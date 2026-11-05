'use strict';
/**
 * public/audio.js — 零素材音效引擎（Web Audio 合成）
 *
 * 参数来源：production/audio/w2-sfx-palette.md（W2-AUD-01）。
 * 硬约束：不加载任何音频文件；不引入依赖；移动 Safari 可用。
 *
 * 三条设计原则（踩过才知道）：
 * 1. **绝不影响游戏逻辑**。任何异常都在内部吞掉，调用方不需要 try。
 * 2. **绝不在没有用户手势时发声**。AudioContext 懒建于首次 pointerdown/keydown，
 *    否则 iOS 会创建一个永远 running 不起来的 context，之后连用户点击也救不回来。
 * 3. **调度用 AudioContext 时间轴，不用 setTimeout**。后台标签会把 setTimeout 节流到
 *    1000ms，多音序列（发牌 5 连响、结算三音）会碎成一团。
 *
 * 调式：D 宫五声（D–E–F#–A–B）。所有音高只允许落在 §1 的频点上，
 * 这是「听起来像同一个游戏」的唯一保证。要换调式，只改 NOTE 这张表。
 */
(function () {
  const KEY_MUTE = 'xyj.audio.muted';
  const KEY_VOL = 'xyj.audio.volume';
  const KEY_BGM = 'xyj.audio.bgm';

  /** D 宫五声 15 个频点（A4=440 十二平均律） */
  const NOTE = {
    D2: 73.42, E2: 82.41, Fs2: 92.50, A2: 110.00, B2: 123.47,
    D3: 146.83, E3: 164.81, Fs3: 185.00, A3: 220.00, B3: 246.94,
    D4: 293.66, E4: 329.63, Fs4: 369.99, A4: 440.00, B4: 493.88,
    D5: 587.33, E5: 659.26, Fs5: 739.99,
  };

  /** 发牌 5 连响的音高递升序列（高八度：锐利但不刺） */
  const DEAL_NOTES = [NOTE.A4, NOTE.B4, NOTE.D5, NOTE.E5, NOTE.Fs5];

  /** 优先级：越大越重要，用于并发抢占 */
  const PRIO = {
    'settle.win': 100, 'settle.lose': 100, take: 90, yourTurn: 80, beat: 60,
    'play.single': 55, 'play.combo': 55, illegal: 40, tick: 30, join: 25, ai: 25, deal: 20, 'ui.click': 10,
  };

  /** 同事件最小间隔（ms）；窗口内重复的处理见 §4 */
  const MINGAP = {
    deal: 40, 'play.single': 90, 'play.combo': 90, beat: 90, take: 320,
    yourTurn: 400, illegal: 260, 'settle.win': 1500, 'settle.lose': 1500,
    join: 200, ai: 200, tick: 900, 'ui.click': 60,
  };

  /** 结算/收牌之后的「让路窗口」内要丢弃的低价值事件 */
  const DUCKED_BY_SETTLE = { 'play.single': 1, 'play.combo': 1, beat: 1, deal: 1, join: 1, ai: 1 };

  const MAX_VOICES = 5;

  let ctx = null;
  let master = null;   // 多声部 1/√n 缩放
  let userGain = null; // 用户音量
  let muteGain = null; // 静音（0/1），与音量分离，互不覆盖
  let limiter = null;
  let noiseBuf = null;

  let muted = read(KEY_MUTE) === '1';
  let volume = clamp01(Number(read(KEY_VOL) || 0.8));

  const lastAt = Object.create(null); // 事件名 -> 上次触发时刻（performance.now）
  const active = [];                  // [{ prio, gain, end }] 当前在响的声部
  let duckPlayUntil = 0;              // 此刻之前丢弃 play/beat 类（给结算/收牌让路）

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : (isFinite(v) ? v : 0.8)); }
  function read(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function write(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 隐私模式无 storage */ } }

  /** 用户开了「减弱动效」：不降音量，只砍装饰性密度（§5 结论） */
  function reducedMotion() {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { return false; }
  }

  function applyGains() {
    if (!ctx) return;
    const t = ctx.currentTime;
    // 感知曲线：线性滑块在低端太钝，^1.6 更接近听感
    userGain.gain.linearRampToValueAtTime(0.75 * Math.pow(volume, 1.6), t + 0.02);
    // 静音用斜坡而不是 suspend —— Safari 上 suspend 之后 restore 经常失败
    muteGain.gain.linearRampToValueAtTime(muted ? 0 : 1, t + 0.02);
  }

  function makeNoiseBuffer(c) {
    // 用 buffer 而不是 oscillator+随机 detune：后者造不出真噪声频谱，还更费 CPU
    const len = Math.floor(c.sampleRate * 0.5); // 不硬编码 44100，iOS 常为 48000
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      userGain = ctx.createGain();
      muteGain = ctx.createGain();
      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 8;
      limiter.ratio.value = 6;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      master.connect(userGain);
      userGain.connect(muteGain);
      muteGain.connect(limiter);
      limiter.connect(ctx.destination);
      // BGM 直连 limiter，既绕过 userGain（音效音量）也绕过 muteGain（音效静音）：
      // 顶栏是两个独立开关，「关音效」不该顺手把音乐也掐了。
      // 仍过 limiter 是为了和音效共用同一道限幅，两者叠加时不会糊掉。
      const bgm = ctx.createGain();
      bgm.gain.value = 0.0001;
      bgm.connect(limiter);
      BGM.gain = bgm;
      noiseBuf = makeNoiseBuffer(ctx);
      applyGains();
      return ctx;
    } catch (e) {
      ctx = null;
      return null;
    }
  }

  /**
   * 一个音（振荡器 + 可选滤波）。
   * 包络规则：起点必须 0.0001（exponentialRamp 不能到 0），attack 用线性斜坡消咔哒。
   */
  function tone(spec, t0, out) {
    const c = ctx;
    const dur = (spec.dur || 120) / 1000;
    const a = spec.a == null ? 0.004 : spec.a;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(spec.vol, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    let head = g;
    if (spec.filter) {
      const bq = c.createBiquadFilter();
      bq.type = spec.filter.type || 'lowpass';
      bq.Q.value = spec.filter.q == null ? 1 : spec.filter.q;
      bq.frequency.setValueAtTime(spec.filter.freq, t0);
      if (spec.filter.to) bq.frequency.exponentialRampToValueAtTime(spec.filter.to, t0 + dur);
      g.connect(bq);
      head = bq;
    }
    head.connect(out);

    const osc = c.createOscillator();
    osc.type = spec.type || 'triangle';
    osc.frequency.setValueAtTime(spec.f0, t0);
    if (spec.f1 && spec.f1 !== spec.f0) osc.frequency.exponentialRampToValueAtTime(spec.f1, t0 + dur);
    osc.connect(g);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    osc.onended = function () {
      try { osc.disconnect(); g.disconnect(); } catch (e) { /* 已断开 */ }
    };
    return g;
  }

  /** 一段噪声（带通/低通扫频）：牌纸、摩擦、报时用 */
  function noise(spec, t0, out) {
    if (!noiseBuf) return;
    const c = ctx;
    const dur = (spec.dur || 90) / 1000;
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    const bq = c.createBiquadFilter();
    bq.type = spec.filter || 'bandpass';
    bq.Q.value = spec.q == null ? 1.4 : spec.q;
    bq.frequency.setValueAtTime(spec.freq, t0);
    if (spec.to) bq.frequency.exponentialRampToValueAtTime(spec.to, t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(spec.vol, t0 + (spec.a == null ? 0.002 : spec.a));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bq); bq.connect(g); g.connect(out);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    src.onended = function () {
      try { src.disconnect(); bq.disconnect(); g.disconnect(); } catch (e) { /* 已断开 */ }
    };
  }

  /* ---------- 事件 → 音色（参数逐条对齐调色板 §2） ---------- */
  const EVENTS = {
    // 发牌：一手 5 张连响，张间固定 45ms
    deal: function (t0, out, o) {
      const n = reducedMotion() ? 1 : Math.max(1, Math.min(5, (o && o.n) || 5));
      for (let i = 0; i < n; i++) {
        const at = t0 + i * 0.045;
        noise({ freq: 1600, to: 1100, q: 1.4, dur: 90, vol: 0.16 }, at, out);
        const f = DEAL_NOTES[i % DEAL_NOTES.length];
        tone({ type: 'triangle', f0: f, f1: f * 0.988, dur: 90, a: 0.002, vol: 0.16 }, at, out);
      }
    },
    'play.single': function (t0, out) {
      tone({ type: 'triangle', f0: NOTE.Fs4, f1: NOTE.Fs4 * 0.988, dur: 150, vol: 0.34 }, t0, out);
    },
    // 组合：低八度垫底 + 8ms 错开，做出「厚」而不是「响」
    'play.combo': function (t0, out, o) {
      const n = Math.max(2, Math.min(4, (o && o.count) || 2));
      const vol = [0, 0, 0.36, 0.40, 0.44][n] || 0.36;
      tone({ type: 'triangle', f0: NOTE.Fs4, dur: 190, vol: vol }, t0, out);
      tone({ type: 'triangle', f0: NOTE.Fs3, dur: 190, vol: vol * 0.5 }, t0 + 0.008, out);
    },
    // 压住了：落 + 上扬，比 play 多一层「成立感」
    beat: function (t0, out) {
      tone({ type: 'triangle', f0: NOTE.A3, f1: NOTE.D4, dur: 180, vol: 0.46 }, t0, out);
    },
    // 收败牌：全场最疼。下坠 + 摩擦长尾（双层）
    take: function (t0, out) {
      tone({
        type: 'sawtooth', f0: NOTE.A3, f1: NOTE.E2, dur: 380, vol: 0.62,
        filter: { type: 'lowpass', freq: 900, to: 380, q: 1 },
      }, t0, out);
      noise({ freq: 2200, filter: 'lowpass', q: 0.7, dur: 380, vol: 0.22 }, t0, out);
    },
    // 轮到你：宫→徵两音，「请」而不是「催」
    yourTurn: function (t0, out) {
      tone({ type: 'sine', f0: NOTE.D4, dur: 170, vol: 0.42 }, t0, out);
      tone({ type: 'sine', f0: NOTE.A4, dur: 170, vol: 0.34 }, t0 + 0.07, out);
    },
    // 非法：闷、钝、下行，绝不刺耳
    illegal: function (t0, out) {
      tone({
        type: 'square', f0: NOTE.B3, f1: NOTE.Fs3, dur: 140, vol: 0.3,
        filter: { type: 'lowpass', freq: 1200, q: 0.7 },
      }, t0, out);
    },
    // 通杀：宫-徵-宫上行（唯一 >400ms，600ms 封顶）
    'settle.win': function (t0, out) {
      const notes = reducedMotion() ? [NOTE.D4, NOTE.A4] : [NOTE.D4, NOTE.A4, NOTE.D5];
      notes.forEach(function (f, i) {
        tone({ type: 'triangle', f0: f, dur: 260, vol: 0.55 / notes.length + 0.18 }, t0 + i * 0.09, out);
      });
    },
    // 别人通杀：低、钝、下行两音，不做哭腔
    'settle.lose': function (t0, out) {
      tone({ type: 'sine', f0: NOTE.B3, f1: NOTE.E3, dur: 380, vol: 0.45 }, t0, out);
      tone({ type: 'triangle', f0: NOTE.B3, f1: NOTE.E3, dur: 380, vol: 0.2 }, t0 + 0.01, out);
    },
    join: function (t0, out) {
      tone({ type: 'triangle', f0: NOTE.E4, f1: NOTE.Fs4, dur: 150, vol: 0.24 }, t0, out);
    },
    // AI 补位：机械感，比「人」低一档，提示这不是人
    ai: function (t0, out) {
      tone({
        type: 'square', f0: NOTE.Fs3, f1: NOTE.E3, dur: 120, vol: 0.24,
        filter: { type: 'lowpass', freq: 900, q: 0.8 },
      }, t0, out);
    },
    // 报时：只报时、不抢注意；剩 1 秒升一阶
    tick: function (t0, out, o) {
      const f = (o && o.last) ? NOTE.Fs3 : NOTE.D3;
      noise({ freq: 900, filter: 'bandpass', q: 6, dur: 50, vol: 0.22 }, t0, out);
      tone({ type: 'square', f0: f, dur: 50, a: 0.001, vol: 0.08 }, t0, out);
    },
    'ui.click': function (t0, out) {
      tone({ type: 'sine', f0: NOTE.A3, f1: NOTE.B3, dur: 60, a: 0.002, vol: 0.18 }, t0, out);
    },
  };

  function prune(now) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].end <= now) active.splice(i, 1);
    }
  }

  /**
   * 播一个事件。内部吞所有异常 —— 音效永远不能把游戏搞挂。
   * @param {string} name EVENTS 的键
   * @param {object} [opts] { n, count, last }
   */
  function play(name, opts) {
    try {
      if (muted) return;
      const fn = EVENTS[name];
      if (!fn) return;
      const c = ensureCtx();
      if (!c) return;
      // iOS：首次必须在用户手势内 resume；失败就丢弃这一声，绝不排队补播
      if (c.state !== 'running') {
        try { c.resume(); } catch (e) { /* 忽略 */ }
        if (c.state !== 'running') return;
      }
      if (typeof document !== 'undefined' && document.hidden) return;

      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const gap = MINGAP[name] || 0;
      let volumeScale = 1;
      if (gap && lastAt[name] && now - lastAt[name] < gap) {
        if (name !== 'take') return;      // 收牌是真实连续发生的，允许重响但压低
        volumeScale = 0.6;
      }
      if (now < duckPlayUntil && DUCKED_BY_SETTLE[name]) return;

      // 并发上限：优先级不高于「最弱在响者」就丢弃，否则抢占它
      prune(c.currentTime);
      if (active.length >= MAX_VOICES) {
        let weakest = 0;
        for (let i = 1; i < active.length; i++) if (active[i].prio < active[weakest].prio) weakest = i;
        const prio = PRIO[name] || 10;
        if (prio <= active[weakest].prio) return;
        try {
          const g = active[weakest].gain;
          g.gain.cancelScheduledValues(c.currentTime);
          g.gain.setValueAtTime(g.gain.value, c.currentTime);
          g.gain.linearRampToValueAtTime(0.0001, c.currentTime + 0.005);
        } catch (e) { /* 忽略 */ }
        active.splice(weakest, 1);
      }

      lastAt[name] = now;
      if (name === 'settle.win' || name === 'settle.lose') duckPlayUntil = now + 600;
      if (name === 'take') duckPlayUntil = Math.max(duckPlayUntil, now + 200);

      const t0 = c.currentTime + 0.02; // 永不用 currentTime 当起点（Safari 会漏音）
      const out = c.createGain();
      out.gain.value = volumeScale;
      out.connect(master);

      // 多声部按 1/√n 缩放，而不是简单相加（避免削波）
      const n = active.length + 1;
      master.gain.setValueAtTime(1 / Math.sqrt(n), t0);

      fn(t0, out, opts);
      active.push({ prio: PRIO[name] || 10, gain: out, end: c.currentTime + 0.8 });
    } catch (e) {
      // 静默：音效失败不影响游戏
    }
  }

  /**
   * 首次手势里调用：建 context 并 resume。
   *
   * 关键点：**不能用 { once: true }**。resume() 有可能因为这次手势不被信任、
   * 或者浏览器正处于某种中间态而不生效，context 会一直是 suspended。
   * 一次性监听一旦被消耗，后面再怎么点都不会再试，用户就永久没声音、只能刷新。
   * 所以改成「每次手势都试，成功（running）后才摘监听」。
   */
  function unlock() {
    try {
      const c = ensureCtx();
      if (!c) return;
      const settle = function () {
        if (!c || c.state !== 'running') return false;
        detachUnlock();
        // 拿到 running 之后才真正起播 BGM：排进 suspended 的上下文等于冻住，
        // 等 resume 时一次性涌出来，听起来像开头一串音糊在一起。
        if (BGM.on && !BGM.timer) bgmStart();
        return true;
      };
      if (settle()) return;
      const p = c.resume();
      if (p && typeof p.then === 'function') p.then(settle, function () { /* 下次手势再试 */ });
    } catch (e) { /* 忽略 */ }
  }

  /** 成功解禁后摘掉监听（宿主不支持 removeEventListener 就算了，重试也无害） */
  function detachUnlock() {
    try {
      if (typeof window.removeEventListener !== 'function') return;
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    } catch (e) { /* 忽略 */ }
  }

  function toggle() {
    muted = !muted;
    write(KEY_MUTE, muted ? '1' : '0');
    applyGains();
    if (!muted) play('ui.click');
    return muted;
  }

  function setVolume(v) {
    volume = clamp01(v);
    write(KEY_VOL, String(volume));
    applyGains();
  }

  /* ---------- 背景音乐（生成式，仍然零素材） ----------
   * 做法：一个 12 秒的五声循环（16 步 × 0.75s），每步最多一个拨弦音，
   * 每 8 步垫一个低音持续音。全部走同一套 D 宫频点，所以与音效同调。
   *
   * 为什么不用 setInterval 直接发声：定时器抖动会让节奏漂。
   * 这里用「提前排程」（lookahead）：每 250ms 检查一次，把未来 1.2 秒内的音
   * 一次性排到 AudioContext 时间轴上，定时器晚到 200ms 也不影响听感。
   */
  const BGM_LEVEL = 0.16;      // 相对 muteGain 的最终电平（压得很低，只做氛围）
  const BGM_STEP = 0.75;       // 每步 0.75 秒
  const BGM_MELODY = [
    'D4', 0, 'A4', 0, 'Fs4', 'E4', 0, 'D4',
    0, 'B3', 'D4', 0, 'A3', 0, 'E4', 0,
  ];

  const BGM = {
    on: read(KEY_BGM) !== '0',
    gain: null,
    timer: null,
    nextTime: 0,
    step: 0,
  };

  /**
   * 定时器取用要防御：某些受限宿主（无 DOM 的沙箱、被 CSP / 特性策略裁掉的环境）
   * 根本没有 setInterval。直接写 setInterval(...) 会在 BGM 启动处抛 ReferenceError，
   * 而调用链上恰好有 try/catch，于是变成「音乐永远不出声且没人知道为什么」。
   * 拿不到就明确降级为「不播 BGM」，音效完全不受影响。
   */
  const TIMER = (function () {
    const w = typeof window !== 'undefined' ? window : null;
    if (w && typeof w.setInterval === 'function' && typeof w.clearInterval === 'function') {
      return { set: w.setInterval.bind(w), clear: w.clearInterval.bind(w) };
    }
    if (typeof setInterval === 'function' && typeof clearInterval === 'function') {
      return { set: setInterval, clear: clearInterval };
    }
    return null;
  })();

  /** 低音持续音：两个正弦叠一个八度，慢起慢落，只做「底」 */
  function bgmDrone(t) {
    const c = ctx;
    [NOTE.D2, NOTE.A2].forEach(function (f, i) {
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(i === 0 ? 0.05 : 0.03, t + 1.2);
      g.gain.linearRampToValueAtTime(0.0001, t + 5.4);
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t);
      osc.connect(g);
      g.connect(BGM.gain);
      osc.start(t);
      osc.stop(t + 5.6);
      osc.onended = function () { try { osc.disconnect(); g.disconnect(); } catch (e) { /* 已断开 */ } };
    });
  }

  /** 拨弦音：三角形 + 低通，1.8 秒自然衰减，模拟古琴的余韵 */
  function bgmNote(name, t) {
    const c = ctx;
    const f = NOTE[name];
    if (!f) return;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    const bq = c.createBiquadFilter();
    bq.type = 'lowpass';
    bq.frequency.setValueAtTime(2200, t);
    bq.frequency.exponentialRampToValueAtTime(700, t + 1.8);
    bq.Q.value = 0.7;
    const osc = c.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f, t);
    osc.connect(g);
    g.connect(bq);
    bq.connect(BGM.gain);
    osc.start(t);
    osc.stop(t + 1.85);
    osc.onended = function () { try { osc.disconnect(); g.disconnect(); bq.disconnect(); } catch (e) { /* 已断开 */ } };
  }

  function bgmSchedule() {
    if (!ctx || !BGM.gain || !BGM.on) return;
    if (ctx.state !== 'running') return;
    const ahead = ctx.currentTime + 1.2;
    // 首次排程从「现在 +0.3s」开始，避免立刻贴脸出声
    if (!BGM.nextTime) BGM.nextTime = ctx.currentTime + 0.3;
    let guard = 0;
    while (BGM.nextTime < ahead && guard++ < 8) {
      const i = BGM.step % BGM_MELODY.length;
      const n = BGM_MELODY[i];
      if (n) bgmNote(n, BGM.nextTime);
      if (i === 0) bgmDrone(BGM.nextTime);
      BGM.nextTime += BGM_STEP;
      BGM.step += 1;
    }
  }

  function bgmStart() {
    const c = ensureCtx();
    if (!c || !BGM.on) return false;
    if (!BGM.gain) return false;
    const t = c.currentTime;
    BGM.gain.gain.cancelScheduledValues(t);
    BGM.gain.gain.setValueAtTime(Math.max(0.0001, BGM.gain.gain.value), t);
    BGM.gain.gain.linearRampToValueAtTime(BGM_LEVEL, t + 1.6);
    BGM.nextTime = 0;
    if (!BGM.timer && TIMER) BGM.timer = TIMER.set(bgmSchedule, 250);
    bgmSchedule();
    return !!BGM.timer;
  }

  function bgmStop() {
    if (BGM.timer && TIMER) { TIMER.clear(BGM.timer); BGM.timer = null; }
    if (!ctx || !BGM.gain) return;
    const t = ctx.currentTime;
    BGM.gain.gain.cancelScheduledValues(t);
    BGM.gain.gain.setValueAtTime(Math.max(0.0001, BGM.gain.gain.value), t);
    BGM.gain.gain.linearRampToValueAtTime(0.0001, t + 0.4);
    BGM.nextTime = 0;
  }

  function toggleBgm() {
    BGM.on = !BGM.on;
    write(KEY_BGM, BGM.on ? '1' : '0');
    if (BGM.on) bgmStart(); else bgmStop();
    return BGM.on;
  }

  // 首次手势解锁（两个都监听：iOS 有时不派发 keydown）。
  // 注意这里不带 once —— 是否摘监听由 unlock 内部在真正 running 后决定。
  try {
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true });
  } catch (e) { /* 老浏览器忽略 */ }

  window.Sfx = {
    play: play,
    unlock: unlock,
    toggle: toggle,
    setVolume: setVolume,
    isMuted: function () { return muted; },
    getVolume: function () { return volume; },
    toggleBgm: toggleBgm,
    isBgmOn: function () { return BGM.on; },
    /**
     * 只读诊断口：真机验收时无法「听」，只能问引擎自己。
     * running 为 AudioContext 状态（suspended 说明还没拿到手势），
     * level 应稳定在 0.16 附近（0.0001 说明起播被挡）。
     */
    bgmState: function () {
      return {
        on: BGM.on,
        running: ctx ? ctx.state : null,
        timer: !!BGM.timer,
        level: BGM.gain ? BGM.gain.gain.value : null,
      };
    },
    startBgm: bgmStart,
    stopBgm: bgmStop,
  };
})();
