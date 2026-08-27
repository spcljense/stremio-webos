// Streaming, playhead-following subtitle demux for the webOS pipeline.
//
// The video plays direct from the CDN into the sealed webOS media pipeline, so we
// can't tap its bytes — we run a SECOND, THIN stream that follows the playhead:
//   - a localhost range-proxy (ass-proxy.js) so the bundled ffmpeg — which can't do
//     DNS — reads http://127.0.0.1:<PORT>/<key>; Node does DNS/TLS/redirect and pins
//     the CDN URL.
//   - a per-episode Session: probe once for the ASS track + duration, then a
//     SubSession (sub-session.js) that extracts small time windows (`-copyts -ss`)
//     around the client-reported playhead, accumulating de-duped events. It never
//     reads past what's being watched, and re-anchors on seek.
//
// The extraction logic (sublogic.js), session driver (sub-session.js) and proxy
// (ass-proxy.js) are unit + integration tested in a vacuum (see vactest/).
//
// Public API:
//   prepare(url, startT)      -> create/reuse a session; {key, state, ass, fonts, ...}
//   tick(key, playhead, seek) -> feed the playhead (seek=true re-anchors); returns status
//   status(key)               -> {state, ass, bytes, fonts, coveredTo}
//   track(key)                -> current accumulated ASS text (in-memory)
//   fontPath(key, name)       -> path to a dumped font

var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');
var http = require('http');
var L = require('./sublogic.js');
var SESS = require('./sub-session.js');
var PX = require('./ass-proxy.js');

var CACHE = '/tmp/ass-cache';
try { fs.mkdirSync(CACHE, { recursive: true }); } catch (e) {}

var FFMPEG = process.env.FFMPEG_BIN || path.join(__dirname, 'bin', 'ffmpeg');
var FFPROBE = process.env.FFPROBE_BIN || path.join(__dirname, 'bin', 'ffprobe');
var PROXY_PORT = parseInt(process.env.ASS_PROXY_PORT || '11473', 10);
var WIN = 30, AHEAD = 45;        // window length / read-ahead (seconds)
var SESSION_TTL = 15 * 60 * 1000, MAX_SESSIONS = 8;

var MEDIA = {};                  // key -> media URL (pinned to CDN by the proxy)
var sessions = {};               // key -> Session

function keyFor(url) { return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16); }
function fontsDir(key) { return path.join(CACHE, key, 'fonts'); }
function fontPath(key, name) { return path.join(fontsDir(key), path.basename(name)); }
function srcFor(key) { return 'http://127.0.0.1:' + PROXY_PORT + '/' + encodeURIComponent(key); }
function listFonts(key) {
    try { return fs.readdirSync(fontsDir(key)).filter(function (f) { return /\.(ttf|otf|ttc|woff2?)$/i.test(f); }); } catch (e) { return []; }
}

// ---- localhost range-proxy (ffmpeg's byte tap) ------------------------------
var proxy = http.createServer(PX.makeHandler(MEDIA));
proxy.on('clientError', function (e, sock) { try { sock.destroy(); } catch (x) {} });
try { proxy.listen(PROXY_PORT, '127.0.0.1'); } catch (e) {}

// ---- per-episode streaming session ------------------------------------------
function Session(url, key, startT) {
    this.url = url; this.key = key;
    this.state = 'probing';       // probing | streaming | error
    this.error = null;
    this.fonts = [];
    this.fontsDumped = false;
    this.sub = null;
    this.playhead = Math.max(0, startT || 0);
    this.pumping = false;
    this.lastActivity = Date.now();
    MEDIA[key] = url;
    this._probe();
}
Session.prototype._probe = function () {
    var self = this;
    try { fs.mkdirSync(fontsDir(this.key), { recursive: true }); } catch (e) {}
    cp.execFile(FFPROBE, ['-v', 'error', '-analyzeduration', '5M', '-probesize', '12M',
        '-show_entries', 'stream=index,codec_type,codec_name:stream_tags=language,title:format=duration',
        '-of', 'json', '-i', srcFor(this.key)], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, function (err, stdout) {
        var p = L.parseProbe(stdout);
        if (!p) { self.state = 'error'; self.error = 'no ASS track' + (err ? ': ' + err.message : ''); return; }
        var idx = p.index;
        var extractFn = function (cs, ce, first) {
            return new Promise(function (resolve) {
                var doFonts = first && !self.fontsDumped;
                var args = L.windowArgs(srcFor(self.key), idx, cs, ce, doFonts);
                var fm = cp.spawn(FFMPEG, args, { cwd: fontsDir(self.key), stdio: ['ignore', 'pipe', 'ignore'] });
                var out = [];
                fm.stdout.on('data', function (c) { out.push(c); });
                fm.on('error', function () { resolve(''); });
                fm.on('close', function () { if (doFonts) { self.fontsDumped = true; self.fonts = listFonts(self.key); } resolve(Buffer.concat(out).toString('utf8')); });
                setTimeout(function () { try { fm.kill('SIGKILL'); } catch (e) {} }, 45000);
            });
        };
        self.sub = new SESS.SubSession(p.duration, extractFn, { win: WIN, ahead: AHEAD });
        self.sub.reportPlayhead(self.playhead);
        self.state = 'streaming';
        self._pump();
    });
};
// Background loop: extract windows until caught up to playhead+AHEAD, then idle.
// Re-kicked by tick() when the playhead advances or seeks.
Session.prototype._pump = function () {
    var self = this;
    if (self.pumping || !self.sub) return;
    self.pumping = true;
    (function loop() {
        self.sub.pump().then(function (n) {
            if (n < 0) { self.pumping = false; return; }   // caught up
            setTimeout(loop, 20);
        }).catch(function () { self.pumping = false; });
    })();
};
Session.prototype.tick = function (t, seek) {
    this.lastActivity = Date.now();
    if (!this.sub) { this.playhead = Math.max(0, t || 0); return; }
    this.playhead = Math.max(0, t || 0);
    if (seek) this.sub.seek(this.playhead); else this.sub.reportPlayhead(this.playhead);
    this._pump();
};
Session.prototype.status = function () {
    var len = this.sub ? this.sub.getTrack().length : 0;
    return { state: this.state, error: this.error, ass: len > 200, bytes: len,
        fonts: this.fonts, coveredTo: this.sub ? (this.sub.coveredTo() || 0) : 0 };
};
Session.prototype.track = function () { return this.sub ? this.sub.getTrack() : ''; };

// ---- session table + light GC ----------------------------------------------
function gc(except) {
    var now = Date.now(), keys = Object.keys(sessions);
    keys.forEach(function (k) { if (k !== except && now - sessions[k].lastActivity > SESSION_TTL) delete sessions[k]; });
    keys = Object.keys(sessions);
    if (keys.length > MAX_SESSIONS) {
        keys.sort(function (a, b) { return sessions[a].lastActivity - sessions[b].lastActivity; });
        while (keys.length > MAX_SESSIONS) { var k = keys.shift(); if (k !== except) delete sessions[k]; }
    }
}

function prepare(url, startT) {
    var key = keyFor(url);
    if (!sessions[key]) sessions[key] = new Session(url, key, startT || 0);
    else sessions[key].lastActivity = Date.now();
    gc(key);
    var s = sessions[key].status(); s.key = key; return s;
}
function tick(key, t, seek) { var s = sessions[key]; if (s) s.tick(t, seek); return status(key); }
function status(key) { var s = sessions[key]; if (!s) return { state: 'none', ass: false, fonts: [], key: key }; var st = s.status(); st.key = key; return st; }
function track(key) { var s = sessions[key]; return s ? s.track() : ''; }

module.exports = { prepare: prepare, tick: tick, status: status, track: track, fontPath: fontPath, keyFor: keyFor, PROXY_PORT: PROXY_PORT };
