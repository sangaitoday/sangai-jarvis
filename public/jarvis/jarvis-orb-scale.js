'use strict';
// jarvis-orb-scale.js — how big the 3D orb may be on this device. Pure arithmetic: every
// input (CSS size, devicePixelRatio, GL limits, navigator hints, frame times, the
// clock) is passed in, so node:test covers it whole and every surface that mounts the
// orb shares one copy.
//
// Two budgets. The NODE MULTIPLIER is how many times jarvis-lattice.js's ~830 nodes the
// sphere is built with (1, 2, 5 or 10). The RENDER SCALE is how many times the device
// pixels the orb's canvas is backed at (1..10), so it stays sharp under zoom. Both
// start from what the device can afford and are walked down by the governor when frames
// run slow: resolution first, nodes only once the resolution is at its floor.

(() => {
  const RES_SCALE_MIN = 1, RES_SCALE_MAX = 10;
  const MAX_BACKING_PX = 8192;
  const PIXEL_BUDGET = 24e6, PIXEL_BUDGET_CONSTRAINED = 4e6;
  const BUILD_BUDGET_MS = 60;
  const FRAME_WINDOW = 60, SLOW_FRAME_MS = 22, FAST_FRAME_MS = 12, FRAME_GAP_MS = 250;
  const SCALE_COOLDOWN_MS = 2000, SCALE_UP_DWELL_MS = 3000;
  const NODE_SLOW_DWELL_MS = 5000, NODE_COOLDOWN_MS = 10000;

  // Gains on jarvis-reactor3d.js's own look, per multiplier, tuned by screenshot. A denser
  // sphere gets smaller nodes or its additive glow runs together into a white ball.
  const LOOK = {
    1: { nodeSize: 2.0, nodeLit: 1.3, edgeAlpha: 1.6 },
    2: { nodeSize: 1.9, nodeLit: 1.3, edgeAlpha: 1.4 },
    5: { nodeSize: 1.75, nodeLit: 1.35, edgeAlpha: 1.2 },
    10: { nodeSize: 1.6, nodeLit: 1.15, edgeAlpha: 1.0 },
  };
  // WebGL draws lines one backing pixel wide, so at render scale N an edge covers 1/N of
  // a screen pixel. Edge alpha is raised with the scale to win some of that back; past
  // the cap it only saturates the lines into bright dashes.
  const EDGE_SCALE_GAIN_MAX = 3;

  // `undefined <= 4` is false, so a browser that hides a hint is not held back by it.
  function isConstrained({ coarse, cores, memory }) {
    return Boolean(coarse) || cores <= 4 || memory <= 4;
  }

  function chooseNodeMultiplier({ constrained, cores, memory, maxRenderbuffer }) {
    if (constrained) return cores <= 2 || memory <= 2 ? 1 : 2;
    const strong = cores >= 8 && (memory === undefined || memory >= 8) && maxRenderbuffer >= 8192;
    return strong ? 10 : 5;
  }

  // Halves the multiplier (10, 5, 2, 1) until buildMs(m) fits the mount-time budget.
  function settleNodeMultiplier(m, buildMs) {
    let n = m;
    while (n > 1 && buildMs(n) > BUILD_BUDGET_MS) n = Math.max(1, Math.floor(n / 2));
    return n;
  }

  function glLimit(maxRenderbuffer, maxViewport) {
    return Math.min(MAX_BACKING_PX, maxRenderbuffer, maxViewport[0], maxViewport[1]);
  }

  function renderScaleCap({ cssW, cssH, dpr, glMax, constrained }) {
    const budget = constrained ? PIXEL_BUDGET_CONSTRAINED : PIXEL_BUDGET;
    const byGl = Math.floor(Math.min(MAX_BACKING_PX, glMax) / (Math.max(cssW, cssH) * dpr));
    const byBudget = Math.floor(Math.sqrt(budget / (cssW * cssH * dpr * dpr)));
    return Math.max(RES_SCALE_MIN, Math.min(RES_SCALE_MAX, byGl, byBudget));
  }

  function backingSize({ cssW, cssH, dpr, scale, glMax }) {
    const px = dpr * scale;
    const fit = Math.min(1, glMax / (cssW * px), glMax / (cssH * px));
    return [Math.round(cssW * px * fit), Math.round(cssH * px * fit)];
  }

  // Watches frame times over a rolling window. tick() answers 'scale' when the render
  // scale moved, 'nodes' when the sphere should be rebuilt at the halved multiplier, else
  // null. setCap() follows a new cap while the scale sits at the old one, else only
  // lowers it — a scale the governor stepped down stays down.
  function createGovernor({ multiplier }) {
    let cap = null, scale = null, mult = multiplier;
    let times = [], sum = 0, fastSince = null, slowSince = null;
    let scaleAt = -Infinity, nodesAt = -Infinity;
    const restart = () => { times = []; sum = 0; fastSince = null; slowSince = null; };
    return {
      get scale() { return scale; },
      get multiplier() { return mult; },
      setCap(c) { scale = scale === null || scale === cap ? c : Math.min(scale, c); cap = c; },
      tick(dt, now) {
        if (!(dt > 0) || dt > FRAME_GAP_MS) { restart(); return null; }
        times.push(dt); sum += dt;
        if (times.length > FRAME_WINDOW) sum -= times.shift();
        if (scale === null || times.length < FRAME_WINDOW) return null;
        const avg = sum / FRAME_WINDOW;
        fastSince = avg < FAST_FRAME_MS ? (fastSince ?? now) : null;
        slowSince = avg > SLOW_FRAME_MS ? (slowSince ?? now) : null;
        if (now - scaleAt < SCALE_COOLDOWN_MS) return null;
        if (slowSince !== null && scale > RES_SCALE_MIN) {
          scale -= 1; scaleAt = now; restart(); return 'scale';
        }
        if (slowSince !== null && mult > 1 && now - slowSince >= NODE_SLOW_DWELL_MS && now - nodesAt >= NODE_COOLDOWN_MS) {
          mult = Math.max(1, Math.floor(mult / 2)); nodesAt = now; restart(); return 'nodes';
        }
        if (fastSince !== null && scale < cap && now - fastSince >= SCALE_UP_DWELL_MS) {
          scale += 1; scaleAt = now; restart(); return 'scale';
        }
        return null;
      },
    };
  }

  const api = {
    isConstrained, chooseNodeMultiplier, settleNodeMultiplier, glLimit, renderScaleCap,
    backingSize, createGovernor,
    lookFor: (m, scale) => ({ ...LOOK[m], edgeAlpha: LOOK[m].edgeAlpha * Math.min(EDGE_SCALE_GAIN_MAX, scale) }),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SangaiJarvisOrbScale = api;
})();
