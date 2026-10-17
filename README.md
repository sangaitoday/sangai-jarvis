# Javis

Javis is a static, browser-only voice chat app. Text generation uses WebLLM and a Qwen3 model on the visitor's GPU. It offers push-to-talk and hands-free microphone modes, browser voices, and downloadable Piper voices. There is no chat API, account, telemetry, or server-side inference.

## Run locally

Requirements: Node.js, npm, Python 3, and a recent browser with WebGPU. Microphone use requires localhost or HTTPS. The asset build also needs `curl` and `sha256sum`.

```sh
npm run assets
npm test
npm run dev
```

Open <http://localhost:8080>. The build writes generated WebLLM and Piper runtime files and two Piper voices under `public/`; they are ignored by Git. A static host can serve the `public/` directory after the same build. No API service is needed.

Choose one of the offered models. Its weights download from Hugging Face on first use and are cached by the browser. The downloadable voice files are served from the static site after `npm run assets`; selecting one loads it in the browser. The app supports English and Vietnamese downloadable voices. Device memory and GPU support determine which models appear.

## Voice and privacy

Model replies run in the browser. Piper synthesis runs in the browser after its voice files load. The browser's own `SpeechRecognition` and `speechSynthesis` features depend on the browser and operating system; they may use an online service. If recognition is unavailable, typed chat still works. Hands-free pauses recognition during generation and speech to avoid feeding the answer back into the microphone.

The app does not upload chat messages to a Javis server. Initial model and voice downloads contact their respective hosts. Browser speech services may transmit audio or text according to the browser's implementation.

## Source and third-party components

Javis source code is MIT licensed; see [LICENSE](LICENSE). The asset builders pin WebLLM 0.2.85, Piper TTS Web 1.0.5, ONNX Runtime Web 1.18.0, Piper WASM 1.0.0, and esbuild 0.25.5. Their licenses remain their own. WebLLM is [Apache-2.0](https://github.com/mlc-ai/web-llm/blob/main/LICENSE); Qwen3-0.6B and Qwen3-1.7B are provided by [Qwen](https://huggingface.co/Qwen) under their model licenses. Piper voice metadata and files are downloaded from the pinned [Piper voices](https://huggingface.co/diffusionstudio/piper-voices) revision in `scripts/build-piper.sh`. Review each voice's metadata before redistributing the generated files.

This public app contains no private site backend, cloud model router, Live call mode, Slack integration, or operator interface.
