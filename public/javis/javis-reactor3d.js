'use strict';
// javis-reactor3d.js — the reactor as a real 3D scene: ~830 nodes on a rotating
// sphere shell, wired into a mesh, with signals travelling along the edges.
//
// WHAT THIS REPLACES, AND WHAT IT DOES NOT
// javis.js's drawOrb() draws all five states as line work on a flat 2D canvas, with
// javis-orb.js's noise field crossfaded in behind the two working states. That code
// is UNCHANGED and still shipping — it is the fallback, and on a machine without
// WebGL2 or on a software renderer it is the whole panel. This file is tier 1.
//
// WHY THIS ONE DOES USE THREE.JS WHEN javis-orb.js ARGUES AGAINST IT
// javis-orb.js's argument is that a full-screen noise field is a fragment-shader
// effect needing no scene graph, no camera and no mesh. That is still true, and this
// file proves it by rendering that very shader, unchanged, as its own backdrop. What
// is NOT true of a sphere of 830 depth-sorted points, a thousand line segments and a
// perspective camera: that is a scene graph's actual job. Same reasoning that let the
// avatar in, applied to the other end of the panel.
//
// WHY IT TAKES OVER #orb-gl RATHER THAN ADDING A CANVAS
// The page already holds two WebGL contexts (this one and the avatar's). Browsers
// evict the oldest when a page holds too many — see javis-orb.js's note on context
// loss, which exists because the avatar made that a real failure mode rather than a
// theoretical one. So the 3D reactor claims the canvas the shader orb used to own,
// and the context count is exactly what it was before.
//
// WHY THE CALLER CREATES THE CONTEXT AND PASSES IT IN (opts.gl)
// The fallback needs a USABLE #orb-gl: once three.js has made a context there, that
// canvas is spent and javis-orb.js can no longer have it. The obvious fix — probe
// support on a scratch 1x1 canvas and throw it away — is wrong, because during that
// probe the page transiently holds THREE contexts, which is the exact condition that
// makes a browser evict the oldest. Evicting #orb-gl while deciding whether to use
// #orb-gl is a bug that would appear only under memory pressure, on someone else's
// machine.
// So javis.js creates exactly one context, inspects it, and hands the same object to
// whichever consumer wins — this module via opts.gl, or createOrb via its own opts.gl.
// The count never exceeds what the page held before, not even for a frame.
//
// `ok:false` IS A NORMAL OUTCOME, NEVER AN ERROR TO REPORT
// No WebGL2, no import maps, a software rasteriser, a failed import, a lost context.
// In every one of those cases javis.js keeps its 2D reactor and the user sees a
// plainer animation rather than a broken panel. Nothing here is ever allowed to throw
// into the caller.

(() => {
  // Software rasterisers report as WebGL and then run at a few frames per second,
  // which looks broken rather than plain. Same list, and the same reasoning, as
  // javis-avatar.js — SwiftShader is what Chrome falls back to over RDP or with a
  // blocklisted GPU, llvmpipe/softpipe are the Mesa equivalents. That matters more
  // here than for the avatar: this host's own desktop is reached over RDP.
  const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;
  // Radius-1 shell: at 34° a camera 4.4 out sees ±1.35, so the globe and its speaking ring fit.
  const FOV_DEG = 34;
  // Thinking's own look (Sang: it was glaring). Nodes grow at most 1.5x with energy, the mesh
  // dims, and the tint turns a soft blue instead of washing out toward white.
  const THINK_LOOK = {
    sizeBase: 0.068, sizeEnergy: 0.034, litScale: 0.65, edgeScale: 0.7,
    tintLow: [0.30, 0.60, 0.95], tintHigh: [0.42, 0.72, 1.0],
  };
  const glslVec3 = (c) => `vec3(${c.map((v) => v.toFixed(3)).join(', ')})`;
  const DEFAULT_CAM_DIST = 4.4;

  const TAU = Math.PI * 2;
  const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

  const model = () => (typeof window !== 'undefined' && window.SangaiJavisLattice)
    || (typeof require === 'function' ? require('./javis-lattice.js') : null);
  const orb = () => (typeof window !== 'undefined' && window.SangaiJavisOrb)
    || (typeof require === 'function' ? require('./javis-orb.js') : null);

  // ---------------------------------------------------------------------------
  // GLSL
  // ---------------------------------------------------------------------------

  // The animation, and the reason the per-frame CPU cost is two uniform writes rather
  // than an 830-iteration loop. This is javis-lattice.js's restPosition() with
  // the sway terms added — the model computes the resting layout for wiring, the GPU
  // computes where it actually is this frame.
  //
  // Attribute packing (see packNodes):
  //   aSphere  th, ph, r        aSway   da, wa, pa, dr
  //   aSway2   wr, pr, dp       aSway3  wp, pp
  const NODE_GLSL = `
  #define TAU 6.283185307179586

  uniform float uTime, uEnergy, uSpin, uSonar, uSonarRate, uSweep, uSweepOn;

  // Where a node is right now. The 'live' factor scales every sway by the energy, so a
  // busy sphere visibly churns and a quiet one barely breathes — the same 0.55/0.75
  // pair the 2D drawGraph uses, so both renderers agree about what "busy" looks like.
  vec3 nodeAt(vec3 sph, vec4 sway, vec3 sway2, vec2 sway3, out float ping, out float sweepLit) {
    float live = 0.55 + uEnergy * 0.75;

    float th = sph.x + uTime * 0.13 * uSpin + sin(uTime * sway.y + sway.z) * sway.x * live;
    float ph = sph.y + sin(uTime * sway3.x + sway3.y) * sway2.z * live;
    float r  = sph.z + sin(uTime * sway2.x + sway2.y) * sway.w * live;

    // SONAR, for ready/wake. On the flat version rings travelled from the centre to
    // the rim; on a sphere that has no meaning, since every node sits at the same
    // radius. So the ping spreads over the SURFACE instead — a ring opening from the
    // point nearest the viewer and closing on the far side, which is what a sonar
    // return off a ball actually looks like. Three rings, staggered, exactly as the
    // 2D drawWaitingRipples does it.
    ping = 0.0;
    if (uSonar > 0.001) {
      float front = cos(ph);                       // +1 at the top pole, -1 at the bottom
      for (int i = 0; i < 3; i++) {
        float p = fract(uTime * uSonarRate + float(i) / 3.0);
        float d = front - (1.0 - 2.0 * p);
        // Fade in quickly, out slowly, so a ring is brightest mid-travel and gone by
        // the far pole — a hard cut at the edge reads as a bug.
        ping += exp(-d * d * 55.0) * sin(p * 3.14159) ;
      }
      ping *= uSonar;
      r += ping * 0.05;
    }

    // WAKE's radar sweep. A longitude band trailing the sweep angle, which is the
    // same "attention moving across the open ear" the 2D version draws as a gradient
    // arc — here it simply lights the nodes it passes over.
    sweepLit = 0.0;
    if (uSweepOn > 0.001) {
      float dth = mod(uSweep - th, TAU);
      sweepLit = smoothstep(0.9, 0.0, dth) * uSweepOn;
    }

    float sp = sin(ph);
    return r * vec3(sp * cos(th), cos(ph), sp * sin(th));
  }

  // Depth cue. uCamDist is the camera's distance from the origin and the shell has
  // radius ~1, so the near surface is at uCamDist-1 and the far one at uCamDist+1.
  float depthCue(vec4 mv) {
    return clamp((uCamDistUniform + 1.0 - (-mv.z)) * 0.5, 0.0, 1.0);
  }

  // THE SILHOUETTE FIX, and without it the sphere renders wrong in a way that is easy
  // to mistake for a design choice. A uniform shell projects onto the screen with
  // density proportional to 1/sqrt(1 - rho^2) — two sheets, front and back, plus the
  // projection Jacobian — so it DIVERGES at the rim. Left alone the reactor is a
  // rarefied middle inside a hard, solid, glowing ring that clips to white and takes
  // the one-hue rule with it.
  // |N.V| is exactly that Jacobian's reciprocal, so multiplying by it cancels the
  // pile-up and leaves an even surface. The floor keeps the rim from vanishing
  // outright: a hard zero at the edge reads as a bug, the same argument the 2D sonar
  // rings make about fading out before the rim rather than cutting.
  float rimEven(vec3 dir, mat4 mvm) {
    float ndv = abs(normalize((mvm * vec4(normalize(dir), 0.0)).xyz).z);
    return mix(0.28, 1.0, ndv);
  }`;

  // A single dot. Round, soft-edged, and additive — the established look is glow, not
  // geometry, which is also why nothing here writes or tests depth.
  const POINT_FRAG = `
  precision highp float;
  in float vAlpha; in vec3 vTint;
  out vec4 outColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.06, d);
    if (a <= 0.0) discard;
    outColor = vec4(vTint, a * vAlpha);
  }`;

  const LINE_FRAG = `
  precision highp float;
  in float vAlpha; in vec3 vTint;
  out vec4 outColor;
  void main() { outColor = vec4(vTint, vAlpha); }`;

  // ⚠ THE ONE THING THAT CANNOT BE SHARED VERBATIM. javis-orb.js's shader is written
  // for raw WebGL, so it opens with its own `#version 300 es`. three.js's
  // RawShaderMaterial with glslVersion: GLSL3 PREPENDS that same directive, and GLSL
  // requires #version to be the first non-comment token — so the reused source arrives
  // with two of them and the whole program fails to compile:
  //   ERROR: 0:4: 'version' : #version directive must occur before anything else
  // The symptom is worth knowing, because it is not what you would guess: three logs
  // the error and carries on, so the reactor reports ok:true, draws its sphere, and
  // simply has no energy field behind it. Nothing throws.
  //
  // Stripping the caller's copy is the fix, and it belongs HERE rather than in
  // javis-orb.js: that file's own raw-GL path still needs the directive, and it is the
  // one that has to keep working when this one cannot run at all.
  const forThree = (src) => String(src).replace(/^\s*#version[^\n]*\n/, '');

  // ---------------------------------------------------------------------------
  // Support probe
  // ---------------------------------------------------------------------------

  // Import maps are the one requirement that can be answered with no context at all,
  // Informational only — NOT a gate. `HTMLScriptElement.supports('importmap')` is a
  // second, separately-shipped API on top of import maps themselves (Chrome 89 /
  // Firefox 108 / Safari 16.4 for the feature; the detection method itself shipped
  // later still on at least one engine). A browser can have real import-map support
  // while this reports false, and treating that as "no support" would refuse tier 1
  // on a browser that would have worked fine — a false negative with no way for the
  // person hitting it to tell it apart from a genuine gap. So this is logged for
  // diagnosis but the real arbiter is always the actual `import('three')` call in
  // boot(): if the browser truly cannot resolve it, that call rejects and boot()
  // already degrades to 'no-library' on any import failure, for any reason.
  function supportsModules() {
    return Boolean(typeof HTMLScriptElement !== 'undefined'
      && HTMLScriptElement.supports && HTMLScriptElement.supports('importmap'));
  }

  // Given a context the caller already made, say whether it is worth handing to
  // three.js. 'ok' | 'no-webgl' | 'unsupported'. Never creates anything.
  //
  // Deliberately does NOT gate on supportsModules() — see the comment on that
  // function. The only hard refusals here are things a context can answer for
  // certain: no context at all, or a confirmed software rasteriser.
  function inspect(gl) {
    // A 2D-canvas stub (the test harness) answers getContext with something that is
    // not a GL context at all — check for the API rather than trusting the object.
    if (!gl || typeof gl.getParameter !== 'function') return 'no-webgl';
    if (typeof console !== 'undefined' && !supportsModules()) {
      console.info('[javis-reactor3d] HTMLScriptElement.supports("importmap") says no, but attempting the 3D reactor anyway — the real test is whether `import(\'three\')` resolves');
    }
    try {
      const dbg = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
      const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
      if (SOFTWARE.test(name)) {
        // Named, not just flagged — "unsupported" alone gives no way to tell this
        // apart from the import-map case above, and the two have different fixes
        // (one is the browser, one is the machine's GPU/driver path).
        if (typeof console !== 'undefined') {
          console.info(`[javis-reactor3d] software renderer detected (${name}) — using the 2D reactor`);
        }
        return 'unsupported';
      }
    } catch { /* a masked renderer string is not a reason to refuse */ }
    return 'ok';
  }

  function prefersReducedMotion() {
    // Guarded because the node:vm harness has no matchMedia — a bare call would throw
    // ReferenceError through every test that mounts the panel.
    try {
      return typeof matchMedia === 'function'
        && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { return false; }
  }

  async function defaultLoad() {
    // Core only. The reactor needs no loader, no VRM and no addons, so it costs the
    // ~340 KB of three itself and nothing more.
    return { THREE: await import('three') };
  }

  function dead(reason) {
    return {
      ok: false, reason,
      ready: Promise.resolve(false),
      setState() {}, setAmplitude() {}, setWave() {}, setSpectrum() {}, setLook() {},
      draw() {}, resize() {}, dispose() {},
      _debug: () => ({ ok: false, reason }),
    };
  }

  // ---------------------------------------------------------------------------
  // createReactor
  // ---------------------------------------------------------------------------

  // createReactor(canvas, opts) -> handle   (synchronous; never throws, never rejects)
  //
  //   opts.load       TEST SEAM. Returns { THREE }. Injected so the tests never touch
  //                   ESM: a bare `three` specifier cannot resolve under node:test.
  //   opts.probe      TEST SEAM for the support answer.
  //   opts.density    node budget — halved on small screens by the caller
  //   opts.multiplier node budget as a multiple of the ~830 default (javis-lattice.js)
  //   opts.look       { nodeSize, nodeLit, edgeAlpha } gains on the default look, each 1;
  //                   setLook() changes them later
  //   opts.maxDpr     device-pixel-ratio cap
  //   opts.camDist    camera distance; the shell has radius 1
  //
  // The handle comes back immediately with `ok:false` and becomes live when three.js
  // lands, so javis.js's rAF loop can call draw() from the very first frame and simply
  // see nothing happen until then. Same contract as createAvatar, for the same reason.
  function createReactor(canvas, opts = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') return dead('no-canvas');

    const M = model();
    if (!M) return dead('no-model');

    const load = typeof opts.load === 'function' ? opts.load : defaultLoad;
    // The caller owns the context. Without one there is nothing to inspect and
    // nothing to render into — and this module deliberately does NOT fall back to
    // calling getContext itself, because that is how a second context gets created
    // behind the caller's back.
    const gl = opts.gl || null;
    if (load === defaultLoad) {
      const why = inspect(gl);
      if (why !== 'ok') return dead(why);
    }

    const maxDpr = Number(opts.maxDpr) > 0 ? Number(opts.maxDpr) : 1.75;
    const camDist = Number(opts.camDist) > 0 ? Number(opts.camDist) : DEFAULT_CAM_DIST;
    const reduce = opts.reduceMotion === undefined ? prefersReducedMotion() : !!opts.reduceMotion;

    let THREE = null, renderer = null, scene = null, camera = null;
    let bgScene = null, bgCam = null, bgMat = null;
    let nodeMat = null, edgeMat = null, pulseMat = null, spokeMat = null, waveMat = null;
    let spokeGeo = null, waveGeo = null, spokeDirs = null, waveN = 0;
    const disposables = [];

    let ok = false, reason = 'loading', disposed = false, lost = false;
    const gain = (k, look = opts.look, dflt = 1) => (Number(look?.[k]) > 0 ? Number(look[k]) : dflt);

    // Latched inputs — javis.js drives these from frame one, long before the scene
    // exists, so they are recorded and applied on the first draw after it lands.
    const mixer = M.createMixer('ready');
    let state = 'ready';
    let ampTarget = 0, ampNow = 0;
    let wave = null, spectrum = null;
    let drawn = 0;

    const fail = (why) => { reason = why; ok = false; teardown(); return false; };

    function teardown() {
      for (const d of disposables) { try { d.dispose?.(); } catch { /* already gone */ } }
      disposables.length = 0;
      // dispose() releases this renderer's GPU resources. Do NOT call
      // forceContextLoss(): it intentionally loses the canvas context, and Chrome can
      // then refuse to create another renderer on that same canvas — the same trap
      // javis-avatar.js records.
      try { renderer?.dispose(); } catch { /* context already gone */ }
      renderer = null; scene = null; camera = null; bgScene = null; bgCam = null;
    }

    const onLost = (e) => {
      e?.preventDefault?.();   // without this the context can never be restored
      lost = true; ok = false; reason = 'context-lost';
      if (typeof console !== 'undefined') console.warn('[javis-reactor3d] WebGL context lost');
    };
    canvas.addEventListener?.('webglcontextlost', onLost, false);

    // Not visible = not rendered. offsetParent is the one that matters: the page
    // HIDES #javis-panel when you switch service and never unmounts it, so without
    // this the sphere renders off-screen forever.
    function hidden() {
      if (typeof document !== 'undefined' && document.hidden) return true;
      if ('offsetParent' in canvas && canvas.offsetParent === null) return true;
      return false;
    }

    // One uniform block, shared by every material in the scene, so a state change is
    // written once rather than once per object.
    const U = {
      uTime: { value: 0 }, uEnergy: { value: 0 }, uSpin: { value: 1 },
      uSonar: { value: 0 }, uSonarRate: { value: 0.18 },
      uSweep: { value: 0 }, uSweepOn: { value: 0 },
      uCamDistUniform: { value: camDist },
      uScale: { value: 260 },
      uGraph: { value: 0 }, uAmp: { value: 0 }, uBackdrop: { value: 1 }, uThink: { value: 0 },
      uNodeSize: { value: gain('nodeSize') }, uNodeLit: { value: gain('nodeLit') },
      uEdgeGain: { value: gain('edgeAlpha') },
    };

    // Add a drawable to the main scene, culling disabled.
    //
    // frustumCulled = false is MANDATORY here, not defensive. Everything in this scene
    // is positioned in the vertex shader, so three.js's culling test measures bounds the
    // geometry never actually occupies — javis-avatar.js:298 turns it off on the VRM's
    // spring-bone meshes for exactly the same reason. The symptom when it is missing is
    // the classic one: the object vanishes as the camera nears it or a resize narrows
    // the frustum, with nothing in the console to say why.
    const show = (obj) => { obj.frustumCulled = false; scene.add(obj); return obj; };

    function makeMaterial(THREE, vert, frag, extra = {}) {
      // RawShaderMaterial, not ShaderMaterial: ShaderMaterial prepends three.js's own
      // uniform/attribute prelude, which collides with GLSL3 sources that declare
      // their own — including javis-orb.js's backdrop, which is already written as
      // `#version 300 es`.
      const m = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: U,
        vertexShader: vert,
        fragmentShader: frag,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        ...extra,
      });
      disposables.push(m);
      return m;
    }

    // The three preludes differ only in which attributes they declare, so the shared
    // NODE_GLSL above can position all of them with one function.
    const ATTRS = `
    in vec3 aSphere; in vec4 aSway; in vec3 aSway2; in vec2 aSway3;`;
    const MATRICES = `
    uniform mat4 modelViewMatrix, projectionMatrix;
    uniform float uCamDistUniform, uScale, uGraph, uAmp, uNodeSize, uNodeLit, uEdgeGain, uThink;`;

    function buildScene() {
      const graph = M.buildSphere({
        ...(opts.density ? { density: opts.density } : {}),
        ...(opts.multiplier ? { multiplier: opts.multiplier } : {}),
      });
      const nodes = M.packNodes(graph);
      const edges = M.packEdges(graph);
      const pulses = M.packPulses(graph);

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(FOV_DEG, aspect(), 0.1, 20);
      camera.position.set(0, 0, camDist);
      camera.lookAt(0, 0, 0);

      const attach = (geo, packed, prefix = 'a') => {
        const sphere = new THREE.BufferAttribute(packed[prefix + 'Sphere'], 3);
        geo.setAttribute(prefix + 'Sphere', sphere);
        geo.setAttribute(prefix + 'Sway', new THREE.BufferAttribute(packed[prefix + 'Sway'], 4));
        geo.setAttribute(prefix + 'Sway2', new THREE.BufferAttribute(packed[prefix + 'Sway2'], 3));
        geo.setAttribute(prefix + 'Sway3', new THREE.BufferAttribute(packed[prefix + 'Sway3'], 2));

        if (prefix === 'a') {
          // `position` under a second name, sharing the SAME BufferAttribute — no extra
          // memory, and not decoration. three.js takes a non-indexed geometry's draw
          // count from `attributes.position.count`; every vertex here is computed in the
          // vertex shader, so without this the renderer draws ZERO vertices and the
          // panel comes up empty with no error anywhere. The shaders never declare
          // `position`, so it is only ever read for the count.
          geo.setAttribute('position', sphere);
          // And three.js culls by bounding sphere, which it would try to measure from
          // those same values — spherical coordinates, not positions. Setting it
          // explicitly stops the whole object being culled on the first frame.
          geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2.2);
        }
        disposables.push(geo);
        return geo;
      };

      // --- nodes -------------------------------------------------------------
      const nodeGeo = attach(new THREE.BufferGeometry(), nodes);
      nodeGeo.setAttribute('aNode', new THREE.BufferAttribute(nodes.aNode, 2));
      nodeGeo.setDrawRange(0, nodes.count);
      nodeMat = makeMaterial(THREE, `${MATRICES}${ATTRS}
      in vec2 aNode;
      ${NODE_GLSL}
      out float vAlpha; out vec3 vTint;
      void main() {
        float ping, sweepLit;
        vec3 p = nodeAt(aSphere, aSway, aSway2, aSway3, ping, sweepLit);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float depth = depthCue(mv);

        // Each node breathes on its OWN phase — a synchronised mesh looks mechanical
        // rather than thinking. This is the 2D version's per-node beat, minus the six
        // quantised buckets it needed to keep fill() calls down; on the GPU every node
        // can simply have its own value.
        float beat = 0.5 + 0.5 * sin(uTime * 2.6 + aNode.y);
        float lit = (0.46 + beat * 0.30 + uEnergy * 0.24 + ping * 0.5 + sweepLit * 0.45) * uNodeLit
                  * mix(1.0, ${THINK_LOOK.litScale.toFixed(3)}, uThink);

        // Depth by DIMMING and SCALING, not occlusion. Hard z-occlusion on additive
        // glow punches holes; falling off toward the back is what reads as volume.
        vAlpha = lit * mix(0.20, 1.0, depth) * (0.35 + uGraph * 0.65) * rimEven(p, modelViewMatrix);
        vTint = mix(mix(vec3(0.176, 0.859, 0.941), vec3(0.647, 0.961, 1.0), beat * 0.6 + uEnergy * 0.4),
                    mix(${glslVec3(THINK_LOOK.tintLow)}, ${glslVec3(THINK_LOOK.tintHigh)}, beat), uThink);

        // TRUE perspective attenuation, not a hand-tuned depth fade: uScale is half the
        // drawing buffer's height, which is the same factor three.js's own PointsMaterial
        // uses for sizeAttenuation, so a node an inch nearer is bigger by the amount the
        // projection says it should be. The floor exists because a sub-pixel GL point does
        // NOT anti-alias down the way ctx.arc does — it snaps to one pixel or drops out.
        gl_PointSize = max(1.5, aNode.x * (${THINK_LOOK.sizeBase.toFixed(3)} + uEnergy * mix(0.078, ${THINK_LOOK.sizeEnergy.toFixed(3)}, uThink) + ping * 0.06) * uNodeSize
                     * uScale / max(0.1, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`, POINT_FRAG);
      show(new THREE.Points(nodeGeo, nodeMat));

      // --- edges -------------------------------------------------------------
      const edgeGeo = attach(new THREE.BufferGeometry(), edges);
      edgeGeo.setDrawRange(0, edges.count);
      edgeMat = makeMaterial(THREE, `${MATRICES}${ATTRS}
      ${NODE_GLSL}
      out float vAlpha; out vec3 vTint;
      void main() {
        float ping, sweepLit;
        vec3 p = nodeAt(aSphere, aSway, aSway2, aSway3, ping, sweepLit);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float depth = depthCue(mv);
        // Dimmer than the nodes by design: the wiring is what the signals travel
        // along, not the subject. At equal brightness the sphere reads as a solid
        // ball of lines with no points left to see.
        //
        // RAISED ~1.6x over the 2D alphas, and it is a correction rather than a taste
        // change. WebGL ignores line width above 1.0 — ANGLE and every core profile
        // clamp glLineWidth — so these draw at ONE DEVICE pixel where the 2D canvas
        // draws 0.9 CSS pixels. On a DPR-2 display that is half the ink, and the mesh
        // would read as noticeably fainter than the version it replaces.
        vAlpha = ((0.28 + uEnergy * 0.26) * mix(1.0, ${THINK_LOOK.edgeScale.toFixed(3)}, uThink) * mix(0.10, 1.0, depth) * uGraph * rimEven(p, modelViewMatrix)
               + sweepLit * 0.10) * uEdgeGain;
        vTint = vec3(0.176, 0.859, 0.941);
        gl_Position = projectionMatrix * mv;
      }`, LINE_FRAG);
      show(new THREE.LineSegments(edgeGeo, edgeMat));

      // --- travelling pulses -------------------------------------------------
      // Both endpoints on one geometry: the a* family via attach (which also supplies
      // `position` for the draw count), the b* family alongside it.
      const pulseGeo = attach(new THREE.BufferGeometry(), pulses);
      attach(pulseGeo, pulses, 'b');
      pulseGeo.setAttribute('aTravel', new THREE.BufferAttribute(pulses.aTravel, 2));
      pulseMat = makeMaterial(THREE, `${MATRICES}${ATTRS}
      in vec3 bSphere; in vec4 bSway; in vec3 bSway2; in vec2 bSway3;
      in vec2 aTravel;
      ${NODE_GLSL}
      out float vAlpha; out vec3 vTint;
      void main() {
        float pingA, pingB, litA, litB;
        vec3 a = nodeAt(aSphere, aSway, aSway2, aSway3, pingA, litA);
        vec3 b = nodeAt(bSphere, bSway, bSway2, bSway3, pingB, litB);
        // The identical travel formula the 2D version uses, so a signal crosses its
        // edge at the same rate in either renderer.
        float p = fract(uTime * aTravel.y * (0.6 + uEnergy * 1.5) + aTravel.x);
        vec4 mv = modelViewMatrix * vec4(mix(a, b, p), 1.0);
        float depth = depthCue(mv);
        vAlpha = (0.55 + uEnergy * 0.45) * mix(0.15, 1.0, depth) * uGraph;
        vTint = vec3(0.588, 0.949, 1.0);
        gl_PointSize = max(1.5, (0.045 + uEnergy * 0.040) * uScale / max(0.1, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`, POINT_FRAG);
      show(new THREE.Points(pulseGeo, pulseMat));

      buildSpokes();
      buildWaveRing();
      buildBackdrop();
    }

    // LISTENING — the radial equaliser. The 2D version puts 56 evenly-spaced spokes
    // around a circle; "evenly spaced" has no good meaning on a sphere, so these use a
    // golden-angle lattice (see the model) and the result reads as a hedgehog rather
    // than a hairy hat. Two vertices per spoke, positions rewritten per frame — 112
    // vertices is small enough that a CPU update costs nothing, and the lengths come
    // from the live spectrum rather than from anything the shader could derive.
    function buildSpokes() {
      const COUNT = 56;
      spokeDirs = M.spokeDirections(COUNT);
      spokeGeo = new THREE.BufferGeometry();
      spokeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 6), 3));
      spokeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2.2);
      disposables.push(spokeGeo);
      spokeMat = makeMaterial(THREE, `${MATRICES}
      in vec3 position;
      out float vAlpha; out vec3 vTint;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float depth = clamp((uCamDistUniform + 1.0 - (-mv.z)) * 0.5, 0.0, 1.0);
        vAlpha = mix(0.15, 1.0, depth) * 0.9;
        vTint = vec3(0.176, 0.859, 0.941);
        gl_Position = projectionMatrix * mv;
      }`, LINE_FRAG);
      show(new THREE.LineSegments(spokeGeo, spokeMat));
    }

    // The traced waveform ring. Real samples in every state that has them — the mic
    // while capturing, the reply while speaking — which is what makes it move with
    // the voice instead of spinning for its own sake. Tilted off the equator so it
    // reads as a ring around a ball rather than a line across a disc.
    function buildWaveRing() {
      const N = 128;
      waveGeo = new THREE.BufferGeometry();
      waveGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((N + 1) * 3), 3));
      waveGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2.2);
      waveN = N;
      disposables.push(waveGeo);
      waveMat = makeMaterial(THREE, `${MATRICES}
      in vec3 position;
      out float vAlpha; out vec3 vTint;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float depth = clamp((uCamDistUniform + 1.0 - (-mv.z)) * 0.5, 0.0, 1.0);
        vAlpha = mix(0.12, 1.0, depth) * min(1.0, 0.5 + uAmp * 0.9);
        vTint = vec3(0.471, 0.922, 1.0);
        gl_Position = projectionMatrix * mv;
      }`, LINE_FRAG);
      const ring = new THREE.Line(waveGeo, waveMat);
      ring.rotation.x = -0.42;   // off-axis, so it reads as a ring in space
      show(ring);
    }

    // javis-orb.js's field, unchanged, on a full-screen quad. It renders into its own
    // scene with an orthographic camera and goes down first, so it is a backdrop in
    // the literal sense — nothing in the main scene has to know it exists.
    function buildBackdrop() {
      const api = orb();
      if (!api || !api.FRAG) return;   // optional: a missing field is not a failure
      bgScene = new THREE.Scene();
      bgCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(
        new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 8);
      disposables.push(geo);
      bgMat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          uTime: U.uTime, uAmp: U.uAmp, uBackdrop: U.uBackdrop,
          uState: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) },
        },
        vertexShader: `
        in vec3 position;
        out vec2 vUv;
        void main() { vUv = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: forThree(api.FRAG),
        transparent: true,
        depthTest: false, depthWrite: false,
      });
      disposables.push(bgMat);
      bgScene.add(new THREE.Mesh(geo, bgMat));
    }

    const aspect = () => (canvas.width && canvas.height ? canvas.width / canvas.height : 1);

    function resize() {
      if (!renderer || !camera) return;
      const w = canvas.width, h = canvas.height;
      if (!w || !h) return;
      // `false` — javis.js's own fit() owns the backing store and the CSS size;
      // letting three.js also write style here would fight it on every resize.
      renderer.setSize?.(w, h, false);
      camera.aspect = aspect();
      camera.updateProjectionMatrix?.();
      // Half the drawing buffer's height — the factor that turns a world-space size
      // into device pixels. It has to be re-read here because fit() rewrites the
      // backing store on every resize.
      U.uScale.value = h * 0.5;
      if (bgMat) bgMat.uniforms.uRes.value.set?.(w, h);
    }

    async function boot() {
      let mod;
      try {
        mod = await load();
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[javis-reactor3d] library failed to load:', err?.message || err);
        return fail('no-library');
      }
      if (disposed) return fail('disposed');
      THREE = mod && mod.THREE;
      if (!THREE || !THREE.WebGLRenderer) return fail('no-library');

      try {
        // `context` is what keeps the one-context rule structural rather than a
        // convention: three.js adopts the object javis.js already made instead of
        // asking the canvas for another. premultipliedAlpha must MATCH the flags that
        // context was created with — three picks different blend factors for
        // AdditiveBlending depending on it, and a mismatch shows up as a field that is
        // either washed out or crushed against the panel's grid.
        renderer = new THREE.WebGLRenderer({
          canvas, context: gl || undefined,
          alpha: true, antialias: true, premultipliedAlpha: false,
        });
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[javis-reactor3d] no WebGL:', err?.message || err);
        return fail('no-webgl');
      }

      try {
        // setPixelRatio(1) is deliberate and load-bearing: javis.js's fit() has ALREADY
        // multiplied the backing store by devicePixelRatio, and setSize is handed that
        // same already-scaled width. Letting three scale again would render at up to
        // DPR^2 the pixels for no visible gain.
        renderer.setPixelRatio?.(1);
        renderer.setClearAlpha?.(0);
        // Two scenes, drawn in order, so the backdrop cannot be reordered by anything
        // in the main one.
        renderer.autoClear = false;
        buildScene();
        resize();
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[javis-reactor3d] scene failed to build:', err?.message || err);
        return fail('scene-failed');
      }

      ok = true; reason = 'ok';
      return true;
    }

    // The two CPU-side geometries. Everything else is a uniform write.
    function updateSpokes(dials) {
      if (!spokeGeo || !spokeDirs) return;
      const pos = spokeGeo.getAttribute?.('position');
      if (!pos) return;
      const arr = pos.array;
      const COUNT = arr.length / 6;
      const on = dials.spokes;
      for (let i = 0; i < COUNT; i++) {
        const dx = spokeDirs[i * 3], dy = spokeDirs[i * 3 + 1], dz = spokeDirs[i * 3 + 2];
        // Per-spoke wobble on top of the level, exactly as the 2D equaliser does it —
        // a bank of bars all the same height reads as a meter, not as a voice. The
        // spectrum refines it when there is one; the level alone still works.
        const band = spectrum && spectrum.length
          ? spectrum[Math.floor((i / COUNT) * spectrum.length)] / 255
          : ampNow;
        const wob = 0.55 + 0.45 * Math.sin(U.uTime.value * 7 + i * 0.7);
        const len = on * (0.06 + band * 0.34 * wob) * (0.25 + ampNow * 1.5);
        const inner = 1.02, outer = inner + len;
        arr[i * 6] = dx * inner; arr[i * 6 + 1] = dy * inner; arr[i * 6 + 2] = dz * inner;
        arr[i * 6 + 3] = dx * outer; arr[i * 6 + 4] = dy * outer; arr[i * 6 + 5] = dz * outer;
      }
      pos.needsUpdate = true;
    }

    function updateWaveRing(dials, t) {
      if (!waveGeo) return;
      const pos = waveGeo.getAttribute?.('position');
      if (!pos) return;
      const arr = pos.array;
      const N = waveN;
      const on = dials.wave;
      const spin = t * 0.35;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * TAU + spin;
        let amp;
        if (wave && wave.length) {
          amp = (wave[Math.floor((i / N) * (wave.length - 1))] || 0) * 0.13 * (0.6 + ampNow * 2);
        } else {
          // Idle still needs SOME motion or the ring reads as a dead circle — the
          // same ambient fallback the 2D version uses when nothing is captured.
          amp = 0.035 * (Math.sin(a * 3 + t * 1.4) + 0.5 * Math.sin(a * 5 - t * 2.1));
        }
        const rr = (1.16 + amp) * on;
        arr[i * 3] = Math.cos(a) * rr;
        arr[i * 3 + 1] = 0;
        arr[i * 3 + 2] = Math.sin(a) * rr;
      }
      pos.needsUpdate = true;
    }

    const ready = boot();

    return {
      get ok() { return ok; },
      get reason() { return reason; },
      ready,

      setState(name) {
        if (!M.STATE[name]) return;
        state = name;
        mixer.setState(name);
      },
      setAmplitude(a) { ampTarget = clamp01(a); },
      setWave(buf) { wave = buf && buf.length ? buf : null; },
      setSpectrum(buf) { spectrum = buf && buf.length ? buf : null; },
      setLook(look) {
        U.uNodeSize.value = gain('nodeSize', look, U.uNodeSize.value);
        U.uNodeLit.value = gain('nodeLit', look, U.uNodeLit.value);
        U.uEdgeGain.value = gain('edgeAlpha', look, U.uEdgeGain.value);
      },

      draw(t) {
        if (!ok || disposed || lost || hidden()) return;
        const now = Number(t) || 0;

        // Asymmetric, like the mic meter and the shader orb: attack fast so a syllable
        // lands on time, release slow so the sphere does not strobe between words.
        ampNow += (ampTarget - ampNow) * (ampTarget > ampNow ? 0.45 : 0.10);
        const dials = mixer.advance(0.08);
        const energy = M.stateEnergy(state, now, ampNow);

        U.uTime.value = now;
        U.uAmp.value = ampNow;
        U.uEnergy.value = energy;
        U.uGraph.value = dials.graph;
        U.uThink.value = dials.think || 0;
        U.uSonar.value = dials.sonar > 0.002 ? 1 : 0;
        U.uSonarRate.value = Math.max(0.02, dials.sonar);
        U.uSweep.value = (now * 1.9) % TAU;
        U.uSweepOn.value = dials.sweep;
        // Reduced motion freezes the spin and the churn but keeps every state's
        // brightness: motion here is decoration, state is information.
        U.uSpin.value = reduce ? 0 : dials.spin;
        if (reduce) U.uEnergy.value = Math.min(energy, 0.35);
        if (bgMat) bgMat.uniforms.uState.value = state === 'speaking' ? 1 : 0;
        // The field's own fade. It used to be a CSS opacity on #orb-gl, but in tier 1
        // the backdrop and the subject share one canvas, so CSS can no longer reach one
        // without the other — see javis-orb.js's uBackdrop.
        U.uBackdrop.value = dials.glow;

        updateSpokes(dials);
        updateWaveRing(dials, reduce ? 0 : now);

        try {
          renderer.clear();
          // The 4-octave fbm over the whole canvas is the panel's dominant GPU cost, and
          // it now applies in all five states rather than the two the shader orb served.
          // Skipping it outright when the field is faded out is worth more than any
          // micro-optimisation inside it.
          if (bgScene && dials.glow > 0.02) renderer.render(bgScene, bgCam);
          renderer.render(scene, camera);
          drawn++;
        } catch (err) {
          // One bad frame must not take the panel down with it — javis.js falls back
          // to the 2D reactor the moment `ok` goes false.
          if (typeof console !== 'undefined') console.warn('[javis-reactor3d] draw failed:', err?.message || err);
          ok = false; reason = 'draw-failed';
        }
      },

      resize,

      dispose() {
        disposed = true; ok = false; reason = 'disposed';
        canvas.removeEventListener?.('webglcontextlost', onLost, false);
        teardown();
      },

      _debug: () => ({
        ok, reason, state, drawn, amp: ampNow,
        energy: U.uEnergy.value, dials: { ...mixer.dials },
        uniforms: Object.fromEntries(Object.entries(U).map(([k, v]) => [k, v.value])),
      }),
    };
  }

  const api = { createReactor, inspect, supportsModules, SOFTWARE, NODE_GLSL, forThree, FOV_DEG, DEFAULT_CAM_DIST, THINK_LOOK };

  // Dual tail, same as every other file here.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SangaiJavisReactor3D = api;
})();
