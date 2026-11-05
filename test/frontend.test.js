'use strict';

/**
 * test/frontend.test.js — 前端「视图状态机」断言（零依赖：node:vm + 极简假 DOM）
 *
 * 为什么需要这一层：
 *   后端 97 条测试全部落在 lib/ 与 net/，**一条都碰不到 public/**。
 *   2026-10-27 的 P0「房主点开始后界面停在房间面板、必须刷新才进对局」就是这样活下来的：
 *   服务端广播了 phase=playing，客户端也 renderGame() 了，但没人调 showView()，
 *   于是内容被渲染进隐藏的 #view-game，屏幕上还停在房间面板 —— 服务端零报错、控制台零报错。
 *
 * 这一层断言的就是那张「事件 → 视图」的表，任何一条漏掉都会在这里变红。
 * 它不引 jsdom、不引任何依赖，只提供 app.js 真正用到的那点 DOM 能力。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// 默认测 public/app.js；设 FE_APP 可指向别的副本，用于「阴性对照」——
// 把断言指向修复前的版本，必须变红，否则说明这套断言抓不住缺陷。
const APP = process.env.FE_APP
  ? path.resolve(process.env.FE_APP)
  : path.join(__dirname, '..', 'public', 'app.js');
const SRC = fs.readFileSync(APP, 'utf8');

/* ---------- 极简假 DOM ---------- */
function makeEl(sel) {
  const classes = new Set();
  const handlers = new Map(); // evt -> [cb]（点击类断言需要能「真的点一下」）
  const el = {
    __sel: sel,
    __handlers: handlers,
    children: [],
    _innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    style: {},
    // 真实 DOM 一定有 parentNode；假 DOM 补上，是让「FX 节点被清理」这条断言
    // 能通过 children.length 观察到结果（否则节点只能加不能删，等于没法验证回收）。
    parentNode: null,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
    },
    get innerHTML() { return el._innerHTML; },
    set innerHTML(v) {
      el._innerHTML = String(v);
      el.children = [];
      // renderHand 会取 firstElementChild 并 addEventListener
      el.firstElementChild = v && v.trim().startsWith('<') ? makeEl(`${sel} > child`) : null;
    },
    appendChild(c) {
      el.children.push(c);
      if (c && typeof c === 'object') c.parentNode = el;
      return c;
    },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      if (c && typeof c === 'object') c.parentNode = null;
      return c;
    },
    remove() {
      if (el.parentNode && typeof el.parentNode.removeChild === 'function') el.parentNode.removeChild(el);
    },
    addEventListener(evt, cb) {
      if (!handlers.has(evt)) handlers.set(evt, []);
      handlers.get(evt).push(cb);
    },
  };
  el.firstElementChild = null;
  return el;
}

/**
 * 可手动推进的假定时器（只在 makeRig({timers:true}) 时注入）。
 * 用途：验证 FX 的「兜底清理」——animationend 永远不触发时，靠 setTimeout 也必须回收节点。
 * 用真实 setTimeout 的话只能靠 sleep 等，既慢又不稳定。
 */
function makeTimers() {
  const q = [];
  let seq = 1;
  let now = 0;
  return {
    setTimeout(fn, ms) {
      const id = seq++;
      q.push({ id, at: now + Math.max(0, ms || 0), fn });
      return id;
    },
    clearTimeout(id) {
      const i = q.findIndex((t) => t.id === id);
      if (i >= 0) q.splice(i, 1);
    },
    pending: () => q.length,
    now: () => now,
    /** 推进 ms 毫秒：到期的回调按时间顺序执行（回调里新排的定时器也在本次范围内） */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const t of q) {
          if (t.at > target) continue;
          if (!next || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t;
        }
        if (!next) break;
        q.splice(q.indexOf(next), 1);
        now = next.at;
        next.fn();
      }
      now = target;
    },
  };
}

/**
 * 触发一次真实点击。
 * 返回 false 表示该元素上没有任何 click 监听（对阴性对照很关键：
 * 旧版本根本没有绑定 addAI / removeAI，必须能区分「没反应」与「发对了事件」）。
 */
function click(el) {
  const hs = (el.__handlers && el.__handlers.get('click')) || [];
  for (const h of hs) h({ preventDefault() {} });
  return hs.length > 0;
}

/**
 * 造一套全新的运行时环境（每个用例一套，互不干扰）。
 * 注意：故意**不提供** document.body / getBoundingClientRect / requestAnimationFrame ——
 * 动效代码必须能在没有布局能力的环境里安全跳过，这里顺带把这条约束钉住。
 *
 * @param {{timers?: boolean, reducedMotion?: boolean}} [opts]
 *   timers        注入可推进的假定时器（默认用真实 setTimeout）
 *   reducedMotion 提供 window.matchMedia，且 (prefers-reduced-motion: reduce) 命中
 */
function makeRig(opts = {}) {
  const els = new Map();
  const getEl = (sel) => {
    if (!els.has(sel)) els.set(sel, makeEl(sel));
    return els.get(sel);
  };
  for (const id of ['view-home', 'view-room', 'view-game', 'view-settle', 'roomInfo', 'toast', 'nickname', 'fx', 'dirRing']) {
    getEl(`#${id}`);
  }
  // 与 public/index.html 的初始 class 对齐：两个 AI 按钮出厂就是 hidden（`.btn.hidden`）。
  // 必须先播下这个初始态，否则「房主应看到按钮」在「根本没实现」的版本上也会假绿 ——
  // 假 DOM 里新元素天生不带 class，不播种就分不清「显式显示」与「从未处理」。
  getEl('#btnAddAI').classList.add('hidden');
  getEl('#btnRemoveAI').classList.add('hidden');

  const timers = opts.timers ? makeTimers() : null;
  const warnings = [];
  const sandbox = {
    console: {
      log: () => {},
      warn: (...a) => warnings.push(a.join(' ')),
      error: (...a) => warnings.push(`ERROR ${a.join(' ')}`),
    },
    setTimeout: timers ? timers.setTimeout : setTimeout,
    clearTimeout: timers ? timers.clearTimeout : clearTimeout,
    Promise, Map, Set, JSON, String, Object, Array, Math, Date,
    location: { host: 'localhost:3311' },
    sessionStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        clear: () => m.clear(),
      };
    })(),
    fetch: async () => ({ ok: true, json: async () => ({ names: { 4: '小妖' }, rankShow: { SJ: '小王' } }) }),
    document: {
      querySelector: (sel) => getEl(sel),
      createElement: () => makeEl('created'),
      addEventListener: (evt, cb) => { if (evt === 'DOMContentLoaded') sandbox.__domReady = cb; },
    },
  };
  // 只有验证「减弱动效」的用例才注入 window：默认环境没有 window，
  // app.js 必须自己把「拿不到 matchMedia」当成「没有偏好」，否则真机上会静默丢特效。
  if (opts.reducedMotion) {
    sandbox.window = {
      matchMedia: (q) => ({ media: q, matches: q === '(prefers-reduced-motion: reduce)' }),
    };
  }

  let socket = null;
  sandbox.io = () => {
    const handlers = new Map();
    socket = {
      handlers,
      emitted: [],
      on(evt, h) { handlers.set(evt, h); },
      emit(evt, payload) { socket.emitted.push({ evt, payload }); },
      fire(evt, payload) {
        const h = handlers.get(evt);
        if (!h) throw new Error(`未注册 socket 事件 ${evt}`);
        return h(payload);
      },
    };
    return socket;
  };

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: APP });
  sandbox.__domReady(); // 等价于 DOMContentLoaded：bindEvents + loadCardNames + connectSocket

  return {
    socket,
    getEl,
    warnings,
    click,
    timers,
    visible: (id) => !getEl(`#${id}`).classList.contains('hidden'),
    hidden: (id) => getEl(`#${id}`).classList.contains('hidden'),
  };
}

/** 构造服务端 getView() 形状的 state */
function stBase(phase, extra = {}) {
  return {
    phase,
    roomCode: '888',
    youId: 'p0',
    roundNumber: 1,
    players: [
      { id: 'p0', name: '悟空', seat: 0, ready: true, connected: true, handCount: 5, penaltyCount: 0, isOwner: true },
      { id: 'p1', name: '八戒', seat: 1, ready: true, connected: true, handCount: 5, penaltyCount: 0, isOwner: false },
      { id: 'p2', name: '沙僧', seat: 2, ready: true, connected: true, handCount: 5, penaltyCount: 0, isOwner: false },
    ],
    direction: 1,
    currentPlayerId: 'p0',
    topCard: null,
    topCount: 1,
    tablePileCount: 0,
    drawPileCount: 9,
    hand: [],
    eventLog: [],
    lastResult: null,
    lastWinnerId: null,
    ...extra,
  };
}

const LAST_RESULT = {
  results: [
    { id: 'p1', name: '八戒', penaltyCount: 1 },
    { id: 'p0', name: '悟空', penaltyCount: 3 },
    { id: 'p2', name: '沙僧', penaltyCount: 4 },
  ],
  winnerId: 'p1',
};

/* ================= 场景 1：建房 → 房间面板 ================= */
test('建房（waiting）→ 停在房间面板，其余视图隐藏', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stBase('waiting') });
  assert.ok(r.visible('view-room'), '#view-room 应可见');
  assert.ok(r.hidden('view-game'), '#view-game 应隐藏');
  assert.ok(r.hidden('view-home'), '#view-home 应隐藏');
  assert.ok(r.hidden('view-settle'), '结算遮罩应隐藏');
});

/* ================= 场景 2：★P0 主场景 —— 房主点开始 ================= */
test('★房主点开始（state 变为 playing）→ 必须切到牌桌', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stBase('waiting') });
  r.socket.fire('state', stBase('playing'));
  assert.ok(r.visible('view-game'), 'state(playing) 后 #view-game 必须可见 —— 这是原缺陷所在：只 render 不切视图');
  assert.ok(r.hidden('view-room'), '#view-room 应隐藏');
  assert.ok(r.hidden('view-settle'), '结算遮罩应隐藏');

  // 回合推进期间反复收 state 不应掉出牌桌
  r.socket.fire('yourTurn', { legalMoves: { opening: true, beats: [['c1']], actions: [] }, deadline: Date.now() + 30000 });
  r.socket.fire('state', stBase('playing', { currentPlayerId: 'p1' }));
  assert.ok(r.visible('view-game'), '回合推进后仍应在牌桌');
});

/* ================= 场景 3：终局 settling 不得关掉结算遮罩 ================= */
test('终局：state(settling) 不切视图，gameEnd 才弹遮罩', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stBase('playing') });
  r.socket.fire('state', stBase('settling', { currentPlayerId: null, lastResult: LAST_RESULT }));
  assert.ok(r.visible('view-game'), 'settling 时视图应保持 view-game');
  assert.ok(r.hidden('view-settle'), 'settling 的 state 单独到来时不应弹遮罩（由 gameEnd 负责）');

  r.socket.fire('gameEnd', { results: LAST_RESULT.results, winnerIds: ['p1'], winnerName: '八戒' });
  assert.ok(r.visible('view-settle'), 'gameEnd 后结算遮罩应弹出');
  assert.ok(r.visible('view-game'), '遮罩叠在 view-game 之上，底层不应被切走');
  assert.strictEqual(r.getEl('#resultList').children.length, 3, '结算列表应有 3 行');
  assert.ok(String(r.getEl('#winnerBanner').textContent).includes('八戒'), '冠军横幅应含胜者名');
});

/* ================= 场景 4：★再来一局 —— 结算遮罩必须消失 ================= */
test('★再来一局（settling → waiting）→ 回房间面板且结算遮罩消失', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stBase('settling', { lastResult: LAST_RESULT }) });
  assert.ok(r.visible('view-settle'), '前置：结算期进来应看到遮罩');

  r.socket.fire('state', stBase('waiting', { currentPlayerId: null, lastResult: LAST_RESULT }));
  assert.ok(r.visible('view-room'), 'waiting 应回房间面板');
  assert.ok(r.hidden('view-settle'), '结算遮罩必须被隐藏（原缺陷：残留遮罩盖住房间面板）');
  assert.ok(r.hidden('view-game'), '#view-game 应隐藏');
});

/* ================= 场景 5：结算期刷新/重连 → 补弹结算遮罩 ================= */
test('结算期刷新（roomJoined 带 settling）→ 自动补弹结算遮罩', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stBase('settling', { currentPlayerId: null, lastResult: LAST_RESULT }) });
  assert.ok(r.visible('view-settle'), '没有 gameEnd 可依赖，roomJoined 必须自己补弹');
  assert.ok(r.visible('view-game'), '底层牌桌应可见');
  assert.strictEqual(r.getEl('#resultList').children.length, 3, '结算列表应有 3 行');
  assert.ok(String(r.getEl('#winnerBanner').textContent).includes('八戒'), 'winnerName 应从 state.players 取到');
});

/* ================= 场景 6：对局中重连 ================= */
test('对局中刷新（roomJoined 带 playing）→ 直接回牌桌，不弹遮罩', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stBase('playing') });
  assert.ok(r.visible('view-game'), '应回牌桌');
  assert.ok(r.hidden('view-settle'), '不应弹结算遮罩');
});

/* ================= 场景 7：房间解散 → 首页 ================= */
test('房间解散 → 回首页并清空所有遮罩', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stBase('settling', { lastResult: LAST_RESULT }) });
  r.socket.fire('roomClosed');
  assert.ok(r.visible('view-home'), '应回首页');
  assert.ok(r.hidden('view-room') && r.hidden('view-game'), '其余视图应隐藏');
  assert.ok(r.hidden('view-settle'), '结算遮罩应隐藏');
});

/* ================= 场景 8：兜底告警只警告、不强行切换 ================= */
test('视图与 phase 不一致时只告警、不强行纠正', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stBase('playing') });
  r.getEl('#view-game').classList.add('hidden'); // 人为制造不一致
  const before = r.warnings.filter((w) => w.includes('视图与状态不一致')).length;
  r.socket.fire('yourTurn', { legalMoves: { opening: true, beats: [], actions: [] }, deadline: Date.now() + 1000 });
  const after = r.warnings.filter((w) => w.includes('视图与状态不一致')).length;
  assert.ok(after > before, '不一致时应打印告警，留下可追查的痕迹');
  assert.ok(r.hidden('view-game'), '兜底不得强行切换视图（强行纠正会掩盖真缺陷）');
});

/* ============================================================
 * AI 补位（W1-ENG-01）· 以下 5 个场景覆盖 AI 相关 UI
 * 说明：这些断言的价值一半在与「阴性对照」——把 FE_APP 指向 HEAD 版 app.js
 * 必须变红，否则它们只是复述实现。
 * ============================================================ */

/** 1 真人 + N 个 AI 的房间视图（形状与 net.getView 一致，含 isAI 字段） */
function stAI({ youId = 'p0', ownerId = 'p0', aiCount = 2, phase = 'waiting', extra = {}, humans = [] } = {}) {
  const players = [
    { id: 'p0', name: '悟空', seat: 0, ready: true, connected: true, handCount: 5, penaltyCount: 0, isOwner: ownerId === 'p0', isAI: false },
  ];
  const AI_NAMES = ['悟能', '悟净', '白龙', '金角', '银角'];
  for (let i = 0; i < aiCount; i++) {
    players.push({
      id: `ai-${i + 1}`, name: AI_NAMES[i], seat: players.length,
      ready: true, connected: true, handCount: phase === 'playing' ? 5 : 0,
      penaltyCount: 0, isOwner: false, isAI: true,
    });
  }
  for (const h of humans) {
    players.push({
      id: h.id, name: h.name, seat: players.length, ready: true, connected: true,
      handCount: phase === 'playing' ? 5 : 0, penaltyCount: 0, isOwner: ownerId === h.id, isAI: false,
    });
  }
  return stBase(phase, {
    youId,
    players,
    currentPlayerId: phase === 'playing' ? 'p0' : null,
    ...extra,
  });
}

/* ================= 场景 9：AI 按钮的可见性（房主 / 非房主） ================= */
test('AI 补位按钮：房主可见「加 AI」「踢 AI」，非房主两个都隐藏', () => {
  const r = makeRig();
  // 房主视角
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stAI({ aiCount: 2 }) });
  assert.ok(!r.hidden('btnAddAI'), '房主应看到「加 AI」（初始为 hidden，必须被显式显示）');
  assert.ok(!r.hidden('btnRemoveAI'), '房主应看到「踢 AI」');

  // 非房主视角：pB 加入，房主仍是 p0
  const st = stAI({ youId: 'pB', ownerId: 'p0', aiCount: 2, humans: [{ id: 'pB', name: '八戒' }] });
  r.socket.fire('state', st);
  assert.ok(r.hidden('btnAddAI'), '非房主必须看不到「加 AI」');
  assert.ok(r.hidden('btnRemoveAI'), '非房主必须看不到「踢 AI」');
});

/* ================= 场景 10：「加/踢 AI」的置灰条件 ================= */
test('AI 按钮置灰：满 6 人禁用「加 AI」，无 AI 时禁用「踢 AI」', () => {
  const r = makeRig();

  // ① 3 人（1 真人 + 2 AI）：可加、可踢
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stAI({ aiCount: 2 }) });
  assert.strictEqual(r.getEl('#btnAddAI').disabled, false, '未满员时「加 AI」应可用');
  assert.strictEqual(r.getEl('#btnRemoveAI').disabled, false, '有 AI 时「踢 AI」应可用');

  // ② 6 人满员：加禁用、踢仍可用
  const full = stAI({ aiCount: 5 });
  assert.strictEqual(full.players.length, 6, '前置：满员 6 人');
  r.socket.fire('state', full);
  assert.strictEqual(r.getEl('#btnAddAI').disabled, true, '满 6 人时「加 AI」必须置灰（服务端也会拒，但不该让用户点了才知道）');
  assert.strictEqual(r.getEl('#btnRemoveAI').disabled, false, '满员但仍有 AI → 「踢 AI」可用');

  // ③ 3 个真人 0 AI：踢禁用、加可用
  r.socket.fire('state', stAI({ aiCount: 0 }));
  assert.strictEqual(r.getEl('#btnRemoveAI').disabled, true, '没有 AI 时「踢 AI」必须置灰');
  assert.strictEqual(r.getEl('#btnAddAI').disabled, false, '3 人局「加 AI」应可用');
});

/* ================= 场景 11：房间列表的 AI 徽标 ================= */
test('房间列表：AI 显示 AI 徽标且不再显示「未准备 / 已准备」，真人仍显示准备态', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stAI({ aiCount: 2 }) });
  const rows = r.getEl('#playerList').children.map((c) => c.innerHTML);
  assert.strictEqual(rows.length, 3, '应渲染 3 行（1 真人 + 2 AI）');

  assert.ok(rows[0].includes('badge ready') && rows[0].includes('已准备'), '真人行显示「已准备」');
  assert.ok(!rows[0].includes('badge ai'), '真人行不得出现 AI 徽标');

  for (const i of [1, 2]) {
    assert.ok(rows[i].includes('badge ai'), `第 ${i + 1} 行（AI）必须有 AI 徽标`);
    assert.ok(!rows[i].includes('未准备'), `第 ${i + 1} 行（AI）不得显示「未准备」——AI 永远不会点准备，显示会让人白等`);
    assert.ok(!rows[i].includes('已准备'), `第 ${i + 1} 行（AI）也不该同时显示「已准备」（AI 徽标替代它，不是并存）`);
  }
});

/* ================= 场景 12：对局座位的 AI 标注 ================= */
test('对局座位：AI 名字后缀 ·AI，真人名字不带', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stAI({ aiCount: 2, phase: 'playing' }) });
  const seats = r.getEl('#seats').children.map((c) => c.innerHTML);
  assert.strictEqual(seats.length, 3, '应渲染 3 个座位');
  assert.ok(seats[1].includes('悟能·AI'), 'AI 座位名后应带 ·AI（对局中也能一眼认出来）');
  assert.ok(seats[2].includes('悟净·AI'), '第二个 AI 同样带 ·AI');
  assert.ok(!seats[0].includes('·AI'), '真人座位名不得带 ·AI');
  assert.strictEqual(r.warnings.filter((w) => w.includes('视图与状态不一致')).length, 0, 'AI 局不应触发视图状态机告警');
});

/* ================= 场景 13：点击真的 emit 了对应事件 ================= */
test('点击「加 AI」「踢 AI」→ 分别 emit addAI / removeAI（事件名不得拼错）', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stAI({ aiCount: 2 }) });
  r.socket.emitted.length = 0;

  const clickedAdd = r.click(r.getEl('#btnAddAI'));
  assert.ok(clickedAdd, '「加 AI」必须绑定了 click 监听（否则按钮是死的）');
  assert.deepStrictEqual(r.socket.emitted.map((e) => e.evt), ['addAI'], '应先 emit addAI');

  const clickedRemove = r.click(r.getEl('#btnRemoveAI'));
  assert.ok(clickedRemove, '「踢 AI」必须绑定了 click 监听');
  assert.deepStrictEqual(r.socket.emitted.map((e) => e.evt), ['addAI', 'removeAI'], '再 emit removeAI');
});

/* ============================================================
 * 打牌压制冲击动画（FX 层 · W2-ENG-FX01）
 *
 * 这一组断言只做一件事：把「三档强度」和「不许重复播 / 不许漏回收」钉死。
 * 阴性对照请把 FE_APP 指向改动前的 app.js —— 除了首出那条，其余都应变红。
 * ============================================================ */

/** 对局中某一帧：门槛牌 + 桌面牌数 */
function stPlay(topCard, pile, extra = {}) {
  return stBase('playing', { topCard, tablePileCount: pile, ...extra });
}

const C4 = { rank: '4', suit: '♠', kind: 'monster' };
const C6 = { rank: '6', suit: '♥', kind: 'monster' };
const C9 = { rank: '9', suit: '♦', kind: 'monster' };
const CJ = { rank: 'J', suit: '♣', kind: 'monster' };

const fxCount = (r, cls) => r.getEl('#fx').children.filter((n) => n.classList.contains(cls)).length;
const fxTotal = (r) => r.getEl('#fx').children.length;

/* ================= 场景 14：★首出 vs 压制 —— 强度必须拉开 ================= */
test('★首出只有落牌、压制才有冲击波（否则「压制」体感等于随便出张牌）', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stPlay(null, 0) });
  assert.strictEqual(fxTotal(r), 0, '入场帧（prev 为空）不得产生任何 FX');

  // ① 首出：prev.hasTop === false
  r.socket.fire('state', stPlay(C4, 1));
  assert.ok(r.getEl('#topCard').classList.contains('drop'), '首出仍要有落牌动画（三档里的第 1 档）');
  assert.strictEqual(fxTotal(r), 0, '首出不得有冲击波/斩击线/残影/火星');
  assert.ok(!r.getEl('#table').classList.contains('hit'), '首出不震桌');

  // ② 压制：prev.hasTop === true 且门槛牌换了
  r.socket.fire('state', stPlay(C6, 2));
  assert.strictEqual(fxCount(r, 'fx-shock'), 2, '压制应有 2 圈冲击波');
  assert.strictEqual(fxCount(r, 'fx-slash'), 1, '压制应有 1 条斩击线');
  assert.strictEqual(fxCount(r, 'fx-card-ghost'), 1, '压制应有旧牌残影');
  assert.strictEqual(fxCount(r, 'fx-spark'), 0, '单张压制不溅火星（火星是连击专属）');
  assert.ok(r.getEl('#table').classList.contains('hit'), '压制要震桌');
  assert.ok(r.getEl('#topCard').classList.contains('flash'), '压制要给牌面高光');
  // 残影必须画的是「被压掉的那张牌」（4），不是新压上去的那张（6）
  const ghost = r.getEl('#fx').children.find((n) => n.classList.contains('fx-card-ghost'));
  assert.ok(ghost && String(ghost.innerHTML).includes('4'), '残影内容应是上一帧的门槛牌（4）');
  assert.ok(ghost && !String(ghost.innerHTML).includes('6'), '残影不得混入新牌（6）');
});

/* ================= 场景 15：连击 —— 冲击波转朱红 + 火星（有上限） ================= */
test('连击（一次压上 ≥2 张）：冲击波转朱红 + 火星 min(delta,4)', () => {
  const r = makeRig({ timers: true });
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stPlay(C4, 1) });

  // 压 2 张（delta = 2）
  r.socket.fire('state', stPlay(C9, 3));
  assert.strictEqual(fxCount(r, 'fx-spark'), 2, '压上 2 张 → 2 颗火星');
  const hot = r.getEl('#fx').children.filter((n) => n.classList.contains('fx-shock') && n.classList.contains('hot'));
  assert.strictEqual(hot.length, 2, '连击的冲击波必须转朱红（.hot）');

  r.timers.advance(1200); // 清场
  assert.strictEqual(fxTotal(r), 0, '前置：上一轮 FX 已回收');

  // 压 6 张（delta = 6）→ 火星封顶 4 颗，否则满屏噪点
  r.socket.fire('state', stPlay(CJ, 9));
  assert.strictEqual(fxCount(r, 'fx-spark'), 4, 'delta 再大也只溅 4 颗火星');
});

/* ================= 场景 16：★幂等 —— 同一份 state 重发不得重播 ================= */
test('★同一份 state 重复到达（重连 / 重播 / 接管）不重复播冲击动画', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stPlay(C4, 1) });

  const beat = stPlay(C6, 2);
  r.socket.fire('state', beat);
  const afterFirst = fxTotal(r);
  assert.ok(afterFirst > 0, '前置：第一次压制应产生节点');

  r.socket.fire('state', beat);
  r.socket.fire('state', beat);
  assert.strictEqual(fxTotal(r), afterFirst, '同一份 state 连发两次，第二次不得新增任何 FX 节点');

  // 连击帧同理（火星最容易漏成叠加噪音）
  const combo = stPlay(C9, 5);
  r.socket.fire('state', combo);
  const afterCombo = fxTotal(r);
  r.socket.fire('state', combo);
  assert.strictEqual(fxTotal(r), afterCombo, '连击帧重发同样不得新增火星');
});

/* ================= 场景 17：功能牌 / 收牌 —— 不是压制，别放特效 ================= */
test('门槛牌没换（功能牌 A/2）或桌面被收走时，都不触发冲击动画', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stPlay(C4, 2) });

  // 门槛牌没变却有新牌 → 功能牌（A/2），不是压制
  r.socket.fire('state', stPlay(C4, 4));
  assert.strictEqual(fxTotal(r), 0, '功能牌不参与压制链，不得放冲击波');

  // 收牌：桌面清空
  r.socket.fire('state', stPlay(null, 0));
  assert.strictEqual(fxTotal(r), 0, '收牌不是压制，不得放冲击波');
});

/* ================= 场景 18：★减弱动效 —— 一个节点都不建 ================= */
test('★prefers-reduced-motion: reduce → 不建任何 FX 节点，但落牌反馈保留', () => {
  const r = makeRig({ reducedMotion: true });
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stPlay(C4, 1) });
  r.socket.fire('state', stPlay(C9, 5)); // 压制 + 连击都占全

  assert.strictEqual(fxTotal(r), 0, '减弱动效时不得创建任何 FX 节点');
  assert.ok(!r.getEl('#table').classList.contains('hit'), '减弱动效时不震桌');
  assert.ok(!r.getEl('#topCard').classList.contains('flash'), '减弱动效时不闪高光');
  // 落牌动画交给 CSS 媒体查询压到 0.001ms，JS 不该连它一起拦掉
  assert.ok(r.getEl('#topCard').classList.contains('drop'), '减弱动效不等于零反馈：落牌类名照加');
});

/* ================= 场景 19：清理主路径（animationend） ================= */
test('FX 节点：animationend 一到就移除（主路径，防止越积越多）', () => {
  const r = makeRig({ timers: true });
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stPlay(C4, 1) });
  r.socket.fire('state', stPlay(C6, 2));

  const nodes = r.getEl('#fx').children.slice();
  assert.ok(nodes.length >= 4, `前置：压制应挂上至少 4 个节点，实际 ${nodes.length}`);

  for (const n of nodes) {
    const hs = (n.__handlers && n.__handlers.get('animationend')) || [];
    assert.ok(hs.length > 0, '每个 FX 节点都必须自己挂 animationend 回收');
    for (const h of hs) h({});
  }
  assert.strictEqual(fxTotal(r), 0, 'animationend 触发后节点必须全部移除');
});

/* ================= 场景 20：★兜底清理（animationend 永不触发） ================= */
test('★FX 节点：拿不到 animationend（减弱动效 / 后台标签页）时，兜底定时器照样清空', () => {
  const r = makeRig({ timers: true });
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stPlay(C4, 1) });
  r.socket.fire('state', stPlay(C9, 5));

  const total = fxTotal(r);
  assert.ok(total > 0, '前置：连击应挂上节点');

  // 谁也不去触发 animationend，只推进时间
  r.timers.advance(100);
  assert.strictEqual(fxTotal(r), total, '100ms 时动画还没播完，不该提前清（清理必须是「时长 + 200ms」而不是立刻）');

  r.timers.advance(1100); // 最长一条 480ms + 200ms 兜底 << 1200ms
  assert.strictEqual(fxTotal(r), 0, '兜底清理失效 → 后台标签页里节点会无限堆积');
  assert.ok(!r.getEl('#table').classList.contains('hit'), '震桌类名也要在 600ms 后摘掉，否则下次不再触发');
});



/* ================= 场景 16：卡面立绘 —— 牌点/样式/图片三者必须对齐 ================= */
test('★卡面立绘：角色牌与法宝牌都挂 has-art + data-rank（15 张全套）', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stPlay(null, 0) });

  // 孙悟空（5）
  r.socket.fire('state', stPlay({ rank: '5', suit: '♠', kind: 'disciple' }, 1));
  const top = r.getEl('#topCard').innerHTML;
  assert.ok(top.includes('has-art'), '角色牌必须挂 has-art（否则立绘样式一条都不会命中）');
  assert.ok(top.includes('data-rank="5"'), '必须带 data-rank，style.css 靠它选 --art');

  // 小王变体 SJ 也要命中（rankShow 会把它显示成「小王」，判断必须用原始 rank）
  r.socket.fire('state', stPlay({ rank: 'SJ', suit: '★', kind: 'monster' }, 2));
  assert.ok(r.getEl('#topCard').innerHTML.includes('data-rank="SJ"'), 'SJ 也要带 data-rank');

  // 功能牌：跳过（A）—— 配的是紫金红葫芦，现在也挂立绘
  r.socket.fire('state', stPlay({ rank: 'A', suit: '♦', kind: 'action' }, 3));
  const a = r.getEl('#topCard').innerHTML;
  assert.ok(a.includes('has-art'), 'A（紫金红葫芦）必须挂 has-art —— 功能牌现在也配法宝图');
  assert.ok(a.includes('data-rank="A"'), 'A 必须带 data-rank，style.css 靠它选 --art');
  // 图是「这是什么法宝」，字是「这张牌干什么」。配图不能把字条挤掉，
  // 否则牌面变成一张纯插画，玩家读不出功能。
  // 注：这里不能断言出现「跳过」二字 —— 假 DOM 的 fetch 桩只回了 { 4: '小妖' }，
  // S.cardNames 里没有 A，name 会回退成 rank。断言结构（字条槽位仍在且是 action 配色）
  // 才是这个环境里能站得住的判据；文案本身由 GET /api/cards 保证，属协议层。
  assert.ok(/class="role action"/.test(a), 'A 的底部字条必须仍在，且是 action 配色 —— 图不能取代字');
  assert.ok(!/class="role"/.test(a.replace(/class="role action"/, '')),
    'A 不应同时出现两个 role 字条（重复渲染会让底部压两层字）');

  // 功能牌：反转（2）—— 芭蕉扇
  r.socket.fire('state', stPlay({ rank: '2', suit: '♣', kind: 'action' }, 4));
  const two = r.getEl('#topCard').innerHTML;
  assert.ok(two.includes('has-art'), '2（芭蕉扇）必须挂 has-art');
  assert.ok(two.includes('data-rank="2"'), '2 必须带 data-rank');
  assert.ok(/class="role action"/.test(two), '2 的底部字条必须仍在，且是 action 配色');
});

test('★资产一致性：ART_RANKS ↔ style.css 的 --art 规则 ↔ 磁盘 PNG，缺一张就红', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const artDir = path.join(__dirname, '..', 'public', 'art', 'cards');

  // 13 个角色（画「人」）+ 2 个法宝（画「物」：A 紫金红葫芦 / 2 芭蕉扇）
  const CHAR_RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'SJ', 'BJ'];
  const ITEM_RANKS = ['A', '2'];
  const ALL_RANKS = CHAR_RANKS.concat(ITEM_RANKS);

  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stPlay(null, 0) });

  for (const rank of ALL_RANKS) {
    // 角色牌 kind 用 monster / 法宝牌用 action：立绘判据只看 rank，
    // 但 kind 决定底部字条配色，两处都用对才不会「测试通过、真机配色错」。
    const kind = ITEM_RANKS.includes(rank) ? 'action' : 'monster';
    r.socket.fire('state', stPlay({ rank, suit: '♠', kind }, 1));
    assert.ok(r.getEl('#topCard').innerHTML.includes('has-art'), `${rank} 应挂 has-art`);

    assert.ok(css.includes(`--art: url('/art/cards/${rank}.png')`),
      `style.css 缺少 ${rank} 的 --art 规则：牌会挂 has-art 但没有背景图，渲染成空牌`);
    assert.ok(fs.existsSync(path.join(artDir, `${rank}.png`)),
      `public/art/cards/${rank}.png 不存在：CSS 会 404，牌面变空白`);
  }

  // 反向：磁盘上不该有孤儿图（有图没规则 = 白生成了，纯浪费体积），
  // 也不该有规则指向不存在的图（上面 existsSync 已覆盖，这里再锁一次集合相等）。
  const files = fs.readdirSync(artDir).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, ''));
  const extra = files.filter((f) => !ALL_RANKS.includes(f));
  assert.deepStrictEqual(extra, [], `art/cards 里有未接线的孤儿图: ${extra.join(', ')}`);
  const missing = ALL_RANKS.filter((f) => !files.includes(f));
  assert.deepStrictEqual(missing, [], `art/cards 缺少已接线的图: ${missing.join(', ')}`);
});

/* ================= 场景 17：布局陷阱护栏 ================= */
test('★事件日志：max-height 必须与 box-sizing: content-box 成对出现', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

  // style.css 顶部有 * { box-sizing: border-box }，于是 max-height 会把
  // padding-top(8px) 和 border-top(1px) 一起算进去。日志要露出 2 行共 35.2px，
  // 在 border-box 下内容区只剩 26.2px ≈ 1.49 行，第二行必然被水平切半。
  // 这是纯布局问题，假 DOM 没有排版引擎测不出来，只能锁住这条样式约定。
  // 必须先剥注释：规则块里可能写着 "* { box-sizing: border-box }" 这类示例，
  // 那个 } 会让 [^}]* 提前截断，于是断言在「其实已经修好」的情况下假红。
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const block = bare.match(/\.event-log\s*\{[^}]*\}/);
  assert.ok(block, 'style.css 里找不到 .event-log 规则');
  assert.ok(/max-height\s*:/.test(block[0]), '.event-log 应保留 max-height 作为条数护栏');
  assert.ok(/box-sizing\s*:\s*content-box/.test(block[0]),
    '.event-log 设了 max-height 却没改回 content-box —— 第二行会被切掉一半（真机复现过）');
});

/* ============================================================
 * 出牌方向环（#dirRing · W3-ENG-FX02）
 *
 * 环的价值全在「一直在说话」+「反转那一下」两件事上，所以断言只钉这两条：
 *   1. 方向类名严格跟着 st.direction（不是靠「谁打了 2」推断）
 *   2. 只有方向真的变了才播一次，重复 state 不重播
 * 外加两条静态护栏：环真的在 index.html 里、层级低于日志且不吃点击。
 * ============================================================ */

/** 静态读 style.css 里某个选择器的规则块（先剥注释，否则块内注释里的 } 会截断匹配） */
function cssRule(sel) {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = bare.match(new RegExp(`${esc}\\s*\\{[^}]*\\}`));
  return m ? m[0] : null;
}

/** 从规则块里取一个整数值（取不到返回 NaN，让断言能明确报出来） */
function cssInt(block, prop) {
  const m = block && block.match(new RegExp(`${prop}\\s*:\\s*(-?\\d+)`));
  return m ? Number(m[1]) : NaN;
}

/* ================= 场景 21：方向类名严格跟着 st.direction ================= */
test('★方向环：进入对局即按 st.direction 挂方向类（1 顺时针 / -1 逆时针）', () => {
  // 静态：环必须真的写在页面结构里。假 DOM 的 querySelector 会自动补元素，
  // 光断言「拿得到 #dirRing」证明不了任何事。
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(/id="dirRing"/.test(html), 'index.html 里必须有 #dirRing');
  assert.ok(/class="dir-ring"/.test(html), '#dirRing 要带 .dir-ring');

  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stBase('playing', { direction: 1 }) });
  assert.ok(!r.getEl('#dirRing').classList.contains('ccw'), 'direction=1 不应挂 ccw');

  r.socket.fire('state', stBase('playing', { direction: -1 }));
  assert.ok(r.getEl('#dirRing').classList.contains('ccw'), 'direction=-1 必须挂 ccw（否则环会朝反方向空转）');

  r.socket.fire('state', stBase('playing', { direction: 1 }));
  assert.ok(!r.getEl('#dirRing').classList.contains('ccw'), '再转回顺时针时要把 ccw 摘掉');

  // 幂等：同一份 st 重复到达（重连 / 服务端重播 / 接力接管都会这样）。
  // 方向没变时绝不能碰 ccw —— 摘掉会让 dirSpin 当场换向、再挂回去又是从 0° 重播，
  // 真机上看就是环「抖一下角度」。state 每个动作都会来一次，一旦重挂，
  // 这根本该匀速空转的环就变成一直在抽搐的装饰。
  const ring = r.getEl('#dirRing');
  const touched = [];
  const rawRemove = ring.classList.remove;
  ring.classList.remove = (c) => { if (c === 'ccw') touched.push('remove'); return rawRemove(c); };

  r.socket.fire('state', stBase('playing', { direction: 1 })); // 与当前同一份方向
  assert.ok(!ring.classList.contains('ccw'), '前置：这一帧仍是顺时针');
  assert.deepStrictEqual(touched, [], '重复 state 不得摘 ccw —— 摘了就要重挂，空转动画从头播');

  // 护栏不能连正常功能一起拦掉：方向真的变了，该类还得照挂
  r.socket.fire('state', stBase('playing', { direction: -1 }));
  assert.ok(ring.classList.contains('ccw'), '方向真的翻过来时必须挂上 ccw');
  assert.deepStrictEqual(touched, [], '正常翻转不需要先摘再加，直接 toggle 即可');

  // 逆时针下重复同样不许动（两个方向都钉死，别只测一半）
  touched.length = 0;
  r.socket.fire('state', stBase('playing', { direction: -1 }));
  r.socket.fire('state', stBase('playing', { direction: -1 }));
  assert.ok(ring.classList.contains('ccw'), '前置：仍是逆时针');
  assert.deepStrictEqual(touched, [], '逆时针下重复 state 同样不得摘 ccw');
});

/* ================= 场景 22：★反转只播一次，且能连着播 ================= */
test('★direction 变化播一次反转动画；同一份 direction 重复到达绝不重播', () => {
  const r = makeRig({ timers: true });
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stBase('playing', { direction: 1 }) });
  assert.ok(!r.getEl('#dirRing').classList.contains('flip'), '入场帧（prev 为空）不该播反转');

  // 监听 classList 的增删：CSS 动画要「从头播」必须先把类名摘掉再重排再加，
  // 只 add 不 remove 的话，浏览器会把第二次当成「无变化」，动画不重播（真机上看就是第二张
  // 2·反转 什么也没发生）。假 DOM 里没有动画引擎，只能盯住这个「先摘后加」的约定。
  const ring = r.getEl('#dirRing');
  const seq = [];
  const rawRemove = ring.classList.remove;
  const rawAdd = ring.classList.add;
  ring.classList.remove = (c) => { if (c === 'flip') seq.push('remove'); return rawRemove(c); };
  ring.classList.add = (c) => { if (c === 'flip') seq.push('add'); return rawAdd(c); };

  r.socket.fire('state', stBase('playing', { direction: -1 }));
  assert.ok(ring.classList.contains('flip'), '1 → -1 必须播一次反转动画');
  assert.deepStrictEqual(seq, ['remove', 'add'], '首次反转应是「先摘后加」各一次');

  // 等动画播完、类名被摘掉，再让同一份 direction 重发一遍
  r.timers.advance(600);
  assert.ok(!ring.classList.contains('flip'), '前置：460ms 后 flip 应已被摘掉');
  const seqAfterTimer = seq.slice(); // 定时器摘类名会多一个 remove，连同它一起记下来

  r.socket.fire('state', stBase('playing', { direction: -1 }));
  assert.ok(!ring.classList.contains('flip'), '方向没变（重连/重播/接管）就绝不重复播');
  assert.deepStrictEqual(seq, seqAfterTimer, '重复 state 不得再动 flip 一次');

  // 真·第二次反转：必须重新走一遍「先摘后加」，动画才能从头播
  r.socket.fire('state', stBase('playing', { direction: 1 }));
  assert.ok(ring.classList.contains('flip'), '连续第二次反转也要看得见（不能只播第一次）');
  assert.deepStrictEqual(seq.slice(-2), ['remove', 'add'],
    '第二次反转必须先把 flip 摘掉再加（否则浏览器不会重播同名动画）');
});

/* ================= 场景 23：★减弱动效 —— 不动但仍有方向 ================= */
test('★减弱动效：环不播反转、不建冲击节点，但方向类名照样正确', () => {
  const r = makeRig({ reducedMotion: true });
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stPlay(C4, 1) });

  r.socket.fire('state', stPlay(C6, 2, { direction: -1 }));
  assert.ok(!r.getEl('#dirRing').classList.contains('flip'), '减弱动效时不得挂反转动画标记');
  assert.ok(r.getEl('#dirRing').classList.contains('ccw'), '方向类名必须照挂 —— 静态箭头是唯一的方向提示');
  assert.strictEqual(r.getEl('#fx').children.length, 0, '顺带：减弱动效下压制 FX 仍应是 0 节点');
});

/* ================= 场景 24：层级与点击穿透（静态读 CSS） ================= */
test('★方向环层级：z-index 低于 .event-log 与 #fx，且 pointer-events: none', () => {
  const ring = cssRule('.dir-ring');
  assert.ok(ring, 'style.css 里找不到 .dir-ring 规则');

  assert.ok(/pointer-events\s*:\s*none/.test(ring), '环必须 pointer-events:none，否则会吃掉门槛牌的点击与 hover');
  assert.ok(/top\s*:\s*var\(--fx-card-top/.test(ring) && /height\s*:\s*var\(--fx-card-h/.test(ring),
    '环要贴在「卡牌带」上（与 #fx 同一套变量），才能正好扣住门槛牌');

  const ringZ = cssInt(ring, 'z-index');
  const logZ = cssInt(cssRule('.event-log'), 'z-index');
  const fxZ = cssInt(cssRule('#fx'), 'z-index');
  assert.ok(Number.isFinite(ringZ), '.dir-ring 必须显式写 z-index（负层级是「落在牌之下」的保证）');
  assert.ok(Number.isFinite(logZ) && Number.isFinite(fxZ), '前置：.event-log 与 #fx 都该有显式 z-index');
  assert.ok(ringZ < logZ, `环(${ringZ}) 必须低于 .event-log(${logZ})，否则会糊住日志文字`);
  assert.ok(ringZ < fxZ, `环(${ringZ}) 应低于冲击波层 #fx(${fxZ})，压制特效要盖在环之上`);
});
