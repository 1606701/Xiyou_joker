'use strict';

/**
 * test/audio.test.js — 音效引擎（public/audio.js）单元测试。
 *
 * 为什么要这一层：音频是「听不见就以为没写」的典型模块。
 * 参数表（production/audio/w2-sfx-palette.md）里最容易做错的三件事——
 * 限流窗口、并发上限、静音持久化——全都无法靠肉眼看代码确认。
 *
 * 做法：不引 jsdom，手写一个极简 Web Audio 假件（只实现被调用的方法），
 * 用 node:vm 加载真实的 public/audio.js，然后数「创建了几个节点、参数被怎么排的」。
 * 这套假件故意会**对明显非法的调用抛错**（例如 exponentialRamp 到 0），
 * 所以它能抓到「包络写错」这一类问题，而不只是「有没有报错」。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'audio.js'), 'utf8');

/** AudioParam 假件：记录每次排程；指数斜坡到 0 会抛错（规范禁止） */
function makeParam(v) {
  return {
    value: v,
    calls: [],
    setValueAtTime(x, t) { this.value = x; this.calls.push(['set', x, t]); return this; },
    linearRampToValueAtTime(x, t) { this.value = x; this.calls.push(['lin', x, t]); return this; },
    exponentialRampToValueAtTime(x, t) {
      if (x === 0) throw new Error('exponentialRampToValueAtTime 不能到 0（规范禁止）');
      this.value = x;
      this.calls.push(['exp', x, t]);
      return this;
    },
    cancelScheduledValues(t) { this.calls.push(['cancel', t]); return this; },
  };
}

function makeWebAudio() {
  const made = { osc: [], gain: [], filter: [], src: [], buf: 0 };
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    state: 'running',
    destination: {},
    resume() { ctx.state = 'running'; return Promise.resolve(); },
    createGain() {
      const g = { gain: makeParam(1), connects: 0, disconnect() {} };
      g.connect = () => { g.connects++; };
      made.gain.push(g);
      return g;
    },
    createOscillator() {
      const o = { type: 'sine', frequency: makeParam(440), started: null, stoppedAt: null };
      o.connect = () => {};
      o.disconnect = () => {};
      o.start = (t) => { o.started = t; };
      o.stop = (t) => { o.stoppedAt = t; };
      made.osc.push(o);
      return o;
    },
    createBiquadFilter() {
      const b = { type: 'lowpass', frequency: makeParam(1000), Q: makeParam(1) };
      b.connect = () => {};
      b.disconnect = () => {};
      made.filter.push(b);
      return b;
    },
    createBufferSource() {
      const s = { buffer: null, started: null, stoppedAt: null };
      s.connect = () => {};
      s.disconnect = () => {};
      s.start = (t) => { s.started = t; };
      s.stop = (t) => { s.stoppedAt = t; };
      made.src.push(s);
      return s;
    },
    createBuffer(ch, len) {
      made.buf++;
      return { length: len, getChannelData: () => new Float32Array(len) };
    },
    createDynamicsCompressor() {
      const c = {
        threshold: makeParam(0), knee: makeParam(0), ratio: makeParam(1),
        attack: makeParam(0), release: makeParam(0),
        connect: () => {}, disconnect: () => {},
      };
      return c;
    },
  };
  return { ctx, made };
}

/**
 * 造一个独立运行时。
 * @param {object} [opts] { noAudio: true 表示浏览器不支持 Web Audio }
 */
function makeEnv(opts = {}) {
  const { ctx, made } = makeWebAudio();
  const store = new Map();
  let now = 1000;

  const win = {
    addEventListener() { /* 解锁监听：测试里直接手动 unlock */ },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    matchMedia: () => ({ matches: false }),
  };
  if (!opts.noAudio) win.AudioContext = function AudioContext() { return ctx; };

  const sandbox = {
    window: win,
    document: { hidden: false, addEventListener() {} },
    performance: { now: () => now },
    Math,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'public/audio.js' });

  return {
    Sfx: win.Sfx,
    ctx,
    made,
    store,
    advance(ms) { now += ms; ctx.currentTime += ms / 1000; },
  };
}

/* ============================================================ */

test('懒建 AudioContext：只加载模块不创建上下文（移动端策略要求）', () => {
  const env = makeEnv();
  assert.ok(env.Sfx, 'window.Sfx 应已挂载');
  assert.strictEqual(env.made.osc.length, 0);
  assert.strictEqual(env.made.gain.length, 0);
});

test('显式 unlock 后才建上下文，并挂出 4 段链路（voice→user→mute→limiter）', () => {
  const env = makeEnv();
  env.Sfx.unlock();
  // master / user / mute 三个 Gain + 压缩器
  assert.ok(env.made.gain.length >= 3, `应至少建 3 个 Gain，实际 ${env.made.gain.length}`);
  assert.strictEqual(env.made.buf, 1, '噪声 buffer 只应生成 1 次并复用');
});

test('play.ui.click 产生 1 个振荡器；60ms 内连点 10 次只响 1 次', () => {
  const env = makeEnv();
  env.Sfx.unlock();
  env.Sfx.play('ui.click');
  const afterFirst = env.made.osc.length;
  assert.strictEqual(afterFirst, 1);

  for (let i = 0; i < 10; i++) env.Sfx.play('ui.click'); // 同一时刻连点
  assert.strictEqual(env.made.osc.length, afterFirst, '限流窗口内的重复点击必须被丢弃');

  env.advance(100);
  env.Sfx.play('ui.click');
  assert.strictEqual(env.made.osc.length, afterFirst + 1, '过了 minGap 应能再响');
});

test('take 是双层（锯齿 + 噪声），且允许重响但音量压到 0.6', () => {
  const env = makeEnv();
  env.Sfx.unlock();
  env.Sfx.play('take');
  assert.strictEqual(env.made.osc.length, 1, 'take 应有 1 个锯齿振荡器');
  assert.strictEqual(env.made.src.length, 1, 'take 应有 1 个噪声源（摩擦长尾）');

  env.advance(50); // 在 320ms minGap 内
  env.Sfx.play('take');
  assert.strictEqual(env.made.osc.length, 2, 'take 必须允许重响（连续收牌是真实发生的）');
  const lastGain = env.made.gain.filter((g) => g.gain.value === 0.6);
  assert.ok(lastGain.length >= 1, '窗口内重响的 take 应把输出压到 0.6');
});

test('deal 一手 5 张 = 5 声（噪声 + 音调各一），减弱动效时压成 1 声', () => {
  const env = makeEnv();
  env.Sfx.unlock();
  env.Sfx.play('deal', { n: 5 });
  assert.strictEqual(env.made.osc.length, 5, '应排 5 个音调');
  assert.strictEqual(env.made.src.length, 5, '应排 5 段噪声');
  // 张间 45ms：第 5 张应在 t0 + 0.18s
  const starts = env.made.osc.map((o) => o.started);
  assert.ok(starts[4] - starts[0] > 0.15, `张间应错开 45ms，实际跨度 ${starts[4] - starts[0]}`);
});

test('并发上限 5：满员时低优先级被丢弃，高优先级能抢占并淡出被抢声部', () => {
  const env = makeEnv();
  env.Sfx.unlock();
  // 排满 5 个声部：yourTurn(80,2 音) / beat(60) / play.single(55) / join(25) / ai(25)
  const names = ['yourTurn', 'beat', 'play.single', 'join', 'ai'];
  for (const n of names) env.Sfx.play(n);
  const full = env.made.osc.length;
  assert.strictEqual(full, 6, '5 个事件应产生 6 个振荡器（yourTurn 两音）');

  // 满员时 ui.click(10) 优先级低于最弱在响者(25) → 必须被丢弃
  env.Sfx.play('ui.click');
  assert.strictEqual(env.made.osc.length, full, '低优先级事件在满员时应被丢弃，不得新增节点');

  // settle.win(100) → 抢占最弱的 join(25)，并且照常落子
  env.Sfx.play('settle.win');
  assert.strictEqual(env.made.osc.length, full + 3, '高优先级事件应抢占并正常发声（三音）');

  // 抢占证据：被抢声部走的是 cancelScheduledValues + 5ms 线性淡出，而不是硬切（硬切会爆音）
  const preempted = env.made.gain.some((g) => g.gain.calls.some((c) => c[0] === 'cancel')
    && g.gain.calls.some((c) => c[0] === 'lin' && c[1] === 0.0001));
  assert.ok(preempted, '抢占必须对被抢声部做 5ms 淡出，硬切会产生爆音');
});

test('非法事件名 / 浏览器不支持 Web Audio：不抛错且不产生节点', () => {
  const env = makeEnv();
  env.Sfx.unlock();
  const before = env.made.osc.length;
  assert.doesNotThrow(() => env.Sfx.play('不存在的音效'));
  assert.strictEqual(env.made.osc.length, before);

  const noAudio = makeEnv({ noAudio: true });
  assert.doesNotThrow(() => noAudio.Sfx.play('take'));
  assert.strictEqual(noAudio.made.osc.length, 0);
  assert.strictEqual(noAudio.Sfx.toggle(), true, '即使没有音频，静音状态也应能切换');
});

test('静音：切换后不再产生节点；状态写进 localStorage，重新加载仍静音', () => {
  const env = makeEnv();
  env.Sfx.unlock();
  env.Sfx.play('ui.click');
  const base = env.made.osc.length;

  const nowMuted = env.Sfx.toggle();
  assert.strictEqual(nowMuted, true);
  assert.strictEqual(env.store.get('xyj.audio.muted'), '1');

  env.advance(500);
  env.Sfx.play('beat');
  assert.strictEqual(env.made.osc.length, base, '静音后不应再产生任何声部');
  assert.strictEqual(env.Sfx.isMuted(), true);
});

test('包络：所有增益都从 0.0001 起、指数收尾，绝不出现指数斜坡到 0', () => {
  const env = makeEnv();
  env.Sfx.unlock();
  ['play.single', 'play.combo', 'beat', 'take', 'yourTurn', 'illegal', 'settle.win', 'settle.lose', 'join', 'ai', 'tick'].forEach((n) => {
    env.advance(2000); // 拉开间隔，避免被限流吃掉
    assert.doesNotThrow(() => env.Sfx.play(n, { count: 3, last: true }), `${n} 不应抛错`);
  });
  // 没有抛错本身即证明：没有任何一处 exponentialRampToValueAtTime(0)
  const oscs = env.made.osc;
  assert.ok(oscs.length > 10, `应产生足够多的声部，实际 ${oscs.length}`);
  // 每个声部都必须在未来被 stop（否则声部不释放，并发计数会永久虚高）
  for (const o of oscs) assert.ok(o.stoppedAt != null, '每个振荡器都必须被 stop');
});
