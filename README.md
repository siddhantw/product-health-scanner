# Product Health Scanner (PWA Demo)
Re-Engineered by **Siddhant Wadhwani**

A lightweight React + Vite Progressive Web App that uses the device camera to estimate a simple "health score" (1–10) from live video, based on a green-channel heuristic. Demonstrates how you could later plug in a real Vision + LLM backend for richer nutrition and product insights.

## Features
- Live camera streaming (getUserMedia)
- Frame sampling + simple heuristic scoring (green bias)
- Dynamic pros / cons + confidence metric
- SpeechSynthesis voice announcements (toggle)
- Snapshot download
- Tailwind CSS UI + responsive layout
- Installable PWA (manifest included)
- Offline caching + network status indicator
- Optional barcode scanning mode (ZXing) (future nutrition DB link)
- Accessibility: ARIA live region for score

## Tech Stack
- React 18 + Vite
- Tailwind CSS
- Browser APIs: MediaDevices, Canvas, SpeechSynthesis
- ZXing for barcode (optional toggle)
- Netlify (deployment) + Functions scaffold (future API integration)

## Quick Start
```bash
npm install
npm run dev
```
Open: http://localhost:5173

Grant camera permission when prompted.

## Production Build
```bash
npm run build
npm run preview
```
Outputs to `dist/`.

## Deploy to Netlify
Option A: UI
1. Push repo to GitHub.
2. In Netlify dashboard: New Site → Import from Git → select repo.
3. Build command: `npm run build`  Publish directory: `dist`
4. Deploy.

Option B: CLI
```bash
npm install -g netlify-cli
netlify login
netlify init   # (build: npm run build, publish: dist)
netlify deploy --prod
```

## PWA Notes
- `manifest.webmanifest` is referenced in `index.html`.
- Add/replace icons (`/icon-192.png`, `/icon-512.png`) as needed.
- Offline page `offline.html` served when navigation fails.

## Service Worker
Implements cache-first for app shell + runtime caching for same-origin GET requests, with offline fallback for navigations.

## Vision / AI Integration (Future)
Replace the heuristic in `captureAndAnalyze` with an API call:
1. Convert canvas to blob / base64.
2. POST to backend (Netlify Function) that calls a Vision + LLM model.
3. Return JSON: `{ score, pros, cons, confidence, barcode }`.
4. Update state; optionally stream partial results.

Example (pseudo):
```js
const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.7));
const formData = new FormData();
formData.append('image', blob, 'frame.jpg');
if (barcode) formData.append('barcode', barcode);
const resp = await fetch('/api/analyze', { method: 'POST', body: formData });
const data = await resp.json();
```

### Netlify Function Scaffold
A placeholder function exists in `netlify/functions/analyze.js`.
Environment variable needed (create `.env`):
```
OPENAI_API_KEY=sk-... (or provider key)
```
Access in function via `process.env.OPENAI_API_KEY`.

## Environment Variables
Create a `.env` (NOT committed) based on `.env.example`:
```
OPENAI_API_KEY=sk-...your real key...
```
Netlify: Site settings > Build & deploy > Environment > Add variable.

The frontend never exposes this key; only the Netlify Function uses it.

## Environment / Permissions
- Requires HTTPS (or localhost) for camera.
- Safari may require first user interaction before speech.

## Accessibility
- Live score announced via ARIA live region (screen reader friendly).
- Toggle voice for users preferring audible feedback.

## Security / Privacy Considerations (Real Build)
- Avoid sending raw frames unless needed.
- Blur / crop sensitive areas client-side first.
- Rate limit API usage.
- Provide user consent + policy disclosures.

## Enhancements Roadmap
- Nutrition database lookup (USDA / OpenFoodFacts)
- User dietary preferences & allergen filters
- Comparison mode (multiple products)
- Offline caching of last results
- Streaming TTS via server
- Persistent history (IndexedDB)

## License
Demo purpose only. Adapt as needed.

---
Re-Engineered by Siddhant Wadhwani
