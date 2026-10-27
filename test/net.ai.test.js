'use strict';

/**
 * test/net.ai.test.js — AI 补位的协议层验收（1 真人 + 2 AI 能完整跑完一局）。
 *
 * 为什么需要这一层：
 *   test/ai.test.js 只能证明「策略在手工摆的局面里选得对」，
 *   test/net.test.js 只能证明「人 → 人 的回合流转」。
 *   两者都覆盖不到「AI 没有 socket 时回合还能不能推进」——而 AI 一旦卡住，
 *   整桌就会永久停在某个 AI 的回合上（本项目最贵的故障模式）。
 *   这里用真实 engine + 真实 net，只把 io / socket / 定时器换成极短的假件，
 *   让 1 真人（AFK，由超时托管代打）+ 2 AI 把一副 54 张牌真的打到底。
 *
 * 注：真人之所以「不主动出牌」而是靠超时托管代打，是为了让每回合只有唯一行动者
 * （定时器），从而不存在「托管与真人同时动作」的竞态 —— 断言「全程 0 个 error 事件」才有意义。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { initNet } = require('../net/net.js');

/* ============================================================
 * 假 socket / 假 io / 注入定时参数（与 test/net.test.js 同构，故意不共享文件，
 * 免得一处的脚手架改动牵连另一处的用例）
 * ============================================================ */

function makeFakeSocket(id) {
  const handlers = new Map();
  const socket = {
    id,
    playerId: null,
    emitted: [],
    joinedRooms: new Set(),
    emit(name, payload) { socket.emitted.push({ name, payload }); },
    on(name, handler) { handlers.set(name, handler); },
    join(code) { socket.joinedRooms.add(code); },
    leave(code) { socket.joinedRooms.delete(code); },
    send(name, payload) {
      const handler = handlers.get(name);
      assert.ok(handler, `服务端未注册事件 '${name}'`);
      handler(payload);
    },
    last(name) {
      for (let i = socket.emitted.length - 1; i >= 0; i--) {
        if (socket.emitted[i].name === name) return socket.emitted[i].payload;
      }
      return undefined;
    },
    all(name) {
      return socket.emitted.filter((e) => e.name === name).map((e) => e.payload);
    },
  };
  return socket;
}

/** AI 对局用的极短定时参数（详见文件头注释） */
const AI_TIMINGS = {
  reconnectGraceMs: 5000,
  // 真实玩家默认 30s 超时；这里让 AFK 真人 15ms 就被托管代打，一局才跑得完
  turnTimeoutMs: 15,
  disconnectedTurnMs: 15,
  pickupDelayMs: 5,
  offlinePickupDelayMs: 5,
  nextRoundCooldownMs: 0,
  aiThinkMs: 3,
  roomGcIntervalMs: 60 * 60 * 1000,
  roomGcWaitingIdleMs: 60 * 60 * 1000,
  roomGcAllOfflineMs: 60 * 60 * 1000,
};

function makeHarness(overrides = {}) {
  const rooms = new Map();
  const sockets = new Map();
  const timings = { ...AI_TIMINGS, ...overrides };

  let connectionHandler = null;
  const io = {
    sockets: { sockets },
    on(event, handler) { if (event === 'connection') connectionHandler = handler; },
  };

  const net = initNet(io, rooms, timings);

  return {
    io,
    rooms,
    sockets,
    timings,
    connect(id) {
      assert.ok(connectionHandler, 'connection 处理器未注册');
      const socket = makeFakeSocket(id);
      sockets.set(id, socket);
      connectionHandler(socket);
      return socket;
    },
    dispose() { net.dispose(); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, { timeout = 20000, interval = 5, label = '' } = {}) {
  const start = Date.now();
  for (;;) {
    if (cond()) return Date.now() - start;
    if (Date.now() - start > timeout) throw new Error(`waitFor 超时${label ? `：${label}` : ''}`);
    await sleep(interval);
  }
}

/** 建房 + 加 N 个 AI + 真人准备 + 开局 */
function startWithAI(h, { ais = 2, nickname = '真人' } = {}) {
  const host = h.connect('s-host');
  host.send('createRoom', { nickname });
  const code = host.last('roomJoined').roomCode;
  const added = [];
  for (let i = 0; i < ais; i++) {
    const before = h.rooms.get(code).players.length;
    host.send('addAI');
    // addAI 的返回值只能是「人数 +1」或一条 error；这里把成功的情况收集起来
    const room = h.rooms.get(code);
    if (room.players.length === before + 1) added.push(room.players[room.players.length - 1]);
  }
  host.send('ready', { ready: true });
  host.send('start');
  return { host, code, room: h.rooms.get(code), added };
}

/* ============================================================
 * 1. 主链路：1 真人 + 2 AI 打到 settling
 * ============================================================ */

test('1 真人 + 2 AI 能完整跑完一局：到 settling 且全程 0 个 error 事件', { timeout: 40000 }, async (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  // 捕获 console.error：AI 决策一旦抛错会「静默降级到 autoPlay」，牌局照样能打完，
  // 只靠「到达 settling」是抓不住策略 bug 的 —— 必须同时证明降级路径没被走过。
  const realError = console.error;
  const captured = [];
  console.error = (...args) => { captured.push(args.map((a) => String(a)).join(' ')); };
  t.after(() => { console.error = realError; });

  const { host, room, added } = startWithAI(h, { ais: 2 });

  // 前置：AI 已入座、永远就绪、没有 socket
  assert.strictEqual(room.players.length, 3);
  assert.strictEqual(added.length, 2, '两次 addAI 应各自成功');
  for (const p of added) {
    assert.ok(p.isAI, 'AI 标记必须为 true');
    assert.strictEqual(p.socketId, null, 'AI 不应有 socketId');
    assert.strictEqual(p.connected, true);
    assert.strictEqual(p.ready, true, 'AI 入座即就绪，否则房主永远等不到全员准备');
    assert.match(p.id, /^ai-/);
  }
  assert.strictEqual(room.phase, 'playing', 'start 应把房间推进到 playing');
  assert.strictEqual(room.roundNumber, 1);

  const elapsed = await waitFor(() => room.phase === 'settling', { timeout: 30000, label: '第 1 局打到 settling' });

  assert.strictEqual(room.phase, 'settling');
  assert.ok(room.lastResult, 'settling 必须有结算结果');
  assert.strictEqual(room.lastResult.results.length, 3, '结算表应含全部 3 名玩家（含 AI）');
  assert.ok(room.lastResult.winnerId, '必须有通杀者');
  assert.ok(
    room.lastResult.results.every((r) => typeof r.penaltyCount === 'number'),
    '每个结算项都要有败牌数'
  );
  assert.deepStrictEqual(host.all('error'), [], '全程不应给真人推任何 error（有就是某条路径在抛错）');
  assert.ok(host.last('gameEnd'), '真人应收到 gameEnd');

  const degradations = captured.filter((line) => line.includes('[net] AI 决策失败') || line.includes('[net] AI 降级'));
  assert.deepStrictEqual(degradations, [], `AI 策略不应依赖 autoPlay 降级兜底：\n${degradations.join('\n')}`);
  t.diagnostic(`第 1 局耗时 ${elapsed}ms，通杀者 ${room.lastResult.winnerId}`);

  // AI 也必须真的出过牌 / 收过牌，而不是被跳过
  assert.ok(room.eventLog.length > 0, '事件日志不应为空（说明确实在出牌）');
});

test('★AI 走的是策略而不是超时托管：开轮手握 4 张同点 → 真的打出 4 张组合', { timeout: 10000 }, async (t) => {
  // 真人回合超时拉长到 60s：整局里唯一的行动者就是 AI，杜绝「托管恰好也这么打」的巧合
  const h = makeHarness({ turnTimeoutMs: 60 * 1000 });
  t.after(() => h.dispose());

  const { host, room, added } = startWithAI(h, { ais: 2 });
  const ai = added[0];
  assert.strictEqual(room.phase, 'playing');

  // 手工摆一个开轮局面：轮到 ai0、无门槛牌、手牌 = 4 张同点 + 1 张单牌
  ai.hand = [
    { id: 'crafted_0', rank: '4', suit: '♠', kind: 'monster' },
    { id: 'crafted_1', rank: '4', suit: '♥', kind: 'monster' },
    { id: 'crafted_2', rank: '4', suit: '♣', kind: 'monster' },
    { id: 'crafted_3', rank: '4', suit: '♦', kind: 'monster' },
    { id: 'crafted_k', rank: 'K', suit: '♠', kind: 'monster' },
  ];
  room.topCard = null;
  room.topCount = 1;
  room.tablePile = [];
  room.currentPlayerId = ai.id;

  // 触发 AI 回合：对 playing 阶段再发一次 start 会走幂等分支（broadcastState + sendTurn(当前玩家)）
  host.send('start');

  // 用「广播过的 state 快照」断言，而不是读实时 room —— 后续回合继续推进也不影响已发出的快照
  await waitFor(() => host.all('state').some((s) => s.topCount === 4), { timeout: 3000, label: 'AI 打出 4 张组合' });
  const first = host.all('state').find((s) => s.tablePileCount > 0);
  assert.ok(first, '应至少广播过一次「桌面上有牌」的状态');
  assert.strictEqual(first.topCount, 4, 'AI 的开局动作必须是 4 张同点（托管策略在开轮只会打 1 张 → 这条会红）');
  assert.strictEqual(first.tablePileCount, 4);
  assert.strictEqual(first.players.find((p) => p.id === ai.id).handCount, 1, 'AI 应恰好打掉 4 张');
  assert.ok(
    first.eventLog.some((e) => e.includes('×4')),
    `事件日志应记录这次 4 张出牌：${first.eventLog.join(' | ')}`
  );
  assert.deepStrictEqual(host.all('error'), []);
});

test('连跑 3 局：每局都能到 settling（AI 每局自动就绪，无需人工干预）', { timeout: 60000 }, async (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const { host, room } = startWithAI(h, { ais: 2 });
  const costs = [];

  for (let round = 1; round <= 3; round++) {
    if (round > 1) {
      host.send('nextRound');
      assert.strictEqual(room.phase, 'waiting', `第 ${round} 局：nextRound 应回到 waiting`);
      // AI 由 engine.nextRound 自动置 ready，真人必须自己再点一次准备
      const aiReady = room.players.filter((p) => p.isAI).every((p) => p.ready);
      assert.ok(aiReady, `第 ${round} 局：AI 应已自动就绪（否则下面的 start 会 NOT_READY）`);
      host.send('ready', { ready: true });
      host.send('start');
      assert.strictEqual(room.phase, 'playing', `第 ${round} 局：start 失败`);
    }
    assert.strictEqual(room.roundNumber, round);
    costs.push(await waitFor(() => room.phase === 'settling', { timeout: 20000, label: `第 ${round} 局` }));
  }

  assert.deepStrictEqual(host.all('error'), [], '3 局全程不应给真人推任何 error');
  t.diagnostic(`3 局耗时 ${costs.join(' / ')}ms`);
});

/* ============================================================
 * 2. addAI / removeAI 的权限与边界
 * ============================================================ */

test('addAI：非房主 NOT_OWNER、对局中 GAME_RUNNING、满 6 人 ROOM_FULL', { timeout: 20000 }, async (t) => {
  // 这条只验权限与边界，故意把 AI 思考与人回合超时拉长，让对局停在原地不自行推进
  const h = makeHarness({ turnTimeoutMs: 60 * 1000, aiThinkMs: 60 * 1000 });
  t.after(() => h.dispose());

  const host = h.connect('s-host');
  host.send('createRoom', { nickname: '房主' });
  const code = host.last('roomJoined').roomCode;

  // 非房主
  const guest = h.connect('s-guest');
  guest.send('joinRoom', { roomCode: code, nickname: '客人' });
  guest.send('addAI');
  assert.strictEqual(guest.last('error').code, 'NOT_OWNER');

  // 2 真人 + 4 AI 加满 6 人
  for (let i = 0; i < 4; i++) host.send('addAI');
  const room = h.rooms.get(code);
  assert.strictEqual(room.players.length, 6, '2 真人 + 4 AI = 6');
  const ais = room.players.filter((p) => p.isAI);
  assert.strictEqual(ais.length, 4);
  assert.strictEqual(new Set(ais.map((p) => p.name)).size, 4, `AI 名字不能重复：${ais.map((p) => p.name).join(',')}`);
  assert.strictEqual(new Set(ais.map((p) => p.id)).size, 4, 'AI 的 id 必须唯一');
  assert.deepStrictEqual(ais.map((p) => p.name), ['悟能', '悟净', '白龙', '金角'], '按 AI_NAMES 顺序取未被占用的名字');

  host.send('addAI');
  assert.strictEqual(host.last('error').code, 'ROOM_FULL');

  // 对局中加 AI
  host.send('ready', { ready: true });
  guest.send('ready', { ready: true });
  host.send('start');
  assert.strictEqual(room.phase, 'playing');
  host.send('addAI');
  assert.strictEqual(host.last('error').code, 'GAME_RUNNING');

  // getView 暴露 isAI（前端据此换徽标）
  const view = host.last('state');
  assert.strictEqual(view.players.filter((p) => p.isAI).length, 4);
  assert.strictEqual(view.players.find((p) => p.id === 's-host').isAI, false, '真人必须是 false 而不是 undefined');
});

test('removeAI：踢掉座位号最大的那个；没有 AI 时静默 no-op；非房主 NOT_OWNER', { timeout: 20000 }, async (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const host = h.connect('s-host');
  host.send('createRoom', { nickname: '房主' });
  const code = host.last('roomJoined').roomCode;
  const room = h.rooms.get(code);

  // 没有 AI 时踢：静默 no-op，不报错
  host.send('removeAI');
  assert.strictEqual(host.last('error'), undefined, '没有 AI 时踢 AI 不应报错');
  assert.strictEqual(room.players.length, 1);

  host.send('addAI');
  host.send('addAI');
  host.send('addAI');
  const ais = room.players.filter((p) => p.isAI);
  assert.strictEqual(ais.length, 3);
  const maxSeat = Math.max(...ais.map((p) => p.seat));
  const victim = ais.find((p) => p.seat === maxSeat);
  assert.ok(victim, '前置：应能定位座位号最大的 AI');

  host.send('removeAI');
  assert.strictEqual(room.players.filter((p) => p.isAI).length, 2, '每次只踢一个');
  assert.ok(!room.players.some((p) => p.id === victim.id), '踢掉的必须是座位号最大的那个 AI');
  assert.ok(room.players.every((p) => p.seat === room.players.indexOf(p)), '座位号必须在移除后重排连续');

  // 非房主
  const guest = h.connect('s-guest');
  guest.send('joinRoom', { roomCode: code, nickname: '客人' });
  guest.send('removeAI');
  assert.strictEqual(guest.last('error').code, 'NOT_OWNER');
});

/* ============================================================
 * 3. 「只数真人」的回收修正
 * ============================================================ */

test('真人离开 waiting 房（还剩 2 个 AI）→ 房间必须被回收，不残留 AI 僵尸房', { timeout: 10000 }, (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const host = h.connect('s-host');
  host.send('createRoom', { nickname: '房主' });
  const code = host.last('roomJoined').roomCode;
  host.send('addAI');
  host.send('addAI');
  assert.strictEqual(h.rooms.get(code).players.length, 3);

  host.send('leaveRoom');

  assert.strictEqual(h.rooms.has(code), false, '只剩 AI 的房间没人能开局，必须回收（原判据 players.length===0 会漏掉它）');
});

test('房主转移：A 建房 + 2 AI，B 加入后 A 离开 → 房主仍是真人 B（不是 AI）', { timeout: 10000 }, (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());

  const a = h.connect('s-a');
  a.send('createRoom', { nickname: '甲' });
  const code = a.last('roomJoined').roomCode;
  a.send('addAI');
  a.send('addAI');

  const b = h.connect('s-b');
  b.send('joinRoom', { roomCode: code, nickname: '乙' });
  const room = h.rooms.get(code);
  assert.strictEqual(room.ownerId, 's-a', '前置：房主是甲');

  a.send('leaveRoom');

  assert.strictEqual(h.rooms.has(code), true, '还有真人乙在，房间不能删');
  assert.strictEqual(room.ownerId, 's-b', '房主必须转移给真人乙');
  assert.ok(!room.players.some((p) => p.isAI && p.id === room.ownerId), '房主绝不能落到 AI 头上');
});

test('gcRooms：真人全离线的 waiting 房（剩 2 AI）会被巡检回收', { timeout: 10000 }, async (t) => {
  // 宽限期拉长到 60s，把「删房」的唯一责任人限定为 GC 巡检本身
  const h = makeHarness({
    roomGcIntervalMs: 5,
    roomGcWaitingIdleMs: 30,
    roomGcAllOfflineMs: 30,
    reconnectGraceMs: 60 * 1000,
  });
  t.after(() => h.dispose());

  const host = h.connect('s-host');
  host.send('createRoom', { nickname: '房主' });
  const code = host.last('roomJoined').roomCode;
  host.send('addAI');
  host.send('addAI');
  host.send('disconnect');

  const room = h.rooms.get(code);
  assert.ok(room, '前置：房间应还在');
  assert.strictEqual(room.players.filter((p) => !p.isAI)[0].connected, false, '前置：真人已离线');
  assert.ok(room.players.filter((p) => p.isAI).every((p) => p.connected), '前置：AI 恒在线');

  // 原判据 `players.every(p => !p.connected)` 会因为 AI 恒在线而永不成立 → 这条会超时变红
  await waitFor(() => !h.rooms.has(code), { timeout: 5000, label: 'GC 回收 AI 僵尸房' });
});

test('对局中真人掉线且宽限期到：AI 在座也不能阻止房间回收', { timeout: 10000 }, async (t) => {
  const h = makeHarness({ reconnectGraceMs: 40 });
  t.after(() => h.dispose());

  const { host, code, room } = startWithAI(h, { ais: 2 });
  assert.strictEqual(room.phase, 'playing');

  host.send('disconnect');
  assert.strictEqual(room.players.filter((p) => !p.isAI)[0].connected, false, '真人应被标记掉线');
  assert.ok(room.players.filter((p) => p.isAI).every((p) => p.connected), 'AI 恒在线');

  await waitFor(() => !h.rooms.has(code), { timeout: 5000, label: '宽限到期后删房' });
  assert.strictEqual(h.rooms.has(code), false, '真人全离线时必须回收，原判据 players.every(!connected) 因 AI 恒在线而永不成立');
});

/* ============================================================
 * 4. 跨局生命周期：AI 定时器不随局数增长（W1-QA-02）
 *
 * 为什么单独一条：
 *   AI 定时器跨局泄漏**不会让任何单局变红** —— 泄漏的那一个要等到它自己到期才会引发
 *   「同一 AI 被调度两次」，而且往往还要再过几局才表现为回合跳变/提前出牌。
 *   所以这里不看「某一局过没过」，而是逐局采样 net 定时器的**峰值**：
 *   1 个 GC 巡检 + 1 个当前动作定时器 = 恒为 2，一旦变成 3 就说明有定时器没被清掉。
 * ============================================================ */

/**
 * 定时器账本：只登记「调用栈里出现 net/net.js」的定时器。
 * 本文件自己的 `sleep()` 也走 setTimeout，若登记全部会把噪声算进去 —— 用栈帧过滤掉。
 */
function installTimerLedger() {
  const realST = global.setTimeout;
  const realCT = global.clearTimeout;
  const realSI = global.setInterval;
  const realCI = global.clearInterval;
  const live = new Map();
  let seq = 0;
  const fromNet = () => /net[\\/]net\.js/.test(new Error().stack || '');

  global.setTimeout = function (fn, ms, ...args) {
    const net = fromNet();
    const id = realST.call(global, (...x) => { live.delete(id); fn(...x); }, ms, ...args);
    if (net) live.set(id, { kind: 'timeout', delay: ms, seq: ++seq });
    return id;
  };
  global.clearTimeout = function (id) { live.delete(id); return realCT.call(global, id); };
  global.setInterval = function (fn, ms, ...args) {
    const net = fromNet();
    const id = realSI.call(global, fn, ms, ...args);
    if (net) live.set(id, { kind: 'interval', delay: ms, seq: ++seq });
    return id;
  };
  global.clearInterval = function (id) { live.delete(id); return realCI.call(global, id); };

  return {
    count: () => live.size,
    list: () => [...live.values()],
    restore() {
      // 先把还活着的 net 定时器全部掐掉，再还原全局。
      // 理由：用例中途断言失败时，牌局还停在 playing，残留的回合定时器会继续推进、
      // 自己再排下一个 —— 进程就迟迟不退出（神似「卡死」，但其实是测试卫生问题）。
      for (const [id, meta] of [...live.entries()]) {
        if (meta.kind === 'interval') realCI.call(global, id);
        else realCT.call(global, id);
        live.delete(id);
      }
      global.setTimeout = realST;
      global.clearTimeout = realCT;
      global.setInterval = realSI;
      global.clearInterval = realCI;
    },
  };
}

test('★跨局连打 5 局：net 定时器峰值恒为 2 不随局数增长，AI 每局自动就绪、先手=上局通杀者', { timeout: 60000 }, async (t) => {
  // 账本必须在 initNet 之前装好，否则连 GC 巡检定时器都统计不到
  const ledger = installTimerLedger();
  const h = makeHarness();
  t.after(() => {
    try {
      h.dispose(); // 先清 net 内部定时器
    } finally {
      ledger.restore(); // 再还原全局，避免影响后续用例
    }
  });

  const ROUNDS = 5;
  const { host, room } = startWithAI(h, { ais: 2 });
  assert.strictEqual(room.phase, 'playing', '前置：已开局');
  assert.strictEqual(room.players.filter((p) => p.isAI).length, 2, '前置：房内有 2 个 AI');

  const peaks = [];   // 每局采样到的定时器峰值
  const costs = [];   // 每局耗时
  let expectedFirst = room.ownerId; // 第 1 局没有上局通杀者 → 房主先手

  for (let round = 1; round <= ROUNDS; round++) {
    assert.strictEqual(room.phase, 'playing', `第 ${round} 局：应处于 playing（AI 未就绪会卡在 waiting）`);
    assert.strictEqual(room.roundNumber, round, `第 ${round} 局：roundNumber 应递增`);
    assert.strictEqual(
      room.currentPlayerId,
      expectedFirst,
      `第 ${round} 局：先手必须是「上局通杀者」${expectedFirst}（先手是 AI 时同样要正确）`
    );

    // 边推进边按 1ms 粒度采样账本（AI 思考 3ms / 真人托管 15ms，1ms 足够密）
    const t0 = Date.now();
    let peak = 0;
    while (room.phase === 'playing') {
      peak = Math.max(peak, ledger.count());
      if (Date.now() - t0 > 20000) {
        throw new Error(
          `第 ${round} 局 20s 内未到 settling（phase=${room.phase}, cur=${room.currentPlayerId}, ` +
          `桌面 ${room.tablePile.length} 张, 定时器 ${JSON.stringify(ledger.list())}）`
        );
      }
      await sleep(1);
    }
    costs.push(Date.now() - t0);
    peaks.push(peak);

    // ---- 每局的结算不变量 ----
    assert.strictEqual(room.phase, 'settling', `第 ${round} 局必须走到 settling`);
    const lr = room.lastResult;
    assert.ok(lr, `第 ${round} 局：settling 必须有结算结果`);
    assert.strictEqual(lr.results.length, room.players.length, `第 ${round} 局：结算必须覆盖全部 ${room.players.length} 人（含 AI）`);

    const minPenalty = Math.min(...room.players.map((p) => p.penaltyPile.length));
    const winner = room.players.find((p) => p.id === lr.winnerId);
    assert.ok(winner, `第 ${round} 局：通杀者必须在房内`);
    assert.strictEqual(
      winner.penaltyPile.length,
      minPenalty,
      `第 ${round} 局：通杀者必须是败牌最少者（${winner.name} ${winner.penaltyPile.length} 张 vs 最少 ${minPenalty} 张）`
    );
    assert.strictEqual(host.all('gameEnd').length, round, `第 ${round} 局后：真人应恰好收到 ${round} 次 gameEnd`);
    assert.deepStrictEqual(host.all('error'), [], `第 ${round} 局为止：全程不应给真人推任何 error`);

    // ---- 跨局：nextRound → waiting ----
    host.send('nextRound');
    assert.strictEqual(room.phase, 'waiting', `第 ${round} 局 nextRound 应回到 waiting`);
    const ais = room.players.filter((p) => p.isAI);
    assert.ok(
      ais.every((p) => p.ready),
      `第 ${round} 局后：AI 必须仍为已准备（否则房主点开始会被 NOT_READY 卡住，而 AI 永远不会自己点准备）`
    );
    const human = room.players.find((p) => !p.isAI);
    assert.strictEqual(human.ready, false, `第 ${round} 局后：真人应被清成未准备（需要自己再点一次）`);

    expectedFirst = lr.winnerId; // 下一局先手 = 本局通杀者

    if (round < ROUNDS) {
      host.send('ready', { ready: true });
      host.send('start');
      assert.strictEqual(room.phase, 'playing', `第 ${round} 局后：应能立刻再开一局（AI 未就绪这里就会停在 waiting）`);
    }
  }

  // 第 5 个循环的收尾：确认第 5 次 nextRound 之后同样能开起来（把「5 个完整循环」跑满）
  host.send('ready', { ready: true });
  host.send('start');
  assert.strictEqual(room.phase, 'playing', '第 5 次 nextRound 后仍必须能开局');
  assert.strictEqual(room.roundNumber, ROUNDS + 1, `应进入第 ${ROUNDS + 1} 局`);
  assert.strictEqual(room.currentPlayerId, expectedFirst, `第 ${ROUNDS + 1} 局先手应为第 ${ROUNDS} 局通杀者`);

  // ---- 本组用例的核心断言 ----
  const maxPeak = Math.max(...peaks);
  assert.strictEqual(
    maxPeak,
    2,
    `net 定时器峰值必须恒为 2（1 个 GC 巡检 + 1 个当前动作定时器），不随局数增长。` +
    `实测各局峰值：${JSON.stringify(peaks)}。` +
    '峰值 >2 说明有定时器跨局叠加/未清理 —— 这种泄漏不会让任何单局变红，只会跑久之后才炸'
  );

  t.diagnostic(`5 局耗时 ${costs.join(' / ')}ms；各局定时器峰值 ${JSON.stringify(peaks)}`);
});

/**
 * 上面那条「峰值恒为 2」的鉴别力从哪来：
 *   上面 5 局的正常流程里，任何时刻都只有「1 个当前动作定时器」，没有重复调度的入口 ——
 *   所以它抓的是**跨局泄漏**，抓不到「同一玩家被调度两次」。而后者有一个真实入口：
 *   `phase === 'playing'` 时再点「开始游戏」会走幂等分支，重新 `sendTurn(当前玩家)`；
 *   若当前玩家是 AI，就相当于又排了一次 scheduleAI。房主连点两下开始就会踩到（P2-05 同源）。
 *   这条用例把那一下点出来，钉住「重复调度必须被去重成 1 个定时器」。
 */
test('★对局中重复点「开始」（幂等分支）不得叠加 AI 定时器：同一 AI 只保留 1 个', { timeout: 20000 }, async (t) => {
  const ledger = installTimerLedger();
  // AI 思考拉到 400ms、真人回合拉到 60s：整条用例不需要等牌局推进，只数定时器，杜绝抢跑
  const h = makeHarness({ aiThinkMs: 400, turnTimeoutMs: 60 * 1000 });
  t.after(() => {
    try {
      h.dispose();
    } finally {
      ledger.restore();
    }
  });

  const { host, room, added } = startWithAI(h, { ais: 2 });
  assert.strictEqual(room.phase, 'playing', '前置：已开局');
  assert.strictEqual(room.currentPlayerId, host.playerId, '前置：第 1 局房主（真人）先手');

  // 前置账本：1 个 GC 巡检 + 1 个真人回合定时器
  assert.strictEqual(
    ledger.count(),
    2,
    `前置：开局后应恰好 2 个 net 定时器（GC 巡检 + 真人回合），实测 ${JSON.stringify(ledger.list())}`
  );

  // 把回合直接交给 AI（等价于「真人托管刚走完一手」，但不用等，避免抢跑）
  const ai = added[0];
  room.currentPlayerId = ai.id;

  // 第 1 次点「开始」：幂等分支 → sendTurn(AI) → scheduleAI
  host.send('start');
  const afterFirst = ledger.count();
  assert.strictEqual(
    afterFirst,
    3,
    `第 1 次 start 后应为 3 个（GC + 真人那个已成陈旧的回合定时器 + AI 回合），实测 ${JSON.stringify(ledger.list())}`
  );

  // 第 2、3 次点「开始」：每点一次都会再排一次 scheduleAI —— 但必须先清掉上一个同 pid 的 AI 定时器
  host.send('start');
  const afterSecond = ledger.count();
  host.send('start');
  const afterThird = ledger.count();

  assert.strictEqual(
    afterSecond,
    afterFirst,
    '第 2 次「开始」不得叠加 AI 定时器 —— 否则同一个 AI 会被调度多次（长跑后定时器数与唤醒次数无界增长，' +
    `极端时同一 AI 在一个回合里连动两次）。实测 ${JSON.stringify(ledger.list())}`
  );
  assert.strictEqual(
    afterThird,
    afterFirst,
    `连点 3 次后定时器数必须不增长（去重生效），实测 ${afterThird} 个：${JSON.stringify(ledger.list())}`
  );

  // 去重之后 AI 仍然只出一次手：让它想完，手牌只能少一次的量
  const handBefore = ai.hand.length;
  const pileBefore = room.tablePile.length;
  await sleep(600);
  const played = pileBefore === 0 ? handBefore - ai.hand.length : room.tablePile.length - pileBefore;
  assert.ok(played > 0, 'AI 必须仍然照常行动（去重不能把 AI 也去掉）');
  assert.ok(played <= 4, `一次回合最多打 4 张，实际少了/多了 ${played} 张（>4 说明同一回合被调度了多次）`);
  t.diagnostic(`连点 3 次 start 后定时器数 ${afterFirst} → ${afterSecond} → ${afterThird}，AI 本次出了 ${played} 张`);
});

