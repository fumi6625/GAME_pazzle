/*
 * GameAudio — Web Audio API による本格シンセBGM＋効果音エンジン v2
 *
 * ルミネスの「操作が音楽になる（シナスタジア）」を高品質に再現:
 *  - 8小節のコード進行 (Am → F → C → G) で展開するトランス風トラック
 *  - スーパーソー・パッド / プラック・アルペジオ / サブ+ミッドベース / リードの多層構成
 *  - コンボリバーブ(IR合成) + 付点8分ディレイの空間系
 *  - キック連動のサイドチェイン風ダッキングで「うねり」を作る
 *  - ゲーム状況に応じて楽器が増減するダイナミックレイヤー (setIntensity 0..3)
 *  - 消去音は FM ベル + 残響。列位置でステレオパン、消えた順に旋律化
 *
 * 著作権フリー: すべてオシレーター/ノイズから合成（本家楽曲は不使用）
 */
const GameAudio = (() => {
  const BPM = 128;
  const spb = 60 / BPM;          // 1拍の秒数
  const STEP = spb / 4;          // 16分音符
  const BARS = 8;                // ループ小節数
  const TOTAL_STEPS = BARS * 16;

  let ctx = null;
  let master, comp, duck, drumBus, sfxBus;
  let reverb, revReturn, delay, delFb, delReturn;
  let started = false;
  let muted = false;
  let intensity = 1;             // 0..3 レイヤー数

  let currentStep = 0;
  let nextStepTime = 0;
  let startTime = 0;
  let timerId = null;
  const lookahead = 25;          // ms
  const scheduleAhead = 0.15;    // s

  // ===== 音楽データ =====
  // コード進行: 2小節ごとに Am → F → C → G
  const CHORDS = [
    { root: 110.00, tones: [220.00, 261.63, 329.63, 440.00] }, // Am
    { root:  87.31, tones: [174.61, 220.00, 261.63, 349.23] }, // F
    { root: 130.81, tones: [261.63, 329.63, 392.00, 523.25] }, // C
    { root:  98.00, tones: [196.00, 246.94, 293.66, 392.00] }, // G
  ];
  // Aマイナー・ペンタトニック（消去音・リード用）
  const SCALE = [220.00, 261.63, 293.66, 329.63, 392.00,
                 440.00, 523.25, 587.33, 659.25, 783.99, 880.00, 1046.50];

  // アルペジオ（16分・コードトーン展開）
  const ARP = [0, 1, 2, 3, 2, 1, 0, 2, 1, 3, 2, 3, 0, 2, 1, 2];

  // リード旋律（2小節=32ステップ、null=休符）: 2フレーズ交互
  const L = SCALE;
  const PHRASE_A = [
    L[5],null,null,L[6], null,null,L[7],null, L[8],null,null,L[7], null,L[6],null,null,
    L[5],null,L[4],null, null,L[5],null,null, L[6],null,null,null, null,null,L[4],null,
  ];
  const PHRASE_B = [
    L[8],null,null,null, L[9],null,L[8],null, L[7],null,null,L[8], null,null,null,null,
    L[7],null,L[6],null, L[5],null,null,L[6], L[5],null,null,L[4], null,null,null,null,
  ];

  // ===== 初期化 =====
  function makeIR(dur, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * dur);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
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

    // リバーブ (合成IR)
    reverb = ctx.createConvolver();
    reverb.buffer = makeIR(2.4, 3.2);
    revReturn = ctx.createGain(); revReturn.gain.value = 0.4;
    reverb.connect(revReturn); revReturn.connect(master);

    // 付点8分ディレイ
    delay = ctx.createDelay(1.0); delay.delayTime.value = spb * 0.75;
    delFb = ctx.createGain(); delFb.gain.value = 0.36;
    const delLp = ctx.createBiquadFilter(); delLp.type = "lowpass"; delLp.frequency.value = 3200;
    delay.connect(delLp); delLp.connect(delFb); delFb.connect(delay);
    delReturn = ctx.createGain(); delReturn.gain.value = 0.5;
    delLp.connect(delReturn); delReturn.connect(master);
    delLp.connect(reverb);

    // サイドチェイン風ダッキング（パッド/ベース/アルペジオが通る）
    duck = ctx.createGain(); duck.gain.value = 1;
    duck.connect(master);

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
      const p = ctx.createStereoPanner(); p.pan.value = opts.pan;
      g.connect(p); node = p;
    }
    node.connect(dest);
    if (opts.rev) send(node, reverb, opts.rev);
    if (opts.del) send(node, delay, opts.del);
    o.connect(g);
    o.start(t); o.stop(t + dur + 0.05);
    return o;
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

  // FMベル（消去音などの美しい高音）
  function bell(freq, t, dur, gain, dest, opts = {}) {
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const mg = ctx.createGain();
    const g = ctx.createGain();
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
      const p = ctx.createStereoPanner(); p.pan.value = opts.pan;
      g.connect(p); node = p;
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
    // 胴鳴り
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    g.gain.setValueAtTime(0.95 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(g); g.connect(drumBus);
    o.start(t); o.stop(t + 0.26);
    // アタックのクリック
    noise(t, 0.02, 0.3 * vel, drumBus, { hp: 3000, decay: 2 });
    // サイドチェイン・ダッキング
    duck.gain.cancelScheduledValues(t);
    duck.gain.setValueAtTime(1, t);
    duck.gain.linearRampToValueAtTime(0.45, t + 0.015);
    duck.gain.linearRampToValueAtTime(1, t + 0.3);
  }
  function clap(t, vel = 1) {
    for (let i = 0; i < 3; i++)
      noise(t + i * 0.012, 0.05, 0.22 * vel, drumBus, { bp: 1500, q: 0.9, decay: 1.5 });
    noise(t + 0.03, 0.25, 0.16 * vel, drumBus, { bp: 1800, q: 0.7, decay: 2.5, rev: 0.5 });
  }
  function hatC(t, vel = 1) { noise(t, 0.035, 0.16 * vel, drumBus, { hp: 8500, decay: 1.8 }); }
  function hatO(t, vel = 1) { noise(t, 0.16, 0.14 * vel, drumBus, { hp: 7500, decay: 1.2 }); }
  function crash(t) { noise(t, 1.4, 0.24, drumBus, { hp: 5500, decay: 2.2, rev: 0.8 }); }
  function snareRoll(t, vel) {
    noise(t, 0.09, 0.15 * vel, drumBus, { bp: 2000, q: 0.8, decay: 1.4 });
  }

  // ===== 楽器 =====
  // スーパーソー・パッド（2小節ごとにコードを鳴らす）
  function pad(chord, t) {
    const dur = spb * 8; // 2小節
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(1600 + intensity * 500, t + dur * 0.6);
    lp.frequency.linearRampToValueAtTime(700, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.5);
    g.gain.setValueAtTime(0.05, t + dur - 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g); g.connect(duck);
    send(g, reverb, 0.7);
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

  // ベース（サブ + ミッド）
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

  // プラック・アルペジオ
  function pluck(freq, t, vel = 1) {
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 3;
    lp.frequency.setValueAtTime(3500 + intensity * 900, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12 * vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = freq;
    o.connect(lp); lp.connect(g); g.connect(duck);
    send(g, delay, 0.35);
    o.start(t); o.stop(t + 0.24);
  }

  // リード（デチューン2osc + ビブラート、ディレイ深め）
  function lead(freq, t, dur) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(duck);
    send(g, delay, 0.55);
    send(g, reverb, 0.4);
    const vib = ctx.createOscillator(); const vg = ctx.createGain();
    vib.frequency.value = 5.5; vg.gain.value = 4;
    vib.connect(vg);
    [-6, 6].forEach((cents) => {
      const o = ctx.createOscillator();
      o.type = "square"; o.frequency.value = freq; o.detune.value = cents;
      vg.connect(o.detune);
      o.connect(g);
      o.start(t); o.stop(t + dur + 0.05);
    });
    vib.start(t); vib.stop(t + dur + 0.05);
  }

  // ライザー（7-8小節目で上昇し、ループ頭のクラッシュへ）
  function riser(t) {
    const dur = spb * 8;
    const o = ctx.createOscillator(); o.type = "sawtooth";
    o.frequency.setValueAtTime(80, t);
    o.frequency.exponentialRampToValueAtTime(900, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(duck);
    send(g, reverb, 0.6);
    o.start(t); o.stop(t + dur + 0.05);
    noise(t, dur, 0.05, drumBus, { hp: 2500, decay: 0.2, rev: 0.5 });
  }

  // ===== シーケンサー（1ステップ=16分） =====
  function scheduleStep(step, t) {
    const bar = Math.floor(step / 16);
    const inBar = step % 16;
    const chord = CHORDS[Math.floor(bar / 2)];

    // --- ドラム ---
    if (inBar % 4 === 0) kick(t);
    if (inBar === 4 || inBar === 12) clap(t);
    if (intensity >= 1) {
      if (inBar % 2 === 0) hatC(t, inBar % 4 === 0 ? 0.7 : 1);
      if (inBar % 4 === 2) hatO(t, 0.8);
    }
    if (intensity >= 3 && inBar % 2 === 1) hatC(t, 0.4); // 16分裏シェイカー
    // フィル（8小節目後半のスネアロール）
    if (bar === 7 && inBar >= 8) snareRoll(t, 0.4 + (inBar - 8) * 0.08);
    // ループ頭のクラッシュ
    if (bar === 0 && inBar === 0) crash(t);
    // ライザー
    if (bar === 6 && inBar === 0 && intensity >= 1) riser(t);

    // --- ベース（オフビート・ハウス + 補間） ---
    if (inBar % 4 === 2) bass(chord.root, t, STEP * 3, 1);
    if (intensity >= 2 && (inBar === 7 || inBar === 15))
      bass(chord.root * (inBar === 15 ? 1.5 : 1), t, STEP * 1.5, 0.7);

    // --- パッド（2小節ごと） ---
    if (bar % 2 === 0 && inBar === 0) pad(chord, t);

    // --- アルペジオ（intensity 1+） ---
    if (intensity >= 1) {
      const p = ARP[inBar];
      const f = chord.tones[p % chord.tones.length] * (p >= 2 ? 2 : 1);
      pluck(f, t, inBar % 4 === 0 ? 1 : 0.6);
    }

    // --- リード（intensity 2+、2小節フレーズ交互） ---
    if (intensity >= 2) {
      const phrase = (bar % 4 < 2) ? PHRASE_A : PHRASE_B;
      const note = phrase[(bar % 2) * 16 + inBar];
      if (note) lead(note, t, STEP * 3);
    }
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
    currentStep = 0;
    nextStepTime = startTime;
    scheduler();
  }
  function stop() {
    started = false;
    if (timerId) { clearTimeout(timerId); timerId = null; }
  }
  function beatPhase() {
    if (!ctx || !started) return 0;
    return ((ctx.currentTime - startTime) / spb) % 1;
  }
  function barPhase() {
    if (!ctx || !started) return 0;
    return ((ctx.currentTime - startTime) / (spb * 4)) % 1;
  }
  function now() { return ctx ? ctx.currentTime : 0; }
  function setIntensity(v) { intensity = Math.max(0, Math.min(3, v)); }

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
    const f = SCALE[col % SCALE.length] * 0.5;
    tone(f, t, 0.09, "triangle", 0.09, sfxBus, { pan: (col / 16) * 1.6 - 0.8 });
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
    [1, 1.25, 1.5].forEach((r, i) =>
      bell(base * r, t + i * 0.055, 0.4, 0.1, sfxBus, { rev: 0.7, del: 0.3 }));
  }
  function playBurst() {
    if (!ctx) return;
    const t = ctx.currentTime;
    // ライザー → 着弾
    tone(100, t, 0.5, "sawtooth", 0.2, sfxBus, { glide: 1600, rev: 0.5 });
    noise(t, 0.5, 0.18, sfxBus, { hp: 800, decay: 0.3, rev: 0.6 });
    // 着弾: 低音ブーム + コード + シマー
    const hit = t + 0.42;
    tone(55, hit, 0.7, "sine", 0.4, sfxBus);
    noise(hit, 0.8, 0.2, sfxBus, { hp: 4000, decay: 2, rev: 1.0 });
    [440, 554.37, 659.25, 880, 1108.7].forEach((f, i) =>
      bell(f, hit + i * 0.03, 0.9, 0.12, sfxBus, { rev: 1.0, del: 0.4 }));
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
    start, stop, beatPhase, barPhase, now, secondsPerBeat: spb, setIntensity,
    playClear, playLock, playSquare, playCombo, playBurst, playGameOver,
    toggleMute, isMuted,
  };
})();
