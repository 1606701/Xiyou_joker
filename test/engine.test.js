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

test('行为变更（W3-ENG-RULE01）：摸牌堆空 + 收牌 → 必须 pickedUp（不再因此终局），且补不了牌', () => {
  const { room, list } = makeGame({ topCard: MONSTER('7'), tablePile: [MONSTER('4'), MONSTER('7')], current: 1 });
  const [p0, p1, p2] = list;
  p1.hand = [MONSTER('4'), MONSTER('6')]; // 压不住 7、无 A/2 → 只能收牌，但手里还有牌
  p0.hand = [MONSTER('4')];
  p2.hand = [MONSTER('6')];
  room.drawPile = [];
  const handBefore = p1.hand.length;

  const ret = pickUp(room, p1.id);

  assert.strictEqual(ret.action, 'pickedUp', '摸牌堆空只是「补不了牌」，不是终局（正面钉住这条行为变更）');
  assert.strictEqual(room.phase, 'playing', '对局必须继续，直到只剩一人有牌');
  assert.strictEqual(room.currentPlayerId, p1.id, '收牌者重开新一轮先出');
  assert.strictEqual(p1.hand.length, handBefore, '摸牌堆空 → 一张也补不到，手牌不变');
  assert.strictEqual(p1.penaltyPile.length, 2, '桌面 2 张仍计入收牌者败牌');

  // 对局真的还能继续：收牌者出一张，回合正常交出去
  const played = p1.hand[0];
  const r2 = playCard(room, p1.id, [played.id]);
  assert.strictEqual(r2.action, 'played', '摸牌堆空之后仍能正常出牌');
  assert.strictEqual(room.currentPlayerId, p2.id);
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
  // 构造纯收牌场景：P1 手牌压不住 7 且无功能牌。
  // 注意（W3-ENG-RULE01）：还必须让 P0/P2 手里留牌，否则「只剩一人有牌」会立刻终局，
  // 测不到「无合法牌 → 收牌」这条分支本身。
  const { room: r2, list: l2 } = makeGame({ topCard: MONSTER('7'), tablePile: [MONSTER('4'), MONSTER('7')], current: 1 });
  l2.forEach((p) => { p.hand = []; });
  l2[0].hand = [MONSTER('K')];
  l2[1].hand = [MONSTER('4')]; // 压不住 7，且无功能牌
  l2[2].hand = [MONSTER('K')];
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

// ---- BUG-007：功能牌开轮（topCard=null 但 tablePile 非空）----
// computeLegalMoves 曾用 tablePile.length === 0 判定开轮，开轮打出 A/2 后
// topCard 仍为 null → 访问 room.topCard.kind 抛 TypeError → 整桌卡死。

test('BUG-007：开轮打出 A 后，下家 computeLegalMoves 不抛异常且 opening=true', () => {
  const { room, list } = makeGame(); // 桌面为空 = 开轮
  const a = list[0].hand.find((c) => c.rank === 'A');
  playCard(room, list[0].id, [a.id]);

  assert.strictEqual(room.topCard, null, 'A 不设置门槛牌');
  assert.strictEqual(room.tablePile.length, 1, 'A 仍留在桌面');
  const nextId = room.currentPlayerId;
  assert.strictEqual(nextId, list[1].id, 'A 不改变方向，轮到下家');

  assert.doesNotThrow(() => computeLegalMoves(room, nextId), '开轮打 A 后不得抛 TypeError');
  const moves = computeLegalMoves(room, nextId);
  assert.strictEqual(moves.opening, true, '无门槛牌 → 仍是开轮，可任意出牌');
  assert.ok(moves.beats.length > 0, '下家任意单张可出');
});

test('BUG-007：开轮打出 2 → 方向反转，下家仍为 opening（topCard 保持 null）', () => {
  const { room, list } = makeGame();
  const two = list[0].hand.find((c) => c.rank === '2');
  playCard(room, list[0].id, [two.id]);

  assert.strictEqual(room.direction, -1, '2 反转方向');
  assert.strictEqual(room.topCard, null, '2 不设置门槛牌');
  assert.strictEqual(room.currentPlayerId, list[2].id, '反转后由原上家（seat 2）接续');
  assert.doesNotThrow(() => computeLegalMoves(room, list[2].id));
  assert.strictEqual(computeLegalMoves(room, list[2].id).opening, true);
});

test('BUG-007：连续两个 2 回到原方向，topCard 仍为 null 且仍是开轮', () => {
  const { room, list } = makeGame();
  const two1 = list[0].hand.find((c) => c.rank === '2');
  playCard(room, list[0].id, [two1.id]);
  assert.strictEqual(room.currentPlayerId, list[2].id);

  list[2].hand.push(ACTION('2'));
  const two2 = list[2].hand.find((c) => c.rank === '2');
  playCard(room, list[2].id, [two2.id]);

  assert.strictEqual(room.direction, 1, '连续两个 2 回到原方向');
  assert.strictEqual(room.topCard, null, '2 始终不设置门槛牌');
  assert.strictEqual(room.tablePile.length, 2, '两张 2 都留在桌面');
  assert.strictEqual(room.currentPlayerId, list[0].id, '再次反转后回到 seat 0');
  assert.strictEqual(computeLegalMoves(room, list[0].id).opening, true);
});

test('BUG-007：功能牌开轮后，有牌可出的玩家收牌仍抛 MUST_PLAY（不得误判为可收）', () => {
  const { room, list } = makeGame();
  const a = list[0].hand.find((c) => c.rank === 'A');
  playCard(room, list[0].id, [a.id]);

  // 下家手上有 4/6/5/10，无门槛 → 都能出，因此不允许收牌
  assert.throws(() => pickUp(room, list[1].id), (e) => e.code === 'MUST_PLAY');
  assert.strictEqual(room.tablePile.length, 1, '被拒后桌面不变');
});

test('BUG-007：开轮打出的 A 留在桌面，下一次收牌时进入败牌堆', () => {
  const { room, list } = makeGame();
  const a = list[0].hand.find((c) => c.rank === 'A');
  playCard(room, list[0].id, [a.id]);
  assert.ok(room.tablePile.some((c) => c.id === a.id), 'A 在桌面上');

  const p1 = list[1];
  p1.hand = []; // 无牌可出
  room.drawPile = [MONSTER('K'), MONSTER('K'), MONSTER('K')];
  const ret = pickUp(room, p1.id);

  assert.strictEqual(ret.action, 'pickedUp');
  assert.ok(p1.penaltyPile.some((c) => c.id === a.id), '桌面上的 A 计入收牌者败牌堆');
  assert.strictEqual(p1.penaltyPile.length, 1);
  assert.strictEqual(room.tablePile.length, 0, '桌面清空');
  assert.strictEqual(room.topCard, null);
  assert.strictEqual(room.currentPlayerId, p1.id, '收牌者成为新一轮先出者');
});

/* ============================================================
 * W3-ENG-RULE01：终局改为「只剩一人手里有牌」，余牌全部计入败牌
 *
 * 产品规则原话：「最后手里还剩余牌的时候余下的玩家是需要继续打的，直到打到只剩下
 * 一个人手里有牌，手里的牌也要计入失败牌数」。
 * 两条落点：playCard 尾部 与 pickUp 补牌之后，都必须在 resolveNext 之前先看 holders。
 * ============================================================ */

const holdersOf = (room) => room.players.filter((p) => p.hand.length > 0);

/**
 * 造一个「桌面已清空、当前玩家可任意出牌」的残局：手牌完全由调用方指定（第 0 位为当前玩家）。
 * 直接绕开 startGame 的发牌，才能把「谁手里还剩几张」钉死成确定性局面。
 */
function makeEndgameSeats(hands) {
  const room = createRoom('END');
  const list = hands.map((_, i) => mkPlayer(`E${i}`));
  list.forEach((p) => addPlayer(room, p));
  room.phase = 'playing';
  room.direction = 1;
  room.topCard = null;
  room.topCount = 1;
  room.tablePile = [];
  room.currentPlayerId = list[0].id;
  list.forEach((p, i) => { p.hand = hands[i].slice(); });
  return { room, list };
}

test('新终局规则：3 人局 A 出完不终局；B 出完（只剩 C 有牌）才终局，C 的手牌全部计入败牌', () => {
  const { room, list } = makeEndgameSeats([
    [MONSTER('4')],
    [MONSTER('6')],
    [MONSTER('7'), MONSTER('9')],
  ]);
  const [a, b, c] = list;

  const r1 = playCard(room, a.id, [a.hand[0].id]);
  assert.strictEqual(r1.action, 'played', 'A 出完了，但 B/C 还有牌 → 不得终局');
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(room.currentPlayerId, b.id, '回合正常交给下一位有牌的人');
  assert.deepStrictEqual(holdersOf(room).map((p) => p.id), [b.id, c.id], '此时仍有 2 人手上有牌');

  const r2 = playCard(room, b.id, [b.hand[0].id]);
  assert.strictEqual(r2.action, 'gameOver', 'B 出完 → 只剩 C 有牌 → 立即终局');
  assert.strictEqual(room.phase, 'settling');
  assert.strictEqual(c.hand.length, 0, 'C 剩余手牌必须被转出');
  assert.strictEqual(c.penaltyPile.length, 2, '转移数量 === 转移前手牌数（2 张）');
  assert.strictEqual(room.currentPlayerId, null, '终局后不得再有 currentPlayerId');
  assert.strictEqual(holdersOf(room).length, 0, '终局后全场手牌皆空');
  assert.strictEqual(
    room.lastResult.results.find((r) => r.id === c.id).penaltyCount,
    2,
    'penaltyCount 语义不变：手牌并入 penaltyPile 后自然体现（未新增字段）'
  );
});

test('新终局规则：2 人局 A 出完立即终局，B 从未出过的手牌也全部计入败牌（增量精确）', () => {
  const { room, list } = makeEndgameSeats([
    [MONSTER('4')],
    [MONSTER('6'), MONSTER('7'), MONSTER('K')],
  ]);
  const [a, b] = list;
  b.penaltyPile = [MONSTER('9')]; // B 之前已有 1 张败牌，用来验证「增量」而不是「覆盖」
  const pileBefore = b.penaltyPile.length;
  const handBefore = b.hand.length;

  const ret = playCard(room, a.id, [a.hand[0].id]);

  assert.strictEqual(ret.action, 'gameOver', '2 人局 A 出完 → 只剩 B 有牌 → 立即终局');
  assert.strictEqual(room.phase, 'settling');
  assert.strictEqual(b.hand.length, 0, '转移后 hand 必须清空');
  assert.strictEqual(b.penaltyPile.length, pileBefore + handBefore, 'penaltyPile 增量 === 转移前 hand.length');
  assert.strictEqual(b.penaltyPile.filter((x) => x.rank === 'K').length, 1, '原来是手牌的那张 K 现在在败牌堆里');
  assert.ok(
    room.eventLog.some((m) => m.includes('手里剩 3 张') && m.includes('全部计入败牌')),
    `事件日志必须写清「剩 N 张全部计入败牌」（实际日志：${JSON.stringify(room.eventLog)}）`
  );
});

test('新终局规则：收牌补牌后只剩收牌者有牌 → 也立刻终局（判定不能只加在 playCard）', () => {
  const { room, list } = makeEndgameSeats([[MONSTER('4'), MONSTER('6')], [], []]);
  const [p0] = list;
  room.topCard = MONSTER('7');
  room.topCount = 1;
  room.tablePile = [MONSTER('7')];
  room.drawPile = []; // 补不了牌
  assert.strictEqual(holdersOf(room).length, 1, '前置：只剩收牌者手里有牌');

  const ret = pickUp(room, p0.id);

  assert.strictEqual(ret.action, 'gameOver', 'pickUp 之后也必须做同一判定');
  assert.strictEqual(room.phase, 'settling');
  assert.strictEqual(p0.hand.length, 0);
  assert.strictEqual(p0.penaltyPile.length, 3, '桌面 1 张 + 手牌 2 张 = 3');
  assert.strictEqual(room.currentPlayerId, null);
});

test('兜底：出牌后全场手牌皆空（holders=0）→ 结算，且不做手牌转移', () => {
  const { room, list } = makeEndgameSeats([[MONSTER('4')], [], []]);
  const [p0] = list;

  const ret = playCard(room, p0.id, [p0.hand[0].id]);

  assert.strictEqual(ret.action, 'gameOver');
  assert.strictEqual(room.phase, 'settling');
  assert.strictEqual(room.tablePile.length, 1, '打出的牌留在桌面（不并入任何人败牌堆）');
  for (const p of room.players) assert.strictEqual(p.penaltyPile.length, 0, '兜底路径不得凭空产生败牌');
  assert.ok(room.lastResult, '兜底路径同样要产出 lastResult');
});

test('兜底：全场手牌皆空时收牌不抛错（无手牌可转移，桌面仍进败牌堆）', () => {
  const { room, list } = makeEndgameSeats([[], [], []]);
  const [p0] = list;
  room.topCard = MONSTER('7');
  room.topCount = 1;
  room.tablePile = [MONSTER('4'), MONSTER('7')];
  room.drawPile = [];

  let ret;
  assert.doesNotThrow(() => { ret = pickUp(room, p0.id); }, 'holders=0 时收牌不得抛错');

  assert.strictEqual(ret.action, 'gameOver');
  assert.strictEqual(room.phase, 'settling');
  assert.strictEqual(p0.penaltyPile.length, 2, '桌面 2 张仍计入收牌者败牌堆');
  assert.strictEqual(room.currentPlayerId, null);
});

test('P3-1 加固：补牌之前就判终局 —— holders===1 且摸牌堆非空时，不得把已出完的人「复活」', () => {
  // 悬崖场景：只剩收牌者有牌，但摸牌堆还没空。若先补牌再判终局，
  // 已出完的人会被补回手牌 → holders 变多 → 终局被静默跳过，且不报任何错。
  const { room, list } = makeEndgameSeats([[MONSTER('4'), MONSTER('6')], [], []]);
  const [p0, p1, p2] = list;
  room.topCard = MONSTER('K');
  room.topCount = 1;
  room.tablePile = [MONSTER('K')];
  room.drawPile = [MONSTER('K'), MONSTER('K'), MONSTER('K')]; // 关键：摸牌堆还有牌
  assert.strictEqual(holdersOf(room).length, 1, '前置：只剩收牌者手里有牌');
  const drawBefore = room.drawPile.length;

  const ret = pickUp(room, p0.id);

  assert.strictEqual(ret.action, 'gameOver', '补牌前必须已经终局（否则 p1/p2 会被补回手牌）');
  assert.strictEqual(room.phase, 'settling');
  assert.strictEqual(p0.hand.length, 0);
  assert.strictEqual(p0.penaltyPile.length, 3, '桌面 1 张 + 手牌 2 张 = 3');
  assert.strictEqual(p1.hand.length, 0, 'p1 不得被补牌「复活」');
  assert.strictEqual(p2.hand.length, 0, 'p2 不得被补牌「复活」');
  assert.strictEqual(room.drawPile.length, drawBefore, '终局判定在补牌之前 → 摸牌堆不得被消耗');
});

test('P3-2 加固：收牌者收牌后若 0 手牌，回合交给下一个有牌的人（不得原地空转）', () => {
  // 悬崖场景：收牌者本来就没手牌（正常流程不可达）。若无条件 currentPlayerId = pid，
  // 他会立刻再「无牌可出 → 收牌」一次，而桌面已空 → 局面完全重复、原地空转。
  const { room, list } = makeEndgameSeats([[], [MONSTER('4')], [MONSTER('6')]]);
  const [p0, p1] = list;
  room.topCard = MONSTER('K');
  room.topCount = 1;
  room.tablePile = [MONSTER('K')];
  room.drawPile = []; // 补不了牌 → p0 收完还是 0 手牌
  assert.strictEqual(p0.hand.length, 0, '前置：收牌者 0 手牌');

  const ret = pickUp(room, p0.id);

  assert.strictEqual(ret.action, 'pickedUp', '仍有 2 人有牌 → 不终局');
  assert.strictEqual(ret.nextPlayerId, p1.id, '回合必须交给下一个有牌的人');
  assert.strictEqual(room.currentPlayerId, p1.id, 'currentPlayerId 不得指向 0 手牌的收牌者');
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(p0.penaltyPile.length, 1, '桌面 1 张仍计入收牌者败牌');
  assert.notStrictEqual(room.currentPlayerId, p0.id, '把回合还给 0 手牌玩家 = 原地空转');
});

test('新终局规则：终局后任何玩家都不能再出牌/收牌（不残留回合）', () => {
  const { room, list } = makeEndgameSeats([[MONSTER('4')], [MONSTER('6')]]);
  const [a, b] = list;
  playCard(room, a.id, [a.hand[0].id]);
  assert.strictEqual(room.phase, 'settling');

  for (const p of room.players) {
    assert.throws(() => playCard(room, p.id, ['whatever']), (e) => e.code === 'BAD_PHASE', `${p.name} 终局后不得出牌`);
    assert.throws(() => pickUp(room, p.id), (e) => e.code === 'BAD_PHASE', `${p.name} 终局后不得收牌`);
  }
  assert.strictEqual(room.currentPlayerId, null);
});

