/*
 * ルミナス風パズル — コアゲーム
 * HTML + Canvas + Vanilla JS（ビルド不要）
 *
 * ルール:
 *  - 2色の 2x2 ブロックが上から落下
 *  - 同じ色が 2x2 の正方形になると「消去待ち」フラグが付く
 *  - 左→右へ動くタイムラインが通過した列で、フラグの付いたセルが消える
 *  - 消えた後、上のセルは下へ落ちる
 *  - 積み上がるとゲームオーバー
 */

// ===== 定数 =====
const COLS = 16;
const ROWS = 10;
const CELL = 32;

const EMPTY = 0;
const COLOR_A = 1; // 青系
const COLOR_B = 2; // オレンジ系

const COLORS = {
  [COLOR_A]: { base: "#1f6feb", light: "#58a6ff", glow: "rgba(88,166,255,0.6)" },
  [COLOR_B]: { base: "#bd561d", light: "#f0883e", glow: "rgba(240,136,62,0.6)" },
};

// 速度設定（ミリ秒）
const GRAVITY_INTERVAL = 600;   // ピースが1マス落ちる間隔
const SOFT_DROP_INTERVAL = 50;  // ↓押下中の落下間隔
const TIMELINE_INTERVAL = 180;  // タイムラインが1列進む間隔

// ===== 状態 =====
let board;            // ROWS x COLS、各セルは EMPTY/COLOR_A/COLOR_B
let marked;           // ROWS x COLS、消去待ちフラグ（true/false）
let current;          // 落下中ピース { x, y, cells:[[tl,tr],[bl,br]] } ※ y は上段の行
let nextPiece;        // 次のピースの cells
let score;
let maxCombo;
let combo;            // 連続消去カウント
let gameOver;
let paused;
let softDrop;         // ↓押下中フラグ

let timelineCol;      // タイムラインの現在列（-1 = 盤面外で待機）
let clearedThisSweep; // 現在のスイープ中に何か消したか
let gravityTimer;
let timelineTimer;
let lastTime;

// ===== Canvas =====
const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const nextCanvas = document.getElementById("next");
const nextCtx = nextCanvas.getContext("2d");

const scoreEl = document.getElementById("score");
const maxComboEl = document.getElementById("max-combo");
const overlayEl = document.getElementById("overlay");
const overlayScoreEl = document.getElementById("overlay-score");
const overlayTitleEl = document.getElementById("overlay-title");

// ===== 初期化 =====
function makeGrid(fill) {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(fill));
}

function randomCells() {
  const rnd = () => (Math.random() < 0.5 ? COLOR_A : COLOR_B);
  return [
    [rnd(), rnd()],
    [rnd(), rnd()],
  ];
}

function init() {
  board = makeGrid(EMPTY);
  marked = makeGrid(false);
  score = 0;
  maxCombo = 0;
  combo = 0;
  gameOver = false;
  paused = false;
  softDrop = false;
  timelineCol = -1;
  clearedThisSweep = false;
  nextPiece = randomCells();
  gravityTimer = 0;
  timelineTimer = 0;
  lastTime = performance.now();
  spawnPiece();
  updateHud();
  overlayEl.classList.add("hidden");
}

// ===== ピース生成 =====
function spawnPiece() {
  const startX = Math.floor(COLS / 2) - 1;
  current = { x: startX, y: -2, cells: nextPiece };
  nextPiece = randomCells();
  drawNext();

  // 出現位置（上段）が既に埋まっていればゲームオーバー
  // current.y を 0 まで進める途中で衝突する場合を判定
  if (collides(current.x, 0, current.cells)) {
    // 盤面上端2行に隙間が無い場合
    if (board[0][startX] !== EMPTY || board[0][startX + 1] !== EMPTY) {
      endGame();
    }
  }
}

// ===== 衝突判定 =====
// 指定位置に 2x2 ピースを置けるか（はみ出し / 既存セルとの重なり）
function collides(x, y, cells) {
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const bx = x + c;
      const by = y + r;
      if (bx < 0 || bx >= COLS) return true;        // 左右の壁
      if (by >= ROWS) return true;                  // 底
      if (by >= 0 && board[by][bx] !== EMPTY) return true; // 既存セル
    }
  }
  return false;
}

// ===== 入力操作 =====
function move(dx) {
  if (!current || gameOver || paused) return;
  if (!collides(current.x + dx, current.y, current.cells)) {
    current.x += dx;
  }
}

function rotate() {
  if (!current || gameOver || paused) return;
  // 2x2 を時計回りに回転
  const c = current.cells;
  const rotated = [
    [c[1][0], c[0][0]],
    [c[1][1], c[0][1]],
  ];
  if (!collides(current.x, current.y, rotated)) {
    current.cells = rotated;
  }
}

function hardDrop() {
  if (!current || gameOver || paused) return;
  while (!collides(current.x, current.y + 1, current.cells)) {
    current.y++;
  }
  lockPiece();
}

// ピースを1マス落とす。落とせなければ固定
function stepDown() {
  if (!collides(current.x, current.y + 1, current.cells)) {
    current.y++;
  } else {
    lockPiece();
  }
}

// ===== ピース固定 =====
function lockPiece() {
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const bx = current.x + c;
      const by = current.y + r;
      if (by < 0) {
        // 盤外上端で固定 = ゲームオーバー
        endGame();
        return;
      }
      board[by][bx] = current.cells[r][c];
    }
  }
  current = null;
  settleColumns();
  markMatches();
  spawnPiece();
}

// ===== 重力: 各列のセルを下へ詰める =====
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

// ===== マッチ判定: 全 2x2 をスキャンし同色をフラグ =====
function markMatches() {
  marked = makeGrid(false);
  for (let y = 0; y < ROWS - 1; y++) {
    for (let x = 0; x < COLS - 1; x++) {
      const v = board[y][x];
      if (
        v !== EMPTY &&
        board[y][x + 1] === v &&
        board[y + 1][x] === v &&
        board[y + 1][x + 1] === v
      ) {
        marked[y][x] = true;
        marked[y][x + 1] = true;
        marked[y + 1][x] = true;
        marked[y + 1][x + 1] = true;
      }
    }
  }
}

// ===== タイムライン進行 =====
function advanceTimeline() {
  timelineCol++;
  if (timelineCol >= COLS) {
    // 1スイープ完了。このスイープで何も消えなかったらコンボリセット
    timelineCol = -1;
    if (!clearedThisSweep) combo = 0;
    clearedThisSweep = false;
    return;
  }

  // 現在列のフラグ付きセルを消去
  let cleared = 0;
  for (let y = 0; y < ROWS; y++) {
    if (marked[y][timelineCol] && board[y][timelineCol] !== EMPTY) {
      board[y][timelineCol] = EMPTY;
      marked[y][timelineCol] = false;
      cleared++;
    }
  }

  if (cleared > 0) {
    clearedThisSweep = true;
    combo++;
    if (combo > maxCombo) maxCombo = combo;

    // スコア: 基本点 + コンボ倍率 + 3個以上ボーナス
    let points = cleared * 10 * combo;
    if (cleared >= 3) points += 50; // BONUS
    score += points;

    settleColumns();
    markMatches();
    updateHud();
  }
}

// ===== HUD更新 =====
function updateHud() {
  scoreEl.textContent = score;
  maxComboEl.textContent = maxCombo;
}

// ===== ゲームオーバー =====
function endGame() {
  gameOver = true;
  current = null;
  overlayTitleEl.textContent = "GAME OVER";
  overlayScoreEl.textContent = "SCORE: " + score;
  overlayEl.classList.remove("hidden");
}

// ===== 描画 =====
function drawCell(context, x, y, color, size, opts = {}) {
  const col = COLORS[color];
  const px = x * size;
  const py = y * size;
  context.fillStyle = col.base;
  context.fillRect(px + 1, py + 1, size - 2, size - 2);
  // 上部ハイライト
  context.fillStyle = col.light;
  context.fillRect(px + 1, py + 1, size - 2, 4);
  // マーク中はグロー枠
  if (opts.marked) {
    context.strokeStyle = "#ffffff";
    context.lineWidth = 2;
    context.strokeRect(px + 2, py + 2, size - 4, size - 4);
  }
}

function render() {
  // 背景
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // グリッド線
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= COLS; x++) {
    ctx.beginPath();
    ctx.moveTo(x * CELL, 0);
    ctx.lineTo(x * CELL, ROWS * CELL);
    ctx.stroke();
  }
  for (let y = 0; y <= ROWS; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * CELL);
    ctx.lineTo(COLS * CELL, y * CELL);
    ctx.stroke();
  }

  // 盤面セル
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (board[y][x] !== EMPTY) {
        drawCell(ctx, x, y, board[y][x], CELL, { marked: marked[y][x] });
      }
    }
  }

  // 落下中ピース
  if (current) {
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const by = current.y + r;
        if (by >= 0) {
          drawCell(ctx, current.x + c, by, current.cells[r][c], CELL);
        }
      }
    }
  }

  // タイムライン
  if (timelineCol >= 0 && timelineCol < COLS) {
    const tx = timelineCol * CELL;
    ctx.fillStyle = "rgba(88,166,255,0.18)";
    ctx.fillRect(tx, 0, CELL, ROWS * CELL);
    ctx.fillStyle = "#58a6ff";
    ctx.fillRect(tx, 0, 3, ROWS * CELL);
  }

  // 一時停止表示
  if (paused && !gameOver) {
    ctx.fillStyle = "rgba(5,7,11,0.7)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#e6edf3";
    ctx.font = "bold 28px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("PAUSE", canvas.width / 2, canvas.height / 2);
    ctx.textAlign = "left";
  }
}

function drawNext() {
  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  const size = 36;
  const offX = (nextCanvas.width - size * 2) / 2;
  const offY = (nextCanvas.height - size * 2) / 2;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const col = COLORS[nextPiece[r][c]];
      nextCtx.fillStyle = col.base;
      nextCtx.fillRect(offX + c * size + 1, offY + r * size + 1, size - 2, size - 2);
      nextCtx.fillStyle = col.light;
      nextCtx.fillRect(offX + c * size + 1, offY + r * size + 1, size - 2, 4);
    }
  }
}

// ===== ゲームループ =====
function loop(now) {
  const dt = now - lastTime;
  lastTime = now;

  if (!gameOver && !paused) {
    // 重力
    gravityTimer += dt;
    const interval = softDrop ? SOFT_DROP_INTERVAL : GRAVITY_INTERVAL;
    if (gravityTimer >= interval) {
      gravityTimer = 0;
      if (current) stepDown();
    }

    // タイムライン
    timelineTimer += dt;
    if (timelineTimer >= TIMELINE_INTERVAL) {
      timelineTimer = 0;
      advanceTimeline();
    }
  }

  render();
  requestAnimationFrame(loop);
}

// ===== キーボード入力 =====
document.addEventListener("keydown", (e) => {
  switch (e.key) {
    case "ArrowLeft":
      move(-1);
      e.preventDefault();
      break;
    case "ArrowRight":
      move(1);
      e.preventDefault();
      break;
    case "ArrowUp":
      rotate();
      e.preventDefault();
      break;
    case "ArrowDown":
      softDrop = true;
      e.preventDefault();
      break;
    case " ":
      hardDrop();
      e.preventDefault();
      break;
    case "r":
    case "R":
      init();
      break;
    case "p":
    case "P":
      if (!gameOver) paused = !paused;
      break;
  }
});

document.addEventListener("keyup", (e) => {
  if (e.key === "ArrowDown") softDrop = false;
});

// ===== 起動 =====
init();
requestAnimationFrame(loop);
