/*
 * GameAudio — Web Audio API による本格シンセBGM＋効果音エンジン v3
 *
 * 「操作が音楽になる」体験を、エジプト風の情景に合わせて高品質に:
 *  - 24小節の楽曲構成 (A:イントロ → B:ビルド → C:ドロップ) で抑揚を作る
 *  - コード進行は 12コード(2小節ごと)で展開: Am F C G / Dm Am E Am / F C Dm E
 *  - リードは A フリジアン・ドミナント(エジプト音階)で異国情緒
 *  - スーパーソー・パッド / プラック・アルペジオ / サブ+ミッドベース / デチューン・リード
 *  - 合成IRリバーブ + 付点8分ディレイ、キック連動サイドチェインの「うねり」
 *  - セクションごとに楽器・音量・フィルターが変化し、ライザー/フィル/クラッシュで展開
 *  - ゲーム状況でも小さくレイヤーが増減 (setIntensity)
 *  - 消去音は FM ベル + 残響、列位置でステレオパン
 *
 * 著作権フリー: すべてオシレーター/ノイズから合成（本家楽曲は不使用）
 */
const GameAudio = (() => {
  const BPM = 126;
  const spb = 60 / BPM;
  const STEP = spb / 4;
  const BARS = 24;                // 3倍の長さ
  const TOTAL_STEPS = BARS * 16;

  let ctx = null;
  let master, comp, duck, drumBus, sfxBus;
  let reverb, revReturn, delay, delFb, delReturn;
  let started = false;
  let muted = false;
  let intensity = 1;

  let currentStep = 0;
  let nextStepTime = 0;
  let startTime = 0;
  let timerId = null;
  const lookahead = 25;
  const scheduleAhead = 0.16;

  // ===== 音楽データ =====
  const CH = {
    Am: { root: 110.00, tones: [220.00, 261.63, 329.63, 440.00] },
    F:  { root: 87.31,  tones: [174.61, 220.00, 261.63, 349.23] },
    C:  { root: 130.81, tones: [261.63, 329.63, 392.00, 523.25] },
    G:  { root: 98.00,  tones: [196.00, 246.94, 293.66, 392.00] },
    Dm: { root: 146.83, tones: [293.66, 349.23, 440.00, 587.33] },
    E:  { root: 164.81, tones: [329.63, 415.30, 493.88, 659.25] }, // E major(和声的短調のドミナント)
  };
  // 24小節 = 12コード × 2小節
  const PROG = [CH.Am, CH.F, CH.C, CH.G, CH.Dm, CH.Am, CH.E, CH.Am, CH.F, CH.C, CH.Dm, CH.E];
  function chordForBar(bar) { return PROG[Math.floor(bar / 2) % PROG.length]; }

  // 消去音・アルペジオ用（Aマイナー・ペンタトニック）
  const SCALE = [220.00, 261.63, 293.66, 329.63, 392.00,
                 440.00, 523.25, 587.33, 659.25, 783.99, 880.00, 1046.50];

  // リード用（A フリジアン・ドミナント = エジプト音階: A Bb C# D E F G）
  const E = [220.00, 233.08, 277.18, 293.66, 329.63, 349.23, 392.00,
             440.00, 466.16, 554.37, 587.33, 659.25];
  const N = null;
  // フレーズA（2小節=32ステップ、しっとり）
  const PHRASE_A = [
    E[7], N, N, E[6], E[5], N, E[4], N, E[2], N, E[3], N, E[4], N, N, N,
    E[5], N, E[4], N, E[2], N, N, E[1], E[0], N, N, N, N, N, N, N,
  ];
  // フレーズB（2小節、より動きのある盛り上げ）
  const PHRASE_B = [
    E[9], N, E[8], N, E[7], N, N, E[6], E[5], N, E[6], E[5], E[4], N, N, N,
    E[7], N, E[6], E[5], E[4], N, E[2], N, E[3], N, E[4], N, E[2], N, E[0], N,
  ];
  // アルペジオ・パターン（コードトーンのインデックス）
  const ARP = [0, 2, 1, 3, 2, 0, 3, 1, 0, 2, 3, 1, 2, 3, 1, 2];

  // ===== 初期化 =====
  function makeIR(dur, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * dur);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();

    master = ctx.createGain(); master.gain.value = 0.85;
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 5; comp.knee.value = 8;
    master.connect(comp); comp.connect(ctx.destination);

    reverb = ctx.createConvolver(); reverb.buffer = makeIR(2.8, 3.0);
    revReturn = ctx.createGain(); revReturn.gain.value = 0.42;
    reverb.connect(revReturn); revReturn.connect(master);

    delay = ctx.createDelay(1.0); delay.delayTime.value = spb * 0.75;
    delFb = ctx.createGain(); delFb.gain.value = 0.36;
    const delLp = ctx.createBiquadFilter(); delLp.type = "lowpass"; delLp.frequency.value = 3200;
    delay.connect(delLp); delLp.connect(delFb); delFb.connect(delay);
    delReturn = ctx.createGain(); delReturn.gain.value = 0.5;
    delLp.connect(delReturn); delReturn.connect(master);
    delLp.connect(reverb);

    duck = ctx.createGain(); duck.gain.value = 1; duck.connect(master);
    drumBus = ctx.createGain(); drumBus.gain.value = 1; drumBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(master);
  }

  function send(node, dest, amt) {
    const g = ctx.createGain(); g.gain.value = amt;
    node.connect(g); g.connect(dest);
  }

  // ===== 基本ボイス =====
  function tone(freq, t, dur, type, gain, dest, opts = {}) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (opts.glide) o.frequency.exponentialRampToValueAtTime(opts.glide, t + dur);
    if (opts.detune) o.detune.value = opts.detune;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + (opts.attack || 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = g;
    if (opts.pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner(); p.pan.value = opts.pan; g.connect(p); node = p;
    }
    node.connect(dest);
    if (opts.rev) send(node, reverb, opts.rev);
    if (opts.del) send(node, delay, opts.del);
    o.connect(g); o.start(t); o.stop(t + dur + 0.05);
  }

  function noise(t, dur, gain, dest, opts = {}) {
    const n = Math.floor(ctx.sampleRate * Math.max(0.02, dur));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, opts.decay ?? 1);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = gain;
    let node = src;
    if (opts.hp) { const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = opts.hp; node.connect(f); node = f; }
    if (opts.bp) { const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = opts.bp; f.Q.value = opts.q ?? 1; node.connect(f); node = f; }
    node.connect(g); g.connect(dest);
    if (opts.rev) send(g, reverb, opts.rev);
    src.start(t); src.stop(t + dur);
  }

  function bell(freq, t, dur, gain, dest, opts = {}) {
    const car = ctx.createOscillator(), mod = ctx.createOscillator();
    const mg = ctx.createGain(), g = ctx.createGain();
    car.frequency.value = freq;
    mod.frequency.value = freq * (opts.ratio || 2.76);
    mg.gain.setValueAtTime(freq * 1.6, t);
    mg.gain.exponentialRampToValueAtTime(1, t + dur * 0.8);
    mod.connect(mg); mg.connect(car.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = g;
    if (opts.pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner(); p.pan.value = opts.pan; g.connect(p); node = p;
    }
    node.connect(dest);
    if (opts.rev) send(node, reverb, opts.rev);
    if (opts.del) send(node, delay, opts.del);
    car.connect(g);
    car.start(t); car.stop(t + dur + 0.05);
    mod.start(t); mod.stop(t + dur + 0.05);
  }

  // ===== ドラム =====
  function kick(t, vel = 1) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    g.gain.setValueAtTime(0.95 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(g); g.connect(drumBus);
    o.start(t); o.stop(t + 0.26);
    noise(t, 0.02, 0.3 * vel, drumBus, { hp: 3000, decay: 2 });
    duck.gain.cancelScheduledValues(t);
    duck.gain.setValueAtTime(1, t);
    duck.gain.linearRampToValueAtTime(0.45, t + 0.015);
    duck.gain.linearRampToValueAtTime(1, t + 0.3);
  }
  function clap(t, vel = 1) {
    for (let i = 0; i < 3; i++) noise(t + i * 0.012, 0.05, 0.22 * vel, drumBus, { bp: 1500, q: 0.9, decay: 1.5 });
    noise(t + 0.03, 0.25, 0.16 * vel, drumBus, { bp: 1800, q: 0.7, decay: 2.5, rev: 0.5 });
  }
  function hatC(t, vel = 1) { noise(t, 0.035, 0.16 * vel, drumBus, { hp: 8500, decay: 1.8 }); }
  function hatO(t, vel = 1) { noise(t, 0.16, 0.14 * vel, drumBus, { hp: 7500, decay: 1.2 }); }
  function crash(t) { noise(t, 1.6, 0.26, drumBus, { hp: 5200, decay: 2.2, rev: 0.9 }); }
  function snareRoll(t, vel) { noise(t, 0.09, 0.15 * vel, drumBus, { bp: 2000, q: 0.8, decay: 1.4 }); }

  // ===== 楽器 =====
  function pad(chord, t, bright) {
    const dur = spb * 8;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass";
    const peak = bright ? 2200 : 1300;
    lp.frequency.setValueAtTime(420, t);
    lp.frequency.linearRampToValueAtTime(peak + intensity * 300, t + dur * 0.6);
    lp.frequency.linearRampToValueAtTime(600, t + dur);
    const g = ctx.createGain();
    const amp = bright ? 0.06 : 0.045;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.5);
    g.gain.setValueAtTime(amp, t + dur - 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g); g.connect(duck); send(g, reverb, 0.7);
    chord.tones.forEach((f) => {
      [-9, 0, 9].forEach((cents) => {
        const o = ctx.createOscillator();
        o.type = "sawtooth"; o.frequency.value = f; o.detune.value = cents;
        const og = ctx.createGain(); og.gain.value = 0.10;
        o.connect(og); og.connect(lp);
        o.start(t); o.stop(t + dur + 0.1);
      });
    });
  }

  function bass(freq, t, dur, vel = 1) {
    tone(freq / 2, t, dur, "sine", 0.34 * vel, duck, { attack: 0.004 });
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2 * vel, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = freq;
    o.connect(lp); lp.connect(g); g.connect(duck);
    o.start(t); o.stop(t + dur + 0.03);
  }

  function pluck(freq, t, vel = 1) {
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 3;
    lp.frequency.setValueAtTime(3500 + intensity * 900, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12 * vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = freq;
    o.connect(lp); lp.connect(g); g.connect(duck); send(g, delay, 0.35);
    o.start(t); o.stop(t + 0.24);
  }

  function lead(freq, t, dur, vel = 1) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09 * vel, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(duck); send(g, delay, 0.55); send(g, reverb, 0.4);
    const vib = ctx.createOscillator(), vg = ctx.createGain();
    vib.frequency.value = 5.5; vg.gain.value = 4; vib.connect(vg);
    [-6, 6].forEach((cents) => {
      const o = ctx.createOscillator();
      o.type = "square"; o.frequency.value = freq; o.detune.value = cents;
      vg.connect(o.detune); o.connect(g);
      o.start(t); o.stop(t + dur + 0.05);
    });
    vib.start(t); vib.stop(t + dur + 0.05);
  }

  function riser(t) {
    const dur = spb * 8; // 2小節
    const o = ctx.createOscillator(); o.type = "sawtooth";
    o.frequency.setValueAtTime(80, t);
    o.frequency.exponentialRampToValueAtTime(900, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(duck); send(g, reverb, 0.6);
    o.start(t); o.stop(t + dur + 0.05);
    noise(t, dur, 0.05, drumBus, { hp: 2500, decay: 0.2, rev: 0.5 });
  }

  function arpNote(chord, inBar) {
    const p = ARP[inBar];
    return chord.tones[p % chord.tones.length] * (p >= 2 ? 2 : 1);
  }
  function leadNote(bar, inBar, phrase) {
    const arr = phrase === "B" ? PHRASE_B : PHRASE_A;
    return arr[(bar % 2) * 16 + inBar];
  }

  // ===== シーケンサー（セクション構成で抑揚） =====
  // A: 0-7(イントロ) / B: 8-15(ビルド) / C: 16-23(ドロップ)
  function scheduleStep(step, t) {
    const bar = Math.floor(step / 16);
    const inBar = step % 16;
    const sec = bar < 8 ? "A" : bar < 16 ? "B" : "C";
    const chord = chordForBar(bar);

    // --- ドラム ---
    if (sec === "A") { if (bar >= 2 && inBar % 4 === 0) kick(t, 0.85); }
    else if (inBar % 4 === 0) kick(t, sec === "C" ? 1 : 0.92);

    if (sec !== "A" && (inBar === 4 || inBar === 12)) clap(t, sec === "C" ? 1 : 0.8);

    if (sec === "B") { if (inBar % 2 === 0) hatC(t, 0.8); if (inBar % 4 === 2) hatO(t, 0.7); }
    if (sec === "C") {
      if (inBar % 2 === 0) hatC(t, 1);
      if (inBar % 4 === 2) hatO(t, 0.9);
      if (inBar % 2 === 1) hatC(t, 0.4);
    }
    if (intensity >= 3 && sec !== "A" && inBar % 2 === 1) hatC(t, 0.3);

    // クラッシュ（各セクション頭・ループ頭）
    if (inBar === 0 && (bar === 0 || bar === 8 || bar === 16)) crash(t);
    // ライザー（ドロップ直前 14-15小節）
    if (bar === 14 && inBar === 0) riser(t);
    // スネアフィル（ループ折返し前 23小節後半）
    if (bar === 23 && inBar >= 8) snareRoll(t, 0.4 + (inBar - 8) * 0.07);

    // --- ベース ---
    if (sec === "B" && inBar % 4 === 2) bass(chord.root, t, STEP * 3, 0.9);
    if (sec === "C") {
      if (inBar % 4 === 2) bass(chord.root, t, STEP * 3, 1);
      if (inBar === 7 || inBar === 15) bass(chord.root * 1.5, t, STEP * 1.5, 0.7);
    }

    // --- パッド（2小節ごと。Cは明るく） ---
    if (bar % 2 === 0 && inBar === 0) pad(chord, t, sec === "C");

    // --- アルペジオ（Aは疎、Bは8分、Cは16分） ---
    if (sec === "A" && inBar % 4 === 0) pluck(arpNote(chord, inBar), t, 0.5);
    if (sec === "B" && inBar % 2 === 0) pluck(arpNote(chord, inBar), t, 0.7);
    if (sec === "C") pluck(arpNote(chord, inBar), t, inBar % 4 === 0 ? 1 : 0.6);

    // --- リード（エジプト音階。Bで導入、Cで主役） ---
    if (sec === "B") { const n = leadNote(bar, inBar, "A"); if (n) lead(n, t, STEP * 3, 0.6); }
    if (sec === "C") { const n = leadNote(bar, inBar, bar < 20 ? "A" : "B"); if (n) lead(n, t, STEP * 3, 1); }
  }

  function scheduler() {
    while (nextStepTime < ctx.currentTime + scheduleAhead) {
      scheduleStep(currentStep, nextStepTime);
      nextStepTime += STEP;
      currentStep = (currentStep + 1) % TOTAL_STEPS;
    }
    timerId = setTimeout(scheduler, lookahead);
  }

  // ===== 公開 =====
  function start() {
    init();
    if (ctx.state === "suspended") ctx.resume();
    if (started) return;
    started = true;
    startTime = ctx.currentTime + 0.06;
    currentStep = 0; nextStepTime = startTime;
    scheduler();
  }
  function stop() { started = false; if (timerId) { clearTimeout(timerId); timerId = null; } }
  function beatPhase() { if (!ctx || !started) return 0; return ((ctx.currentTime - startTime) / spb) % 1; }
  function barPhase() { if (!ctx || !started) return 0; return ((ctx.currentTime - startTime) / (spb * 4)) % 1; }
  function now() { return ctx ? ctx.currentTime : 0; }
  function setIntensity(v) { intensity = Math.max(0, Math.min(3, v)); }
  // 現在のセクション（背景演出との連動用）: 0=A,1=B,2=C
  function section() {
    if (!ctx || !started) return 0;
    const bar = Math.floor(((ctx.currentTime - startTime) / spb / 4)) % BARS;
    return bar < 8 ? 0 : bar < 16 ? 1 : 2;
  }

  // ===== 効果音 =====
  function playClear(index, row, pan = 0) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const deg = Math.min(SCALE.length - 1, (index + (9 - row)) % SCALE.length);
    bell(SCALE[deg], t, 0.5, 0.14, sfxBus, { pan, rev: 0.8, del: 0.3 });
  }
  function playLock(col) {
    if (!ctx) return;
    const t = ctx.currentTime;
    tone(SCALE[col % SCALE.length] * 0.5, t, 0.09, "triangle", 0.09, sfxBus, { pan: (col / 16) * 1.6 - 0.8 });
    noise(t, 0.03, 0.06, sfxBus, { hp: 2500, decay: 2 });
  }
  function playSquare() {
    if (!ctx) return;
    const t = ctx.currentTime;
    bell(659.25, t, 0.4, 0.1, sfxBus, { rev: 0.6 });
    bell(987.77, t + 0.04, 0.35, 0.06, sfxBus, { rev: 0.6 });
  }
  function playCombo(level) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const base = 440 * Math.pow(1.122, Math.min(level, 10));
    [1, 1.25, 1.5].forEach((r, i) => bell(base * r, t + i * 0.055, 0.4, 0.1, sfxBus, { rev: 0.7, del: 0.3 }));
  }
  function playBurst() {
    if (!ctx) return;
    const t = ctx.currentTime;
    tone(100, t, 0.5, "sawtooth", 0.2, sfxBus, { glide: 1600, rev: 0.5 });
    noise(t, 0.5, 0.18, sfxBus, { hp: 800, decay: 0.3, rev: 0.6 });
    const hit = t + 0.42;
    tone(55, hit, 0.7, "sine", 0.4, sfxBus);
    noise(hit, 0.8, 0.2, sfxBus, { hp: 4000, decay: 2, rev: 1.0 });
    [440, 554.37, 659.25, 880, 1108.7].forEach((f, i) => bell(f, hit + i * 0.03, 0.9, 0.12, sfxBus, { rev: 1.0, del: 0.4 }));
  }
  function playGameOver() {
    if (!ctx) return;
    const t = ctx.currentTime;
    [523.25, 392.00, 329.63, 261.63, 220.00].forEach((f, i) =>
      tone(f, t + i * 0.22, 0.7, "triangle", 0.16, sfxBus, { glide: f * 0.94, rev: 0.7 }));
    noise(t, 1.6, 0.06, sfxBus, { hp: 3000, decay: 0.5, rev: 0.9 });
  }

  function toggleMute() {
    if (!ctx) return muted;
    muted = !muted;
    master.gain.setTargetAtTime(muted ? 0 : 0.85, ctx.currentTime, 0.02);
    return muted;
  }
  function isMuted() { return muted; }

  return {
    start, stop, beatPhase, barPhase, section, now, secondsPerBeat: spb, setIntensity,
    playClear, playLock, playSquare, playCombo, playBurst, playGameOver,
    toggleMute, isMuted,
  };
})();
