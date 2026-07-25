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

const GRAVITY_INTERVAL = 620;   // ms: ピース落下
const SOFT_DROP_INTERVAL = 45;
const BURST_MAX = 30;           // 消したセル数でゲージ満タン

// ===== 状態 =====
let board, marked;
let current, nextPiece;
let score, squaresCleared, combo, maxCombo;
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

// ===== 初期化 =====
function init() {
  board = makeGrid(EMPTY);
  marked = makeGrid(false);
  score = 0;
  squaresCleared = 0;
  combo = 0;
  maxCombo = 0;
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
  return any && newOne;
}

// 1列だけを下へ詰める（マークも一緒に移動）
function settleColumn(x) {
  let write = ROWS - 1;
  for (let y = ROWS - 1; y >= 0; y--) {
    if (board[y][x] !== EMPTY) {
      board[write][x] = board[y][x];
      marked[write][x] = marked[y][x];
      if (write !== y) { board[y][x] = EMPTY; marked[y][x] = false; }
      write--;
    }
  }
  for (let y = write; y >= 0; y--) { board[y][x] = EMPTY; marked[y][x] = false; }
}

// ===== タイムライン進行（音楽同期・本家準拠） =====
// 1列 = 8分音符。マークは「通過するまで」保持され、通過列だけ消去・落下する。
// スコア/COMBO は 1スイープ単位で確定させる。
let sweepCleared = 0;

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
      cleared.push({ y, color: board[y][c] });
      board[y][c] = EMPTY;
    }
  }
  for (let y = 0; y < ROWS; y++) marked[y][c] = false;

  if (cleared.length > 0) {
    sweepCleared += cleared.length;
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
      if (burstGauge >= BURST_MAX) { burstGauge = BURST_MAX; burstReady = true; }
    }

    settleColumn(c);
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
    let pts = sweepCleared * 10 * mult;
    if (sweepCleared >= 8) pts += 100;
    score += pts;

    if (combo >= 2) {
      Effects.popup(canvas.width / 2, 64, "COMBO x" + combo, "#ffe27a");
      GameAudio.playCombo(combo);
    }
    if (mult >= 4) {
      Effects.popup(canvas.width / 2, canvas.height / 2, "BONUS x" + mult, "#7fffd4", true);
    }
  } else {
    combo = 0;
  }
  sweepCleared = 0;
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

// ===== BURST 発動 =====
function triggerBurst() {
  if (!burstReady || gameOver || paused) return;
  burstReady = false;
  burstGauge = 0;

  let cells = [];
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (marked[y][x] && board[y][x] !== EMPTY) cells.push({ x, y, color: board[y][x] });

  // 盤面下部の密集を薙ぎ払う（ピンチ脱出）
  for (let y = ROWS - 1; y >= ROWS - 4; y--) {
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

  cells.forEach((c) => {
    board[c.y][c.x] = EMPTY;
    marked[c.y][c.x] = false;
    const { cx, cy } = cellCenter(c.x, c.y);
    const col = COLORS[c.color];
    Effects.shatter(cx, cy, col.light, 8, 1.8);
    Effects.burst(cx, cy, col.glow, 12, 1.6);
    Effects.ring(cx, cy, "#ffffff", CELL * 2);
  });

  score += cells.length * 30;
  squaresCleared += cells.length / 4;

  Effects.screenFlash(0.9);
  Effects.screenShake(12);
  Effects.popup(canvas.width / 2, canvas.height / 2 - 20, "BURST!", "#ff5cf0", true);
  GameAudio.playBurst();

  settleColumns();
  markMatches();
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
  burstReadyEl.classList.toggle("hidden", !burstReady);
}

// ===== ゲームオーバー =====
function endGame() {
  if (gameOver) return;
  gameOver = true;
  current = null;
  GameAudio.playGameOver();
  GameAudio.setIntensity(0);
  Effects.screenShake(8);
  overScoreEl.textContent = "SCORE: " + score + "  /  MAX COMBO: " + maxCombo;
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

  // セル
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (board[y][x] !== EMPTY)
        drawCell(ctx, x, y, board[y][x], CELL, { marked: marked[y][x] });

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
    const gi = softDrop ? SOFT_DROP_INTERVAL : GRAVITY_INTERVAL;
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
drawNext();
requestAnimationFrame(loop);
