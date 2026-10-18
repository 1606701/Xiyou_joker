'use strict';

/**
 * lib/engine.js — 纯逻辑层：房间状态机、回合流转、收牌/补牌/终局/托管选择。
 * 不依赖 socket/I/O，房间对象在内存中直接变更，可单测。
 * 错误通过 throw new Error(msg) 并附带 err.code 表达，net 层负责转成客户端 error 事件。
 */

const { buildDeck, shuffle, canBeat, canBeatGroup, CARD_NAMES } = require('./cards');

// 展示/消耗顺序：用于「最小可压牌」等确定性选择（越靠前越优先消耗）
const DISPLAY_ORDER = {
  '4': 1, '6': 2, '7': 3, '9': 4, J: 5, Q: 6, K: 7,
  SJ: 8, BJ: 9, '3': 10, '8': 11, '5': 12, '10': 13, A: 14, '2': 15,
};

const MAX_EVENT_LOG = 20;
const HAND_SIZE = 5;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** 创建房间（初始空房间，phase=waiting） */
function createRoom(roomCode) {
  return {
    roomCode,
    phase: 'waiting',          // waiting | playing | settling
    ownerId: null,
    lastWinnerId: null,        // 上局通杀者（下局先手）
    roundNumber: 0,            // 当前/已完成局数
    players: [],               // [{ id, name, seat, ready, connected, hand, penaltyPile }]
    direction: 1,              // 1=seat 递增（顺时针）/ -1=递减
    currentPlayerId: null,
    topCard: null,             // 门槛牌（功能牌不改变它）
    topCount: 1,               // 当前门槛组合的张数（单张=1，组合 2~4）
    tablePile: [],             // 桌面已出牌（含功能牌），收牌时整体进败牌堆
    drawPile: [],
    eventLog: [],
    lastResult: null,          // 上局结算
  };
}

function getPlayer(room, pid) {
  const p = room.players.find((x) => x.id === pid);
  if (!p) throw err('PLAYER_NOT_FOUND', '玩家不存在');
  return p;
}

function seatOf(room, pid) {
  const i = room.players.findIndex((x) => x.id === pid);
  if (i < 0) throw err('PLAYER_NOT_FOUND', '玩家不存在');
  return i;
}

function playerCount(room) {
  return room.players.length;
}

function log(room, msg) {
  room.eventLog.push(msg);
  if (room.eventLog.length > MAX_EVENT_LOG) room.eventLog.shift();
}

/** 玩家加入（座位=加入顺序） */
function addPlayer(room, player) {
  if (room.phase !== 'waiting') throw err('GAME_RUNNING', '对局进行中，无法加入');
  if (playerCount(room) >= 6) throw err('ROOM_FULL', '房间已满（最多 6 人）');
  player.seat = playerCount(room);
  player.ready = false;
  player.connected = true;
  player.hand = [];
  player.penaltyPile = [];
  room.players.push(player);
  if (!room.ownerId) room.ownerId = player.id;
}

/** 玩家离开（waiting 阶段直接移除；playing 阶段由 net 层先标记掉线再决定） */
function removePlayer(room, pid) {
  const i = room.players.findIndex((x) => x.id === pid);
  if (i < 0) return;
  room.players.splice(i, 1);
  // 重排座位序号
  room.players.forEach((p, idx) => { p.seat = idx; });
  if (room.ownerId === pid) {
    room.ownerId = room.players.length ? room.players[0].id : null;
  }
}

/** 切换准备状态 */
function setReady(room, pid, ready) {
  if (room.phase !== 'waiting') throw err('BAD_PHASE', '对局已开始，不能改变准备状态');
  const p = getPlayer(room, pid);
  p.ready = !!ready;
}

function allReady(room) {
  return room.players.length >= 3 && room.players.every((p) => p.ready);
}

/** 开始游戏：发牌、确定先手（首局房主 / 之后上局通杀者） */
function startGame(room) {
  if (room.phase !== 'waiting') throw err('BAD_PHASE', '对局已在进行中');
  if (playerCount(room) < 3) throw err('NOT_ENOUGH', '至少需要 3 名玩家');
  if (playerCount(room) > 6) throw err('ROOM_FULL', '最多 6 名玩家');
  if (!allReady(room)) throw err('NOT_READY', '有玩家未准备');

  const deck = shuffle(buildDeck());
  room.players.forEach((p, i) => {
    p.hand = deck.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE);
    p.penaltyPile = [];
  });
  room.drawPile = deck.slice(playerCount(room) * HAND_SIZE);
  room.phase = 'playing';
  room.roundNumber += 1;
  room.direction = 1;
  room.topCard = null;
  room.topCount = 1;
  room.tablePile = [];
  room.eventLog = [];
  room.currentPlayerId =
    room.lastWinnerId && room.players.some((p) => p.id === room.lastWinnerId)
      ? room.lastWinnerId
      : room.ownerId;
  log(room, `第 ${room.roundNumber} 局开始，${room.players.find((p) => p.id === room.currentPlayerId).name} 先出`);
}

/**
 * 合法出牌集合：{ opening, beats[][], actions[] }
 * beats：可压制的牌组合（每组为同点牌的 id 数组；单张=1 张一组，组合=2~4 张一组）
 * actions：功能牌（A/2）单张 id
 * opening=true 时桌面为空（新一轮开局），任意单张或同点组合可出；功能牌始终可选。
 */
function computeLegalMoves(room, pid) {
  const p = getPlayer(room, pid);
  const opening = room.tablePile.length === 0;
  const top = opening ? null : { kind: room.topCard.kind, rank: room.topCard.rank, count: room.topCount || 1 };

  // 按点数分组（功能牌除外）
  const byRank = new Map();
  for (const c of p.hand) {
    if (c.kind === 'action') continue;
    if (!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank).push(c);
  }

  const beats = [];
  const sizes = opening ? [1, 2, 3, 4] : [top.count];
  for (const cards of byRank.values()) {
    const kind = cards[0].kind;
    for (const n of sizes) {
      if (cards.length < n) continue;
      if (canBeatGroup(top, { kind, rank: cards[0].rank, count: n })) {
        beats.push(cards.slice(0, n).map((c) => c.id));
      }
    }
  }

  const actions = p.hand.filter((c) => c.kind === 'action').map((c) => c.id);
  return { opening, beats, actions };
}

/** 按当前方向找下一个有手牌的玩家；找不到（全场手牌空）返回 null */
function resolveNext(room, fromId) {
  const n = playerCount(room);
  let i = seatOf(room, fromId);
  for (let step = 1; step <= n; step++) {
    i = (i + room.direction + n) % n;
    if (room.players[i].hand.length > 0) return room.players[i].id;
  }
  return null;
}

function cardDisplay(card) {
  const rankShow = { SJ: '小王', BJ: '大王' }[card.rank] || card.rank;
  const name = CARD_NAMES[card.rank] || rankShow;
  return `${rankShow}${card.suit || ''}·${name}`;
}

/**
 * 出牌（压制 或 功能牌 A/2）。
 * @param {string[]|string} cardIds 单张传 id 字符串，组合传同点 id 数组（2~4 张）
 */
function playCard(room, pid, cardIds) {
  if (room.phase !== 'playing') throw err('BAD_PHASE', '当前不在对局中');
  if (room.currentPlayerId !== pid) throw err('NOT_YOUR_TURN', '还没轮到您出牌');
  const p = getPlayer(room, pid);
  const ids = Array.isArray(cardIds) ? cardIds : [cardIds];
  if (ids.length === 0) throw err('ILLEGAL_CARD', '未选择要打出的牌');
  if (new Set(ids).size !== ids.length) throw err('ILLEGAL_CARD', '同一张牌不能重复打出');
  if (ids.length > 4) throw err('ILLEGAL_CARD', '一次最多出 4 张');

  const cards = [];
  for (const id of ids) {
    const c = p.hand.find((x) => x.id === id);
    if (!c) throw err('ILLEGAL_CARD', '手牌中没有这张牌');
    cards.push(c);
  }

  const moves = computeLegalMoves(room, pid);
  const first = cards[0];
  if (first.kind === 'action') {
    if (ids.length !== 1) throw err('ILLEGAL_CARD', '功能牌只能单张打出');
    if (!moves.actions.includes(first.id)) throw err('ILLEGAL_CARD', '这张牌不能压制当前门槛牌');
  } else {
    if (!cards.every((c) => c.rank === first.rank)) throw err('ILLEGAL_CARD', '多张出牌必须同点');
    const key = (arr) => arr.slice().sort().join('|');
    if (!moves.beats.some((g) => key(g) === key(ids))) {
      throw err('ILLEGAL_CARD', '这张牌不能压制当前门槛牌');
    }
  }

  for (const c of cards) p.hand.splice(p.hand.indexOf(c), 1);
  room.tablePile.push(...cards);
  const pname = p.name;

  if (first.kind === 'action') {
    if (first.rank === 'A') {
      // 跳过自己本次出牌：门槛不变，轮到下家
      log(room, `${pname} 打出【A·跳过自己本次】`);
    } else {
      // 2：反转方向，由新方向的上家（原下家）出牌
      room.direction *= -1;
      log(room, `${pname} 打出【2·反转】方向${room.direction === 1 ? '顺时针' : '逆时针'}`);
    }
  } else {
    room.topCard = first;
    room.topCount = ids.length;
    log(room, `${pname} 打出 ${cardDisplay(first)}${ids.length > 1 ? ` ×${ids.length}` : ''}${moves.opening ? '（新一轮任意出牌）' : ' 压制门槛'}`);
  }

  const nextId = resolveNext(room, pid);
  if (nextId === null) {
    settleGame(room);
    return { action: 'gameOver' };
  }
  room.currentPlayerId = nextId;
  return { action: 'played', nextPlayerId: nextId };
}

/** 收牌：桌面全部牌进败牌堆 → 摸牌堆空则终局 → 全员补牌至 5 张 → 收牌者重开新一轮 */
function pickUp(room, pid) {
  if (room.phase !== 'playing') throw err('BAD_PHASE', '当前不在对局中');
  if (room.currentPlayerId !== pid) throw err('NOT_YOUR_TURN', '还没轮到您');
  const p = getPlayer(room, pid);
  const moves = computeLegalMoves(room, pid);
  if (moves.beats.length > 0 || moves.actions.length > 0) {
    throw err('MUST_PLAY', '您还有可出的牌，不能收牌');
  }

  const count = room.tablePile.length;
  p.penaltyPile.push(...room.tablePile);
  log(room, `${p.name} 无法出牌，收走桌面 ${count} 张作为败牌（累计 ${p.penaltyPile.length} 张）`);
  room.tablePile = [];
  room.topCard = null;
  room.topCount = 1;

  // 终局：收牌时摸牌堆已空（无法补牌）
  if (room.drawPile.length === 0) {
    settleGame(room);
    return { action: 'gameOver' };
  }

  // 补牌：从收牌者起，按当前方向，逐个补至 5 张（摸牌堆空则停）
  const n = playerCount(room);
  let i = seatOf(room, pid);
  for (let step = 0; step < n && room.drawPile.length > 0; step++) {
    const idx = (i + room.direction * step + n * 2) % n;
    const player = room.players[idx];
    while (player.hand.length < HAND_SIZE && room.drawPile.length > 0) {
      player.hand.push(room.drawPile.pop());
    }
  }

  // 新一轮：收牌者先出（桌面为空，任意牌可出）
  room.currentPlayerId = pid;
  log(room, `${p.name} 成为新一轮先出牌者`);
  return { action: 'pickedUp', nextPlayerId: pid };
}

/** 终局结算：败牌最少者通杀，并列取座位号最小 */
function settleGame(room) {
  const sorted = [...room.players].sort(
    (a, b) => a.penaltyPile.length - b.penaltyPile.length || a.seat - b.seat
  );
  const winner = sorted[0];
  room.lastResult = {
    results: sorted.map((p) => ({ id: p.id, name: p.name, penaltyCount: p.penaltyPile.length })),
    winnerId: winner.id,
  };
  room.lastWinnerId = winner.id;
  room.phase = 'settling';
  room.currentPlayerId = null;
  log(room, `本局结束，通杀者：${winner.name}（败牌 ${winner.penaltyPile.length} 张）`);
}

/** 再来一局：回 waiting，保留座位，清空手牌/桌面/败牌，重置准备与方向 */
function nextRound(room) {
  if (room.phase !== 'settling') throw err('BAD_PHASE', '当前无法开始下一局');
  room.phase = 'waiting';
  room.players.forEach((p) => {
    p.hand = [];
    p.penaltyPile = [];
    p.ready = false;
  });
  room.topCard = null;
  room.topCount = 1;
  room.tablePile = [];
  room.drawPile = [];
  room.currentPlayerId = null;
  room.direction = 1;
  room.eventLog = [];
  // lastWinnerId 保留，供下一局 startGame 使用
  return { action: 'nextRound' };
}

/** 托管选择器：最小可压组合（牌面序数升序，同序数张数少者优先）→ A → 2 → 收牌 */
function autoPlay(room, pid) {
  const p = getPlayer(room, pid);
  const moves = computeLegalMoves(room, pid);

  if (moves.beats.length > 0) {
    const key = (ids) => {
      const c = p.hand.find((x) => x.id === ids[0]);
      return (DISPLAY_ORDER[c.rank] ?? 99) * 10 + ids.length;
    };
    let best = moves.beats[0];
    for (const g of moves.beats) if (key(g) < key(best)) best = g;
    return playCard(room, pid, best);
  }

  const a = p.hand.find((c) => c.rank === 'A');
  if (a) return playCard(room, pid, [a.id]);
  const t = p.hand.find((c) => c.rank === '2');
  if (t) return playCard(room, pid, [t.id]);
  return pickUp(room, pid);
}

module.exports = {
  createRoom,
  addPlayer,
  removePlayer,
  setReady,
  allReady,
  startGame,
  playCard,
  pickUp,
  nextRound,
  autoPlay,
  settleGame,
  getPlayer,
  computeLegalMoves,
  resolveNext,
  DISPLAY_ORDER,
  HAND_SIZE,
};
