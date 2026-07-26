/*
 * GameAudio v8 — Web Audio API のみで合成する「ビッグビート・ファンク」
 *
 *  参考曲 HIDEKI NAGANUMA - JACK DA FUNK を解析し、測れるものは実測値に合わせた。
 *  旋律だけは複製せず独自に書き、それ以外（テンポ・キー・コードの循環・構成の
 *  切れ目・ドラムの打点・跳ね・音色の帯域バランス）を原曲に寄せている。
 *
 *  実測してこの曲に反映した値:
 *   - BPM 112.02（ビートグリッドを総当たりで合わせ込んだ値。
 *     自己相関だけだと 113.5 に見えるが、それだと250秒で位相がずれる）
 *   - 長さ 252.3秒 → 118小節 ≒ 252.8秒
 *   - キー: 低域の根音を小節ごとに数えると G#(A♭)58 / A#(B♭)34 / D#(E♭)11 回。
 *     A♭ を中心とした循環と判断し、出現比に合う8小節を組んだ
 *     （Ab7 Ab7 Bbm7 Ab7 / Ab7 Bbm7 Bbm7 Eb7 = A♭50% B♭37.5% E♭12.5%）
 *   - ドラム: 16分位置ごとの打点を実測。スネアは2・4拍の裏打ち＋3拍裏のゴースト、
 *     キックは 1 / 1a / 2e / 4 / 4e / 4& に詰まった前ノリの刻み
 *   - スウィング: 裏拍ピーク 0.688 → 0.62 の比率で奇数16分を後ろへずらす
 *   - 音色: 8-11kHz が -0.3dB と明るい中高域主体（Rez参考時は -10.4dB）
 *
 *  構成（参考曲の音量推移の変化点をそのまま小節に換算）:
 *    0-7     intro   (0-17s)    スクラッチと濾したブレイクで立ち上げ
 *    8-40    mainA   (17-88s)   本編。リードがリフを歌う
 *    41-44   brk1    (88-96s)   ドラムが抜ける
 *    45-55   mainB   (96-120s)  復帰
 *    56-63   bridge  (120-137s) ハーフタイムで一段落とす
 *    64-77   mainC   (137-167s) 本編再現
 *    78-81   brk2    (167-176s) 小ブレイク
 *    82-103  climax  (176-223s) 全部乗せ
 *    104-117 outro   (223-253s) 抜けていく
 *
 *  音色: ブレイクビーツ（ゴーストスネア入り）/ ファンクベース / クラビのカッティング /
 *        ホーン・スタブ / オルガン / ターンテーブルのスクラッチ / タンバリン /
 *        ピアノ / スーパーソーのリード
 *
 *  インタラクティブ:
 *   - 操作音は次の16分へクオンタイズ＋同じスウィングを適用（曲から浮かせない）
 *   - setIntensity(0..3) で手数・上物・マスターフィルターの開きが変化
 *
 *  著作権フリー: 全てオシレーター/ノイズからのリアルタイム合成（外部音源不使用）
 */
const GameAudio = (() => {
  "use strict";

  // ===== テンポ / 尺 =====
  const BPM = 112.02;              // 参考曲をビートグリッドに合わせ込んで実測した値
  const spb = 60 / BPM;            // 1拍 = 0.5356s
  const STEP = spb / 4;            // 16分 = 0.1339s
  const BAR = spb * 4;             // 4拍子: 1小節 = 2.143s
  const SPB_STEPS = 16;
  const BARS = 118;
  const TOTAL_STEPS = BARS * SPB_STEPS;
  const LOOP_SEC = TOTAL_STEPS * STEP;   // ≒252.8秒（参考曲は252.3秒）

  // ===== スウィング =====
  // 参考曲の裏拍ピークは 0.688（三連寄り）。跳ねが命のジャンルなので深めに取る。
  const SWING = 0.62;
  // 奇数16分を後ろへずらす量（秒）
  const swingOf = (i) => (i % 2 === 1 ? (SWING - 0.5) * 2 * STEP : 0);

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

  // ===== コード進行（A エオリアン: i - VI - III - VII、2小節ずつの8小節周期） =====
  // Am - F - C - G。メロディが最も映え、盛り上がりを作りやすい定番の進行。
  // 参考曲の低域から小節ごとの根音を数えた結果、G#(A♭) 58回 / A#(B♭) 34回 /
  // D#(E♭) 11回 / C#(D♭) 5回。A♭ を中心にしたファンクの循環と判断し、
  // その出現比（A♭50% / B♭37.5% / E♭12.5%）に合う8小節循環を組んだ。
  const CH = {
    Ab7:  { sub: nf(32), root: nf(44), tones: [nf(56), nf(60), nf(63), nf(66)] }, // Ab C  Eb Gb
    Bbm7: { sub: nf(34), root: nf(46), tones: [nf(58), nf(61), nf(65), nf(68)] }, // Bb Db F  Ab
    Db9:  { sub: nf(37), root: nf(49), tones: [nf(61), nf(65), nf(68), nf(71)] }, // Db F  Ab C
    Eb7:  { sub: nf(39), root: nf(51), tones: [nf(63), nf(67), nf(70), nf(73)] }, // Eb G  Bb Db
  };
  const PROG = [CH.Ab7, CH.Ab7, CH.Bbm7, CH.Ab7,
                CH.Ab7, CH.Bbm7, CH.Bbm7, CH.Eb7];
  const chordForBar = (bar) => PROG[bar % PROG.length];

  // 効果音用スケール（A マイナー・ペンタ + 9th。どのコードにも乗る）
  const SCALE = [57, 60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84].map(nf);

  // ===== アシッド・ベース パターン（[半音オフセット, アクセント, スライド]） =====
  const _ = null;
  // ===== ブレイクビーツ（16ステップ / 拍頭は 0 4 8 12） =====
  // ファンキー・ドラマー系: キックは1と2裏・3の裏、スネアは2と4、
  // 隙間にゴーストスネアを置いて跳ねを作る。
  // 参考曲の 60-92秒 をビートグリッドに合わせ込んで16分位置ごとの打点を実測した結果:
  //   KICK  1(.9) 1a(.8) 2e(.8) 4(.8) 4e(.9) 4&(1.0) … 前ノリで詰まった刻み
  //   SNARE 2(.7) 3&(.7) 4(1.0)      … 2・4の裏打ち + 3拍裏のゴースト
  // これをそのままパターン化した（B は2小節ごとの変化形）。
  const KICK_A  = [.9, 0, .6, .8, 0, .8, .5, 0, 0, .6, .6, 0, .8, .9, 1, 0];
  const KICK_B  = [.9, 0, .6, 0, .3, .8, 0, .5, 0, .6, .7, 0, .8, 0, 1, .5];
  const SNARE_A = [0, 0, .15, 0, 1, 0, .2, 0, 0, .18, .7, 0, 1, 0, .22, 0];
  const SNARE_B = [0, .15, 0, .2, 1, 0, .25, 0, .18, 0, .7, .3, 1, 0, 0, .35];
  // ハイハット（8分主体。裏を少し強くしてシャッフル感を出す）
  const HAT     = [.85, .3, .5, .35, .75, .3, .55, .4, .85, .3, .5, .35, .75, .35, .6, .45];
  // タンバリン / シェイカー
  const TAMB    = [0, .5, 0, .6, 0, .5, 0, .7, 0, .5, 0, .6, 0, .5, 0, .8];

  // ファンク・ベース（[半音オフセット, アクセント, スライド]）
  const BASS_A = [
    [0, 1, 0], _, _, [0, 0, 0], _, _, [12, 0, 0], _,
    [0, 1, 0], _, [10, 0, 0], _, [12, 0, 0], _, [7, 0, 1], _,
  ];
  const BASS_B = [
    [0, 1, 0], _, [0, 0, 0], _, [3, 0, 0], _, [5, 0, 0], _,
    [7, 1, 0], _, _, [5, 0, 0], [3, 0, 0], _, [0, 0, 1], _,
  ];
  // クラビ／カッティングの刻み位置
  const CLAV   = [0, .8, 0, .9, 0, .7, .5, 0, 0, .85, 0, .9, 0, .7, .6, 0];
  // ホーン・スタブ（1で短打、2で長め）
  const HORN_A = [2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0];
  const HORN_B = [0, 0, 2, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0, 0];
  // アルペジオ（旧来の互換用に残す）
  const ARP = [0, 2, 1, 3, 2, 0, 3, 1, 1, 3, 0, 2, 3, 1, 2, 0];
  const ARP_OCT = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1];
  const PERC = [0, .5, 0, .8, 0, .4, .9, 0, 0, .6, 0, .5, .7, 0, .4, .8];

  // ===== セクション =====
  // id は section() の戻り値（背景演出用）: 0=イントロ 1=ビルド 2=ドロップ 3=ブレイク 4=ラストドロップ
  // cut = マスターLPFの開き / lvl = セクション全体の音量。
  // 抑揚を出すため、静と動の落差を大きく取る（ブレイクは大きく引き、ドロップで解放）。
  // 参考曲の音量推移を4秒刻みで実測し、落ちる時刻（88s / 120s / 168s / 224s）と
  // 立ち上がる時刻（16s / 178s）をそのまま小節番号に換算して切れ目にした。
  // 1小節 = 2.143s なので 118小節 ≒ 252.8秒（参考曲 252.3秒）。
  //   0-7     intro   (0-17s)    スクラッチと濾したブレイクで立ち上げ
  //   8-40    mainA   (17-88s)   本編
  //   41-44   brk1    (88-96s)   ドラムが抜ける
  //   45-55   mainB   (96-120s)  復帰
  //   56-63   bridge  (120-137s) ハーフタイムで一段落とす
  //   64-77   mainC   (137-167s) 本編再現
  //   78-81   brk2    (167-176s) 小ブレイク
  //   82-103  climax  (176-223s) 全部乗せ
  //   104-117 outro   (223-253s) 抜けていく
  function sectionOfBar(bar) {
    if (bar < 8)   return { id: 0, name: "intro",  cut: 1600,  lvl: 0.52 };
    if (bar < 41)  return { id: 2, name: "mainA",  cut: 13000, lvl: 1.00 };
    if (bar < 45)  return { id: 3, name: "brk1",   cut: 2600,  lvl: 0.58 };
    if (bar < 56)  return { id: 2, name: "mainB",  cut: 13000, lvl: 1.00 };
    if (bar < 64)  return { id: 3, name: "bridge", cut: 4200,  lvl: 0.74 };
    if (bar < 78)  return { id: 2, name: "mainC",  cut: 14000, lvl: 1.00 };
    if (bar < 82)  return { id: 3, name: "brk2",   cut: 2800,  lvl: 0.60 };
    if (bar < 104) return { id: 4, name: "climax", cut: 16000, lvl: 1.00 };
    return { id: 0, name: "outro", cut: 5000, lvl: 0.70 };
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

  // ================= ファンクの楽器たち =================

  // ホーン・セクション（ブラス・スタブ）。鋸波を重ねて帯域を絞り、
  // 立ち上がりに軽いピッチのしゃくりを付けて生管っぽさを出す。
  function hornStab(chord, t, dur, vel = 1, o = {}) {
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 1250; bp.Q.value = 0.8;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = 2;
    lp.frequency.setValueAtTime(2200, t);
    lp.frequency.linearRampToValueAtTime(4200, t + 0.05);
    lp.frequency.exponentialRampToValueAtTime(1400, t + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.085 * vel, t + 0.022);
    g.gain.setValueAtTime(0.085 * vel, t + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const notes = o.notes || chord.tones.slice(1);
    notes.forEach((f, k) => {
      [-7, 7].forEach((cents) => {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(f * 0.985, t);          // しゃくり
        osc.frequency.linearRampToValueAtTime(f, t + 0.035);
        osc.detune.value = cents + (k - 1) * 3;
        const og = ctx.createGain(); og.gain.value = 0.2;
        osc.connect(og); og.connect(bp);
        osc.start(t); osc.stop(t + dur + 0.05);
      });
    });
    bp.connect(lp); lp.connect(g);
    let node = g;
    if (o.pan !== undefined) { const pn = pan(o.pan); g.connect(pn); node = pn; }
    node.connect(duck);
    send(node, revIn, o.rev ?? 0.28); send(node, delayIn, o.del ?? 0.12);
  }

  // クラビネット風のカッティング（極短い減衰 + 強いレゾナンス）
  function clav(freq, t, vel = 1, o = {}) {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = 9;
    lp.frequency.setValueAtTime(2600 + vel * 2600, t);
    lp.frequency.exponentialRampToValueAtTime(600, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.075 * vel, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    ["square", "sawtooth"].forEach((ty, k) => {
      const osc = ctx.createOscillator();
      osc.type = ty; osc.frequency.value = freq * (k ? 1.004 : 1);
      const og = ctx.createGain(); og.gain.value = k ? 0.35 : 0.6;
      osc.connect(og); og.connect(lp);
      osc.start(t); osc.stop(t + 0.16);
    });
    lp.connect(g);
    const pn = pan(o.pan ?? 0.3); g.connect(pn); pn.connect(duck);
    send(pn, delayIn, 0.16);
  }

  // ターンテーブルのスクラッチ。帯域ノイズの再生速度を往復させて擦る音を作る。
  function scratch(t, dur = 0.28, vel = 1, o = {}) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    // 前後に擦る動き
    src.playbackRate.setValueAtTime(1.6, t);
    src.playbackRate.linearRampToValueAtTime(0.35, t + dur * 0.42);
    src.playbackRate.linearRampToValueAtTime(1.9, t + dur * 0.78);
    src.playbackRate.linearRampToValueAtTime(0.7, t + dur);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.Q.value = 3.2;
    bp.frequency.setValueAtTime(700, t);
    bp.frequency.linearRampToValueAtTime(2600, t + dur * 0.5);
    bp.frequency.linearRampToValueAtTime(900, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.10 * vel, t + 0.012);
    g.gain.setValueAtTime(0.10 * vel, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(g);
    const pn = pan(o.pan ?? -0.35); g.connect(pn); pn.connect(duck);
    send(pn, delayIn, 0.2); send(pn, revIn, 0.18);
    src.start(t); src.stop(t + dur + 0.02);
  }

  // ファンク・ベース（指弾き風。軽い歪みと素早いフィルター減衰）
  function funkBass(freq, t, dur, o = {}) {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = o.accent ? 7 : 3.5;
    const peak = (o.accent ? 2400 : 1300) + (o.cut || 0);
    lp.frequency.setValueAtTime(peak, t);
    lp.frequency.exponentialRampToValueAtTime(320, t + Math.max(0.12, dur));
    const g = ctx.createGain();
    const amp = 0.20 * (o.accent ? 1.25 : 1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    if (o.from) {
      osc.frequency.setValueAtTime(o.from, t);
      osc.frequency.exponentialRampToValueAtTime(freq, t + 0.07);
    } else osc.frequency.value = freq;
    // 芯を出す矩形の1オクターブ下
    const sq = ctx.createOscillator();
    sq.type = "square"; sq.frequency.value = freq / 2;
    const sg = ctx.createGain(); sg.gain.value = 0.32;
    osc.connect(lp); sq.connect(sg); sg.connect(lp); lp.connect(g); g.connect(duck);
    osc.start(t); osc.stop(t + dur + 0.04);
    sq.start(t); sq.stop(t + dur + 0.04);
  }

  // オルガン（引き伸ばしたコード。倍音を足して枯れた質感に）
  function organ(chord, t, dur, amp = 0.04) {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 2600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.05);
    g.gain.setValueAtTime(amp, t + dur - 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    chord.tones.forEach((f) => {
      [1, 2, 3].forEach((h, k) => {
        const osc = ctx.createOscillator();
        osc.type = "sine"; osc.frequency.value = f * h;
        const og = ctx.createGain(); og.gain.value = [0.5, 0.25, 0.14][k];
        osc.connect(og); og.connect(lp);
        osc.start(t); osc.stop(t + dur + 0.06);
      });
    });
    lp.connect(g); g.connect(duck);
    send(g, revIn, 0.4);
  }

  // タンバリン
  function tamb(t, vel = 1) {
    metal(t, 0.09, 0.045 * vel, drumBus, { base: 900, bp: 7200, hp: 5000, voices: 5, rev: 0.2 });
  }

  // ================= ピアノ =================
  // 倍音を積み、高次ほど速く減衰させる加算合成。わずかな非調和で弦の張りを出し、
  // ハンマーのノイズと減衰につれ閉じるLPFで生っぽさを作る。
  const PIANO_PARTIALS = [[1, 1.0], [2, 0.40], [3, 0.20], [4, 0.10], [5, 0.055], [7, 0.025]];
  function piano(freq, t, dur, vel = 1, o = {}) {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(Math.min(11000, freq * 10), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(420, freq * 2.4), t + Math.max(0.2, dur * 0.75));

    const g = ctx.createGain();
    g.gain.value = 0.115 * vel;

    PIANO_PARTIALS.forEach(([n, amp], k) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq * n * (1 + 0.0006 * n * n);   // 非調和
      const og = ctx.createGain();
      const d = Math.max(0.09, dur / (1 + k * 0.62));          // 高次ほど短い
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(amp, t + 0.005);
      og.gain.exponentialRampToValueAtTime(0.0001, t + d);
      osc.connect(og); og.connect(lp);
      osc.start(t); osc.stop(t + dur + 0.06);
    });

    let node = g;
    if (o.pan !== undefined) { const pn = pan(o.pan); g.connect(pn); node = pn; }
    lp.connect(g);
    node.connect(duck);
    send(node, revIn, o.rev ?? 0.5);
    if (o.del) send(node, delayIn, o.del);
    // ハンマーの当たり
    nz(t, 0.016, 0.028 * vel, duck, { hp: 2400, pan: o.pan });
  }

  // ================= メインメロディ =================
  // A エオリアンの8小節フック。コードは 2小節ずつ Am → F → Dm → Em。
  // 小節6でトップの B5 に到達して山を作り、小節7で E5 に着地する。
  // [16分位置, MIDI, 長さ(16分)]
  // Ab7 循環の上に置く8小節のファンク・リフ。
  // A♭ ブルーススケール（Ab B Db D Eb Gb）を軸に、16分の跳ねを効かせた
  // 「コール(2小節) → レスポンス(1小節) → ターンアラウンド(1小節)」を1セットとし、
  // 後半4小節はそれをそのままオクターブ上げて盛り上げる。
  // 短く言い切るリフ型なので、跳ねと一緒に体で覚えられる。
  // [16分位置(0-15), MIDI, 長さ(16分)]
  const MELODY = [
    // 1-2小節目: Ab7 上のコール
    [[0, 68, 3], [3, 71, 2], [6, 73, 2], [7, 74, 1], [8, 75, 4], [13, 73, 2]],
    [[0, 71, 3], [3, 68, 2], [6, 66, 4], [11, 68, 4]],
    // 3小節目: Bbm7 上のレスポンス
    [[0, 75, 3], [3, 73, 2], [6, 71, 3], [10, 68, 5]],
    // 4小節目: Ab7 へ戻るターンアラウンド
    [[0, 73, 2], [2, 71, 2], [4, 68, 2], [6, 66, 2], [8, 63, 3], [12, 68, 4]],
    // 5-6小節目: 同じコールをオクターブ上で
    [[0, 80, 3], [3, 83, 2], [6, 85, 2], [7, 86, 1], [8, 87, 4], [13, 85, 2]],
    [[0, 83, 3], [3, 80, 2], [6, 78, 4], [11, 80, 4]],
    // 7小節目: Bbm7 上で頂点を保つ
    [[0, 87, 3], [3, 85, 2], [6, 83, 3], [10, 80, 5]],
    // 8小節目: Eb7 から Ab へ着地
    [[0, 85, 2], [2, 83, 2], [4, 80, 2], [6, 78, 2], [8, 75, 3], [12, 80, 4]],
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
    const amp = 0.105 * vel;      // 主役として前に出す
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

  // ピアノで主題を弾く。mode:
  //   "solo"  … 右手で主題 + 左手の分散和音（イントロとブレイク）
  //   "comp"  … 和音の刻みだけ（ビート合流後の伴奏）
  //   "double"… リードに寄り添って主題を重ねる（フィナーレ）
  function pianoPart(bar, i, t, mode, chord) {
    // --- 左手: ルートと5度の分散（8分） ---
    // 三拍子の定石: 1拍目にバス、2・3拍目に和音（ズン・チャッ・チャッ）
    if (mode === "solo") {
      if (i === 0) piano(chord.root, t, spb * 1.3, 0.85, { pan: -0.35, rev: 0.6 });
      if (i === 4 || i === 8) {
        chord.tones.slice(0, 3).forEach((f, k) =>
          piano(f * 0.5, t, spb * 0.55, 0.34, { pan: -0.34 + k * 0.16, rev: 0.6 }));
      }
    } else if (mode === "comp") {
      if (i === 0) piano(chord.root, t, spb * 1.2, 0.55, { pan: -0.3 });
      if (i === 4 || i === 8) {
        chord.tones.slice(0, 3).forEach((f, k) =>
          piano(f, t, spb * 0.5, 0.30, { pan: -0.22 + k * 0.2, rev: 0.45 }));
      }
    }

    // --- 右手: 主題 ---
    if (mode === "solo" || mode === "double") {
      const evs = MELODY[bar % 8];
      for (const [pos, midi, len] of evs) {
        if (pos !== i) continue;
        const dur = len * STEP * (mode === "solo" ? 1.35 : 1.0);
        const vel = mode === "solo" ? 1 : 0.42;
        piano(nf(midi), t, dur, vel, { pan: 0.18, rev: mode === "solo" ? 0.62 : 0.4, del: 0.2 });
        // 独奏時はオクターブ下を薄く足して芯を出す
        if (mode === "solo") piano(nf(midi - 12), t, dur * 0.8, 0.30, { pan: 0.12, rev: 0.5 });
      }
    }
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
        case "tease":   // 予告: 断片をディレイの霧の中に
          leadV(f, t, dur, 0.30, { cut: 2200, del: 0.75, rev: 0.6, atk: 0.05, det: 9 });
          break;
        case "build":   // 提示: 控えめ・フィルター閉じ気味
          leadV(f, t, dur, 0.60, { cut: 3400, del: 0.5, rev: 0.42, det: 12 });
          break;
        case "drop":    // 主役: 芯 + オクターブ重ね（ここが一番の聴かせどころ）
          leadV(f, t, dur, 1.0, { cut: 6000, body: true, det: 16, rev: 0.26 });
          leadV(f * 2, t, dur, 0.36, { cut: 8000, del: 0.3, rev: 0.3, det: 20 });
          break;
        case "final":   // 最厚: 3度ハモリ + オクターブ上下
          leadV(f, t, dur, 1.0, { cut: 7400, body: true, det: 18, pan: -0.16, rev: 0.24 });
          leadV(nf(midi + 3), t, dur, 0.52, { cut: 5600, det: 16, pan: 0.3, del: 0.3 });
          leadV(f * 2, t, dur, 0.44, { cut: 8600, det: 22, rev: 0.28 });
          break;
      }
    }
  }

  // ================= セクション別シーケンス =================
  function applyTone(t, bar) {
    const s = sectionOfBar(bar);
    let base = s.cut;
    // イントロはフィルターが徐々に開き、アウトロは閉じていく
    if (s.name === "intro") base = 900 + Math.pow(bar / 8, 2) * 7000;
    if (s.name === "outro") base = 12000 * Math.pow(1 - (bar - 104) / 14, 1.5) + 700;
    baseCutoff = base;
    const target = Math.max(280, Math.min(18000, base * (0.55 + intensity * 0.15)));
    musicLp.frequency.setTargetAtTime(target, t, 0.25);

    // --- セクション音量のオートメーション（抑揚の骨格） ---
    let lvl = s.lvl;
    if (s.name === "intro") lvl = 0.34 + (bar / 8) * 0.46;
    if (s.name === "outro") lvl = 0.92 * Math.pow(1 - (bar - 104) / 14, 0.8) + 0.06;
    // 復帰直前の1小節は一瞬引いて、戻った瞬間の解放感を作る
    if (bar === 44 || bar === 63 || bar === 81) lvl *= 0.72;
    secGain.gain.setTargetAtTime(lvl, t, 0.30);
  }

  function scheduleStep(step, t0) {
    const bar = (step / SPB_STEPS) | 0;
    const i = step % SPB_STEPS;
    const t = t0 + swingOf(i);              // 奇数16分を後ろへ = 跳ね
    const s = sectionOfBar(bar);
    const name = s.name;
    const chord = chordForBar(bar);
    const phrase = bar % 8;                 // リフの8小節周期
    const isMain = name === "mainA" || name === "mainB" || name === "mainC";
    const early = name === "mainA" && bar < 16;   // 本編の入り口は少し薄く
    const isBig = name === "climax";
    const full = isMain || isBig;
    const isBrk = name === "brk1" || name === "brk2";
    const alt = (bar >> 1) % 2 === 1;       // 2小節ごとにパターンを入れ替える

    if (i === 0) applyTone(t, bar);

    // ---------- ブレイクビーツ ----------
    if (name === "intro") {
      // 濾したブレイクが徐々に姿を現す
      if (bar >= 2 && KICK_A[i]) kick(t, KICK_A[i] * 0.6, { soft: true, duckDepth: 0.35 });
      if (bar >= 4 && (i === 4 || i === 12)) snare(t, 0.45);
      if (bar >= 6 && i % 2 === 0) hatC(t, 0.3);
    } else if (isBrk) {
      // ドラムを抜く。頭のキックと4拍目のスネアだけ残す
      if (i === 0) kick(t, 0.9, { duckDepth: 0.4 });
      if (i === 12) snare(t, 0.7);
      if (i % 4 === 2) hatC(t, 0.25);
    } else if (name === "bridge") {
      // ハーフタイム: 手数を半分にして重心を下げる
      if (i === 0) kick(t, 1);
      if (i === 8) snare(t, 0.95);
      if (i % 4 === 0) hatC(t, 0.5);
      if (i === 6 || i === 14) hatO(t, 0.45);
    } else if (name === "outro") {
      const fade = 1 - (bar - 104) / 16;
      const kp = KICK_A[i];
      if (kp) kick(t, kp * fade);
      if (SNARE_A[i] >= 1) snare(t, fade);
      if (i % 2 === 0) hatC(t, 0.5 * fade);
    } else {
      const kp = (alt ? KICK_B : KICK_A)[i];
      const sp = (alt ? SNARE_B : SNARE_A)[i];
      if (kp) kick(t, kp * (isBig ? 1 : 0.95));
      if (sp) snare(t, sp * (isBig ? 1 : 0.92));       // 小さい値はゴーストになる
      if (HAT[i]) hatC(t, HAT[i] * (full ? 0.85 : 0.6));
      if (i === 6 || i === 14) hatO(t, 0.55);
      if (isBig && TAMB[i]) tamb(t, TAMB[i]);
      if (full && (i === 7 || i === 15)) rim(t, 0.45, i === 7 ? -0.5 : 0.5);
      if (isBig && PERC[i] > 0 && intensity >= 2) ride(t, PERC[i] * 0.5);
    }

    // ---------- サブベース ----------
    if (name !== "intro" && i === 0) sub(chord.sub, t, spb * 1.6, isBrk ? 0.8 : 1);

    // ---------- ファンク・ベース ----------
    if (name !== "intro" || bar >= 4) {
      const pat = alt ? BASS_B : BASS_A;
      const n = pat[i];
      if (n && (full || isBrk || name === "bridge" || name === "outro")) {
        const [semi, accent, slide] = n;
        const f = chord.root * Math.pow(2, semi / 12);
        funkBass(f, t, STEP * (slide ? 2.4 : 1.5), {
          accent, from: slide ? f * 0.78 : 0,
          cut: isBig ? 900 : full ? 500 : 0,
        });
      }
    }

    // ---------- クラビのカッティング ----------
    if (full && CLAV[i]) {
      const idx = (i + bar) % 4;
      clav(chord.tones[idx] * 2, t, CLAV[i] * (isBig ? 1 : 0.8), { pan: 0.34 });
    }
    if (name === "bridge" && i % 4 === 2) clav(chord.tones[1] * 2, t, 0.5, { pan: 0.3 });

    // ---------- ホーン・スタブ ----------
    if (full) {
      const hp = (alt ? HORN_B : HORN_A)[i];
      if (hp) hornStab(chord, t, hp === 2 ? spb * 0.85 : spb * 0.34,
                       isBig ? 1 : 0.8, { pan: -0.2 });
    }
    if (isBrk && i === 0) hornStab(chord, t, spb * 1.4, 0.7, { pan: -0.15, rev: 0.5 });

    // ---------- オルガン ----------
    if (i === 0 && (name === "bridge" || isBrk)) organ(chord, t, BAR * 0.95, 0.05);
    if (i === 0 && isBig && bar % 2 === 0) organ(chord, t, BAR * 1.9, 0.028);

    // ---------- パッド（薄い下地） ----------
    if (i === 0 && bar % 2 === 0 && (name === "intro" || name === "outro")) {
      pad(chord, t, 2, 0.035);
    }

    // ---------- スクラッチ（このジャンルの看板） ----------
    if (name === "intro" && (bar % 2 === 1) && i === 12) scratch(t, 0.34, 0.9);
    if (full && phrase === 7 && (i === 8 || i === 12)) scratch(t, 0.26, 1, { pan: i === 8 ? -0.4 : 0.4 });
    if (isBig && phrase % 4 === 3 && i === 14) scratch(t, 0.2, 0.85, { pan: 0.45 });
    if (isBrk && i === 6) scratch(t, 0.4, 1, { pan: -0.3 });

    // ---------- リフ（リード） ----------
    let mel = null;
    if (early) mel = "build";          // 入り口はフィルター気味で提示
    else if (isMain) mel = "drop";
    else if (isBig) mel = "final";
    else if (isBrk) mel = "tease";
    if (mel) playMelodyStep(bar, i, t, mel);

    // ---------- ピアノ（イントロとブレイクの彩り） ----------
    if (name === "intro" && bar >= 4) pianoPart(bar, i, t, "comp", chord);
    if (early && i % 8 === 0) organ(chord, t, BAR * 0.5, 0.03);
    if (name === "bridge") pianoPart(bar, i, t, "comp", chord);
    if (name === "outro" && bar < 114) pianoPart(bar, i, t, "comp", chord);

    // ---------- 展開 FX ----------
    if (i === 0 && (bar === 8 || bar === 45 || bar === 64 || bar === 82)) {
      crash(t, bar === 82 ? 1 : 0.8);
    }
    // 復帰の直前2小節でライザー
    if ((bar === 43 || bar === 62 || bar === 80) && i === 0) riser(t, BAR * 2);
    // ブレイクへ入る/出る掃引
    if ((bar === 41 || bar === 56 || bar === 78) && i === 0) sweep(t, BAR, false, 0.09);
    if ((bar === 44 || bar === 63 || bar === 81) && i === 8) {
      sweep(t, BAR * 0.5, true, 0.11);
      reverseCymbal(t, BAR * 0.5, 0.13);
    }
    // フレーズ終わりのスネアフィル
    if ((bar === 40 || bar === 55 || bar === 77 || bar === 103) && i >= 10) {
      snare(t, 0.3 + (i - 10) * 0.11);
    }
  }

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
    return startTime + n * STEP + swingOf(n % SPB_STEPS);
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
