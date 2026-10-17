#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { MIME, cacheControlFor, PAGES, isTestFile } = require('./site-rules.js');

const PUBLIC_DIR = path.join(__dirname, 'public');

function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  if (isTestFile(full)) {
    res.writeHead(404);
    return res.end('not found');
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full)] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': cacheControlFor('/' + file),
    });
    res.end(buf);
  });
}

function createSite() {
  function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      return res.end('ok');
    }
    if (PAGES[p]) return serveStatic(res, PAGES[p]);
    return serveStatic(res, p.slice(1));
  }
  return { handle };
}

if (require.main === module) {
  const port = Number(process.env.PORT || process.env.SANGAI_SITE_PORT || 8080);
  const host = process.env.HOST || process.env.SANGAI_SITE_HOST || '127.0.0.1';
  const site = createSite();
  const server = http.createServer(site.handle);
  server.listen(port, host, () => {
    console.log(`listening on http://${host}:${port}`);
  });
}

module.exports = { createSite };
