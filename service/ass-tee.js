// Single-download subtitle tee. The patched player points <video>.src at this
// proxy; for every byte range the player requests we fetch it from the CDN ONCE,
// pipe it to the player, AND feed it to the streaming MKV demuxer (mkv-subs.js) —
// subtitles fall out of the exact bytes the player already pulls (no 2nd pull).
//
// It demuxes ALL embedded ASS subtitle tracks (keyed by track number) so the
// client can render whichever track the user SELECTS in Stremio, and switch
// instantly. Header (styles) + fonts are bootstrapped from the file head once
// (a small metadata fetch), so mid-file/resume streams still parse. Verified in
// vactest/ + on-device against a real Demon Slayer BD (zlib-compressed subs).

var http = require('http');
var crypto = require('crypto');
var PX = require('./ass-proxy.js');
var M = require('./mkv-subs.js');
var FI = require('./font-info.js');

var PORT = parseInt(process.env.ASS_TEE_PORT || '11474', 10);
// Each session pins ~18 embedded fonts (multi-MB CJK) + all-track events in RAM,
// so on a memory-tight TV keep only the current stream plus a little grace, and
// evict finished episodes promptly. (Prefetch is off in tee mode, so we never need
// many at once.)
var SESSION_TTL = 6 * 60 * 1000, MAX_SESSIONS = 3;
var sessions = {};

function keyFor(u) { return crypto.createHash('sha1').update(String(u)).digest('hex').slice(0, 16); }

function Session(cdnUrl) {
    this.cdnUrl = cdnUrl;
    this.pinned = cdnUrl;
    this.tracks = [];              // subtitle tracks [{number,name,lang,codecPrivate}] sorted by number == EMBEDDED_ order
    this.subTrackSet = {};         // number -> info (seeds per-request demuxers)
    this.byTrack = {};             // number -> { events:[], seen:{} }
    this.fonts = {};               // name -> Buffer
    this.fontNamesByFile = {};     // name -> [family/full names] (for on-demand loading)
    this.ready = false;            // header/track-list bootstrapped (subTracks seeded)
    this.bootstrapDone = false;    // bootstrap finished (ready OR failed) — unblocks feeding
    this._doneCbs = [];            // callbacks waiting on bootstrapDone
    this.liveConns = 0;            // open tee connections (never evict while >0)
    this.videoFps = null;          // exact fps from the container (video DefaultDuration)
    this.lastActivity = Date.now();
    this._bootstrap();
}
Session.prototype._finishBootstrap = function () {
    if (this.bootstrapDone) return;
    this.bootstrapDone = true;
    var cbs = this._doneCbs; this._doneCbs = [];
    for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} }
};
Session.prototype.whenBootstrapDone = function (cb) {
    if (this.bootstrapDone) { cb(); return; }
    this._doneCbs.push(cb);
};
Session.prototype._bucket = function (tn) { return this.byTrack[tn] || (this.byTrack[tn] = { events: [], seen: Object.create(null) }); };
Session.prototype._sink = function () {
    var self = this;
    return {
        onFont: function (f) {
            if (!f.name || !f.data || self.fonts[f.name]) return;
            if (/^image\//i.test(f.mime || '')) return;                       // cover art etc. — not a font, don't ship to libass
            self.fonts[f.name] = f.data;
            self.fontNamesByFile[f.name] = FI.fontNames(f.data).names;         // for on-demand loading
        },
        onEvent: function (line, coff, tn) { var b = self._bucket(tn); if (!b.seen[line]) { b.seen[line] = 1; b.events.push(line); } },
    };
};
// The player may resume MID-FILE (no Tracks header in its stream), so bootstrap
// the track list + styles + fonts once from the file head — a small fetch that
// stops at the first Cluster, NOT the whole file.
Session.prototype._bootstrap = function () {
    var self = this;
    var hd = new M.MkvSubDemux(self._sink());
    hd.allSubs = true;
    var off = 0;
    PX.fetchRange(self.pinned, 'bytes=0-16777215', function (err, up, finalUrl) {
        if (err || !up) { self._finishBootstrap(); return; }
        if (finalUrl && finalUrl !== self.pinned && /^https?:/.test(finalUrl) && finalUrl.indexOf('/resolve/') < 0) self.pinned = finalUrl;
        up.on('data', function (c) {
            try { hd.pushAt(off, c); } catch (e) {}
            off += c.length;
            if (hd._curCluster && !self.ready) {         // header+fonts done -> capture tracks
                self.subTrackSet = hd.subTracks;
                self.tracks = Object.keys(hd.subTracks).map(function (n) { return { number: +n, name: hd.subTracks[n].name, lang: hd.subTracks[n].lang, codecPrivate: hd.subTracks[n].codecPrivate }; }).sort(function (a, b) { return a.number - b.number; });
                self.videoFps = hd.videoFps();               // exact container fps for sign frame-lock
                self.ready = true;
                self._finishBootstrap();                     // unblock the mid-file demuxers (now seedable)
                try { up.destroy(); } catch (e) {}
            }
        });
        // Head exhausted / upstream error before a Cluster: still unblock waiters
        // (a start-at-0 stream can self-seed from its own header; a mid-file one
        // just can't get subs for this session, but it must not hang forever).
        up.on('end', function () { self._finishBootstrap(); });
        up.on('error', function () { self._finishBootstrap(); });
    });
};
// Per-connection demuxer (concurrent-safe), demuxing all sub tracks. Seeded from
// the bootstrapped track map when ready; a start-at-0 stream self-seeds from the
// Tracks header in its own bytes so it does not need the seed.
Session.prototype.newDemux = function () {
    var d = new M.MkvSubDemux(this._sink());
    d.allSubs = true;
    if (this.ready) d.subTracks = this.subTrackSet;
    return d;
};
Session.prototype.list = function () {
    var self = this;
    return this.tracks.map(function (t, i) { var b = self.byTrack[t.number]; return { index: i, number: t.number, name: t.name, lang: t.lang, events: b ? b.events.length : 0 }; });
};
// ASS timecode "H:MM:SS.cc" -> seconds.
function tcSec(s) { var m = /(\d+):(\d\d):(\d\d)[.,](\d+)/.exec(s); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+('0.' + m[4])) : 0; }
// Windowed track text. Heavy-typesetting tracks (per-frame mocha signs) can be tens
// of MB / tens of thousands of events; handing all of it to libass every frame starves
// rendering. When tSec/winSec are given, return only events OVERLAPPING [t-win, t+win]
// so libass parses/holds a small slice around the playhead.
Session.prototype.trackText = function (index, tSec, winSec) {
    var t = this.tracks[index]; if (!t || !t.codecPrivate) return '';
    var h = t.codecPrivate.toString('utf8'); if (h[h.length - 1] !== '\n') h += '\n';
    var b = this.byTrack[t.number];
    if (!b || !b.events.length) return h;
    var events = b.events;
    if (tSec != null && winSec > 0) {
        var lo = tSec - winSec, hi = tSec + winSec;
        events = events.filter(function (line) {
            var m = /^Dialogue:[^,]*,([^,]+),([^,]+),/.exec(line);
            if (!m) return true;                                  // keep anything unparseable
            return tcSec(m[2]) >= lo && tcSec(m[1]) <= hi;        // event overlaps the window
        });
    }
    return h + events.join('\n') + '\n';
};
// Split embedded fonts into on-demand (avail) vs always-load (eager). A font is safe
// on-demand — loaded by JASSUB only when the ASS references its name — ONLY if none of
// the names it provides is shared with another file. Multi-face families (Regular/Bold/
// Italic in separate files, which share a family name) and unparseable fonts stay eager,
// because availableFonts maps one name -> one file and would otherwise drop faces.
Session.prototype.fontPlan = function () {
    var self = this, files = Object.keys(this.fonts);
    var owners = {};
    files.forEach(function (fn) { (self.fontNamesByFile[fn] || []).forEach(function (nm) { owners[nm] = (owners[nm] || 0) + 1; }); });
    var avail = {}, eager = [];
    files.forEach(function (fn) {
        var names = self.fontNamesByFile[fn] || [];
        var safe = names.length && names.every(function (nm) { return owners[nm] === 1; });
        if (safe) names.forEach(function (nm) { avail[nm] = fn; });
        else eager.push(fn);
    });
    return { avail: avail, eager: eager };
};

function gc(except) {
    var now = Date.now(), keys = Object.keys(sessions);
    // Never evict a session that has open tee connections (it's being watched).
    function evictable(k) { return k !== except && sessions[k].liveConns <= 0; }
    keys.forEach(function (k) { if (evictable(k) && now - sessions[k].lastActivity > SESSION_TTL) delete sessions[k]; });
    keys = Object.keys(sessions);
    if (keys.length > MAX_SESSIONS) {
        keys.sort(function (a, b) { return sessions[a].lastActivity - sessions[b].lastActivity; });
        var over = keys.length - MAX_SESSIONS;
        for (var i = 0; i < keys.length && over > 0; i++) { if (evictable(keys[i])) { delete sessions[keys[i]]; over--; } }
    }
}
function ensure(cdnUrl) {
    var key = keyFor(cdnUrl);
    if (!sessions[key]) sessions[key] = new Session(cdnUrl);
    sessions[key].lastActivity = Date.now();
    gc(key);
    return sessions[key];
}

// ---- the tee HTTP server (the player streams THROUGH this) -------------------
var tee = http.createServer(function (req, res) {
    var path = (req.url || '/').split('?')[0];
    var m = /^\/s\/(.+)$/.exec(path);
    if (!m) { res.writeHead(404); res.end(); return; }
    var cdnUrl = decodeURIComponent(m[1]);
    var sess = ensure(cdnUrl);
    var range = req.headers.range || '';
    var rm = /bytes=(\d+)-/.exec(range);
    var start = rm ? parseInt(rm[1], 10) : 0;
    // The demuxer only yields subtitles once its subTracks map exists. A stream
    // starting at byte 0 carries the Tracks header and self-seeds, so it can demux
    // immediately. A MID-FILE stream (resume/seek) has NO header — if we feed it
    // before _bootstrap has seeded subTracks, every block is rejected as non-sub
    // and its events are lost until a later seek re-fetches with a ready session.
    // So: buffer a mid-file stream's bytes (bounded) until bootstrapDone, then make
    // the (now-seedable) demuxer and flush.
    var demux = null, pre = [], preLen = 0;
    function makeDemux() {
        if (demux) return;
        demux = sess.newDemux();
        if (pre) { for (var i = 0; i < pre.length; i++) { try { demux.pushAt(pre[i][0], pre[i][1]); } catch (e) {} } pre = null; }
    }
    if (start === 0) makeDemux();
    else sess.whenBootstrapDone(function () {
        if (!demux) makeDemux();
        else if (sess.ready) { demux.subTracks = sess.subTrackSet; }   // seed a demuxer forced early by pre-buffer overflow
    });
    sess.liveConns++;
    var closed = false;
    function closeConn() { if (!closed) { closed = true; sess.liveConns = Math.max(0, sess.liveConns - 1); sess.lastActivity = Date.now(); pre = null; preLen = 0; } }   // release the pre-bootstrap buffer (up to 16MB)
    PX.fetchRange(sess.pinned, range, function (err, up, finalUrl) {
        if (err || !up) { closeConn(); try { res.writeHead(502); res.end(); } catch (e) {} return; }
        if (finalUrl && finalUrl !== sess.pinned && /^https?:/.test(finalUrl) && finalUrl.indexOf('/resolve/') < 0) sess.pinned = finalUrl;
        var h = {};
        ['content-length', 'content-range', 'accept-ranges', 'content-type'].forEach(function (k) { if (up.headers[k]) h[k] = up.headers[k]; });
        try { res.writeHead(up.statusCode, h); } catch (e) { closeConn(); try { up.destroy(); } catch (x) {} return; }
        var off = start;
        up.on('data', function (c) {
            if (demux) { try { demux.pushAt(off, c); } catch (e) {} }
            else if (pre) {                                                            // still buffering (not closed)
                if (preLen < 16777216) { pre.push([off, c]); preLen += c.length; }     // buffer until bootstrapDone
                else { makeDemux(); try { demux.pushAt(off, c); } catch (e) {} }        // overflow: proceed best-effort
            }
            off += c.length;
            // BACKPRESSURE (critical): the player fills its ~30s media buffer then stops
            // reading. Without pausing the CDN read, the WHOLE multi-GB file streams into
            // res's writable queue in RAM -> the service balloons to ~1GB and OOM-crashes
            // at stream start. Pause the upstream when res is full; resume it on 'drain'.
            try { if (res.write(c) === false) up.pause(); } catch (e) {}
        });
        up.on('end', function () { sess.lastActivity = Date.now(); try { res.end(); } catch (e) {} });
        up.on('error', function () { try { res.end(); } catch (e) {} });
        res.on('drain', function () { try { up.resume(); } catch (e) {} });
        res.on('close', function () { closeConn(); try { up.destroy(); } catch (e) {} });
    });
});
tee.on('clientError', function (e, sock) { try { sock.destroy(); } catch (x) {} });
try { tee.listen(PORT, '127.0.0.1'); } catch (e) {}

// ---- API used by launch.js routes -------------------------------------------
function status(cdnUrl) {
    var s = sessions[keyFor(cdnUrl)];
    if (!s) return { state: 'none', ready: false, tracks: [] };
    s.lastActivity = Date.now();   // the client poll is a heartbeat — keep the session alive
    var fp = s.fontPlan();
    return { state: s.ready ? 'streaming' : 'probing', ready: s.ready, tracks: s.list(), fonts: Object.keys(s.fonts), fontAvail: fp.avail, fontEager: fp.eager, videoFps: s.videoFps };
}
function trackText(cdnUrl, index, tSec, winSec) { var s = sessions[keyFor(cdnUrl)]; if (!s) return ''; s.lastActivity = Date.now(); return s.trackText(index | 0, tSec, winSec); }
function fontData(cdnUrl, name) { var s = sessions[keyFor(cdnUrl)]; if (!s) return null; s.lastActivity = Date.now(); return s.fonts[name] || null; }
function teeUrl(cdnUrl) { return 'http://127.0.0.1:' + PORT + '/s/' + encodeURIComponent(cdnUrl); }

module.exports = { status: status, trackText: trackText, fontData: fontData, teeUrl: teeUrl, keyFor: keyFor, PORT: PORT, _sessions: sessions };
