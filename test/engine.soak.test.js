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

const DECK_SIZE = buildDeck().length; // 54

/**
 * 每轮动作数上界 —— **派生量，不是魔数**（W3-ENG-RULE01 后的解析上界）：
 *
 *   出牌 ≤ DECK_SIZE：一张牌离开手牌后永不回到手牌（出牌 → tablePile → penaltyPile），
 *     54 张牌各只可能离开手牌一次。
 *   收牌 ≤ 出牌 + 1：收牌后桌面必空、收牌者成为开轮者，而开轮时任何手牌都合法
 *     （功能牌也能单张出），且回合只会交给「手里有牌的人」⇒ 两次收牌之间至少有一次出牌。
 *   两者不会同时取满：若收牌 = 出牌 + 1，说明最后一手是收牌，此时已无牌可出，
 *     即出牌 ≤ DECK_SIZE - 1（最后那张牌若被打出，holders 归零当场结算，不会再有人收牌）。
 *
 * ⇒ 单轮动作 ≤ DECK_SIZE * 2 = 108。超过它说明「牌在哪儿」出了问题
 * （牌被复制 / 手牌没扣减 / 回合空转），而不是运气不好。
 * 实测（本套件 2 种策略 × 2 种人数 × 30 局固定 seed）最大 76，余量 1.42×
 * （first 67/70、strong 74/76；另一套探针每局重置 PRNG 得 79，非本套件口径，别拿它算余量）。
 *
 * ⚠️ 这三条前提任何一条被新规则打破（牌能回手牌 / 开轮可能无合法牌 / 回合能给空手玩家），
 *    这个上界都要**重新推导**，不是调大常数的事。完整论证见文件末尾「终止性」用例。
 */
const MAX_ACTIONS_PER_ROUND = DECK_SIZE * 2;
/**
 * 每轮步数上限：超过即视为死循环。
 *
 * ⚠ 一个常数、两个职责：它既是「终止性解析上界」的判据，又是主 soak 的**死循环哨兵阈值**。
 * 也就是说主 soak 里没有第二道安全网 —— 单独调大这个值，等于同时放松了「上界断言」和
 * 「死循环检测」。要动它请先重读上面那段推导，而不是因为它红了就加数字。
 */
const MAX_STEPS_PER_GAME = MAX_ACTIONS_PER_ROUND;
/** 每局打几轮（>1 时覆盖 nextRound → startGame 的二次开局路径） */
const ROUNDS_PER_GAME = 2;

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
    /** 以「只剩一人有牌 → 余牌计入败牌」这条新规则收尾的轮次数（W3-ENG-RULE01） */
    carryOverRounds: 0,
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
      // W3-ENG-RULE01：终局 = 只剩一人有牌时把他余下的牌计入败牌（或全场皆空的兜底），
      // 两种路径结束后都不应该再有人手里留牌 —— 留牌就是「漏算败牌」，会直接少算某人的失败牌数。
      for (const p of room.players) {
        assert.strictEqual(p.hand.length, 0, `${where}：settling 阶段 ${p.name} 手里不得还留着牌`);
      }
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
      // 终止性的关键不变量（W3-ENG-RULE01）：回合永远落在「手里有牌」的人身上。
      // 一旦把回合交给 0 手牌的玩家，他会无限空收牌（桌面为空 + 无合法牌）而永不终结。
      const cur = room.players.find((p) => p.id === room.currentPlayerId);
      assert.ok(cur.hand.length > 0, `${where}：当前玩家 ${cur.name} 手里必须有牌（否则只会在收牌上死循环）`);
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
      if (room.eventLog.some((m) => m.includes('未能出完'))) stats.carryOverRounds += 1;
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
  assert.ok(
    stats.carryOverRounds > 0,
    '本轮 soak 从未走到「只剩一人有牌 → 余牌+桌面遗留计入败牌」的新终局路径，W3-ENG-RULE01 未被覆盖'
  );
});

/* ============================================================
 * W3-ENG-RULE01 终止性：新规则「打到只剩一人有牌」不得出现无限对局
 *
 * 用固定 seed 的确定性牌局，断言的是**解析上界**，不是「跑起来没超时」：
 *
 *   1. 一张牌离开手牌后永不回到手牌（出牌 → tablePile → penaltyPile，收牌只是挪去败牌堆）；
 *   2. 手牌只可能来自「开局 5n 张」+「摸牌堆 54-5n 张」，合计恰好 54 张牌各进一次；
 *   3. ⇒ 单局出牌次数 ≤ 54；
 *   4. 收牌之后桌面必空、收牌者成为开轮者，开轮时任何手牌都合法（功能牌也能单张出），
 *      且回合只会交给「手里有牌的人」（checkInvariants 里的不变量）——
 *      ⇒ 两次收牌之间至少有一次出牌 ⇒ 收牌次数 ≤ 出牌次数 + 1。
 *
 * 合计：单轮动作数 ≤ DECK_SIZE * 2 = 108（见文件顶部 MAX_ACTIONS_PER_ROUND 的推导）。
 * 任何超过它的对局都说明「牌在哪儿」出了问题（牌被复制 / 手牌没扣减 / 回合空转），
 * 而不是运气不好。
 * ============================================================ */
const ENDGAME_GAMES = Number(process.env.SOAK_ENDGAME_GAMES || 30);

/**
 * 两条选牌策略 —— **只加样本，不改判据**（三条上界断言一个字都不放宽）：
 * - `first`：现行行为，取首个合法组合（≈ 最小可压），收牌次数少；
 * - `strong`：按 engine.DISPLAY_ORDER **反向**取（打最强），专门逼出收牌，
 *   压的是「收牌 ≤ 出牌 + 1」那条腿（QA 的压测里，最大步数就出现在这条策略上）。
 *
 * **为什么「反向 DISPLAY_ORDER」可以当「打最强」用**（后来人最容易怀疑的一步）：
 * 1) DISPLAY_ORDER 的顺序 `4<6<7<9<J<Q<K<SJ<BJ<3<8<5<10<A<2` 在**同一 kind 内部**与
 *    lib/cards.js 的牌力序**逐位相同**：妖怪用 MONSTER_ORDER、师兄弟用 DISCIPLE_ORDER、
 *    唐僧只有一张 10 —— 也就是说「同 kind 内反向取序数最大者」＝ 取能压住同 kind 最多牌的牌，
 *    这一半是严格成立的。
 * 2) 跨 kind 不存在「最强」：克制链是环（妖怪 → 唐僧 → 师兄弟 → 妖怪，见 BEAT），
 *    环上没有全序，所以任何单一排序都只能近似。DISPLAY_ORDER 在跨 kind 时按「稀有度」排
 *    （妖怪 < 师兄弟 < 唐僧 < 功能牌），反向即「先甩唐僧/师兄弟、留功能牌」，
 *    对「逼对手收牌」这个**目标**是有效的近似，但它不是、也不可能是理论最优。
 * 3) 所以这条 arm 的价值来自**实测**而不是定理：同 seed 下它把最大收牌从 14/17 顶到 27，
 *    正好压到「收牌 ≤ 出牌+1」那条腿上。别把它当「最优策略」写进文档。
 * （不再另写一张牌力表：那种映射表最容易随规则漂移，而 DISPLAY_ORDER 已够用。）
 *
 * **加第三个 seed 之前必读：「seed 相同」≠「牌局相同」。**
 * 每个 arm 在**自己那一轮循环开始前** `mulberry32(arm.seed)` 复位一次，之后 arm 内 3 人/6 人 ×
 * N 局**连续消耗同一条 PRNG 流**（第 2 局的牌序接着第 1 局用剩的游标继续）。
 * 若换成「每局重开 `mulberry32(seed)`」（每局牌序都从同一游标起跑），同一个 seed 得到的是
 * **完全不同的牌局集合**，实测最大步数也会变（本套件 76，每局复位口径曾量到 79）。
 * 所以复现别人报的数字时，必须同时对齐 seed **和**复位粒度，否则两人会各自对、互相不信。
 */
const ENDGAME_ARMS = [
  { label: 'first', seed: SEED, strategy: 'first' },
  { label: 'strong', seed: 999, strategy: 'strong' },
];

/** 从合法动作里按策略挑一个（beats/actions 都来自引擎，策略输出 ⊆ 引擎认可） */
function pickMove(hand, moves, strategy) {
  const all = [...moves.beats, ...moves.actions.map((id) => [id])];
  if (all.length === 0) return null;
  if (strategy === 'first') return all[0];
  const key = (ids) => (engine.DISPLAY_ORDER[hand.find((c) => c.id === ids[0]).rank] ?? 99) * 10 + ids.length;
  let best = all[0];
  for (const g of all) if (key(g) > key(best)) best = g;
  return best;
}

test(`终止性：2 种选牌策略 × 3 人 / 6 人各 ${ENDGAME_GAMES} 局必须在 ≤${MAX_ACTIONS_PER_ROUND} 步内走到 settling`, (t) => {
  const realRandomNow = Math.random;
  t.after(() => {
    Math.random = realRandomNow;
  });

  const report = [];

  for (const arm of ENDGAME_ARMS) {
    const rng = mulberry32(arm.seed);
    Math.random = rng; // engine.shuffle 依赖同一个流，保证每个 arm 各自可复现

    for (const n of [3, 6]) {
      let maxActions = 0;
      let maxPlays = 0;
      let maxPickups = 0;
      let totalActions = 0;
      let carryOver = 0;
      const where = (gi) => `[${arm.label}] ${n} 人局第 ${gi} 局`;

      for (let gi = 0; gi < ENDGAME_GAMES; gi++) {
        const room = engine.createRoom(String(500 + gi));
        for (let i = 0; i < n; i++) {
          engine.addPlayer(room, { id: `e${arm.label}_${n}_${gi}_${i}`, name: `P${i}` });
        }
        for (const p of room.players) engine.setReady(room, p.id, true);
        engine.startGame(room);

        let plays = 0;
        let pickups = 0;
        const totalAtStart = room.players.reduce((s, p) => s + p.hand.length, 0) + room.drawPile.length;
        assert.strictEqual(totalAtStart, DECK_SIZE, `${where(gi)}：开局牌数应为 ${DECK_SIZE}`);

        let steps = 0;
        let prevHandTotalWhenDrawEmpty = null;
        while (room.phase === 'playing') {
          steps += 1;
          assert.ok(
            steps <= MAX_ACTIONS_PER_ROUND * 2,
            `${where(gi)} 超过 ${MAX_ACTIONS_PER_ROUND * 2} 步仍未结束 → 死循环`
          );

          const cur = room.players.find((p) => p.id === room.currentPlayerId);
          assert.ok(cur && cur.hand.length > 0, `${where(gi)} 第 ${steps} 步：回合不得落在 0 手牌玩家身上`);

          const moves = engine.computeLegalMoves(room, cur.id);
          const pick = pickMove(cur.hand, moves, arm.strategy);
          if (pick) {
            engine.playCard(room, cur.id, pick);
            plays += 1;
          } else {
            engine.pickUp(room, cur.id);
            pickups += 1;
          }

          // 摸牌堆空之后：全场手牌总数必须单调不增（新规则下「继续打」的唯一收敛来源）
          if (room.drawPile.length === 0) {
            const handTotal = room.players.reduce((s, p) => s + p.hand.length, 0);
            if (prevHandTotalWhenDrawEmpty !== null && room.phase === 'playing') {
              assert.ok(
                handTotal <= prevHandTotalWhenDrawEmpty,
                `${where(gi)} 第 ${steps} 步：摸牌堆空后手牌总数不得增加（${prevHandTotalWhenDrawEmpty} → ${handTotal}）`
              );
            }
            prevHandTotalWhenDrawEmpty = handTotal;
          }
        }

        const actions = plays + pickups;
        assert.strictEqual(room.phase, 'settling', `${where(gi)} 必须走到 settling（实际 phase=${room.phase}）`);
        assert.ok(plays <= DECK_SIZE, `${where(gi)} 出牌 ${plays} 次 > ${DECK_SIZE}：牌被复制或手牌没扣减`);
        assert.ok(
          pickups <= plays + 1,
          `${where(gi)} 收牌 ${pickups} 次 > 出牌 ${plays} + 1：出现连续空收牌（回合空转）`
        );
        assert.ok(
          actions <= MAX_ACTIONS_PER_ROUND,
          `${where(gi)} 动作数 ${actions} 超出解析上界 ${MAX_ACTIONS_PER_ROUND}`
        );
        assert.strictEqual(room.currentPlayerId, null, `${where(gi)} 终局后不得有 currentPlayerId`);
        for (const p of room.players) {
          assert.strictEqual(p.hand.length, 0, `${where(gi)} 终局后 ${p.name} 手里还留着牌`);
        }
        // 终局后也要复核牌守恒（QA 复核补）：只「hand=[]」而不并入败牌堆会把牌吞掉，
        // 这种变异在单跑本用例时不会被上面的断言发现（那也是 hand=0），只有这里能抓住。
        const zonesTotal = room.drawPile.length + room.tablePile.length +
          room.players.reduce((s2, p) => s2 + p.hand.length + p.penaltyPile.length, 0);
        assert.strictEqual(
          zonesTotal,
          DECK_SIZE,
          `${where(gi)} 终局后牌不守恒（${zonesTotal} != ${DECK_SIZE}）：余牌被吞或牌被复制`
        );
        if (room.eventLog.some((m) => m.includes('未能出完'))) carryOver += 1;

        maxActions = Math.max(maxActions, actions);
        maxPlays = Math.max(maxPlays, plays);
        maxPickups = Math.max(maxPickups, pickups);
        totalActions += actions;
      }

      assert.ok(
        carryOver > 0,
        `[${arm.label}] ${n} 人局：${ENDGAME_GAMES} 局里从未走「余牌+桌面遗留计入败牌」的新终局路径，覆盖不足`
      );
      // 每个 arm 各自打印自己的最大值 —— 否则余量从 1.42× 掉到 1.05× 也没人看得见
      report.push(
        `${arm.label}(seed=${arm.seed}) ${n} 人局：最大动作 ${maxActions} / 最大出牌 ${maxPlays} / ` +
          `最大收牌 ${maxPickups} / 合计 ${totalActions} 步 / 余牌计入败牌 ${carryOver}/${ENDGAME_GAMES} 局`
      );
    }
  }

  for (const line of report) t.diagnostic(line);
});
