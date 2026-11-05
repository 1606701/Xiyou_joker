'use strict';

/**
 * test/net.endgame.test.js — 终局相关协议层护栏（W3-QA-RULE01 复核补）
 *
 * 【为什么单独一个文件】
 * 这两条都要用「定时器账本」，而账本目前只存在于 test/net.adversarial.test.js 的 rig 里。
 * 把账本内联进 test/net.test.js 会让同一套逻辑散在两个文件（改一处漏一处）；新建一个自包含
 * 文件则零重复，`npm test` 的 `test/*.test.js` glob 会自动收。主题上也更清楚：
 *   net.test.js          常规协议
 *   net.adversarial.test.js  对抗 / 注入
 *   net.endgame.test.js  终局与回收（本文件）
 *
 * 【两条用例职责正交，不要再合并】
 * - N3 只管「终局后 net 层不残留定时器」；
 * - N4 只管「一局真的能端到端闭环 + 54 张牌守恒」。
 * N4 **故意不**断言定时器账本：它必须用 5ms 短超时驱动机器人/托管才能把一局打完，而短超时下
 * 「账本为空」既可以因为**被正确清掉**、也可以因为定时器**自己到点烧掉** —— 两种原因不可区分，
 * 断言会退化成恒真（即「看着有覆盖，实际什么都没测」）。所以定时器护栏集中在 N3，
 * 且 N3 用 1 小时超时，让「只有显式 clearTimeout 才能让定时器从账本消失」成立。
 *
 * 【阴性对照（变异验证，落地时实测）】
 * - 删掉 playCard 处理器里的 `clearPlayerTimers(socket.playerId)` → N3 红；
 * - 删掉 `closeOutLastHolder` 里的 `last.penaltyPile.push(...last.hand)` → N4 红（守恒被破坏）；
 * - 把 scheduleAI 的 `if (res.action === 'gameOver') sendGameEnd(room)` 改成 `if (false)` → N4 红。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const engine = require('../lib/engine.js');
const { initNet } = require('../net/net.js');

/* 真实定时器引用：账本会包住全局 setTimeout，等待逻辑必须用真的，否则会被自己记账 */
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

async function waitFor(cond, { timeout = 30000, interval = 5, label = '' } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - t0 > timeout) throw new Error(`waitFor 超时${label ? '：' + label : ''}`);
    await sleep(interval);
  }
}

/**
 * 定时器账本：只登记调用栈来自 net/net.js 的定时器，其余原样透传。
 * 只在需要它的用例里安装、在 t.after 里还原，不影响同文件其它用例。
 */
function installTimerLedger() {
  const live = new Map();
  const fromNet = () => /net[\\/]net\.js/.test(new Error().stack || '');
  global.setTimeout = function (fn, ms, ...args) {
    const track = fromNet();
    const id = realSetTimeout.call(global, (...a) => {
      live.delete(id);
      if (typeof fn === 'function') fn(...a);
    }, ms, ...args);
    if (track) live.set(id, { kind: 'timeout', delay: ms });
    return id;
  };
  global.clearTimeout = function (id) { live.delete(id); return realClearTimeout.call(global, id); };
  global.setInterval = function (fn, ms, ...args) { return realSetInterval.call(global, fn, ms, ...args); };
  global.clearInterval = function (id) { live.delete(id); return realClearInterval.call(global, id); };
  return {
    timeouts: () => [...live.values()].filter((t) => t.kind === 'timeout'),
    restore() {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
      live.clear();
    },
  };
}

/** 假 socket：记录 emit 序列，手动驱动客户端 → 服务端事件 */
function makeSocket(id) {
  const handlers = new Map();
  const s = {
    id,
    playerId: null,
    log: [],
    joined: new Set(),
    emit(name, payload) { s.log.push({ name, payload }); },
    on(name, h) { handlers.set(name, h); },
    join(code) { s.joined.add(code); },
    leave(code) { s.joined.delete(code); },
    send(name, payload) {
      const h = handlers.get(name);
      assert.ok(h, `服务端未注册事件 '${name}'`);
      h(payload);
    },
    all(name) { return s.log.filter((e) => e.name === name).map((e) => e.payload); },
    last(name) {
      for (let i = s.log.length - 1; i >= 0; i--) if (s.log[i].name === name) return s.log[i].payload;
      return undefined;
    },
    clear() { s.log.length = 0; },
  };
  return s;
}

function makeHarness(overrides = {}) {
  const rooms = new Map();
  const sockets = new Map();
  const timings = {
    reconnectGraceMs: 60 * 60 * 1000,
    turnTimeoutMs: 60 * 60 * 1000,
    disconnectedTurnMs: 60 * 60 * 1000,
    pickupDelayMs: 60 * 60 * 1000,
    offlinePickupDelayMs: 60 * 60 * 1000,
    nextRoundCooldownMs: 0,
    aiThinkMs: 1,
    roomGcIntervalMs: 60 * 60 * 1000,
    roomGcWaitingIdleMs: 60 * 60 * 1000,
    roomGcAllOfflineMs: 60 * 60 * 1000,
    ...overrides,
  };
  let conn = null;
  const io = { sockets: { sockets }, on(ev, h) { if (ev === 'connection') conn = h; } };
  const net = initNet(io, rooms, timings);
  return {
    rooms,
    sockets,
    timings,
    connect(id) { const s = makeSocket(id); sockets.set(id, s); conn(s); return s; },
    dispose() { net.dispose(); },
  };
}

let cardSeq = 0;
const C = (rank, kind = 'monster') => ({ id: `qa_${rank}_${(cardSeq += 1)}`, rank, suit: '♠', kind });

/** 建 3 人房并开局 */
function startThree(h) {
  const host = h.connect('s0');
  host.send('createRoom', { nickname: 'A' });
  const code = host.last('roomJoined').roomCode;
  const others = ['B', 'C'].map((n, i) => {
    const s = h.connect('s' + (i + 1));
    s.send('joinRoom', { roomCode: code, nickname: n });
    return s;
  });
  for (const s of [host, ...others]) s.send('ready', { ready: true });
  host.send('start');
  return { host, others, code, room: h.rooms.get(code) };
}

/* ============================================================
 * N3：终局后 net 层不得残留任何定时器
 * ============================================================ */
test('N3 终局后 net 层不残留任何回合/收牌定时器（1h 超时：只有显式 clear 才能让它从账本消失）', async (t) => {
  // 全部定时器 1 小时：它们绝不会自己到点，「账本里还有东西」就等价于「漏清」。
  const h = makeHarness();
  const ledger = installTimerLedger();
  t.after(() => { ledger.restore(); h.dispose(); });

  const { host, room } = startThree(h);
  const cur = room.players.find((p) => p.id === host.playerId);

  // 前置：当前玩家确实挂着 1 个回合定时器 —— 少了这条，用例可能在「什么都没挂」时空转成恒真
  assert.strictEqual(ledger.timeouts().length, 1, '前置：开局应给当前玩家挂 1 个回合定时器');

  // 造残局：B/C 已出完，A 手里 2 张，出一张 → 只剩 B/C 之外唯一有牌者 → 终局
  room.topCard = null;
  room.topCount = 1;
  room.tablePile = [];
  room.drawPile = [];
  for (const p of room.players) { p.hand = []; p.penaltyPile = []; }
  cur.hand = [C('4'), C('6')];

  host.send('playCard', { cardIds: [cur.hand[0].id] });
  assert.strictEqual(room.phase, 'settling', '前置：应进入结算');

  assert.deepStrictEqual(
    ledger.timeouts().map((x) => x.delay),
    [],
    `终局后 net 层不得残留定时器（实际 ${JSON.stringify(ledger.timeouts())}）`
  );

  // 隔一会儿复查：不允许「到点后才被排出来」的幽灵定时器把阶段改回去
  await sleep(50);
  assert.strictEqual(room.phase, 'settling', '结算后不得被任何陈旧定时器改写阶段');
  assert.deepStrictEqual(ledger.timeouts().map((x) => x.delay), [], '结算后也不得冒出新定时器');
});

/* ============================================================
 * N4：真人 + 2 AI 端到端打完整局（引擎终局 → net 下发 → 牌守恒）
 * ============================================================ */
test('N4 真人+2AI 自动打完整局：settling + gameEnd + 54 张牌守恒且无重复 + hand 全空', async (t) => {
  // 短超时是 gameplay 需要（人类回合靠托管推进、AI 靠 scheduleAI）；
  // 定时器账本断言不放在这里 —— 短超时下它会恒真（详见文件头说明）。
  const h = makeHarness({ turnTimeoutMs: 5, pickupDelayMs: 5, aiThinkMs: 1 });
  t.after(() => h.dispose());

  const host = h.connect('qa-human');
  host.send('createRoom', { nickname: '人类' });
  const code = host.last('roomJoined').roomCode;
  host.send('addAI');
  host.send('addAI');
  host.send('ready', { ready: true });
  host.send('start');
  const room = h.rooms.get(code);

  assert.strictEqual(room.players.length, 3, '应为 3 人（1 真人 + 2 AI）');
  assert.strictEqual(room.players.filter((p) => p.isAI).length, 2, '应有 2 个 AI');

  await waitFor(() => room.phase === 'settling', { timeout: 30000, label: 'AI 局走到 settling' });
  await waitFor(() => host.all('gameEnd').length > 0, { timeout: 5000, label: '收到 gameEnd' });

  // 牌守恒 + 唯一性：只清 hand 而不并入败牌堆、或牌被复制，都会在这里暴露
  const zones = [room.drawPile, room.tablePile]
    .concat(room.players.map((p) => p.hand))
    .concat(room.players.map((p) => p.penaltyPile));
  assert.strictEqual(
    zones.reduce((s, z) => s + z.length, 0),
    54,
    '终局后 54 张牌必须守恒（余牌被吞 / 牌被复制都会在这里暴露）'
  );
  const seen = new Set();
  for (const z of zones) {
    for (const c of z) {
      assert.ok(!seen.has(c.id), `牌 ${c.id} 同时出现在两个区域（被复制）`);
      seen.add(c.id);
    }
  }
  assert.strictEqual(seen.size, 54, '必须有 54 张唯一牌');

  for (const p of room.players) assert.strictEqual(p.hand.length, 0, `终局后 ${p.name} 不得留手牌`);
  assert.strictEqual(room.currentPlayerId, null, '终局后不得残留回合');

  const ge = host.last('gameEnd');
  assert.strictEqual(ge.results.length, 3, 'gameEnd 必须覆盖全员');
  assert.strictEqual(ge.winnerIds[0], room.lastResult.winnerId, 'gameEnd.winnerIds 必须与 lastResult.winnerId 一致');
  assert.ok(ge.results.reduce((s, r) => s + r.penaltyCount, 0) <= 54, '败牌总数不得超 54');
});
