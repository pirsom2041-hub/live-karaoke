// Microphone capture: one stream feeds the level analyser (visuals) and short recorded chunks (transcription).
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const now = () => performance.now() / 1000;

// Raw capture. Measured on a phone: the voice-call processing (noise suppression) strips music almost to silence.
const CAPTURE = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };

export function createAudio({ getKey, model, onChunk, onStatus, hint = null }) {
  let stream = null, ctx = null, analyser = null, freq = null, wave = null;
  let running = false, timer = 0, inflight = 0, pausedUntil = 0, demo = false;
  // Searching: long chunks, because short ones of far-field music rarely transcribe into anything usable.
  let hop = 10, len = 16;
  // Each Whisper model has its own free quota. The second one is clearly weaker on sung Hebrew, so it is only a stopgap.
  const ALT = 'whisper-large-v3-turbo';
  let altUntil = 0;
  const hist = [];
  let lastBeat = 0, beatLevel = 0;
  const lvl = { sum: 0, n: 0, peak: 0 };
  const net = { ok: 0, fail: 0, lastMs: 0, state: 'idle' };
  const status = (s, extra) => { net.state = s; onStatus && onStatus(s, extra); };

  async function start() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: CAPTURE });
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    ctx.createMediaStreamSource(stream).connect(analyser);
    freq = new Uint8Array(analyser.frequencyBinCount);
    wave = new Uint8Array(analyser.fftSize);
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
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
    } catch (e) { status('error', 'recorder'); return; }
    const parts = [];
    let t0 = now();
    lvl.sum = 0; lvl.n = 0; lvl.peak = 0;
    rec.onstart = () => { t0 = now(); };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    rec.onstop = () => {
      const meta = { level: lvl.n ? +(lvl.sum / lvl.n).toFixed(3) : 0, peak: +lvl.peak.toFixed(3) };
      send(new Blob(parts, { type: rec.mimeType || 'audio/webm' }), t0, now(), meta);
    };
    rec.start();
    setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, len * 1000);
  }

  // One transcription. hintText: lyrics the audio is expected to contain (improves far-field transcripts a lot).
  async function post(blob, hintText) {
    const key = getKey();
    if (!key) { status('error', 'key'); return null; }
    const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
    // Main model first. If its quota answers 429, send this same chunk to the other model and stay there briefly.
    const order = now() < altUntil ? [ALT] : [model(), ALT];
    for (let i = 0; i < order.length; i++) {
      const used = order[i];
      const fd = new FormData();
      fd.append('file', blob, `chunk.${ext}`);
      fd.append('model', used);
      fd.append('language', 'he');
      fd.append('response_format', 'verbose_json');
      fd.append('temperature', '0');
      fd.append('timestamp_granularities[]', 'word');
      fd.append('timestamp_granularities[]', 'segment');
      if (hintText) fd.append('prompt', hintText);
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(GROQ_URL, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd, signal: ctl.signal });
      clearTimeout(to);
      if (r.status === 400 && hintText) { hintText = ''; i--; continue; } // hint too long for the model: send without it
      if (r.status === 429) {
        if (used !== ALT) { altUntil = now() + 30; continue; }
        const wait = Number(r.headers.get('retry-after')) || 20;
        pausedUntil = now() + Math.min(wait, 120);
        status('limited', Math.round(wait));
        return null;
      }
      if (r.status === 401) { status('error', 'key'); return null; }
      if (!r.ok) { net.fail++; status('error', `http ${r.status}`); return null; }
      return { tr: await r.json(), used };
    }
    return null;
  }

  async function send(blob, t0, t1, meta) {
    if (!running || blob.size < 2000) return;
    if (now() < pausedUntil) return;
    if (inflight >= 2) return; // the network is behind: drop instead of queueing stale audio
    if (!navigator.onLine) { status('offline'); return; }
    inflight++;
    const started = now();
    try {
      const r = await post(blob, hint ? hint() : '');
      if (!r) return;
      net.ok++; net.lastMs = Math.round((now() - started) * 1000);
      status('listening');
      if (running) onChunk({ t0, t1, tr: r.tr, blob, meta: { ...meta, model: r.used, ms: net.lastMs, bytes: blob.size } });
    } catch (e) {
      net.fail++;
      status(navigator.onLine ? 'slow' : 'offline');
    } finally { inflight--; }
  }

  // Second pass over a chunk already recorded, with a lyric hint.
  async function transcribe(blob, hintText) {
    if (now() < pausedUntil || !navigator.onLine) return null;
    try { const r = await post(blob, hintText); return r && r.tr; } catch (e) { return null; }
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
    start, startDemo, stop, levels, transcribe,
    // search: long chunks. locked: chunks back to back, hinted with the song's lyrics.
    // waiting: she is expected to start a stanza, so shorter and more frequent chunks catch it sooner.
    setMode(mode) {
      if (mode === 'waiting') { hop = 6; len = 9; } else if (mode === 'locked') { hop = 10; len = 12; } else { hop = 10; len = 16; }
    },
    get net() { return net; },
    get running() { return running; },
  };
}
