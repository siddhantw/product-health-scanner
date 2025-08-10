import React, { useEffect, useRef, useState } from 'react';

/**
 * Product Health Scanner - React PWA Demo
 * --------------------------------------
 * Single-file React component demo (export default App)
 * - Uses the device camera (getUserMedia) to stream video
 * - Grabs frames and runs a lightweight 'health heuristic' analysis
 *   (average green channel) to produce a live health score (1-10)
 * - Announces the score using Web Speech (SpeechSynthesis)
 * - Displays an animated UI with score, pros, cons; updates live
 *
 * Notes on real integrations:
 * - Replace `analyzeFrame` with a backend call to OpenAI's Vision model
 *   (send the frame image bytes, receive structured JSON: {score, pros, cons})
 * - For "ChatGPT Voice" playback you can either stream TTS from an API
 *   (if available), or continue using browser SpeechSynthesis for demoing.
 * - Add authentication, rate-limiting, and privacy handling when sending images.
 */

// Simple helper: map 0..1 to 1..10
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
  const rafRef = useRef(null);

  // Start camera
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

  // Core loop: draw video to hidden canvas and analyze every N ms
  useEffect(() => {
    let last = 0;
    const interval = 300; // ms between analyses (update faster for higher responsiveness)

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

  // Capture current frame and run a lightweight analysis
  const captureAndAnalyze = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // draw a smaller area centered for speed
    const sx = Math.floor(w * 0.25);
    const sy = Math.floor(h * 0.25);
    const sw = Math.floor(w * 0.5);
    const sh = Math.floor(h * 0.5);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

    // Get pixel data and compute simple "health" heuristic
    const img = ctx.getImageData(0, 0, sw, sh);
    const { data } = img;
    let rSum = 0,
      gSum = 0,
      bSum = 0,
      count = 0;
    // sample pixels to speed up
    const step = 4 * 6; // every 6th pixel
    for (let i = 0; i < data.length; i += step) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
      count++;
    }
    const rAvg = rSum / count / 255;
    const gAvg = gSum / count / 255;
    const bAvg = bSum / count / 255;

    // Heuristic: greener products (fresh produce, plants, vegetables) => healthier.
    // Also reduce score if image is very processed-looking (high red/b channel ratio or high saturation)
    const greenBias = gAvg;
    const redPenalty = Math.max(0, rAvg - gAvg) * 0.5;
    const bluePenalty = Math.max(0, bAvg - gAvg) * 0.2;
    const rawScore = Math.max(0, greenBias - redPenalty - bluePenalty);
    const mapped = greenToScore(rawScore);

    // Confidence: how strongly green dominates
    const conf = Math.min(1, Math.abs(gAvg - (rAvg + bAvg) / 2) * 2);

    // Build pros/cons using simple rule-based descriptions
    const { pros: newPros, cons: newCons } = describeFromScore(mapped);

    // Update state only when significant change to reduce chatter
    setScore((prev) => {
      if (prev === null || Math.abs(mapped - prev) >= 1) {
        if (announceOnChange) speakScore(mapped);
      }
      return mapped;
    });
    setPros(newPros);
    setCons(newCons);
    setLastUpdate(new Date().toLocaleTimeString());
    setConfidence(Math.round(conf * 100));

    // --- for real integration: you could send `canvas.toDataURL()` to your backend here ---
    // Example payload: { image_base64: canvas.toDataURL('image/jpeg', 0.7) }
  };

  // Turn the numeric score into pros & cons
  const describeFromScore = (s) => {
    const pros = [];
    const cons = [];
    if (s >= 8) {
      pros.push('High fresh/plant-based content');
      pros.push('Low visible processing or additives');
      cons.push('May be perishable — check storage');
    } else if (s >= 6) {
      pros.push('Moderately healthy choice');
      pros.push('Likely contains real ingredients');
      cons.push('May include added sugars or oils');
    } else if (s >= 4) {
      pros.push('May contain some natural ingredients');
      cons.push('Visible signs of processing or colouring');
      cons.push('Check labels for additives');
    } else {
      pros.push('Convenient or tasty option');
      cons.push('Likely highly processed');
      cons.push('Higher sugar/sodium/fats possible');
    }

    // Add nuance based on confidence
    if (confidence < 30) {
      cons.push('Low visual confidence — move camera closer');
    }
    return { pros, cons };
  };

  // Voice announce the score using Web Speech API
  const speakScore = (s) => {
    const text = `Health score ${s} out of 10`;
    // Prefer server-side TTS if you want ChatGPT Voice — this is a browser fallback demo
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      // cancel previous
      synth.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      // voice selection - keep default for compatibility
      utter.rate = 1.0;
      utter.pitch = 1.0;
      synth.speak(utter);
    } catch (e) {
      console.warn('TTS failed', e);
    }
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-indigo-900 text-white flex flex-col items-center p-4">
      <div className="w-full max-w-3xl bg-white/5 rounded-2xl shadow-xl overflow-hidden border border-white/10">
        <div className="flex flex-col md:flex-row">
          <div className="relative md:w-1/2">
            <div className="absolute top-3 left-3 z-20 bg-black/40 p-2 rounded-md text-sm">Live Camera</div>
            <video ref={videoRef} className="w-full h-72 object-cover bg-black" playsInline muted />
            <canvas ref={canvasRef} className="hidden" />
            <div className="absolute bottom-3 left-3 z-20 flex gap-2">
              <button
                onClick={() => setAnnounceOnChange((v) => !v)}
                className="bg-white/10 px-3 py-1 rounded-md text-sm backdrop-blur"
              >
                {announceOnChange ? 'Voice: On' : 'Voice: Off'}
              </button>
              <button onClick={takeSnapshot} className="bg-white/10 px-3 py-1 rounded-md text-sm">
                Snapshot
              </button>
            </div>
          </div>

          <div className="md:w-1/2 p-6">
            <h2 className="text-2xl font-bold mb-1">Product Health Scanner</h2>
            <div className="text-xs mb-3 opacity-70">Re-Engineered by Siddhant Wadhwani</div>
            <p className="text-sm opacity-80 mb-4">Point your camera at a product. Health score updates live.</p>

            <div className="flex items-center gap-4 mb-4">
              <div className="w-28 h-28 rounded-full bg-white/5 flex items-center justify-center text-4xl font-bold animate-pulse">
                {score ?? '--'}
              </div>

              <div className="flex-1">
                <div className="mb-2">Live description (animated)</div>
                <div className="bg-white/6 p-3 rounded-lg min-h-[72px]">
                  <div className={`transition-all duration-500 ease-out ${score >= 8 ? 'translate-x-0' : ''}`}>
                    <strong className="block">{score !== null ? `Health score: ${score}/10` : 'Scanning...'}</strong>
                    <div className="text-xs opacity-80">Confidence: {confidence}% • last: {lastUpdate ?? '–'}</div>
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
              </ul>
            </div>

            <div className="mt-6 flex gap-3">
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
              <div className="mt-4 text-red-400">Camera error: {permissionError}</div>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-3xl mt-6 text-xs text-white/60">
        Tip: For improved results, point the camera at the product label and get closer to capture details. This demo uses visual heuristics — integrate a vision model for reliable results.
      </div>
      <div className="mt-4 text-[10px] uppercase tracking-wider text-white/30">Re-Engineered by Siddhant Wadhwani</div>
    </div>
  );
}
