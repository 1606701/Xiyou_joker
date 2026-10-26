'use strict';

/**
 * test/engine.soak.test.js — lib/engine.js 随机对局压力测试（QA 独立实现，固定 seed 可复现）。
 *
 * 目的：BUG-007 这类「状态机走错分叉」的缺陷，单条用例只能覆盖到作者想到的分支；
 * 随机上万步 + 每步校验 GDD 不变量，才能把它们成批捞出来。
 *
 * 覆盖：
 * - 随机 3~6 人局，随机合法出牌（含开轮打 A/2、组合出牌、无牌收牌），跑完再开下一局
 * - 每步校验：牌守恒（=54）、无重复牌 id、手牌上限 5、settling 时 currentPlayerId 必为 null
 * - 每局设步数上限，超即判定「死循环」并 fail（而不是靠 --test-timeout 超时才发现）
 *
 * 确定性：Math.random 被替换为 mulberry32(seed)，engine.shuffle 与本文件的选牌都取自同一流，
 * 因此「第几局、第几步、出了什么牌」完全可复现；失败时可用同一个 SEED 重跑。
 *
 * 不做的事：不引入真实 socket、不 mock 定时器（那是 test/net.*.test.js 的职责）。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const engine = require('../lib/engine.js');
const { buildDeck } = require('../lib/cards.js');

/** 固定 seed：任何一次失败都可原样重跑 */
const SEED = 20261026;
/** 局数（可经环境变量调小以加快本地调试，CI 默认 1000） */
const GAMES = Number(process.env.SOAK_GAMES || 1000);
/** 每局步数上限：超过即视为死循环 */
const MAX_STEPS_PER_GAME = 20000;
/** 每局打几轮（>1 时覆盖 nextRound → startGame 的二次开局路径） */
const ROUNDS_PER_GAME = 2;

const DECK_SIZE = buildDeck().length; // 54

/** mulberry32：小而稳的可复现 PRNG */
function mulberry32(a) {
  let t = a >>> 0;
  return function rng() {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const realRandom = Math.random;

test(`soak：${GAMES} 局随机对局 × ${ROUNDS_PER_GAME} 轮，逐步校验牌守恒/无重复/终局态/无死循环（seed=${SEED}）`, (t) => {
  const rng = mulberry32(SEED);
  Math.random = rng; // engine.shuffle 依赖 Math.random
  t.after(() => {
    Math.random = realRandom;
  });

  const stats = {
    games: 0,
    rounds: 0,
    steps: 0,
    maxGameSteps: 0,
    maxGameIndex: -1,
    picks: 0,
    comboPlays: 0,
    actionPlays: 0,
    /** 开轮（桌面无门槛牌且桌面无牌）时打出功能牌 —— 即 BUG-007 的触发路径 */
    actionLeadOnEmptyTable: 0,
    aLeadOnEmptyTable: 0,
    twoLeadOnEmptyTable: 0,
    /** 收牌后桌面清空、topCard 归零的重开次数 */
    tableCleared: 0,
  };

  /** 牌守恒 + 唯一性 + 形状校验 */
  function checkInvariants(room, where) {
    const zones = [
      ['drawPile', room.drawPile],
      ['tablePile', room.tablePile],
      ...room.players.map((p) => [`${p.name}.hand`, p.hand]),
      ...room.players.map((p) => [`${p.name}.penalty`, p.penaltyPile]),
    ];
    let total = 0;
    const seen = new Map();
    for (const [zone, cards] of zones) {
      assert.ok(Array.isArray(cards), `${where}：${zone} 不是数组`);
      total += cards.length;
      for (const c of cards) {
        assert.ok(c && typeof c.id === 'string' && c.id, `${where}：${zone} 出现无 id 的牌 ${JSON.stringify(c)}`);
        const prev = seen.get(c.id);
        assert.strictEqual(prev, undefined, `${where}：牌 ${c.id} 同时出现在 ${prev} 与 ${zone}（牌被复制）`);
        seen.set(c.id, zone);
      }
    }
    assert.strictEqual(total, DECK_SIZE, `${where}：牌守恒被破坏（期望 ${DECK_SIZE}，实际 ${total}）`);

    for (const p of room.players) {
      assert.ok(p.hand.length <= engine.HAND_SIZE, `${where}：${p.name} 手牌 ${p.hand.length} > ${engine.HAND_SIZE}`);
    }
    if (room.phase === 'settling') {
      assert.strictEqual(room.currentPlayerId, null, `${where}：settling 阶段 currentPlayerId 必须为 null`);
      assert.ok(room.lastResult && room.lastResult.winnerId, `${where}：settling 阶段必须有 lastResult.winnerId`);
      const winner = room.players.find((p) => p.id === room.lastResult.winnerId);
      assert.ok(winner, `${where}：通杀者必须是房间内的玩家`);
      const minPenalty = Math.min(...room.players.map((p) => p.penaltyPile.length));
      assert.strictEqual(
        winner.penaltyPile.length,
        minPenalty,
        `${where}：通杀者败牌数应为最少（${winner.penaltyPile.length} vs min ${minPenalty}）`
      );
    }
    if (room.phase === 'playing') {
      assert.ok(room.currentPlayerId, `${where}：playing 阶段必须有 currentPlayerId`);
      assert.ok(
        room.players.some((p) => p.id === room.currentPlayerId),
        `${where}：currentPlayerId 必须是房间内玩家`
      );
    }
  }

  /** 从合法动作里随机挑一个执行；返回本次动作类型 */
  function stepOnce(room) {
    const pid = room.currentPlayerId;
    const moves = engine.computeLegalMoves(room, pid);
    const options = [];
    for (const g of moves.beats) options.push({ kind: 'beat', ids: g });
    for (const a of moves.actions) options.push({ kind: 'action', ids: [a] });

    if (options.length === 0) {
      engine.pickUp(room, pid);
      stats.picks += 1;
      if (room.tablePile.length === 0) stats.tableCleared += 1;
      return 'pick';
    }

    const pick = options[Math.floor(rng() * options.length)];
    const openingBefore = moves.opening && room.tablePile.length === 0;
    const card = room.players.find((p) => p.id === pid).hand.find((c) => c.id === pick.ids[0]);
    if (pick.kind === 'action' && openingBefore) {
      stats.actionLeadOnEmptyTable += 1;
      if (card.rank === 'A') stats.aLeadOnEmptyTable += 1;
      if (card.rank === '2') stats.twoLeadOnEmptyTable += 1;
    }
    if (pick.kind === 'action') stats.actionPlays += 1;
    if (pick.ids.length > 1) stats.comboPlays += 1;

    engine.playCard(room, pid, pick.ids);
    if (room.tablePile.length === 0) stats.tableCleared += 1;
    return 'play';
  }

  for (let gi = 0; gi < GAMES; gi++) {
    // ---- 建局：随机 3~6 人 ----
    const n = 3 + Math.floor(rng() * 4); // 3..6
    const room = engine.createRoom(String(100 + (gi % 900)));
    for (let i = 0; i < n; i++) {
      engine.addPlayer(room, { id: `g${gi}p${i}`, name: `P${i}`, socketId: `s${gi}-${i}` });
    }
    for (const p of room.players) engine.setReady(room, p.id, true);

    let gameSteps = 0;
    for (let round = 0; round < ROUNDS_PER_GAME; round++) {
      if (round === 0) {
        engine.startGame(room);
      } else {
        // 上一轮已 settling → nextRound 回 waiting → 全员准备 → startGame
        engine.nextRound(room);
        assert.strictEqual(room.phase, 'waiting', `第 ${gi} 局第 ${round} 轮：nextRound 后应回 waiting`);
        for (const p of room.players) engine.setReady(room, p.id, true);
        engine.startGame(room);
      }
      stats.rounds += 1;
      assert.strictEqual(room.phase, 'playing', `第 ${gi} 局第 ${round} 轮：startGame 后应进入 playing`);
      checkInvariants(room, `第 ${gi} 局第 ${round} 轮开局`);

      let roundSteps = 0;
      while (room.phase === 'playing') {
        roundSteps += 1;
        gameSteps += 1;
        stats.steps += 1;
        assert.ok(
          roundSteps <= MAX_STEPS_PER_GAME,
          `第 ${gi} 局第 ${round} 轮超过 ${MAX_STEPS_PER_GAME} 步仍未结束 → 疑似死循环（seed=${SEED}）`
        );
        const where = `第 ${gi} 局第 ${round} 轮第 ${roundSteps} 步（${room.currentPlayerId}，topCard=${room.topCard ? room.topCard.rank : 'null'}，tablePile=${room.tablePile.length}）`;
        try {
          stepOnce(room);
        } catch (e) {
          // 把「哪一局、哪一步、什么局面」钉在失败信息里，否则 CI 上只看到一行 TypeError
          e.message = `${where} 抛出异常：${e.message}`;
          throw e;
        }
        checkInvariants(room, where);
      }
      assert.strictEqual(room.phase, 'settling', `第 ${gi} 局第 ${round} 轮应以 settling 结束`);
    }

    stats.games += 1;
    if (gameSteps > stats.maxGameSteps) {
      stats.maxGameSteps = gameSteps;
      stats.maxGameIndex = gi;
    }
  }

  t.diagnostic(
    `soak 完成：${stats.games} 局 / ${stats.rounds} 轮 / ${stats.steps} 步；` +
      `单局最多 ${stats.maxGameSteps} 步（第 ${stats.maxGameIndex} 局）`
  );
  t.diagnostic(
    `覆盖度：收牌 ${stats.picks} 次、组合出牌 ${stats.comboPlays} 次、功能牌出牌 ${stats.actionPlays} 次、` +
      `其中「开轮打功能牌」${stats.actionLeadOnEmptyTable} 次（A ${stats.aLeadOnEmptyTable} / 2 ${stats.twoLeadOnEmptyTable}）`
  );

  // 覆盖度断言：确保这一轮 soak 真的走到了 BUG-007 的分支（否则「没炸」不能说明问题）
  assert.ok(stats.games === GAMES, `应跑满 ${GAMES} 局（实际 ${stats.games}）`);
  assert.ok(stats.steps > GAMES * 10, `总步数偏少（${stats.steps}），随机性可能失效`);
  assert.ok(
    stats.actionLeadOnEmptyTable > 0,
    '本轮 soak 从未触发「开轮打功能牌」——BUG-007 的分支未被覆盖，soak 结论不可信'
  );
  assert.ok(stats.comboPlays > 0, '本轮 soak 从未出现组合出牌，覆盖不足');
  assert.ok(stats.picks > 0, '本轮 soak 从未出现收牌，覆盖不足');
});
