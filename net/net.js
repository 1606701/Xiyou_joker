'use strict';

/**
 * net/net.js — 协议层：Socket.IO 事件接入 → 调用 engine → 按人定制广播。
 * 依赖注入 io（Socket.IO Server 实例）与 rooms（房间 Map），便于测试。
 *
 * 分层约定：
 * - 本层不含游戏规则，规则全部在 lib/engine.js；本层只做「接入 / 编排 / 广播 / 定时」。
 * - 所有定时参数集中在 DEFAULT_TIMINGS，可通过 initNet(io, rooms, timings) 注入缩短值，
 *   因此 test/net.test.js 无需引入 socket.io 真实服务或 mock 定时器即可验证托管链路。
 * - engine 抛出的 err.code 统一转成客户端 'error' 事件（code + message）。
 */

const { randomUUID } = require('node:crypto');
const engine = require('../lib/engine');
const ai = require('../lib/ai');

/** 默认定时参数（ms）。测试可注入更短的值；生产环境保持下列默认。 */
const DEFAULT_TIMINGS = Object.freeze({
  /** 断线重连宽限期：期内重连可回原座位，超期按阶段回收 */
  reconnectGraceMs: 60 * 1000,
  /** 正常出牌超时（托管） */
  turnTimeoutMs: 30 * 1000,
  /** 掉线玩家轮到自己时的快速托管超时 */
  disconnectedTurnMs: 8 * 1000,
  /** 在线玩家无合法牌时自动收牌延迟 */
  pickupDelayMs: 1500,
  /** 掉线玩家无合法牌时自动收牌延迟 */
  offlinePickupDelayMs: 1000,
  /** 结算后 nextRound 防误触冷却 */
  nextRoundCooldownMs: 3000,
  /** AI 思考延迟：不为性能，纯粹让真人看清「谁出了什么」，否则三家走完只要几十毫秒 */
  aiThinkMs: 800,
  /** 僵尸房间巡检间隔 */
  roomGcIntervalMs: 60 * 1000,
  /** waiting 阶段全员离线的回收阈值 */
  roomGcWaitingIdleMs: 5 * 60 * 1000,
  /** 任意阶段全员离线的回收阈值 */
  roomGcAllOfflineMs: 10 * 60 * 1000,
});

/** 生成 3 位数字房间码（局域网场景足够，简单好记，如 666/888） */
function makeRoomCode() {
  return String(Math.floor(Math.random() * 900) + 100); // 100~999
}

/** 按人定制的房间视图（防作弊：只暴露本人手牌） */
function getView(room, pid) {
  const publicPlayers = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    seat: p.seat,
    ready: p.ready,
    connected: p.connected,
    handCount: p.hand.length,
    penaltyCount: p.penaltyPile.length,
    isOwner: p.id === room.ownerId,
    // AI 补位：前端据此把准备徽标换成 AI 徽标（AI 不会点准备，显示「未准备」会让人白等）
    isAI: !!p.isAI,
  }));
  const me = room.players.find((p) => p.id === pid);
  return {
    phase: room.phase,
    roomCode: room.roomCode,
    youId: pid,
    roundNumber: room.roundNumber,
    players: publicPlayers,
    direction: room.direction,
    currentPlayerId: room.currentPlayerId,
    topCard: room.topCard ? { rank: room.topCard.rank, suit: room.topCard.suit, kind: room.topCard.kind } : null,
    topCount: room.topCount || 1,
    tablePileCount: room.tablePile.length,
    drawPileCount: room.drawPile.length,
    hand: me ? me.hand.map((c) => ({ id: c.id, rank: c.rank, suit: c.suit, kind: c.kind })) : [],
    eventLog: room.eventLog.slice(-6),
    lastResult: room.lastResult,
    lastWinnerId: room.lastWinnerId,
  };
}

/**
 * 初始化网络层。
 * @param {object} io Socket.IO Server（需具备 io.on('connection') 与 io.sockets.sockets Map）
 * @param {Map<string, object>} rooms 房间 Map（roomCode -> Room）
 * @param {object} [timings] 覆盖 DEFAULT_TIMINGS 的部分字段（测试注入更短值）
 * @returns {{getView: Function, broadcastState: Function, clearPlayerTimers: Function, dispose: Function}}
 */
function initNet(io, rooms, timings = {}) {
  const T = { ...DEFAULT_TIMINGS, ...timings };
  const timers = new Map(); // pid -> { turn, pickup, ai }
  const settleAt = new Map(); // roomCode -> 进入 settling 的时间戳（nextRound 防误触基准）
  const idleSince = new Map(); // roomCode -> 全员离线起始时间戳（房间 GC 基准）

  function clearPlayerTimers(pid) {
    const t = timers.get(pid);
    if (t) {
      clearTimeout(t.turn);
      clearTimeout(t.pickup);
      clearTimeout(t.ai); // AI 调度也挂在同一张定时器账本上，漏清会留下「幽灵 AI 行动」
      timers.delete(pid);
    }
  }

  function clearRoomTimers(room) {
    for (const p of room.players) clearPlayerTimers(p.id);
  }

  /**
   * 「房间还有没有真人」——AI 补位后，所有「房间是否该回收」的判断都必须基于真人。
   *
   * AI 的 connected 恒为 true（没有连接可掉），若沿用 `room.players.every(p => !p.connected)`
   * 这类「数全体玩家」的写法，只要房里剩一个 AI，房间就永远不会被回收：
   * 内存里堆一批「零真人在座、谁也开不了局」的僵尸房，且它们会一直占用随机房间码。
   */
  function humansOf(room) {
    return room.players.filter((p) => !p.isAI);
  }

  /**
   * 无真人 或 真人全部离线。
   * `humansOf(...).length === 0` 正常路径下不该长期存在（最后一名真人在 waiting 阶段离开会即时删房、
   * 在 playing 阶段离开会走宽限回收），但作为回收判据必须一并算作「无人」，
   * 否则一旦出现只有 AI 的残留房间，它就成了唯一删不掉的那一种。
   */
  function noHumanOnline(room) {
    const humans = humansOf(room);
    return humans.length === 0 || humans.every((p) => !p.connected);
  }

  /**
   * 找到这条 socket「当前有权操作」的房间 —— 全部 7 个写/读 handler 的唯一入口。
   *
   * 返回 null 的三种情况：
   *   1. 未绑定身份（socket.playerId 为空）
   *   2. 已被 rejoin 接管（socket.stale，或 player.socketId 已指向别的连接）
   *   3. 该玩家已不在任何房间（被移除 / 房间被回收）
   *
   * P2-11 教训：归属校验必须放在这个**单一入口**里。早先把校验散落在
   * handleDisconnect / disconnect 两处，结果 ready/start/playCard/pickUp/nextRound/leaveRoom
   * 六条写路径全部裸奔 —— 被接管的旧连接（幽灵连接 / 旧页签）仍能代玩家出牌、甚至把在线玩家踢出房间。
   */
  function roomOfPlayer(socket) {
    const pid = socket.playerId;
    if (!pid || socket.stale) return null;
    for (const room of rooms.values()) {
      const me = room.players.find((p) => p.id === pid);
      if (!me) continue;
      // 座位已由新连接接管 → 旧连接无权再操作
      return me.socketId === socket.id ? room : null;
    }
    return null;
  }

  function getPlayer(room, pid) {
    return room.players.find((p) => p.id === pid);
  }

  function socketOf(player) {
    return io.sockets.sockets.get(player.socketId);
  }

  /** 向房间内全体广播按人定制的 state */
  function broadcastState(room) {
    for (const p of room.players) {
      const socket = socketOf(p);
      if (socket && p.connected) socket.emit('state', getView(room, p.id));
    }
  }

  function broadcastError(socket, code, message) {
    socket.emit('error', { code, message });
  }

  /**
   * 给当前行动者下发 yourTurn（合法出牌集合 + 截止时间），并调度后续动作。
   *
   * 重要：`computeLegalMoves()` 的返回结构是 { opening, beats, actions }：
   *   beats   同点牌的 id 数组的数组（单张 = 长度 1 的组）
   *   actions 功能牌（A/2）的单张 id 数组
   * 早先此处误写为 moves.beatIds / moves.actionIds（均为 undefined），访问 .length 抛
   * TypeError，导致「无牌自动收牌」「30s 超时托管」「掉线 8s 快速托管」全部未被调度，
   * 客户端还会收到一次假的「操作失败」——即 BUG-001。
   */
  function sendTurn(room, pid) {
    const player = getPlayer(room, pid);
    if (!player) return;

    // AI 补位：AI 没有 socket，既不该走 computeLegalMoves 的异常降级分支，
    // 也不该「碰巧」因为 socketOf() 返回 undefined 而静默跳过 only-for-human 的 yourTurn 广播。
    // 走独立的 scheduleAI 路径，语义明确：AI 自己算、自己动手。
    if (player.isAI) return scheduleAI(room, pid);

    // 最后一道保险：即使 computeLegalMoves 因未知缺陷抛错（如 BUG-007 的 topCard=null），
    // 也绝不能让「本回合没有任何定时器」——那就等于整桌永久卡死。
    // 降级策略：记录上下文 + 告知该玩家 + 仍按超时托管兜底（托管会再走一次引擎，通常能自行恢复）。
    let moves;
    try {
      moves = engine.computeLegalMoves(room, pid);
    } catch (e) {
      console.error('[net] computeLegalMoves 失败，降级为超时托管兜底', {
        roomCode: room.roomCode,
        pid,
        phase: room.phase,
        topCard: room.topCard,
        topCount: room.topCount,
        tablePileLength: room.tablePile.length,
        drawPileLength: room.drawPile.length,
        error: e && e.message,
      });
      if (player.connected) {
        const s = socketOf(player);
        if (s) broadcastError(s, 'INTERNAL', '服务端计算出牌集合失败，本回合已转为超时托管');
      }
      scheduleTurn(room, pid, player.connected ? T.turnTimeoutMs : T.disconnectedTurnMs);
      return;
    }

    const canPlay = moves.beats.length > 0 || moves.actions.length > 0;

    // 只给在线玩家发 yourTurn（离线玩家没有可送达的 socket）；deadline 只对在线玩家有意义，
    // 因此不再用 isOffline 三元分支（原写法是永远不会走到离线分支的死代码，BUG-002）。
    if (player.connected) {
      const socket = socketOf(player);
      if (socket) socket.emit('yourTurn', { legalMoves: moves, deadline: Date.now() + T.turnTimeoutMs });
    }

    // 无合法牌 → 快速自动收牌；否则按超时托管（掉线玩家更快托管，避免卡局）
    if (canPlay) {
      scheduleTurn(room, pid, player.connected ? T.turnTimeoutMs : T.disconnectedTurnMs);
    } else {
      schedulePickup(room, pid, player.connected ? T.pickupDelayMs : T.offlinePickupDelayMs);
    }
  }

  /** 超时托管：最小可压牌 → A → 2 → 收牌 */
  function scheduleTurn(room, pid, delay) {
    clearPlayerTimers(pid);
    const t = {};
    t.turn = setTimeout(() => {
      timers.delete(pid);
      // 房间已结束/已被回收，或轮次已不属于该玩家 → 丢弃陈旧定时器
      if (room.phase !== 'playing' || room.currentPlayerId !== pid) return;
      try {
        engine.autoPlay(room, pid);
        broadcastState(room);
        if (room.phase === 'playing' && room.currentPlayerId) sendTurn(room, room.currentPlayerId);
        else if (room.phase === 'settling') sendGameEnd(room);
      } catch (e) {
        // 托管失败不应使服务器崩溃，但必须可观测（否则线上只会表现为「莫名卡住」）
        console.error('[net] 超时托管 autoPlay 失败', {
          roomCode: room.roomCode,
          pid,
          phase: room.phase,
          currentPlayerId: room.currentPlayerId,
          topCard: room.topCard,
          tablePileLength: room.tablePile.length,
          error: e && e.message,
          code: e && e.code,
        });
      }
    }, delay);
    timers.set(pid, t);
  }

  /** 无合法牌时自动收牌 */
  function schedulePickup(room, pid, delay) {
    clearPlayerTimers(pid);
    const t = {};
    t.pickup = setTimeout(() => {
      timers.delete(pid);
      if (room.phase !== 'playing' || room.currentPlayerId !== pid) return;
      try {
        const res = engine.pickUp(room, pid);
        broadcastState(room);
        if (res.action === 'gameOver') sendGameEnd(room);
        else if (room.currentPlayerId) sendTurn(room, room.currentPlayerId);
      } catch (e) {
        // 已过校验（如已出牌）属正常竞态，保留静默返回；但仍打日志以便区分「正常竞态」与「真缺陷」
        console.error('[net] 自动收牌 pickUp 失败（可能是定时器竞态）', {
          roomCode: room.roomCode,
          pid,
          phase: room.phase,
          currentPlayerId: room.currentPlayerId,
          topCard: room.topCard,
          tablePileLength: room.tablePile.length,
          error: e && e.message,
          code: e && e.code,
        });
      }
    }, delay);
    timers.set(pid, t);
  }

  /**
   * AI 玩家行动调度（AI 补位）。
   *
   * 与 scheduleTurn / schedulePickup 并列的第三条调度路径：
   * - AI 不需要 yourTurn（没有 socket 可发），也不需要「超时兜底」——它永远不会超时；
   * - 但**必须**占用同一张 timers 账本（key = pid），否则 clearPlayerTimers / clearRoomTimers
   *   清不掉它，踢掉 AI 或回收房间后会留下一个「幽灵 AI 继续出牌」的定时器；
   * - 延迟由 T.aiThinkMs 控制，纯粹是给人看的（默认 800ms），测试注入个位数毫秒。
   */
  function scheduleAI(room, pid) {
    clearPlayerTimers(pid);
    const t = {};
    t.ai = setTimeout(() => {
      timers.delete(pid);
      // 四道陈旧定时器守卫，缺一不可：
      // 1) 房间已被回收（rooms 里已经没有它）——AI 回调会自己重新挂定时器（sendTurn → scheduleAI），
      //    少了这一道就会变成「房间删了、AI 还在自走棋」的孤儿定时器循环，进程永不退出；
      // 2) 房间已结束；3) 轮次已不属于该 AI；4) 该 AI 已被移出房间（踢 AI 或房间重建）
      if (rooms.get(room.roomCode) !== room) return;
      if (room.phase !== 'playing' || room.currentPlayerId !== pid) return;
      const p = getPlayer(room, pid);
      if (!p || !p.isAI) return;

      let res;
      try {
        const mv = ai.chooseMove(room, pid);
        res = mv.type === 'pickup' ? engine.pickUp(room, pid) : engine.playCard(room, pid, mv.cardIds);
      } catch (e) {
        // 策略与规则不一致时不能整桌卡死：降级到「超时托管选择器」（最小可压 → A → 2 → 收牌）
        console.error('[net] AI 决策失败，降级 autoPlay', {
          roomCode: room.roomCode,
          pid,
          phase: room.phase,
          topCard: room.topCard,
          topCount: room.topCount,
          tablePileLength: room.tablePile.length,
          error: e && e.message,
          code: e && e.code,
        });
        try {
          res = engine.autoPlay(room, pid);
        } catch (e2) {
          // 最后一道：连托管选择器也失败。宁可把这一局异常结束（并让真人看到提示），
          // 也绝不留下「0 个定时器 + 一直等 AI」的死桌 —— 那是本项目最贵的故障模式。
          console.error('[net] AI 降级 autoPlay 仍失败，强制结算本局', {
            roomCode: room.roomCode,
            pid,
            phase: room.phase,
            currentPlayerId: room.currentPlayerId,
            topCard: room.topCard,
            tablePileLength: room.tablePile.length,
            drawPileLength: room.drawPile.length,
            error: e2 && e2.message,
            code: e2 && e2.code,
          });
          try {
            engine.settleGame(room);
          } catch (e3) {
            console.error('[net] 强制结算失败，房间已无可用恢复手段', {
              roomCode: room.roomCode,
              playerCount: room.players.length,
              error: e3 && e3.message,
            });
          }
          // 让真人至少看到一句人话，而不是盯着一张静止的牌桌
          for (const other of humansOf(room)) {
            const s = socketOf(other);
            if (s) broadcastError(s, 'INTERNAL', '服务端异常，本局已强制结算');
          }
          sendGameEnd(room);
          return;
        }
      }

      broadcastState(room);
      if (res.action === 'gameOver') sendGameEnd(room);
      else if (room.phase === 'playing' && room.currentPlayerId) sendTurn(room, room.currentPlayerId);
    }, T.aiThinkMs);
    timers.set(pid, t);
  }

  /** 记录进入 settling 的时刻（nextRound 防误触用；同一局只记第一次） */
  function markSettled(room) {
    if (!settleAt.has(room.roomCode)) settleAt.set(room.roomCode, Date.now());
  }

  function sendGameEnd(room) {
    if (!room.lastResult) return;
    markSettled(room);
    const winner = room.players.find((p) => p.id === room.lastResult.winnerId);
    for (const p of room.players) {
      const socket = socketOf(p);
      if (socket && p.connected) {
        socket.emit('gameEnd', {
          results: room.lastResult.results,
          winnerIds: [room.lastResult.winnerId],
          winnerName: winner ? winner.name : '',
          lastWinnerId: room.lastWinnerId,
        });
      }
    }
  }

  /** 新玩家入座的统一收尾：签发重连令牌、绑定 socket、加入房间通道、回执 */
  function seatPlayer(socket, room, player) {
    player.rejoinToken = randomUUID(); // BUG-004：rejoin 必须同时校验 roomCode + playerId + token
    player.socketId = socket.id;
    socket.playerId = player.id;
    socket.join(room.roomCode);
    socket.emit('roomJoined', {
      roomCode: room.roomCode,
      youId: player.id,
      rejoinToken: player.rejoinToken,
      state: getView(room, player.id),
    });
  }

  /**
   * 僵尸房间巡检（BUG-005）：socket 断开的房间本身不会自行消失，
   * 若全员离线且超过阈值则回收，避免内存里堆积「谁也进不去、谁也没在里面」的房间。
   */
  function gcRooms() {
    const now = Date.now();
    for (const [code, room] of [...rooms.entries()]) {
      // AI 补位：判据必须是「无真人或真人全离线」，不能数全体玩家（详见 noHumanOnline 注释）
      const allOffline = noHumanOnline(room);
      if (!allOffline) {
        idleSince.delete(code);
        continue;
      }
      if (!idleSince.has(code)) {
        idleSince.set(code, now);
        continue;
      }
      const limit = room.phase === 'waiting' ? T.roomGcWaitingIdleMs : T.roomGcAllOfflineMs;
      if (now - idleSince.get(code) >= limit) {
        clearRoomTimers(room);
        rooms.delete(code);
        settleAt.delete(code);
        idleSince.delete(code);
      }
    }
    // 房间可能已被其他路径删除，顺手清理记账 Map，避免长期运行后累积
    for (const code of [...settleAt.keys()]) if (!rooms.has(code)) settleAt.delete(code);
    for (const code of [...idleSince.keys()]) if (!rooms.has(code)) idleSince.delete(code);
  }

  const gcTimer = setInterval(gcRooms, T.roomGcIntervalMs);
  if (typeof gcTimer.unref === 'function') gcTimer.unref();

  io.on('connection', (socket) => {
    socket.playerId = null;

    const fail = (code, message) => broadcastError(socket, code, message);

    /** 创建房间 */
    socket.on('createRoom', ({ nickname } = {}) => {
      if (!nickname || !nickname.trim()) return fail('NAME_TAKEN', '昵称不能为空');
      const pid = socket.id;
      const name = nickname.trim().slice(0, 12);
      let code;
      do { code = makeRoomCode(); } while (rooms.has(code));
      const room = engine.createRoom(code);
      const player = { id: pid, name, socketId: socket.id };
      engine.addPlayer(room, player);
      rooms.set(code, room);
      seatPlayer(socket, room, player);
    });

    /** 加入房间 */
    socket.on('joinRoom', ({ roomCode, nickname } = {}) => {
      if (!nickname || !nickname.trim()) return fail('NAME_TAKEN', '昵称不能为空');
      const name = nickname.trim().slice(0, 12);
      const code = String(roomCode || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return fail('ROOM_NOT_FOUND', '房间不存在');
      if (room.phase !== 'waiting') return fail('GAME_RUNNING', '对局已开始，无法加入');
      if (room.players.length >= 6) return fail('ROOM_FULL', '房间已满');
      // 与存储名（已截断到 12 字）比较，避免超长昵称绕过重名校验
      if (room.players.some((p) => p.name === name)) return fail('NAME_TAKEN', '昵称已被使用');
      const pid = socket.id;
      const player = { id: pid, name, socketId: socket.id };
      engine.addPlayer(room, player);
      seatPlayer(socket, room, player);
      broadcastState(room);
    });

    /**
     * 断线重连：roomCode + playerId + rejoinToken 三者全对才允许接管座位。
     * 仅凭旧 id 即可接管是 BUG-004（可被猜 id 顶号）。
     */
    socket.on('rejoin', ({ roomCode, playerId, rejoinToken } = {}) => {
      const room = rooms.get(String(roomCode || '').trim().toUpperCase());
      if (!room) return fail('ROOM_NOT_FOUND', '房间不存在');
      const player = getPlayer(room, playerId);
      if (!player) return fail('PLAYER_NOT_FOUND', '玩家不存在');
      if (!rejoinToken || !player.rejoinToken || rejoinToken !== player.rejoinToken) {
        return fail('BAD_TOKEN', '重连凭证已失效，请重新加入房间');
      }
      // 作废旧连接（BUG-008 + P2-11）：
      // - stale 标记：旧 socket 稍后触发的 disconnect 不得把玩家改回「掉线」、也不得清掉新连接的定时器；
      // - playerId 置空：连身份一起作废，旧连接连「我是谁」都不知道，任何写路径都无法反查到房间
      //   （只打 stale 标记时，一旦某条写路径漏检 stale 就仍然能生效 —— P2-11 就是这么发生的）。
      const prevSocketId = player.socketId;
      if (prevSocketId && prevSocketId !== socket.id) {
        const prevSocket = io.sockets.sockets.get(prevSocketId);
        if (prevSocket) {
          prevSocket.stale = true;
          prevSocket.playerId = null;
        }
      }
      player.connected = true;
      player.socketId = socket.id;
      socket.playerId = player.id;
      socket.stale = false;
      socket.join(room.roomCode);
      socket.emit('roomJoined', {
        roomCode: room.roomCode,
        youId: player.id,
        rejoinToken: player.rejoinToken,
        state: getView(room, player.id),
      });
      broadcastState(room);
      // 重连后若轮到自己，立即重发 yourTurn（并重置托管定时器）
      if (room.phase === 'playing' && room.currentPlayerId === player.id) sendTurn(room, player.id);
    });

    /** 离开房间 */
    socket.on('leaveRoom', () => {
      const room = roomOfPlayer(socket);
      if (!room) {
        // 已被新连接接管（P2-11b）：必须给旧连接一个明确回执，否则旧页签会「静默地以为自己还在房里」。
        // 其余情况（本来就未入座 / 重复点击离开）保持静默，避免给正常用户弹无意义的 toast。
        if (socket.stale) return fail('ROOM_NOT_FOUND', '连接已被新页面接管，无法操作房间');
        return;
      }
      const pid = socket.playerId;
      if (room.phase === 'waiting') {
        engine.removePlayer(room, pid);
        socket.leave(room.roomCode);
        socket.playerId = null; // 已离座，身份随之作废（重复点击离开变成静默 no-op）
        broadcastState(room);
        // 空房判定同样只数真人：房里只剩 AI 时没人能开下一局，属于僵尸房，必须回收
        if (humansOf(room).length === 0) {
          clearRoomTimers(room);
          rooms.delete(room.roomCode);
          settleAt.delete(room.roomCode);
          idleSince.delete(room.roomCode);
        }
      } else {
        handleDisconnect(socket);
      }
    });

    /** 准备/取消准备 */
    socket.on('ready', ({ ready } = {}) => {
      const room = roomOfPlayer(socket);
      if (!room) return fail('ROOM_NOT_FOUND', '未在房间中');
      try {
        engine.setReady(room, socket.playerId, !!ready);
        broadcastState(room);
      } catch (e) {
        fail(e.code || 'ERROR', e.message);
      }
    });

    /** 房主开始 */
    socket.on('start', () => {
      const room = roomOfPlayer(socket);
      if (!room) return fail('ROOM_NOT_FOUND', '未在房间中');
      if (room.ownerId !== socket.playerId) return fail('NOT_OWNER', '只有房主可以开始');
      try {
        // 幂等：若房间已在对局中（如房主双击开始按钮触发第二次），不报错，重发当前状态即可
        if (room.phase === 'playing') {
          broadcastState(room);
          sendTurn(room, room.currentPlayerId);
          return;
        }
        engine.startGame(room);
        settleAt.delete(room.roomCode); // 新一局开始，清掉上局结算时刻
        broadcastState(room);
        sendTurn(room, room.currentPlayerId);
      } catch (e) {
        fail(e.code || 'ERROR', e.message);
      }
    });

    /** 出牌（单张传 cardIds=[id]，组合传同点 2~4 张） */
    socket.on('playCard', ({ cardIds } = {}) => {
      const room = roomOfPlayer(socket);
      if (!room) return fail('ROOM_NOT_FOUND', '未在房间中');
      try {
        const res = engine.playCard(room, socket.playerId, cardIds);
        clearPlayerTimers(socket.playerId);
        broadcastState(room);
        if (res.action === 'gameOver') sendGameEnd(room);
        else sendTurn(room, room.currentPlayerId);
      } catch (e) {
        fail(e.code || 'ERROR', e.message);
      }
    });

    /** 收牌（仅无合法牌时；无牌时会自动执行） */
    socket.on('pickUp', () => {
      const room = roomOfPlayer(socket);
      if (!room) return fail('ROOM_NOT_FOUND', '未在房间中');
      try {
        const res = engine.pickUp(room, socket.playerId);
        clearPlayerTimers(socket.playerId);
        broadcastState(room);
        if (res.action === 'gameOver') sendGameEnd(room);
        else sendTurn(room, room.currentPlayerId);
      } catch (e) {
        fail(e.code || 'ERROR', e.message);
      }
    });

    /**
     * 加一个 AI 补位（仅房主、仅 waiting）。
     * AI 玩家是「没有 socket 的玩家」：socketId = null、connected = true、
     * broadcastState / sendGameEnd 里 socketOf() 返回 undefined 已被 `if (socket)` 守卫跳过，
     * 所以不需要假 socket 也不会崩。它的行动统一由 scheduleAI 驱动。
     */
    socket.on('addAI', () => {
      const room = roomOfPlayer(socket);
      if (!room) return fail('ROOM_NOT_FOUND', '未在房间中');
      if (room.ownerId !== socket.playerId) return fail('NOT_OWNER', '只有房主可以加 AI');
      if (room.phase !== 'waiting') return fail('GAME_RUNNING', '对局进行中，无法加 AI');
      if (room.players.length >= 6) return fail('ROOM_FULL', '房间已满（最多 6 人）');

      const seat = room.players.length;
      const used = new Set(room.players.map((p) => p.name));
      const name = ai.AI_NAMES.find((n) => !used.has(n)) || `AI-${seat + 1}`;
      const id = `ai-${randomUUID()}`;
      const player = { id, name, socketId: null, rejoinToken: null, isAI: true, connected: true };
      try {
        engine.addPlayer(room, player);
        // AI 永远就绪，否则房主永远等不到「全员准备」（AI 没有手可以点）
        engine.setReady(room, id, true);
      } catch (e) {
        return fail(e.code || 'ERROR', e.message);
      }
      broadcastState(room);
    });

    /** 踢掉最后一个 AI（仅房主、仅 waiting；没有 AI 时静默 no-op） */
    socket.on('removeAI', () => {
      const room = roomOfPlayer(socket);
      if (!room) return fail('ROOM_NOT_FOUND', '未在房间中');
      if (room.ownerId !== socket.playerId) return fail('NOT_OWNER', '只有房主可以踢 AI');
      if (room.phase !== 'waiting') return fail('GAME_RUNNING', '对局进行中，无法踢 AI');
      const ais = room.players.filter((p) => p.isAI);
      if (ais.length === 0) return; // 幂等：重复点击不弹错
      const last = ais.reduce((a, b) => (b.seat > a.seat ? b : a));
      engine.removePlayer(room, last.id);
      broadcastState(room);
    });

    /**
     * 再来一局（BUG-003）：
     * - 仅房主可触发，非房主回 NOT_OWNER；
     * - 结算后 nextRoundCooldownMs（默认 3s）内静默忽略，避免结算页刚弹出就被误触点掉；
     * - 非 settling 阶段重复点击按幂等处理（只重发状态，不报错，避免误触弹「操作失败」）。
     */
    socket.on('nextRound', () => {
      const room = roomOfPlayer(socket);
      if (!room) return fail('ROOM_NOT_FOUND', '未在房间中');
      if (room.ownerId !== socket.playerId) return fail('NOT_OWNER', '只有房主可以开始下一局');
      if (room.phase !== 'settling') {
        broadcastState(room);
        return;
      }
      const at = settleAt.get(room.roomCode);
      if (at != null && Date.now() - at < T.nextRoundCooldownMs) return; // 防误触：静默忽略
      try {
        engine.nextRound(room);
        settleAt.delete(room.roomCode);
        broadcastState(room);
      } catch (e) {
        fail(e.code || 'ERROR', e.message);
      }
    });

    /**
     * 掉线处理。
     * 归属校验（是否仍是该玩家的当前连接）**统一由 roomOfPlayer() 保证**（单点，避免再次漏检）：
     * 被 rejoin 接管的旧连接在这里天然拿到 null 直接返回，不会把座位改回「掉线」
     * （BUG-008：前端冻结 / 本人被 8s 托管 / 他人看到假掉线 / waiting 阶段 60s 后被踢）。
     * @returns {object|null} 校验通过时返回玩家对象，否则 null
     */
    function handleDisconnect(socket) {
      const room = roomOfPlayer(socket);
      if (!room) return null;
      const player = getPlayer(room, socket.playerId);
      if (!player) return null;

      player.connected = false;
      // 掉线时若正轮到自己，走快速托管；否则静默
      if (room.phase === 'playing' && room.currentPlayerId === player.id) {
        scheduleTurn(room, player.id, T.disconnectedTurnMs);
      }
      broadcastState(room);
      // 宽限期后仍未重连则移除（waiting 阶段直接移除；playing 阶段保留座位继续托管，
      // 但若全员掉线则整房删除，避免残留房间干扰新对局）
      const graceTimer = setTimeout(() => {
        // 宽限期内可能已重连（或被新连接接管），届时 fresh.socketId 会变；connected 已足够判定
        const fresh = getPlayer(room, player.id);
        if (!fresh || fresh.connected) return;
        if (room.phase === 'waiting') {
          engine.removePlayer(room, player.id);
          broadcastState(room);
          // waiting 阶段宽限到期被移除后，只剩 AI 的房间同样是死房（没人能点开始）
          if (humansOf(room).length === 0) {
            clearRoomTimers(room);
            rooms.delete(room.roomCode);
            settleAt.delete(room.roomCode);
            idleSince.delete(room.roomCode);
          }
        } else if (noHumanOnline(room)) {
          // AI 恒 connected=true，沿用 players.every(!connected) 会因为 AI 永远「在线」而永不回收
          clearRoomTimers(room);
          rooms.delete(room.roomCode);
          settleAt.delete(room.roomCode);
          idleSince.delete(room.roomCode);
        }
      }, T.reconnectGraceMs);
      if (typeof graceTimer.unref === 'function') graceTimer.unref();
      return player;
    }

    socket.on('disconnect', () => {
      // 归属校验统一走 roomOfPlayer()：被接管的旧连接（stale / playerId 已作废）拿不到房间，
      // 直接返回，不产生任何副作用（BUG-008）。写/读入口全部共用同一个校验，避免再次漏点。
      const room = roomOfPlayer(socket);
      if (!room) return;
      const player = getPlayer(room, socket.playerId);
      if (!player) return;
      // 顺序必须是「先清旧定时器 → 再走掉线托管」，反过来的话会把自己刚排的 8s 快速托管定时器清掉
      clearPlayerTimers(player.id);
      handleDisconnect(socket);
    });
  });

  /** 释放内部定时器（进程退出 / 测试收尾用；生产环境由 HTTP server 维持事件循环） */
  function dispose() {
    clearInterval(gcTimer);
    for (const pid of [...timers.keys()]) clearPlayerTimers(pid);
  }

  return { getView, broadcastState, clearPlayerTimers, dispose };
}

module.exports = { initNet, getView, makeRoomCode, DEFAULT_TIMINGS };
