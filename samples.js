/* Consort — the sampler: record (7 s), trim, auto-trim / normalize / fade, root note and loop,
   then encode (IMA ADPCM, 22050 mono) and send to USR1–4 through SMP. The classic order: listen, cut,
   set the root and the loop, name it, send it. */
(function () {
  "use strict";
  const App = window.ConsortApp || {};
  const SMPC = Sloop.SMP;
  const MAX_SEC = 7;
  const T = (key, vars) => (window.ConsortI18n ? ConsortI18n.t(key, vars) : key);
  const IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88,
    97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658,
    724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660,
    4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818,
    18500, 20350, 22385, 24623, 27086, 29794, 32767];
  const IMA_IDX = [-1, -1, -1, -1, 2, 4, 6, 8];
  const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const MIN_TRIM = 0.005;                    // ~35 ms at 7 s: short enough for a loop, long enough to grab
  let slot = 0, take = null, trim = { a: 0, b: 1 }, root = 60, loopMode = 0;
  let fadeMs = 15, xfadeMs = 0, gainDb = 0;
  let recorder = null, recRAF = 0, recCtx = null, recAnalyser = null, recBuf = null, recT0 = 0;
  let livePeaks = null, liveLen = 0, liveScale = 0.06;
  let history = [];                          // copy-on-write states; a destructive edit makes a new pcm
  let lastInfo = null, lastErr = null;
  let dbp = null;

  const toast = (m) => (App.toast ? App.toast(m) : null);
  const link = () => App.link || null;
  const when = (ms) => (App.when ? App.when(ms) : String(ms));
  const noteName = (n) => NOTES[n % 12] + (Math.floor(n / 12) - 1);
  const recording = () => !!(recorder && recorder.state === "recording");
  const secs = (s) => (s < 1 ? s.toFixed(3) : s.toFixed(2)) + " s";

  function imaEncode(x) {
    let pred = 0, idx = 0;
    const nib = new Uint8Array(x.length + (x.length & 1));
    for (let n = 0; n < x.length; n++) {
      const step = IMA_STEP[idx];
      let diff = x[n] - pred, code = 0;
      if (diff < 0) { code = 8; diff = -diff; }
      let vd = step >> 3;
      if (diff >= step) { code |= 4; diff -= step; vd += step; }
      if (diff >= step >> 1) { code |= 2; diff -= step >> 1; vd += step >> 1; }
      if (diff >= step >> 2) { code |= 1; vd += step >> 2; }
      pred = Math.max(-32768, Math.min(32767, code & 8 ? pred - vd : pred + vd));
      idx = Math.max(0, Math.min(88, idx + IMA_IDX[code & 7]));
      nib[n] = code;
    }
    const out = new Uint8Array(nib.length >> 1);
    for (let k = 0; k < nib.length; k += 2) out[k >> 1] = nib[k] | (nib[k + 1] << 4);
    return out;
  }

  function buildSlot(name, zones) {
    const parts = [], zs = [];
    let len = 0;
    for (const z of zones) {
      const data = imaEncode(z.s);
      const le = z.le == null ? z.s.length - 1 : Math.max(0, Math.min(z.s.length - 1, z.le | 0));
      zs.push({ off: len, n: z.s.length, le, root: z.root, looped: z.loop ? 2 : 0 });
      parts.push(data);
      len += data.length;
    }
    if (len > SMPC.MAX_DATA) throw new Error(T("smp.tooLong"));
    const data = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { data.set(p, o); o += p.length; }
    const hdr = new Uint8Array(SMPC.HDR_LEN), v = new DataView(hdr.buffer);
    v.setUint32(0, 0x504D5346, true);
    v.setUint16(4, 1, true);
    hdr[6] = zs.length;
    const nm = String(name).toUpperCase().replace(/[^A-Z0-9 _-]/g, "").slice(0, 8) || "SAMPLE";
    for (let i = 0; i < nm.length; i++) hdr[8 + i] = nm.charCodeAt(i);
    v.setUint32(16, len, true);
    v.setUint32(20, Sloop.crc32(data), true);
    const rate = Math.round(SMPC.RATE / 44100 * 65536);
    zs.forEach((z, j) => {
      const b = 32 + j * 28;
      [z.off, z.n, 0, z.le, rate].forEach((x, k) => v.setUint32(b + k * 4, x >>> 0, true));
      v.setInt16(b + 20, z.root * 16, true);
      v.setInt16(b + 22, 0, true);
      hdr[b + 24] = 0;
      hdr[b + 25] = 0;
      hdr[b + 26] = 127;
      hdr[b + 27] = z.looped;
    });
    return { hdr, data };
  }

  function monoPcm(buf, maxFrames) {
    const n = Math.min(buf.length, maxFrames || buf.length), out = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels;
    }
    return out;
  }
  function resample(x, from, to) {
    if (from === to) return x;
    const n = Math.max(1, Math.round(x.length * to / from)), out = new Float32Array(n), r = from / to;
    for (let i = 0; i < n; i++) {
      const p = i * r, i0 = Math.floor(p), f = p - i0;
      const a = x[Math.min(x.length - 1, i0)], b = x[Math.min(x.length - 1, i0 + 1)];
      out[i] = a + (b - a) * f;
    }
    return out;
  }
  function toInt16(x) {
    const o = new Int16Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const v = Math.max(-1, Math.min(1, x[i]));
      o[i] = v < 0 ? v * 32768 : v * 32767;
    }
    return o;
  }
  function wavBytes(pcm, rate) {
    const ab = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(ab);
    const str = (o, t) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, pcm.length * 2, true);
    new Uint8Array(ab, 44).set(new Uint8Array(pcm.buffer));
    return new Uint8Array(ab);
  }
  function clock(sec) {
    const m = Math.floor(sec / 60), s = sec - m * 60;
    return String(m).padStart(2, "0") + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
  }
  // The waveform is a filled, mirrored envelope (min/max per column), not bars: it reads as audio.
  // The SVG is built once and only the path and the two dim rectangles are updated afterwards.
  function initWaveSvg() {
    const svg = document.getElementById("smp-wavesvg");
    if (!svg || svg.dataset.ready) return;
    svg.dataset.ready = "1";
    svg.innerHTML =
      '<line x1="0" y1="66" x2="400" y2="66" style="stroke:var(--line);stroke-width:1"/>' +
      '<path id="smp-wpath" style="fill:var(--t1);fill-opacity:.9"/>' +
      '<line id="smp-playhead" x1="0" y1="0" x2="0" y2="132" style="stroke:var(--red);stroke-width:2" visibility="hidden"/>' +
      '<rect id="smp-diml" x="0" y="0" width="0" height="132" style="fill:var(--bg);fill-opacity:.72" visibility="hidden"/>' +
      '<rect id="smp-dimr" x="400" y="0" width="0" height="132" style="fill:var(--bg);fill-opacity:.72" visibility="hidden"/>';
  }
  function envelopePath(pcm, n) {
    const len = pcm.length;
    if (!len) return "";
    let peak = 0;
    const cols = [];
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * len / n), b = Math.max(a + 1, Math.floor((i + 1) * len / n));
      let hi = 0, lo = 0;
      for (let j = a; j < b && j < len; j++) {
        const v = pcm[j];
        if (v > hi) hi = v;
        if (v < lo) lo = v;
      }
      if (hi > peak) peak = hi;
      if (-lo > peak) peak = -lo;
      cols.push([(i + 0.5) * 400 / n, hi, lo]);
    }
    const scale = 60 / Math.max(0.05, peak);   // display auto-gain, with a floor so silence stays flat
    const pt = (x, y) => x.toFixed(1) + "," + Math.max(1, Math.min(131, y)).toFixed(1);
    const up = cols.map((c) => pt(c[0], 66 - c[1] * scale));
    const dn = cols.slice().reverse().map((c) => pt(c[0], 66 - c[2] * scale));
    return "M" + up.join("L") + "L" + dn.join("L") + "Z";
  }
  function drawWave(pcm) {
    initWaveSvg();
    const path = document.getElementById("smp-wpath");
    if (!path) return;
    path.setAttribute("d", pcm && pcm.length ? envelopePath(pcm, 200) : "");
    updateDim();
  }
  function updateDim() {
    const l = document.getElementById("smp-diml"), r = document.getElementById("smp-dimr");
    if (!l || !r) return;
    const show = !!take && !recording();
    l.setAttribute("visibility", show ? "visible" : "hidden");
    r.setAttribute("visibility", show ? "visible" : "hidden");
    if (!show) return;
    l.setAttribute("width", (trim.a * 400).toFixed(1));
    r.setAttribute("x", (trim.b * 400).toFixed(1));
    r.setAttribute("width", ((1 - trim.b) * 400).toFixed(1));
  }
  // While recording, MediaRecorder only produces an encoded stream, so the live picture comes from
  // the AnalyserNode: one peak per 1/240 of the 7 s timeline, drawn left to right.
  function drawLive() {
    initWaveSvg();
    const path = document.getElementById("smp-wpath");
    if (!path || !livePeaks) return;
    const n = 240, pts = [];
    let peak = 0;
    for (let i = 0; i < liveLen; i++) if (livePeaks[i] > peak) peak = livePeaks[i];
    if (peak > 0) liveScale = Math.max(0.06, peak);
    const scale = 60 / liveScale;
    for (let i = 0; i < n; i++) {
      const p = i < liveLen ? livePeaks[i] : 0;
      pts.push([(i + 0.5) * 400 / n, 66 - p * scale]);
    }
    const pt = (x, y) => x.toFixed(1) + "," + Math.max(1, Math.min(131, y)).toFixed(1);
    path.setAttribute("d", "M" + pts.map((p) => pt(p[0], p[1])).join("L") +
      "L" + pts.slice().reverse().map((p) => pt(p[0], 132 - p[1])).join("L") + "Z");
    const ph = document.getElementById("smp-playhead");
    if (ph) {
      const x = (Math.min(1, (performance.now() - recT0) / (MAX_SEC * 1000)) * 400).toFixed(1);
      ph.setAttribute("x1", x);
      ph.setAttribute("x2", x);
      ph.setAttribute("visibility", "visible");
    }
    updateDim();
  }
  function drawHint() {
    const el = document.getElementById("smp-wavehint");
    if (el && !take && !recording()) { el.style.display = ""; el.textContent = T("smp.recHint"); }
  }
  function setTrim(a, b) {
    a = Math.max(0, Math.min(1 - MIN_TRIM, a));
    b = Math.max(a + MIN_TRIM, Math.min(1, b));
    trim = { a, b };
    const sel = document.getElementById("smp-sel");
    sel.hidden = !take || recording();
    sel.style.left = (a * 100) + "%";
    sel.style.right = ((1 - b) * 100) + "%";
    const lp = document.getElementById("smp-loopreg");
    lp.hidden = !take || !loopMode || recording();
    lp.style.left = (a * 100) + "%";
    lp.style.right = ((1 - b) * 100) + "%";
    if (take) {
      const s = a * take.pcm.length / take.rate, e = b * take.pcm.length / take.rate;
      const hint = document.getElementById("smp-wavehint");
      hint.style.display = "";
      hint.textContent = T("smp.trimHint", { a: secs(s), b: secs(e) });
      document.getElementById("smp-time").textContent = secs(e - s);
      document.getElementById("smp-cap").textContent = "/ " + MAX_SEC.toFixed(1) + " s";
      document.getElementById("smp-start").textContent = s.toFixed(3);
      document.getElementById("smp-end").textContent = e.toFixed(3);
    } else {
      drawHint();
      ["smp-start", "smp-end"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = "—";
      });
    }
    updateDim();
  }
  function rootLabel() {
    const el = document.getElementById("smp-root");
    if (el) el.textContent = noteName(root);
  }
  function loopLabel() {
    const el = document.getElementById("smp-loopmode");
    if (el) el.textContent = loopMode ? "LOOP" : "ONE SHOT";
  }
  function gainLabel() {
    const el = document.getElementById("smp-gain");
    if (el) el.textContent = (gainDb > 0 ? "+" : "") + gainDb + " dB";
  }
  function paintSlots() {
    const box = document.getElementById("smp-slots");
    if (!box) return;
    const n = lastInfo && lastInfo.nslots ? Math.max(1, Math.min(16, lastInfo.nslots)) : 4;
    if (slot >= n) slot = n - 1;
    box.replaceChildren();
    for (let k = 0; k < n; k++) {
      const sl = lastInfo && lastInfo.slots[k];
      const c = document.createElement("button");
      c.className = "chip" + (k === slot ? " on" : "");
      const b = document.createElement("b");
      b.textContent = "USR" + (k + 1);
      const sp = document.createElement("span");
      sp.textContent = sl && sl.zones ? (sl.name || "—") + " · " + sl.kib + " KiB"
        : (lastInfo ? T("smp.empty", { kib: lastInfo.slotKiB })
          : (lastErr ? T("smp.readFail") : T("smp.offline")));
      c.append(b, sp);
      c.addEventListener("click", () => { slot = k; refresh(); });
      box.appendChild(c);
    }
    const inf = document.getElementById("smp-slotinfo");
    if (inf) inf.textContent = lastInfo ? T("smp.slotInfo", { n: slot + 1, kib: lastInfo.slotKiB })
      : (lastErr ? T("smp.slotInfoFail", { err: lastErr }) : T("smp.offline"));
    const send = document.getElementById("smp-upload");
    if (send) send.textContent = T("smp.send", { n: slot + 1 });
  }
  function refresh() {
    if (!link()) { lastInfo = null; lastErr = null; paintSlots(); return Promise.resolve(); }
    return Sloop.smpInfo(link())
      .then((info) => { lastInfo = info; lastErr = null; paintSlots(); })
      .catch((e) => { lastInfo = null; lastErr = e.message || String(e); paintSlots(); });
  }
  let preview = null;
  function stopPreview() {
    if (!preview) return;
    const s = preview;
    preview = null;
    const btn = document.getElementById("smp-play");
    if (btn) btn.classList.remove("on");
    try { s.stop(); } catch (e) { /* already ended */ }
  }
  function idxAt(f) {
    return Math.max(0, Math.min(take.pcm.length - 1, Math.round(f * take.pcm.length)));
  }
  // What will actually be heard/sent: the trim, with gain, fade and (in LOOP) a crossfaded seam.
  // Nothing here mutates the take, so trim/fade/gain can be changed and undone freely.
  function region() {
    const x = take.pcm;
    let i0 = idxAt(trim.a), i1 = Math.max(i0 + 1, Math.round(trim.b * x.length));
    if (loopMode) {                            // the FM-1 wraps at these two samples: cut on zero crossings
      i0 = nearestZero(i0);
      i1 = Math.max(i0 + 2, Math.min(x.length, nearestZero(i1 - 1) + 1));
    }
    const out = new Float32Array(i1 - i0), g = Math.pow(10, gainDb / 20);
    for (let i = i0; i < i1; i++) out[i - i0] = x[i] * g;
    // A one-shot fades in and out; a loop must not: the fade would dip the level on every wrap.
    const nf = loopMode ? 0 : Math.min(Math.round(take.rate * fadeMs / 1000), out.length >> 2);
    if (nf > 0) {
      for (let i = 0; i < nf; i++) {
        const w = i / nf;
        out[i] *= w;
        out[out.length - 1 - i] *= w;
      }
    }
    if (loopMode && xfadeMs > 0) {
      // Fold the tail onto the head, equal-power: the loop wraps from the sample before the tail
      // (see upload) to out[0], where the tail now continues; by out[n-1] the head has resumed.
      const n = Math.min(Math.round(take.rate * xfadeMs / 1000), out.length >> 2);
      if (n > 1) for (let i = 0; i < n; i++) {
        const th = (i / (n - 1)) * Math.PI / 2;
        out[i] = out[i] * Math.sin(th) + out[out.length - n + i] * Math.cos(th);
      }
    }
    return out;
  }
  function pushUndo() {
    if (!take) return;
    history.push({ pcm: take.pcm, trim: { a: trim.a, b: trim.b }, root, loopMode, fadeMs, xfadeMs, gainDb });
    if (history.length > 12) history.shift();
    updateUndo();
  }
  function updateUndo() {
    const b = document.getElementById("smp-undo");
    if (b) b.disabled = !history.length || recording();
  }
  function undo() {
    if (!take || !history.length) return;
    if (recording()) { toast(T("smp.stopFirst")); return; }
    const h = history.pop();
    take.pcm = h.pcm;
    trim = { a: h.trim.a, b: h.trim.b };
    root = h.root; loopMode = h.loopMode;
    fadeMs = h.fadeMs; xfadeMs = h.xfadeMs; gainDb = h.gainDb || 0;
    rootLabel(); loopLabel(); gainLabel();
    drawWave(take.pcm); setTrim(trim.a, trim.b); updateUndo();
    toast(T("smp.undone"));
  }
  // Nearest point to zero inside ±4 ms: a clean cut is what keeps clicks out of a loop.
  function nearestZero(i) {
    const x = take.pcm, n = Math.max(1, Math.round(take.rate * 0.004));
    let best = i, bestV = Math.abs(x[i] || 0);
    for (let d = 1; d <= n; d++) {
      for (const j of [i - d, i + d]) {
        if (j < 1 || j >= x.length - 1) continue;
        const v = Math.abs(x[j]);
        if (v < bestV) { bestV = v; best = j; }
      }
    }
    return best;
  }
  function play() {
    if (!take) { toast(T("smp.needTake")); return; }
    if (recording()) { toast(T("smp.stopFirst")); return; }
    if (preview) { stopPreview(); return; }
    const pcm = region();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const buf = ac.createBuffer(1, pcm.length, take.rate);
    buf.copyToChannel(pcm, 0);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = !!loopMode;                    // in LOOP the audition loops until pressed again
    if (loopMode) {                           // wrap where the FM-1 wraps: before the folded tail
      const nxf = xfadeMs > 0 ? Math.min(Math.round(take.rate * xfadeMs / 1000), pcm.length >> 2) : 0;
      src.loopEnd = (pcm.length - nxf) / take.rate;
    }
    src.connect(ac.destination);
    const btn = document.getElementById("smp-play");
    if (btn) btn.classList.add("on");
    src.onended = () => {
      ac.close().catch(() => {});
      if (preview === src) preview = null;
      if (btn) btn.classList.remove("on");
    };
    src.start();
    preview = src;
  }
  function autoTrim() {
    if (!take) { toast(T("smp.needTake")); return; }
    if (recording()) { toast(T("smp.stopFirst")); return; }
    stopPreview();
    const x = take.pcm, peak = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const th = Math.max(0.01, peak * 0.04);
    let i0 = 0, i1 = x.length - 1;
    while (i0 < i1 && Math.abs(x[i0]) < th) i0++;
    while (i1 > i0 && Math.abs(x[i1]) < th) i1--;
    const pad = Math.round(take.rate * 0.003);   // keep the attack; then land on a zero crossing
    i0 = nearestZero(Math.max(0, i0 - pad));
    i1 = nearestZero(Math.min(x.length - 1, i1 + pad));
    pushUndo();
    setTrim(i0 / x.length, (i1 + 1) / x.length);
    toast(T("smp.trimmed"));
  }
  function normalize() {
    if (!take) { toast(T("smp.needTake")); return; }
    if (recording()) { toast(T("smp.stopFirst")); return; }
    stopPreview();
    const src = take.pcm;
    const peak = src.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (peak < 1e-4) { toast(T("smp.silent")); return; }
    const g = 0.98 / peak, out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = src[i] * g;
    pushUndo();
    take.pcm = out;
    gainDb = 0;
    gainLabel();
    drawWave(out);
    toast(T("smp.normalized"));
  }
  function fadeSheet() {
    if (!take) { toast(T("smp.needTake")); return; }
    if (recording()) { toast(T("smp.stopFirst")); return; }
    const back = document.createElement("div");
    back.className = "consort-back";
    const sheet = document.createElement("div");
    sheet.className = "consort-sheet";
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = T("smp.fade");
    sheet.appendChild(h);
    [0, 5, 15, 50, 200].forEach((ms) => {
      const b = document.createElement("button");
      b.textContent = ms ? ms + " ms" : T("smp.fadeOff");
      if (ms === fadeMs) b.className = "on";
      b.addEventListener("click", () => {
        pushUndo();
        fadeMs = ms;
        back.remove();
        setTrim(trim.a, trim.b);
        toast(ms ? T("smp.fadeApplied", { n: ms }) : T("smp.fadeOff"));
      });
      sheet.appendChild(b);
    });
    const h2 = document.createElement("div");
    h2.className = "hint";
    h2.textContent = T("smp.loopXfade");
    sheet.appendChild(h2);
    [0, 10, 30].forEach((ms) => {
      const b = document.createElement("button");
      b.textContent = ms ? ms + " ms" : T("smp.fadeOff");
      if (ms === xfadeMs) b.className = "on";
      b.addEventListener("click", () => {
        pushUndo();
        xfadeMs = ms;
        back.remove();
        setTrim(trim.a, trim.b);
        toast(ms ? T("smp.xfadeApplied", { n: ms }) : T("smp.fadeOff"));
      });
      sheet.appendChild(b);
    });
    const cancel = document.createElement("button");
    cancel.textContent = T("menu.cancel");
    cancel.addEventListener("click", () => back.remove());
    sheet.appendChild(cancel);
    back.appendChild(sheet);
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
  }
  function reverse() {
    if (!take) { toast(T("smp.needTake")); return; }
    if (recording()) { toast(T("smp.stopFirst")); return; }
    stopPreview();
    const x = take.pcm, i0 = idxAt(trim.a), i1 = Math.max(i0 + 1, Math.round(trim.b * x.length));
    const out = new Float32Array(x);
    for (let i = 0; i < i1 - i0; i++) out[i0 + i] = x[i1 - 1 - i];
    pushUndo();
    take.pcm = out;
    drawWave(out);
    setTrim(trim.a, trim.b);
    toast(T("smp.reversed"));
  }
  function clean() {
    if (!take) { toast(T("smp.needTake")); return; }
    if (recording()) { toast(T("smp.stopFirst")); return; }
    stopPreview();
    const x = take.pcm, i0 = idxAt(trim.a), i1 = Math.max(i0 + 1, Math.round(trim.b * x.length));
    let mean = 0;
    for (let i = i0; i < i1; i++) mean += x[i];
    mean /= (i1 - i0);
    const out = new Float32Array(x.length);
    const rc = 1 / (2 * Math.PI * 30), dt = 1 / take.rate, a = rc / (rc + dt);
    let pIn = 0, pOut = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i] - mean;                  // DC first, then a gentle 30 Hz high-pass
      const y = a * (pOut + v - pIn);
      pIn = v; pOut = y; out[i] = y;
    }
    pushUndo();
    take.pcm = out;
    drawWave(out);
    setTrim(trim.a, trim.b);
    toast(T("smp.cleaned"));
  }
  // Autocorrelation over the first 250 ms of the selection. Returns null unless the periodicity is
  // confident; parabolic interpolation keeps the frequency accurate enough for TUNE.
  function detectPitch() {
    if (!take) return null;
    const x = take.pcm, rate = take.rate;
    const i0 = idxAt(trim.a), i1 = Math.max(i0 + 1, Math.round(trim.b * x.length));
    const st = i0 + Math.floor((i1 - i0) * 0.1);
    const n = Math.min(i1 - st, Math.round(rate * 0.25));
    if (n < 256) return null;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[st + i];
    mean /= n;
    const y = new Float32Array(n);
    let energy = 0;
    for (let i = 0; i < n; i++) { const v = x[st + i] - mean; y[i] = v; energy += v * v; }
    if (Math.sqrt(energy / n) < 0.003) return null;
    const minLag = Math.max(2, Math.floor(rate / 1000)), maxLag = Math.min(n - 2, Math.floor(rate / 55));
    if (maxLag <= minLag) return null;
    const r = new Float32Array(maxLag + 2);
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0, e1 = 0, e2 = 0;
      for (let i = 0; i < n - lag; i++) {
        const a = y[i], b = y[i + lag];
        s += a * b; e1 += a * a; e2 += b * b;
      }
      const v = s / Math.sqrt(e1 * e2 + 1e-12);
      r[lag] = v;
      if (v > best) { best = v; bestLag = lag; }
    }
    if (best < 0.55 || !bestLag) return null;
    let lag = bestLag;                        // prefer the first strong peak: the fundamental, not the octave
    for (let k = minLag; k <= maxLag; k++) {
      if (r[k] >= best * 0.9 && r[k] > r[k - 1] && r[k] >= r[k + 1]) { lag = k; break; }
    }
    const rl = lag > minLag ? r[lag - 1] : r[lag], r0 = r[lag], rr = r[lag + 1] || r[lag];
    const den = rl - 2 * r0 + rr;
    const shift = Math.abs(den) > 1e-9 ? 0.5 * (rl - rr) / den : 0;
    const f = rate / (lag + shift);
    const midi = Math.round(69 + 12 * Math.log2(f / 440));
    if (!isFinite(midi) || midi < 24 || midi > 96) return null;
    return { f, midi };
  }
  function autoRoot() {
    if (!take) { toast(T("smp.needTake")); return; }
    if (recording()) { toast(T("smp.stopFirst")); return; }
    const p = detectPitch();
    if (!p) { toast(T("smp.rootNone")); return; }
    pushUndo();
    root = p.midi;
    rootLabel();
    toast(T("smp.rootFound", { note: noteName(root) }));
  }
  // Optional and destructive: move the sample's own pitch onto ROOT by resampling it. AUTO leaves
  // the audio alone and only labels it; TUNE makes the root key sound at the root's pitch.
  function tuneToRoot() {
    if (!take) { toast(T("smp.needTake")); return; }
    if (recording()) { toast(T("smp.stopFirst")); return; }
    const p = detectPitch();
    if (!p) { toast(T("smp.rootNone")); return; }
    const target = 440 * Math.pow(2, (root - 69) / 12);
    const ratio = target / p.f;
    if (!isFinite(ratio) || ratio < 0.25 || ratio > 4) { toast(T("smp.tuneRange")); return; }
    if (Math.abs(1200 * Math.log2(ratio)) < 0.5) { toast(T("smp.inTune", { note: noteName(root) })); return; }
    const x = take.pcm, len = Math.round(x.length / ratio);
    if ((trim.b - trim.a) * len / take.rate > MAX_SEC) {
      toast(T("smp.tuneLong", { sec: MAX_SEC.toFixed(1) })); return;
    }
    stopPreview();
    const out = resample(x, take.rate * ratio, take.rate);
    pushUndo();
    take.pcm = out;
    drawWave(out);
    setTrim(trim.a, trim.b);
    toast(T("smp.tuned", { note: noteName(root) }));
  }
  async function saveWav(pcm, name) {
    const r = await fetch("/save?name=" + encodeURIComponent(name) + "&type=audio/wav",
      { method: "POST", body: wavBytes(toInt16(pcm), SMPC.RATE) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const where = (await r.text()).trim();
    return where || name;
  }
  async function saveTake() {
    if (!take) { toast(T("smp.needTake")); return; }
    if (recording()) { toast(T("smp.stopFirst")); return; }
    const pcm = resample(region(), take.rate, SMPC.RATE);
    const btn = document.getElementById("smp-save");
    btn.disabled = true;
    try {
      const where = await saveWav(pcm, take.name);
      rememberTake(where);
      toast(T("smp.saved", { where: where.replace(/^.*[\\/]/, "") }));
    } catch (e) { toast(T("smp.saveFail", { err: e.message || e })); }
    btn.disabled = false;
  }
  async function upload() {
    if (!take) { toast(T("smp.needTake")); return; }
    if (recording()) { toast(T("smp.stopFirst")); return; }
    if (!link()) { toast(T("needConnect")); return; }
    const pcm = resample(region(), take.rate, SMPC.RATE);
    const name = (document.getElementById("smp-name").value || take.name.replace(/\.wav$/i, "")).toUpperCase();
    document.getElementById("smp-name").value = name;
    // A crossfaded loop ends before the folded tail; the release (LOOP+TAIL) plays that tail out.
    const nxf = loopMode && xfadeMs > 0 ? Math.min(Math.round(SMPC.RATE * xfadeMs / 1000), pcm.length >> 2) : 0;
    const le = loopMode && nxf > 1 ? pcm.length - nxf - 1 : pcm.length - 1;
    let built;
    try { built = buildSlot(name, [{ s: toInt16(pcm), root, loop: loopMode, le }]); }
    catch (e) { toast(e.message); return; }
    const btn = document.getElementById("smp-upload");
    btn.disabled = true;
    try {
      await Sloop.smpUpload(link(), slot, built.hdr, built.data, (d, t) => { btn.textContent = Math.round(d / t * 100) + "%"; });
      toast(T("smp.written", { n: slot + 1 }));
      let where = null;
      try { where = await saveWav(pcm, take.name); }
      catch (e) { if (window.ConsortFiles) toast(T("smp.writtenNoFile", { n: slot + 1 })); }
      rememberTake(where);
      refresh();
    } catch (e) { toast(T("smp.uploadFail", { err: e.message })); }
    btn.textContent = T("smp.send", { n: slot + 1 });
    btn.disabled = false;
  }
  function takes() {
    try { return JSON.parse(localStorage.getItem("consort.takes") || "[]"); } catch (e) { return []; }
  }
  function takeId() { return String(Date.now()) + "-" + Math.random().toString(36).slice(2, 7); }
  // The WAV in Downloads is the finished render. The editable take (full PCM + trim/root/loop/fade)
  // lives in IndexedDB, so tapping a take reopens exactly what was recorded/imported.
  function dbOpen() {
    if (!window.indexedDB) return Promise.reject(new Error("no IndexedDB"));
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open("consort-takes", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("takes")) d.createObjectStore("takes", { keyPath: "id" });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function dbPut(v) {
    return dbOpen().then((d) => new Promise((res, rej) => {
      const tx = d.transaction("takes", "readwrite");
      tx.objectStore("takes").put(v);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    })).then(() => dbOpen()).then((d) => new Promise((res) => {
      // Keep the twelve newest; a cursor also works on older WebViews that lack getAll().
      const tx = d.transaction("takes", "readwrite"), st = tx.objectStore("takes");
      let n = 0;
      const req = st.openCursor(null, "prev");
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        n++;
        if (n > 12) c.delete();
        c.continue();
      };
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    })).catch(() => {});
  }
  function dbGet(id) {
    return dbOpen().then((d) => new Promise((res, rej) => {
      const tx = d.transaction("takes", "readonly"), r = tx.objectStore("takes").get(id);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    }));
  }
  function dbDel(id) {
    return dbOpen().then((d) => new Promise((res) => {
      const tx = d.transaction("takes", "readwrite");
      tx.objectStore("takes").delete(id);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    })).catch(() => {});
  }
  function rememberTake(where) {
    if (!take) return;
    if (!take.id) take.id = takeId();
    const now = Date.now();
    let stored = take.name, path = "Download/SLOOP/";
    if (where) {
      const p = String(where).replace(/\\/g, "/").split("/");
      stored = p.pop();
      path = p.join("/") + "/";
      if (path === "/") path = "Download/SLOOP/";
    }
    const list = takes().filter((t) => (t.id || t.name) !== take.id);
    list.unshift({ id: take.id, name: take.name, when: now, stored, path, sec: take.pcm.length / take.rate });
    try { localStorage.setItem("consort.takes", JSON.stringify(list.slice(0, 20))); } catch (e) { /* full */ }
    dbPut({ id: take.id, name: take.name, when: now, rate: take.rate, pcm: take.pcm,
      trim: { a: trim.a, b: trim.b }, root, loopMode, fadeMs, xfadeMs, gainDb,
      label: document.getElementById("smp-name").value }).catch(() => {});
    renderTakes();
  }
  function adopt(st) {
    stopPreview();
    take = { id: st.id, name: st.name || "TAKE.wav", pcm: st.pcm, rate: st.rate || SMPC.RATE };
    trim = st.trim && isFinite(st.trim.a) && isFinite(st.trim.b)
      ? { a: Math.max(0, Math.min(1, st.trim.a)), b: Math.max(0, Math.min(1, st.trim.b)) }
      : { a: 0, b: 1 };
    if (trim.b <= trim.a) trim = { a: 0, b: 1 };
    root = Math.max(24, Math.min(96, st.root || 60));
    loopMode = st.loopMode ? 1 : 0;
    fadeMs = st.fadeMs == null ? 15 : Math.max(0, st.fadeMs);
    xfadeMs = st.xfadeMs == null ? 0 : Math.max(0, st.xfadeMs);
    gainDb = Math.max(-24, Math.min(24, st.gainDb || 0));
    history = [];
    document.getElementById("smp-name").value = (st.label ||
      take.name.replace(/\.wav$/i, "").toUpperCase().replace(/[^A-Z0-9 _-]/g, "")).slice(0, 8);
    rootLabel(); loopLabel(); gainLabel();
    drawWave(take.pcm); setTrim(trim.a, trim.b); updateUndo();
  }
  async function loadTake(t) {
    if (recording()) { toast(T("smp.stopFirst")); return; }
    stopPreview();
    const id = t.id || t.name;
    let st = null;
    try { st = await dbGet(id); } catch (e) { /* no IndexedDB: try the file */ }
    if (st && st.pcm && st.pcm.length) {
      adopt(st);
      toast(T("smp.loaded", { name: t.name }));
      return;
    }
    if (window.ConsortFiles && ConsortFiles.readBase64) {
      try {
        const b64 = ConsortFiles.readBase64(t.stored || t.name, t.path || "Download/SLOOP/");
        if (b64) {
          const bin = atob(b64), u = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
          const ac = new (window.AudioContext || window.webkitAudioContext)();
          const buf = await ac.decodeAudioData(u.buffer);
          ac.close().catch(() => {});
          adopt({ id, name: t.name, rate: buf.sampleRate, pcm: monoPcm(buf),
            trim: { a: 0, b: 1 }, root, loopMode: 0, fadeMs: 0, xfadeMs: 0, gainDb: 0,
            label: t.name.replace(/\.wav$/i, "").toUpperCase().replace(/[^A-Z0-9 _-]/g, "").slice(0, 8) });
          toast(T("smp.loaded", { name: t.name }));
          return;
        }
      } catch (e) { /* report below */ }
    }
    toast(T("smp.loadFail", { name: t.name }));
  }
  function fileBytes(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsArrayBuffer(file);
    });
  }
  function importAudio() {
    if (recording()) { toast(T("smp.stopFirst")); return; }
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "audio/*,.wav,.mp3,.ogg,.oga,.m4a,.aac,.flac,.opus";
    inp.addEventListener("change", async () => {
      const file = (inp.files || [])[0];
      if (!file) return;
      try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const buf = await ac.decodeAudioData(await fileBytes(file));
        ac.close().catch(() => {});
        const limit = Math.round(MAX_SEC * buf.sampleRate);
        const long = buf.length > limit + Math.round(buf.sampleRate * 0.02);
        const pcm = monoPcm(buf, limit);      // the hardware cap applies to the source too
        const base = file.name.replace(/\.[^.]+$/, "");
        take = { id: takeId(), pcm, rate: buf.sampleRate,
          name: base.replace(/[\\/:*?"<>|]/g, "_") + ".wav" };
        history = []; gainDb = 0; fadeMs = 15; xfadeMs = 0; loopMode = 0;
        document.getElementById("smp-name").value =
          base.toUpperCase().replace(/[^A-Z0-9 _-]/g, "").slice(0, 8) || "SAMPLE";
        rootLabel(); loopLabel(); gainLabel();
        drawWave(pcm); setTrim(0, 1); updateUndo();
        toast(T("smp.imported", { name: base, sec: (pcm.length / buf.sampleRate).toFixed(1) }));
        if (long) setTimeout(() => toast(T("smp.importLong")), 1300);
      } catch (e) { toast(T("smp.importFail", { name: file.name })); }
    });
    inp.click();
  }
  function renderTakes() {
    const box = document.getElementById("smp-takes");
    const empty = document.getElementById("smp-takes-empty");
    const hint = document.getElementById("smp-takes-hint");
    if (!box) return;
    const list = takes();
    box.replaceChildren();
    if (empty) empty.style.display = list.length ? "none" : "";
    if (hint) hint.style.display = list.length ? "" : "none";
    list.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "take";
      const info = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = t.name;
      const sp = document.createElement("span");
      sp.textContent = when(t.when) + " · " + (t.sec ? t.sec.toFixed(1) + " s" : T("smp.phone"));
      info.append(b, sp);
      const more = document.createElement("button");
      more.className = "mini";
      more.textContent = "⋯";
      more.addEventListener("click", (e) => { e.stopPropagation(); menu(t, i); });
      row.addEventListener("click", () => loadTake(t));
      row.append(info, more);
      box.appendChild(row);
    });
  }
  function menu(t, i) {
    const back = document.createElement("div");
    back.className = "consort-back";
    const sheet = document.createElement("div");
    sheet.className = "consort-sheet";
    const ren = document.createElement("button");
    ren.textContent = T("menu.rename");
    ren.addEventListener("click", () => {
      back.remove();
      const to = prompt(T("menu.newName"), t.name);
      if (!to) return;
      const m = /(\.[^.]+)$/.exec(t.name);
      const ext = m ? m[1] : "";
      let next = to.trim();
      if (ext && !next.toLowerCase().endsWith(ext.toLowerCase())) next += ext;
      if (!next) return;
      let ok = true;
      const from = t.stored || t.name;
      if (window.ConsortFiles) { try { ok = ConsortFiles.renameAt(from, t.path || "Download/SLOOP/", next); } catch (e) { ok = false; } }
      if (!ok) { toast(T("file.renameFail", { name: t.name })); return; }
      const list = takes();
      if (list[i]) {
        list[i].name = next;
        list[i].stored = next;
        localStorage.setItem("consort.takes", JSON.stringify(list));
      }
      if (take && take.id === (t.id || t.name)) take.name = next;
      const id = t.id || t.name;
      dbGet(id).then((st) => { if (st) { st.name = next; dbPut(st); } }).catch(() => {});
      renderTakes();
    });
    const share = document.createElement("button");
    share.textContent = T("menu.share");
    share.addEventListener("click", () => {
      back.remove();
      if (window.ConsortFiles) {
        try {
          if (ConsortFiles.shareAt) ConsortFiles.shareAt(t.stored || t.name, t.path || "Download/SLOOP/");
          else ConsortFiles.share(t.stored || t.name);
          return;
        } catch (e) { /* no bridge */ }
      }
      toast(T("smp.shareNone"));
    });
    const del = document.createElement("button");
    del.textContent = T("menu.delete");
    del.className = "danger";
    del.addEventListener("click", () => {
      back.remove();
      if (!confirm(T("deleteConfirm", { name: t.name }))) return;
      let ok = true;
      if (window.ConsortFiles) {
        try {
          ok = ConsortFiles.deleteAt
            ? ConsortFiles.deleteAt(t.stored || t.name, t.path || "Download/SLOOP/")
            : ConsortFiles.delete(t.stored || t.name);
        } catch (e) { ok = false; }
      }
      if (!ok) { toast(T("file.deleteFail", { name: t.name })); return; }
      const id = t.id || t.name;
      dbDel(id);
      const list = takes();
      list.splice(i, 1);
      localStorage.setItem("consort.takes", JSON.stringify(list));
      renderTakes();
      toast(T("deleted", { name: t.name }));
    });
    const cancel = document.createElement("button");
    cancel.textContent = T("menu.cancel");
    cancel.addEventListener("click", () => back.remove());
    sheet.append(ren, share, del, cancel);
    back.appendChild(sheet);
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
  }
  async function toggleRec() {
    const btn = document.getElementById("smp-rec");
    if (recording()) { recorder.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast(T("smp.noRec")); return; }
    stopPreview();                            // never record the audition coming out of the speaker
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const chunks = [];
      recCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (recCtx.resume) recCtx.resume().catch(() => {});
      const src = recCtx.createMediaStreamSource(stream);
      recAnalyser = recCtx.createAnalyser();
      recAnalyser.fftSize = 512;
      recBuf = new Float32Array(recAnalyser.fftSize);
      src.connect(recAnalyser);
      recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? { mimeType: "audio/webm;codecs=opus" } : undefined);
      const rec = recorder;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        cancelAnimationFrame(recRAF);
        recRAF = 0;
        stream.getTracks().forEach((x) => x.stop());
        if (recCtx) { try { recCtx.close(); } catch (e) { /* gone */ } recCtx = null; }
        recAnalyser = null; recBuf = null;
        btn.textContent = "REC";
        btn.classList.remove("stop");
        const meter = document.getElementById("smp-meter");
        if (meter) meter.style.width = "0%";
        const ph = document.getElementById("smp-playhead");
        if (ph) ph.setAttribute("visibility", "hidden");
        const hint = document.getElementById("smp-wavehint");
        if (hint) hint.style.display = "";
        try {
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          const ac = new (window.AudioContext || window.webkitAudioContext)();
          const buf = await ac.decodeAudioData(await blob.arrayBuffer());
          ac.close().catch(() => {});
          const pcm = monoPcm(buf);
          const d = new Date(), p = (x) => (x < 10 ? "0" : "") + x;
          take = { id: takeId(), pcm, rate: buf.sampleRate,
            name: "REC-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + ".wav" };
          history = []; gainDb = 0; fadeMs = 15; xfadeMs = 0; loopMode = 0;
          document.getElementById("smp-name").value = "REC-" + p(d.getHours()) + p(d.getMinutes());
          rootLabel(); loopLabel(); gainLabel();
          drawWave(pcm);
          setTrim(0, 1);
          autoTrim();                         // the untrimmed take is the undo step
        } catch (e) {
          // The old take is still in memory; put its picture back so the page does not go blank.
          if (take) { drawWave(take.pcm); setTrim(trim.a, trim.b); }
          else { drawWave(null); drawHint(); }
          toast(T("smp.decodeFail", { err: e.message || e }));
        }
      };
      recorder.start();
      recT0 = performance.now();
      livePeaks = new Float32Array(240);
      liveLen = 0;
      liveScale = 0.06;
      drawWave(null);
      ["smp-sel", "smp-loopreg"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.hidden = true;
      });
      const hint = document.getElementById("smp-wavehint");
      if (hint) hint.style.display = "none";
      btn.textContent = "STOP";
      btn.classList.add("stop");
      const meter = document.getElementById("smp-meter");
      const time = document.getElementById("smp-time");
      let lastMeter = -1000;
      const loop = () => {
        if (!recAnalyser || !recBuf || !recording()) return;
        const elapsed = (performance.now() - recT0) / 1000;
        recAnalyser.getFloatTimeDomainData(recBuf);
        let peak = 0;
        for (let i = 0; i < recBuf.length; i++) peak = Math.max(peak, Math.abs(recBuf[i]));
        const n = Math.min(239, Math.floor(elapsed / MAX_SEC * 240));
        while (liveLen <= n) { livePeaks[liveLen] = 0; liveLen++; }
        if (peak > livePeaks[n]) livePeaks[n] = peak;
        drawLive();
        if (elapsed * 1000 - lastMeter > 80) {
          lastMeter = elapsed * 1000;
          time.textContent = clock(elapsed);
          meter.style.width = Math.min(100, Math.round(peak * 140)) + "%";
        }
        if (elapsed >= MAX_SEC) { try { recorder.stop(); } catch (e) { /* already stopped */ } return; }
        recRAF = requestAnimationFrame(loop);
      };
      recRAF = requestAnimationFrame(loop);
    } catch (e) {
      cancelAnimationFrame(recRAF);
      recRAF = 0;
      if (stream) stream.getTracks().forEach((x) => x.stop());
      if (recCtx) { try { recCtx.close(); } catch (err) { /* gone */ } recCtx = null; }
      recAnalyser = null; recBuf = null;
      btn.textContent = "REC";
      btn.classList.remove("stop");
      drawHint();
      toast(T("smp.recFail", { err: e.message || e }));
    }
  }

  function relabel() {
    paintSlots();
    renderTakes();
    rootLabel(); loopLabel(); gainLabel();
    if (take) setTrim(trim.a, trim.b); else drawHint();
  }

  document.getElementById("smp-rec").addEventListener("click", toggleRec);
  document.getElementById("smp-play").addEventListener("click", play);
  document.getElementById("smp-trim").addEventListener("click", autoTrim);
  document.getElementById("smp-norm").addEventListener("click", normalize);
  document.getElementById("smp-fade").addEventListener("click", fadeSheet);
  document.getElementById("smp-reverse").addEventListener("click", reverse);
  document.getElementById("smp-undo").addEventListener("click", undo);
  document.getElementById("smp-clean").addEventListener("click", clean);
  document.getElementById("smp-save").addEventListener("click", saveTake);
  document.getElementById("smp-upload").addEventListener("click", upload);
  document.getElementById("smp-import").addEventListener("click", importAudio);
  document.getElementById("root-dec").addEventListener("click", () => { pushUndo(); root = Math.max(24, root - 1); rootLabel(); });
  document.getElementById("root-inc").addEventListener("click", () => { pushUndo(); root = Math.min(96, root + 1); rootLabel(); });
  document.getElementById("root-auto").addEventListener("click", autoRoot);
  document.getElementById("root-tune").addEventListener("click", tuneToRoot);
  document.getElementById("gain-dec").addEventListener("click", () => { pushUndo(); gainDb = Math.max(-24, gainDb - 1); gainLabel(); });
  document.getElementById("gain-inc").addEventListener("click", () => { pushUndo(); gainDb = Math.min(24, gainDb + 1); gainLabel(); });
  document.getElementById("smp-loopmode").addEventListener("click", () => {
    if (recording()) { toast(T("smp.stopFirst")); return; }
    pushUndo(); stopPreview(); loopMode = loopMode ? 0 : 1; loopLabel(); setTrim(trim.a, trim.b);
  });
  document.getElementById("smp-name").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9 _-]/g, "").slice(0, 8);
  });
  document.getElementById("smp-erase").addEventListener("click", async () => {
    if (!link()) { toast(T("needConnect")); return; }
    if (!confirm(T("smp.eraseConfirm", { n: slot + 1 }))) return;
    try { await Sloop.smpErase(link(), slot); toast(T("smp.erased", { n: slot + 1 })); refresh(); }
    catch (e) { toast(T("smp.eraseFail", { err: e.message })); }
  });
  function nudge(edge, dir) {
    if (!take) { toast(T("smp.needTake")); return; }
    if (recording()) { toast(T("smp.stopFirst")); return; }
    pushUndo();
    const step = 0.010 / (take.pcm.length / take.rate);   // 10 ms as a fraction of the take
    if (edge < 0) setTrim(trim.a + dir * step, trim.b);
    else setTrim(trim.a, trim.b + dir * step);
  }
  document.getElementById("start-dec").addEventListener("click", () => nudge(-1, -1));
  document.getElementById("start-inc").addEventListener("click", () => nudge(-1, 1));
  document.getElementById("end-dec").addEventListener("click", () => nudge(1, -1));
  document.getElementById("end-inc").addEventListener("click", () => nudge(1, 1));
  const sel = document.getElementById("smp-sel");
  let edge = 0, moved = false;
  sel.addEventListener("pointerdown", (e) => {
    if (!take || recording()) return;
    const r = document.getElementById("smp-wave").getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    edge = Math.abs(x - trim.a) < Math.abs(x - trim.b) ? -1 : 1;
    moved = false;
    try { sel.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
    e.preventDefault();
  });
  sel.addEventListener("pointermove", (e) => {
    if (!sel.hasPointerCapture || !sel.hasPointerCapture(e.pointerId)) return;
    const r = document.getElementById("smp-wave").getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    if (!moved) { pushUndo(); moved = true; }
    if (edge < 0) setTrim(Math.min(x, trim.b - MIN_TRIM), trim.b);
    else setTrim(trim.a, Math.max(x, trim.a + MIN_TRIM));
  });
  sel.addEventListener("pointerup", (e) => {
    try { sel.releasePointerCapture(e.pointerId); } catch (err) { /* */ }
    if (!take || !moved) return;
    const x = take.pcm, i0 = idxAt(trim.a), i1 = Math.max(i0 + 1, Math.round(trim.b * x.length));
    if (edge < 0) setTrim(nearestZero(i0) / x.length, trim.b);
    else setTrim(trim.a, nearestZero(i1) / x.length);
  });
  const tab = document.querySelector('nav button[data-page="p-samples"]');
  if (tab) tab.addEventListener("click", refresh);

  window.ConsortSamples = {
    refresh,
    relabel,
    _take: (pcm, rate, name) => {
      stopPreview();
      take = { id: takeId(), pcm, rate, name: name || "TEST.wav" };
      history = []; gainDb = 0; fadeMs = 15; xfadeMs = 0; loopMode = 0;
      gainLabel(); loopLabel(); drawWave(pcm); setTrim(0, 1); autoTrim(); updateUndo();
    }
  };
  initWaveSvg();
  rootLabel();
  loopLabel();
  gainLabel();
  updateUndo();
  drawHint();
  refresh();
  renderTakes();
})();
