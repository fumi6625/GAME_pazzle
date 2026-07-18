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

  // 背景状態
  const starsFar = [];
  const starsNear = [];
  const auroras = [];
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
  function initBg(w, h) {
    bgW = w; bgH = h;
    starsFar.length = 0; starsNear.length = 0; auroras.length = 0;
    for (let i = 0; i < 90; i++)
      starsFar.push({ x: Math.random() * w, y: Math.random() * h, r: rand(0.3, 1.1), sp: rand(2, 6), tw: Math.random() * Math.PI * 2 });
    for (let i = 0; i < 40; i++)
      starsNear.push({ x: Math.random() * w, y: Math.random() * h, r: rand(1.0, 2.4), sp: rand(8, 20), tw: Math.random() * Math.PI * 2 });
    // 大きなオーロラ光斑（ゆっくり周回）
    for (let i = 0; i < 4; i++)
      auroras.push({
        cx: w * rand(0.2, 0.8), cy: h * rand(0.2, 0.75),
        rx: w * rand(0.18, 0.34), orbit: rand(30, 90),
        speed: rand(0.05, 0.14) * (i % 2 ? 1 : -1),
        phase: Math.random() * Math.PI * 2,
        hueOff: i * 45,
      });
    bgInit = true;
  }

  function drawBackground(ctx, w, h, dt, beat, intensity = 1) {
    if (!bgInit || w !== bgW || h !== bgH) initBg(w, h);
    hueTime += dt;
    const baseHue = (hueTime * 4) % 360; // ゆっくり色相が巡る
    const pulse = Math.pow(1 - beat, 2.2); // 拍頭で1→減衰

    // 新しい拍を検出してビートリングを追加
    if (beat < prevBeat) {
      beatRings.push({ age: 0, life: 1.2 });
    }
    prevBeat = beat;

    // ベース: 深い縦グラデ
    const base = ctx.createLinearGradient(0, 0, 0, h);
    base.addColorStop(0, `hsl(${(baseHue + 250) % 360}, 45%, ${7 + pulse * 2}%)`);
    base.addColorStop(0.6, `hsl(${(baseHue + 265) % 360}, 50%, 5%)`);
    base.addColorStop(1, "hsl(255, 40%, 3%)");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);

    // オーロラ光斑（加算）
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const a of auroras) {
      a.phase += a.speed * dt;
      const x = a.cx + Math.cos(a.phase) * a.orbit;
      const y = a.cy + Math.sin(a.phase * 0.7) * a.orbit * 0.6;
      const hue = (baseHue + a.hueOff + 200) % 360;
      const g = ctx.createRadialGradient(x, y, 0, x, y, a.rx);
      g.addColorStop(0, `hsla(${hue}, 85%, 55%, ${0.10 + pulse * 0.05})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - a.rx, y - a.rx, a.rx * 2, a.rx * 2);
    }

    // 回転光線（中心から放射する細いくさび）
    raysRot += dt * 0.05;
    const cx = w / 2, cy = h * 0.45;
    const R = Math.max(w, h);
    const rayAlpha = 0.028 + pulse * 0.05 + intensity * 0.008;
    ctx.fillStyle = `hsla(${(baseHue + 230) % 360}, 80%, 65%, ${rayAlpha})`;
    for (let i = 0; i < 10; i++) {
      const a0 = raysRot + (i / 10) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a0, a0 + 0.06);
      ctx.closePath();
      ctx.fill();
    }

    // ビートリング（中心から拡がる輪）
    for (const b of beatRings) {
      const t = b.age / b.life;
      ctx.strokeStyle = `hsla(${(baseHue + 210) % 360}, 90%, 70%, ${(1 - t) * 0.18})`;
      ctx.lineWidth = 2 + (1 - t) * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 40 + t * R * 0.55, 0, Math.PI * 2);
      ctx.stroke();
    }

    // スターフィールド（視差2層 + 瞬き）
    const now = hueTime;
    for (const s of starsFar) {
      s.y -= s.sp * dt;
      if (s.y < -3) { s.y = h + 3; s.x = Math.random() * w; }
      const tw = 0.5 + 0.5 * Math.sin(now * 2 + s.tw);
      ctx.fillStyle = `rgba(200,220,255,${0.25 * tw + pulse * 0.1})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }
    for (const s of starsNear) {
      s.y -= s.sp * dt;
      if (s.y < -4) { s.y = h + 4; s.x = Math.random() * w; }
      const tw = 0.5 + 0.5 * Math.sin(now * 3 + s.tw);
      ctx.fillStyle = `hsla(${(baseHue + 260) % 360}, 90%, 80%, ${0.3 * tw + pulse * 0.15})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r + pulse * 0.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // 下部の霞
    const fog = ctx.createLinearGradient(0, h * 0.7, 0, h);
    fog.addColorStop(0, "rgba(0,0,0,0)");
    fog.addColorStop(1, `hsla(${(baseHue + 250) % 360}, 50%, 10%, 0.5)`);
    ctx.fillStyle = fog;
    ctx.fillRect(0, h * 0.7, w, h * 0.3);
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
