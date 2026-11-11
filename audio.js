// Microphone capture: one stream feeds the level analyser (visuals) and short recorded chunks (transcription).
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const now = () => performance.now() / 1000;

export function createAudio({ getKey, model, onChunk, onStatus }) {
  let stream = null, ctx = null, analyser = null, freq = null;
  let running = false, timer = 0, inflight = 0, pausedUntil = 0, demo = false;
  let hop = 6, len = 8; // searching: shorter overlapping chunks, so the first match comes sooner
  // Each Whisper model has its own free quota. When the main one is exhausted, use the other for ten minutes.
  const ALT = 'whisper-large-v3-turbo';
  let altUntil = 0;
  const pickModel = () => (now() < altUntil ? ALT : model());
  const hist = [];
  let lastBeat = 0, beatLevel = 0;
  const net = { ok: 0, fail: 0, lastMs: 0, state: 'idle' };
  const status = (s, extra) => { net.state = s; onStatus && onStatus(s, extra); };

  async function start() {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    ctx.createMediaStreamSource(stream).connect(analyser);
    freq = new Uint8Array(analyser.frequencyBinCount);
    running = true;
    status('listening');
    cycle();
  }

  function startDemo() { demo = true; running = true; status('listening'); }

  function stop() {
    running = false; clearTimeout(timer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close();
    stream = ctx = analyser = null;
  }

  function cycle() {
    if (!running || demo) return;
    if (!document.hidden) record();
    timer = setTimeout(cycle, hop * 1000);
  }

  function record() {
    let rec;
    try {
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    } catch (e) { status('error', 'recorder'); return; }
    const parts = [];
    let t0 = now();
    rec.onstart = () => { t0 = now(); };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    rec.onstop = () => { const t1 = now(); send(new Blob(parts, { type: rec.mimeType || 'audio/webm' }), t0, t1); };
    rec.start();
    setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, len * 1000);
  }

  async function send(blob, t0, t1) {
    if (!running || blob.size < 2000) return;
    if (now() < pausedUntil) return;
    if (inflight >= 2) return; // the network is behind: drop instead of queueing stale audio
    if (!navigator.onLine) { status('offline'); return; }
    const key = getKey();
    if (!key) { status('error', 'key'); return; }
    inflight++;
    const started = now();
    try {
      const fd = new FormData();
      const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
      fd.append('file', blob, `chunk.${ext}`);
      const used = pickModel();
      fd.append('model', used);
      fd.append('language', 'he');
      fd.append('response_format', 'verbose_json');
      fd.append('temperature', '0');
      fd.append('timestamp_granularities[]', 'word');
      fd.append('timestamp_granularities[]', 'segment');
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(GROQ_URL, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd, signal: ctl.signal });
      clearTimeout(to);
      if (r.status === 429) {
        if (used !== ALT) { altUntil = now() + 600; return; }
        const wait = Number(r.headers.get('retry-after')) || 20;
        pausedUntil = now() + Math.min(wait, 120);
        status('limited', Math.round(wait));
        return;
      }
      if (r.status === 401) { status('error', 'key'); return; }
      if (!r.ok) { net.fail++; status('error', `http ${r.status}`); return; }
      const tr = await r.json();
      net.ok++; net.lastMs = Math.round((now() - started) * 1000);
      status('listening');
      if (running) onChunk({ t0, t1, tr });
    } catch (e) {
      net.fail++;
      status(navigator.onLine ? 'slow' : 'offline');
    } finally { inflight--; }
  }

  // Called every animation frame. Values are 0..1.
  function levels() {
    const t = now();
    let bass = 0, mid = 0, high = 0, level = 0;
    if (demo) {
      const ph = (t * 2) % 1;
      bass = 0.25 + 0.6 * Math.exp(-ph * 6);
      mid = 0.3 + 0.2 * Math.sin(t * 3.1); high = 0.2 + 0.15 * Math.sin(t * 7.3); level = (bass + mid + high) / 3;
    } else if (analyser) {
      analyser.getByteFrequencyData(freq);
      const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += freq[i]; return s / ((b - a) * 255); };
      bass = avg(1, 5); mid = avg(5, 40); high = avg(40, 160); level = avg(1, 160);
    }
    hist.push(bass); if (hist.length > 45) hist.shift();
    const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
    let beat = false;
    if (bass > mean * 1.28 + 0.03 && t - lastBeat > 0.24) { beat = true; lastBeat = t; beatLevel = 1; }
    beatLevel *= 0.9;
    return { bass, mid, high, level, beat, pulse: beatLevel, bins: demo ? null : freq };
  }

  return {
    start, startDemo, stop, levels,
    setMode(locked) { hop = locked ? 10 : 6; len = locked ? 10 : 8; },
    get net() { return net; },
    get running() { return running; },
  };
}
