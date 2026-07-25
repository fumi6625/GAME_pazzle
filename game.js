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

const COLORS = {
  [COLOR_A]: { base: "#1b3fbf", light: "#3f8bff", core: "#bfe3ff", glow: "#57b1ff" },
  [COLOR_B]: { base: "#c31677", light: "#ff4fae", core: "#ffd2ec", glow: "#ff6ec7" },
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

function blockSprite(color, size) {
  const key = color + "_" + size;
  if (spriteCache[key]) return spriteCache[key];
  const s = document.createElement("canvas");
  s.width = s.height = size;
  const c = s.getContext("2d");
  const col = COLORS[color];
  const pad = 2, r = size * 0.2;

  // 本体: 左上から光が差すラジアルグラデ
  const g = c.createRadialGradient(size * 0.32, size * 0.26, 2, size * 0.5, size * 0.6, size * 0.85);
  g.addColorStop(0, col.core);
  g.addColorStop(0.4, col.light);
  g.addColorStop(1, col.base);
  roundRectPath(c, pad, pad, size - pad * 2, size - pad * 2, r);
  c.fillStyle = g;
  c.fill();

  // 底面の陰影
  const g2 = c.createLinearGradient(0, size * 0.55, 0, size);
  g2.addColorStop(0, "rgba(0,0,0,0)");
  g2.addColorStop(1, "rgba(5,0,25,0.4)");
  roundRectPath(c, pad, pad, size - pad * 2, size - pad * 2, r);
  c.fillStyle = g2;
  c.fill();

  // ガラスの艶（上部ハイライト）
  const g3 = c.createLinearGradient(0, pad, 0, size * 0.46);
  g3.addColorStop(0, "rgba(255,255,255,0.6)");
  g3.addColorStop(1, "rgba(255,255,255,0.02)");
  roundRectPath(c, pad + 3, pad + 2.5, size - pad * 2 - 6, size * 0.36, r * 0.7);
  c.fillStyle = g3;
  c.fill();

  // 内側の輝点
  const g4 = c.createRadialGradient(size * 0.3, size * 0.3, 0, size * 0.3, size * 0.3, size * 0.22);
  g4.addColorStop(0, "rgba(255,255,255,0.5)");
  g4.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g4;
  c.fillRect(0, 0, size, size);

  // 縁
  roundRectPath(c, pad + 0.5, pad + 0.5, size - pad * 2 - 1, size - pad * 2 - 1, r);
  c.strokeStyle = "rgba(255,255,255,0.25)";
  c.lineWidth = 1;
  c.stroke();

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
    const px = x * size, py = y * size, pad = 2;
    c.save();
    c.globalCompositeOperation = "lighter";
    c.globalAlpha = 0.25 + pulse * 0.3;
    c.drawImage(blockSprite(color, size), px, py);
    c.restore();
    c.strokeStyle = `rgba(255,255,255,${0.45 + pulse * 0.5})`;
    c.lineWidth = 2;
    roundRectPath(c, px + pad + 1, py + pad + 1, size - pad * 2 - 2, size - pad * 2 - 2, size * 0.16);
    c.stroke();
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
