// Server-side streaming session: drives the PlayheadScheduler + EventAccumulator
// off a client-reported playhead. The window extractor is INJECTED (extractFn),
// so this driver is unit-testable with a mock extractor — the real wiring passes
// an ffmpeg-through-the-range-proxy extractor.
//
// Two distinct client signals, mirroring the DOM:
//   reportPlayhead(t) — periodic/timeupdate: advance intent, never re-anchors
//   seek(t)           — the 'seeked' event: may re-anchor the window
var L = require('./sublogic.js');

function SubSession(duration, extractFn, opts) {
    this.sched = new L.PlayheadScheduler(duration, opts);
    this.acc = new L.EventAccumulator();
    this.extractFn = extractFn;      // (cs, ce, dumpFonts) -> assText
    this.playhead = 0;
    this.firstWindow = true;
    this.gen = 0;                    // bumps on every re-anchor; guards in-flight windows
    this.fonts = [];
}
SubSession.prototype.reportPlayhead = function (t) { this.playhead = Math.max(0, t || 0); };

// A real (discontinuous) seek. Re-anchor + reset accumulation only if the target
// isn't already covered; otherwise it's a no-op and existing subs stay.
SubSession.prototype.seek = function (t) {
    this.playhead = Math.max(0, t || 0);
    var act = this.sched.onSeek(this.playhead);
    if (act === 're-anchor') { this.acc = new L.EventAccumulator(); this.firstWindow = true; this.gen++; }
    return act;
};

// Extract exactly one window if coverage is behind the read-ahead target.
// Returns the number of NEW events added, or -1 if nothing was needed.
// ASYNC: extractFn spawns ffmpeg; it MUST NOT block the event loop, because the
// range-proxy runs in the same process and needs to answer ffmpeg's requests
// (a synchronous extractor deadlocks against the in-process proxy).
SubSession.prototype.pump = async function () {
    var w = this.sched.next(this.playhead);
    if (!w) return -1;
    var gen = this.gen;
    var isFirst = this.firstWindow;
    this.firstWindow = false;
    var ass = (await this.extractFn(w.cs, w.ce, isFirst)) || '';
    if (this.gen !== gen) return 0; // a seek re-anchored mid-extract -> discard this stale window
    return this.acc.addBlob(ass);
};

// Pump until caught up to the read-ahead target (bounded so a bug can't spin).
SubSession.prototype.pumpToCaughtUp = async function (maxWindows) {
    maxWindows = maxWindows || 10000;
    var added = 0, n;
    while (maxWindows-- > 0) { n = await this.pump(); if (n < 0) break; added += n; }
    return added;
};

SubSession.prototype.getTrack = function () { return this.acc.track(); };
SubSession.prototype.coveredTo = function () { return this.sched.hi; };

module.exports = { SubSession: SubSession };
