import React, { useEffect, useRef, useState } from 'react';

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
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [userActivatedAudio, setUserActivatedAudio] = useState(false);
  const rafRef = useRef(null);
  const historyRef = useRef([]); // rolling raw score history
  const stableRef = useRef(null); // last stable spoken score
  const consecutiveStableRef = useRef(0);

  // Delayed camera start until first interaction for better autoplay / speech compatibility
  useEffect(() => {
    // Autostart camera but handle failures gracefully
    startCamera();
    return () => stopCamera();
  }, []);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setRunning(true);
      }
    } catch (err) {
      console.error('camera error', err);
      setPermissionError(err.message || String(err));
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      videoRef.current.srcObject.getTracks().forEach(t => t.stop());
    }
    cancelAnimationFrame(rafRef.current);
  };

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
      <div className="w-full max-w-5xl bg-white/5 rounded-2xl shadow-xl overflow-hidden border border-white/10">
        <div className="flex flex-col md:flex-row">
          <div className="relative md:w-1/2">
            <div className="absolute top-3 left-3 z-20 bg-black/40 px-3 py-1 rounded-md text-sm">Live Scan</div>
            <video
              ref={videoRef}
              className="w-full aspect-[3/4] md:aspect-auto md:h-full object-cover bg-black max-h-[70vh]"
              playsInline
              muted
            />
            <canvas ref={canvasRef} className="hidden" />
            <div className="absolute bottom-3 left-3 z-20 flex flex-wrap gap-2">
              <button
                onClick={toggleVoice}
                className="bg-white/10 px-3 py-1 rounded-md text-sm backdrop-blur"
              >
                {voiceEnabled ? 'Voice: On' : 'Voice: Off'}
              </button>
              <button onClick={takeSnapshot} className="bg-white/10 px-3 py-1 rounded-md text-sm">
                Snapshot
              </button>
            </div>
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
                <div className="bg-white/10 p-4 rounded-lg min-h-[120px]">
                  <strong className="block mb-1">{score !== null ? `Health score: ${score}/10` : 'Scanning...'}</strong>
                  <div className="text-xs opacity-80 mb-2">Confidence: {confidence}% • Updated: {lastUpdate ?? '–'}</div>
                  <div className="grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <div className="text-sm font-semibold mb-1">Pros</div>
                      <ul className="space-y-1">
                        {pros.map((p,i)=>(<li key={i}>✅ {p}</li>))}
                      </ul>
                    </div>
                    <div>
                      <div className="text-sm font-semibold mb-1">Cons</div>
                      <ul className="space-y-1">
                        {cons.map((c,i)=>(<li key={i}>⚠️ {c}</li>))}
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
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
