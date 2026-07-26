/*
 * GameAudio v4 — Web Audio API のみで合成する「ダーク・メトロポリス・テクノ」
 *
 *  設計方針（Rez Infinite / LUMINES 系のクールなトランス・テクノを参照）:
 *   - BPM 140 / 64小節 ≒ 110秒 でシームレスにループ（Rez Area 1 実測 141.5BPM に準拠）
 *   - 極端に低域優勢のミックス: 太いキック + 深いサブベース(36-55Hz)が主役、上物は暗く控えめ
 *   - 構成: イントロ → ビルド → ドロップ → ブレイク → ビルド2 → ドロップ2 → (先頭へ)
 *   - 音色: サブベース / アシッド(レゾナンス)ベース / 金属質パーカッション /
 *           暗いミニマル・アルペジオ / 冷たく広いリバーブ / ダブ的ピンポン・ディレイ
 *   - キック連動サイドチェイン(ダッキング)で全体に「呼吸」を作る
 *   - エジプト音階・民族色は不使用。A エオリアン/ドリアン系のクールな響き
 *
 *  インタラクティブ:
 *   - 操作音(回転/移動/ドロップ/着地/消去/コンボ)は必ず次の16分グリッドへクオンタイズ
 *   - setIntensity(0..3) でドラムの手数・上物・マスターフィルターの開きが変化
 *   - playBurst は ライザー → 次の拍でインパクト + リバースシンバル
 *
 *  著作権フリー: 全てオシレーター/ノイズからのリアルタイム合成（外部音源不使用）
 */
const GameAudio = (() => {
  "use strict";

  // ===== テンポ / 尺 =====
  const BPM = 140;
  const spb = 60 / BPM;            // 1拍 = 0.4286s
  const STEP = spb / 4;            // 16分 = 0.1071s
  const BAR = spb * 4;             // 1小節 = 1.714s
  const BARS = 64;
  const TOTAL_STEPS = BARS * 16;   // 1024ステップ
  const LOOP_SEC = TOTAL_STEPS * STEP; // ≒109.7秒

  // ===== 状態 =====
  let ctx = null;
  let master, out, comp, shaper;
  let musicLp, secGain, duck, drumBus, sfxBus;
  let reverb, revIn, revReturn;
  let delayIn, delayReturn;
  let noiseBuf = null;

  let started = false;
  let muted = false;
  let intensity = 1;
  let baseCutoff = 3000;

  let currentStep = 0;
  let nextStepTime = 0;
  let startTime = 0;
  let timerId = null;
  const LOOKAHEAD = 25;      // ms
  const SCHEDULE_AHEAD = 0.2; // s

  // 同一グリッドへの発音集中を防ぐガード
  const slotCount = new Map();
  const lastSlot = new Map();

  // コンボ状態（消去音の音程上昇に使用）
  let comboLevel = 0;
  let comboAt = 0;

  // ===== 音名ヘルパー (MIDI → Hz) =====
  const nf = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // ===== コード進行（A エオリアン: i - VI - iv - v、2小節ずつの8小節周期） =====
  const CH = {
    Am: { sub: nf(33), root: nf(45), tones: [nf(57), nf(60), nf(64), nf(71)] }, // A  C  E  B
    F:  { sub: nf(29), root: nf(41), tones: [nf(53), nf(57), nf(60), nf(64)] }, // F  A  C  E
    Dm: { sub: nf(26), root: nf(38), tones: [nf(50), nf(53), nf(57), nf(60)] }, // D  F  A  C
    Em: { sub: nf(28), root: nf(40), tones: [nf(52), nf(55), nf(59), nf(62)] }, // E  G  B  D
  };
  const PROG = [CH.Am, CH.F, CH.Dm, CH.Em];
  const chordForBar = (bar) => PROG[(bar >> 1) % PROG.length];

  // 効果音用スケール（A マイナー・ペンタ + 9th。どのコードにも乗る）
  const SCALE = [57, 60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84].map(nf);

  // ===== アシッド・ベース パターン（[半音オフセット, アクセント, スライド]） =====
  const _ = null;
  const ACID_A = [
    [0, 1, 0], _, [0, 0, 0], [12, 0, 0], _, [0, 0, 1], _, [10, 0, 0],
    [0, 1, 0], _, [12, 0, 0], _, [7, 0, 0], _, [10, 0, 1], [12, 0, 0],
  ];
  const ACID_B = [
    [0, 1, 0], [0, 0, 0], _, [12, 0, 1], [10, 0, 0], _, [0, 0, 0], _,
    [3, 0, 0], _, [0, 1, 0], [12, 0, 0], _, [15, 0, 0], _, [10, 0, 0],
  ];
  // 暗いミニマル・アルペジオ（コードトーンのインデックス / +1 で1oct上）
  const ARP = [0, 2, 1, 3, 2, 0, 3, 1, 1, 3, 0, 2, 3, 1, 2, 0];
  const ARP_OCT = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1];
  // 金属パーカッションの16分ベロシティ
  const PERC = [0, 0.5, 0, 0.8, 0, 0.4, 0.9, 0, 0, 0.6, 0, 0.5, 0.7, 0, 0.4, 0.8];

  // ===== セクション =====
  // id は section() の戻り値（背景演出用）: 0=イントロ 1=ビルド 2=ドロップ 3=ブレイク 4=ラストドロップ
  // cut = マスターLPFの開き / lvl = セクション全体の音量。
  // 抑揚を出すため、静と動の落差を大きく取る（ブレイクは大きく引き、ドロップで解放）。
  function sectionOfBar(bar) {
    if (bar < 8)  return { id: 0, name: "intro",  cut: 1200, lvl: 0.55 };
    if (bar < 16) return { id: 1, name: "build",  cut: 3200, lvl: 0.78 };
    if (bar < 32) return { id: 2, name: "drop",   cut: 9500, lvl: 1.00 };
    if (bar < 40) return { id: 3, name: "break",  cut: 900,  lvl: 0.42 };
    if (bar < 48) return { id: 1, name: "build2", cut: 3800, lvl: 0.82 };
    return { id: 4, name: "drop2", cut: 14000, lvl: 1.00 };
  }

  // ================= 初期化 =================
  function softClipCurve() {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * 1.6) / Math.tanh(1.6);
    }
    return c;
  }

  // 冷たく広いリバーブIR（ステレオ非相関ノイズ + 一次ローパスで角を取る）
  function makeIR(dur, decay) {
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * dur));
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let z = 0;
      for (let i = 0; i < len; i++) {
        const x = Math.random() * 2 - 1;
        z += (x - z) * 0.45;                        // 一次LP
        const t = i / len;
        d[i] = z * Math.pow(1 - t, decay) * (i < rate * 0.012 ? i / (rate * 0.012) : 1);
      }
    }
    return buf;
  }

  function makeNoise(sec) {
    const len = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  function pan(p) {
    if (ctx.createStereoPanner) { const n = ctx.createStereoPanner(); n.pan.value = p; return n; }
    const g = ctx.createGain(); return g; // 未対応環境はスルー
  }

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    noiseBuf = makeNoise(2.0);

    // --- マスター: ゲイン → コンプ → ソフトクリップ → 出力 ---
    out = ctx.createGain(); out.gain.value = 0.82;
    shaper = ctx.createWaveShaper(); shaper.curve = softClipCurve(); shaper.oversample = "4x";
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -7; comp.knee.value = 8; comp.ratio.value = 6;
    comp.attack.value = 0.003; comp.release.value = 0.14;
    master = ctx.createGain(); master.gain.value = 0.9;
    master.connect(comp); comp.connect(shaper); shaper.connect(out); out.connect(ctx.destination);

    // --- リバーブ（低域を濁さないよう250Hz以下はカット） ---
    revIn = ctx.createGain(); revIn.gain.value = 1;
    const revHp = ctx.createBiquadFilter(); revHp.type = "highpass"; revHp.frequency.value = 260;
    reverb = ctx.createConvolver(); reverb.buffer = makeIR(3.4, 2.6);
    revReturn = ctx.createGain(); revReturn.gain.value = 0.5;
    revIn.connect(revHp); revHp.connect(reverb); reverb.connect(revReturn); revReturn.connect(master);

    // --- ダブ的ピンポン・ディレイ（付点8分） ---
    delayIn = ctx.createGain(); delayIn.gain.value = 1;
    const dL = ctx.createDelay(2.0), dR = ctx.createDelay(2.0);
    dL.delayTime.value = spb * 0.75; dR.delayTime.value = spb * 0.75;
    const dLp = ctx.createBiquadFilter(); dLp.type = "lowpass"; dLp.frequency.value = 2400;
    const dHp = ctx.createBiquadFilter(); dHp.type = "highpass"; dHp.frequency.value = 320;
    const fb = ctx.createGain(); fb.gain.value = 0.44;
    delayIn.connect(dL);
    dL.connect(dLp); dLp.connect(dHp); dHp.connect(dR);
    dR.connect(fb); fb.connect(dL);
    delayReturn = ctx.createGain(); delayReturn.gain.value = 0.42;
    const pL = pan(-0.75), pR = pan(0.75);
    dL.connect(pL); pL.connect(delayReturn);
    dR.connect(pR); pR.connect(delayReturn);
    delayReturn.connect(master);
    const dRev = ctx.createGain(); dRev.gain.value = 0.35;
    delayReturn.connect(dRev); dRev.connect(revIn);

    // --- バス構成 ---
    musicLp = ctx.createBiquadFilter();
    musicLp.type = "lowpass"; musicLp.Q.value = 0.7; musicLp.frequency.value = baseCutoff;
    // セクションごとの音量オートメーション用（抑揚の骨格）
    secGain = ctx.createGain(); secGain.gain.value = 0.55;
    musicLp.connect(secGain); secGain.connect(master);
    duck = ctx.createGain(); duck.gain.value = 1; duck.connect(musicLp); // サイドチェイン対象
    // ドラムもセクション音量に追従させる（ブレイクでちゃんと静まるように）
    drumBus = ctx.createGain(); drumBus.gain.value = 1; drumBus.connect(secGain);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.85; sfxBus.connect(master);
  }

  function send(node, dest, amt) {
    const g = ctx.createGain(); g.gain.value = amt;
    node.connect(g); g.connect(dest);
  }

  // ================= 基本ボイス =================
  function noiseSrc(t, dur) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    const off = Math.random() * (noiseBuf.duration - 0.05);
    s.start(t, off, dur + 0.05);
    s.stop(t + dur + 0.05);
    return s;
  }

  // フィルター付きノイズ・ヒット
  function nz(t, dur, gain, dest, o = {}) {
    const s = noiseSrc(t, dur);
    let node = s;
    if (o.hp) { const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = o.hp; node.connect(f); node = f; }
    if (o.bp) {
      const f = ctx.createBiquadFilter(); f.type = "bandpass";
      f.frequency.setValueAtTime(o.bp, t); f.Q.value = o.q ?? 1.2;
      if (o.bpTo) f.frequency.exponentialRampToValueAtTime(o.bpTo, t + dur);
      node.connect(f); node = f;
    }
    if (o.lp) { const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = o.lp; node.connect(f); node = f; }
    const g = ctx.createGain();
    const a = o.attack ?? 0.002;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g);
    let outNode = g;
    if (o.pan !== undefined) { const p = pan(o.pan); g.connect(p); outNode = p; }
    outNode.connect(dest);
    if (o.rev) send(outNode, revIn, o.rev);
    if (o.del) send(outNode, delayIn, o.del);
    return outNode;
  }

  // 単純トーン
  function tone(freq, t, dur, type, gain, dest, o = {}) {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (o.glide) osc.frequency.exponentialRampToValueAtTime(o.glide, t + (o.glideTime || dur));
    if (o.detune) osc.detune.value = o.detune;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = g;
    if (o.lp) { const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = o.lp; g.connect(f); node = f; }
    if (o.pan !== undefined) { const p = pan(o.pan); node.connect(p); node = p; }
    node.connect(dest);
    if (o.rev) send(node, revIn, o.rev);
    if (o.del) send(node, delayIn, o.del);
    osc.connect(g); osc.start(t); osc.stop(t + dur + 0.05);
  }

  // FM ベル（消去音・コンボ用。金属質で冷たい）
  function bell(freq, t, dur, gain, dest, o = {}) {
    const car = ctx.createOscillator(), mod = ctx.createOscillator();
    const mg = ctx.createGain(), g = ctx.createGain();
    car.type = "sine"; mod.type = "sine";
    car.frequency.value = freq;
    mod.frequency.value = freq * (o.ratio || 3.01);
    mg.gain.setValueAtTime(freq * (o.index || 2.2), t);
    mg.gain.exponentialRampToValueAtTime(1, t + dur * 0.55);
    mod.connect(mg); mg.connect(car.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = g;
    if (o.pan !== undefined) { const p = pan(o.pan); g.connect(p); node = p; }
    node.connect(dest);
    if (o.rev) send(node, revIn, o.rev);
    if (o.del) send(node, delayIn, o.del);
    car.connect(g);
    car.start(t); car.stop(t + dur + 0.05);
    mod.start(t); mod.stop(t + dur + 0.05);
  }

  // 金属パーカッション（デチューン矩形の束をバンドパス）
  const METAL = [1, 1.342, 1.2312, 1.6532, 1.9523, 2.1547];
  function metal(t, dur, gain, dest, o = {}) {
    const base = o.base || 164;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass";
    bp.frequency.value = o.bp || 5200; bp.Q.value = o.q || 1.4;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = o.hp || 3800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0002, gain), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (let i = 0; i < (o.voices || 4); i++) {
      const osc = ctx.createOscillator();
      osc.type = "square"; osc.frequency.value = base * METAL[i];
      osc.connect(bp); osc.start(t); osc.stop(t + dur + 0.02);
    }
    bp.connect(hp); hp.connect(g);
    let node = g;
    if (o.pan !== undefined) { const p = pan(o.pan); g.connect(p); node = p; }
    node.connect(dest);
    if (o.rev) send(node, revIn, o.rev);
    if (o.del) send(node, delayIn, o.del);
  }

  // ================= ドラム =================
  function duckNow(t, depth) {
    duck.gain.setValueAtTime(depth, t);
    duck.gain.linearRampToValueAtTime(1, t + Math.min(0.32, spb * 0.85));
  }

  // 厚いキック（サブ層 + ボディ + クリック）
  function kick(t, vel = 1, o = {}) {
    const sub = ctx.createOscillator(), sg = ctx.createGain();
    sub.type = "sine";
    sub.frequency.setValueAtTime(o.top || 170, t);
    sub.frequency.exponentialRampToValueAtTime(o.end || 42, t + 0.075);
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.95 * vel, t + 0.004);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + (o.dur || 0.34));
    sub.connect(sg); sg.connect(drumBus);
    sub.start(t); sub.stop(t + (o.dur || 0.34) + 0.03);

    // ボディ（軽い歪みでレンジを埋める）
    const body = ctx.createOscillator(), bg = ctx.createGain();
    const bsh = ctx.createWaveShaper(); bsh.curve = softClipCurve();
    body.type = "triangle";
    body.frequency.setValueAtTime(220, t);
    body.frequency.exponentialRampToValueAtTime(58, t + 0.05);
    bg.gain.setValueAtTime(0.3 * vel, t);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    body.connect(bg); bg.connect(bsh); bsh.connect(drumBus);
    body.start(t); body.stop(t + 0.14);

    if (!o.soft) nz(t, 0.014, 0.22 * vel, drumBus, { hp: 3500 });
    duckNow(t, o.duckDepth ?? 0.3);
  }

  function clap(t, vel = 1) {
    for (let i = 0; i < 3; i++) nz(t + i * 0.011, 0.04, 0.2 * vel, drumBus, { bp: 1500, q: 1.1 });
    nz(t + 0.028, 0.22, 0.14 * vel, drumBus, { bp: 1900, q: 0.8, rev: 0.45, del: 0.12 });
  }
  function snare(t, vel = 1) {
    nz(t, 0.13, 0.2 * vel, drumBus, { bp: 2200, q: 0.7 });
    tone(190, t, 0.09, "triangle", 0.14 * vel, drumBus, { glide: 130 });
  }
  function hatC(t, vel = 1) { nz(t, 0.03, 0.13 * vel, drumBus, { hp: 9000 }); }
  function hatO(t, vel = 1) { nz(t, 0.19, 0.1 * vel, drumBus, { hp: 8000, rev: 0.2 }); }
  function ride(t, vel = 1) { metal(t, 0.16, 0.035 * vel, drumBus, { bp: 7600, hp: 6000, voices: 4, rev: 0.25 }); }
  function rim(t, vel = 1, p = 0) { metal(t, 0.05, 0.07 * vel, drumBus, { base: 320, bp: 3200, hp: 1800, voices: 3, pan: p, del: 0.18 }); }
  function crash(t, vel = 1) { nz(t, 2.2, 0.17 * vel, drumBus, { hp: 5000, rev: 0.9 }); }

  // ノイズ・スイープ（up: 上昇 / down: 下降）
  function sweep(t, dur, up, gain = 0.09) {
    nz(t, dur, gain, drumBus, {
      bp: up ? 400 : 7000, bpTo: up ? 9000 : 350, q: 1.6,
      attack: dur * 0.5, rev: 0.6,
    });
  }
  function reverseCymbal(t, dur, gain = 0.14) {
    // アタックを遅くして逆再生風に
    nz(t, dur, gain, drumBus, { hp: 4200, attack: dur * 0.92, rev: 0.8 });
  }

  // ================= 楽器 =================
  // サブベース（曲の主役。ハーフタイム感の長い音）
  function sub(freq, t, dur, vel = 1) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * vel, t + 0.02);
    g.gain.setValueAtTime(0.5 * vel, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(duck);
    o.start(t); o.stop(t + dur + 0.05);
    // 少しだけ倍音を足して小型スピーカーでも輪郭が出るように
    tone(freq * 2, t, Math.min(dur, 0.16), "triangle", 0.05 * vel, duck);
  }

  // アシッド・ベース（レゾナントLP + エンベロープ、アクセント/スライド付き）
  function acid(freq, t, dur, o = {}) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(o.from || freq, t);
    if (o.from) osc.frequency.exponentialRampToValueAtTime(freq, t + Math.min(0.09, dur * 0.6));
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = o.q ?? 11;
    const acc = o.accent ? 1 : 0;
    const peak = (o.cut || 900) * (1 + acc * 1.1) * (0.6 + intensity * 0.18);
    lp.frequency.setValueAtTime(Math.min(12000, peak), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(140, (o.cut || 900) * 0.22), t + dur * 0.9);
    const g = ctx.createGain();
    const amp = (o.gain ?? 0.17) * (1 + acc * 0.45);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(lp); lp.connect(g); g.connect(duck);
    if (o.del) send(g, delayIn, o.del);
    osc.start(t); osc.stop(t + dur + 0.03);
  }

  // 冷たいパッド（デチューン・ソウ、大きなリバーブ）
  function pad(chord, t, bars, amp = 0.05) {
    const dur = BAR * bars;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 0.6;
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(1400 + intensity * 350, t + dur * 0.55);
    lp.frequency.linearRampToValueAtTime(600, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + dur * 0.25);
    g.gain.setValueAtTime(amp, t + dur * 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g); g.connect(duck); send(g, revIn, 0.8);
    chord.tones.forEach((f, i) => {
      [-8, 7].forEach((cents, k) => {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth"; osc.frequency.value = f; osc.detune.value = cents;
        const og = ctx.createGain(); og.gain.value = 0.1;
        const p = pan((i % 2 === 0 ? -0.5 : 0.5) * (k ? -1 : 1));
        osc.connect(og); og.connect(p); p.connect(lp);
        osc.start(t); osc.stop(t + dur + 0.1);
      });
    });
  }

  // 暗いミニマル・アルペジオ（プラック、ディレイに送る）
  function arp(freq, t, vel = 1) {
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 4;
    lp.frequency.setValueAtTime(2600 + intensity * 900, t);
    lp.frequency.exponentialRampToValueAtTime(420, t + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.075 * vel, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    const osc = ctx.createOscillator(); osc.type = "square"; osc.frequency.value = freq;
    const osc2 = ctx.createOscillator(); osc2.type = "sawtooth"; osc2.frequency.value = freq; osc2.detune.value = 9;
    const g2 = ctx.createGain(); g2.gain.value = 0.5;
    osc.connect(lp); osc2.connect(g2); g2.connect(lp);
    lp.connect(g); g.connect(duck);
    send(g, delayIn, 0.45); send(g, revIn, 0.28);
    osc.start(t); osc.stop(t + 0.22);
    osc2.start(t); osc2.stop(t + 0.22);
  }

  // ダブ・スタブ（コード和音の短打 → ディレイで空間へ）
  function stab(chord, t, vel = 1) {
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 2;
    lp.frequency.setValueAtTime(3000, t);
    lp.frequency.exponentialRampToValueAtTime(600, t + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06 * vel, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    chord.tones.forEach((f) => {
      const osc = ctx.createOscillator(); osc.type = "sawtooth"; osc.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = 0.22;
      osc.connect(og); og.connect(lp);
      osc.start(t); osc.stop(t + 0.28);
    });
    lp.connect(g); g.connect(duck);
    send(g, delayIn, 0.6); send(g, revIn, 0.4);
  }

  // ライザー（ビルド用の上昇音）
  function riser(t, dur) {
    const osc = ctx.createOscillator(); osc.type = "sawtooth";
    osc.frequency.setValueAtTime(70, t);
    osc.frequency.exponentialRampToValueAtTime(1100, t + dur);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 6;
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(6000, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + dur * 0.85);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(lp); lp.connect(g); g.connect(duck); send(g, revIn, 0.5);
    osc.start(t); osc.stop(t + dur + 0.05);
    sweep(t, dur, true, 0.07);
  }

  // ================= メインメロディ =================
  // A エオリアンの8小節フック。コードは 2小節ずつ Am → F → Dm → Em。
  // 小節6でトップの B5 に到達して山を作り、小節7で E5 に着地する。
  // [16分位置, MIDI, 長さ(16分)]
  const MELODY = [
    [[0, 76, 3], [4, 81, 2], [6, 79, 2], [8, 76, 4], [14, 74, 2]],   // 0 Am  主題
    [[0, 72, 6], [8, 71, 3], [12, 69, 4]],                            // 1 Am  下降
    [[0, 77, 3], [4, 76, 2], [6, 72, 2], [8, 77, 4], [14, 76, 2]],   // 2 F   主題の応答
    [[0, 74, 6], [8, 72, 3], [12, 69, 4]],                            // 3 F   下降
    [[0, 81, 3], [4, 79, 2], [6, 77, 2], [8, 74, 4], [14, 77, 2]],   // 4 Dm  上方へ展開
    [[0, 76, 6], [8, 74, 3], [12, 72, 4]],                            // 5 Dm
    [[0, 71, 3], [4, 76, 2], [6, 79, 2], [8, 83, 4], [14, 81, 2]],   // 6 Em  クライマックス
    [[0, 79, 4], [6, 77, 2], [8, 76, 6]],                             // 7 Em  着地
  ];
  // イントロで断片だけ匂わせる小節（フックの予告）
  const TEASE_BARS = { 5: [0], 6: [0, 3], 7: [0, 2] };

  // リード: デチューン・スーパーソー。サブベースを避けて中高域に置く。
  function leadV(freq, t, dur, vel = 1, o = {}) {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = o.q ?? 4;
    const peak = o.cut ?? 4200;
    lp.frequency.setValueAtTime(peak * 0.55, t);
    lp.frequency.linearRampToValueAtTime(peak, t + Math.min(0.09, dur * 0.4));
    lp.frequency.exponentialRampToValueAtTime(Math.max(400, peak * 0.35), t + dur);
    // サブと衝突しないよう下を削る
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 300;

    const g = ctx.createGain();
    const amp = 0.075 * vel;
    const atk = o.atk ?? 0.012;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + atk);
    g.gain.setValueAtTime(amp, t + Math.max(atk, dur * 0.7));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    // 7声スーパーソー
    const det = o.det ?? 14;
    [-det, -det * 0.6, -det * 0.2, 0, det * 0.2, det * 0.6, det].forEach((c, idx) => {
      const osc = ctx.createOscillator();
      osc.type = idx === 3 ? "sawtooth" : "sawtooth";
      osc.frequency.value = freq;
      osc.detune.value = c;
      const og = ctx.createGain(); og.gain.value = idx === 3 ? 0.22 : 0.12;
      osc.connect(og); og.connect(lp);
      osc.start(t); osc.stop(t + dur + 0.06);
    });
    // 芯を出す矩形の1オクターブ下
    if (o.body) {
      const osc = ctx.createOscillator();
      osc.type = "square"; osc.frequency.value = freq / 2;
      const og = ctx.createGain(); og.gain.value = 0.07;
      osc.connect(og); og.connect(lp);
      osc.start(t); osc.stop(t + dur + 0.06);
    }
    lp.connect(hp); hp.connect(g);
    let node = g;
    if (o.pan !== undefined) { const p = pan(o.pan); g.connect(p); node = p; }
    node.connect(duck);
    send(node, delayIn, o.del ?? 0.42);
    send(node, revIn, o.rev ?? 0.34);
  }

  // 1小節分のメロディを鳴らす。mode でセクションごとの厚みを変える。
  function playMelodyStep(bar, i, t, mode) {
    const evs = MELODY[bar % 8];
    if (!evs) return;
    for (const [pos, midi, len] of evs) {
      if (pos !== i) continue;
      if (mode === "tease") {
        const allow = TEASE_BARS[bar % 8];
        if (!allow || !allow.includes(pos)) continue;
      }
      const dur = len * STEP * 0.96;
      const f = nf(midi);
      switch (mode) {
        case "tease":   // イントロ: 断片をディレイの霧の中に
          leadV(f, t, dur, 0.34, { cut: 1900, del: 0.75, rev: 0.6, atk: 0.05, det: 9 });
          break;
        case "build":   // 提示: 控えめ・フィルター閉じ気味
          leadV(f, t, dur, 0.62, { cut: 3000, del: 0.5, rev: 0.42, det: 12 });
          break;
        case "drop":    // 主役: オクターブ重ね
          leadV(f, t, dur, 1.0, { cut: 5200, body: true, det: 16 });
          leadV(f * 2, t, dur, 0.34, { cut: 7000, del: 0.3, rev: 0.3, det: 20 });
          break;
        case "break":   // 叙情: 単音・深い残響
          leadV(f, t, dur * 1.25, 0.78, { cut: 2600, del: 0.8, rev: 0.95, atk: 0.06, det: 10 });
          break;
        case "final":   // 最厚: 3度ハモリ + オクターブ上下
          leadV(f, t, dur, 1.0, { cut: 6800, body: true, det: 18, pan: -0.16 });
          leadV(nf(midi + 3), t, dur, 0.5, { cut: 5200, det: 16, pan: 0.3, del: 0.3 });
          leadV(f * 2, t, dur, 0.42, { cut: 8000, det: 22, rev: 0.28 });
          break;
      }
    }
  }

  // ================= セクション別シーケンス =================
  function applyTone(t, bar) {
    const s = sectionOfBar(bar);
    let base = s.cut;
    if (s.name === "build" || s.name === "build2") {
      const start = s.name === "build" ? 8 : 40;
      const p = (bar - start) / 8;          // 0..1 でフィルターが開く
      base = 1400 + p * p * 7000;
    }
    if (s.name === "break") {
      const p = (bar - 32) / 8;
      base = 900 + p * 2600;
    }
    baseCutoff = base;
    const target = Math.max(280, Math.min(18000, base * (0.55 + intensity * 0.15)));
    musicLp.frequency.setTargetAtTime(target, t, 0.25);

    // --- セクション音量のオートメーション（抑揚の骨格） ---
    let lvl = s.lvl;
    if (s.name === "build" || s.name === "build2") {
      const start = s.name === "build" ? 8 : 40;
      lvl = 0.62 + ((bar - start) / 8) * 0.32;     // ビルド中に持ち上げる
    }
    if (s.name === "break") {
      const p = (bar - 32) / 8;
      lvl = 0.34 + p * p * 0.42;                    // 底から徐々に戻す
    }
    // ドロップ直前の1小節は一瞬引いて、落ちた瞬間の解放感を作る
    if (bar === 15 || bar === 47 || bar === 31) lvl *= 0.72;
    secGain.gain.setTargetAtTime(lvl, t, 0.30);
  }

  function scheduleStep(step, t) {
    const bar = (step / 16) | 0;
    const i = step % 16;                    // 小節内16分位置
    const s = sectionOfBar(bar);
    const name = s.name;
    const chord = chordForBar(bar);
    const barInPhrase = bar % 8;
    const isDrop = name === "drop" || name === "drop2";
    const isBuild = name === "build" || name === "build2";
    const big = name === "drop2";

    if (i === 0) applyTone(t, bar);

    // ---------- キック ----------
    if (name === "intro") {
      if (i % 4 === 0) kick(t, bar < 2 ? 0.78 : 0.9, { soft: bar < 2, duckDepth: 0.4 });
    } else if (name === "break") {
      if (i === 0) kick(t, 0.9, { duckDepth: 0.35 });
      if (bar >= 36 && i === 8) kick(t, 0.85, { duckDepth: 0.4 });
      if (bar >= 38 && i % 4 === 0) kick(t, 0.9);
    } else {
      if (i % 4 === 0) kick(t, isDrop ? 1 : 0.95);
      // ドロップ終盤のダブルキック
      if (isDrop && barInPhrase === 7 && i === 14) kick(t, 0.8);
    }

    // ---------- クラップ / スネア ----------
    if ((isBuild && bar % 8 >= 2) || isDrop) {
      if (i === 4 || i === 12) clap(t, isDrop ? 1 : 0.8);
    }
    if (name === "break" && bar >= 38 && i === 12) clap(t, 0.7);

    // ---------- ハイハット / 金属パーカッション ----------
    if (name === "intro" && bar >= 2 && i % 4 === 2) hatC(t, 0.45);
    if (isBuild) {
      if (i % 2 === 0) hatC(t, 0.7);
      if (i % 8 === 6) hatO(t, 0.6);
      if (intensity >= 2 && i % 4 === 3) hatC(t, 0.3);
    }
    if (isDrop) {
      if (i % 2 === 0) hatC(t, 0.85);
      if (i === 6 || i === 14) hatO(t, big ? 0.75 : 0.6);
      if (i % 2 === 1) hatC(t, intensity >= 2 ? 0.4 : 0.22);
      if (PERC[i] > 0 && (intensity >= 1 || big)) ride(t, PERC[i] * (big ? 1 : 0.8));
      if (intensity >= 2 && (i === 3 || i === 11)) rim(t, 0.6, i === 3 ? -0.5 : 0.5);
    }
    if (name === "break") {
      if (i % 4 === 2) hatC(t, 0.35);
      if (i === 6) hatO(t, 0.4);
      if (PERC[i] > 0 && intensity >= 2 && bar >= 34) ride(t, PERC[i] * 0.5);
    }

    // ---------- サブベース（ハーフタイムの土台） ----------
    if (i === 0) sub(chord.sub, t, spb * (name === "break" ? 3.4 : 2.6), name === "intro" ? 0.85 : 1);
    if (name !== "break") {
      if (i === 10) sub(chord.sub, t, spb * 1.1, 0.85);
      if ((isDrop || isBuild) && i === 14) sub(chord.sub * (big ? 1.5 : 1), t, spb * 0.7, 0.7);
    } else if (i === 12) {
      sub(chord.sub, t, spb * 0.9, 0.7);
    }

    // ---------- アシッド・ベース ----------
    if (isBuild || isDrop || (name === "break" && bar >= 38)) {
      const pat = (bar >> 1) % 2 === 0 ? ACID_A : ACID_B;
      const n = pat[i];
      if (n) {
        const [semi, accent, slide] = n;
        const f = chord.root * Math.pow(2, semi / 12);
        const cut = isDrop ? (big ? 2200 : 1700) : 900;
        acid(f, t, STEP * (slide ? 1.9 : 0.95), {
          accent, cut,
          from: slide ? f * 0.75 : 0,
          gain: isDrop ? 0.18 : 0.13,
          del: isDrop ? 0.14 : 0,
        });
      }
    }

    // ---------- パッド（2小節ごと） ----------
    if (i === 0 && bar % 2 === 0) {
      const amp = name === "break" ? 0.075 : name === "intro" ? 0.05 : isDrop ? 0.045 : 0.04;
      pad(chord, t, 2, amp);
    }

    // ---------- アルペジオ ----------
    const arpFreq = () => chord.tones[ARP[i] % 4] * (ARP_OCT[i] ? 2 : 1);
    if (name === "intro" && bar >= 4 && i % 4 === 0) arp(arpFreq(), t, 0.5);
    if (isBuild && (i % 2 === 0 || intensity >= 2)) arp(arpFreq(), t, 0.6);
    if (isDrop) arp(arpFreq(), t, i % 4 === 0 ? 1 : 0.62);
    if (big && intensity >= 2 && i % 2 === 1) arp(arpFreq() * 2, t, 0.3);
    if (name === "break" && i % 4 === 0) arp(arpFreq(), t, 0.45);

    // ---------- ダブ・スタブ ----------
    if ((isDrop && bar % 2 === 1 && (i === 6 || i === 14)) ||
        (name === "break" && bar % 2 === 0 && i === 6) ||
        (name === "intro" && bar % 4 === 3 && i === 12)) {
      stab(chord, t, isDrop ? 1 : 0.7);
    }

    // ---------- メインメロディ ----------
    // イントロ=断片 / ビルド=提示 / ドロップ=主役 / ブレイク=叙情 / ラスト=最厚
    let mel = null;
    if (name === "intro" && bar >= 5) mel = "tease";
    else if (name === "build") mel = "build";
    else if (name === "drop") mel = bar >= 24 ? "drop" : "build";
    else if (name === "break") mel = bar >= 34 ? "break" : null;
    else if (name === "build2") mel = "build";
    else if (big) mel = "final";
    if (mel) playMelodyStep(bar, i, t, mel);

    // ---------- 展開用 FX / フィル ----------
    const bigCrash = bar === 0 || bar === 16 || bar === 32 || bar === 48;
    if (i === 0 && bigCrash) crash(t, bar === 48 ? 1 : 0.85);
    if (i === 0 && isDrop && barInPhrase === 0 && !bigCrash) crash(t, 0.5);

    // ビルド終盤のライザー（2小節）とスネアロール（最終小節）
    if ((bar === 14 || bar === 46) && i === 0) riser(t, BAR * 2);
    if (bar === 15 || bar === 47) {
      if (i >= 8) snare(t, 0.25 + (i - 8) * 0.075);
      if (i === 8) reverseCymbal(t, BAR * 0.5, 0.13); // 半小節かけてドロップ頭で最大に
    }

    // ブレイク突入 / 復帰のスイープ
    if (bar === 32 && i === 0) sweep(t, BAR * 1.5, false, 0.1);
    if (bar === 39 && i === 8) sweep(t, BAR * 0.5, true, 0.1);

    // 8小節ごとの軽いフィル
    if (isDrop && barInPhrase === 7 && i >= 12) rim(t, 0.5 + (i - 12) * 0.12, ((i % 2) ? 0.6 : -0.6));

    // ループ折返し（63小節）— 先頭のクラッシュへ自然に繋げる
    if (bar === 63) {
      if (i >= 8) snare(t, 0.2 + (i - 8) * 0.08);
      if (i === 8) reverseCymbal(t, BAR * 0.5, 0.14);
      if (i === 12) sweep(t, BAR * 0.25, true, 0.09);
    }
  }

  // ================= スケジューラ =================
  function scheduler() {
    while (nextStepTime < ctx.currentTime + SCHEDULE_AHEAD) {
      scheduleStep(currentStep, nextStepTime);
      nextStepTime += STEP;
      currentStep = (currentStep + 1) % TOTAL_STEPS;
    }
    // 発音ガードの掃除
    if (slotCount.size > 64) {
      const cut = ctx.currentTime - 1;
      slotCount.forEach((v, k) => { if (k * STEP + startTime < cut) slotCount.delete(k); });
    }
    timerId = setTimeout(scheduler, LOOKAHEAD);
  }

  // ================= クオンタイズ =================
  // 次の16分グリッドの絶対時刻を返す（操作音は必ずここに乗せる）
  // いま鳴っている小節番号（効果音を曲のコードに乗せるのに使う）
  function barNow() {
    if (!ctx || !started) return 0;
    const b = Math.floor((ctx.currentTime - startTime) / BAR) % BARS;
    return b < 0 ? b + BARS : b;
  }

  function grid(lead = 0.015) {
    if (!ctx) return 0;
    if (!started) return ctx.currentTime + 0.001;
    const n = Math.ceil((ctx.currentTime + lead - startTime) / STEP);
    return startTime + n * STEP;
  }
  function beatGrid(lead = 0.02) {
    if (!ctx || !started) return ctx ? ctx.currentTime + 0.001 : 0;
    const n = Math.ceil((ctx.currentTime + lead - startTime) / spb);
    return startTime + n * spb;
  }
  // 同一グリッドでの重複・過密を防ぐ（true なら発音可）
  function slotOK(key, t, max = 3) {
    const k = Math.round((t - startTime) / STEP);
    if (lastSlot.get(key) === k) return false;
    lastSlot.set(key, k);
    const c = (slotCount.get(k) || 0) + 1;
    slotCount.set(k, c);
    return c <= max;
  }
  function curChord() {
    if (!started) return CH.Am;
    const bar = Math.floor(((ctx.currentTime - startTime) / BAR)) % BARS;
    return chordForBar((bar + BARS) % BARS);
  }

  // ================= 公開: トランスポート =================
  function start() {
    init();
    if (ctx.state === "suspended") ctx.resume();
    if (started) return;
    started = true;
    startTime = ctx.currentTime + 0.08;
    currentStep = 0; nextStepTime = startTime;
    scheduler();
  }
  function stop() {
    started = false;
    if (timerId) { clearTimeout(timerId); timerId = null; }
    if (ctx) duck.gain.setTargetAtTime(1, ctx.currentTime, 0.05);
  }
  function beatPhase() {
    if (!ctx || !started) return 0;
    const p = ((ctx.currentTime - startTime) / spb) % 1;
    return p < 0 ? p + 1 : p;
  }
  function barPhase() {
    if (!ctx || !started) return 0;
    const p = ((ctx.currentTime - startTime) / BAR) % 1;
    return p < 0 ? p + 1 : p;
  }
  function section() {
    if (!ctx || !started) return 0;
    let bar = Math.floor((ctx.currentTime - startTime) / BAR) % BARS;
    if (bar < 0) bar += BARS;
    return sectionOfBar(bar).id;
  }
  function now() { return ctx ? ctx.currentTime : 0; }
  function setIntensity(v) {
    intensity = Math.max(0, Math.min(3, v | 0));
    if (!ctx) return;
    const target = Math.max(320, Math.min(18000, baseCutoff * (0.55 + intensity * 0.15)));
    musicLp.frequency.setTargetAtTime(target, ctx.currentTime, 0.3);
  }

  // ================= 公開: 効果音（全て16分クオンタイズ） =================
  // 消去: スケール上の音。コンボが進むほど高く、レイヤーが増える
  function playClear(index, row, pan_ = 0) {
    if (!ctx) return;
    if (comboLevel > 0 && ctx.currentTime - comboAt > 4) comboLevel = 0;
    const n = Math.min(index, 7);
    const t = grid() + n * STEP;               // 連続消去は16分の駆け上がりに
    const deg = (index * 2 + (9 - row) + comboLevel * 2) % SCALE.length;
    const oct = comboLevel >= 3 ? 2 : 1;
    const vel = 0.13 * (1 - n * 0.06);
    bell(SCALE[deg] * oct, t, 0.55, vel, sfxBus, { pan: pan_, rev: 0.6, del: 0.3, ratio: 3.01 });
    if (comboLevel >= 2) bell(SCALE[deg] * oct * 2, t, 0.3, vel * 0.4, sfxBus, { pan: -pan_, rev: 0.5 });
    if (n === 0) metal(t, 0.07, 0.05, sfxBus, { base: 420, bp: 6200, hp: 4000, voices: 3, pan: pan_ });
  }

  // 着地: 列位置でパンする金属タップ + 短いサブ
  function playLock(col) {
    if (!ctx) return;
    const t = grid();
    if (!slotOK("lock", t, 6)) return;
    const p = Math.max(-0.8, Math.min(0.8, (col / 8) - 0.8));
    metal(t, 0.06, 0.09, sfxBus, { base: 200 + (col % 8) * 26, bp: 3600, hp: 2200, voices: 3, pan: p, del: 0.12 });
    tone(curChord().sub * 2, t, 0.09, "sine", 0.16, sfxBus, { pan: p * 0.4 });
  }

  // 2x2 成立: 冷たい2音チャイム
  function playSquare() {
    if (!ctx) return;
    const t = grid();
    if (!slotOK("square", t, 6)) return;
    bell(SCALE[5], t, 0.35, 0.07, sfxBus, { rev: 0.5, del: 0.2, ratio: 2.01 });
    bell(SCALE[8], t + STEP * 0.5, 0.3, 0.05, sfxBus, { rev: 0.5, del: 0.2, ratio: 2.01 });
  }

  // コンボ: 段が上がるほど高く・厚く
  function playCombo(level) {
    if (!ctx) return;
    comboLevel = Math.max(0, Math.min(8, level));
    comboAt = ctx.currentTime;
    const t = grid();
    const base = Math.min(SCALE.length - 4, (level - 1) * 2);
    [0, 2, 4].forEach((k, i) => {
      bell(SCALE[(base + k) % SCALE.length] * (level >= 5 ? 2 : 1), t + i * STEP * 0.5,
        0.45, 0.1 - i * 0.015, sfxBus, { pan: (i - 1) * 0.4, rev: 0.6, del: 0.35 });
    });
    if (level >= 3) sweep(t, spb * 1.5, true, 0.05);
  }

  // 回転: 短い金属ブリップ（上昇FM）
  // 回転: 曲の質感（暗いテクノ）に馴染ませる。
  // 明るい矩形波のピッチアップをやめ、レゾナントに濾したノイズの短い掃引 +
  // 和音に乗る低めのサブ・ブリップにする。右回転は上向き、左回転は下向き。
  function playRotate(dir = 1) {
    if (!ctx) return;
    const t = grid();
    if (!slotOK("rot", t, 6)) return;
    const up = dir >= 0;

    // レゾナントなフィルタ掃引（テクノの「シュッ」という質感）
    const src = noiseSrc(t, 0.09);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.Q.value = 9;
    bp.frequency.setValueAtTime(up ? 900 : 3200, t);
    bp.frequency.exponentialRampToValueAtTime(up ? 3400 : 800, t + 0.075);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.075, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(bp); bp.connect(g);
    const pn = pan(up ? 0.22 : -0.22);
    g.connect(pn); pn.connect(sfxBus);
    send(pn, delayIn, 0.18);

    // 和音に乗る低めのブリップ（キーから外れないよう A エオリアンの構成音）
    const chord = chordForBar(barNow());
    const f = chord.tones[up ? 0 : 1] * 0.5;
    tone(f, t, 0.10, "triangle", 0.05, sfxBus, { lp: 1800, pan: up ? 0.2 : -0.2 });
  }

  // 移動: 極小のクリック（方向でパン）
  function playMove(dir) {
    if (!ctx) return;
    const t = grid();
    if (!slotOK("mv", t, 8)) return;
    const p = dir < 0 ? -0.55 : 0.55;
    nz(t, 0.022, 0.06, sfxBus, { hp: 4000, pan: p });
    tone(dir < 0 ? 880 : 1046.5, t, 0.035, "triangle", 0.04, sfxBus, { pan: p });
  }

  // ハードドロップ: 短いサブの落下 + ノイズ・パンチ
  function playDrop() {
    if (!ctx) return;
    const t = grid();
    if (!slotOK("drop", t, 6)) return;
    tone(300, t, 0.16, "sine", 0.3, sfxBus, { glide: 60, glideTime: 0.12 });
    nz(t, 0.09, 0.1, sfxBus, { bp: 1800, bpTo: 300, q: 1.2 });
    metal(t, 0.08, 0.05, sfxBus, { base: 260, bp: 4200, hp: 2600, voices: 3, rev: 0.25 });
  }

  // BURST: ライザー → 次の拍でインパクト + リバースシンバル
  // レベルアップ: 明るく上へ抜けるファンファーレ（レベルが上がるほど高く）
  function playLevelUp(lv) {
    if (!ctx) return;
    const g0 = beatGrid(0.03);
    const oct = Math.min(2, Math.floor((lv - 1) / 6));
    // A メジャー系の明るい響きで「上がった」感を出す
    [69, 73, 76, 81].forEach((m, k) => {
      const t = g0 + k * STEP * 0.5;
      bell(nf(m + oct * 12), t, 0.7, 0.14, sfxBus, { rev: 0.8, del: 0.28, pan: -0.3 + k * 0.2 });
      leadV(nf(m + oct * 12), t, STEP * 2, 0.42, { cut: 6200, det: 18, rev: 0.5 });
    });
    const top = g0 + 2 * STEP;
    leadV(nf(85 + oct * 12), top, spb * 1.6, 0.55, { cut: 7000, det: 22, rev: 0.7, del: 0.4 });
    nz(top, 0.9, 0.06, sfxBus, { hp: 7000, rev: 0.8 });
  }

  // 豪華コマ生成: サイズが大きいほど荘厳に
  function playGrand(n) {
    if (!ctx) return;
    const g0 = beatGrid(0.03);
    const depth = Math.min(4, n - 2);
    // 低音の芯 + 倍音の重なりで「大物ができた」重みを出す
    tone(nf(33), g0, spb * 2, "sine", 0.3, sfxBus, { attack: 0.01 });
    [57, 64, 69, 76, 81].slice(0, 2 + depth).forEach((m, k) =>
      bell(nf(m), g0 + k * STEP * 0.34, 1.4, 0.13, sfxBus, { rev: 0.95, del: 0.35 }));
    metal(g0, 0.6, 0.05 * depth, sfxBus, { base: 440, bp: 5200, hp: 2000, voices: 5, rev: 0.8 });
  }

  // BURST-B 発動: 時間が伸びるような下降スイープ + 深い残響
  function playSlow() {
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const g0 = grid();
    // ピッチが落ちていく = 時間が遅くなる感覚
    const osc = ctx.createOscillator(); osc.type = "sawtooth";
    osc.frequency.setValueAtTime(880, g0);
    osc.frequency.exponentialRampToValueAtTime(110, g0 + 1.4);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 8;
    lp.frequency.setValueAtTime(5200, g0);
    lp.frequency.exponentialRampToValueAtTime(320, g0 + 1.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, g0);
    g.gain.exponentialRampToValueAtTime(0.10, g0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, g0 + 1.5);
    osc.connect(lp); lp.connect(g); g.connect(sfxBus);
    send(g, revIn, 0.9); send(g, delayIn, 0.4);
    osc.start(g0); osc.stop(g0 + 1.55);
    // 冷たいベルの余韻
    [76, 71, 67, 64].forEach((m, k) =>
      bell(nf(m), g0 + k * STEP * 1.5, 1.6, 0.10, sfxBus, { rev: 1.0, del: 0.4, pan: 0.4 - k * 0.27 }));
    nz(g0, 1.2, 0.05, sfxBus, { hp: 5000, rev: 0.9 });
  }

  // BURST-B 終了: 時間が戻る上昇スイープ
  function playSlowEnd() {
    if (!ctx) return;
    const g0 = grid();
    const osc = ctx.createOscillator(); osc.type = "sawtooth";
    osc.frequency.setValueAtTime(120, g0);
    osc.frequency.exponentialRampToValueAtTime(900, g0 + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, g0);
    g.gain.exponentialRampToValueAtTime(0.06, g0 + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, g0 + 0.55);
    osc.connect(g); g.connect(sfxBus); send(g, revIn, 0.5);
    osc.start(g0); osc.stop(g0 + 0.6);
    bell(nf(81), g0 + 0.42, 0.8, 0.10, sfxBus, { rev: 0.7 });
  }

  // BURST ゲージ満タン: 「準備完了」を明確に知らせる上昇フレーズ
  // 曲のキー(A エオリアン)に乗せ、拍頭にクオンタイズして曲を壊さない。
  function playBurstReady() {
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const g0 = beatGrid(0.04);
    // 駆け上がり: A → C → E → A → C → E（16分）
    const climb = [69, 72, 76, 81, 84, 88];
    climb.forEach((m, k) => {
      const t = g0 + k * STEP;
      bell(nf(m), t, 0.55, 0.13 + k * 0.012, sfxBus, { rev: 0.75, del: 0.3, pan: -0.4 + k * 0.16 });
      leadV(nf(m), t, STEP * 1.6, 0.30, { cut: 6000, det: 18, rev: 0.4, del: 0.35 });
    });
    // 到達点: きらめきと緊張感のあるサステイン
    const top = g0 + climb.length * STEP;
    [81, 84, 88, 93].forEach((m, k) =>
      bell(nf(m), top + k * 0.035, 1.5, 0.11, sfxBus, { rev: 1.0, del: 0.4 }));
    leadV(nf(81), top, spb * 2.2, 0.5, { cut: 5000, det: 22, rev: 0.8, del: 0.5, atk: 0.03 });
    leadV(nf(88), top, spb * 2.2, 0.32, { cut: 6500, det: 24, rev: 0.8, del: 0.5, atk: 0.03 });
    reverseCymbal(t0, Math.max(0.12, top - t0), 0.1);
    nz(top, 1.2, 0.07, sfxBus, { hp: 6000, rev: 0.9 });
  }

  function playBurst() {
    if (!ctx) return;
    const t0 = ctx.currentTime;
    let hit = beatGrid(0.05);
    if (hit - t0 < 0.3) hit += spb;
    const lead = hit - t0;
    // ライザー
    const osc = ctx.createOscillator(); osc.type = "sawtooth";
    osc.frequency.setValueAtTime(120, t0);
    osc.frequency.exponentialRampToValueAtTime(1800, hit);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.09, hit - 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, hit + 0.04);
    osc.connect(g); g.connect(sfxBus); send(g, revIn, 0.5);
    osc.start(t0); osc.stop(hit + 0.08);
    reverseCymbal(t0, lead, 0.16);
    sweep(t0, lead, true, 0.1);

    // インパクト（サブの一撃 + ノイズ + 和音）
    tone(70, hit, 1.1, "sine", 0.55, sfxBus, { glide: 34, glideTime: 0.5 });
    nz(hit, 1.6, 0.16, sfxBus, { hp: 2500, rev: 1.0 });
    crash(hit, 1.0);
    duckNow(hit, 0.2);
    const ch = curChord();
    ch.tones.forEach((f, i) => {
      bell(f * 2, hit + i * 0.035, 1.2, 0.09, sfxBus, { pan: (i - 1.5) * 0.45, rev: 0.9, del: 0.4, ratio: 2.01 });
    });
    // 余韻の下降サブ
    tone(ch.sub * 2, hit + 0.5, 1.4, "sine", 0.22, sfxBus, { glide: ch.sub, glideTime: 1.2 });
  }

  // ゲームオーバー: フィルターが閉じ、暗く沈む
  function playGameOver() {
    if (!ctx) return;
    const t = ctx.currentTime;
    musicLp.frequency.cancelScheduledValues(t);
    musicLp.frequency.setTargetAtTime(360, t, 0.5);
    [nf(69), nf(64), nf(60), nf(57), nf(45)].forEach((f, i) => {
      tone(f, t + i * 0.24, 1.0, "sawtooth", 0.1, sfxBus,
        { glide: f * 0.92, glideTime: 0.9, lp: 900, rev: 0.7, del: 0.25 });
    });
    tone(nf(33), t + 0.9, 2.4, "sine", 0.32, sfxBus, { glide: nf(21), glideTime: 2.2 });
    nz(t, 2.2, 0.06, sfxBus, { bp: 4000, bpTo: 300, q: 1.0, rev: 0.8 });
  }

  // ================= ミュート =================
  function toggleMute() {
    if (!ctx) return muted;
    muted = !muted;
    out.gain.setTargetAtTime(muted ? 0 : 0.82, ctx.currentTime, 0.03);
    return muted;
  }
  function isMuted() { return muted; }

  return {
    // トランスポート
    start, stop, beatPhase, barPhase, section, now, secondsPerBeat: spb, setIntensity,
    // 効果音
    playClear, playLock, playSquare, playCombo, playBurst, playGameOver,
    playRotate, playMove, playDrop, playBurstReady, playLevelUp, playGrand,
    playSlow, playSlowEnd,
    // ミュート
    toggleMute, isMuted,
    // 参考情報
    bpm: BPM, bars: BARS, loopSeconds: LOOP_SEC,
  };
})();
