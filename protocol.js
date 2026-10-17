/* The SLOOP editor protocol, the part Consort needs: framing, a request/response link, and backup objects
   (which is how the theme and the songs travel). F0 7D 46 4C <cmd> <7-bit args> F7. */
(function (g) {
  "use strict";
  const HDR = [0x7D, 0x46, 0x4C];
  const CMD = { INFO: 1, SET: 3, PROJECT: 9, SMP_BEGIN: 11, SMP_WRITE: 12, SMP_END: 13, SMP_ERASE: 14, SMP_INFO: 15,
    BK_LIST: 34, BK_GET: 35, BK_PUT: 36, LIVE: 77 };
  const SMP = { RATE: 22050, DATA_OFF: 512, HDR_LEN: 32 + 16 * 28, MAX_DATA: 0x14000 - 512, MAX_ZONES: 16 };
  const THEME_ID = 11;
  /* A song as one file (SLOOP 2.7, the editor's "Export this song"): the loop, sections A-D and the
     song order. Consort may add a top-level `samples` array (ids 32..35) when the user asks for it;
     the upstream editor ignores unknown top-level fields, so the file still loads there. Those ids
     must never go into `objects`: upstream rejects any object id other than 0 and 2..5. */
  const SONGF = { FORMAT: "sloop-song", VERSION: 1, SECS: [2, 3, 4, 5], SAMPLES: [32, 33, 34, 35],
    ORDER_OFF: 48, ORDER_LEN: 36, PER3: 0x50455233 };

  function frame(cmd, args) {
    args = args || [];
    for (const b of args) if (!(Number.isInteger(b) && b >= 0 && b <= 0x7F)) throw new Error("bad data byte " + b);
    return Uint8Array.from([0xF0, ...HDR, cmd & 0x7F, ...args, 0xF7]);
  }
  function unframe(d) {
    d = Array.from(d);
    if (d.length < 6 || d[0] !== 0xF0 || d[d.length - 1] !== 0xF7) return null;
    if (d[1] !== HDR[0] || d[2] !== HDR[1] || d[3] !== HDR[2]) return null;
    return { cmd: d[4], a: d.slice(5, d.length - 1) };
  }

  function u35enc(v) { v >>>= 0; return [0, 1, 2, 3, 4].map((k) => Math.floor(v / 2 ** (7 * k)) & 0x7F); }
  function u35dec(r) { let v = 0; for (let k = 0; k < 5; k++) v += r.b() * 2 ** (7 * k); return v >>> 0; }
  class Reader { constructor(a) { this.a = a; this.i = 0; } b() { return this.a[this.i++]; }
    s() { let o = ""; for (;;) { const c = this.b(); if (!c) return o; o += String.fromCharCode(c); } } }

  function pack7(b) {
    const out = [];
    for (let i = 0; i < b.length; i += 7) {
      const grp = Array.from(b.slice(i, i + 7));
      out.push(grp.reduce((m, x, j) => m | (((x >> 7) & 1) << j), 0));
      for (const x of grp) out.push(x & 0x7F);
    }
    return out;
  }
  function unpack7(a) {
    const out = [];
    for (let i = 0; i < a.length; i += 8) {
      const top = a[i];
      for (let j = 0; j < 7 && i + 1 + j < a.length; j++) out.push(a[i + 1 + j] | (((top >> j) & 1) << 7));
    }
    return Uint8Array.from(out);
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  class Link {
    constructor(transport, timeout) {
      this.t = transport;
      this.timeout = timeout || 500;
      this.q = [];
      this.cur = null;
      this.closed = false;
    }
    request(cmd, args, opt) {
      opt = opt || {};
      if (this.closed) return Promise.reject(new Error("closed"));
      return new Promise((res, rej) => {
        this.q.push({ cmd, args: args || [], res, rej, timeout: opt.timeout || this.timeout, retries: opt.retries == null ? 1 : opt.retries });
        this._pump();
      });
    }
    _pump() {
      if (this.cur || this.closed || !this.q.length) return;
      this.cur = this.q.shift();
      this._fire();
    }
    _fire() {
      const c = this.cur;
      this.t.send(frame(c.cmd, c.args));
      c.timer = setTimeout(() => {
        if (this.cur !== c) return;
        if (c.retries-- > 0) { this._fire(); return; }
        this._finish(null, new Error("timeout (cmd " + c.cmd + ")"));
      }, c.timeout);
    }
    _finish(val, err) {
      const c = this.cur;
      if (!c) return;
      clearTimeout(c.timer);
      this.cur = null;
      if (err) c.rej(err); else c.res(val);
      this._pump();
    }
    receive(bytes) {
      const f = unframe(bytes);
      if (!f) return null;
      const c = this.cur;
      if (c && f.cmd === c.cmd) { this._finish(f.a); return f; }
      return f;
    }
    close() { this.closed = true; if (this.cur) this._finish(null, new Error("closed")); }
  }

  async function connect(transport) {
    const link = new Link(transport);
    transport.link = link;               /* the mock transport answers through it */
    await link.request(CMD.INFO, [], { timeout: 500, retries: 3 });
    return link;
  }

  function parseList(a) {
    const r = new Reader(a), rc = r.b(), n = r.b(), items = [];
    for (let i = 0; i < n; i++) items.push({ id: r.b(), len: u35dec(r), crc: u35dec(r) });
    return { rc, items };
  }
  function parseGet(a) {
    const r = new Reader(a), id = r.b(), rc = r.b(), off = u35dec(r), count = r.b() | (r.b() << 7);
    return { id, rc, off, count, data: unpack7(a.slice(r.i)) };
  }
  function parsePut(a) { const r = new Reader(a); return { op: r.b(), id: r.b(), rc: r.b() }; }

  function v14(v) {
    const u = Math.max(-8192, Math.min(8191, Math.round(v))) + 8192;
    return [u & 0x7F, (u >> 7) & 0x7F];
  }
  async function setParam(link, scope, id, value) {
    const a = await link.request(CMD.SET, [scope & 0x7F, id & 0x7F, ...v14(value)], { timeout: 800, retries: 0 });
    const r = new Reader(a);
    return { scope: r.b(), id: r.b(), value: (r.b() | (r.b() << 7)) - 8192 };
  }
  /* INFO: version string, NENGINES, P_COUNT, G_COUNT, NSTEP, P_E0, the engine names, then (v3) NTRK
     and (v5) the protocol version. P_COUNT is all a song/backup check needs (see bkDevFormat). */
  function parseInfo(a) {
    const r = new Reader(a);
    const o = { version: r.s(), nengines: r.b(), pcount: r.b(), gcount: r.b(), nstep: r.b(), pe0: r.b(), protocol: 0 };
    for (let i = 0; i < o.nengines && r.i < a.length; i++) r.s();
    if (r.i < a.length) r.b();                       /* NTRK */
    if (r.i < a.length) o.protocol = r.b();
    return o;
  }
  async function info(link) {
    return parseInfo(await link.request(CMD.INFO, [], { timeout: 1000, retries: 2 }));
  }
  /* a project object starts "FUN4" .. "FUN6" (low byte first); 0 when it is not a project */
  const bkProjFormat = (d) => (d && d.length >= 4 && d[1] === 0x4E && d[2] === 0x55 && d[3] === 0x46 ? d[0] - 0x30 : 0);
  /* the newest project format a device reads, from its INFO (SLOOP 2.6 has 71 parameters) */
  const bkDevFormat = (nfo) => (nfo && nfo.pcount >= 71 ? 6 : nfo && nfo.pcount >= 61 ? 5 : 4);
  /* "SLOOP 2.6" is at least 2.5.1, the firmware whose backups may predate the MIDI map object */
  const bkFwAtLeast = (v, want) => {
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || ""));
    if (!m) return false;
    const a = [+m[1], +m[2], +(m[3] || 0)];
    for (let i = 0; i < 3; i++) if (a[i] !== want[i]) return a[i] > want[i];
    return true;
  };

  async function smpInfo(link) {
    const a = await link.request(CMD.SMP_INFO, [], { timeout: 2000, retries: 0 });
    const r = new Reader(a);
    const o = { nslots: r.b(), slotKiB: r.b(), slots: [] };
    for (let i = 0; i < o.nslots; i++) o.slots.push({ zones: r.b(), name: r.s(), kib: r.b() });
    return o;
  }
  async function smpUpload(link, slot, hdr, data, progress) {
    let a = await link.request(CMD.SMP_BEGIN, [slot & 0x7F], { timeout: 1000, retries: 0 });
    if (a[1]) throw new Error("begin rc " + a[1]);
    for (let off = 0; off < data.length; off += 256) {
      const chunk = data.subarray(off, off + 256);
      const at = SMP.DATA_OFF + off;
      a = await link.request(CMD.SMP_WRITE,
        [slot & 0x7F, at & 0x7F, (at >> 7) & 0x7F, (at >> 14) & 0x7F, ...pack7(chunk)],
        { timeout: 1000, retries: 1 });
      if (a[4]) throw new Error("write rc " + a[4]);
      if (progress) progress(off + chunk.length, data.length);
    }
    a = await link.request(CMD.SMP_END, [slot & 0x7F, ...pack7(hdr)], { timeout: 2000, retries: 0 });
    if (a[1]) throw new Error("end rc " + a[1]);
    return true;
  }
  async function smpErase(link, slot) {
    const a = await link.request(CMD.SMP_ERASE, [slot & 0x7F], { timeout: 2500, retries: 0 });
    if (a[1]) throw new Error("erase rc " + a[1]);
    return true;
  }

  async function project(link, op, slot) {
    const a = await link.request(CMD.PROJECT, [op & 0x7F, slot & 3], { timeout: 4000, retries: 0 });
    const r = new Reader(a);
    return { op: r.b(), slot: r.b(), used: r.b(), busy: a.length > 3 && a[3] === 1 };
  }
  function live(link, op, ...args) {
    return link.request(CMD.LIVE, [op & 0x7F, ...(args.length ? args : [0]).map((x) => x & 0x7F)],
      { timeout: 800, retries: 0 });
  }

  /* a full backup: every object the FM-1 lists, in 256-byte reads, CRC checked */
  async function backupCapture(link, progress) {
    const L = parseList(await link.request(CMD.BK_LIST, [], { timeout: 5000, retries: 0 }));
    if (L.rc) throw new Error("list rc " + L.rc);
    const total = L.items.reduce((s, it) => s + it.len, 0);
    const objects = [];
    let done = 0;
    for (const it of L.items) {
      const data = new Uint8Array(it.len);
      for (let off = 0; off < it.len; off += 256) {
        const n = Math.min(256, it.len - off);
        const g = parseGet(await link.request(CMD.BK_GET,
          [it.id, ...u35enc(off), n & 0x7F, (n >> 7) & 0x7F], { timeout: 1500, retries: 2 }));
        if (g.rc) throw new Error("get " + it.id + "+" + off + " rc " + g.rc);
        data.set(g.data, off);
        done += n;
        if (progress) progress(done, total);
      }
      if (crc32(data) !== it.crc) throw new Error("object " + it.id + " CRC");
      objects.push({ id: it.id, len: it.len, crc: it.crc, data: b64(data) });
    }
    return { format: "sloop-backup", version: 1, date: new Date().toISOString(), objects };
  }
  async function backupRestore(link, file, progress) {
    const SAMPLES = [32, 33, 34, 35];
    const RESTORE = [6, 7, 8, 9, 10, 11, 2, 3, 4, 5, 0, 1];
    const m = new Map();
    for (const o of file.objects || []) {
      const d = unb64(o.data || "");
      if (![...RESTORE, ...SAMPLES].includes(o.id)) throw new Error("object " + o.id + " unknown");
      if (d.length !== o.len || crc32(d) !== (o.crc >>> 0)) throw new Error("object " + o.id + " damaged");
      m.set(o.id, d);
    }
    if (!m.has(0) || !m.has(1)) throw new Error("incomplete backup");
    // Refuse a backup made by a newer firmware before anything is written (upstream does the same).
    const nfo = await info(link);
    const newest = Math.max(0, ...[0, 2, 3, 4, 5].filter((id) => m.has(id)).map((id) => bkProjFormat(m.get(id))));
    if (newest > bkDevFormat(nfo)) throw new Error("backup format " + newest + " > device " + bkDevFormat(nfo));
    // A pre-2.6 backup has no MIDI map; upstream restores it to the defaults instead of leaving today's.
    if (!m.has(10) && bkFwAtLeast(file.firmware, [2, 5, 1])) {
      const d = new Uint8Array(40);
      d.set([1, 2, 3, 10, 2], 32);
      m.set(10, d);
    }
    let done = 0;
    const total = [...m.values()].reduce((s, d) => s + d.length, 0) || 1;
    for (const id of RESTORE) {
      if (!m.has(id)) continue;
      try {
        await writeObject(link, id, m.get(id));
      } catch (e) {
        // A device before v9/v10/v11 has no object 8/9/10/11: its begin answers rc 5 (or rc 1). Skip it.
        if ([8, 9, 10, 11].includes(id) && /begin rc [15]/.test(e.message)) continue;
        throw e;
      }
      done += m.get(id).length;
      if (progress) progress(done, total);
    }
    // The samples are not backup objects: they go through SMP (header + packed ADPCM), as upstream.
    for (const id of SAMPLES) {
      if (!m.has(id)) continue;
      const k = id - 32, d = m.get(id);
      if (!d.length) { await smpErase(link, k); continue; }
      // subarray clamps: a header-only object uploads no audio and keeps the header, as upstream does.
      const data = d.subarray(SMP.DATA_OFF);
      await smpUpload(link, k, d.subarray(0, SMP.HDR_LEN), data, (n) => {
        if (progress) progress(done + n, total);
      });
      done += data.length;
      if (progress) progress(done, total);
    }
    return true;
  }

  /* one object, read whole from a BK_LIST item (the list already carries its length and CRC) */
  async function readItem(link, it) {
    // BK_GET takes at most 256 bytes per reply; a sample slot can be 80 KiB (a theme is 40 bytes).
    const data = new Uint8Array(it.len);
    for (let off = 0; off < it.len; off += 256) {
      const n = Math.min(256, it.len - off);
      const g = parseGet(await link.request(CMD.BK_GET,
        [it.id, ...u35enc(off), n & 0x7F, (n >> 7) & 0x7F], { timeout: 1500, retries: 2 }));
      if (g.rc) throw new Error("get " + it.id + "+" + off + " rc " + g.rc);
      if (g.data.length !== n) throw new Error("get " + it.id + "+" + off + ": " + g.data.length + " bytes");
      data.set(g.data, off);
    }
    if (crc32(data) !== (it.crc >>> 0)) throw new Error("object " + it.id + " CRC");
    return data;
  }
  async function readObject(link, id) {
    const L = parseList(await link.request(CMD.BK_LIST, [], { timeout: 5000, retries: 0 }));
    if (L.rc) throw new Error("list rc " + L.rc);
    const it = L.items.find((x) => x.id === id);
    if (!it) return null;
    return readItem(link, it);
  }
  async function writeObject(link, id, bytes) {
    bytes = Uint8Array.from(bytes);
    let r = parsePut(await link.request(CMD.BK_PUT,
      [0, id, ...u35enc(bytes.length), ...u35enc(crc32(bytes))], { timeout: 1500, retries: 1 }));
    if (r.rc) throw new Error("begin rc " + r.rc);
    for (let off = 0; off < bytes.length; off += 256) {
      r = parsePut(await link.request(CMD.BK_PUT,
        [1, id, ...u35enc(off), ...pack7(bytes.subarray(off, off + 256))], { timeout: 1500, retries: 1 }));
      if (r.rc) throw new Error("data rc " + r.rc);
    }
    r = parsePut(await link.request(CMD.BK_PUT, [2, id], { timeout: 5000, retries: 0 }));
    if (r.rc) throw new Error("commit rc " + r.rc);
  }

  /* ---- songs as one file (SLOOP 2.7): format "sloop-song" ----
     {format, version, name, firmware, date, order: base64(36) | null,
      objects: [{id, len, crc, data: base64}],
      samples?: [{id, len, crc, data: base64}]}   ids: 0 the loop, 2..5 sections A-D; 32..35 USR1-4.
     `samples` is a Consort extension and is absent from a canonical upstream export. Keeping it out of
     `objects` is what lets the upstream editor load the file (it ignores unknown top-level keys). */
  function songObjects(file) {
    if (!file || file.format !== SONGF.FORMAT || !(file.version >= 1) || !Array.isArray(file.objects))
      throw new Error("not a SLOOP song");
    const m = new Map();
    for (const o of file.objects) {
      const d = unb64(o.data || "");
      if (!(o.id === 0 || SONGF.SECS.includes(o.id))) throw new Error("object " + o.id + " unknown");
      if (d.length !== o.len || crc32(d) !== (o.crc >>> 0)) throw new Error("object " + o.id + " damaged");
      m.set(o.id, d);
    }
    if (!m.has(0)) throw new Error("no loop");
    const order = file.order ? unb64(file.order) : null;
    if (order && order.length !== SONGF.ORDER_LEN) throw new Error("bad song order");
    let samples = null;
    if (file.samples != null) {
      if (!Array.isArray(file.samples)) throw new Error("samples: not a list");
      samples = new Map();
      for (const o of file.samples) {
        const d = unb64(o && o.data || "");
        if (!o || !SONGF.SAMPLES.includes(o.id)) throw new Error("sample " + (o && o.id) + " unknown");
        if (samples.has(o.id)) throw new Error("sample " + o.id + " twice");
        if (d.length !== o.len || crc32(d) !== (o.crc >>> 0)) throw new Error("sample " + o.id + " damaged");
        samples.set(o.id, d);
      }
    }
    return { objects: m, order, samples };
  }
  async function songCapture(link, name, progress, withSamples) {
    const L = parseList(await link.request(CMD.BK_LIST, [], { timeout: 5000, retries: 0 }));
    if (L.rc) throw new Error("list rc " + L.rc);
    const items = L.items.filter((it) => it.id === 0 || it.id === 1
      || (SONGF.SECS.includes(it.id) && it.len)
      || (withSamples && SONGF.SAMPLES.includes(it.id)));
    // A slot the firmware does not list is an empty slot; record it so loading the file clears it.
    if (withSamples) for (const id of SONGF.SAMPLES) {
      if (!items.some((it) => it.id === id)) items.push({ id, len: 0, crc: 0 });
    }
    const total = items.reduce((s, it) => s + it.len, 0) || 1, objects = [], samples = [];
    let done = 0, order = null;
    for (const it of items) {
      const d = it.len ? await readItem(link, it) : new Uint8Array(0);
      done += it.len;
      if (progress) progress(done, total);
      if (it.id === 1) {
        // The song order lives in the settings object (arr_config_t); keep the 36 bytes, not the settings.
        if (d.length >= SONGF.ORDER_OFF + SONGF.ORDER_LEN
            && ((d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) >>> 0) === SONGF.PER3)
          order = d.slice(SONGF.ORDER_OFF, SONGF.ORDER_OFF + SONGF.ORDER_LEN);
        continue;
      }
      const o = { id: it.id, len: it.len, crc: it.crc, data: b64(d) };
      if (SONGF.SAMPLES.includes(it.id)) samples.push(o);
      else objects.push(o);
    }
    const nfo = await info(link);
    const out = { format: SONGF.FORMAT, version: SONGF.VERSION, name: String(name || "").slice(0, 40),
      firmware: nfo.version, date: new Date().toISOString(),
      order: order ? b64(order) : null, objects };
    if (withSamples) out.samples = samples;
    return out;
  }
  async function songLoad(link, file, progress) {
    const { objects: m, order, samples } = songObjects(file);
    const nfo = await info(link);
    const newest = Math.max(0, ...[...m.values()].map(bkProjFormat));
    if (newest > bkDevFormat(nfo)) throw new Error("song format " + newest + " > device " + bkDevFormat(nfo));
    const total = [...m.values()].reduce((s, d) => s + d.length, 0)
      + (samples ? [...samples.values()].reduce((s, d) => s + d.length, 0) : 0) || 1;
    let done = 0;
    const step = (n) => { done += n; if (progress) progress(done, total); };
    // The four sections first (an absent one clears that slot), then the loop, as the editor does.
    for (const id of SONGF.SECS) {
      const d = m.get(id) || new Uint8Array(0);
      await writeObject(link, id, d);
      step(d.length);
    }
    await writeObject(link, 0, m.get(0));
    step(m.get(0).length);
    if (order) {
      // Splice the song order into the device's own settings object, so its colours and calibration stay.
      const L = parseList(await link.request(CMD.BK_LIST, [], { timeout: 5000, retries: 0 }));
      const it = L.rc ? null : L.items.find((x) => x.id === 1);
      if (!it) throw new Error("settings unavailable");
      const s = await readItem(link, it);
      if (s.length >= SONGF.ORDER_OFF + SONGF.ORDER_LEN
          && ((s[0] | (s[1] << 8) | (s[2] << 16) | (s[3] << 24)) >>> 0) === SONGF.PER3) {
        s.set(order, SONGF.ORDER_OFF);
        await writeObject(link, 1, s);
      }
    }
    // Samples last: the song is already on the machine if a slot write fails. Compare CRCs first, so
    // loading a song whose slots did not change does not rewrite the flash.
    if (samples && samples.size) {
      let list;
      try {
        const L = parseList(await link.request(CMD.BK_LIST, [], { timeout: 5000, retries: 0 }));
        if (L.rc) throw new Error("list rc " + L.rc);
        list = L.items;
      } catch (e) { e.sampleStage = true; throw e; }
      for (const id of SONGF.SAMPLES) {
        if (!samples.has(id)) continue;                 // a slot this file says nothing about stays as it is
        const d = samples.get(id), slot = id - SONGF.SAMPLES[0];
        const it = list.find((x) => x.id === id);
        try {
          if (!d.length) {
            if (it && it.len) await smpErase(link, slot);
            continue;
          }
          if (it && it.len === d.length && (it.crc >>> 0) === crc32(d)) { step(d.length); continue; }
          const data = d.subarray(SMP.DATA_OFF);
          let sent = 0;
          await smpUpload(link, slot, d.subarray(0, SMP.HDR_LEN), data, (n) => { step(n - sent); sent = n; });
          if (d.length > sent) step(d.length - sent);   // the header, or a header-only object
        } catch (e) { e.sampleStage = true; throw e; }
      }
    }
    return true;
  }
  /* The library keeps one full file (with samples). These make the shapes offered when sharing;
     the file on disk is never modified. */
  function songVariant(file, withSamples) {
    const out = {};
    for (const k of Object.keys(file)) if (k !== "samples" || withSamples) out[k] = file[k];
    return out;
  }
  function songPlaylist(file) {
    return { format: "sloop-playlist", version: 1, name: String(file.name || "").slice(0, 40),
      date: file.date || new Date().toISOString(), songs: [file] };
  }

  /* ---- themes: 40 bytes, THM2 (or 36-byte THM1) ---- */
  function rgb565(v) {
    const r = (v >> 11) & 31, gg = (v >> 5) & 63, b = v & 31;
    const h = (x) => Math.round(x).toString(16).padStart(2, "0");
    return "#" + h(r * 255 / 31) + h(gg * 255 / 63) + h(b * 255 / 31);
  }
  function decodeTheme(bytes) {
    if (!bytes || (bytes.length !== 40 && bytes.length !== 36)) return null;
    const d = Uint8Array.from(bytes), w = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const magic = w.getUint32(0, true);
    if (magic !== 0x324D4854 && magic !== 0x314D4854) return null;
    const v1 = magic === 0x314D4854;
    if (v1 ? w.getUint32(32, true) !== crc32(d.subarray(0, 32)) : w.getUint32(36, true) !== crc32(d.subarray(0, 36))) return null;
    let name = "";
    for (let i = 4; i < 12; i++) { const c = d[i]; if (!c) break; name += String.fromCharCode(c); }
    const c = [], trk = [];
    for (let k = 0; k < 5; k++) c.push(rgb565(w.getUint16(12 + 2 * k, true)));
    for (let k = 0; k < 4; k++) trk.push(rgb565(w.getUint16(22 + 2 * k, true)));
    const bg = rgb565(w.getUint16(30, true));
    const hi = v1 ? "#ffffff" : rgb565(w.getUint16(32, true));
    return { name: name.trim(), c, trk, bg, hi, bytes: Array.from(d) };
  }
  function to565(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return 0;
    const n = parseInt(m[1], 16);
    return ((Math.round(((n >> 16) & 255) * 31 / 255) & 31) << 11)
      | ((Math.round(((n >> 8) & 255) * 63 / 255) & 63) << 5)
      | (Math.round((n & 255) * 31 / 255) & 31);
  }
  function encodeTheme(t) {
    const d = new Uint8Array(40), w = new DataView(d.buffer);
    w.setUint32(0, 0x324D4854, true);
    const nm = String(t.name || "THEME").slice(0, 7).toUpperCase();
    for (let i = 0; i < nm.length; i++) d[4 + i] = nm.charCodeAt(i) & 0x7F;
    (t.c || []).slice(0, 5).forEach((x, k) => w.setUint16(12 + 2 * k, to565(x), true));
    (t.trk || []).slice(0, 4).forEach((x, k) => w.setUint16(22 + 2 * k, to565(x), true));
    w.setUint16(30, to565(t.bg || "#000000"), true);
    w.setUint16(32, to565(t.hi || "#ffffff"), true);
    w.setUint32(36, crc32(d.subarray(0, 36)), true);
    return d;
  }
  function b64(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(String(str || "").trim());
    return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  }
  function shareCode(bytes) { return "SLOOP-THEME-1:" + b64(bytes); }

  g.Sloop = {
    CMD, THEME_ID, SONGF, frame, unframe, pack7, unpack7, u35enc, crc32, Link, connect,
    parseInfo, info, bkProjFormat, bkDevFormat, bkFwAtLeast,
    readObject, writeObject, project, live, backupCapture, backupRestore, setParam, smpInfo, smpUpload, smpErase, SMP,
    songObjects, songCapture, songLoad, songVariant, songPlaylist,
    readTheme: (link) => readObject(link, THEME_ID),
    writeTheme: (link, bytes) => writeObject(link, THEME_ID, bytes),
    decodeTheme, encodeTheme, shareCode, b64, unb64
  };
})(window);
