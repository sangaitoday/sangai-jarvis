'use strict';
(function () {
  // Bandwidth is the slope between a 1-copy submit and one whose copy work swamps timer and
  // clock-ramp jitter, so fixed queue latency cancels. Some browsers report completion only on a
  // ~37 ms tick after ~75 ms of latency, so the batch grows until its work alone passes the target.
  const TARGET_WORK_MS = 150;
  const MAX_COPIES = 1024;
  const PROBE_ROUNDS = 7;
  // Idle GPUs sit in a low memory-clock state; sustained load first so the rounds see full clocks.
  const WARM_MS = 150;
  let menuPromise = null;
  let engine = null;
  let worker = null;
  let selectionQueue = Promise.resolve();
  let selectedId = null;
  let selectedContextWindow = null;
  let catalog = null;
  let persistRequested = false;
  const MODEL_CACHE = 'webllm/model';

  async function readJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return response.json();
  }

  async function measureBandwidth(adapter) {
    const info = adapter.info || {};
    const key = `talk.gpu.bw.${info.vendor || ''}|${info.architecture || ''}`;
    let cached = null;
    try {
      cached = Number(localStorage.getItem(key));
    } catch (error) {
      cached = null;
    }
    if (cached > 0) return cached;
    const device = await adapter.requestDevice();
    let source;
    let destination;
    try {
      const size = 64 * 1024 * 1024;
      source = device.createBuffer({ size, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      destination = device.createBuffer({ size, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const timeBatch = async (copies) => {
        const started = performance.now();
        const commands = device.createCommandEncoder();
        for (let i = 0; i < copies; i += 1) {
          commands.copyBufferToBuffer(i % 2 ? destination : source, 0, i % 2 ? source : destination, 0, size);
        }
        device.queue.submit([commands.finish()]);
        await device.queue.onSubmittedWorkDone();
        return performance.now() - started;
      };
      await timeBatch(1);
      const latency = Math.max(await timeBatch(1), await timeBatch(1), await timeBatch(1));
      let copies = 2;
      while (copies < MAX_COPIES && await timeBatch(copies) - latency < TARGET_WORK_MS) copies *= 2;
      const warmStart = performance.now();
      while (performance.now() - warmStart < WARM_MS) await timeBatch(copies);
      const singles = [];
      const batches = [];
      for (let i = 0; i < PROBE_ROUNDS; i += 1) {
        singles.push(await timeBatch(1));
        batches.push(await timeBatch(copies));
      }
      // Page animation only ever adds time to a submit, so the fastest round is the least contended.
      const single = Math.min(...singles);
      const batch = Math.min(...batches);
      if (!(batch > single)) throw new Error('GPU bandwidth probe could not separate copy time from queue latency');
      const bandwidth = (copies - 1) * size * 2 / ((batch - single) / 1000) / 1e9;
      try {
        localStorage.setItem(key, String(bandwidth));
      } catch (error) {
        return bandwidth;
      }
      return bandwidth;
    } finally {
      if (source) source.destroy();
      if (destination) destination.destroy();
      device.destroy();
    }
  }

  function prepareMenu() {
    if (!menuPromise) {
      menuPromise = (async () => {
        const [models, scores] = await Promise.all([
          readJson('/talk-models.json'),
          readJson('/talk-models-scores.json'),
        ]);
        catalog = models;
        const adapter = await navigator.gpu?.requestAdapter();
        const hw = {
          gpu: Boolean(adapter),
          f16: Boolean(adapter?.features.has('shader-f16')),
          maxBufferMB: adapter ? adapter.limits.maxBufferSize / 2 ** 20 : 0,
          memoryMB: navigator.deviceMemory ? navigator.deviceMemory * 1024 : null,
          bandwidthGBs: adapter ? await measureBandwidth(adapter) : 0,
        };
        const device = window.TalkModelsCore.deviceSummary(adapter?.info, hw.bandwidthGBs, navigator.userAgentData, navigator.userAgent);
        return { options: window.TalkModelsCore.talkModelOptions(models, scores, hw), device };
      })();
    }
    return menuPromise;
  }

  async function cachedUrls() {
    if (typeof caches === 'undefined') return new Set();
    return new Set((await (await caches.open(MODEL_CACHE)).keys()).map((request) => request.url));
  }

  async function storedShards(model, keys, listing) {
    const records = listing.records;
    const present = records.filter((record) => keys.has(new URL(record.dataPath, model.url).href));
    return { present, records };
  }

  async function downloads() {
    const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
    if (typeof caches === 'undefined') {
      return { models: [], usage: estimate.usage ?? null, quota: estimate.quota ?? null };
    }
    const keys = await cachedUrls();
    const cache = await caches.open(MODEL_CACHE);
    const seen = new Set();
    const models = [];
    for (const model of catalog.models) {
      if (seen.has(model.url)) continue;
      seen.add(model.url);
      if (!keys.has(model.url + 'tensor-cache.json')) continue;
      const stored = await cache.match(model.url + 'tensor-cache.json');
      if (!stored) continue;
      const { present, records } = await storedShards(model, keys, await stored.json());
      if (!present.length) continue;
      models.push({
        id: model.id,
        base: model.base,
        url: model.url,
        bytes: present.reduce((sum, record) => sum + record.nbytes, 0),
        complete: present.length === records.length,
      });
    }
    return { models, usage: estimate.usage ?? null, quota: estimate.quota ?? null };
  }

  async function removeDownload(id) {
    const model = catalog?.models.find((record) => record.id === id);
    if (!model) throw new Error(`Unknown browser model: ${id}`);
    const current = catalog.models.find((record) => record.id === selectedId);
    if (current && current.url === model.url) await unload();
    if (typeof caches === 'undefined') return;
    for (const name of [MODEL_CACHE, 'webllm/config']) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (request.url.startsWith(model.url)) await cache.delete(request);
      }
    }
    const wasm = await caches.open('webllm/wasm');
    for (const lib of new Set(catalog.models.filter((record) => record.url === model.url).map((record) => record.lib))) {
      await wasm.delete(lib);
    }
  }

  async function ensureSpace(model) {
    if (!navigator.storage?.estimate) return;
    const { present, records } = await storedShards(model, await cachedUrls(), await readJson(model.url + 'tensor-cache.json'));
    const stored = new Set(present);
    const need = records.filter((record) => !stored.has(record)).reduce((sum, record) => sum + record.nbytes, 0);
    const { usage, quota } = await navigator.storage.estimate();
    if (need > quota - usage) {
      const size = window.TalkModelsCore.formatBytes;
      throw new Error(`Not enough browser storage: ${model.base} needs ${size(need)}, ${size(Math.max(quota - usage, 0))} free`);
    }
  }

  function keepDownloads() {
    if (persistRequested || !navigator.storage?.persist) return;
    persistRequested = true;
    // Best effort: without it the browser may evict the weights under disk pressure, and the next pick re-downloads.
    navigator.storage.persist().catch((error) => console.warn('Persistent storage request failed', error));
  }

  function enqueueSelection(action) {
    const selection = selectionQueue.then(action);
    selectionQueue = selection.then(() => undefined, () => undefined);
    return selection;
  }

  async function unloadNow() {
    const loaded = engine;
    const currentWorker = worker;
    engine = null;
    worker = null;
    selectedId = null;
    selectedContextWindow = null;
    if (!loaded) {
      if (currentWorker) currentWorker.terminate();
      return;
    }
    try {
      await loaded.unload();
    } finally {
      if (currentWorker) currentWorker.terminate();
    }
  }

  function unload() {
    return enqueueSelection(unloadNow);
  }

  function select(id, onProgress = () => {}) {
    return enqueueSelection(async () => {
      const model = catalog?.models.find((record) => record.id === id);
      if (!model) throw new Error(`Unknown browser model: ${id}`);
      if (selectedId === id && engine) return;
      await ensureSpace(model);
      selectedContextWindow = model.contextWindow;
      if (!engine) {
        const { CreateWebWorkerMLCEngine } = await import(`/webllm/${catalog.bundle}/engine.js`);
        const nextWorker = new Worker(`/webllm/${catalog.bundle}/worker.js`, { type: 'module' });
        try {
          engine = await CreateWebWorkerMLCEngine(nextWorker, id, {
            initProgressCallback: (progress) => onProgress(progress.progress, progress.text),
          });
          worker = nextWorker;
          selectedId = id;
          keepDownloads();
        } catch (error) {
          nextWorker.terminate();
          throw error;
        }
        return;
      }
      if (selectedId !== id) await engine.reload(id);
      selectedId = id;
    });
  }

  async function reply(messages, signal) {
    if (!engine) throw new Error('No browser model is selected');
    const interrupt = () => engine.interruptGenerate();
    if (signal?.aborted) {
      interrupt();
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    else signal?.addEventListener('abort', interrupt, { once: true });
    try {
      const response = await engine.chat.completions.create({
        messages: [
          { role: 'system', content: window.TalkModelsCore.TALK_BRIEF },
          ...window.TalkModelsCore.trimHistory(messages, selectedContextWindow),
        ],
        stream: false,
        extra_body: { enable_thinking: false },
      });
      const content = response.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('Browser model returned a non-string reply');
      const cleaned = window.TalkModelsCore.cleanReply(content);
      if (!cleaned) throw new Error('The browser model gave an empty reply. Please try again.');
      return cleaned;
    } finally {
      signal?.removeEventListener('abort', interrupt);
    }
  }

  window.TalkModels = { prepareMenu, select, reply, unload, downloads, removeDownload };
})();
