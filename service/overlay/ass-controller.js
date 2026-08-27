/*
 * ass-controller.js — full-fidelity ASS rendering driver for webOS.
 * See docs/ASS-SUBTITLE-RENDERING-PLAN.md §3 (timing model) and §5.
 *
 * Drives the forked JASSUB 1.8.8 (externalClock/renderAt) off a transition-
 * anchored phase-locked-loop media clock, from a requestAnimationFrame loop.
 * NEVER feeds raw 5Hz video.currentTime into the renderer per tick (that reset
 * of libass's extrapolation anchor is the measured jaggedness — Probe A).
 *
 * P0-confirmed on-device:
 *   - video.currentTime is 5Hz / 200ms-quantized  -> PLL smooths between samples
 *   - com.webos.media subscribe is ACL-denied      -> anchor on currentTime transitions
 *   - a naive extrapolator drifts across stalls     -> hard-anchor + stall watchdog
 *
 * Modes (localStorage):
 *   assMode  = 'pll' (default) | 'raw'   raw = old setCurrentTime-per-tick, for A/B
 *   assDelta = display-latency delta in ms (default 0; +ve = subs later)
 * Diagnostics are OFF by default (production); opt in via localStorage:
 *   assLog   = '1'  client logging (/client-log) + on-screen status pills
 *   assHud   = '1'  small fps/clock overlay
 *   assTest  = '1'  synthetic animated track to judge motion smoothness
 */
(function () {
    'use strict';
    if (window.__assCtl) return;

    function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
    var MODE = lsGet('assMode', 'pll');
    var deltaS = (parseFloat(lsGet('assDelta', '0')) || 0) / 1000;   // live-tunable (see __assSetDelta)
    // Diagnostics are OFF by default in production. Opt in per-feature via
    // localStorage: assLog=1 (client->/client-log + on-screen status pills),
    // assHud=1 (the fps/clock overlay), assTest=1 (synthetic motion-test track).
    var LOG = lsGet('assLog', '0') === '1';
    var TEST = lsGet('assTest', '0') === '1';
    var HUD = lsGet('assHud', '0') === '1';
    // Show frame rate. Per-frame mocha-tracked signs are authored one \pos per
    // video frame; we quantize the render time to this grid so they step in
    // lockstep with the picture instead of being sampled at arbitrary sub-frame
    // times by the 60Hz rAF loop. Default 24000/1001 (23.976). 0 = off (continuous).
    // Default until the tee reports the container's REAL fps (video track
    // DefaultDuration). An explicit assFps override wins over the container value;
    // assFps=0 means frame-lock off (and must survive the fallback below).
    var _fpsLS = lsGet('assFps', '');
    var FPS_USER = _fpsLS !== '' && isFinite(parseFloat(_fpsLS));
    var FPS = FPS_USER ? parseFloat(_fpsLS) : (24000 / 1001);
    // How many compositor/scanout refresh stages the subtitle graphics plane goes
    // through before the panel (canvas->compositor->scanout ~= 2). Integer pipeline
    // property, not a tuned constant; live-adjustable for on-device calibration.
    var COMP_FRAMES = parseFloat(lsGet('assCompFrames', '3'));
    if (isNaN(COMP_FRAMES)) COMP_FRAMES = 3;
    window.__assSetComp = function (n) { COMP_FRAMES = parseFloat(n) || 0; try { localStorage.setItem('assCompFrames', String(COMP_FRAMES)); } catch (e) {} return 'compFrames=' + COMP_FRAMES; };
    // Live frame-lock calibration: __assSetFps(fps) sets the grid tracked signs snap
    // to (23.976 default; 0 = continuous 60Hz sampling, i.e. frame-lock off). Live A/B.
    window.__assSetFps = function (n) { FPS = parseFloat(n) || 0; FPS_USER = true; try { localStorage.setItem('assFps', String(FPS)); } catch (e) {} return 'fps=' + FPS + (FPS > 0 ? ' (frame-lock on)' : ' (frame-lock OFF)'); };
    // Live display-latency calibration: __assSetDelta(ms) nudges sub timing vs
    // picture (+ = subs earlier/ahead, - = later); persists to localStorage.
    window.__assSetDelta = function (ms) { deltaS = (parseFloat(ms) || 0) / 1000; try { localStorage.setItem('assDelta', String(ms)); } catch (e) {} return 'delta=' + ms + 'ms'; };

    var STALE_GAP = 120;   // ms: reject a transition preceded by an abnormal rAF gap
    var STALL_MS = 450;    // ms: no fresh transition -> freeze extrapolation
    var K = 0.12;          // PLL phase-correction gain
    var BIG_INNOV = 0.06;  // s: innovation over this, twice same-sign -> hard re-anchor

    // ---- transition-anchored phase-locked loop --------------------------------
    function MediaClock() {
        this.anchorMedia = 0; this.anchorPerf = 0; this.rate = 1;
        this.running = false; this.lastObserved = -1;
        this._consec = 0; this._lastInnovSign = 0;
    }
    MediaClock.prototype.now = function (at) {
        return this.running ? this.anchorMedia + ((at - this.anchorPerf) / 1000) * this.rate : this.anchorMedia;
    };
    MediaClock.prototype.hardSync = function (media, atPerf) {
        this.anchorMedia = media; this.anchorPerf = atPerf; this.running = true;
        this.lastObserved = media; this._consec = 0; this._lastInnovSign = 0;
    };
    // Freeze extrapolation. Snap to the authoritative currentTime when given
    // (a clean pause), else hold the last extrapolated value (a mid-play stall).
    MediaClock.prototype.freeze = function (atPerf, media) {
        if (this.running) { this.anchorMedia = (media != null ? media : this.now(atPerf)); this.running = false; }
        else if (media != null) { this.anchorMedia = media; }
    };
    MediaClock.prototype.setRate = function (r, atPerf) {
        if (r === this.rate) return;
        this.anchorMedia = this.now(atPerf); this.anchorPerf = atPerf; this.rate = r || 1;
    };
    // A genuinely new currentTime value observed, timestamped at atPerf (midpoint).
    MediaClock.prototype.softSync = function (media, atPerf) {
        if (!this.running) { this.hardSync(media, atPerf); return; }
        var pred = this.now(atPerf);
        var innov = media - pred;                       // seconds
        // Seek-scale jump: SNAP immediately instead of creeping at K per sample and
        // waiting for 2 consecutive big innovations. That slow recovery is what walks
        // the clock forward from a stale post-seek anchor and sweeps "the one after
        // next" cue. Steady-play innovations are sub-frame, so >0.5s is unambiguously a
        // seek/discontinuity where an immediate re-anchor is correct.
        if (Math.abs(innov) > 0.5) { this.hardSync(media, atPerf); return; }
        if (Math.abs(innov) > BIG_INNOV) {
            var sgn = innov < 0 ? -1 : 1;
            this._consec = (sgn === this._lastInnovSign) ? this._consec + 1 : 1;
            this._lastInnovSign = sgn;
            if (this._consec >= 2) { this.hardSync(media, atPerf); return; }
        } else { this._consec = 0; this._lastInnovSign = 0; }
        // phase-only correction, re-based to atPerf to keep magnitudes small
        this.anchorMedia = pred + K * innov;
        this.anchorPerf = atPerf;
        this.lastObserved = media;
    };

    // ---- controller -----------------------------------------------------------
    function AssController(video) {
        this.video = video;
        this.clock = new MediaClock();
        this.jassub = null;
        this.raf = 0;
        this.lastCt = -1;
        this.prevRaf = 0;
        this.lastChangeWall = 0;
        this._fps = 0; this._fpsN = 0; this._fpsT = 0;
        // Adaptive plane-latency compensation (all measured live, no constants):
        //   _renderLat = EMA of the render round-trip (demand dispatch -> unbusy)
        //   _refresh   = EMA of the compositor refresh interval (rAF delta)
        //   _autoDelta = seconds to render ahead so the subtitle graphics plane
        //                lands on the same panel frame as the hardware video plane
        this._renderLat = 8; this._refresh = 16.7; this._autoDelta = 0; this._dispatchT = 0;
        this._bound = {};
        this._hud = null;
    }
    AssController.prototype.attach = function (subContent, fonts, availableFonts) {
        var v = this.video, self = this;
        if (typeof window.JASSUB !== 'function') { alog('JASSUB ctor missing'); return; }
        // Transactional ownership: never overwrite a live JASSUB — tear the old worker
        // down first or its ~60MB WASM heap leaks (notably across binge episode
        // boundaries where this controller is reused without a route change).
        if (this.jassub) { try { this.jassub.destroy(); } catch (e) {} this.jassub = null; }
        // Suppress the app's native subtitle rendering (webOS surfaces the embedded
        // ASS track tag-stripped). We render it ourselves via libass.
        try { for (var ti = 0; ti < v.textTracks.length; ti++) v.textTracks[ti].mode = 'disabled'; } catch (e) {}
        // webOS-CONFIRMED: OffscreenCanvas DOES composite once the wasm actually
        // loads (the earlier "offscreen invisible" was the dead worker from bad
        // wasm paths). Offscreen is the fast path — the worker paints the screen
        // canvas directly, with no per-frame IPC + main-thread drawImage (which
        // otherwise caps throughput at ~28 renders/s and stutters on heavy effects).
        var OFFSCREEN = lsGet('assOffscreen', '1') === '1';
        // 'wasm' (renderBlend) — fast for heavy signs. The blend path's empty-frame
        // "doesn't clear" bug (last sub lingers with no active cue, esp. through a seek)
        // is fixed in the WORKER instead (forces a clear on the non-empty->empty edge),
        // so we keep blend's speed without the stale-sub artifact. ('js' clears but its
        // per-image compositing is slow on heavy transitions.)
        var BLEND = lsGet('assBlend', 'wasm');   // fast blend for heavy signs (user preference over js)
        var ASYNC = lsGet('assAsync', '1') === '1';
        // Prescale: render the subtitle bitmaps below native height then upscale,
        // trading a little sharpness for a big rasterization saving on heavy frames.
        // prescaleHeightLimit:1 forces it to always apply (JASSUB keeps \pos correct
        // via the ass_set_storage_size vs ass_set_frame_size split — do NOT hack _video*).
        var PRESCALE = parseFloat(lsGet('assPrescale', '1')) || 1;
        // libass keeps an internal bitmap+glyph cache that is UNCAPPED by default
        // (JASSUB passes 0 => no limit). On a 250MB renderer budget that cache is the
        // dominant OOM source on effect-heavy full-res frames. Cap it: bitmap cache MB
        // + cached-glyph count. Visually identical (cache is a re-raster optimization);
        // only costs extra rasterization on eviction during heavy scenes. Tunable.
        var LIBASS_MEM = parseInt(lsGet('assLibassMem', '24'), 10);      // bitmap cache MB (0=unlimited)
        var LIBASS_GLYPH = parseInt(lsGet('assLibassGlyph', '500'), 10); // glyph cache count (0=unlimited)
        // Cap the subtitle RASTER height (libass frame size). Bitmaps rasterize at
        // this height then CSS-upscale to the video area — big memory saving on 1080p
        // (~44% per bitmap) and huge on 4K (33MB->6MB backing). 0 = native (off).
        var SUBCAP = parseInt(lsGet('assMaxSubHeight', '720'), 10);
        try {
            this.jassub = new window.JASSUB({
                video: v,
                subContent: subContent,
                fonts: fonts || [],
                fallbackFont: 'liberation sans',
                // On-demand fonts: JASSUB loads a name's URL only when the ASS references
                // it, instead of eagerly loading every embedded CJK font into the wasm
                // heap. Multi-face/unparseable fonts are still passed eagerly via `fonts`.
                availableFonts: Object.assign({ 'liberation sans': '/jassub/default.woff2' }, availableFonts || {}),   // ABSOLUTE: worker resolves relative against /jassub/ -> 404
                // ABSOLUTE paths: the worker resolves wasmUrl against its own
                // location (/jassub/), so a relative 'jassub/..' becomes
                // /jassub/jassub/.. -> 404 -> wasm never compiles -> never ready.
                workerUrl: '/jassub/jassub-worker.js',
                wasmUrl: '/jassub/jassub-worker.wasm',
                modernWasmUrl: '/jassub/jassub-worker-modern.wasm',
                legacyWasmUrl: '/jassub/jassub-worker.wasm.js',
                externalClock: MODE === 'pll',      // raw mode uses stock timeupdate path
                onDemandRender: true,
                offscreenRender: OFFSCREEN,
                asyncRender: ASYNC,
                blendMode: BLEND,
                prescaleFactor: PRESCALE,
                prescaleHeightLimit: PRESCALE < 1 ? 1 : 1080,
                maxRenderHeight: SUBCAP,
                libassMemoryLimit: LIBASS_MEM,
                libassGlyphLimit: LIBASS_GLYPH,
                dropAllAnimations: false,
                dropAllBlur: false,
                debug: false
            });
            alog('JASSUB constructed mode=' + MODE + ' len=' + subContent.length);
            // Flag the video.chunk.js patch to suppress the app's native (tag-stripped)
            // embedded subtitle while we render this track ourselves.
            window.__assActive = true;
            this._lastMt = NaN;   // fresh instance: force the first render past the dedup
        } catch (e) { alog('JASSUB ctor THREW ' + (e && e.message)); return; }

        // Measure the render round-trip live (demand dispatch -> unbusy) for the
        // adaptive latency compensation. EMA; ignore outliers.
        (function () {
            var j = self.jassub;
            var od = j._demandRender.bind(j), ou = j._unbusy.bind(j);
            j._demandRender = function (x) { self._dispatchT = performance.now(); return od(x); };
            j._unbusy = function () {
                if (self._dispatchT) { var l = performance.now() - self._dispatchT; if (l > 0 && l < 200) self._renderLat = self._renderLat * 0.85 + l * 0.15; self._dispatchT = 0; }
                return ou();
            };
        })();

        // Force render size to the video's native resolution and keep it correct.
        var fixSize = function () {
            if (!self.jassub) return;
            var vw = v.videoWidth || 1920, vh = v.videoHeight || 1080;
            // Raster at the capped height, but keep _videoWidth/_videoHeight NATIVE so
            // \pos scaling stays correct AND the per-frame _demandRender guard (which
            // compares demand dims to _videoWidth/_videoHeight) doesn't re-resize back
            // to full res. Only the frame/canvas backing shrinks; CSS upscales it.
            var rh = (SUBCAP > 0 && vh > SUBCAP) ? SUBCAP : vh;
            var rw = Math.round(vw * rh / vh);
            try { self.jassub._videoWidth = vw; self.jassub._videoHeight = vh; self.jassub.resize(rw, rh); } catch (e) {}
            self._lastMt = NaN;   // a resize needs a re-render even at the same mt (dedup would suppress the paused/busy retry)
        };
        try { this.jassub.addEventListener('ready', function () { fixSize(); setTimeout(fixSize, 600); }); } catch (e) {}
        this._bound.fixSize = fixSize;
        v.addEventListener('loadedmetadata', fixSize);
        this._sizeT = setInterval(fixSize, 4000);
        setTimeout(fixSize, 300);

        if (MODE !== 'pll') { alog('raw mode: JASSUB owns the clock (no PLL)'); this._startHud(); return; }

        // Anchor events on the media element.
        var hard = function () { self.clock.hardSync(v.currentTime, performance.now()); self._seeking = false; };   // any re-anchor also un-blanks
        var freeze = function () { self.clock.freeze(performance.now(), v.currentTime); };
        var rate = function () { self.clock.setRate(v.playbackRate || 1, performance.now()); };
        // Seek: while seeking, render the TARGET's subs (v.currentTime), not the stale
        // pre-seek clock — otherwise a backward seek briefly flashes the "upcoming" subs
        // from where you seeked FROM before snapping to the target.
        var seekStart = function () { self._seeking = true; self._settleCt = -1; self._settleSince = 0; self._seekSince = performance.now(); freeze(); };
        var seekEnd = function () { /* no-op: the settle-gate in the rAF tick owns un-blank + re-anchor — webOS currentTime BOUNCES after 'seeked' */ };
        this._bound.hard = hard; this._bound.freeze = freeze; this._bound.rate = rate;
        this._bound.seekStart = seekStart; this._bound.seekEnd = seekEnd;
        v.addEventListener('loadedmetadata', hard);
        v.addEventListener('playing', hard);
        v.addEventListener('seeked', seekEnd);
        v.addEventListener('play', hard);
        v.addEventListener('pause', freeze);
        v.addEventListener('waiting', freeze);
        v.addEventListener('seeking', seekStart);
        v.addEventListener('stalled', freeze);
        v.addEventListener('ratechange', rate);
        document.addEventListener('visibilitychange', freeze);
        if (v.readyState >= 1) { if (v.paused) freeze(); else hard(); }

        this._startHud();
        this._loop();
    };
    AssController.prototype._loop = function () {
        var self = this, v = this.video;
        var tick = function (now) {
            if (!self.jassub) return;
            // 1. seek settle-gate + transition detection.
            var ct = v.currentTime;
            if (self._seeking) {
                // After a seek, webOS currentTime BOUNCES (5Hz quantization + buffering)
                // for a few hundred ms. Stay blanked+frozen until it stops moving, then
                // lock ONCE — else the frame-locked mt bounces through adjacent frames'
                // cues (the post-seek flicker). Watchdog so we never blank forever.
                if (ct === self._settleCt) {
                    if (!self._settleSince) self._settleSince = now;
                    else if (now - self._settleSince > 180) {
                        self.clock.hardSync(ct, now);
                        self._seeking = false; self._settleSince = 0; self._settleCt = -1;
                        self.lastCt = ct; self.lastChangeWall = now;
                    }
                } else { self._settleCt = ct; self._settleSince = 0; }
                if (self._seeking && self._seekSince && (now - self._seekSince) > 2500) {   // watchdog
                    self.clock.hardSync(ct, now); self._seeking = false; self.lastCt = ct; self.lastChangeWall = now;
                }
            } else if (ct !== self.lastCt) {
                if (self.lastCt >= 0 && (now - self.prevRaf) < STALE_GAP) {
                    self.clock.softSync(ct, (self.prevRaf + now) / 2);
                } else if (self.lastCt < 0) {
                    self.clock.hardSync(ct, now);
                }
                self.lastCt = ct; self.lastChangeWall = now;
            }
            // 2a. paused: hold exactly at currentTime (never extrapolate past a still frame)
            if (v.paused) {
                if (self.clock.running) self.clock.freeze(now, ct);
            // 2b. stall watchdog: pipeline froze mid-play without a waiting/stalled event
            } else if (self.clock.running && (now - self.lastChangeWall) > STALL_MS) {
                self.clock.freeze(now);
            }
            // 3. adaptive plane-latency compensation: render AHEAD by the measured
            //    sub-plane pipeline latency (render round-trip + one compositor
            //    refresh) so the graphics plane lands on the same panel frame as the
            //    hardware video plane. Auto-measured; adapts to content/panel/res.
            //    Frame-lock: a sign tracked per video frame (\move / \t / per-frame
            //    \pos) must step on the VIDEO's ~23.976fps cadence, not the 60Hz rAF
            //    grid. Sampled continuously it glides while the picture judders (they
            //    desync), and the adaptive-delta EMA noise leaks straight into its
            //    position. Quantizing the render time to the frame grid snaps it back
            //    in lockstep with the picture AND absorbs that per-frame delta jitter.
            //    (assFps=0 disables, for A/B.)
            if (self.prevRaf) { var rd = now - self.prevRaf; if (rd > 6 && rd < 50) self._refresh = self._refresh * 0.9 + rd * 0.1; }
            // FREEZE the latency lead while paused. On a still frame the EMA keeps
            // drifting; a per-frame (mocha-tracked) sign then flips between adjacent
            // frames' poses and visibly "jumps" even though nothing is playing. Only
            // advance the lead during playback.
            var mt;
            if (self._seeking) {
                // webOS reports a STALE/transitional currentTime mid-seek, so any time we
                // pick renders the wrong (pre-seek/future) subs. Blank instead — render an
                // empty frame (t<0 has no active events) until 'seeked' settles, then
                // resume at the real position.
                mt = -1;
            } else {
                if (self.clock.running) self._autoDelta = (self._renderLat + COMP_FRAMES * self._refresh) / 1000;
                mt = self.clock.now(now) + self._autoDelta + deltaS;
                if (isFinite(FPS) && FPS > 0) mt = Math.round(mt * FPS) / FPS;   // frame-lock to the video cadence
            }
            // Dedup: the frame-locked mt repeats ~2.5x per distinct video frame at the
            // 60Hz rAF rate (and is CONSTANT while paused or seeking). Subtitle output is
            // a pure function of mediaTime, so re-shipping the same time is pure waste:
            // a libass ass_render_frame + worker IPC that the changed===0 gate then drops.
            // Skipping it cuts karaoke's render-thread load ~60%->its real ~24fps floor,
            // and stops all render work on a paused/held frame. Lossless. (FPS=0 continuous
            // mode never repeats, so this is a no-op there.)
            if (mt !== self._lastMt) {
                self._lastMt = mt;
                try { self.jassub.renderAt(mt); } catch (e) {}
            }
            // fps meter
            self._fpsN++;
            if (now - self._fpsT > 1000) { self._fps = self._fpsN * 1000 / (now - self._fpsT); self._fpsN = 0; self._fpsT = now; if (self._hud) self._renderHud(ct, mt); }
            self.prevRaf = now;
            self.raf = requestAnimationFrame(tick);
        };
        this.raf = requestAnimationFrame(tick);
    };
    AssController.prototype._startHud = function () {
        if (!HUD || this._hud) return;
        var d = document.createElement('div');
        d.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483001;background:rgba(0,0,0,.7);color:#8f8;font:12px monospace;padding:4px 8px;pointer-events:none;white-space:pre';
        (document.body || document.documentElement).appendChild(d);
        this._hud = d;
        d.textContent = 'ASS ' + MODE + ' — starting…';
    };
    AssController.prototype._renderHud = function (ct, mt) {
        if (!this._hud) return;
        this._hud.textContent = 'ASS ' + MODE + '  rAF ' + this._fps.toFixed(0) + 'fps\n'
            + 'ct ' + (ct || 0).toFixed(3) + '  clk ' + (mt || 0).toFixed(3) + '\n'
            + 'run ' + this.clock.running + '  auto+' + (this._autoDelta * 1000).toFixed(0) + 'ms (rl' + this._renderLat.toFixed(0) + '+rf' + this._refresh.toFixed(0) + ')';
    };
    AssController.prototype.detach = function () {
        window.__assActive = false;   // let the app's native subtitle path resume
        if (this.raf) cancelAnimationFrame(this.raf);
        clearInterval(this._sizeT);
        var v = this.video, b = this._bound;
        try {
            v.removeEventListener('loadedmetadata', b.fixSize); v.removeEventListener('loadedmetadata', b.hard);
            v.removeEventListener('playing', b.hard); v.removeEventListener('seeked', b.seekEnd); v.removeEventListener('play', b.hard);
            v.removeEventListener('pause', b.freeze); v.removeEventListener('waiting', b.freeze);
            v.removeEventListener('seeking', b.seekStart); v.removeEventListener('stalled', b.freeze);
            v.removeEventListener('ratechange', b.rate); document.removeEventListener('visibilitychange', b.freeze);
        } catch (e) {}
        if (this.jassub) { try { this.jassub.destroy(); } catch (e) {} this.jassub = null; }
        if (this._hud) { this._hud.remove(); this._hud = null; }
    };

    function alog(m) { if (!LOG) return; try { fetch('/client-log', { method: 'POST', body: 'ASSCTL ' + m }).catch(function () {}); } catch (e) {} }

    // ---- synthetic animated test track (P1 clock-fix validation) --------------
    // Tiles a 2s spinning + horizontally sweeping marker across 30 min so motion
    // smoothness is judged independently of the demux. Jagged sweep/rotation ==
    // clock problem; smooth == fix works.
    function buildTestTrack() {
        var head = '[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n'
            + '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
            + 'Style: T,Arial,72,&H0000FFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,5,10,10,10,1\n\n'
            + '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
        function ts(s) { var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = (s % 60); return h + ':' + ('0' + m).slice(-2) + ':' + ('0' + sec.toFixed(2)).slice(-5); }
        var lines = [];
        for (var i = 0; i < 900; i++) {
            var a = i * 2, b = a + 2;
            lines.push('Dialogue: 0,' + ts(a) + ',' + ts(b) + ',T,,0,0,0,,{\\an5\\pos(960,540)\\t(0,2000,\\frz360)}► SMOOTH ◄');
            lines.push('Dialogue: 1,' + ts(a) + ',' + ts(b) + ',T,,0,0,0,,{\\an5\\move(120,320,1800,320,0,2000)}●');
            lines.push('Dialogue: 1,' + ts(a) + ',' + ts(b) + ',T,,0,0,0,,{\\an5\\move(1800,760,120,760,0,2000)}●');
        }
        return head + lines.join('\n') + '\n';
    }

    // ---- driver: attach on a player page, detach when leaving -----------------
    var cur = null;
    function playerHash() { var h = ''; try { h = decodeURIComponent(location.hash || ''); } catch (e) { h = location.hash || ''; } return /#\/player\//.test(h) ? h : null; }
    function stop() { if (cur) { cur.detach(); cur = null; window.__assCtl = null; } }   // release the detached controller + its <video>
    // While we render an embedded track (window.__assActive, set by the player
    // patch on selection), the app keeps re-enabling the DOM textTrack — the webOS
    // webview then paints the ASS track tag-stripped ("broken subs") on top of
    // ours. Keep every text track disabled so only our JASSUB shows.
    setInterval(function () {
        if (!window.__assActive) return;
        var v = document.querySelector('video'); if (!v) return;
        try { for (var i = 0; i < v.textTracks.length; i++) if (v.textTracks[i].mode !== 'disabled') v.textTracks[i].mode = 'disabled'; } catch (e) {}
    }, 250);
    // The media URL the player is actually streaming (the debrid MKV). If the
    // player was routed through our single-download tee (video.chunk.js patch),
    // currentSrc is http://127.0.0.1:<port>/s/<encodedCdnUrl> — unwrap it and flag
    // `teed` so we mirror the tee's demuxed track instead of running a 2nd extract.
    // Returns { url, teed }.
    function findMediaUrl() {
        var v = document.querySelector('video');
        var src = v && v.currentSrc;
        if (src && /^https?:/.test(src)) {
            var tm = /\/s\/([^?/]+)$/.exec(src.split('?')[0]);
            if (tm && /\/\/127\.0\.0\.1(:|\/)/.test(src)) { try { return { url: decodeURIComponent(tm[1]), teed: true }; } catch (e) {} }
            var m = /[?&]mediaURL=([^&]+)/.exec(src);
            return { url: m ? decodeURIComponent(m[1]) : src, teed: false };
        }
        try {
            var es = performance.getEntriesByType('resource');
            for (var i = es.length - 1; i >= 0; i--) {
                var m2 = /[?&]mediaURL=([^&]+)/.exec(es[i].name || '');
                if (m2) return { url: decodeURIComponent(m2[1]), teed: false };
            }
        } catch (e) {}
        return null;
    }
    // Small transient status pill (e.g. "Extracting subtitles…") shown bottom-left
    // while the first, uncached extraction runs so the wait isn't a silent void.
    var _msgEl = null, _msgT = 0;
    function subMsg(text, ms) {
        if (!LOG) return;                 // no status pills in production (opt in with assLog=1)
        if (!text) { if (_msgEl) { _msgEl.remove(); _msgEl = null; } return; }
        if (!_msgEl) {
            _msgEl = document.createElement('div');
            _msgEl.style.cssText = 'position:fixed;left:18px;bottom:18px;z-index:2147483002;background:rgba(0,0,0,.72);color:#eee;font:13px/1.4 sans-serif;padding:7px 12px;border-radius:6px;pointer-events:none;text-shadow:0 1px 2px #000';
            (document.body || document.documentElement).appendChild(_msgEl);
        }
        _msgEl.textContent = text;
        clearTimeout(_msgT);
        if (ms) _msgT = setTimeout(function () { subMsg(''); }, ms);
    }
    // Hot-swap the libass track content in place (progressive extraction feeds
    // the growing .ass in behind playback). setTrack reparses + re-renders; cheap.
    AssController.prototype.updateTrack = function (subContent) {
        if (this.jassub) { try { this.jassub.setTrack(subContent); this._lastMt = NaN; } catch (e) { alog('setTrack failed ' + (e && e.message)); } }   // reparse needs a re-render even at the same mt
    };
    // Single-download tee path: the player streams THROUGH our tee (video.chunk.js
    // patch), which demuxes subtitles from the exact bytes it forwards. We just
    // mirror the tee's growing track into JASSUB — no second extraction, and no
    // seek handling needed (the tee accumulates whatever the player fetches, seeks
    // included). This is the mpv-style single pull, verified in vactest + on-device.
    function attachViaTee(ctl, cdnUrl) {
        var attached = false, curIdx = -1, lastCount = -1, fonts = [], avail = null, uq = encodeURIComponent(cdnUrl);
        // Heavy-typesetting tracks can be tens of MB / 25k+ events; libass chokes on the
        // whole thing every frame. Only feed it events within +/-WINDOW sec of the
        // playhead, re-fetching as we advance. assSubWindow=0 => whole track (old).
        var _wv = parseFloat(lsGet('assSubWindow', '60')); var WINDOW = isNaN(_wv) ? 60 : _wv;
        var winCenter = -1e9;
        var forceReload = false;   // set by seek; the poll consumes it once
        // On-demand fonts: OFF by default — Codex found it can drop an *unnamed* CJK
        // fallback attachment (-> tofu). Opt in with assFontDemand=1 once the lossless
        // path (cmap coverage / glyph-miss hook) lands. Eager = all fonts, never tofu.
        var DEMAND = lsGet('assFontDemand', '0') === '1';
        // A seek must reliably re-pull the track even when the server-side event
        // count didn't grow (sparse track, or a previously-failed load) — force the
        // next poll to reload by invalidating lastCount.
        var onSeek = function () { forceReload = true; };
        try { if (ctl.video) ctl.video.addEventListener('seeked', onSeek); } catch (e) {}
        // window.__assSel is the subtitle track the user selected in Stremio (set by
        // the video.chunk.js patch): "EMBEDDED_<r>" for an embedded track, else an
        // external id or null. We only render — and the native subs are only
        // suppressed (via __assActive, also set by the patch) — for embedded tracks.
        function selIdx() { var s = window.__assSel; if (typeof s === 'string') { var m = /^EMBEDDED_(\d+)$/.exec(s); if (m) return +m[1]; } return -1; }
        // Commit curIdx/lastCount ONLY after a load actually applies — otherwise a
        // transient /ass/tget failure would advance the gate and never retry until
        // the event count next grows (i.e. until a seek to novel bytes).
        function load(idx, count, ph) {
            var q = '/ass/tget?u=' + uq + '&trk=' + idx;
            if (WINDOW > 0 && ph != null) q += '&t=' + ph + '&w=' + WINDOW;
            return fetch(q).then(function (r) { return r.ok ? r.text() : ''; }).then(function (ass) {
                if (ctl !== cur || !ass || ass.length < 40) return;
                if (!attached) { var furls = fonts.map(function (n) { return '/ass/tfont?u=' + uq + '&f=' + encodeURIComponent(n); }); ctl.attach(ass, furls, avail); attached = true; subMsg('Subtitles ready', 1200); alog('tee attach trk=' + idx + ' len=' + ass.length + ' eager=' + furls.length + ' avail=' + (avail ? Object.keys(avail).length : 0)); }
                else ctl.updateTrack(ass);
                curIdx = idx; lastCount = count; if (ph != null) winCenter = ph;
            });
        }
        (function poll() {
            if (ctl !== cur) { try { ctl.video && ctl.video.removeEventListener('seeked', onSeek); } catch (e) {} return; }
            var idx = selIdx();
            if (idx < 0) {   // off / external subtitle selected -> stop rendering ours
                if (attached) { alog('tee: non-embedded selected -> detach'); ctl.detach(); attached = false; curIdx = -1; lastCount = -1; }
                return setTimeout(poll, 800);
            }
            fetch('/ass/track?u=' + uq).then(function (r) { return r.json(); }).then(function (s) {
                if (ctl !== cur) return;
                if (DEMAND && s.fontEager) {                 // on-demand: eager list + name->url map
                    fonts = s.fontEager;
                    avail = {}; var _fa = s.fontAvail || {};
                    for (var _k in _fa) avail[_k] = '/ass/tfont?u=' + uq + '&f=' + encodeURIComponent(_fa[_k]);
                } else if (s.fonts && s.fonts.length) { fonts = s.fonts; avail = null; }
                // Lock the sign frame-grid to the container's real fps (unless the
                // user pinned assFps). Idempotent — same value every poll.
                if (!FPS_USER && s.videoFps > 0 && FPS !== s.videoFps) { FPS = s.videoFps; alog('frame-lock fps=' + s.videoFps.toFixed(3) + ' (from container)'); }
                var trk = (s.tracks || [])[idx];
                var ph = Math.floor((ctl.video && ctl.video.currentTime) || 0);
                var drift = WINDOW > 0 && Math.abs(ph - winCenter) > WINDOW / 3;
                // Reload ONLY when we actually need different events: first attach,
                // selection change, a seek, or the playhead drifting a third of the
                // window from center. NOT on mere event-count growth: the streaming
                // demuxer's total count climbs every poll (~1.5s) as it parses ahead,
                // and reparsing the whole 6MB/20k-event OP track (a full libass
                // setTrack) froze the worker ~0.5-1.5s EACH time -> the OP was frozen a
                // third of the time. Drift-following keeps ~WINDOW of future loaded, so
                // forward playback stays covered without the reparse storm.
                if (trk && trk.events > 0 && (idx !== curIdx || !attached || forceReload || drift)) {
                    forceReload = false;
                    load(idx, trk.events, ph);   // commits only on success
                }
                setTimeout(poll, attached ? 1500 : 600);
            }).catch(function () { setTimeout(poll, 1500); });
        })();
    }
    // Streaming, playhead-following demux. We open a server session at the current
    // play position, then poll: each poll REPORTS our playhead (so the server keeps
    // the demux window just ahead of us) and refreshes the in-memory track as it
    // grows. On a real seek we tell the server to re-anchor at the new position, so
    // subs show up wherever you jump — no full-file download, no stale track.
    function extractAndAttach(ctl, mediaUrl) {
        var key = null, tries = 0, attached = false, lastLen = 0, lastSwap = 0, dead = false, lastFonts = [];
        function ph() { return Math.max(0, Math.floor((ctl.video && ctl.video.currentTime) || 0)); }
        function gone() { return ctl !== cur || !ctl.video; }
        function loadTrack(first) {
            return fetch('/ass/get?key=' + key).then(function (r) { return r.ok ? r.text() : ''; }).then(function (ass) {
                if (ctl !== cur || !ass || ass.length < 40) return;
                if (first && !attached) {
                    var fonts = lastFonts.map(function (f) { return '/ass/font?key=' + key + '&f=' + encodeURIComponent(f); });
                    ctl.attach(ass, fonts); attached = true; subMsg('Subtitles ready', 1500);
                    alog('attached streaming len=' + ass.length + ' t=' + ph() + 's fonts=' + fonts.length);
                } else if (attached) { ctl.updateTrack(ass); }
                lastLen = ass.length; lastSwap = Date.now();
            });
        }
        // A real seek: re-anchor the server window at the new playhead, then pull
        // the fresh region. lastLen=-1 makes the next poll refresh even though the
        // reset track is SHORTER than the pre-seek one.
        function onSeek() {
            if (gone()) { try { ctl.video && ctl.video.removeEventListener('seeked', onSeek); } catch (e) {} return; }
            if (!key) return;
            lastLen = -1;
            fetch('/ass/status?key=' + key + '&t=' + ph() + '&seek=1').then(function () {
                setTimeout(function () { if (attached && ctl === cur) loadTrack(false); }, 600);
            }).catch(function () {});
        }
        try { ctl.video && ctl.video.addEventListener('seeked', onSeek); } catch (e) {}
        (function poll() {
            if (gone()) { try { ctl.video && ctl.video.removeEventListener('seeked', onSeek); } catch (e) {} return; }
            if (dead) return;   // hard error only; poll otherwise runs for the whole session
            var url = key ? '/ass/status?key=' + key + '&t=' + ph() + '&seek=0'
                          : '/ass/prepare?u=' + encodeURIComponent(mediaUrl) + '&t=' + ph();
            fetch(url).then(function (r) { return r.json(); }).then(function (s) {
                if (ctl !== cur) return;
                if (s.key) key = s.key;
                if (s.fonts && s.fonts.length) lastFonts = s.fonts;
                if (s.ass && key) {
                    var changed = s.bytes !== lastLen && (Date.now() - lastSwap) > 1200;
                    if (!attached || changed) loadTrack(!attached);
                } else if (!attached && s.state !== 'error') { subMsg('Extracting subtitles…'); }
                if (s.state === 'error') { if (!attached) subMsg('Subtitles unavailable', 4000); alog('extract error ' + (s.error || '')); dead = true; return; }
                setTimeout(poll, attached ? 2000 : 700);
            }).catch(function () { setTimeout(poll, 1500); });
        })();
    }
    // Binge prefetch: while this episode plays, resolve the SAME release group's
    // stream for the next 3 episodes and pre-extract their subs so the binge
    // rollover is instant. Group identity = the torrent infohash (shared across a
    // season pack) with a fallback to the [Group] bracket tag.
    function currentEpId() {
        var h = ''; try { h = decodeURIComponent(location.hash || ''); } catch (e) { h = location.hash || ''; }
        var m = h.match(/kitsu:\d+:\d+/) || h.match(/kitsu:\d+/);
        return m ? m[0] : null;
    }
    // Binge stream-lock: build a valid app #/player hash for a chosen same-group
    // stream, so auto-play-next stays on the release group we pre-extracted. The
    // app encodes the stream object as a zlib STORED block + base64 in the hash's
    // first segment; we reproduce that byte-for-byte in pure JS (verified against
    // the app's inflate). Fails safe (returns null -> app uses its own choice).
    (function () {
        function adler32(b) { var a = 1, c = 0; for (var i = 0; i < b.length; i++) { a = (a + b[i]) % 65521; c = (c + a) % 65521; } return ((c * 65536) + a) >>> 0; }
        function zlibStore(bytes) {
            var len = bytes.length;
            var out = [0x78, 0x01, 0x01, len & 0xff, (len >> 8) & 0xff, (~len) & 0xff, ((~len) >> 8) & 0xff];
            for (var i = 0; i < len; i++) out.push(bytes[i]);
            var ad = adler32(bytes);
            out.push((ad >>> 24) & 0xff, (ad >>> 16) & 0xff, (ad >>> 8) & 0xff, ad & 0xff);
            return out;
        }
        function encodeStream(obj) {
            var j = unescape(encodeURIComponent(JSON.stringify(obj)));   // UTF-8 bytes
            var bytes = []; for (var i = 0; i < j.length; i++) bytes.push(j.charCodeAt(i) & 0xff);
            var z = zlibStore(bytes), s = ''; for (var k = 0; k < z.length; k++) s += String.fromCharCode(z[k]);
            return btoa(s);
        }
        window.__assBinge = {
            streams: {},                       // epId -> stream object (from prefetch)
            lockHash: function (nextEpId) {     // called by the video.chunk.js binge patch
                try {
                    var so = nextEpId && this.streams[nextEpId]; if (!so) return null;
                    var segs = location.hash.replace(/^#\/player\//, '').split('/');
                    if (segs.length < 6) return null;
                    segs[0] = encodeURIComponent(encodeStream(so));            // the stream blob
                    segs[segs.length - 1] = encodeURIComponent(nextEpId);      // the episode id
                    delete this.streams[nextEpId];                            // consumed -> release
                    return '#/player/' + segs.join('/');
                } catch (e) { return null; }
            }
        };
    })();
    function prefetchNext(mediaUrl) {
        var m = /\/resolve\/[^\/]+\/([^\/]+)\/([0-9a-f]{40}|[0-9a-f]{32})\/([^\/]+)/.exec(mediaUrl);
        var epId = currentEpId();
        if (!m || !epId) { alog('prefetch: no infohash/epId'); return; }
        var token = m[1], infohash = m[2];
        var fname = ''; try { fname = decodeURIComponent(m[3]); } catch (e) { fname = m[3]; }
        var grp = (fname.match(/\[([^\]]+)\]/) || [])[1] || '';
        var cfg = 'torbox=' + token;
        var n = parseInt(lsGet('assPrefetchN', '3'), 10); if (isNaN(n) || n < 0) n = 3;   // 0 disables prefetch
        if (n === 0) { alog('prefetch disabled'); return; }
        fetch('/next-episodes?id=' + encodeURIComponent(epId) + '&n=' + n).then(function (r) { return r.json(); }).then(function (d) {
            (d.next || []).forEach(function (nid) {
                fetch('/anime-streams?cfg=' + encodeURIComponent(cfg) + '&id=' + encodeURIComponent(nid))
                    .then(function (r) { return r.json(); }).then(function (sd) {
                        var streams = sd.streams || [];
                        var pick = streams.find(function (s) { return (s.url || '').indexOf(infohash) >= 0; })   // same pack
                            || (grp && streams.find(function (s) { return (((s.title || '') + (s.description || '')).indexOf('[' + grp + ']') >= 0); }));
                        if (pick && pick.url) {
                            fetch('/ass/prepare?u=' + encodeURIComponent(pick.url)).catch(function () {});
                            // Remember the same-group stream so binge locks onto it.
                            if (window.__assBinge) {
                                var _st = window.__assBinge.streams;
                                _st[nid] = {
                                    url: pick.url, name: pick.name || '',
                                    description: pick.title || pick.description || '',
                                    behaviorHints: pick.behaviorHints || {}
                                };
                                var _ks = Object.keys(_st); if (_ks.length > 6) delete _st[_ks[0]];   // cap
                            }
                            alog('prefetch ' + nid + ' -> ' + (pick.title || pick.name || '').replace(/\n/g, ' ').slice(0, 40));
                        } else alog('prefetch ' + nid + ': no same-group stream');
                    }).catch(function () {});
            });
        }).catch(function () {});
    }
    function begin() {
        var v = document.querySelector('video');
        if (!v || v.readyState < 1) return false;
        cur = new AssController(v);
        window.__assCtl = cur;
        var subUrl = lsGet('assSubUrl', '');          // dev override: point at a served .ass
        if (subUrl) {
            var fonts = []; try { fonts = JSON.parse(lsGet('assFonts', '[]')); } catch (e) {}
            fetch(subUrl).then(function (r) { return r.text(); }).then(function (t) {
                if (cur) { cur.attach(t, fonts); alog('attached override len=' + t.length); }
            }).catch(function (e) { alog('override fetch failed ' + (e && e.message)); });
        } else if (lsGet('assTest', '0') === '1') {   // synthetic motion-test track (opt-in)
            cur.attach(buildTestTrack(), []); alog('attached TEST track');
        } else {                                       // default: auto-extract from the MKV
            var made = cur;
            (function waitMedia(n) {
                if (made !== cur) return;
                var mi = findMediaUrl();
                if (mi && mi.url) {
                    if (mi.teed) { alog('tee mode: ' + mi.url.slice(0, 48)); attachViaTee(cur, mi.url); }
                    else { extractAndAttach(cur, mi.url); setTimeout(function () { if (made === cur) prefetchNext(mi.url); }, 30000); }
                }
                else if (n < 60) setTimeout(function () { waitMedia(n + 1); }, 500);
                else alog('no media url after 30s');
            })(0);
        }
        return true;
    }
    // Manual re-attach on the live page without reload (dev helper).
    window.__assReattach = function (subUrl, fontUrls) {
        stop(); started = false;
        var v = document.querySelector('video');
        if (!v) return 'no video';
        cur = new AssController(v); window.__assCtl = cur; started = true;
        if (subUrl) {
            fetch(subUrl).then(function (r) { return r.text(); }).then(function (t) {
                if (cur) { cur.attach(t, fontUrls || []); alog('reattach real len=' + t.length); }
            }).catch(function (e) { alog('reattach fetch failed ' + (e && e.message)); });
            return 'attaching ' + subUrl;
        }
        cur.attach(buildTestTrack(), []); return 'test track';
    };
    var started = false;
    setInterval(function () {
        var h = playerHash();
        if (h) { if (!started) started = begin(); }
        else { if (started || cur) { stop(); started = false; } }
    }, 700);
    window.__assCtlLoaded = true;
})();
