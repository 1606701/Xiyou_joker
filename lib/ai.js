'use strict';

/**
 * lib/ai.js — AI 补位策略（纯逻辑层：不 require net、不做 I/O、不修改房间状态）
 *
 * 职责边界：**只做决策，不执行**。返回「想干什么」，由 net 层去调 engine.playCard / engine.pickUp。
 * 合法性在执行时会被引擎再校验一次（双保险）：即便策略与规则出现漂移，也只会得到一次 err.code，
 * 而不会把房间推进到非法状态。因此本模块**不自己重算组合**，返回的 cardIds 一律直接取自
 * engine.computeLegalMoves() 的 beats / actions —— 保证「策略输出 ⊆ 引擎认可」是结构性成立的，
 * 而不是靠两边各写一遍逻辑碰巧一致。
 *
 * 决策优先级（自上而下，第一条命中即返回）：
 *
 *   1. 无牌可出（beats 与 actions 皆空）→ 收牌。
 *
 *   2. 开轮（moves.opening === true，即桌面没有门槛牌）：
 *      2a. beats 非空 → 取**张数最多**的同点组；张数相同则取 DISPLAY_ORDER 最小的组。
 *          理由：组合只能被「同张数、更高点」压住（lib/cards.js canBeatGroup: top.count !== combo.count
 *          直接 false），所以开轮打 4 张同点几乎全场无人能压，下家只能收堆 —— 这是全场最强的
 *          开局动作，也是唯一能把「开轮任意出牌权」真正变现的方式。
 *      2b. beats 为空（手里只剩功能牌）→ 打 DISPLAY_ORDER 最小的功能牌。
 *          注：功能牌不设门槛（不写 topCard），开轮打 A/2 等于把「随便出」的机会白送给下家，
 *          所以只在没有实体牌可出时才用，且用消耗序最靠前的那张。
 *
 *   3. 跟牌（有门槛牌）：
 *      3a. beats 非空 → 取 DISPLAY_ORDER 最小的组。
 *          组张数恒等于 topCount（computeLegalMoves 跟牌时 sizes=[top.count]），
 *          所以这里无需比较长度，只需比较消耗顺序（越靠前越先扔掉小牌）。
 *      3b. beats 为空、actions 非空 → 按桌面牌堆深度 pile = room.tablePile.length 分流：
 *          - pile >= 3 且手里有 2 → 打 2。2 不设门槛但**反转方向**：反向后下一个行动者是
 *            刚设门槛的上家，他必须压自己打出的牌，压不住就吃下整堆（含他自己刚打出的牌）。
 *            堆越深，这一手越赚。
 *          - 否则有 A → 打 A。A 跳过自己本次、门槛原样交给下家，风险低；同时把 2 留作逃生牌
 *            （下次遇到深堆还能用）。
 *          - 只剩一种功能牌就出那种。
 *
 *   4. 兜底：理论上到不了（1~3 已覆盖 moves 非空的所有情况），保险起见仍返回 moves 里最小的
 *      功能牌，绝不允许返回空 cardIds（空数组会被 playCard 判 ILLEGAL_CARD）。
 */

const engine = require('./engine');

/** AI 默认昵称池（优先取未被房间占用的那个，避免和真人重名） */
const AI_NAMES = ['悟能', '悟净', '白龙', '金角', '银角', '牛魔'];

/** 消耗优先序：数值越小越先打出（沿用 engine.DISPLAY_ORDER，未收录的牌排最后） */
function orderOf(rank) {
  const o = engine.DISPLAY_ORDER[rank];
  return o == null ? 99 : o;
}

/**
 * 给一个「同点组」打分：{ size 张数, order 消耗序 }。
 * @param {string[]} group 同点牌的 id 数组
 * @param {Map<string, object>} byId 手牌 id -> card
 */
function groupStat(group, byId) {
  let order = 99;
  for (const id of group) {
    const c = byId.get(id);
    const o = orderOf(c ? c.rank : undefined);
    if (o < order) order = o;
  }
  return { size: group.length, order };
}

/**
 * 选出功能牌里消耗序最小的那张（actions 只含 A/2，A=14 < 2=15）。
 * @param {string[]} actions engine.computeLegalMoves().actions（非空）
 * @param {Map<string, object>} byId
 */
function cheapestAction(actions, byId) {
  let best = actions[0];
  for (const id of actions) {
    const c = byId.get(id);
    if (orderOf(c ? c.rank : undefined) < orderOf((byId.get(best) || {}).rank)) best = id;
  }
  return best;
}

/**
 * AI 决策。
 * @param {object} room 房间（lib/engine.js createRoom 的形状）
 * @param {string} pid AI 玩家 id
 * @returns {{type:'play', cardIds:string[]} | {type:'pickup'}}
 */
function chooseMove(room, pid) {
  const player = engine.getPlayer(room, pid);
  const moves = engine.computeLegalMoves(room, pid);
  const byId = new Map(player.hand.map((c) => [c.id, c]));

  const hasBeat = moves.beats.length > 0;
  const hasAction = moves.actions.length > 0;

  // 1. 无牌可出 → 收牌
  if (!hasBeat && !hasAction) return { type: 'pickup' };

  // 2. 开轮
  if (moves.opening) {
    if (hasBeat) {
      let best = moves.beats[0];
      let bestStat = groupStat(best, byId);
      for (const g of moves.beats) {
        const st = groupStat(g, byId);
        if (st.size > bestStat.size || (st.size === bestStat.size && st.order < bestStat.order)) {
          best = g;
          bestStat = st;
        }
      }
      return { type: 'play', cardIds: best.slice() };
    }
    // 2b. 只剩功能牌
    return { type: 'play', cardIds: [cheapestAction(moves.actions, byId)] };
  }

  // 3a. 跟牌：有可压组合 → 消耗序最小的组
  if (hasBeat) {
    let best = moves.beats[0];
    let bestOrder = groupStat(best, byId).order;
    for (const g of moves.beats) {
      const o = groupStat(g, byId).order;
      if (o < bestOrder) {
        best = g;
        bestOrder = o;
      }
    }
    return { type: 'play', cardIds: best.slice() };
  }

  // 3b. 跟牌：只有功能牌
  const twoId = moves.actions.find((id) => (byId.get(id) || {}).rank === '2');
  const aceId = moves.actions.find((id) => (byId.get(id) || {}).rank === 'A');
  const pile = room.tablePile.length;
  if (pile >= 3 && twoId) return { type: 'play', cardIds: [twoId] };
  if (aceId) return { type: 'play', cardIds: [aceId] };
  if (twoId) return { type: 'play', cardIds: [twoId] };

  // 4. 兜底（理论不可达）
  return { type: 'play', cardIds: [cheapestAction(moves.actions, byId)] };
}

module.exports = { chooseMove, AI_NAMES };
