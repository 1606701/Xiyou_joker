'use strict';

/* ===== 西游斗牌 · 前端逻辑 ===== */
const $ = (sel) => document.querySelector(sel);

const AVATARS = ['🐵', '🐷', '🦁', '🐉', '🐰', '🦊'];
const KIND_CLS = { monster: 'monster', disciple: 'disciple', master: 'master', action: 'action' };
const RANK_SHOW = { SJ: '小王', BJ: '大王' };
// 牌面对应的西游名称（与 lib/cards.js 保持一致；客户端无模块系统，故本地维护一份）
const CARD_NAMES = {
  '3': '沙僧', '5': '孙悟空', '8': '八戒', '10': '唐僧',
  '4': '小妖', '6': '黑熊精', '7': '黄风怪', '9': '白骨精',
  J: '红孩儿', Q: '牛魔王', K: '青牛精',
  SJ: '六耳猕猴', BJ: '金翅大鹏',
  A: '跳过', '2': '反转',
};
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
  DEFAULT: '操作失败',
};

const S = {
  socket: null,
  state: null,        // 最近一次 state 视图
  myTurn: null,       // { legalMoves, deadline }
  selectedIds: [],     // 选中的手牌 id（可多选同点牌组成组合）
  nickname: '',
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

/* ---------- Socket ---------- */
function connectSocket() {
  S.socket = io();

  S.socket.on('connect', () => {
    $('#connBanner').classList.add('hidden');
    // 刷新页面 / 断线恢复：尝试回原座位
    const roomCode = sessionStorage.getItem('roomCode');
    const playerId = sessionStorage.getItem('playerId');
    if (roomCode && playerId) {
      S.socket.emit('rejoin', { roomCode, playerId });
    }
  });

  S.socket.on('disconnect', () => {
    $('#connBanner').classList.remove('hidden');
  });

  S.socket.on('roomJoined', ({ roomCode, youId, state }) => {
    sessionStorage.setItem('roomCode', roomCode);
    sessionStorage.setItem('playerId', youId);
    S.state = state;
    S.myTurn = null;
    S.selectedIds = [];
    showView(state.phase === 'waiting' ? 'view-room' : 'view-game');
    renderRoom();
    if (state.phase !== 'waiting') renderGame();
  });

  S.socket.on('state', (state) => {
    S.state = state;
    // 回合切换时清空选中
    if (S.myTurn && (!state.phase || state.phase === 'waiting')) {
      S.myTurn = null;
      S.selectedIds = [];
    }
    if (state.phase === 'waiting') { renderRoom(); return; }
    if (state.phase === 'settling') { renderGame(); return; }
    renderGame();
  });

  S.socket.on('yourTurn', ({ legalMoves, deadline }) => {
    S.myTurn = { legalMoves, deadline };
    S.selectedIds = [];
    renderGame();
  });

  S.socket.on('gameEnd', (data) => {
    S.myTurn = null;
    S.selectedIds = [];
    showSettle(data);
  });

  S.socket.on('error', ({ code }) => {
    toast(ERROR_TEXT[code] || ERROR_TEXT.DEFAULT);
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
  showView('view-home');
}

function renderRoom() {
  const st = S.state;
  if (!st) return;
  $('#roomCodeBig').textContent = st.roomCode;
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
      <div><span class="seat-no">${p.seat + 1}</span><span class="name">${escapeHtml(p.name)}${p.id === meId ? '（我）' : ''}</span></div>
      <div>${badges.join('')}</div>`;
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
  { left: 50, top: 86 }, // 下中（我方）
  { left: 90, top: 78 }, // 右下
  { left: 93, top: 10 }, // 右上
  { left: 50, top: 7 },  // 上中
  { left: 7, top: 10 },  // 左上
  { left: 10, top: 78 }, // 左下
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
    const avatar = AVATARS[p.seat % AVATARS.length];
    seat.innerHTML = `
      <div class="avatar">${p.connected ? avatar : '💤'}</div>
      <div class="sname">${escapeHtml(p.name)}${p.id === st.youId ? '（我）' : ''}${p.isOwner ? '👑' : ''}</div>
      <div class="smeta">${p.handCount}张${p.penaltyCount ? `<span class="penalty">败${p.penaltyCount}</span>` : ''}</div>`;
    el.appendChild(seat);
  });
}

function cardHtml(card, extraCls = '') {
  const rank = RANK_SHOW[card.rank] || card.rank;
  const name = CARD_NAMES[card.rank] || rank;
  return `<div class="card ${extraCls}" data-id="${escapeHtml(card.id)}">
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
    topEl.innerHTML = cardHtml(top, 'back-hide') + badge;
  } else {
    topEl.innerHTML = '<div class="card back" style="cursor:default"></div><div style="font-size:11px;color:var(--text-dim);margin-top:2px">新一轮：任意出牌</div>';
  }
  $('#tableInfo').textContent = `桌面共 ${st.tablePileCount} 张`;
  $('#eventLog').innerHTML = (st.eventLog || []).slice(-3).map((e) => `<div>${escapeHtml(e)}</div>`).join('');
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

  st.hand.forEach((card) => {
    const canPlay = legal && (beatIds.has(card.id) || actionIds.has(card.id));
    const cls = [];
    if (canPlay) cls.push('playable');
    if (S.selectedIds.includes(card.id)) cls.push('selected');
    if (!canPlay) cls.push('disabled');
    const div = document.createElement('div');
    div.innerHTML = cardHtml(card, cls.join(' '));
    const node = div.firstElementChild;
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
function showSettle(data) {
  const list = $('#resultList');
  list.innerHTML = '';
  data.results.forEach((r, i) => {
    const li = document.createElement('li');
    li.classList.toggle('winner', r.id === data.winnerIds[0]);
    li.innerHTML = `
      <span>${i + 1}. ${escapeHtml(r.name)}${r.id === data.winnerIds[0] ? ' 🏆 通杀' : ''}${r.id === S.state.youId ? '（我）' : ''}</span>
      <span class="pen">败牌 ${r.penaltyCount} 张</span>`;
    list.appendChild(li);
  });
  $('#winnerBanner').textContent = `🏆 ${escapeHtml(data.winnerName)} 通杀！`;
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
    S.socket.emit('playCard', { cardIds: S.selectedIds });
    S.selectedIds = [];
  });

  $('#btnPickup').addEventListener('click', () => S.socket.emit('pickUp'));

  $('#btnNextRound').addEventListener('click', () => S.socket.emit('nextRound'));
}

/* ---------- 启动 ---------- */
document.addEventListener('DOMContentLoaded', () => {
  if (!$('#nickname').value) $('#nickname').value = makeDefaultNickname();
  bindEvents();
  connectSocket();
});
