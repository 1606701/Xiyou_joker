'use strict';

/**
 * lib/cards.js — 纯函数层：牌定义、组内序数、环形克制判定 canBeat、洗牌、发牌。
 * 不依赖任何 I/O 或 socket，可单测。
 */

// 妖怪牌内部大小序数（4 < 6 < 7 < 9 < J < Q < K < 小王 < 大王）
const MONSTER_ORDER = { 4: 1, 6: 2, 7: 3, 9: 4, J: 5, Q: 6, K: 7, SJ: 8, BJ: 9 };

// 师兄弟内部大小序数（3沙僧 < 8八戒 < 5悟空）
const DISCIPLE_ORDER = { 3: 1, 8: 2, 5: 3 };

// 环形克制矩阵：card.kind 可以压制 top.kind
// monster(妖怪) → master(唐僧10) → disciple(师兄弟) → monster(妖怪)
const BEAT = { monster: 'master', master: 'disciple', disciple: 'monster' };

const SUITS = ['♠', '♥', '♣', '♦'];

// 牌面对应的西游名称（展示用）：
// 角色牌：3沙僧 < 8八戒 < 5悟空，10唐僧；妖怪牌按强弱命名；功能牌显示效果名
const CARD_NAMES = {
  '3': '沙僧',
  '5': '孙悟空',
  '8': '八戒',
  '10': '唐僧',
  '4': '小妖',
  '6': '黑熊精',
  '7': '黄风怪',
  '9': '白骨精',
  J: '红孩儿',
  Q: '牛魔王',
  K: '青牛精',
  SJ: '六耳猕猴',
  BJ: '金翅大鹏',
  A: '跳过',
  '2': '反转',
};

/**
 * 构建一副标准 54 张牌。
 * 妖怪牌：4/6/7/9/J/Q/K ×4 + 小王×1 + 大王×1 = 30
 * 师兄弟牌：3/8/5 ×4 = 12
 * 唐僧牌：10 ×4 = 4
 * 功能牌：A/2 ×4 = 8
 * @returns {Array<{id:string, rank:string, suit:string, kind:string}>}
 */
function buildDeck() {
  const deck = [];
  let n = 0;
  const push = (rank, suit, kind) => deck.push({ id: `${rank}_${suit}_${n++}`, rank, suit, kind });

  for (const rank of ['4', '6', '7', '9', 'J', 'Q', 'K']) {
    for (const suit of SUITS) push(rank, suit, 'monster');
  }
  push('SJ', '', 'monster'); // 小王
  push('BJ', '', 'monster'); // 大王

  for (const rank of ['3', '8', '5']) {
    for (const suit of SUITS) push(rank, suit, 'disciple');
  }
  for (const suit of SUITS) push('10', suit, 'master');
  for (const suit of SUITS) push('A', suit, 'action');
  for (const suit of SUITS) push('2', suit, 'action');

  if (deck.length !== 54) throw new Error(`buildDeck: 期望 54 张，实际 ${deck.length}`);
  return deck;
}

/**
 * Fisher-Yates 洗牌（原地）。
 * @param {Array} deck
 * @returns {Array} 打乱后的数组
 */
function shuffle(deck) {
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 环形克制判定：card 能否压制 top。
 * - 空门槛（新一轮开局桌面为空）任意可出
 * - 功能牌（A/2）不参与压制链
 * - 同组牌内严格更大才可压
 * - 跨组查克制矩阵 BEAT
 * @param {object|null} top 门槛牌（桌面最后一张参与压制的牌）
 * @param {object} card 要打出的牌
 * @returns {boolean}
 */
function canBeat(top, card) {
  if (!top) return true;
  if (top.kind === 'action' || card.kind === 'action') return false;

  if (top.kind === card.kind) {
    if (top.kind === 'monster') return MONSTER_ORDER[card.rank] > MONSTER_ORDER[top.rank];
    if (top.kind === 'disciple') return DISCIPLE_ORDER[card.rank] > DISCIPLE_ORDER[top.rank];
    return false; // master 只有 10，同值不可压
  }
  return BEAT[card.kind] === top.kind;
}

/**
 * 组合克制判定（多张同点出牌）：
 * 出 N 张同点牌（N=2~4）须用 N 张同点且能单张压制的牌来压制（张数必须相等）。
 * - top=null 表示新一轮开局，任意单张或同点组合均可出
 * - 功能牌（A/2）不参与压制链
 * @param {object|null} top { kind, rank, count }
 * @param {object} combo { kind, rank, count }
 * @returns {boolean}
 */
function canBeatGroup(top, combo) {
  if (!top) return true;
  if (top.kind === 'action' || combo.kind === 'action') return false;
  if (top.count !== combo.count) return false;
  return canBeat({ kind: top.kind, rank: top.rank }, { kind: combo.kind, rank: combo.rank });
}

module.exports = { buildDeck, shuffle, canBeat, canBeatGroup, MONSTER_ORDER, DISCIPLE_ORDER, BEAT, CARD_NAMES };
