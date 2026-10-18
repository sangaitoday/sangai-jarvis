'use strict';
// A fake force graph, always simulating. Small nodes roam the whole screen and drift on their own. It is not
// live data.
(function () {
  const canvas = document.getElementById('stage');
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const quiet = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  // One node per DENSITY px of screen, kept between MIN and MAX: a phone is not
  // empty and a 4K screen does not make the O(n^2) repulsion slow.
  const DENSITY = 3000;
  const MIN_COUNT = 240;
  const MAX_COUNT = 800;
  const NEIGHBOURS = 3;
  const PAD = 16;
  // Inside EDGE px of a side the field pushes back, so nodes turn round before the wall. The push
  // has to beat the repulsion of the densest field, a phone's.
  const EDGE = 70;
  const EDGE_PUSH = 0.008;
  const FLOW = 0.04;
  // Physics advances in fixed steps, so a 120 Hz display is not twice as fast as a 60 Hz one. At most
  // MAX_STEPS catch up in a frame and at most MAX_CATCHUP_MS of a long frame counts.
  const STEP_MS = 1000 / 60;
  const MAX_STEPS = 2;
  const MAX_CATCHUP_MS = 100;
  // Now and then the whole field rushes in toward the middle in a spiral, bunches, bursts back out
  // through an infinity sign (so it reads round, not square) and circles round the centre. The rush and the burst are only a view transform over the
  // simulation, so the world stays an even, full-screen field. MIN_SCALE keeps most of the
  // bunched field outside the opaque logo disc (34% of the reactor).
  const MIN_SCALE = 0.4;
  // The simulated field is a square whose area-preserving disc view is a circle round the orb that
  // reaches ROUT times the screen's half-diagonal: past every corner, so no edge shows at rest and
  // gathering shrinks a circle, never a rectangle.
  const ROUT = 1.08;
  const TURNS = 0.5;
  // The story, in ms from the first frame. The gaps between gathers repeat through this table: not
  // a metronome, but deterministic.
  const FIRST_GATHER = 6000;
  const GAPS = [38000, 52000, 44000, 60000, 33000, 47000, 56000, 41000];
  const ROUND = GAPS.reduce((a, b) => a + b, 0);
  const RUSH_MS = 5000;
  const TIGHT_MS = 1500;
  const BURST_MS = 2000;
  // The burst first stretches the bunched disc into an infinity sign (two round lobes joined at a
  // narrow neck), holds it a moment so the field is seen to be round, then opens it to full screen.
  // INFINITY_OPEN is how far the view has opened at the sign (the rest of the way is gather).
  const INFINITY_OPEN = 0.12;
  const INFINITY_STRETCH = 0.35;
  const NECK = 0.05;
  const CIRCLE_MS = 14000;
  // Circling is a push, not a view effect: a divergence-free rotation along ellipses that touch all
  // four sides and vanishes on the outermost, so nothing is pushed through a wall, and it needs no
  // undoing at full size. It does shear the springs, so the mesh is rebuilt while it runs.
  const ORBIT = 0.6;
  // Cool colours only (greens, cyans, blues, violets), in keeping with the Jarvis orb.
  const COLORS = [
    '#2ddbf0', '#7af0ff', '#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#c084fc',
    '#4ade80', '#34d399', '#2dd4bf', '#22d3ee', '#86efac', '#67e8f9', '#93c5fd',
  ];
  const nodes = [];
  const links = [];
  let cw = 0;
  let ch = 0;
  let w = 0;
  let h = 0;
  let rest = 50;
  let drag = null;
  let pointer = null;
  let hover = null;
  let scale = 1;
  let gather = 0;
  let lobes = 0;
  let windup = 1;
  let circle = 0;
  let circling = false;
  let relinked = -Infinity;
  let origin = null;
  let lastTs = null;
  let owed = 0;
  let resumed = false;
  let restart = false;
  let calm = false;
  // Links breathe on their own: hidden, a slow fade in to a faint peak, back out, every 5 s.
  const LINK_ALPHA = 0.1;
  const LINK_CYCLE_MS = 5000;

  // Wrap inside the padded area, so a wrapped node is never on the wall.
  const wrap = (v, size) => PAD + ((((v - PAD) % (size - 2 * PAD)) + (size - 2 * PAD)) % (size - 2 * PAD));
  const countFor = (width, height) =>
    Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round((width * height) / DENSITY)));

  const smooth = (p) => p * p * (3 - 2 * p);

  // How gathered the view is (scale) and how hard the circling pushes (circle), elapsed ms in.
  function story(elapsed) {
    scale = 1;
    circle = 0;
    lobes = 0;
    windup = 1;
    let u = elapsed - FIRST_GATHER;
    if (u < 0) return;
    u %= ROUND;
    for (const gap of GAPS) {
      if (u < gap) break;
      u -= gap;
    }
    const burst = RUSH_MS + TIGHT_MS;
    if (u < RUSH_MS) scale = 1 - (1 - MIN_SCALE) * smooth(u / RUSH_MS);
    else if (u < burst) scale = MIN_SCALE;
    else if (u < burst + BURST_MS) {
      const t = (u - burst) / BURST_MS;
      const open = t < 0.4 ? INFINITY_OPEN * smooth(t / 0.4) : INFINITY_OPEN + (1 - INFINITY_OPEN) * smooth((t - 0.4) / 0.6);
      scale = MIN_SCALE + (1 - MIN_SCALE) * open;
      windup = 1 - smooth(Math.min(1, t / 0.25));
      lobes = t < 0.25 ? smooth(t / 0.25) : t < 0.4 ? 1 : 1 - smooth(Math.min(1, (t - 0.4) / 0.3));
    }
    if (u >= burst && u < burst + CIRCLE_MS) {
      const fade = 1 - (u - burst) / CIRCLE_MS;
      circle = Math.min(1, (u - burst) / 800) * fade * fade;
    }
  }

  // Turn about the screen centre, further for the inner field than the outer, zero at full size.
  // The burst unwinds it within its first quarter, so the infinity sign it passes through is level.
  const twist = (rho) => windup * (1 - scale) * TURNS * 2 * Math.PI * 0.3 / (0.3 + rho);
  const reach = () => (ROUT * Math.hypot(cw, ch)) / 2;

  // Radius of the disc the field is drawn in: past the screen corners at rest, MIN_SCALE of the
  // screen's area once gathered (and inside a thin strip).
  function discRadius() {
    const rc = Math.min(MIN_SCALE * Math.sqrt((cw * ch) / Math.PI), Math.min(cw, ch) / 2 - PAD);
    return (1 - gather) * reach() + gather * rc;
  }

  // Where a point at offset (dx, dy) from the centre of the field is drawn, into `spot`. The square
  // field becomes a disc with the area-preserving concentric square-to-disc map (a uniform square
  // becomes a uniform disc, so the galaxy has no lobes), then turns. Bursting out, the disc is
  // first stretched into an infinity sign.
  const spot = { x: 0, y: 0 };
  function place(dx, dy) {
    const radius = discRadius();
    const u = dx / (w / 2);
    const v = dy / (h / 2);
    let ex = 0;
    let ey = 0;
    if (u !== 0 || v !== 0) {
      let r;
      let phi;
      if (Math.abs(u) > Math.abs(v)) {
        r = u;
        phi = (Math.PI / 4) * (v / u);
      } else {
        r = v;
        phi = Math.PI / 2 - (Math.PI / 4) * (u / v);
      }
      ex = r * Math.cos(phi);
      ey = r * Math.sin(phi);
    }
    // The stretch is capped so the sign never leaves the screen, on a phone least of all.
    const stretch = Math.max(0, Math.min(INFINITY_STRETCH, (cw / 2 - PAD) / radius - 1));
    const qx = radius * ex * (1 + stretch * lobes);
    const qy = radius * ey * (1 - lobes * (1 - NECK - (1 - NECK) * Math.abs(ex)));
    // The turn depends on the morphed radius alone, so it only shears the disc and keeps it even.
    const th = twist(Math.hypot(qx, qy) / radius);
    const c = Math.cos(th);
    const s = Math.sin(th);
    spot.x = qx * c - qy * s;
    spot.y = qx * s + qy * c;
  }

  // World point -> where it is drawn, written onto the node so links, nodes and hit-testing agree.
  function project(n) {
    place(n.x - w / 2, n.y - h / 2);
    n.sx = cw / 2 + spot.x;
    n.sy = ch / 2 + spot.y;
  }

  // Screen point -> the world point drawn there. The morph has no closed-form inverse, so Newton
  // steps on `place` with a finite-difference Jacobian (three `place` calls a step, three steps in
  // practice, twelve at most); it runs once or twice a frame, for a pointer only.
  function toWorld(x, y) {
    const tx = x - cw / 2;
    const ty = y - ch / 2;
    const seed = w / 2 / discRadius();
    let px = tx * seed;
    let py = ty * seed;
    for (let i = 0; i < 40; i++) {
      place(px, py);
      const fx = spot.x - tx;
      const fy = spot.y - ty;
      const err = fx * fx + fy * fy;
      if (err < 1e-4) break;
      place(px + 0.5, py);
      const ax = (spot.x - tx - fx) / 0.5;
      const ay = (spot.y - ty - fy) / 0.5;
      place(px, py + 0.5);
      const bx = (spot.x - tx - fx) / 0.5;
      const by = (spot.y - ty - fy) / 0.5;
      const det = ax * by - bx * ay;
      if (Math.abs(det) < 1e-9) break;
      const dxn = (by * fx - bx * fy) / det;
      const dyn = (ax * fy - ay * fx) / det;
      // The infinity sign pinches the map at its neck, so a full step can overshoot: halve it
      // until the miss shrinks.
      let k = 1;
      for (; k > 0.01; k /= 2) {
        place(px - k * dxn, py - k * dyn);
        if ((spot.x - tx) ** 2 + (spot.y - ty) ** 2 < err) break;
      }
      px -= k * dxn;
      py -= k * dyn;
    }
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      px = tx * seed;
      py = ty * seed;
    }
    return { x: w / 2 + px, y: h / 2 + py };
  }

  // A link longer than half the screen can only be one that crosses the wrap seam.
  const seam = (a, b) => Math.abs(a.x - b.x) > w / 2 || Math.abs(a.y - b.y) > h / 2;

  // Each node links to its nearest few, so the mesh stays local wherever it sits. It runs on the
  // main thread while the field circles, so it compares squared distances and allocates nothing
  // per node.
  const bestJ = new Int32Array(NEIGHBOURS);
  const bestD = new Float64Array(NEIGHBOURS);
  function linkNearest() {
    const n = nodes.length;
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      bestD.fill(Infinity);
      const a = nodes[i];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dx = nodes[j].x - a.x;
        const dy = nodes[j].y - a.y;
        const d = dx * dx + dy * dy;
        if (d >= bestD[NEIGHBOURS - 1]) continue;
        let k = NEIGHBOURS - 1;
        while (k > 0 && bestD[k - 1] > d) {
          bestD[k] = bestD[k - 1];
          bestJ[k] = bestJ[k - 1];
          k--;
        }
        bestD[k] = d;
        bestJ[k] = j;
      }
      for (let k = 0; k < NEIGHBOURS; k++) {
        if (bestD[k] === Infinity) break;
        const j = bestJ[k];
        const key = i < j ? i * n + j : j * n + i;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ a: i, b: j });
      }
    }
  }

  function relink() {
    links.length = 0;
    linkNearest();
  }

  function seedNodes() {
    nodes.length = 0;
    links.length = 0;
    let seed = 0x2ddbf0;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const count = countFor(w, h);
    for (let i = 0; i < count; i++) {
      nodes.push({
        x: PAD + rnd() * (w - 2 * PAD),
        y: PAD + rnd() * (h - 2 * PAD),
        vx: 0,
        vy: 0,
        r: 0.8 + rnd() * 1.2,
        color: COLORS[(rnd() * COLORS.length) | 0],
        sx: 0,
        sy: 0,
      });
    }
    for (const n of nodes) project(n);
    relink();
  }

  function fit() {
    const nw = canvas.clientWidth;
    const nh = canvas.clientHeight;
    // Too small to hold a padded field (or not laid out yet): keep what we have.
    if (nw < 4 * PAD || nh < 4 * PAD) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const ow = w;
    const oh = h;
    cw = nw;
    ch = nh;
    w = Math.sqrt(Math.PI) * reach();
    h = w;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = countFor(w, h);
    if (!ow || !oh || Math.abs(want - nodes.length) > want * 0.2) {
      hover = null;
      drag = null;
      seedNodes();
    } else if (w !== ow || h !== oh) {
      for (const n of nodes) {
        n.x *= w / ow;
        n.y *= h / oh;
        project(n);
      }
      relink();
    }
    rest = 0.9 * Math.sqrt((w * h) / nodes.length);
  }

  // A slow flow that neighbours share, so patches of the mesh travel together. It comes from a
  // stream function that is zero on the screen edge: it has no divergence, so it never bunches
  // nodes up or leaves a gap, and nothing is pushed into a wall.
  const push = { x: 0, y: 0 };
  function flow(x, y, t) {
    const gx = (Math.PI * x) / w;
    const gy = (Math.PI * y) / h;
    const c1 = Math.cos(t * 0.2);
    const c2 = Math.sin(t * 0.15);
    const side = Math.min(w, h);
    push.x = (side / h) * (c1 * Math.sin(2 * gx) * Math.cos(gy) + 2 * c2 * Math.sin(gx) * Math.cos(2 * gy));
    push.y = -(side / w) * (2 * c1 * Math.cos(2 * gx) * Math.sin(gy) + c2 * Math.sin(2 * gy) * Math.cos(gx));
  }

  function step(t) {
    const n = nodes.length;
    const aim = pointer && !drag ? toWorld(pointer.x, pointer.y) : null;
    const drift = calm ? 0 : FLOW;
    const semiX = w / 2 - PAD;
    const semiY = h / 2 - PAD;
    const minor = Math.min(semiX, semiY);
    // Angular speed stays the same on every screen size: the push grows with the smaller half-axis.
    const push2 = (ORBIT * circle * minor) / 450;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) d2 = 1;
        if (d2 > 140 * 140) continue;
        const d = Math.sqrt(d2);
        const f = 90 / d2;
        dx = dx / d * f;
        dy = dy / d * f;
        a.vx += dx;
        a.vy += dy;
        b.vx -= dx;
        b.vy -= dy;
      }
      flow(a.x, a.y, t);
      a.vx += push.x * drift;
      a.vy += push.y * drift;
      if (circle > 0.001) {
        // Round the ellipse that touches all four sides, the way the burst unwound the twist.
        const dx = a.x - w / 2;
        const dy = a.y - h / 2;
        const re = Math.hypot(dx / semiX, dy / semiY);
        if (re > 0.001 && re < 1) {
          const g = (Math.sin(Math.PI * re) / re) * push2;
          a.vx += (g * dy * minor) / (semiY * semiY);
          a.vy -= (g * dx * minor) / (semiX * semiX);
        }
      }
      if (a.x < EDGE) a.vx += (EDGE - a.x) * EDGE_PUSH;
      else if (a.x > w - EDGE) a.vx -= (a.x - (w - EDGE)) * EDGE_PUSH;
      if (a.y < EDGE) a.vy += (EDGE - a.y) * EDGE_PUSH;
      else if (a.y > h - EDGE) a.vy -= (a.y - (h - EDGE)) * EDGE_PUSH;
      if (hover === a && aim) {
        a.vx += (aim.x - a.x) * 0.05;
        a.vy += (aim.y - a.y) * 0.05;
      }
    }
    for (const link of links) {
      const a = nodes[link.a];
      const b = nodes[link.b];
      if (seam(a, b)) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const f = (dist - rest) * 0.003;
      const ux = dx / dist * f;
      const uy = dy / dist * f;
      a.vx += ux;
      a.vy += uy;
      b.vx -= ux;
      b.vy -= uy;
    }
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      if (drag && drag.node === a) continue;
      a.vx *= 0.96;
      a.vy *= 0.96;
      a.x += a.vx * 0.22;
      a.y += a.vy * 0.22;
      if (a.x < PAD) { a.x = PAD; a.vx *= -0.4; }
      if (a.y < PAD) { a.y = PAD; a.vy *= -0.4; }
      if (a.x > w - PAD) { a.x = w - PAD; a.vx *= -0.4; }
      if (a.y > h - PAD) { a.y = h - PAD; a.vy *= -0.4; }
    }
  }

  function strokeLinks(alpha, keep) {
    ctx.strokeStyle = `rgba(45, 219, 240, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    for (const link of links) {
      if (!keep(link)) continue;
      const a = nodes[link.a];
      const b = nodes[link.b];
      if (seam(a, b)) continue;
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
    }
    ctx.stroke();
  }

  function draw(ts) {
    ctx.clearRect(0, 0, cw, ch);
    ctx.lineWidth = 1;
    for (const n of nodes) project(n);
    // Reduced motion: the links sit still at half their peak instead of fading in and out.
    const pulse = calm ? 0.5 : (1 - Math.cos((2 * Math.PI * (ts % LINK_CYCLE_MS)) / LINK_CYCLE_MS)) / 2;
    const touches = (link) => nodes[link.a] === hover || nodes[link.b] === hover;
    if (pulse > 0.01) strokeLinks(LINK_ALPHA * pulse, (link) => !hover || !touches(link));
    // A hovered node's own links stay at the peak, whatever the cycle is doing.
    if (hover) strokeLinks(LINK_ALPHA, touches);
    for (const a of nodes) {
      const hot = hover === a;
      // Smaller as the field gathers, so the core stays a glow and not a white blot.
      const rad = a.r * (0.6 + 0.4 * scale) * (hot ? 3 : 1);
      if (hot) {
        ctx.strokeStyle = a.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(a.sx, a.sy, rad + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = a.color;
      ctx.beginPath();
      ctx.arc(a.sx, a.sy, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function frame(ts) {
    if (origin === null || restart) origin = ts;
    restart = false;
    // Back from a hidden tab: the story carries on where it paused, the hidden time does not count.
    if (resumed && lastTs !== null) {
      origin += Math.max(0, ts - lastTs - STEP_MS);
      lastTs = ts - STEP_MS; // the frame after a hidden tab is one ordinary frame, not a catch-up
      owed = 0;
    }
    resumed = false;
    if (calm) { scale = 1; circle = 0; lobes = 0; windup = 1; } else story(ts - origin);
    gather = (1 - scale) / (1 - MIN_SCALE);
    if (circle > 0.001) {
      if (ts - relinked >= 1000) { relink(); relinked = ts; }
      circling = true;
    } else if (circling) {
      relink();
      circling = false;
    }
    if (w && h) {
      // A node being dragged stays under a resting pointer while the view moves.
      if (drag && drag.node && pointer) holdNode(drag.node, pointer);
      owed += lastTs === null ? STEP_MS : Math.max(0, Math.min(MAX_CATCHUP_MS, ts - lastTs));
      let steps = 0;
      while (owed >= STEP_MS && steps < MAX_STEPS) {
        step(ts / 1000);
        owed -= STEP_MS;
        steps++;
      }
      owed = Math.min(owed, STEP_MS);
      draw(ts);
    }
    lastTs = ts;
    requestAnimationFrame(frame);
  }

  function point(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  // Put a node at the world point under a screen point, inside the canvas.
  function holdNode(node, at) {
    const wp = toWorld(at.x, at.y);
    node.x = Math.max(0, Math.min(w, wp.x));
    node.y = Math.max(0, Math.min(h, wp.y));
    node.vx = 0;
    node.vy = 0;
  }

  function nearest(x, y) {
    let best = null;
    let bestD = 22;
    for (const n of nodes) {
      const d = Math.hypot(n.sx - x, n.sy - y);
      if (d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  function aim(ev) {
    pointer = point(ev);
    if (!drag) hover = nearest(pointer.x, pointer.y);
    canvas.style.cursor = drag ? 'grabbing' : hover ? 'pointer' : 'grab';
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const p = point(ev);
    pointer = p;
    const node = nearest(p.x, p.y);
    hover = node;
    drag = node
      ? { node: node, pan: false }
      : { node: null, pan: true, x: p.x, y: p.y };
    if (node) holdNode(node, p);
    canvas.setPointerCapture(ev.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (ev) => {
    aim(ev);
    if (!drag) return;
    const p = pointer;
    if (drag.node) {
      holdNode(drag.node, p);
      return;
    }
    // Move the world by what the pointer moved over it, whatever the view is doing.
    const from = toWorld(drag.x, drag.y);
    const to = toWorld(p.x, p.y);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    drag.x = p.x;
    drag.y = p.y;
    // The field wraps round the screen, so a long pan never packs it against a wall.
    for (const n of nodes) {
      n.x = wrap(n.x + dx, w);
      n.y = wrap(n.y + dy, h);
    }
  });
  canvas.addEventListener('pointerleave', () => {
    if (drag) return;
    pointer = null;
    hover = null;
    canvas.style.cursor = 'grab';
  });
  function release() {
    if (drag && drag.pan) relink();
    drag = null;
    hover = pointer ? nearest(pointer.x, pointer.y) : null;
    canvas.style.cursor = hover ? 'pointer' : 'grab';
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resumed = true; });
  }
  if (quiet) {
    calm = quiet.matches;
    if (typeof quiet.addEventListener === 'function') quiet.addEventListener('change', (ev) => {
      // Turning it off starts the story afresh, as on load, instead of landing wherever its clock is.
      if (calm && !ev.matches) restart = true;
      calm = ev.matches;
    });
  }
  fit();
  window.addEventListener('resize', fit);
  requestAnimationFrame(frame);
})();
