/*
 * Effects — パーティクル・リング・ポップアップ・背景演出
 * 盤面キャンバス(fg)と背景キャンバス(bg)の両方の描画を担当。
 */
const Effects = (() => {
  const particles = [];
  const rings = [];
  const popups = [];
  let flash = 0;          // 画面フラッシュ 0..1
  let shake = 0;          // 画面シェイク量(px)

  // 背景の漂う光の粒
  const bgDots = [];
  let bgInit = false;

  function rand(a, b) { return a + Math.random() * (b - a); }

  // ===== 生成 =====
  function burst(x, y, color, n = 14, power = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(40, 200) * power;
      particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 40,
        life: rand(0.4, 0.9),
        age: 0,
        r: rand(1.5, 4),
        color,
      });
    }
  }

  function ring(x, y, color, maxR = 60) {
    rings.push({ x, y, r: 6, maxR, life: 0.5, age: 0, color });
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
      p.vy += 220 * dt; // 重力
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.age += dt;
      if (r.age >= r.life) { rings.splice(i, 1); continue; }
      const t = r.age / r.life;
      r.r = 6 + (r.maxR - 6) * t;
    }
    for (let i = popups.length - 1; i >= 0; i--) {
      const p = popups[i];
      p.age += dt;
      if (p.age >= p.life) { popups.splice(i, 1); continue; }
      p.y -= 24 * dt;
    }
    if (flash > 0) flash = Math.max(0, flash - dt * 2.2);
    if (shake > 0) shake = Math.max(0, shake - dt * 40);
  }

  // ===== 盤面上の描画（加算合成） =====
  function drawForeground(ctx, w, h) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (const p of particles) {
      const t = 1 - p.age / p.life;
      ctx.globalAlpha = t;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * t + 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const r of rings) {
      const t = 1 - r.age / r.life;
      ctx.globalAlpha = t * 0.7;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3 * t + 0.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();

    // ポップアップ文字（通常合成）
    ctx.save();
    ctx.textAlign = "center";
    for (const p of popups) {
      const t = 1 - p.age / p.life;
      ctx.globalAlpha = Math.min(1, t * 1.6);
      ctx.fillStyle = p.color;
      ctx.font = `800 ${p.big ? 40 : 24}px "Segoe UI", sans-serif`;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 20;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.restore();

    // 画面フラッシュ
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

  // ===== 背景演出（ビート連動） =====
  function initBg(w, h) {
    bgDots.length = 0;
    const n = 70;
    for (let i = 0; i < n; i++) {
      bgDots.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: rand(0.5, 2.4),
        sp: rand(4, 22),
        hue: rand(180, 320),
      });
    }
    bgInit = true;
  }

  function drawBackground(ctx, w, h, dt, beat) {
    if (!bgInit) initBg(w, h);
    // ビートで強まる放射グラデーション
    const pulse = 1 - beat; // 0..1（拍頭で1）
    const cx = w * 0.5, cy = h * 0.52;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.75);
    g.addColorStop(0, `rgba(40,30,80,${0.5 + pulse * 0.25})`);
    g.addColorStop(0.5, "rgba(12,14,34,0.85)");
    g.addColorStop(1, "rgba(3,4,12,1)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // 漂う光の粒
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const d of bgDots) {
      d.y -= d.sp * dt;
      if (d.y < -4) { d.y = h + 4; d.x = Math.random() * w; }
      const a = 0.15 + pulse * 0.25;
      ctx.fillStyle = `hsla(${d.hue},80%,70%,${a})`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r + pulse * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function reset() {
    particles.length = 0;
    rings.length = 0;
    popups.length = 0;
    flash = 0; shake = 0;
  }

  return {
    burst, ring, popup, screenFlash, screenShake,
    update, drawForeground, drawBackground, getShake, reset, initBg,
  };
})();
