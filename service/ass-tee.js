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
// Bounded tee read-ahead. Pausing on the FIRST res.write()===false clamps the CDN read
// to within ~16KB (res's highWaterMark) of the player's socket, which pins the DEMUX
// FRONTIER to the player's media buffer — the demuxer then knows subtitles barely
// further ahead than the playhead, and the renderer starves. Let res's writable queue
// grow to CAP instead, resuming at CAP/2: memory stays bounded (it was UNBOUNDED — the
// whole multi-GB file — which is what OOM'd at ~1GB), while the demuxer keeps a real
// head start over the player.
var READAHEAD_CAP = parseInt(process.env.ASS_TEE_READAHEAD || '16777216', 10);   // 16MB
// Anime releases can carry tens of MiB of embedded fonts before their first
// Cluster. Request a generous bounded head window, consume it incrementally, and
// destroy the response as soon as the Cluster arrives. This does NOT download the
// full window for normal files; it removes the old 16 MiB correctness assumption.
var BOOTSTRAP_MAX_BYTES = parseInt(process.env.ASS_TEE_BOOTSTRAP_MAX_BYTES || '134217728', 10); // 128 MiB
var BOOTSTRAP_MAX_ATTEMPTS = parseInt(process.env.ASS_TEE_BOOTSTRAP_ATTEMPTS || '3', 10);
var BOOTSTRAP_RETRY_MS = parseInt(process.env.ASS_TEE_BOOTSTRAP_RETRY_MS || '250', 10);
var BOOTSTRAP_COOLDOWN_MS = parseInt(process.env.ASS_TEE_BOOTSTRAP_COOLDOWN_MS || '2000', 10);
var sessions = {};

function keyFor(u) { return crypto.createHash('sha1').update(String(u)).digest('hex').slice(0, 16); }

function Session(cdnUrl) {
    this.cdnUrl = cdnUrl;
    this.pinned = cdnUrl;
    this.tracks = [];              // subtitle tracks in container/ffprobe order == EMBEDDED_ order
    this.subTrackSet = {};         // number -> info (seeds per-request demuxers)
    this.byTrack = {};             // number -> { events:[], seen:{} }
    this.fonts = {};               // name -> Buffer
    this.fontNamesByFile = {};     // name -> [family/full names] (for on-demand loading)
    this.ready = false;            // header/track-list bootstrapped (subTracks seeded)
    this.bootstrapDone = false;    // bootstrap finished (ready OR failed) — unblocks feeding
    this._doneCbs = [];            // callbacks waiting on bootstrapDone
    this._readyCbs = [];           // active range demuxers waiting for eventual recovery
    this.bootstrapRunning = false;
    this.bootstrapAttempts = 0;
    this.bootstrapLimitReached = false;
    this.nextBootstrapAt = 0;
    this._bootstrapTimer = null;
    this.pinDone = false;          // resolver redirect followed and pinned (or failed once)
    this._pinCbs = [];             // player requests wait here instead of racing /resolve
    this.refreshRunning = false;   // expired temporary CDN URL is refreshed single-flight
    this._refreshCbs = [];
    this.liveConns = 0;            // open tee connections (never evict while >0)
    this.videoFps = null;          // exact fps from the container (video DefaultDuration)
    this.lastActivity = Date.now();
    this.ensureBootstrap();
}
Session.prototype._finishPin = function () {
    if (this.pinDone) return;
    this.pinDone = true;
    var cbs = this._pinCbs; this._pinCbs = [];
    for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} }
};
Session.prototype.whenPinned = function (cb) {
    if (this.pinDone) { cb(); return; }
    this._pinCbs.push(cb);
};
Session.prototype._finishRefresh = function () {
    this.refreshRunning = false;
    var cbs = this._refreshCbs; this._refreshCbs = [];
    for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} }
};
// TorBox's redirect target is temporary, while cdnUrl (/resolve/...) is stable.
// If the pinned target expires, exactly one request goes back through the
// resolver. Concurrent player ranges wait for that refresh, then use the new
// target instead of stampeding the resolver.
Session.prototype.fetchPlayerRange = function (range, cb, afterRefresh) {
    var self = this;
    if (self.refreshRunning && !afterRefresh) {
        self._refreshCbs.push(function () { self.fetchPlayerRange(range, cb, true); });
        return;
    }
    var attempted = self.pinned;
    PX.fetchRange(attempted, range, function (err, up, finalUrl) {
        var stalePin = attempted !== self.cdnUrl;
        var failed = err || !up || up.statusCode >= 400;
        if (failed && stalePin && !afterRefresh) {
            try { if (up) { up.resume(); up.destroy(); } } catch (e) {}
            if (self.refreshRunning) {
                self._refreshCbs.push(function () { self.fetchPlayerRange(range, cb, true); });
                return;
            }
            self.refreshRunning = true;
            PX.fetchRange(self.cdnUrl, range, function (refreshErr, refreshUp, refreshUrl) {
                if (!refreshErr && refreshUp && refreshUp.statusCode < 400 && refreshUrl && /^https?:/.test(refreshUrl) && refreshUrl.indexOf('/resolve/') < 0)
                    self.pinned = refreshUrl;
                self._finishRefresh();
                cb(refreshErr, refreshUp, refreshUrl);
            });
            return;
        }
        if (!failed && finalUrl && finalUrl !== self.pinned && /^https?:/.test(finalUrl) && finalUrl.indexOf('/resolve/') < 0)
            self.pinned = finalUrl;
        cb(err, up, finalUrl);
    });
};
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
Session.prototype._finishReady = function () {
    var cbs = this._readyCbs; this._readyCbs = [];
    for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} }
};
Session.prototype.whenReady = function (cb) {
    if (this.ready) { cb(); return function () {}; }
    this._readyCbs.push(cb);
    var self = this;
    return function () {
        var i = self._readyCbs.indexOf(cb);
        if (i >= 0) self._readyCbs.splice(i, 1);
    };
};
Session.prototype.ensureBootstrap = function () {
    if (this.ready || this.bootstrapRunning || this.bootstrapLimitReached || Date.now() < this.nextBootstrapAt) return;
    this.bootstrapRunning = true;
    this.bootstrapAttempts++;
    this._bootstrap();
};
Session.prototype._bootstrapFailed = function () {
    var self = this;
    if (self.ready) return;
    self.bootstrapRunning = false;
    if (self.bootstrapAttempts < BOOTSTRAP_MAX_ATTEMPTS) {
        var delay = BOOTSTRAP_RETRY_MS * self.bootstrapAttempts;
        self.nextBootstrapAt = Date.now() + delay;
        clearTimeout(self._bootstrapTimer);
        self._bootstrapTimer = setTimeout(function () {
            self._bootstrapTimer = null;
            self.ensureBootstrap();
        }, delay);
        return;
    }
    // Do not poison the cached session forever. Unblock playback after this
    // bounded burst, then let the controller's status polling start a new burst.
    self.bootstrapAttempts = 0;
    self.nextBootstrapAt = Date.now() + BOOTSTRAP_COOLDOWN_MS;
    self._finishBootstrap();
};
Session.prototype._bucket = function (tn) { return this.byTrack[tn] || (this.byTrack[tn] = { events: [], seen: Object.create(null) }); };
Session.prototype._sink = function () {
    var self = this;
    return {
        onFont: function (f) {
            if (!f.name || !f.data || self.fonts[f.name]) return;
            if (!FI.isFontAttachment(f.name, f.mime)) return;
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
    var settled = false;
    function failed() {
        if (settled) return;
        settled = true;
        self._bootstrapFailed();
    }
    PX.fetchRange(self.pinned, 'bytes=0-' + (BOOTSTRAP_MAX_BYTES - 1), function (err, up, finalUrl) {
        if (err || !up) { self._finishPin(); failed(); return; }
        if (finalUrl && finalUrl !== self.pinned && /^https?:/.test(finalUrl) && finalUrl.indexOf('/resolve/') < 0) self.pinned = finalUrl;
        self._finishPin();
        up.on('data', function (c) {
            var remaining = BOOTSTRAP_MAX_BYTES - off;
            if (remaining <= 0) return;
            if (c.length > remaining) c = c.slice(0, remaining);
            try { hd.pushAt(off, c); } catch (e) {}
            off += c.length;
            if (hd._curCluster && !self.ready) {         // header+fonts done -> capture tracks
                settled = true;
                self.subTrackSet = hd.subTracks;
                self.tracks = Object.keys(hd.subTracks).map(function (n) { return { number: +n, streamIndex: hd.subTracks[n].streamIndex, name: hd.subTracks[n].name, lang: hd.subTracks[n].lang, codecPrivate: hd.subTracks[n].codecPrivate }; }).sort(function (a, b) { return a.streamIndex - b.streamIndex || a.number - b.number; });
                self.videoFps = hd.videoFps();               // exact container fps for sign frame-lock
                self.ready = true;
                self.bootstrapRunning = false;
                self.bootstrapAttempts = 0;
                self.nextBootstrapAt = 0;
                self._finishBootstrap();                     // unblock the mid-file demuxers (now seedable)
                self._finishReady();                         // seed demuxers created after an earlier failed burst
                try { up.destroy(); } catch (e) {}
            } else if (off >= BOOTSTRAP_MAX_BYTES) {
                // A malformed/pathological file must not make status polling
                // redownload the same maximum-size prefix forever.
                settled = true;
                self.bootstrapRunning = false;
                self.bootstrapAttempts = 0;
                self.bootstrapLimitReached = true;
                self._finishBootstrap();
                try { up.destroy(); } catch (e) {}
            }
        });
        // Head exhausted / upstream error before a Cluster: retry instead of
        // preserving a permanently trackless session. The bounded retry burst
        // eventually unblocks playback; later status polls can recover it.
        up.on('end', failed);
        up.on('error', failed);
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
    return this.tracks.map(function (t, i) { var b = self.byTrack[t.number]; return { index: i, number: t.number, streamIndex: t.streamIndex, name: t.name, lang: t.lang, events: b ? b.events.length : 0 }; });
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
    var demux = null, pre = [], preLen = 0, closed = false;
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
    var cancelReady = sess.whenReady(function () {
        if (closed) return;
        if (!demux) makeDemux();
        demux.subTracks = sess.subTrackSet;
    });
    sess.liveConns++;
    function closeConn() { if (!closed) { closed = true; cancelReady(); sess.liveConns = Math.max(0, sess.liveConns - 1); sess.lastActivity = Date.now(); pre = null; preLen = 0; } }   // release the pre-bootstrap buffer (up to 16MB)
    sess.whenPinned(function () { sess.fetchPlayerRange(range, function (err, up, finalUrl) {
        if (err || !up) { closeConn(); try { res.writeHead(502); res.end(); } catch (e) {} return; }
        var h = {};
        ['content-length', 'content-range', 'accept-ranges', 'content-type'].forEach(function (k) { if (up.headers[k]) h[k] = up.headers[k]; });
        try { res.writeHead(up.statusCode, h); } catch (e) { closeConn(); try { up.destroy(); } catch (x) {} return; }
        var off = start;
        var pending = 0, paused = false;
        // BACKPRESSURE, bounded (critical, and delicate — read before changing):
        //  * No pause at all  -> the whole multi-GB file lands in res's writable queue
        //                        in RAM -> ~1GB RSS -> OOM at stream start.
        //  * Pause on the first write()===false -> the CDN read is clamped to res's 16KB
        //                        highWaterMark, so the demuxer only ever parses as far
        //                        ahead as the player has buffered. The subtitle renderer
        //                        then runs dry and subs vanish mid-episode.
        // So: allow up to READAHEAD_CAP bytes in flight, resume at half (hysteresis, to
        // avoid pause/resume churn every 16KB). Memory bounded; demuxer keeps a lead.
        function wrote(n) { return function () { pending -= n; if (paused && pending <= (READAHEAD_CAP >> 1)) { paused = false; try { up.resume(); } catch (e) {} } }; }
        up.on('data', function (c) {
            if (demux) { try { demux.pushAt(off, c); } catch (e) {} }
            else if (pre) {                                                            // still buffering (not closed)
                if (preLen < 16777216) { pre.push([off, c]); preLen += c.length; }     // buffer until bootstrapDone
                else { makeDemux(); try { demux.pushAt(off, c); } catch (e) {} }        // overflow: proceed best-effort
            }
            off += c.length;
            try {
                pending += c.length;
                res.write(c, wrote(c.length));
                if (pending > READAHEAD_CAP && !paused) { paused = true; up.pause(); }
            } catch (e) {}
        });
        up.on('end', function () { sess.lastActivity = Date.now(); try { res.end(); } catch (e) {} });
        up.on('error', function () { try { res.end(); } catch (e) {} });
        res.on('close', function () { closeConn(); try { up.destroy(); } catch (e) {} });
    }); });
});
tee.on('clientError', function (e, sock) { try { sock.destroy(); } catch (x) {} });
try { tee.listen(PORT, '127.0.0.1'); } catch (e) {}

// ---- API used by launch.js routes -------------------------------------------
function status(cdnUrl) {
    var s = sessions[keyFor(cdnUrl)];
    if (!s) return { state: 'none', ready: false, tracks: [] };
    s.lastActivity = Date.now();   // the client poll is a heartbeat — keep the session alive
    s.ensureBootstrap();           // failed bursts cool down, then recover instead of staying poisoned
    var fp = s.fontPlan();
    return { state: s.ready ? 'streaming' : 'probing', ready: s.ready, tracks: s.list(), fonts: Object.keys(s.fonts), fontAvail: fp.avail, fontEager: fp.eager, videoFps: s.videoFps };
}
function trackText(cdnUrl, index, tSec, winSec) { var s = sessions[keyFor(cdnUrl)]; if (!s) return ''; s.lastActivity = Date.now(); return s.trackText(index | 0, tSec, winSec); }
function fontData(cdnUrl, name) { var s = sessions[keyFor(cdnUrl)]; if (!s) return null; s.lastActivity = Date.now(); return s.fonts[name] || null; }
function teeUrl(cdnUrl) { return 'http://127.0.0.1:' + PORT + '/s/' + encodeURIComponent(cdnUrl); }

module.exports = { status: status, trackText: trackText, fontData: fontData, teeUrl: teeUrl, keyFor: keyFor, PORT: PORT, _sessions: sessions };
