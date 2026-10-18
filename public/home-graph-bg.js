'use strict';
// home-graph-bg — ambient backdrop for Home's force graph.
//
// Three modes, cycled from the graph tools row (persisted in localStorage):
//   galaxy  procedural canvas only (starfield + nebula + neural core)
//   video   the operator-supplied looping mp4 only
//   mixed   video underneath, transparent galaxy (stars/lightning/brain) on top
//
// Both layers sit UNDER the transparent graph canvas (pointer-events:none).
// Destroyed with each home-panel remount so a stale rAF never paints a detached stage.
(function () {
  const STORAGE_KEY = 'jarvis_graph_bg';
  const MODES = ['galaxy', 'video', 'mixed'];
  const VIDEO_SRC = '/media/home-graph-bg.mp4';
  const MODE_LABEL = { galaxy: 'Galaxy', video: 'Video', mixed: 'Mixed' };

  function readMode() {
    try {
      const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      if (MODES.includes(v)) return v;
    } catch (_) { /* private mode */ }
    return 'galaxy';
  }

  function writeMode(mode) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, mode);
    } catch (_) { /* ignore */ }
  }

  function el(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function prepend(stage, node) {
    if (typeof stage.insertBefore === 'function' && stage.firstChild) {
      stage.insertBefore(node, stage.firstChild);
    } else {
      stage.append(node);
    }
  }

  // ---- galaxy canvas -------------------------------------------------------

  function createGalaxy(stage) {
    const canvas = el('canvas', 'home-graph-bg home-graph-bg--galaxy');
    canvas.setAttribute('aria-hidden', 'true');
    prepend(stage, canvas);

    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!ctx) {
      // Test stub / ancient browser — CSS nebula still gives motion.
      canvas.classList.add('home-graph-bg--css-fallback');
      return {
        show() { canvas.hidden = false; },
        hide() { canvas.hidden = true; },
        setOverlay(on) { canvas.classList.toggle('is-overlay', !!on); },
        destroy() { if (canvas.parentNode) canvas.parentNode.removeChild(canvas); },
      };
    }

    let destroyed = false;
    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let t0 = performance.now();
    let stars = [];
    let neurons = [];
    let synapses = [];
    let pulses = [];
    let shootings = [];
    let bolts = []; // ambient lightning flashes
    // When true (Mixed mode), skip the opaque space wash so the video shows through.
    let overlay = false;

    function seed() {
      // Dense starfield — warm yellow starlight (real stars lean gold, not pure white).
      const nStars = Math.min(520, Math.max(180, Math.floor((w * h) / 3500)));
      stars = [];
      for (let i = 0; i < nStars; i += 1) {
        const bright = Math.random() < 0.1;
        // Slight hue drift: pale gold → amber → soft white-gold
        const warmth = Math.random();
        stars.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: bright ? (1.3 + Math.random() * 2.0) : (0.4 + Math.random() * 1.15),
          a: bright ? (0.6 + Math.random() * 0.4) : (0.25 + Math.random() * 0.6),
          tw: Math.random() * Math.PI * 2,
          sp: 0.45 + Math.random() * 2.6,
          cross: bright && Math.random() < 0.6,
          // RGB for the star core / glow (yellow light)
          cr: 255,
          cg: Math.round(210 + warmth * 35), // 210–245
          cb: Math.round(120 + warmth * 80), // 120–200
        });
      }

      // Neural “brain” — denser oval of nodes near stage centre + a wider halo ring.
      const cx = w * 0.5;
      const cy = h * 0.48;
      const rx = Math.min(w, h) * 0.22;
      const ry = Math.min(w, h) * 0.17;
      const nCount = 56;
      neurons = [];
      for (let i = 0; i < nCount; i += 1) {
        const ang = (i / nCount) * Math.PI * 2 + Math.random() * 0.25;
        const rad = 0.3 + Math.random() * 0.7;
        neurons.push({
          x: cx + Math.cos(ang) * rx * rad * (0.65 + Math.random() * 0.55),
          y: cy + Math.sin(ang) * ry * rad * (0.65 + Math.random() * 0.55),
          r: 1.1 + Math.random() * 1.9,
          phase: Math.random() * Math.PI * 2,
        });
      }
      // Interior hubs.
      for (let i = 0; i < 14; i += 1) {
        neurons.push({
          x: cx + (Math.random() - 0.5) * rx * 0.85,
          y: cy + (Math.random() - 0.5) * ry * 0.85,
          r: 1.8 + Math.random() * 2.4,
          phase: Math.random() * Math.PI * 2,
        });
      }
      // Outer constellation nodes scattered across the field (galaxy “stations”).
      const outer = Math.min(40, Math.max(18, Math.floor((w * h) / 28000)));
      for (let i = 0; i < outer; i += 1) {
        neurons.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: 0.9 + Math.random() * 1.4,
          phase: Math.random() * Math.PI * 2,
        });
      }

      synapses = [];
      const linkDist = Math.min(w, h) * 0.11;
      for (let i = 0; i < neurons.length; i += 1) {
        for (let j = i + 1; j < neurons.length; j += 1) {
          const a = neurons[i];
          const b = neurons[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < linkDist) synapses.push({ a: i, b: j, d });
        }
      }
      if (synapses.length > 180) {
        synapses.sort((u, v) => u.d - v.d);
        synapses = synapses.slice(0, 180);
      }
      pulses = [];
      shootings = [];
      bolts = [];
    }

    function resize() {
      if (destroyed) return;
      const rect = stage.getBoundingClientRect ? stage.getBoundingClientRect() : { width: 800, height: 500 };
      w = Math.max(1, Math.floor(rect.width || stage.clientWidth || 800));
      h = Math.max(1, Math.floor(rect.height || stage.clientHeight || 500));
      dpr = Math.min(1.5, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }

    function spawnPulse(now) {
      if (!synapses.length) return;
      const s = synapses[(Math.random() * synapses.length) | 0];
      pulses.push({
        a: s.a, b: s.b,
        t0: now,
        dur: 700 + Math.random() * 900,
      });
      if (pulses.length > 28) pulses.shift();
    }

    // Jagged polyline from (x0,y0) toward (x1,y1) with side forks — classic bolt look.
    function buildBoltPath(x0, y0, x1, y1, segs) {
      const pts = [{ x: x0, y: y0 }];
      const forks = [];
      for (let i = 1; i < segs; i += 1) {
        const u = i / segs;
        const jx = (Math.random() - 0.5) * Math.min(w, h) * 0.045;
        const jy = (Math.random() - 0.5) * Math.min(w, h) * 0.045;
        const x = x0 + (x1 - x0) * u + jx;
        const y = y0 + (y1 - y0) * u + jy;
        pts.push({ x, y });
        if (Math.random() < 0.28 && i > 1 && i < segs - 1) {
          const prev = pts[pts.length - 2];
          forks.push([
            { x, y },
            {
              x: x + (x - prev.x) * 0.4 + (Math.random() - 0.5) * 28,
              y: y + (y - prev.y) * 0.4 + (Math.random() - 0.5) * 28,
            },
          ]);
        }
      }
      pts.push({ x: x1, y: y1 });
      return { pts, forks };
    }

    function spawnBolt(now) {
      // Cloud-to-cloud or sky-to-horizon flashes around the edges — not through the brain core.
      const edge = Math.random();
      let x0; let y0; let x1; let y1;
      if (edge < 0.25) {
        x0 = Math.random() * w * 0.35; y0 = Math.random() * h * 0.25;
        x1 = x0 + 40 + Math.random() * w * 0.35; y1 = y0 + 30 + Math.random() * h * 0.35;
      } else if (edge < 0.5) {
        x0 = w * (0.55 + Math.random() * 0.4); y0 = Math.random() * h * 0.3;
        x1 = x0 - 40 - Math.random() * w * 0.3; y1 = y0 + 40 + Math.random() * h * 0.35;
      } else if (edge < 0.75) {
        x0 = Math.random() * w; y0 = Math.random() * h * 0.2;
        x1 = x0 + (Math.random() - 0.5) * w * 0.4; y1 = h * (0.35 + Math.random() * 0.35);
      } else {
        x0 = Math.random() * w * 0.3; y0 = h * (0.55 + Math.random() * 0.4);
        x1 = w * (0.4 + Math.random() * 0.5); y1 = y0 - 40 - Math.random() * h * 0.25;
      }
      const path = buildBoltPath(x0, y0, x1, y1, 6 + ((Math.random() * 5) | 0));
      bolts.push({
        ...path,
        t0: now,
        dur: 180 + Math.random() * 220, // brief flash
        glow: 0.55 + Math.random() * 0.45,
      });
      if (bolts.length > 4) bolts.shift();
    }

    function paint(now) {
      if (destroyed || canvas.hidden) return;
      const t = (now - t0) / 1000;

      if (overlay) {
        // Mixed mode: clear to transparent so the video underneath stays visible.
        ctx.clearRect(0, 0, w, h);
        for (let i = 0; i < 3; i += 1) {
          const ox = w * (0.25 + 0.2 * i) + Math.sin(t * 0.07 + i) * w * 0.04;
          const oy = h * (0.32 + 0.1 * i) + Math.cos(t * 0.05 + i) * h * 0.05;
          const ng = ctx.createRadialGradient(ox, oy, 0, ox, oy, Math.min(w, h) * (0.18 + i * 0.03));
          ng.addColorStop(0, i % 2 === 0 ? 'rgba(56, 189, 248, 0.05)' : 'rgba(167, 139, 250, 0.045)');
          ng.addColorStop(1, 'rgba(0, 0, 0, 0)');
          ctx.fillStyle = ng;
          ctx.fillRect(0, 0, w, h);
        }
      } else {
        // Space wash
        const g = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.7);
        g.addColorStop(0, '#12162a');
        g.addColorStop(0.45, '#0a0c18');
        g.addColorStop(1, '#05060c');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);

        // Nebula lobes — slow drift
        for (let i = 0; i < 4; i += 1) {
          const ox = w * (0.22 + 0.18 * i) + Math.sin(t * 0.07 + i) * w * 0.05;
          const oy = h * (0.3 + 0.12 * (i % 3)) + Math.cos(t * 0.05 + i * 1.3) * h * 0.06;
          const ng = ctx.createRadialGradient(ox, oy, 0, ox, oy, Math.min(w, h) * (0.2 + i * 0.035));
          if (i % 3 === 0) {
            ng.addColorStop(0, 'rgba(56, 189, 248, 0.11)');
            ng.addColorStop(1, 'rgba(56, 189, 248, 0)');
          } else if (i % 3 === 1) {
            ng.addColorStop(0, 'rgba(167, 139, 250, 0.10)');
            ng.addColorStop(1, 'rgba(167, 139, 250, 0)');
          } else {
            ng.addColorStop(0, 'rgba(45, 212, 191, 0.08)');
            ng.addColorStop(1, 'rgba(45, 212, 191, 0)');
          }
          ctx.fillStyle = ng;
          ctx.fillRect(0, 0, w, h);
        }
      }

      // Stars — auto yellow light: pulsing gold core + warm halo (real starlight)
      for (const s of stars) {
        const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * s.sp + s.tw));
        const glowR = s.r * (2.8 + tw * 2.2);
        const halo = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, glowR);
        halo.addColorStop(0, `rgba(${s.cr}, ${s.cg}, ${s.cb}, ${s.a * tw * 0.85})`);
        halo.addColorStop(0.35, `rgba(255, 200, 80, ${s.a * tw * 0.35})`);
        halo.addColorStop(1, 'rgba(255, 180, 40, 0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(s.x, s.y, glowR, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = Math.min(1, s.a * tw * 1.15);
        ctx.fillStyle = `rgb(${s.cr}, ${s.cg}, ${Math.min(255, s.cb + 20)})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * (0.7 + tw * 0.35), 0, Math.PI * 2);
        ctx.fill();
        if (s.cross) {
          ctx.strokeStyle = `rgba(255, 220, 120, ${0.45 * tw})`;
          ctx.lineWidth = 0.7;
          const arm = s.r * (3.5 + tw);
          ctx.beginPath();
          ctx.moveTo(s.x - arm, s.y); ctx.lineTo(s.x + arm, s.y);
          ctx.moveTo(s.x, s.y - arm); ctx.lineTo(s.x, s.y + arm);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // Shooting stars — warm gold trails
      if (shootings.length < 3 && Math.random() < 0.012) {
        shootings.push({
          x: Math.random() * w,
          y: Math.random() * h * 0.55,
          vx: 2.5 + Math.random() * 5,
          vy: 0.8 + Math.random() * 2.2,
          life: 0,
          max: 35 + Math.random() * 40,
        });
      }
      for (let i = shootings.length - 1; i >= 0; i -= 1) {
        const sh = shootings[i];
        sh.life += 1;
        sh.x += sh.vx;
        sh.y += sh.vy;
        const fade = 1 - sh.life / sh.max;
        ctx.strokeStyle = `rgba(255, 220, 120, ${0.7 * fade})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(sh.x, sh.y);
        ctx.lineTo(sh.x - sh.vx * 7, sh.y - sh.vy * 7);
        ctx.stroke();
        if (sh.life >= sh.max) shootings.splice(i, 1);
      }

      // Lightning — sporadic edge flashes with a brief screen bloom
      if (bolts.length < 2 && Math.random() < 0.018) spawnBolt(now);
      for (let i = bolts.length - 1; i >= 0; i -= 1) {
        const b = bolts[i];
        const u = (now - b.t0) / b.dur;
        if (u >= 1) { bolts.splice(i, 1); continue; }
        // Flash envelope: snap on, soft off
        const flash = u < 0.15 ? (u / 0.15) : (1 - (u - 0.15) / 0.85);
        const alpha = Math.max(0, flash) * b.glow;

        // Soft bloom behind the bolt
        const mid = b.pts[(b.pts.length / 2) | 0];
        const bloom = ctx.createRadialGradient(mid.x, mid.y, 0, mid.x, mid.y, Math.min(w, h) * 0.18);
        bloom.addColorStop(0, `rgba(186, 230, 253, ${0.14 * alpha})`);
        bloom.addColorStop(0.5, `rgba(125, 211, 252, ${0.06 * alpha})`);
        bloom.addColorStop(1, 'rgba(125, 211, 252, 0)');
        ctx.fillStyle = bloom;
        ctx.fillRect(0, 0, w, h);

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // Outer glow
        ctx.strokeStyle = `rgba(147, 197, 253, ${0.35 * alpha})`;
        ctx.lineWidth = 4.5;
        ctx.shadowBlur = 18;
        ctx.shadowColor = `rgba(125, 211, 252, ${0.8 * alpha})`;
        ctx.beginPath();
        b.pts.forEach((p, idx) => { if (idx === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.stroke();
        for (const fork of b.forks) {
          ctx.beginPath();
          ctx.moveTo(fork[0].x, fork[0].y);
          ctx.lineTo(fork[1].x, fork[1].y);
          ctx.stroke();
        }
        // Hot core
        ctx.shadowBlur = 0;
        ctx.strokeStyle = `rgba(248, 250, 252, ${0.85 * alpha})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        b.pts.forEach((p, idx) => { if (idx === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.stroke();
        for (const fork of b.forks) {
          ctx.beginPath();
          ctx.moveTo(fork[0].x, fork[0].y);
          ctx.lineTo(fork[1].x, fork[1].y);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Synapses
      ctx.lineWidth = 0.65;
      for (const s of synapses) {
        const a = neurons[s.a];
        const b = neurons[s.b];
        const pulse = 0.07 + 0.07 * Math.sin(t * 1.2 + a.phase);
        ctx.strokeStyle = `rgba(125, 211, 252, ${pulse})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // Traveling pulses along synapses
      if (Math.random() < 0.07) spawnPulse(now);
      for (let i = pulses.length - 1; i >= 0; i -= 1) {
        const p = pulses[i];
        const u = (now - p.t0) / p.dur;
        if (u >= 1) { pulses.splice(i, 1); continue; }
        const a = neurons[p.a];
        const b = neurons[p.b];
        const x = a.x + (b.x - a.x) * u;
        const y = a.y + (b.y - a.y) * u;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 7);
        glow.addColorStop(0, 'rgba(165, 243, 252, 0.95)');
        glow.addColorStop(1, 'rgba(165, 243, 252, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
      }

      // Neurons
      for (const n of neurons) {
        const beat = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.1 + n.phase));
        ctx.fillStyle = `rgba(186, 230, 253, ${0.32 + beat * 0.5})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * (0.85 + beat * 0.25), 0, Math.PI * 2);
        ctx.fill();
      }

      // Soft brain envelope (dimmer in Mixed so video stays readable)
      const br = Math.min(w, h) * 0.24;
      const bg = ctx.createRadialGradient(w * 0.5, h * 0.48, br * 0.2, w * 0.5, h * 0.48, br);
      const coreA = overlay ? 0.04 : 0.07;
      const midA = overlay ? 0.025 : 0.045;
      bg.addColorStop(0, `rgba(56, 189, 248, ${coreA})`);
      bg.addColorStop(0.6, `rgba(129, 140, 248, ${midA})`);
      bg.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.ellipse(w * 0.5, h * 0.48, br * 1.05, br * 0.78, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    function tick(now) {
      if (destroyed) return;
      if (!canvas.hidden && !(typeof document !== 'undefined' && document.hidden)) {
        paint(now);
      }
      raf = requestAnimationFrame(tick);
    }

    let ro = null;
    resize();
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => resize());
      ro.observe(stage);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', resize);
    }
    raf = requestAnimationFrame(tick);

    return {
      show() { canvas.hidden = false; },
      hide() { canvas.hidden = true; },
      setOverlay(on) {
        overlay = !!on;
        canvas.classList.toggle('is-overlay', overlay);
      },
      destroy() {
        destroyed = true;
        if (raf) cancelAnimationFrame(raf);
        if (ro) ro.disconnect();
        else if (typeof window !== 'undefined') window.removeEventListener('resize', resize);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      },
    };
  }

  // ---- video ---------------------------------------------------------------

  function createVideo(stage) {
    const video = el('video', 'home-graph-bg home-graph-bg--video');
    video.preload = 'none';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute('preload', 'none');
    video.setAttribute('muted', '');
    video.setAttribute('loop', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    video.hidden = true;
    prepend(stage, video);
    return {
      show() {
        if (!video.getAttribute('src')) {
          video.src = VIDEO_SRC;
          video.preload = 'auto';
          video.setAttribute('preload', 'auto');
        }
        video.hidden = false;
        if (typeof video.play === 'function') Promise.resolve(video.play()).catch(() => {});
      },
      hide() {
        video.hidden = true;
        if (typeof video.pause === 'function') video.pause();
      },
      destroy() {
        if (typeof video.pause === 'function') video.pause();
        if (video.parentNode) video.parentNode.removeChild(video);
      },
    };
  }

  function create(stage, opts = {}) {
    let mode = MODES.includes(opts.mode) ? opts.mode : readMode();
    const scrim = el('div', 'home-graph-bg-scrim');
    scrim.setAttribute('aria-hidden', 'true');
    prepend(stage, scrim);

    // DOM order after both prepends: video (bottom) → galaxy → scrim → graph.
    // Mixed keeps both visible so stars/lightning sit above the footage.
    const galaxy = createGalaxy(stage);
    const video = createVideo(stage);

    function apply() {
      scrim.classList.remove('is-galaxy', 'is-video', 'is-mixed');
      if (mode === 'galaxy') {
        if (galaxy.setOverlay) galaxy.setOverlay(false);
        galaxy.show();
        video.hide();
        scrim.classList.add('is-galaxy');
      } else if (mode === 'video') {
        if (galaxy.setOverlay) galaxy.setOverlay(false);
        video.show();
        galaxy.hide();
        scrim.classList.add('is-video');
      } else {
        // mixed — video underneath, transparent galaxy on top
        if (galaxy.setOverlay) galaxy.setOverlay(true);
        video.show();
        galaxy.show();
        scrim.classList.add('is-mixed');
      }
      writeMode(mode);
    }
    apply();

    return {
      get mode() { return mode; },
      setMode(next) {
        if (!MODES.includes(next) || next === mode) return mode;
        mode = next;
        apply();
        return mode;
      },
      toggle() {
        const i = MODES.indexOf(mode);
        return this.setMode(MODES[(i + 1) % MODES.length]);
      },
      label() {
        return MODE_LABEL[mode] || 'Galaxy';
      },
      hint() {
        if (mode === 'galaxy') return 'Background: AI galaxy (click → Video)';
        if (mode === 'video') return 'Background: video (click → Mixed = video + galaxy)';
        return 'Background: Mixed — video under galaxy (click → Galaxy)';
      },
      destroy() {
        galaxy.destroy();
        video.destroy();
        if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      },
    };
  }

  window.JarvisGraphBg = { create, readMode, MODES, MODE_LABEL, STORAGE_KEY };
})();
