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
  snap: null,                           // 上一帧快照：动效与音效靠「状态差异」驱动，不靠事件
  turnTimerRaf: null,                   // 回合倒计时的 rAF 句柄（无 rAF 环境为 null）
  lastTickSec: 0,                        // 报时去重：3/2/1 各响一次
  prevPlayerIds: '',                     // 上一帧的玩家 id 串：用来听出「有人加入 / 加了 AI」
};

/* ---------- 工具 ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
/**
 * @param {string} msg
 * @param {boolean} [isErr] 报错时抖一下；成功提示保持静默淡出，两者要能一眼分开
 */
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.remove('err');
  if (isErr) {
    // 重排一次，让同一个抖动能连续重播（连点两次非法牌也要有反馈）
    if (el.offsetWidth) void el.offsetWidth;
    el.classList.add('err');
  }
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
    S.snap = null;                        // 换房后重算差异，避免拿上一个房间的牌堆去 diff
    S.prevPlayerIds = state.players.map((p) => p.id).join(',');
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
    const prevPhase = S.state ? S.state.phase : null;
    S.state = state;

    // 有人加入 / 加了 AI：只按「新增的那一个人」判音色，且不进游戏音效的依赖链
    const ids = state.players.map((p) => p.id).join(',');
    if (S.prevPlayerIds && S.prevPlayerIds !== ids) {
      const before = new Set(S.prevPlayerIds.split(','));
      const added = state.players.filter((p) => p.id && !before.has(p.id));
      if (added.length === 1) sfx(added[0].isAI ? 'ai' : 'join');
    }
    S.prevPlayerIds = ids;

    // 发牌：只在「等待 → 对局」这个跃迁上响一次。
    // 刻意不用「自己手牌从 0 变 5」判定 —— 刷新/重连时 hand 也会从空变成 5，
    // 那样每刷新一次就会重放一遍发牌音（调色板 §7 明令禁止重放）。
    if (prevPhase === 'waiting' && state.phase === 'playing') {
      const me = state.players.find((p) => p.id === state.youId);
      sfx('deal', { n: me ? me.handCount : 5 });
    }

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
    startTurnTimer(deadline);
    sfx('yourTurn');
    warnIfViewMismatch('yourTurn');
  });

  S.socket.on('gameEnd', (data) => {
    S.myTurn = null;
    S.selectedIds = [];
    // 同样不切视图：settling 的 state 广播先把视图留在 view-game，结算遮罩叠在其上。
    showSettle(data);
    // 结算音只在这条事件上响；结算期 roomJoined（刷新重连）那条路径刻意不补音，
    // 否则每次刷新都会被一段结算音乐砸一次。
    const winnerId = data && data.winnerIds && data.winnerIds[0];
    sfx(winnerId && S.state && winnerId === S.state.youId ? 'settle.win' : 'settle.lose');
    warnIfViewMismatch('gameEnd');
  });

  S.socket.on('error', ({ code }) => {
    toast(ERROR_TEXT[code] || ERROR_TEXT.DEFAULT, true);
    sfx('illegal');
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
    // AI 不会点「准备」，显示「未准备」会让人以为在等它操作 → 直接给 AI 徽标
    if (p.isAI) badges.push('<span class="badge ai">AI</span>');
    else badges.push(p.ready ? '<span class="badge ready">已准备</span>' : '<span class="badge wait">未准备</span>');
    if (!p.connected) badges.push('<span class="badge offline">掉线</span>');
    li.innerHTML = `
      <div class="left"><span class="seat-no">${p.seat + 1}</span><span class="name">${escapeHtml(p.name)}${p.id === meId ? '（我）' : ''}</span></div>
      <div class="badges">${badges.join('')}</div>`;
    ul.appendChild(li);
  });

  const me = st.players.find((p) => p.id === meId);
  const isOwner = me && me.isOwner;
  const allReady = st.players.length >= 3 && st.players.every((p) => p.ready);
  const aiCount = st.players.filter((p) => p.isAI).length;
  $('#btnReady').textContent = me && me.ready ? '取消准备' : '准备';
  $('#btnStart').classList.toggle('hidden', !isOwner);
  $('#btnStart').disabled = !allReady;
  // AI 按钮：非房主完全看不到；房主看到但按条件置灰（保持布局稳定，不来回跳）
  $('#btnAddAI').classList.toggle('hidden', !isOwner);
  $('#btnRemoveAI').classList.toggle('hidden', !isOwner);
  $('#btnAddAI').disabled = st.players.length >= 6;
  $('#btnRemoveAI').disabled = aiCount === 0;
  $('#roomStatus').textContent = st.players.length < 3
    ? `还需 ${3 - st.players.length} 人即可开局（当前 ${st.players.length}/6）`
    : (allReady ? '全部就绪，房主可开始游戏' : '等待所有人准备…');
}

/* ---------- 对局视图 ---------- */
function renderGame() {
  const st = S.state;
  if (!st || !st.players || st.players.length === 0) return;
  const prev = S.snap;
  renderInfo(st);
  renderDirRing(st);
  renderSeats(st);
  renderTable(st);
  renderHand(st);
  renderPrompt(st);
  renderHandMeta(st);
  S.snap = snapshot(st);
  applyFeel(prev, st);
}

/**
 * 动效用「状态差异」驱动，而不是「事件」驱动。
 * 理由：同一份状态会因托管推进、断线重连、重复广播等原因到达多次；
 * 在事件回调里播动画，会因重复广播而抖（发牌动画当初就是这么踩过的）。
 */
function snapshot(st) {
  const pen = {};
  for (const p of st.players) pen[p.id] = p.penaltyCount || 0;
  return {
    topKey: st.topCard ? `${st.topCard.rank}|${st.topCard.suit}|${st.topCard.kind}` : '',
    hasTop: !!st.topCard,
    pile: st.tablePileCount || 0,
    pen,
    // 门槛牌本体的只读副本：只给「压制残影」画点数/花色用（topKey 是判据，不是牌面）。
    // 纯新增字段，不改上面四个字段的语义；判据永远只认 topKey。
    topCard: st.topCard ? { rank: st.topCard.rank, suit: st.topCard.suit, kind: st.topCard.kind } : null,
    // 出牌方向（1 顺时针 / -1 逆时针）：只给「方向环反转」做帧对比用。
    // 归一化成 ±1，免得收到 undefined 时把 0 当真值去比。
    direction: st.direction === -1 ? -1 : 1,
  };
}

function applyFeel(prev, st) {
  if (!prev) return;

  const topKey = st.topCard ? `${st.topCard.rank}|${st.topCard.suit}|${st.topCard.kind}` : '';

  // 桌面牌数增量（下面出牌音与连击判定共用同一个 diff）
  const pile = st.tablePileCount || 0;
  const delta = pile - (prev.pile || 0);

  /**
   * 出牌三档强度 —— 判据全部来自「同一份快照的前后差异」，所以重复 state 天然幂等
   * （重连 / 接力接管 / 服务端重播都会重发同一份 state，不能每次重放）：
   *   ① 首出：prev 没有门槛牌 → 只有落牌（下面 1 的 .drop）+ 堆叠阴影，**没有冲击波**
   *   ② 压制：prev 有门槛牌且真的换了牌 → 残影 / 冲击波 / 斩击线 / 震桌 + 高光
   *   ③ 连击：压制且一次压上 ≥2 张 → 冲击波转朱红 + 溅火星
   * 三档必须拉开强度，否则「压制」在体感上等于「随便出张牌」。
   */
  const overplay = !!prev.hasTop && !!topKey && topKey !== prev.topKey;

  // 1) 门槛牌真的换了才砸一下（不是每次广播都砸）
  if (topKey && topKey !== prev.topKey) {
    const el = $('#topCard');
    if (el && el.classList) {
      el.classList.remove('drop');
      if (el.offsetWidth) void el.offsetWidth; // 重排，让同一动画可重播
      el.classList.add('drop');
    }
  }

  // 2) 桌面牌数变化 → 出牌 / 收牌。
  //    必须用 diff：重连、重绘、托管推进都会重发同一份 state，
  //    在事件回调里无条件播音会变成一串噪音。
  if (delta > 0) {
    // 门槛牌没变却有新牌 → 是功能牌（A/2），不是压制
    if (prev.hasTop && topKey !== prev.topKey) sfx('beat');
    else if (delta >= 2) sfx('play.combo', { count: delta });
    else sfx('play.single');
  } else if (delta < 0) {
    sfx('take'); // 桌面被收走进败牌堆
  }

  // 3) 败牌增加：对应座位的数字跳一下
  for (const p of st.players) {
    const before = prev.pen[p.id] || 0;
    if ((p.penaltyCount || 0) > before) {
      const node = document.querySelector(`#seats .seat[data-pid="${p.id}"] .penalty`);
      if (node && node.classList) node.classList.add('bump');
    }
  }

  // 4) 压制 / 连击的冲击动画（首出刻意不进来：只有落牌，见上面三档说明）
  if (overplay) hitFx(prev.topCard, delta);

  // 5) 反转（打出 2·反转）：方向真的翻了才播一次。
  //    判据同样是帧对比 —— 同一份 direction 重复到达绝不重播；
  //    减弱动效时连类名都不挂（环不动，但箭头仍钉在环上指示方向）。
  if (prev.direction !== stDir(st) && motionOk()) pulseClass('#dirRing', 'flip', DIR_FLIP_MS);
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

/**
 * 方向环：环的形状不变，靠**空转方向**一直在说话（顺时针慢转 / 逆时针慢转）。
 * 状态严格来自 st.direction —— 不能靠「谁打了 2」这类事件推断：
 * 重连、服务端重播、接力接管都会重发同一份 state，事件推断会重复翻转方向。
 *
 * 只在方向真的变了的时候才切类名：classList.toggle(…, force) 在值不变时不会改属性，
 * 于是 9s 一圈的空转动画不会每帧被重启（重启会让环原地抖一下）。
 */
function renderDirRing(st) {
  const ring = $('#dirRing');
  if (!ring || !ring.classList) return;
  ring.classList.toggle('ccw', st.direction === -1);
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
    // AI 正在思考：头像旁一颗呼吸的金点，否则真人会以为卡住了
    seat.classList.toggle('ai-turn', !!p.isAI && st.currentPlayerId === p.id);
    if (typeof seat.setAttribute === 'function') seat.setAttribute('data-pid', p.id);
    seat.style.left = pos[p.seat].left + '%';
    seat.style.top = pos[p.seat].top + '%';
    seat.innerHTML = `
      <div class="avatar">${escapeHtml(initialOf(p.name))}${p.isOwner ? '<span class="crown">主</span>' : ''}</div>
      <div class="sname">${escapeHtml(p.name)}${p.isAI ? '·AI' : ''}</div>
      <div class="smeta"><span>${p.handCount} 张</span>${p.penaltyCount ? `<span class="penalty">败 ${p.penaltyCount}</span>` : ''}</div>
      ${p.connected ? '' : '<div class="off-tag">离线</div>'}`;
    // 「我」不再写进可见文本：座位只有 84~96px 宽，加「（我）」三个字会把名字挤成省略号。
    // 视觉上由 .me 的金色字 + 高亮座位表达；读屏信息用 aria-label 保留。
    if (typeof seat.setAttribute === 'function') {
      seat.setAttribute('aria-label', `${p.name}${p.isAI ? '（AI）' : ''}${p.id === st.youId ? '（我）' : ''}，${p.handCount} 张`);
    }
    el.appendChild(seat);
  });
}

/**
 * 有立绘的牌点，与 public/art/cards/<rank>.png 一一对应（由 tools/build-card-art.py 产出）。
 * 功能牌 A / 2 故意不在此列：它们没有角色，硬塞一张立绘反而读不出「跳过 / 反转」，
 * 保持纸底大字比配图更清楚。要加牌就同时加图片和 style.css 里的 --art 规则，
 * test/frontend.test.js 有一条用例专门盯着这三者是否对齐。
 */
const ART_RANKS = new Set(['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'SJ', 'BJ']);

function cardHtml(card, extraCls = '') {
  const rank = S.rankShow[card.rank] || card.rank;
  const name = S.cardNames[card.rank] || rank;
  const isRed = card.suit === '♥' || card.suit === '♦';
  const art = ART_RANKS.has(String(card.rank));
  return `<div class="card ${isRed ? 'suit-red ' : ''}${art ? 'has-art ' : ''}${extraCls}" data-rank="${escapeHtml(String(card.rank))}" data-id="${escapeHtml(card.id)}">
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
  // 桌面有牌时补一层堆叠厚度（纯 CSS 阴影，不加 DOM）
  const tableEl = $('#table');
  if (tableEl) tableEl.classList.toggle('has-pile', (st.tablePileCount || 0) > 0);
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

/**
 * 回合倒计时：一条会缩短的金线。
 * 只在真实布局环境里跑（假 DOM 没有 requestAnimationFrame，直接跳过）；
 * 不依赖 socket 事件，靠 deadline 绝对时间算比例，所以断线重连后也准。
 */
function stopTurnTimer() {
  if (S.turnTimerRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(S.turnTimerRaf);
  S.turnTimerRaf = null;
  const bar = $('#turnTimer');
  if (bar && bar.classList) bar.classList.add('hidden');
}

function startTurnTimer(deadline) {
  stopTurnTimer();
  const bar = $('#turnTimer');
  if (!bar || !deadline) return;
  if (typeof requestAnimationFrame !== 'function') return;
  const fill = bar.firstElementChild;
  if (!fill || !fill.style) return;
  const total = Math.max(500, deadline - Date.now());
  bar.classList.remove('hidden');
  S.lastTickSec = 0;
  const tick = () => {
    const left = deadline - Date.now();
    const k = Math.max(0, Math.min(1, left / total));
    fill.style.transform = `scaleX(${k})`;
    bar.classList.toggle('urgent', left <= 3000);
    // 最后 3 秒每秒一声；sec 去重，保证 3/2/1 各响一次而不是每帧都响
    const sec = Math.ceil(left / 1000);
    if (sec <= 3 && sec >= 1 && sec !== S.lastTickSec) {
      S.lastTickSec = sec;
      sfx('tick', { last: sec === 1 });
    }
    if (left <= 0) { stopTurnTimer(); return; }
    S.turnTimerRaf = requestAnimationFrame(tick);
  };
  tick();
}

function renderPrompt(st) {
  // 文案写到 #promptText 子节点，**不能直接写 #promptBar.textContent** ——
  // 那会把同级的 #turnTimer 元素一起清掉，倒计时条会在每次重绘后消失。
  const text = $('#promptText');
  const myTurnNow = st.phase === 'playing' && st.currentPlayerId === st.youId;
  // 轮到自己时屏幕边缘金光呼吸（CSS 负责画，这里只切换开关）
  const game = $('#view-game');
  if (game && game.classList) game.classList.toggle('my-turn', myTurnNow);
  if (!myTurnNow) stopTurnTimer();
  if (st.phase === 'settling') { text.textContent = '本局已结束'; return; }
  const isMyTurn = st.currentPlayerId === st.youId;
  if (!isMyTurn) {
    const cur = st.players.find((p) => p.id === st.currentPlayerId);
    text.textContent = cur ? `等待 ${cur.name} 出牌…` : '…';
    return;
  }
  if (!S.myTurn) { text.textContent = '轮到你…'; return; }
  const legal = S.myTurn.legalMoves;
  if (legal.beats.length === 0 && legal.actions.length === 0) {
    text.textContent = '无可出之牌，将自动收牌…';
  } else {
    text.textContent = '轮到你：请压制（可同点多张）或打出功能牌';
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
    // 逐条错峰落位（55ms 一档）。减弱动效下 animation-delay 被全局清零，不会先空白再出现
    if (li.style) li.style.animationDelay = `${i * 55}ms`;
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

/**
 * 音效出口：只有这一个函数碰 Sfx，且整体 try/catch。
 * 音效失败（没有 AudioContext、浏览器策略拦截、隐私模式）绝不能影响游戏逻辑，
 * 所以调用方永远不需要判断可用性。
 */
function sfx(name, opts) {
  try {
    if (typeof window !== 'undefined' && window.Sfx) window.Sfx.play(name, opts);
  } catch (e) { /* 静默 */ }
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

/* ---------- 压制冲击动画（#fx 层 · 三档强度） ----------
 * 挂在 #table 里的 #fx 层上，位置全部交给 CSS（grid + place-items:center），
 * 因此**不读 getBoundingClientRect、不用 requestAnimationFrame**：
 * 假 DOM 里刻意没有这两个 API，用了动画代码就没法降级；真浏览器也不需要，
 * 因为门槛牌的位置是 CSS 决定的，JS 再量一次只会多出一次强制重排。
 *
 * 清理走双路：主路径听 animationend，兜底 setTimeout(时长 + 200ms) 强制移除。
 * 只靠 animationend 会漏 —— prefers-reduced-motion、标签页进后台、元素被 display:none
 * 时都不触发，节点会越积越多，最后 #fx 变成一座内存坟场。
 */
const FX_MS = { ghost: 260, shock: 420, shockLag: 60, slash: 300, spark: 340 };

/** 反转动画时长（环缩放闪亮 + 「反转」浮字），与 CSS 的 .46s 对齐 */
const DIR_FLIP_MS = 460;

/** 方向归一化：只有 -1 才算逆时针，其余（含 undefined）都按顺时针 */
function stDir(st) {
  return st && st.direction === -1 ? -1 : 1;
}

/** #fx 层；拿不到（老页面/裁剪过的 DOM）就返回 null，所有 FX 静默跳过 */
function fxLayer() {
  const el = $('#fx');
  return el && typeof el.appendChild === 'function' ? el : null;
}

/**
 * 用户是否接受动效。拿不到 matchMedia（沙箱 / 隐私模式 / 老浏览器）一律当作「接受」——
 * 宁可多播一次动画，也不要在拿不到偏好的环境里静默丢掉全部反馈。
 */
function motionOk() {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  } catch (e) { /* matchMedia 在隐私模式/老浏览器可能抛错 → 当作「没有偏好」 */ }
  return true;
}

/**
 * 允许播 FX 吗？三票否决：
 *  1. 没有 createElement（测试沙箱 / 极端环境）
 *  2. 没有 #fx 层
 *  3. 用户要减弱动效
 */
function fxAllowed() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
  if (!fxLayer()) return false;
  return motionOk();
}

/** 造一个带 class 的 div（classList.add 而不是 className：假 DOM 只有 classList） */
function fxEl(...classes) {
  const el = document.createElement('div');
  for (const c of classes) if (c) el.classList.add(c);
  return el;
}

/** 挂上 #fx 并登记双路清理；ms = 该节点的动画总时长 */
function spawnFx(node, ms) {
  const layer = fxLayer();
  if (!layer) return null;
  layer.appendChild(node);
  let dead = false;
  const kill = () => {
    if (dead) return;
    dead = true;
    const p = node.parentNode;
    if (p && typeof p.removeChild === 'function') p.removeChild(node);
  };
  if (typeof node.addEventListener === 'function') node.addEventListener('animationend', kill);
  // 兜底：animationend 万一不触发，也一定在时长后回收（dead 标记让两路只生效一次）
  setTimeout(kill, ms + 200);
  return node;
}

/** 短命类名特效（震桌 / 牌面高光）：没有节点要回收，按时把类名摘掉即可 */
function flashClass(sel, cls, ms) {
  const el = $(sel);
  if (!el || !el.classList) return;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

/**
 * 可重复触发的类名特效：先摘 → 强制重排 → 再加。
 * flashClass 只加不摘，同一个动画在 600ms 内被打断第二次时浏览器会当作「无变化」而不重播；
 * 方向环的反转必须每次都能从头播（连续两张 2·反转 也要看得到），所以单独用这个。
 */
function pulseClass(sel, cls, ms) {
  const el = $(sel);
  if (!el || !el.classList) return;
  el.classList.remove(cls);
  if (el.offsetWidth) void el.offsetWidth; // 重排，让同名动画可重播（假 DOM 没有 offsetWidth）
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

/**
 * 压制（②）/ 连击（③）的冲击组合。
 * @param {{rank:string,suit:string,kind:string}|null} card 上一帧的门槛牌（残影用）
 * @param {number} delta 桌面牌数增量；≥2 视为连击（一次压上多张）
 */
function hitFx(card, delta) {
  if (!fxAllowed()) return;
  const combo = delta >= 2;

  // ① 旧牌残影：被压掉的那张往下沉、歪一点、淡出（260ms）
  if (card) {
    const ghost = fxEl('fx-card-ghost');
    ghost.innerHTML = cardHtml(card); // 复用真实牌面渲染：点数/花色/角色名同源，不另写一套
    spawnFx(ghost, FX_MS.ghost);
  }

  // ② 冲击波：两圈同心圆环，第二圈晚 60ms 起步；连击转朱红
  for (let i = 0; i < 2; i++) {
    spawnFx(
      fxEl('fx-shock', combo ? 'hot' : '', i === 1 ? 'lag' : ''),
      FX_MS.shock + (i === 1 ? FX_MS.shockLag : 0)
    );
  }

  // ③ 斩击线：一道斜向金光，0 → 满宽 180ms，再 120ms 淡出
  spawnFx(fxEl('fx-slash'), FX_MS.slash);

  // ④ 桌面一震 + 牌面金色高光（只加类名，flashClass 负责摘）
  flashClass('#table', 'hit', 600);
  flashClass('#topCard', 'flash', 360);

  // ⑤ 连击：溅出 min(delta, 4) 颗火星（四向散开）
  const sparks = combo ? Math.min(delta, 4) : 0;
  for (let i = 0; i < sparks; i++) {
    spawnFx(fxEl('fx-spark', `p${i}`), FX_MS.spark);
  }
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

  // AI 补位：加/踢都由服务端判断权限与阶段，前端不做前置拦截（避免两侧规则各写一遍）
  $('#btnAddAI').addEventListener('click', () => S.socket.emit('addAI'));
  $('#btnRemoveAI').addEventListener('click', () => S.socket.emit('removeAI'));

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

  // 音效开关：状态存在 localStorage 里（只存用户显式选择），刷新后保持
  const muteBtn = $('#btnMute');
  if (muteBtn && muteBtn.addEventListener) {
    if (typeof window !== 'undefined' && window.Sfx && window.Sfx.isMuted()) {
      muteBtn.classList.add('off');
      if (muteBtn.setAttribute) muteBtn.setAttribute('aria-pressed', 'true');
    }
    muteBtn.addEventListener('click', () => {
      const nowMuted = (typeof window !== 'undefined' && window.Sfx)
        ? window.Sfx.toggle()
        : true;
      muteBtn.classList.toggle('off', !!nowMuted);
      if (muteBtn.setAttribute) muteBtn.setAttribute('aria-pressed', nowMuted ? 'true' : 'false');
      if (nowMuted) toast('音效已关闭');
    });
  }

  // 背景音乐开关：与音效完全独立（音乐不经过音效音量，见 audio.js 的 BGM 电平链）
  const bgmBtn = $('#btnBgm');
  if (bgmBtn && bgmBtn.addEventListener) {
    const paintBgm = (on) => {
      bgmBtn.classList.toggle('off', !on);
      if (bgmBtn.setAttribute) bgmBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    const bgmOnNow = (typeof window !== 'undefined' && window.Sfx && window.Sfx.isBgmOn)
      ? window.Sfx.isBgmOn()
      : true;
    paintBgm(bgmOnNow);
    bgmBtn.addEventListener('click', () => {
      const on = (typeof window !== 'undefined' && window.Sfx && window.Sfx.toggleBgm)
        ? window.Sfx.toggleBgm()
        : false;
      paintBgm(on);
      toast(on ? '背景音乐已开启' : '背景音乐已关闭');
    });
  }

  // 全局按钮点击音：全项目唯一绑在 DOM 层的声音（见调色板 §3）。
  // 用捕获阶段，保证即使某个按钮的 handler 提前 return，点击仍然有反馈。
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', (e) => {
      const t = e && e.target;
      if (!t || typeof t.closest !== 'function') return;
      const btn = t.closest('button');
      if (!btn || btn.id === 'btnMute') return; // 静音键自己有自己的音
      sfx('ui.click');
    }, true);
  }
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
