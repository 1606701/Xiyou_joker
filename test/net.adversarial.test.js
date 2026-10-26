'use strict';

/**
 * test/net.adversarial.test.js — 协议层（net/net.js）对抗性测试（QA 独立实现）。
 *
 * 与 test/net.test.js **零共享代码**：本文件的假 io / 假 socket / 定时器账本全部独立实现，
 * 目的是互相校验 —— 若两份实现同时为绿，才有资格说「协议层行为符合预期」。
 *
 * 自研脚手架的三处关键差异：
 * 1. **定时器账本**：patch 全局 setTimeout/setInterval，只登记调用栈来自 net/net.js 的定时器，
 *    因此可以断言「是否存在定时器泄漏 / 重复叠加」，而不仅仅是「行为看起来对」。
 * 2. **事件溯源**：每个假 socket 保留完整 emit 序列（按时间顺序），用于断言广播次数与内容，
 *    而不是只取 last()。
 * 3. **todo 用例**：发现缺陷后按 TDD 写法断言「应然行为」并标 { todo: true }，
 *    使 `npm test` 保持全绿的同时把缺陷固化在下一条回归线上（修好后去掉 todo 即变真红线）。
 *
 * 约定：本文件只读 net/net.js 与 lib/，不修改任何产品代码。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const engine = require('../lib/engine.js');
const { initNet, DEFAULT_TIMINGS } = require('../net/net.js');

/* ============================================================
 * 基础设施：真实 setTimeout 引用（避免被定时器账本误记）
 * ============================================================ */
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;

const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

async function waitFor(cond, { timeout = 2000, interval = 5, label = '' } = {}) {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeout) throw new Error(`waitFor 超时${label ? `：${label}` : ''}`);
    await sleep(interval);
  }
}

/* ============================================================
 * 定时器账本：只登记 net/net.js 内部创建的定时器
 * ============================================================ */
function installTimerLedger() {
  const live = new Map(); // id -> { kind, delay, seq }
  let seq = 0;
  const fromNet = () => {
    const stack = new Error().stack || '';
    return /net[\\/]net\.js/.test(stack);
  };

  global.setTimeout = function (fn, ms, ...args) {
    const track = fromNet();
    const id = realSetTimeout.call(global, (...a) => {
      live.delete(id);
      if (typeof fn === 'function') fn(...a);
    }, ms, ...args);
    if (track) {
      seq += 1;
      live.set(id, { kind: 'timeout', delay: ms, seq });
    }
    return id;
  };
  global.clearTimeout = function (id) {
    live.delete(id);
    return realClearTimeout.call(global, id);
  };
  global.setInterval = function (fn, ms, ...args) {
    const track = fromNet();
    const id = realSetInterval.call(global, fn, ms, ...args);
    if (track) {
      seq += 1;
      live.set(id, { kind: 'interval', delay: ms, seq });
    }
    return id;
  };
  global.clearInterval = function (id) {
    live.delete(id);
    return realClearInterval.call(global, id);
  };

  return {
    /** 账本快照（只含 net 层定时器） */
    list: () => [...live.values()],
    count: () => live.size,
    timeouts: () => [...live.values()].filter((t) => t.kind === 'timeout'),
    intervals: () => [...live.values()].filter((t) => t.kind === 'interval'),
    restore() {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
      live.clear();
    },
  };
}

/* ============================================================
 * 假 socket（独立实现：保留完整 emit 序列）
 * ============================================================ */
function makeSocket(id) {
  const handlers = new Map();
  const sock = {
    id,
    playerId: null,
    log: [],              // [{ name, payload, at }]
    joined: new Set(),
    emit(name, payload) {
      sock.log.push({ name, payload, at: Date.now() });
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    join(code) {
      sock.joined.add(code);
    },
    leave(code) {
      sock.joined.delete(code);
    },
    /* ---- QA 辅助 ---- */
    fire(name, payload) {
      const h = handlers.get(name);
      assert.ok(h, `socket '${id}' 上服务端未注册事件 '${name}'`);
      h(payload);
    },
    events(name) {
      return sock.log.filter((e) => e.name === name).map((e) => e.payload);
    },
    count(name) {
      return sock.log.filter((e) => e.name === name).length;
    },
    last(name) {
      for (let i = sock.log.length - 1; i >= 0; i--) if (sock.log[i].name === name) return sock.log[i].payload;
      return undefined;
    },
    clear() {
      sock.log.length = 0;
    },
  };
  return sock;
}

/* ============================================================
 * 测试台（Rig）
 * ============================================================ */
function makeRig(overrides = {}) {
  const rooms = new Map();
  const sockets = new Map();
  const timings = {
    reconnectGraceMs: 60 * 1000,
    turnTimeoutMs: 60 * 1000,
    disconnectedTurnMs: 60 * 1000,
    pickupDelayMs: 60 * 1000,
    offlinePickupDelayMs: 60 * 1000,
    nextRoundCooldownMs: 0,
    roomGcIntervalMs: 6 * 60 * 60 * 1000,
    roomGcWaitingIdleMs: 6 * 60 * 60 * 1000,
    roomGcAllOfflineMs: 6 * 60 * 60 * 1000,
    ...overrides,
  };

  const ledger = installTimerLedger();

  let onConnection = null;
  const io = {
    sockets: { sockets },
    on(event, handler) {
      if (event === 'connection') onConnection = handler;
    },
  };

  let net;
  try {
    net = initNet(io, rooms, timings);
  } catch (e) {
    ledger.restore();
    throw e;
  }

  const rig = {
    rooms,
    sockets,
    timings,
    ledger,
    connect(id) {
      assert.ok(onConnection, 'connection 处理器未注册');
      const sock = makeSocket(id);
      sockets.set(id, sock);
      onConnection(sock);
      return sock;
    },
    room(code) {
      return rooms.get(code);
    },
    /**
     * 只调 net.dispose()，**不动定时器账本**。
     * 存在的理由（QA 自查发现的假红线）：dispose() 内部 finally 会 ledger.restore()，
     * 而 restore() 里有 live.clear()，所以「dispose() 后断言 ledger.count()===0」恒真 ——
     * 断言的是「restore 清空了账本」，与 net.dispose() 是否真的清了定时器无关。
     * 需要真正检查 net.dispose() 的清理效果时，必须用本方法，然后在 restore 之前快照账本。
     */
    netDispose() {
      net.dispose();
    },
    dispose() {
      try {
        net.dispose();
      } finally {
        ledger.restore();
      }
    },
  };
  return rig;
}

/* ---- 局面构造 ---- */
let cardSeq = 0;
const mk = (rank, kind, suit = '♠') => {
  cardSeq += 1;
  return { id: `qa_${rank}_${cardSeq}`, rank, suit, kind };
};
const MONSTER = (rank) => mk(rank, 'monster');
const ACTION = (rank) => mk(rank, 'action');

/** 建房 + 入座（不开始）；idp 用于同一 rig 内多个房间的场景，避免 socket.id 撞车 */
function seatN(rig, n, idp = 'p') {
  const host = rig.connect(`${idp}0`);
  host.fire('createRoom', { nickname: '玩家0' });
  const code = host.last('roomJoined').roomCode;
  const others = [];
  for (let i = 1; i < n; i++) {
    const s = rig.connect(`${idp}${i}`);
    s.fire('joinRoom', { roomCode: code, nickname: `玩家${i}` });
    others.push(s);
  }
  return { host, others, all: [host, ...others], code, room: rig.rooms.get(code) };
}

/** 建房 + 入座 + 全员准备 + 房主开局 */
function startN(rig, n, idp = 'p') {
  const ctx = seatN(rig, n, idp);
  ctx.all.forEach((s) => s.fire('ready', { ready: true }));
  ctx.host.fire('start');
  return ctx;
}

const playerOf = (room, sock) => room.players.find((p) => p.id === sock.playerId);
const byPid = (ctx) => new Map(ctx.all.map((s) => [s.playerId, s]));
const curPlayer = (room) => room.players.find((p) => p.id === room.currentPlayerId);
const curSocket = (ctx) => byPid(ctx).get(ctx.room.currentPlayerId);

/** 清空所有 socket 的事件记录，便于断言「这一步产生了什么」 */
const clearAll = (ctx) => ctx.all.forEach((s) => s.clear());

/**
 * 等「回合托管定时器已触发过一次」。
 * 不能直接等账本清空：定时器触发后可能立刻重排下一个（如幽灵房间仍在 playing），
 * 账本永远不为 0。用 seq 变化判定「旧定时器已出队、已有新动作」。
 */
async function waitForTurnTimerFired(rig, label) {
  const before = rig.ledger.timeouts().map((x) => x.seq);
  await waitFor(
    () => {
      const now = rig.ledger.timeouts().map((x) => x.seq);
      if (now.length === 0) return true;
      return now.some((seq) => !before.includes(seq));
    },
    { label: label || '回合托管定时器应已触发' }
  );
}

/** 把房间改造成「桌面有单张 K 门槛」的局面，返回当前玩家 socket 与手牌 */
function setTopK(ctx) {
  const room = ctx.room;
  const top = MONSTER('K');
  room.topCard = top;
  room.topCount = 1;
  room.tablePile = [top];
  return { room, sock: curSocket(ctx) };
}

/**
 * 让「当前玩家」走一步合法动作。
 * 策略：优先最小可压组合 → 次选功能牌 → 都不可行则收牌。
 * 返回 'played' | 'picked' | 'blocked-p0'（触及已知缺陷 P0-01：桌面为空且手上只剩功能牌）。
 */
function stepOnce(ctx) {
  const room = ctx.room;
  const cur = curPlayer(room);
  const sock = byPid(ctx).get(cur.id);
  const moves = engine.computeLegalMoves(room, cur.id);
  if (moves.beats.length > 0) {
    sock.fire('playCard', { cardIds: moves.beats[0] });
    return 'played';
  }
  if (moves.actions.length > 0) {
    if (room.tablePile.length === 0) return 'blocked-p0';
    sock.fire('playCard', { cardIds: [moves.actions[0]] });
    return 'played';
  }
  sock.fire('pickUp');
  return 'picked';
}

/* ============================================================
 * 1. 6 人满员局的完整闭环与广播完整性
 * ============================================================ */
test('对抗 1：6 人满员局完整跑通到 settling，每次广播对 6 人全部到位且手牌数无漂移', (t) => {
  const rig = makeRig();
  t.after(() => rig.dispose());

  const ctx = startN(rig, 6);
  const room = ctx.room;
  assert.strictEqual(room.players.length, 6, '应满员 6 人');
  assert.strictEqual(room.phase, 'playing');

  const sockOf = byPid(ctx);
  let steps = 0;
  let maxSteps = 4000;
  let stoppedByKnownP0 = false;

  while (room.phase === 'playing' && steps < maxSteps) {
    steps += 1;
    const cur = curPlayer(room);
    assert.ok(cur, `第 ${steps} 步：当前玩家必须存在（否则回合链断裂）`);
    assert.ok(sockOf.get(cur.id), `第 ${steps} 步：当前玩家应有 socket`);

    const before = new Map(ctx.all.map((s) => [s.playerId, s.count('state')]));
    const outcome = stepOnce(ctx);
    if (outcome === 'blocked-p0') {
      stoppedByKnownP0 = true;
      t.diagnostic(`第 ${steps} 步触及已知 P0-01（开轮只能打功能牌），闭环在此中断`);
      break;
    }

    // 广播完整性：每个在线玩家都应收到恰好一次新的 state
    for (const s of ctx.all) {
      const delta = s.count('state') - before.get(s.playerId);
      assert.ok(delta >= 1, `第 ${steps} 步：玩家 ${s.playerId} 漏收 state 广播（delta=${delta}）`);
    }
    // 广播内容一致性：所有人看到的公开信息都应等于房间真值
    for (const s of ctx.all) {
      const st = s.last('state');
      assert.strictEqual(st.players.length, 6, `第 ${steps} 步：${s.playerId} 看到的座位数应为 6`);
      for (const p of room.players) {
        const view = st.players.find((x) => x.id === p.id);
        assert.ok(view, `第 ${steps} 步：state 缺少玩家 ${p.id}`);
        assert.strictEqual(view.handCount, p.hand.length, `第 ${steps} 步：${p.id} 手牌数漂移`);
        assert.strictEqual(view.penaltyCount, p.penaltyPile.length, `第 ${steps} 步：${p.id} 败牌数漂移`);
        assert.strictEqual(view.connected, true);
      }
      assert.strictEqual(st.currentPlayerId, room.currentPlayerId, `第 ${steps} 步：currentPlayerId 不一致`);
      assert.strictEqual(st.direction, room.direction, `第 ${steps} 步：direction 不一致`);
      assert.strictEqual(st.tablePileCount, room.tablePile.length);
      // 防作弊：state 中不得出现他人手牌 id
      const otherIds = room.players.filter((p) => p.id !== s.playerId).flatMap((p) => p.hand.map((c) => c.id));
      const serialized = JSON.stringify(st);
      for (const id of otherIds) assert.ok(!serialized.includes(id), `第 ${steps} 步：state 泄露了他人手牌 ${id}`);
    }
    // 任何一步都不应出现「操作失败」类错误
    for (const s of ctx.all) {
      assert.deepStrictEqual(s.events('error'), [], `第 ${steps} 步：${s.playerId} 收到错误事件`);
    }
  }

  assert.ok(steps < maxSteps, `闭环不应依赖步数上限（实际 ${steps} 步）`);
  if (!stoppedByKnownP0) {
    assert.strictEqual(room.phase, 'settling', `6 人局应能走到结算（实际步数 ${steps}）`);
    assert.ok(room.lastResult, '结算应产出 lastResult');
    assert.strictEqual(room.lastResult.results.length, 6, '结算结果应覆盖 6 人');
    for (const s of ctx.all) assert.ok(s.last('gameEnd'), `${s.playerId} 应收到 gameEnd`);
  }
});

/* ============================================================
 * 2. 组合出牌的协议层拒绝
 * ============================================================ */
test('对抗 2：组合出牌的张数/点数校验（张数不等、跨点数混合、超 4 张）全部被拒且不破坏状态', (t) => {
  const rig = makeRig();
  t.after(() => rig.dispose());

  const ctx = startN(rig, 3);
  const room = ctx.room;
  const sock = curSocket(ctx);
  const me = playerOf(room, sock);

  // 门槛：一对 9（topCount=2）
  const t1 = MONSTER('9');
  const t2 = MONSTER('9');
  room.topCard = t1;
  room.topCount = 2;
  room.tablePile = [t1, t2];

  const j1 = MONSTER('J');
  const j2 = MONSTER('J');
  const j3 = MONSTER('J');
  const k1 = MONSTER('K');
  const four = MONSTER('4');
  me.hand = [j1, j2, j3, k1, four];
  clearAll(ctx);

  const snapshot = () => ({
    hand: me.hand.map((c) => c.id).join(','),
    pile: room.tablePile.length,
    topCount: room.topCount,
    cur: room.currentPlayerId,
  });
  const baseline = snapshot();

  const reject = (ids, expectCode, why) => {
    sock.fire('playCard', { cardIds: ids });
    const errs = sock.events('error');
    assert.ok(errs.length >= 1, `${why}：应被拒绝`);
    assert.strictEqual(errs[errs.length - 1].code, expectCode, `${why}：错误码应为 ${expectCode}`);
    assert.deepStrictEqual(snapshot(), baseline, `${why}：拒绝后状态不得改变`);
  };

  reject([j1.id], 'ILLEGAL_CARD', '门槛是 2 张，只出 1 张（张数不等）');
  reject([j1.id, j2.id, j3.id], 'ILLEGAL_CARD', '门槛是 2 张，出 3 张（张数不等）');
  reject([j1.id, k1.id], 'ILLEGAL_CARD', '跨点数混合组合（J+K）');
  reject([j1.id, j2.id, j3.id, k1.id, four.id], 'ILLEGAL_CARD', '一次出 5 张（超上限 4）');
  reject([j1.id, j1.id], 'ILLEGAL_CARD', '同一张牌重复提交');

  // 正对照：2 张 J 合法
  sock.clear();
  sock.fire('playCard', { cardIds: [j1.id, j2.id] });
  assert.deepStrictEqual(sock.events('error'), [], '合法的同点 2 张不应报错');
  assert.strictEqual(room.tablePile.length, 4, '桌面应新增 2 张');
  assert.strictEqual(room.topCount, 2, '新门槛张数为 2');
  assert.strictEqual(me.hand.length, 3, '手牌应扣减 2 张');
});

/* ============================================================
 * 3. 「2」反转方向
 * ============================================================ */
test('对抗 3：2 反转方向正确，连续两个 2 回到原方向（并校验 direction 与上家接续）', (t) => {
  const rig = makeRig();
  t.after(() => rig.dispose());

  const ctx = startN(rig, 3);
  const room = ctx.room;
  const sockOf = byPid(ctx);
  const seats = room.players.map((p) => p.id);

  // 门槛 = 单张 K，因此功能牌是唯一「不受压制限制」的选择
  setTopK(ctx);
  const two1 = ACTION('2');
  playerOf(room, sockOf.get(seats[0])).hand = [two1, MONSTER('4')];
  assert.strictEqual(room.direction, 1);
  assert.strictEqual(room.currentPlayerId, seats[0]);

  clearAll(ctx);
  sockOf.get(seats[0]).fire('playCard', { cardIds: [two1.id] });
  assert.deepStrictEqual(sockOf.get(seats[0]).events('error'), [], '打出 2 不应报错');
  assert.strictEqual(room.direction, -1, '第一个 2 应把方向反转为 -1');
  assert.strictEqual(room.currentPlayerId, seats[2], '反转后应由原上家（seat 2）接续');
  assert.strictEqual(room.topCard.rank, 'K', '2 不改变门槛牌');

  const two2 = ACTION('2');
  playerOf(room, sockOf.get(seats[2])).hand = [two2, MONSTER('4')];
  sockOf.get(seats[2]).fire('playCard', { cardIds: [two2.id] });
  assert.deepStrictEqual(sockOf.get(seats[2]).events('error'), [], '第二个 2 不应报错');
  assert.strictEqual(room.direction, 1, '连续两个 2 应回到原方向 +1');
  assert.strictEqual(room.currentPlayerId, seats[0], '再次反转后应回到 seat 0');

  const log = room.eventLog.join(' | ');
  assert.strictEqual((log.match(/反转/g) || []).length, 2, '事件日志应有两条反转记录');
});

/** 强制进入 settling：摸牌堆空 + 当前玩家无合法牌 → 收牌即终局 */
function forceSettle(ctx) {
  const room = ctx.room;
  const cur = curPlayer(room);
  const top = MONSTER('K');
  room.topCard = top;
  room.topCount = 1;
  room.tablePile = [top];
  room.drawPile = [];
  cur.hand = [MONSTER('4')];
  const sock = curSocket(ctx);
  clearAll(ctx);
  sock.fire('pickUp');
  assert.strictEqual(room.phase, 'settling', '前置条件：应进入结算');
  return { bombedAt: Date.now() };
}

/* ============================================================
 * 4. 结算后 3s 冷却的边界
 * ============================================================ */
test('对抗 4a：结算后真实 3s 防误触边界（2.9s 内静默忽略、3.1s 后放行）', async (t) => {
  const rig = makeRig({ nextRoundCooldownMs: DEFAULT_TIMINGS.nextRoundCooldownMs });
  t.after(() => rig.dispose());
  assert.strictEqual(DEFAULT_TIMINGS.nextRoundCooldownMs, 3000, '冷却默认值应为 3s');

  const ctx = startN(rig, 3);
  const room = ctx.room;
  const { bombedAt } = forceSettle(ctx);

  ctx.host.clear();
  await sleep(2900);
  const elapsedIn = Date.now() - bombedAt;
  ctx.host.fire('nextRound');
  t.diagnostic(`2.9s 断言点实测 elapsed=${elapsedIn}ms（阈值 3000ms）`);
  if (elapsedIn < 3000) {
    assert.strictEqual(room.phase, 'settling', `冷却期内（已过 ${elapsedIn}ms）应静默忽略`);
  } else {
    // 机器抖动导致越过阈值：本断言失效但有 4b 兜底（不静默放行，留下诊断）
    t.diagnostic('抖动越过 3000ms，2.9s 边界断言跳过（由 4b 的运算符精度用例兜底）');
  }
  assert.deepStrictEqual(ctx.host.events('error'), [], '防误触不应弹出错误提示');

  await sleep(250);
  const elapsedOut = Date.now() - bombedAt;
  ctx.host.fire('nextRound');
  assert.strictEqual(room.phase, 'waiting', `冷却结束后（已过 ${elapsedOut}ms）应放行`);
  for (const p of room.players) {
    assert.strictEqual(p.hand.length, 0, '下一局开始前手牌应清空');
    assert.strictEqual(p.ready, false, '准备状态应重置');
  }
});

test('对抗 4b：注入短冷却验证比较运算符（< 而非 <=）与邻域行为', async (t) => {
  const rig = makeRig({ nextRoundCooldownMs: 600 });
  t.after(() => rig.dispose());

  const ctx = startN(rig, 3);
  const room = ctx.room;
  forceSettle(ctx);
  ctx.host.clear();

  await sleep(400);
  ctx.host.fire('nextRound');
  assert.strictEqual(room.phase, 'settling', '注入 600ms 冷却下，约 400ms 时应忽略');
  assert.deepStrictEqual(ctx.host.events('error'), []);

  await sleep(400);
  ctx.host.fire('nextRound');
  assert.strictEqual(room.phase, 'waiting', '注入 600ms 冷却下，约 800ms 时应放行');

  // 非 settling 阶段重复点击：幂等、不报错
  ctx.host.clear();
  ctx.host.fire('nextRound');
  ctx.host.fire('nextRound');
  assert.deepStrictEqual(ctx.host.events('error'), [], '非 settling 阶段重复点击不得弹「操作失败」');
  assert.strictEqual(room.phase, 'waiting');
});

/* ============================================================
 * 5. rejoinToken 复用与混用
 * ============================================================ */
test('对抗 5：同一 rejoinToken 二次重连幂等；跨玩家/伪造 token 被拒；座位与手牌不被复制', (t) => {
  const rig = makeRig();
  t.after(() => rig.dispose());

  const ctx = startN(rig, 3);
  const room = ctx.room;
  const host = ctx.host;
  const pid = host.playerId;
  const token = host.last('roomJoined').rejoinToken;
  const hostToken = token;
  const otherToken = ctx.others[0].last('roomJoined').rejoinToken;
  // 按 player.id 查，而不是 playerOf(room, socket)——后者的语义是「用 socket.playerId 反查」，
  // 会把我对「旧 socket 是否保留 playerId」的实现细节写进断言，从而反过来限制修法选择。
  const me = () => room.players.find((p) => p.id === pid);
  const handCount = me().hand.length;
  const playersBefore = room.players.length;

  host.fire('disconnect');
  assert.strictEqual(me().connected, false);

  // 第一次重连
  const r1 = rig.connect('r1');
  r1.fire('rejoin', { roomCode: ctx.code, playerId: pid, rejoinToken: token });
  assert.ok(r1.last('roomJoined'), '第一次重连应成功');
  assert.strictEqual(me().connected, true);
  assert.strictEqual(me().socketId, 'r1');

  // 第二次重连（同一 token 复用）：应幂等 —— 不新增玩家、不改手牌、不换座位
  const r2 = rig.connect('r2');
  r2.fire('rejoin', { roomCode: ctx.code, playerId: pid, rejoinToken: token });
  assert.ok(r2.last('roomJoined'), '同 token 二次重连应成功（幂等）');
  assert.strictEqual(room.players.length, playersBefore, '重连不得复制玩家');
  assert.strictEqual(me().seat, 0, '座位不变');
  assert.strictEqual(me().hand.length, handCount, '手牌数量不变');
  assert.strictEqual(me().socketId, 'r2', 'socket 应指向最新连接');
  assert.strictEqual(r2.last('roomJoined').rejoinToken, token, '令牌应原样回执（供前端持久化）');

  // 混用：拿 A 的 token 去接管 B 的座位
  const attacker = rig.connect('attacker');
  attacker.fire('rejoin', { roomCode: ctx.code, playerId: ctx.others[0].playerId, rejoinToken: hostToken });
  assert.strictEqual(attacker.last('error').code, 'BAD_TOKEN', '跨玩家 token 必须被拒');
  assert.strictEqual(attacker.last('roomJoined'), undefined);
  assert.strictEqual(playersCountUnchanged(room, playersBefore), true);

  // 伪造 token
  const forger = rig.connect('forger');
  forger.fire('rejoin', { roomCode: ctx.code, playerId: pid, rejoinToken: 'forged' });
  assert.strictEqual(forger.last('error').code, 'BAD_TOKEN');
  // 空 token
  const empty = rig.connect('empty');
  empty.fire('rejoin', { roomCode: ctx.code, playerId: pid, rejoinToken: '' });
  assert.strictEqual(empty.last('error').code, 'BAD_TOKEN');
  // 他人房间码 + 自己的 token
  const wrongRoom = rig.connect('wrongroom');
  wrongRoom.fire('rejoin', { roomCode: '999', playerId: pid, rejoinToken: hostToken });
  assert.strictEqual(wrongRoom.last('error').code, 'ROOM_NOT_FOUND');

  assert.ok(otherToken && otherToken !== hostToken, '两名玩家的 token 应各不相同');
  assert.strictEqual(attacker.playerId, null, '被拒后不得绑定身份');
});

function playersCountUnchanged(room, n) {
  return room.players.length === n;
}

test('回归 BUG-008（QA 原编号 P1-02）：旧 socket 的 disconnect 不应把已被新连接接管的玩家标记为掉线', (t) => {
  const rig = makeRig();
  t.after(() => rig.dispose());

  const ctx = startN(rig, 3);
  const room = ctx.room;
  const pid = ctx.host.playerId;
  const token = ctx.host.last('roomJoined').rejoinToken;

  ctx.host.fire('disconnect');
  const r1 = rig.connect('r1');
  r1.fire('rejoin', { roomCode: ctx.code, playerId: pid, rejoinToken: token });
  const r2 = rig.connect('r2');
  r2.fire('rejoin', { roomCode: ctx.code, playerId: pid, rejoinToken: token });
  assert.strictEqual(playerOf(room, r2).connected, true);

  // 幽灵连接（r1）随后断开：不应影响已接管的新连接
  r1.fire('disconnect');
  assert.strictEqual(
    playerOf(room, r2).connected,
    true,
    '旧连接的 disconnect 把玩家标记为掉线 → 前端收到 connected=false，界面会误显示「掉线」且收不到后续 state'
  );
});

/* ============================================================
 * 6. GC 与重连的竞态
 * ============================================================ */
test('对抗 6：GC 阈值到达前一刻重连，房间不得被误删；重连后重新计时', async (t) => {
  const rig = makeRig({
    roomGcIntervalMs: 20,
    roomGcWaitingIdleMs: 600,
    roomGcAllOfflineMs: 600,
    reconnectGraceMs: 60 * 1000,
  });
  t.after(() => rig.dispose());

  const ctx = seatN(rig, 2); // waiting 阶段，2 人
  const code = ctx.code;
  const tokens = ctx.all.map((s) => s.last('roomJoined').rejoinToken);
  const pids = ctx.all.map((s) => s.playerId);

  ctx.all.forEach((s) => s.fire('disconnect'));
  assert.ok(rig.rooms.has(code), '刚掉线时房间应保留');

  // 等到约一半阈值（idleSince 从首个 GC tick 起算）
  await sleep(300);
  assert.ok(rig.rooms.has(code), '阈值未到前房间应保留');

  const revived = rig.connect('revived');
  revived.fire('rejoin', { roomCode: code, playerId: pids[0], rejoinToken: tokens[0] });
  assert.ok(revived.last('roomJoined'), '阈值前一刻应能重连成功');

  // 跨过原阈值
  await sleep(700);
  assert.ok(rig.rooms.has(code), '有人在线时房间绝不能被 GC 删除');
  assert.strictEqual(rig.rooms.get(code).players.find((p) => p.id === pids[0]).connected, true);

  // 再次全员离线 → 重新计时，仍应撑过一个完整的阈值周期
  rig.sockets.get('revived').fire('disconnect');
  await sleep(300);
  assert.ok(rig.rooms.has(code), '重新计时后不足阈值，房间应保留');
  await waitFor(() => !rig.rooms.has(code), { timeout: 3000, label: '阈值到达后应回收' });
});

/* ============================================================
 * 7. 陈旧定时器
 * ============================================================ */
test('对抗 7：房间进入 settling 后，此前注册的托管定时器触发时不得改动任何状态', async (t) => {
  const rig = makeRig({ turnTimeoutMs: 60, pickupDelayMs: 60 });
  t.after(() => rig.dispose());

  const ctx = startN(rig, 3);
  const room = ctx.room;
  const cur = curPlayer(room);
  const handBefore = cur.hand.map((c) => c.id).join(',');
  const pileBefore = room.tablePile.length;

  // 只改 phase，保留 currentPlayerId（排除 currentPlayerId 保护，单验 phase 保护）
  room.phase = 'settling';
  await waitForTurnTimerFired(rig, '托管定时器应已触发并退出');

  assert.strictEqual(cur.hand.map((c) => c.id).join(','), handBefore, 'settling 后陈旧定时器不得替玩家出牌');
  assert.strictEqual(room.tablePile.length, pileBefore, '桌面不得变化');
  assert.strictEqual(room.phase, 'settling');
});

test('缺陷 P2-02：房间被移出注册表后，陈旧托管定时器仍会改写幽灵房间状态（守卫缺 rooms.has 判定）', { todo: true }, async (t) => {
  const rig = makeRig({ turnTimeoutMs: 60, pickupDelayMs: 60 });
  t.after(() => rig.dispose());

  const ctx = startN(rig, 3, 'q');
  const room = ctx.room;
  const cur = curPlayer(room);
  const handBefore = cur.hand.map((c) => c.id).join(',');

  // 模拟「房间已回收但定时器未被清理」的路径
  rig.rooms.delete(ctx.code);
  await waitForTurnTimerFired(rig, '托管定时器应已触发');

  assert.ok(!rig.rooms.has(ctx.code), '陈旧定时器不得把房间重新注册回来');
  assert.strictEqual(
    cur.hand.map((c) => c.id).join(','),
    handBefore,
    '已回收房间的状态不应再被托管计时器改写（stale 守卫只查 phase / currentPlayerId，未查房间是否仍注册）'
  );
});

/* ============================================================
 * 8. 定时器不得重复叠加
 * ============================================================ */
test('对抗 8：重复 ready / 重复重连 / 掉线重连都不叠加托管定时器（否则超时会双倍加速）', (t) => {
  const rig = makeRig({ turnTimeoutMs: 30 * 1000, disconnectedTurnMs: 8 * 1000 });
  t.after(() => rig.dispose());

  const ctx = startN(rig, 3);
  const room = ctx.room;
  const pid = room.currentPlayerId;
  const token = ctx.all.find((s) => s.playerId === pid).last('roomJoined').rejoinToken;
  // 「托管定时器」= 回合托管（30s 在线 / 8s 掉线）；宽限定时器（reconnectGraceMs）不在此列
  const turnTimers = () => rig.ledger.timeouts().filter((x) => x.delay === 30 * 1000 || x.delay === 8 * 1000);

  assert.strictEqual(turnTimers().length, 1, '开局应有且仅有 1 个回合定时器');
  assert.strictEqual(turnTimers()[0].delay, 30 * 1000, '在线玩家应用 30s 回合超时');
  assert.strictEqual(rig.ledger.intervals().length, 1, '应有 1 个 GC 巡检定时器');

  // 重复 ready：对局中应被拒，且不改变定时器账本
  const curSock = curSocket(ctx);
  curSock.clear();
  curSock.fire('ready', { ready: true });
  assert.strictEqual(curSock.last('error').code, 'BAD_PHASE', '对局中改准备状态应被拒');
  assert.strictEqual(turnTimers().length, 1, 'ready 不得叠加定时器');

  // 连续三次重连：每次都重发 yourTurn，但定时器必须被重置而非叠加
  for (let i = 0; i < 3; i++) {
    const s = rig.connect(`re-${i}`);
    s.fire('rejoin', { roomCode: ctx.code, playerId: pid, rejoinToken: token });
    assert.strictEqual(turnTimers().length, 1, `第 ${i + 1} 次重连后仍应只有 1 个回合定时器`);
  }

  // 掉线 → 快速托管定时器仍只有 1 个（另有 1 个宽限定时器属预期）
  const latest = rig.sockets.get('re-2');
  latest.fire('disconnect');
  assert.strictEqual(turnTimers().length, 1, '掉线后仍应只有 1 个回合定时器');
  assert.strictEqual(turnTimers()[0].delay, 8 * 1000, '掉线玩家应用 8s 快速托管');
  assert.strictEqual(rig.ledger.timeouts().filter((x) => x.delay === 60 * 1000).length, 1, '掉线应生成 1 个宽限定时器');

  // 重连接管 → 仍只有 1 个回合定时器，且回到 30s
  const back = rig.connect('back');
  back.fire('rejoin', { roomCode: ctx.code, playerId: pid, rejoinToken: token });
  assert.strictEqual(turnTimers().length, 1, '重连后仍应只有 1 个回合定时器');
  assert.strictEqual(turnTimers()[0].delay, 30 * 1000, '重连恢复在线后应回到 30s 回合超时');
});

/* ============================================================
 * 9. 违背规则的直接调用
 * ============================================================ */
test('对抗 9：非当前玩家 playCard / pickUp 被拒，且不得清掉当前玩家的托管定时器', (t) => {
  const rig = makeRig();
  t.after(() => rig.dispose());

  const ctx = startN(rig, 3);
  const room = ctx.room;
  const curId = room.currentPlayerId;
  const notCur = ctx.all.find((s) => s.playerId !== curId);
  const cur = ctx.all.find((s) => s.playerId === curId);
  const me = playerOf(room, notCur);

  setTopK(ctx);
  me.hand = [MONSTER('4'), ACTION('2')];
  const baseline = {
    hand: me.hand.map((c) => c.id).join(','),
    pile: room.tablePile.length,
    cur: room.currentPlayerId,
    timers: rig.ledger.timeouts().length,
  };
  clearAll(ctx);

  notCur.fire('playCard', { cardIds: [me.hand[0].id] });
  assert.strictEqual(notCur.last('error').code, 'NOT_YOUR_TURN');
  notCur.fire('pickUp');
  assert.strictEqual(notCur.last('error').code, 'NOT_YOUR_TURN');
  assert.strictEqual(notCur.events('error').length, 2, '两次违规调用都应报错');

  assert.strictEqual(me.hand.map((c) => c.id).join(','), baseline.hand, '违规调用不得扣手牌');
  assert.strictEqual(room.tablePile.length, baseline.pile, '违规调用不得改桌面');
  assert.strictEqual(room.currentPlayerId, baseline.cur, '违规调用不得改回合');
  assert.strictEqual(rig.ledger.timeouts().length, baseline.timers, '违规调用不得清掉当前玩家的托管定时器');

  // 当前玩家有牌可出时收牌 → MUST_PLAY
  setTopK(ctx);
  playerOf(room, cur).hand = [MONSTER('4'), MONSTER('BJ')];
  cur.clear();
  cur.fire('pickUp');
  assert.strictEqual(cur.last('error').code, 'MUST_PLAY');

  // 结算页越权：非房主 nextRound / start 都必须被拒（BUG-003）
  forceSettle(ctx);
  assert.strictEqual(room.phase, 'settling');
  const nonOwner = ctx.all.find((s) => s.playerId !== room.ownerId);
  nonOwner.clear();
  nonOwner.fire('nextRound');
  assert.strictEqual(nonOwner.last('error').code, 'NOT_OWNER', '非房主不得把全房拉回等待');
  assert.strictEqual(room.phase, 'settling', '非房主越权后仍应停在结算页');
  nonOwner.clear();
  nonOwner.fire('start');
  assert.strictEqual(nonOwner.last('error').code, 'NOT_OWNER', '非房主不得开局');

  // waiting 阶段出牌 → BAD_PHASE
  const ctx2 = seatN(rig, 3, 'w');
  const s2 = ctx2.host;
  s2.clear();
  s2.fire('playCard', { cardIds: ['x'] });
  assert.strictEqual(s2.last('error').code, 'BAD_PHASE', '未开局时出牌应被拒');
});

/* ============================================================
 * 10. 连续 20 次出牌 + 收牌，无定时器泄漏
 * ============================================================ */
test('对抗 10：连续 20 次出牌/收牌循环，定时器账本不增长（无泄漏、无叠加）', async (t) => {
  const rig = makeRig({ turnTimeoutMs: 10 * 60 * 1000, pickupDelayMs: 10 * 60 * 1000 });
  t.after(() => rig.dispose());

  const ctx = startN(rig, 4);
  const room = ctx.room;
  let peak = 0;
  let cycles = 0;

  for (let i = 0; i < 20 && room.phase === 'playing'; i++) {
    if (stepOnce(ctx) === 'blocked-p0') break;
    cycles += 1;
    const total = rig.ledger.count();
    peak = Math.max(peak, total);
    assert.ok(total <= 2, `第 ${i + 1} 次循环后 net 定时器数应为 2（1 回合 + 1 GC 巡检），实际 ${total} → 存在泄漏或叠加`);
    for (const s of ctx.all) assert.deepStrictEqual(s.events('error'), [], `第 ${i + 1} 次循环出现错误事件`);
  }

  assert.ok(cycles >= 20, `应至少完成 20 次循环（实际 ${cycles}）`);
  assert.strictEqual(rig.ledger.timeouts().length, 1, '循环结束后仍应只有 1 个回合定时器');
  assert.ok(peak <= 2, `定时器峰值应为 2，实际 ${peak}`);

  // dispose 应把内部定时器全部清干净。
  // 必须用 netDispose()：rig.dispose() 的 finally 会 ledger.restore() → live.clear()，
  // 直接断言 count()===0 是恒真的假红线（QA 自查 + engineering-lead 交叉指出）。
  const beforeDispose = rig.ledger.count();
  assert.strictEqual(beforeDispose, 2, 'dispose 前应有 1 个回合定时器 + 1 个 GC 巡检定时器');
  rig.netDispose();
  const afterDispose = rig.ledger.count(); // 快照：net.dispose() 之后、ledger.restore() 之前
  rig.ledger.restore();
  assert.strictEqual(afterDispose, 0, 'net.dispose() 后 net 层定时器应清零');
});

test('缺陷 P2-01：dispose 应同时清理掉线宽限定时器（否则测试/热重载场景残留）', { todo: true }, (t) => {
  const rig = makeRig({ reconnectGraceMs: 10 * 60 * 1000 });
  t.after(() => {
    try {
      rig.dispose();
    } catch (_) {
      /* ignore */
    }
  });

  const ctx = seatN(rig, 2);
  ctx.all[0].fire('disconnect'); // 生成宽限定时器
  assert.strictEqual(rig.ledger.timeouts().length, 1, '掉线应生成 1 个宽限定时器');
  const beforeDispose = rig.ledger.count();
  assert.strictEqual(beforeDispose, 2, '账本应为 1 个宽限定时器 + 1 个 GC 巡检定时器');

  // 关键：不能用 rig.dispose()（它 finally 里 restore() 会 live.clear()，断言恒真）。
  // 这里只调 net.dispose()，在 restore() 之前把账本快照下来。
  rig.netDispose();
  const leftover = rig.ledger.list();
  const afterDispose = rig.ledger.count();
  rig.ledger.restore();
  t.diagnostic(`net.dispose() 后残留 net 定时器：${afterDispose} 个 ${JSON.stringify(leftover)}`);
  assert.strictEqual(
    afterDispose,
    0,
    `net.dispose() 应清理掉线宽限定时器（实测残留 ${afterDispose} 个：${JSON.stringify(leftover)}）`
  );
});

test('回归 P2-11：被 rejoin 接管的旧 socket 不得再代替玩家出牌（写权限随接管一并吊销）', (t) => {
  const rig = makeRig({ turnTimeoutMs: 10 * 60 * 1000, pickupDelayMs: 10 * 60 * 1000 });
  t.after(() => rig.dispose());

  const ctx = startN(rig, 3);
  const room = ctx.room;
  const pid = room.currentPlayerId;
  const oldSock = ctx.all.find((s) => s.playerId === pid);
  const token = oldSock.last('roomJoined').rejoinToken;

  oldSock.fire('disconnect');
  const r1 = rig.connect('r1');
  r1.fire('rejoin', { roomCode: ctx.code, playerId: pid, rejoinToken: token });
  assert.strictEqual(room.players.find((p) => p.id === pid).socketId, 'r1', '前置：座位已由 r1 接管');

  const me = room.players.find((p) => p.id === pid);
  const handBefore = me.hand.length;
  const pileBefore = room.tablePile.length;
  oldSock.clear();
  oldSock.fire('playCard', { cardIds: [me.hand[0].id] });

  assert.ok(
    oldSock.events('error').length > 0,
    '被接管的旧连接必须被拒（W0-ENG-03 之前此路径无任何校验，幽灵连接可直接出牌成功）'
  );
  assert.strictEqual(me.hand.length, handBefore, '旧连接不得改动房间状态');
  assert.strictEqual(room.tablePile.length, pileBefore, '旧连接不得改动桌面');
});

test('回归 P2-11b：被接管的旧 socket 不得把玩家踢出 waiting 房间（越权写必须被拒）', (t) => {
  const rig = makeRig({ reconnectGraceMs: 10 * 60 * 1000 });
  t.after(() => rig.dispose());

  const ctx = seatN(rig, 2); // waiting 阶段：房主 + 1 人
  const room = ctx.room;
  const pid = ctx.host.playerId;
  const token = ctx.host.last('roomJoined').rejoinToken;
  const playersBefore = room.players.length;

  ctx.host.fire('disconnect');
  const r1 = rig.connect('r1');
  r1.fire('rejoin', { roomCode: ctx.code, playerId: pid, rejoinToken: token });
  assert.strictEqual(room.players.find((p) => p.id === pid).socketId, 'r1', '前置：座位已由 r1 接管');

  // 已作废的旧连接发 leaveRoom
  ctx.host.clear();
  ctx.host.fire('leaveRoom');

  assert.ok(ctx.host.events('error').length > 0, '被接管的旧连接必须收到拒绝回执（静默放行 = 越权成功）');
  assert.strictEqual(room.players.length, playersBefore, '旧连接不得把在线玩家踢出房间');
  assert.strictEqual(room.ownerId, pid, '房主身份不得被旧连接的操作夺走');
});

/* ============================================================
 * 11. 已知 P0：功能牌开轮导致协议层崩溃（BUG-001 的同类复发）
 * ============================================================ */
test('回归 BUG-007（QA 原编号 P0-01）：桌面为空时打出功能牌（A/2）后，下家回合必须能正常计算合法牌', (t) => {
  const rig = makeRig({ turnTimeoutMs: 60 * 1000, pickupDelayMs: 60 * 1000 });
  t.after(() => rig.dispose());

  const ctx = startN(rig, 3);
  const room = ctx.room;
  const cur = curPlayer(room);
  const sock = curSocket(ctx);

  // GDD §6.3：「一轮的第一张牌（桌面为空）可出任意牌（含功能牌）」
  room.tablePile = [];
  room.topCard = null;
  room.topCount = 1;
  const two = ACTION('2');
  cur.hand = [two, MONSTER('4')];
  clearAll(ctx);

  sock.fire('playCard', { cardIds: [two.id] });

  assert.deepStrictEqual(sock.events('error'), [], '合法出牌不得给玩家弹「操作失败」');
  assert.strictEqual(room.direction, -1, '2 应反转方向');
  // 修正（已回传 team-lead）：原断言用「第一个不是当前玩家的 socket」找下家，
  // 但 2 会反转方向，真正的接续者是反方向的下一位（seat 2 而非 seat 1）。
  const nextSock = ctx.all.find((s) => s.playerId === room.currentPlayerId);
  assert.ok(nextSock, '应能定位到实际下家');
  assert.ok(nextSock.last('yourTurn'), '下家必须收到 yourTurn（否则房间被卡死）');
  assert.strictEqual(
    nextSock.last('yourTurn').legalMoves.opening,
    true,
    'topCard=null → 仍是「无门槛」，下家可任意出牌'
  );
  assert.strictEqual(rig.ledger.timeouts().length, 1, '下家回合必须有超时托管兜底');
});

test('回归 BUG-007（QA 原编号 P0-01b）：功能牌开轮后的桌面状态应能被后续任何操作正确处理', (t) => {
  const rig = makeRig();
  t.after(() => rig.dispose());

  const ctx = startN(rig, 3);
  const room = ctx.room;
  const cur = curPlayer(room);
  const nextPid = room.players.find((p) => p.id !== cur.id).id;
  const nextSock = ctx.all.find((s) => s.playerId === nextPid);
  const nextPlayer = playerOf(room, nextSock);

  room.tablePile = [];
  room.topCard = null;
  const a = ACTION('A');
  cur.hand = [a, MONSTER('4')];
  curSocket(ctx).fire('playCard', { cardIds: [a.id] });

  assert.strictEqual(room.currentPlayerId, nextPid, 'A 不改变方向，下家是 seat 1');
  assert.strictEqual(room.topCard, null, 'A 不设置门槛牌');
  assert.strictEqual(room.tablePile.length, 1, 'A 仍留在桌面（收牌时一并进败牌堆）');

  // ① 有牌可出时收牌：必须是业务错误 MUST_PLAY，而不是因 topCard=null 抛的内部异常。
  //    修正（已回传 team-lead）：原断言要求「完全没有 error 事件」，这与规则冲突 ——
  //    有牌可出时收牌本就该被拒（engine 抛 MUST_PLAY），修好 BUG-007 后这条反而是正确行为。
  nextPlayer.hand = [MONSTER('4'), MONSTER('6')];
  nextSock.clear();
  nextSock.fire('pickUp');
  const errs = nextSock.events('error');
  assert.ok(errs.length >= 1, '有牌可出时收牌应被拒');
  assert.strictEqual(errs[errs.length - 1].code, 'MUST_PLAY', '应为业务错误 MUST_PLAY');
  assert.ok(
    !errs.some((e) => e.code === 'ERROR' || e.code === 'INTERNAL'),
    '不得出现内部异常错误码（topCard=null 时抛 TypeError 的老路径）'
  );
  assert.strictEqual(room.currentPlayerId, nextPid, '被拒后仍是该玩家回合');
  assert.strictEqual(room.tablePile.length, 1, '被拒后桌面不变');

  // ② 手牌打空后收牌：应成功，且桌面那张 A 进入败牌堆、本轮重开（GDD §6.1）
  nextPlayer.hand = [];
  if (room.drawPile.length === 0) room.drawPile = [MONSTER('K'), MONSTER('K'), MONSTER('K'), MONSTER('K'), MONSTER('K')];
  nextSock.clear();
  nextSock.fire('pickUp');

  assert.deepStrictEqual(nextSock.events('error'), [], '无牌可出时收牌不应报错');
  assert.ok(nextPlayer.penaltyPile.some((c) => c.id === a.id), '桌面上那张 A 应进入收牌者败牌堆');
  assert.strictEqual(room.tablePile.length, 0, '桌面清空');
  assert.strictEqual(room.topCard, null, '门槛仍为空');
  assert.strictEqual(room.currentPlayerId, nextPid, '收牌者成为新一轮先出者');
  assert.ok(nextSock.last('yourTurn'), '收牌后应重新下发 yourTurn');
  assert.strictEqual(nextSock.last('yourTurn').legalMoves.opening, true, '新一轮仍是开轮');
});
