/*
 * Effects v4 — 3D メトロポリスをドローンで駆け抜ける背景 + 前景エフェクト
 *
 * 背景は Canvas 2D 上の自前パースペクティブ投影による立体都市:
 *   1. 空グラデ + 星（カメラのロールに追従）
 *   2. 地面のワイヤーグリッド（Rez 的な「網の中」）
 *   3. ビル群を直方体として投影。正面は窓テクスチャをアフィン変換で貼り、
 *      側面は暗く落として立体化。稜線はビートで明滅し、屋上に航空障害灯。
 *   4. z の周期で建物をリサイクルして無限に続く都市にする
 *   5. 前方の霞 / 放射状スピードライン / 走査線 / カラーグレード
 *
 * カメラ(ドローン)は前進しながら左右に蛇行・上下に揺れ、旋回方向へバンクする。
 *
 * 前景: ガラス片 / グロー粒子 / リング / 亀裂状の光柱 / 加点フロート / フラッシュ
 * バナー(COMBO/BONUS/LEVEL/BURST)はコマを隠さないよう盤面の外側に描く。
 */
const Effects = (() => {
  "use strict";

  const TAU = Math.PI * 2;
  const rand = (a, b) => a + Math.random() * (b - a);
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ===== 色ユーティリティ =====
  function toRGB(col) {
    if (typeof col !== "string") return [255, 255, 255];
    if (col.charCodeAt(0) === 35) { // '#'
      let s = col.slice(1);
      if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
      const n = parseInt(s, 16) | 0;
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const m = col.match(/-?\d+(\.\d+)?/g);
    if (m && m.length >= 3) return [+m[0], +m[1], +m[2]];
    return [255, 255, 255];
  }
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  // スプライトキャッシュ用に色を量子化（毎フレーム微変化する色でキャッシュが膨れるのを防ぐ）
  const qkey = (c) => `rgba(${(c[0] / 24 | 0) * 24},${(c[1] / 24 | 0) * 24},${(c[2] / 24 | 0) * 24},1)`;
  function mix(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  }
  function makeCanvas(w, h) {
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, w | 0); cv.height = Math.max(1, h | 0);
    return cv;
  }

  // ===== プリレンダー・スプライト（毎フレームの createRadialGradient を回避）=====
  const glowCache = new Map();
  function glowSprite(color) {
    let s = glowCache.get(color);
    if (s) return s;
    const R = 32, c = toRGB(color);
    const cv = makeCanvas(R * 2, R * 2), g2 = cv.getContext("2d");
    const g = g2.createRadialGradient(R, R, 0, R, R, R);
    g.addColorStop(0.0, rgba(c, 1));
    g.addColorStop(0.28, rgba(c, 0.42));
    g.addColorStop(0.65, rgba(c, 0.09));
    g.addColorStop(1.0, rgba(c, 0));
    g2.fillStyle = g; g2.fillRect(0, 0, R * 2, R * 2);
    glowCache.set(color, cv);
    return cv;
  }
  // 被写界深度ボケ（縁が明るい実写的な玉ボケ）
  const bokehCache = new Map();
  function bokehSprite(color) {
    let s = bokehCache.get(color);
    if (s) return s;
    const R = 32, c = toRGB(color);
    const cv = makeCanvas(R * 2, R * 2), g2 = cv.getContext("2d");
    const g = g2.createRadialGradient(R, R, 0, R, R, R);
    g.addColorStop(0.0, rgba(c, 0.34));
    g.addColorStop(0.60, rgba(c, 0.30));
    g.addColorStop(0.88, rgba(c, 0.50));
    g.addColorStop(0.97, rgba(c, 0.16));
    g.addColorStop(1.0, rgba(c, 0));
    g2.fillStyle = g; g2.fillRect(0, 0, R * 2, R * 2);
    bokehCache.set(color, cv);
    return cv;
  }

  // ===== 前景の状態 =====
  const particles = [];
  const shards = [];
  const rings = [];
  const popups = [];
  const columns = [];
  let flash = 0;
  let shake = 0;

  // ===== 前景の生成 API =====
  function burst(x, y, color, n = 14, power = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = rand(50, 240) * power;
      particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 50,
        life: rand(0.4, 1.0), age: 0, r: rand(1.5, 4), color,
      });
    }
  }

  // ガラス／金属質の破片（多面体・稜線あり）
  function shatter(x, y, color, n = 6, power = 1) {
    const c = toRGB(color);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = rand(60, 210) * power;
      shards.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 90,
        rot: Math.random() * Math.PI, vr: rand(-9, 9),
        size: rand(5, 12), skew: rand(0.45, 1),
        life: rand(0.5, 0.95), age: 0,
        face: rgba(c, 1), edge: rgba(mix(c, [255, 255, 255], 0.75), 1),
      });
    }
  }

  function ring(x, y, color, maxR = 60) {
    rings.push({ x, y, r: 6, maxR, life: 0.5, age: 0, color });
  }

  // 消去列に走る「亀裂」状の光柱（色は "rgba(r,g,b,ALPHA)" 形式）
  function column(x, w, h, color) {
    columns.push({ x, w, h, color, life: 0.5, age: 0, seed: Math.random() * 100 });
  }

  function popup(x, y, text, color, big = false) {
    popups.push({ x, y, text, color, life: 1.2, age: 0, big });
  }

  // 加点のフロート表示（消えた場所から数字が舞い上がる）
  const floats = [];
  // コマを隠さないよう、速く上へ抜けて短く消える
  function scorePop(x, y, text, color, scale = 1) {
    floats.push({
      x, y, text, color, scale,
      vx: (Math.random() - 0.5) * 30, vy: -132 - Math.random() * 40,
      life: 0.62, age: 0,
    });
  }

  // 範囲の強調（BURST が薙ぎ払った領域など「何が起きたか」を見せる）
  const zones = [];
  function zone(x, y, w, h, color) {
    zones.push({ x, y, w, h, color, life: 0.9, age: 0 });
  }

  function screenFlash(v) { flash = Math.max(flash, v); }
  function screenShake(v) { shake = Math.max(shake, v); }

  // ===== 更新 =====
  function update(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) { particles.splice(i, 1); continue; }
      p.vy += 240 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (let i = shards.length - 1; i >= 0; i--) {
      const s = shards[i];
      s.age += dt;
      if (s.age >= s.life) { shards.splice(i, 1); continue; }
      s.vy += 430 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.rot += s.vr * dt;
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.age += dt;
      if (r.age >= r.life) { rings.splice(i, 1); continue; }
      const t = r.age / r.life;
      r.r = 6 + (r.maxR - 6) * (1 - Math.pow(1 - t, 3)); // 鋭く出て減速
    }
    for (let i = columns.length - 1; i >= 0; i--) {
      const c = columns[i];
      c.age += dt;
      if (c.age >= c.life) columns.splice(i, 1);
    }
    for (let i = popups.length - 1; i >= 0; i--) {
      const p = popups[i];
      p.age += dt;
      if (p.age >= p.life) { popups.splice(i, 1); continue; }
      p.y -= (p.big ? 12 : 28) * dt;
    }
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i];
      f.age += dt;
      if (f.age >= f.life) { floats.splice(i, 1); continue; }
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.vy += 118 * dt;   // 上昇して失速する
      f.vx *= 1 - 1.6 * dt;
    }
    for (let i = zones.length - 1; i >= 0; i--) {
      const z = zones[i];
      z.age += dt;
      if (z.age >= z.life) zones.splice(i, 1);
    }
    updateBanners(dt);
    if (flash > 0) flash = Math.max(0, flash - dt * 2.4);
    if (shake > 0) shake = Math.max(0, shake - dt * 42);
  }

  // ===== 前景描画 =====
  function drawForeground(ctx, w, h) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // 亀裂状の光柱：鋭い白コア + 色収差のズレたスライス
    for (const c of columns) {
      const t = 1 - c.age / c.life;
      const cw = c.w;
      // 外側のにじみ
      ctx.fillStyle = c.color.replace("ALPHA", (0.10 * t).toFixed(3));
      ctx.fillRect(c.x - cw * 0.9, 0, cw * 1.8, c.h);
      // 亀裂：ランダムな高さで左右にズレるスライス
      const slices = 9;
      for (let i = 0; i < slices; i++) {
        const y0 = (i / slices) * c.h;
        const hh = c.h / slices;
        const off = Math.sin(c.seed + i * 2.7) * cw * 0.55 * (1 - t);
        ctx.fillStyle = c.color.replace("ALPHA", (0.30 * t).toFixed(3));
        ctx.fillRect(c.x - cw * 0.16 + off, y0, cw * 0.32, hh);
      }
      // コア（細く鋭い白）
      ctx.fillStyle = `rgba(255,255,255,${(0.85 * t).toFixed(3)})`;
      ctx.fillRect(c.x - 1, 0, 2, c.h);
    }

    // グロー粒子（プリレンダー・スプライト）
    for (const p of particles) {
      const t = 1 - p.age / p.life;
      ctx.globalAlpha = t * t;
      const rr = (p.r * t + 0.6) * 3.4;
      const sp = glowSprite(p.color);
      ctx.drawImage(sp, p.x - rr, p.y - rr, rr * 2, rr * 2);
    }
    ctx.globalAlpha = 1;

    // ガラス片（2面のファセット + 稜線）
    ctx.globalCompositeOperation = "source-over";
    for (const s of shards) {
      const t = 1 - s.age / s.life;
      ctx.save();
      ctx.globalAlpha = clamp(t * 1.3, 0, 1);
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      const sz = s.size * (0.45 + 0.55 * t), hz = sz / 2, sk = hz * s.skew;
      // 面 A
      ctx.beginPath();
      ctx.moveTo(0, -hz); ctx.lineTo(sk, 0); ctx.lineTo(0, hz); ctx.closePath();
      ctx.fillStyle = s.face; ctx.fill();
      // 面 B（反射で明るい）
      ctx.beginPath();
      ctx.moveTo(0, -hz); ctx.lineTo(0, hz); ctx.lineTo(-sk, 0.15 * hz); ctx.closePath();
      ctx.fillStyle = s.edge; ctx.globalAlpha *= 0.7; ctx.fill();
      // 稜線
      ctx.globalAlpha = clamp(t, 0, 1);
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 0.9;
      ctx.beginPath(); ctx.moveTo(0, -hz); ctx.lineTo(0, hz); ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // 衝撃リング（細く鋭い）
    ctx.globalCompositeOperation = "lighter";
    for (const r of rings) {
      const t = 1 - r.age / r.life;
      ctx.globalAlpha = t * t * 0.9;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 1 + 2 * t;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, TAU); ctx.stroke();
      ctx.globalAlpha = t * 0.35;
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r * 1.35, 0, TAU); ctx.stroke();
    }
    ctx.restore();

    // 大型タイポグラフィ（半透明・ズラして重なる）
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const ls = "letterSpacing" in ctx;
    for (const p of popups) {
      const t = 1 - p.age / p.life;
      const pop = 1 - Math.pow(1 - Math.min(1, p.age * 6), 2);
      const size = p.big ? 62 : 22;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(p.big ? lerp(1.35, 1.0, pop) : 1, p.big ? lerp(1.35, 1.0, pop) : 1);
      if (ls) ctx.letterSpacing = p.big ? "10px" : "4px";
      ctx.font = `${p.big ? 200 : 600} ${size}px "Helvetica Neue", "Arial Narrow", Arial, system-ui, sans-serif`;
      if (p.big) {
        // ズレて重なる残像（本家のオーバーレイ表現）
        ctx.globalAlpha = t * 0.16;
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, -10 * (1 - pop) - 6, -4);
        ctx.fillText(p.text, 10 * (1 - pop) + 6, 4);
        ctx.globalAlpha = t * 0.5;
        ctx.strokeStyle = p.color; ctx.lineWidth = 1;
        ctx.strokeText(p.text, 0, 0);
        ctx.globalAlpha = Math.min(1, t * 1.4);
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.fillText(p.text, 0, 0);
      } else {
        ctx.globalAlpha = Math.min(1, t * 1.8);
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color; ctx.shadowBlur = 18;
        ctx.fillText(p.text, 0, 0);
      }
      if (ls) ctx.letterSpacing = "0px";
      ctx.restore();
    }

    // 加点フロート（爽快感の核。弾んで出て、光りながら舞い上がる）
    for (const f of floats) {
      const t = 1 - f.age / f.life;
      const pop = 1 - Math.pow(1 - Math.min(1, f.age * 9), 3);   // 出た瞬間に弾む
      const sc = f.scale * (0.5 + pop * 0.72);
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.scale(sc, sc);
      ctx.font = `800 19px "Helvetica Neue", Arial, system-ui, sans-serif`;
      ctx.globalAlpha = Math.min(1, t * 2.2);
      // 縁取りで背景に負けないようにする
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.strokeText(f.text, 0, 0);
      ctx.shadowColor = f.color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(f.text, 0, 0);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = Math.min(1, t * 2.2) * 0.85;
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, 0, 0);
      ctx.restore();
    }
    ctx.restore();

    // 範囲の強調（BURST の薙ぎ払い領域）
    for (const z of zones) {
      const t = 1 - z.age / z.life;
      const e = 1 - Math.pow(1 - z.age / z.life, 2);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = t;
      const g = ctx.createLinearGradient(0, z.y, 0, z.y + z.h);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.5, z.color);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(z.x, z.y, z.w, z.h);
      // 領域を左→右へ走る光の刃
      const sx = z.x + z.w * e;
      const blade = ctx.createLinearGradient(sx - 60, 0, sx, 0);
      blade.addColorStop(0, "rgba(255,255,255,0)");
      blade.addColorStop(1, `rgba(255,255,255,${(t * 0.85).toFixed(3)})`);
      ctx.fillStyle = blade;
      ctx.fillRect(sx - 60, z.y, 60, z.h);
      ctx.strokeStyle = `rgba(255,255,255,${(t * 0.9).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(z.x, z.y, z.w, z.h);
      ctx.restore();
    }

    if (flash > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `rgba(200,235,255,${flash * 0.42})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  function getShake() {
    if (shake <= 0) return { x: 0, y: 0 };
    return { x: rand(-shake, shake), y: rand(-shake, shake) };
  }

  // =========================================================================
  //  背景：3D メトロポリスをドローンで駆け抜ける
  //
  //  実装は Canvas 2D 上の自前パースペクティブ投影。
  //   - ビル群を直方体としてワールド座標に配置し、z の周期でリサイクル（無限都市）
  //   - カメラ(ドローン)は前進しながら左右に蛇行・上下に揺れ、旋回方向へバンクする
  //   - 遠景はフォグで空に溶かし、近景ほど窓・稜線がはっきり出る
  //   - 面はプリレンダーした窓テクスチャをアフィン変換で貼る（毎フレームの点描を回避）
  // =========================================================================

  // セクション別のトーン。BGM の section() が返す 0..4 に 1:1 対応させる。
  // Rez Infinite Area 1 の実測に準拠:
  //   明色の色相は 赤(0-30°) 63.6% / 桃 8.3% / シアン・青 19%、平均輝度 0.133 と極端に暗い。
  //   色相の推移は シアン(205°) → 赤(10-18°)が本編の大半 → 緑(136°) → 桃(346°) → 青(245°)。
  //   dens=光量/密度, cam=ドローンの機動の激しさ, grid=前進速度の倍率
  const SECTIONS = [
    // 0 イントロ: 冷たいシアン（Rez の導入部 205°）。低速でゆったり巡航
    { accent: [72, 186, 255], sub: [255, 96, 72], warm: [170, 214, 255], sky: [3, 7, 14],  dens: 0.70, cam: 0.40, grid: 0.55 },
    // 1 ビルド: 赤へ傾く琥珀（30-40°）
    { accent: [255, 146, 52], sub: [90, 190, 255], warm: [255, 198, 140], sky: [12, 6, 6],  dens: 1.10, cam: 0.85, grid: 1.00 },
    // 2 ドロップ: 錆びた赤 = 本編の支配色（12°）。低空を高速で突っ切る
    { accent: [255, 68, 44], sub: [64, 208, 255], warm: [255, 150, 110], sky: [14, 4, 4],   dens: 1.65, cam: 1.45, grid: 1.90 },
    // 3 ブレイク: 翠（136-159°）。上空へ抜けて静まる
    { accent: [56, 240, 168], sub: [255, 92, 72], warm: [170, 255, 214], sky: [2, 10, 9],   dens: 0.50, cam: 0.28, grid: 0.38 },
    // 4 ラストドロップ: 桃(346°) と 青(245°) が混ざる終盤。最高速
    { accent: [255, 74, 150], sub: [96, 120, 255], warm: [255, 176, 208], sky: [10, 4, 14], dens: 2.00, cam: 1.85, grid: 2.40 },
  ];

  let bgW = 0, bgH = 0, bgInit = false;
  let halfW = 0, halfH = 0;
  let time = 0, prevBeat = 0, beatCount = 0, barPulse = 0;
  const stars = [];
  let curAccent = SECTIONS[0].accent.slice();
  let curSub = SECTIONS[0].sub.slice();
  let curSky = SECTIONS[0].sky.slice();
  let curDens = 1, curCam = 0.4, curGrid = 0.55;
  let prevSecId = -1;
  let secFlash = 0;
  let burstReadyOn = false, burstReadyT = 0;
  let quality = 1;                 // 実行時に自動調整される描画品質 0.45..1
  function setQuality(q) { quality = Math.max(0.3, Math.min(1, q)); }

  // ===== レベル連動 =====
  // レベルが上がるほど都市の色相がずれ、飛行速度が増して「world が変わった」感を出す。
  let levelNo = 1, levelHue = 0, levelSpeed = 1, levelSurge = 0;
  function setLevel(n) {
    levelNo = Math.max(1, n | 0);
    levelHue = ((levelNo - 1) * 26) % 360;      // 1段ごとに色相を26度ずらす
    levelSpeed = 1 + Math.min(0.9, (levelNo - 1) * 0.06);
  }
  function levelUpSurge() { levelSurge = 1; }

  // RGB を色相回転（レベルごとの世界の変化に使う）
  function hueRot(c, deg) {
    if (!deg) return c;
    const a = deg * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
    // YIQ 近似の色相回転行列
    const m = [
      0.299 + 0.701 * cs + 0.168 * sn, 0.587 - 0.587 * cs + 0.330 * sn, 0.114 - 0.114 * cs - 0.497 * sn,
      0.299 - 0.299 * cs - 0.328 * sn, 0.587 + 0.413 * cs + 0.035 * sn, 0.114 - 0.114 * cs + 0.292 * sn,
      0.299 - 0.300 * cs + 1.250 * sn, 0.587 - 0.588 * cs - 1.050 * sn, 0.114 + 0.886 * cs - 0.203 * sn,
    ];
    const r = c[0], g = c[1], b = c[2];
    return [
      Math.max(0, Math.min(255, m[0] * r + m[1] * g + m[2] * b)),
      Math.max(0, Math.min(255, m[3] * r + m[4] * g + m[5] * b)),
      Math.max(0, Math.min(255, m[6] * r + m[7] * g + m[8] * b)),
    ];
  }

  // ===== ドローン（カメラ） =====
  const FOCAL = 560;          // 焦点距離（小さいほど広角＝ドローンらしい画角）
  const CITY_DEPTH = 4200;    // z 方向の周期
  const LANE_HALF = 430;      // 中央通路の半幅（ここを縫うように飛ぶ）
  const NEAR_FADE = 520;      // これより近い建物は溶けて消える（壁になるのを防ぐ）
  const FAR = 3600;           // 描画する最遠 z
  const BASE_SPEED = 420;     // 前進速度 (unit/s)
  const N_BUILDINGS = 190;
  const WIN_W = 26, WIN_H = 32;   // 窓1つのワールドサイズ（建物ごとに枚数が変わる）

  let camZ = 0, camX = 0, camY = 215, camRoll = 0;
  let camXPrev = 0;

  const buildings = [];
  function makeBuilding(z) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const w = 70 + Math.random() * 150;
    const d = 70 + Math.random() * 150;
    return {
      x: side * (LANE_HALF + w * 0.5 + Math.random() * 1500),
      z, w, d,
      // 低層を多めに、たまに超高層（分布に偏りを付ける）
      h: 140 + Math.pow(Math.random(), 1.7) * 1050,
      variant: (Math.random() * 6) | 0,
      lit: 0.25 + Math.random() * 0.5,
      spire: Math.random() < 0.22,
    };
  }
  function initCity() {
    buildings.length = 0;
    for (let i = 0; i < N_BUILDINGS; i++) buildings.push(makeBuilding(Math.random() * CITY_DEPTH));
    camZ = 0; camX = 0; camY = 215; camRoll = 0; camXPrev = 0;
  }

  // ===== 窓テクスチャ（ビルの外壁。6種 × 色でキャッシュ） =====
  const TEX_W = 64, TEX_H = 256;
  const TEX_COLS = 5, TEX_ROWS = 26;   // テクスチャ内の窓の枚数
  const facadeCache = new Map();
  const patCache = new Map();
  function facadeTex(variant, colorKey, accent) {
    const key = variant + "|" + colorKey;
    let cv = facadeCache.get(key);
    if (cv) return cv;
    cv = makeCanvas(TEX_W, TEX_H);
    const c = cv.getContext("2d");
    // 壁面はほぼ黒（Rez の平均輝度 0.133 に合わせて暗く保つ）
    c.fillStyle = "rgba(4,5,9,0.93)";
    c.fillRect(0, 0, TEX_W, TEX_H);

    const cols = TEX_COLS, rows = TEX_ROWS;
    const gw = TEX_W / cols, gh = TEX_H / rows;
    // variant ごとに決まったパターンを作る（毎回同じ見た目になるよう疑似乱数）
    let seed = variant * 7919 + 13;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        const v = rnd();
        if (v > 0.62) continue;                    // 消灯
        const bright = v < 0.12 ? 1 : v < 0.3 ? 0.6 : 0.32;
        const warmWin = rnd() < 0.34;
        const col = warmWin ? [255, 214, 150] : accent;
        c.fillStyle = rgba(col, 0.14 + bright * 0.55);
        c.fillRect(cc * gw + gw * 0.22, r * gh + gh * 0.24, gw * 0.56, gh * 0.44);
      }
    }
    facadeCache.set(key, cv);
    if (facadeCache.size > 40) {                   // 色替わりで無限に増えないよう間引く
      const first = facadeCache.keys().next().value;
      if (first !== key) facadeCache.delete(first);
    }
    return cv;
  }

  // タイリング用パターン（テクスチャと同じキーでキャッシュ）
  function facadePattern(ctx, variant, colorKey, accent) {
    const key = variant + "|" + colorKey;
    let p = patCache.get(key);
    if (!p) {
      p = ctx.createPattern(facadeTex(variant, colorKey, accent), "repeat");
      patCache.set(key, p);
      if (patCache.size > 40) patCache.delete(patCache.keys().next().value);
    }
    return p;
  }

  // ===== 投影 =====
  // ワールド (px:横, py:高さ, pz:奥行) → 画面。カメラのロールを適用する。
  function proj(px, py, pz) {
    const dz = pz - camZ;
    if (dz < 14) return null;
    const f = FOCAL / dz;
    const ex = px - camX, ey = py - camY;
    const cr = Math.cos(camRoll), sr = Math.sin(camRoll);
    return {
      x: halfW + (ex * cr - ey * sr) * f,
      y: halfH - (ex * sr + ey * cr) * f,
      f, dz,
    };
  }

  // 遠いほど空に溶ける。さらに近すぎる建物も溶かして「壁」になるのを防ぐ。
  function fogOf(dz) {
    const t = Math.min(1, Math.max(0, (dz - 300) / (FAR - 300)));
    const far = 1 - t * t;
    const near = Math.min(1, Math.max(0, (dz - 90) / NEAR_FADE));
    return far * near;
  }

  function initBg(w, h) {
    bgW = w; bgH = h;
    halfW = w / 2; halfH = h * 0.56;   // 地平線をやや下に置いて見上げ気味に
    stars.length = 0;
    for (let i = 0; i < 140; i++) {
      stars.push({ x: Math.random() * w, y: Math.random() * h * 0.62, r: rand(0.4, 1.5), ph: Math.random() * TAU });
    }
    if (buildings.length === 0) initCity();
    bgInit = true;
  }

  // ===== 地面のワイヤーグリッド（Rez の「網の中」を担保する） =====
  function drawGround(ctx, pulse, dens) {
    const GZ = 220, GX = 260;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 1;

    // 奥行き方向の横線
    const z0 = Math.floor(camZ / GZ) * GZ;
    for (let i = 1; i < FAR / GZ; i++) {
      const z = z0 + i * GZ;
      const a = proj(-4200, 0, z), b = proj(4200, 0, z);
      if (!a || !b) continue;
      const fog = fogOf(z - camZ);
      ctx.strokeStyle = rgba(curAccent, 0.055 * fog * dens * (1 + pulse * 0.7));
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // 進行方向の縦線
    for (let k = -14; k <= 14; k++) {
      const x = k * GX;
      const a = proj(x, 0, camZ + 40), b = proj(x, 0, camZ + FAR);
      if (!a || !b) continue;
      ctx.strokeStyle = rgba(curAccent, 0.05 * dens);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }

  // ===== ビル1棟 =====
  function drawBuilding(ctx, B, pulse, dens) {
    const x0 = B.x - B.w * 0.5, x1 = B.x + B.w * 0.5;
    const z0 = B.z - B.d * 0.5, z1 = B.z + B.d * 0.5;
    const dz = z0 - camZ;
    const fog = fogOf(dz);
    if (fog <= 0.02) return;

    // 手前面（z0 は常にカメラ側）
    const fTL = proj(x0, B.h, z0), fTR = proj(x1, B.h, z0);
    const fBL = proj(x0, 0, z0), fBR = proj(x1, 0, z0);
    if (!fTL || !fTR || !fBL || !fBR) return;
    // 画面外なら捨てる
    const minX = Math.min(fTL.x, fBL.x), maxX = Math.max(fTR.x, fBR.x);
    if (maxX < -80 || minX > bgW + 80) return;

    // 側面（カメラのある側の面だけ描く）
    let sTA = null, sTB = null, sBA = null, sBB = null;
    if (camX < x0) {
      sTA = fTL; sBA = fBL;
      sTB = proj(x0, B.h, z1); sBB = proj(x0, 0, z1);
    } else if (camX > x1) {
      sTA = fTR; sBA = fBR;
      sTB = proj(x1, B.h, z1); sBB = proj(x1, 0, z1);
    }

    ctx.save();

    // --- 側面: 暗く落として立体感を出す ---
    if (sTB && sBB) {
      ctx.beginPath();
      ctx.moveTo(sTA.x, sTA.y); ctx.lineTo(sTB.x, sTB.y);
      ctx.lineTo(sBB.x, sBB.y); ctx.lineTo(sBA.x, sBA.y);
      ctx.closePath();
      ctx.fillStyle = `rgba(2,3,6,${(0.86 * fog).toFixed(3)})`;
      ctx.fill();
      ctx.strokeStyle = rgba(curAccent, 0.10 * fog * dens);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // --- 正面: 窓テクスチャをタイリングして貼る ---
    // 正面は z 一定なので投影は相似変換になり、テクスチャを正確に載せられる。
    // 窓1つのワールドサイズを固定し、建物の大きさに応じて枚数を変える
    // （引き伸ばすと窓が巨大化して「壁」に見えてしまうため）。
    const rx = Math.max(1, Math.round(B.w / WIN_W) / TEX_COLS);
    const ry = Math.max(1, Math.round(B.h / WIN_H) / TEX_ROWS);
    const spanX = TEX_W * rx, spanY = TEX_H * ry;
    const ux = (fTR.x - fTL.x) / spanX, uy = (fTR.y - fTL.y) / spanX;
    const vx = (fBL.x - fTL.x) / spanY, vy = (fBL.y - fTL.y) / spanY;
    ctx.save();
    ctx.globalAlpha = fog;
    ctx.transform(ux, uy, vx, vy, fTL.x, fTL.y);
    ctx.fillStyle = facadePattern(ctx, B.variant, qkey(curAccent), curAccent);
    ctx.fillRect(0, 0, spanX, spanY);
    ctx.restore();

    // --- 稜線（ネオンの縁取り。近いほど強く、拍で明滅） ---
    const edge = 0.16 + pulse * 0.26 * dens;
    ctx.strokeStyle = rgba(curAccent, edge * fog * B.lit);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(fBL.x, fBL.y); ctx.lineTo(fTL.x, fTL.y);
    ctx.lineTo(fTR.x, fTR.y); ctx.lineTo(fBR.x, fBR.y);
    ctx.stroke();
    // 屋上のライン
    ctx.strokeStyle = rgba(curSub, (edge * 1.3) * fog * B.lit);
    ctx.beginPath();
    ctx.moveTo(fTL.x, fTL.y); ctx.lineTo(fTR.x, fTR.y);
    ctx.stroke();

    // --- 屋上の航空障害灯（拍で点滅） ---
    if (B.spire && fog > 0.25) {
      const tip = proj(B.x, B.h + 60, z0);
      if (tip) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const blink = 0.35 + 0.65 * pulse;
        const r = Math.max(2, 7 * tip.f * 40);
        ctx.globalAlpha = fog * blink;
        ctx.drawImage(glowSprite("rgba(255,70,60,1)"), tip.x - r, tip.y - r, r * 2, r * 2);
        ctx.restore();
        ctx.strokeStyle = rgba(curSub, 0.2 * fog);
        ctx.beginPath();
        ctx.moveTo((fTL.x + fTR.x) / 2, (fTL.y + fTR.y) / 2);
        ctx.lineTo(tip.x, tip.y);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  // ===== 背景本体 =====
  function drawBackground(ctx, w, h, dt, beat, intensity = 1) {
    if (!bgInit || w !== bgW || h !== bgH) { initBg(w, h); if (!bgInit) return; }
    time += dt;

    const pulse = Math.pow(1 - beat, 3);
    if (beat < prevBeat) { beatCount++; if (beatCount % 4 === 0) barPulse = 1; }
    prevBeat = beat;
    barPulse = Math.max(0, barPulse - dt * 1.6);

    // --- セクションの色とドローンの機動を補間 ---
    const secId = (typeof GameAudio !== "undefined" && GameAudio.section
      ? GameAudio.section() : 0) % SECTIONS.length;
    const sec = SECTIONS[secId];
    if (secId !== prevSecId) {
      if (prevSecId >= 0) secFlash = (secId === 2 || secId === 4) ? 1 : 0.45;
      prevSecId = secId;
    }
    secFlash = Math.max(0, secFlash - dt * 1.5);

    const k = Math.min(1, dt * 0.9);
    curAccent = mix(curAccent, hueRot(sec.accent, levelHue), k);
    curSub = mix(curSub, hueRot(sec.sub, levelHue), k);
    curSky = mix(curSky, hueRot(sec.sky, levelHue), k);
    curDens = lerp(curDens, sec.dens * (0.72 + intensity * 0.2), k);
    curCam = lerp(curCam, sec.cam, k);
    curGrid = lerp(curGrid, sec.grid, k);
    const dens = curDens * (1 + secFlash * 0.5);

    // --- ドローンの機動 ---
    // 前進しながら、周期の異なる正弦を重ねて「手飛ばし」らしい不規則な蛇行にする。
    levelSurge = Math.max(0, levelSurge - dt * 1.1);
    // レベルアップ直後は一気に加速して「上がった」ことを体感させる
    camZ += BASE_SPEED * curGrid * levelSpeed * (1 + pulse * 0.12 + levelSurge * 2.4) * dt;
    camXPrev = camX;
    camX = (Math.sin(time * 0.23) * 150 + Math.sin(time * 0.081) * 210) * curCam;
    camY = 215 + Math.sin(time * 0.17) * 70 * curCam + Math.sin(time * 0.41) * 14 * curCam;
    // 旋回方向へバンク（横速度に比例）。ドローンらしさの肝。
    const vx = dt > 0 ? (camX - camXPrev) / dt : 0;
    camRoll = lerp(camRoll, Math.max(-0.34, Math.min(0.34, -vx * 0.0016)), Math.min(1, dt * 3));

    // --- 空 ---
    const skyG = ctx.createLinearGradient(0, 0, 0, h);
    skyG.addColorStop(0, rgba(mix(curSky, [0, 0, 0], 0.45), 1));
    skyG.addColorStop(0.55, rgba(curSky, 1));
    skyG.addColorStop(1, rgba(mix(curSky, curAccent, 0.10), 1));
    ctx.fillStyle = skyG;
    ctx.fillRect(0, 0, w, h);

    // --- 星（ロールに合わせてわずかに回す） ---
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(halfW, halfH);
    ctx.rotate(camRoll * 0.5);
    ctx.translate(-halfW, -halfH);
    for (const s of stars) {
      const tw = 0.4 + 0.6 * Math.sin(time * 1.7 + s.ph);
      ctx.fillStyle = `rgba(200,220,255,${(0.08 + 0.2 * tw).toFixed(3)})`;
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }
    ctx.restore();

    // --- 地面グリッド ---
    drawGround(ctx, pulse, dens);

    // --- ビル群（奥→手前のペインターズ・アルゴリズム） ---
    for (const B of buildings) {
      // 通り過ぎたら前方へ回して無限に続く街にする
      if (B.z - camZ < -260) {
        const nb = makeBuilding(B.z + CITY_DEPTH);
        B.x = nb.x; B.z = nb.z; B.w = nb.w; B.d = nb.d;
        B.h = nb.h; B.variant = nb.variant; B.lit = nb.lit; B.spire = nb.spire;
      }
    }
    const far = FAR * (0.55 + 0.45 * quality);
    let vis = buildings
      .filter((B) => B.z - camZ > 14 && B.z - camZ < far)
      .sort((a, b) => (b.z - a.z));
    // 品質を落とすときは遠くの小さい建物から間引く（vis は奥→手前の順）
    if (quality < 1) vis = vis.slice(Math.floor(vis.length * (1 - quality) * 0.7));
    for (const B of vis) drawBuilding(ctx, B, pulse, dens);

    // --- 放射状のスピードライン（前進感を強調） ---
    {
      const n = Math.round((22 + dens * 26) * quality);
      const reach = Math.max(w, h) * 0.62;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      for (let i = 0; i < n; i++) {
        const seed = Math.sin(i * 12.9898) * 43758.5453;
        const rnd2 = seed - Math.floor(seed);
        const ang = (i / n) * TAU + rnd2 * 0.7 + camRoll;
        const ph = (time * (0.3 + rnd2 * 0.7) * curGrid + rnd2) % 1;
        const r0 = reach * (0.08 + ph * 0.95);
        const len = reach * (0.05 + ph * 0.22) * (0.6 + pulse * 0.9);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const a = (1 - ph) * ph * 4 * (0.14 + pulse * 0.24) * dens;
        if (a <= 0.004) continue;
        ctx.strokeStyle = rgba(rnd2 > 0.82 ? curSub : curAccent, Math.min(0.5, a));
        ctx.lineWidth = 0.6 + rnd2 * 1.5;
        ctx.beginPath();
        ctx.moveTo(halfW + ca * r0, halfH + sa * r0);
        ctx.lineTo(halfW + ca * (r0 + len), halfH + sa * (r0 + len));
        ctx.stroke();
      }
      ctx.restore();
    }

    // --- 走査ライン ---
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = rgba(curAccent, 0.012 + pulse * 0.014);
    const scanY = (time * 90) % h;
    ctx.fillRect(0, scanY, w, 2);
    ctx.fillRect(0, (scanY + h * 0.5) % h, w, 1);
    ctx.restore();

    // --- カラーグレード + 前方の霞（同じ中心の加算なので1パスに統合） ---
    {
      const amb = 0.05 + curDens * 0.05 + pulse * 0.02;
      const gg = ctx.createRadialGradient(halfW, halfH * 1.06, 0, halfW, halfH, Math.max(w, h) * 0.74);
      // 中心寄りを厚くして「前方の霞」も兼ねる
      gg.addColorStop(0.0, rgba(curAccent, amb * 1.35 + 0.10 + pulse * 0.05));
      gg.addColorStop(0.30, rgba(curAccent, amb * 0.95 + 0.035));
      gg.addColorStop(0.55, rgba(curAccent, amb * 0.68));
      gg.addColorStop(1.0, rgba(curAccent, amb * 0.18));
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = gg;
      ctx.fillRect(0, 0, w, h);
      const sg = ctx.createLinearGradient(0, 0, w, h);
      sg.addColorStop(0, rgba(curSub, amb * 0.18));
      sg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = sg;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    // --- レベルアップの衝撃（白熱 → 収束する輪） ---
    if (levelSurge > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `rgba(180,255,230,${(levelSurge * 0.28).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 3; i++) {
        const t = Math.max(0, Math.min(1, levelSurge - i * 0.18));
        if (t <= 0) continue;
        ctx.strokeStyle = `rgba(127,255,212,${(t * 0.55).toFixed(3)})`;
        ctx.lineWidth = 1 + t * 5;
        ctx.beginPath();
        ctx.arc(halfW, halfH, Math.max(2, (1 - t) * Math.max(w, h) * 0.8), 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    }

    // --- セクション転換の閃光 ---
    if (secFlash > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = rgba(curAccent, secFlash * 0.20);
      ctx.fillRect(0, 0, w, h);
      const rr = (1 - secFlash) * Math.max(w, h) * 0.75;
      ctx.strokeStyle = rgba(curAccent, secFlash * 0.5);
      ctx.lineWidth = 2 + secFlash * 6;
      ctx.beginPath();
      ctx.arc(halfW, halfH, Math.max(1, Math.max(w, h) * 0.75 - rr), 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // --- BURST 準備完了: 画面周縁の脈動オーラ ---
    if (burstReadyOn || burstReadyT > 0) {
      burstReadyT = burstReadyOn
        ? Math.min(1, burstReadyT + dt * 2.2)
        : Math.max(0, burstReadyT - dt * 2.2);
      const throb = 0.55 + 0.45 * Math.sin(time * 5.4);
      const a = burstReadyT * (0.48 + throb * 0.46);
      const cx0 = w / 2, cy0 = h / 2;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const rim = ctx.createRadialGradient(cx0, cy0, Math.min(w, h) * 0.27,
                                           cx0, cy0, Math.max(w, h) * 0.60);
      rim.addColorStop(0, "rgba(255,92,240,0)");
      rim.addColorStop(0.45, `rgba(255,92,240,${(a * 0.16).toFixed(3)})`);
      rim.addColorStop(0.78, `rgba(255,92,240,${(a * 0.52).toFixed(3)})`);
      rim.addColorStop(1, `rgba(255,150,250,${a.toFixed(3)})`);
      ctx.fillStyle = rim;
      ctx.fillRect(0, 0, w, h);
      const bw = Math.min(w, h) * 0.09;
      const edge = burstReadyT * (0.30 + throb * 0.45);
      const bands = [
        [0, 0, w, bw, 0, 0, 0, bw], [0, h - bw, w, bw, 0, h, 0, h - bw],
        [0, 0, bw, h, 0, 0, bw, 0], [w - bw, 0, bw, h, w, 0, w - bw, 0],
      ];
      for (const [x, y, bwd, bht, gx0, gy0, gx1, gy1] of bands) {
        const gr = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
        gr.addColorStop(0, `rgba(255,120,245,${edge.toFixed(3)})`);
        gr.addColorStop(1, "rgba(255,120,245,0)");
        ctx.fillStyle = gr;
        ctx.fillRect(x, y, bwd, bht);
      }
      const n = 26;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * TAU + time * 0.5;
        const ph = (time * 0.85 + i / n) % 1;
        const rad = Math.max(w, h) * (0.60 - ph * 0.34);
        ctx.globalAlpha = burstReadyT * (1 - ph) * 0.85;
        ctx.fillStyle = "#ffa8f7";
        ctx.beginPath();
        ctx.arc(cx0 + Math.cos(ang) * rad, cy0 + Math.sin(ang) * rad * 0.72,
                1.6 + (1 - ph) * 2.6, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function setBurstReady(on) { burstReadyOn = !!on; }

  // =========================================================================
  //  バナー（COMBO / BONUS / LEVEL / BURST などの大きな文字）
  //  盤面の上に重ねるとコマが見えなくなるので、盤面の「外側」に描く。
  // =========================================================================
  const banners = [];
  function banner(text, color, sub) {
    // 同じ文字が連続したら差し替えて積み上がりを防ぐ
    const same = banners.find((b) => b.text === text);
    if (same) { same.age = 0; same.sub = sub || null; return; }
    banners.push({ text, color, sub: sub || null, life: 1.5, age: 0 });
    if (banners.length > 3) banners.shift();
  }

  function updateBanners(dt) {
    for (let i = banners.length - 1; i >= 0; i--) {
      banners[i].age += dt;
      if (banners[i].age >= banners[i].life) banners.splice(i, 1);
    }
  }

  // rect: 盤面の画面上の矩形 {x, y, w, h}
  function drawBanners(ctx, rect, scale = 1) {
    if (!banners.length || !rect) return;
    const ls = "letterSpacing" in ctx;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const cx = rect.x + rect.w / 2;
    banners.forEach((b, i) => {
      const t = 1 - b.age / b.life;
      const pop = 1 - Math.pow(1 - Math.min(1, b.age * 7), 2);
      // 盤面の下端より下に積む（上側はレベルゲージと NEXT が占めるため）
      const y = rect.y + rect.h + 34 * scale + i * 46 * scale;
      ctx.save();
      ctx.translate(cx, y);
      const sc = lerp(1.3, 1, pop) * scale;
      ctx.scale(sc, sc);
      ctx.globalAlpha = Math.min(1, t * 2.4);
      if (ls) ctx.letterSpacing = "10px";
      ctx.font = '200 44px "Helvetica Neue", "Arial Narrow", Arial, system-ui, sans-serif';
      // ズレて重なる残像（本家のオーバーレイ表現）
      ctx.globalAlpha = Math.min(1, t * 2.4) * 0.18;
      ctx.fillStyle = b.color;
      ctx.fillText(b.text, -12 * (1 - pop) - 7, -3);
      ctx.fillText(b.text, 12 * (1 - pop) + 7, 3);
      ctx.globalAlpha = Math.min(1, t * 2.4);
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 26;
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      ctx.fillText(b.text, 0, 0);
      ctx.shadowBlur = 0;
      if (b.sub) {
        if (ls) ctx.letterSpacing = "4px";
        ctx.font = '600 14px "Helvetica Neue", Arial, system-ui, sans-serif';
        ctx.fillStyle = b.color;
        ctx.fillText(b.sub, 0, 30);
      }
      if (ls) ctx.letterSpacing = "0px";
      ctx.restore();
    });
    ctx.restore();
  }

  function reset() {
    particles.length = 0;
    shards.length = 0;
    rings.length = 0;
    popups.length = 0;
    columns.length = 0;
    floats.length = 0;
    zones.length = 0;
    banners.length = 0;
    flash = 0; shake = 0;
    burstReadyOn = false; burstReadyT = 0;
  }

  return {
    burst, shatter, ring, column, popup, scorePop, zone, screenFlash, screenShake,
    update, drawForeground, drawBackground, getShake, reset, initBg,
    setBurstReady, banner, drawBanners, setQuality, setLevel, levelUpSurge,
  };
})();
