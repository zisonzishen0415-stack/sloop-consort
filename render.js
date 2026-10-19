/* Consort — offline, faster-than-real-time rendering of a SLOOP song or backup.
   The full SLOOP firmware is compiled to WebAssembly (sloop.wasm) against the browser emulator's
   simulated FM-1. The file's objects are written into the emulated flash, the machine boots from it,
   PLAY is pressed, and web_render() is called in a tight loop; no audio hardware and no real time.
   The WAV goes through the same /save endpoint as the sampler, into Download/SLOOP. */
(function () {
  "use strict";
  const RATE = 44100;
  const SAMPLE_OFFSETS = [0xA0000, 0xB4000, 0xC8000, 0xE7000]; // USR1..4, 0x14000 each
  const SAMPLE_SIZE = 0x14000;
  const PLAY_BUTTON = 1 << 10;
  const T = (key, vars) => (window.ConsortI18n ? ConsortI18n.t(key, vars) : key);
  const toast = (m) => (window.ConsortApp && ConsortApp.toast ? ConsortApp.toast(m) : null);
  let wasmPromise = null;

  function wasmModule() {
    if (!wasmPromise) wasmPromise = fetch("sloop.wasm").then((r) => {
      if (!r.ok) throw new Error("sloop.wasm: HTTP " + r.status);
      return r.arrayBuffer();
    }).then((b) => WebAssembly.compile(b));
    return wasmPromise;
  }

  function putObject(ex, id, bytes) {
    if (!bytes.length) return;
    if (bytes.length > ex.web_upload_size()) throw new Error("object " + id + " too large");
    new Uint8Array(ex.memory.buffer, ex.web_upload_buf(), bytes.length).set(bytes);
    const rc = ex.web_obj_put(id, bytes.length);
    if (rc) throw new Error("object " + id + " refused (" + rc + ")");
  }

  function putSample(ex, id, bytes) {
    const k = id - 32;
    if (k < 0 || k > 3 || !bytes.length) return;
    const off = SAMPLE_OFFSETS[k], n = Math.min(bytes.length, SAMPLE_SIZE);
    new Uint8Array(ex.memory.buffer, ex.web_nor() + off, n).set(bytes.subarray(0, n));
  }

  function objectsOf(file) {
    let data = file;
    if (data && data.format === "sloop-playlist" && Array.isArray(data.songs) && data.songs.length) data = data.songs[0];
    if (!data || typeof data !== "object") throw new Error(T("songs.renderBad"));
    if (data.format === "sloop-song") {
      Sloop.songObjects(data);                       // checks ids, lengths and CRCs
    } else if (data.format === "sloop-backup") {
      if (!Array.isArray(data.objects)) throw new Error(T("songs.renderBad"));
    } else throw new Error(T("songs.renderBad"));
    const out = [], samples = [];
    for (const o of data.objects || []) {
      const bytes = Sloop.unb64(o.data || "");
      if (bytes.length !== o.len || Sloop.crc32(bytes) !== (o.crc >>> 0)) throw new Error("object " + o.id + " damaged");
      if (o.id >= 32 && o.id <= 35) samples.push({ id: o.id, bytes });
      else if (o.id >= 0 && o.id <= 8) out.push({ id: o.id, bytes });
    }
    for (const o of data.samples || []) {
      const bytes = Sloop.unb64(o.data || "");
      if (bytes.length !== o.len || Sloop.crc32(bytes) !== (o.crc >>> 0)) throw new Error("sample " + o.id + " damaged");
      if (o.id >= 32 && o.id <= 35) samples.push({ id: o.id, bytes });
    }
    if (!out.some((o) => o.id === 0)) throw new Error(T("songs.renderNoLoop"));
    let order = data.order ? Sloop.unb64(data.order) : null;
    if (!order) {                                  // a backup keeps the order in its settings object
      const s = out.find((o) => o.id === 1);
      if (s && s.bytes.length >= 48 + 36 &&
          s.bytes[0] === 0x33 && s.bytes[1] === 0x52 && s.bytes[2] === 0x45 && s.bytes[3] === 0x50)
        order = s.bytes.slice(48, 48 + 36);        // "PER3" little-endian, arr_config_t
    }
    if (order && order.length !== 36) throw new Error(T("songs.renderBad"));
    return { objects: out, samples, order: order ? Uint8Array.from(order) : null };
  }

  function build(module, obj) {
    const a = instanceSync(module);
    a.web_nor_erase();
    a.web_master(700);
    a.web_boot();
    for (const o of obj.objects) putObject(a, o.id, o.bytes);
    for (const s of obj.samples) putSample(a, s.id, s.bytes);
    if (obj.order) {
      new Uint8Array(a.memory.buffer, a.web_upload_buf(), obj.order.length).set(obj.order);
      const rc = a.web_order_put(obj.order.length);
      if (rc) throw new Error("song order refused (" + rc + ")");
    }
    const image = new Uint8Array(a.memory.buffer, a.web_nor(), a.web_nor_size()).slice();
    const b = instanceSync(module);
    b.web_nor_erase();
    new Uint8Array(b.memory.buffer, b.web_nor(), b.web_nor_size()).set(image);
    b.web_master(700);
    b.web_boot();
    return b;
  }

  function instanceSync(module) {
    const inst = new WebAssembly.Instance(module, {});
    const ex = inst.exports;
    if (ex._initialize) ex._initialize();
    return ex;
  }

  async function render(ex, seconds, onProgress, fullSong) {
    let songMode = false;
    if (fullSong && typeof ex.web_song_play === "function") songMode = !!ex.web_song_play();
    const maxFrames = Math.round(RATE * (songMode ? 300 : seconds));
    const chunks = [];
    let frames = 0;
    const clamp = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    const block = (n) => {
      ex.web_render(n);
      const l = new Float32Array(ex.memory.buffer, ex.web_out_l(), n);
      const r = new Float32Array(ex.memory.buffer, ex.web_out_r(), n);
      const b = new Uint8Array(n * 4), dv = new DataView(b.buffer);
      for (let i = 0; i < n; i++) {
        dv.setInt16(i * 4, clamp(l[i]), true);
        dv.setInt16(i * 4 + 2, clamp(r[i]), true);
      }
      chunks.push(b);
      frames += n;
    };
    if (!songMode) {
      ex.web_buttons(PLAY_BUTTON);
      const held = Math.min(maxFrames, Math.round(RATE * 0.05));
      while (frames < held) block(Math.min(128, held - frames));
      ex.web_buttons(0);
    }
    let next = 0.5;
    while (frames < maxFrames) {
      block(Math.min(128, maxFrames - frames));
      if (songMode && frames > RATE * 0.2 && typeof ex.web_song_playing === "function" && !ex.web_song_playing()) break;
      if (frames / RATE >= next) {
        if (onProgress) onProgress(Math.min(99, Math.round(frames / maxFrames * 100)));
        next += 0.5;
        await new Promise((r) => setTimeout(r, 0));    // keep the page responsive on long songs
      }
    }
    if (onProgress) onProgress(100);
    return { chunks, frames };
  }

  function wav(chunks, frames) {
    const n = frames, ab = new ArrayBuffer(44 + n * 4), v = new DataView(ab);
    const str = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + n * 4, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, RATE, true); v.setUint32(28, RATE * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, n * 4, true);
    let off = 44;
    for (const c of chunks) {
      new Uint8Array(ab, off, c.length).set(c);
      off += c.length;
    }
    return new Uint8Array(ab);
  }

  async function renderData(data, seconds, onProgress, module) {
    const m = module || await wasmModule();
    const obj = objectsOf(data);
    const fullSong = !!(obj.order && obj.order[0] > 0);
    if (fullSong) obj.order[1] = 0;                 // render the song once, not forever
    const ex = build(m, obj);
    const pcm = await render(ex, Math.max(0.5, Math.min(300, +seconds || 16)), onProgress, fullSong);
    return wav(pcm.chunks, pcm.frames);
  }

  async function renderFile(f) {
    if (!window.ConsortFiles) { toast(T("songs.previewOnly")); return; }
    let text = null;
    try { text = ConsortFiles.readText(f.name, f.path || ""); }
    catch (e) { text = null; }
    if (!text) { toast(T("songs.readFail", { name: f.name })); return; }
    let data;
    try { data = JSON.parse(text); }
    catch (e) { toast(T("songs.renderBad")); return; }
    let fullSong = false;
    try {
      const o = objectsOf(data);
      fullSong = !!(o.order && o.order[0] > 0);
    } catch (e) { toast(e && e.message ? e.message : T("songs.renderBad")); return; }
    let seconds = 16;
    if (!fullSong) {
      const sec = prompt(T("songs.renderAsk", { name: f.name }), "16");
      if (sec == null) return;
      seconds = Math.max(0.5, Math.min(300, Number(sec) || 16));
    }
    try {
      toast(T("songs.rendering", { pct: 0 }));
      const bytes = await renderData(data, seconds, (pct) => toast(T("songs.rendering", { pct })));
      const name = String(f.name || "song").replace(/\.[^.]+$/, "") + "-mix.wav";
      const r = await fetch("/save?name=" + encodeURIComponent(name) + "&type=audio/wav",
        { method: "POST", body: bytes });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const where = (await r.text()).trim();
      toast(T("songs.renderDone", { name: where.replace(/^.*[\\/]/, "") }));
    } catch (e) {
      toast(T("songs.renderFail", { err: e && e.message ? e.message : String(e) }));
    }
  }

  window.ConsortRender = { renderFile, renderData };
})();
