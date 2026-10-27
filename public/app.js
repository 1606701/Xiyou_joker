'use strict';

/* ===== 西游斗牌 · 前端逻辑 ===== */
const $ = (sel) => document.querySelector(sel);

const KIND_CLS = { monster: 'monster', disciple: 'disciple', master: 'master', action: 'action' };

/**
 * 座位头像用「昵称首字」，不再用 emoji：
 * emoji 在 Windows / macOS / Android 上字形完全不同（扁的、拟物的、彩色的），
 * 同一套设计会呈现三种观感；中文字头像则处处一致，且能直接认出是谁。
 */
function initialOf(name) {
  const chars = Array.from(String(name == null ? '' : name).trim());
  return chars.length ? chars[0] : '?';
}
// 牌面名称 / 大小王显示文本统一由服务端 GET /api/cards 下发（唯一来源：lib/cards.js 的 CARD_NAMES），
// 前端不再维护第二份表，改牌名只需改一处（BUG-006）。拉取失败时退化为显示点数原文。
const FALLBACK_RANK_SHOW = { SJ: '小王', BJ: '大王' };
const ERROR_TEXT = {
  ROOM_NOT_FOUND: '房间不存在',
  ROOM_FULL: '房间已满（最多 6 人）',
  NAME_TAKEN: '昵称不能为空或已被使用',
  GAME_RUNNING: '对局已开始，无法加入',
  NOT_YOUR_TURN: '还没轮到您出牌',
  ILLEGAL_CARD: '这张牌不能压制当前门槛牌',
  MUST_PLAY: '您还有可出的牌，不能收牌',
  NOT_READY: '有玩家未准备',
  NOT_OWNER: '只有房主可以开始',
  BAD_PHASE: '当前状态不允许该操作',
  PLAYER_NOT_FOUND: '玩家不存在',
  NOT_ENOUGH: '至少需要 3 名玩家',
  BAD_TOKEN: '重连凭证失效，请重新加入房间',
  INTERNAL: '服务端异常，本回合已转托管',
  DEFAULT: '操作失败',
};

const S = {
  socket: null,
  state: null,        // 最近一次 state 视图
  myTurn: null,       // { legalMoves, deadline }
  selectedIds: [],     // 选中的手牌 id（可多选同点牌组成组合）
  nickname: '',
  cardNames: {},                        // 由 GET /api/cards 覆盖（BUG-006）
  rankShow: FALLBACK_RANK_SHOW,
  handSig: '',                          // 手牌指纹：只有牌真的变了才播放入场动画
};

/* ---------- 工具 ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function showView(name) {
  for (const v of ['view-home', 'view-room', 'view-game']) {
    $(`#${v}`).classList.toggle('hidden', v !== name);
  }
  $('#view-settle').classList.add('hidden');
  $('#roomInfo').classList.toggle('hidden', name === 'view-home');
}

/**
 * 兜底（只警告、不强行切换）：校验「当前可见视图」是否与 S.state.phase 匹配。
 *
 * 为什么只警告：强行切换会把「某条事件忘了切视图」这种真缺陷掩盖成「看起来能用」，
 * 而这正是本次 P0（state 只 render 不切视图 → 点了开始没反应）活了这么久的成因。
 * 有了这条警告，将来谁再漏掉 showView()，控制台会立刻留下痕迹。
 * 未知 phase 不参与校验（新增阶段应当在 state 处理器里显式加分支）。
 */
function warnIfViewMismatch(where) {
  const phase = S.state && S.state.phase;
  if (phase !== 'waiting' && phase !== 'playing' && phase !== 'settling') return;
  const expect = phase === 'waiting' ? 'view-room' : 'view-game';
  const el = $(`#${expect}`);
  if (el && el.classList.contains('hidden')) {
    console.warn(
      `[西游斗牌] 视图与状态不一致（${where}）：phase=${phase}，期望可见 #${expect} 但它是隐藏的 → 检查是否漏了 showView()`
    );
  }
}

/* ---------- Socket ---------- */
function connectSocket() {
  S.socket = io();

  S.socket.on('connect', () => {
    $('#connBanner').classList.add('hidden');
    // 刷新页面 / 断线恢复：尝试回原座位（需 roomCode + playerId + 服务端签发的 rejoinToken）
    const roomCode = sessionStorage.getItem('roomCode');
    const playerId = sessionStorage.getItem('playerId');
    const rejoinToken = sessionStorage.getItem('rejoinToken');
    if (roomCode && playerId) {
      S.socket.emit('rejoin', { roomCode, playerId, rejoinToken: rejoinToken || '' });
    }
  });

  S.socket.on('disconnect', () => {
    $('#connBanner').classList.remove('hidden');
  });

  S.socket.on('roomJoined', ({ roomCode, youId, state, rejoinToken }) => {
    sessionStorage.setItem('roomCode', roomCode);
    sessionStorage.setItem('playerId', youId);
    if (rejoinToken) sessionStorage.setItem('rejoinToken', rejoinToken);
    S.state = state;
    S.myTurn = null;
    S.selectedIds = [];
    showView(state.phase === 'waiting' ? 'view-room' : 'view-game');
    // #roomInfo（房间码）在房间面板与牌桌都要显示，所以两种阶段都渲染一次房间信息
    renderRoom();
    if (state.phase !== 'waiting') renderGame();
    // 结算期刷新 / 被 rejoin 接回：这条路径没有 gameEnd 事件可依赖，
    // 必须自己把结算遮罩补弹出来，否则只看到一张静止的牌桌（用户会以为卡住）。
    if (state.phase === 'settling' && state.lastResult) {
      const winner = state.players.find((p) => p.id === state.lastResult.winnerId);
      showSettle({
        results: state.lastResult.results,
        winnerIds: [state.lastResult.winnerId],
        winnerName: (winner && winner.name) || '', // 取不到就给空串，避免 escapeHtml(undefined) 显示 "undefined"
      });
    }
  });

  /**
   * 视图状态机：**任何 phase 变化都必须有对应的 showView**（之前的 P0 就是这里只 render 不切视图）。
   *
   *   waiting  → view-room  （showView 内部会顺手隐藏结算遮罩 → 「再来一局」后不会残留结算层）
   *   playing  → view-game
   *   settling → 只重绘，**绝不调 showView**
   *
   * settling 为什么特殊（这条顺序依赖不要「优化」掉）：
   *   服务端顺序是「先 broadcastState(settling) → 再 sendGameEnd」。
   *   showView() 会无条件 $('#view-settle').classList.add('hidden')，
   *   若这里调 showView('view-game')，结算遮罩刚被 gameEnd 弹出就会被后续广播关掉。
   *   结算遮罩只由 gameEnd / roomJoined 负责弹出。
   */
  S.socket.on('state', (state) => {
    S.state = state;
    // 回到等待阶段（开局前 / 再来一局）时清空本回合的合法牌与选中
    if (S.myTurn && state.phase === 'waiting') {
      S.myTurn = null;
      S.selectedIds = [];
    }
    if (state.phase === 'waiting') {
      S.handSig = ''; // 下一局重新播入场动画
      showView('view-room');
      renderRoom();
    } else if (state.phase === 'playing') {
      showView('view-game');
      renderGame();
    } else if (state.phase === 'settling') {
      renderGame(); // 视图保持不动，结算遮罩交给 gameEnd（见上方顺序说明）
    } else {
      // 未知阶段：不猜视图，只告警（将来加新阶段时应在这里显式加分支）
      console.warn(`[西游斗牌] 收到未知 room.phase=${state.phase}，视图保持不动`);
    }
    warnIfViewMismatch('state');
  });

  S.socket.on('yourTurn', ({ legalMoves, deadline }) => {
    S.myTurn = { legalMoves, deadline };
    S.selectedIds = [];
    // 不切视图：服务端保证 sendTurn 之前必有一次 broadcastState（state 处理器已切到 view-game），
    // 这里只做兜底告警 —— 如果将来这个不变量被破坏，控制台会告诉我们，而不是让用户看不见桌面。
    renderGame();
    warnIfViewMismatch('yourTurn');
  });

  S.socket.on('gameEnd', (data) => {
    S.myTurn = null;
    S.selectedIds = [];
    // 同样不切视图：settling 的 state 广播先把视图留在 view-game，结算遮罩叠在其上。
    showSettle(data);
    warnIfViewMismatch('gameEnd');
  });

  S.socket.on('error', ({ code }) => {
    toast(ERROR_TEXT[code] || ERROR_TEXT.DEFAULT);
    // 重连令牌失效（如房间已回收）：清掉本地凭证，回到首页重新加入
    if (code === 'BAD_TOKEN' || code === 'PLAYER_NOT_FOUND' || code === 'ROOM_NOT_FOUND') {
      if (!S.state) resetToHome();
    }
  });

  S.socket.on('roomClosed', () => {
    sessionStorage.clear();
    toast('房间已解散');
    resetToHome();
  });
}

/* ---------- 房间视图 ---------- */
function resetToHome() {
  S.state = null; S.myTurn = null; S.selectedIds = [];
  sessionStorage.removeItem('roomCode');
  sessionStorage.removeItem('playerId');
  sessionStorage.removeItem('rejoinToken');
  showView('view-home');
}

function renderRoom() {
  const st = S.state;
  if (!st) return;
  $('#roomCodeBig').textContent = st.roomCode;
  $('#roomInfo').textContent = `房间 ${st.roomCode}`;
  $('#lanUrl').textContent = `${location.host}`;
  const meId = st.youId;
  const ul = $('#playerList');
  ul.innerHTML = '';
  st.players.forEach((p) => {
    const li = document.createElement('li');
    const badges = [];
    if (p.isOwner) badges.push('<span class="badge owner">房主</span>');
    badges.push(p.ready ? '<span class="badge ready">已准备</span>' : '<span class="badge wait">未准备</span>');
    if (!p.connected) badges.push('<span class="badge offline">掉线</span>');
    li.innerHTML = `
      <div class="left"><span class="seat-no">${p.seat + 1}</span><span class="name">${escapeHtml(p.name)}${p.id === meId ? '（我）' : ''}</span></div>
      <div class="badges">${badges.join('')}</div>`;
    ul.appendChild(li);
  });

  const me = st.players.find((p) => p.id === meId);
  const isOwner = me && me.isOwner;
  const allReady = st.players.length >= 3 && st.players.every((p) => p.ready);
  $('#btnReady').textContent = me && me.ready ? '取消准备' : '准备';
  $('#btnStart').classList.toggle('hidden', !isOwner);
  $('#btnStart').disabled = !allReady;
  $('#roomStatus').textContent = st.players.length < 3
    ? `还需 ${3 - st.players.length} 人即可开局（当前 ${st.players.length}/6）`
    : (allReady ? '全部就绪，房主可开始游戏' : '等待所有人准备…');
}

/* ---------- 对局视图 ---------- */
function renderGame() {
  const st = S.state;
  if (!st || !st.players || st.players.length === 0) return;
  renderInfo(st);
  renderSeats(st);
  renderTable(st);
  renderHand(st);
  renderPrompt(st);
  renderHandMeta(st);
}

/** 手牌上方的单行摘要：把「几张牌 / 败了几张」从座位的小字里解放出来 */
function renderHandMeta(st) {
  const me = st.players.find((p) => p.id === st.youId);
  if (!me) { $('#handMeta').textContent = ''; return; }
  const parts = [`手牌 ${me.handCount} 张`];
  if (me.penaltyCount) parts.push(`败牌 ${me.penaltyCount}`);
  if (st.currentPlayerId === st.youId) parts.push('轮到你');
  $('#handMeta').textContent = parts.join(' · ');
}

function renderInfo(st) {
  $('#iRound').textContent = `第 ${st.roundNumber || 1} 局`;
  $('#iDraw').textContent = `摸牌堆 ${st.drawPileCount}`;
  $('#iDir').textContent = st.direction === 1 ? '方向 ↻ 顺时针' : '方向 ↺ 逆时针';
}

// 座位边缘锚点（相对 #gameArea 的 % 坐标，顺时针排列，从下中开始）
// 我方始终坐下中（贴近手牌），其余按座位号递增顺时针绕圈铺开，避免遮挡中央桌面；
// 下排槽位刻意上移，防止座位信息溢出到下方提示条/手牌区
const SEAT_SLOTS = [
  { left: 50, top: 87 }, // 下中（我方）
  { left: 86, top: 76 }, // 右下
  { left: 88, top: 12 }, // 右上
  { left: 50, top: 8 },  // 上中
  { left: 12, top: 12 }, // 左上
  { left: 14, top: 76 }, // 左下
];

function seatPositions(count, meSeat) {
  const pos = new Array(count);
  pos[meSeat] = SEAT_SLOTS[0];
  for (let k = 1; k < count; k++) {
    pos[(meSeat + k) % count] = SEAT_SLOTS[k];
  }
  return pos;
}

function renderSeats(st) {
  const me = st.players.find((p) => p.id === st.youId);
  const meSeat = me ? me.seat : 0;
  const pos = seatPositions(st.players.length, meSeat);
  const el = $('#seats');
  el.innerHTML = '';
  st.players.forEach((p) => {
    const seat = document.createElement('div');
    seat.className = 'seat';
    seat.classList.toggle('active', st.currentPlayerId === p.id);
    seat.classList.toggle('me', p.id === st.youId);
    seat.classList.toggle('offline', !p.connected);
    seat.style.left = pos[p.seat].left + '%';
    seat.style.top = pos[p.seat].top + '%';
    seat.innerHTML = `
      <div class="avatar">${escapeHtml(initialOf(p.name))}${p.isOwner ? '<span class="crown">主</span>' : ''}</div>
      <div class="sname">${escapeHtml(p.name)}${p.id === st.youId ? '（我）' : ''}</div>
      <div class="smeta"><span>${p.handCount} 张</span>${p.penaltyCount ? `<span class="penalty">败 ${p.penaltyCount}</span>` : ''}</div>
      ${p.connected ? '' : '<div class="off-tag">离线</div>'}`;
    el.appendChild(seat);
  });
}

function cardHtml(card, extraCls = '') {
  const rank = S.rankShow[card.rank] || card.rank;
  const name = S.cardNames[card.rank] || rank;
  const isRed = card.suit === '♥' || card.suit === '♦';
  return `<div class="card ${isRed ? 'suit-red ' : ''}${extraCls}" data-id="${escapeHtml(card.id)}">
    <span class="rank">${rank}</span>
    <span class="suit">${card.suit || ''}</span>
    <span class="role ${KIND_CLS[card.kind]}">${name}</span>
  </div>`;
}

function renderTable(st) {
  const top = st.topCard;
  const topEl = $('#topCard');
  if (top) {
    const badge = (st.topCount || 1) > 1 ? `<span class="count-badge">×${st.topCount}</span>` : '';
    topEl.innerHTML = cardHtml(top) + badge;
  } else {
    topEl.innerHTML = '<div class="card back"></div>';
  }
  $('#tableInfo').textContent = top
    ? `桌面 ${st.tablePileCount} 张 · 门槛 ${st.topCount || 1} 张`
    : `桌面 ${st.tablePileCount} 张 · 新一轮任意出牌`;
  // 只保留最近两条：牌桌上的日志是提示，不是账本，超过两行会盖住桌面
  $('#eventLog').innerHTML = (st.eventLog || []).slice(-2).map((e) => `<div>${escapeHtml(e)}</div>`).join('');
}

/** 手牌点选：已选中则取消；切换点数时只保留同点牌，实现多张组合选择 */
function toggleSelect(sel, id, hand) {
  if (sel.includes(id)) return sel.filter((x) => x !== id);
  const card = hand.find((c) => c.id === id);
  if (!card) return sel;
  const sameRank = hand.filter((c) => c.rank === card.rank);
  const rest = sel.filter((x) => sameRank.some((c) => c.id === x));
  return [...rest, id];
}

function renderHand(st) {
  const el = $('#hand');
  el.innerHTML = '';
  const isMyTurn = st.currentPlayerId === st.youId && st.phase === 'playing';
  const legal = S.myTurn && isMyTurn ? S.myTurn.legalMoves : null;
  const beatIds = legal ? new Set(legal.beats.flat()) : null;
  const actionIds = legal ? new Set(legal.actions) : null;

  // 只有手牌集合真的变了才播入场动画，否则每次 state 广播都会抖一下
  const sig = st.hand.map((c) => c.id).join(',');
  const entering = sig !== S.handSig;
  S.handSig = sig;

  st.hand.forEach((card, idx) => {
    const canPlay = legal && (beatIds.has(card.id) || actionIds.has(card.id));
    const cls = [];
    if (canPlay) cls.push('playable');
    if (S.selectedIds.includes(card.id)) cls.push('selected');
    if (!canPlay) cls.push('disabled');
    if (entering) cls.push('enter');
    const div = document.createElement('div');
    div.innerHTML = cardHtml(card, cls.join(' '));
    const node = div.firstElementChild;
    if (node && entering) node.style.animationDelay = `${idx * 28}ms`;
    if (canPlay) {
      node.addEventListener('click', () => {
        S.selectedIds = toggleSelect(S.selectedIds, card.id, st.hand);
        renderHand(st);
      });
    }
    el.appendChild(node);
  });

  const canPlayAny = legal && (legal.beats.length > 0 || legal.actions.length > 0);
  $('#btnPickup').classList.toggle('hidden', !(isMyTurn && legal && !canPlayAny));
  $('#btnPlay').classList.toggle('hidden', !(isMyTurn && S.selectedIds.length > 0));
}

function renderPrompt(st) {
  const bar = $('#promptBar');
  if (st.phase === 'settling') { bar.textContent = '本局已结束'; return; }
  const isMyTurn = st.currentPlayerId === st.youId;
  if (!isMyTurn) {
    const cur = st.players.find((p) => p.id === st.currentPlayerId);
    bar.textContent = cur ? `等待 ${cur.name} 出牌…` : '…';
    return;
  }
  if (!S.myTurn) { bar.textContent = '轮到你…'; return; }
  const legal = S.myTurn.legalMoves;
  if (legal.beats.length === 0 && legal.actions.length === 0) {
    bar.textContent = '无可出之牌，将自动收牌…';
  } else {
    bar.textContent = '轮到你：请压制（可同点多张）或打出功能牌';
  }
}

/* ---------- 结算 ---------- */
/**
 * 弹出结算遮罩。
 * 现在有两个调用方：gameEnd 事件、以及「结算期 roomJoined（刷新/重连）」，
 * 所以对入参做一层容错 —— 宁可显示空列表，也不要因为少一个字段抛错留下半张遮罩。
 */
function showSettle(data) {
  const results = (data && data.results) || [];
  const winnerId = (data && data.winnerIds && data.winnerIds[0]) || null;
  const youId = S.state && S.state.youId;
  const list = $('#resultList');
  list.innerHTML = '';
  results.forEach((r, i) => {
    const li = document.createElement('li');
    li.classList.toggle('winner', r.id === winnerId);
    li.innerHTML = `
      <span>${i + 1}. ${escapeHtml(r.name)}${r.id === winnerId ? ' <span class="win-tag">通杀</span>' : ''}${r.id === youId ? '（我）' : ''}</span>
      <span class="pen">败牌 ${r.penaltyCount} 张</span>`;
    list.appendChild(li);
  });
  $('#winnerBanner').textContent = `${(data && data.winnerName) || ''} 通杀`;
  $('#view-settle').classList.remove('hidden');
}

/* ---------- 默认昵称 ---------- */
function makeDefaultNickname() {
  const pool = ['悟空', '八戒', '沙僧', '唐僧', '白龙', '哪吒', '二郎神', '牛魔', '红孩儿', '金翅'];
  return pool[Math.floor(Math.random() * pool.length)] + Math.floor(Math.random() * 90 + 10);
}

/** 昵称为空时自动生成一个默认名（用户可直接创建/加入，无需手动输入） */
function effectiveNickname() {
  const v = $('#nickname').value.trim();
  if (v) return v;
  const d = makeDefaultNickname();
  $('#nickname').value = d;
  return d;
}

/* ---------- 动效 ----------
 * 全部做特性检测：没有真实布局能力的环境（无 body / 无 getBoundingClientRect，
 * 例如前端断言用的假 DOM）直接跳过，绝不因为动效把逻辑搞挂。
 */
function fxReady() {
  return typeof document !== 'undefined' && !!document.body
    && typeof document.body.appendChild === 'function';
}

function rectOf(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  try {
    const r = el.getBoundingClientRect();
    return r && r.width ? r : null;
  } catch (e) {
    return null;
  }
}

/** 复刻一张牌从自己位置飞到目标位置，然后销毁。真实牌只在 state 广播后重绘。 */
function flyGhost(node, toRect, rotate) {
  if (!fxReady() || !node || !toRect) return;
  const from = rectOf(node);
  if (!from) return;
  const layer = $('#fxLayer') || document.body;
  const ghost = node.cloneNode(true);
  ghost.classList.remove('selected', 'playable', 'enter', 'disabled');
  ghost.classList.add('fx-ghost');
  ghost.style.position = 'fixed';
  ghost.style.left = `${from.left}px`;
  ghost.style.top = `${from.top}px`;
  ghost.style.width = `${from.width}px`;
  ghost.style.height = `${from.height}px`;
  ghost.style.margin = '0';
  ghost.style.zIndex = '80';
  ghost.style.opacity = '1';
  layer.appendChild(ghost);
  // 触发一次重排，让初始位置先生效，否则会直接「闪现」到终点
  if (typeof ghost.offsetWidth === 'number') void ghost.offsetWidth;
  const dx = (toRect.left + toRect.width / 2) - (from.left + from.width / 2);
  const dy = (toRect.top + toRect.height / 2) - (from.top + from.height / 2);
  const scale = Math.max(0.5, Math.min(1, toRect.width / from.width));
  ghost.style.transition = 'transform .34s cubic-bezier(.22,.61,.36,1), opacity .34s ease-out';
  ghost.style.transform = `translate(${dx}px, ${dy}px) scale(${scale}) rotate(${rotate || -8}deg)`;
  ghost.style.opacity = '0';
  setTimeout(() => {
    if (ghost.parentNode && typeof ghost.parentNode.removeChild === 'function') {
      ghost.parentNode.removeChild(ghost);
    }
  }, 380);
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  $('#btnCreate').addEventListener('click', () => {
    const nickname = effectiveNickname();
    S.nickname = nickname;
    S.socket.emit('createRoom', { nickname });
  });

  $('#btnJoin').addEventListener('click', () => {
    const nickname = effectiveNickname();
    const code = $('#roomCode').value.trim().toUpperCase();
    if (!code) return toast('请输入房间码');
    S.nickname = nickname;
    S.socket.emit('joinRoom', { roomCode: code, nickname });
  });

  $('#btnReady').addEventListener('click', () => {
    const me = S.state && S.state.players.find((p) => p.id === S.state.youId);
    S.socket.emit('ready', { ready: me ? !me.ready : true });
  });

  // 防抖：点击后立即禁用，待收到新 state 时在 renderRoom 中恢复
  $('#btnStart').addEventListener('click', () => {
    $('#btnStart').disabled = true;
    S.socket.emit('start');
  });

  $('#btnLeave').addEventListener('click', () => {
    S.socket.emit('leaveRoom');
    resetToHome();
  });

  $('#btnPlay').addEventListener('click', () => {
    if (!S.selectedIds.length) return;
    const ids = S.selectedIds.slice();
    // 出牌手感：把选中的牌复刻一份飞向桌面（真实手牌等 state 广播回来再重绘）
    const target = rectOf($('#topCard'));
    if (target) {
      ids.forEach((id, i) => {
        const node = document.querySelector(`#hand .card[data-id="${id}"]`);
        setTimeout(() => flyGhost(node, target, -8 + i * 4), i * 40);
      });
    }
    S.socket.emit('playCard', { cardIds: ids });
    S.selectedIds = [];
  });

  $('#btnPickup').addEventListener('click', () => {
    // 收牌手感：桌面那张牌飞向自己座位
    const meAvatar = document.querySelector('#seats .seat.me .avatar');
    const tableCard = document.querySelector('#topCard .card');
    const toRect = rectOf(meAvatar);
    if (toRect) flyGhost(tableCard, toRect, 12);
    S.socket.emit('pickUp');
  });

  $('#btnNextRound').addEventListener('click', () => S.socket.emit('nextRound'));
}

/* ---------- 启动 ---------- */
/**
 * 拉取牌面名称（唯一来源 lib/cards.js）。成功后重绘一次，避免出现「先显示点数再变成角色名」的长期状态。
 * 失败（离线/接口不可用）只是退化为显示点数，不影响出牌流程。
 */
async function loadCardNames() {
  try {
    const res = await fetch('/api/cards');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.names) S.cardNames = data.names;
    if (data && data.rankShow) S.rankShow = data.rankShow;
    if (S.state) {
      if (S.state.phase === 'waiting') renderRoom();
      else renderGame();
    }
  } catch (e) {
    console.warn('[西游斗牌] 牌面名称拉取失败，暂以点数显示：', e.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (!$('#nickname').value) $('#nickname').value = makeDefaultNickname();
  bindEvents();
  loadCardNames();
  connectSocket();
});
