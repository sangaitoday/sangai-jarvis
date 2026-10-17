# SangAI Javis

SangAI Javis is the open-source, browser-only edition of the [www.sangai.today](https://www.sangai.today) voice interface. It keeps the exact `www.sangai.today` UI, 2D/3D reactive orb, on-device WebLLM model picker, and local ONNX (Piper, Supertonic 3, Kokoro) + browser voice synthesis, with all cloud model routers, Live call mode, and server `.env` dependencies removed.

## Run locally

Requirements: Node.js, npm, `curl`, `sha256sum`, and a recent browser with WebGPU. Microphone use requires `localhost` or HTTPS.

```sh
npm run assets
npm test
npm start
```

Open <http://127.0.0.1:8080>. `npm run assets` builds the WebLLM and ONNX runtime bundles and downloads the two default Piper voices under `public/` (gitignored). `npm start` runs the zero-dependency static server (`server.js`) with no `.env` required, or you can serve `public/` from any static host.

## Models and voices

- **On-device models (`On this device`)**: 159 WebLLM model variants (65 model families), filtered and ranked automatically for your GPU and memory. Weights download from Hugging Face into your browser cache on first use and can be deleted anytime from the `Models` tab.
- **Local ONNX & browser voices (`Voice`)**: 162 downloadable ONNX voices across Piper, Supertonic 3 (WebGPU), and Kokoro, plus your browser's built-in `speechSynthesis` voices, with search, grouping, preview, and one-click batch download/delete.
- **Push-to-talk & Hands-free**: Uses your browser's `SpeechRecognition` (including on-device `processLocally` where supported), falling back to text input when speech recognition is unavailable.

## License

MIT License — see [LICENSE](LICENSE). Third-party model icon notices are in `public/vendor/model-icons/NOTICE.md`.
