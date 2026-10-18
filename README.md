# Consort

**A phone companion for the M-VAVE FM-1 running SLOOP 2.7.** It is deliberately narrow: it does the jobs that are awkward on the machine, and leaves the instrument itself alone.

| Sampler | FX |
| --- | --- |
| <img src="docs/screenshots/sampler.jpg" width="330" alt="The sampler page"> | <img src="docs/screenshots/fx.jpg" width="330" alt="The FX page"> |
| **Songs and project files** | **Settings, skins and languages** |
| <img src="docs/screenshots/songs.jpg" width="330" alt="The songs page"> | <img src="docs/screenshots/settings.jpg" width="330" alt="The settings page"> |

*Screenshots: the app wearing an FM-1 theme (ABLETON).*

## Scope: only what SLOOP makes awkward

The FM-1 remains the instrument. Consort is the extra pair of hands:

1. **An external sampler and sample management.** Record through the phone mic or import an audio file (up to 7 s), watch the waveform as it arrives, trim by dragging or in 10 ms steps with zero-crossing snap, auto-trim, normalize, reverse, set the loop mode (ONE SHOT / LOOP / LOOP+TAIL) with zero-crossed loop points and crossfade, clean DC/rumble, detect the root pitch (AUTO), optionally retune the sample onto it (TUNE), undo, then name it and send it to USR1–4. Takes stay on the phone as WAV files and can be reopened from the Recent takes list; the slots can be inspected and erased from the same page.
2. **Punch-in FX without key combos.** All 27 effects are on one dense page, grouped by time, filter, tone and motion. Hold a pad to engage it, release to let go; the master FILTER / DUST / DUCK sliders sit above.
3. **Project files.** The FM-1 keeps one project; Consort backs the whole thing up to the phone (and to a JSON file in `Download/SLOOP`) and restores it, including the four sample slots. The Songs page is also a phone-side library of `.sloopsong`, `.sloopset` and backup files: load a song onto the FM-1, restore a backup, import from Downloads, share, rename, delete or open a file elsewhere. Saving a song captures it once, in full: loop, sections A–D, order and USR1–4. The library keeps that one master file; when sharing, choose the shape the other app needs — a canonical `.sloopsong`, the full `.sloopsong`, or a one-song `.sloopset`.
4. **Theme sync.** Read the current theme from the machine, save it on the phone, write it back, and wear the same colours as the app's own skin. Themes can also travel as share codes.

Everything else stays where it belongs: sequencing, sections and patterns on the SONG screen, sound design on the FM-1 or in the web editor. This is not a replacement editor.

## A little more detail

- **Sampler** — IMA ADPCM at 22050 Hz mono, written over the same USB MIDI link SLOOP uses; a hard 7-second cap keeps it inside the 80 KiB slot, and imported files are capped the same way. The slot tiles follow `SMP_INFO`'s count (USR1–4 from SLOOP 2.4; earlier firmware reports three), so the page matches the machine it is connected to. While recording, the waveform is drawn live from an `AnalyserNode` (the encoded stream cannot be decoded until it ends); afterwards it becomes a filled min/max envelope, with the out-of-trim parts dimmed. Trim and gain are applied non-destructively when auditioning or rendering. The LOOP control cycles through SLOOP's three zone states: ONE SHOT, LOOP (the whole trim repeats while the key is held) and LOOP+TAIL (the loop start/end points repeat while held; on release the rest of the sample plays as the tail). LOOP+TAIL's two points are set in 10 ms steps and are cut on zero crossings. A one-shot gets the short fade; a loop gets no fade (that would dip the level on every wrap), and if crossfade is set its tail is folded onto the loop start with the loop end placed just before that tail — the machine's zone flag 2 (SLOOP 2.6 plays it as always-loop). Auto-trim, normalize, reverse, clean and TUNE make a new buffer so Undo can step back. AUTO only labels the take with the detected pitch (leaving the audio untouched, which is what the machine's root key wants); TUNE is the optional destructive one: it resamples the take so its own pitch equals ROOT, refuses moves beyond ±2 octaves or results over 7 s, and changes duration accordingly. Save renders the trimmed 22050 Hz WAV to `Download/SLOOP`; the full-rate editable take (PCM plus trim/root/loop/fade) also stays in IndexedDB, so tapping a take reopens it even after the app restarts. Deliberately absent: pitch shift/time stretch and multi-zone kits — Consort writes one zone spanning the whole keyboard, which SAMPLE, GRAIN and TEXTURE play; a 16-key drum kit and per-key splitting are left to the upstream web editor.
- **FX** — LIVE op 3, held and released, so an effect can never stick. The names are the machine's own.
- **Songs** — PROJECT for the section status; backup objects for the full state. A backup is written both to the app and to a JSON file, so clearing the WebView's storage does not lose it. Restore from the phone library, the last five in-app backups, or a file. USR1–4 are global flash slots shared by every song. Consort's master song file is still a `.sloopsong`, but adds a top-level `samples` array (ids 32–35) beside `objects`; loading it restores those slots too. Sharing offers three generated shapes without changing the master: a canonical `.sloopsong` (loop, A–D and order only, upstream-compatible), the full `.sloopsong`, or a one-song `.sloopset` playlist (the samples ride along as opaque data). The upstream SLOOP editor ignores unknown top-level fields, so it still loads the song, but it does not apply the samples and drops them if the song is saved again there. A full backup remains the complete, restorable snapshot of everything, sample slots included.
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

SLOOP 2.7 over USB MIDI: `F0 7D 46 4C <cmd> <7-bit args> F7`. Framing, request/response, backup objects, themes (THM2) and sample slots (SMP, IMA ADPCM) live in `protocol.js`.

```
index.html   the four pages and the banner
theme.css    SLOOP's visual language (Terminus, square controls)
i18n.js      the eight interface languages
protocol.js  framing, Link, backup objects, .sloopsong, themes, SMP
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

Verified through the APK against the virtual FM-1: INFO, sample encode/upload to USR and erase, FX
press/release, global SET, theme read/save/write-back and skin, backup to `Download/SLOOP` with
restore (samples included), and `.sloopsong` save/load through the phone library. On real hardware,
the USB MIDI handshake and section status are confirmed on an FM-1; a final pass on the machine is
still worthwhile for the sampler/FX/theme/backup writes and the song load path. Bug reports are
welcome.

## Credits and licences

- **SLOOP** is by 3dSam, built on **[Felucca](https://github.com/hugelton/Felucca)** by Leo Kuroshita (@kurogedelic) / **Hügelton Instruments**. This is an independent companion: it contains no firmware and is not affiliated with them.
- The M-VAVE FM-1 belongs to its owners.
- The code is GPL-3.0-only (see `LICENSE`), matching the SLOOP editor sources it was developed against.
- The Terminus font is SIL OFL 1.1; see `LICENSES/Terminus-OFL.txt`.
