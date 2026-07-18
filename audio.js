/*
 * GameAudio — Web Audio API による同期BGM＋効果音エンジン
 *
 * ルミネスの設計思想「操作が音楽になる（シナスタジア）」を再現:
 *  - BPM同期のバックトラック（キック/ハット/スネア/ベース/パッド）
 *  - タイムラインが消したセルは音階（ペンタトニック）で鳴り、旋律になる
 *  - BURST や COMBO などのアクションにも専用SFX
 *
 * 著作権フリー: すべてオシレーター/ノイズからその場で合成（本家楽曲は不使用）
 */
const GameAudio = (() => {
  const BPM = 126;
  const secondsPerBeat = 60 / BPM;
  const STEPS = 32; // 16分 × 2小節

  let ctx = null;
  let master, musicGain, sfxGain, comp;
  let started = false;
  let muted = false;

  // スケジューラ状態
  let currentStep = 0;
  let nextStepTime = 0;
  const lookahead = 25;          // ms
  const scheduleAhead = 0.12;    // s
  let timerId = null;
  let startTime = 0;

  // 音階（Aマイナー・ペンタトニック、複数オクターブ）
  const SCALE = [220.00, 261.63, 293.66, 329.63, 392.00,
                 440.00, 523.25, 587.33, 659.25, 783.99,
                 880.00, 1046.50];

  // ベース進行（2小節・16分×32ステップ、null=休符）
  const A2 = 110.0, C3 = 130.81, D3 = 146.83, E3 = 164.81, G2 = 98.0;
  const bassSeq = [
    A2,null,A2,null, E3,null,null,A2, C3,null,C3,null, G2,null,null,null,
    D3,null,D3,null, A2,null,null,D3, E3,null,E3,null, E3,null,G2,null
  ];
  // パッド（小節ごとのコード根音）
  const padRoots = [220.0, 164.81]; // Am / Em 系

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();

    comp = ctx.createDynamicsCompressor();
    master = ctx.createGain();
    master.gain.value = 0.9;
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.55;
    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.7;

    musicGain.connect(master);
    sfxGain.connect(master);
    master.connect(comp);
    comp.connect(ctx.destination);
  }

  // ===== 汎用シンセ =====
  function tone(freq, t, dur, type, gain, dest, glideTo) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest || sfxGain);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function noise(t, dur, gain, hp, dest) {
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    let node = src;
    if (hp) {
      const f = ctx.createBiquadFilter();
      f.type = "highpass";
      f.frequency.value = hp;
      node.connect(f); node = f;
    }
    node.connect(g).connect(dest || sfxGain);
    src.start(t);
    src.stop(t + dur);
  }

  // ===== ドラム =====
  function kick(t) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(musicGain);
    o.start(t); o.stop(t + 0.24);
  }
  function hat(t, open) {
    noise(t, open ? 0.12 : 0.04, open ? 0.18 : 0.14, 7000, musicGain);
  }
  function snare(t) {
    noise(t, 0.16, 0.28, 1800, musicGain);
    tone(190, t, 0.14, "triangle", 0.18, musicGain);
  }

  // ===== 1ステップの発音 =====
  function scheduleStep(step, t) {
    const bar = Math.floor(step / 16);
    const inBar = step % 16;

    // キック（4つ打ち）
    if (inBar % 4 === 0) kick(t);
    // スネア（2,4拍）
    if (inBar === 4 || inBar === 12) snare(t);
    // ハット（8分、オフでオープン）
    if (inBar % 2 === 0) hat(t, false);
    else if (inBar % 4 === 3) hat(t, true);

    // ベース
    const bf = bassSeq[step];
    if (bf) tone(bf, t, secondsPerBeat * 0.42, "sawtooth", 0.22, musicGain);

    // パッド（各小節頭でコードを長めに）
    if (inBar === 0) {
      const root = padRoots[bar % padRoots.length];
      [1, 1.2, 1.5].forEach((mult) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sawtooth";
        o.frequency.value = root * mult;
        const f = ctx.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.setValueAtTime(500, t);
        f.frequency.linearRampToValueAtTime(1400, t + secondsPerBeat * 2);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.05, t + 0.4);
        g.gain.exponentialRampToValueAtTime(0.0001, t + secondsPerBeat * 3.6);
        o.connect(f).connect(g).connect(musicGain);
        o.start(t); o.stop(t + secondsPerBeat * 3.8);
      });
    }

    // アルペジオ煌めき（16分の一部）
    if (inBar % 4 === 2) {
      const f = SCALE[(step * 3) % SCALE.length];
      tone(f * 2, t, 0.18, "triangle", 0.06, musicGain);
    }
  }

  function scheduler() {
    while (nextStepTime < ctx.currentTime + scheduleAhead) {
      scheduleStep(currentStep, nextStepTime);
      nextStepTime += secondsPerBeat / 4; // 16分音符
      currentStep = (currentStep + 1) % STEPS;
    }
    timerId = setTimeout(scheduler, lookahead);
  }

  // ===== 公開: 開始/停止 =====
  function start() {
    init();
    if (ctx.state === "suspended") ctx.resume();
    if (started) return;
    started = true;
    startTime = ctx.currentTime + 0.08;
    currentStep = 0;
    nextStepTime = startTime;
    scheduler();
  }
  function stop() {
    started = false;
    if (timerId) { clearTimeout(timerId); timerId = null; }
  }

  // ===== 公開: ビート位相（背景演出用 0..1） =====
  function beatPhase() {
    if (!ctx || !started) return 0;
    const el = ctx.currentTime - startTime;
    return (el / secondsPerBeat) % 1;
  }
  function now() { return ctx ? ctx.currentTime : 0; }

  // ===== 公開: 効果音 =====
  // タイムラインが消したセル: 音階で旋律に（index=消えた順, row=高さ）
  function playClear(index, row) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const deg = (index + (9 - row)) % SCALE.length;
    const f = SCALE[deg];
    tone(f, t, 0.28, "triangle", 0.16, sfxGain);
    tone(f * 2, t, 0.2, "sine", 0.06, sfxGain);
  }
  function playLock(col) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = SCALE[col % SCALE.length] * 0.5;
    tone(f, t, 0.12, "square", 0.08, sfxGain);
  }
  function playSquare() {
    if (!ctx) return;
    const t = ctx.currentTime;
    tone(659.25, t, 0.18, "sine", 0.12, sfxGain);
    tone(987.77, t, 0.18, "sine", 0.08, sfxGain);
  }
  function playCombo(level) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const base = 440 * Math.pow(1.12, Math.min(level, 12));
    tone(base, t, 0.2, "triangle", 0.16, sfxGain);
    tone(base * 1.5, t + 0.05, 0.2, "sine", 0.1, sfxGain);
  }
  function playBurst() {
    if (!ctx) return;
    const t = ctx.currentTime;
    // 上昇ライザー
    tone(120, t, 0.6, "sawtooth", 0.22, sfxGain, 1200);
    noise(t, 0.6, 0.2, 400, sfxGain);
    // コード一撃
    [440, 554.37, 659.25, 880].forEach((f) =>
      tone(f, t + 0.18, 0.5, "triangle", 0.14, sfxGain));
  }
  function playGameOver() {
    if (!ctx) return;
    const t = ctx.currentTime;
    [440, 349.23, 261.63, 174.61].forEach((f, i) =>
      tone(f, t + i * 0.16, 0.5, "sawtooth", 0.18, sfxGain, f * 0.5));
  }

  function toggleMute() {
    if (!ctx) return muted;
    muted = !muted;
    master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.02);
    return muted;
  }
  function isMuted() { return muted; }

  return {
    start, stop, beatPhase, now, secondsPerBeat,
    playClear, playLock, playSquare, playCombo, playBurst, playGameOver,
    toggleMute, isMuted,
  };
})();
