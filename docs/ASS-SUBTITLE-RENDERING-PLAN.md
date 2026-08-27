# Full-fidelity ASS subtitle rendering on LG webOS — implementation plan

Status: design locked (multi-agent research, 2026-07). Build not started.
Target: LG C5 OLED, webOS 25, WebAppManager webview = Chromium 120, hosting this
Stremio Theater port with the local Node service. Content: heavily-typeset fansub
anime (karaoke `{\k}`, mocha-tracked signs with per-frame `\t`/`\pos`, `{\p}`
vector draws, `\blur`, embedded TTF/OTF) streamed from TorBox (direct-play or the
local streaming server's HLS path).

---

## 1. The verdict (the question that drove this)

Of the three goals **{full-fidelity, frame-perfect (mpv pixel-parity), no-server}**,
**you cannot have all three on this hardware.** Which one bends:

- **full-fidelity + no-server DO coexist** — keep both.
- **frame-perfect is the one that must bend**, and only to *near-frame-accurate*:
  smooth, motion-correct, calibrated to within ~1 frame (42 ms), indistinguishable
  from mpv on dialogue and karaoke; only *fast per-frame mocha-tracked signs* can
  lead/lag by up to one frame.

This is a **platform ceiling, not a renderer defect.** Frame-lock is a *compositing*
property: "pixel-frame-locked to the video like mpv" requires the subtitle pixels and
the video pixels to be presented by the **same compositor swap** with the same latency.
On this SoC:

- The video lives on an **independent hardware overlay plane** that emits **zero
  presented-frame signal** — `requestVideoFrameCallback` never fires (the plane is
  hole-punched; `Page.captureScreenshot` shows white where video is), `video.currentTime`
  advances in **200 ms / 5 Hz quanta** (~5 video frames), and
  `getVideoPlaybackQuality()` counters return 0. The web layer can only *predict*
  presentation from a 5 Hz clock + `performance.now()`, with no ground-truth to lock to.
- The subtitle graphics plane composites **independently** over that overlay, and under
  non-Game picture modes travels through TruMotion/HDR post-processing with its own
  content-adaptive buffering — giving a constant-but-unknown, possibly non-integer,
  sometimes-variable frame offset the web layer cannot measure or cancel.

A better clock removes **jitter**; a calibrated constant removes the stable **bias**;
neither manufactures the missing presentation phase. The only two architectures that
reach true frame-lock each spend another constraint:

- **Server-side ffmpeg burn-in** → frame-perfect, but breaks *no-server*.
- **WebCodecs single-canvas decode** → frame-perfect by construction, but **dead on
  this content**: webOS routes hardware decode through the platform media pipeline, not
  Chromium's WebCodecs; `VideoDecoder` falls back to software; Chromium ships **no**
  software fallback for HEVC or H.264 High-10 — exactly what typeset anime ships as — so
  `isConfigSupported` returns false and it hard-fails. Making it run needs a server
  transcode to 8-bit H.264 (reintroducing, and worsening, the forbidden step) and still
  loses HDR + audio passthrough. **Rejected.**

So ship **full-fidelity + ffmpeg-free + near-frame-accurate**, and keep ffmpeg burn-in
as an **opt-in "perfect mode"** for the rare cases the residual is objectionable.

---

## 2. Root cause of the current jaggedness (critical)

**The 4–8 fps stutter is a clock bug, not a rendering bottleneck.** libass renders this
heavy typesetting at **~2 ms p50 / 3 ms p95 on-device** — rendering was never the
bottleneck. The defect is in the drive loop (`ctrl.js`, the `setInterval(..., 33)` that
calls `setCurrentTime(v.paused, v.currentTime)`):

> Feeding raw 5 Hz `video.currentTime` into `setCurrentTime` every tick **resets
> libass's own `lastCurrentTime + elapsed*rate` extrapolation anchor** on every call.
> libass is trying to interpolate smooth motion between samples, and we stomp its anchor
> ~30×/sec with a 5 Hz staircase. That staircase *is* the jaggedness.

**Consequence:** no renderer swap can fix this. SubtitlesOctopus, self-built libass,
JASSUB 2.x, DOM/CSS renderers (ass.js, libjass), from-scratch Canvas/WebGL — all change
the pixels but not the one moment we know to draw them. All were evaluated and rejected
(see §7). The fix is to drive libass off a **smooth extrapolated clock** and call a
demand-render `renderAt(mediaTime)` — never raw samples per tick.

---

## 3. Recommended architecture (survived adversarial refutation)

**Fork JASSUB 1.8.8 (UMD, classic worker) and fix the clock.** It is the only option that
is *simultaneously* (a) full-fidelity — libass is byte-for-byte the renderer mpv uses;
(b) ffmpeg-free; and (c) a real fix for the measured bug. JASSUB 1.8.8 is already
pthread-free, classic-worker, OffscreenCanvas-based — it dodges every proven platform
killer (no SharedArrayBuffer, module workers silently dead, rVFC dead). No emscripten
rebuild needed.

Two-plane overlay is preserved: **video stays on the hardware plane** (direct-play,
smooth, HDR/passthrough intact); **libass paints its own fixed full-viewport canvas
above it** (the `.JASSUB` overlay CSS is already in `index.html`).

### Timing model (the core — everything else serves it)

- **rAF loop is the presentation cadence.** Each tick:
  `mediaTime = clock.now(); renderer.renderAt(mediaTime + delta)`.
  **Never** feed raw `video.currentTime` per tick.
- **`MediaClock` = transition-anchored phase-locked loop (PLL).**
  State: `anchorMedia`, `anchorPerf` (= `performance.now()`), `rate`
  (= `video.playbackRate || 1`), `running`, `lastObservedMedia`.
  `now(at) = running ? anchorMedia + ((at - anchorPerf) / 1000) * rate : anchorMedia`.
- **Anchor sources, in priority:**
  1. **HARD sync** (reset `anchorMedia = observed`, `anchorPerf = now`) on
     `loadedmetadata`, `playing`, `seeked`, `pause`, `ratechange`, HLS discontinuity.
  2. **SOFT sync** from the finest position stream available — `com.webos.media`
     `subscribe` integer-ms emissions (preferred) or `video.currentTime` transitions
     (fallback). Only re-anchor on a genuinely **new** value; timestamp a fresh
     transition at the **midpoint** of last-unchanged and first-changed rAF (removes
     ~+8 ms detection bias); apply a **phase-only** correction with `K = 0.12`;
     hard-anchor after two consecutive fresh innovations of the same sign > ~50–75 ms;
     **reject** the sample if the preceding rAF gap was abnormally large (stale).
  3. **STALL watchdog:** on `waiting`/`stalled`/`seeking`/`visibilitychange`, or no fresh
     transition for ~400–450 ms, freeze (`running = false`) so extrapolation does not run
     past a stopped picture.
- **`delta`** = a single additive constant applied only at `renderAt` time, keyed by
  `{device × refresh × HDR × picture-mode}`; start at ~+25 ms, seed properly via a
  one-time 240 fps optical capture of a frame-number/flash clip; re-select on
  picture-mode/HDR/refresh change events. Keep it **separate from and after** clock
  estimation.
- **Rate estimation stays OUT initially** (media is CFR 23.976; phase-only steady error
  is ~1.7 ms at 0.1% skew). Add a slow 10–30 s slope estimator only if logs show real
  long-term drift.

### Subtitle acquisition (stays ffmpeg-free)

Pure-JS Matroska demux — `matroska-subtitles` (`ebml-stream` + `pako`, all pure JS) —
reconstructs the `.ass` header verbatim from the subtitle track `CodecPrivate`
(`PlayResX/Y`, `WrapStyle`, `ScaledBorderAndShadow`, `[V4+ Styles]`), carries
`{\k}`/`{\t}`/`{\pos}`/`{\p}`/`\blur` untouched, and pulls TTF/OTF via `AttachedFile`.
webOS native `textTracks` only surface tag-stripped cues, so this is the ffmpeg-free way
to get the real ASS. **In-page classic worker if TorBox allows CORS + Range; else the
existing Node service** (native `zlib`). No transcode, no ffmpeg. Honest cost: ASS events
are scattered across every cluster (~17 events/s), so a complete pull streams the whole
MKV once — but it is O(1) memory, one-time, and cacheable, so re-watch is instant.

---

## 4. Files to add / touch

- `service/www/jassub/` — **new dir** (copy from JASSUB 1.8.8 `dist/`):
  `jassub-worker.js`, `jassub-worker.wasm`, `jassub-worker-modern.wasm`, `default.woff2`,
  and `jassub-ekitabu.umd.js` (the forked `jassub.umd.js`).
- `service/www/index.html` — `.JASSUB` overlay CSS already present (fixed, 100vw/vh,
  z-index 2147482000; matches JASSUB's auto `_canvasParent`). Add one
  `<script src="jassub/jassub-ekitabu.umd.js"></script>` so `window.JASSUB` is global.
- `service/www/ass-demux-worker.js` — **new classic worker**: rollup-bundle
  `matroska-subtitles` to an **IIFE** (`output.format:'iife'`, **no ESM** — module
  workers are dead). `fetch()`es the MKV, pumps `response.body` into the parser,
  `postMessage`s `{type:'tracks'|'file'|'subtitle'}` back.
- `patches/zzzz-ass-libass.patch` — **new patch** on `video.chunk.js`. Anchor: immediately
  after the player creates and appends the `<video>` element `d`
  (`t.appendChild(d)`, ~`video.chunk.js:18812`). Inject:
  `try { window.__assCtl = new AssController(d); } catch(e) {}`. Read `d.mediaId`
  (present on direct-play, ~`video.chunk.js:18790`) for the subscribe path.
- `service/www/ass-controller.js` — **new**: the `AssController` class (owns the JASSUB
  instance + MediaClock + rAF loop + `com.webos.media` subscription + `d` event listeners
  + delta table). Public: `attach(d, subUrl, fontUrls)`, `detach()`. Loaded by
  `index.html` (keeps the patch tiny and reviewable).
- `service/ass-extract.js` + a route in `launch.js` — Node fallback demux: same
  `matroska-subtitles` pipeline server-side (Node has native `zlib.inflateSync`),
  accumulate the full `.ass` + fonts, cache under a content-hash key, serve
  `GET /ass/<key>.ass` and `/ass/<key>/fonts/*`. **No ffmpeg.**

---

## 5. Fork edits (3 edits; apply from `jassub.es.js` to the UMD build → `jassub-ekitabu.umd.js`)

1. **Constructor** (`jassub.es.js:~85`): keep `this._onDemandRender = true` (so
   `this.busy` / `_lastDemandTime` initialize and the worker `demand` path + OffscreenCanvas
   are used), and add `this._externalClock = e.externalClock ?? false`.
2. **setVideo** (`jassub.es.js:~225`): guard the rVFC registration so external mode
   registers **neither** rVFC **nor** the `timeupdate` listeners —
   `if (this._onDemandRender && !this._externalClock) this._video.requestVideoFrameCallback(...);
   else if (!this._onDemandRender) { ...timeupdate/seeking/playing/ratechange... }`.
   In external mode we drive entirely via `renderAt()`. Keep the ResizeObserver and
   (best-effort) colorspace listener.
3. **Add method** (reuses `_demandRender`/`_unbusy` at `jassub.es.js:434–443`,
   latest-wins backpressure):
   ```js
   renderAt(mediaTime) {
     if (this._destroyed) return;
     const width = this._video.videoWidth, height = this._video.videoHeight;
     if (this.busy) { this._lastDemandTime = { mediaTime, width, height }; }
     else { this.busy = true; this._demandRender({ mediaTime, width, height }); }
   }
   ```

Known no-op to accept: `_updateColorSpace()` constructs a `VideoFrame` inside rVFC, which
never fires → subtitle BT.601/709 alpha correction silently skips. Fine for SDR anime; note it.

### JASSUB construction (in `AssController.attach`)

```js
new window.JASSUB({
  video: d,
  canvas: undefined,              // let it create its own .JASSUB parent + OffscreenCanvas
  workerUrl: 'jassub/jassub-worker.js',
  wasmUrl: 'jassub/jassub-worker.wasm',
  modernWasmUrl: 'jassub/jassub-worker-modern.wasm',
  externalClock: true,
  onDemandRender: true,
  offscreenRender: true,
  blendMode: 'wasm',
  asyncRender: true,
  prescaleFactor: 1,
  prescaleHeightLimit: 1080,
  maxRenderHeight: 0,
  dropAllAnimations: false,
  dropAllBlur: false,
  availableFonts: fontFamilyToUrl,
  fallbackFont: 'liberation sans',
  subContent: assText,
});
```

Verify `_ctx` stays false (true OffscreenCanvas). **Do NOT** mutate `_videoWidth`/
`_videoHeight` and **do NOT** `resize(0.6w, 0.6h)` for perf — that is what broke sign
placement before. If prescaling is ever needed, use `prescaleFactor: 2/3` +
`prescaleHeightLimit: 1` (preserves the `ass_set_storage_size` vs `ass_set_frame_size`
split; the storage-size hack corrupts tracked-sign placement).

---

## 6. Ordered build steps

- **P0 — probes (~1 hr, before code).** De-risk the two unproven gates. See §8 and the
  `ass-probe.js` harness already in this tree.
  - (a) On-device: log distinct `video.currentTime` values/sec + rAF-vs-synthetic drift
    for 10 s → reconfirm the 5 Hz reset root cause.
  - (b) `fetch()` a TorBox MKV URL from the page; inspect for
    `Access-Control-Allow-Origin` + `Range`/206 → decides in-page demux vs Node demux.
  - (c) Try `com.webos.media` `subscribe` on a direct-play session → confirm the retail
    LS2 ACL permits it and integer-ms emissions arrive (~4 Hz).
  - (d) Confirm the media codec (HEVC10 / Hi10P?) → closes WebCodecs for good.
- **P1 — decisive.** Fork JASSUB (3 edits) → `jassub-ekitabu.umd.js`. Ship
  `ass-controller.js` with `MediaClock` (hard/soft sync on `d`) + rAF loop calling
  `renderAt(clock.now() + delta)`, `delta = 0` for now. Wire the demux (P0-b winner) to
  produce `assText` + fonts and construct JASSUB.
  **Expected outcome: the 4–8 fps step disappears; motion smooth and correct at full
  1080p.** This alone likely satisfies "smooth + full-fidelity."
- **P2 — refine sync.** Add the `com.webos.media` subscribe integer-ms anchor into
  `MediaClock.softSync` (fallback to `currentTime` transitions). Add midpoint timestamping,
  consecutive-innovation hard-anchor, stale-rAF rejection, stall watchdog. Seed `delta`
  via one 240 fps optical calibration per picture-mode/HDR/refresh; add a change listener
  to re-select `delta`; instruct the user to use **Game or Filmmaker mode with TruMotion
  OFF** to keep the plane differential small and stable.
- **P3 — perf (only if the SoC struggles at 1080p).** A/B `blendMode` wasm-async vs
  wasm-sync vs js-async; add worker timing counters (libass ms, bitmap, paint, changed
  0/1/2); if fill-bound, dirty-union clearing on changed composites; only then a 720p
  profile via `prescaleFactor: 2/3` + `prescaleHeightLimit: 1`.
- **P4 — robustness.** Cache extracted `<sha>.ass` + fonts (Node) so re-watch is instant;
  handle zlib-compressed sub tracks (`pako`/`inflateSync`, already in the parser); use
  ThaUnknown's fixed Transform (`matroska-subtitles` PR #15) to avoid dropped chunks under
  backpressure.
- **P5 — opt-in perfect mode.** `ffmpeg -vf ass=` burn-in on the Node service or a stronger
  remote box, cached HLS by media-fingerprint + sub-track + font-set, exposed as an
  explicit toggle for the hardest fast-tracked-sign material. **Off by default.**

---

## 7. Rejected alternatives (why every richer path fails here)

| Approach | Verdict | Fatal flaw |
|---|---|---|
| SubtitlesOctopus / libass-wasm 4.1.0 | rejected | Same single-threaded libass, same demand API — inherits the exact clock gap; swaps the library, not the bug. |
| JASSUB 2.5.6 as-shipped | rejected | Spawns renderer via `new Worker(url, {type:'module'})` — module workers silently never execute on webOS 120; libass never boots. |
| JASSUB 2.x rebuilt as classic worker | rejected | `manualRender` params are typed from `VideoFrameCallbackMetadata` — only sourced by rVFC, which never fires here. |
| Self-compiled libass → plain wasm | *survives but pointless* | Renderer swap for a non-renderer problem; frame-sync identical to the JASSUB 1.8.8 attempt. |
| ass.js / assjs (DOM/CSS) | rejected | Karaoke WIP, `\blur` broken (no CSS `round()` in Chromium 120), DOM/CSS cannot pixel-match libass. Worst case for this material. |
| libjass (DOM/CSS/SVG) | rejected | Author archived it; DOM cannot render `{\p}` draws, `\blur`, per-frame signs; does nothing for the clock. |
| ass-compiler + custom Canvas/WebGL | rejected | Reimplements libass at *lower* fidelity; does nothing for the plane/clock problem. |
| WebGL from-scratch renderer | rejected | GPU accelerates rasterization (already 2 ms, never the bottleneck); no help for frame-lock. |
| WebCodecs single-canvas (mpv model) | rejected | No decode path for HEVC/Hi10P on webOS; needs a server transcode to even run; loses HDR + audio. |
| `drawImage(<video>)` / `texImage2D(<video>)` | rejected | Hardware overlay buffer is unreadable by Chromium → tainted/blank/stale rectangle (same root cause as dead rVFC). |
| Parallel WebCodecs decode as a *timing* signal | rejected | Media is CFR 24000/1001 — frame boundaries are already known analytically; WebCodecs recovers zero new info and can't decode the codec anyway. |
| Server-side ffmpeg burn-in | opt-in only | The only truly frame-perfect full-fidelity path, but it breaks *no-server*; keep as "perfect mode." |

---

## 8. Acceptance tests

- distinct `currentTime` values/sec; synthetic-clock drift over 20+ min;
- worker render p50/p95/p99; demand queue depth never > 1 retained frame;
- `changed` 0/1/2 distribution on static dialogue;
- exact sign placement at 1080p and after seek/resize;
- karaoke timing through pause/resume and HLS discontinuity;
- confirm no bitmap payload reaches the main thread (true OffscreenCanvas).

---

## 9. Provenance

Design produced by a multi-agent research + adversarial-verification workflow
(6 research angles → 34 candidate approaches → 5 survived refutation). Candidate #1
(this plan) survived its adversarial refutation cleanly; every alternative in §7 was
refuted by an independent skeptic agent. The frame-perfect impossibility is a compositing
argument, not an empirical guess — it follows from the hardware-overlay plane exposing no
presented-frame signal.

---

## 10. Implementation notes — what actually happened on-device (verified)

The plan above was mostly right, but several beliefs were **corrected by on-device testing** on the real LG C5. Recording them so the knowledge isn't lost.

### Corrections to the plan
- **OffscreenCanvas DOES composite on webOS WAM.** The plan/§3 worried it might not; an early test showed "HUD visible, subs not," which I wrongly attributed to offscreen. The real cause was a **dead worker** (below). With that fixed, `offscreenRender:true` composites fine and is the fast path (worker paints the screen canvas directly; no per-frame IPC). Main-thread rendering caps at ~28 renders/s and stutters on heavy effects — **use offscreen.**
- **The wasm-path bug (the big one).** JASSUB's worker resolves `wasmUrl`/`modernWasmUrl` **relative to the worker's own location** (`/jassub/`), so a relative `jassub/jassub-worker.wasm` becomes `/jassub/jassub/...` → 404 → `WebAssembly.compile` throws → worker never reaches `ready` → `busy` sticks → zero renders. **Use ABSOLUTE paths** (`/jassub/...`). This masqueraded as font hangs, offscreen failures, and "no subs" for hours.
- **Font force-load works.** The `fonts:[...]` "hang" was the dead worker, not the fonts. With absolute wasm paths, force-loading all 10 embedded fonts is fine (ready ~1.8s) and matches libass fonts byte-for-byte. SIMD (`modernWasmUrl`) loads and is active.
- **`prescaleFactor` HURTS this content** (35→28 fps). Heavy karaoke is **compute-bound** (glyph shaping + per-frame `\t`), not fill-bound, so scaling down output resolution only adds an upscale cost. Confirmed by a 7-config benchmark: `offscreen + asyncRender + blendMode:'wasm'` is the fastest; bigger glyph caches and `blendMode:'js'` are worse; `dropAllBlur` doesn't even help. Worst-case OP karaoke sustains ~32 fps in real playback (>24 needed).
- **Forking latest JASSUB is not worth it.** Research: 1.8.8's libass is only ~8 months / 46 commits behind current, with **zero** `\clip`/`\pos`/drawing/scaling fixes. 2.x re-introduces the module-worker + pthread fights. Stay on the 1.8.8 fork.

### Timing / motion (the hard part)
- The clock (transition-anchored PLL on `video.currentTime`) locks to the media/audio timeline at **+7 ms** — subtitles are audio-synced automatically, no manual delta.
- **Per-frame mocha-tracked signs** (one `\pos` per video frame, e.g. the UZUI gravestone slide) trail the moving picture because the subtitle **graphics plane is composited ~1 frame later than the hardware video plane**. Symptom: gap ∝ sign speed (large when moving fast, ~0 at rest). Not the renderer (render round-trip is ~5 ms), not the clock, not aspect/overscan (video is clean 1920×1080 SAR 1:1) — it's the two-plane compositor skew.
- **Fix: adaptive plane-latency compensation** in `ass-controller.js` — render AHEAD by `renderLatency + COMP_FRAMES × refreshInterval`, all **measured live** (render round-trip via `_demandRender`→`_unbusy`; refresh via rAF deltas). `COMP_FRAMES` default **3** (compositor + scanout + panel), settable via `localStorage.assCompFrames`. Adapts to any panel/refresh/resolution/sub complexity; only the integer stage-count is fixed. This is the only client-side close for fast tracked signs (short of server burn-in).

### Extraction & seamless integration
- **ffmpeg/ffprobe cannot resolve DNS on webOS** (`Failed to resolve hostname … System error`) — for the bundled binaries AND the prisoner shell. Node's resolver works. **Fix: Node fetches (follows redirects) and pipes bytes into ffmpeg's stdin** (`ass-extract.js`); ffmpeg never touches the network. Two-pass: pipe head → ffprobe (`-i pipe:0`, cut after ~12 MB → EOF) to pick the "Full Subtitles" track; pipe full file → ffmpeg `-dump_attachment + -map 0:<idx> -c copy` to get fonts + ASS in one pass. Cached under `/tmp/ass-cache/<sha1(url)>/`.
- **Routes** (`launch.js`): `/ass/prepare|status|get|font` (extraction + serve), `/anime-streams?cfg=torbox=<token>&id=<kitsu:...>` (server-side torrentio replication — the core never exposes stream URLs to JS), `/next-episodes?id=&n=` (Kitsu `videos[]`, not naïve +1). `/probe-codec` was the working ffprobe template.
- **Controller** auto-extracts on any `#/player/` page (polls hash + `<video>`), attaches when ready, and sets `window.__assActive`.
- **Native-sub suppression** (`patches/zzzz-ass-native-suppress.patch` on `video.chunk.js`): the app's Luna `selectTrack({type:"text", index:r})` is gated to `index:(window.__assActive?-1:r)` — while our renderer is active, the app deselects the native (tag-stripped) embedded track, so no double subtitles.

### Binge prefetch (next 3, same release group)
- On play, the controller parses `{token, infohash, [Group]}` from the stream's `/resolve/torbox/<token>/<infohash>/<file>` URL, calls `/next-episodes`, then `/anime-streams` per upcoming id, and picks the **same-pack stream by infohash** (fallback: `[Group]` bracket tag), pre-extracting each. Verified: from S03E09 it resolved `[Trix] S03E10` and `[Trix] S03E11` (same pack) and queued their subs.
- **bingeGroup = `torrentio|<infohash>` is shared across a season pack**, so the app's own binge already stays in-group for pack releases (no `bt` patch needed there). Hard-locking binge for per-episode (non-pack) releases would require constructing the app's deflate-encoded `#/player` hash — deferred.

### Deploy
- Deployed as a real installed app via `ares-package app service` + `ares-install --device tv` (no `make build`, to avoid the network fetch + `www` wipe during iteration). Custom files live in `service/overlay/` and are copied into `service/www/` by `make build` (Makefile updated) so a clean rebuild reproduces everything. Dev access: `prisoner@192.168.1.9:9922` (key `~/.ssh/tv_webos`, needs `HostKeyAlgorithms=+ssh-rsa`); WAM inspector on `:9998` (drive via CDP; `video.play()`/`Page.reload` work, but synthetic key events do NOT reach the spatial-nav UI — use `ares-launch` to open the app).

### Critical bug found in testing: cached-key omission (would have broken all binge)
`/ass/prepare` returned the extraction `key` only on the *fresh* (queued) path; on the **cached-ready** path it returned `status()` without a key. The client then fetched `/ass/get?key=undefined` → 404 → attached the 404 body as `subContent` → libass parsed **0 styles** → **blank subtitles**. This is invisible on a first-ever play (extraction is in progress, so the queued path runs and returns a key), but hits on **every replay and every binge-prefetched episode** (which are cached by the time you reach them). Fix: `prepare()` always stamps `s.key = key`. Verified: full attach flow (prepare→key→get→JASSUB with real ASS+fonts) now loads `styles=8`. Lesson: a `readyOnDisk`-only "success" check is not enough — validate the *parsed* result (styles/events count), and never treat `key=undefined` as valid.
