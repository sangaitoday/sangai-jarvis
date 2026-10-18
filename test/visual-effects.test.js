'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../public');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('fake-graph.js implements Vibrant Neural Spectrum with traveling photon pulses and distinct palette', () => {
  const code = read('fake-graph.js');
  
  // Palette must include vibrant violet/purple and emerald accents
  assert.match(code, /#8b5cf6|#a855f7|#d946ef|#6366f1/i, 'fake-graph must include vibrant violet/indigo/purple colors');
  assert.match(code, /#10b981|#059669|#047857/i, 'fake-graph must include vibrant emerald accents');
  
  // Must render photon/signal pulses traveling along links
  assert.match(code, /photon|pulsePacket|travelPulse|linkPulse/i, 'fake-graph must implement traveling link photon/signal pulses');

  // Links must have dynamic gradient or dual-color styling, not just static single-hue cyan
  assert.match(code, /createLinearGradient|pulseGradient|strokeLinksGradient|strokePhotons/i, 'fake-graph must support dynamic gradient or photon link rendering');
});

test('jarvis-orb.js and jarvis-center.js implement chromatic dual-tone energy distinct from monolithic cyan', () => {
  const orbCode = read('jarvis/jarvis-orb.js');
  const centerCode = read('jarvis-center.js');

  // Orb shader must have chromatic spectrum (violet / emerald / harmonic dual-tone)
  assert.match(orbCode, /chroma|harmonic|violet|emerald|mix\(.*vec3\(0\.[3-9]/i, 'orb shader must include chromatic harmonic tint beyond cool blue');

  // 2D center reactor must support multi-spectral pulses (e.g. violet / emerald accents alongside cyan)
  assert.match(centerCode, /#a855f7|#818cf8|#c084fc|#34d399|#10b981|spectral/i, 'jarvis-center must include multi-spectral pulse colors');
});
