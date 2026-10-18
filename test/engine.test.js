'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  createRoom, addPlayer, removePlayer, setReady, allReady, startGame,
  playCard, pickUp, nextRound, settleGame, autoPlay, computeLegalMoves, resolveNext,
} = require('../lib/engine.js');

// ---- 辅助构造 ----
let uid = 0;
const mkPlayer = (name) => ({ id: `u${uid++}`, name, seat: 0, ready: false, connected: true, hand: [], penaltyPile: [] });

let cid = 0;
const C = (rank, kind, suit = '♠') => ({ id: `${rank}_${suit}_${cid++}`, rank, suit, kind });
const MONSTER = (r) => C(r, 'monster');
const DISCIPLE = (r) => C(r, 'disciple');
const MASTER = () => C('10', 'master');
const ACTION = (r) => C(r, 'action');

/** 构造一个对局中的房间：3 玩家、指定手牌、门槛、桌面、方向、当前玩家 */
function makeGame({ hands = 3, players = 3, topCard = null, tablePile = [], direction = 1, current = 0 } = {}) {
  const room = createRoom('ABC');
  const list = [];
  for (let i = 0; i < players; i++) list.push(mkPlayer(`P${i}`));
  list.forEach((p) => addPlayer(room, p));
  list.forEach((p) => { p.ready = true; });
  room.phase = 'playing';
  room.direction = direction;
  room.currentPlayerId = list[current].id;
  room.topCard = topCard;
  room.tablePile = tablePile.slice();
  if (hands === 0) return { room, list };
  // 给每人发一些简单牌：每人一张 4、一张 6（+ 更多）
  list.forEach((p, i) => {
    p.hand = [MONSTER('4'), MONSTER('6')];
    if (i === 0) p.hand.push(ACTION('A'), ACTION('2'), DISCIPLE('3'));
    if (i === 1) p.hand.push(DISCIPLE('5'), MASTER());
  });
  return { room, list };
}

const getByName = (room, name) => room.players.find((p) => p.name === name);

// ---- 发牌与开局 ----
test('startGame：3~6 人各得 5 张，摸牌堆 = 54-5n，首局房主先手', () => {
  for (const n of [3, 4, 5, 6]) {
    const room = createRoom('R');
    const list = [];
    for (let i = 0; i < n; i++) list.push(mkPlayer(`P${i}`));
    list.forEach((p) => addPlayer(room, p));
    list.forEach((p) => { p.ready = true; });
    startGame(room);
    assert.strictEqual(room.phase, 'playing');
    for (const p of list) assert.strictEqual(p.hand.length, 5, `${n}人局每人5张`);
    assert.strictEqual(room.drawPile.length, 54 - 5 * n);
    assert.strictEqual(room.currentPlayerId, room.ownerId, '首局房主先手');
  }
});

test('startGame 校验：不足 3 人 / 未全员准备 抛错', () => {
  const room = createRoom('R');
  const a = mkPlayer('A');
  addPlayer(room, a);
  a.ready = true;
  assert.throws(() => startGame(room), (e) => e.code === 'NOT_ENOUGH');
  const b = mkPlayer('B');
  addPlayer(room, b);
  b.ready = false;
  assert.throws(() => startGame(room), (e) => e.code === 'NOT_ENOUGH', '2人仍不足');
  const c = mkPlayer('C');
  addPlayer(room, c);
  c.ready = true;
  // 3 人但 B 未准备
  assert.throws(() => startGame(room), (e) => e.code === 'NOT_READY');
});

// ---- 出牌 ----
test('普通压制：门槛更新为新牌，顺时针轮到下家', () => {
  const { room, list } = makeGame({ topCard: MONSTER('4'), tablePile: [MONSTER('4')] });
  const p0 = list[0];
  const six = p0.hand.find((c) => c.rank === '6');
  const ret = playCard(room, p0.id, [six.id]);
  assert.strictEqual(ret.action, 'played');
  assert.strictEqual(room.topCard.rank, '6');
  assert.strictEqual(room.topCount, 1, '单张门槛张数=1');
  assert.strictEqual(room.currentPlayerId, list[1].id, '顺时针轮到下家');
  assert.ok(!p0.hand.some((c) => c.id === six.id));
});

test('A 牌：门槛不变，轮到下家', () => {
  const { room, list } = makeGame({ topCard: MONSTER('4'), tablePile: [MONSTER('4')] });
  const a = list[0].hand.find((c) => c.rank === 'A');
  playCard(room, list[0].id, [a.id]);
  assert.strictEqual(room.topCard.rank, '4', 'A 不改变门槛');
  assert.strictEqual(room.currentPlayerId, list[1].id);
});

test('2 牌：方向反转，轮到原上家（新方向下一位）', () => {
  const { room, list } = makeGame({ topCard: MONSTER('4'), tablePile: [MONSTER('4')], direction: 1, current: 1 });
  list[1].hand.push(ACTION('2')); // 补一张 2 给当前玩家 P1
  const two = list[1].hand.find((c) => c.rank === '2');
  playCard(room, list[1].id, [two.id]);
  assert.strictEqual(room.direction, -1, '方向反转');
  // 原顺时针顺序 P0→P1→P2；P1 出 2 后逆时针，下一位是 P0（原上家）
  assert.strictEqual(room.currentPlayerId, list[0].id);
});

test('同值不可压：出相同牌值的牌被拒绝', () => {
  const { room, list } = makeGame({ topCard: MONSTER('4'), tablePile: [MONSTER('4')] });
  const four = list[0].hand.find((c) => c.rank === '4');
  assert.throws(() => playCard(room, list[0].id, [four.id]), (e) => e.code === 'ILLEGAL_CARD');
});

test('非当前玩家出牌被拒绝', () => {
  const { room, list } = makeGame({ topCard: MONSTER('4'), tablePile: [MONSTER('4')] });
  const six = list[1].hand.find((c) => c.rank === '6');
  assert.throws(() => playCard(room, list[1].id, [six.id]), (e) => e.code === 'NOT_YOUR_TURN');
});

test('能压制时不允许收牌', () => {
  const { room, list } = makeGame({ topCard: MONSTER('4'), tablePile: [MONSTER('4')] });
  // P0 手上有 6 可压
  assert.throws(() => pickUp(room, list[0].id), (e) => e.code === 'MUST_PLAY');
});

// ---- 收牌 / 补牌 / 重开 ----
test('收牌：桌面入败牌堆、全员补至5张、收牌者新一轮先出', () => {
  const { room, list } = makeGame({ topCard: MONSTER('7'), tablePile: [MONSTER('4'), MONSTER('7'), ACTION('A')], current: 1 });
  const p1 = list[1];
  p1.hand = [MONSTER('4'), MONSTER('6')]; // 压不住 7，且无功能牌 → 无合法牌
  // 清掉 P0 的 A/2 与师兄弟，只留压不住 7 的牌
  const p0 = list[0];
  p0.hand = [MONSTER('4'), MONSTER('6')];
  const p2 = list[2];
  p2.hand = [MONSTER('4'), MONSTER('6')];
  // 足够 3 人补至 5 张的摸牌堆（每人需 3 张 = 9 张，多给几张）
  room.drawPile = [];
  for (let i = 0; i < 12; i++) room.drawPile.push(MONSTER('K'));

  const moves = computeLegalMoves(room, p1.id);
  assert.strictEqual(moves.beats.length, 0, 'P1 无牌可压');
  assert.strictEqual(moves.actions.length, 0, 'P1 无功能牌可出');
  const ret = pickUp(room, p1.id);

  assert.strictEqual(ret.action, 'pickedUp');
  assert.strictEqual(p1.penaltyPile.length, 3, '桌面3张全入败牌堆');
  assert.strictEqual(room.tablePile.length, 0, '桌面清空');
  assert.strictEqual(room.topCard, null);
  assert.strictEqual(room.currentPlayerId, p1.id, '收牌者新一轮先出');
  for (const p of [p0, p1, p2]) assert.strictEqual(p.hand.length, 5, '全员补至5张');
  // 收牌者可出任意牌（桌面为空）
  const first = p1.hand[0];
  playCard(room, p1.id, [first.id]);
  assert.ok(room.tablePile.length === 1);
});

test('收牌时摸牌堆为空 → 终局结算', () => {
  const { room, list } = makeGame({ topCard: MONSTER('7'), tablePile: [MONSTER('4'), MONSTER('7')], current: 1 });
  const p1 = list[1];
  p1.hand = [];
  room.drawPile = [];
  const ret = pickUp(room, p1.id);
  assert.strictEqual(ret.action, 'gameOver');
  assert.strictEqual(room.phase, 'settling');
  assert.ok(room.lastResult);
});

// ---- 终局结算 ----
test('结算：败牌最少者通杀，并列取座位最小', () => {
  const room = createRoom('R');
  const a = mkPlayer('A'); const b = mkPlayer('B'); const c = mkPlayer('C');
  [a, b, c].forEach((p) => addPlayer(room, p));
  a.penaltyPile = [MONSTER('4'), MONSTER('6')];
  b.penaltyPile = [MONSTER('4')];
  c.penaltyPile = [MONSTER('4')];
  settleGame(room);
  assert.strictEqual(room.phase, 'settling');
  assert.strictEqual(room.lastResult.winnerId, b.id, 'b=1张最少；c并列1张但座位号大');
  assert.strictEqual(room.lastResult.results.length, 3);
  assert.strictEqual(room.lastResult.results[0].name, 'B');
  assert.strictEqual(room.lastWinnerId, b.id);
});

test('nextRound：回 waiting，清手牌/败牌/桌面，保留 lastWinnerId', () => {
  const { room, list } = makeGame();
  settleGame(room);
  const winner = room.lastWinnerId;
  nextRound(room);
  assert.strictEqual(room.phase, 'waiting');
  for (const p of list) {
    assert.strictEqual(p.hand.length, 0);
    assert.strictEqual(p.penaltyPile.length, 0);
    assert.strictEqual(p.ready, false);
  }
  assert.strictEqual(room.lastWinnerId, winner);
  assert.strictEqual(room.tablePile.length, 0);
});

test('第二局先手：上局通杀者', () => {
  const room = createRoom('R');
  const a = mkPlayer('A'); const b = mkPlayer('B'); const c = mkPlayer('C');
  [a, b, c].forEach((p) => addPlayer(room, p));
  [a, b, c].forEach((p) => { p.ready = true; });
  a.penaltyPile = [MONSTER('4')];
  startGame(room);
  const first1 = room.currentPlayerId;
  // 人为结束第一局并确认 winner
  settleGame(room);
  const winner = room.lastWinnerId;
  nextRound(room);
  [a, b, c].forEach((p) => { p.ready = true; });
  startGame(room);
  assert.strictEqual(room.currentPlayerId, winner, '第二局由通杀者先出');
  assert.notStrictEqual(first1, null);
});

// ---- 空手轮空 ----
test('空手玩家轮空：resolveNext 跳过', () => {
  const { room, list } = makeGame({ topCard: MONSTER('4'), tablePile: [MONSTER('4')] });
  list[1].hand = [];
  const next = resolveNext(room, list[0].id);
  assert.strictEqual(next, list[2].id, '跳过空手的 P1，轮到 P2');
});

test('全场手牌空 → resolveNext 返回 null', () => {
  const { room, list } = makeGame({ topCard: MONSTER('4'), tablePile: [MONSTER('4')] });
  list.forEach((p) => { p.hand = []; });
  assert.strictEqual(resolveNext(room, list[0].id), null);
});

// ---- 托管 ----
test('autoPlay：有可压牌时打最小可压牌', () => {
  const { room, list } = makeGame({ topCard: MONSTER('4'), tablePile: [MONSTER('4')] });
  const p0 = list[0];
  const ret = autoPlay(room, p0.id);
  assert.strictEqual(ret.action, 'played');
  assert.strictEqual(room.topCard.rank, '6', 'P0 手中 4/6/A/2/3，可压的最小是 6');
});

test('autoPlay：无牌可压时优先出 A，其次 2，最后收牌', () => {
  const { room, list } = makeGame({ topCard: MONSTER('7'), tablePile: [MONSTER('4'), MONSTER('7')], current: 1 });
  const p1 = list[1];
  p1.hand = [ACTION('A'), ACTION('2')];
  const ret = autoPlay(room, p1.id);
  assert.strictEqual(ret.action, 'played');
  assert.strictEqual(room.topCard.rank, '7', 'A 不改变门槛');
  // 再轮到 P1（A 之后回到 P1？不——P0,P1,P2 顺时针，A 后轮到 P2）
  assert.strictEqual(room.currentPlayerId, list[2].id);
  // 构造纯收牌场景：P1 手牌压不住 7 且无功能牌，drawPile 留牌避免收牌即终局
  const { room: r2, list: l2 } = makeGame({ topCard: MONSTER('7'), tablePile: [MONSTER('4'), MONSTER('7')], current: 1 });
  l2.forEach((p) => { p.hand = []; });
  l2[1].hand = [MONSTER('4')]; // 压不住 7，且无功能牌
  r2.drawPile = [MONSTER('K')];
  const ret2 = autoPlay(r2, l2[1].id);
  assert.strictEqual(ret2.action, 'pickedUp', '无合法牌 → 收牌');
});

// ---- 房间 ----
test('addPlayer/removePlayer：座位重排、房主移交', () => {
  const room = createRoom('R');
  const a = mkPlayer('A'); const b = mkPlayer('B'); const c = mkPlayer('C');
  addPlayer(room, a);
  addPlayer(room, b);
  addPlayer(room, c);
  assert.strictEqual(room.ownerId, a.id);
  assert.strictEqual(a.seat, 0);
  assert.strictEqual(c.seat, 2);
  removePlayer(room, a.id);
  assert.strictEqual(room.ownerId, b.id, '房主移交');
  assert.strictEqual(b.seat, 0);
  assert.strictEqual(c.seat, 1, '座位重排');
});

test('setReady/allReady', () => {
  const room = createRoom('R');
  const a = mkPlayer('A'); const b = mkPlayer('B'); const c = mkPlayer('C');
  [a, b, c].forEach((p) => addPlayer(room, p));
  assert.strictEqual(allReady(room), false);
  [a, b, c].forEach((p) => setReady(room, p.id, true));
  assert.strictEqual(allReady(room), true);
  setReady(room, b.id, false);
  assert.strictEqual(allReady(room), false);
});

// ---- 多张组合出牌 ----
test('组合出牌：3 张同点小妖可用 3 张更大的同点妖怪压制', () => {
  const { room, list } = makeGame({ topCard: MONSTER('4'), tablePile: [MONSTER('4'), MONSTER('4'), MONSTER('4')] });
  room.topCount = 3;
  const p0 = list[0];
  p0.hand = [MONSTER('6'), MONSTER('6'), MONSTER('6'), MONSTER('4')];
  const sixes = p0.hand.filter((c) => c.rank === '6').map((c) => c.id);
  const ret = playCard(room, p0.id, sixes);
  assert.strictEqual(ret.action, 'played');
  assert.strictEqual(room.topCard.rank, '6');
  assert.strictEqual(room.topCount, 3, '组合门槛张数=3');
  assert.strictEqual(room.tablePile.length, 6, '桌面原3张 + 新出3张 = 6');
});

test('组合出牌：张数必须相等（2 张压不了 3 张门槛；补足 3 张后可压）', () => {
  const { room, list } = makeGame({ topCard: MONSTER('4'), tablePile: [MONSTER('4'), MONSTER('4'), MONSTER('4')] });
  room.topCount = 3;
  const p0 = list[0];
  p0.hand = [MONSTER('6'), MONSTER('6'), MONSTER('4'), MONSTER('7')];
  const two6 = p0.hand.filter((c) => c.rank === '6').map((c) => c.id);
  assert.throws(() => playCard(room, p0.id, two6), (e) => e.code === 'ILLEGAL_CARD', '2 张 6 压不了 3 张门槛');
  p0.hand.push(MONSTER('7'), MONSTER('7')); // 凑齐 3 张 7
  const three7 = p0.hand.filter((c) => c.rank === '7').map((c) => c.id);
  assert.strictEqual(three7.length, 3);
  const ret = playCard(room, p0.id, three7);
  assert.strictEqual(ret.action, 'played');
  assert.strictEqual(room.topCount, 3);
  assert.strictEqual(room.topCard.rank, '7');
});

test('组合出牌：跨组压制（3 张师兄弟压 3 张妖怪，3 张唐僧压 3 张师兄弟）', () => {
  const { room, list } = makeGame({ topCard: MONSTER('4'), tablePile: [MONSTER('4'), MONSTER('4'), MONSTER('4')] });
  room.topCount = 3;
  const p0 = list[0];
  p0.hand = [DISCIPLE('3'), DISCIPLE('3'), DISCIPLE('3')];
  const ret = playCard(room, p0.id, p0.hand.map((c) => c.id));
  assert.strictEqual(ret.action, 'played');
  assert.strictEqual(room.topCard.kind, 'disciple');

  const { room: r2, list: l2 } = makeGame({ topCard: DISCIPLE('3'), tablePile: [DISCIPLE('3'), DISCIPLE('3'), DISCIPLE('3')] });
  r2.topCount = 3;
  const p1 = l2[0];
  p1.hand = [MASTER(), MASTER(), MASTER()];
  playCard(r2, p1.id, p1.hand.map((c) => c.id));
  assert.strictEqual(r2.topCard.kind, 'master');
});

test('组合出牌：不同点数不可混出', () => {
  const { room, list } = makeGame(); // 桌面为空（开局）
  const p0 = list[0];
  p0.hand = [MONSTER('4'), MONSTER('4'), MONSTER('6')];
  assert.throws(() => playCard(room, p0.id, p0.hand.map((c) => c.id)), (e) => e.code === 'ILLEGAL_CARD');
});

test('组合出牌：开局可出 2~4 张同点组合', () => {
  const { room, list } = makeGame(); // 桌面为空
  const p0 = list[0];
  p0.hand = [MONSTER('6'), MONSTER('6'), MONSTER('4'), MONSTER('4')];
  const moves = computeLegalMoves(room, p0.id);
  assert.ok(moves.opening, '桌面为空 = 开局');
  const hasPair6 = moves.beats.some((g) => g.length === 2 && g.every((id) => p0.hand.find((c) => c.id === id).rank === '6'));
  assert.ok(hasPair6, '开局可出 2 张 6 组合');
});

test('autoPlay：门槛为 3 张组合时打出最小 3 张可压组合', () => {
  const { room, list } = makeGame({ topCard: MONSTER('4'), tablePile: [MONSTER('4'), MONSTER('4'), MONSTER('4')] });
  room.topCount = 3;
  const p0 = list[0];
  p0.hand = [MONSTER('6'), MONSTER('6'), MONSTER('6'), MONSTER('7'), MONSTER('7')];
  const ret = autoPlay(room, p0.id);
  assert.strictEqual(ret.action, 'played');
  assert.strictEqual(room.topCard.rank, '6', '托管打最小的 3 张 6（先于 3 张 7）');
  assert.strictEqual(room.topCount, 3);
});
