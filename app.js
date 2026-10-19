/* Consort: the theme slice first — read the skin from the FM-1, keep it on the phone, write it back, and
   wear it in the app. Songs and samples hang off the same protocol link. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const native = !!window.ConsortMidi;
  const THEMES_KEY = "consort.themes";
  const SKIN_KEY = "consort.skin";
  let link = null;
  let current = null;                 // the theme last read from the machine
  let autoTheme = null;               // the mock device's skin
  let connRaw = null;                 // the USB MIDI port name, if it is printable ASCII
  let currentAt = 0;                  // when the machine's theme was read
  const T = (key, vars) => (window.ConsortI18n ? ConsortI18n.t(key, vars) : key);
  // USB strings arrive as Unicode; the FM-1's port is "Hügelton Instruments Felucca". The header used to
  // render it in Terminus, which has no ü and showed a placeholder, so the button now uses the system
  // monospace face and ellipsizes a long name. A descriptor that stores the ü as a literal '?' has lost
  // the byte; the known spelling is restored, and Latin-1-misread UTF-8 is repaired generically.
  function cleanPortName(name) {
    let s = String(name || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
    if (!s) return "";
    if (/[ÃÂ]/.test(s)) {
      try {
        const bytes = Uint8Array.from([...s].map((ch) => ch.charCodeAt(0) & 0xFF));
        const fixed = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (fixed.indexOf("�") < 0) s = fixed;
      } catch (e) { /* not UTF-8 misread as Latin-1 */ }
    }
    s = s.replace(/^H\?gelton/i, "Hügelton");
    return s.indexOf("�") < 0 ? s.slice(0, 48) : "";
  }

  function toastMsg(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(toastMsg.t);
    toastMsg.t = setTimeout(() => el.classList.remove("on"), 2400);
  }

  // ---- transport -----------------------------------------------------------------------------------
  // The device can answer the very first INFO frame before Sloop.connect() has returned, so incoming
  // bytes must go through transport.link: protocol.js sets that when the Link is made, while the
  // module-level `link` below is still null until the handshake completes. Routing through `link`
  // here would drop the INFO reply and make a perfectly good FM-1 look unresponsive.
  const nativeTransport = {
    send(bytes) { ConsortMidi.send(Array.from(bytes).join(",")); },
    receive(csv) {
      const l = this.link;
      if (l && csv) l.receive(csv.split(",").map(Number));
    }
  };

  function mockTransport() {
    const theme = autoTheme || (autoTheme = Sloop.encodeTheme({
      name: "NORD",
      c: ["#6f6f6f", "#5a5a5a", "#3c3c3c", "#232323", "#0d0d0d"],
      trk: ["#88c0f8", "#80f860", "#f0f078", "#f8a028"],
      bg: "#000000", hi: "#ffffff"
    }));
    const objs = [
      { id: 0, d: Uint8Array.from([1]) },
      { id: 1, d: Uint8Array.from([2]) },
      { id: Sloop.THEME_ID, d: theme }
    ];
    // Enough of a 2.7 device for the preview: INFO, DESC, TRACK and the two SETs the sampler uses
    // for "Play on track" (engine SAMPLE + SET = USRn, or KIT = USRn on the drum track).
    const ENGINES = ["ANALOG", "DIGITAL", "PHASE", "LOFI", "SAMPLE", "VOICE", "TRIO", "WHEEL", "GRAIN", "FM6", "PHYS", "NOISE"];
    const SETS = ["PIANO", "BASS", "VIBES", "HORNS", "STRGS", "FLUTE", "SCRCH", "PERC", "USR1", "USR2", "USR3", "USR4"];
    const KITS = Array.from({ length: 37 }, (_, i) => "KIT" + (i + 1));
    KITS.push("USR1", "USR2", "USR3", "USR4", "USR3+4", "SYN1", "SYN2", "SYN3", "SYN4");
    const v14 = (x) => { const u = x + 8192; return [u & 0x7F, (u >> 7) & 0x7F]; };
    const str = (s) => [...Array.from(s, (ch) => ch.charCodeAt(0)), 0];
    let selected = 0;
    const tracks = [0, 1, 3, ENGINES.length].map((engine) => ({ engine, preset: 0, level: 100, mute: 0, armed: 0, pe0: 0 }));
    const t = {
      send(bytes) {
        const f = Sloop.unframe(bytes);
        if (!f) return;
        const reply = (args) => setTimeout(() => t.link && t.link.receive(Sloop.frame(f.cmd, args)), 25);
        if (f.cmd === Sloop.CMD.INFO) {
          reply([...str("SLOOP 2.7"), ENGINES.length, 71, 45, 16, 63,
            ...ENGINES.flatMap(str), 4, 5]);
        } else if (f.cmd === Sloop.CMD.PROJECT) reply([f.a[0], f.a[1], f.a[1] < 2 ? 1 : 0]);
        else if (f.cmd === Sloop.CMD.LIVE) reply([f.a[0]]);
        else if (f.cmd === Sloop.CMD.SET) {
          const scope = f.a[0], id = f.a[1], val = (f.a[2] | (f.a[3] << 7)) - 8192;
          if (scope === 1 && id === 20) tracks[selected].engine = val;
          else if (scope === 0 && id === 63) tracks[selected].pe0 = val;
          reply([scope, id, f.a[2], f.a[3]]);
        } else if (f.cmd === Sloop.CMD.DESC) {
          const scope = f.a[0], id = f.a[1];
          let label = "PARAM", names = [];
          if (scope === 1 && id === 20) { label = "ENG"; names = ENGINES; }
          else if (scope === 0 && id === 63) {
            if (selected === 3) { label = "KIT"; names = KITS; }
            else if (tracks[selected].engine === 4) { label = "SET"; names = SETS; }
          }
          reply([scope, id, names.length ? 8 : 0, ...v14(0), ...v14(Math.max(0, names.length - 1)), ...v14(0),
            ...str(label), ...str(""), ...names.flatMap(str)]);
        } else if (f.cmd === Sloop.CMD.TRACK) {
          if (f.a.length) selected = f.a[0] & 3;
          const a = [selected, tracks.length];
          for (const tr of tracks) a.push(tr.engine, tr.preset, ...v14(tr.level), tr.mute, tr.armed);
          reply(a);
        } else if (f.cmd === Sloop.CMD.TRACK_PARAM) {
          const trk = f.a[0] & 3, id = f.a[1];
          if (f.a.length > 2 && id === 63) tracks[trk].pe0 = (f.a[2] | (f.a[3] << 7)) - 8192;
          reply([trk, id, ...v14(id === 63 ? tracks[trk].pe0 : 0)]);
        }
        else if (f.cmd === Sloop.CMD.SMP_INFO) {
          const a = [4, 80];
          for (let i = 0; i < 4; i++) a.push(0, 0, 0);
          reply(a);
        } else if (f.cmd === Sloop.CMD.SMP_BEGIN || f.cmd === Sloop.CMD.SMP_END || f.cmd === Sloop.CMD.SMP_ERASE) reply([f.a[0], 0]);
        else if (f.cmd === Sloop.CMD.SMP_WRITE) reply([f.a[0], f.a[1], f.a[2], f.a[3], 0]);
        else if (f.cmd === Sloop.CMD.BK_LIST) {
          const a = [0, objs.length];
          for (const o of objs) a.push(o.id, ...Sloop.u35enc(o.d.length), ...Sloop.u35enc(Sloop.crc32(o.d)));
          reply(a);
        } else if (f.cmd === Sloop.CMD.BK_GET) {
          const o = objs.find((x) => x.id === f.a[0]);
          if (!o) { reply([f.a[0], 5]); return; }
          reply([o.id, 0, ...Sloop.u35enc(0), o.d.length & 0x7F, (o.d.length >> 7) & 0x7F, ...Sloop.pack7(o.d)]);
        } else if (f.cmd === Sloop.CMD.BK_PUT) reply([f.a[0], f.a[1], 0]);
      }
    };
    return t;
  }

  function setConn(on, label) {
    const el = document.querySelector(".conn");
    if (!el) return;
    el.innerHTML = "<i></i><span></span>";
    const text = el.querySelector("span");
    if (text) text.textContent = on ? (label || T("conn.on")) : T("conn.off");
    el.classList.toggle("off", !on);
    paintPills();
  }

  function paintPills() {
    const on = !!link;
    for (const id of ["song-pill", "theme-pill"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.textContent = on ? T("songs.connectedPill") : T("songs.offlinePill");
      el.classList.toggle("off", !on);
    }
  }

  async function start(transport, label) {
    try {
      link = await Sloop.connect(transport);
      connRaw = label || "";
      const port = cleanPortName(connRaw);
      setConn(true, port || T("conn.on"));
      toastMsg(port ? T("conn.connectedTo", { name: port }) : T("conn.on"));
      refreshSections();
      renderSongs();
      if (window.ConsortSamples) window.ConsortSamples.refresh();
    } catch (e) {
      link = null;
      connRaw = null;
      setConn(false);
      toastMsg(T("conn.noReply"));
    }
  }

  setConn(false);                     // localized "not connected" before the first MIDI callback
  if (native) {
    window.__consortOpened = (ok, name, why) => {
      if (!ok) {
        setConn(false);
        toastMsg(why ? T("conn.fail", { why }) : T("conn.noReply"));
        return;
      }
      start(nativeTransport, name || "FM-1");
    };
    window.__consortIn = (csv) => { nativeTransport.receive(csv); };
    window.__consortLost = () => {
      nativeTransport.link = null;
      link = null;
      connRaw = null;
      setConn(false);
    };
    try { ConsortMidi.connect(); } catch (e) { /* no bridge */ }
  } else {
    setTimeout(() => start(mockTransport(), "FM-1 (mock)"), 250);
  }

  document.querySelector(".conn").addEventListener("click", () => {
    if (link) return;
    if (native) ConsortMidi.connect();
    else start(mockTransport(), "FM-1 (mock)");
  });

  // ---- storage -------------------------------------------------------------------------------------
  function loadThemes() {
    try { return JSON.parse(localStorage.getItem(THEMES_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveThemes(list) {
    try { localStorage.setItem(THEMES_KEY, JSON.stringify(list)); } catch (e) { toastMsg(T("storage.fail")); }
  }
  function when(ms) {
    const d = new Date(ms);
    const p = (n) => (n < 10 ? "0" : "") + n;
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  window.ConsortApp = { get link() { return link; }, toast: toastMsg, when: when };

  // ---- skin ----------------------------------------------------------------------------------------
  function rgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return [0, 0, 0];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function hex(c) { return "#" + c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join(""); }
  function mix(a, b, t) {
    const x = rgb(a), y = rgb(b);
    return hex(x.map((v, i) => v + (y[i] - v) * t));
  }
  function lum(hexColor) {
    const [r, g, b] = rgb(hexColor).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function brightest(list) {
    return list.slice().sort((a, b) => lum(b) - lum(a))[0] || "#e8e8e8";
  }
  // WCAG contrast ratio. The FM-1 themes were made for a tiny OLED, not for this app's 10–20 px text:
  // NORD's lightest UI colour is #6f6f6f on black (4.4:1), and its 50 % mix is unreadable. So the skin
  // derives its text colours from the theme but lifts them toward white/black until they pass.
  function contrast(a, b) {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function towardContrast(base, bg, min, target) {
    let out = base;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      out = mix(base, target, t);
      if (contrast(out, bg) >= min) return out;
    }
    return target;
  }
  function applySkin(t) {
    const root = document.documentElement;
    const bg = t.bg || "#0b0b0b";
    const target = contrast("#ffffff", bg) >= contrast("#000000", bg) ? "#ffffff" : "#000000";
    const base = brightest([(t.c && t.c[0]) || t.hi || "#ffffff", t.hi || "#ffffff"]);
    const fg = towardContrast(base, bg, 7, target);                 // body/button text
    const fg2 = towardContrast(mix(bg, fg, 0.72), bg, 5.5, fg);    // body copy
    const dim = towardContrast(mix(bg, fg, 0.45), bg, 4.5, fg);    // hints and labels
    let acc = t.hi || "#ffffff";
    if (contrast(acc, bg) < 4.5) {
      const options = [...(t.trk || []), ...(t.c || []), target];
      acc = options.slice().sort((a, b) => contrast(b, bg) - contrast(a, bg))[0];
      acc = towardContrast(acc, bg, 4.5, target);
    }
    const ink = contrast("#000000", acc) >= contrast("#ffffff", acc) ? "#000000" : "#ffffff";
    const trk = (t.trk || []).map((c) => (contrast(c, bg) >= 4 ? c : towardContrast(c, bg, 4, fg)));
    const v = {
      "--bg": bg, "--fg": fg, "--fg2": fg2,
      "--s1": mix(bg, fg, 0.06), "--s2": mix(bg, fg, 0.12), "--s3": mix(bg, fg, 0.24),
      "--card": mix(bg, fg, 0.06), "--card2": mix(bg, fg, 0.12),
      "--btn": mix(bg, fg, 0.12), "--line": mix(bg, fg, 0.16),
      "--dim": dim, "--nav": mix(bg, fg, 0.04),
      "--wave": mix(bg, fg, 0.05),
      "--acc": acc, "--ink": ink,
      "--t1": trk[0] || fg, "--t2": trk[1] || fg, "--t3": trk[2] || fg, "--t4": trk[3] || fg
    };
    for (const k in v) if (v[k]) root.style.setProperty(k, v[k]);
    const name = document.getElementById("skinName");
    if (name) name.textContent = "FM-1 companion · " + (t.name || "THEME");
  }
  try {
    const saved = JSON.parse(localStorage.getItem(SKIN_KEY) || "null");
    if (saved) applySkin(saved);
  } catch (e) { /* no skin */ }

  // ---- the theme page ------------------------------------------------------------------------------
  function swatches(t) {
    const box = document.createElement("div");
    box.className = "swatches";
    for (const c of [...t.c, t.bg, ...t.trk]) {
      const i = document.createElement("i");
      i.className = "sw";
      i.style.background = c;
      box.appendChild(i);
    }
    return box;
  }

  function renderCurrent(t) {
    const name = document.getElementById("cur-name");
    const whenEl = document.getElementById("cur-when");
    const box = document.getElementById("cur-sw");
    if (name) name.textContent = t.name || T("theme.unnamed");
    if (whenEl) whenEl.textContent = T("theme.readAt", { when: when(currentAt || Date.now()) });
    if (box) {
      box.replaceChildren();
      for (const c of [...t.c, t.bg, ...t.trk]) {
        const i = document.createElement("i");
        i.className = "sw";
        i.style.background = c;
        box.appendChild(i);
      }
    }
  }

  async function readCurrent() {
    if (!link) { toastMsg(T("needConnect")); return; }
    try {
      const bytes = await Sloop.readTheme(link);
      if (!bytes || !bytes.length) { toastMsg(T("theme.readNone")); return; }
      const t = Sloop.decodeTheme(bytes);
      if (!t) { toastMsg(T("theme.readBad")); return; }
      current = t;
      currentAt = Date.now();
      renderCurrent(t);
      toastMsg(T("theme.readDone", { name: t.name || T("theme.unnamed") }));
    } catch (e) {
      toastMsg(T("theme.readFail", { err: e.message }));
    }
  }

  function saveCurrent() {
    if (!current) { toastMsg(T("theme.needRead")); return; }
    const list = loadThemes();
    list.unshift({ name: current.name || "THEME", when: Date.now(), bytes: current.bytes });
    saveThemes(list);
    renderPhoneThemes();
    toastMsg(T("theme.saved", { name: current.name || "THEME" }));
  }

  async function applyTheme(item, index) {
    const t = Sloop.decodeTheme(item.bytes);
    if (!t) { toastMsg(T("theme.bad")); return; }
    const dev = document.querySelector('[data-opt="dev"]').checked;
    const app = document.querySelector('[data-opt="app"]').checked;
    if (app) {
      applySkin(t);
      try { localStorage.setItem(SKIN_KEY, JSON.stringify(t)); } catch (e) { /* no storage */ }
    }
    if (dev) {
      if (!link) { toastMsg(app ? T("theme.skinOnlyNoConn") : T("needConnect")); return; }
      try {
        await Sloop.writeTheme(link, Uint8Array.from(item.bytes));
        toastMsg(app ? T("theme.writtenSkin") : T("theme.written"));
      } catch (e) {
        toastMsg(app ? T("theme.writeFailSkin", { err: e.message }) : T("theme.writeFail", { err: e.message }));
      }
    } else {
      toastMsg(app ? T("theme.skinChanged", { name: t.name || "" }) : T("theme.noAction"));
    }
  }

  function shareTheme(item) {
    const code = Sloop.shareCode(item.bytes);
    const done = () => toastMsg(T("theme.codeCopied"));
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, () => prompt(T("theme.code"), code));
    else prompt(T("theme.code"), code);
  }

  function deleteTheme(index) {
    const list = loadThemes();
    const item = list[index];
    if (!item) return;
    if (!confirm(T("theme.deleteConfirm", { name: item.name }))) return;
    list.splice(index, 1);
    saveThemes(list);
    renderPhoneThemes();
    toastMsg(T("theme.deleted", { name: item.name }));
  }

  function openMenu(item, index, anchor) {
    const back = document.createElement("div");
    back.className = "consort-back";
    const sheet = document.createElement("div");
    sheet.className = "consort-sheet";
    const b1 = document.createElement("button");
    b1.textContent = T("theme.shareCode");
    b1.addEventListener("click", () => { back.remove(); shareTheme(item); });
    const b2 = document.createElement("button");
    b2.textContent = T("menu.delete");
    b2.className = "danger";
    b2.addEventListener("click", () => { back.remove(); deleteTheme(index); });
    const b3 = document.createElement("button");
    b3.textContent = T("menu.cancel");
    b3.addEventListener("click", () => back.remove());
    sheet.append(b1, b2, b3);
    back.appendChild(sheet);
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
  }

  function renderPhoneThemes() {
    const box = document.getElementById("phone-themes");
    const empty = document.getElementById("phone-empty");
    if (!box) return;
    const list = loadThemes();
    box.replaceChildren();
    if (empty) empty.style.display = list.length ? "none" : "";
    list.forEach((item, index) => {
      const t = Sloop.decodeTheme(item.bytes);
      const row = document.createElement("div");
      row.className = "themerow";
      const sw = document.createElement("div");
      sw.className = "swatches";
      if (t) for (const c of [t.c[0], t.c[2], t.c[4], t.trk[0]]) {
        const i = document.createElement("i");
        i.className = "sw";
        i.style.background = c;
        sw.appendChild(i);
      }
      const info = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = item.name || "THEME";
      const s = document.createElement("span");
      s.textContent = when(item.when) + " · " + T("theme.onPhone");
      info.append(b, s);
      const acts = document.createElement("div");
      acts.className = "row";
      acts.style.marginLeft = "auto";
      acts.style.gap = "6px";
      const apply = document.createElement("button");
      apply.className = "mini";
      apply.textContent = T("theme.apply");
      apply.addEventListener("click", () => applyTheme(item, index));
      const more = document.createElement("button");
      more.className = "mini";
      more.textContent = "⋯";
      more.addEventListener("click", () => openMenu(item, index, more));
      acts.append(apply, more);
      row.append(sw, info, acts);
      box.appendChild(row);
    });
  }

  function importCode() {
    const raw = prompt(T("theme.importAsk"));
    if (!raw) return;
    const code = raw.trim().replace(/^SLOOP-THEME-1:/i, "");
    try {
      const bytes = Sloop.unb64(code);
      const t = Sloop.decodeTheme(bytes);
      if (!t) { toastMsg(T("theme.importBad")); return; }
      const list = loadThemes();
      list.unshift({ name: t.name || "THEME", when: Date.now(), bytes: Array.from(bytes) });
      saveThemes(list);
      renderPhoneThemes();
      toastMsg(T("theme.importDone", { name: t.name || "THEME" }));
    } catch (e) { toastMsg(T("theme.importFail")); }
  }

  // ---- FX: punch-in while held (LIVE op 3) ------------------------------------------------------
  let fxHeld = -1;
  function fxRelease() {
    if (fxHeld < 0) return;
    const el = document.querySelector('.fx[data-fx="' + fxHeld + '"]');
    if (el) el.classList.remove("on");
    if (link) Sloop.live(link, 3, fxHeld, 0).catch(() => {});
    fxHeld = -1;
  }
  document.querySelectorAll(".fx[data-fx]").forEach((b) => {
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (!link) { toastMsg(T("needConnect")); return; }
      if (fxHeld >= 0) fxRelease();
      fxHeld = +b.dataset.fx;
      b.classList.add("on");
      Sloop.live(link, 3, fxHeld, 1).catch(() => {});
    });
  });
  document.addEventListener("pointerup", fxRelease);
  document.addEventListener("pointercancel", fxRelease);

  // the master effects: global parameters (SET scope 1); the engine's own ids: FILT 29, DUST 27, DUCK 28
  [["fx-filter", 29], ["fx-dust", 27], ["fx-duck", 28]].forEach(([id, gid]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const out = el.parentElement.querySelector("output");
    const show = () => { if (out) out.textContent = el.value; };
    el.addEventListener("input", show);
    el.addEventListener("change", () => {
      if (!link) { toastMsg(T("needConnect")); return; }
      Sloop.setParam(link, 1, gid, +el.value).catch(() => {});
    });
    show();
  });

  // ---- songs: the section slots and a backup on the phone ------------------------------------------
  async function refreshSections() {
    const el = document.getElementById("song-status");
    if (!el) return;
    paintPills();
    if (!link) { el.textContent = T("songs.notConnected"); return; }
    try {
      const u = [];
      for (let k = 0; k < 4; k++) u.push((await Sloop.project(link, 2, k)).used);
      el.textContent = ["A", "B", "C", "D"].map((s, i) => s + " " + (u[i] ? T("songs.used") : T("songs.free"))).join(" · ");
    } catch (e) { el.textContent = T("songs.readFail"); }
  }
  // The phone's song library. A file can be a .sloopsong (loop + A-D + order), a .sloopset
  // (playlist), a full SLOOP-backup JSON, or another JSON. All of them are managed here: open,
  // load/restore, share, rename, delete; files found outside Download/SLOOP can be imported.
  let songFilter = "all";
  function fileKind(name) {
    if (/\.sloopsong$/i.test(name)) return "song";
    if (/\.sloopset$/i.test(name)) return "set";
    if (/^SLOOP-backup-.*\.json$/i.test(name)) return "backup";
    if (/\.json$/i.test(name)) return "file";
    return "other";
  }
  const KIND = { song: "SONG", set: "SET", backup: "BACKUP", file: "JSON", other: "FILE" };
  function bytes(n) {
    n = +n || 0;
    return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
  }
  function library() {
    if (!window.ConsortFiles) return [];
    try {
      return JSON.parse(ConsortFiles.list())
        .filter((f) => f && /\.(sloopsong|sloopset|json)$/i.test(f.name || ""))
        .map((f) => ({ ...f, kind: fileKind(f.name), managed: f.managed !== false, path: f.path || "Download/SLOOP/" }))
        .sort((a, b) => (b.date || 0) - (a.date || 0));
    } catch (e) { return []; }
  }
  function libraryJson(f) {
    if (!window.ConsortFiles) throw new Error(T("songs.previewOnly"));
    const text = ConsortFiles.readText(f.name, f.path || "");
    if (text == null || text === "") throw new Error(T("songs.readFail", { name: f.name }));
    return JSON.parse(text);
  }
  function friendly(e, key) {
    if (e && e.sampleStage) return T("songs.loadSamplesFail", { err: e.message || String(e) });
    if (/(^|\s)rc 3$|commit rc 3/.test(e && e.message ? e.message : "")) return T("songs.stopFirst");
    return T(key, { err: e && e.message ? e.message : String(e) });
  }
  function sheet(buttons) {
    const back = document.createElement("div");
    back.className = "consort-back";
    const box = document.createElement("div");
    box.className = "consort-sheet";
    box.append(...buttons);
    back.appendChild(box);
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
    return back;
  }
  function sbtn(label, fn, danger) {
    const b = document.createElement("button");
    b.textContent = label;
    if (danger) b.className = "danger";
    b.addEventListener("click", () => { b.closest(".consort-back").remove(); fn(); });
    return b;
  }
  function detailsBox(f) {
    const box = document.createElement("div");
    box.className = "sheetinfo";
    const rows = [
      [T("songs.name"), f.name],
      [T("songs.type"), KIND[f.kind] || "FILE"],
      [T("songs.size"), bytes(f.size)],
      [T("songs.date"), f.date ? when(f.date * 1000) : "—"],
      [T("songs.location"), (f.path || "").replace(/\/$/, "")]
    ];
    let data = null;
    try { data = libraryJson(f); } catch (e) { /* unreadable or not JSON: the basics still show */ }
    if (data && data.format === "sloop-song") {
      rows.push([T("songs.songName"), data.name || "—"]);
      rows.push([T("songs.firmware"), data.firmware || "—"]);
      rows.push([T("songs.sections"), String((data.objects || []).filter((o) => o.id !== 0).length) + " / 4"]);
      rows.push([T("songs.order"), data.order ? T("songs.yes") : T("songs.no")]);
      rows.push([T("songs.samples"), Array.isArray(data.samples) && data.samples.length ? "USR1–4" : T("songs.no")]);
    } else if (data && data.format === "sloop-backup") {
      rows.push([T("songs.firmware"), data.firmware || "—"]);
      rows.push([T("songs.objects"), String((data.objects || []).length)]);
      rows.push([T("songs.samples"), (data.objects || []).some((o) => o.id >= 32 && o.id <= 35) ? T("songs.yes") : T("songs.no")]);
    } else if (data && data.format === "sloop-playlist") {
      rows.push([T("songs.playlist"), T("songs.playlistCount", { n: (data.songs || []).length })]);
    } else if (data && data.format) {
      rows.push([T("songs.format"), String(data.format)]);
    }
    for (const [k, v] of rows) {
      const line = document.createElement("div");
      line.className = "sheetrow";
      const a = document.createElement("span");
      a.textContent = k;
      const b = document.createElement("b");
      b.textContent = v;
      line.append(a, b);
      box.appendChild(line);
    }
    return box;
  }
  function shareFile(f) {
    if (!window.ConsortFiles) { toastMsg(T("songs.previewOnly")); return; }
    try { ConsortFiles.shareAt(f.name, f.path || ""); }
    catch (e) { toastMsg(T("songs.shareFail", { name: f.name })); }
  }
  function shareVariant(f, data, ext) {
    const base = String(f.name || data.name || "SONG").replace(/\.(sloopsong|sloopset|json)$/i, "")
      .replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 40) || "SONG";
    const name = base + "." + ext;
    if (!window.ConsortFiles || !ConsortFiles.shareText) { toastMsg(T("songs.previewOnly")); return; }
    let ok = false;
    try { ok = ConsortFiles.shareText(name, JSON.stringify(data), "application/json"); }
    catch (e) { ok = false; }
    if (!ok) toastMsg(T("songs.shareFail", { name }));
  }
  // The library keeps the full file (song + samples). Sharing offers the shapes another app may want;
  // the file on disk stays as it is.
  function shareSong(f) {
    let file;
    try { file = libraryJson(f); Sloop.songObjects(file); }
    catch (e) { toastMsg(T("songs.loadBad", { err: e.message })); return; }
    const hasSamples = Array.isArray(file.samples) && file.samples.length > 0;
    const cap = document.createElement("p");
    cap.className = "hint";
    cap.style.margin = "2px 4px 8px";
    cap.textContent = T("songs.exportSamplesHint");
    const btns = [
      sbtn(T("songs.exportOnly"), () => shareVariant(f, Sloop.songVariant(file, false), "sloopsong"))
    ];
    if (hasSamples) btns.push(sbtn(T("songs.exportSamples"), () => shareVariant(f, Sloop.songVariant(file, true), "sloopsong")));
    btns.push(sbtn(T("songs.sharePlaylist"), () => shareVariant(f, Sloop.songPlaylist(file), "sloopset")));
    btns.push(sbtn(T("menu.cancel"), () => {}));
    const back = sheet(btns);
    back.querySelector(".consort-sheet").prepend(cap);
  }
  function renameFile(f) {
    const to = prompt(T("menu.newName"), f.name);
    if (!to || to === f.name) return;
    let ok = false;
    if (window.ConsortFiles) {
      try { ok = ConsortFiles.renameAt(f.name, f.path || "", to); } catch (e) { ok = false; }
    }
    if (!ok) { toastMsg(T("file.renameFail", { name: f.name })); return; }
    renderSongs();
  }
  function deleteFile(f) {
    if (!confirm(T("deleteConfirm", { name: f.name }))) return;
    let ok = false;
    if (window.ConsortFiles) {
      try { ok = ConsortFiles.deleteAt(f.name, f.path || ""); } catch (e) { ok = false; }
    }
    if (!ok) { toastMsg(T("file.deleteFail", { name: f.name })); return; }
    renderSongs();
    toastMsg(T("deleted", { name: f.name }));
  }
  function importFile(f) {
    let name = null;
    if (window.ConsortFiles) {
      try { name = ConsortFiles.importToLibrary(f.name, f.path || ""); } catch (e) { name = null; }
    }
    // Another app's download may not be readable in place; the system picker grants access for one read.
    if (!name) { toastMsg(T("songs.importFail", { err: f.name })); importSong(); return; }
    renderSongs();
    toastMsg(T("songs.importedToLibrary", { name }));
  }
  function openFile(f) {
    if (!window.ConsortFiles) { toastMsg(T("songs.previewOnly")); return; }
    try { ConsortFiles.openWith(f.name, f.path || ""); }
    catch (e) { toastMsg(T("songs.openFail", { name: f.name })); }
  }
  async function loadSong(f) {
    if (!link) { toastMsg(T("needConnect")); return; }
    let file, parsed;
    try {
      file = libraryJson(f);
      parsed = Sloop.songObjects(file);
    } catch (e) { toastMsg(T("songs.loadBad", { err: e.message })); return; }
    const hasSamples = !!(parsed.samples && parsed.samples.size);
    if (!confirm(T(hasSamples ? "songs.loadConfirmSamples" : "songs.loadConfirm",
      { name: file.name || f.name }))) return;
    toastMsg(T("songs.loading", { pct: 0 }));
    try {
      await Sloop.songLoad(link, file, (d, t) => toastMsg(T("songs.loading", { pct: Math.round(d / t * 100) })));
      toastMsg(T("songs.loaded", { name: file.name || f.name }));
      refreshSections();
    } catch (e) { toastMsg(friendly(e, "songs.loadFail")); }
  }
  async function restorePhoneBackup(f) {
    if (!link) { toastMsg(T("needConnect")); return; }
    let file;
    try { file = libraryJson(f); }
    catch (e) { toastMsg(T("songs.restoreFileBad")); return; }
    if (!file || file.format !== "sloop-backup" || !Array.isArray(file.objects)) {
      toastMsg(T("songs.notBackup"));
      return;
    }
    if (!confirm(T("songs.restoreConfirm", { name: file.name || f.name }))) return;
    restoreBackup({ name: file.name || f.name, file }, true);
  }
  function fileActions(f) {
    const box = detailsBox(f);
    const btns = [];
    if (f.kind === "song") btns.push(sbtn(T("songs.load"), () => loadSong(f)));
    if (f.kind === "backup" || f.kind === "file") btns.push(sbtn(T("songs.restoreThis"), () => restorePhoneBackup(f)));
    if (window.ConsortRender && ["song", "set", "backup", "file"].includes(f.kind))
      btns.push(sbtn(T("songs.render"), () => ConsortRender.renderFile(f)));
    if (!f.managed) btns.push(sbtn(T("songs.importToLibrary"), () => importFile(f)));
    btns.push(sbtn(T("menu.share"), () => (f.kind === "song" ? shareSong(f) : shareFile(f))));
    btns.push(sbtn(T("menu.rename"), () => renameFile(f)));
    btns.push(sbtn(T("songs.openWith"), () => openFile(f)));
    btns.push(sbtn(T("menu.delete"), () => deleteFile(f), true));
    btns.push(sbtn(T("menu.cancel"), () => {}));
    const back = sheet(btns);
    back.querySelector(".consort-sheet").prepend(box);
  }
  function songMenu(f) { fileActions(f); }
  function primaryAction(f) {
    if (f.kind === "song") return [T("songs.load"), () => loadSong(f)];
    if (f.kind === "backup" || f.kind === "file") return [T("songs.restoreThis"), () => restorePhoneBackup(f)];
    return null;
  }
  function renderSongs() {
    const box = document.getElementById("songs-list");
    const empty = document.getElementById("songs-empty");
    const count = document.getElementById("songs-count");
    if (!box) return;
    const all = library();
    const list = all.filter((f) => songFilter === "all"
      || (songFilter === "song" && (f.kind === "song" || f.kind === "set"))
      || (songFilter === "backup" && (f.kind === "backup" || f.kind === "file")));
    box.replaceChildren();
    if (count) count.textContent = list.length + (list.length !== all.length ? " / " + all.length : "");
    if (empty) {
      empty.style.display = list.length ? "none" : "";
      empty.textContent = all.length ? T("songs.noneMatch") : (window.ConsortFiles ? T("songs.none") : T("songs.previewOnly"));
    }
    list.forEach((f) => {
      const row = document.createElement("div");
      row.className = "song";
      const kind = document.createElement("span");
      kind.className = "type " + f.kind;
      kind.textContent = KIND[f.kind] || "FILE";
      const info = document.createElement("div");
      info.className = "grow";
      const b = document.createElement("b");
      b.textContent = f.name;
      const sp = document.createElement("span");
      sp.textContent = [bytes(f.size), f.date ? when(f.date * 1000) : "", f.managed ? "" : T("songs.external")]
        .filter(Boolean).join(" · ");
      info.append(b, sp);
      const acts = document.createElement("div");
      acts.className = "row";
      acts.style.gap = "6px";
      acts.style.marginLeft = "auto";
      const main = primaryAction(f);
      if (main) {
        const mb = document.createElement("button");
        mb.className = "mini pri";
        mb.textContent = main[0];
        mb.addEventListener("click", (e) => { e.stopPropagation(); main[1](); });
        acts.appendChild(mb);
      }
      const more = document.createElement("button");
      more.className = "mini";
      more.textContent = "⋯";
      more.addEventListener("click", (e) => { e.stopPropagation(); songMenu(f); });
      acts.appendChild(more);
      row.append(kind, info, acts);
      row.addEventListener("click", () => fileActions(f));
      box.appendChild(row);
    });
  }
  function importSong() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.multiple = true;
    inp.accept = ".sloopsong,.sloopset,.json,application/json";
    inp.addEventListener("change", async () => {
      const files = [...(inp.files || [])];
      if (!files.length) return;
      let ok = 0;
      for (const file of files) {
        try {
          const r = await fetch("/save?name=" + encodeURIComponent(file.name) + "&type=application/json",
            { method: "POST", body: file });
          if (r.ok) ok++;
        } catch (e) { /* report below */ }
      }
      if (ok) {
        toastMsg(ok === 1 ? T("songs.imported", { name: files[0].name }) : T("songs.importedMany", { n: ok }));
        renderSongs();
      } else {
        toastMsg(T("songs.importFail", { err: files[0].name }));
      }
    });
    inp.click();
  }

  // One capture, always the full artifact: loop, sections A-D, order and USR1-4. The share sheet
  // turns it into a canonical .sloopsong, the full .sloopsong, or a .sloopset, without touching it.
  async function saveSong() {
    if (!link) { toastMsg(T("needConnect")); return; }
    const d = new Date(), p = (n) => (n < 10 ? "0" : "") + n;
    const def = "SONG " + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
    const name = prompt(T("songs.exportName"), def);
    if (name == null) return;
    const btn = document.getElementById("song-export");
    if (btn) { btn.disabled = true; btn.textContent = T("songs.exporting"); }
    try {
      const file = await Sloop.songCapture(link, (name.trim() || def).slice(0, 40), (done, total) => {
        if (btn && total) btn.textContent = Math.round(done / total * 100) + "%";
      }, true);
      const safe = String(file.name || "SONG").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 40) || "SONG";
      const r = await fetch("/save?name=" + encodeURIComponent(safe + ".sloopsong") + "&type=application/json",
        { method: "POST", body: JSON.stringify(file) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      toastMsg(T("songs.exportedSamples", { name: file.name }));
      renderSongs();
    } catch (e) { toastMsg(T("songs.exportFail", { err: e.message })); }
    if (btn) { btn.disabled = false; btn.textContent = T("songs.export"); }
  }
  function backups() {
    try { return JSON.parse(localStorage.getItem("consort.backups") || "[]"); } catch (e) { return []; }
  }
  async function backupSave() {
    if (!link) { toastMsg(T("needConnect")); return; }
    const btn = document.getElementById("bk-save");
    if (btn) { btn.disabled = true; btn.textContent = T("songs.backingUp"); }
    try {
      toastMsg(T("songs.backingUp"));
      const file = await Sloop.backupCapture(link, (done, total) => {
        if (btn && total) btn.textContent = Math.round(done / total * 100) + "%";
      });
      // A durable copy first: Download/SLOOP survives a cleared WebView, the list below is the convenience copy.
      const d = new Date(), p = (n) => (n < 10 ? "0" : "") + n;
      const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
      const fileName = "SLOOP-backup-" + stamp + ".json";
      let fileSaved = true;
      try {
        const r = await fetch("/save?name=" + encodeURIComponent(fileName) + "&type=application/json",
          { method: "POST", body: JSON.stringify(file) });
        fileSaved = r.ok;
      } catch (e) { fileSaved = !window.ConsortFiles; }   // the static preview has no saver
      const list = backups();
      const name = T("songs.backupName", { when: when(Date.now()) });
      list.unshift({ name, date: Date.now(), file });
      try {
        localStorage.setItem("consort.backups", JSON.stringify(list.slice(0, 5)));
        toastMsg(T("songs.backupDone", { n: file.objects.length })
          + (fileSaved && window.ConsortFiles ? " · Download/SLOOP" : ""));
      } catch (e) {
        toastMsg(fileSaved ? T("songs.backupFileOnly", { n: file.objects.length }) : T("storage.fail"));
      }
      if (fileSaved) renderSongs();
    } catch (e) { toastMsg(T("songs.backupFail", { err: e.message })); }
    if (btn) { btn.disabled = false; btn.textContent = T("songs.backup"); }
  }

  function backupSheet() {
    const list = backups();
    const phone = library().filter((f) => f.kind === "backup" || f.kind === "file");
    const back = document.createElement("div");
    back.className = "consort-back";
    const sheet = document.createElement("div");
    sheet.className = "consort-sheet";
    if (phone.length) {
      const cap = document.createElement("div");
      cap.className = "sheetcap";
      cap.textContent = T("songs.phoneBackups");
      sheet.appendChild(cap);
      phone.forEach((f) => {
        const btn = document.createElement("button");
        btn.textContent = f.name;
        btn.addEventListener("click", () => { back.remove(); restorePhoneBackup(f); });
        sheet.appendChild(btn);
      });
    }
    if (list.length) {
      const cap = document.createElement("div");
      cap.className = "sheetcap";
      cap.textContent = T("songs.appBackups");
      sheet.appendChild(cap);
    }
    list.forEach((b) => {
      const btn = document.createElement("button");
      btn.textContent = b.name;
      btn.addEventListener("click", () => { back.remove(); restoreBackup(b); });
      sheet.appendChild(btn);
    });
    const fromFile = document.createElement("button");
    fromFile.textContent = T("songs.restoreFile");
    fromFile.addEventListener("click", () => { back.remove(); restoreFromFile(); });
    const cancel = document.createElement("button");
    cancel.textContent = T("menu.cancel");
    cancel.addEventListener("click", () => back.remove());
    sheet.append(fromFile, cancel);
    back.appendChild(sheet);
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
  }

  function restoreFromFile() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".json,application/json";
    inp.addEventListener("change", async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!data || data.format !== "sloop-backup" || !Array.isArray(data.objects)) {
          toastMsg(T("songs.restoreFileBad"));
          return;
        }
        if (!confirm(T("songs.restoreConfirm", { name: f.name }))) return;
        restoreBackup({ name: f.name, file: data }, true);
      } catch (e) { toastMsg(T("songs.restoreFileBad")); }
    });
    inp.click();
  }

  async function restoreBackup(b, confirmed) {
    if (!link) { toastMsg(T("needConnect")); return; }
    if (!confirmed && !confirm(T("songs.restoreConfirm", { name: b.name }))) return;
    const btn = document.getElementById("bk-restore");
    if (btn) { btn.disabled = true; btn.textContent = T("songs.restoring"); }
    try {
      toastMsg(T("songs.restoring"));
      await Sloop.backupRestore(link, b.file, (done, total) => {
        if (btn && total) btn.textContent = Math.round(done / total * 100) + "%";
      });
      toastMsg(T("songs.restored", { name: b.name }));
      refreshSections();
    } catch (e) { toastMsg(T("songs.restoreFail", { err: e.message })); }
    if (btn) { btn.disabled = false; btn.textContent = T("songs.restore"); }
  }
  document.getElementById("bk-save").addEventListener("click", backupSave);
  document.getElementById("bk-restore").addEventListener("click", backupSheet);
  document.getElementById("song-import").addEventListener("click", importSong);
  const songExport = document.getElementById("song-export");
  if (songExport) songExport.addEventListener("click", saveSong);
  const songsRefresh = document.getElementById("songs-refresh");
  if (songsRefresh) songsRefresh.addEventListener("click", renderSongs);
  document.querySelectorAll(".songfilter button").forEach((b) => b.addEventListener("click", () => {
    songFilter = b.dataset.filter;
    document.querySelectorAll(".songfilter button").forEach((x) => x.classList.toggle("on", x === b));
    renderSongs();
  }));
  const songsTab = document.querySelector('nav button[data-page="p-songs"]');
  if (songsTab) songsTab.addEventListener("click", () => { refreshSections(); renderSongs(); });

  document.getElementById("th-read").addEventListener("click", readCurrent);
  document.getElementById("th-save").addEventListener("click", saveCurrent);
  document.getElementById("th-import").addEventListener("click", importCode);
  renderSongs();
  renderPhoneThemes();
  try {
    if (window.ConsortFiles && ConsortFiles.version) {
      const v = ConsortFiles.version();
      if (v) document.getElementById("app-version").textContent = "v" + v;
    }
  } catch (e) { /* the browser preview has no package version */ }
  if (current) renderCurrent(current);
  else {
    const w = document.getElementById("cur-when");
    if (w) w.textContent = T("set.notRead");
  }

  document.addEventListener("consort:lang", () => {
    setConn(!!link, cleanPortName(connRaw) || T("conn.on"));
    paintPills();
    refreshSections();
    renderSongs();
    renderPhoneThemes();
    if (current) renderCurrent(current);
    else {
      const w = document.getElementById("cur-when");
      if (w) w.textContent = T("set.notRead");
    }
    if (window.ConsortSamples && window.ConsortSamples.relabel) window.ConsortSamples.relabel();
  });
})();
