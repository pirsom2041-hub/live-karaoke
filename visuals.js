// Sound-reactive background on a 2D canvas, plus the full-screen "torch" mode.
export function createVisuals(canvas) {
  const g = canvas.getContext('2d');
  let W = 0, H = 0, hue = 315, targetHue = 315, torch = false, torchHue = 315, torchL = 0;
  const rings = [];
  const sparks = [];

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = canvas.width = Math.round(innerWidth * dpr);
    H = canvas.height = Math.round(innerHeight * dpr);
  }
  resize();
  addEventListener('resize', resize);

  function draw(t, lv) {
    hue += (((targetHue - hue + 540) % 360) - 180) * 0.04;
    const R = Math.max(W, H);

    if (torch) {
      if (lv.beat) { torchL = 1; torchHue = (torchHue + 47) % 360; }
      torchL = Math.max(0.18, torchL * 0.93);
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = `hsl(${torchHue} 100% ${Math.round(18 + torchL * 52)}%)`;
      g.fillRect(0, 0, W, H);
      return;
    }

    g.globalCompositeOperation = 'source-over';
    g.fillStyle = 'rgba(8, 6, 14, 0.34)';
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';

    // Three drifting orbs: size follows bass, brightness follows overall level.
    for (let i = 0; i < 3; i++) {
      const a = t * (0.11 + i * 0.05) + i * 2.1;
      const x = W * (0.5 + 0.36 * Math.cos(a));
      const y = H * (0.42 + 0.3 * Math.sin(a * 1.3 + i));
      const r = R * (0.2 + 0.26 * lv.bass + 0.07 * lv.pulse);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      const h = (hue + i * 38) % 360;
      grd.addColorStop(0, `hsla(${h} 95% 62% / ${0.1 + 0.3 * lv.level + 0.12 * lv.pulse})`);
      grd.addColorStop(1, `hsla(${h} 95% 50% / 0)`);
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }

    if (lv.beat) {
      rings.push({ r: R * 0.05, a: 0.55, h: (hue + 20) % 360 });
      for (let i = 0; i < 6; i++) sparks.push({ x: Math.random() * W, y: H, vy: -(2 + Math.random() * 4) * (H / 700), a: 0.9, h: (hue + Math.random() * 70) % 360, s: 1 + Math.random() * 2.2 });
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const q = rings[i];
      q.r += R * 0.014; q.a *= 0.94;
      if (q.a < 0.02) { rings.splice(i, 1); continue; }
      g.strokeStyle = `hsla(${q.h} 100% 70% / ${q.a})`;
      g.lineWidth = Math.max(2, R * 0.004);
      g.beginPath(); g.arc(W / 2, H * 0.4, q.r, 0, 7); g.stroke();
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.y += s.vy; s.a *= 0.985;
      if (s.y < -10 || s.a < 0.03) { sparks.splice(i, 1); continue; }
      g.fillStyle = `hsla(${s.h} 100% 75% / ${s.a})`;
      g.beginPath(); g.arc(s.x, s.y, s.s * (W / 420), 0, 7); g.fill();
    }
    if (sparks.length > 160) sparks.splice(0, sparks.length - 160);

    // Spectrum along the bottom edge.
    const n = 36, bw = W / n;
    for (let i = 0; i < n; i++) {
      const v = lv.bins ? lv.bins[2 + i * 3] / 255 : Math.max(0, 0.15 + 0.5 * lv.bass * Math.abs(Math.sin(i * 0.9 + t * 3)));
      const h = v * v * H * 0.2;
      g.fillStyle = `hsla(${(hue + i * 3) % 360} 100% 66% / ${0.1 + 0.4 * v})`;
      g.fillRect(i * bw + bw * 0.15, H - h, bw * 0.7, h);
    }
    g.globalCompositeOperation = 'source-over';
  }

  return {
    draw,
    setHue(h) { targetHue = h; },
    setTorch(on) { torch = on; torchL = 1; },
    get torch() { return torch; },
  };
}

export function hueOf(str) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}
