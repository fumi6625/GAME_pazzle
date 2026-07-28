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
const CELL = 40; // 640x400

const EMPTY = 0;
const COLOR_A = 1;
const COLOR_B = 2;

// 背景のネオン（シアン/マゼンタ）と同じ色域に揃える
const COLORS = {
  [COLOR_A]: { deep: "#03202f", base: "#0c6d97", light: "#5ce4ff", core: "#e2fbff", glow: "#5ce4ff" },
  [COLOR_B]: { deep: "#2b0620", base: "#a01463", light: "#ff5cc8", core: "#ffe0f4", glow: "#ff5cc8" },
};

const GRAVITY_INTERVAL = 620;   // ms: ピース落下（レベル1）
const SOFT_DROP_INTERVAL = 45;
const BURST_MAX = 72;           // 消したセル数でゲージ満タン（条件を厳しく）

// ===== レベル =====
const LEVEL_BASE = 2000;        // Lv2 到達に必要な点
const LEVEL_STEP = 1600;        // 1レベル上がるごとの必要点の増分
const LEVEL_MULT = 0.2;         // レベルごとの得点係数の増加（Lv1=x1.0, Lv5=x1.8）
const LEVEL_SPEEDUP = 0.955;    // レベルごとの落下間隔（ほんの少しだけ速く）
const MIN_GRAVITY = 190;        // 落下間隔の下限
const MAX_LEVEL = 30;

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
let bigSize, bigTop;            // 豪華コマ: 各セルが属する正方形の辺長 / 左上セルの辺長
let current, nextPiece;
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

// ===== ユーティリティ =====
function makeGrid(fill) {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(fill));
}
function randomCells() {
  const rnd = () => (Math.random() < 0.5 ? COLOR_A : COLOR_B);
  return [[rnd(), rnd()], [rnd(), rnd()]];
}
function cellCenter(x, y) {
  return { cx: x * CELL + CELL / 2, cy: y * CELL + CELL / 2 };
}
function colPan(x) { return (x / (COLS - 1)) * 1.6 - 0.8; }

// ===== レベル =====
// 得点が閾値を越えるたびに1段階ずつ上がる。上がるほど得点係数が伸び、
// 落下間隔がわずかに縮んで難度が上がる。
function levelNeed(l) { return LEVEL_BASE + (l - 1) * LEVEL_STEP; }
function levelMult() { return 1 + (level - 1) * LEVEL_MULT; }
function gravityInterval() {
  return Math.max(MIN_GRAVITY, GRAVITY_INTERVAL * Math.pow(LEVEL_SPEEDUP, level - 1));
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
  }
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
 * カット済みクリスタルのブロック。
 * 面取り八角形の外周と内側テーブルの間に8枚のベベル面を張り、
 * 各面の向きと光源(左上)の内積で明暗を付けて立体を出す。
 */
function blockSprite(color, size) {
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
 * 豪華コマ（3x3 以上の同色正方形）を1個の大きな宝石として描く。
 * ベースは同じカット済みクリスタルを n セル分の大きさで描き、
 * その上に金の二重縁・四隅の飾り・中央のきらめきを重ねて「格の違い」を出す。
 */
const bigSpriteCache = {};
function bigBlockSprite(color, n) {
  const key = color + "_" + n;
  if (bigSpriteCache[key]) return bigSpriteCache[key];
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
  nextPiece = randomCells();
  Effects.reset();
  Effects.setBurstReady(false);
  Effects.setLevel(1);
  GameAudio.setIntensity(1);
  spawnPiece();
  updateHud();
  overOverlay.classList.add("hidden");
}

// ===== ピース生成 =====
function spawnPiece() {
  const startX = Math.floor(COLS / 2) - 1;
  current = { x: startX, y: -2, cells: nextPiece };
  nextPiece = randomCells();
  drawNext();
  if (board[0][startX] !== EMPTY || board[0][startX + 1] !== EMPTY) {
    endGame();
  }
}

// ===== 衝突判定 =====
function collides(x, y, cells) {
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const bx = x + c, by = y + r;
      if (bx < 0 || bx >= COLS) return true;
      if (by >= ROWS) return true;
      if (by >= 0 && board[by][bx] !== EMPTY) return true;
    }
  }
  return false;
}

// ===== 操作 =====
function move(dx) {
  if (!current || gameOver || paused) return;
  if (!collides(current.x + dx, current.y, current.cells)) {
    current.x += dx;
    GameAudio.playMove(dx);
  }
}
// dir: 1 = 右回転(時計回り) / -1 = 左回転(反時計回り)
function rotate(dir = 1) {
  if (!current || gameOver || paused) return;
  const c = current.cells;
  const rotated = dir >= 0
    ? [[c[1][0], c[0][0]], [c[1][1], c[0][1]]]
    : [[c[0][1], c[1][1]], [c[0][0], c[1][0]]];
  if (!collides(current.x, current.y, rotated)) {
    current.cells = rotated;
    GameAudio.playRotate(dir);
    // 回転は「音を回す」動作: ピース中心にリングを出す（方向で色を変える）
    const { cx, cy } = cellCenter(current.x + 0.5, Math.max(0, current.y) + 0.5);
    Effects.ring(cx, cy, dir >= 0 ? "rgba(150,230,255,1)" : "rgba(255,190,120,1)", CELL * 1.6);
  }
}
function hardDrop() {
  if (!current || gameOver || paused) return;
  const from = current.y;
  while (!collides(current.x, current.y + 1, current.cells)) current.y++;
  if (current.y > from) {
    GameAudio.playDrop();
    // 落下の軌跡（残像トレイル）
    const { cx } = cellCenter(current.x + 0.5, 0);
    Effects.column(cx, CELL * 2, (current.y + 2) * CELL, "rgba(200,240,255,ALPHA)");
  }
  lockPiece();
}
function stepDown() {
  if (!collides(current.x, current.y + 1, current.cells)) current.y++;
  else lockPiece();
}

// ===== 固定 =====
function lockPiece() {
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const bx = current.x + c, by = current.y + r;
      if (by < 0) { endGame(); return; }
      board[by][bx] = current.cells[r][c];
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
    for (let y = ROWS - 1; y >= 0; y--) {
      if (board[y][x] !== EMPTY) {
        board[write][x] = board[y][x];
        if (write !== y) board[y][x] = EMPTY;
        write--;
      }
    }
    for (let y = write; y >= 0; y--) board[y][x] = EMPTY;
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
  findBigBlocks();
  return any && newOne;
}

// 1列だけを下へ詰める（マークも一緒に移動）
function settleColumn(x) {
  let write = ROWS - 1;
  for (let y = ROWS - 1; y >= 0; y--) {
    if (board[y][x] !== EMPTY) {
      board[write][x] = board[y][x];
      marked[write][x] = marked[y][x];
      bigSize[write][x] = bigSize[y][x];
      if (write !== y) { board[y][x] = EMPTY; marked[y][x] = false; bigSize[y][x] = 0; }
      write--;
    }
  }
  for (let y = write; y >= 0; y--) { board[y][x] = EMPTY; marked[y][x] = false; bigSize[y][x] = 0; }
}

// ===== タイムライン進行（音楽同期・本家準拠） =====
// 1列 = 8分音符。マークは「通過するまで」保持され、通過列だけ消去・落下する。
// スコア/COMBO は 1スイープ単位で確定させる。
let sweepCleared = 0;
let sweepBase = 0;      // このスイープの基礎点（豪華コマの単価上昇を含む）

function advanceTimeline() {
  timelineCol++;

  // スイープ完了 → 集計と再マッチ
  if (timelineCol >= COLS) {
    timelineCol = -1;
    resolveSweep();
    settleColumns();
    markMatches();
    return;
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
    const pendingMult = Math.min(16, Math.pow(2, combo));
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
    Effects.column(c * CELL + CELL / 2, CELL, ROWS * CELL,
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

    const mult = Math.min(16, Math.pow(2, combo - 1)); // x1,x2,x4,x8,x16
    let pts = Math.round(sweepBase * mult * levelMult());
    if (sweepCleared >= 8) pts += 100;
    score += pts;

    // 連鎖はバナーと音で伝える。画面全体を揺らすと目が疲れるので控える。
    if (combo >= 2) {
      Effects.banner("COMBO x" + combo, rgbaOf(HL_CHAIN, 1));
      Effects.screenFlash(0.10);
      GameAudio.playCombo(combo);
    }
    if (mult >= 4) {
      Effects.banner("BONUS x" + mult, "#7fffd4");
    }

    checkLevelUp();
  } else {
    combo = 0;
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
  burstReady = false;
  burstGauge = 0;
  Effects.setBurstReady(false);
  slowTimer = SLOW_DURATION;

  Effects.banner("CHRONO", "#7fe9ff",
    "タイムライン減速 " + SLOW_DURATION + "秒  /  大きな正方形を組め");
  Effects.screenFlash(0.5);
  Effects.zone(0, 0, COLS * CELL, ROWS * CELL, "rgba(120,230,255,0.22)");
  for (let i = 0; i < 4; i++)
    Effects.ring(canvas.width / 2, canvas.height / 2, "#7fe9ff", canvas.width * (0.3 + i * 0.22));
  GameAudio.playSlow();
  padRumble(0.35, 0.8, 500);
  updateHud();
}

// ===== BURST-A: 最下段を薙ぎ払う =====
function triggerBurst() {
  if (!burstReady || gameOver || paused) return;
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
  Effects.zone(0, (ROWS - BURST_ROWS) * CELL, COLS * CELL, BURST_ROWS * CELL,
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
const hlColor = () => (chaining() ? HL_CHAIN : HL_IDLE);
// 脈動はごく穏やかに（周期 620ms・振幅小）。目立たせるのは色の違いで足りる。
const hlPulse = () => 0.5 + 0.5 * Math.sin(performance.now() / 620);
const rgbaOf = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function drawCell(c, x, y, color, size, opts = {}) {
  c.drawImage(blockSprite(color, size), x * size, y * size);
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

    // 面取り八角形に沿った枠。色だけが連鎖の有無を示す。
    c.save();
    c.translate(px, py);
    polyPath(c, facetPoints(size, Math.max(1.5, size * 0.045) + 1, size * 0.2, 1));
    c.strokeStyle = rgbaOf(col, 0.6 + pulse * 0.3);
    c.lineWidth = 2;
    c.stroke();
    c.restore();
  }
}

function render() {
  const shk = Effects.getShake();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(shk.x, shk.y);

  // 盤面のうっすら暗幕
  ctx.fillStyle = "rgba(8,10,26,0.42)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // グリッド（微細ドット）
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  for (let x = 1; x < COLS; x++)
    for (let y = 1; y < ROWS; y++)
      ctx.fillRect(x * CELL - 1, y * CELL - 1, 2, 2);

  // セル（豪華コマに含まれるものは個別に描かず、大きな1個として描く）
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (board[y][x] !== EMPTY && !bigSize[y][x])
        drawCell(ctx, x, y, board[y][x], CELL, { marked: marked[y][x] });

  // 豪華コマ
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const n = bigTop[y][x];
      if (!n || board[y][x] === EMPTY) continue;
      const px = x * CELL, py = y * CELL, sz = n * CELL;
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
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 2; c++) {
        const by = current.y + r;
        if (by >= 0) drawCell(ctx, current.x + c, by, current.cells[r][c], CELL);
      }
  }

  // タイムライン（音楽同期 + 尾を引く光）
  if (running && !gameOver) {
    const frac = timelineBeat * 2 % 1;
    const colf = timelineCol + frac;
    if (colf >= 0 && colf < COLS) {
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

  // パーティクル等
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

function drawNext() {
  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  const size = 42;
  const offX = (nextCanvas.width - size * 2) / 2;
  const offY = (nextCanvas.height - size * 2) / 2;
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 2; c++)
      nextCtx.drawImage(blockSprite(nextPiece[r][c], size), offX + c * size, offY + r * size);
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
  const g = c.createLinearGradient(0, r.y - pad, 0, r.y + r.h + pad);
  g.addColorStop(0, "rgba(3,5,12,0)");
  g.addColorStop(0.10, "rgba(3,5,12,0.80)");
  g.addColorStop(0.90, "rgba(3,5,12,0.80)");
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
    gravityTimer += dt * 1000;
    const gi = (softDrop || padSoftDrop) ? SOFT_DROP_INTERVAL : gravityInterval();
    if (gravityTimer >= gi) { gravityTimer = 0; if (current) stepDown(); }

    // タイムライン（音楽ビートで進行: 1列 = 8分音符）
    const beatsPerCol = 0.5;
    if (slowTimer > 0) {
      slowTimer = Math.max(0, slowTimer - dt);
      if (slowTimer === 0) {
        Effects.banner("CHRONO END", "#7fe9ff");
        GameAudio.playSlowEnd();
      }
    }
    timelineBeat += (dt / GameAudio.secondsPerBeat) * (slowTimer > 0 ? SLOW_FACTOR : 1);
    while (timelineBeat >= beatsPerCol) {
      timelineBeat -= beatsPerCol;
      advanceTimeline();
    }

    if (Math.floor(now / 250) !== Math.floor((now - dt * 1000) / 250)) updateHud();
  }

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
    case "m": case "M": GameAudio.toggleMute(); break;
  }
});
document.addEventListener("keyup", (e) => {
  if (e.key === "ArrowDown") softDrop = false;
});

document.getElementById("start-btn").addEventListener("click", startGame);
document.getElementById("retry-btn").addEventListener("click", () => init());

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
  pieceX() { return current ? current.x : null; },
  pieceY() { return current ? current.y : null; },
  pieceCells() { return current ? current.cells : null; },
  addScore(v) { score += v; checkLevelUp(); updateHud(); },
  setCombo(v) { combo = v; updateHud(); },
  pause(v) { paused = !!v; },
  endNow() { endGame(); },
  setBoard(grid) {
    board = grid.map((row) => row.slice());
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

// ===== 起動 =====
resizeBg();
running = false;
lastTime = performance.now();
board = makeGrid(EMPTY);
marked = makeGrid(false);
current = null;
nextPiece = randomCells();
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
