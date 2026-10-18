'use strict';
// jarvis-orb.js — the tuned fbm energy field behind Jarvis's reactor, and the raw-WebGL
// fallback renderer for machines that cannot run the 3D one.
//
// WHAT THIS FILE WAS, AND WHAT IT BECAME
// This used to be the primary THINKING/SPEAKING backdrop, on its own canvas,
// crossfaded against the 2D reactor by CSS. That is no longer the whole story:
// jarvis-reactor3d.js now draws all five states as a real 3D sphere on THIS SAME
// CANVAS, and it renders this file's shader — unchanged, via the exported `FRAG` and
// `VERT` below — as its own backdrop. So this file has two jobs now, not one:
//   1. owner of the tuned GLSL both renderers share
//   2. the tier-2 fallback: createOrb() + jarvis.js's full 2D drawOrb() is exactly
//      what ran here before the 3D reactor existed, and it is what still runs on a
//      machine without WebGL2, without import maps, or on a software rasteriser.
// See startReactor() in jarvis.js for the three-tier selection, and
// jarvis-reactor3d.js's header for why it takes over this canvas rather than adding
// one — the two-context ceiling this file's context-loss note (below) already argues
// for the same reason.
//
// WHY RAW WebGL, AND NOT THREE.JS, FOR THIS SHADER SPECIFICALLY
// The look here — a noise-displaced glowing field with no rim, no fresnel, no
// surface — is a fragment-shader effect. It needs no scene graph, no camera and no
// mesh: one full-screen quad and ~120 lines of GLSL, with "bloom" done as additive
// falloff in-shader. That argument is unaffected by the 3D reactor's existence — it is
// exactly why the reactor RENDERS THIS SOURCE rather than reimplementing it in a scene
// graph of its own. What the reactor's sphere needs that this field does not — real
// perspective, depth, a thousand individually positioned points — is the one thing a
// full-screen shader is a poor tool for, which is the reactor's own justification for
// existing at all.
//
// The 3D renderer uses the pinned Three.js build under /vendor/three/.

(() => {
  // Vertex stage: one full-screen triangle-pair. All the work is in the
  // fragment shader, so this only has to hand it clip-space coordinates.
  const VERT = `#version 300 es
  in vec2 aPos;
  out vec2 vUv;
  void main() {
    vUv = aPos;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }`;

  // Fragment stage. Draws an implicit sphere: distance from centre gives a
  // fake surface normal, which is all the 3D that a glowing orb actually needs.
  //
  //   uState  0 = thinking, 1 = speaking. Held as a float and LERPED by the JS
  //           side rather than switched, so a state change is a visible morph
  //           rather than a jump cut.
  //   uAmp    0..1. In `speaking` this is the REAL reply audio (see jarvis.js's
  //           player analyser), which is the whole point — the orb has to move
  //           with the words, not on a timer.
  const FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;

  // THIS IS A BACKDROP, NOT THE SUBJECT. The mesh — nodes, edges, travelling pulses —
  // is discrete, and a fragment shader is a poor tool for discrete things. What this
  // layer adds is the energy field the mesh floats in: soft, dim, and deliberately
  // low-contrast so it never competes with what is drawn over it.
  // Where that subject lives depends on the tier: jarvis-reactor3d.js's 3D sphere in
  // this SAME scene (tier 1, the common case), or jarvis.js's 2D drawGraph on the
  // canvas above this one (tier 2, the fallback). Either way this shader does not
  // know or care which — it only ever reads uTime/uAmp/uState/uBackdrop.
  uniform float uTime;
  uniform float uAmp;
  uniform float uState;     // 0 thinking .. 1 speaking (lerped, never switched)
  uniform vec2  uRes;
  // How present the field is at all. This used to be a CSS opacity on #orb-gl, which
  // worked while the field had a canvas to itself. jarvis-reactor3d.js renders this same
  // source INTO the canvas that also carries the subject, where CSS can no longer fade
  // one without the other — so the fade became a uniform.
  //
  // ⚠ An unset GLSL uniform is 0, so every consumer MUST write this. The failure is
  // silent and invisible where it is easiest to miss: forget it in createOrb below and
  // the fallback backdrop disappears completely, on exactly the machines that cannot
  // run the 3D path and that you will therefore never be looking at. Pinned by a test.
  uniform float uBackdrop;

  // --- simplex-ish value noise ----------------------------------------------
  // Gradient noise would be smoother, but this is displacement on a glowing
  // blob at ~500px: the difference is invisible and this is a third of the ALU.
  vec3 hash3(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
             dot(p, vec3(269.5, 183.3, 246.1)),
             dot(p, vec3(113.5, 271.9, 124.6)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(dot(hash3(i + vec3(0,0,0)), f - vec3(0,0,0)),
                       dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
                   mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)),
                       dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
               mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)),
                       dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
                   mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)),
                       dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);
  }
  float fbm(vec3 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.02; a *= 0.5; }
    return s;
  }

  void main() {
    // Square, centred, aspect-corrected coordinates.
    vec2 uv = vUv * vec2(max(1.0, uRes.x / uRes.y), max(1.0, uRes.y / uRes.x));
    float r = length(uv);

    // THE TWO PERSONALITIES.
    //   thinking — slow, heavy churn: work happening out of sight.
    //   speaking — quicker, and the field breathes with uAmp so the backdrop
    //              swells on each syllable behind the graph.
    float churn = mix(0.42, 1.10, uState);
    float swell = uAmp * uState;

    // A volumetric-ish field rather than a hard-edged blob: the z term makes
    // the noise travel AROUND the centre instead of sliding across a flat disc.
    vec3  sp = vec3(uv * 1.7, sqrt(max(0.0, 1.0 - min(1.0, r * r))));
    float n  = fbm(sp * 1.6 + vec3(0.0, 0.0, uTime * churn));

    // Soft radial envelope — no rim, no fresnel. Those read as a SURFACE, and a
    // surface behind the graph looked like a second object competing with it.
    // This is a glow that fades out, so the nodes always sit clearly in front.
    float core  = exp(-r * (2.5 - swell * 0.5));
    float field = core * (0.55 + n * 0.85);

    // ONE HUE FAMILY. The whole HUD is cyan-blue, and the earlier amber/green
    // split for these two states fought that rather than belonging to it — so
    // thinking and speaking now differ by ENERGY, not by colour.
    vec3 deep  = vec3(0.10, 0.45, 0.80);   // cool blue, thinking
    vec3 bright = vec3(0.25, 0.80, 0.98);  // brighter cyan, speaking
    vec3 tint  = mix(deep, bright, uState * 0.65 + swell * 0.35);

    vec3 col = tint * field;
    // A slow expanding pulse, only while speaking — the field's own echo of the
    // voice, under the graph rather than on it.
    col += tint * pow(max(0.0, 1.0 - abs(r - fract(uTime * 0.45) * 1.1) * 6.0), 2.0)
                * swell * 0.35;

    // Alpha, not black: this canvas sits over the panel's grid background, and
    // an opaque quad would punch a hole in it. Capped well under 1 so the grid
    // stays faintly visible through the field.
    float a = clamp(field * 0.85, 0.0, 0.85) * uBackdrop;
    outColor = vec4(col, a);
  }`;

  const STATE_MIX = { thinking: 0, speaking: 1 };

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader compile failed: ' + log);
    }
    return sh;
  }

  // createOrb(canvas) -> { ok, setState, setAmplitude, draw, dispose }
  //
  // `ok === false` is a normal outcome, not an error to report: a browser
  // without WebGL2, a blocked context, a driver that refuses to compile. The
  // caller keeps its 2D orb and the user sees a slightly plainer animation
  // rather than a broken panel.
  // `opts.gl` lets the caller hand over a context it already made, which is how the
  // page keeps its context count flat. jarvis.js creates exactly one on #orb-gl and
  // gives it to whichever renderer wins — the 3D reactor, or this. Calling getContext
  // here as well would make a second one on a canvas that already has one (a no-op at
  // best, a differently-configured context at worst), and asking each module to make
  // its own during a support probe is what transiently pushes the page to three
  // contexts and gets the oldest evicted. Omitting it keeps the original behaviour.
  function createOrb(canvas, opts = {}) {
    const dead = { ok: false, setState() {}, setAmplitude() {}, draw() {}, dispose() {} };
    if (!canvas || typeof canvas.getContext !== 'function') return dead;

    let gl = opts.gl || null;
    try {
      if (!gl) gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: true });
    } catch { return dead; }
    // A 2D-canvas stub (the test harness) answers getContext with something
    // that is not a GL context at all — check for the API rather than trusting
    // the return value.
    if (!gl || typeof gl.createShader !== 'function') return dead;

    let prog, buf;
    try {
      const vs = compile(gl, gl.VERTEX_SHADER, VERT);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
      prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs);
      gl.bindAttribLocation(prog, 0, 'aPos');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error('link failed: ' + gl.getProgramInfoLog(prog));
      }
      gl.deleteShader(vs); gl.deleteShader(fs);

      buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    } catch (err) {
      // Compile/link failures are the one case worth a console line: they mean
      // a real bug in the GLSL above, not an unsupported browser.
      if (typeof console !== 'undefined') console.warn('[jarvis-orb]', err.message);
      return dead;
    }

    const uBackdrop = gl.getUniformLocation(prog, 'uBackdrop');
    const uTime = gl.getUniformLocation(prog, 'uTime');
    const uAmp = gl.getUniformLocation(prog, 'uAmp');
    const uState = gl.getUniformLocation(prog, 'uState');
    const uRes = gl.getUniformLocation(prog, 'uRes');

    gl.useProgram(prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Targets vs current: both the state morph and the amplitude are eased
    // toward their target every frame. Amplitude in particular arrives as a
    // spiky RMS reading, and an unsmoothed orb reads as flicker rather than
    // speech — the same reasoning as sampleLevel()'s smoothing in jarvis.js.
    let stateTarget = 0, stateNow = 0;
    let ampTarget = 0, ampNow = 0;

    // Context loss was previously unhandled, and the symptom was a silently
    // frozen orb: every GL call after the loss is a no-op, so nothing throws,
    // nothing logs, and the canvas just holds its last frame forever. It became
    // worth handling once the avatar added a SECOND context to the page —
    // browsers evict the oldest context when a page holds too many, and a GPU
    // process restart takes them both out at once.
    //
    // This paragraph is now load-bearing for a second reason: it is WHY
    // jarvis-reactor3d.js takes over this same canvas instead of asking for a third
    // context of its own, and why jarvis.js creates exactly one context on #orb-gl and
    // hands it down rather than letting each renderer probe for support on its own
    // scratch canvas. A third context, even a transient one, is the exact condition
    // that gets one of the two real ones evicted.
    let lost = false;
    const onLost = (e) => {
      e?.preventDefault?.();   // without this the context can never be restored
      lost = true;
      if (typeof console !== 'undefined') console.warn('[jarvis-orb] WebGL context lost');
    };
    canvas.addEventListener?.('webglcontextlost', onLost, false);

    return {
      get ok() { return !lost; },
      // Anything that is not one of the two shader states leaves the target
      // where it is: the caller is crossfading this canvas out, and morphing
      // toward some third value underneath the fade would be visible.
      setState(name) {
        if (name in STATE_MIX) stateTarget = STATE_MIX[name];
      },
      setAmplitude(a) {
        ampTarget = Math.max(0, Math.min(1, Number(a) || 0));
      },
      draw(t) {
        if (lost) return;
        const w = canvas.width, h = canvas.height;
        if (!w || !h) return;
        stateNow += (stateTarget - stateNow) * 0.08;
        // Asymmetric, like the mic meter: attack fast so a syllable lands on
        // time, release slow so the orb does not strobe between words.
        ampNow += (ampTarget - ampNow) * (ampTarget > ampNow ? 0.45 : 0.10);

        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(prog);
        gl.uniform1f(uTime, t);
        // Always 1 here. This path only ever draws when jarvis.js has already decided the
        // field should be visible — the crossfade is still CSS's job on #orb-gl — but the
        // uniform has to be written or it reads 0 and the field never appears at all.
        gl.uniform1f(uBackdrop, 1);
        gl.uniform1f(uAmp, ampNow);
        gl.uniform1f(uState, stateNow);
        gl.uniform2f(uRes, w, h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      dispose() {
        canvas.removeEventListener?.('webglcontextlost', onLost, false);
        try {
          gl.deleteProgram(prog);
          gl.deleteBuffer(buf);
        } catch { /* context already lost */ }
      },
      // Exposed for tests: the eased values are the whole behaviour worth
      // asserting, and they are otherwise unreachable from outside.
      _debug: () => ({ stateNow, stateTarget, ampNow, ampTarget, lost }),
    };
  }

  // FRAG is exported because jarvis-reactor3d.js renders THIS SHADER, unchanged, as
  // the backdrop of its 3D scene. Sharing the source rather than copying it is the
  // point: the field's look is tuned, and two copies would drift the moment either
  // was touched. The 3D reactor supplies its own full-screen quad and its own
  // uniform plumbing, so nothing above needs to know it has a second consumer.
  const api = { createOrb, STATE_MIX, FRAG, VERT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SangaiJarvisOrb = api;
})();
