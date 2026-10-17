'use strict';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const LONG_CACHE = [
  [/^\/webllm\/\d+\.\d+\.\d+\//, 'public, max-age=31536000, immutable'],
  [/^\/onnx\/[a-z0-9]+\/[0-9a-f]{12}\//, 'public, max-age=31536000, immutable'],
  [/^\/onnx\//, 'public, max-age=604800'],
];

function cacheControlFor(pathname) {
  const rule = LONG_CACHE.find(([pattern]) => pattern.test(pathname));
  return rule ? rule[1] : 'no-store';
}

const PAGES = { '/': 'index.html', '/privacy': 'privacy.html', '/terms': 'terms.html' };

function isTestFile(p) {
  return /\.test\.m?js$/.test(p);
}

module.exports = { MIME, LONG_CACHE, cacheControlFor, PAGES, isTestFile };
