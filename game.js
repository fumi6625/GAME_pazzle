/*
 * LUMINA ARISE — ルミナス風パズル（演出・音楽・BURST 搭載）v2
 * HTML + Canvas + Web Audio（ビルド不要）
 *
 * ゲームの流れ:
 *  - 2色の 2x2 ブロックが落下（←→移動 / Space 回転 / ↑ 即落下 / ↓ ソフトドロップ）
 *  - 同色が 2x2 の正方形になると「消去待ち」フラグ
 *  - タイムライン（音楽に同期して左→右）が通過した列でフラグ付きセルを消去
 *  - 連続スイープで消し続けると COMBO 倍率アップ、大量消しで BONUS
 *  - 消去でたまる BURST ゲージ満タン時に Enter → 大量消去の必殺演出
 *  - コンボ・盤面の高さに応じて BGM のレイヤーが増減（ダイナミックミュージック）
 */

// ===== 定数 =====
const COLS = 16;
const ROWS = 10;
const CELL = 40;
// 盤面の上に確保する「待機エリア」の行数。
// 参考動画（スクリーン録画）のとおり、落ちる前のコマは盤面の枠外で待つ。
// ここが無いと待機中のコマが見えず、待つ意味が無くなる。
const PAD_ROWS = 2;   // キャンバスは 640 x 480（待機2行 + 盤面10行）

const EMPTY = 0;
const COLOR_A = 1;
const COLOR_B = 2;

// 背景のネオン（シアン/マゼンタ）と同じ色域に揃える
const COLORS = {
  [COLOR_A]: { deep: "#03202f", base: "#0c6d97", light: "#5ce4ff", core: "#e2fbff", glow: "#5ce4ff" },
  [COLOR_B]: { deep: "#2b0620", base: "#a01463", light: "#ff5cc8", core: "#ffe0f4", glow: "#ff5cc8" },
};

// 落下速度は ms 固定ではなく「拍」で持つ。
// 参考動画（ルミネス リマスター）のタイムラインは 16列 = 3.94秒 = ちょうど2小節で、
// 盤面の進行が完全に曲に乗っている。落下も同じ考え方で拍に紐づけておくと、
// 曲の BPM が変わっても「音楽的な落ち方」が崩れない。


// ===== 出現してから落ち始めるまでの待ち =====
// ルミネスは新しいコマが出ても、しばらくその場に留まってから落ち始める。
// レベルが上がっても縮まない固定時間にしてあるので、盤面がどれだけ速くなっても
// 「置き場所を考える間」だけは必ず残る。ソフトドロップ/即落下で打ち切れる。

// ===== 落ちる前の待機 =====
// 無操作のプレイ録画（ルミネス リマスター / PC版・33秒・1018x732）の実測。
// 盤面は左213 上238 セル37.3px の 16x10。コマの上端を1/60秒ごとに追った:
//   ・タイムラインの1周 = 3.588 秒（掃引位置の直線当てはめ。10秒窓で安定）
//   ・コマは盤面の枠外（上に2行ぶん）で待ってから落ち始める
//   ・2個目のコマ: 枠外に出てから落ち始めるまで 3.52 秒 ≒ 掃引ちょうど1周
// 待機は掃引と同じ拍数で持つので、曲のテンポが変われば一緒に変わる。
const HOLD_BEATS = 8.0;         // 掃引1周 = 2小節 = 8拍
const HOLD_MIN_BEATS = 3.0;     // レベルで縮む下限
const HOLD_LEVEL_STEP = 0.955;  // レベルごとに待機が縮む（難度の主軸）

// ===== 解放後の自然落下 =====
// 同じ録画の、プレイヤーが何も操作していない最初の2コマを1行ずつ計測:
//   1個目 行4→行8 が 2.750 秒 → 687.5 ms/行
//   2個目 行0→行2 が 1.370 秒 → 685.0 ms/行
// つまり自然落下は 1行あたり約 0.69 秒。96BPM の1拍(625ms)にほぼ一致するので
// 「1拍で1行」として拍に紐づける。曲が変わっても落下が音と揃う。
// （以前は 42ms/行 → 150ms/行 としていたが、あれはプレイヤーが
//   ソフトドロップ／即落下を混ぜている区間を拾ってしまっていた）
const GRAVITY_BEATS = 1.0;       // 1行落ちるのにかかる拍数（4分音符 = 1拍）
const GRAVITY_MIN_BEATS = 0.25;  // レベルで縮む下限（16分音符）
const GRAVITY_LEVEL_STEP = 0.94;
const SOFT_DROP_INTERVAL = 45;   // ms/行: ソフトドロップ中は一気に速くする

// ===== 接地してから固定されるまでの猶予（ロックディレイ）=====
// テトリスと同じく、着地しても少しのあいだは動かせる。動かすか回すたびに
// 猶予が리セットされるので、回し続けて固定を先延ばしにできる。
// ただし無限に粘れると別のゲームになってしまうので、回数に上限を置く
// （テトリスのガイドラインと同じ 15 回）。より下の段へ落ちたら上限は戻る。
const LOCK_DELAY = 520;         // ms: 接地してから固定されるまで
const LOCK_RESET_MAX = 15;      // 猶予をリセットできる回数
const BURST_MAX = 72;           // 消したセル数でゲージ満タン（条件を厳しく）

// ===== レベル =====
const LEVEL_BASE = 2000;        // Lv2 到達に必要な点
const LEVEL_STEP = 1600;        // 1レベル上がるごとの必要点の増分
const LEVEL_MULT = 0.2;         // レベルごとの得点係数の増加（Lv1=x1.0, Lv5=x1.8）
const LEVEL_SPEEDUP = 0.955;    // レベルごとの落下間隔（ほんの少しだけ速く）
const MAX_LEVEL = 30;

// ===== チェインブロック =====
// 参考動画「How to Play」より:
//   「チェインブロックを使って、同じ色のブロックを繋げて消そう。」
//   落ちてくる4マスのうち1マスに印が付き、2x2 が成立して消える時に、
//   そのマスと地続きになっている同色マスをまとめて消す。
//   動画では印のマスを中心に、消去待ちの表示が外へ波状に広がっていく。
// 出現率は「20コマに1回くらい」。あくまでチャンス役なので、
// 頻繁に来ると盤面を組む楽しさが薄れる。
const CHAIN_CHANCE = 0.05;      // 新しいコマにチェインブロックが混じる確率
const CHAIN_WAVE = 0.045;       // 波が1マス進むのにかかる秒数
const CHAIN_BONUS = 4;          // チェインで消したセル1個あたりの追加点

// ===== 豪華コマ（3x3 以上の同色正方形） =====
const BIG_MIN = 3;
const BURST_ROWS = 4;           // BURST-A が薙ぎ払う最下段からの行数
const SLOW_DURATION = 14;       // BURST-B: タイムラインが遅くなる秒数
const SLOW_FACTOR = 0.34;       // その間のタイムライン速度
const BIG_BONUS = 0.6;          // セル単価の倍率 = 1 + (n-2) * BIG_BONUS

// ===== ランキング =====
const RANK_KEY = "lumina.arise.ranking.v1";
const RANK_MAX = 10;

// ===== 状態 =====
let board, marked;
// 消去のあと上のコマが落ちてくる見た目のためのオフセット（単位: マス）。
// 論理座標はすでに落ちた後の位置で、描画だけを fallAnim ぶん上にずらして戻す。
let fallAnim, fallVel;
let chain;                      // そのマスがチェインブロックか
let chainWave;                  // チェイン発動時の波の到達距離（マス）。表示用
let chainWaveT = 0;             // 波の経過時間（秒）
let chainCells = 0;             // 直近のチェインで巻き込んだセル数
let bigSize, bigTop;            // 豪華コマ: 各セルが属する正方形の辺長 / 左上セルの辺長
let current;
// 先読みキュー。先頭が次、その次が次の次。2手先まで見えると組み立てを計画できる。
const NEXT_VIEW = 2;
let nextQueue = [];
let score, squaresCleared, combo, maxCombo;
let level, nextLevelAt, levelFlash;
let bestBig;                    // このプレイで作った最大の豪華コマ
let burstGauge, burstReady;
let slowTimer = 0;              // BURST-B の残り秒数
let gameOver, paused, running, softDrop;
let startTimeMs, elapsedMs;
let dangerLevel = 0;            // 0..1 盤面の危険度（赤ビネット）

let timelineCol;
let timelineBeat;

let gravityTimer, lastTime;
let holdTimer = 0;              // 出現してから落ち始めるまでの残り(ms)
let lockTimer = 0;              // 接地してから経った時間(ms)
let lockResets = 0;             // 猶予をリセットした回数
let lockLowest = -99;           // このコマが到達した最も下の段

// ===== Canvas =====
const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const bgCanvas = document.getElementById("bg");
const bgCtx = bgCanvas.getContext("2d");
const nextCanvas = document.getElementById("next");
const nextCtx = nextCanvas.getContext("2d");

// HUD
const scoreEl = document.getElementById("score");
const squaresEl = document.getElementById("squares");
const timeEl = document.getElementById("time");
const comboEl = document.getElementById("combo");
const burstFillEl = document.getElementById("burst-fill");
const burstReadyEl = document.getElementById("burst-ready");
const startOverlay = document.getElementById("start");
const overOverlay = document.getElementById("over");
const overScoreEl = document.getElementById("over-score");
const levelEl = document.getElementById("level");
const levelFillEl = document.getElementById("level-fill");
const levelMultEl = document.getElementById("level-mult");
const overRankEl = document.getElementById("over-rank");
const startRankEl = document.getElementById("start-rank");
const overRankNoteEl = document.getElementById("over-rank-note");
const levelNextEl = document.getElementById("level-next");
const slowLeftEl = document.getElementById("slow-left");
const trackNameEl = document.getElementById("track-name");

// ===== ユーティリティ =====
// 盤面の格子。0..ROWS-1 が枠の中（見えている盤面）で、
// -PAD_ROWS..-1 は枠の上の待機エリア。参考動画のルミネス リマスターでも、
// あふれたブロックは枠の外へ積み上がり、そこが埋まった時点でゲームオーバーになる。
// 負の添字は配列の length に入らないので、既存の
// for (y = 0; y < ROWS; y++) は今までどおり枠の中だけを回る。
function makeGrid(fill) {
  const g = Array.from({ length: ROWS }, () => Array(COLS).fill(fill));
  for (let y = -PAD_ROWS; y < 0; y++) g[y] = Array(COLS).fill(fill);
  return g;
}
function randomCells() {
  const rnd = () => (Math.random() < 0.5 ? COLOR_A : COLOR_B);
  const cells = [[rnd(), rnd()], [rnd(), rnd()]];
  // 4マスのうち1マスだけを、たまにチェインブロックにする
  cells.chain = null;
  if (Math.random() < CHAIN_CHANCE) {
    cells.chain = [Math.random() < 0.5 ? 0 : 1, Math.random() < 0.5 ? 0 : 1];
  }
  return cells;
}
// 盤面座標 → キャンバス座標。待機エリアの高さぶん下にずれる。
function cellCenter(x, y) {
  return { cx: x * CELL + CELL / 2, cy: (y + PAD_ROWS) * CELL + CELL / 2 };
}
const padY = () => PAD_ROWS * CELL;
function colPan(x) { return (x / (COLS - 1)) * 1.6 - 0.8; }

// ===== レベル =====
// 得点が閾値を越えるたびに1段階ずつ上がる。上がるほど得点係数が伸び、
// 落下間隔がわずかに縮んで難度が上がる。
function levelNeed(l) { return LEVEL_BASE + (l - 1) * LEVEL_STEP; }
function levelMult() { return 1 + (level - 1) * LEVEL_MULT; }
// 曲が止まっている間も破綻しないよう、secondsPerBeat が取れないときは
// 96BPM 相当にフォールバックする。
function spbNow() {
  return (typeof GameAudio !== "undefined" && GameAudio.secondsPerBeat) || 60 / 96;
}
// 枠外で待てる時間。レベルが上がるほど短くなり、これが難度の主軸になる。
function holdBeats() {
  return Math.max(HOLD_MIN_BEATS, HOLD_BEATS * Math.pow(HOLD_LEVEL_STEP, level - 1));
}
function holdMs() { return holdBeats() * spbNow() * 1000; }
// 解放後の落下間隔。実測どおり「16分音符で1行」を基準にし、レベルで少しずつ
// 詰める。ソフトドロップ中だけは一定の速さで一気に落とす。
function gravityBeats() {
  return Math.max(GRAVITY_MIN_BEATS,
                  GRAVITY_BEATS * Math.pow(GRAVITY_LEVEL_STEP, level - 1));
}
function gravityInterval() {
  if (softDrop || padSoftDrop || touchSoftDrop) return SOFT_DROP_INTERVAL;
  return gravityBeats() * spbNow() * 1000;
}
function checkLevelUp() {
  let rose = false;
  while (level < MAX_LEVEL && score >= nextLevelAt) {
    level++;
    nextLevelAt += levelNeed(level);
    rose = true;
  }
  if (rose) {
    levelFlash = 1;
    Effects.banner("LEVEL " + level, "#7fffd4",
      "SCORE x" + levelMult().toFixed(1) + "  /  SPEED UP");
    Effects.screenFlash(0.6);
    Effects.screenShake(9);
    for (let i = 0; i < 4; i++)
      Effects.ring(canvas.width / 2, canvas.height / 2, "#7fffd4", canvas.width * (0.35 + i * 0.24));
    // 背景の世界そのものを切り替える（色相がずれ、飛行速度が上がる）
    Effects.setLevel(level);
    Effects.levelUpSurge();
    if (levelEl) {
      levelEl.classList.remove("up");
      void levelEl.offsetWidth;     // アニメーションを再生し直す
      levelEl.classList.add("up");
    }
    GameAudio.playLevelUp(level);
    padRumble(0.5, 0.6, 260);
    maybeChangeTrack();
  }
}

// ===== 曲の切り替え =====
// レベルが5上がるごとに次の曲へ。曲ごとに BPM が違うので、
// タイムラインの掃引時間も落下速度も一緒に変わる（どちらも拍で持っているため）。
const TRACK_EVERY_LEVELS = 5;
function trackIndexForLevel(l) {
  const n = (GameAudio.trackList || []).length || 1;
  return Math.floor((l - 1) / TRACK_EVERY_LEVELS) % n;
}
function renderTrackName() {
  if (!trackNameEl || !GameAudio.track) return;
  const t = GameAudio.track;
  trackNameEl.innerHTML = "";
  trackNameEl.appendChild(document.createTextNode(t.title));
  const sm = document.createElement("small");
  sm.textContent = `${t.genre} / ${t.bpm} BPM / ライン ${t.sweepSec.toFixed(2)}秒`;
  trackNameEl.appendChild(sm);
}

function maybeChangeTrack() {
  if (!GameAudio.setTrack) return;
  // 次の曲を先読みしておく（切り替えの瞬間に取りに行くと間に合わない）
  if (GameAudio.prefetchTrack) GameAudio.prefetchTrack(trackIndexForLevel(level) + 1);
  const want = trackIndexForLevel(level);
  if (want === GameAudio.trackIndex) return;
  Promise.resolve(GameAudio.setTrack(want)).then((ok) => {
    if (!ok) return;
    const t = GameAudio.track;
    Effects.banner("♪ " + t.title, "#ffe27a",
      t.genre + "  /  " + t.bpm + " BPM  /  ライン " + t.sweepSec.toFixed(2) + "秒");
    renderTrackName();
    updateHud();
  });
}

// ===== 豪華コマの検出 =====
// 同色の正方形のうち 3x3 以上のものを、大きい順に重ならないよう選び出す。
// 選ばれた領域は1個の大きな宝石として描画され、消去時の単価も上がる。
function findBigBlocks() {
  bigSize = makeGrid(0);
  bigTop = makeGrid(0);

  // dp[y][x] = (y,x) を右下とする同色正方形の最大辺長
  const dp = makeGrid(0);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const v = board[y][x];
      if (v === EMPTY) continue;
      if (y === 0 || x === 0) { dp[y][x] = 1; continue; }
      dp[y][x] = (board[y - 1][x] === v && board[y][x - 1] === v && board[y - 1][x - 1] === v)
        ? Math.min(dp[y - 1][x], dp[y][x - 1], dp[y - 1][x - 1]) + 1
        : 1;
    }
  }

  const cands = [];
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (dp[y][x] >= BIG_MIN) cands.push({ n: dp[y][x], y, x });
  cands.sort((a, b) => b.n - a.n);

  for (const c of cands) {
    const n = c.n, y0 = c.y - n + 1, x0 = c.x - n + 1;
    let free = true;
    for (let y = y0; y <= c.y && free; y++)
      for (let x = x0; x <= c.x; x++) if (bigSize[y][x]) { free = false; break; }
    if (!free) continue;
    for (let y = y0; y <= c.y; y++)
      for (let x = x0; x <= c.x; x++) bigSize[y][x] = n;
    bigTop[y0][x0] = n;
    if (n > bestBig) {
      bestBig = n;
      const { cx, cy } = cellCenter(x0 + (n - 1) / 2, y0 + (n - 1) / 2);
      Effects.banner(n + "×" + n + " GRAND", "#ffe27a", "豪華コマ生成");
      Effects.screenFlash(0.3);
      GameAudio.playGrand(n);
      padRumble(0.45, 0.5, 200);
    }
  }
}

// ===== ランキング（localStorage に上位10件） =====
function loadRanking() {
  try {
    const r = JSON.parse(localStorage.getItem(RANK_KEY));
    return Array.isArray(r) ? r : [];
  } catch (e) { return []; }
}
function saveRanking(entry) {
  const r = loadRanking();
  r.push(entry);
  r.sort((a, b) => b.score - a.score);
  r.splice(RANK_MAX);
  try { localStorage.setItem(RANK_KEY, JSON.stringify(r)); } catch (e) { /* 保存不可でも続行 */ }
  return r;
}
// entry が今回の記録なら強調表示する
function renderRanking(el, list, mark) {
  if (!el) return;
  el.innerHTML = "";
  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "rank-empty";
    li.textContent = "記録なし — 最初の1件を刻もう";
    el.appendChild(li);
    return;
  }
  list.forEach((e, i) => {
    const li = document.createElement("li");
    li.className = "rank-row" + (mark && e.id === mark ? " is-me" : "") + (i === 0 ? " is-top" : "");
    const pos = document.createElement("span");
    pos.className = "rank-pos";
    pos.textContent = String(i + 1).padStart(2, "0");
    const sc = document.createElement("span");
    sc.className = "rank-score";
    sc.textContent = e.score.toLocaleString();
    const meta = document.createElement("span");
    meta.className = "rank-meta";
    meta.textContent = `Lv${e.level} · ${e.combo}COMBO` + (e.big >= BIG_MIN ? ` · ${e.big}×${e.big}` : "");
    li.append(pos, sc, meta);
    el.appendChild(li);
  });
}

// ===== ブロックスプライト（ガラス質の宝石ブロックを事前描画） =====
// ===== テーマ（見た目の切り替え） =====
// "arise"    … これまでの夜のメトロポリス。3Dシティ背景 + カット済みクリスタルのコマ
// "remaster" … 参考動画（ルミネス リマスター）寄せ。平面2Dスキン + フラットな角コマ
const THEME_KEY = "lumina.arise.theme.v1";
const THEMES = [
  { id: "arise", name: "ARISE", desc: "夜のメトロポリス／3D背景・宝石コマ" },
  { id: "remaster", name: "REMASTER", desc: "平面2Dスキン／フラットなコマ・帯タイムライン" },
];
let themeId = "arise";
function loadTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (THEMES.some((t) => t.id === v)) themeId = v;
  } catch (e) { /* localStorage が使えない環境では既定のまま */ }
}
function isRemaster() { return themeId === "remaster"; }
function applyTheme() {
  Effects.setTheme(themeId);
  document.body.setAttribute("data-theme", themeId);
  // コマの見た目が変わるのでスプライトのキャッシュを捨てる
  for (const k in spriteCache) delete spriteCache[k];
  for (const k in bigSpriteCache) delete bigSpriteCache[k];
  renderThemePicker();
  if (nextQueue.length) drawNext();
}
function setTheme(id) {
  if (!THEMES.some((t) => t.id === id) || id === themeId) return;
  themeId = id;
  try { localStorage.setItem(THEME_KEY, id); } catch (e) { /* 保存できなくても続行 */ }
  applyTheme();
}

// REMASTER のコマ色は背景スキンから取る（スキンが変わるとコマの色も変わる）
function skinPalette() {
  const s = Effects.skin();
  return { [COLOR_A]: s.a, [COLOR_B]: s.b, line: s.line, grid: s.grid, ink: s.ink };
}

const spriteCache = {};
function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// hex → [r,g,b] / 2色の線形補間
function hexRgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function mixHex(a, b, t) {
  const A = hexRgb(a), B = hexRgb(b);
  return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(A[2] + (B[2] - A[2]) * t)})`;
}

// 面取り八角形の頂点（中心へ scale 倍して内側テーブルにも使う）
function facetPoints(size, pad, chamfer, scale) {
  const p = pad, q = size - pad, c = chamfer, m = size / 2;
  const pts = [
    [p + c, p], [q - c, p], [q, p + c], [q, q - c],
    [q - c, q], [p + c, q], [p, q - c], [p, p + c],
  ];
  return pts.map(([x, y]) => [m + (x - m) * scale, m + (y - m) * scale]);
}
function polyPath(c, pts) {
  c.beginPath();
  pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
}

/*
 * REMASTER のコマ。参考動画のコマは立体ではなく「角の四角 + 細い縁 + 斜めの面分割」。
 * ベベルを付けず、色の差だけで2色を見分けさせるので、コマが小さくても潰れない。
 */
function flatSprite(color, size) {
  const sk = Effects.skin();
  const key = "f" + color + "_" + size + "_" + sk.id;
  if (spriteCache[key]) return spriteCache[key];
  const s = document.createElement("canvas");
  s.width = s.height = size;
  const c = s.getContext("2d");
  const base = color === COLOR_A ? sk.a : sk.b;
  const rgb = (v, a) => `rgba(${v[0]},${v[1]},${v[2]},${a})`;
  const shade = (t) => [
    Math.round(base[0] * t), Math.round(base[1] * t), Math.round(base[2] * t),
  ];
  const g = Math.max(1, Math.round(size * 0.055));   // セル間の目地

  // 本体
  c.fillStyle = rgb(shade(0.82), 1);
  c.fillRect(g, g, size - g * 2, size - g * 2);
  // 斜め分割: 左上の三角だけ明るくして、動画のコマの「斜めの面」を再現する
  c.fillStyle = rgb(base, 1);
  c.beginPath();
  c.moveTo(g, g); c.lineTo(size - g, g); c.lineTo(g, size - g); c.closePath();
  c.fill();
  // 内側の細いハイライトと外側の縁
  c.strokeStyle = rgb(shade(1.28), 0.55);
  c.lineWidth = Math.max(1, size * 0.05);
  c.strokeRect(g + c.lineWidth / 2, g + c.lineWidth / 2,
               size - g * 2 - c.lineWidth, size - g * 2 - c.lineWidth);
  c.strokeStyle = rgb(shade(0.4), 0.85);
  c.lineWidth = 1;
  c.strokeRect(g + 0.5, g + 0.5, size - g * 2 - 1, size - g * 2 - 1);

  spriteCache[key] = s;
  return s;
}

/*
 * カット済みクリスタルのブロック。
 * 面取り八角形の外周と内側テーブルの間に8枚のベベル面を張り、
 * 各面の向きと光源(左上)の内積で明暗を付けて立体を出す。
 */
function blockSprite(color, size) {
  if (isRemaster()) return flatSprite(color, size);
  const key = color + "_" + size;
  if (spriteCache[key]) return spriteCache[key];
  const s = document.createElement("canvas");
  s.width = s.height = size;
  const c = s.getContext("2d");
  const col = COLORS[color];
  const pad = Math.max(1.5, size * 0.045);
  const chamfer = size * 0.2;
  const m = size / 2;
  const LX = -0.6, LY = -0.8;              // 光源方向（左上）

  const outer = facetPoints(size, pad, chamfer, 1);
  const inner = facetPoints(size, pad, chamfer, 0.56);

  // --- ベベル面 8枚 ---
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    const quad = [outer[i], outer[j], inner[j], inner[i]];
    // 面の外向き方向 ≒ 外周エッジ中点の中心からの向き
    const mx = (outer[i][0] + outer[j][0]) / 2 - m;
    const my = (outer[i][1] + outer[j][1]) / 2 - m;
    const len = Math.hypot(mx, my) || 1;
    const lam = (mx / len) * LX + (my / len) * LY;   // -1..1
    const t = Math.pow(Math.max(0, lam * 0.5 + 0.5), 1.5);
    polyPath(c, quad);
    c.fillStyle = t > 0.62
      ? mixHex(col.light, col.core, (t - 0.62) / 0.38)
      : mixHex(col.deep, col.light, t / 0.62);
    c.fill();
  }

  // --- 内側テーブル（屈折感のある斜めグラデ） ---
  const tg = c.createLinearGradient(size * 0.2, size * 0.15, size * 0.85, size * 0.9);
  tg.addColorStop(0, col.light);
  tg.addColorStop(0.42, col.base);
  tg.addColorStop(0.72, mixHex(col.base, col.deep, 0.55));
  tg.addColorStop(1, mixHex(col.base, col.light, 0.35));
  polyPath(c, inner);
  c.fillStyle = tg;
  c.fill();

  // テーブルを斜めに割る稜線（カットの分割線）
  c.save();
  polyPath(c, inner); c.clip();
  c.strokeStyle = "rgba(255,255,255,0.16)";
  c.lineWidth = Math.max(0.6, size * 0.018);
  c.beginPath(); c.moveTo(pad, size * 0.72); c.lineTo(size * 0.72, pad); c.stroke();
  // 鋭いスペキュラの筋
  const sp = c.createLinearGradient(size * 0.18, size * 0.34, size * 0.52, size * 0.06);
  sp.addColorStop(0, "rgba(255,255,255,0)");
  sp.addColorStop(0.5, "rgba(255,255,255,0.55)");
  sp.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = sp;
  c.fillRect(0, 0, size, size);
  c.restore();

  // --- 発光（暗いシーンで自発光ガラスに見せる） ---
  c.save();
  c.globalCompositeOperation = "lighter";
  const gl = c.createRadialGradient(m, m, 0, m, m, size * 0.5);
  gl.addColorStop(0, col.glow + "38");
  gl.addColorStop(1, "rgba(0,0,0,0)");
  polyPath(c, outer); c.clip();
  c.fillStyle = gl;
  c.fillRect(0, 0, size, size);
  c.restore();

  // --- 稜線（面の境界を細く光らせる） ---
  c.strokeStyle = "rgba(255,255,255,0.10)";
  c.lineWidth = Math.max(0.5, size * 0.014);
  for (let i = 0; i < 8; i++) {
    c.beginPath();
    c.moveTo(outer[i][0], outer[i][1]);
    c.lineTo(inner[i][0], inner[i][1]);
    c.stroke();
  }

  // --- 外周: 左上は明るいリムライト、右下は接地の影 ---
  polyPath(c, outer);
  c.strokeStyle = "rgba(255,255,255,0.30)";
  c.lineWidth = Math.max(0.6, size * 0.02);
  c.stroke();
  c.save();
  polyPath(c, outer); c.clip();
  const rim = c.createLinearGradient(0, size, size, 0);
  rim.addColorStop(0, "rgba(0,0,0,0.42)");
  rim.addColorStop(0.45, "rgba(0,0,0,0)");
  c.fillStyle = rim;
  c.fillRect(0, 0, size, size);
  c.restore();

  spriteCache[key] = s;
  return s;
}

/*
 * REMASTER の豪華コマ。フラットな大きい1枚として描き、
 * 二重の縁と隅のブラケットだけで「格の違い」を示す（立体表現は使わない）。
 */
function flatBigSprite(color, n) {
  const sk = Effects.skin();
  const size = n * CELL;
  const s = document.createElement("canvas");
  s.width = s.height = size;
  const c = s.getContext("2d");
  const base = color === COLOR_A ? sk.a : sk.b;
  const rgb = (v, a) => `rgba(${v[0]},${v[1]},${v[2]},${a})`;
  const shade = (t) => [base[0] * t, base[1] * t, base[2] * t].map((v) => Math.round(Math.min(255, v)));
  const g = Math.max(2, Math.round(CELL * 0.055));

  c.fillStyle = rgb(shade(0.82), 1);
  c.fillRect(g, g, size - g * 2, size - g * 2);
  c.fillStyle = rgb(base, 1);
  c.beginPath();
  c.moveTo(g, g); c.lineTo(size - g, g); c.lineTo(g, size - g); c.closePath();
  c.fill();

  // 二重縁（タイムライン色に合わせた明色）
  c.strokeStyle = rgb(sk.line, 0.95);
  c.lineWidth = Math.max(2, size * 0.016);
  c.strokeRect(g + 2, g + 2, size - g * 2 - 4, size - g * 2 - 4);
  c.strokeStyle = rgb(shade(0.35), 0.9);
  c.lineWidth = 1;
  c.strokeRect(g + 6, g + 6, size - g * 2 - 12, size - g * 2 - 12);

  // 四隅のブラケット
  const L = size * 0.14;
  c.strokeStyle = rgb(sk.line, 0.85);
  c.lineWidth = Math.max(2, size * 0.014);
  for (const [sx, sy, dx, dy] of [
    [g + 6, g + 6, 1, 1], [size - g - 6, g + 6, -1, 1],
    [g + 6, size - g - 6, 1, -1], [size - g - 6, size - g - 6, -1, -1],
  ]) {
    c.beginPath();
    c.moveTo(sx, sy + dy * L); c.lineTo(sx, sy); c.lineTo(sx + dx * L, sy);
    c.stroke();
  }
  // 大きさの表示（3x3 / 4x4 が一目で分かるように）
  c.fillStyle = rgb(sk.line, 0.5);
  c.font = `600 ${Math.round(size * 0.16)}px "Rajdhani", system-ui, sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(n + "×" + n, size / 2, size / 2);
  return s;
}

/*
 * 豪華コマ（3x3 以上の同色正方形）を1個の大きな宝石として描く。
 * ベースは同じカット済みクリスタルを n セル分の大きさで描き、
 * その上に金の二重縁・四隅の飾り・中央のきらめきを重ねて「格の違い」を出す。
 */
const bigSpriteCache = {};
function bigBlockSprite(color, n) {
  const key = color + "_" + n + (isRemaster() ? "_r" + Effects.skin().id : "");
  if (bigSpriteCache[key]) return bigSpriteCache[key];
  if (isRemaster()) return (bigSpriteCache[key] = flatBigSprite(color, n));
  const size = n * CELL;
  const s = document.createElement("canvas");
  s.width = s.height = size;
  const c = s.getContext("2d");
  const col = COLORS[color];
  const m = size / 2;

  // --- ベース：大きなクリスタル ---
  c.drawImage(blockSprite(color, size), 0, 0);

  const pad = Math.max(1.5, size * 0.045);
  const chamfer = size * 0.2;
  const outer = facetPoints(size, pad, chamfer, 1);

  // --- 金の二重縁 ---
  const gold = "#ffd77a", goldDeep = "#a9772a";
  c.save();
  polyPath(c, outer);
  c.strokeStyle = gold;
  c.lineWidth = Math.max(2, size * 0.018);
  c.shadowColor = gold;
  c.shadowBlur = size * 0.06;
  c.stroke();
  c.shadowBlur = 0;
  polyPath(c, facetPoints(size, pad + size * 0.045, chamfer * 0.86, 1));
  c.strokeStyle = goldDeep;
  c.lineWidth = Math.max(1, size * 0.008);
  c.stroke();
  c.restore();

  // --- 四隅の飾り（L字のブラケット） ---
  const b = size * 0.16, off = size * 0.085;
  c.strokeStyle = gold;
  c.lineWidth = Math.max(1.5, size * 0.014);
  c.lineCap = "round";
  [[off, off, 1, 1], [size - off, off, -1, 1],
   [off, size - off, 1, -1], [size - off, size - off, -1, -1]]
    .forEach(([x, y, sx, sy]) => {
      c.beginPath();
      c.moveTo(x, y + sy * b);
      c.lineTo(x, y);
      c.lineTo(x + sx * b, y);
      c.stroke();
    });

  // --- 内側の同心リング（大きいほど輪が増える） ---
  c.save();
  c.globalCompositeOperation = "lighter";
  for (let i = 0; i < n - 1; i++) {
    c.beginPath();
    c.arc(m, m, size * (0.17 + i * 0.075), 0, Math.PI * 2);
    c.strokeStyle = `rgba(255,226,140,${0.24 - i * 0.05})`;
    c.lineWidth = Math.max(1, size * 0.006);
    c.stroke();
  }
  // --- 中央のきらめき（4条の光条） ---
  const rr = size * 0.30;
  const star = c.createRadialGradient(m, m, 0, m, m, rr);
  star.addColorStop(0, "rgba(255,255,255,0.85)");
  star.addColorStop(0.35, "rgba(255,232,170,0.30)");
  star.addColorStop(1, "rgba(255,220,140,0)");
  c.fillStyle = star;
  c.beginPath(); c.arc(m, m, rr, 0, Math.PI * 2); c.fill();
  c.strokeStyle = "rgba(255,255,255,0.7)";
  c.lineWidth = Math.max(1, size * 0.01);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    c.beginPath();
    c.moveTo(m - Math.cos(a) * rr * 1.15, m - Math.sin(a) * rr * 1.15);
    c.lineTo(m + Math.cos(a) * rr * 1.15, m + Math.sin(a) * rr * 1.15);
    c.stroke();
  }
  // 全体の底上げ発光
  const gl = c.createRadialGradient(m, m, 0, m, m, size * 0.55);
  gl.addColorStop(0, col.glow + "30");
  gl.addColorStop(1, "rgba(0,0,0,0)");
  polyPath(c, outer); c.save(); c.clip();
  c.fillStyle = gl; c.fillRect(0, 0, size, size);
  c.restore();
  c.restore();

  bigSpriteCache[key] = s;
  return s;
}

// ===== 初期化 =====
function init() {
  board = makeGrid(EMPTY);
  marked = makeGrid(false);
  fallAnim = makeGrid(0);
  fallVel = makeGrid(0);
  chain = makeGrid(false);
  chainWave = makeGrid(-1);
  chainWaveT = 0;
  bigSize = makeGrid(0);
  bigTop = makeGrid(0);
  score = 0;
  squaresCleared = 0;
  combo = 0;
  maxCombo = 0;
  level = 1;
  nextLevelAt = levelNeed(1);
  levelFlash = 0;
  bestBig = 0;
  burstGauge = 0;
  burstReady = false;
  slowTimer = 0;
  gameOver = false;
  paused = false;
  softDrop = false;
  timelineCol = -1;
  timelineBeat = 0;
  sweepCleared = 0;
  gravityTimer = 0;
  elapsedMs = 0;
  dangerLevel = 0;
  startTimeMs = performance.now();
  nextQueue = [];
  while (nextQueue.length < NEXT_VIEW) nextQueue.push(randomCells());
  Effects.reset();
  Effects.setBurstReady(false);
  Effects.setLevel(1);
  GameAudio.setIntensity(1);
  if (GameAudio.setTrack) Promise.resolve(GameAudio.setTrack(0, 0.25)).then(renderTrackName);
  renderTrackName();
  spawnPiece();
  updateHud();
  overOverlay.classList.add("hidden");
}

// ===== ピース生成 =====
function spawnPiece() {
  const startX = Math.floor(COLS / 2) - 1;
  // 盤面の枠外（待機エリア）に出す。参考動画のとおり、
  // 落ちる前のコマは盤面の外で待ち、そこで置き場所を決める。
  current = { x: startX, y: -PAD_ROWS, cells: nextQueue.shift() };
  lockTimer = 0; lockResets = 0; lockLowest = -99;
  holdTimer = holdMs();
  while (nextQueue.length < NEXT_VIEW) nextQueue.push(randomCells());
  drawNext();
  // 待機エリアまで埋まって、新しいコマを置く場所が無くなったら終了。
  // 参考動画でも、枠の上に2行ぶん積み上がったところでゲームオーバーになる。
  if (collides(startX, -PAD_ROWS, current.cells)) endGame();
}

// ===== 衝突判定 =====
function collides(x, y, cells) {
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const bx = x + c, by = y + r;
      if (bx < 0 || bx >= COLS) return true;
      if (by >= ROWS) return true;
      if (by >= -PAD_ROWS && board[by][bx] !== EMPTY) return true;
    }
  }
  return false;
}

// ===== 操作 =====
// 接地中に動かす/回すと固定までの猶予が戻る。上限に達したらもう戻らない。
function touchLockDelay() {
  if (!current) return;
  if (!collides(current.x, current.y + 1, current.cells)) return;   // 浮いている
  if (lockResets >= LOCK_RESET_MAX) return;
  lockResets++;
  lockTimer = 0;
}

function move(dx) {
  if (!current || gameOver || paused) return;
  if (!collides(current.x + dx, current.y, current.cells)) {
    current.x += dx;
    GameAudio.playMove(dx);
    touchLockDelay();
    if (tutorialMode) tutSeen.moved = true;
  }
}
// dir: 1 = 右回転(時計回り) / -1 = 左回転(反時計回り)
function rotate(dir = 1) {
  if (!current || gameOver || paused) return;
  const c = current.cells;
  const rotated = dir >= 0
    ? [[c[1][0], c[0][0]], [c[1][1], c[0][1]]]
    : [[c[0][1], c[1][1]], [c[0][0], c[1][0]]];
  // チェインブロックの位置も一緒に回す。回すと印が消えてしまうのを防ぐ。
  //   右回り: (r,c) → (c, 1-r)   左回り: (r,c) → (1-c, r)
  if (c.chain) {
    const [r0, c0] = c.chain;
    rotated.chain = dir >= 0 ? [c0, 1 - r0] : [1 - c0, r0];
  } else {
    rotated.chain = null;
  }
  if (!collides(current.x, current.y, rotated)) {
    current.cells = rotated;
    GameAudio.playRotate(dir);
    touchLockDelay();
    if (tutorialMode) tutSeen.rotated = true;
    // 回転は「音を回す」動作: ピース中心にリングを出す（方向で色を変える）
    const { cx, cy } = cellCenter(current.x + 0.5, Math.max(0, current.y) + 0.5);
    Effects.ring(cx, cy, dir >= 0 ? "rgba(150,230,255,1)" : "rgba(255,190,120,1)", CELL * 1.6);
  }
}
function hardDrop() {
  if (!current || gameOver || paused) return;
  const from = current.y;
  while (!collides(current.x, current.y + 1, current.cells)) current.y++;
  lockTimer = 0; holdTimer = 0;
  if (current.y > from) {
    GameAudio.playDrop();
    // 落下の軌跡（残像トレイル）
    const { cx } = cellCenter(current.x + 0.5, 0);
    Effects.column(cx, CELL * 2, (current.y + 2 + PAD_ROWS) * CELL, "rgba(200,240,255,ALPHA)");
  }
  lockPiece();
}
function stepDown() {
  if (collides(current.x, current.y + 1, current.cells)) return false;
  current.y++;
  // より下の段へ進めたら、猶予のリセット回数を戻す。
  // これがないと、下へ落ちながらでも回した回数が累積して早々に固定されてしまう。
  if (current.y > lockLowest) { lockLowest = current.y; lockResets = 0; }
  lockTimer = 0;
  return true;
}

// ===== 固定 =====
function lockPiece() {
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const bx = current.x + c, by = current.y + r;
      // 枠の外（待機エリア）にも積める。次のコマが置けなくなった時点で
      // spawnPiece() がゲームオーバーにする。
      board[by][bx] = current.cells[r][c];
      const ch = current.cells.chain;
      chain[by][bx] = !!(ch && ch[0] === r && ch[1] === c);
    }
  }
  GameAudio.playLock(current.x);
  padRumble(0, 0.22, 55);
  // 着地の小さな煙
  const { cx, cy } = cellCenter(current.x + 0.5, current.y + 1.5);
  Effects.burst(cx, cy + CELL * 0.4, "rgba(180,200,255,0.8)", 5, 0.4);
  current = null;
  settleColumns();
  const had = markMatches();
  if (had) GameAudio.playSquare();
  updateIntensity();
  spawnPiece();
}

// ===== 重力（全列詰め） =====
function settleColumns() {
  for (let x = 0; x < COLS; x++) {
    let write = ROWS - 1;
    // 枠の外に積み上がったぶんも一緒に落とす
    for (let y = ROWS - 1; y >= -PAD_ROWS; y--) {
      if (board[y][x] !== EMPTY) {
        board[write][x] = board[y][x];
        chain[write][x] = chain[y][x];
        chainWave[write][x] = chainWave[y][x];
        fallAnim[write][x] = (write - y) + fallAnim[y][x];
        fallVel[write][x] = fallVel[y][x];
        if (write !== y) {
          board[y][x] = EMPTY;
          chain[y][x] = false; chainWave[y][x] = -1;
          fallAnim[y][x] = 0; fallVel[y][x] = 0;
        }
        write--;
      }
    }
    for (let y = write; y >= -PAD_ROWS; y--) {
      board[y][x] = EMPTY;
      chain[y][x] = false; chainWave[y][x] = -1;
      fallAnim[y][x] = 0; fallVel[y][x] = 0;
    }
  }
}

// 落下オフセットを重力で 0 へ戻す。1マスで約0.24秒、4マスで約0.49秒。
// タイムラインが1列進むのが 0.31秒なので、それと同じ時間感覚に合わせてある。
const FALL_G = 34;       // マス/秒^2
const FALL_VMAX = 20;    // マス/秒
function updateFall(dt) {
  for (let y = -PAD_ROWS; y < ROWS; y++) {
    const fa = fallAnim[y], fv = fallVel[y];
    for (let x = 0; x < COLS; x++) {
      if (fa[x] <= 0) continue;
      fv[x] = Math.min(FALL_VMAX, fv[x] + FALL_G * dt);
      fa[x] -= fv[x] * dt;
      if (fa[x] <= 0) { fa[x] = 0; fv[x] = 0; }
    }
  }
}

// ===== 2x2マッチ検出（フラグ付け）。新規マッチがあれば true =====
function markMatches() {
  const prev = marked;
  marked = makeGrid(false);
  let any = false, newOne = false;
  for (let y = 0; y < ROWS - 1; y++) {
    for (let x = 0; x < COLS - 1; x++) {
      const v = board[y][x];
      if (v !== EMPTY &&
          board[y][x + 1] === v &&
          board[y + 1][x] === v &&
          board[y + 1][x + 1] === v) {
        marked[y][x] = marked[y][x + 1] = true;
        marked[y + 1][x] = marked[y + 1][x + 1] = true;
        any = true;
        if (!prev[y][x]) newOne = true;
      }
    }
  }
  // --- チェインブロックの発動 ---
  // 2x2 が成立して消える対象になったチェインブロックから、
  // 地続きの同色マスを幅優先で辿って全部消去対象にする。
  // 参考動画と同じく、印のマスからの距離を持たせて外へ波打つように見せる。
  const fired = chainFlood();
  if (fired > 0) {
    chainCells += fired;
    chainWaveT = 0;
    any = true; newOne = true;
    Effects.banner("CHAIN " + fired, "#8affd8", "つながった同色をまとめて消去");
    Effects.screenFlash(0.18);
    GameAudio.playGrand();
    padRumble(0.35, 0.5, 200);
    // 印のマスから外へリングを飛ばして、波の起点を見せる
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++)
        if (chain[y][x] && chainWave[y][x] === 0) {
          const { cx, cy } = cellCenter(x, y);
          Effects.ring(cx, cy, "rgba(140,255,216,1)", CELL * 5);
          Effects.burst(cx, cy, "rgba(140,255,216,1)", 14, 1.2);
        }
  }

  findBigBlocks();
  return any && newOne;
}

// 消去対象になったチェインブロックから同色を塗り広げる。巻き込んだ数を返す。
function chainFlood() {
  const seeds = [];
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (chain[y][x] && marked[y][x] && board[y][x] !== EMPTY) seeds.push([x, y]);
  if (!seeds.length) return 0;

  chainWave = makeGrid(-1);
  let added = 0;
  for (const [sx, sy] of seeds) {
    const color = board[sy][sx];
    // 幅優先。dist は印のマスからの手数で、これが波の到達順になる。
    let frontier = [[sx, sy]];
    if (chainWave[sy][sx] < 0) chainWave[sy][sx] = 0;
    let dist = 0;
    while (frontier.length) {
      const next = [];
      for (const [x, y] of frontier) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
          if (board[ny][nx] !== color) continue;
          if (chainWave[ny][nx] >= 0) continue;
          chainWave[ny][nx] = dist + 1;
          if (!marked[ny][nx]) { marked[ny][nx] = true; added++; }
          next.push([nx, ny]);
        }
      }
      frontier = next;
      dist++;
    }
  }
  return added;
}

// 1列だけを下へ詰める（マークも一緒に移動）
function settleColumn(x) {
  let write = ROWS - 1;
  // 枠の外に積み上がったぶんも一緒に落とす
  for (let y = ROWS - 1; y >= -PAD_ROWS; y--) {
    if (board[y][x] !== EMPTY) {
      board[write][x] = board[y][x];
      marked[write][x] = marked[y][x];
      bigSize[write][x] = bigSize[y][x];
      chain[write][x] = chain[y][x];
      chainWave[write][x] = chainWave[y][x];
      // 落ちた距離を描画オフセットに足す（落下中にさらに落ちても破綻しない）
      fallAnim[write][x] = (write - y) + fallAnim[y][x];
      fallVel[write][x] = fallVel[y][x];
      if (write !== y) {
        board[y][x] = EMPTY; marked[y][x] = false; bigSize[y][x] = 0;
        chain[y][x] = false; chainWave[y][x] = -1;
        fallAnim[y][x] = 0; fallVel[y][x] = 0;
      }
      write--;
    }
  }
  for (let y = write; y >= -PAD_ROWS; y--) {
    board[y][x] = EMPTY; marked[y][x] = false; bigSize[y][x] = 0;
    chain[y][x] = false; chainWave[y][x] = -1;
    fallAnim[y][x] = 0; fallVel[y][x] = 0;
  }
}

// ===== タイムライン進行（音楽同期・本家準拠） =====
// 1列 = 8分音符。マークは「通過するまで」保持され、通過列だけ消去・落下する。
// スコア/COMBO は 1スイープ単位で確定させる。
let sweepCleared = 0;
let sweepBase = 0;      // このスイープの基礎点（豪華コマの単価上昇を含む）

function advanceTimeline() {
  timelineCol++;

  // スイープ完了 → 集計と再マッチ。
  // ここで -1（盤面外）に戻して1ステップ使ってしまうと、1周が 17ステップになり
  // 16列ぶんの時間より 1列ぶん長くなる。折り返しは 0 列目に直結させて、
  // 「16列ちょうどで1周 = 5.000秒」を保つ。
  if (timelineCol >= COLS) {
    timelineCol = 0;
    resolveSweep();
    settleColumns();
    markMatches();
  }

  const c = timelineCol;
  const cleared = [];
  for (let y = 0; y < ROWS; y++) {
    if (marked[y][c] && board[y][c] !== EMPTY) {
      cleared.push({ y, color: board[y][c], big: bigSize[y][c] });
      board[y][c] = EMPTY;
    }
  }
  for (let y = 0; y < ROWS; y++) { marked[y][c] = false; bigSize[y][c] = 0; }

  if (cleared.length > 0) {
    sweepCleared += cleared.length;

    // このスイープに適用される倍率（resolveSweep と一致させる）
    const pendingMult = multOf(combo);
    let colBase = 0;
    let colBig = 0;
    for (const cell of cleared) {
      const bm = cell.big >= BIG_MIN ? 1 + (cell.big - 2) * BIG_BONUS : 1;
      colBase += 10 * bm;
      if (cell.big > colBig) colBig = cell.big;
    }
    sweepBase += colBase;

    // 加点をその場に飛ばす（爽快感の核）
    const colPts = Math.round(colBase * pendingMult * levelMult());
    const mid = cleared[Math.floor(cleared.length / 2)];
    const cc = cellCenter(c, mid.y);
    const popScale = 0.6 + Math.min(0.7, combo * 0.12) + (colBig >= BIG_MIN ? 0.25 : 0);
    Effects.scorePop(cc.cx, cc.cy, "+" + colPts,
      colBig >= BIG_MIN ? "#ffe27a" : COLORS[mid.color].glow, popScale);
    // 演出: 破片 + グロー粒 + リング + 光柱、音は列位置パン付きベル
    const pan = colPan(c);
    cleared.forEach((cell, i) => {
      const { cx, cy } = cellCenter(c, cell.y);
      const col = COLORS[cell.color];
      Effects.shatter(cx, cy, col.light, 6, 1);
      Effects.burst(cx, cy, col.glow, 8, 0.9);
      Effects.ring(cx, cy, col.glow, CELL * 1.5);
      GameAudio.playClear(i, cell.y, pan);
    });
    Effects.column(c * CELL + CELL / 2, CELL, (ROWS + PAD_ROWS) * CELL,
      "rgba(190,225,255,ALPHA)");
    Effects.screenFlash(0.1 + Math.min(0.3, sweepCleared * 0.025));
    padRumble(0.12 + Math.min(0.4, cleared.length * 0.07), 0.3, 70);

    // BURST ゲージ
    if (!burstReady) {
      burstGauge += cleared.length;
      if (burstGauge >= BURST_MAX) {
        burstGauge = BURST_MAX;
        burstReady = true;
        onBurstReady();
      }
    }

    settleColumn(c);
    // 列を消すと豪華コマは正方形として崩れる。盤面から取り直して整合を保つ。
    findBigBlocks();
    updateHud();
  }
}

// スイープ1回分のスコア・COMBO を確定
function resolveSweep() {
  if (sweepCleared > 0) {
    combo++;
    if (combo > maxCombo) maxCombo = combo;
    squaresCleared += sweepCleared / 4;

    const mult = multOf(combo - 1);   // combo++ 済みなので1つ戻して数える
    let pts = Math.round(sweepBase * mult * levelMult());
    if (sweepCleared >= 8) pts += 100;
    // チェインで巻き込んだぶんは、通常の単価に加えてボーナスを乗せる
    if (chainCells > 0) {
      pts += Math.round(chainCells * CHAIN_BONUS * mult * levelMult());
      Effects.banner("CHAIN BONUS +" + Math.round(chainCells * CHAIN_BONUS * mult * levelMult()),
                     "#8affd8");
      chainCells = 0;
    }
    score += pts;

    // 連鎖はバナーと音で伝える。画面全体を揺らすと目が疲れるので控える。
    if (combo >= 2) {
      comboPop = 1;                 // 盤面左下の COMBO 表示を一瞬大きくする
      Effects.screenFlash(0.10);
      GameAudio.playCombo(combo);
    }
    if (mult >= 4) {
      Effects.banner("BONUS x" + mult, "#7fffd4");
    }

    checkLevelUp();
  } else {
    combo = 0;
    chainCells = 0;
  }
  sweepCleared = 0;
  sweepBase = 0;
  updateIntensity();
  updateHud();
}

// ===== 音楽レイヤー制御（ゲーム状況 → BGMの厚み） =====
function stackHeight() {
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (board[y][x] !== EMPTY) return ROWS - y;
  return 0;
}
function updateIntensity() {
  const h = stackHeight();
  let lvl = 1;
  if (combo >= 2 || burstReady || h >= 5) lvl = 2;
  if (combo >= 4 || h >= 7) lvl = 3;
  GameAudio.setIntensity(lvl);
  dangerLevel = Math.max(0, Math.min(1, (h - 6) / 3));
}

// ===== BURST 準備完了（ゲージ満タンの瞬間に1回だけ） =====
function onBurstReady() {
  GameAudio.playBurstReady();
  Effects.setBurstReady(true);
  padRumble(0.6, 0.7, 300);

  // 見逃しようのないインパクト: 衝撃波・フラッシュ・文字
  const cx = canvas.width / 2, cy = canvas.height / 2;
  Effects.ring(cx, cy, "#ff5cf0", canvas.width * 0.9);
  Effects.ring(cx, cy, "#7fffd4", canvas.width * 0.65);
  Effects.burst(cx, cy, "#ff8cf5", 40, 2.2);
  Effects.screenFlash(0.55);
  Effects.screenShake(7);
  Effects.banner("BURST READY", "#ff5cf0", "PRESS ENTER / X · L2 · R2");
}

// ===== BURST-B: タイムライン減速（大きな正方形を組む時間を稼ぐ） =====
function triggerSlow() {
  if (!burstReady || gameOver || paused) return;
  if (tutorialMode) tutSeen.burstUsed = true;
  burstReady = false;
  burstGauge = 0;
  Effects.setBurstReady(false);
  slowTimer = SLOW_DURATION;

  Effects.banner("CHRONO", "#7fe9ff",
    "タイムライン減速 " + SLOW_DURATION + "秒  /  大きな正方形を組め");
  Effects.screenFlash(0.5);
  Effects.zone(0, padY(), COLS * CELL, ROWS * CELL, "rgba(120,230,255,0.22)");
  for (let i = 0; i < 4; i++)
    Effects.ring(canvas.width / 2, canvas.height / 2, "#7fe9ff", canvas.width * (0.3 + i * 0.22));
  GameAudio.playSlow();
  padRumble(0.35, 0.8, 500);
  updateHud();
}

// ===== BURST-A: 最下段を薙ぎ払う =====
function triggerBurst() {
  if (!burstReady || gameOver || paused) return;
  if (tutorialMode) tutSeen.burstUsed = true;
  burstReady = false;
  burstGauge = 0;
  Effects.setBurstReady(false);

  let cells = [];
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (marked[y][x] && board[y][x] !== EMPTY) cells.push({ x, y, color: board[y][x] });

  // 盤面下部の密集を薙ぎ払う（ピンチ脱出）
  for (let y = ROWS - 1; y >= ROWS - BURST_ROWS; y--) {
    for (let x = 0; x < COLS; x++) {
      if (board[y][x] !== EMPTY && !cells.find((c) => c.x === x && c.y === y)) {
        cells.push({ x, y, color: board[y][x] });
      }
    }
  }

  if (cells.length === 0) {
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++)
        if (board[y][x] !== EMPTY) cells.push({ x, y, color: board[y][x] });
  }

  // 薙ぎ払う領域を明示（何が起きたのか分かるように）
  Effects.zone(0, padY() + (ROWS - BURST_ROWS) * CELL, COLS * CELL, BURST_ROWS * CELL,
    "rgba(255,92,240,0.30)");

  let bigBonus = 0;
  cells.forEach((c) => {
    if (bigSize[c.y][c.x] >= BIG_MIN) bigBonus += (bigSize[c.y][c.x] - 2) * BIG_BONUS * 30;
    board[c.y][c.x] = EMPTY;
    marked[c.y][c.x] = false;
    bigSize[c.y][c.x] = 0;
    const { cx, cy } = cellCenter(c.x, c.y);
    const col = COLORS[c.color];
    Effects.shatter(cx, cy, col.light, 8, 1.8);
    Effects.burst(cx, cy, col.glow, 12, 1.6);
    Effects.ring(cx, cy, "#ffffff", CELL * 2);
  });

  const pts = Math.round((cells.length * 30 + bigBonus) * levelMult());
  score += pts;
  squaresCleared += cells.length / 4;

  Effects.screenFlash(0.9);
  Effects.screenShake(14);
  Effects.banner("BURST!", "#ff5cf0", cells.length + " BLOCKS  /  +" + pts);
  GameAudio.playBurst();
  padRumble(1, 0.9, 420);

  settleColumns();
  markMatches();
  checkLevelUp();
  updateIntensity();
  updateHud();
}

// ===== HUD =====
function updateHud() {
  scoreEl.textContent = score;
  squaresEl.textContent = Math.floor(squaresCleared);
  // HUD の COMBO も盤面のハイライトと同じ琥珀にして、両者が同じ状態を指すようにする
  comboEl.textContent = combo;
  comboEl.style.color = chaining() ? rgbaOf(HL_CHAIN, 1) : "";
  comboEl.style.textShadow = chaining() ? `0 0 10px ${rgbaOf(HL_CHAIN, 0.7)}` : "";
  const s = Math.floor(elapsedMs / 1000);
  timeEl.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  burstFillEl.style.width = (burstGauge / BURST_MAX * 100) + "%";
  burstFillEl.classList.toggle("ready", burstReady);
  burstReadyEl.classList.toggle("hidden", !burstReady);

  // レベル: 現在値・次レベルまでの進捗・得点係数・残り点
  if (levelEl) levelEl.textContent = level;
  if (levelMultEl) levelMultEl.textContent = "x" + levelMult().toFixed(1);
  const need = levelNeed(level);
  const remain = Math.max(0, nextLevelAt - score);
  const ratio = Math.max(0, Math.min(1, (need - remain) / need));
  if (levelFillEl) {
    levelFillEl.style.width = (ratio * 100).toFixed(1) + "%";
    levelFillEl.classList.toggle("near", ratio >= 0.85 && level < MAX_LEVEL);
  }
  if (levelNextEl) {
    levelNextEl.textContent = level >= MAX_LEVEL
      ? "MAX"
      : "NEXT " + remain.toLocaleString();
  }
  // CHRONO の残り時間
  if (slowLeftEl) {
    slowLeftEl.classList.toggle("hidden", slowTimer <= 0);
    if (slowTimer > 0) slowLeftEl.textContent = "CHRONO " + slowTimer.toFixed(1) + "s";
  }
}

// ===== ゲームオーバー =====
function endGame() {
  if (gameOver) return;
  // チュートリアル中は詰まっても終了させず、そのステップをやり直す
  if (tutorialMode) { tutGo(tutStep); return; }
  gameOver = true;
  current = null;
  GameAudio.playGameOver();
  GameAudio.setIntensity(0);
  padRumble(0.8, 0.4, 700);
  Effects.setBurstReady(false);
  Effects.screenShake(8);

  // ランキングへ登録し、今回の記録を強調表示する
  const id = "r" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  const entry = {
    id, score, level, combo: maxCombo,
    squares: Math.floor(squaresCleared), big: bestBig,
    date: new Date().toISOString().slice(0, 10),
  };
  const list = saveRanking(entry);
  const rank = list.findIndex((e) => e.id === id);
  renderRanking(overRankEl, list, id);
  renderRanking(startRankEl, list, null);

  overScoreEl.textContent =
    `SCORE ${score.toLocaleString()}  /  LV ${level}  /  MAX COMBO ${maxCombo}` +
    (bestBig >= BIG_MIN ? `  /  BEST ${bestBig}×${bestBig}` : "");
  if (overRankNoteEl) {
    overRankNoteEl.textContent = rank >= 0
      ? `${rank + 1} 位にランクイン`
      : `ランク外（${RANK_MAX}位 ${(list[list.length - 1] || {}).score || 0} 点）`;
    overRankNoteEl.classList.toggle("is-in", rank >= 0);
  }
  overOverlay.classList.remove("hidden");
}

// ===== 描画 =====
/*
 * 消去待ちハイライトの色は「連鎖中かどうか」の2状態だけ。
 * 連鎖していなければ白、連鎖中は琥珀。
 * 同じ琥珀をタイムラインにも使うので、「いま流れている線が、この光っている
 * コマを連鎖として消している」という対応が一目で分かる。
 * 連鎖数は HUD の COMBO と盤面下のバナーで読めるので、色は段階分けしない。
 */
const HL_IDLE = [255, 255, 255];    // 連鎖なし
const HL_CHAIN = [255, 206, 92];    // 連鎖中（琥珀）
const chaining = () => combo >= 1;
// 得点倍率。参考動画と同じく x1 → x2 → x4 → x8 → x16 で頭打ち。
// 引数は「このスイープに入る前の連鎖数」。いま流れている1周が消せば
// combo は 1 増えるので、実際に掛かる倍率は multOf(連鎖数) になる。
const multOf = (c) => Math.min(16, Math.pow(2, Math.max(0, c)));
const comboMult = () => multOf(combo);
let comboPop = 0;          // COMBO 表示の一瞬の拡大（0..1 で減衰）
const hlColor = () => (chaining() ? HL_CHAIN : HL_IDLE);
// 脈動はごく穏やかに（周期 620ms・振幅小）。目立たせるのは色の違いで足りる。
const hlPulse = () => 0.5 + 0.5 * Math.sin(performance.now() / 620);
const rgbaOf = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// チェインの波がそのマスに届いているか。届くまでは消去待ちの表示を出さない。
function markVisible(x, y) {
  const d = chainWave[y][x];
  if (d < 0) return true;                       // チェインとは無関係のマス
  return chainWaveT >= d * CHAIN_WAVE;
}

// チェインブロックの印。中央の菱形と四隅の点。回転させて「特別なマス」だと分かるようにする。
function drawChainMark(c, px, py, size, alpha = 1) {
  const m = size / 2, t = performance.now() / 1000;
  c.save();
  c.translate(px + m, py + m);
  c.rotate(t * 1.1);
  c.globalAlpha = alpha;
  c.shadowColor = "rgba(255,255,255,0.9)";
  c.shadowBlur = size * 0.18;
  c.fillStyle = "rgba(255,255,255,0.96)";
  const r = size * 0.17;
  c.beginPath();
  c.moveTo(0, -r); c.lineTo(r, 0); c.lineTo(0, r); c.lineTo(-r, 0);
  c.closePath(); c.fill();
  c.shadowBlur = 0;
  const q = size * 0.30;
  for (const [dx, dy] of [[q, 0], [-q, 0], [0, q], [0, -q]]) {
    c.beginPath(); c.arc(dx, dy, size * 0.065, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}

function drawCell(c, x, y, color, size, opts = {}) {
  c.drawImage(blockSprite(color, size), x * size, y * size);
  if (opts.chain) drawChainMark(c, x * size, y * size, size);
  if (opts.marked) {
    const col = hlColor();
    const pulse = hlPulse();
    const px = x * size, py = y * size;

    // 本体の増光（控えめ）
    c.save();
    c.globalCompositeOperation = "lighter";
    c.globalAlpha = 0.20 + pulse * 0.16;
    c.drawImage(blockSprite(color, size), px, py);
    c.restore();

    // 消去待ちの枠。色だけが連鎖の有無を示す。
    c.save();
    c.translate(px, py);
    if (isRemaster()) {
      // フラットなコマなので枠も角の四角にそろえる
      const g = Math.max(1, Math.round(size * 0.055));
      c.strokeStyle = rgbaOf(col, 0.7 + pulse * 0.3);
      c.lineWidth = 2;
      c.strokeRect(g + 1, g + 1, size - g * 2 - 2, size - g * 2 - 2);
    } else {
      polyPath(c, facetPoints(size, Math.max(1.5, size * 0.045) + 1, size * 0.2, 1));
      c.strokeStyle = rgbaOf(col, 0.6 + pulse * 0.3);
      c.lineWidth = 2;
      c.stroke();
    }
    c.restore();
  }
}

// 待機エリア（盤面の枠外）。ここに落ちる前のコマが浮いている。
function drawHoldArea() {
  const w = COLS * CELL, h = padY();
  const sk = isRemaster() ? Effects.skin() : null;
  ctx.save();
  // 盤面より暗くして「外側」だと分かるようにする
  ctx.fillStyle = sk
    ? `rgba(${sk.ink[0]},${sk.ink[1]},${sk.ink[2]},0.34)`
    : "rgba(6,8,18,0.30)";
  ctx.fillRect(0, 0, w, h);
  // 盤面との境界。ここを越えたら固定されるという線。
  const line = sk ? `rgba(${sk.line[0]},${sk.line[1]},${sk.line[2]},0.55)`
                  : "rgba(140,210,255,0.45)";
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 6]);
  ctx.beginPath(); ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function render() {
  const shk = Effects.getShake();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(shk.x, shk.y);

  // --- 待機エリア（盤面の枠外）---
  // ここに落ちる前のコマが浮いている。盤面とは明るさで区別し、
  // 下端に境界線を引いて「ここから下が盤面」と分かるようにする。
  drawHoldArea();

  // 以降は盤面座標のまま描く。待機エリアぶんだけ原点を下げておくので、
  // y = -2..-1 のコマ（＝待機中）は自然に枠外へ描かれる。
  ctx.save();
  ctx.translate(0, padY());

  if (isRemaster()) {
    // REMASTER: 盤面は「半透明の暗いパネル + セル全部を区切る細いグリッド」。
    // 参考動画と同じく、空きマスの位置が常に読めるようにする。
    const sk = Effects.skin();
    ctx.fillStyle = `rgba(${sk.ink[0]},${sk.ink[1]},${sk.ink[2]},0.62)`;
    ctx.fillRect(0, 0, COLS * CELL, ROWS * CELL);
    ctx.strokeStyle = `rgba(${sk.grid[0]},${sk.grid[1]},${sk.grid[2]},0.13)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < COLS; x++) { ctx.moveTo(x * CELL + 0.5, 0); ctx.lineTo(x * CELL + 0.5, ROWS * CELL); }
    for (let y = 1; y < ROWS; y++) { ctx.moveTo(0, y * CELL + 0.5); ctx.lineTo(COLS * CELL, y * CELL + 0.5); }
    ctx.stroke();
  } else {
    // 盤面のうっすら暗幕
    ctx.fillStyle = "rgba(8,10,26,0.42)";
    ctx.fillRect(0, 0, COLS * CELL, ROWS * CELL);

    // グリッド（微細ドット）
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    for (let x = 1; x < COLS; x++)
      for (let y = 1; y < ROWS; y++)
        ctx.fillRect(x * CELL - 1, y * CELL - 1, 2, 2);
  }

  // セル（豪華コマに含まれるものは個別に描かず、大きな1個として描く）
  // 枠の外にあふれたぶん（y < 0）も描く。ここが埋まると次のコマが出せない。
  for (let y = -PAD_ROWS; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (board[y][x] !== EMPTY && !bigSize[y][x])
        drawCell(ctx, x, y - fallAnim[y][x], board[y][x], CELL,
                 { marked: marked[y][x] && markVisible(x, y), chain: chain[y][x] });

  // 豪華コマ
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const n = bigTop[y][x];
      if (!n || board[y][x] === EMPTY) continue;
      const px = x * CELL, py = (y - fallAnim[y][x]) * CELL, sz = n * CELL;
      ctx.drawImage(bigBlockSprite(board[y][x], n), px, py);
      // 消去待ちの脈動（大きいほど強く光る）
      if (marked[y][x]) {
        const pulse = hlPulse();
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = (0.16 + pulse * 0.18) * (1 + (n - 3) * 0.15);
        ctx.drawImage(bigBlockSprite(board[y][x], n), px, py);
        ctx.restore();
        // 豪華コマの枠は元々金なので、連鎖中だけ同じ琥珀へ寄せる
        ctx.strokeStyle = rgbaOf(chaining() ? HL_CHAIN : [255, 232, 150], 0.6 + pulse * 0.3);
        ctx.lineWidth = 3;
        roundRectPath(ctx, px + 3, py + 3, sz - 6, sz - 6, sz * 0.1);
        ctx.stroke();
      }
    }
  }

  // 落下ガイド（REMASTER）: 参考動画では落下中のコマの2列が縦線で示される。
  // どの列に落ちるかが常に読めるので、盤面を目で追う量が減る。
  if (isRemaster() && current && running && !gameOver) {
    const sk = Effects.skin();
    const gx = current.x * CELL, gw = 2 * CELL;
    ctx.save();
    ctx.fillStyle = `rgba(${sk.grid[0]},${sk.grid[1]},${sk.grid[2]},0.07)`;
    ctx.fillRect(gx, 0, gw, ROWS * CELL);
    ctx.strokeStyle = `rgba(${sk.grid[0]},${sk.grid[1]},${sk.grid[2]},0.5)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(gx + 1, 0); ctx.lineTo(gx + 1, ROWS * CELL);
    ctx.moveTo(gx + gw - 1, 0); ctx.lineTo(gx + gw - 1, ROWS * CELL);
    ctx.stroke();
    ctx.restore();
  }

  // 落下ピース（着地予測のゴースト付き）
  if (current) {
    let gy = current.y;
    while (!collides(current.x, gy + 1, current.cells)) gy++;
    if (gy !== current.y) {
      ctx.save();
      ctx.globalAlpha = 0.18;
      for (let r = 0; r < 2; r++)
        for (let c = 0; c < 2; c++) {
          const by = gy + r;
          if (by >= 0) drawCell(ctx, current.x + c, by, current.cells[r][c], CELL);
        }
      ctx.restore();
    }
    // 待機の残り時間。コマの真下に横棒で出す（枠外にいるので盤面を邪魔しない）。
    if (holdTimer > 0) {
      const full = holdMs();
      const w = 2 * CELL * (holdTimer / full);
      const py = (current.y + 2) * CELL - 4;
      ctx.fillStyle = holdTimer / full < 0.25
        ? "rgba(255,150,90,0.95)" : "rgba(140,255,216,0.9)";
      ctx.fillRect(current.x * CELL, py, w, 4);
    }

    // 接地中は、固定までの残り時間が分かるように白く明滅させる。
    // 残りが少ないほど速く点滅するので「そろそろ固まる」が体で分かる。
    const lockT = lockTimer > 0 ? Math.min(1, lockTimer / LOCK_DELAY) : 0;
    const cm = current.cells.chain;
    // 待機中は y = -2..-1 にいる。原点を待機エリアぶん下げてあるので
    // そのまま描けば枠外に出る。-PAD_ROWS まで描かないと待機中のコマが消える。
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 2; c++) {
        const by = current.y + r;
        if (by >= -PAD_ROWS) drawCell(ctx, current.x + c, by, current.cells[r][c], CELL,
                                      { chain: !!(cm && cm[0] === r && cm[1] === c) });
      }
    if (lockT > 0) {
      const blink = 0.5 + 0.5 * Math.sin(performance.now() / (60 + (1 - lockT) * 150));
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.12 + lockT * 0.30 * blink;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(current.x * CELL, Math.max(0, current.y) * CELL,
                   2 * CELL, (current.y + 2 - Math.max(0, current.y)) * CELL);
      ctx.restore();
      // 猶予の残りを細いバーで示す（リセット上限に達したら赤に変える）
      const w = 2 * CELL * (1 - lockT);
      ctx.fillStyle = lockResets >= LOCK_RESET_MAX
        ? "rgba(255,90,90,0.9)" : "rgba(255,255,255,0.75)";
      ctx.fillRect(current.x * CELL, (current.y + 2) * CELL - 3, w, 3);
    }
  }

  // タイムライン（音楽同期 + 尾を引く光）
  if (running && !gameOver) {
    const frac = timelineBeat * 2 % 1;
    const colf = timelineCol + frac;
    if (colf >= 0 && colf < COLS && isRemaster()) {
      // REMASTER のタイムライン。参考動画の実測に合わせた構成:
      //   ・幅およそ1セルの暖色の「帯」（線ではない）
      //   ・帯の後方(左)へ伸びる減衰グラデーションの尾
      //   ・先端に細くはっきりした縦線
      //   ・盤面の上端に進行位置を示す三角マーカー
      const sk = Effects.skin();
      const tl = chaining() ? HL_CHAIN : sk.line;
      const tx = colf * CELL, H = ROWS * CELL;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const band = ctx.createLinearGradient(tx - CELL * 2.4, 0, tx + CELL * 0.5, 0);
      band.addColorStop(0.00, rgbaOf(tl, 0));
      band.addColorStop(0.55, rgbaOf(tl, 0.16));
      band.addColorStop(0.88, rgbaOf(tl, 0.42));
      band.addColorStop(1.00, rgbaOf(tl, 0.10));
      ctx.fillStyle = band;
      ctx.fillRect(tx - CELL * 2.4, 0, CELL * 2.9, H);
      // 先端のはっきりした縦線
      ctx.fillStyle = rgbaOf(tl, 0.95);
      ctx.fillRect(tx - 1.5, 0, 3, H);
      ctx.restore();
      // 上端の三角マーカー（加算ではなく実色で置いて位置を読みやすくする）
      ctx.fillStyle = rgbaOf(tl, 0.95);
      ctx.beginPath();
      ctx.moveTo(tx - 7, 0); ctx.lineTo(tx + 7, 0); ctx.lineTo(tx, 11);
      ctx.closePath(); ctx.fill();
    } else if (colf >= 0 && colf < COLS) {
      const tx = colf * CELL;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      // 尾（左側に減衰するグラデ）
      // 連鎖中はタイムラインも消去待ちのコマと同じ琥珀にする。
      // 「この線がこのコマを連鎖として消している」という対応を色で示す。
      const tl = chaining() ? HL_CHAIN : [120, 210, 255];
      const tail = ctx.createLinearGradient(tx - 90, 0, tx, 0);
      tail.addColorStop(0, rgbaOf(tl, 0));
      tail.addColorStop(1, rgbaOf(tl, 0.24));
      ctx.fillStyle = tail;
      ctx.fillRect(tx - 90, 0, 90, ROWS * CELL);
      // コアライン
      const core = ctx.createLinearGradient(tx - 5, 0, tx + 5, 0);
      core.addColorStop(0, rgbaOf(tl, 0));
      core.addColorStop(0.5, "rgba(250,250,250,0.95)");   // 芯は白のまま
      core.addColorStop(1, rgbaOf(tl, 0));
      ctx.fillStyle = core;
      ctx.fillRect(tx - 5, 0, 10, ROWS * CELL);
      // 先端の輝き
      ctx.fillStyle = rgbaOf(tl, 0.55);
      ctx.fillRect(tx - 1, 0, 2, ROWS * CELL);
      ctx.restore();
    }
  }

  // COMBO 表示（参考動画と同じく盤面の左下に大きく常時出す）。
  // 連鎖が続いている限り数字が伸びていくので、途切れさせたくない気持ちが働く。
  if (running && !gameOver && combo > 0) {
    const H = ROWS * CELL;
    const pop = 1 + comboPop * 0.35;
    // コマの上に重なっても読めるよう、下端に薄い暗幕を敷く
    const sh = ctx.createLinearGradient(0, H - 74, 0, H);
    sh.addColorStop(0, "rgba(0,0,0,0)");
    sh.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = sh;
    ctx.fillRect(0, H - 74, 300, 74);
    ctx.save();
    ctx.translate(14, H - 20);
    ctx.scale(pop, pop);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.shadowColor = rgbaOf(HL_CHAIN, 0.85);
    ctx.shadowBlur = 14;
    ctx.fillStyle = rgbaOf(HL_CHAIN, 0.96);
    ctx.font = '700 30px "Rajdhani", system-ui, sans-serif';
    const n = String(combo);
    ctx.fillText(n, 0, 0);
    const w = ctx.measureText(n).width;
    ctx.font = '600 15px "Rajdhani", system-ui, sans-serif';
    ctx.fillText("COMBO", w + 8, -1);
    // 次のスイープで適用される倍率
    ctx.shadowBlur = 8;
    ctx.font = '600 13px "Rajdhani", system-ui, sans-serif';
    ctx.fillStyle = rgbaOf(HL_CHAIN, 0.72);
    ctx.fillText("SCORE x" + comboMult(), 1, -30);
    ctx.restore();
  }

  ctx.restore();      // 盤面座標の終わり

  // パーティクル等（cellCenter がすでに待機エリアぶんを含むのでそのまま）
  Effects.drawForeground(ctx, canvas.width, canvas.height);

  // 危険時の赤ビネット
  if (dangerLevel > 0 && !gameOver) {
    const throb = 0.6 + 0.4 * Math.sin(performance.now() / 180);
    const g = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, canvas.height * 0.35,
      canvas.width / 2, canvas.height / 2, canvas.height * 0.75);
    g.addColorStop(0, "rgba(255,30,60,0)");
    g.addColorStop(1, `rgba(255,30,60,${0.22 * dangerLevel * throb})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // 一時停止
  if (paused && !gameOver && running) {
    ctx.fillStyle = "rgba(4,6,16,0.7)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#eaf2ff";
    ctx.font = "bold 30px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("PAUSE", canvas.width / 2, canvas.height / 2);
    ctx.textAlign = "left";
  }

  ctx.restore();
}

// NEXT は横並びで2手ぶん。次の次は一回り小さく描いて優先度の差を出す。
function drawNext() {
  const w = nextCanvas.width, h = nextCanvas.height;
  nextCtx.clearRect(0, 0, w, h);
  const s1 = Math.floor(h / 2);                 // 次
  const s2 = Math.floor(s1 * 0.66);             // 次の次
  const gap = Math.max(6, Math.round(w * 0.06));
  const total = s1 * 2 + gap + s2 * 2;
  let ox = Math.round((w - total) / 2);
  for (let i = 0; i < Math.min(NEXT_VIEW, nextQueue.length); i++) {
    const cells = nextQueue[i], sz = i === 0 ? s1 : s2;
    const oy = Math.round((h - sz * 2) / 2);
    nextCtx.globalAlpha = i === 0 ? 1 : 0.55;
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 2; c++) {
        nextCtx.drawImage(blockSprite(cells[r][c], sz), ox + c * sz, oy + r * sz);
        const cm = cells.chain;
        if (cm && cm[0] === r && cm[1] === c)
          drawChainMark(nextCtx, ox + c * sz, oy + r * sz, sz, i === 0 ? 1 : 0.6);
      }
    ox += sz * 2 + gap;
  }
  nextCtx.globalAlpha = 1;
}

// ===== 背景リサイズ =====
let boardRect = { x: 0, y: 0, w: 640, h: 400 };
// 背景キャンバスは縮小されているので、盤面矩形もその座標系へ写す
function scaledBoardRect() {
  return {
    x: boardRect.x * bgScale, y: boardRect.y * bgScale,
    w: boardRect.w * bgScale, h: boardRect.h * bgScale,
  };
}
function measureBoard() {
  const r = canvas.getBoundingClientRect();
  boardRect = { x: r.left, y: r.top, w: r.width, h: r.height };
}

// 盤面の裏に暗幕を敷き、その外側へ滑らかに繋ぐ
function dimBehindBoard(c) {
  const r = scaledBoardRect();
  if (!r.w) return;
  const pad = 26 * bgScale;
  c.save();
  // REMASTER の背景は平面で元々静かなので、暗幕は薄めにしてスキンの色を残す
  const a = isRemaster() ? 0.34 : 0.80;
  const g = c.createLinearGradient(0, r.y - pad, 0, r.y + r.h + pad);
  g.addColorStop(0, "rgba(3,5,12,0)");
  g.addColorStop(0.10, `rgba(3,5,12,${a})`);
  g.addColorStop(0.90, `rgba(3,5,12,${a})`);
  g.addColorStop(1, "rgba(3,5,12,0)");
  c.fillStyle = g;
  c.fillRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2);
  c.restore();
}

// 背景は塗り面積が支配的なので、低解像度で描いて CSS で引き伸ばす。
// 都市はもともと霞んだ絵なので、解像度を落としても見た目の劣化がほぼない。
// 画面が大きいほど強く縮小し、実際に塗る画素数を一定の予算内に収める。
const BG_PIXEL_BUDGET = 0.46e6;
let bgScale = 0.62;

function bgScaleFor(w, h) {
  return Math.max(0.42, Math.min(0.72, Math.sqrt(BG_PIXEL_BUDGET / Math.max(1, w * h))));
}

function resizeBg() {
  const sc = bgScaleFor(window.innerWidth, window.innerHeight);
  bgCanvas.width = Math.max(1, Math.round(window.innerWidth * sc));
  bgCanvas.height = Math.max(1, Math.round(window.innerHeight * sc));
  bgScale = bgCanvas.width / window.innerWidth;
  Effects.initBg(bgCanvas.width, bgCanvas.height);
  measureBoard();
}
window.addEventListener("resize", resizeBg);

// ===== ループ =====
let qAcc = 0, qFrames = 0, quality = 1;
function autoQuality(dt) {
  qAcc += dt; qFrames++;
  if (qAcc < 1) return;
  const fps = qFrames / qAcc;
  // 30fps を下回りそうなら描画量を落とし、余裕があれば戻す
  if (fps < 34 && quality > 0.45) quality = Math.max(0.45, quality - 0.14);
  else if (fps > 52 && quality < 1) quality = Math.min(1, quality + 0.08);
  Effects.setQuality(quality);
  qAcc = 0; qFrames = 0;
}

function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  autoQuality(dt);

  pollPad(dt * 1000);

  const beat = GameAudio.beatPhase();

  // 背景（常時・ビート連動）
  Effects.drawBackground(bgCtx, bgCanvas.width, bgCanvas.height, dt, beat,
    running && !gameOver ? 2 : 1);
  // 盤面の背後だけ都市を落とす（コマの可読性を最優先）
  dimBehindBoard(bgCtx);
  Effects.drawBanners(bgCtx, scaledBoardRect(), bgScale);

  if (running && !gameOver && !paused && !padCfgOpen) {
    elapsedMs = now - startTimeMs;

    // 重力
    // 枠外での待機。この間は落ちないが、移動と回転はできる。
    // 下入力で待たずに落とせる（自分のタイミングで置けるようにする）。
    if (current && holdTimer > 0) {
      if (softDrop || padSoftDrop || touchSoftDrop) holdTimer = 0;
      else holdTimer = Math.max(0, holdTimer - dt * 1000);
      if (holdTimer > 0) gravityTimer = 0;
      else GameAudio.playDrop();                 // 落ち始めた合図
    }

    // 重力と接地。接地している間は落とさず、猶予を数えて時間切れで固定する。
    if (current && holdTimer <= 0) {
      if (collides(current.x, current.y + 1, current.cells)) {
        gravityTimer = 0;
        lockTimer += dt * 1000;
        if (lockTimer >= LOCK_DELAY) { lockTimer = 0; lockPiece(); }
      } else {
        lockTimer = 0;
        gravityTimer += dt * 1000;
        const gi = gravityInterval();
        // 1フレームで複数行ぶん進むことがあるのでまとめて処理する
        while (gravityTimer >= gi && stepDown()) gravityTimer -= gi;
        if (gravityTimer >= gi) gravityTimer = 0;
      }
    }

    // タイムライン（音楽ビートで進行: 1列 = 8分音符）
    const beatsPerCol = 0.5;
    if (slowTimer > 0) {
      slowTimer = Math.max(0, slowTimer - dt);
      if (slowTimer === 0) {
        Effects.banner("CHRONO END", "#7fe9ff");
        GameAudio.playSlowEnd();
      }
    }
    // チュートリアルの「作る」ステップでは帯を止めて、じっくり組ませる
    if (!tutFrozen()) {
      timelineBeat += (dt / GameAudio.secondsPerBeat) * (slowTimer > 0 ? SLOW_FACTOR : 1);
      while (timelineBeat >= beatsPerCol) {
        timelineBeat -= beatsPerCol;
        advanceTimeline();
      }
    }

    tutUpdate(dt);

    if (Math.floor(now / 250) !== Math.floor((now - dt * 1000) / 250)) updateHud();
  }

  updateFall(dt);
  chainWaveT += dt;
  comboPop = Math.max(0, comboPop - dt * 3.2);
  Effects.update(dt);
  render();
  requestAnimationFrame(loop);
}

// ===== ゲーム開始 =====
function startGame() {
  GameAudio.start();
  startOverlay.classList.add("hidden");
  running = true;
  init();
}

// ===== ゲームパッド（Gamepad API / 標準マッピング） =====
// Xbox・PlayStation・汎用パッドの "standard" マッピングを前提にしつつ、
// 左スティックでも操作できるようにする。押しっぱなしの左右は DAS/ARR でリピート。
const PAD_DEADZONE = 0.45;
const PAD_UP_THRESHOLD = 0.75;  // スティック上は誤爆しやすいので深めに倒す必要あり
const PAD_DAS = 170;            // ms: リピート開始までの溜め
const PAD_ARR = 55;             // ms: リピート間隔

// 標準マッピングのボタン番号
//  0:A/×  1:B/○  2:X/□  3:Y/△  4:LB/L1  5:RB/R1  6:LT/L2  7:RT/R2
//  8:View/Share  9:Menu/Options  12:↑  13:↓  14:←  15:→
const PAD_MAP_DEFAULT = {
  rotateCW:  [0, 5],      // A/× · R1
  rotateCCW: [3, 4],      // Y/△ · L1
  hardDrop:  [1, 12],     // B/○ · 十字↑
  softDrop:  [13],        // 十字↓
  left:      [14],
  right:     [15],
  burst:     [2, 7],      // X/□ · R2 … 薙ぎ払い
  slow:      [6],         // L2 … 減速
  pause:     [9],
  restart:   [8],
};

// 設定画面に並べる順序と表示名
const PAD_ACTIONS = [
  { key: "left",      label: "移動（左）" },
  { key: "right",     label: "移動（右）" },
  { key: "rotateCW",  label: "右回転" },
  { key: "rotateCCW", label: "左回転" },
  { key: "hardDrop",  label: "即落下" },
  { key: "softDrop",  label: "ソフトドロップ" },
  { key: "burst",     label: "BURST A（薙ぎ払い）" },
  { key: "slow",      label: "BURST B（減速）" },
  { key: "pause",     label: "一時停止" },
  { key: "restart",   label: "リスタート" },
];

// 標準マッピングのボタン名（Xbox / PlayStation 併記）
const PAD_BTN_NAMES = [
  "A / ×", "B / ○", "X / □", "Y / △", "L1 / LB", "R1 / RB", "L2 / LT", "R2 / RT",
  "View / Share", "Menu / Options", "L3", "R3", "十字 ↑", "十字 ↓", "十字 ←", "十字 →", "Home",
];
const btnName = (i) => PAD_BTN_NAMES[i] || ("ボタン " + i);

// ユーザーが変更した割り当ては localStorage に保存する
const PADMAP_KEY = "lumina.arise.padmap.v1";
function defaultPadMap() {
  const m = {};
  for (const k in PAD_MAP_DEFAULT) m[k] = PAD_MAP_DEFAULT[k].slice();
  return m;
}
function loadPadMap() {
  try {
    const j = JSON.parse(localStorage.getItem(PADMAP_KEY));
    if (j && typeof j === "object") {
      const m = defaultPadMap();
      for (const k in m) {
        if (Array.isArray(j[k])) m[k] = j[k].filter((v) => Number.isInteger(v) && v >= 0 && v < 32);
      }
      return m;
    }
  } catch (e) { /* 壊れていたら既定に戻す */ }
  return defaultPadMap();
}
function savePadMap() {
  try { localStorage.setItem(PADMAP_KEY, JSON.stringify(padMap)); } catch (e) { /* 保存不可でも続行 */ }
}
let padMap = loadPadMap();

let padIndex = null;
let padPrev = {};
let padDir = 0, padDasTimer = 0, padArrAcc = 0;
let padSoftDrop = false;
const padStatusEl = document.getElementById("pad-status");

function padGet() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  if (padIndex !== null && pads[padIndex] && pads[padIndex].connected) return pads[padIndex];
  for (let i = 0; i < pads.length; i++) {
    if (pads[i] && pads[i].connected) { padIndex = i; return pads[i]; }
  }
  padIndex = null;
  return null;
}

function padDown(gp, action) {
  for (const b of padMap[action] || []) {
    const btn = gp.buttons[b];
    if (btn && (typeof btn === "object" ? btn.pressed : btn > 0.5)) return true;
  }
  const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
  if (action === "left" && ax < -PAD_DEADZONE) return true;
  if (action === "right" && ax > PAD_DEADZONE) return true;
  if (action === "softDrop" && ay > PAD_DEADZONE) return true;
  if (action === "hardDrop" && ay < -PAD_UP_THRESHOLD) return true;
  return false;
}

// 触覚フィードバック（対応パッドのみ）
function padRumble(strong, weak, ms) {
  const gp = padGet();
  if (!gp || !gp.vibrationActuator) return;
  try {
    gp.vibrationActuator.playEffect("dual-rumble", {
      duration: ms, startDelay: 0,
      strongMagnitude: strong, weakMagnitude: weak,
    });
  } catch (e) { /* 未対応でも通常プレイに影響なし */ }
}

function updatePadStatus(gp) {
  if (!padStatusEl) return;
  const on = !!gp;
  const label = on ? (gp.id || "CONNECTED").replace(/\s*\(.*\)\s*/g, "").slice(0, 20) : "未接続";
  if (padStatusEl.textContent !== label) padStatusEl.textContent = label;
  padStatusEl.classList.toggle("is-on", on);
}

// ===== ボタン割り当ての変更 =====
let padBindWait = null;        // 待機中のアクション名
let padCaptPrev = [];          // 取り込み用の前フレーム押下状態
let padCfgOpen = false;

// 押されたボタンを action に割り当てる。他のアクションと重複したら奪う。
function assignButton(action, index) {
  for (const k in padMap) {
    padMap[k] = padMap[k].filter((v) => v !== index);
    if (padMap[k].length === 0 && k !== action) {
      // 空になったアクションは既定へ戻して操作不能を防ぐ
      padMap[k] = PAD_MAP_DEFAULT[k].filter((v) => v !== index);
    }
  }
  padMap[action] = [index];
  savePadMap();
  renderPadCfg();
  renderControlHints();
}

function pollPad(dtMs) {
  const gp = padGet();
  updatePadStatus(gp);
  if (!gp) { padSoftDrop = false; return; }

  // --- 割り当て変更の待機中: 押されたボタンを取り込む ---
  if (padBindWait) {
    for (let i = 0; i < gp.buttons.length; i++) {
      const b = gp.buttons[i];
      const now = b && (typeof b === "object" ? b.pressed : b > 0.5);
      if (now && !padCaptPrev[i]) {
        const act = padBindWait;
        padBindWait = null;
        assignButton(act, i);
        break;
      }
    }
    for (let i = 0; i < gp.buttons.length; i++) {
      const b = gp.buttons[i];
      padCaptPrev[i] = !!(b && (typeof b === "object" ? b.pressed : b > 0.5));
    }
    for (const k in padMap) padPrev[k] = padDown(gp, k);
    padPrev._any = padCaptPrev.some(Boolean);
    return;
  }
  for (let i = 0; i < gp.buttons.length; i++) {
    const b = gp.buttons[i];
    padCaptPrev[i] = !!(b && (typeof b === "object" ? b.pressed : b > 0.5));
  }

  // 設定画面を開いている間はゲーム操作を受け付けない
  if (padCfgOpen) {
    for (const k in padMap) padPrev[k] = padDown(gp, k);
    padPrev._any = padCaptPrev.some(Boolean);
    padSoftDrop = false;
    return;
  }

  // 未開始／ゲームオーバー中はどのボタンでも開始・再挑戦
  if (!running || gameOver) {
    const any = gp.buttons.some((b) => b && (typeof b === "object" ? b.pressed : b > 0.5));
    const wasAny = padPrev._any;
    padPrev._any = any;
    for (const k in padMap) padPrev[k] = padDown(gp, k);  // 開始直後の誤爆を防ぐ
    if (any && !wasAny) {
      if (!running) startGame();
      else init();
    }
    return;
  }
  padPrev._any = gp.buttons.some((b) => b && (typeof b === "object" ? b.pressed : b > 0.5));

  const edge = (a) => {
    const now = padDown(gp, a);
    const fired = now && !padPrev[a];
    padPrev[a] = now;
    return fired;
  };

  if (edge("rotateCW")) rotate(1);
  if (edge("rotateCCW")) rotate(-1);
  if (edge("hardDrop")) hardDrop();
  if (edge("burst")) triggerBurst();
  if (edge("slow")) triggerSlow();
  if (edge("pause")) paused = !paused;
  if (edge("restart")) init();

  padSoftDrop = padDown(gp, "softDrop");
  padPrev.softDrop = padSoftDrop;

  // 左右: 押した瞬間に1マス → 溜めのあとリピート
  const l = padDown(gp, "left"), r = padDown(gp, "right");
  padPrev.left = l; padPrev.right = r;
  const dir = l && !r ? -1 : r && !l ? 1 : 0;
  if (dir !== padDir) {
    padDir = dir;
    padDasTimer = 0;
    padArrAcc = 0;
    if (dir && !paused) move(dir);
  } else if (dir && !paused) {
    padDasTimer += dtMs;
    if (padDasTimer >= PAD_DAS) {
      padArrAcc += dtMs;
      while (padArrAcc >= PAD_ARR) { move(dir); padArrAcc -= PAD_ARR; }
    }
  }
}

// ===== ボタン設定 UI =====
const padCfgOverlay = document.getElementById("padcfg");
const padCfgListEl = document.getElementById("cfg-list");
const padCfgHintEl = document.getElementById("cfg-hint");
const padCfgPadEl = document.getElementById("cfg-pad");

function bindingLabel(action) {
  const list = padMap[action] || [];
  if (!list.length) return "未割り当て";
  return list.map(btnName).join(" · ");
}

function renderPadCfg() {
  if (!padCfgListEl) return;
  padCfgListEl.innerHTML = "";
  for (const a of PAD_ACTIONS) {
    const li = document.createElement("li");
    li.className = "cfg-row" + (padBindWait === a.key ? " is-wait" : "");

    const name = document.createElement("span");
    name.className = "cfg-act";
    name.textContent = a.label;

    const bind = document.createElement("span");
    bind.className = "cfg-bind";
    bind.textContent = padBindWait === a.key ? "ボタンを押してください…" : bindingLabel(a.key);

    const btn = document.createElement("button");
    btn.className = "cfg-change";
    btn.textContent = padBindWait === a.key ? "キャンセル" : "変更";
    btn.addEventListener("click", () => {
      padBindWait = padBindWait === a.key ? null : a.key;
      renderPadCfg();
    });

    li.append(name, bind, btn);
    padCfgListEl.appendChild(li);
  }
  if (padCfgHintEl) {
    padCfgHintEl.textContent = padBindWait
      ? "割り当てたいボタンをコントローラーで押してください（Esc で取消）"
      : "「変更」を押してから、割り当てたいボタンを押してください";
  }
  if (padCfgPadEl) {
    const gp = padGet();
    padCfgPadEl.textContent = gp
      ? (gp.id || "接続中").replace(/\s*\(.*\)\s*/g, "")
      : "コントローラーが未接続です（接続すると設定できます）";
  }
}

// HUD の操作一覧をいまの割り当てで書き換える
function renderControlHints() {
  document.querySelectorAll("[data-pad-hint]").forEach((el) => {
    const act = el.getAttribute("data-pad-hint");
    el.textContent = act === "move"
      ? bindingLabel("left") + " / " + bindingLabel("right") + " / Lスティック"
      : bindingLabel(act);
  });
}

function openPadCfg() {
  padCfgOpen = true;
  padBindWait = null;
  if (padCfgOverlay) padCfgOverlay.classList.remove("hidden");
  renderPadCfg();
}
function closePadCfg() {
  padCfgOpen = false;
  padBindWait = null;
  if (padCfgOverlay) padCfgOverlay.classList.add("hidden");
}

window.addEventListener("gamepadconnected", (e) => {
  padIndex = e.gamepad.index;
  updatePadStatus(e.gamepad);
  renderPadCfg();
  padRumble(0.4, 0.2, 160);   // 接続の合図
});
window.addEventListener("gamepaddisconnected", () => {
  padIndex = null;
  padPrev = {};
  padSoftDrop = false;
  updatePadStatus(null);
  renderPadCfg();
});

// ===== タッチ操作 =====
// 盤面のジェスチャ:
//   左右ドラッグ … 指の移動量をセル幅で割って移動（追従するので狙った列に置きやすい）
//   タップ       … 右回転
//   上スワイプ   … 即落下 / 下スワイプ … ソフトドロップ
//   2本指タップ  … 左回転
// 加えて画面下のボタンでも同じ操作ができる（細かい位置合わせ用）。
const TAP_MS = 260;          // これより短く、動きが小さければタップ扱い
const TAP_SLOP = 18;         // タップと見なす移動量(px)
const SWIPE_Y = 42;          // 縦スワイプと見なす移動量(px)
// 1列動かすのに必要な指の移動量（セル幅の倍数）。
// 等倍だと指のわずかなブレで列が飛んでシビアすぎたので、2セル幅ぶん動かして1列とする。
const DRAG_CELLS_PER_COL = 2;

let touchId = null;
let tx0 = 0, ty0 = 0, tt0 = 0, tCarry = 0, tMoved = false, tTwo = false;
let touchSoftDrop = false;

function cellPx() {
  const r = canvas.getBoundingClientRect();
  return r.width / COLS;    // 表示上の1セル幅（盤面は縮小表示されることがある）
}
function dragStepPx() {
  return cellPx() * DRAG_CELLS_PER_COL;
}

// 左右移動はボタンで行うので、ジェスチャを受けるのは盤面だけにする
// （タップ＝回転 / 上下スワイプ＝落下。横ドラッグも補助として残してある）。
const gestureTargets = [canvas];

function onGestureDown(e) {
  if (e.pointerType !== "touch") return;
  if (!running || gameOver || padCfgOpen) return;
  if (touchId !== null) { tTwo = true; return; }   // 2本目 = 左回転の合図
  touchId = e.pointerId;
  tx0 = e.clientX; ty0 = e.clientY; tt0 = performance.now();
  tCarry = 0; tMoved = false; tTwo = false;
  e.preventDefault();
}

function onGestureMove(e) {
  if (e.pointerId !== touchId) return;
  const dx = e.clientX - tx0;
  const dy = e.clientY - ty0;
  if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) tMoved = true;
  // 横方向はセル単位で追従させる（指の移動量 2セル幅 = 1列）
  const w = dragStepPx();
  const want = Math.trunc((dx - tCarry) / w);
  if (want !== 0) {
    for (let i = 0; i < Math.abs(want); i++) move(Math.sign(want));
    tCarry += want * w;
  }
  e.preventDefault();
}

function endTouch(e) {
  if (e.pointerId !== touchId) return;
  const dt = performance.now() - tt0;
  const dy = e.clientY - ty0;
  const dx = e.clientX - tx0;
  if (tTwo) {
    rotate(-1);                                   // 2本指 = 左回転
  } else if (!tMoved && dt < TAP_MS) {
    rotate(1);                                    // タップ = 右回転
  } else if (dy < -SWIPE_Y && Math.abs(dy) > Math.abs(dx)) {
    hardDrop();                                   // 上スワイプ = 即落下
  } else if (dy > SWIPE_Y && Math.abs(dy) > Math.abs(dx)) {
    softDrop = true;                              // 下スワイプ = ひと押しぶん落とす
    setTimeout(() => { softDrop = false; }, 220);
  }
  touchId = null; tTwo = false;
  e.preventDefault();
}
gestureTargets.forEach((el) => {
  el.addEventListener("pointerdown", onGestureDown, { passive: false });
  el.addEventListener("pointermove", onGestureMove, { passive: false });
  el.addEventListener("pointerup", endTouch, { passive: false });
  el.addEventListener("pointercancel", (e) => {
    if (e.pointerId === touchId) { touchId = null; tTwo = false; }
  });
});

// ===== 画面下のタッチボタン =====
{
  let repeatTimer = null, repeatDelay = null;
  const fire = {
    rotateCW: () => rotate(1),
    rotateCCW: () => rotate(-1),
    hardDrop: () => hardDrop(),
    left: () => move(-1),
    right: () => move(1),
    burst: () => triggerBurst(),
    slow: () => triggerSlow(),
    pause: () => { if (!gameOver) paused = !paused; },
    mute: () => GameAudio.toggleMute(),
  };
  // 左右ボタンだけは押しっぱなしで連続移動する。
  // 値はゲームパッドの DAS/ARR と揃えてあるので、持ち替えても感覚が変わらない。
  const REPEAT = { left: true, right: true };
  const stopRepeat = () => {
    clearTimeout(repeatDelay); clearInterval(repeatTimer);
    repeatDelay = repeatTimer = null;
  };

  // ボタンは画面上端(.toptouch)・盤面下(#movepad)・下部(#touchpad)に分かれているので
  // document でまとめて受ける
  document.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest && e.target.closest(".tbtn, .mbtn");
    if (!btn) return;
    e.preventDefault();
    const act = btn.getAttribute("data-act");
    if (!running) { startGame(); return; }
    if (act === "softDrop") { touchSoftDrop = true; return; }
    if (!fire[act]) return;
    fire[act]();
    // 押しっぱなしのリピート（DAS で溜めてから ARR 間隔で繰り返す）
    if (REPEAT[act]) {
      stopRepeat();
      repeatDelay = setTimeout(() => {
        repeatTimer = setInterval(() => {
          if (!running || gameOver || paused) { stopRepeat(); return; }
          fire[act]();
        }, PAD_ARR);
      }, PAD_DAS);
    }
  }, { passive: false });

  const release = () => { stopRepeat(); touchSoftDrop = false; };
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
}

// ===== 入力 =====
document.addEventListener("keydown", (e) => {
  // 設定画面はゲームの状態に関係なく開閉できる
  if (e.key === "Escape") {
    if (padBindWait) { padBindWait = null; renderPadCfg(); }
    else if (padCfgOpen) closePadCfg();
    return;
  }
  if (e.key === "c" || e.key === "C") {
    if (padCfgOpen) closePadCfg(); else openPadCfg();
    e.preventDefault();
    return;
  }
  if (padCfgOpen) return;   // 設定中はゲーム操作を止める

  if (!running) {
    if (e.key === " " || e.key === "Enter") { startGame(); e.preventDefault(); }
    return;
  }
  switch (e.key) {
    case "ArrowLeft": move(-1); e.preventDefault(); break;
    case "ArrowRight": move(1); e.preventDefault(); break;
    case "ArrowUp": hardDrop(); e.preventDefault(); break;      // ↑ = 即座に落下
    case "ArrowDown": softDrop = true; e.preventDefault(); break;
    case " ": rotate(1); e.preventDefault(); break;             // Space = 右回転
    case "z": case "Z": rotate(-1); e.preventDefault(); break;  // Z = 左回転
    case "Enter": triggerBurst(); e.preventDefault(); break;    // BURST-A 薙ぎ払い
    case "Shift": triggerSlow(); e.preventDefault(); break;     // BURST-B 減速
    case "p": case "P": if (!gameOver) paused = !paused; break;
    case "r": case "R": init(); break;
    case "h": case "H": goHome(); break;
    case "m": case "M": GameAudio.toggleMute(); break;
  }
});
document.addEventListener("keyup", (e) => {
  if (e.key === "ArrowDown") softDrop = false;
});

// ホーム（スタート画面）へ戻る。デザイン選択とチュートリアルはここからしか
// 触れないので、ゲームオーバーからは必ず戻れるようにしておく。
function goHome() {
  tutorialMode = false;
  tutEl.classList.add("hidden");
  document.body.classList.remove("tut-on");
  running = false;
  gameOver = false;
  paused = false;
  current = null;
  board = makeGrid(EMPTY);
  marked = makeGrid(false);
  bigSize = makeGrid(0);
  bigTop = makeGrid(0);
  fallAnim = makeGrid(0);
  chain = makeGrid(false);
  chainWave = makeGrid(-1);
  timelineCol = -1;
  timelineBeat = 0;
  burstGauge = 0;
  burstReady = false;
  slowTimer = 0;
  Effects.reset();
  Effects.setBurstReady(false);
  GameAudio.setIntensity(1);
  overOverlay.classList.add("hidden");
  startOverlay.classList.remove("hidden");
  renderRanking(startRankEl, loadRanking(), null);
  updateHud();
}

document.getElementById("start-btn").addEventListener("click", () => startGame());
document.getElementById("retry-btn").addEventListener("click", () => init());
document.getElementById("home-btn").addEventListener("click", (e) => { e.stopPropagation(); goHome(); });

// ===== デザイン切り替えの UI =====
const themePickerEl = document.getElementById("theme-picker");
const themeDescEl = document.getElementById("theme-desc");
function renderThemePicker() {
  if (!themePickerEl) return;
  themePickerEl.innerHTML = "";
  for (const t of THEMES) {
    const b = document.createElement("button");
    b.className = "picker-btn" + (t.id === themeId ? " on" : "");
    b.textContent = t.name;
    b.addEventListener("click", (e) => { e.stopPropagation(); setTheme(t.id); });
    themePickerEl.appendChild(b);
  }
  const cur = THEMES.find((t) => t.id === themeId);
  if (themeDescEl && cur) themeDescEl.textContent = cur.desc;
}

loadTheme();
applyTheme();

// ===== テスト用フック（自動テストからの状態確認に使用。通常プレイに影響なし） =====
window.LUMINA = {
  get board() { return board; },
  get marked() { return marked; },
  get score() { return score; },
  get combo() { return combo; },
  get burstReady() { return burstReady; },
  get gameOver() { return gameOver; },
  get level() { return level; },
  get bestBig() { return bestBig; },
  get slowLeft() { return slowTimer; },
  get gravity() { return Math.round(gravityInterval()); },
  get mult() { return levelMult(); },
  bigTopList() {
    const out = [];
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++) if (bigTop[y][x]) out.push({ x, y, n: bigTop[y][x] });
    return out;
  },
  get paused() { return paused; },
  get maxCombo() { return maxCombo; },
  get lockTimer() { return lockTimer; },
  get holdTimer() { return holdTimer; },
  get holdFull() { return holdMs(); },
  get chain() { return chain; },
  get chainWave() { return chainWave; },
  pieceChain() { return current ? (current.cells.chain || null) : null; },
  setChain(x, y, on) { chain[y][x] = !!on; },
  markNow() { return markMatches(); },
  hardDropNow() { hardDrop(); },
  releaseHold() { holdTimer = 0; },
  get lockResets() { return lockResets; },
  lockConst() { return { delay: LOCK_DELAY, max: LOCK_RESET_MAX }; },
  gravityMs() { return gravityInterval(); },
  // 枠の外（待機エリア）に積み上がっているセル数を上の行から順に返す
  overflow() {
    const out = [];
    for (let y = -PAD_ROWS; y < 0; y++)
      out.push(board[y].filter((v) => v !== EMPTY).length);
    return out;
  },
  rollChain() { return !!randomCells().chain; },
  get gravityBeat() { return gravityBeats(); },
  stepDown() { return current ? stepDown() : false; },
  rotate(d) { rotate(d); },
  move(d) { move(d); },
  get quality() { return quality; },
  comboMult() { return comboMult(); },
  nextQueue() { return nextQueue.map((c) => c.map((r) => r.slice())); },
  fallMax() {
    let m = 0;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++)
      if (fallAnim[y][x] > m) m = fallAnim[y][x];
    return m;
  },
  get timelineCol() { return timelineCol; },
  get theme() { return themeId; },
  get tutStep() { return tutStep; },
  get holdBeats() { return holdBeats(); },
  get holdMs() { return holdMs(); },
  setTheme,
  startTutorial() { startTutorial(); },
  pieceX() { return current ? current.x : null; },
  pieceY() { return current ? current.y : null; },
  pieceCells() { return current ? current.cells : null; },
  addScore(v) { score += v; checkLevelUp(); updateHud(); },
  setCombo(v) { combo = v; updateHud(); },
  pause(v) { paused = !!v; },
  endNow() { endGame(); },
  setBoard(grid) {
    // makeGrid 経由にして、枠の外（負の行）も必ず用意する
    const g = makeGrid(EMPTY);
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++) g[y][x] = grid[y] ? (grid[y][x] || EMPTY) : EMPTY;
    board = g;
    markMatches();
    updateHud();
  },
  runSweep() {
    timelineCol = -1;
    for (let i = 0; i <= COLS; i++) advanceTimeline();
  },
  fillBurst() { burstGauge = BURST_MAX; burstReady = true; updateHud(); },
  triggerBurst,
};

// ===== チュートリアル =====
// シングルプレイと同じ盤面・同じ操作のまま、盤面を作り込んだ状態から始めて
// 「1つのルールを1回体験する」を6回くり返す。読ませるより先に触らせる。
const tutEl = document.getElementById("tutorial");
const tutNoEl = document.getElementById("tut-no");
const tutTotalEl = document.getElementById("tut-total");
const tutTitleEl = document.getElementById("tut-title");
const tutBodyEl = document.getElementById("tut-body");
const tutGoalEl = document.getElementById("tut-goal");
const tutQuitEl = document.getElementById("tut-quit");

let tutorialMode = false;
let tutStep = -1;
let tutClearT = 0;      // 達成メッセージを見せている残り秒数
let tutSeen = {};       // ステップ内で観測した状態（回転した/移動した など）

// 盤面を作るヘルパ。fn(x, y) が色を返す。
function tutBoard(fn) {
  const g = makeGrid(EMPTY);
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++) g[y][x] = fn(x, y) || EMPTY;
  board = g;
  bigSize = makeGrid(0);
  bigTop = makeGrid(0);
  markMatches();
  findBigBlocks();
  updateHud();
}

const TUT_STEPS = [
  {
    title: "枠の外で組み立てる",
    body: "コマは盤面の外側（点線より上）で待ちます。待っているあいだに左右へ動かし、"
        + "回して 4マスの色の並びを決めます。待ち時間が切れると一気に落ちます"
        + "（下入力・即落下で自分から落とすこともできます）。"
        + "着地後も動かす／回すたびに固定が少し延びます（15回まで）。",
    goal: "枠の外にいるうちに、左右に動かして1回まわしてみましょう",
    freeze: true,
    setup() { tutBoard(() => EMPTY); },
    done() { return tutSeen.moved && tutSeen.rotated; },
  },
  {
    title: "2×2 にそろえる",
    body: "同じ色が 2×2 の正方形になると、そのマスが「消去待ち」になって枠が光ります。"
        + "そろえただけでは、まだ消えません。",
    goal: "左下の水色があと1マスで 2×2 です。水色が右下に来るように回して置きましょう",
    freeze: true,   // タイムラインを止めて、じっくり作らせる
    setup() {
      // 2x2 に「あと1マス」の L 字。この時点では正方形ではない。
      tutBoard((x, y) =>
        (x === 2 && y >= 8) || (x === 3 && y === 9) ? COLOR_A : EMPTY);
    },
    done() {
      for (let y = 0; y < ROWS; y++)
        for (let x = 0; x < COLS; x++) if (marked[y][x]) return true;
      return false;
    },
  },
  {
    title: "タイムラインが消す",
    body: "左から右へ流れる帯が「タイムライン」。これが通過した列の消去待ちだけが消えます。"
        + "そろえるタイミングと、帯が通るタイミングの両方が大事です。",
    goal: "タイムラインが通過して消えるのを見てみましょう",
    setup() {
      // 消去待ちを置いた状態から始めて、通過→消去だけを見せる
      tutBoard((x, y) => (y >= 8 && x >= 3 && x <= 6 ? COLOR_B : EMPTY));
      timelineCol = -1; timelineBeat = 0;
      tutSeen.score0 = score;
    },
    done() { return score > tutSeen.score0; },
  },
  {
    title: "連鎖（COMBO）",
    body: "タイムラインが1周するあいだに消えると COMBO が1つ増え、次の1周でも消えるとさらに増えます。"
        + "COMBO が増えるほど得点の倍率が上がります。連鎖中は帯と消えるコマが同じ色になります。",
    goal: "下の山は 2周続けて消えるように積んであります。COMBO x2 を見てみましょう",
    setup() {
      // 1周目で水色が消え、落ちてきた桃色が2周目で消えるように組んである。
      //   col2: 下から A,A,B,B        col3: 下から A,A,(空),B,B
      // 初期状態で正方形になっているのは最下段の A だけ。
      tutBoard((x, y) => {
        if (x === 2) return y >= 8 ? COLOR_A : (y === 6 || y === 7) ? COLOR_B : EMPTY;
        if (x === 3) return y >= 8 ? COLOR_A : (y === 5 || y === 6) ? COLOR_B : EMPTY;
        return EMPTY;
      });
      timelineCol = -1; timelineBeat = 0;
      combo = 0; maxCombo = 0; updateHud();
    },
    done() { return maxCombo >= 2; },
  },
  {
    title: "豪華コマ",
    body: "正方形を 3×3・4×4 と大きくすると、1個の大きなコマに変わって単価が上がります。"
        + "同じマス数でも、まとめて大きく作るほど得点が伸びます。",
    goal: "水色があと2マスで 3×3 です。タイムラインは止めてあるので、じっくり作りましょう",
    freeze: true,
    setup() {
      // 3x3 から2マス欠けた形。この時点では 2x2 すら成立していない。
      tutBoard((x, y) => {
        if (x === 2 && y >= 7) return COLOR_A;          // 縦3
        if (x === 3 && y === 9) return COLOR_A;          // 最下段だけ
        if (x === 4 && y >= 8) return COLOR_A;           // 縦2
        return EMPTY;
      });
      bestBig = 0;
    },
    done() { return bestBig >= BIG_MIN; },
  },
  {
    title: "チェインブロック",
    body: "落ちてくる4マスのうち1マスに、まれに印の付いたブロックが混じります。"
        + "そのマスが 2×2 の一部として消えるとき、地続きにつながっている同じ色を"
        + "まとめて消します。同色を広く伸ばしておくほど、大きく返ってきます。",
    goal: "印の付いたマスが光ります。つながった同色がまとめて消去対象になるのを見てみましょう",
    freeze: true,
    setup() {
      // 地続きの水色を長く伸ばし、その端に印を置いておく
      tutBoard((x, y) => {
        if (y === 9 && x >= 1 && x <= 11) return COLOR_A;
        if (y === 8 && x >= 1 && x <= 5) return COLOR_A;
        if (y >= 6 && y <= 7 && (x === 1 || x === 2)) return COLOR_A;
        return EMPTY;
      });
      LUMINA_setChainForTutorial(1, 7);
      tutSeen.chain0 = 0;
      for (let y = 0; y < ROWS; y++)
        for (let x = 0; x < COLS; x++) if (marked[y][x]) tutSeen.chain0++;
    },
    done() {
      let n = 0;
      for (let y = 0; y < ROWS; y++)
        for (let x = 0; x < COLS; x++) if (chainWave[y][x] >= 0 && marked[y][x]) n++;
      return n >= 8;
    },
  },
  {
    title: "BURST A / B",
    body: "消すほどたまる BURST ゲージが満タンになると、2種類の必殺技が使えます。"
        + "A（Enter）は最下段4行を薙ぎ払って立て直す用。"
        + "B（Shift）はタイムラインを遅くして、大きな正方形を作る時間をかせぐ用です。",
    goal: "ゲージを満タンにしてあります。BURST A か B を使ってみましょう",
    setup() {
      tutBoard((x, y) => (y >= 6 ? ((x + y) % 3 === 0 ? COLOR_A : COLOR_B) : EMPTY));
      burstGauge = BURST_MAX; burstReady = true;
      Effects.setBurstReady(true);
      updateHud();
      tutSeen.burstUsed = false;
    },
    done() { return tutSeen.burstUsed; },
  },
];

// このステップではタイムラインを止めるか
function tutFrozen() {
  return tutorialMode && tutStep >= 0 && !!(TUT_STEPS[tutStep] || {}).freeze;
}

// チュートリアルからチェインブロックを仕込むための小さな入口
function LUMINA_setChainForTutorial(x, y) {
  chain[y][x] = true;
  markMatches();
}

function tutShow() {
  const s = TUT_STEPS[tutStep];
  if (!s) return;
  tutNoEl.textContent = String(tutStep + 1);
  tutTotalEl.textContent = String(TUT_STEPS.length);
  tutTitleEl.textContent = s.title;
  tutBodyEl.textContent = s.body;
  tutGoalEl.textContent = "▶ " + s.goal;
  tutGoalEl.classList.remove("done");
}

function tutGo(n) {
  tutStep = n;
  if (tutStep >= TUT_STEPS.length) { tutFinish(); return; }
  tutSeen = { score0: score };
  // 帯を止めるステップでは、盤面の外に退けてから止める（途中で固まって見えないように）
  if (TUT_STEPS[tutStep].freeze) { timelineCol = -1; timelineBeat = 0; }
  TUT_STEPS[tutStep].setup();
  spawnPiece();
  tutShow();
}

function tutFinish() {
  tutorialMode = false;
  tutEl.classList.add("hidden");
  document.body.classList.remove("tut-on");
  running = false;
  current = null;
  Effects.banner("TUTORIAL CLEAR", "#7fe9ff", "これで一通り遊べます");
  startOverlay.classList.remove("hidden");
}

function startTutorial() {
  GameAudio.start();
  startOverlay.classList.add("hidden");
  running = true;
  init();
  tutorialMode = true;
  tutEl.classList.remove("hidden");
  document.body.classList.add("tut-on");
  tutGo(0);
}

// 毎フレーム、いまのステップの達成条件を見る
function tutUpdate(dt) {
  if (!tutorialMode || tutStep < 0) return;
  if (tutClearT > 0) {
    tutClearT -= dt;
    if (tutClearT <= 0) tutGo(tutStep + 1);
    return;
  }
  const s = TUT_STEPS[tutStep];
  if (s && s.done()) {
    tutGoalEl.textContent = "✔ できました";
    tutGoalEl.classList.add("done");
    GameAudio.playLevelUp();
    tutClearT = 1.6;
  }
}

if (tutQuitEl) tutQuitEl.addEventListener("click", () => tutFinish());
const tutBtn = document.getElementById("tutorial-btn");
if (tutBtn) tutBtn.addEventListener("click", (e) => { e.stopPropagation(); startTutorial(); });

// ===== 起動 =====
resizeBg();
running = false;
lastTime = performance.now();
board = makeGrid(EMPTY);
marked = makeGrid(false);
fallAnim = makeGrid(0);
fallVel = makeGrid(0);
chain = makeGrid(false);
chainWave = makeGrid(-1);
current = null;
nextQueue = [randomCells(), randomCells()];
level = 1;
nextLevelAt = levelNeed(1);
bigSize = makeGrid(0);
bigTop = makeGrid(0);
drawNext();
renderRanking(startRankEl, loadRanking(), null);
// 音楽素材の先読み。START を押すまでに間に合わせる。
if (GameAudio.preload) {
  GameAudio.preload().then(() => {
    const hint = document.querySelector("#start .overlay-hint");
    if (hint && GameAudio.usingFallback) {
      hint.textContent = "クリック / SPACE / コントローラーのボタン で開始"
        + "（file:// で開いているためミックス固定。HTTP配信でレイヤー連動が有効になります）";
    }
  });
}
renderPadCfg();
renderControlHints();
{
  const openBtn = document.getElementById("pad-config-btn");
  if (openBtn) openBtn.addEventListener("click", openPadCfg);
  const closeBtn = document.getElementById("cfg-close");
  if (closeBtn) closeBtn.addEventListener("click", closePadCfg);
  const resetBtn = document.getElementById("cfg-reset");
  if (resetBtn) resetBtn.addEventListener("click", () => {
    padMap = defaultPadMap();
    padBindWait = null;
    savePadMap();
    renderPadCfg();
    renderControlHints();
  });
}
requestAnimationFrame(loop);
