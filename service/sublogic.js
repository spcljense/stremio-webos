// Pure, testable logic for the streaming playhead-following subtitle demux.
// No I/O in these functions — they take strings/objects and return strings/objects,
// so they can be unit-tested in a vacuum. The server module (ass-stream.js) and the
// client wire these up; the ffmpeg/network bits are tested separately as integration.

// ---- probe parsing ----------------------------------------------------------
// Parse the ffprobe JSON we already run, pick the English "full" ASS track, and
// read duration. Mirrors the existing pickTracks heuristic. Returns {index,duration}
// or null.
function parseProbe(ffprobeJson) {
    var d;
    try { d = typeof ffprobeJson === 'string' ? JSON.parse(ffprobeJson) : ffprobeJson; } catch (e) { return null; }
    if (!d || !d.streams) return null;
    var subs = d.streams.filter(function (s) { return s.codec_type === 'subtitle' && /ass|ssa/i.test(s.codec_name || ''); });
    var eng = subs.filter(function (s) { return /^en/i.test((s.tags && s.tags.language) || ''); });
    var pick = eng.find(function (s) { return /full|dialog/i.test((s.tags && s.tags.title) || ''); })
        || eng.find(function (s) { return !/sign|song/i.test((s.tags && s.tags.title) || ''); })
        || eng[0] || subs[0];
    if (!pick) return null;
    var dur = parseFloat(d.format && d.format.duration) || 0;
    return { index: pick.index, duration: dur };
}

// ---- ffmpeg window args (pure) ----------------------------------------------
// Build the argv for extracting one time window [cs,ce] of the subtitle track,
// with absolute timestamps preserved. dumpFonts only on the first window.
function windowArgs(src, idx, cs, ce, dumpFonts) {
    var a = ['-y', '-hide_banner', '-loglevel', 'error', '-copyts', '-ss', String(cs), '-to', String(ce)];
    if (dumpFonts) a = a.concat(['-dump_attachment:t', '']);
    return a.concat(['-i', src, '-map', '0:' + idx, '-c', 'copy', '-f', 'ass', 'pipe:1']);
}

// ---- ASS split / assemble ---------------------------------------------------
// Split an ffmpeg-produced ASS blob into {header, events}. header = everything up
// to and including the [Events] "Format:" line; events = the Dialogue/Comment lines.
function splitAss(assText) {
    if (!assText) return { header: '', events: [] };
    var ev = assText.indexOf('[Events]');
    var fmt = ev >= 0 ? assText.indexOf('Format:', ev) : -1;
    var nl = fmt >= 0 ? assText.indexOf('\n', fmt) : -1;
    if (nl < 0) return { header: assText, events: [] };
    var header = assText.slice(0, nl + 1);
    var events = [];
    var rest = assText.slice(nl + 1).split('\n');
    for (var i = 0; i < rest.length; i++) {
        var ln = rest[i];
        if (/^(Dialogue|Comment):/.test(ln)) events.push(ln);
    }
    return { header: header, events: events };
}

// Reassemble a full ASS string from a header and an ordered event list.
function assembleTrack(header, events) {
    return header + events.join('\n') + (events.length ? '\n' : '');
}

// ---- event accumulator with dedup ------------------------------------------
// Streaming windows overlap at boundaries, so identical Dialogue lines recur.
// Accumulate unique events in arrival order (which is time order across windows).
function EventAccumulator() {
    this.header = '';
    this.seen = Object.create(null);
    this.events = [];
}
EventAccumulator.prototype.addBlob = function (assText) {
    var parts = splitAss(assText);
    if (!this.header && parts.header) this.header = parts.header;
    var added = 0;
    for (var i = 0; i < parts.events.length; i++) {
        var ln = parts.events[i];
        if (!this.seen[ln]) { this.seen[ln] = 1; this.events.push(ln); added++; }
    }
    return added; // number of new (non-duplicate) events
};
EventAccumulator.prototype.track = function () { return assembleTrack(this.header, this.events); };
// Latest event Start time we hold (seconds), for coverage bookkeeping.
EventAccumulator.prototype.maxStart = function () {
    var mx = 0;
    for (var i = 0; i < this.events.length; i++) { var t = eventStart(this.events[i]); if (t > mx) mx = t; }
    return mx;
};

// Parse the Start time (seconds) from a Dialogue/Comment line: "Dialogue: L,H:MM:SS.cc,..."
function eventStart(line) {
    var m = /^(?:Dialogue|Comment):\s*[^,]*,\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(line);
    if (!m) return 0;
    return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

// ---- playhead scheduler (pure state machine) -------------------------------
// Decides which time windows to extract as playback advances and on seeks. It
// NEVER reads past what's needed: it keeps the covered range a bit ahead of the
// playhead. All decisions are pure functions of (playhead, covered range, duration).
//   WIN   = window length per extraction (s)
//   AHEAD = keep covered up to playhead+AHEAD
function PlayheadScheduler(duration, opts) {
    opts = opts || {};
    this.duration = duration || 0;
    this.WIN = opts.win || 30;
    this.AHEAD = opts.ahead || 45;
    this.lo = null;   // covered range start (s), null = nothing yet
    this.hi = null;   // covered range end (s)
}
// Given the current playhead, return the next window [cs,ce] to extract, or null
// if we're covered far enough ahead. Advances internal covered range on each call.
PlayheadScheduler.prototype.next = function (playhead) {
    var end = this.duration > 0 ? this.duration : (playhead + 1e9);
    // Need coverage up to here:
    var want = Math.min(end, playhead + this.AHEAD);
    if (this.hi != null && this.hi >= want) return null;         // already covered enough
    var cs = this.hi != null ? this.hi : Math.max(0, playhead);  // continue from frontier or start at playhead
    if (cs >= end) return null;
    var ce = Math.min(end, cs + this.WIN);
    if (this.lo == null) this.lo = cs;
    this.hi = ce;
    return { cs: cs, ce: ce };
};
// A seek: decide whether to re-anchor. If the target is within [lo,hi] we're
// already covered (no re-extract). If before lo, or beyond hi+slack, re-anchor the
// window at the target and reset coverage.
PlayheadScheduler.prototype.onSeek = function (target) {
    var slack = 5;
    if (this.lo != null && target >= this.lo - 1 && target <= this.hi + slack) return 'covered';
    this.lo = null; this.hi = null;         // reset; next() will start a fresh window at the seek target
    return 're-anchor';
};

module.exports = {
    parseProbe: parseProbe,
    windowArgs: windowArgs,
    splitAss: splitAss,
    assembleTrack: assembleTrack,
    EventAccumulator: EventAccumulator,
    eventStart: eventStart,
    PlayheadScheduler: PlayheadScheduler,
};
