/*
 * Effects v2 — パーティクル・破片・光柱・ポップアップ・多層背景
 *
 * 背景: ベースグラデ + オーロラ光斑 + 回転光線 + 視差スターフィールド + ビートリング
 * 前景: グロー粒子 / 回転する破片 / 拡散リング / 光柱 / ポップアップ文字 / フラッシュ
 */
const Effects = (() => {
  const particles = [];
  const shards = [];
  const rings = [];
  const popups = [];
  const columns = [];   // 消去列の光柱
  const beatRings = []; // 背景のビートリング
  let flash = 0;
  let shake = 0;

  // 背景状態（エジプト / ピラミッドの情景）
  const stars = [];
  const dust = [];
  let pyramids = [];
  let raysRot = 0;
  let bgW = 0, bgH = 0;
  let bgInit = false;
  let prevBeat = 0;
  let hueTime = 0;

  function rand(a, b) { return a + Math.random() * (b - a); }

  // ===== 前景の生成 =====
  function burst(x, y, color, n = 14, power = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(50, 230) * power;
      particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 50,
        life: rand(0.4, 1.0), age: 0,
        r: rand(1.5, 4), color,
      });
    }
  }

  // ブロックが砕け散る破片（回転する小方形）
  function shatter(x, y, color, n = 6, power = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(60, 200) * power;
      shards.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 90,
        rot: Math.random() * Math.PI, vr: rand(-8, 8),
        size: rand(4, 10),
        life: rand(0.5, 0.9), age: 0, color,
      });
    }
  }

  function ring(x, y, color, maxR = 60) {
    rings.push({ x, y, r: 6, maxR, life: 0.5, age: 0, color });
  }

  // 消去列に立ち上る光柱
  function column(x, w, h, color) {
    columns.push({ x, w, h, color, life: 0.45, age: 0 });
  }

  function popup(x, y, text, color, big = false) {
    popups.push({ x, y, text, color, life: 1.1, age: 0, big });
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
      s.vy += 420 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.rot += s.vr * dt;
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.age += dt;
      if (r.age >= r.life) { rings.splice(i, 1); continue; }
      r.r = 6 + (r.maxR - 6) * (r.age / r.life);
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
      p.y -= 26 * dt;
    }
    for (let i = beatRings.length - 1; i >= 0; i--) {
      const b = beatRings[i];
      b.age += dt;
      if (b.age >= b.life) beatRings.splice(i, 1);
    }
    if (flash > 0) flash = Math.max(0, flash - dt * 2.4);
    if (shake > 0) shake = Math.max(0, shake - dt * 42);
  }

  // ===== 前景描画 =====
  function drawForeground(ctx, w, h) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // 光柱
    for (const c of columns) {
      const t = 1 - c.age / c.life;
      const g = ctx.createLinearGradient(c.x, 0, c.x + c.w, 0);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.5, c.color.replace("ALPHA", (0.35 * t).toFixed(3)));
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(c.x - c.w * 0.5, 0, c.w * 2, c.h);
    }

    // 粒子（グロー付き）
    for (const p of particles) {
      const t = 1 - p.age / p.life;
      ctx.globalAlpha = t;
      const rr = p.r * t + 0.5;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr * 3);
      g.addColorStop(0, p.color);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr * 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 破片
    for (const s of shards) {
      const t = 1 - s.age / s.life;
      ctx.globalAlpha = t;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.fillStyle = s.color;
      const sz = s.size * (0.4 + 0.6 * t);
      ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
      ctx.restore();
    }

    // リング
    for (const r of rings) {
      const t = 1 - r.age / r.life;
      ctx.globalAlpha = t * 0.75;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3 * t + 0.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();

    // ポップアップ文字
    ctx.save();
    ctx.textAlign = "center";
    for (const p of popups) {
      const t = 1 - p.age / p.life;
      const scale = p.big ? (1 + (1 - Math.min(1, p.age * 5)) * 0.5) : 1;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(scale, scale);
      ctx.globalAlpha = Math.min(1, t * 1.6);
      ctx.fillStyle = p.color;
      ctx.font = `800 ${p.big ? 44 : 24}px "Segoe UI", sans-serif`;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 26;
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
    }
    ctx.restore();

    if (flash > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `rgba(255,255,255,${flash * 0.5})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  function getShake() {
    if (shake <= 0) return { x: 0, y: 0 };
    return { x: rand(-shake, shake), y: rand(-shake, shake) };
  }

  // ===== 背景 =====
  const HORIZON = 0.70; // 地平線の高さ（比率）

  function initBg(w, h) {
    bgW = w; bgH = h;
    const horizon = h * HORIZON;
    stars.length = 0; dust.length = 0;

    // 星（空の上部）
    for (let i = 0; i < 110; i++)
      stars.push({
        x: Math.random() * w,
        y: Math.random() * horizon * 0.62,
        r: rand(0.4, 1.6),
        p: Math.random() * Math.PI * 2,
      });

    // 漂う砂塵（地平付近を横に流れる）
    for (let i = 0; i < 60; i++)
      dust.push({
        x: Math.random() * w,
        y: horizon + Math.random() * (h - horizon),
        r: rand(0.4, 1.8),
        vx: rand(6, 24) * (Math.random() < 0.5 ? 1 : -1),
        vy: -rand(1, 5),
        a: rand(0.05, 0.22),
      });

    // ピラミッド群（ギザ風。奥→手前の順に描画。太陽は中央にあり側面が陰陽に分かれる）
    pyramids = [
      { cx: w * 0.72, baseY: horizon + 2,  hw: w * 0.085, ht: h * 0.16, haze: 0.62 },
      { cx: w * 0.30, baseY: horizon + 4,  hw: w * 0.10,  ht: h * 0.19, haze: 0.5 },
      { cx: w * 0.18, baseY: horizon + 12, hw: w * 0.15,  ht: h * 0.30, haze: 0.22 },
      { cx: w * 0.62, baseY: horizon + 22, hw: w * 0.23,  ht: h * 0.44, haze: 0.0 },
    ];
    bgInit = true;
  }

  // ピラミッド1基（光と影で立体化）
  function drawPyramid(ctx, p, sunX, pulse) {
    const ax = p.cx, ay = p.baseY - p.ht;   // 頂点
    const lx = p.cx - p.hw, rx = p.cx + p.hw, by = p.baseY;
    const litLeft = p.cx >= sunX;            // 太陽が左 → 左面が明るい
    const alpha = 1 - p.haze * 0.6;          // 遠景ほど霞んで空に溶ける

    ctx.save();
    ctx.globalAlpha = alpha;

    const litGrad = () => {
      const g = ctx.createLinearGradient(ax, ay, p.cx, by);
      g.addColorStop(0, "#f6d79a"); g.addColorStop(0.5, "#d7a24e"); g.addColorStop(1, "#a5721f");
      return g;
    };
    const shadowGrad = () => {
      const g = ctx.createLinearGradient(ax, ay, p.cx, by);
      g.addColorStop(0, "#6a4b62"); g.addColorStop(1, "#2b1d33");
      return g;
    };

    // 左面
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(lx, by); ctx.lineTo(p.cx, by); ctx.closePath();
    ctx.fillStyle = litLeft ? litGrad() : shadowGrad(); ctx.fill();
    // 右面
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(p.cx, by); ctx.lineTo(rx, by); ctx.closePath();
    ctx.fillStyle = litLeft ? shadowGrad() : litGrad(); ctx.fill();

    // 近景のみ稜線ハイライト
    if (p.haze < 0.3) {
      ctx.globalAlpha = alpha * 0.9;
      ctx.strokeStyle = `rgba(255,236,180,${0.4 + pulse * 0.3})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(p.cx, by); ctx.stroke();   // 手前の稜線
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(litLeft ? lx : rx, by); ctx.stroke(); // 陽の当たる外縁
    }
    ctx.restore();
  }

  function drawBackground(ctx, w, h, dt, beat, intensity = 1) {
    if (!bgInit || w !== bgW || h !== bgH) initBg(w, h);
    hueTime += dt;
    const horizon = h * HORIZON;
    const pulse = Math.pow(1 - beat, 2.0);       // 拍頭で1
    const warm = 0.5 + 0.5 * Math.sin(hueTime * 0.03); // ゆっくりした陽の移ろい
    const sunX = w * 0.5, sunY = horizon - h * 0.015;

    // 拍ごとに太陽から広がる陽炎リング
    if (beat < prevBeat) beatRings.push({ age: 0, life: 1.4 });
    prevBeat = beat;

    // ---- 空 ----
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0.00, `hsl(258, 62%, ${8 + pulse * 2}%)`);      // 深い藍
    sky.addColorStop(0.34, `hsl(282, 46%, ${16 + warm * 4}%)`);      // 紫
    sky.addColorStop(0.60, `hsl(330, 52%, 30%)`);                    // マゼンタ
    sky.addColorStop(0.82, `hsl(24, 82%, ${44 + pulse * 6}%)`);      // オレンジ
    sky.addColorStop(1.00, `hsl(44, 92%, ${64 + pulse * 5}%)`);      // 黄金の地平
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon);

    // ---- 星 ----
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const s of stars) {
      const tw = 0.5 + 0.5 * Math.sin(hueTime * 2 + s.p);
      const fade = 1 - s.y / (horizon * 0.62);
      ctx.fillStyle = `rgba(255,244,214,${(0.15 + 0.4 * tw) * fade})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }

    // ---- 太陽（グロー / 光線 / 円盤） ----
    const glowR = Math.min(w, h) * 0.6;
    const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, glowR);
    glow.addColorStop(0, `rgba(255,226,150,${0.34 + pulse * 0.16})`);
    glow.addColorStop(0.25, "rgba(255,150,70,0.16)");
    glow.addColorStop(1, "rgba(255,110,50,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, horizon + 60);

    raysRot += dt * 0.03;
    ctx.fillStyle = `rgba(255,210,140,${0.028 + pulse * 0.03 + intensity * 0.006})`;
    for (let i = 0; i < 14; i++) {
      const a0 = raysRot + (i / 14) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(sunX, sunY);
      ctx.arc(sunX, sunY, glowR, a0, a0 + 0.05); ctx.closePath(); ctx.fill();
    }

    for (const b of beatRings) {
      const t = b.age / b.life;
      ctx.strokeStyle = `rgba(255,220,150,${(1 - t) * 0.14})`;
      ctx.lineWidth = 1 + (1 - t) * 2;
      ctx.beginPath(); ctx.arc(sunX, sunY, 30 + t * glowR * 0.7, 0, Math.PI * 2); ctx.stroke();
    }

    const dR = Math.min(w, h) * 0.10;
    const disc = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, dR);
    disc.addColorStop(0, "#fff6d2"); disc.addColorStop(0.6, "#ffd772"); disc.addColorStop(1, "rgba(255,150,60,0.65)");
    ctx.fillStyle = disc;
    ctx.beginPath(); ctx.arc(sunX, sunY, dR, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // ---- ピラミッド（奥→手前） ----
    for (const p of pyramids) drawPyramid(ctx, p, sunX, pulse);

    // ---- 砂丘（前景） ----
    const sand = ctx.createLinearGradient(0, horizon, 0, h);
    sand.addColorStop(0, `hsl(34, 72%, ${40 + pulse * 4}%)`);
    sand.addColorStop(0.5, "hsl(28, 55%, 22%)");
    sand.addColorStop(1, "hsl(24, 45%, 7%)");
    ctx.fillStyle = sand;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    const amp = h * 0.03;
    for (let x = 0; x <= w; x += w / 16)
      ctx.lineTo(x, horizon + Math.sin(x * 0.006 + 1.2) * amp - amp * 0.4);
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fill();

    // 砂への陽の照り返し
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const refl = ctx.createRadialGradient(sunX, horizon, 0, sunX, horizon, w * 0.42);
    refl.addColorStop(0, `rgba(255,190,110,${0.10 + pulse * 0.06})`);
    refl.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = refl;
    ctx.fillRect(0, horizon, w, h - horizon);

    // ---- 漂う砂塵 ----
    for (const d of dust) {
      d.x += d.vx * dt; d.y += d.vy * dt;
      if (d.x > w + 6) d.x = -6; else if (d.x < -6) d.x = w + 6;
      if (d.y < horizon * 0.85) { d.y = h - 2; d.x = Math.random() * w; }
      ctx.fillStyle = `rgba(255,222,160,${d.a * (0.5 + pulse * 0.5)})`;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function reset() {
    particles.length = 0;
    shards.length = 0;
    rings.length = 0;
    popups.length = 0;
    columns.length = 0;
    flash = 0; shake = 0;
  }

  return {
    burst, shatter, ring, column, popup, screenFlash, screenShake,
    update, drawForeground, drawBackground, getShake, reset, initBg,
  };
})();
