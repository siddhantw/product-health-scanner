// Netlify Function: analyze
// Secure placeholder integrating Vision + LLM scoring.
// Expects either multipart/form-data with 'image' or JSON { image_base64, barcode, use_model }
// NEVER hardcode API keys – uses environment variable OPENAI_API_KEY.

export const config = { path: '/api/analyze' };

// Helper to read body (JSON fallback)
async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

// Sanitize / validate model output structure
function normalizeResult(raw) {
  const out = { score: 5, pros: [], cons: [], confidence: 50, model: 'normalized' };
  if (!raw || typeof raw !== 'object') return out;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  if (typeof raw.score === 'number') out.score = clamp(Math.round(raw.score), 1, 10);
  if (typeof raw.confidence === 'number') out.confidence = clamp(Math.round(raw.confidence), 0, 100);
  const limitList = (arr) => Array.isArray(arr) ? arr.filter(x => typeof x === 'string').slice(0, 6).map(s => s.slice(0, 60)) : [];
  out.pros = limitList(raw.pros);
  out.cons = limitList(raw.cons);
  if (typeof raw.model === 'string') out.model = raw.model.slice(0, 40);
  return out;
}

// Attempt to extract JSON if model returns text with surrounding prose / code fences
function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const match = text.match(/\{[\s\S]*\}/); // first object
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }
  return null;
}

export default async (req, res) => {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Missing OPENAI_API_KEY env var' }));
    return;
  }

  try {
    const method = req.method || 'GET';
    if (method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end(JSON.stringify({ error: 'Use POST' }));
      return;
    }

    // For brevity we treat everything as JSON; production: detect multipart & parse.
    const body = await readBody(req);
    const { image_base64, barcode, use_model } = body;

    // Basic validations
    const MAX_IMAGE_BYTES = 400_000; // ~400 KB budget
    if (image_base64) {
      const rawLen = image_base64.length * 0.75; // rough
      if (rawLen > MAX_IMAGE_BYTES) {
        res.statusCode = 413;
        res.end(JSON.stringify({ error: 'Image too large', max_bytes: MAX_IMAGE_BYTES }));
        return;
      }
    }

    let final = null;
    let modelTried = false;

    if (use_model && image_base64) {
      modelTried = true;
      try {
        // --- Uncomment & adjust when enabling real model call ---
        // const openAiResp = await fetch('https://api.openai.com/v1/responses', {
        //   method: 'POST',
        //   headers: {
        //     'Authorization': `Bearer ${OPENAI_API_KEY}`,
        //     'Content-Type': 'application/json'
        //   },
        //   body: JSON.stringify({
        //     model: 'gpt-4.1-mini',
        //     input: [
        //       { role: 'user', content: [
        //         { type: 'input_text', text: 'Analyze this grocery / product photo and output STRICT JSON only with keys: score (1-10 int), pros (array short phrases), cons (array short phrases), confidence (0-100 int). No extra commentary.' },
        //         { type: 'input_image', image_base64 }
        //       ]}
        //     ],
        //     temperature: 0.1
        //   })
        // });
        // if (!openAiResp.ok) throw new Error('Model HTTP ' + openAiResp.status);
        // const openAiJson = await openAiResp.json();
        // // Depending on API shape; pick text or structured field
        // const text = openAiJson.output_text || openAiJson.choices?.[0]?.message?.content || JSON.stringify(openAiJson);
        // const parsed = extractJSON(typeof text === 'string' ? text : JSON.stringify(text));
        // final = normalizeResult(parsed);
      } catch (modelErr) {
        // Fallback will kick in
        final = null;
      }
    }

    if (!final) {
      // Mock fallback heuristic result
      const mockScore = 7;
      final = normalizeResult({
        score: mockScore,
        pros: ['Sample fresh indicator', 'Balanced ingredients'],
        cons: ['Mock data - integrate real model'],
        confidence: 65,
        model: modelTried ? 'fallback-mock' : 'placeholder-mock'
      });
    }

    const response = {
      ...final,
      barcode: barcode || null,
      ts: Date.now(),
    };

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Inference failed', detail: String(e) }));
  }
};
