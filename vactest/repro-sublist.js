// LOCAL DETERMINISTIC REPRO of "embedded subtitle list sometimes doesn't populate
// on a fresh stream; replaying fixes it."
//
// On this webOS TV the video is decoded natively, so embedded subtitle tracks do
// NOT surface as HTML5 textTracks (confirmed on-device: video.textTracks.length===0
// while EMBEDDED_0 plays). The embedded subtitle LIST therefore has exactly one
// source: a /tracks/<url> fetch to the streaming server, consumed by F() in
// video.chunk.js (~line 21250).
//
// This harness drives:
//   - the REAL module-4775 fetcher logic (fetch /tracks/, 10s abort, filter
//     audio/text, cb({audio,subs}) on success / cb(false) on failure), and
//   - the REAL F() consumption logic (single-shot P latch; build list `y`; fire the
//     "subtitlesTracks changed" notify ONLY when subs.length; never retry),
// both transcribed line-for-line from service/www/video.chunk.js, against a mock
// streaming server that returns [] for the first COLD_PROBES requests (a cold probe
// that hasn't ffprobed the file yet) and the real tracks afterwards (warm).
//
// It runs the CURRENT (single-shot) F() and the PROPOSED (retrying) F() and reports,
// for each, whether the subtitle list ever populated.

var http = require('http');

var COLD_PROBES = +(process.env.COLD || 3);   // how many probes are empty before the server warms
var REAL_TRACKS = [
    { type: 'video', codec: 'h264' },
    { type: 'audio', codec: 'aac', lang: 'jpn', label: null },
    { type: 'text', codec: 'ass', lang: 'eng', label: 'Full Subtitles' }
];

// ---- mock streaming server: cold (empty) for the first COLD_PROBES, then warm ----
var probeCount = 0;
var srv = http.createServer(function (req, res) {
    if (req.url.indexOf('/tracks/') === 0) {
        probeCount++;
        var cold = probeCount <= COLD_PROBES;
        res.writeHead(200, { 'content-type': 'application/json' });
        // The streaming server returns an EMPTY ARRAY while it is still probing.
        res.end(JSON.stringify(cold ? [] : REAL_TRACKS));
    } else { res.writeHead(404); res.end(); }
});

// ---- REAL module-4775 fetcher (transcribed from video.chunk.js) ------------------
function makeFetcher(base) {
    return function o(e, t) {                                  // o(url, cb)
        var _ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var _timer = setTimeout(function () { _ctrl && _ctrl.abort(); }, 10000);
        fetch(base + '/tracks/' + encodeURIComponent(e), _ctrl ? { signal: _ctrl.signal } : {})
            .then(function (e) { return e.json(); })
            .then(function (e) {
                clearTimeout(_timer);
                var r = e.filter(function (e) { return 'audio' === (e || {}).type; });
                var n = e.filter(function (e) { return 'text' === (e || {}).type; });
                t({ audio: r, subs: n });
            })
            .catch(function (e) { clearTimeout(_timer); t(!1); });
    };
}

// ---- run one scenario with a given F() implementation ----------------------------
function run(label, Fimpl, done) {
    var base = 'http://127.0.0.1:' + srv.address().port;
    var o = makeFetcher(base);
    // component state, mirroring the module-21250 closure
    var state = {
        D: { url: 'http://127.0.0.1:11474/s/https%3A%2F%2Fcdn%2Fep.mkv' },   // stream (non-null)
        M: { audio: [], subs: [] },
        y: [],            // subtitlesTracks list (the getter returns this)
        T: [],            // audioTracks list
        p: null, v: null, // selected sub / audio
        P: false,         // the single-shot latch
        notifies: []      // every G("subtitlesTracks") call, with the list length at that moment
    };
    function G(prop) { if (prop === 'subtitlesTracks') state.notifies.push(state.y.length); }
    Fimpl(state, o, G, function () {
        done({
            label: label,
            probes: probeCount,
            listPopulated: state.y.length > 0,
            subCount: state.y.length,
            notifyCount: state.notifies.length
        });
    });
}

// ---- CURRENT F(): single-shot, gated notify (video.chunk.js:21250, verbatim) -----
function F_current(s, o, G, finish) {
    (function F() {
        s.P || null === s.D || (s.P = !0, o(s.D.url, function (e) {
            var t = 0, r = 0;
            s.y = [], s.T = [], e && (s.M = e);
            ((s.M || {}).subs || []).length && (s.M.subs.forEach(function (e) {
                var r = t; t++, s.p || s.y.length || (s.p = r), s.y.push({ id: 'EMBEDDED_' + r, lang: e.lang || 'eng', label: e.label || null, origin: 'EMBEDDED', embedded: !0, mode: r === s.p ? 'showing' : 'disabled' });
            }), G('subtitlesTracks'), G('selectedSubtitlesTrackId'));
            // (audio branch omitted — not what this repro measures)
            finish();
        }));
    })();
    // the real code has no callback for "done"; give the single shot time to resolve
    setTimeout(function () { if (!s._f) { s._f = 1; } }, 0);
}

// ---- PROPOSED F(): retry the probe with backoff until it yields tracks ------------
function F_fixed(s, o, G, finish) {
    var attempt = 0, MAX = 15;
    s.P || null === s.D || (s.P = !0, (function tryFetch() {
        if (null === s.D) return finish();
        o(s.D.url, function (e) {
            if (null === s.D) return finish();
            var t = 0;
            s.y = [], s.T = [], e && (s.M = e);
            var hasSubs = ((s.M || {}).subs || []).length;
            var hasAudio = ((s.M || {}).audio || []).length;
            hasSubs && (s.M.subs.forEach(function (e) {
                var r = t; t++, s.p || s.y.length || (s.p = r), s.y.push({ id: 'EMBEDDED_' + r, lang: e.lang || 'eng', label: e.label || null, origin: 'EMBEDDED', embedded: !0, mode: r === s.p ? 'showing' : 'disabled' });
            }), G('subtitlesTracks'), G('selectedSubtitlesTrackId'));
            // Empty probe (cold, still ffprobing) -> both empty. Retry with backoff.
            // Audio present but no subs -> probe done, file genuinely has no subs -> stop.
            if (!hasSubs && !hasAudio && ++attempt < MAX) { setTimeout(tryFetch, 5); return; }
            finish();
        });
    })());
}

// ---- drive both scenarios sequentially -------------------------------------------
srv.listen(0, '127.0.0.1', function () {
    console.log('Cold probes before the streaming server warms up: ' + COLD_PROBES + '\n');
    probeCount = 0;
    run('CURRENT (single-shot)', F_current, function (a) {
        probeCount = 0;
        run('FIXED (retry until tracks)', F_fixed, function (b) {
            [a, b].forEach(function (r) {
                console.log('  ' + r.label);
                console.log('    /tracks probes issued : ' + r.probes);
                console.log('    subtitle list populated: ' + (r.listPopulated ? 'YES (' + r.subCount + ' track)' : '*** NO — list stayed empty ***'));
                console.log('    subtitlesTracks notifies: ' + r.notifyCount + '\n');
            });
            var pass = !a.listPopulated && b.listPopulated;
            console.log(pass
                ? 'REPRODUCED: current build leaves the list empty on a cold probe; the fix populates it.'
                : 'INCONCLUSIVE: expected current=empty, fixed=populated (got current=' + a.listPopulated + ', fixed=' + b.listPopulated + ')');
            srv.close();
            process.exit(pass ? 0 : 1);
        });
    });
});
