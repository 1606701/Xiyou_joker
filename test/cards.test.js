'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { buildDeck, shuffle, canBeat, canBeatGroup } = require('../lib/cards.js');

// 构造测试用牌
const card = (rank, kind, suit = '♠') => ({ id: `${rank}_${suit}_0`, rank, suit, kind });

const MONSTER = (r) => card(r, 'monster');
const DISCIPLE = (r) => card(r, 'disciple');
const MASTER = () => card('10', 'master');
const ACTION = (r) => card(r, 'action');

test('牌堆完整性：54 张，各类别数量符合规格', () => {
  const deck = buildDeck();
  assert.strictEqual(deck.length, 54);
  const count = (kind) => deck.filter((c) => c.kind === kind).length;
  const countRank = (rank) => deck.filter((c) => c.rank === rank).length;
  assert.strictEqual(count('monster'), 30); // 4/6/7/9/J/Q/K×4=28 + 王×2
  assert.strictEqual(count('disciple'), 12); // 3/8/5×4
  assert.strictEqual(count('master'), 4); // 10×4
  assert.strictEqual(count('action'), 8); // A/2×4
  for (const r of ['4', '6', '7', '9', 'J', 'Q', 'K', '3', '8', '5', '10', 'A', '2']) {
    assert.strictEqual(countRank(r), 4, `牌面 ${r} 应有 4 张`);
  }
  assert.strictEqual(countRank('SJ'), 1);
  assert.strictEqual(countRank('BJ'), 1);
});

test('洗牌：数量不变且 id 集合相同', () => {
  const deck = buildDeck();
  const ids = deck.map((c) => c.id).sort();
  const shuffled = shuffle(deck);
  assert.strictEqual(shuffled.length, 54);
  assert.deepStrictEqual(shuffled.map((c) => c.id).sort(), ids);
});

test('妖怪内部逐档可压：4<6<7<9<J<Q<K<小王<大王', () => {
  const pairs = [['4', '6'], ['6', '7'], ['7', '9'], ['9', 'J'], ['J', 'Q'], ['Q', 'K'], ['K', 'SJ'], ['SJ', 'BJ']];
  for (const [small, big] of pairs) {
    assert.strictEqual(canBeat(MONSTER(small), MONSTER(big)), true, `${big} 应压制 ${small}`);
    assert.strictEqual(canBeat(MONSTER(big), MONSTER(small)), false, `${small} 不应压制 ${big}`);
  }
});

test('同值妖怪不可压', () => {
  assert.strictEqual(canBeat(MONSTER('4'), MONSTER('4')), false);
  assert.strictEqual(canBeat(MONSTER('BJ'), MONSTER('BJ')), false);
});

test('师兄弟可压制任意妖怪：3 压 4、3 压大王、8 压 K、5 压小王', () => {
  assert.strictEqual(canBeat(MONSTER('4'), DISCIPLE('3')), true);
  assert.strictEqual(canBeat(MONSTER('BJ'), DISCIPLE('3')), true);
  assert.strictEqual(canBeat(MONSTER('K'), DISCIPLE('8')), true);
  assert.strictEqual(canBeat(MONSTER('SJ'), DISCIPLE('5')), true);
});

test('师兄弟内部：3<8<5，反向与同值不可压', () => {
  assert.strictEqual(canBeat(DISCIPLE('3'), DISCIPLE('8')), true);
  assert.strictEqual(canBeat(DISCIPLE('3'), DISCIPLE('5')), true);
  assert.strictEqual(canBeat(DISCIPLE('8'), DISCIPLE('5')), true);
  assert.strictEqual(canBeat(DISCIPLE('8'), DISCIPLE('3')), false);
  assert.strictEqual(canBeat(DISCIPLE('5'), DISCIPLE('3')), false);
  assert.strictEqual(canBeat(DISCIPLE('5'), DISCIPLE('8')), false);
  assert.strictEqual(canBeat(DISCIPLE('3'), DISCIPLE('3')), false);
});

test('唐僧可压制三师兄弟：10 压 3/8/5', () => {
  assert.strictEqual(canBeat(DISCIPLE('3'), MASTER()), true);
  assert.strictEqual(canBeat(DISCIPLE('8'), MASTER()), true);
  assert.strictEqual(canBeat(DISCIPLE('5'), MASTER()), true);
});

test('师兄弟不可压制唐僧', () => {
  assert.strictEqual(canBeat(MASTER(), DISCIPLE('3')), false);
  assert.strictEqual(canBeat(MASTER(), DISCIPLE('8')), false);
  assert.strictEqual(canBeat(MASTER(), DISCIPLE('5')), false);
});

test('任意妖怪可压制唐僧（含 4 压 10）', () => {
  assert.strictEqual(canBeat(MASTER(), MONSTER('4')), true);
  assert.strictEqual(canBeat(MASTER(), MONSTER('J')), true);
  assert.strictEqual(canBeat(MASTER(), MONSTER('BJ')), true);
});

test('唐僧互压不可：10 压 10', () => {
  assert.strictEqual(canBeat(MASTER(), MASTER()), false);
});

test('妖怪不可压制师兄弟：4 压 3、K 压 5 均 false', () => {
  assert.strictEqual(canBeat(DISCIPLE('3'), MONSTER('4')), false);
  assert.strictEqual(canBeat(DISCIPLE('5'), MONSTER('K')), false);
});

// ---- 组合克制（多张同点出牌） ----
test('组合克制：同点数严格更大才可压（3×6 压 3×4，3×4 压不了 3×4）', () => {
  assert.ok(canBeatGroup({ kind: 'monster', rank: '4', count: 3 }, { kind: 'monster', rank: '6', count: 3 }));
  assert.ok(!canBeatGroup({ kind: 'monster', rank: '4', count: 3 }, { kind: 'monster', rank: '4', count: 3 }));
});

test('组合克制：张数必须相等（3×6 压不了 2×4，2×6 压不了 3×4）', () => {
  assert.ok(!canBeatGroup({ kind: 'monster', rank: '4', count: 3 }, { kind: 'monster', rank: '6', count: 2 }));
  assert.ok(!canBeatGroup({ kind: 'monster', rank: '4', count: 2 }, { kind: 'monster', rank: '6', count: 3 }));
});

test('组合克制：跨组遵循环形克制（师兄弟压妖怪、唐僧压师兄弟、妖怪压唐僧）', () => {
  assert.ok(canBeatGroup({ kind: 'monster', rank: '4', count: 3 }, { kind: 'disciple', rank: '3', count: 3 }));
  assert.ok(canBeatGroup({ kind: 'disciple', rank: '5', count: 3 }, { kind: 'master', rank: '10', count: 3 }));
  assert.ok(canBeatGroup({ kind: 'master', rank: '10', count: 3 }, { kind: 'monster', rank: '4', count: 3 }));
});

test('组合克制：开局任意同点组合（2~4 张）均可出', () => {
  assert.ok(canBeatGroup(null, { kind: 'monster', rank: '4', count: 4 }));
  assert.ok(canBeatGroup(null, { kind: 'disciple', rank: '3', count: 2 }));
});

test('功能牌隔离：A/2 不参与压制链', () => {
  assert.strictEqual(canBeat(ACTION('A'), MONSTER('4')), false);
  assert.strictEqual(canBeat(ACTION('2'), MONSTER('4')), false);
  assert.strictEqual(canBeat(MONSTER('4'), ACTION('A')), false);
  assert.strictEqual(canBeat(ACTION('A'), ACTION('2')), false);
});

test('空门槛（开局）任意牌可出', () => {
  assert.strictEqual(canBeat(null, MONSTER('4')), true);
  assert.strictEqual(canBeat(null, MASTER()), true);
  assert.strictEqual(canBeat(null, ACTION('A')), true);
});
