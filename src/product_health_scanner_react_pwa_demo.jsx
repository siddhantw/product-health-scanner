import React, { useEffect, useRef, useState, useCallback } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';

/* Product Health Scanner
 * Camera-based heuristic scoring UI (client-only)
 * Re-Engineered by Siddhant Wadhwani
 */

// Helper: map 0..1 to 1..10
const greenToScore = (g) => {
  const s = Math.round(Math.min(1, Math.max(0, g)) * 9) + 1; // 1..10
  return s;
};

// Robust median utility
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  return s[Math.floor(s.length/2)];
};

// Trimmed mean utility (exclude extremes for stability)
const trimmedMean = (arr, trim=0.1) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  const k = Math.floor(s.length * trim);
  const trimmed = s.slice(k, s.length - k || undefined);
  return trimmed.reduce((a,c)=>a+c,0)/trimmed.length;
};

// Hook: image analysis & scoring
function useHealthAnalyzer() {
  const historyRef = useRef([]);
  const brightnessHistoryRef = useRef([]);
  const varianceHistoryRef = useRef([]);

  const analyzeImageData = useCallback((imageData) => {
    const { data, width, height } = imageData;
    if (!width || !height) return null;
    let rSum=0,gSum=0,bSum=0,count=0;
    const stepPix = 4 * 4;
    for (let i=0;i<data.length;i+=stepPix){
      rSum+=data[i]; gSum+=data[i+1]; bSum+=data[i+2]; count++;}
    const rAvg = rSum/count/255; const gAvg = gSum/count/255; const bAvg = bSum/count/255;
    const luminance = 0.2126*rAvg + 0.7152*gAvg + 0.0722*bAvg;
    // variance sample
    let lSum=0,lSq=0,n=0;
    for (let i=0;i<data.length;i+=stepPix*12){
      const r=data[i]/255,g=data[i+1]/255,b=data[i+2]/255; const lum=0.2126*r+0.7152*g+0.0722*b; lSum+=lum; lSq+=lum*lum; n++;}
    const meanL = lSum/Math.max(1,n);
    const variance = Math.max(0,(lSq/Math.max(1,n)) - meanL*meanL);

    brightnessHistoryRef.current.push(luminance);
    if (brightnessHistoryRef.current.length>30) brightnessHistoryRef.current.shift();
    varianceHistoryRef.current.push(variance);
    if (varianceHistoryRef.current.length>30) varianceHistoryRef.current.shift();

    const avgBrightness = trimmedMean(brightnessHistoryRef.current,0.15);
    const avgVariance = trimmedMean(varianceHistoryRef.current,0.15);
    let lightingState='OK';
    if (avgBrightness < 0.12) lightingState='Too Dark'; else if (avgBrightness>0.85) lightingState='Too Bright'; else if (avgVariance<0.002) lightingState='Low Texture';

    const greenDominance = gAvg/(rAvg+gAvg+bAvg+1e-6);
    const balancePenalty = Math.abs(rAvg-bAvg)*0.15;
    let rawScore = Math.max(0, greenDominance - balancePenalty);

    const hist = historyRef.current; hist.push(rawScore); if (hist.length>25) hist.shift();
    if (['Too Dark','Too Bright','Low Texture'].includes(lightingState) && hist.length){
      const prevMed = median(hist); rawScore = prevMed*0.7 + rawScore*0.3; hist[hist.length-1]=rawScore; }

    const sorted=[...hist].sort((a,b)=>a-b); const med=sorted[Math.floor(sorted.length/2)];
    const iqr = sorted[Math.floor(sorted.length*0.75)] - sorted[Math.floor(sorted.length*0.25)] || 1e-6;
    const filtered = hist.filter(v=> v>= med-1.5*iqr && v<= med+1.5*iqr);
    const smoothed = median(filtered.length?filtered:hist);
    const mapped = greenToScore(smoothed);

    const neutral = 1/3;
    const dominanceComponent = Math.min(1, Math.abs(greenDominance-neutral)*2.2);
    const chroma = Math.sqrt(((rAvg-gAvg)**2 + (gAvg-bAvg)**2 + (rAvg-bAvg)**2)/3);
    const chromaComponent = Math.min(1, chroma*1.8);
    const stability = 1 - (sorted[sorted.length-1]-sorted[0]);
    const stabilityComponent = Math.max(0, Math.min(1, stability));
    let conf = dominanceComponent*0.45 + chromaComponent*0.25 + stabilityComponent*0.30;
    if (hist.length>=10) conf = Math.min(1, conf+0.1);
    if (lightingState!=='OK') conf*=0.7; if (avgVariance<0.002) conf*=0.75; conf = Math.max(0.2, Math.min(1, conf));

    const warnings=[]; if (lightingState==='Too Dark') warnings.push('Increase lighting'); if (lightingState==='Too Bright') warnings.push('Reduce glare'); if (lightingState==='Low Texture') warnings.push('Move closer / adjust focus');

    return { mappedScore: mapped, conf, lightingState, warnings };
  }, []);

  return { analyzeImageData };
}

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
  const [lighting, setLighting] = useState('');
  const [warnings, setWarnings] = useState([]);
  const rafRef = useRef(null);
  const stableRef = useRef(null); // last stable spoken score
  const consecutiveStableRef = useRef(0);
  const barcodeReaderRef = useRef(null);
  const [barcode, setBarcode] = useState('');
  const { analyzeImageData } = useHealthAnalyzer();
  // API integration scaffold states
  const [apiMode, setApiMode] = useState(false); // toggle to enable backend
  const [apiPending, setApiPending] = useState(false);
  const [apiError, setApiError] = useState('');
  const [apiModel, setApiModel] = useState('');
  const lastApiRef = useRef(0);
  const backoffRef = useRef(0); // ms additional delay after failures

  // Helper: encode current frame (resized) to base64 JPEG (raw base64 without header)
  const encodeFrame = (srcCanvas) => new Promise((resolve) => {
    const maxSide = 512;
    const c = document.createElement('canvas');
    let { width, height } = srcCanvas;
    if (width > maxSide || height > maxSide) {
      const scale = Math.min(maxSide / width, maxSide / height);
      width = Math.round(width * scale); height = Math.round(height * scale);
    }
    c.width = width; c.height = height;
    const ctx = c.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0, c.width, c.height);
    c.toBlob((blob) => {
      if (!blob) return resolve(null);
      const fr = new FileReader();
      fr.onload = () => {
        const result = fr.result || '';
        const base64 = result.toString().split(',')[1] || '';
        resolve(base64);
      };
      fr.readAsDataURL(blob);
    }, 'image/jpeg', 0.7);
  });

  const attemptApiAnalyze = useCallback(async (canvas, barcodeVal) => {
    if (!apiMode || apiPending || !navigator.onLine) return;
    const now = Date.now();
    const baseInterval = 2500; // min ms between calls
    if (now - lastApiRef.current < baseInterval + backoffRef.current) return;
    lastApiRef.current = now;
    setApiError('');
    setApiPending(true);
    try {
      const image_base64 = await encodeFrame(canvas);
      if (!image_base64) throw new Error('encode failed');
      const resp = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64, barcode: barcodeVal || undefined, use_model: true })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (typeof data.score === 'number') {
        setScore(prev => (prev == null || Math.abs(data.score - prev) >= 1 ? data.score : prev));
      }
      if (Array.isArray(data.pros)) setPros(data.pros.slice(0, 6));
      if (Array.isArray(data.cons)) setCons(data.cons.slice(0, 6));
      if (typeof data.confidence === 'number') setConfidence(Math.round(Math.min(100, Math.max(0, data.confidence))));
      if (data.model) setApiModel(String(data.model).slice(0, 24));
      setLastUpdate(new Date().toLocaleTimeString());
      backoffRef.current = 0; // reset backoff
    } catch (err) {
      const prev = backoffRef.current || 2000;
      backoffRef.current = Math.min(prev * 2, 60000);
      setApiError(err.message || 'API error');
    } finally {
      setApiPending(false);
    }
  }, [apiMode, apiPending]);

  // Delayed camera start until first interaction for better autoplay / speech compatibility
  useEffect(() => {
    // Autostart camera but handle failures gracefully
    startCamera();
    return () => stopCamera();
  }, []);

  // Restart camera on orientation change (mobile stability)
  useEffect(() => {
    const handler = () => {
      stopCamera();
      startCamera();
    };
    window.addEventListener('orientationchange', handler);
    return () => window.removeEventListener('orientationchange', handler);
  }, []);

  // Keyboard shortcuts (accessibility / power use): v=voice, s=snapshot, r=restart
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key.toLowerCase() === 'v') toggleVoice();
      if (e.key.toLowerCase() === 's') takeSnapshot();
      if (e.key.toLowerCase() === 'r') { stopCamera(); startCamera(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [userActivatedAudio, voiceEnabled]);

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

  // Initialize barcode reader lazily
  const initBarcode = async () => {
    if (barcodeReaderRef.current) return;
    barcodeReaderRef.current = new BrowserMultiFormatReader();
  };

  const decodeBarcodeFromCanvas = (canvas) => {
    if (!barcodeReaderRef.current) return;
    try {
      const luminanceSource = barcodeReaderRef.current.createLuminanceSource(canvas, canvas.width, canvas.height);
      const binaryBitmap = barcodeReaderRef.current.createBinaryBitmap(luminanceSource);
      const result = barcodeReaderRef.current.decodeBitmap(binaryBitmap);
      if (result && result.getText && result.getText() !== barcode) {
        setBarcode(result.getText());
      }
    } catch (_) { /* ignore no barcode */ }
  };

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

    // ImageData for analysis
    const imgData = ctx.getImageData(0, 0, w, h);

    const imageData = ctx.getImageData(0,0,w,h);
    const analysis = analyzeImageData(imageData);
    decodeBarcodeFromCanvas(canvas);
    if (!analysis) return;
    const { mappedScore, conf, lightingState, warnings: dynamicWarnings } = analysis;

    // Stable update logic: require persistence of change
    setScore(prev => {
      if (prev === null || Math.abs(mappedScore - prev) >= 1) {
        // track persistence
        if (stableRef.current === mappedScore) {
          consecutiveStableRef.current += 1;
        } else {
          stableRef.current = mappedScore;
          consecutiveStableRef.current = 1;
        }
        if (voiceEnabled && userActivatedAudio && consecutiveStableRef.current >= 2 && mappedScore !== prev) {
          speakScore(mappedScore);
        }
        return mappedScore;
      } else {
        // no big change; keep existing
        return prev;
      }
    });

    const { pros: newPros, cons: newCons } = describeFromScore(mappedScore, conf);

    setPros(newPros);
    setCons(newCons);
    setLastUpdate(new Date().toLocaleTimeString());
    setConfidence(Math.round(conf * 100));
    setWarnings(dynamicWarnings);
    // Attempt backend enrichment (throttled)
    attemptApiAnalyze(canvas, barcode);
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

  const handleImageUpload = (e) => {
    const file = e.target.files && e.target.files[0];
    if(!file) return;
    const img = new Image();
    img.onload = () => {
      const off = document.createElement('canvas');
      const maxSide = 800;
      let { width, height } = img;
      if (width > maxSide || height > maxSide) {
        const scale = Math.min(maxSide/width, maxSide/height);
        width = Math.round(width*scale); height = Math.round(height*scale);
      }
      off.width = width; off.height = height;
      const ictx = off.getContext('2d');
      ictx.drawImage(img,0,0,width,height);
      const imageData = ictx.getImageData(0,0,width,height);
      const a = analyzeImageData(imageData);
      if (a) {
        // direct state updates (mirror live path)
        const { mappedScore, conf, lightingState, warnings: dynamicWarnings } = a;
        setScore(mappedScore);
        const { pros: p, cons: c } = describeFromScore(mappedScore, conf);
        setPros(p); setCons(c);
        setConfidence(Math.round(conf*100));
        setLighting(lightingState); setWarnings(dynamicWarnings);
        setLastUpdate(new Date().toLocaleTimeString());
      }
      URL.revokeObjectURL(img.src);
      initBarcode().then(()=> decodeBarcodeFromCanvas(off));
    };
    img.src = URL.createObjectURL(file);
  };

  useEffect(()=>{ initBarcode(); },[]);

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
              <button
                onClick={() => { setApiMode(m => !m); if (!apiMode) { backoffRef.current = 0; lastApiRef.current = 0; }}}
                className={`px-3 py-1 rounded-md text-sm backdrop-blur ${apiMode ? 'bg-indigo-600' : 'bg-white/10'}`}
              >
                {apiMode ? 'API: On' : 'API: Off'}
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
                  {apiMode && (
                    <div className="flex items-center gap-2 mb-2 text-[10px]">
                      <span className={`px-2 py-0.5 rounded ${apiPending ? 'bg-indigo-600 animate-pulse' : 'bg-white/10'}`}>{apiPending ? 'API…' : (apiModel || 'API')}</span>
                      {apiError && <span className="text-red-400" title={apiError}>Err</span>}
                      {!navigator.onLine && <span className="text-amber-400">Offline</span>}
                    </div>
                  )}
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

      <div className="max-w-5xl mt-4 text-xs text-white/60 text-center space-y-1">
        <div>For best results: steady framing, diffuse lighting, move closer if confidence is low.</div>
        {lighting && <div className="text-amber-300">Lighting: {lighting}</div>}
        {warnings.length > 0 && (
          <ul className="text-rose-300 space-y-0.5">{warnings.map((w,i)=><li key={i}>⚠️ {w}</li>)}</ul>
        )}
        {barcode && <div className="text-emerald-300">Barcode: {barcode}</div>}
      </div>
      <div className="mt-4 text-[10px] opacity-40">Shortcuts: V=Voice S=Snapshot R=Restart</div>

      {/* Manual image upload fallback */}
      <div className="mt-6">
        <label className="text-xs opacity-70 block mb-1">Upload image (fallback / analysis)</label>
        <input type="file" accept="image/*" onChange={(e)=>handleImageUpload(e)} className="text-xs" />
      </div>
    </div>
  );
}

// Image upload handler appended after component
function handleImageUpload(e){
  const file = e.target.files && e.target.files[0];
  if(!file) return;
  const img = new Image();
  img.onload = () => {
    // Could integrate a separate analysis path if needed
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
}
