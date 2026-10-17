'use strict';
// The 2D Javis reactor.
// Same five pictures: sonar while ready, a sweep while wake, bars while
// listening, the neural mesh while thinking or speaking. No microphone samples
// here — the public pages use the browser's speech recogniser — so the rings
// breathe on a clock and `level` only rises while a turn is actually live.
(function () {
  const R_MIN = 0.33;
  let graph = null;
  let gx = null;
  let gy = null;

  function buildGraph() {
    let s = 0x2ddbf0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const nodes = [];
    const RINGS = 16, R_IN = 0.36, R_OUT = 0.92, DENSITY = 81;
    for (let k = 0; k < RINGS; k++) {
      const ring = R_IN + (R_OUT - R_IN) * (k / (RINGS - 1));
      const count = Math.round(DENSITY * ring);
      for (let i = 0; i < count; i++) {
        nodes.push({
          a: (i / count) * Math.PI * 2 + rnd() * 0.30,
          r: ring + (rnd() - 0.5) * 0.045,
          size: 0.28 + rnd() * 0.42,
          phase: rnd() * Math.PI * 2,
          da: 0.10 + rnd() * 0.17,
          wa: 0.34 + rnd() * 0.55,
          pa: rnd() * Math.PI * 2,
          dr: 0.040 + rnd() * 0.060,
          wr: 0.40 + rnd() * 0.62,
          pr: rnd() * Math.PI * 2,
        });
      }
    }
    const seen = new Set();
    const edges = [];
    for (let i = 0; i < nodes.length; i++) {
      const ni = nodes[i];
      let b1 = -1, b2 = -1, d1 = Infinity, d2 = Infinity;
      for (let j = 0; j < nodes.length; j++) {
        if (j === i) continue;
        const nj = nodes[j];
        let da = Math.abs(ni.a - nj.a);
        if (da > Math.PI) da = Math.PI * 2 - da;
        const dr = ni.r - nj.r, arc = da * (ni.r + nj.r) * 0.5;
        const d = dr * dr + arc * arc;
        if (d < d1) { d2 = d1; b2 = b1; d1 = d; b1 = j; }
        else if (d < d2) { d2 = d; b2 = j; }
      }
      for (const j of [b1, b2]) {
        if (j < 0) continue;
        const key = i < j ? i + ':' + j : j + ':' + i;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ a: i, b: j, phase: rnd(), speed: 0.30 + rnd() * 0.55, pulse: rnd() < 0.34 });
      }
    }
    return { nodes, edges, pulses: edges.filter((e) => e.pulse) };
  }

  function drawGraph(ctx, c, R, t, energy) {
    if (!graph) graph = buildGraph();
    const nodes = graph.nodes;
    if (!gx || gx.length !== nodes.length) {
      gx = new Float32Array(nodes.length);
      gy = new Float32Array(nodes.length);
    }
    const spin = t * 0.13;
    const live = 0.55 + energy * 0.75;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const a = n.a + spin + Math.sin(t * n.wa + n.pa) * n.da * live;
      const r = Math.max(R_MIN, n.r + Math.sin(t * n.wr + n.pr) * n.dr * live) * R;
      gx[i] = c + Math.cos(a) * r;
      gy[i] = c + Math.sin(a) * r;
    }
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(45,219,240,' + (0.11 + energy * 0.12) + ')';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (const e of graph.edges) {
      ctx.moveTo(gx[e.a], gy[e.a]);
      ctx.lineTo(gx[e.b], gy[e.b]);
    }
    ctx.stroke();
    const pr = 1.4 + energy * 1.3;
    ctx.fillStyle = 'rgba(150,242,255,' + (0.55 + energy * 0.45) + ')';
    ctx.shadowColor = '#2ddbf0';
    ctx.shadowBlur = 8 + energy * 9;
    ctx.beginPath();
    for (const e of graph.pulses) {
      const p = (t * e.speed * (0.6 + energy * 1.5) + e.phase) % 1;
      const sx = gx[e.a] + (gx[e.b] - gx[e.a]) * p;
      const sy = gy[e.a] + (gy[e.b] - gy[e.a]) * p;
      ctx.moveTo(sx + pr, sy);
      ctx.arc(sx, sy, pr, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = 'rgba(45,219,240,' + (0.13 + energy * 0.14) + ')';
    ctx.shadowBlur = 5 + energy * 7;
    ctx.beginPath();
    for (let i = 0; i < nodes.length; i++) {
      const rad = nodes[i].size * (2.0 + energy * 2.0);
      ctx.moveTo(gx[i] + rad, gy[i]);
      ctx.arc(gx[i], gy[i], rad, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    const BEATS = 6;
    for (let b = 0; b < BEATS; b++) {
      const beat = (b + 0.5) / BEATS;
      ctx.fillStyle = 'rgba(165,245,255,' + (0.30 + beat * 0.26 + energy * 0.16) + ')';
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const nb = 0.5 + 0.5 * Math.sin(t * 2.6 + n.phase);
        if (Math.min(BEATS - 1, (nb * BEATS) | 0) !== b) continue;
        const rad = n.size * (1.5 + beat * 0.8 + energy * 1.4);
        ctx.moveTo(gx[i] + rad, gy[i]);
        ctx.arc(gx[i], gy[i], rad, 0, Math.PI * 2);
        any = true;
      }
      if (any) ctx.fill();
    }
  }

  function drawWaitingRipples(ctx, c, R, t, rate, alpha) {
    const RINGS = 3, N = 72;
    for (let i = 0; i < RINGS; i++) {
      const p = (t * rate + i / RINGS) % 1;
      const fade = Math.sin(p * Math.PI) ** 1.5;
      const rBase = R * (0.30 + p * 0.68);
      ctx.strokeStyle = 'rgba(45,219,240,' + (alpha * fade) + ')';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let j = 0; j <= N; j++) {
        const a = (j / N) * Math.PI * 2;
        const amp = R * 0.018 * Math.sin(a * 4 + t * 2 + i);
        const rr = rBase + amp;
        const x = c + Math.cos(a) * rr, y = c + Math.sin(a) * rr;
        j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  function drawOrb(ctx, size, t, state, level) {
    const c = size / 2, R = size * 0.42;
    const CY = '#2ddbf0';
    const idle = state === 'ready';
    const capturing = state === 'wake' || state === 'listening';
    const graphState = state === 'thinking' || state === 'speaking';
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = idle ? 'rgba(45,219,240,.10)' : 'rgba(45,219,240,.18)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.stroke();
    if (graphState) {
      const energy = state === 'speaking'
        ? Math.min(1, 0.45 + level)
        : 0.58 + 0.20 * Math.sin(t * 1.7) + 0.10 * Math.sin(t * 0.63 + 1.1);
      drawGraph(ctx, c, R, t, energy);
      return;
    }
    if (idle || state === 'wake') {
      drawWaitingRipples(ctx, c, R, t, idle ? 0.18 : 0.55, idle ? 0.20 : 0.42);
    }
    const N = 96;
    const rotation = t * (idle ? 0.10 : 0.35);
    ctx.globalAlpha = idle ? 0.45 : 1;
    ctx.strokeStyle = CY; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.shadowColor = CY; ctx.shadowBlur = idle ? 5 : 14;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2 + rotation;
      const amp = R * 0.035 * (Math.sin(a * 3 + t * 1.4) + 0.5 * Math.sin(a * 5 - t * 2.1));
      const rr = R * 0.80 + amp;
      const x = c + Math.cos(a) * rr, y = c + Math.sin(a) * rr;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    if (state === 'wake') {
      const a0 = (t * 1.9) % (Math.PI * 2);
      const g = ctx.createLinearGradient(
        c + Math.cos(a0) * R, c + Math.sin(a0) * R,
        c + Math.cos(a0 - 0.9) * R, c + Math.sin(a0 - 0.9) * R);
      g.addColorStop(0, 'rgba(45,219,240,.55)');
      g.addColorStop(1, 'rgba(45,219,240,0)');
      ctx.strokeStyle = g; ctx.lineWidth = R * 0.30; ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.arc(c, c, R * 0.80, a0 - 0.9, a0);
      ctx.stroke();
      ctx.setLineDash([2, 7]);
      ctx.strokeStyle = 'rgba(45,219,240,.30)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(c, c, R * 0.80, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    const breathe = 1 + Math.sin(t * 1.6) * (idle ? 0.008 : 0.012);
    const r2 = R * 0.52 * (capturing ? 1 + level * 0.30 : breathe);
    ctx.strokeStyle = 'rgba(45,219,240,' + ((idle ? 0.14 : 0.25) + level * 0.5) + ')';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(c, c, r2, 0, Math.PI * 2); ctx.stroke();
    if (capturing && level > 0.01) {
      const n = 56, rIn = R * 0.56;
      ctx.strokeStyle = CY; ctx.lineCap = 'round';
      ctx.shadowColor = CY; ctx.shadowBlur = 12;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        const wob = 0.55 + 0.45 * Math.sin(t * 7 + i * 0.7);
        const len = level * R * 0.20 * wob;
        if (len < 1) continue;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * rIn, c + Math.sin(a) * rIn);
        ctx.lineTo(c + Math.cos(a) * (rIn + len), c + Math.sin(a) * (rIn + len));
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }
  }

  function start(canvas, get) {
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let t0 = 0;
    let rafId = 0;
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = canvas.getBoundingClientRect();
      if (!r.width) return;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
    };
    fit();
    window.addEventListener('resize', fit);
    const frame = (ts) => {
      t0 = t0 || ts;
      const info = get() || {};
      drawOrb(ctx, canvas.width, (ts - t0) / 1000, info.state || 'ready', info.level || 0);
      rafId = requestAnimationFrame(frame);
    };
    rafId = requestAnimationFrame(frame);
    return {
      stop() {
        cancelAnimationFrame(rafId);
        window.removeEventListener('resize', fit);
      },
    };
  }

  window.SangaiTalkReactor = { start: start };
})();
