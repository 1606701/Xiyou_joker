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
  const attrs = {};           // setAttribute 的落点（显示偏好要写 meta[theme-color].content）
  const el = {
    __sel: sel,
    __handlers: handlers,
    __attrs: attrs,
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
    // 真实 DOM 一定有。显示偏好会给 <html> 写 data-theme、给 meta[theme-color]
    // 写 content；假 DOM 没有 attribute 存储层，统一记到 __attrs 供断言读回。
    // 保留「可删除」这一点：兼容性用例会故意删掉它，验证 app.js 的存在性守卫。
    setAttribute(name, value) { attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
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
 *
 * 可选 patch 会合并进事件对象：设置面板「点遮罩空白处关闭」判的是
 * e.target === panel，而默认事件没有 target，所以必须能显式带一个进来。
 */
function click(el, patch) {
  const hs = (el.__handlers && el.__handlers.get('click')) || [];
  const e = Object.assign({ preventDefault() {} }, patch || {});
  for (const h of hs) h(e);
  return hs.length > 0;
}

/**
 * 造一套全新的运行时环境（每个用例一套，互不干扰）。
 * 注意：故意**不提供** document.body / getBoundingClientRect / requestAnimationFrame ——
 * 动效代码必须能在没有布局能力的环境里安全跳过，这里顺带把这条约束钉住。
 *
 * @param {{timers?: boolean, reducedMotion?: boolean, storage?: Map|object, noLocalStorage?: boolean, throwOnSet?: boolean}} [opts]
 *   timers         注入可推进的假定时器（默认用真实 setTimeout）
 *   reducedMotion  提供 window.matchMedia，且 (prefers-reduced-motion: reduce) 命中
 *   storage        共享一份 localStorage 底层 Map（或另一个 rig 的 storage 对象），
 *                  用于「刷新后偏好仍生效」；不传则每个 rig 独享一份空 Map
 *   noLocalStorage 故意不注入 localStorage，覆盖 app.js 的 typeof 存在性守卫
 *   throwOnSet     localStorage 存在、但 setItem 抛 QuotaExceededError（配额满/隐私模式），
 *                  覆盖 app.js prefWrite 的 catch 分支：落盘失败只该影响「下次记不记得」
 *   session        整体替换 sessionStorage 对象（默认是 Map 实现）。用于让某个方法抛
 *                  SecurityError，模拟「站点存储被整体禁用」。
 *   sessionMap     共享一份 sessionStorage 底层 Map，用于「刷新后自动 rejoin」断言。
 *   sessionGetterThrows 更真实的禁用模式：**访问 sessionStorage 属性本身就抛** SecurityError。
 *                  注意宿主的 sandbox 上放 accessor 再 contextify 不会转发（等价于属性不存在），
 *                  所以这种模式必须在 vm 内部对 globalThis 定义（见 makeRig 里 createContext 之后）。
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
  // 同理：设置面板在 index.html 里是 class="overlay hidden"。不播种的话，
  // 「点开面板」在「根本没绑定 #btnSettings」的版本上也会假绿（新元素天生不带 class）。
  getEl('#view-settings').classList.add('hidden');

  const timers = opts.timers ? makeTimers() : null;
  const warnings = [];

  /* ---- 显示偏好（字号 / 主题）所需的 DOM 能力 ----
   * applyPrefs() 要给 <html> 写 data-theme 与 --fs、给 meta[theme-color] 写 content，
   * 还要读 localStorage。之前假 DOM 只有 sessionStorage、没有 documentElement，
   * 于是 applyPrefs 被 guard 全部跳过 —— 185 条全量用例对这两个属性零覆盖。
   * 这里补齐，并把每次写入记到可观察对象上，断言才能读回「到底写没写」。
   */
  const rootAttrs = {};
  const rootVars = {};
  const documentElement = {
    __attrs: rootAttrs,
    __vars: rootVars,
    setAttribute(name, value) { rootAttrs[name] = String(value); },
    style: {
      __vars: rootVars,
      setProperty(name, value) { rootVars[name] = String(value); },
    },
  };

  // 与 sessionStorage 同形状的 Map 实现。opts.storage 可传 Map，也可传另一个 rig
  // 的 storage 对象（含 __map）：两个 rig 共享同一份底层 Map 即等价于「刷新页面」。
  const storeMap = opts.storage instanceof Map
    ? opts.storage
    : (opts.storage && opts.storage.__map instanceof Map ? opts.storage.__map : new Map());
  const localStorage = {
    __map: storeMap,
    getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
    // throwOnSet：模拟 setItem 抛异常但 storage 对象本身存在（与「整个 localStorage 缺失」不同）
    setItem: (k, v) => {
      if (opts.throwOnSet) throw new Error('QuotaExceededError');
      storeMap.set(k, String(v));
    },
    removeItem: (k) => { storeMap.delete(k); },
    clear: () => { storeMap.clear(); },
  };

  /* ---- sessionStorage：会话凭证（roomCode / playerId / rejoinToken） ----
   * 默认 Map 实现；opts.session 可整体替换，用来让 getItem/setItem/removeItem/clear
   * 单独抛 SecurityError（站点存储被整体禁用时，连读属性都会抛）。
   * **绝不用 Storage.prototype 覆盖来模拟** —— localStorage 与 sessionStorage 共用原型，
   * 那样会连带打掉另一端（真浏览器验收被这个坑过一次）。这里始终是独立普通对象。
   */
  const sessMap = opts.sessionMap instanceof Map ? opts.sessionMap : new Map();
  const sessionStorage = opts.session || {
    __map: sessMap,
    getItem: (k) => (sessMap.has(k) ? sessMap.get(k) : null),
    setItem: (k, v) => { sessMap.set(k, String(v)); },
    removeItem: (k) => { sessMap.delete(k); },
    clear: () => sessMap.clear(),
  };

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
    fetch: async () => ({ ok: true, json: async () => ({ names: { 4: '小妖' }, rankShow: { SJ: '小王' } }) }),
    document: {
      documentElement,
      querySelector: (sel) => getEl(sel),
      createElement: () => makeEl('created'),
      addEventListener: (evt, cb) => { if (evt === 'DOMContentLoaded') sandbox.__domReady = cb; },
    },
  };
  // 默认注入 localStorage —— 这一步让 applyPrefs() 在所有用例里真的执行，
  // 而不是被 typeof 守卫静默跳过。noLocalStorage 用例才故意不注入。
  // 必须在 vm.createContext 之前挂上，否则沙箱里 typeof localStorage 永远是 undefined。
  if (!opts.noLocalStorage) sandbox.localStorage = localStorage;
  // sessionStorage 默认作为普通数据属性注入 —— contextify 会正常转发数据属性。
  // sessionGetterThrows 时故意不在这里放，改在 vm 内 defineProperty（见 createContext 之后）。
  if (!opts.sessionGetterThrows) sandbox.sessionStorage = sessionStorage;
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
  // 「访问 sessionStorage 属性本身就抛」= 真实浏览器禁用站点存储时的行为。
  // 坑：把 accessor 放在宿主的 sandbox 对象上再 contextify **不会转发**，
  // vm 内只会看到「属性不存在」（typeof === 'undefined'），模拟不出 getter 抛。
  // 正确做法：在 vm 内部对 globalThis 定义 accessor —— 已声明且 getter 抛时，typeof 会传播异常。
  if (opts.sessionGetterThrows) {
    vm.runInContext(
      "Object.defineProperty(globalThis, 'sessionStorage', {" +
      "  configurable: true," +
      "  get() { const e = new Error('blocked'); e.name = 'SecurityError'; throw e; }" +
      "});",
      sandbox);
  }
  vm.runInContext(SRC, sandbox, { filename: APP });
  sandbox.__domReady(); // 等价于 DOMContentLoaded：bindEvents + loadCardNames + connectSocket

  return {
    socket,
    getEl,
    warnings,
    click,
    timers,
    // 显示偏好的观察口：root 是 documentElement（__attrs / style.__vars），
    // storage 是 localStorage 的读写 API（__map 是底层 Map，可传给另一个 rig 共享）。
    root: documentElement,
    storage: localStorage,
    sessionStorage,
    sessionMap: sessMap,
    // 直接检查 vm 内注入是否真的生效（例如 getter 抛时 typeof 应抛异常），
    // 用来排除「用例因属性不存在而变红/变绿」的假覆盖。
    probe: (code) => vm.runInContext(code, sandbox, { filename: 'probe.js' }),
    themeAttr: () => rootAttrs['data-theme'],
    fsVar: () => rootVars['--fs'],
    metaColor: () => getEl('meta[name="theme-color"]').__attrs.content,
    fsOn: (v) => getEl(`#fsRow .btn[data-fs="${v}"]`).classList.contains('on'),
    themeOn: (t) => getEl(`#themeRow .btn[data-theme-choice="${t}"]`).classList.contains('on'),
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
  // 终局账目：1 + 3 + 4 = 8 张败牌 + 46 张未发 = 54。给非 0 值才有区分度
  drawPileRemainder: 46,
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


/* ================= 场景 3b：终局账目脚注 —— 「败牌合计 + 未发 = 54」必须闭合 ================= */
test('★结算脚注：败牌合计 + 未发牌数 = 54 的账目必须写出来（否则玩家看到一个对不上的总数）', () => {
  const r = makeRig();
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stBase('playing') });

  // gameEnd 带 drawPileRemainder：脚注要写「合计 8 + 未发 46 = 54」
  r.socket.fire('gameEnd', {
    results: LAST_RESULT.results,
    winnerIds: ['p1'],
    winnerName: '八戒',
    drawPileRemainder: 46,
  });
  const foot = String(r.getEl('#settleFoot').textContent);
  assert.ok(foot.includes('合计 8 张'), `脚注应写「全场败牌合计 8 张」：实际「${foot}」`);
  assert.ok(foot.includes('46'), `脚注应写未发 46 张：实际「${foot}」`);
  assert.ok(foot.includes('54'), `脚注要把账闭合到 54：实际「${foot}」`);

  // 摸牌堆正好发完：脚注要说「全部打完」，而不是显示「未发 0 张」
  r.socket.fire('gameEnd', {
    results: [{ id: 'p0', name: '悟空', penaltyCount: 54 }],
    winnerIds: ['p0'],
    winnerName: '悟空',
    drawPileRemainder: 0,
  });
  const foot2 = String(r.getEl('#settleFoot').textContent);
  assert.ok(foot2.includes('= 54'), `未发为 0 时应写「合计 54 张 = 54」：实际「${foot2}」`);
  assert.ok(!foot2.includes('未发'), `未发为 0 时不应再出现「未发」字样：实际「${foot2}」`);

  // 老版本 state（重连到还没加这个字段的服务端）：脚注必须静默为空，不得显示 undefined
  r.socket.fire('gameEnd', { results: LAST_RESULT.results, winnerIds: ['p1'], winnerName: '八戒' });
  assert.strictEqual(String(r.getEl('#settleFoot').textContent), '',
    '拿不到 drawPileRemainder 时脚注应为空串，而不是把 undefined 渲染给玩家');
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

/* ================= 场景 25：收牌 / 放弃出牌按钮（W4-ENG-RULE02） ================= */
test('★放弃出牌按钮：桌面有牌就出现；有牌可出时必须点两下才真的发出去', () => {
  const r = makeRig();
  const hand = [{ id: 'c1', rank: '6', suit: '♠', kind: 'monster' }];
  const pickUps = () => r.socket.emitted.filter((e) => e.evt === 'pickUp').length;
  r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk', state: stPlay(null, 0, { hand }) });
  const btn = r.getEl('#btnPickup');

  // ① 桌面为空：按钮不出现。引擎那边也会抛 NOTHING_TO_PICK —— 按钮先挡住，别让人点了才被拒。
  r.socket.fire('yourTurn', { legalMoves: { opening: true, beats: [['c1']], actions: [] }, deadline: Date.now() + 30000 });
  assert.ok(btn.classList.contains('hidden'), '桌面为空时不该出现收牌按钮（空桌面收牌会变成无限刷手牌）');

  // ② 有牌可出 + 桌面 2 张：出现，且是「主动放弃」的两步确认
  r.socket.fire('state', stPlay(C4, 2, { hand }));
  assert.ok(!btn.classList.contains('hidden'), '桌面有牌时按钮必须出现（旧的实现只在无牌可出时显示）');
  assert.match(btn.textContent, /放弃出牌/, `有牌可出时应说「放弃」而不是「收牌」，实际：${btn.textContent}`);
  assert.match(btn.textContent, /2/, '文案要把代价（桌面张数）写出来');

  click(btn);
  assert.strictEqual(pickUps(), 0, '第一下只进入确认态，不得发出 pickUp');
  assert.match(btn.textContent, /确认放弃/, `第一下后必须变成确认文案，实际：${btn.textContent}`);

  click(btn);
  assert.strictEqual(pickUps(), 1, '第二下才真的发出去');

  // ③ 无牌可出 + 桌面 3 张：本来就没得选，不搞两步，点一下即发
  r.socket.fire('state', stPlay(C4, 3, { hand }));
  r.socket.fire('yourTurn', { legalMoves: { opening: false, beats: [], actions: [] }, deadline: Date.now() + 30000 });
  assert.ok(!btn.classList.contains('hidden'), '无牌可出时按钮当然要在');
  assert.match(btn.textContent, /收牌/, `无牌可出时应说「收牌」，实际：${btn.textContent}`);
  const before = pickUps();
  click(btn);
  assert.strictEqual(pickUps(), before + 1, '无牌可出时不该再要一次确认 —— 那只会让人多点一下');
});

/* ============================================================
 * 显示设置：字号 / 明亮主题（2026-11-07 用户反馈 · W4-QA-DISPLAY）
 *
 * 这一层以前是零覆盖：假 DOM 没有 documentElement / localStorage，
 * applyPrefs() 里的守卫把整个函数跳过了 —— 页面照常渲染、控制台零报错，
 * 但「--fs / data-theme 到底写没写」从来没人验过。makeRig 补齐这两样之后，
 * 下面的断言才是真的在跑那段代码。
 *
 * 阴性对照请把 FE_APP 指向做过 targeted mutation 的 app.js 副本：
 *   M1 删 root.style.setProperty('--fs', fs)   → 字号断言必须红
 *   M2 删 root.setAttribute('data-theme', ...) → 主题断言必须红
 *   M3 删 #btnSettings 的 click 绑定            → 打开面板断言必须红
 * ============================================================ */

const FS_VALUES = ['0.92', '1', '1.18', '1.36'];
const THEME_VALUES = ['light', 'night'];

// 默认读 public/style.css；设 FE_CSS 可指向工作区外的变异副本，用于静态断言的阴性对照。
// 与文件头 FE_APP 同一套纪律：阴性对照绝不改共享工作区里的 public/。
const CSS_FILE = process.env.FE_CSS
  ? path.resolve(process.env.FE_CSS)
  : path.join(__dirname, '..', 'public', 'style.css');

// 同理：设 FE_HTML 可指向工作区外副本，用于「首屏内联脚本 ↔ app.js 常量」一致性护栏的阴性对照。
const HTML_FILE = process.env.FE_HTML
  ? path.resolve(process.env.FE_HTML)
  : path.join(__dirname, '..', 'public', 'index.html');

/** 读 style.css 并剥注释：注释里的示例规则/花括号会污染静态匹配（见场景 17） */
function prefCssBare() {
  return fs.readFileSync(CSS_FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/* ================= 场景 26：默认态 ================= */
test('★显示偏好默认态：明亮 + 标准字号，选中态落在 1 / light，面板仍隐藏', () => {
  const r = makeRig();
  assert.strictEqual(r.themeAttr(), 'light', '未存过偏好时 data-theme 必须是 light（用户反馈「太暗」的默认解）');
  assert.strictEqual(r.fsVar(), '1', '未存过偏好时 --fs 必须是 1（标准字号）');
  assert.strictEqual(r.metaColor(), '#F1EDE4', 'meta[theme-color] 默认走明亮色');
  assert.ok(r.hidden('view-settings'), '设置面板出厂必须隐藏，不能一进页面就盖住牌桌');

  assert.ok(r.fsOn('1'), '「标准」按钮应带 on');
  for (const v of FS_VALUES.filter((x) => x !== '1')) {
    assert.ok(!r.fsOn(v), `字号 ${v} 不该带 on（默认只选一个）`);
  }
  assert.ok(r.themeOn('light'), '「明亮」按钮应带 on');
  assert.ok(!r.themeOn('night'), '「夜局」按钮默认不该带 on');

  assert.strictEqual(r.storage.getItem('xyj.theme'), null, '默认态不该往 localStorage 写任何东西');
  assert.strictEqual(r.storage.getItem('xyj.fs'), null, '默认态不该往 localStorage 写任何东西');
});

/* ================= 场景 27：面板开关 + 遮罩空白处 ================= */
test('★显示设置面板：设按钮打开 / 好了关闭 / 点遮罩空白处关闭（点面板内部不关）', () => {
  const r = makeRig();
  const panel = r.getEl('#view-settings');
  const open = r.getEl('#btnSettings');
  const close = r.getEl('#btnCloseSettings');

  assert.ok(click(open), '#btnSettings 必须绑定 click（否则设置入口是死的）');
  assert.ok(r.visible('view-settings'), '点「设」后面板必须显示');

  assert.ok(click(close), '#btnCloseSettings 必须绑定 click');
  assert.ok(r.hidden('view-settings'), '点「好了」后面板必须重新隐藏');

  // 点遮罩空白处：app.js 判的是 e.target === panel，默认 click() 不带 target，
  // 必须显式带进来才能覆盖这条路径。
  click(open);
  assert.ok(r.visible('view-settings'), '前置：面板再次打开');
  click(panel, { target: panel });
  assert.ok(r.hidden('view-settings'), '点遮罩空白处必须关闭面板');

  // 反向护栏：点在面板内部的按钮上不能误关，否则一点字号面板就消失，根本调不了。
  click(open);
  click(panel, { target: r.getEl('#fsRow .btn[data-fs="1.18"]') });
  assert.ok(r.visible('view-settings'), '点在面板内部不得关闭面板');
});

/* ================= 场景 28：字号「大」 ================= */
test('★字号「大」：--fs 与 localStorage 同步为 1.18，四档选中态互斥', () => {
  const r = makeRig();
  assert.ok(click(r.getEl('#fsRow .btn[data-fs="1.18"]')), '「大」按钮必须绑定 click');

  assert.strictEqual(r.fsVar(), '1.18', '点「大」后 <html> 的 --fs 必须变成 1.18');
  assert.strictEqual(r.storage.getItem('xyj.fs'), '1.18', '字号要写进 localStorage，刷新才记得住');
  assert.ok(r.fsOn('1.18'), '1.18 按钮应带 on');
  assert.ok(!r.fsOn('1'), '原来的「标准」必须摘掉 on（四档互斥，不能两个都亮）');
  assert.ok(!r.fsOn('0.92') && !r.fsOn('1.36'), '其余两档也不该带 on');

  // 换到「特大」再验一次互斥，防止实现只写死处理了 1.18
  click(r.getEl('#fsRow .btn[data-fs="1.36"]'));
  assert.strictEqual(r.fsVar(), '1.36', '「特大」应生效');
  assert.strictEqual(r.storage.getItem('xyj.fs'), '1.36', '「特大」也要写进 localStorage');
  assert.ok(r.fsOn('1.36') && !r.fsOn('1.18'), '切档后旧档位必须摘 on');

  // 字号切换不得顺手改主题
  assert.strictEqual(r.themeAttr(), 'light', '只调字号时主题应保持不变');
  assert.strictEqual(r.metaColor(), '#F1EDE4', '只调字号时 meta 颜色应保持不变');
});

/* ================= 场景 29：主题「夜局」 ================= */
test('★主题「夜局」：data-theme / meta 颜色 / localStorage 三处同步，选中态互斥', () => {
  const r = makeRig();
  assert.ok(click(r.getEl('#themeRow .btn[data-theme-choice="night"]')), '「夜局」按钮必须绑定 click');

  assert.strictEqual(r.themeAttr(), 'night', 'data-theme 必须变成 night');
  assert.strictEqual(r.metaColor(), '#0B1D18', '夜局下 meta[theme-color] 要切到深墨绿（浏览器地址栏同步）');
  assert.strictEqual(r.storage.getItem('xyj.theme'), 'night', '主题要写进 localStorage');
  assert.ok(r.themeOn('night'), '「夜局」按钮应带 on');
  assert.ok(!r.themeOn('light'), '「明亮」必须摘掉 on（两档互斥）');

  // 切回明亮：三处都要复位，别只改一半
  click(r.getEl('#themeRow .btn[data-theme-choice="light"]'));
  assert.strictEqual(r.themeAttr(), 'light', '切回明亮后 data-theme 复位');
  assert.strictEqual(r.metaColor(), '#F1EDE4', '切回明亮后 meta 颜色复位');
  assert.strictEqual(r.storage.getItem('xyj.theme'), 'light', '切回明亮后 localStorage 复位');
  assert.ok(r.themeOn('light') && !r.themeOn('night'), '复位后「明亮」重新带 on');
});

/* ================= 场景 30：刷新持久化 ================= */
test('★刷新持久化：同一份 localStorage 的新 rig 启动即是大字号 + 夜局', () => {
  const r1 = makeRig();
  click(r1.getEl('#fsRow .btn[data-fs="1.18"]'));
  click(r1.getEl('#themeRow .btn[data-theme-choice="night"]'));
  assert.strictEqual(r1.storage.getItem('xyj.fs'), '1.18', '前置：第一页已存下字号');
  assert.strictEqual(r1.storage.getItem('xyj.theme'), 'night', '前置：第一页已存下主题');

  // 共享同一份底层 Map = 同一个浏览器 profile 刷新页面
  const r2 = makeRig({ storage: r1.storage });
  assert.strictEqual(r2.storage.__map, r1.storage.__map, '两个 rig 必须真的共享同一份 Map');
  assert.strictEqual(r2.fsVar(), '1.18', '刷新后 --fs 直接是 1.18，不等用户再点');
  assert.strictEqual(r2.themeAttr(), 'night', '刷新后 data-theme 直接是 night');
  assert.strictEqual(r2.metaColor(), '#0B1D18', '刷新后 meta 颜色也要跟着走');
  assert.ok(r2.fsOn('1.18') && !r2.fsOn('1'), '刷新后字号选中态落在 1.18');
  assert.ok(r2.themeOn('night') && !r2.themeOn('light'), '刷新后主题选中态落在 night');
  assert.ok(r2.hidden('view-settings'), '刷新不该顺手把设置面板弹出来');
});

/* ================= 场景 31：脏值回落 ================= */
test('★脏值回落：storage 里的 neon / 99 不得让页面落到白名单外', () => {
  const shared = new Map([['xyj.theme', 'neon'], ['xyj.fs', '99']]);
  const r = makeRig({ storage: shared });

  assert.strictEqual(r.themeAttr(), 'light', '非法主题必须回落到 light');
  assert.strictEqual(r.fsVar(), '1', '非法字号必须回落到 1');
  assert.strictEqual(r.metaColor(), '#F1EDE4', '回落后的 meta 颜色也按 light 算');
  assert.ok(r.fsOn('1'), '选中态必须落在「标准」，不能四档一个都不亮');
  assert.ok(!r.fsOn('0.92') && !r.fsOn('1.18') && !r.fsOn('1.36'), '其余字号档位都不得带 on');
  assert.ok(r.themeOn('light') && !r.themeOn('night'), '选中态必须落在「明亮」');
});

/* ================= 场景 32：兼容守卫 a —— 无 localStorage ================= */
test('★兼容守卫 a：没有 localStorage（隐私模式）时启动不抛，且回落到默认', () => {
  let r;
  assert.doesNotThrow(() => { r = makeRig({ noLocalStorage: true }); },
    'localStorage 缺失时 applyPrefs 不得抛错把整页带崩');
  assert.strictEqual(r.themeAttr(), 'light', '读不到存储时主题回落 light');
  assert.strictEqual(r.fsVar(), '1', '读不到存储时字号回落 1');
  assert.strictEqual(r.metaColor(), '#F1EDE4', '读不到存储时 meta 仍是明亮色');
  assert.ok(r.fsOn('1') && r.themeOn('light'), '选中态照样落在标准 / 明亮');
});

/* ================= 场景 33：兼容守卫 b —— meta 无 setAttribute ================= */
test('★兼容守卫 b：meta[theme-color] 没有 setAttribute 时切换偏好不抛', () => {
  const r = makeRig();
  const mc = r.getEl('meta[name="theme-color"]');
  mc.setAttribute('content', 'SENTINEL');  // 哨兵：后面若被调用就会被改掉
  delete mc.setAttribute;                  // 模拟极简环境：元素存在但没有这个 API

  // 用字号按钮触发 applyPrefs（不依赖 #btnSettings，避免与 M3 变异混淆）
  assert.doesNotThrow(() => click(r.getEl('#fsRow .btn[data-fs="1.18"]')),
    'mc.setAttribute 缺失时 applyPrefs 必须跳过而不是抛错');
  assert.strictEqual(mc.__attrs.content, 'SENTINEL',
    'setAttribute 缺失时应整段跳过，不得试着去写 content');
});

/* ================= 场景 34：打开面板时先 applyPrefs ================= */
test('★打开面板时先 applyPrefs：外部改了 storage，点开设置选中态要跟着走', () => {
  const r = makeRig();
  assert.ok(r.fsOn('1'), '前置：启动时的选中态是「标准」');

  // 模拟另一个标签页 / 手工改了 localStorage：本页内存里还是旧值
  r.storage.setItem('xyj.fs', '1.36');
  r.storage.setItem('xyj.theme', 'night');
  assert.ok(r.fsOn('1'), '光改 storage 不会自己重绘（本用例不要求自动同步）');

  click(r.getEl('#btnSettings'));
  assert.ok(r.visible('view-settings'), '面板应打开');
  assert.strictEqual(r.fsVar(), '1.36', '打开面板时 applyPrefs 要把 --fs 同步成 1.36');
  assert.strictEqual(r.themeAttr(), 'night', '打开面板时 applyPrefs 要把 data-theme 同步成 night');
  assert.strictEqual(r.metaColor(), '#0B1D18', 'meta 颜色也要同步');
  assert.ok(r.fsOn('1.36') && !r.fsOn('1'), '字号选中态跟着 storage 改到 1.36');
  assert.ok(r.themeOn('night') && !r.themeOn('light'), '主题选中态跟着 storage 改到 night');
});

/* ================= 场景 35：静态 CSS —— --fs 与明亮块 ================= */
test('★静态 CSS：:root 声明 --fs，且存在 :root[data-theme="light"] 明亮变量块', () => {
  const bare = prefCssBare();
  const rootBlock = bare.match(/:root\s*\{[^}]*\}/);
  assert.ok(rootBlock, 'style.css 里找不到 :root 规则块');
  assert.ok(/--fs\s*:\s*1\s*;/.test(rootBlock[0]),
    ':root 必须声明 --fs: 1（四档倍率的基准，缺了全部 calc() 都会失效）');

  const lightBlock = bare.match(/:root\[data-theme="light"\]\s*\{[^}]*\}/);
  assert.ok(lightBlock, 'style.css 里找不到 :root[data-theme="light"] 变量块（用户反馈「太暗」的修复落点）');
  assert.ok(/--bg\s*:\s*#F1EDE4/.test(lightBlock[0]),
    '明亮块必须把 --bg 换成米白 #F1EDE4，不能只是个空壳');
});

/* ================= 场景 36：静态 CSS —— 字号倍率不漏 ================= */
test('★静态 CSS：每一条 font-size 都走 calc(Npx * var(--fs))，倍率声明不少于 44 处', () => {
  const bare = prefCssBare();

  // 不要用 /font-size:\s*(?!calc)/ 这种 lookahead：\s* 能回溯到 0 个字符，
  // 此时 lookahead 看到的是空格而不是 calc，反而会在合规行上匹配成功
  // （实测 44 行全是假阳性）。正确做法是「把声明值整个抠出来再判断」。
  // 先剥注释，避免注释里的示例话术/花括号混进声明列表。
  const decls = [...bare.matchAll(/font-size\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());

  // ① 必须真的乘了倍率：只看 calc( 会放过 calc(17px + 1px) 这种「写了 calc 但没接 --fs」
  const noVar = decls.filter((v) => !v.includes('var(--fs)'));
  assert.deepStrictEqual(noVar, [],
    `这些 font-size 没有引用 var(--fs)，「设置 → 字体大小」对它们完全失效：${noVar.join(' | ')}`);

  // ② 严格格式：calc(<px 数值> * var(--fs))，含 calc(11.5px * ...) 这类小数
  const bad = decls.filter((v) => !/^calc\(\s*[\d.]+px\s*\*\s*var\(--fs\)\s*\)$/.test(v));
  assert.deepStrictEqual(bad, [], `calc 形式不合规（如写成变量、漏乘号）：${bad.join(' | ')}`);

  // ③ 实测 44 处 = 原有 41 处 + 设置面板 3 处（.pref-label / .pref-note / .pref-sample）。
  //    整段删掉倍率要在这里红。
  assert.ok(decls.length >= 44,
    `带倍率的 font-size 只剩 ${decls.length} 处（实测基线 44）—— 有人整段删掉了倍率`);
});

/* ================= 场景 37：静态 HTML —— 面板与按钮真的在页面里 ================= */
test('★静态 HTML：设置面板 / 四档字号 / 两档主题 / meta 默认色都真的在页面里', () => {
  const html = fs.readFileSync(HTML_FILE, 'utf8');
  // 假 DOM 的 querySelector 会自动补元素，光断言「拿得到」证明不了页面里真有这些节点。
  assert.ok(/id="view-settings"[^>]*class="overlay hidden"/.test(html),
    '#view-settings 必须出厂带 hidden（否则一进页面就被设置遮罩盖住）');
  assert.ok(/id="btnSettings"/.test(html), '入口按钮 #btnSettings 必须在');
  assert.ok(/id="btnCloseSettings"/.test(html), '关闭按钮 #btnCloseSettings 必须在');
  assert.ok(/<meta\s+name="theme-color"\s+content="#F1EDE4"/.test(html),
    'meta[theme-color] 默认必须是明亮色 #F1EDE4（首屏之前就不该闪深色）');
  for (const v of FS_VALUES) {
    assert.ok(html.includes(`data-fs="${v}"`), `#fsRow 缺少 data-fs="${v}" 按钮`);
  }
  for (const t of THEME_VALUES) {
    assert.ok(html.includes(`data-theme-choice="${t}"`), `#themeRow 缺少 data-theme-choice="${t}" 按钮`);
  }
});

/* ================= 场景 38：静态 CSS —— 明亮主题补漏护栏 ================= */
/** 粗略相对亮度（0~1，sRGB 加权）；补漏块里这几条用的都是 6 位 #RRGGBB */
function hexLuminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

test('★静态 CSS：明亮主题补漏块还在 —— 金底必须用浅字，危险按钮默认态必须可辨', () => {
  const bare = prefCssBare();

  // 明亮主题把 --gold 压深成 #9C7418；夜局那套「亮金底 + 深墨绿字」在深琥珀上
  // 对比度约 1.5:1，主操作按钮 / 选中态 / 名次徽标会读不出来。
  // 这条规则是多选择器逗号分组，从 .btn.primary 起一直吃到第一个 { ... }。
  const goldRule = bare.match(/\[data-theme="light"\]\s*\.btn\.primary[\s\S]*?\{([^}]*)\}/);
  assert.ok(goldRule, '找不到 [data-theme="light"] .btn.primary 的补漏规则（金底深字被改回去了）');
  const colorHit = goldRule[1].match(/color:\s*(#[0-9a-fA-F]{6})/i);
  assert.ok(colorHit, '补漏规则里找不到明确的 color 声明');
  const lum = hexLuminance(colorHit[1]);
  assert.ok(lum > 0.7,
    `金底上的字必须是浅色，实测 ${colorHit[1]} 亮度 ${lum.toFixed(3)}（深字在深琥珀上读不出来）`);
  assert.ok(/#FFF8E7/i.test(goldRule[1]),
    `当前约定的浅字色是 #FFF8E7，实测 ${colorHit[1]} —— 若有意换色请同步更新本断言`);

  // 危险按钮默认态：夜局的浅粉 #E79A95 在白底上几乎看不见。
  // :not(.armed) 是为了不盖掉两步确认态的白字，选择器本身也要钉住。
  assert.ok(
    /\[data-theme="light"\]\s*\.btn\.danger:not\(\.armed\)\s*\{[^}]*color:\s*var\(--danger\)/.test(bare),
    '找不到 [data-theme="light"] .btn.danger:not(.armed) 的补漏规则（或颜色被改回浅粉）');
});

/* ================= 场景 38b：静态 CSS —— 非回合手牌亮度护栏 ================= */
// 用户反馈「特别是非自己回合的时候」暗沉，亲看截图定位到元凶不是整屏压暗，
// 而是 .hand .card.disabled 的 opacity 把整片手牌压灰（.5 时明显褪色）。
// 改动本身很小，但没有护栏就会被顺手改回去，所以把下限钉在这里。
test('★静态 CSS：非自己回合的手牌不得被压灰（.hand .card.disabled opacity ≥ 0.7）', () => {
  const bare = prefCssBare();
  const hit = bare.match(/\.hand\s+\.card\.disabled\s*\{([^}]*)\}/);
  assert.ok(hit, '找不到 .hand .card.disabled 规则（非回合手牌的禁用态样式被整条删了）');
  const op = hit[1].match(/opacity:\s*([0-9]*\.?[0-9]+)/);
  assert.ok(op, '规则里找不到 opacity 声明');
  const v = Number(op[1]);
  assert.ok(v >= 0.7,
    `非自己回合手牌 opacity=${v}，低于 0.7 会明显变灰；这是「非回合暗沉」反馈的主要观感来源`);
});

/* ================= 场景 39：P2 修复回归 —— 无 localStorage ================= */
// 修复前：prefWrite 在无 storage 时直接 return，applyPrefs 又重新从存储读回落默认，
// 于是刚点的值立刻被冲掉 —— 隐私/无痕模式下四个设置按钮全无反应（见 W4-QA-DISPLAY 报告）。
// 场景 32 只验「不抛 + 初始回落默认」；这里把「修好后本次会话必须生效」钉死。
test('★P2 回归：无 localStorage 时字号/主题本次会话仍生效，重开面板不回弹', () => {
  const r = makeRig({ noLocalStorage: true });
  // 修复只改「点击后」，首次进入的默认值必须原样保留（与场景 32 同一语义）
  assert.strictEqual(r.themeAttr(), 'light', '前置：启动态主题仍回落默认 light');
  assert.strictEqual(r.fsVar(), '1', '前置：启动态字号仍回落默认 1');
  assert.strictEqual(r.metaColor(), '#F1EDE4', '前置：启动态 meta 仍是明亮色');
  assert.doesNotThrow(() => click(r.getEl('#fsRow .btn[data-fs="1.18"]')), '无 storage 时点击不得抛');
  assert.strictEqual(r.fsVar(), '1.18', '无 storage 时点「大」也必须立刻生效（不能只是「不抛」）');
  assert.ok(r.fsOn('1.18') && !r.fsOn('1'), '选中态跟着本次会话值走');

  click(r.getEl('#themeRow .btn[data-theme-choice="night"]'));
  assert.strictEqual(r.themeAttr(), 'night', '无 storage 时点「夜局」也必须生效');
  assert.strictEqual(r.metaColor(), '#0B1D18', 'meta 颜色同步');
  assert.ok(r.themeOn('night') && !r.themeOn('light'), '主题选中态跟着走');

  // 打开面板会再次 applyPrefs()；修复前这一步会把会话内选择冲回默认。
  click(r.getEl('#btnSettings'));
  assert.strictEqual(r.fsVar(), '1.18', '重开设置面板不应把字号冲回 1');
  assert.strictEqual(r.themeAttr(), 'night', '重开设置面板不应把主题冲回 light');
});

/* ================= 场景 40：P2 修复回归 —— 落盘抛异常 ================= */
test('★P2 回归：localStorage.setItem 抛异常（配额满/隐私模式）时本次仍生效', () => {
  const r = makeRig({ throwOnSet: true });
  assert.ok(r.storage && typeof r.storage.getItem === 'function',
    '前置：localStorage 对象存在，只是 setItem 抛异常');
  assert.strictEqual(r.themeAttr(), 'light', '前置：启动态主题仍回落默认 light');
  assert.strictEqual(r.fsVar(), '1', '前置：启动态字号仍回落默认 1');
  assert.doesNotThrow(() => click(r.getEl('#fsRow .btn[data-fs="1.36"]')), '落盘失败不得把整页带崩');
  assert.strictEqual(r.fsVar(), '1.36', '落盘失败只该影响「下次还记不记得」，不该影响本次');
  assert.strictEqual(r.storage.getItem('xyj.fs'), null,
    '落盘失败时确实没写进 storage（符合「只是不记住」）');
  assert.ok(r.fsOn('1.36'), '选中态跟着本次会话值走');
  click(r.getEl('#themeRow .btn[data-theme-choice="night"]'));
  assert.strictEqual(r.themeAttr(), 'night', '主题同理');
});

/* ================= 场景 41：静态一致性 —— 首屏内联脚本 ↔ app.js ================= */
/** 把 "'a', 'b'" 这样的数组字面量拆成字符串数组 */
function parseStrList(s) {
  return s.split(',')
    .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
    .filter((x) => x.length > 0);
}

test('★静态一致性：index.html 首屏内联脚本的默认 theme/fs 与白名单，必须与 app.js 的 PREF_* 同源', () => {
  const html = fs.readFileSync(HTML_FILE, 'utf8');
  const hit = html.match(/<script>\s*([\s\S]*?)<\/script>/);
  assert.ok(hit, 'index.html 里找不到 head 首屏内联脚本');
  const inline = hit[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*/gm, '');

  // app.js 侧：SRC 就是 FE_APP 指向的那份源码，与本次跑的运行时同源。
  const appDefaults = SRC.match(/const PREF_DEFAULTS\s*=\s*\{\s*theme:\s*'([^']+)',\s*fs:\s*'([^']+)'\s*\}/);
  const appFs = SRC.match(/const PREF_FS_VALUES\s*=\s*\[([^\]]+)\]/);
  const appThemes = SRC.match(/const PREF_THEMES\s*=\s*\[([^\]]+)\]/);
  assert.ok(appDefaults && appFs && appThemes,
    'app.js 里 PREF_DEFAULTS / PREF_FS_VALUES / PREF_THEMES 必须齐全');

  // 内联脚本侧：默认值、storage 兜底值、theme 白名单、fs 白名单
  const inlineDefaults = inline.match(/var\s+theme\s*=\s*'([^']+)',\s*fs\s*=\s*'([^']+)'/);
  const inlineThemes = inline.match(/if\s*\(\s*theme\s*!==\s*'([^']+)'\s*&&\s*theme\s*!==\s*'([^']+)'/);
  const inlineFs = inline.match(/\[([^\]]+)\]\.indexOf\(fs\)/);
  const fbTheme = inline.match(/getItem\('xyj\.theme'\)\s*\|\|\s*'([^']+)'/);
  const fbFs = inline.match(/getItem\('xyj\.fs'\)\s*\|\|\s*'([^']+)'/);
  assert.ok(inlineDefaults && inlineThemes && inlineFs, '内联脚本的默认值 / 白名单写法变了，请同步更新本断言');
  assert.ok(fbTheme && fbFs, '内联脚本 storage 读空时的 || 兜底写法变了，请同步更新本断言');

  const defTheme = appDefaults[1], defFs = appDefaults[2];
  assert.deepStrictEqual([inlineDefaults[1], inlineDefaults[2]], [defTheme, defFs],
    '首屏内联脚本的 var theme/fs 默认值必须与 PREF_DEFAULTS 一致');
  assert.deepStrictEqual([fbTheme[1], fbFs[1]], [defTheme, defFs],
    '首屏内联脚本 storage 读空时的 || 兜底值也必须与 PREF_DEFAULTS 一致');
  assert.deepStrictEqual([inlineThemes[1], inlineThemes[2]], parseStrList(appThemes[1]),
    '首屏内联脚本的 theme 白名单必须与 PREF_THEMES 一致');
  assert.deepStrictEqual(parseStrList(inlineFs[1]), parseStrList(appFs[1]),
    '首屏内联脚本的 fs 白名单必须与 PREF_FS_VALUES 一致（含顺序）');
});

/* ============================================================
 * 会话凭证守卫（W5-QA-SESS01）
 *
 * 站点存储整体被禁用时，**访问 sessionStorage 属性本身**就会抛 SecurityError。
 * 致命的不是「丢凭证」，而是异常抛在处理器中间会截断后续逻辑：
 *   roomJoined 里 setItem 抛 → S.state/showView/renderRoom 全不执行 → 进了房间却停在首页
 *   roomClosed 里 clear() 抛 → toast 与 resetToHome 不执行 → 卡在已解散的房间
 *   resetToHome 里 removeItem 抛 → showView('view-home') 不执行 → 退不出房间
 *
 * 修前证据：FE_APP=<git HEAD 版 app.js>（10 处裸调）；
 * 修后：当前 public/app.js（sessGet/sessSet/sessRemove/sessClear 内部 try/catch）。
 * ============================================================ */

/** 构造「站点存储被禁用」时浏览器抛的异常（name=SecurityError） */
function blockedStorageError() {
  const e = new Error('blocked');
  e.name = 'SecurityError';
  return e;
}

/** 构造一个指定方法抛 SecurityError 的 sessionStorage stub（其余方法正常） */
function blockedSession(method) {
  const base = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };
  base[method] = () => { throw blockedStorageError(); };
  return base;
}

/* ================= 场景 42：roomJoined 的 setItem 抛 ================= */
test('★会话守卫：roomJoined 的 setItem 抛异常时不得截断视图切换（否则进了房间停在首页）', () => {
  const r = makeRig({ session: blockedSession('setItem') });
  const state = stBase('waiting');
  assert.doesNotThrow(
    () => r.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk-1', state }),
    'setItem 抛异常不得穿透 socket 事件处理器');
  // S 是沙箱内部状态，用渲染副作用间接断言「S.state 已赋值 + showView/renderRoom 执行过」
  assert.ok(r.visible('view-room'), '必须已切到房间面板（showView 不能被截断）');
  assert.ok(r.hidden('view-home'), '首页必须被隐藏');
  assert.ok(String(r.getEl('#roomInfo').textContent).includes('888'),
    `#roomInfo 应含房间码 888（证明 S.state 已赋值且 renderRoom 跑完）：实际「${r.getEl('#roomInfo').textContent}」`);
  assert.strictEqual(r.getEl('#playerList').children.length, 3, '玩家列表应渲染出 3 人');
  // sessSet 内置「只 warn 一次」：roomJoined 连续写 3 个 key 都失败，也只该有一条告警，不刷屏。
  const sessWarns = r.warnings.filter((w) => w.includes('会话存储不可用'));
  assert.strictEqual(sessWarns.length, 1, `setItem 失败应只 warn 一次（不刷屏），实际 ${sessWarns.length} 次`);
});

/* ================= 场景 43：roomClosed 的 clear() 抛 ================= */
test('★会话守卫：roomClosed 的 clear() 抛异常时仍要弹「房间已解散」并回首页', () => {
  const r = makeRig({ session: blockedSession('clear') });
  assert.doesNotThrow(() => r.socket.fire('roomClosed'),
    'clear() 抛异常不得把 toast 与 resetToHome 截断');
  assert.strictEqual(String(r.getEl('#toast').textContent), '房间已解散', 'toast 必须显示「房间已解散」');
  assert.ok(!r.getEl('#toast').classList.contains('hidden'), 'toast 不得处于 hidden');
  assert.ok(r.visible('view-home'), '必须回到首页');
  assert.ok(r.hidden('view-room'), '房间面板应隐藏');
});

/* ================= 场景 44：resetToHome 的 removeItem 抛 ================= */
test('★会话守卫：resetToHome 的 removeItem 抛异常时仍要切回首页', () => {
  const r = makeRig({ session: blockedSession('removeItem') });
  // 前置：模拟「当前停在房间视图」，再走 BAD_TOKEN + S.state 为空的自然路径
  r.getEl('#view-home').classList.add('hidden');
  r.getEl('#view-room').classList.remove('hidden');
  assert.doesNotThrow(() => r.socket.fire('error', { code: 'BAD_TOKEN' }),
    'removeItem 抛异常不得把 showView(view-home) 截断');
  assert.ok(r.visible('view-home'), '必须切回首页（否则退不出房间）');
  assert.ok(r.hidden('view-room'), '房间面板应隐藏');
});

/* ================= 场景 45：存储正常时行为不变（防回归） ================= */
test('★会话凭证正常路径：三凭证写入 / 刷新后自动 rejoin / 缺 token 时发空串', () => {
  // ① roomJoined 写入三个 key
  const r1 = makeRig();
  r1.socket.fire('roomJoined', { roomCode: '888', youId: 'p0', rejoinToken: 'tk-1', state: stBase('waiting') });
  assert.strictEqual(r1.sessionStorage.getItem('roomCode'), '888', 'roomCode 应写入');
  assert.strictEqual(r1.sessionStorage.getItem('playerId'), 'p0', 'playerId 应写入');
  assert.strictEqual(r1.sessionStorage.getItem('rejoinToken'), 'tk-1', 'rejoinToken 应写入');

  // ② 共享同一份 sessionStorage 底层 Map = 刷新页面；connect 时自动 rejoin
  const r2 = makeRig({ sessionMap: r1.sessionMap });
  r2.socket.fire('connect');
  const rejoin = r2.socket.emitted.find((e) => e.evt === 'rejoin');
  assert.ok(rejoin, '刷新后 connect 应发出 rejoin');
  // payload 是沙箱 realm 里创建的对象：跨 realm 的 deepStrictEqual 会比原型而误报，
  // 这里逐字段比较（字符串 primitive 跨 realm 按值相等）。
  assert.strictEqual(rejoin.payload.roomCode, '888', 'rejoin 应带 roomCode');
  assert.strictEqual(rejoin.payload.playerId, 'p0', 'rejoin 应带 playerId');
  assert.strictEqual(rejoin.payload.rejoinToken, 'tk-1', 'rejoin 应带 rejoinToken');

  // ③ 旧版本/首次进房：有 roomCode+playerId 但没有 rejoinToken → 必须发 '' 而不是 undefined
  const m = new Map([['roomCode', '999'], ['playerId', 'p1']]);
  const r3 = makeRig({ sessionMap: m });
  r3.socket.fire('connect');
  const rejoin3 = r3.socket.emitted.find((e) => e.evt === 'rejoin');
  assert.ok(rejoin3, '有 roomCode+playerId 时应 rejoin');
  assert.strictEqual(rejoin3.payload.rejoinToken, '', "缺 token 时必须发空串（对应 rejoinToken || ''）");
});

/* ================= 场景 46：真实禁用模式 —— 属性 getter 抛 ================= */
test('★会话守卫：sessionStorage 属性 getter 抛（真实禁用模式）时三条路径都不得截断', () => {
  // 前置校验：注入必须真的生效。这是 team-lead / engineering-lead 特别强调的坑 ——
  // 把 accessor 放在宿主 sandbox 上再 contextify **不会转发**，vm 内只会看到「属性不存在」，
  // 那种情况下用例也会红/绿，但红/绿的原因不对，等于假覆盖。
  // 用 probe 直接进 vm 验证：直接取值必须抛 SecurityError，typeof 也必须传播异常。
  const probeRig = makeRig({ sessionGetterThrows: true });
  assert.throws(() => probeRig.probe('sessionStorage.getItem("x")'),
    (e) => !!e && e.name === 'SecurityError',
    '前置校验：getter 必须真的抛 SecurityError（不是「属性不存在」的 ReferenceError）');
  assert.throws(() => probeRig.probe('typeof sessionStorage'),
    (e) => !!e && e.name === 'SecurityError',
    '前置校验：typeof「已声明且 getter 抛」的属性必须传播异常（app.js helper 的 typeof 检查就靠它被 catch）');

  // ① roomJoined：setItem 读属性就抛，不能截断 showView/renderRoom
  const r1 = makeRig({ sessionGetterThrows: true });
  assert.doesNotThrow(() => r1.socket.fire('roomJoined', {
    roomCode: '888', youId: 'p0', rejoinToken: 'tk-1', state: stBase('waiting'),
  }), 'roomJoined 在属性 getter 抛时不得把异常穿透出去');
  assert.ok(r1.visible('view-room'), '必须已切到房间面板（showView 不能被截断）');
  assert.ok(r1.hidden('view-home'), '首页必须隐藏');
  assert.ok(String(r1.getEl('#roomInfo').textContent).includes('888'),
    `#roomInfo 应含 888（证明 S.state 已赋值且 renderRoom 跑完）：实际「${r1.getEl('#roomInfo').textContent}」`);
  assert.strictEqual(r1.getEl('#playerList').children.length, 3, '玩家列表应渲染出 3 人');

  // ② roomClosed：clear() 读属性就抛，toast 与 resetToHome 仍要执行
  const r2 = makeRig({ sessionGetterThrows: true });
  assert.doesNotThrow(() => r2.socket.fire('roomClosed'),
    'roomClosed 在属性 getter 抛时不得把 toast/resetToHome 截断');
  assert.strictEqual(String(r2.getEl('#toast').textContent), '房间已解散', 'toast 必须显示「房间已解散」');
  assert.ok(r2.visible('view-home'), '必须回到首页');

  // ③ resetToHome（BAD_TOKEN 且 S.state 为空）
  const r3 = makeRig({ sessionGetterThrows: true });
  r3.getEl('#view-home').classList.add('hidden');
  r3.getEl('#view-room').classList.remove('hidden');
  assert.doesNotThrow(() => r3.socket.fire('error', { code: 'BAD_TOKEN' }),
    'BAD_TOKEN 在属性 getter 抛时不得把 showView(view-home) 截断');
  assert.ok(r3.visible('view-home'), '必须切回首页');
  assert.ok(r3.hidden('view-room'), '房间面板应隐藏');
});
