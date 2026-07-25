/*
 * Effects v3 — 夜のメトロポリス × サイバースペース
 *
 * 背景レイヤー（奥→手前）:
 *   1. ほぼ黒の空グラデ + 星 + 遠景ボケ粒子
 *   2. 視差スカイライン 4 層（プリレンダー / 窓明かりを焼き込み）
 *   3. 大気遠近のヘイズ帯 + ネオンの滲み（ビートで脈動）
 *   4. 濡れた路面：スカイラインの反転反射 + 波紋バンド
 *   5. Rez 的ワイヤーフレーム地平（透視グリッド + 消失点線）
 *   6. 車のヘッドライト光跡 / 手前のボケ粒子
 *   7. 通行人シルエット（低解像度スプライトの拡大 = 被写界深度のボケ）
 *   8. ビネット + 走査ノイズ
 *
 * 前景: ガラス片 / グロー粒子 / リング / 亀裂状の光柱 / 大型タイポ / フラッシュ
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
    ctx.restore();

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
  //  背景：夜のメトロポリス × ワイヤーフレーム
  // =========================================================================
  const HORIZON = 0.66;

  // セクション別のトーン（0=A シアン / 1=B マゼンタ / 2=C アンバー）
  const SECTIONS = [
    { accent: [80, 225, 255], sub: [255, 90, 200], warm: [255, 206, 148], sky: [5, 9, 18], dens: 1.00 },
    { accent: [255, 86, 208], sub: [110, 220, 255], warm: [255, 190, 160], sky: [10, 6, 20], dens: 1.18 },
    { accent: [255, 172, 66], sub: [96, 232, 255], warm: [255, 218, 168], sky: [14, 9, 13], dens: 1.36 },
  ];

  let bgW = 0, bgH = 0, bgInit = false;
  let time = 0, prevBeat = 0, beatCount = 0, barPulse = 0;
  let horizonY = 0, tileW = 0;
  const layers = [];        // スカイライン各層
  const stars = [];
  const bokehFar = [], bokehNear = [];
  const trails = [];        // 路面の光跡
  const peds = [];          // 通行人
  let pedSprites = [];
  let curAccent = SECTIONS[0].accent.slice();
  let curSub = SECTIONS[0].sub.slice();
  let curSky = SECTIONS[0].sky.slice();
  let curDens = 1;
  let gridScroll = 0;
  let backdrop = null, backdropKey = "";

  // 層の仕様（奥→手前）
  const LAYER_SPECS = [
    { haze: 0.62, speed: 3.5, hMul: 0.30, wMin: 22, wMax: 62, step: 5, win: 1, alpha: 0.85, dyn: 10 },
    { haze: 0.38, speed: 8, hMul: 0.44, wMin: 30, wMax: 86, step: 6, win: 1, alpha: 0.92, dyn: 18 },
    { haze: 0.17, speed: 16, hMul: 0.60, wMin: 44, wMax: 116, step: 8, win: 2, alpha: 1.0, dyn: 26 },
    { haze: 0.03, speed: 29, hMul: 0.84, wMin: 66, wMax: 168, step: 11, win: 3, alpha: 1.0, dyn: 34 },
  ];

  // --- 通行人シルエットのプリレンダー（低解像度→拡大でボケを得る）---
  function buildPedSprites() {
    pedSprites = [];
    const W = 26, H = 62;
    for (let f = 0; f < 6; f++) {
      const cv = makeCanvas(W, H), c = cv.getContext("2d");
      const sw = Math.sin((f / 6) * TAU);        // 脚の開き
      const aw = Math.sin((f / 6) * TAU + Math.PI); // 腕の振り
      c.fillStyle = "#000";
      const cx = W / 2;
      c.beginPath(); c.arc(cx, 8, 5.4, 0, TAU); c.fill();       // 頭
      c.beginPath();                                             // 胴
      c.moveTo(cx - 7, 16); c.quadraticCurveTo(cx, 12.5, cx + 7, 16);
      c.lineTo(cx + 5.5, 36); c.lineTo(cx - 5.5, 36); c.closePath(); c.fill();
      c.lineCap = "round"; c.strokeStyle = "#000";
      c.lineWidth = 4.4;                                         // 腕
      c.beginPath(); c.moveTo(cx - 6, 18); c.lineTo(cx - 6 + aw * 5, 33); c.stroke();
      c.beginPath(); c.moveTo(cx + 6, 18); c.lineTo(cx + 6 - aw * 5, 33); c.stroke();
      c.lineWidth = 5.6;                                         // 脚
      c.beginPath(); c.moveTo(cx - 2.5, 35); c.lineTo(cx - 2.5 + sw * 7, 60); c.stroke();
      c.beginPath(); c.moveTo(cx + 2.5, 35); c.lineTo(cx + 2.5 - sw * 7, 60); c.stroke();
      pedSprites.push(cv);
    }
  }

  // --- スカイライン1層をプリレンダー ---
  // 層ごとに必要最小限の高さだけ持つ（毎フレームの転送面積を抑える）
  function buildLayer(spec, tw, horizon) {
    const maxH = horizon * spec.hMul;
    const bandH = Math.ceil(maxH) + 28;
    const cv = makeCanvas(tw, bandH);
    const c = cv.getContext("2d");
    const hazeCol = [38, 54, 80];
    const body = mix([2, 3, 7], hazeCol, spec.haze);
    const roof = mix(body, [70, 96, 130], 0.5);
    const dynWins = [], beacons = [], neons = [];
    // 壁面は上ほど暗く、地平近くほど霞む（大気遠近）
    const bodyGrad = c.createLinearGradient(0, 0, 0, bandH);
    bodyGrad.addColorStop(0, rgba(mix(body, [0, 0, 0], 0.4), 1));
    bodyGrad.addColorStop(0.7, rgba(body, 1));
    bodyGrad.addColorStop(1, rgba(mix(body, hazeCol, 0.5), 1));

    // 同じ建物を右端跨ぎでも描くための小ヘルパ
    const shapes = [];
    let x = -30;
    while (x < tw + 20) {
      const bw = rand(spec.wMin, spec.wMax);
      const bh = rand(maxH * 0.34, maxH);
      shapes.push({ x, w: bw, h: bh });
      x += bw + rand(2, 12);
    }

    for (const s of shapes) {
      for (const dx of (s.x + s.w > tw ? [0, -tw] : s.x < 0 ? [0, tw] : [0])) {
        const bx = s.x + dx, by = bandH - s.h;
        // 本体
        c.fillStyle = bodyGrad;
        c.fillRect(bx, by, s.w, s.h);
        // セットバック（段付きの頂部）
        if (Math.random() < 0.45 && s.w > 26) {
          const tw2 = s.w * rand(0.35, 0.68), th = s.h * rand(0.06, 0.16);
          c.fillRect(bx + (s.w - tw2) / 2, by - th, tw2, th);
        }
        // 屋上のエッジ（わずかな受光）
        c.fillStyle = rgba(roof, 0.55);
        c.fillRect(bx, by, s.w, 1);
        // 窓明かり（焼き込み）
        const st = spec.step, ws = spec.win;
        const lit = 0.27 + spec.haze * 0.12;
        for (let wy = by + 5; wy < bandH - 3; wy += st) {
          for (let wx = bx + 3; wx < bx + s.w - ws - 1; wx += st) {
            if (Math.random() > lit) continue;
            const warm = Math.random();
            const col = warm < 0.72 ? [255, 208, 148] : warm < 0.9 ? [190, 226, 255] : [255, 240, 214];
            c.fillStyle = rgba(col, rand(0.16, 0.62) * (1 - spec.haze * 0.45));
            c.fillRect(wx, wy, ws, Math.max(1, ws - 1));
          }
        }
        // アンテナ + 航空障害灯
        if (s.h > maxH * 0.72 && Math.random() < 0.5) {
          const ax = bx + s.w / 2, ah = rand(6, 22);
          c.fillStyle = rgba(roof, 0.7);
          c.fillRect(ax, by - ah, 1, ah);
          beacons.push({ x: ax + 0.5, y: by - ah, ph: Math.random() * TAU });
        }
        // 明滅する窓（動的に上描き）
        for (let i = 0; i < 2 && dynWins.length < spec.dyn; i++) {
          if (s.h < 30) break;
          const wx = bx + rand(3, s.w - 4), wy = by + rand(5, s.h - 6);
          dynWins.push({ x: wx, y: wy, w: spec.win + 1, h: spec.win + 1, ph: Math.random() * TAU });
        }
      }
    }

    // 最前列にはネオン看板（縦帯 / 横帯）
    if (spec.haze < 0.2) {
      const n = spec.haze < 0.1 ? 5 : 3;
      for (let i = 0; i < n; i++) {
        const vertical = Math.random() < 0.55;
        neons.push({
          x: rand(30, tw - 30),
          y: bandH - rand(maxH * 0.08, maxH * 0.9),
          w: vertical ? rand(3, 6) : rand(20, 54),
          h: vertical ? rand(24, 70) : rand(4, 9),
          ph: Math.random() * TAU,
          sub: Math.random() < 0.4,
        });
      }
    }
    // 層ごとの不透明度を焼き込む（描画時の globalAlpha を避けて転送を速くする）
    if (spec.alpha < 1) {
      c.globalCompositeOperation = "destination-in";
      c.fillStyle = `rgba(0,0,0,${spec.alpha})`;
      c.fillRect(0, 0, tw, bandH);
      c.globalCompositeOperation = "source-over";
    }

    // 反射用の上下反転コピー（最前列のみ）。毎フレームの scale(1,-1) を避ける
    let flip = null;
    if (spec.haze < 0.1) {
      flip = makeCanvas(tw, bandH);
      const fc = flip.getContext("2d");
      fc.translate(0, bandH); fc.scale(1, -1);
      fc.drawImage(cv, 0, 0);
    }
    return {
      cv, flip, spec, bandH, top: Math.round(horizon - bandH),
      dynWins, beacons, neons, off: rand(0, tw),
    };
  }

  function initBg(w, h) {
    if (!w || !h || w < 2 || h < 2) return;
    bgW = w; bgH = h;
    horizonY = Math.round(h * HORIZON);
    tileW = Math.max(w, 900);

    layers.length = 0;
    for (const spec of LAYER_SPECS) layers.push(buildLayer(spec, tileW, horizonY));
    glowCache.clear(); bokehCache.clear();

    // 星
    stars.length = 0;
    for (let i = 0; i < 90; i++)
      stars.push({ x: Math.random() * w, y: Math.random() * horizonY * 0.5, r: rand(0.3, 1.2), ph: Math.random() * TAU });

    // ボケ粒子（遠景 / 近景）
    bokehFar.length = 0; bokehNear.length = 0;
    for (let i = 0; i < 26; i++)
      bokehFar.push({ x: Math.random() * w, y: Math.random() * horizonY, r: rand(6, 20), a: rand(0.05, 0.16), vx: rand(-6, 6), vy: rand(-4, 2), ph: Math.random() * TAU, sub: Math.random() < 0.35 });
    for (let i = 0; i < 16; i++)
      bokehNear.push({ x: Math.random() * w, y: rand(horizonY * 0.35, h), r: rand(24, 68), a: rand(0.04, 0.11), vx: rand(-14, 14), vy: rand(-8, 4), ph: Math.random() * TAU, sub: Math.random() < 0.5 });

    // 路面の光跡（車）
    trails.length = 0;
    for (let i = 0; i < 12; i++) {
      const d = Math.random();
      trails.push(resetTrail({}, w, h, d));
    }

    // 通行人
    if (!pedSprites.length) buildPedSprites();
    peds.length = 0;
    for (let i = 0; i < 7; i++) {
      const near = i < 3;
      peds.push({
        x: Math.random() * (w + 200) - 100,
        scale: near ? rand(2.6, 4.4) : rand(1.2, 2.0),
        y: near ? h + rand(2, 14) : h * rand(0.90, 0.97),
        v: (Math.random() < 0.5 ? -1 : 1) * rand(14, 42),
        ph: Math.random() * 6,
        dark: near ? 1 : 0.82,
      });
    }

    // 空と路面のベースを焼くバックドロップ（ビネットは CSS 側 .vignette が担当）
    backdrop = makeCanvas(w, h);
    backdropKey = "";

    gridScroll = 0;
    bgInit = true;
  }

  function resetTrail(t, w, h, d) {
    const depth = d === undefined ? Math.random() : d; // 0=遠 1=近
    t.depth = depth;
    t.y = horizonY + 6 + Math.pow(depth, 1.7) * (h - horizonY - 10);
    t.dir = Math.random() < 0.5 ? 1 : -1;
    t.x = t.dir > 0 ? -rand(40, 400) : w + rand(40, 400);
    t.sp = (60 + depth * 620) * t.dir;
    t.len = 30 + depth * 190;
    t.th = 1.4 + depth * 6;
    t.red = t.dir < 0;                                  // 遠ざかる車=テールランプ
    t.a = 0.16 + depth * 0.34;
    return t;
  }

  // --- 空と路面のベース（全画面グラデ）をキャッシュ ---
  // 毎フレーム全画面グラデを塗ると重いので、色が実質変わったときだけ焼き直す
  function updateBackdrop(w, h) {
    const key = `${curSky.map((v) => v / 12 | 0).join()}|${curAccent.map((v) => v / 26 | 0).join()}`;
    if (key === backdropKey) return;
    backdropKey = key;
    const c = backdrop.getContext("2d");
    const sky = c.createLinearGradient(0, 0, 0, horizonY);
    sky.addColorStop(0, rgba(mix(curSky, [0, 0, 0], 0.45), 1));
    sky.addColorStop(0.55, rgba(curSky, 1));
    sky.addColorStop(1, rgba(mix(curSky, curAccent, 0.16), 1));
    c.fillStyle = sky;
    c.fillRect(0, 0, w, horizonY);
    const road = c.createLinearGradient(0, horizonY, 0, h);
    road.addColorStop(0, rgba(mix(curSky, curAccent, 0.12), 1));
    road.addColorStop(0.35, rgba(mix(curSky, [0, 0, 0], 0.55), 1));
    road.addColorStop(1, "rgba(0,0,0,1)");
    c.fillStyle = road;
    c.fillRect(0, horizonY, w, h - horizonY);
  }

  // --- Rez 的ワイヤーフレーム地平 ---
  function drawWireGrid(ctx, w, h, pulse, dens) {
    const vpx = w * 0.5, gh = h - horizonY;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 1;

    // 消失点へ収束する縦線
    const cols = 22;
    const aV = (0.045 + pulse * 0.05) * dens;
    ctx.strokeStyle = rgba(curAccent, aV);
    ctx.beginPath();
    for (let i = 0; i <= cols; i++) {
      const t = i / cols - 0.5;
      ctx.moveTo(vpx + t * w * 0.14, horizonY);
      ctx.lineTo(vpx + t * w * 3.4, h);
    }
    ctx.stroke();

    // 手前へ流れる横線（透視スペーシング）
    const rows = 16;
    ctx.beginPath();
    for (let i = 0; i < rows; i++) {
      const t = ((i + gridScroll) % rows) / rows;
      const y = horizonY + gh * Math.pow(t, 2.6);
      ctx.moveTo(0, y); ctx.lineTo(w, y);
    }
    ctx.strokeStyle = rgba(curAccent, (0.05 + pulse * 0.06) * dens);
    ctx.stroke();

    // 地平線（鋭い一本）
    ctx.strokeStyle = rgba(mix(curAccent, [255, 255, 255], 0.5), 0.16 + pulse * 0.22);
    ctx.beginPath(); ctx.moveTo(0, horizonY + 0.5); ctx.lineTo(w, horizonY + 0.5); ctx.stroke();
    ctx.restore();
  }

  // --- スカイライン層の描画（タイル反復）---
  // 転送先 x は必ず整数にする（小数だと再サンプリングの遅い経路に落ちて激重になる）
  function layerOffset(L) {
    return -Math.round((time * L.spec.speed + L.off) % tileW);
  }
  function drawLayerTiles(ctx, L, w, off) {
    for (let x = off; x < w; x += tileW) ctx.drawImage(L.cv, x, L.top);
  }

  function drawBackground(ctx, w, h, dt, beat, intensity = 1) {
    if (!bgInit || w !== bgW || h !== bgH) { initBg(w, h); if (!bgInit) return; }
    time += dt;
    gridScroll = (gridScroll + dt * 1.4) % 16;

    // 拍の検出
    const pulse = Math.pow(1 - beat, 3);
    if (beat < prevBeat) { beatCount++; if (beatCount % 4 === 0) barPulse = 1; }
    prevBeat = beat;
    barPulse = Math.max(0, barPulse - dt * 1.6);

    // セクションでトーンを段階変化
    const sec = SECTIONS[(typeof GameAudio !== "undefined" && GameAudio.section ? GameAudio.section() : 0) % 3];
    const k = Math.min(1, dt * 0.9);
    curAccent = mix(curAccent, sec.accent, k);
    curSub = mix(curSub, sec.sub, k);
    curSky = mix(curSky, sec.sky, k);
    curDens = lerp(curDens, sec.dens * (0.72 + intensity * 0.2), k);
    const dens = curDens;

    // ---- 1. 空 + 路面のベース（キャッシュ済みバックドロップを 1:1 転送）----
    updateBackdrop(w, h);
    ctx.drawImage(backdrop, 0, 0);

    // 星
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const s of stars) {
      const tw2 = 0.4 + 0.6 * Math.sin(time * 1.7 + s.ph);
      ctx.fillStyle = `rgba(200,220,255,${(0.10 + 0.22 * tw2).toFixed(3)})`;
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }
    // 遠景ボケ
    for (const b of bokehFar) {
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x < -80) b.x = w + 60; else if (b.x > w + 80) b.x = -60;
      if (b.y < -40) b.y = horizonY;
      const r = b.r * (1 + pulse * 0.06);
      ctx.globalAlpha = b.a * (0.7 + 0.3 * Math.sin(time + b.ph)) * dens;
      const sp = bokehSprite(qkey(b.sub ? curSub : curAccent));
      ctx.drawImage(sp, b.x - r, b.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // ---- 2. スカイライン（奥→手前 / 視差）----
    const layerOffs = [];
    for (const L of layers) {
      const off = layerOffset(L);
      layerOffs.push(off);
      drawLayerTiles(ctx, L, w, off);
    }

    // 明滅する窓・航空障害灯・ネオン（加算）
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i], off = layerOffs[i];
      for (let x = off; x < w; x += tileW) {
        for (const dw of L.dynWins) {
          const f = 0.5 + 0.5 * Math.sin(time * 2.4 + dw.ph);
          const a = (0.18 + pulse * 0.55 * f) * dens * L.spec.alpha;
          ctx.fillStyle = rgba(sec.warm, a);
          ctx.fillRect(x + dw.x, L.top + dw.y, dw.w, dw.h);
        }
        for (const bc of L.beacons) {
          const bl = Math.sin(time * 2.2 + bc.ph);
          if (bl > 0.7) {
            ctx.fillStyle = `rgba(255,80,60,${(0.5 * (bl - 0.7) / 0.3).toFixed(3)})`;
            ctx.fillRect(x + bc.x - 1, L.top + bc.y - 1, 2, 2);
          }
        }
        for (const nn of L.neons) {
          const f = 0.62 + 0.38 * Math.sin(time * 3 + nn.ph);
          const col = qkey(nn.sub ? curSub : curAccent);
          const gr = Math.max(nn.w, nn.h) * (1.9 + pulse * 0.5);
          ctx.globalAlpha = (0.30 + pulse * 0.32) * f * dens;
          ctx.drawImage(glowSprite(col), x + nn.x + nn.w / 2 - gr, L.top + nn.y + nn.h / 2 - gr, gr * 2, gr * 2);
          ctx.globalAlpha = (0.55 + pulse * 0.35) * f;
          ctx.fillStyle = "rgba(255,255,255,0.9)";
          ctx.fillRect(x + nn.x, L.top + nn.y, nn.w, nn.h);
          ctx.globalAlpha = 1;
        }
      }
    }
    ctx.restore();

    // ---- 3. 大気遠近のヘイズ帯（地平にたまるスモッグ）----
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const hz = ctx.createLinearGradient(0, horizonY - h * 0.22, 0, horizonY + 2);
    hz.addColorStop(0, rgba(curAccent, 0));
    hz.addColorStop(0.72, rgba(curAccent, 0.05 * dens));
    hz.addColorStop(1, rgba(mix(curAccent, sec.warm, 0.4), (0.13 + pulse * 0.07) * dens));
    ctx.fillStyle = hz;
    ctx.fillRect(0, horizonY - h * 0.22, w, h * 0.22 + 2);
    ctx.restore();

    // ---- 4. 濡れた路面（ベースはバックドロップ済み。ここから映り込みを重ねる）----
    // 反射（プリレンダー済みの反転コピーを地平の下へ 1:1 転送）
    ctx.save();
    ctx.beginPath(); ctx.rect(0, horizonY, w, h - horizonY); ctx.clip();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.32 * dens;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      if (!L.flip) continue;
      const off = layerOffs[i];
      for (let x = off; x < w; x += tileW) ctx.drawImage(L.flip, x, horizonY);
    }
    ctx.restore();

    // 反射のにじみを縦に引き伸ばす（ネオンの映り込み）
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i], off = layerOffs[i];
      if (!L.neons.length) continue;
      for (let x = off; x < w; x += tileW) {
        for (const nn of L.neons) {
          const f = 0.6 + 0.4 * Math.sin(time * 3 + nn.ph);
          const col = qkey(nn.sub ? curSub : curAccent);
          // 縦に引き伸ばした滲み（時間で緩くゆらぐ = 水面の揺れ）
          const rw = Math.max(6, nn.w * 2.2);
          const rh = (h - horizonY) * (0.44 + 0.06 * Math.sin(time * 1.6 + nn.ph));
          ctx.globalAlpha = (0.14 + pulse * 0.12) * f * dens;
          ctx.drawImage(glowSprite(col), x + nn.x + nn.w / 2 - rw, horizonY, rw * 2, rh);
        }
      }
    }
    ctx.globalAlpha = 1;
    // 水面の波紋バンド（横方向の暗線でアスファルトの起伏）
    ctx.globalCompositeOperation = "source-over";
    for (let i = 0; i < 14; i++) {
      const t = i / 14;
      const y = horizonY + Math.pow(t, 2.1) * (h - horizonY);
      const a = 0.05 + 0.05 * Math.sin(time * 1.1 + i * 1.7);
      ctx.fillStyle = `rgba(0,0,0,${a.toFixed(3)})`;
      ctx.fillRect(0, y, w, 1 + t * 4);
    }
    ctx.restore();

    // ---- 5. ワイヤーフレーム地平 ----
    drawWireGrid(ctx, w, h, pulse + barPulse * 0.4, dens);

    // ---- 6. 車の光跡 ----
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const t of trails) {
      t.x += t.sp * dt;
      if (t.x < -t.len - 420 || t.x > w + t.len + 420) { resetTrail(t, w, h); continue; }
      const col = t.red ? "rgba(255,60,50,1)" : "rgba(255,238,200,1)";
      ctx.globalAlpha = t.a * (0.75 + pulse * 0.25);
      ctx.drawImage(glowSprite(col), t.x - t.len, t.y - t.th * 2.2, t.len * 2, t.th * 4.4);
      ctx.globalAlpha = t.a;
      ctx.fillStyle = t.red ? "rgba(255,120,110,0.8)" : "rgba(255,252,240,0.9)";
      ctx.fillRect(t.x - t.len * 0.2, t.y - t.th * 0.25, t.len * 0.4, Math.max(1, t.th * 0.5));
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // ---- 7. 手前のボケ粒子（被写界深度）----
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const b of bokehNear) {
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x < -140) b.x = w + 120; else if (b.x > w + 140) b.x = -120;
      if (b.y < horizonY * 0.3) b.y = h + 40; else if (b.y > h + 60) b.y = horizonY * 0.4;
      const r = b.r * (1 + pulse * 0.08 + barPulse * 0.05);
      ctx.globalAlpha = b.a * (0.65 + 0.35 * Math.sin(time * 0.8 + b.ph)) * dens;
      ctx.drawImage(bokehSprite(qkey(b.sub ? curSub : curAccent)), b.x - r, b.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // ---- 8. 通行人シルエット（手前を横切る）----
    for (const p of peds) {
      p.x += p.v * dt;
      p.ph += Math.abs(p.v) * dt * 0.14;
      if (p.x < -140) p.x = w + 110; else if (p.x > w + 140) p.x = -110;
      const sp = pedSprites[(p.ph | 0) % pedSprites.length];
      const dw = sp.width * p.scale, dh = sp.height * p.scale;
      const bob = Math.sin(p.ph * Math.PI) * p.scale * 0.6;
      const ty = p.y - dh + bob;
      ctx.save();
      ctx.translate(p.x - dw / 2, 0);
      if (p.v < 0) { ctx.translate(dw, 0); ctx.scale(-1, 1); } // 進行方向へ反転
      // 背後のネオンによる逆光ハロー（先に置く → 本体は黒く抜ける）
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = (0.07 + pulse * 0.05) * p.dark;
      ctx.drawImage(glowSprite(qkey(curAccent)), -dw * 0.4, ty - dh * 0.05, dw * 1.8, dh * 0.95);
      // シルエット本体（ほぼ黒）
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = p.dark;
      ctx.drawImage(sp, 0, ty, dw, dh);
      ctx.restore();
    }

    // ---- 9. 走査ライン（ビネットは CSS 側）----
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = rgba(curAccent, 0.012 + pulse * 0.014);
    const scanY = (time * 90) % h;
    ctx.fillRect(0, scanY, w, 2);
    ctx.fillRect(0, (scanY + h * 0.5) % h, w, 1);
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
