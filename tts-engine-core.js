'use strict';

// Holds the value created for the most recent key: a prefetch and a reply asking for the same
// voice share one download and one session, and asking for another voice replaces it.
function latestOnly(create) {
  let current = null;
  const get = (key) => {
    if (current && current.key === key) return current.promise;
    const promise = (async () => create(key))();
    current = { key, promise };
    promise.catch(() => {
      if (current && current.promise === promise) current = null;
    });
    return promise;
  };
  get.reset = () => { current = null; };
  return get;
}

// Some servers send no Content-Length; the size the catalog already knows stands in, capped short
// of done so a low estimate never shows 100% early.
function downloadFraction(loaded, total, expected) {
  if (total > 0) return loaded / total;
  return expected > 0 ? Math.min(0.99, loaded / expected) : 0;
}

// Model files are hundreds of MB, so they come from Cache Storage when present and are streamed
// with progress otherwise. A full cache costs only the next visit's download, never this one.
async function fetchCached(url, { cacheName, progress, expectedBytes = 0, fetchImpl = fetch, cachesImpl = caches, warn = console.warn }) {
  const cache = await cachesImpl.open(cacheName);
  const hit = await cache.match(url);
  if (hit) {
    progress(1);
    return new Uint8Array(await hit.arrayBuffer());
  }
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`);
  // Under Content-Encoding the header counts compressed bytes, not what the reader yields.
  const total = response.headers.get('content-encoding') ? 0 : Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total || expectedBytes) progress(downloadFraction(received, total, expectedBytes));
  }
  if (total && received !== total) throw new Error(`download incomplete (${received} of ${total} bytes) for ${url}`);
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
  } catch (error) {
    warn(`Not cached (${error.name}): ${url}`);
  }
  return bytes;
}

module.exports = { latestOnly, fetchCached, downloadFraction };
