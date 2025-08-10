import React, { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';

/**
 * Product Health Scanner - React PWA Demo
 * --------------------------------------
 * Single-file React component demo (export default App)
 * - Uses the device camera (getUserMedia) to stream video
 * - Grabs frames and runs a lightweight 'health heuristic' analysis
 *   (average green channel) to produce a live health score (1-10)
 * - Announces the score using Web Speech (SpeechSynthesis)
 * - Displays an animated UI with score, pros, cons; updates live
 * - Optional barcode scanning mode (ZXing) for future nutrition lookup
/* Product Health Scanner
 * Camera-based heuristic scoring UI (client-only)
 * Re-Engineered by Siddhant Wadhwani
 */

// Helper: map 0..1 to 1..10
const greenToScore = (g) => {
  const s = Math.round(Math.min(1, Math.max(0, g)) * 9) + 1; // 1..10
  return s;
};

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [permissionError, setPermissionError] = useState(null);
  const [running, setRunning] = useState(false);
  const [score, setScore] = useState(null);
  const [pros, setPros] = useState([]);
  const [cons, setCons] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [confidence, setConfidence] = useState(0);
  const [announceOnChange, setAnnounceOnChange] = useState(true);
  const [barcodeMode, setBarcodeMode] = useState(false);
  const [barcode, setBarcode] = useState(null);
  const [networkOnline, setNetworkOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const rafRef = useRef(null);
  const barcodeReaderRef = useRef(null);

  // Delayed camera start until first interaction for better autoplay / speech compatibility
  useEffect(() => {
    let mounted = true;
    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (!mounted) return;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setRunning(true);
        }
      } catch (err) {
        console.error('camera error', err);
        setPermissionError(err.message || String(err));
      }
    }
    startCamera();
    return () => {
      mounted = false;
      // stop tracks
      if (videoRef.current && videoRef.current.srcObject) {
        const tracks = videoRef.current.srcObject.getTracks();
        tracks.forEach((t) => t.stop());
      }
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Network status listener
  useEffect(() => {
    const onOnline = () => setNetworkOnline(true);
    const onOffline = () => setNetworkOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Barcode scanning effect
  useEffect(() => {
    if (!barcodeMode) {
      if (barcodeReaderRef.current) {
        try { barcodeReaderRef.current.reset(); } catch (_) {}
      }
      return;
    }
    const start = async () => {
      try {
        const reader = new BrowserMultiFormatReader();
        barcodeReaderRef.current = reader;
        // Using video element ID for convenience
        await reader.decodeFromVideoDevice(null, 'camera-feed', (result, err, controls) => {
          if (result) {
            const text = result.getText();
            setBarcode(text);
          }
        });
      } catch (e) {
        console.warn('Barcode init failed', e);
      }
    };
    start();
    return () => {
      try { barcodeReaderRef.current?.reset(); } catch (_) {}
    };
  }, [barcodeMode]);

  // Core loop
  useEffect(() => {
    let last = 0;
    const interval = 400; // slower sampling to reduce fluctuations

    const step = (timestamp) => {
      if (!videoRef.current || videoRef.current.readyState < 2) {
        rafRef.current = requestAnimationFrame(step);
        return;
      }
      if (timestamp - last >= interval) {
        last = timestamp;
        captureAndAnalyze();
      }
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const captureAndAnalyze = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    // Use full frame for better signal (previously cropped center)
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, w, h, 0, 0, w, h);

    const sampleScale = 0.5; // downscale for performance
    const sw = Math.max(1, Math.floor(w * sampleScale));
    const sh = Math.max(1, Math.floor(h * sampleScale));
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = sw;
    tempCanvas.height = sh;
    const tctx = tempCanvas.getContext('2d');
    tctx.drawImage(canvas, 0, 0, w, h, 0, 0, sw, sh);
    const img = tctx.getImageData(0, 0, sw, sh);
    const { data } = img;

    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    const stepPix = 4 * 4; // every 4th pixel now (denser sampling)
    for (let i = 0; i < data.length; i += stepPix) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
      count++;
    }
    const rAvg = rSum / count / 255;
    const gAvg = gSum / count / 255;
    const bAvg = bSum / count / 255;

    // Improved raw score emphasizing green balance but penalizing oversaturation + red dominance
    const greenDominance = gAvg / (rAvg + gAvg + bAvg + 1e-6); // 0..1
    const balancePenalty = Math.abs(rAvg - bAvg) * 0.15; // encourage balanced non-green channels
    const rawScore = Math.max(0, greenDominance - balancePenalty);

    // Push into rolling history
    const hist = historyRef.current;
    hist.push(rawScore);
    if (hist.length > 15) hist.shift();

    // Compute smoothed score (median of last N for robustness)
    const sorted = [...hist].sort((a,b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mapped = greenToScore(median);

    // Confidence: combine green dominance distance from neutral (1/3) + chroma variance + history length
    const neutral = 1/3;
    const dominanceComponent = Math.min(1, Math.abs(greenDominance - neutral) * 2.2);
    const chroma = Math.sqrt(((rAvg - gAvg) ** 2 + (gAvg - bAvg) ** 2 + (rAvg - bAvg) ** 2) / 3);
    const chromaComponent = Math.min(1, chroma * 1.8);
    const stability = 1 - (sorted[sorted.length - 1] - sorted[0]); // narrower range => closer to 1
    const stabilityComponent = Math.max(0, Math.min(1, stability));
    let conf = (dominanceComponent * 0.45 + chromaComponent * 0.25 + stabilityComponent * 0.30);
    // Boost once we have enough samples
    if (hist.length >= 10) conf = Math.min(1, conf + 0.1);
    // Floor + scale
    conf = Math.max(0.3, conf);

    const { pros: newPros, cons: newCons } = describeFromScore(mapped, conf);

    // Stable update logic: require persistence of change
    setScore(prev => {
      if (prev === null || Math.abs(mapped - prev) >= 1) {
        // track persistence
        if (stableRef.current === mapped) {
          consecutiveStableRef.current += 1;
        } else {
          stableRef.current = mapped;
          consecutiveStableRef.current = 1;
        }
        if (voiceEnabled && userActivatedAudio && consecutiveStableRef.current >= 2 && mapped !== prev) {
          speakScore(mapped);
        }
        return mapped;
      } else {
        // no big change; keep existing
        return prev;
      }
    });

    setPros(newPros);
    setCons(newCons);
    setLastUpdate(new Date().toLocaleTimeString());
    setConfidence(Math.round(conf * 100));
  };

  const describeFromScore = (s, conf) => {
    const pros = [];
    const cons = [];
    if (s >= 8) {
      pros.push('High natural indicators');
      pros.push('Low visible processing');
      cons.push('Perishable — ensure proper storage');
    } else if (s >= 6) {
      pros.push('Generally balanced visual profile');
      pros.push('Some natural components evident');
      cons.push('Possible added ingredients');
    } else if (s >= 4) {
      pros.push('Contains mixed indicators');
      cons.push('Signs of processing or additives');
      cons.push('Review packaging details');
    } else {
      pros.push('Convenient option');
      cons.push('Likely processed');
      cons.push('Check sugar / sodium / fats');
    }
    if (conf * 100 < 50) cons.push('Low visual confidence — move closer / adjust lighting');
    return { pros, cons };
  };

  const speakScore = (s) => {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      synth.cancel();
      const utter = new SpeechSynthesisUtterance(`Health score ${s} out of 10`);
      utter.rate = 1;
      utter.pitch = 1;
      utter.volume = 1;
      synth.speak(utter);
    } catch (e) {
      console.warn('TTS failed', e);
    }
  };
  const speakText = (t) => {
    try {
      const synth = window.speechSynthesis; if (!synth) return;
      const utter = new SpeechSynthesisUtterance(t); synth.cancel(); synth.speak(utter);
    } catch (_) {}
  };

  // UI helpers
  const formatPros = (items) => items.map((p, i) => <li key={i}>✅ {p}</li>);
  const formatCons = (items) => items.map((c, i) => <li key={i}>⚠️ {c}</li>);

  // Manual SNAPSHOT save
  const takeSnapshot = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `snapshot-${Date.now()}.png`;
    link.click();
  };

  const toggleVoice = () => {
    setVoiceEnabled(v => !v);
    if (!userActivatedAudio) setUserActivatedAudio(true); // first user interaction unlocks speech
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-indigo-900 text-white flex flex-col items-center p-4">
      {/* Accessibility live region for score updates */}
      <div className="sr-only" aria-live="polite">{score !== null ? `Health score ${score} out of 10` : 'Scanning'}</div>
      {/* Network status banner */}
      {!networkOnline && (
        <div className="fixed top-2 right-2 bg-red-600/80 px-3 py-1 rounded text-xs shadow">Offline mode (cached)</div>
      )}
      <div className="w-full max-w-3xl bg-white/5 rounded-2xl shadow-xl overflow-hidden border border-white/10">
        <div className="flex flex-col md:flex-row">
          <div className="relative md:w-1/2">
            <div className="absolute top-3 left-3 z-20 bg-black/40 p-2 rounded-md text-sm">Live Camera</div>
            <video id="camera-feed" ref={videoRef} className="w-full h-72 object-cover bg-black" playsInline muted />
            <canvas ref={canvasRef} className="hidden" />
            <div className="absolute bottom-3 left-3 z-20 flex gap-2 flex-wrap pr-3">
              <button
                onClick={toggleVoice}
                className="bg-white/10 px-3 py-1 rounded-md text-sm backdrop-blur"
              >
                {voiceEnabled ? 'Voice: On' : 'Voice: Off'}
              </button>
              <button onClick={takeSnapshot} className="bg-white/10 px-3 py-1 rounded-md text-sm">
                Snapshot
              </button>
              <button
                onClick={() => setBarcodeMode((m) => !m)}
                className={`px-3 py-1 rounded-md text-sm ${barcodeMode ? 'bg-indigo-600' : 'bg-white/10'}`}
              >
                {barcodeMode ? 'Stop Barcode' : 'Scan Barcode'}
              </button>
            </div>
            {barcode && (
              <div className="absolute top-3 right-3 bg-black/60 rounded p-2 text-[10px] max-w-[140px] break-words">
                <div className="font-semibold mb-1">Barcode</div>
                <div>{barcode}</div>
              </div>
            )}
          </div>

          <div className="md:w-1/2 p-6 flex flex-col">
            <h1 className="text-2xl font-bold mb-1">Product Health Scanner</h1>
            <p className="text-sm opacity-80 mb-4">Point the camera at a product. A stabilized health score updates live.</p>

            <div className="flex items-center gap-4 mb-5">
              <div
                className="w-32 h-32 rounded-full bg-white/5 flex items-center justify-center text-4xl font-bold transition-colors"
                aria-live="polite"
              >
                {score ?? '--'}
              </div>

              <div className="flex-1">
                <div className="mb-2">Live description (animated)</div>
                <div className="bg-white/6 p-3 rounded-lg min-h-[72px]">
                  <div className={`transition-all duration-500 ease-out ${score >= 8 ? 'translate-x-0' : ''}`}>
                    <strong className="block">{score !== null ? `Health score: ${score}/10` : 'Scanning...'}</strong>
                    <div className="text-xs opacity-80">Confidence: {confidence}% • last: {lastUpdate ?? '–'}</div>
                    {barcode && (
                      <div className="mt-1 text-[10px] opacity-70">Detected barcode: {barcode}</div>
                    )}
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div>
                        <div className="text-sm font-semibold">Pros</div>
                        <ul className="text-xs mt-1 space-y-1">{formatPros(pros)}</ul>
                      </div>
                      <div>
                        <div className="text-sm font-semibold">Cons</div>
                        <ul className="text-xs mt-1 space-y-1">{formatCons(cons)}</ul>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-3 text-sm opacity-80">
              <div className="mb-1">How it works (demo):</div>
              <ul className="list-disc pl-5 space-y-1">
                <li>Camera frames are analyzed in-browser using a green-channel heuristic (demo only).</li>
                <li>For production, replace analysis with OpenAI Vision model backend call to get richer insights.</li>
                <li>Use server-side TTS / ChatGPT Voice streaming to produce natural voice output.</li>
                <li>Optional barcode scan (ZXing) to link with nutrition databases (future).</li>
              </ul>
            </div>

            <div className="mt-6 flex gap-3 flex-wrap">
              <button
                onClick={() => alert('Replace with API integration: send canvas image to backend -> call OpenAI Vision')}
                className="bg-indigo-600 px-4 py-2 rounded-md"
              >
                Integrate Vision API
              </button>

              <button
                onClick={() => alert('Advanced features: barcode scan, nutrition DB lookup, allergies, compare price')}
                className="bg-white/6 px-4 py-2 rounded-md"
              >
                Show Enhancements
              </button>
            </div>

            {permissionError && (
              <div className="mt-2 text-red-400 text-sm">Camera error: {permissionError}</div>
            )}

            <div className="mt-auto text-[10px] tracking-wider text-white/30">© {new Date().getFullYear()}</div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mt-6 text-xs text-white/60 text-center">
        For best results: ensure steady framing, diffuse lighting, and move closer if confidence is low.
      </div>
    </div>
  );
}
