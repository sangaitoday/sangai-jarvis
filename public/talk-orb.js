'use strict';
(function () {
  const GL_OPTIONS = { alpha: true, premultipliedAlpha: false, antialias: true };
  const LEVEL_GAIN = 9;
  const ATTACK = 0.5;
  const RELEASE = 0.12;
  const DECAY = 0.86;

  function readVoice(analyser) {
    if (!analyser) return null;
    const wave = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(wave);
    const spectrum = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(spectrum);
    let sum = 0;
    for (const v of wave) sum += v * v;
    return { level: Math.min(1, Math.sqrt(sum / wave.length) * LEVEL_GAIN), wave, spectrum };
  }

  function createTalkOrb(canvas, glCanvas, env = {
    reactor3d: window.SangaiJavisReactor3D,
    reactor2d: window.SangaiTalkReactor,
    scale: window.SangaiJavisOrbScale,
    lattice: window.SangaiJavisLattice,
    now: () => performance.now(),
    hints: () => ({
      coarse: typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
      cores: navigator.hardwareConcurrency,
      memory: navigator.deviceMemory,
    }),
    dpr: () => window.devicePixelRatio || 1,
    addEventListener: (type, fn) => window.addEventListener(type, fn),
    removeEventListener: (type, fn) => window.removeEventListener(type, fn),
    log: console,
  }) {
    let state = 'ready';
    let level = 0;
    let sphere = null;
    let live = false;
    let flat = null;
    let device = null;
    let governor = null;
    let lastMs = null;
    const startFlat = () => { flat = flat || env.reactor2d.start(canvas, () => ({ state, level })); };
    const show = (sphereUp) => {
      canvas.hidden = sphereUp;
      glCanvas.hidden = !sphereUp;
    };
    const fit = () => {
      const box = glCanvas.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const dpr = env.dpr();
      const { glMax, constrained } = device;
      governor.setCap(env.scale.renderScaleCap({ cssW: box.width, cssH: box.height, dpr, glMax, constrained }));
      [glCanvas.width, glCanvas.height] = env.scale.backingSize({ cssW: box.width, cssH: box.height, dpr, scale: governor.scale, glMax });
      sphere.resize();
      sphere.setLook(env.scale.lookFor(governor.multiplier, governor.scale));
    };
    const onResize = () => {
      if (live) fit();
    };

    function demote(why) {
      const dying = sphere;
      sphere = null;
      live = false;
      dying.dispose();
      env.log.warn(`[talk-orb] 3D reactor stopped (${why}); using the 2D reactor`);
      show(false);
      startFlat();
    }

    function boot() {
      const m = governor.multiplier;
      const handle = env.reactor3d.createReactor(glCanvas, { gl, multiplier: m, look: env.scale.lookFor(m, governor.scale ?? 1) });
      sphere = handle;
      handle.ready.then((up) => {
        if (sphere !== handle) return;
        if (!up) return demote(handle.reason);
        live = true;
        if (flat) flat.stop();
        flat = null;
        show(true);
        fit();
      });
    }

    let gl = null;
    try {
      gl = glCanvas.getContext('webgl2', GL_OPTIONS);
    } catch (e) {
      env.log.warn(`[talk-orb] WebGL2 context refused (${e.message})`);
    }
    if (gl && typeof gl.createShader !== 'function') gl = null;
    const verdict = !env.reactor3d || !env.scale ? 'no-model' : !gl ? 'no-webgl' : env.reactor3d.inspect(gl);
    show(false);
    startFlat();
    env.addEventListener('resize', onResize);
    if (verdict !== 'ok') {
      env.log.info(`[talk-orb] 3D reactor not used here (${verdict}); using the 2D reactor`);
    } else {
      const rb = Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
      const hints = env.hints();
      device = {
        cores: hints.cores, memory: hints.memory, maxRenderbuffer: rb,
        glMax: env.scale.glLimit(rb, gl.getParameter(gl.MAX_VIEWPORT_DIMS)),
        constrained: env.scale.isConstrained(hints),
      };
      const first = env.scale.chooseNodeMultiplier(device);
      const multiplier = env.lattice
        ? env.scale.settleNodeMultiplier(first, (m) => {
          const t0 = env.now();
          env.lattice.buildSphere({ multiplier: m });
          return env.now() - t0;
        })
        : first;
      governor = env.scale.createGovernor({ multiplier });
      boot();
    }

    return {
      frame(nextState, voice, t) {
        state = nextState;
        if (!voice) level *= DECAY;
        else level += (voice.level - level) * (voice.level > level ? ATTACK : RELEASE);
        if (!live) return;
        if (!sphere.ok) {
          if (sphere.reason !== 'loading') demote(sphere.reason);
          return;
        }
        sphere.setState(state);
        sphere.setAmplitude(level);
        sphere.setWave(voice ? voice.wave : null);
        sphere.setSpectrum(voice ? voice.spectrum : null);
        sphere.draw(t);
        const ms = t * 1000;
        const step = governor.tick(ms - lastMs, ms);
        lastMs = ms;
        if (step === 'scale') fit();
        if (step === 'nodes') {
          sphere.dispose();
          boot();
        }
      },
      dispose() {
        env.removeEventListener('resize', onResize);
        if (sphere) sphere.dispose();
        sphere = null;
        live = false;
        if (flat) flat.stop();
        flat = null;
      },
    };
  }

  const api = { createTalkOrb, readVoice };
  if (typeof window !== 'undefined') window.TalkOrb = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
