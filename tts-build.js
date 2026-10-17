'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FORBIDDEN = [
  [/huggingface\.co\/[^"'`\s]*\/resolve\/main\//, 'an unpinned model URL (resolve/main)'],
  [/cdn\.jsdelivr\.net/, 'a runtime loaded from cdn.jsdelivr.net'],
  [/cdnjs\.cloudflare\.com/, 'a runtime loaded from cdnjs.cloudflare.com'],
  [/unpkg\.com/, 'a runtime loaded from unpkg.com'],
];

function checkBundle(source, buildDirName) {
  const problems = FORBIDDEN.filter(([pattern]) => pattern.test(source)).map(([, what]) => `bundle contains ${what}`);
  if (buildDirName && source.includes(buildDirName)) problems.push(`bundle leaks the build path (${buildDirName})`);
  return problems;
}

function mergeManifest(file, engine, { bundle, revision, voices }) {
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const next = {
    bundles: { ...current.bundles, [engine]: bundle },
    revisions: { ...current.revisions, [engine]: revision },
    voices: { ...current.voices },
  };
  if (voices) next.voices[engine] = voices;
  else delete next.voices[engine];
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(temporary, 'w');
  try {
    fs.writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'check') {
    const [file, buildDirName] = args;
    const problems = checkBundle(fs.readFileSync(file, 'utf8'), buildDirName);
    for (const problem of problems) process.stderr.write(`${file}: ${problem}\n`);
    process.exit(problems.length ? 1 : 0);
  } else if (command === 'manifest') {
    const [file, engine, bundle, revision, voicesFile] = args;
    const voices = voicesFile ? JSON.parse(fs.readFileSync(voicesFile, 'utf8')) : undefined;
    mergeManifest(file, engine, { bundle, revision, voices });
  } else {
    process.stderr.write('usage: tts-build.js check <bundle> <build-dir-name> | manifest <file> <engine> <bundle> <revision> [voices.json]\n');
    process.exit(2);
  }
}

module.exports = { checkBundle, mergeManifest };
