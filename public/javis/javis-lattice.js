'use strict';
// javis-lattice.js — the pure arithmetic behind the 3D reactor: where the
// nodes sit on the sphere, which of them are wired together, and how much energy
// each state is carrying.
//
// WHY THIS IS ITS OWN FILE AND NOT PART OF javis-reactor3d.js
// The same reason javis-viseme.js is split out of javis-avatar.js, and it is worth
// restating rather than cross-referencing: everything here is arithmetic on numbers.
// No DOM, no WebGL, no three.js, no audio API. That makes it the one part of the
// reactor `node:test` can cover COMPLETELY, with no fake renderer and no module
// loader. The renderer next door can only be tested through an injection seam, so
// anything that can live here should.
//
// WHAT THIS REPLACES
// javis.js's `GRAPH` block built the same idea on a FLAT ANNULUS: 16 concentric
// rings between 0.36R and 0.92R, `count ∝ r` so areal density stayed even, and a
// hole in the middle because the 96px mic button sits inside the ring. That code is
// still there and still correct — it is the 2D fallback. This file is the sphere.
//
// THE THREE THINGS THAT CHANGE ON A SPHERE, AND THE THREE THAT DO NOT
// Changed: bands are spaced by EQUAL AREA rather than evenly in radius; population
// scales with sin(latitude) rather than with radius; and there is no centre hole,
// because the mic button now sits IN FRONT of the sphere and occludes the middle by
// itself — which is a correct depth read rather than clutter.
// Unchanged: the seeded generator (so the shape is recognisable across reloads), the
// per-node bounded sway, and nearest-2 wiring with a third of the edges carrying a
// travelling signal.

(() => {
  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  // Deterministic PRNG, same LCG and same seed as the 2D graph. A fixed TOPOLOGY is
  // what makes this read as "Javis's brain" rather than a random scatter; the
  // POSITIONS still move, via the per-node drift below.
  function lcg(seed) {
    let s = seed >>> 0;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  }

  // BANDS/DENSITY are chosen to land on the SAME node budget as the 2D mesh (~830),
  // because that count was tuned by eye and there is no reason for the sphere to
  // spend more. The arithmetic, since it is not obvious: with bands spaced evenly in
  // cos(φ) the mean of sin(φ) across them is ∫₀^π sin²φ dφ / 2 = π/4 ≈ 0.785, so the
  // total is BANDS × DENSITY × 0.785. At 16 × 66 that is ≈ 829.
  const DEFAULTS = {
    seed: 0x2ddbf0,
    bands: 16,
    density: 66,
    // A SHELL, not a solid ball. A filled sphere hides its own far side and reads as
    // a blob; a thin shell lets the back surface show through the front, which is
    // where the sense of volume actually comes from.
    rIn: 0.88,
    rOut: 1.0,
  };

  // buildSphere(opts) -> { nodes, edges, pulses }
  //
  // opts.multiplier scales the node budget (1 = the ~830 above): bands and density
  // each grow by its square root, so the spacing stays equal-area.
  //
  // node = {
  //   th, ph, r      longitude (0..2π), polar angle (0..π), radius
  //   size, phase    dot size and its own breathing phase
  //   da, wa, pa     longitude sway: amplitude, frequency, phase
  //   dp, wp, pp     latitude sway — the axis a flat ring did not have
  //   dr, wr, pr     radial drift, i.e. how much it breathes through the shell
  // }
  function buildSphere(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const grow = Math.sqrt(Number(o.multiplier) > 0 ? Number(o.multiplier) : 1);
    o.bands = Math.round(o.bands * grow);
    o.density = Math.round(o.density * grow);
    const rnd = lcg(o.seed);
    const nodes = [];

    for (let k = 0; k < o.bands; k++) {
      // EQUAL-AREA bands. Spacing φ evenly instead would pack the poles solid and
      // leave the equator thin — the same mistake, mirrored, that `count ∝ r` exists
      // to prevent on the flat version. Uniform in cos(φ) makes every band carry the
      // same surface area, so an even population per unit area is the only thing
      // left to arrange.
      const cosPhi = 1 - 2 * (k + 0.5) / o.bands;
      const ph = Math.acos(cosPhi);
      // Population follows the band's CIRCUMFERENCE, which on a sphere is sin(φ) —
      // the direct analogue of `count ∝ r` in the annulus.
      const count = Math.max(1, Math.round(o.density * Math.sin(ph)));

      for (let i = 0; i < count; i++) {
        nodes.push({
          // The jitter matters: a perfectly regular lattice reads as a wireframe
          // globe — a manufactured object — where a slightly irregular one reads as
          // a swarm. Scaled by 1/count so the jitter is a fraction of the local
          // spacing rather than a fixed angle that would overlap at the poles.
          th: (i / count) * Math.PI * 2 + rnd() * (Math.PI * 2 / count) * 0.9,
          ph: ph + (rnd() - 0.5) * (Math.PI / o.bands) * 0.55,
          r: o.rIn + (o.rOut - o.rIn) * rnd(),

          size: 0.28 + rnd() * 0.42,
          phase: rnd() * Math.PI * 2,

          // Longitude sway — the direct port of the 2D `da/wa/pa`.
          da: 0.10 + rnd() * 0.17,
          wa: 0.34 + rnd() * 0.55,
          pa: rnd() * Math.PI * 2,

          // Latitude sway. NEW, and the whole reason the sphere reads as alive
          // rather than as a rotating globe: on the flat version a node could only
          // wander around the ring and in and out of it, so the mesh always looked
          // like one rigid body turning. Here neighbours also slide PAST each other
          // vertically. Deliberately smaller and slower than the longitude term —
          // at equal amplitude the cloud churns and stops reading as a surface.
          dp: 0.05 + rnd() * 0.09,
          wp: 0.21 + rnd() * 0.34,
          pp: rnd() * Math.PI * 2,

          // Radial drift — how far it breathes through the shell's thickness.
          dr: 0.020 + rnd() * 0.035,
          wr: 0.40 + rnd() * 0.62,
          pr: rnd() * Math.PI * 2,
        });
      }
    }

    const { edges, pulses } = wire(nodes, rnd);
    return { nodes, edges, pulses };
  }

  // Unit-sphere position of a node at rest. Used for wiring (which happens once, on
  // the resting layout) and by the tests. The renderer computes the ANIMATED version
  // of this in its vertex shader — see javis-reactor3d.js's NODE_POSITION glsl,
  // which is this same formula with the sway terms added.
  function restPosition(n) {
    const sp = Math.sin(n.ph);
    return [n.r * sp * Math.cos(n.th), n.r * Math.cos(n.ph), n.r * sp * Math.sin(n.th)];
  }

  // Each node keeps its two nearest neighbours, deduped so a mutual pair is one edge.
  //
  // SELECTION, not a sort — the same correction the 2D version documents. Building an
  // index array per node and sorting it to take the first two is O(n² log n) with a
  // comparator that recomputes the distance on every comparison; at 830 nodes that is
  // tens of millions of distance computations on the main thread while the panel is
  // trying to appear. Keeping the best two in one pass computes each distance exactly
  // once.
  //
  // CHORD distance, not great-circle. Ordering is all that matters here, and chord
  // length is monotonic in angle, so the acos every great-circle distance would need
  // buys nothing but 690k transcendental calls.
  //
  // A GRID, not all pairs: at 8300 nodes an all-pairs scan is ~70M distances (~320 ms).
  // Nodes are bucketed into cubes sized for ~4 per surface cell, and each search walks
  // outward ring by ring until nothing unvisited could beat the second-best — the
  // same two neighbours the all-pairs scan finds.
  function wire(nodes, rnd) {
    const n = nodes.length;
    const pos = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const p = restPosition(nodes[i]);
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
    }

    const cell = Math.sqrt(16 * Math.PI / Math.max(1, n));
    const G = Math.ceil(2.2 / cell);
    const cellOf = (v) => Math.min(G - 1, Math.max(0, Math.floor((v + 1.1) / cell)));
    const home = new Int32Array(n);
    const start = new Int32Array(G * G * G + 1);
    for (let i = 0; i < n; i++) {
      home[i] = (cellOf(pos[i * 3]) * G + cellOf(pos[i * 3 + 1])) * G + cellOf(pos[i * 3 + 2]);
      start[home[i] + 1]++;
    }
    for (let c = 0; c < G * G * G; c++) start[c + 1] += start[c];
    const items = new Int32Array(n);
    const fill = start.slice(0, G * G * G);
    for (let i = 0; i < n; i++) items[fill[home[i]]++] = i;
    const grid = { G, cell, cellOf, start, items };

    const seen = new Set();
    const edges = [];
    for (let i = 0; i < n; i++) {
      const { b1, b2 } = nearestTwo(pos, grid, i);
      for (const j of [b1, b2]) {
        if (j < 0) continue;
        const key = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Only a MINORITY carries a travelling signal. One pulse per edge was right
        // at 56 edges; at ~1000 it is a swarm of moving dots that hides the mesh it
        // is supposed to be travelling through. A third keeps the "something is being
        // carried" reading while leaving the network itself visible.
        edges.push({ a: i, b: j, phase: rnd(), speed: 0.30 + rnd() * 0.55, pulse: rnd() < 0.34 });
      }
    }
    return { edges, pulses: edges.filter((e) => e.pulse) };
  }

  // After ring r every unvisited node is at least r cells away, so the search stops once
  // the second-best is within that reach.
  function nearestTwo(pos, grid, i) {
    const best = { b1: -1, b2: -1, d1: Infinity, d2: Infinity };
    for (let r = 0; r <= grid.G; r++) {
      scanRing(pos, grid, i, r, best);
      if (best.b2 >= 0 && best.d2 <= (r * grid.cell) ** 2) break;
    }
    return best;
  }

  // The cells whose Chebyshev distance from i's cell is exactly r, as one flat loop.
  function scanRing(pos, grid, i, r, best) {
    const { G, cellOf, start, items } = grid;
    const xi = pos[i * 3], yi = pos[i * 3 + 1], zi = pos[i * 3 + 2];
    const cx = cellOf(xi), cy = cellOf(yi), cz = cellOf(zi);
    const w = 2 * r + 1;
    for (let t = 0; t < w * w * w; t++) {
      const dx = (t % w) - r, dy = (Math.floor(t / w) % w) - r, dz = Math.floor(t / (w * w)) - r;
      if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
      const x = cx + dx, y = cy + dy, z = cz + dz;
      if (x < 0 || y < 0 || z < 0 || x >= G || y >= G || z >= G) continue;
      const c = (x * G + y) * G + z;
      for (let k = start[c]; k < start[c + 1]; k++) {
        const j = items[k];
        const ex = xi - pos[j * 3], ey = yi - pos[j * 3 + 1], ez = zi - pos[j * 3 + 2];
        consider(best, j === i ? Infinity : ex * ex + ey * ey + ez * ez, j);
      }
    }
  }

  // Ties go to the lower index, as the all-pairs scan in index order resolved them.
  function consider(best, d, j) {
    if (d < best.d1 || (d === best.d1 && j < best.b1)) {
      best.d2 = best.d1; best.b2 = best.b1; best.d1 = d; best.b1 = j;
    } else if (d < best.d2 || (d === best.d2 && j < best.b2)) {
      best.d2 = d; best.b2 = j;
    }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  // Per-state weights. Every one of these is a 0..1 dial the shaders multiply by, so
  // a state change can be EASED rather than switched — the same reasoning as
  // javis-orb.js's lerped `uState`: a morph is a visible transition, a switch is a
  // jump cut.
  //
  //   graph   how present the mesh, its edges and its pulses are
  //   sonar   rate of the outward wave travelling through the shell (0 = none)
  //   sweep   the wake radar band
  //   spokes  the listening equaliser
  //   wave    the traced waveform ring
  //   spin    global rotation rate multiplier
  //   glow    the fbm energy field behind everything
  //
  // The field's weighting is the one place this table is NOT a straight port. On the
  // 2D panel the backdrop was CSS-faded and only appeared for thinking/speaking; here
  // it shares a canvas with the subject, so it is dialled per state instead — present
  // but faint at rest, so `ready` reads as a lit object rather than a black hole, and
  // full only where the shader orb used to show it at all.
  const STATE = {
    ready: { graph: 0.22, sonar: 0.18, sweep: 0, spokes: 0, wave: 0.45, spin: 0.55, glow: 0.35, think: 0 },
    wake: { graph: 0.30, sonar: 0.55, sweep: 1, spokes: 0, wave: 1.00, spin: 0.85, glow: 0.50, think: 0 },
    listening: { graph: 0.38, sonar: 0.30, sweep: 0, spokes: 1, wave: 1.00, spin: 0.90, glow: 0.70, think: 0 },
    thinking: { graph: 1.00, sonar: 0, sweep: 0, spokes: 0, wave: 0, spin: 1.00, glow: 0.55, think: 1 },
    speaking: { graph: 1.00, sonar: 0, sweep: 0, spokes: 0, wave: 1.00, spin: 1.15, glow: 1.00, think: 0 },
  };
  const DIALS = Object.keys(STATE.ready);
  const STATES = Object.keys(STATE);

  // Energy — 0..1, and the single number that decides how alive the sphere looks.
  // Lifted verbatim from javis.js's drawOrb so the two renderers agree:
  //   speaking  the REAL reply amplitude, which is what makes the state "brain and
  //             audio" rather than the same loop in a new colour
  //   thinking  two beats, a slow swell with a faster one riding on it. A single sine
  //             reads as a heartbeat monitor rather than as thought.
  //   the rest  the microphone, so an open mic visibly moves the sphere
  function stateEnergy(state, t, level) {
    const lv = Math.max(0, Math.min(1, Number(level) || 0));
    if (state === 'speaking') return Math.min(1, lv * 1.15);
    if (state === 'thinking') return 0.58 + 0.20 * Math.sin(t * 1.7) + 0.10 * Math.sin(t * 0.63 + 1.1);
    return Math.min(1, lv);
  }

  // The eased dial set. javis-reactor3d.js holds one of these and advances it every
  // frame; the shaders read the result. `k` is the same 0.08 both javis-orb.js and
  // javis-avatar.js use for their morphs, so all three settle at the same rate and a
  // state change looks like one movement rather than three.
  function createMixer(initial = 'ready') {
    const now = { ...STATE[initial] || STATE.ready };
    let target = STATE[initial] || STATE.ready;
    let name = STATE[initial] ? initial : 'ready';

    return {
      get state() { return name; },
      // An unknown name leaves the dials where they are rather than snapping to a
      // default — the caller is mid-transition and a third value underneath would be
      // visible.
      setState(s) {
        if (!STATE[s]) return;
        name = s; target = STATE[s];
      },
      advance(k = 0.08) {
        for (const d of DIALS) now[d] += (target[d] - now[d]) * k;
        return now;
      },
      get dials() { return now; },
    };
  }

  // ---------------------------------------------------------------------------
  // GPU packing
  // ---------------------------------------------------------------------------

  // The buffers the renderer uploads once and never touches again. Everything that
  // moves is computed in the vertex shader from these plus a couple of uniforms,
  // which is what takes the per-frame CPU cost from an 830-iteration loop to two
  // uniform writes.
  //
  // Attribute names are the contract with javis-reactor3d.js's GLSL; they are
  // asserted in the tests so a rename cannot silently produce an empty sphere.
  function packNodes(graph) {
    const n = graph.nodes.length;
    const aSphere = new Float32Array(n * 3);   // th, ph, r
    const aSway = new Float32Array(n * 4);     // da, wa, pa, dr
    const aSway2 = new Float32Array(n * 3);    // wr, pr, dp
    const aSway3 = new Float32Array(n * 2);    // wp, pp
    const aNode = new Float32Array(n * 2);     // size, phase

    for (let i = 0; i < n; i++) {
      const d = graph.nodes[i];
      aSphere[i * 3] = d.th; aSphere[i * 3 + 1] = d.ph; aSphere[i * 3 + 2] = d.r;
      aSway[i * 4] = d.da; aSway[i * 4 + 1] = d.wa; aSway[i * 4 + 2] = d.pa; aSway[i * 4 + 3] = d.dr;
      aSway2[i * 3] = d.wr; aSway2[i * 3 + 1] = d.pr; aSway2[i * 3 + 2] = d.dp;
      aSway3[i * 2] = d.wp; aSway3[i * 2 + 1] = d.pp;
      aNode[i * 2] = d.size; aNode[i * 2 + 1] = d.phase;
    }
    return { count: n, aSphere, aSway, aSway2, aSway3, aNode };
  }

  // Edges become a flat vertex list — two vertices per edge, each carrying its OWN
  // node's attributes, so the identical vertex-shader function positions both ends
  // and nothing has to be looked up.
  function packEdges(graph) {
    const src = packNodes(graph);
    const m = graph.edges.length * 2;
    const out = {
      count: m,
      aSphere: new Float32Array(m * 3),
      aSway: new Float32Array(m * 4),
      aSway2: new Float32Array(m * 3),
      aSway3: new Float32Array(m * 2),
      aNode: new Float32Array(m * 2),
    };
    let v = 0;
    for (const e of graph.edges) {
      for (const idx of [e.a, e.b]) {
        copyVertex(src, idx, out, v);
        v++;
      }
    }
    return out;
  }

  // Pulses carry BOTH endpoints, and the shader lerps between them by
  // fract(t·speed·(0.6 + energy·1.5) + phase) — the identical travel formula the 2D
  // version uses, so a pulse crosses its edge at the same rate in either renderer.
  function packPulses(graph) {
    const src = packNodes(graph);
    const m = graph.pulses.length;
    const out = {
      count: m,
      aSphere: new Float32Array(m * 3), aSway: new Float32Array(m * 4),
      aSway2: new Float32Array(m * 3), aSway3: new Float32Array(m * 2),
      aNode: new Float32Array(m * 2),
      bSphere: new Float32Array(m * 3), bSway: new Float32Array(m * 4),
      bSway2: new Float32Array(m * 3), bSway3: new Float32Array(m * 2),
      aTravel: new Float32Array(m * 2),   // phase, speed
    };
    for (let i = 0; i < m; i++) {
      const e = graph.pulses[i];
      copyVertex(src, e.a, out, i);
      copyVertex(src, e.b, out, i, 'b');
      out.aTravel[i * 2] = e.phase;
      out.aTravel[i * 2 + 1] = e.speed;
    }
    return out;
  }

  // One node's attributes → one vertex slot. `prefix` picks the a*/b* family so the
  // pulse packer can write both endpoints without a second copy of this.
  function copyVertex(src, idx, out, v, prefix = 'a') {
    const P = (name) => out[prefix + name];
    for (let c = 0; c < 3; c++) P('Sphere')[v * 3 + c] = src.aSphere[idx * 3 + c];
    for (let c = 0; c < 4; c++) P('Sway')[v * 4 + c] = src.aSway[idx * 4 + c];
    for (let c = 0; c < 3; c++) P('Sway2')[v * 3 + c] = src.aSway2[idx * 3 + c];
    for (let c = 0; c < 2; c++) P('Sway3')[v * 2 + c] = src.aSway3[idx * 2 + c];
    // Pulses do not need the b-side size/phase — the dot is drawn once, at the
    // interpolated point, so only the a-side family carries aNode.
    if (prefix === 'a' && out.aNode) {
      for (let c = 0; c < 2; c++) out.aNode[v * 2 + c] = src.aNode[idx * 2 + c];
    }
  }

  // The listening equaliser's directions. A Fibonacci lattice rather than the 2D
  // version's 56 evenly-spaced angles, because "evenly spaced" has no good meaning on
  // a sphere: any latitude/longitude grid bunches at the poles, and the spikes would
  // read as a hairy hat rather than a hedgehog. The golden-angle lattice is the
  // standard fix and needs no iteration to converge.
  function spokeDirections(count = 56) {
    const dirs = new Float32Array(count * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
      const y = 1 - (i / Math.max(1, count - 1)) * 2;   // +1 .. -1
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      dirs[i * 3] = Math.cos(th) * rad;
      dirs[i * 3 + 1] = y;
      dirs[i * 3 + 2] = Math.sin(th) * rad;
    }
    return dirs;
  }

  const api = {
    lcg, buildSphere, restPosition, wire,
    STATE, STATES, DIALS, stateEnergy, createMixer,
    packNodes, packEdges, packPulses, spokeDirections,
    DEFAULTS,
  };

  // Dual tail, same as every other file here: CommonJS for node:test, a global for
  // the browser, and no module system in between.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SangaiJavisLattice = api;
})();
