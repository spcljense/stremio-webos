// LOCAL DETERMINISTIC REPRO of the "subs randomly disappear mid-episode" bug.
//
// Everything below the controller is the REAL SHIPPED CODE:
//   - service/ass-tee.js      : required as-is. Its HTTP tee listens on 127.0.0.1:11474,
//                               its Session/_sink/newDemux/trackText/status run untouched,
//                               and its BACKPRESSURE (res.write()===false -> up.pause(),
//                               res 'drain' -> up.resume()) is exercised over REAL sockets.
//   - service/mkv-subs.js     : the real streaming demuxer (via the tee).
//   - service/ass-proxy.js    : the real CDN fetch (via the tee).
//   - Session.trackText()     : the real +/-WINDOW event filter (ass-tee.js:116-131).
//
// Simulated (and only these):
//   - the CDN            : a local range-serving HTTP file server
//   - the player         : a real HTTP client on the tee that reads at ~playback rate and
//                          stops reading once it holds R seconds of media ahead of its
//                          playhead. Because it stops reading a REAL socket, the tee's
//                          res.write() really does return false and up.pause() really fires.
//   - the controller     : the poll loop of service/overlay/ass-controller.js:498-558,
//                          transcribed line-for-line (it's browser code; it cannot be
//                          require()d). It calls the REAL assTee.status()/assTee.trackText()
//                          exactly as launch.js:455-466 does.
//
// Time is compressed SPEED x (media seconds per wall second). The controller's poll
// interval is scaled by the same factor, so the MEDIA-TIME geometry (poll cadence vs
// drift threshold vs read-ahead) is identical to the TV. Byte<->media-time is exact:
// mkv-gen writes exactly one cluster == one second == BYTES_PER_SEC bytes.

var http = require('http');
var fs = require('fs');
var path = require('path');
var G = require('./mkv-gen.js');
var TEE = require('../service/ass-tee.js');    // starts the real tee on 127.0.0.1:11474

// ---- config ------------------------------------------------------------------
var DUR = +(process.env.DUR || 300);            // media seconds
var BITRATE = +(process.env.BITRATE || 8e6);    // bits/s  -> 1 MB/s -> socket slack ~= 0.3s of media
var SPEED = +(process.env.SPEED || 20);         // media seconds per wall second
var SAMPLE = 0.5;                               // media seconds between coverage samples
var MEDIA = path.join(__dirname, 'out', 'ep.mkv');

var WINDOW = 60;                                // ass-controller.js:467  (assSubWindow default)
var DRIFT = WINDOW / 3;                         // ass-controller.js:543  -> 20s
var COVER_MARGIN = 5;                           // only for the proposed FIX rule

// ---- build the media ---------------------------------------------------------
fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
var INFO;
if (!fs.existsSync(MEDIA) || +(process.env.REGEN || 0)) {
    INFO = G.build({ path: MEDIA, durSec: DUR, bitrateBps: BITRATE, seed: 42 });
    fs.writeFileSync(MEDIA + '.json', JSON.stringify({ headerLen: INFO.headerLen, bytesPerSec: INFO.bytesPerSec, size: INFO.size, durSec: INFO.durSec, events: INFO.events }));
} else {
    INFO = JSON.parse(fs.readFileSync(MEDIA + '.json', 'utf8'));
}
var HDR = INFO.headerLen, BPS = INFO.bytesPerSec, SIZE = INFO.size, SRC = INFO.events;

// ---- the CDN -----------------------------------------------------------------
var cdn = http.createServer(function (req, res) {
    var r = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    var start = r ? +r[1] : 0, end = r && r[2] ? Math.min(+r[2], SIZE - 1) : SIZE - 1;
    if (r) res.writeHead(206, { 'content-range': 'bytes ' + start + '-' + end + '/' + SIZE, 'content-length': (end - start + 1), 'accept-ranges': 'bytes', 'content-type': 'video/x-matroska' });
    else res.writeHead(200, { 'content-length': SIZE, 'accept-ranges': 'bytes', 'content-type': 'video/x-matroska' });
    fs.createReadStream(MEDIA, { start: start, end: end }).pipe(res);
});

// ---- ground truth ------------------------------------------------------------
function srcCovers(t) { for (var i = 0; i < SRC.length; i++) if (SRC[i].start <= t && t < SRC[i].end) return SRC[i]; return null; }
// parse the ASS text the controller actually handed to JASSUB
function parseAss(ass) {
    var out = [], lines = String(ass).split('\n');
    for (var i = 0; i < lines.length; i++) {
        var m = /^Dialogue:[^,]*,([^,]+),([^,]+),/.exec(lines[i]);
        if (m) out.push({ start: tc(m[1]), end: tc(m[2]) });
    }
    return out;
}
function tc(s) { var m = /(\d+):(\d\d):(\d\d)[.,](\d+)/.exec(s); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+('0.' + m[4])) : 0; }
function loadedCovers(evs, t) { for (var i = 0; i < evs.length; i++) if (evs[i].start <= t && t < evs[i].end) return true; return false; }

// ---- one run -----------------------------------------------------------------
// rule: 'NEW' (HEAD, drift-gated) | 'OLD' (pre-regression, count-gated) | 'FIX' (coverage-gated)
// R:    player read-ahead in MEDIA SECONDS (Infinity == no backpressure == pre-change-(1))
function run(rule, R, tag, done) {
    var CDN = 'http://127.0.0.1:' + cdn.address().port + '/ep.mkv?run=' + tag;   // unique -> fresh tee Session
    var samples = [], loads = [];

    // ---------- player ----------
    var received = 0, ph = 0, playing = false, lastWall = 0, ended = false, nextSample = 0, stallSec = 0;
    var PREBUF = Math.min(R, 5);
    var resStream = null;
    function recvTime() { return Math.max(0, (received - HDR) / BPS); }
    function pump() {
        if (!resStream) return;
        var want = Math.min(SIZE, HDR + Math.ceil((ph + R) * BPS));
        while (received < want) { var c = resStream.read(); if (!c) return; received += c.length; }
    }
    var preq = http.get(TEE.teeUrl(CDN), function (rs) {
        resStream = rs; rs.pause();
        rs.on('readable', pump);
        rs.on('end', function () { ended = true; });
        pump();
    });
    preq.on('error', function (e) { console.error('player error', e.message); });

    // ---------- controller (ass-controller.js:498-558, verbatim gate) ----------
    var attached = false, curIdx = -1, lastCount = -1, winCenter = -1e9, forceReload = false;
    var loadedEvents = [], loadedCoverEnd = -1, ctlDead = false;
    var IDX = 0;   // window.__assSel === 'EMBEDDED_0'
    // FIX-rule state, mirroring the shipped ass-controller.js exactly.
    var LEAD = 8, MIN_RELOAD = 3000, lastLoadAt = -1e9, loading = false;

    // Mirrors the shipped coverOf(): -1 when the slice holds nothing at/after the
    // playhead (demuxer hasn't reached these bytes) -> must NOT be committed.
    function coverOf(evs, phv) {
        var end = -1, live = false;
        evs.forEach(function (e) { if (e.end > end) end = e.end; if (e.end >= phv) live = true; });
        return live ? end : -1;
    }

    function load(idx, count, phv) {                      // == GET /ass/tget (launch.js:460-466)
        var t = (WINDOW > 0 && phv != null) ? phv : null;
        var w = (WINDOW > 0 && phv != null) ? WINDOW : 0;
        var ass = TEE.trackText(CDN, idx, t, w);          // REAL Session.trackText + REAL window filter
        loading = true; lastLoadAt = Date.now();
        return Promise.resolve().then(function () {
            loading = false;
            if (!ass || ass.length < 40) return;          // ass-controller.js:492
            var evs = parseAss(ass);
            if (rule === 'FIX') {
                // Shipped guard: never commit an empty slice (it would hand libass a
                // zero-event track -> blank canvas -> pinned for a whole reload cycle).
                var cover = coverOf(evs, phv == null ? 0 : phv);
                if (cover < 0) return;
                loadedEvents = evs; loadedCoverEnd = cover;
                curIdx = idx; lastCount = count; forceReload = false;
                if (phv != null) winCenter = phv;
            } else {
                loadedEvents = evs;
                loadedCoverEnd = evs.length ? Math.max.apply(null, evs.map(function (e) { return e.end; })) : -1;
                curIdx = idx; lastCount = count; if (phv != null) winCenter = phv;   // :495
            }
            if (!attached) attached = true;
            loads.push({ ph: phv, n: evs.length, coverEnd: loadedCoverEnd, fwd: +(loadedCoverEnd - phv).toFixed(1) });
        });
    }
    (function poll() {
        if (ctlDead) return;
        var s = TEE.status(CDN);                                                  // REAL
        var trk = (s.tracks || [])[IDX];
        var phv = Math.floor(ph);                                                 // :542
        var drift = WINDOW > 0 && Math.abs(phv - winCenter) > WINDOW / 3;         // :543
        // Shipped `dry`: within LEAD of running out, tee has events we lack, throttled.
        var dry = attached && IDX === curIdx
                  && phv > (loadedCoverEnd - LEAD)
                  && trk && trk.events > lastCount
                  && (Date.now() - lastLoadAt) > MIN_RELOAD / SPEED;
        var trigger =
            rule === 'NEW' ? (IDX !== curIdx || !attached || forceReload || drift)
                : rule === 'OLD' ? (IDX !== curIdx || !attached || forceReload || (trk && trk.events !== lastCount))
                    : /* FIX */    (!loading && (IDX !== curIdx || !attached || forceReload || dry || drift));
        if (trk && trk.events > 0 && trigger) {                                   // :552
            if (rule !== 'FIX') { forceReload = false; if (!attached) attached = true; }
            load(IDX, trk.events, phv);
        }
        setTimeout(poll, ((attached && !forceReload) ? 1500 : 600) / SPEED);      // :556
    })();

    // ---------- clock + sampler ----------
    var t0 = Date.now();
    var tick = setInterval(function () {
        var now = Date.now();
        pump();
        if (!playing) { if (recvTime() >= PREBUF || ended) { playing = true; lastWall = now; } else return; }
        var dt = (now - lastWall) / 1000 * SPEED; lastWall = now;
        var avail = recvTime();
        if (avail > ph) ph = Math.min(ph + dt, avail); else stallSec += dt;       // underrun -> rebuffer
        pump();
        while (ph >= nextSample && nextSample <= DUR) {
            var t = nextSample;
            var src = srcCovers(t);
            samples.push({
                t: t,
                should: !!src,
                have: loadedCovers(loadedEvents, t),
                ra: +(recvTime() - t).toFixed(1),          // player read-ahead, MEASURED
                winCenter: winCenter,
                coverEnd: +loadedCoverEnd.toFixed(1),
            });
            nextSample += SAMPLE;
        }
        if (ph >= DUR - 2 || (ended && recvTime() - ph < 0.2)) {
            clearInterval(tick); ctlDead = true;
            try { preq.destroy(); } catch (e) {}
            setTimeout(function () { done({ rule: rule, R: R, samples: samples, loads: loads, stall: stallSec }); }, 60);
        }
    }, 4);
}

// ---- reporting ---------------------------------------------------------------
function analyse(r) {
    var s = r.samples.filter(function (x) { return x.t >= 6; });   // skip the very first seconds (attach)
    var shouldN = 0, missN = 0, runs = [], cur = null, ras = [];
    s.forEach(function (x) {
        ras.push(x.ra);
        if (!x.should) { if (cur) { runs.push(cur); cur = null; } return; }
        shouldN++;
        if (!x.have) {
            missN++;
            if (!cur) cur = { from: x.t, to: x.t, ra: x.ra };
            cur.to = x.t;
        } else if (cur) { runs.push(cur); cur = null; }
    });
    if (cur) runs.push(cur);
    runs = runs.map(function (g) { return { from: g.from, to: g.to + SAMPLE, len: +(g.to + SAMPLE - g.from).toFixed(1), ra: g.ra }; });
    // the first-attach gap (winCenter committed at ph=0 with only a few seconds demuxed)
    // is a DIFFERENT defect from the recurring mid-episode starvation: separate them.
    var startup = runs.filter(function (g) { return g.from < 25; });
    var mid = runs.filter(function (g) { return g.from >= 25; });
    var lens = mid.map(function (g) { return g.len; });
    return {
        rule: r.rule, R: r.R,
        shouldN: shouldN, missN: missN,
        missPct: shouldN ? +(100 * missN / shouldN).toFixed(1) : 0,
        startupGap: startup.length ? startup[0].len : 0,
        gaps: mid.length,
        longest: lens.length ? Math.max.apply(null, lens) : 0,
        totalBlank: +(lens.reduce(function (a, b) { return a + b; }, 0)).toFixed(1),
        raMin: Math.min.apply(null, ras), raMed: ras.sort(function (a, b) { return a - b; })[ras.length >> 1],
        loads: r.loads.length,
        fwdMin: r.loads.length ? Math.min.apply(null, r.loads.map(function (l) { return l.fwd; })) : null,
        fwdMed: r.loads.length ? r.loads.map(function (l) { return l.fwd; }).sort(function (a, b) { return a - b; })[r.loads.length >> 1] : null,
        stall: +r.stall.toFixed(1),
        runs: runs, _r: r,
    };
}

function timeline(a, maxRows) {
    var s = a._r.samples.filter(function (x) { return x.t >= 6 && Math.round(x.t) === x.t; });
    var out = ['   t   should  loaded  verdict      readahead  winCenter  loadedCoverEnd'];
    var shown = 0;
    for (var i = 0; i < s.length && shown < maxRows; i++) {
        var x = s[i];
        var v = !x.should ? '(silence)' : (x.have ? 'ok' : '*** SUBTITLE MISSING ***');
        out.push(
            String(x.t).padStart(5) + '   ' + (x.should ? 'YES' : ' no') + '     ' + (x.have ? 'YES' : ' NO') + '     ' +
            v.padEnd(26) + String(x.ra).padStart(6) + '     ' + String(x.winCenter).padStart(6) + '        ' + String(x.coverEnd).padStart(7));
        shown++;
    }
    return out.join('\n');
}

// ---- driver ------------------------------------------------------------------
var PLAN = [];
[5, 10, 15, 18, 20, 25, 30, 60, Infinity].forEach(function (R) { PLAN.push(['NEW', R]); });
[5, 10, 20].forEach(function (R) { PLAN.push(['OLD', R]); });
[5, 10, 15, 18, 20, 25, 30, Infinity].forEach(function (R) { PLAN.push(['FIX', R]); });   // fix must hold at EVERY read-ahead

cdn.listen(0, '127.0.0.1', function () {
    console.log('media: ' + MEDIA + '  ' + (SIZE / 1048576).toFixed(1) + ' MB  ' + DUR + 's @ ' + (BITRATE / 1e6) + ' Mbps  (' + BPS + ' bytes/s, 1 cluster = 1 s)');
    console.log('source track: ' + SRC.length + ' Dialogue events   |   WINDOW=' + WINDOW + '  drift threshold=' + DRIFT + 's  poll=1500ms  (time compressed ' + SPEED + 'x)');
    console.log('');
    var results = [], i = 0, only = process.env.ONLY;
    (function next() {
        if (i >= PLAN.length) return report(results);
        var p = PLAN[i++];
        if (only && p[0] !== only) return next();
        process.stdout.write('  running ' + p[0] + '  R=' + (p[1] === Infinity ? 'inf' : p[1] + 's') + ' ... ');
        run(p[0], p[1], p[0] + '-' + p[1] + '-' + Date.now(), function (r) {
            var a = analyse(r); results.push(a);
            console.log('miss ' + a.missPct + '%  gaps=' + a.gaps + '  longest=' + a.longest + 's');
            if (process.env.DEBUG) {
                a.runs.forEach(function (g) { console.log('        blank ' + g.from + '->' + g.to + ' (' + g.len + 's) ra=' + g.ra); });
                console.log('        loads: ' + a._r.loads.map(function (l) { return l.ph + '@' + l.n + '/cov' + l.coverEnd.toFixed(0); }).join(' '));
            }
            next();
        });
    })();
});

function report(results) {
    var W = function (s, n) { return String(s).padStart(n); };
    console.log('\n\n================================ RESULTS ================================\n');
    console.log('                            |          | subs MISSING |  START-UP  |  MID-EPISODE DROPOUTS      | fwd cover');
    console.log('rule   read-ahead R  measured|  reloads | (% of time)  |    gap     | count  longest  total blank| at load (med)');
    console.log('-'.repeat(112));
    var lastRule = null;
    results.forEach(function (a) {
        if (lastRule && lastRule !== a.rule) console.log('-'.repeat(112));
        lastRule = a.rule;
        console.log(
            W(a.rule, 4) + W(a.R === Infinity ? 'inf' : a.R + 's', 13) + W(a.raMed + 's', 10) + '  |' +
            W(a.loads, 8) + '  |' + W(a.missPct + '%', 12) + '  |' + W(a.startupGap + 's', 10) + '  |' +
            W(a.gaps, 5) + W(a.longest + 's', 9) + W(a.totalBlank + 's', 13) + ' |' + W(a.fwdMed + 's', 12));
    });

    var newSmall = results.filter(function (a) { return a.rule === 'NEW' && a.R <= 20; });
    var worst = newSmall.sort(function (a, b) { return b.missPct - a.missPct; })[0];
    if (worst) {
        console.log('\n\n--- TIMELINE: rule=' + worst.rule + '  R=' + worst.R + 's  (one media-second per row, first 70 rows) ---\n');
        console.log(timeline(worst, 70));
        console.log('\n--- every blank stretch in that run (media time) ---');
        worst.runs.forEach(function (g) { console.log('   subs MISSING ' + g.from + 's -> ' + g.to + 's   (' + g.len + 's blank)   read-ahead at onset = ' + g.ra + 's'); });
        console.log('\n--- what the controller loaded in that run (first 12 reloads) ---');
        console.log('   winCenter   events in window   window covers up to   forward coverage');
        worst._r.loads.slice(0, 12).forEach(function (l) {
            console.log('   ' + String(l.ph).padStart(6) + 's ' + String(l.n).padStart(14) + '   ' + String(l.coverEnd.toFixed(1)).padStart(16) + 's   ' + String(l.fwd).padStart(14) + 's');
        });
    }
    cdn.close(); process.exit(0);
}
