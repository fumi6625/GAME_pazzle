/*
 * GameAudio v9 — PRISM SHUFFLE 素材を再生するサンプルベース・エンジン
 *
 * 自前のシンセ合成をやめ、PRISM_SHUFFLE/ の素材をそのまま鳴らす方式に切り替えた。
 * 仕様は PRISM_SHUFFLE/README.md に従う（数値はすべて実ファイルで検証済み）:
 *
 *   テンポ      96 BPM（1拍 0.625s / 1小節 2.5s / 16分 0.15625s）
 *   ループ      32小節 = 80.000000s = 3,528,000 サンプル @44.1kHz（サンプル単位で正確）
 *   スウィング  裏16分を 18.75ms 後ろへ（16分の12%）
 *
 *   ※ 96 BPM は「タイムラインが16列を5.000秒で渡り切る」ことから決めた。
 *      16列 = 2小節を保つと 8拍 = 5.000秒 → 96.000 BPM ちょうど。
 *      2小節は32小節ループを割り切るので、曲の切り替わりと掃引の頭がずっと一致する。
 *      素材は 135 BPM 版から作り直してある（ドラムは16分スライスの貼り直し、
 *      他はフェーズボコーダ。詳細は PRISM_SHUFFLE/README.md）。
 *   調          F ドリアン / 操作音は F マイナーペンタトニック
 *
 * ■ ステム（音楽）
 *   5本を同じ AudioContext の時刻で同時 start するのでサンプル単位で位相が揃う。
 *   README の推奨に従い 05_atmos は常時鳴らす（高域の刺さりを抑える層のため）。
 *   ゲーム状況に応じて 03_chords / 04_melody を小節境界でクロスフェードする。
 *     静か = 01+02+05 / 標準 = +03 / 高揚 = +04
 *   全部鳴らす時はステムの 8% ヘッドルーム分をマスターで戻す（×1.083 = +0.7dB）。
 *
 * ■ 読み込み経路
 *   ステムは fetch で読む。file:// で開くと fetch が CORS で弾かれるため、
 *   その場合は <audio> で全部入りミックス（PRISM_SHUFFLE_loop.m4a）に自動で切り替える。
 *   （この時はレイヤー切替なし。HTTP で配信すれば全機能が有効になる。）
 *   操作音は sfx-assets.js に FLAC を base64 で埋め込んであるので、
 *   どの開き方でも 16分グリッドへ正確にクオンタイズして鳴らせる。
 */
const GameAudio = (() => {
  "use strict";

  // ===== グリッド定数（README の値）=====
  // ===== 曲テーブル =====
  // 参考動画（RTA in Japan / ルミネス リマスター）では、タイムラインの1周が
  // スキン（＝曲）ごとに 4.0〜5.6 秒と違っていた。掃引の速さは曲のテンポで
  // 決まるのが本家の設計なので、テンポの違う曲を用意して切り替える。
  // 掃引は常に「2小節 = 16列」なので、BPM が決まれば掃引時間も決まる。
  //
  // BPM はすべて 32小節ぶんが 44100Hz でサンプル単位に割り切れる値。
  // 端数が出るとループのたびに位相がずれて、掃引と音がずれていく。
  const BARS = 32;
  const SWING_RATIO = 0.12;             // 裏16分を16分の12%だけ後ろへ
  const HEADROOM = 1.083;               // ステム合計を元のミックス音量へ戻す係数

  // semis: 操作音の移調量（PRISM SHUFFLE の F を 0 とした半音差）。
  // 操作音は1セットしか持たないので、曲が変わったら再生レートで主音を合わせる。
  // 素材は C マイナーペンタトニック = F ドリアンの部分集合なので、
  // 主音ぶん動かせば A エオリアン / E エオリアン / D ドリアンにもそのまま乗る。
  const TRACKS = [
    { id: "PRISM_SHUFFLE", title: "PRISM SHUFFLE", genre: "ビッグビート / ファンク",
      bpm: 96, semis: 0, base: "PRISM_SHUFFLE/", loop: "PRISM_SHUFFLE_loop" },
    { id: "NEON_MARCH", title: "NEON MARCH", genre: "4つ打ちテクノ",
      bpm: 120, semis: 4, base: "PRISM_SHUFFLE/NEON_MARCH/", loop: "loop" },
    { id: "CIRCUIT_RUSH", title: "CIRCUIT RUSH", genre: "エレクトロ・ブレイクス",
      bpm: 112, semis: -1, base: "PRISM_SHUFFLE/CIRCUIT_RUSH/", loop: "loop" },
    { id: "GLASS_TIDE", title: "GLASS TIDE", genre: "ダウンテンポ・ダブ",
      bpm: 84, semis: -3, base: "PRISM_SHUFFLE/GLASS_TIDE/", loop: "loop" },
  ];
  TRACKS.forEach((t) => {
    t.spb = 60 / t.bpm;
    t.step = t.spb / 4;
    t.bar = t.spb * 4;
    t.loopSec = BARS * t.bar;
    t.swing = t.step * SWING_RATIO;
    t.frames44k = Math.round(t.loopSec * 44100);
    t.sweepSec = t.bar * 2;             // 16列 = 2小節
  });

  let trackIdx = 0;
  const T = () => TRACKS[trackIdx];
  // 旧コードとの互換のため、いまの曲の値を返す薄い別名を置く
  const spbOf = () => T().spb;
  const BAR_OF = () => T().bar;
  const STEMS = ["01_drums", "02_bass", "03_chords", "04_melody", "05_atmos"];
  // レイヤー: 0=常時 / 1=標準以上 / 2=高揚のみ
  const STEM_TIER = { "01_drums": 0, "02_bass": 0, "05_atmos": 0, "03_chords": 1, "04_melody": 2 };

  let ctx = null;
  let master, sfxBus, musicBus;
  let started = false, muted = false;
  let intensity = 1;
  let startTime = 0;

  let stemBufs = {};       // name -> AudioBuffer
  let stemGain = {};       // name -> GainNode
  let stemSrc = {};        // name -> AudioBufferSourceNode
  let sfxBufs = {};        // name -> AudioBuffer
  let fallbackEl = null;   // file:// 用の <audio>
  let usingFallback = false;
  let ready = false;

  // 同一グリッドへの発音集中を防ぐ
  const lastSlot = new Map();

  // ===== 読み込み =====
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }

  async function loadSfx() {
    if (typeof SFX_ASSETS === "undefined") return;
    const names = Object.keys(SFX_ASSETS);
    await Promise.all(names.map(async (n) => {
      try {
        sfxBufs[n] = await ctx.decodeAudioData(b64ToBuf(SFX_ASSETS[n]));
      } catch (e) { /* 1つ読めなくても他は鳴らす */ }
    }));
  }

  // AAC はエンコーダ遅延と末尾パディングが入るため、デコード後の長さが
  // 原音と一致しない。サンプル単位のシームレスループが命なので、
  // 仕様どおりの長さへ切り揃える（不足分は無音で埋める）。
  function trimToLoop(buf, track) {
    const want = Math.round((track || T()).frames44k * (buf.sampleRate / 44100));
    if (buf.length === want) return buf;
    const out = ctx.createBuffer(buf.numberOfChannels, want, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch);
      out.getChannelData(ch).set(src.subarray(0, Math.min(want, src.length)));
    }
    return out;
  }

  // 配信サイズを抑えた m4a（約5MB）を優先し、無ければ原音の wav（約47MB）を使う。
  // スマホの回線で 47MB を落とすのは現実的でないため。
  // AAC を復号できない環境（コーデック非搭載の Chromium など）もあるので、
  // 失敗したら黙って wav へ落とす。iOS Safari と通常の Chrome は AAC を復号できる。
  let stemSource = "";
  // どの形式から試すかを先に決める。全部試すと、復号できない形式まで
  // ダウンロードしてしまい通信量が倍になるため。
  function codecOrder() {
    const a = document.createElement("audio");
    const aac = a.canPlayType('audio/mp4; codecs="mp4a.40.2"');
    const ogg = a.canPlayType('audio/ogg; codecs="vorbis"');
    const m4a = ["stems_web/", ".m4a"], og = ["stems_web/", ".ogg"], wav = ["stems/", ".wav"];
    if (aac) return [m4a, og, wav];        // iOS Safari / 通常の Chrome
    if (ogg) return [og, m4a, wav];        // AAC 非搭載のビルド
    return [wav, m4a, og];
  }
  let CODECS = null;

  async function fetchStem(track, n) {
    // m4a … iOS Safari 用（必須）。ogg … Chrome/Firefox 用で m4a より小さい。
    // wav … 原音。AAC も Vorbis も復号できない環境の最後の砦。
    if (!CODECS) CODECS = codecOrder();
    for (const [dir, ext] of CODECS) {
      try {
        const r = await fetch(track.base + dir + n + ext);
        if (!r.ok) continue;
        const buf = trimToLoop(await ctx.decodeAudioData(await r.arrayBuffer()), track);
        stemSource = ext;
        return buf;
      } catch (e) { /* 次の候補へ */ }
    }
    throw new Error("stem not found: " + track.id + "/" + n);
  }

  // 曲ごとにステムを持つ。読み込み済みなら使い回す。
  const bufsByTrack = {};
  const loading = {};
  async function loadStems(track) {
    if (bufsByTrack[track.id]) return bufsByTrack[track.id];
    if (loading[track.id]) return loading[track.id];
    loading[track.id] = (async () => {
      const got = await Promise.all(STEMS.map(async (n) => [n, await fetchStem(track, n)]));
      const m = {};
      got.forEach(([n, b]) => { m[n] = b; });
      bufsByTrack[track.id] = m;
      return m;
    })();
    try { return await loading[track.id]; }
    finally { delete loading[track.id]; }
  }

  // 次の曲を先に読んでおく。レベルアップの瞬間に読み込みが始まると
  // 切り替わりが1秒ほど遅れて、掃引と曲がずれて聞こえるため。
  function prefetchTrack(i) {
    if (usingFallback || !ctx) return;
    const t = TRACKS[((i % TRACKS.length) + TRACKS.length) % TRACKS.length];
    if (bufsByTrack[t.id] || loading[t.id]) return;
    loadStems(t).catch(() => {});
  }

  function setupFallback() {
    usingFallback = true;
    fallbackEl = new Audio(T().base + T().loop + ".m4a");
    fallbackEl.loop = true;
    fallbackEl.preload = "auto";
    try {
      const src = ctx.createMediaElementSource(fallbackEl);
      src.connect(musicBus);
    } catch (e) {
      fallbackEl.volume = 0.85;   // グラフに繋げない環境では素で鳴らす
    }
  }

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();

    master = ctx.createGain(); master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6; comp.knee.value = 10; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.16;
    master.connect(comp); comp.connect(ctx.destination);

    musicBus = ctx.createGain(); musicBus.gain.value = HEADROOM;
    musicBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.85;
    sfxBus.connect(master);
  }

  // 素材の読み込み。ステムが取れなければ全部入りミックスへ退避する。
  async function preload() {
    init();
    await loadSfx();
    // file:// では fetch が必ず CORS で弾かれるので、試さずに退避経路へ回す
    // （試すとコンソールがエラーで埋まるだけで結果は同じ）。
    if (location.protocol === "file:") {
      setupFallback();
    } else {
      try {
        stemBufs = await loadStems(T());
      } catch (e) {
        setupFallback();
      }
    }
    ready = true;
  }

  // ===== 再生 =====
  function startStems(at) {
    STEMS.forEach((n) => {
      const g = ctx.createGain();
      g.gain.value = STEM_TIER[n] === 0 ? 1 : 0;   // 上位レイヤーは無音から
      g.connect(musicBus);
      const s = ctx.createBufferSource();
      s.buffer = stemBufs[n];
      s.loop = true;
      s.connect(g);
      s.start(at);
      stemGain[n] = g;
      stemSrc[n] = s;
    });
  }

  function start() {
    init();
    if (ctx.state === "suspended") ctx.resume();
    if (started) return;
    started = true;
    startTime = ctx.currentTime + 0.08;

    if (!ready) {
      // 読み込みが終わっていなければ、終わり次第そろえて開始する
      preload().then(() => {
        startTime = ctx.currentTime + 0.05;
        if (usingFallback) { if (fallbackEl) fallbackEl.play().catch(() => {}); }
        else startStems(startTime);
        applyIntensity(0.05);
      });
      return;
    }
    if (usingFallback) { if (fallbackEl) fallbackEl.play().catch(() => {}); }
    else startStems(startTime);
    applyIntensity(0.05);
  }

  function stop() {
    started = false;
    STEMS.forEach((n) => { try { stemSrc[n] && stemSrc[n].stop(); } catch (e) {} });
    stemSrc = {};
    if (fallbackEl) fallbackEl.pause();
  }

  // ===== 位置 =====
  // 位相は常に AudioContext の時刻から出す。<audio> の currentTime は
  // 環境によって進まない/粗いことがあり、グリッドの基準にすると破綻するため。
  function elapsed() {
    if (!ctx || !started) return 0;
    return Math.max(0, ctx.currentTime - startTime);
  }
  function beatPhase() { const p = (elapsed() / T().spb) % 1; return p < 0 ? p + 1 : p; }
  function barPhase() { const p = (elapsed() / T().bar) % 1; return p < 0 ? p + 1 : p; }
  function barNow() { return Math.floor(elapsed() / T().bar) % BARS; }
  // 背景演出用に 32小節を 5 場面へ割り当てる
  function section() {
    const b = barNow();
    if (b < 8) return 0;
    if (b < 16) return 1;
    if (b < 24) return 2;
    if (b < 28) return 3;
    return 4;
  }
  function now() { return ctx ? ctx.currentTime : 0; }

  // ===== レイヤー（音楽の厚み）=====
  // README の推奨どおり小節境界で 0.2-0.4秒かけてクロスフェードする。
  function nextBarTime() {
    if (!ctx || !started) return ctx ? ctx.currentTime : 0;
    const n = Math.ceil((ctx.currentTime - startTime) / T().bar);
    return startTime + n * T().bar;
  }
  function applyIntensity(fade) {
    if (usingFallback || !started || !ctx) return;
    const at = fade !== undefined ? ctx.currentTime : nextBarTime();
    const ramp = fade !== undefined ? fade : 0.3;
    STEMS.forEach((n) => {
      const g = stemGain[n];
      if (!g) return;
      const on = STEM_TIER[n] <= (intensity >= 3 ? 2 : intensity >= 2 ? 1 : 0);
      g.gain.cancelScheduledValues(at);
      g.gain.setValueAtTime(g.gain.value, at);
      g.gain.linearRampToValueAtTime(on ? 1 : 0, at + ramp);
    });
  }
  function setIntensity(v) {
    const nv = Math.max(0, Math.min(3, v));
    if (nv === intensity) return;
    intensity = nv;
    applyIntensity();
  }

  // ===== 16分グリッドへのクオンタイズ（スウィング込み）=====
  function grid(lead = 0.012) {
    if (!ctx) return 0;
    if (!started) return ctx.currentTime + 0.001;
    const n = Math.ceil((ctx.currentTime + lead - startTime) / T().step);
    return startTime + n * T().step + (n % 2 === 1 ? T().swing : 0);
  }
  // 同じ16分に同じ音が重なるのを防ぐ
  function slotOK(key, t) {
    const k = Math.round((t - startTime) / T().step);
    if (lastSlot.get(key) === k) return false;
    lastSlot.set(key, k);
    return true;
  }

  // ===== 操作音 =====
  function playSfx(name, o = {}) {
    if (!ctx || !sfxBufs[name]) return;
    const t = o.at !== undefined ? o.at : grid();
    if (o.key && !slotOK(o.key, t)) return;
    const s = ctx.createBufferSource();
    s.buffer = sfxBufs[name];
    // 曲の主音に合わせて移調する。半音単位なので再生レートで足りる
    // （最大でも ±4半音なので、音色の崩れより調が合う利点のほうが大きい）。
    const semis = o.semis !== undefined ? o.semis : (T().semis || 0);
    if (semis) s.playbackRate.value = Math.pow(2, semis / 12);
    const g = ctx.createGain();
    g.gain.value = o.gain !== undefined ? o.gain : 1;
    s.connect(g);
    let node = g;
    if (o.pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      g.connect(p); node = p;
    }
    node.connect(sfxBus);
    s.start(t);
  }

  // --- ゲームからの呼び出し（音名は README の対応表どおり）---
  // 打点主体の音に作り直したぶん RMS が下がっているので、
  // 旧素材と同じ体感音量になるところまで音量を上げてある。
  function playMove(dir) {
    playSfx(dir < 0 ? "move_left" : "move_right", { key: "mv", gain: 1.15, pan: dir < 0 ? -0.4 : 0.4 });
  }
  function playRotate(dir = 1) {
    playSfx(dir >= 0 ? "rotate_cw" : "rotate_ccw", { key: "rot", gain: 1.05, pan: dir >= 0 ? 0.25 : -0.25 });
  }
  function playDrop() { playSfx("hard_drop", { key: "drop", gain: 1.05 }); }
  function playLock(col) {
    playSfx("lock", { key: "lock", gain: 0.92, pan: ((col || 0) / 16) * 1.2 - 0.6 });
  }
  // 消去は同時消し数が多いほど厚い和音になる clear_1..4 を使う
  function playClear(index, row, pan = 0) {
    const n = Math.min(4, (index | 0) + 1);
    playSfx("clear_" + n, { key: "clr" + n, gain: 0.85, pan });
  }
  function playSquare() { playSfx("clear_1", { key: "sq", gain: 0.6 }); }
  // 連鎖はペンタトニックを1段ずつ上行する。13連鎖以上は最上段を繰り返す。
  function playCombo(level) {
    const n = Math.max(1, Math.min(12, level | 0));
    playSfx("combo_" + String(n).padStart(2, "0"), { gain: 0.9 });
  }
  function playBurst() { playSfx("stage_clear", { gain: 1 }); }
  function playBurstReady() { playSfx("level_up", { gain: 0.9 }); }
  function playLevelUp() { playSfx("level_up", { gain: 1 }); }
  function playGrand() { playSfx("clear_4", { gain: 1 }); }
  function playSlow() { playSfx("stage_clear", { gain: 0.8 }); }
  function playSlowEnd() { playSfx("combo_01", { gain: 0.7 }); }
  function playGameOver() { playSfx("game_over", { at: ctx ? ctx.currentTime : 0, gain: 1 }); }
  function playInvalid() { playSfx("invalid", { key: "inv", gain: 0.7 }); }

  // ===== ミュート =====
  function toggleMute() {
    if (!ctx) return muted;
    muted = !muted;
    master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.02);
    if (fallbackEl) fallbackEl.muted = muted;
    return muted;
  }
  function isMuted() { return muted; }

  // ===== 曲の切り替え =====
  // 曲が変わるとテンポが変わり、タイムラインの掃引時間と落下速度も一緒に変わる
  // （game.js 側は「拍」で持っているので、BPM が変われば自動で追従する）。
  // 切り替えは今の曲を素早くフェードアウトしてから新しい曲を頭から始める。
  // 小節の途中で切っても、次の曲は自分の頭から始まるのでグリッドは崩れない。
  let switching = false;
  async function setTrack(i, fade = 0.6) {
    const n = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
    if (n === trackIdx || switching || !ctx) return false;
    switching = true;
    try {
      const next = TRACKS[n];
      let bufs = null;
      if (!usingFallback) {
        try { bufs = await loadStems(next); }
        catch (e) { switching = false; return false; }   // 読めなければ今の曲を続ける
      }
      const t0 = ctx.currentTime;
      if (started && !usingFallback) {
        STEMS.forEach((k) => {
          const g = stemGain[k];
          if (!g) return;
          g.gain.cancelScheduledValues(t0);
          g.gain.setValueAtTime(g.gain.value, t0);
          g.gain.linearRampToValueAtTime(0, t0 + fade);
        });
        const old = stemSrc;
        setTimeout(() => {
          STEMS.forEach((k) => { try { old[k] && old[k].stop(); } catch (e) {} });
        }, (fade + 0.1) * 1000);
      }
      trackIdx = n;
      if (bufs) stemBufs = bufs;
      if (started) {
        if (usingFallback) {
          if (fallbackEl) {
            fallbackEl.pause();
            fallbackEl.src = next.base + next.loop + ".m4a";
            fallbackEl.play().catch(() => {});
          }
          startTime = ctx.currentTime;
        } else {
          startTime = t0 + fade;
          stemGain = {}; stemSrc = {};
          startStems(startTime);
          applyIntensity(0.4);
        }
      }
      return true;
    } finally {
      switching = false;
    }
  }

  return {
    start, stop, preload, beatPhase, barPhase, section, now,
    setIntensity, setTrack, prefetchTrack,
    playClear, playLock, playSquare, playCombo, playBurst, playGameOver,
    playRotate, playMove, playDrop, playBurstReady, playLevelUp, playGrand,
    playSlow, playSlowEnd, playInvalid,
    toggleMute, isMuted,
    bars: BARS,
    // テンポ系はすべて「いまの曲」の値を返す。game.js はこれを見て
    // 掃引と落下の速さを決めるので、曲が変わればゲームの速さも変わる。
    get bpm() { return T().bpm; },
    get secondsPerBeat() { return T().spb; },
    get loopSeconds() { return T().loopSec; },
    get sweepSeconds() { return T().sweepSec; },
    get trackIndex() { return trackIdx; },
    get track() { const t = T(); return { id: t.id, title: t.title, genre: t.genre, bpm: t.bpm, sweepSec: t.sweepSec }; },
    get trackList() { return TRACKS.map((t) => ({ id: t.id, title: t.title, genre: t.genre, bpm: t.bpm, semis: t.semis, sweepSec: t.sweepSec })); },
    get usingFallback() { return usingFallback; },
    get stemSource() { return stemSource; },
    get stemFrames() { const b = stemBufs["01_drums"]; return b ? b.length : 0; },
    get loaded() { return ready; },
  };
})();
