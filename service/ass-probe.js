/*
 * P0 probe harness for the full-fidelity ASS subtitle rendering plan.
 * See docs/ASS-SUBTITLE-RENDERING-PLAN.md §6 (P0) and §8.
 *
 * Runs four read-only, non-mutating probes on the real TV while an anime
 * episode plays, then renders an on-screen overlay AND POSTs raw JSON to
 * /client-log (the service appends it to /tmp/stremio-ass-probe.log and
 * console). Nothing here changes playback — it only measures.
 *
 *   A  clock cadence  — reconfirm the 5Hz `video.currentTime` reset root cause
 *   B  media CORS/Range — can we demux the MKV in-page, or must it be the Node service
 *   C  com.webos.media — does the retail LS2 ACL permit subscribe, and at what Hz
 *   D  codec           — HEVC10 / Hi10P? (closes WebCodecs for good; via server ffprobe)
 *
 * Auto-runs on any player page unless localStorage 'assProbeOff' === '1'.
 * Remove the <script src="/ass-probe.js"> from index.html to ship without it.
 */
(function () {
    'use strict';
    if (window.__assProbeLoaded) return;
    window.__assProbeLoaded = true;
    try { if (localStorage.getItem('assProbeOff') === '1') return; } catch (e) {}

    var results = { ts: null, ua: navigator.userAgent, probes: {} };
    // Exposed for off-device capture via the WebAppManager inspector (CDP :9998):
    //   Runtime.evaluate JSON.stringify(window.__assResults)
    window.__assResults = results;

    // ---- output channels -----------------------------------------------------
    function post() {
        try {
            fetch('/client-log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag: 'ASS-PROBE', data: results })
            }).catch(function () {});
        } catch (e) {}
    }

    var ov, ovBody;
    function overlay() {
        if (ov) return;
        ov = document.createElement('div');
        ov.id = '__assProbeOverlay';
        ov.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'width:62vw', 'max-height:100vh',
            'overflow:auto', 'z-index:2147483000', 'background:rgba(0,0,0,.85)',
            'color:#eee', 'font:14px/1.45 monospace', 'padding:12px 16px',
            'white-space:pre-wrap', 'pointer-events:none',
            'text-shadow:0 1px 2px #000', 'box-sizing:border-box'
        ].join(';');
        var h = document.createElement('div');
        h.style.cssText = 'font-weight:700;font-size:16px;color:#7bf;margin-bottom:8px';
        h.textContent = 'ASS P0 PROBE';
        ovBody = document.createElement('div');
        ov.appendChild(h); ov.appendChild(ovBody);
        (document.body || document.documentElement).appendChild(ov);
    }
    function render() {
        if (!ovBody) return;
        var p = results.probes, out = [];
        ['A_clock', 'B_media', 'C_luna', 'D_codec'].forEach(function (k) {
            var r = p[k];
            out.push('── ' + k.replace('_', '  ') + (r ? (r._done ? '  ✓' : '  …') : '  ·'));
            if (r && r.lines) r.lines.forEach(function (l) { out.push('   ' + l); });
        });
        out.push('');
        out.push(results._allDone ? '● all probes done — posted to /client-log'
                                  : '○ running…');
        out.push('  log: /tmp/stremio-ass-probe.log (pull via ares/SSH)');
        ovBody.textContent = out.join('\n');
    }
    function set(key, obj) {
        results.probes[key] = Object.assign(results.probes[key] || {}, obj);
        render();
    }
    function done(key) {
        set(key, { _done: true });
        var p = results.probes;
        if (p.A_clock && p.A_clock._done && p.B_media && p.B_media._done &&
            p.C_luna && p.C_luna._done && p.D_codec && p.D_codec._done) {
            results._allDone = true; render(); post();
        }
    }

    // ---- shared helpers ------------------------------------------------------
    function video() { return document.querySelector('video'); }
    function findMediaUrl() {
        var v = video();
        if (v && v.currentSrc && /^https?:/.test(v.currentSrc)) {
            var m = /[?&]mediaURL=([^&]+)/.exec(v.currentSrc);
            if (m) return decodeURIComponent(m[1]);
            return v.currentSrc;
        }
        try {
            var es = performance.getEntriesByType('resource');
            for (var i = es.length - 1; i >= 0; i--) {
                var m2 = /[?&]mediaURL=([^&]+)/.exec(es[i].name || '');
                if (m2) return decodeURIComponent(m2[1]);
            }
        } catch (e) {}
        return null;
    }
    function host(u) { try { return new URL(u).host; } catch (e) { return '?'; } }

    // ==== Probe A: clock cadence / 5Hz reset root cause =======================
    // Sample video.currentTime every rAF for ~10s. Count distinct values/sec and
    // the staircase step, and measure how far a smooth extrapolated clock drifts
    // from the raw samples we'd otherwise feed libass every tick.
    function probeA() {
        var v = video();
        if (!v) { set('A_clock', { lines: ['no <video> yet'] }); return setTimeout(probeA, 700); }
        set('A_clock', { lines: ['sampling 10s…'] });
        var t0 = performance.now();
        var ticks = 0, changes = 0;
        var lastCT = -1, lastChangePerf = t0, lastChangeCT = -1;
        var steps = [], gaps = [];           // step = CT jump; gap = ms between changes
        var anchorCT = -1, anchorPerf = t0;  // synthetic clock anchor (set on 1st change)
        var synthErr = [];                   // |synthetic - actual| at each change (ms)

        function tick(now) {
            ticks++;
            var ct = v.currentTime;
            if (ct !== lastCT) {
                if (lastChangeCT >= 0) {
                    steps.push(+(ct - lastChangeCT).toFixed(4));
                    gaps.push(+(now - lastChangePerf).toFixed(1));
                }
                if (anchorCT < 0) { anchorCT = ct; anchorPerf = now; }
                else {
                    var synth = anchorCT + (now - anchorPerf) / 1000 * (v.playbackRate || 1);
                    synthErr.push(Math.abs(synth - ct) * 1000);
                }
                changes++; lastChangeCT = ct; lastChangePerf = now;
            }
            lastCT = ct;
            if (now - t0 < 10000) return requestAnimationFrame(tick);

            var secs = (now - t0) / 1000;
            var med = function (a) { a = a.slice().sort(function (x, y) { return x - y; }); return a.length ? a[Math.floor(a.length / 2)] : 0; };
            var mx = function (a) { return a.length ? Math.max.apply(null, a) : 0; };
            set('A_clock', { lines: [
                'rAF fps:            ' + (ticks / secs).toFixed(1),
                'distinct CT / sec:  ' + (changes / secs).toFixed(2) + '   (≈5 ⇒ 5Hz clock)',
                'CT step (median):   ' + med(steps).toFixed(3) + 's  (≈0.20 ⇒ 200ms quanta)',
                'change gap ms:      med ' + med(gaps).toFixed(0) + '  max ' + mx(gaps).toFixed(0),
                'synth-vs-raw drift: med ' + med(synthErr).toFixed(0) + 'ms  max ' + mx(synthErr).toFixed(0) + 'ms',
                'VERDICT: ' + ((changes / secs) < 8 && med(steps) > 0.1
                    ? 'CONFIRMED 5Hz staircase — feeding raw CT/tick is the jaggedness'
                    : 'unexpected — capture raw and review'),
                'raw: changes=' + changes + ' ticks=' + ticks + ' secs=' + secs.toFixed(1)
            ] });
            results.probes.A_clock.raw = { ticks: ticks, changes: changes, secs: secs, steps: steps, gaps: gaps, synthErr: synthErr };
            done('A_clock');
        }
        requestAnimationFrame(tick);
    }

    // ==== Probe B: media URL CORS + Range =====================================
    // Decides in-page demux (needs CORS + 206 Range on the TorBox MKV) vs the
    // Node service demux fallback.
    function probeB() {
        var v = video();
        var src = v && v.currentSrc || '';
        var mu = findMediaUrl();
        set('B_media', { lines: ['probing…', 'currentSrc host: ' + host(src), 'mediaURL host:   ' + (mu ? host(mu) : 'none')] });
        results.probes.B_media.currentSrc = src;
        results.probes.B_media.mediaUrl = mu;
        var target = mu || src;
        if (!target || !/^https?:/.test(target)) {
            set('B_media', { lines: ['no fetchable media URL found', 'currentSrc: ' + (src || '∅')] });
            return done('B_media');
        }
        var lines = ['currentSrc host: ' + host(src), 'mediaURL host:   ' + (mu ? host(mu) : 'none')];
        var t0 = performance.now();
        // Default (cors) mode: a server without ACAO will reject with TypeError.
        fetch(target, { method: 'GET', headers: { Range: 'bytes=0-1' } }).then(function (r) {
            var g = function (h) { return r.headers.get(h) || '∅'; };
            var info = {
                status: r.status,
                acao: g('access-control-allow-origin'),
                acceptRanges: g('accept-ranges'),
                contentRange: g('content-range'),
                contentType: g('content-type'),
                rttMs: Math.round(performance.now() - t0)
            };
            results.probes.B_media.fetch = info;
            var rangeOk = r.status === 206 || info.contentRange !== '∅' || info.acceptRanges.toLowerCase().indexOf('bytes') >= 0;
            var corsOk = info.acao === '*' || info.acao !== '∅';
            lines.push('status:        ' + info.status + '  (' + info.rttMs + 'ms)');
            lines.push('ACA-Origin:    ' + info.acao);
            lines.push('Accept-Ranges: ' + info.acceptRanges + '   Content-Range: ' + info.contentRange);
            lines.push('VERDICT: ' + (corsOk && rangeOk
                ? 'IN-PAGE demux viable (CORS+Range OK) — classic worker'
                : 'use NODE demux (' + (!corsOk ? 'no CORS' : 'no Range') + ')'));
            try { r.body && r.body.cancel && r.body.cancel(); } catch (e) {}
            set('B_media', { lines: lines });
            done('B_media');
        }).catch(function (e) {
            results.probes.B_media.fetch = { error: String(e && e.message || e) };
            lines.push('fetch THREW: ' + String(e && e.message || e));
            lines.push('VERDICT: use NODE demux (cross-origin fetch blocked / no CORS)');
            set('B_media', { lines: lines });
            done('B_media');
        });
    }

    // ==== Probe C: com.webos.media subscribe ACL + Hz =========================
    // Confirms the retail LS2 ACL permits a com.webos.media subscribe and, if we
    // can discover a mediaId, measures the real emission Hz + quantization.
    function probeC() {
        var svc = window.webOS && window.webOS.service && window.webOS.service.request;
        if (!svc) {
            set('C_luna', { lines: ['window.webOS.service.request: MISSING',
                'VERDICT: luna bridge unavailable from page — use CT-transition anchor'] });
            return done('C_luna');
        }
        set('C_luna', { lines: ['bridge present — probing ACL…'] });
        var lines = ['window.webOS.service.request: present'];
        var log = {};
        results.probes.C_luna.calls = log;

        function call(method, params, cb) {
            var uri = 'luna://com.webos.media';
            var t0 = performance.now();
            var sub = { subscribe: !!(params && params.subscribe) };
            var req;
            try {
                req = window.webOS.service.request(uri, {
                    method: method,
                    parameters: params || {},
                    onSuccess: function (r) { cb(null, r, Math.round(performance.now() - t0), req); },
                    onFailure: function (e) { cb(e, null, Math.round(performance.now() - t0), req); },
                    subscribe: sub.subscribe
                });
            } catch (e) { cb({ errorText: String(e && e.message || e) }, null, 0, null); }
        }

        // Step 1: can we call com.webos.media at all? getActivePipelines returns
        // active pipelines (with mediaId) if the ACL permits it.
        call('getActivePipelines', { subscribe: false }, function (err, r, ms) {
            if (err) {
                log.getActivePipelines = { error: err };
                lines.push('getActivePipelines: DENIED ' + JSON.stringify(err).slice(0, 120));
                lines.push('VERDICT: ACL blocks com.webos.media — fall back to CT transitions');
                set('C_luna', { lines: lines });
                return done('C_luna');
            }
            log.getActivePipelines = { ok: r, ms: ms };
            var mediaId = null;
            try {
                var arr = (r && (r.pipelines || r.activePipelines || r.data)) || [];
                for (var i = 0; i < arr.length; i++) {
                    if (arr[i] && (arr[i].mediaId || arr[i].id)) { mediaId = arr[i].mediaId || arr[i].id; break; }
                }
            } catch (e) {}
            lines.push('getActivePipelines: OK (' + ms + 'ms)  mediaId=' + (mediaId || 'not-found'));
            set('C_luna', { lines: lines });
            if (!mediaId) {
                lines.push('VERDICT: ACL OK, but no mediaId here — read d.mediaId at the');
                lines.push('   patch point (video.chunk.js ~18790) during integration');
                set('C_luna', { lines: lines });
                return done('C_luna');
            }
            // Step 2: subscribe to currentTime; measure Hz + quantization over ~5s.
            var vals = [], arr = [], t0 = performance.now(), lastV = null;
            lines.push('subscribing currentTime for 5s…');
            set('C_luna', { lines: lines });
            call('subscribe', { mediaId: mediaId, subscribe: true }, function (err2, r2, ms2, req2) {
                if (err2) { log.subscribe = { error: err2 }; return; }
                var ct = r2 && (r2.currentTime != null ? r2.currentTime : (r2.sourceInfo && r2.sourceInfo.currentTime));
                if (ct != null && ct !== lastV) { vals.push({ ct: ct, at: Math.round(performance.now() - t0) }); lastV = ct; }
                if (performance.now() - t0 > 5000 && !log.subscribe) {
                    try { req2 && req2.cancel && req2.cancel(); } catch (e) {}
                    var n = vals.length, secs = 5;
                    var gaps = [];
                    for (var j = 1; j < n; j++) gaps.push(vals[j].at - vals[j - 1].at);
                    gaps.sort(function (a, b) { return a - b; });
                    log.subscribe = { count: n, sample: vals.slice(0, 8), medGapMs: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0 };
                    var isInt = vals.every(function (x) { return Math.abs(x.ct - Math.round(x.ct)) < 1e-6 || Math.abs(x.ct * 1000 - Math.round(x.ct * 1000)) < 1; });
                    lines.push('subscribe: ' + (n / secs).toFixed(1) + ' Hz, med gap ' + (log.subscribe.medGapMs) + 'ms');
                    lines.push('   integer-ms values: ' + (isInt ? 'YES (finer than 200ms)' : 'no'));
                    lines.push('VERDICT: subscribe USABLE as PLL hard-anchor');
                    set('C_luna', { lines: lines });
                    done('C_luna');
                }
            });
            // Safety: if no emissions at all in 6s, close out.
            setTimeout(function () {
                if (!log.subscribe) {
                    log.subscribe = { count: vals.length, note: 'no/low emissions' };
                    lines.push('subscribe: ' + vals.length + ' emissions in 6s — ' + (vals.length ? 'sparse' : 'none'));
                    lines.push('VERDICT: ' + (vals.length ? 'weak anchor — prefer CT transitions' : 'no data — use CT transitions'));
                    set('C_luna', { lines: lines });
                    done('C_luna');
                }
            }, 6200);
        });
    }

    // ==== Probe D: codec (server ffprobe) =====================================
    // Definitively answers HEVC10 / Hi10P — closes the WebCodecs path.
    function probeD() {
        var mu = findMediaUrl();
        if (!mu) { set('D_codec', { lines: ['no media URL to ffprobe'] }); return done('D_codec'); }
        set('D_codec', { lines: ['ffprobe (server)…'] });
        fetch('/probe-codec?u=' + encodeURIComponent(mu)).then(function (r) { return r.json(); }).then(function (d) {
            results.probes.D_codec.raw = d;
            if (d.error) { set('D_codec', { lines: ['ffprobe error: ' + d.error] }); return done('D_codec'); }
            var tenBit = /10|hi10|p010|yuv420p10/i.test((d.pix_fmt || '') + ' ' + (d.profile || '') + ' ' + (d.bits_per_raw_sample || ''));
            var hevc = /hevc|h\.?265/i.test(d.codec_name || '');
            set('D_codec', { lines: [
                'codec:   ' + (d.codec_name || '?') + '   profile: ' + (d.profile || '?'),
                'pix_fmt: ' + (d.pix_fmt || '?') + '   bits: ' + (d.bits_per_raw_sample || '?'),
                'size:    ' + (d.width || '?') + 'x' + (d.height || '?'),
                'VERDICT: ' + ((tenBit || hevc)
                    ? 'WebCodecs DEAD (' + (hevc ? 'HEVC' : '') + (tenBit ? ' 10-bit' : '') + ' — no Chromium sw fallback)'
                    : '8-bit ' + (d.codec_name || '') + ' — WebCodecs *might* run, but still no win')
            ] });
            done('D_codec');
        }).catch(function (e) {
            set('D_codec', { lines: ['/probe-codec failed: ' + String(e && e.message || e), '(is the launch.js route deployed?)'] });
            done('D_codec');
        });
    }

    // ---- driver: start once a player video is present & playing --------------
    var started = false;
    function maybeStart() {
        if (started) return;
        var h = '';
        try { h = decodeURIComponent(location.hash || ''); } catch (e) { h = location.hash || ''; }
        if (!/#\/player\//.test(h)) return;
        var v = video();
        if (!v || v.readyState < 1) return;
        started = true;
        results.ts = new Date().toISOString ? undefined : null; // stamped server-side
        overlay(); render();
        set('A_clock', { lines: ['waiting for playback…'] });
        set('B_media', {}); set('C_luna', {}); set('D_codec', {});
        probeA(); probeB(); probeC(); probeD();
    }
    setInterval(maybeStart, 700);
})();
