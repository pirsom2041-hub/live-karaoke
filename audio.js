// Microphone capture: one stream feeds the level analyser (visuals) and short recorded chunks (transcription).
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const now = () => performance.now() / 1000;

// Capture profiles. "raw" keeps the phone from treating music as noise; "dsp" is the phone's voice-call processing.
const PROFILES = {
  raw: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  agc: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  dsp: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

export function createAudio({ getKey, model, onChunk, onStatus, profile = 'raw', cycleProfiles = null, prompt = null }) {
  let stream = null, ctx = null, analyser = null, srcNode = null, freq = null, wave = null;
  let running = false, timer = 0, inflight = 0, pausedUntil = 0, demo = false;
  let hop = 6, len = 8; // searching: shorter overlapping chunks, so the first match comes sooner
  let cur = profile, cycleN = 0;
  // Each Whisper model has its own free quota. The second one is clearly weaker on sung Hebrew, so it is only a stopgap.
  const ALT = 'whisper-large-v3-turbo';
  let altUntil = 0;
  const pickModel = () => (now() < altUntil ? ALT : model());
  const hist = [];
  let lastBeat = 0, beatLevel = 0;
  const lvl = { sum: 0, n: 0, peak: 0 };
  const net = { ok: 0, fail: 0, lastMs: 0, state: 'idle' };
  const status = (s, extra) => { net.state = s; onStatus && onStatus(s, extra); };

  async function open(name) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { ...PROFILES[name], channelCount: 1 } });
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (srcNode) srcNode.disconnect();
    stream = s; cur = name;
    srcNode = ctx.createMediaStreamSource(stream);
    srcNode.connect(analyser);
  }

  async function start() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    freq = new Uint8Array(analyser.frequencyBinCount);
    wave = new Uint8Array(analyser.fftSize);
    try { await open(cur); } catch (e) { ctx.close(); ctx = analyser = null; throw e; }
    if (ctx.state === 'suspended') await ctx.resume();
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

  async function cycle() {
    if (!running || demo) return;
    if (cycleProfiles && cycleN && cycleN % 4 === 0) {
      try { await open(cycleProfiles[(cycleN / 4) % cycleProfiles.length]); } catch (e) { /* keep the current stream */ }
    }
    cycleN++;
    if (!document.hidden) record();
    timer = setTimeout(cycle, hop * 1000);
  }

  function record() {
    let rec;
    const used = cur, st = stream;
    try {
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
      rec = new MediaRecorder(st, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
    } catch (e) { status('error', 'recorder'); return; }
    const parts = [];
    let t0 = now();
    lvl.sum = 0; lvl.n = 0; lvl.peak = 0;
    rec.onstart = () => { t0 = now(); };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    rec.onstop = () => {
      const t1 = now();
      const track = st.getAudioTracks()[0];
      const meta = { profile: used, level: lvl.n ? +(lvl.sum / lvl.n).toFixed(3) : 0, peak: +lvl.peak.toFixed(3), sr: ctx ? ctx.sampleRate : 0, set: track && track.getSettings ? track.getSettings() : null };
      send(new Blob(parts, { type: rec.mimeType || 'audio/webm' }), t0, t1, meta);
    };
    rec.start();
    setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, len * 1000);
  }

  async function send(blob, t0, t1, meta) {
    if (!running || blob.size < 2000) return;
    if (now() < pausedUntil) return;
    if (inflight >= 2) return; // the network is behind: drop instead of queueing stale audio
    if (!navigator.onLine) { status('offline'); return; }
    const key = getKey();
    if (!key) { status('error', 'key'); return; }
    inflight++;
    const started = now();
    try {
      const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
      const p = prompt && prompt();
      // Main model first. If its quota answers 429, send this same chunk to the other model and stay there briefly.
      const order = now() < altUntil ? [ALT] : [model(), ALT];
      for (const used of order) {
        const fd = new FormData();
        fd.append('file', blob, `chunk.${ext}`);
        fd.append('model', used);
        fd.append('language', 'he');
        fd.append('response_format', 'verbose_json');
        fd.append('temperature', '0');
        fd.append('timestamp_granularities[]', 'word');
        fd.append('timestamp_granularities[]', 'segment');
        if (p) fd.append('prompt', p);
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 15000);
        const r = await fetch(GROQ_URL, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd, signal: ctl.signal });
        clearTimeout(to);
        if (r.status === 429) {
          if (used !== ALT) { altUntil = now() + 30; continue; }
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
        if (running) onChunk({ t0, t1, tr, blob, meta: { ...meta, model: used, ms: net.lastMs, bytes: blob.size, mime: blob.type } });
        return;
      }
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
      analyser.getByteTimeDomainData(wave);
      let pk = 0;
      for (let i = 0; i < wave.length; i += 4) { const v = Math.abs(wave[i] - 128) / 128; if (v > pk) pk = v; }
      lvl.sum += pk; lvl.n++; if (pk > lvl.peak) lvl.peak = pk;
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
