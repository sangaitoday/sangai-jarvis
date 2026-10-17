#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { MIME, cacheControlFor, PAGES, isTestFile } = require('./site-rules.js');

const PUBLIC_DIR = path.join(__dirname, 'public');

function serveStatic(req, res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  if (isTestFile(full)) {
    res.writeHead(404);
    return res.end('not found');
  }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const type = MIME[path.extname(full)] || 'application/octet-stream';
    const cacheControl = cacheControlFor('/' + file);
    const total = stat.size;
    const rangeHeader = req.headers && req.headers.range;
    const isHead = req.method === 'HEAD';

    if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
      const [startStr, endStr] = rangeHeader.slice('bytes='.length).split('-');
      let start = startStr === '' ? total - Number(endStr) : Number(startStr);
      let end = endStr === '' || startStr === '' ? total - 1 : Number(endStr);
      if (end >= total) end = total - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || start >= total) {
        res.writeHead(416, { 'content-range': `bytes */${total}` });
        return res.end();
      }
      const chunkLength = end - start + 1;
      res.writeHead(206, {
        'content-type': type,
        'content-length': chunkLength,
        'content-range': `bytes ${start}-${end}/${total}`,
        'accept-ranges': 'bytes',
        'cache-control': cacheControl,
      });
      if (isHead) return res.end();
      const stream = fs.createReadStream(full, { start, end });
      stream.on('error', () => res.destroy());
      return stream.pipe(res);
    }

    res.writeHead(200, {
      'content-type': type,
      'content-length': total,
      'accept-ranges': 'bytes',
      'cache-control': cacheControl,
    });
    if (isHead) return res.end();
    const stream = fs.createReadStream(full);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

function createSite() {
  function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let p;
    try {
      p = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      return res.end('bad request');
    }
    const clean = p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
    if (clean === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? '' : 'ok');
    }
    if (PAGES[clean]) return serveStatic(req, res, PAGES[clean]);
    return serveStatic(req, res, p.slice(1));
  }
  return { handle };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '127.0.0.1';
  const site = createSite();
  const server = http.createServer(site.handle);
  server.listen(port, host, () => {
    console.log(`listening on http://${host}:${port}`);
  });
}

module.exports = { createSite };
