'use strict';

/**
 * net/net.js — 协议层：Socket.IO 事件接入 → 调用 engine → 按人定制广播。
 * 依赖注入 io（Socket.IO Server 实例）与 rooms（房间 Map），便于测试。
 */

const engine = require('../lib/engine');

/** 断线重连宽限期（ms） */
const RECONNECT_GRACE_MS = 60 * 1000;
/** 正常出牌超时（ms） */
const TURN_TIMEOUT_MS = 30 * 1000;
/** 掉线玩家快速托管超时（ms） */
const DISCONNECTED_TURN_MS = 8 * 1000;
/** 无合法牌时自动收牌延迟（ms） */
const PICKUP_DELAY_MS = 1500;

/** 生成 3 位数字房间码（局域网场景足够，简单好记，如 666/888） */
function makeRoomCode() {
  return String(Math.floor(Math.random() * 900) + 100); // 100~999
}

/** 按人定制的房间视图（防作弊：只暴露本人手牌） */
function getView(room, pid) {
  const publicPlayers = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    seat: p.seat,
    ready: p.ready,
    connected: p.connected,
    handCount: p.hand.length,
    penaltyCount: p.penaltyPile.length,
    isOwner: p.id === room.ownerId,
  }));
  const me = room.players.find((p) => p.id === pid);
  return {
    phase: room.phase,
    roomCode: room.roomCode,
    youId: pid,
    roundNumber: room.roundNumber,
    players: publicPlayers,
    direction: room.direction,
    currentPlayerId: room.currentPlayerId,
    topCard: room.topCard ? { rank: room.topCard.rank, suit: room.topCard.suit, kind: room.topCard.kind } : null,
    topCount: room.topCount || 1,
    tablePileCount: room.tablePile.length,
    drawPileCount: room.drawPile.length,
    hand: me ? me.hand.map((c) => ({ id: c.id, rank: c.rank, suit: c.suit, kind: c.kind })) : [],
    eventLog: room.eventLog.slice(-6),
    lastResult: room.lastResult,
    lastWinnerId: room.lastWinnerId,
  };
}

/**
 * 初始化网络层。
 * @param {object} io Socket.IO Server
 * @param {Map} rooms 房间 Map（roomCode -> Room）
 */
function initNet(io, rooms) {
  const timers = new Map(); // pid -> { turn, pickup }

  function clearPlayerTimers(pid) {
    const t = timers.get(pid);
    if (t) {
      clearTimeout(t.turn);
      clearTimeout(t.pickup);
      timers.delete(pid);
    }
  }

  function clearRoomTimers(room) {
    for (const p of room.players) clearPlayerTimers(p.id);
  }

  function roomOfPlayer(socket) {
    const pid = socket.playerId;
    if (!pid) return null;
    for (const room of rooms.values()) {
      if (room.players.some((p) => p.id === pid)) return room;
    }
    return null;
  }

  function getPlayer(room, pid) {
    return room.players.find((p) => p.id === pid);
  }

  /** 向房间内全体广播按人定制的 state */
  function broadcastState(room) {
    for (const p of room.players) {
      const socket = io.sockets.sockets.get(p.socketId);
      if (socket && p.connected) socket.emit('state', getView(room, p.id));
    }
  }

  function broadcastError(socket, code, message) {
    socket.emit('error', { code, message });
  }

  /** 给当前行动者发送 yourTurn（含合法出牌集合与截止时间），并调度超时托管 */
  function sendTurn(room, pid) {
    const player = getPlayer(room, pid);
    if (!player) return;
    const moves = engine.computeLegalMoves(room, pid);
    const isOffline = !player.connected;
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket && player.connected) {
      const deadline = Date.now() + (isOffline ? DISCONNECTED_TURN_MS : TURN_TIMEOUT_MS);
      socket.emit('yourTurn', { legalMoves: moves, deadline });
    }
    // 无合法牌：快速自动收牌；否则按超时托管（掉线玩家更快托管，避免卡局）
    if (moves.beatIds.length === 0 && moves.actionIds.length === 0) {
      schedulePickup(room, pid, isOffline ? 1000 : PICKUP_DELAY_MS);
    } else {
      scheduleTurn(room, pid, isOffline ? DISCONNECTED_TURN_MS : TURN_TIMEOUT_MS);
    }
  }

  /** 超时托管：最小可压牌 → A → 2 → 收牌 */
  function scheduleTurn(room, pid, delay) {
    clearPlayerTimers(pid);
    const t = timers.get(pid) || {};
    t.turn = setTimeout(() => {
      try {
        engine.autoPlay(room, pid);
        broadcastState(room);
        if (room.phase === 'playing' && room.currentPlayerId) sendTurn(room, room.currentPlayerId);
        else if (room.phase === 'settling') sendGameEnd(room);
      } catch (e) {
        // 托管失败不应使服务器崩溃
      }
    }, delay);
    timers.set(pid, t);
  }

  /** 无合法牌时自动收牌 */
  function schedulePickup(room, pid, delay) {
    const t = timers.get(pid) || {};
    t.pickup = setTimeout(() => {
      try {
        const res = engine.pickUp(room, pid);
        broadcastState(room);
        if (res.action === 'gameOver') sendGameEnd(room);
        else if (room.currentPlayerId) sendTurn(room, room.currentPlayerId);
      } catch (e) {
        // 已过校验（如已出牌），忽略
      }
    }, delay);
    timers.set(pid, t);
  }

  function sendGameEnd(room) {
    if (!room.lastResult) return;
    const winner = room.players.find((p) => p.id === room.lastResult.winnerId);
    for (const p of room.players) {
      const socket = io.sockets.sockets.get(p.socketId);
      if (socket && p.connected) {
        socket.emit('gameEnd', {
          results: room.lastResult.results,
          winnerIds: [room.lastResult.winnerId],
          winnerName: winner ? winner.name : '',
          lastWinnerId: room.lastWinnerId,
        });
      }
    }
  }

  io.on('connection', (socket) => {
    socket.playerId = null;

    const fail = (code, message) => broadcastError(socket, code, message);

    /** 创建房间 */
    socket.on('createRoom', ({ nickname } = {}) => {
      if (!nickname || !nickname.trim()) return fail('NAME_TAKEN', '昵称不能为空');
      const pid = socket.id;
      const name = nickname.trim().slice(0, 12);
      let code;
      do { code = makeRoomCode(); } while (rooms.has(code));
      const room = engine.createRoom(code);
      engine.addPlayer(room, { id: pid, name, socketId: socket.id });
      rooms.set(code, room);
      socket.playerId = pid;
      socket.join(code);
      socket.emit('roomJoined', { roomCode: code, youId: pid, state: getView(room, pid) });
    });

    /** 加入房间 */
    socket.on('joinRoom', ({ roomCode, nickname } = {}) => {
      if (!nickname || !nickname.trim()) return fail('NAME_TAKEN', '昵称不能为空');
      const code = String(roomCode || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return fail('ROOM_NOT_FOUND', '房间不存在');
      if (room.phase !== 'waiting') return fail('GAME_RUNNING', '对局已开始，无法加入');
      if (room.players.length >= 6) return fail('ROOM_FULL', '房间已满');
      if (room.players.some((p) => p.name === nickname.trim())) return fail('NAME_TAKEN', '昵称已被使用');
      const pid = socket.id;
      engine.addPlayer(room, { id: pid, name: nickname.trim().slice(0, 12), socketId: socket.id });
      socket.playerId = pid;
      socket.join(code);
      socket.emit('roomJoined', { roomCode: code, youId: pid, state: getView(room, pid) });
      broadcastState(room);
    });

    /** 断线重连 */
    socket.on('rejoin', ({ roomCode, playerId } = {}) => {
      const room = rooms.get(String(roomCode || '').trim().toUpperCase());
      if (!room) return fail('ROOM_NOT_FOUND', '房间不存在');
      const player = getPlayer(room, playerId);
      if (!player) return fail('PLAYER_NOT_FOUND', '玩家不存在');
      const wasConnected = player.connected;
      player.connected = true;
      player.socketId = socket.id;
      socket.playerId = player.id;
      socket.join(room.roomCode);
      socket.emit('roomJoined', { roomCode: room.roomCode, youId: player.id, state: getView(room, player.id) });
      broadcastState(room);
      // 重连后若轮到自己，立即重发 yourTurn
      if (room.phase === 'playing' && room.currentPlayerId === player.id) sendTurn(room, player.id);
    });

    /** 离开房间 */
    socket.on('leaveRoom', () => {
      const room = roomOfPlayer(socket);
      if (!room) return;
      const pid = socket.playerId;
      if (room.phase === 'waiting') {
        engine.removePlayer(room, pid);
        socket.leave(room.roomCode);
        broadcastState(room);
        if (room.players.length === 0) rooms.delete(room.roomCode);
      } else {
        handleDisconnect(socket);
      }
    });

    /** 准备/取消准备 */
    socket.on('ready', ({ ready } = {}) => {
      const room = roomOfPlayer(socket);
      if (!room) return fail('ROOM_NOT_FOUND', '未在房间中');
      try {
        engine.setReady(room, socket.playerId, !!ready);
        broadcastState(room);
      } catch (e) {
        fail(e.code || 'ERROR', e.message);
      }
    });

    /** 房主开始 */
    socket.on('start', () => {
      const room = roomOfPlayer(socket);
      if (!room) return fail('ROOM_NOT_FOUND', '未在房间中');
      if (room.ownerId !== socket.playerId) return fail('NOT_OWNER', '只有房主可以开始');
      try {
        // 幂等：若房间已在对局中（如房主双击开始按钮触发第二次），不报错，重发当前状态即可
        if (room.phase === 'playing') {
          broadcastState(room);
          sendTurn(room, room.currentPlayerId);
          return;
        }
        engine.startGame(room);
        broadcastState(room);
        sendTurn(room, room.currentPlayerId);
      } catch (e) {
        fail(e.code || 'ERROR', e.message);
      }
    });

    /** 出牌（单张传 cardIds=[id]，组合传同点 2~4 张） */
    socket.on('playCard', ({ cardIds } = {}) => {
      const room = roomOfPlayer(socket);
      if (!room) return fail('ROOM_NOT_FOUND', '未在房间中');
      try {
        const res = engine.playCard(room, socket.playerId, cardIds);
        clearPlayerTimers(socket.playerId);
        broadcastState(room);
        if (res.action === 'gameOver') sendGameEnd(room);
        else sendTurn(room, room.currentPlayerId);
      } catch (e) {
        fail(e.code || 'ERROR', e.message);
      }
    });

    /** 收牌（仅无合法牌时；1.5s 自动执行） */
    socket.on('pickUp', () => {
      const room = roomOfPlayer(socket);
      if (!room) return fail('ROOM_NOT_FOUND', '未在房间中');
      try {
        const res = engine.pickUp(room, socket.playerId);
        clearPlayerTimers(socket.playerId);
        broadcastState(room);
        if (res.action === 'gameOver') sendGameEnd(room);
        else sendTurn(room, room.currentPlayerId);
      } catch (e) {
        fail(e.code || 'ERROR', e.message);
      }
    });

    /** 再来一局 */
    socket.on('nextRound', () => {
      const room = roomOfPlayer(socket);
      if (!room) return fail('ROOM_NOT_FOUND', '未在房间中');
      try {
        engine.nextRound(room);
        broadcastState(room);
      } catch (e) {
        fail(e.code || 'ERROR', e.message);
      }
    });

    /** 掉线处理 */
    function handleDisconnect(socket) {
      const room = roomOfPlayer(socket);
      if (!room) return;
      const player = getPlayer(room, socket.playerId);
      if (!player) return;
      player.connected = false;
      // 掉线时若正轮到自己，走快速托管；否则静默
      if (room.phase === 'playing' && room.currentPlayerId === player.id) {
        scheduleTurn(room, player.id, DISCONNECTED_TURN_MS);
      }
      broadcastState(room);
      // 宽限期后仍未重连则移除（waiting 阶段直接移除；playing 阶段保留座位继续托管，
      // 但若全员掉线则整房删除，避免残留房间干扰新对局）
      setTimeout(() => {
        const fresh = getPlayer(room, player.id);
        if (fresh && !fresh.connected) {
          if (room.phase === 'waiting') {
            engine.removePlayer(room, player.id);
            broadcastState(room);
            if (room.players.length === 0) rooms.delete(room.roomCode);
          } else {
            const allGone = room.players.every((p) => !p.connected);
            if (allGone) rooms.delete(room.roomCode);
          }
        }
      }, RECONNECT_GRACE_MS);
    }

    socket.on('disconnect', () => {
      clearPlayerTimers(socket.playerId);
      handleDisconnect(socket);
    });
  });

  return { getView, broadcastState, clearPlayerTimers };
}

module.exports = { initNet, getView, makeRoomCode };
