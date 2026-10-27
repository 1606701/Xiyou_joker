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
    appendChild(c) { el.children.push(c); return c; },
    addEventListener(evt, cb) {
      if (!handlers.has(evt)) handlers.set(evt, []);
      handlers.get(evt).push(cb);
    },
  };
  el.firstElementChild = null;
  return el;
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
 */
function makeRig() {
  const els = new Map();
  const getEl = (sel) => {
    if (!els.has(sel)) els.set(sel, makeEl(sel));
    return els.get(sel);
  };
  for (const id of ['view-home', 'view-room', 'view-game', 'view-settle', 'roomInfo', 'toast', 'nickname']) {
    getEl(`#${id}`);
  }
  // 与 public/index.html 的初始 class 对齐：两个 AI 按钮出厂就是 hidden（`.btn.hidden`）。
  // 必须先播下这个初始态，否则「房主应看到按钮」在「根本没实现」的版本上也会假绿 ——
  // 假 DOM 里新元素天生不带 class，不播种就分不清「显式显示」与「从未处理」。
  getEl('#btnAddAI').classList.add('hidden');
  getEl('#btnRemoveAI').classList.add('hidden');

  const warnings = [];
  const sandbox = {
    console: {
      log: () => {},
      warn: (...a) => warnings.push(a.join(' ')),
      error: (...a) => warnings.push(`ERROR ${a.join(' ')}`),
    },
    setTimeout, clearTimeout, Promise, Map, Set, JSON, String, Object, Array, Math, Date,
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

