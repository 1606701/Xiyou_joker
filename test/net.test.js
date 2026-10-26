'use strict';

/**
 * test/net.test.js — 协议层（net/net.js）单元测试。
 *
 * 设计原则：不引入 socket.io 真实服务、不引入新依赖、不依赖 mock 定时器。
 * - 假 io：只需 io.on('connection', h) 与 io.sockets.sockets（Map<socketId, socket>）
 * - 假 socket：记录 emit、提供 on/join/leave/id，测试用 socket.send(事件名, payload) 手动触发
 * - 定时器：Timings 经 initNet(io, rooms, timings) 注入极短值，用 waitFor 轮询断言结果，
 *   因此托管链路（自动收牌 / 超时托管 / 掉线快速托管 / 宽限回收 / 房间 GC）全部可确定性验证。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const engine = require('../lib/engine.js');
const { initNet, DEFAULT_TIMINGS } = require('../net/net.js');

/* ============================================================
 * 测试脚手架
 * ============================================================ */

/** 假 socket：记录所有 emit，手动驱动客户端 → 服务端事件 */
function makeFakeSocket(id) {
  const handlers = new Map();
  const socket = {
    id,
    playerId: null,
    emitted: [],
    joinedRooms: new Set(),
    emit(name, payload) {
      socket.emitted.push({ name, payload });
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    join(code) {
      socket.joinedRooms.add(code);
    },
    leave(code) {
      socket.joinedRooms.delete(code);
    },
    /* ---- 测试辅助 ---- */
    /** 模拟客户端发出事件 */
    send(name, payload) {
      const handler = handlers.get(name);
      assert.ok(handler, `服务端未注册事件 '${name}'`);
      handler(payload);
    },
    /** 最近一次某事件的 payload（没有则 undefined） */
    last(name) {
      for (let i = socket.emitted.length - 1; i >= 0; i--) {
        if (socket.emitted[i].name === name) return socket.emitted[i].payload;
      }
      return undefined;
    },
    /** 某事件的全部 payload */
    all(name) {
      return socket.emitted.filter((e) => e.name === name).map((e) => e.payload);
    },
    clear() {
      socket.emitted.length = 0;
    },
  };
  return socket;
}

/** 默认把定时器都拉长，避免无关用例之间互相干扰；需要托管链路的用例自行注入极短值 */
function makeHarness(overrides = {}) {
  const rooms = new Map();
  const sockets = new Map();
  const timings = {
    reconnectGraceMs: 5000,
    turnTimeoutMs: 5000,
    disconnectedTurnMs: 5000,
    pickupDelayMs: 5000,
    offlinePickupDelayMs: 5000,
    nextRoundCooldownMs: 0,
    roomGcIntervalMs: 60 * 60 * 1000,
    roomGcWaitingIdleMs: 60 * 60 * 1000,
    roomGcAllOfflineMs: 60 * 60 * 1000,
    ...overrides,
  };

  let connectionHandler = null;
  const io = {
    sockets: { sockets },
    on(event, handler) {
      if (event === 'connection') connectionHandler = handler;
    },
  };

  const net = initNet(io, rooms, timings);

  return {
    io,
    rooms,
    sockets,
    timings,
    /** 模拟一次客户端连接（服务端 connection 处理器立即执行） */
    connect(id) {
      assert.ok(connectionHandler, 'connection 处理器未注册');
      const socket = makeFakeSocket(id);
      sockets.set(id, socket);
      connectionHandler(socket);
      return socket;
    },
    room(code) {
      return rooms.get(code);
    },
    dispose() {
      net.dispose();
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待条件成立（避免依赖 mock timers 与大段固定 sleep） */
async function waitFor(cond, { timeout = 2000, interval = 5, label = '' } = {}) {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeout) throw new Error(`waitFor 超时${label ? `：${label}` : ''}`);
    await sleep(interval);
  }
}

/* ---- 构造引擎侧的手牌（直连 room 对象，属于协议层用例的白盒前置条件） ---- */
let cardSeq = 0;
function card(rank, kind, suit = '♠') {
  cardSeq += 1;
  return { id: `t_${rank}_${cardSeq}`, rank, suit, kind };
}
const MONSTER = (rank) => card(rank, 'monster');
const ACTION = (rank) => card(rank, 'action');

/** 建 3 人房并开局；返回房主 / 其余两位 / roomCode / room */
function startThree(h, nicknames = ['悟空', '八戒', '沙僧']) {
  const host = h.connect('s-host');
  host.send('createRoom', { nickname: nicknames[0] });
  const code = host.last('roomJoined').roomCode;
  const others = nicknames.slice(1).map((name, i) => {
    const socket = h.connect(`s-other-${i}`);
    socket.send('joinRoom', { roomCode: code, nickname: name });
    return socket;
  });
  for (const socket of [host, ...others]) socket.send('ready', { ready: true });
  host.send('start');
  return { host, others, code, room: h.rooms.get(code) };
}

/**
 * 取 room 里「这条连接」对应的玩家对象 —— 按**连接身份**（player.socketId === socket.id）反查，
 * 而不是用 socket 自报的 playerId。
 * 原因：socket.playerId 是「服务端记在这条连接上的可变状态」，rejoin 接管后会被作废；
 * 用它反查会把「旧 socket 是否仍保留 playerId」这种实现细节写进断言，导致任何不相关变异
 * （甚至只是换一种同样正确的作废手段）都会把用例打红。按 socketId 反查则只依赖「谁持有这个座位」。
 */
const playerOf = (room, socket) => room.players.find((p) => p.socketId === socket.id);

/**
 * 构造「出牌后下家无任何合法牌」的局面（BUG-001 的触发路径）：
 * 房主打出 K，下家只剩一张压不住 K 的小妖 4，且无 A/2 功能牌。
 */
function forceNoLegalMoves(h) {
  const { host, others, code, room } = startThree(h);
  const victimSocket = others[0];
  const me = playerOf(room, host);
  const victim = playerOf(room, victimSocket);
  const high = MONSTER('K');
  me.hand = [high];
  victim.hand = [MONSTER('4')];
  host.clear();
  victimSocket.clear();
  host.send('playCard', { cardIds: [high.id] });
  return { host, victimSocket, me, victim, code, room, high };
}

/** 构造已进入 settling 的房间（当前玩家无牌可出 + 摸牌堆已空 → 收牌即终局） */
function forceSettle(h) {
  const { host, others, code, room } = startThree(h);
  const cur = playerOf(room, host);
  const top = MONSTER('K');
  room.topCard = top;
  room.topCount = 1;
  room.tablePile = [top];
  room.drawPile = [];
  cur.hand = [MONSTER('4')];
  host.clear();
  host.send('pickUp');
  return { host, others, code, room, cur };
}

/* ============================================================
 * 1. 建房 / 加入
 * ============================================================ */

test('createRoom → 收到 roomJoined（roomCode / youId / rejoinToken / state）', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const s = h.connect('s1');
  s.send('createRoom', { nickname: '悟空' });

  const joined = s.last('roomJoined');
  assert.ok(joined, '应收到 roomJoined');
  assert.match(joined.roomCode, /^\d{3}$/);
  assert.strictEqual(joined.youId, 's1');
  assert.ok(joined.rejoinToken, '应签发重连令牌（BUG-004）');
  assert.strictEqual(joined.state.youId, 's1');
  assert.strictEqual(joined.state.phase, 'waiting');
  assert.strictEqual(joined.state.players.length, 1);
  assert.strictEqual(joined.state.players[0].isOwner, true);
  assert.ok(h.rooms.has(joined.roomCode), '房间应注册进 rooms');
  assert.ok(s.joinedRooms.has(joined.roomCode), 'socket 应加入房间通道');
  assert.strictEqual(s.playerId, 's1');
});

test('joinRoom → 新玩家收到 roomJoined，房主收到 state 更新（座位=加入顺序）', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const host = h.connect('s1');
  host.send('createRoom', { nickname: '悟空' });
  const code = host.last('roomJoined').roomCode;
  host.clear();

  const guest = h.connect('s2');
  guest.send('joinRoom', { roomCode: code, nickname: '八戒' });

  const joined = guest.last('roomJoined');
  assert.ok(joined);
  assert.strictEqual(joined.state.phase, 'waiting');
  assert.strictEqual(joined.state.players.length, 2);
  assert.strictEqual(joined.state.players[1].seat, 1, '座位号=加入顺序');
  assert.strictEqual(joined.state.players[1].name, '八戒');
  assert.ok(joined.rejoinToken);

  const hostState = host.last('state');
  assert.ok(hostState, '房主应收到广播 state');
  assert.strictEqual(hostState.players.length, 2);
});

test('joinRoom 昵称重复 → NAME_TAKEN（空昵称同样拒绝）', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const host = h.connect('s1');
  host.send('createRoom', { nickname: '悟空' });
  const code = host.last('roomJoined').roomCode;

  const dup = h.connect('s2');
  dup.send('joinRoom', { roomCode: code, nickname: '悟空' });
  assert.strictEqual(dup.last('error').code, 'NAME_TAKEN');
  assert.strictEqual(dup.last('roomJoined'), undefined, '被拒后不应进入房间');

  const blank = h.connect('s3');
  blank.send('joinRoom', { roomCode: code, nickname: '   ' });
  assert.strictEqual(blank.last('error').code, 'NAME_TAKEN');

  assert.strictEqual(h.rooms.get(code).players.length, 1);
});

test('joinRoom 房间不存在 → ROOM_NOT_FOUND', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const s = h.connect('s1');
  s.send('joinRoom', { roomCode: 'ABC', nickname: '路人' });
  assert.strictEqual(s.last('error').code, 'ROOM_NOT_FOUND');
  assert.strictEqual(s.playerId, null, '失败后不应绑定身份');
});

test('joinRoom 对局已开始 → GAME_RUNNING', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const { code } = startThree(h);

  const late = h.connect('s-late');
  late.send('joinRoom', { roomCode: code, nickname: '迟到者' });
  assert.strictEqual(late.last('error').code, 'GAME_RUNNING');
  assert.strictEqual(h.rooms.get(code).players.length, 3);
});

/* ============================================================
 * 2. 开局与 yourTurn
 * ============================================================ */

test('start：非房主触发 → NOT_OWNER', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const host = h.connect('s1');
  host.send('createRoom', { nickname: '悟空' });
  const code = host.last('roomJoined').roomCode;
  const guest = h.connect('s2');
  guest.send('joinRoom', { roomCode: code, nickname: '八戒' });
  const guest2 = h.connect('s3');
  guest2.send('joinRoom', { roomCode: code, nickname: '沙僧' });
  [host, guest, guest2].forEach((s) => s.send('ready', { ready: true }));
  guest.clear();

  guest.send('start');
  assert.strictEqual(guest.last('error').code, 'NOT_OWNER');
  assert.strictEqual(h.rooms.get(code).phase, 'waiting', '非房主无法开局');
});

test('start：全员准备后房主开局 → 当前玩家收到 yourTurn，含 legalMoves.beats / legalMoves.actions', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const host = h.connect('s1');
  host.send('createRoom', { nickname: '悟空' });
  const code = host.last('roomJoined').roomCode;
  const others = ['八戒', '沙僧'].map((name, i) => {
    const s = h.connect(`s-other-${i}`);
    s.send('joinRoom', { roomCode: code, nickname: name });
    return s;
  });
  [host, ...others].forEach((s) => s.send('ready', { ready: true }));
  host.clear();
  host.send('start');

  const room = h.rooms.get(code);
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(room.currentPlayerId, room.ownerId, '首局房主先手');

  const turn = host.last('yourTurn');
  assert.ok(turn, '当前玩家应收到 yourTurn');
  assert.ok(turn.legalMoves, 'yourTurn 必须携带 legalMoves');
  assert.ok(Array.isArray(turn.legalMoves.beats), 'legalMoves.beats 必须是数组（BUG-001 的关键字段名）');
  assert.ok(Array.isArray(turn.legalMoves.actions), 'legalMoves.actions 必须是数组（BUG-001 的关键字段名）');
  assert.strictEqual(turn.legalMoves.opening, true, '开局桌面为空');
  assert.ok(turn.legalMoves.beats.length > 0, '开局任意单张可出');
  assert.strictEqual(typeof turn.deadline, 'number', 'deadline 用于前端倒计时');
  assert.ok(turn.deadline > Date.now());

  for (const p of room.players) assert.strictEqual(p.hand.length, 5, '全员 5 张手牌');
  assert.strictEqual(others[0].last('yourTurn'), undefined, '非当前玩家不应收到 yourTurn');
});

/* ============================================================
 * 3. BUG-001 回归（核心）
 * ============================================================ */

test('回归 BUG-001：出牌后调用 sendTurn 不抛异常，下家 yourTurn 携带 beats/actions 键', (t) => {
  const h = makeHarness({ pickupDelayMs: 60 * 1000 }); // 拉长，先只验证「不抛异常」
  t.after(() => h.dispose());

  const { host, victimSocket, room } = forceNoLegalMoves(h);

  // 旧实现：moves.beatIds 为 undefined → TypeError → 被 handler 捕获 → 客户端收到假「操作失败」
  assert.deepStrictEqual(host.all('error'), [], '出牌不应产生任何 error 事件');
  assert.strictEqual(room.currentPlayerId, victimSocket.playerId, '轮到下家');

  const turn = victimSocket.last('yourTurn');
  assert.ok(turn, '下家应收到 yourTurn');
  assert.deepStrictEqual(
    Object.keys(turn.legalMoves).sort(),
    ['actions', 'beats', 'opening'],
    'legalMoves 结构必须是 { opening, beats, actions }'
  );
  assert.strictEqual(turn.legalMoves.beats.length, 0, '下家压不住 K');
  assert.strictEqual(turn.legalMoves.actions.length, 0, '下家无 A/2 功能牌');
  assert.strictEqual(room.tablePile.length, 1, '此时尚未收牌（收牌由定时器负责）');
});

test('回归 BUG-001：无合法牌 → 定时器自动收牌（桌面清空、进入败牌堆、重发 yourTurn）', async (t) => {
  const h = makeHarness({ pickupDelayMs: 40 });
  t.after(() => h.dispose());

  const { victimSocket, victim, room } = forceNoLegalMoves(h);
  assert.strictEqual(room.tablePile.length, 1);

  await waitFor(() => room.tablePile.length === 0, { label: '自动收牌后桌面应清空' });

  assert.strictEqual(victim.penaltyPile.length, 1, '桌面牌应进入收牌者败牌堆');
  assert.strictEqual(room.topCard, null, '新一轮门槛牌清空');
  assert.strictEqual(room.currentPlayerId, victim.id, '收牌者成为新一轮先出者');
  assert.strictEqual(victim.hand.length, engine.HAND_SIZE, '收牌后补牌至 5 张');

  const turn = victimSocket.last('yourTurn');
  assert.ok(turn, '收牌后应重新下发 yourTurn');
  assert.strictEqual(turn.legalMoves.opening, true, '桌面已清空 = 新一轮任意出牌');

  const lastState = victimSocket.last('state');
  assert.strictEqual(lastState.tablePileCount, 0, '广播的 state 桌面已清空');
});

/* ============================================================
 * 4. 托管链路
 * ============================================================ */

test('超时托管：轮到自己超时不操作 → 自动打出最小可压牌', async (t) => {
  const h = makeHarness({ turnTimeoutMs: 40 });
  t.after(() => h.dispose());

  const { host, room } = startThree(h);
  const me = playerOf(room, host);
  assert.strictEqual(me.hand.length, 5);
  assert.strictEqual(room.tablePile.length, 0);

  await waitFor(() => room.tablePile.length >= 1, { label: '超时托管应自动出牌' });
  assert.ok(me.hand.length < 5, '托管后手牌减少');
  assert.deepStrictEqual(host.all('error'), [], '托管不应产生 error 事件');
});

test('掉线快速托管：当前玩家断线 → 快速超时内自动行动，不再需要等待完整回合超时', async (t) => {
  const h = makeHarness({ disconnectedTurnMs: 30, turnTimeoutMs: 60 * 1000, reconnectGraceMs: 60 * 1000 });
  t.after(() => h.dispose());

  const { host, room } = startThree(h);
  const me = playerOf(room, host);
  assert.strictEqual(me.hand.length, 5);

  host.send('disconnect');
  assert.strictEqual(me.connected, false);

  await waitFor(() => room.tablePile.length >= 1, { label: '掉线玩家应在 disconnectedTurnMs 内被托管' });
  assert.ok(me.hand.length < 5, '掉线玩家的手牌由托管打出');
});

/* ============================================================
 * 5. 非法出牌 / 收牌校验
 * ============================================================ */

test('非法出牌：不存在的牌 id → ILLEGAL_CARD，且房间状态不被破坏', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const { host, room } = startThree(h);
  host.clear();

  host.send('playCard', { cardIds: ['not-a-real-card'] });
  assert.strictEqual(host.last('error').code, 'ILLEGAL_CARD');
  assert.strictEqual(room.tablePile.length, 0, '非法出牌不应改变桌面');
  assert.strictEqual(room.currentPlayerId, host.playerId, '仍应是该玩家出牌');
});

test('非法出牌：压不住门槛牌 → ILLEGAL_CARD', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const { host, room } = startThree(h);
  const me = playerOf(room, host);
  const top = MONSTER('K');
  const small = MONSTER('4');
  room.topCard = top;
  room.topCount = 1;
  room.tablePile = [top];
  me.hand = [small];
  host.clear();

  host.send('playCard', { cardIds: [small.id] });
  assert.strictEqual(host.last('error').code, 'ILLEGAL_CARD');
  assert.strictEqual(me.hand.length, 1, '手牌不应被扣除');
});

test('非法收牌：还有牌可出时收牌 → MUST_PLAY', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const { host, room } = startThree(h);
  host.clear();
  host.send('pickUp');
  assert.strictEqual(host.last('error').code, 'MUST_PLAY');
  assert.strictEqual(room.phase, 'playing');
});

/* ============================================================
 * 6. 断线重连（BUG-004：令牌校验）
 * ============================================================ */

test('rejoin：令牌正确 → 回到原座位、手牌数量正确、轮到自己时补发 yourTurn', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const { host, code, room } = startThree(h);
  const token = host.last('roomJoined').rejoinToken;
  const pid = host.playerId;
  const seatBefore = playerOf(room, host).seat;
  const handCount = playerOf(room, host).hand.length;

  host.send('disconnect');
  assert.strictEqual(playerOf(room, host).connected, false);
  assert.strictEqual(room.currentPlayerId, pid, '房主仍是当前玩家');

  const revived = h.connect('s-host-again');
  revived.send('rejoin', { roomCode: code, playerId: pid, rejoinToken: token });

  const joined = revived.last('roomJoined');
  assert.ok(joined, '重连成功应回执 roomJoined');
  assert.strictEqual(joined.youId, pid);
  assert.strictEqual(joined.rejoinToken, token, '令牌随回执再次下发，供前端持久化');
  assert.strictEqual(joined.state.hand.length, handCount, '手牌数量一致');
  assert.strictEqual(joined.state.players.find((p) => p.id === pid).seat, seatBefore, '回到原座位');
  // 接管之后座位属于新连接，必须用 revived 反查（旧 socket 的身份已被作废）
  assert.strictEqual(playerOf(room, revived).connected, true);
  assert.strictEqual(host.stale, true, '旧连接应被标记 stale');
  assert.strictEqual(host.playerId, null, '旧连接的身份应被作废（P2-11：否则仍能反查到房间）');

  const turn = revived.last('yourTurn');
  assert.ok(turn, '轮到自己时应立即补发 yourTurn');
  assert.ok(Array.isArray(turn.legalMoves.beats) && Array.isArray(turn.legalMoves.actions));
});

test('rejoin 无令牌 / 令牌错误 → BAD_TOKEN，座位不被接管', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const { host, code, room } = startThree(h);
  const pid = host.playerId;
  host.send('disconnect');

  const noToken = h.connect('s-attacker');
  noToken.send('rejoin', { roomCode: code, playerId: pid });
  assert.strictEqual(noToken.last('error').code, 'BAD_TOKEN');
  assert.strictEqual(noToken.last('roomJoined'), undefined);
  assert.strictEqual(playerOf(room, host).connected, false, '未通过校验不得改连接状态');

  const badToken = h.connect('s-attacker2');
  badToken.send('rejoin', { roomCode: code, playerId: pid, rejoinToken: 'forged-token' });
  assert.strictEqual(badToken.last('error').code, 'BAD_TOKEN');
  assert.strictEqual(noToken.playerId, null);
  assert.strictEqual(badToken.playerId, null);
});

/* ============================================================
 * 7. 房间回收（宽限期 / GC）
 * ============================================================ */

test('全员掉线且宽限期结束 → 房间被回收（rooms 中不再存在该 roomCode）', async (t) => {
  const h = makeHarness({ reconnectGraceMs: 30, turnTimeoutMs: 60 * 1000, disconnectedTurnMs: 60 * 1000 });
  t.after(() => h.dispose());

  const { host, others, code } = startThree(h);
  for (const s of [host, ...others]) s.send('disconnect');
  assert.ok(h.rooms.has(code), '宽限期内房间应保留（可重连）');

  await waitFor(() => !h.rooms.has(code), { label: '宽限期结束后房间应被回收' });
});

test('GC：waiting 阶段全员离线超过 5 分钟阈值 → 房间被清理（BUG-005）', async (t) => {
  const h = makeHarness({
    roomGcIntervalMs: 10,
    roomGcWaitingIdleMs: 30,
    roomGcAllOfflineMs: 60 * 60 * 1000,
    reconnectGraceMs: 60 * 60 * 1000, // 让宽限期分支不参与，只验证 GC
  });
  t.after(() => h.dispose());

  const host = h.connect('s1');
  host.send('createRoom', { nickname: '悟空' });
  const code = host.last('roomJoined').roomCode;
  host.send('disconnect');

  await waitFor(() => !h.rooms.has(code), { label: 'waiting 房间应被 GC 回收' });
});

test('GC：对局中全员离线超过 10 分钟阈值 → 房间被清理（BUG-005）', async (t) => {
  const h = makeHarness({
    roomGcIntervalMs: 10,
    roomGcWaitingIdleMs: 10 * 60 * 1000,
    roomGcAllOfflineMs: 40,
    reconnectGraceMs: 60 * 60 * 1000,
    turnTimeoutMs: 60 * 1000,
    disconnectedTurnMs: 60 * 1000,
  });
  t.after(() => h.dispose());

  const { host, others, code } = startThree(h);
  for (const s of [host, ...others]) s.send('disconnect');

  await waitFor(() => !h.rooms.has(code), { label: 'playing 房间应被 GC 回收' });
});

/* ============================================================
 * 8. 按人定制广播（防作弊）
 * ============================================================ */

test('广播按人定制：每人只收到自己的手牌，看不到他人的手牌 id', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const { host, others, room } = startThree(h);
  const aId = host.playerId;
  const bId = others[0].playerId;
  const aHand = playerOf(room, host).hand.map((c) => c.id);
  const bHand = playerOf(room, others[0]).hand.map((c) => c.id);

  const aState = host.last('state');
  const bState = others[0].last('state');
  assert.ok(aState && bState);

  assert.deepStrictEqual(aState.hand.map((c) => c.id).sort(), aHand.slice().sort(), 'A 看到自己的手牌');
  assert.deepStrictEqual(bState.hand.map((c) => c.id).sort(), bHand.slice().sort(), 'B 看到自己的手牌');
  assert.strictEqual(aState.youId, aId);
  assert.strictEqual(bState.youId, bId);
  for (const id of bHand) assert.ok(!aState.hand.some((c) => c.id === id), 'A 不得看到 B 的手牌');
  assert.ok(!JSON.stringify(aState).includes(bHand[0]), 'state 序列化后也不得含他人手牌 id');
  // 他人只暴露数量
  assert.strictEqual(aState.players.find((p) => p.id === bId).handCount, 5);
});

/* ============================================================
 * 9. nextRound 权限与防误触（BUG-003）
 * ============================================================ */

test('nextRound：非房主触发 → NOT_OWNER', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const { host, others, room } = forceSettle(h);
  assert.strictEqual(room.phase, 'settling');
  assert.ok(host.last('gameEnd'), '结算应下发 gameEnd');

  others[0].clear();
  others[0].send('nextRound');
  assert.strictEqual(others[0].last('error').code, 'NOT_OWNER');
  assert.strictEqual(room.phase, 'settling', '非房主无法把全房拉回等待');
});

test('nextRound：结算后冷却期内忽略（防误触），冷却后房主可开下一局且重复点击不报错', async (t) => {
  const h = makeHarness({ nextRoundCooldownMs: 60 });
  t.after(() => h.dispose());

  const { host, room } = forceSettle(h);
  assert.strictEqual(room.phase, 'settling');

  host.clear();
  host.send('nextRound'); // 冷却期内：静默忽略
  assert.strictEqual(room.phase, 'settling', '冷却期内不应被误触拉回等待');
  assert.deepStrictEqual(host.all('error'), [], '防误触不应弹错误提示');

  await sleep(80);
  host.send('nextRound');
  assert.strictEqual(room.phase, 'waiting', '冷却结束后房主可开下一局');
  for (const p of room.players) {
    assert.strictEqual(p.hand.length, 0);
    assert.strictEqual(p.ready, false);
  }

  host.clear();
  host.send('nextRound'); // 非 settling 阶段重复点击：幂等，不报错
  assert.deepStrictEqual(host.all('error'), [], '重复点击不应产生「操作失败」');
  assert.strictEqual(room.phase, 'waiting');
});

/* ============================================================
 * 10. 离开房间
 * ============================================================ */

test('leaveRoom：waiting 阶段最后一人离开 → 房间从 rooms 中移除', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const host = h.connect('s1');
  host.send('createRoom', { nickname: '悟空' });
  const code = host.last('roomJoined').roomCode;
  const guest = h.connect('s2');
  guest.send('joinRoom', { roomCode: code, nickname: '八戒' });

  host.send('leaveRoom');
  assert.strictEqual(h.rooms.get(code).players.length, 1, '房主离开后房主移交给剩下的人');
  assert.strictEqual(h.rooms.get(code).ownerId, 's2');

  guest.send('leaveRoom');
  assert.ok(!h.rooms.has(code), '最后一人离开后房间移除');
});

/* ============================================================
 * 11. 整局闭环（防卡局回归）
 * ============================================================ */

test('整局闭环：连续出牌/收牌直到 settling，全程无 error（防卡局）', (t) => {
  const h = makeHarness({ turnTimeoutMs: 60 * 1000, pickupDelayMs: 60 * 1000 });
  t.after(() => h.dispose());

  const { host, others, room } = startThree(h);
  const socketOf = new Map([[host.playerId, host], ...others.map((s) => [s.playerId, s])]);

  let steps = 0;
  while (room.phase === 'playing' && steps < 2000) {
    steps += 1;
    const cur = room.players.find((p) => p.id === room.currentPlayerId);
    assert.ok(cur, `第 ${steps} 步：当前玩家必须存在`);
    const socket = socketOf.get(cur.id);
    const moves = engine.computeLegalMoves(room, cur.id);
    if (moves.beats.length > 0 || moves.actions.length > 0) {
      const ids = moves.beats.length > 0 ? moves.beats[0] : [moves.actions[0]];
      socket.send('playCard', { cardIds: ids });
    } else {
      socket.send('pickUp');
    }
    for (const s of socketOf.values()) {
      assert.deepStrictEqual(s.all('error'), [], `第 ${steps} 步不应出现客户端错误提示`);
    }
  }

  assert.strictEqual(room.phase, 'settling', `整局应能走到结算（实际步数 ${steps}）`);
  assert.ok(room.lastResult, '结算应产出 lastResult');
  assert.ok(host.last('gameEnd'), '应下发 gameEnd');
  assert.ok(steps < 2000, '不应依赖步数上限收敛（说明没有卡局）');

  // 结算后房主可开下一局（冷却为注入的 0）
  host.send('nextRound');
  assert.strictEqual(room.phase, 'waiting', '结算后应能回到等待房');
});

/* ============================================================
 * 12. 定时参数契约
 * ============================================================ */

test('DEFAULT_TIMINGS：默认值符合设计（30s 回合 / 8s 掉线托管 / 1.5s 收牌 / 60s 宽限 / 3s 防误触）', () => {
  assert.strictEqual(DEFAULT_TIMINGS.turnTimeoutMs, 30 * 1000);
  assert.strictEqual(DEFAULT_TIMINGS.disconnectedTurnMs, 8 * 1000);
  assert.strictEqual(DEFAULT_TIMINGS.pickupDelayMs, 1500);
  assert.strictEqual(DEFAULT_TIMINGS.reconnectGraceMs, 60 * 1000);
  assert.strictEqual(DEFAULT_TIMINGS.nextRoundCooldownMs, 3000);
  assert.strictEqual(DEFAULT_TIMINGS.roomGcIntervalMs, 60 * 1000);
  assert.strictEqual(DEFAULT_TIMINGS.roomGcWaitingIdleMs, 5 * 60 * 1000);
  assert.strictEqual(DEFAULT_TIMINGS.roomGcAllOfflineMs, 10 * 60 * 1000);
});

/* ============================================================
 * 13. 旧连接无权写（P2-11）
 *
 * rejoin 接管座位后，旧 socket（旧页签 / 幽灵连接）必须在**所有**写路径上失效：
 * 出牌、收牌、准备、开始、下一局、离开。校验集中在 roomOfPlayer()，这里逐条钉住，
 * 防止将来有人再往某条路径里加 handler 却忘了归属校验。
 * ============================================================ */

/**
 * 建 3 人局并开局，然后让 host 的座位被一条新连接接管，旧 socket 仍然存活
 * （不触发 disconnect —— 模拟「同一玩家开了两个页签」这种最坏情况）。
 */
function takeOverPlaying(h) {
  const { host, others, code, room } = startThree(h);
  const pid = host.playerId;
  const token = host.last('roomJoined').rejoinToken;
  const live = h.connect('s-host-live');
  live.send('rejoin', { roomCode: code, playerId: pid, rejoinToken: token });
  assert.ok(live.last('roomJoined'), '前置：新连接应接管成功');
  assert.strictEqual(host.playerId, null, '前置：旧连接身份已作废');
  return { old: host, live, others, code, room, pid };
}

/** 建 3 人 waiting 房，然后让 host 的座位被新连接接管（旧 socket 存活）。idp 用于同 harness 多房间时区分身份 */
function takeOverWaiting(h, idp = 'w') {
  const old = h.connect(`${idp}-host`);
  old.send('createRoom', { nickname: `${idp}悟空` });
  const code = old.last('roomJoined').roomCode;
  const token = old.last('roomJoined').rejoinToken;
  const others = ['八戒', '沙僧'].map((name, i) => {
    const s = h.connect(`${idp}-other-${i}`);
    s.send('joinRoom', { roomCode: code, nickname: `${idp}${name}` });
    return s;
  });
  const pid = old.playerId;
  const live = h.connect(`${idp}-host-live`);
  live.send('rejoin', { roomCode: code, playerId: pid, rejoinToken: token });
  assert.ok(live.last('roomJoined'), '前置：新连接应接管成功');
  return { old, live, others, code, room: h.rooms.get(code), pid };
}

test('P2-11 回归：旧连接出牌被拒，手牌与桌面不变', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const { old, room, pid } = takeOverPlaying(h);
  const me = room.players.find((p) => p.id === pid);
  // 此时正轮到该玩家且桌面为空（开轮任意出牌）→ 若校验缺失，这一手会真的打出去
  assert.strictEqual(room.currentPlayerId, pid, '前置：轮到该玩家');
  assert.strictEqual(room.tablePile.length, 0, '前置：桌面为空');
  const handBefore = me.hand.map((c) => c.id);

  old.clear();
  old.send('playCard', { cardIds: [me.hand[0].id] });

  assert.ok(old.last('error'), '旧连接出牌必须被拒（否则幽灵连接可代打）');
  assert.strictEqual(old.last('error').code, 'ROOM_NOT_FOUND');
  assert.deepStrictEqual(me.hand.map((c) => c.id), handBefore, '手牌不得被旧连接改动');
  assert.strictEqual(room.tablePile.length, 0, '桌面不得被旧连接改动');
});

test('P2-11 回归：旧连接收牌被拒，败牌堆不变（同一操作由新连接执行则成功）', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const { old, live, room, pid } = takeOverPlaying(h);
  const me = room.players.find((p) => p.id === pid);
  // 构造「无牌可出」局面：门槛 K，手上只有压不住的 4 → 正常收牌会成功
  const top = MONSTER('K');
  room.topCard = top;
  room.topCount = 1;
  room.tablePile = [top];
  me.hand = [MONSTER('4')];

  old.clear();
  old.send('pickUp');
  assert.ok(old.last('error'), '旧连接收牌必须被拒');
  assert.strictEqual(old.last('error').code, 'ROOM_NOT_FOUND');
  assert.strictEqual(me.penaltyPile.length, 0, '败牌堆不得被旧连接改动');
  assert.strictEqual(room.tablePile.length, 1, '桌面不得被旧连接清空');

  // 反证：同一操作由接管后的新连接执行 → 成功（守卫不能写成「谁都写不了」）
  live.clear();
  live.send('pickUp');
  assert.deepStrictEqual(live.all('error'), [], '新连接收牌不应报错');
  assert.strictEqual(me.penaltyPile.length, 1, '新连接收牌生效：桌面牌进入败牌堆');
  assert.strictEqual(room.tablePile.length, 0, '新连接收牌生效：桌面清空');
});

test('P2-11 回归：旧连接 ready / start 被拒（准备状态与房间阶段不变）', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const { old, live, others, room } = takeOverWaiting(h);
  // 前置：全员已准备 —— 这样「旧连接 start」若被放行就会真的开局
  live.send('ready', { ready: true });
  for (const s of others) s.send('ready', { ready: true });
  assert.ok(room.players.every((p) => p.ready), '前置：全员已准备');

  old.clear();
  old.send('ready', { ready: false });
  assert.strictEqual(old.last('error').code, 'ROOM_NOT_FOUND', '旧连接不得改准备状态');
  assert.ok(room.players.every((p) => p.ready), '准备状态未被旧连接改动');

  old.clear();
  old.send('start');
  assert.strictEqual(old.last('error').code, 'ROOM_NOT_FOUND', '旧连接不得开局');
  assert.strictEqual(room.phase, 'waiting', '旧连接不得把房间推进到对局中');
});

test('P2-11 回归：旧连接 nextRound 被拒（结算页不被旧连接点掉）', (t) => {
  const h = makeHarness({ nextRoundCooldownMs: 0 });
  t.after(() => h.dispose());

  const { host, room } = forceSettle(h); // 房主 = 结算后唯一有权开下一局的人
  const pid = host.playerId;
  // forceSettle 内部清过 host 的事件记录，令牌直接从玩家对象取（它才是权威来源）
  const token = room.players.find((p) => p.id === pid).rejoinToken;
  assert.strictEqual(room.phase, 'settling');

  const live = h.connect('s-host-live');
  live.send('rejoin', { roomCode: room.roomCode, playerId: pid, rejoinToken: token });
  assert.ok(live.last('roomJoined'), '前置：新连接应接管成功');

  host.clear();
  host.send('nextRound');
  assert.strictEqual(host.last('error').code, 'ROOM_NOT_FOUND', '旧连接不得点掉结算页');
  assert.strictEqual(room.phase, 'settling', '房间仍停在结算页');

  // 反证：新连接（房主）可以正常开下一局
  live.clear();
  live.send('nextRound');
  assert.deepStrictEqual(live.all('error'), []);
  assert.strictEqual(room.phase, 'waiting', '新连接可正常开下一局');
});

test('P2-11 回归：旧连接 leaveRoom 不得踢出在线玩家、房主不转移、房间仍在', (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const { old, room, code, pid } = takeOverWaiting(h);
  const playersBefore = room.players.length;

  old.clear();
  old.send('leaveRoom');

  assert.ok(old.last('error'), '旧连接操作房间必须被拒（否则旧页签能静默把自己踢掉）');
  assert.strictEqual(room.players.length, playersBefore, '在线玩家不得被踢出');
  assert.strictEqual(room.ownerId, pid, '房主身份不得被夺走');
  assert.ok(h.rooms.has(code), '房间应仍然存在');
  assert.ok(room.players.some((p) => p.id === pid && p.connected), '该玩家仍在线');
});

test('P2-11 反证：接管后的新连接写权限完整（playCard / ready / start / leaveRoom 全部成功）', (t) => {
  const hp = makeHarness();
  t.after(() => hp.dispose());
  const hw = makeHarness({ nextRoundCooldownMs: 0 });
  t.after(() => hw.dispose());

  // ① 对局中：新连接出牌生效
  const g = takeOverPlaying(hp);
  const me = g.room.players.find((p) => p.id === g.pid);
  g.live.clear();
  g.live.send('playCard', { cardIds: [me.hand[0].id] });
  assert.deepStrictEqual(g.live.all('error'), [], '新连接出牌不应报错');
  assert.strictEqual(me.hand.length, 4, '新连接出牌生效（手牌 5→4）');
  assert.strictEqual(g.room.tablePile.length, 1, '新连接出牌生效（桌面 0→1）');

  // ② 等待房：新连接 ready → start → leaveRoom 全部生效
  const w = takeOverWaiting(hw);
  const meW = w.room.players.find((p) => p.id === w.pid);
  w.live.clear();
  w.live.send('ready', { ready: true });
  assert.deepStrictEqual(w.live.all('error'), [], '新连接准备不应报错');
  assert.strictEqual(meW.ready, true, '新连接准备生效');

  for (const s of w.others) s.send('ready', { ready: true });
  w.live.clear();
  w.live.send('start');
  assert.deepStrictEqual(w.live.all('error'), [], '新连接（房主）开局不应报错');
  assert.strictEqual(w.room.phase, 'playing', '新连接开局生效');

  w.live.clear();
  w.live.send('leaveRoom'); // 对局中离开 = 标记掉线、保留座位
  assert.deepStrictEqual(w.live.all('error'), [], '新连接离开不应报错');
  assert.strictEqual(meW.connected, false, '新连接离开生效（标记掉线）');

  // ③ 等待房：新连接离开 → 玩家真的被移除（守卫不能把合法离开也拦掉）
  const x = takeOverWaiting(hw, 'x');
  const playersBefore = x.room.players.length;
  x.live.clear();
  x.live.send('leaveRoom');
  assert.deepStrictEqual(x.live.all('error'), []);
  assert.strictEqual(x.room.players.length, playersBefore - 1, '合法离开应真正移除玩家');
});
