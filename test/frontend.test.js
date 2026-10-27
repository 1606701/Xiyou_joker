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
  const el = {
    __sel: sel,
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
    addEventListener() {},
  };
  el.firstElementChild = null;
  return el;
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
