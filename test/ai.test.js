'use strict';

/**
 * test/ai.test.js — AI 补位策略（lib/ai.js）单元测试。
 *
 * 设计原则（与 test/net.test.js 一致）：零依赖、不依赖随机、全部手工摆局面。
 * 策略的价值在于「确定性可推演」，所以每条决策规则都有一个手工构造的最小局面来钉住它；
 * 最后用 300 个伪随机房间做合法性穷举，防止「策略与引擎漂移」（这是本模块唯一的真风险）。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const engine = require('../lib/engine.js');
const { buildDeck } = require('../lib/cards.js');
const ai = require('../lib/ai.js');

/* ============================================================
 * 脚手架
 * ============================================================ */

const KIND_OF = {
  4: 'monster', 6: 'monster', 7: 'monster', 9: 'monster', J: 'monster', Q: 'monster',
  K: 'monster', SJ: 'monster', BJ: 'monster',
  3: 'disciple', 8: 'disciple', 5: 'disciple',
  10: 'master',
  A: 'action', 2: 'action',
};

let seq = 0;
/** 造一张牌（id 全局唯一，便于断言「返回的牌来自手牌」） */
function C(rank, suit) {
  seq += 1;
  return { id: `a_${rank}_${seq}`, rank, suit: suit || '♠', kind: KIND_OF[rank] };
}

/**
 * 摆一个 3 人房间：p0 是 AI（被测），p1/p2 只是占位（保持 3 人，符合引擎最少人数）。
 * @param {object} o
 * @param {object[]} o.hand p0 的手牌
 * @param {object|null} [o.top] 门槛牌
 * @param {number} [o.topCount] 门槛组合张数
 * @param {object[]} [o.tablePile] 桌面牌堆
 * @param {object[]} [o.drawPile] 摸牌堆
 * @param {number} [o.direction]
 */
function makeRoom(o) {
  const room = engine.createRoom('999');
  for (const [i, name] of ['AI', '乙', '丙'].entries()) {
    engine.addPlayer(room, { id: `p${i}`, name, socketId: i === 0 ? null : `s${i}`, isAI: i === 0 });
  }
  room.phase = 'playing';
  room.currentPlayerId = 'p0';
  room.players[0].hand = o.hand || [];
  room.players[1].hand = [C('4')];
  room.players[2].hand = [C('4')];
  room.topCard = o.top || null;
  room.topCount = o.topCount || 1;
  room.tablePile = o.tablePile || [];
  room.drawPile = o.drawPile || [];
  room.direction = o.direction || 1;
  return room;
}

/** 取 p0 手牌里所有指定点数的牌（用于构造「4 张同点」这类局面） */
function cardsOf(rank, n) {
  return Array.from({ length: n }, (_, i) => C(rank, ['♠', '♥', '♣', '♦'][i]));
}

/** 断言 chooseMove 返回的是「从手牌里挑出的非空组合」 */
function assertPlayFrom(room, mv) {
  assert.strictEqual(mv.type, 'play', '应为出牌决策');
  assert.ok(Array.isArray(mv.cardIds), 'cardIds 必须是数组');
  assert.ok(mv.cardIds.length > 0, 'cardIds 不能为空（空数组会被 playCard 判 ILLEGAL_CARD）');
  const handIds = new Set(room.players[0].hand.map((c) => c.id));
  for (const id of mv.cardIds) assert.ok(handIds.has(id), `返回的牌 ${id} 必须在手牌里`);
}

/* ============================================================
 * 1. 开轮（无门槛牌）
 * ============================================================ */

test('开轮：4 张同点 + 单张 → 打 4 张同点（张数最多优先）', () => {
  const four = cardsOf('4', 4);
  const room = makeRoom({ hand: [...four, C('K')] });
  const mv = ai.chooseMove(room, 'p0');

  assertPlayFrom(room, mv);
  assert.strictEqual(mv.cardIds.length, 4, '开轮应打张数最多的组（4 张几乎无人可压）');
  assert.strictEqual(new Set(mv.cardIds).size, 4, '4 张牌不应重复');
  assert.deepStrictEqual(mv.cardIds.slice().sort(), four.map((c) => c.id).sort());

  // 同上局面能被引擎执行（合法性由引擎复验）
  const res = engine.playCard(room, 'p0', mv.cardIds);
  assert.strictEqual(res.action, 'played');
  assert.strictEqual(room.topCount, 4);
});

test('开轮：有单张实体牌时不打功能牌（功能牌不设门槛，开轮打它等于把出牌权送人）', () => {
  const room = makeRoom({ hand: [C('4'), C('A')] });
  const mv = ai.chooseMove(room, 'p0');

  assertPlayFrom(room, mv);
  assert.strictEqual(mv.cardIds.length, 1);
  assert.strictEqual(room.players[0].hand.find((c) => c.id === mv.cardIds[0]).rank, '4');
});

test('开轮：手里只剩功能牌 → 打 A（消耗序 14 < 2 的 15）', () => {
  const room = makeRoom({ hand: [C('2'), C('A')] });
  const mv = ai.chooseMove(room, 'p0');

  assertPlayFrom(room, mv);
  assert.strictEqual(mv.cardIds.length, 1);
  assert.strictEqual(room.players[0].hand.find((c) => c.id === mv.cardIds[0]).rank, 'A');
});

/* ============================================================
 * 2. 跟牌（有门槛牌）
 * ============================================================ */

test('跟牌：取 DISPLAY_ORDER 最小的可压组（6 而不是 7/9）', () => {
  const room = makeRoom({ hand: [C('9'), C('7'), C('6')], top: C('4'), topCount: 1 });
  const mv = ai.chooseMove(room, 'p0');

  assertPlayFrom(room, mv);
  assert.strictEqual(mv.cardIds.length, 1, '跟单张必须出单张（张数须等于门槛）');
  assert.strictEqual(room.players[0].hand.find((c) => c.id === mv.cardIds[0]).rank, '6');
});

test('跟牌：门槛 2 张时出 2 张同点（张数恒等于 topCount，无需比较长度）', () => {
  const sixes = cardsOf('6', 2);
  const room = makeRoom({ hand: [...sixes, C('9')], top: C('4'), topCount: 2 });
  const mv = ai.chooseMove(room, 'p0');

  assertPlayFrom(room, mv);
  assert.strictEqual(mv.cardIds.length, 2, '门槛是 2 张组合，只能用 2 张压');
  const res = engine.playCard(room, 'p0', mv.cardIds);
  assert.strictEqual(res.action, 'played');
});

test('跟牌：beats 空 + 桌面 >= 3 张 + 有 A/2 → 打 2（反转方向让上家吃自己设的门槛）', () => {
  const room = makeRoom({
    hand: [C('4'), C('A'), C('2')],
    top: C('BJ'), // 大王，4 压不住
    topCount: 1,
    tablePile: [C('4'), C('6'), C('7'), C('BJ')],
  });
  const moves = engine.computeLegalMoves(room, 'p0');
  assert.strictEqual(moves.beats.length, 0, '前置：4 压不住大王，beats 必须为空');

  const mv = ai.chooseMove(room, 'p0');
  assertPlayFrom(room, mv);
  assert.strictEqual(room.players[0].hand.find((c) => c.id === mv.cardIds[0]).rank, '2');

  const before = room.direction;
  engine.playCard(room, 'p0', mv.cardIds);
  assert.strictEqual(room.direction, -before, '2 必须反转方向');
});

test('跟牌：beats 空 + 桌面 < 3 张 + 有 A/2 → 打 A（省下 2 当逃生牌）', () => {
  const room = makeRoom({
    hand: [C('4'), C('A'), C('2')],
    top: C('BJ'),
    topCount: 1,
    tablePile: [C('BJ')],
  });
  const mv = ai.chooseMove(room, 'p0');

  assertPlayFrom(room, mv);
  assert.strictEqual(room.players[0].hand.find((c) => c.id === mv.cardIds[0]).rank, 'A');
});

test('跟牌：桌面 >= 3 张但只剩 A → 打 A（不能因为没 2 就弃权收牌）', () => {
  const room = makeRoom({
    hand: [C('4'), C('A')],
    top: C('BJ'),
    topCount: 1,
    tablePile: [C('4'), C('6'), C('7'), C('BJ')],
  });
  const mv = ai.chooseMove(room, 'p0');

  assertPlayFrom(room, mv);
  assert.strictEqual(room.players[0].hand.find((c) => c.id === mv.cardIds[0]).rank, 'A');
});

/* ============================================================
 * 3. 无牌可出
 * ============================================================ */

test('无任何合法牌 → 收牌', () => {
  const room = makeRoom({ hand: [C('4')], top: C('BJ'), topCount: 1, tablePile: [C('BJ')], drawPile: [C('9')] });
  const mv = ai.chooseMove(room, 'p0');

  assert.strictEqual(mv.type, 'pickup');
  const res = engine.pickUp(room, 'p0');
  assert.strictEqual(res.action, 'pickedUp');
  assert.strictEqual(room.players[0].penaltyPile.length, 1, '桌面 1 张应进败牌堆');
});

/* ============================================================
 * 4. 与引擎的协作契约（AI 相关的两处引擎行为）
 * ============================================================ */

test('nextRound：AI 自动就绪，否则下一局房主点开始会被 NOT_READY 卡住', () => {
  const room = makeRoom({ hand: [] });
  room.phase = 'settling';
  room.players.forEach((p) => { p.penaltyPile = [C('4')]; });

  engine.nextRound(room);

  assert.strictEqual(room.phase, 'waiting');
  assert.strictEqual(room.players[0].ready, true, 'AI 必须保持就绪');
  assert.strictEqual(room.players[1].ready, false, '真人仍需自己点准备');
});

test('removePlayer：房主离开后房主转移给真人，不落到 AI 头上', () => {
  const room = engine.createRoom('999');
  engine.addPlayer(room, { id: 'ai-1', name: '悟能', socketId: null, isAI: true });
  engine.addPlayer(room, { id: 'h-1', name: '悟空', socketId: 's1' });
  engine.addPlayer(room, { id: 'ai-2', name: '悟净', socketId: null, isAI: true });
  assert.strictEqual(room.ownerId, 'ai-1', '前置：第一个入座的是 AI，它先拿了房主');

  engine.removePlayer(room, 'h-1');
  assert.strictEqual(room.ownerId, 'ai-1', '真人离开不应改变现有房主');

  engine.removePlayer(room, 'ai-1');
  assert.strictEqual(room.ownerId, 'ai-2', '只剩 AI 时房主只能给 AI（此时房间本就该被回收）');

  // 关键场景：房主是真人，且 0 号座位是 AI → 转移不能给 0 号座位的 AI
  const room2 = engine.createRoom('998');
  engine.addPlayer(room2, { id: 'ai-x', name: '悟能', socketId: null, isAI: true });
  engine.addPlayer(room2, { id: 'h-a', name: '悟空', socketId: 'sa' });
  engine.addPlayer(room2, { id: 'h-b', name: '八戒', socketId: 'sb' });
  room2.ownerId = 'h-a';
  engine.removePlayer(room2, 'h-a');
  assert.strictEqual(room2.ownerId, 'h-b', '房主必须转移给真人 h-b，而不是 0 号座位的 AI');
});

test('AI_NAMES：6 个名字，互不重复', () => {
  assert.strictEqual(ai.AI_NAMES.length, 6);
  assert.strictEqual(new Set(ai.AI_NAMES).size, 6);
});

/* ============================================================
 * 5. 合法性穷举：策略输出必须 100% 能被引擎执行
 * ============================================================ */

/** 确定性伪随机（固定种子 → 失败可复现） */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('合法性穷举：300 个随机房间，chooseMove 的返回必须能被引擎成功执行', () => {
  const rng = makeRng(20261027);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const counts = { play: 0, pickup: 0 };
  const openingCounts = { true: 0, false: 0 };

  for (let iter = 0; iter < 300; iter++) {
    const pool = buildDeck();
    // Fisher-Yates（用注入的 rng，保证可复现）
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const hand = pool.slice(0, 1 + Math.floor(rng() * 8));
    const rest = pool.slice(hand.length);

    const room = makeRoom({
      hand,
      top: rng() < 0.45 ? null : pick(rest.filter((c) => c.kind !== 'action')),
      topCount: 1 + Math.floor(rng() * 4),
      tablePile: rest.slice(0, Math.floor(rng() * 6)),
      drawPile: rest.slice(8, 8 + Math.floor(rng() * 10)),
    });
    if (room.topCard === null) room.topCount = 1;
    else if (room.topCard === undefined) room.topCard = null;
    // 门槛为 null 时 topCount 必须归 1（与引擎开轮语义一致）
    if (!room.topCard) room.topCount = 1;

    const moves = engine.computeLegalMoves(room, 'p0');
    const mv = ai.chooseMove(room, 'p0');

    assert.ok(mv && (mv.type === 'play' || mv.type === 'pickup'), `第 ${iter} 次：返回结构非法`);
    if (moves.beats.length === 0 && moves.actions.length === 0) {
      assert.strictEqual(mv.type, 'pickup', `第 ${iter} 次：无牌可出必须收牌`);
    } else {
      assert.strictEqual(mv.type, 'play', `第 ${iter} 次：有牌可出却选择了收牌`);
    }

    // 核心断言：不抛错即证明「策略输出 ⊆ 引擎认可」
    let res;
    assert.doesNotThrow(() => {
      res = mv.type === 'pickup' ? engine.pickUp(room, 'p0') : engine.playCard(room, 'p0', mv.cardIds);
    }, `第 ${iter} 次：策略给出的动作被引擎拒绝（opening=${moves.opening}, topCard=${JSON.stringify(room.topCard && room.topCard.rank)}, topCount=${room.topCount}）`);
    assert.ok(res && (res.action === 'played' || res.action === 'pickedUp' || res.action === 'gameOver'));

    counts[mv.type] += 1;
    openingCounts[moves.opening ? 'true' : 'false'] += 1;
  }

  // 覆盖面自检：两个分支、开轮/跟牌两种情境都必须被真的走到
  assert.ok(counts.play > 50, `出牌分支覆盖不足：${counts.play}`);
  assert.ok(counts.pickup > 10, `收牌分支覆盖不足：${counts.pickup}`);
  assert.ok(openingCounts.true > 20, `开轮情境覆盖不足：${openingCounts.true}`);
  assert.ok(openingCounts.false > 20, `跟牌情境覆盖不足：${openingCounts.false}`);
});
