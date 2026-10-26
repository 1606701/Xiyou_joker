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
  const timers = new Map(); // pid -> { turn, pickup }
  const settleAt = new Map(); // roomCode -> 进入 settling 的时间戳（nextRound 防误触基准）
  const idleSince = new Map(); // roomCode -> 全员离线起始时间戳（房间 GC 基准）

  function clearPlayerTimers(pid) {
    const t = timers.get(pid);
    if (t) {
      clearTimeout(t.turn);
      clearTimeout(t.pickup);
      timers.delete(pid);
    }
  }

  function clearRoomTimers(room) {
    for (const p of room.players) clearPlayerTimers(p.id);
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
      const allOffline = room.players.length > 0 && room.players.every((p) => !p.connected);
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
        if (room.players.length === 0) {
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
          if (room.players.length === 0) {
            rooms.delete(room.roomCode);
            settleAt.delete(room.roomCode);
            idleSince.delete(room.roomCode);
          }
        } else if (room.players.every((p) => !p.connected)) {
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
