/*
 * LUMINA ARISE — ルミナス風パズル（演出・音楽・BURST 搭載）
 * HTML + Canvas + Web Audio（ビルド不要）
 *
 * ゲームの流れ:
 *  - 2色の 2x2 ブロックが落下（←→移動 / ↑回転 / ↓落下 / Space ハードドロップ）
 *  - 同色が 2x2 の正方形になると「消去待ち」フラグ
 *  - タイムライン（音楽に同期して左→右）が通過した列でフラグ付きセルを消去
 *  - 連続スイープで消し続けると COMBO 倍率アップ、3個以上で BONUS
 *  - 消去でたまる BURST ゲージ満タン時に Enter → 大量消去の必殺演出
 */

// ===== 定数 =====
const COLS = 16;
const ROWS = 10;
const CELL = 40; // 640x400

const EMPTY = 0;
const COLOR_A = 1;
const COLOR_B = 2;

const COLORS = {
  [COLOR_A]: { base: "#2f7bff", light: "#7fb2ff", glow: "#4f9bff" },
  [COLOR_B]: { base: "#ff3ea5", light: "#ff8fd0", glow: "#ff5cc0" },
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

let timelineCol;        // 現在のタイムライン列（-1..COLS-1）
let timelineBeat;       // 累積ビート（音楽同期）
let clearedThisSweep;

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
  clearedThisSweep = false;
  gravityTimer = 0;
  elapsedMs = 0;
  startTimeMs = performance.now();
  nextPiece = randomCells();
  Effects.reset();
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
  if (!collides(current.x + dx, current.y, current.cells)) current.x += dx;
}
function rotate() {
  if (!current || gameOver || paused) return;
  const c = current.cells;
  const rotated = [[c[1][0], c[0][0]], [c[1][1], c[0][1]]];
  if (!collides(current.x, current.y, rotated)) current.cells = rotated;
}
function hardDrop() {
  if (!current || gameOver || paused) return;
  while (!collides(current.x, current.y + 1, current.cells)) current.y++;
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
  current = null;
  settleColumns();
  const had = markMatches();
  if (had) GameAudio.playSquare();
  spawnPiece();
}

// ===== 重力（列詰め） =====
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
let sweepCleared = 0; // 現スイープで消したセル数

function advanceTimeline() {
  timelineCol++;

  // スイープ完了（右端を越えた）→ 集計と再マッチ
  if (timelineCol >= COLS) {
    timelineCol = -1;
    resolveSweep();
    // 落下してできた新しいスクエアを次スイープ用に付け直す
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
  // この列は処理済み：残マークを消し、列内だけ落下
  for (let y = 0; y < ROWS; y++) marked[y][c] = false;

  if (cleared.length > 0) {
    sweepCleared += cleared.length;
    // 演出＋音（消えたセルが音階で旋律になる）
    cleared.forEach((cell, i) => {
      const { cx, cy } = cellCenter(c, cell.y);
      Effects.burst(cx, cy, COLORS[cell.color].light, 12, 1);
      Effects.ring(cx, cy, COLORS[cell.color].glow, CELL * 1.6);
      GameAudio.playClear(i, cell.y);
    });
    Effects.screenFlash(0.12 + Math.min(0.35, sweepCleared * 0.03));

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
    if (sweepCleared >= 8) pts += 100; // 大量消しBONUS
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
  updateHud();
}

// ===== BURST 発動 =====
function triggerBurst() {
  if (!burstReady || gameOver || paused) return;
  burstReady = false;
  burstGauge = 0;

  // 現在マーク中の全セル ＋ 各色の最大クラスタ的に "同色隣接" を一気消し
  // シンプルに: 盤上で最も多い色のセルを一定割合消す + マーク中は全消し
  let cells = [];
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (marked[y][x] && board[y][x] !== EMPTY) cells.push({ x, y, color: board[y][x] });

  // 追加で、盤面下部の密集を薙ぎ払う（BURST の"ピンチ脱出"）
  for (let y = ROWS - 1; y >= ROWS - 4; y--) {
    for (let x = 0; x < COLS; x++) {
      if (board[y][x] !== EMPTY && !cells.find((c) => c.x === x && c.y === y)) {
        cells.push({ x, y, color: board[y][x] });
      }
    }
  }

  if (cells.length === 0) {
    // マーク・下段が無ければ全消し量を確保（最低限の見返り）
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++)
        if (board[y][x] !== EMPTY) cells.push({ x, y, color: board[y][x] });
  }

  cells.forEach((c) => {
    board[c.y][c.x] = EMPTY;
    marked[c.y][c.x] = false;
    const { cx, cy } = cellCenter(c.x, c.y);
    Effects.burst(cx, cy, COLORS[c.color].light, 18, 1.6);
    Effects.ring(cx, cy, "#ffffff", CELL * 2);
  });

  score += cells.length * 30;
  squaresCleared += Math.round(cells.length / 4 * 10) / 10;

  Effects.screenFlash(0.85);
  Effects.screenShake(10);
  Effects.popup(canvas.width / 2, canvas.height / 2 - 20, "BURST!", "#ff5cf0", true);
  GameAudio.playBurst();

  settleColumns();
  markMatches();
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
  Effects.screenShake(8);
  overScoreEl.textContent = "SCORE: " + score + "  /  MAX COMBO: " + maxCombo;
  overOverlay.classList.remove("hidden");
}

// ===== 描画 =====
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawCell(c, x, y, color, size, opts = {}) {
  const col = COLORS[color];
  const px = x * size, py = y * size;
  const pad = 2;
  c.save();
  if (opts.marked) {
    c.shadowColor = col.glow;
    c.shadowBlur = 16;
  }
  const grad = c.createLinearGradient(px, py, px, py + size);
  grad.addColorStop(0, col.light);
  grad.addColorStop(0.5, col.base);
  grad.addColorStop(1, col.base);
  c.fillStyle = grad;
  roundRect(c, px + pad, py + pad, size - pad * 2, size - pad * 2, 6);
  c.fill();
  c.restore();

  // ハイライト
  c.fillStyle = "rgba(255,255,255,0.28)";
  roundRect(c, px + pad + 2, py + pad + 2, size - pad * 2 - 4, 5, 3);
  c.fill();

  // マーク中は白枠パルス
  if (opts.marked) {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120);
    c.strokeStyle = `rgba(255,255,255,${0.4 + pulse * 0.5})`;
    c.lineWidth = 2;
    roundRect(c, px + pad + 1, py + pad + 1, size - pad * 2 - 2, size - pad * 2 - 2, 5);
    c.stroke();
  }
}

function render() {
  const shk = Effects.getShake();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(shk.x, shk.y);

  // 盤面枠内うっすら
  ctx.fillStyle = "rgba(10,14,30,0.35)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // グリッド
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= COLS; x++) {
    ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, ROWS * CELL); ctx.stroke();
  }
  for (let y = 0; y <= ROWS; y++) {
    ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(COLS * CELL, y * CELL); ctx.stroke();
  }

  // セル
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (board[y][x] !== EMPTY)
        drawCell(ctx, x, y, board[y][x], CELL, { marked: marked[y][x] });

  // 落下ピース
  if (current) {
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 2; c++) {
        const by = current.y + r;
        if (by >= 0) drawCell(ctx, current.x + c, by, current.cells[r][c], CELL);
      }
  }

  // タイムライン（音楽同期の連続位置で滑らかに）
  if (running && !gameOver) {
    const frac = timelineBeat * 2 % 1; // 8分の途中位置
    const colf = timelineCol + frac;
    if (colf >= 0 && colf < COLS) {
      const tx = colf * CELL;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const g = ctx.createLinearGradient(tx - 16, 0, tx + 16, 0);
      g.addColorStop(0, "rgba(53,200,255,0)");
      g.addColorStop(0.5, "rgba(53,200,255,0.35)");
      g.addColorStop(1, "rgba(53,200,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(tx - 16, 0, 32, ROWS * CELL);
      ctx.fillStyle = "#8fe3ff";
      ctx.fillRect(tx - 1.5, 0, 3, ROWS * CELL);
      ctx.restore();
    }
  }

  // パーティクル等
  Effects.drawForeground(ctx, canvas.width, canvas.height);

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
    for (let c = 0; c < 2; c++) {
      const col = COLORS[nextPiece[r][c]];
      const grad = nextCtx.createLinearGradient(0, offY + r * size, 0, offY + r * size + size);
      grad.addColorStop(0, col.light);
      grad.addColorStop(1, col.base);
      nextCtx.fillStyle = grad;
      roundRect(nextCtx, offX + c * size + 2, offY + r * size + 2, size - 4, size - 4, 6);
      nextCtx.fill();
    }
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

  // 背景（常時）
  Effects.drawBackground(bgCtx, bgCanvas.width, bgCanvas.height, dt, beat);

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
    case "ArrowUp": rotate(); e.preventDefault(); break;
    case "ArrowDown": softDrop = true; e.preventDefault(); break;
    case " ": hardDrop(); e.preventDefault(); break;
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
  // 盤面を指定パターンで直接セット（テスト専用）
  setBoard(grid) {
    board = grid.map((row) => row.slice());
    markMatches();
    updateHud();
  },
  // 1スイープ分タイムラインを端まで走らせる（同期・即時）
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
// 開始前でも背景を見せるため board も一度描画
board = makeGrid(EMPTY);
marked = makeGrid(false);
current = null;
nextPiece = randomCells();
drawNext();
requestAnimationFrame(loop);
