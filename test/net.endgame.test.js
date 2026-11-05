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
 * 【阴性对照（变异验证，实测：每项连跑 10 次）】
 * - 删掉 playCard 处理器里的 `clearPlayerTimers(socket.playerId)` → N3 红（确定性 10/10）。
 *   红在「定时器账本非空」，报错形如 `实际 [{"kind":"timeout","delay":3600000}]` —— 与竞速无关。
 * - 删掉 `closeOutLastHolder` 里的 `last.penaltyPile.push(...last.hand)` → N4 红（确定性 10/10）。
 *   红在「54 张牌必须守恒」（`53 !== 54`）—— 也**与竞速无关**，别和下面那个概率问题混为一谈。
 *
 * 【为什么下面一律用函数名、不写行号】
 * 这些行号一天之内漂过两次（缺陷修复往回调里插了守卫），写死行号等于给下一个人留一份过期地图。
 * 函数名不会漂：「scheduleTurn 的定时器回调」永远指得住。
 *
 * ⚠ N4 对 `sendGameEnd` 的发射点只是**概率守卫**（实测：只关 scheduleTurn 回调的 settling 分支 → 红 9/30；
 *   只关 scheduleAI 回调的 gameOver 分支 → 红 12/20。HEAD 复测同向：**2/10** 与 **6/10**）。根因不是样本少：本用例是
 *   「真人 + 2 AI」的实时对局，最后一手由 turnTimeoutMs 与 aiThinkMs 的竞速决定走了哪条路，
 *   而这两条路径**互相兜底** —— 关掉一处，另一处照样把 gameEnd 发出去。
 *   ⇒ 别把「关一处而 N4 没红」当成该发射点没有守卫的证据。
 *
 * ✅ 那到底有没有确定性守卫？**没有**。全仓六个 `sendGameEnd` 发射点，逐点单点变异实测：
 *   〔确定性，各有专门用例〕
 *     · schedulePickup 定时器回调的 gameOver 分支（`托管自动收牌触发终局…`）
 *     · playCard 事件处理器（`出牌触发终局：playCard → gameOver…`）
 *     · pickUp 事件处理器（`收牌触发终局（余牌计入败牌）…`）
 *   〔高概率但**不是**确定性〕
 *     · scheduleTurn 定时器回调的 settling 分支
 *     · scheduleAI 回调的 gameOver 分支
 *     前一轮这里写的是「约 83%（50/60）」，**但没写清 50/60 是哪些用例、跑了几次** —— 这种数字
 *     换一版基线就无从复核。HEAD `8d0a7a5` 上按「整套 CI 连跑 10 次」重测（每个变异独立进程）：
 *       删 settling 分支      → **9/10 红**（★跨局连打 8、1 真人+2AI 跑完一局 5、N4 2）
 *       删 gameOver 分支      → **10/10 红**（★跨局连打 9、1 真人+2AI 7、N4 6）
 *       两条一起删            → 10/10 红，且三条用例全红
 *     ⚠ 顺带修掉一句错话：这里原先写「这两处**唯一**的护栏是 ★跨局连打 5 局」。不对 ——
 *       上表里每条变异都有 2~3 条用例踩到，★跨局连打只是命中率最高的那条。写「唯一」会让下一个
 *       人以为删了它这两处就没人管了，或者反过来以为别的用例都管不着。**护栏是并集，不是单点。**
 *     ★跨局连打确实是最能代表的一条：它红在 `assert.strictEqual(host.all('gameEnd').length, round, …)`，
 *       而用例名字讲的是「定时器峰值恒为 2」——**从名字看不出它还在守 gameEnd**。5 局里只要
 *       「被你关掉的那条路」一次都没走到最后一手，另一条就兜底，它就照绿；局数把命中率往上抬，
 *       抬不到 100%，所以删 settling 分支时它 10 次里绿了 2 次。
 *     ⇒ 10/10 也别读成「确定性」：n=10 全红的两侧 95% 下界只有约 74%。规矩见 §8 第 7 条。
 *   〔确定性，由本文件 N5 守住 —— 补之前是 0/10 全绿，即无守卫〕
 *     · scheduleAI 的 catch 块（AI 决策失败 → 降级 autoPlay 也失败 → 强制结算后发 gameEnd）。
 *       它要连吃两次注入抛出才可达，所以 N5 的触发方式就是「注入两个抛出」：
 *       `ai.chooseMove` 抛 + `engine.autoPlay` 也抛，`t.after` 里复原。
 *       这条路径一旦破了，表现是**本项目最贵的故障模式**：0 个定时器 + 桌上没人能动 —— 所以
 *       宁可强制结算让真人看到一句人话，也不能静默卡死。
 *   ⇒ 那两处**仍然应该**各写一条白盒残局用例定点触发；连打再长也只是把概率往上抬，抬不到 100%。
 *     别拿「连打 20 局」代替白盒：那是用数倍耗时把最后那点漏检（实测 1/10）换成更小的一点，
 *     换来的是每次都更慢、且判据仍然是概率。
 *     （写白盒时的坑：定时器账本只记 `{kind:'timeout', delay}`，不区分 turn / pickup / ai。
 *       要按 delay 认路径，必须让 turnTimeoutMs / disconnectedTurnMs / pickupDelayMs /
 *       offlinePickupDelayMs / aiThinkMs / reconnectGraceMs 这 6 个值两两不等 —— 本文件 N3 的
 *       harness 把其中 5 个都设成 1h，抄它必踩。断言写一行 `new Set([...]).size === 6`，
 *       别写 15 行两两 `notStrictEqual`：人肉数对数一定会漏。）
 */

const { test } = require('node:test');
const assert = require('node:assert');

const engine = require('../lib/engine.js');
const ai = require('../lib/ai.js');
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
  // 注意：本用例把 reconnectGraceMs / turnTimeoutMs / disconnectedTurnMs / pickupDelayMs /
  // offlinePickupDelayMs **五个都设成同一个 1h**（N3 不靠 delay 区分种类，只查账本是否为空）。
  // 若将来真要按 delay 区分路径（见文件头「到底有没有确定性守卫」那段），必须先把这 6 个值全部拉开。
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

/* ============================================================
 * N5：scheduleAI 的两级降级都失败 → 必须强制结算并发 gameEnd
 *
 * 这是全仓六个 sendGameEnd 发射点里唯一长期无守卫的一个（补之前单点变异 0/10 全绿）。
 * 它要连吃两次抛出才可达（AI 决策抛 + 托管 autoPlay 也抛），所以这里直接注入这两个抛出，
 * 定点走到 catch 分支 —— 不用「打很多局碰运气」那种概率式覆盖。
 *
 * 为什么值得单独一条用例：这条路径一旦破了，表现是「0 个定时器 + 桌上三个人谁也不动」，
 * 是本项目最贵的故障模式。宁可强制结算让真人看到一句人话，也不能静默卡死。
 *
 * 阴性对照（在 /d/tmp 的 worktree 副本里做，每个变异 10 次独立进程）：
 *   M1 删 catch 里的 sendGameEnd          → 10/10 红（gameEnd 数量断言）
 *   M2 删 catch 里给真人的 INTERNAL 提示   → 10/10 红（「已强制结算」断言）
 *   M3 删 catch 里的 engine.settleGame     → 10/10 红（waitFor(settling) 超时）
 *   M4 在 return 前挂 scheduleAI(1ms)      → 0/10 红 ← **变异写错了，不是断言松**
 *      账本只记「在册且尚未触发」的定时器；1ms 的那只早已触发并自删，不算遗留。
 *   M4b 错修法「重试而非结算」（挂 1h 回合定时器）→ 10/10 红（账本为空断言）
 *   M5 删 catch 末尾的 return（落回常规路径）→ 10/10 红
 * 结论：本用例五条主断言都能红。**「不留定时器」只对「挂上且还在等」的定时器有效**，
 * 别把它当成「没有任何定时器被创建过」——那是两种不同的断言。
 * ============================================================ */
test('N5 AI 决策失败且托管也失败：必须强制结算 + 下发 gameEnd + 不留定时器（宁可结束本局，不可留死桌）', async (t) => {
  const realChooseMove = ai.chooseMove;
  const realAutoPlay = engine.autoPlay;
  t.after(() => {
    // 复原必须放在 after 里：断言失败也要复原，否则后续用例会继承一个会抛的引擎
    ai.chooseMove = realChooseMove;
    engine.autoPlay = realAutoPlay;
  });

  // 只有 aiThinkMs 短：其余定时器 1h，任何残留都会明晃晃挂在账本里
  const h = makeHarness({ aiThinkMs: 1 });
  const ledger = installTimerLedger();
  t.after(() => { ledger.restore(); h.dispose(); });

  const host = h.connect('qa-human');
  host.send('createRoom', { nickname: '人类' });
  const code = host.last('roomJoined').roomCode;
  host.send('addAI');
  host.send('addAI');
  host.send('ready', { ready: true });
  host.send('start');
  const room = h.rooms.get(code);

  assert.strictEqual(room.players.length, 3, '前置：1 真人 + 2 AI（本游戏最少 3 人，2 人开不了局）');
  const human = room.players.find((p) => !p.isAI);
  assert.ok(human, '前置：真人一名');

  // 打断两级降级：AI 决策抛 + 托底选择器也抛 ⇒ 只有 catch(e2) 能接住
  ai.chooseMove = () => { throw new Error('注入：AI 决策失败'); };
  engine.autoPlay = () => { throw new Error('注入：托管也失败'); };

  // 把回合交给 AI（开局先手可能是真人，也可能是 AI）
  if (room.currentPlayerId === human.id) {
    host.send('playCard', { cardIds: [human.hand[0].id] });
  }
  const actor = room.players.find((p) => p.id === room.currentPlayerId);
  assert.ok(
    actor && actor.isAI,
    '前置：回合必须已交给 AI —— 否则本用例测的不是 scheduleAI 这条路径'
  );

  await waitFor(() => room.phase === 'settling', { timeout: 5000, label: '两级降级失败后强制结算' });

  // lastResult 是 sendGameEnd 的前置：没有它，sendGameEnd 会静默早退（那一行在函数开头）
  assert.ok(room.lastResult, '强制结算必须产出 lastResult，否则 gameEnd 会被静默吞掉');
  assert.strictEqual(host.all('gameEnd').length, 1, '必须且只能下发 1 次 gameEnd');
  assert.strictEqual(room.currentPlayerId, null, '强制结算后不得残留回合');

  // 让真人看到人话，而不是盯着一张静止的牌桌
  const internal = host.all('error').filter((e) => e && e.code === 'INTERNAL');
  assert.ok(
    internal.some((e) => e.message === '服务端异常，本局已强制结算'),
    `真人必须收到「已强制结算」提示，实际收到 ${JSON.stringify(host.all('error'))}`
  );

  // 死桌的定义是「既没结算、也没定时器」；结算了且账本干净才算真的脱困
  await sleep(30);
  assert.deepStrictEqual(
    ledger.timeouts().map((x) => x.delay),
    [],
    `强制结算后不得残留定时器（实际 ${JSON.stringify(ledger.timeouts())}）`
  );
  assert.strictEqual(room.phase, 'settling', '结算后不得被任何陈旧定时器改写阶段');
});
