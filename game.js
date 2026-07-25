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
const BURST_ROWS = 4;           // BURST が薙ぎ払う最下段からの行数
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
    Effects.popup(canvas.width / 2, canvas.height / 2 - 70, "LEVEL " + level, "#7fffd4", true);
    Effects.popup(canvas.width / 2, canvas.height / 2 - 18,
      "SCORE x" + levelMult().toFixed(1) + "  /  SPEED UP", "#bfe9ff");
    Effects.screenFlash(0.45);
    Effects.screenShake(6);
    for (let i = 0; i < 3; i++)
      Effects.ring(canvas.width / 2, canvas.height / 2, "#7fffd4", canvas.width * (0.4 + i * 0.25));
    GameAudio.playLevelUp(level);
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
      Effects.popup(cx, cy - CELL, n + "×" + n + " GRAND", "#ffe27a", true);
      Effects.screenFlash(0.3);
      GameAudio.playGrand(n);
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
function rotate() {
  if (!current || gameOver || paused) return;
  const c = current.cells;
  const rotated = [[c[1][0], c[0][0]], [c[1][1], c[0][1]]];
  if (!collides(current.x, current.y, rotated)) {
    current.cells = rotated;
    GameAudio.playRotate();
    // 回転は「音を回す」動作: ピース中心にリングを出す
    const { cx, cy } = cellCenter(current.x + 0.5, Math.max(0, current.y) + 0.5);
    Effects.ring(cx, cy, "rgba(150,230,255,1)", CELL * 1.6);
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
    const popScale = 0.85 + Math.min(1.3, combo * 0.22) + (colBig >= BIG_MIN ? 0.5 : 0);
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

    // COMBO はコンボ段数に応じて派手さが増す
    if (combo >= 2) {
      const heat = Math.min(1, (combo - 1) / 5);
      Effects.popup(canvas.width / 2, 64, "COMBO x" + combo, "#ffe27a", combo >= 4);
      Effects.screenFlash(0.12 + heat * 0.3);
      Effects.screenShake(2 + heat * 8);
      for (let i = 0; i < 1 + Math.min(4, combo); i++)
        Effects.ring(canvas.width / 2, canvas.height / 2,
          "#ffe27a", canvas.width * (0.25 + i * 0.16));
      GameAudio.playCombo(combo);
    }
    if (mult >= 4) {
      Effects.popup(canvas.width / 2, canvas.height / 2, "BONUS x" + mult, "#7fffd4", true);
    }
    // スイープ合計をまとめて中央に打ち出す（達成感）
    Effects.scorePop(canvas.width / 2, canvas.height / 2 + 46, "+" + pts,
      combo >= 3 ? "#ffe27a" : "#bfe9ff", 1.1 + Math.min(1.1, combo * 0.2));

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

  // 見逃しようのないインパクト: 衝撃波・フラッシュ・文字
  const cx = canvas.width / 2, cy = canvas.height / 2;
  Effects.ring(cx, cy, "#ff5cf0", canvas.width * 0.9);
  Effects.ring(cx, cy, "#7fffd4", canvas.width * 0.65);
  Effects.burst(cx, cy, "#ff8cf5", 40, 2.2);
  Effects.screenFlash(0.55);
  Effects.screenShake(7);
  Effects.popup(cx, cy - 40, "BURST READY", "#ff5cf0", true);
  Effects.popup(cx, cy + 16, "PRESS ENTER", "#bfe9ff");
}

// ===== BURST 発動 =====
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
  Effects.popup(canvas.width / 2, canvas.height / 2 - 34, "BURST!", "#ff5cf0", true);
  Effects.popup(canvas.width / 2, canvas.height / 2 + 22,
    cells.length + " BLOCKS CLEARED", "#ffd2ec");
  Effects.scorePop(canvas.width / 2, canvas.height / 2 + 64, "+" + pts, "#ff8cf5", 2.0);
  GameAudio.playBurst();

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
  comboEl.textContent = combo;
  const s = Math.floor(elapsedMs / 1000);
  timeEl.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  burstFillEl.style.width = (burstGauge / BURST_MAX * 100) + "%";
  burstFillEl.classList.toggle("ready", burstReady);
  burstReadyEl.classList.toggle("hidden", !burstReady);

  // レベル: 現在値・次レベルまでの進捗・得点係数
  if (levelEl) levelEl.textContent = level;
  if (levelMultEl) levelMultEl.textContent = "x" + levelMult().toFixed(1);
  if (levelFillEl) {
    const need = levelNeed(level);
    const done = Math.max(0, need - (nextLevelAt - score));
    levelFillEl.style.width = Math.max(0, Math.min(100, (done / need) * 100)) + "%";
  }
}

// ===== ゲームオーバー =====
function endGame() {
  if (gameOver) return;
  gameOver = true;
  current = null;
  GameAudio.playGameOver();
  GameAudio.setIntensity(0);
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
function drawCell(c, x, y, color, size, opts = {}) {
  c.drawImage(blockSprite(color, size), x * size, y * size);
  if (opts.marked) {
    // 消去待ち: 白枠 + グローのパルス
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 110);
    const px = x * size, py = y * size;
    c.save();
    c.globalCompositeOperation = "lighter";
    c.globalAlpha = 0.25 + pulse * 0.3;
    c.drawImage(blockSprite(color, size), px, py);
    c.restore();
    // 面取り八角形に沿った白枠のパルス
    c.save();
    c.translate(px, py);
    polyPath(c, facetPoints(size, Math.max(1.5, size * 0.045) + 1, size * 0.2, 1));
    c.strokeStyle = `rgba(255,255,255,${0.45 + pulse * 0.5})`;
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
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 100);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = (0.18 + pulse * 0.3) * (1 + (n - 3) * 0.2);
        ctx.drawImage(bigBlockSprite(board[y][x], n), px, py);
        ctx.restore();
        ctx.strokeStyle = `rgba(255,232,150,${0.5 + pulse * 0.5})`;
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
      const tail = ctx.createLinearGradient(tx - 90, 0, tx, 0);
      tail.addColorStop(0, "rgba(90,190,255,0)");
      tail.addColorStop(1, "rgba(120,210,255,0.22)");
      ctx.fillStyle = tail;
      ctx.fillRect(tx - 90, 0, 90, ROWS * CELL);
      // コアライン
      const core = ctx.createLinearGradient(tx - 5, 0, tx + 5, 0);
      core.addColorStop(0, "rgba(160,230,255,0)");
      core.addColorStop(0.5, "rgba(235,250,255,0.95)");
      core.addColorStop(1, "rgba(160,230,255,0)");
      ctx.fillStyle = core;
      ctx.fillRect(tx - 5, 0, 10, ROWS * CELL);
      // 先端の輝き
      ctx.fillStyle = "rgba(200,240,255,0.5)";
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
function resizeBg() {
  bgCanvas.width = window.innerWidth;
  bgCanvas.height = window.innerHeight;
  Effects.initBg(bgCanvas.width, bgCanvas.height);
}
window.addEventListener("resize", resizeBg);

// ===== ループ =====
function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  const beat = GameAudio.beatPhase();

  // 背景（常時・ビート連動）
  Effects.drawBackground(bgCtx, bgCanvas.width, bgCanvas.height, dt, beat,
    running && !gameOver ? 2 : 1);

  if (running && !gameOver && !paused) {
    elapsedMs = now - startTimeMs;

    // 重力
    gravityTimer += dt * 1000;
    const gi = softDrop ? SOFT_DROP_INTERVAL : gravityInterval();
    if (gravityTimer >= gi) { gravityTimer = 0; if (current) stepDown(); }

    // タイムライン（音楽ビートで進行: 1列 = 8分音符）
    const beatsPerCol = 0.5;
    timelineBeat += dt / GameAudio.secondsPerBeat;
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

// ===== 入力 =====
document.addEventListener("keydown", (e) => {
  if (!running) {
    if (e.key === " " || e.key === "Enter") { startGame(); e.preventDefault(); }
    return;
  }
  switch (e.key) {
    case "ArrowLeft": move(-1); e.preventDefault(); break;
    case "ArrowRight": move(1); e.preventDefault(); break;
    case "ArrowUp": hardDrop(); e.preventDefault(); break;      // ↑ = 即座に落下
    case "ArrowDown": softDrop = true; e.preventDefault(); break;
    case " ": rotate(); e.preventDefault(); break;              // Space = 回転
    case "Enter": triggerBurst(); e.preventDefault(); break;
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
  get gravity() { return Math.round(gravityInterval()); },
  get mult() { return levelMult(); },
  bigTopList() {
    const out = [];
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++) if (bigTop[y][x]) out.push({ x, y, n: bigTop[y][x] });
    return out;
  },
  addScore(v) { score += v; checkLevelUp(); updateHud(); },
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
requestAnimationFrame(loop);
