# Consort

[**English**](README.md) · [简体中文](README.zh-CN.md)

**A phone companion for the M-VAVE FM-1 running SLOOP 2.7.** It is deliberately narrow: it does the jobs that are awkward on the machine, and leaves the instrument itself alone.

| Sampler | FX |
| --- | --- |
| <img src="docs/screenshots/sampler.jpg" width="330" alt="The sampler page"> | <img src="docs/screenshots/fx.jpg" width="330" alt="The FX page"> |
| **Songs and project files** | **Settings, skins and languages** |
| <img src="docs/screenshots/songs.jpg" width="330" alt="The songs page"> | <img src="docs/screenshots/settings.jpg" width="330" alt="The settings page"> |

*Screenshots: the app wearing an FM-1 theme (ABLETON).*

## Download

[**Download the latest APK**](https://github.com/zisonzishen0415-stack/sloop-consort/releases/latest) — sideload it; Android will ask you to allow installs from the browser or file manager. The APK is signed with the project's debug key (not a Play Store build). Requires Android 6.0+ (minSdk 23) and USB host / OTG.

## Scope: only what SLOOP makes awkward

The FM-1 remains the instrument. Consort is the extra pair of hands:

1. **An external sampler and sample management.** Record through the phone mic or import an audio file (up to the slot's ~7.4 s), watch the waveform as it arrives, trim by dragging or in 10 ms steps with zero-crossing snap, auto-trim, normalize, reverse, set the loop mode (ONE SHOT / LOOP / LOOP+TAIL) with zero-crossed loop points and crossfade, clean DC/rumble, detect the root pitch (AUTO), optionally retune the sample onto it (TUNE), undo, then name it and send it to USR1–4. A take can be added as a zone at its ROOT, and up to 16 such zones are written to one slot as a key-split instrument; the slot can then be put on track 1–3 or used as the drum kit from the same page. WAV files with a `smpl` loop chunk open with that loop already set, and saved WAVs carry the loop back. Takes stay on the phone as WAV files and can be reopened from the Recent takes list; the slots can be inspected and erased from the same page.
2. **Punch-in FX without key combos.** All 27 effects are on one dense page, grouped by time, filter, tone and motion. Hold a pad to engage it, release to let go; the master FILTER / DUST / DUCK sliders sit above.
3. **Project files.** The FM-1 keeps one project; Consort backs the whole thing up to the phone (and to a JSON file in `Download/SLOOP`) and restores it, including the four sample slots. The Songs page is also a phone-side library of `.sloopsong`, `.sloopset` and backup files: load a song onto the FM-1, restore a backup, import from Downloads, share, rename, delete or open a file elsewhere. Saving a song captures it once, in full: loop, sections A–D, order and USR1–4. The library keeps that one master file; when sharing, choose the shape the other app needs — a canonical `.sloopsong`, the full `.sloopsong`, or a one-song `.sloopset`.
4. **Theme sync.** Read the current theme from the machine, save it on the phone, write it back, and wear the same colours as the app's own skin. Themes can also travel as share codes.

Everything else stays where it belongs: sequencing, sections and patterns on the SONG screen, sound design on the FM-1 or in the web editor. This is not a replacement editor.

## A little more detail

- **Sampler** — IMA ADPCM at 22050 Hz mono, written over the same USB MIDI link SLOOP uses; the slot's own 81408-byte capacity is the cap (about 7.38 s at 22050 Hz), and imported files are capped the same way; the 22050 Hz conversion follows `sampleio.resample`'s moving-average anti-alias and linear interpolation. The slot tiles follow `SMP_INFO`'s count (USR1–4 from SLOOP 2.4; earlier firmware reports three), so the page matches the machine it is connected to. While recording, the waveform is drawn live from an `AnalyserNode` (the encoded stream cannot be decoded until it ends); afterwards it becomes a filled min/max envelope, with the out-of-trim parts dimmed. Trim and gain are applied non-destructively when auditioning or rendering. The LOOP control cycles through SLOOP's three zone states: ONE SHOT, LOOP (the whole trim repeats while the key is held) and LOOP+TAIL (the loop start/end points repeat while held; on release the rest of the sample plays as the tail). LOOP+TAIL's two points are set in 10 ms steps and are cut on zero crossings. A one-shot gets a 15 ms fade by default (a Consort edit — the slot has no fade field, and it can be set to 0); a loop gets no fade (that would dip the level on every wrap), and if crossfade is set its tail is folded onto the loop start with the loop end placed just before that tail — the machine's zone flag 2 (SLOOP 2.6 plays it as always-loop). The loop start also carries the IMA predictor/index at that sample, which is the state the firmware restores when it wraps, so a loop that starts past the beginning does not click. A take with a root can be added as a zone; zones are sorted by root, split the keyboard halfway between neighbours (the upstream `key_split`) and share the slot's data budget, so up to 16 zones or about 7.4 s in all. Auto-trim, normalize, reverse, clean and TUNE make a new buffer so Undo can step back. AUTO only labels the take with the detected pitch (leaving the audio untouched, which is what the machine's root key wants); TUNE is the optional destructive one: it resamples the take so its own pitch equals ROOT, refuses moves beyond ±2 octaves or results over 7 s, and changes duration accordingly. Save renders the trimmed 22050 Hz WAV, with a `smpl` chunk when looping, to `Download/SLOOP`; import reads the same chunk back, so loop points survive a round trip. An imported `smpl` loop becomes LOOP+TAIL with its points, even when the loop reaches the end, which is how the upstream editor imports it. ROOT spans the whole 0–127 field. Level is left as recorded: the upstream Python CLI peak-normalises each zone to 30000, but that is a CLI convention rather than a slot rule (the header has no gain field), and the web editor uses per-file gain; Consort offers GAIN and an optional NORM instead. The full-rate editable take (PCM plus trim/root/loop/fade) also stays in IndexedDB, so tapping a take reopens it even after the app restarts. Play on track 1–3 selects the track, switches it to the SAMPLE engine and its default sound (what the upstream editor also does), sets SET to the slot and restores the selection; DRUM sets the drum track's KIT instead. Deliberately absent: pitch shift/time stretch; per-key drum pads are made in the upstream web editor.
- **FX** — LIVE op 3, held and released, so an effect can never stick. The names are the machine's own.
- **Songs** — PROJECT for the section status; backup objects for the full state. A backup is written both to the app and to a JSON file, so clearing the WebView's storage does not lose it. Restore from the phone library, the last five in-app backups, or a file. USR1–4 are global flash slots shared by every song. Consort's master song file is still a `.sloopsong`, but adds a top-level `samples` array (ids 32–35) beside `objects`; loading it restores those slots too. Sharing offers three generated shapes without changing the master: a canonical `.sloopsong` (loop, A–D and order only, upstream-compatible), the full `.sloopsong`, or a one-song `.sloopset` playlist (the samples ride along as opaque data). The upstream SLOOP editor ignores unknown top-level fields, so it still loads the song, but it does not apply the samples and drops them if the song is saved again there. A full backup remains the complete, restorable snapshot of everything, sample slots included. **Offline render:** a SONG or BACKUP can be rendered to a 44.1 kHz stereo WAV on the phone — the full SLOOP 2.7.1 firmware runs in WebAssembly, faster than real time, so the FM-1 is not needed. A song with an A–D order renders the whole arrangement once; a file without an order renders its working loop (choose the length). The WAV lands in `Download/SLOOP`.
- **Skins and settings** — the theme is object 11 on the FM-1 (THM2); the app derives its palette from it with contrast lifting so text stays readable. Eight interface languages, English by default.
- No firmware is modified. The FM-1 is reached through Android's USB MIDI (`android.media.midi`), not Web MIDI. Phones need USB host / OTG; the FM-1's USB port must be the one that exposes MIDI.

## Build

Needs the Android SDK (build-tools and a platform), JDK 17, and a shell where `aapt2`, `javac`, `d8`, `zipalign` and `apksigner` can run.

    bash android/build.sh

The signed APK is written to `consort.apk` at the project root (and `android/consort.apk`). `About` shows the package version; the build script stamps the time into it, so a sideloaded test build can be identified.

## Preview without hardware

    python -m http.server 8765
    # open http://127.0.0.1:8765/index.html

Without the native bridge the page connects to a mock FM-1, so the whole UI and protocol flow can be exercised in a browser. Transfers are simulated; nothing is written to Download/SLOOP in this mode.

## Protocol

SLOOP 2.7 over USB MIDI: `F0 7D 46 4C <cmd> <7-bit args> F7`. Framing, request/response, backup objects, themes (THM2), sample slots (SMP, IMA ADPCM), descriptors (DESC), tracks (TRACK, TRACK_PARAM) and the engine/KIT assignment behind "Play on" live in `protocol.js`.

```
index.html   the four pages and the banner
theme.css    SLOOP's visual language (Terminus, square controls)
i18n.js      the eight interface languages
protocol.js  framing, Link, backup objects, .sloopsong, themes, SMP, DESC/TRACK
app.js       skin, FX, songs, settings
samples.js   the sampler
android/     WebView shell, local server, USB MIDI bridge, file bridge
```

## Testing with the virtual FM-1

The APK can be run against the **real SLOOP firmware** with no machine, through a small virtual-MIDI
rig in `tools/vfm1/`: an Android `MidiDeviceService` publishes a device named `Felucca`, and a host
build of the firmware (the browser emulator's environment plus `editor.c`) answers the same SysEx.
This is how the sampler, FX, theme, backup and restore paths are verified end-to-end. See
[tools/vfm1/README.md](tools/vfm1/README.md).

## Status

Verified end-to-end on a real FM-1: INFO, sample encode/upload to USR and erase, FX press/release,
global SET, theme read/save/write-back and skin, backup to `Download/SLOOP` with restore (samples
included), and `.sloopsong` save/load through the phone library. The loop points, the three loop
states, the `smpl` round trip, multi-zone headers and the TRACK/KIT assignment were also checked
against a scripted SLOOP 2.7 device; the zone and engine numbers are resolved from `DESC`/`INFO`, not
hardcoded. Bug reports are welcome.

## Credits and licences

- **SLOOP** is by 3dSam, built on **[Felucca](https://github.com/hugelton/Felucca)** by Leo Kuroshita (@kurogedelic) / **Hügelton Instruments**. This is an independent companion: it contains no firmware and is not affiliated with them.
- The M-VAVE FM-1 belongs to its owners.
- The code is GPL-3.0-only (see `LICENSE`), matching the SLOOP editor sources it was developed against.
- The Terminus font is SIL OFL 1.1; see `LICENSES/Terminus-OFL.txt`.
- The offline renderer embeds the SLOOP 2.7.1 firmware compiled to WebAssembly (`sloop.wasm`), GPL-3.0; it is built from the SLOOP sources and runs the same DSP as the FM-1.
