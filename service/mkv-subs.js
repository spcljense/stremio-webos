// Streaming Matroska/WebM demuxer that pulls the ASS subtitle track out of raw
// container bytes — the primitive needed to tee a proxied video stream into JASSUB
// with ONE download. Feed bytes with push(buf); it emits:
//   onHeader({ timestampScale, trackNumber, codecPrivate })  // ASS styles header
//   onFont({ name, mime, data })                             // embedded attachments
//   onEvent(dialogueLine)                                    // reconstructed ASS Dialogue
// It tolerates being fed sequential bytes OR resynced mid-stream after a seek
// (scan to the next Cluster and continue, using each cluster's own Timestamp).
//
// MKV stores each ASS event in a block as "ReadOrder,Layer,Style,Name,MarginL,
// MarginR,MarginV,Effect,Text" with timing from the block timecode + duration —
// we reconstruct the "Dialogue:" line ffmpeg's ass muxer would produce.

var zlib = require('zlib');

var IDS = {
    SEGMENT: 0x18538067, SEEKHEAD: 0x114d9b74, INFO: 0x1549a966, TIMESTAMPSCALE: 0x2ad7b1,
    TRACKS: 0x1654ae6b, TRACKENTRY: 0xae, TRACKNUMBER: 0xd7, TRACKTYPE: 0x83, CODECID: 0x86,
    CODECPRIVATE: 0x63a2, LANGUAGE: 0x22b59c, NAME: 0x536e, DEFAULTDURATION: 0x23e383,
    ATTACHMENTS: 0x1941a469, ATTACHEDFILE: 0x61a7, FILENAME: 0x466e, FILEMIME: 0x4660, FILEDATA: 0x465c,
    CLUSTER: 0x1f43b675, TIMESTAMP: 0xe7, SIMPLEBLOCK: 0xa3, BLOCKGROUP: 0xa0, BLOCK: 0xa1, BLOCKDURATION: 0x9b,
};
var MASTER = {};
[IDS.SEGMENT, IDS.SEEKHEAD, IDS.INFO, IDS.TRACKS, IDS.TRACKENTRY, IDS.ATTACHMENTS, IDS.ATTACHEDFILE, IDS.CLUSTER, IDS.BLOCKGROUP].forEach(function (i) { MASTER[i] = 1; });

// Read an element ID (marker kept). Returns {id, len} or null if not enough bytes.
function readId(buf, pos) {
    if (pos >= buf.length) return null;
    var first = buf[pos], len = 1, mask = 0x80;
    while (len <= 4 && !(first & mask)) { mask >>= 1; len++; }
    if (len > 4 || pos + len > buf.length) return null;
    var id = 0; for (var i = 0; i < len; i++) id = id * 256 + buf[pos + i];
    return { id: id, len: len };
}
// Read a size vint (marker stripped). Returns {value, len, unknown} or null.
function readSize(buf, pos) {
    if (pos >= buf.length) return null;
    var first = buf[pos], len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
    if (len > 8 || pos + len > buf.length) return null;
    var value = first & (mask - 1), allones = (first & (mask - 1)) === (mask - 1);
    for (var i = 1; i < len; i++) { value = value * 256 + buf[pos + i]; if (buf[pos + i] !== 0xff) allones = false; }
    return { value: value, len: len, unknown: allones };
}
function uint(buf, s, e) { var v = 0; for (var i = s; i < e; i++) v = v * 256 + buf[i]; return v; }

function fmtTs(sec) {
    if (sec < 0) sec = 0;
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return h + ':' + ('0' + m).slice(-2) + ':' + ('0' + s.toFixed(2)).slice(-5);
}
// block data (Buffer) -> "Dialogue:" line, with timing from start/end seconds.
function reconstruct(data, startS, endS) {
    var s = data.toString('utf8'), parts = [], idx = 0;
    for (var f = 0; f < 8; f++) { var c = s.indexOf(',', idx); if (c < 0) break; parts.push(s.slice(idx, c)); idx = c + 1; }
    var text = s.slice(idx);
    var layer = parts[1] || '0', style = parts[2] || 'Default', name = parts[3] || '',
        ml = parts[4] || '0', mr = parts[5] || '0', mv = parts[6] || '0', eff = parts[7] || '';
    return 'Dialogue: ' + layer + ',' + fmtTs(startS) + ',' + fmtTs(endS) + ',' + style + ',' + name + ',' + ml + ',' + mr + ',' + mv + ',' + eff + ',' + text;
}

function MkvSubDemux(cb) {
    this.cb = cb || {};
    this.buf = Buffer.alloc(0);
    this.tsScale = 1e6;          // ns per tick (default 1ms)
    this.tracks = [];            // {number, type, codec, codecPrivate, lang, name}
    this.subTrack = null;        // chosen ASS track number
    this.codecPrivate = null;
    this.headerEmitted = false;
    this.clusterTs = 0;          // current cluster base timestamp (ticks)
    this.pendingTracks = null;   // TrackEntry being assembled
    this.clusterOffsets = [];    // absolute byte offset of each Cluster seen (parseAll)
    this.subTracks = {};         // ALL ASS subtitle track numbers -> {name,lang,codecPrivate}
    this.allSubs = false;        // true -> emit events for every subtitle track (multi-track/selection)
}
// Pick the English "full" ASS track (mirrors parseProbe heuristic).
MkvSubDemux.prototype._chooseTrack = function () {
    var subs = this.tracks.filter(function (t) { return t.type === 0x11 && /ASS|SSA/i.test(t.codec || ''); });
    var st = this.subTracks;                                   // index EVERY sub track (for selection)
    subs.forEach(function (t) { if (t.number != null && !st[t.number]) st[t.number] = { name: t.name || '', lang: t.lang || '', codecPrivate: t.codecPrivate }; });
    if (this.subTrack != null) return;   // externally seeded (mid-file demuxer) — keep the default
    // Anime often has many sub tracks with null language but descriptive names
    // ("Full Subtitles", "Signs/Songs", "French"...), so match on name too.
    function nm(t) { return t.name || ''; }
    function eng(t) { return /^en/i.test(t.lang || '') || /english/i.test(nm(t)); }
    function notSign(t) { return !/sign|song/i.test(nm(t)); }
    var pick = subs.find(function (t) { return eng(t) && /full|dialog/i.test(nm(t)); })   // English full
        || subs.find(function (t) { return /full|dialog/i.test(nm(t)) && notSign(t); })   // "Full Subtitles" (any lang)
        || subs.find(function (t) { return eng(t) && notSign(t); })                        // English, not signs
        || subs.filter(notSign)[0] || subs[0];
    if (pick) { this.subTrack = pick.number; this.codecPrivate = pick.codecPrivate; }
};
// Exact video frame rate from the container: the video TrackEntry's DefaultDuration
// is ns-per-frame, so fps = 1e9 / DefaultDuration. This is the cadence the signs
// were typeset against and the picture is encoded at, so the renderer locks tracked
// signs to it instead of a hardcoded constant. Returns null if the container didn't
// declare it (rare for CFR anime) -> caller falls back to its own default.
MkvSubDemux.prototype.videoFps = function () {
    var v = this.tracks.filter(function (t) { return t.type === 0x01 && t.defaultDuration > 0; })[0];
    return v ? 1e9 / v.defaultDuration : null;
};
MkvSubDemux.prototype._emitHeaderIfReady = function () {
    if (!this.headerEmitted && this.subTrack != null && this.codecPrivate) {
        this.headerEmitted = true;
        if (this.cb.onHeader) this.cb.onHeader({ timestampScale: this.tsScale, trackNumber: this.subTrack, codecPrivate: this.codecPrivate.toString('utf8') });
    }
};
// Handle one fully-available element [dataStart, dataEnd) with id (recursive path).
MkvSubDemux.prototype._element = function (id, buf, ds, de, parent) {
    if (MASTER[id]) {
        this._openMaster(id);
        this._walk(buf, ds, de, id);
        this._closeMaster(id);
        return;
    }
    this._leaf(id, buf, ds, de);
};
// Master enter/exit context (shared by recursive + streaming parsers).
MkvSubDemux.prototype._openMaster = function (id) {
    if (id === IDS.TRACKENTRY) this.pendingTracks = { type: null, number: null, codec: null, codecPrivate: null, lang: null, name: null, defaultDuration: null };
    if (id === IDS.ATTACHEDFILE) this._pendFont = { name: null, mime: null, data: null };
};
MkvSubDemux.prototype._closeMaster = function (id) {
    if (id === IDS.TRACKENTRY && this.pendingTracks) { this.tracks.push(this.pendingTracks); this.pendingTracks = null; this._chooseTrack(); this._emitHeaderIfReady(); }
    if (id === IDS.ATTACHEDFILE && this._pendFont) { if (this.cb.onFont && this._pendFont.data) this.cb.onFont(this._pendFont); this._pendFont = null; }
};
MkvSubDemux.prototype._leaf = function (id, buf, ds, de) {
    switch (id) {
        case IDS.TIMESTAMPSCALE: this.tsScale = uint(buf, ds, de); break;
        case IDS.TRACKNUMBER: if (this.pendingTracks) this.pendingTracks.number = uint(buf, ds, de); break;
        case IDS.TRACKTYPE: if (this.pendingTracks) this.pendingTracks.type = uint(buf, ds, de); break;
        case IDS.CODECID: if (this.pendingTracks) this.pendingTracks.codec = buf.slice(ds, de).toString('utf8'); break;
        case IDS.CODECPRIVATE: if (this.pendingTracks) this.pendingTracks.codecPrivate = Buffer.from(buf.slice(ds, de)); break;
        case IDS.LANGUAGE: if (this.pendingTracks) this.pendingTracks.lang = buf.slice(ds, de).toString('utf8'); break;
        case IDS.NAME: if (this.pendingTracks) this.pendingTracks.name = buf.slice(ds, de).toString('utf8'); break;
        case IDS.DEFAULTDURATION: if (this.pendingTracks) this.pendingTracks.defaultDuration = uint(buf, ds, de); break;   // ns/frame -> exact video fps
        case IDS.FILENAME: if (this._pendFont) this._pendFont.name = buf.slice(ds, de).toString('utf8'); break;
        case IDS.FILEMIME: if (this._pendFont) this._pendFont.mime = buf.slice(ds, de).toString('utf8'); break;
        case IDS.FILEDATA: if (this._pendFont) this._pendFont.data = Buffer.from(buf.slice(ds, de)); break;
        case IDS.TIMESTAMP: this.clusterTs = uint(buf, ds, de); break;
        // Peek the block's track number BEFORE copying: video/audio keyframes are
        // hundreds of KB each and we'd otherwise allocate+discard a full copy of
        // every one just to reject it. Only subtitle blocks get copied. (Big memory
        // + GC win on webOS — video is 99%+ of the blocks we never keep.)
        case IDS.SIMPLEBLOCK: if (this._blockIsSub(buf, ds)) this._block(Buffer.from(buf.slice(ds, de)), null); break;
        case IDS.BLOCK: if (this._blockIsSub(buf, ds)) this._pendBlock = Buffer.from(buf.slice(ds, de)); break;   // wait for sibling BLOCKDURATION
        case IDS.BLOCKDURATION: if (this._pendBlock) { this._block(this._pendBlock, uint(buf, ds, de)); this._pendBlock = null; } break;
    }
};
// Cheap track-number peek straight off the source buffer (no copy) so the caller
// can skip non-subtitle blocks before allocating. Block starts with the track vint.
MkvSubDemux.prototype._blockIsSub = function (buf, ds) {
    var tn = readSize(buf, ds); if (!tn) return false;
    return this.allSubs ? !!this.subTracks[tn.value] : (tn.value === this.subTrack);
};
// Parse a (Simple)Block payload; durTicks null for SimpleBlock (duration 0).
MkvSubDemux.prototype._block = function (data, durTicks) {
    var tn = readSize(data, 0); if (!tn) return;
    if (this.cb.onBlockTn) this.cb.onBlockTn(tn.value);   // debug: every block's track number
    if (this.allSubs ? !this.subTracks[tn.value] : (tn.value !== this.subTrack)) return;
    var p = tn.len;
    if (p + 3 > data.length) return;
    var rel = (data[p] << 8) | data[p + 1]; if (rel & 0x8000) rel -= 0x10000;
    p += 3; // +2 int16 timecode +1 flags
    var payload = data.slice(p);
    // Many anime releases zlib-compress the subtitle track (Matroska
    // ContentCompression, algo 0). A zlib stream starts with 0x78 — inflate it
    // back to the real ASS event text.
    if (payload.length > 2 && payload[0] === 0x78 && (payload[1] === 0x01 || payload[1] === 0x9c || payload[1] === 0xda)) {
        try { payload = zlib.inflateSync(payload); } catch (e) { return; }   // corrupt/partial -> skip
    }
    // A valid S_TEXT/ASS block payload starts with "ReadOrder," (an integer). If a
    // false cluster match or a wrong track number slips a garbage block through,
    // the payload is binary — reject it so we never emit corrupt "Dialogue:" lines.
    if (!/^\d{1,10},/.test(payload.slice(0, 12).toString('latin1'))) return;
    var startS = (this.clusterTs + rel) * this.tsScale / 1e9;
    var endS = startS + (durTicks || 0) * this.tsScale / 1e9;
    if (this.cb.onEvent) this.cb.onEvent(reconstruct(payload, startS, endS), this._curCluster, tn.value);
};

// ---- streaming feed (bytes arrive in the player's request order) ------------
// pushAt(byteOffset, buf): feed a range. Contiguous ranges extend the parse;
// a gap (seek) triggers a resync to the next Cluster boundary. The header
// (Tracks/CodecPrivate/attachments) is parsed from the initial offset-0 range.
MkvSubDemux.prototype.pushAt = function (offset, buf) {
    if (this._sPending && offset === this._sAbs + this._sPending.length) {
        this._sPending = Buffer.concat([this._sPending, buf]);       // contiguous
    } else {
        this._sPending = Buffer.from(buf); this._sAbs = offset; this._sPos = offset; // (re)start
        this._stack = offset === 0 ? [] : [{ id: IDS.SEGMENT, end: Infinity }];
        if (offset !== 0) this._needResync = true;                    // jumped mid-file
    }
    this._parseStream();
};
// Find the next real Cluster start. The bare 4-byte ID (0x1F43B675) occurs by
// chance inside compressed video, so we VALIDATE each candidate: after the ID +
// size vint, a real cluster's first child is a Timestamp element (0xE7). This
// rejects false matches that would otherwise parse video bytes as garbage blocks.
MkvSubDemux.prototype._findCluster = function (buf, from) {
    for (var i = from; i + 4 <= buf.length; i++) {
        if (buf[i] === 0x1f && buf[i + 1] === 0x43 && buf[i + 2] === 0xb6 && buf[i + 3] === 0x75) {
            var sz = readSize(buf, i + 4);
            if (!sz) { if (i + 12 > buf.length) return -1; continue; }   // need more bytes to validate
            var child = i + 4 + sz.len;
            if (child + 1 >= buf.length) return -1;                      // wait for more bytes to validate
            var id = buf[child];
            if (id === 0xe7) return i;                                   // Timestamp first child -> real cluster
            if (id === 0xbf || id === 0xec) {                            // CRC-32 / Void, then Timestamp
                var cs = readSize(buf, child + 1);
                if (!cs) continue;
                var next = child + 1 + cs.len + cs.value;
                if (next >= buf.length) return -1;                       // wait for more bytes
                if (buf[next] === 0xe7) return i;
            }
        }
    }
    return -1;
};
MkvSubDemux.prototype._parseStream = function () {
    if (this._stack == null) this._stack = [];
    if (this._needResync) {
        var ci = this._findCluster(this._sPending, this._sPos - this._sAbs);
        if (ci < 0) { this._trim(true); return; }                    // no cluster yet; keep tail for the marker
        this._sPos = this._sAbs + ci; this._needResync = false;
    }
    while (true) {
        while (this._stack.length && this._sPos >= this._stack[this._stack.length - 1].end) this._closeMaster(this._stack.pop().id);
        var local = this._sPos - this._sAbs;
        if (local >= this._sPending.length) break;
        var idr = readId(this._sPending, local); if (!idr) break;
        var szr = readSize(this._sPending, local + idr.len); if (!szr) break;
        var dsLocal = local + idr.len + szr.len;
        var dsAbs = this._sPos + idr.len + szr.len;
        var deAbs = szr.unknown ? Infinity : dsAbs + szr.value;
        if (MASTER[idr.id]) { if (idr.id === IDS.CLUSTER) this._curCluster = this._sPos; this._openMaster(idr.id); this._stack.push({ id: idr.id, end: deAbs }); this._sPos = dsAbs; continue; }
        if (deAbs === Infinity) { this._sPos = dsAbs; continue; }     // shouldn't happen for leaves
        if (deAbs - this._sAbs > this._sPending.length) break;        // wait for full leaf data
        this._leaf(idr.id, this._sPending, dsLocal, deAbs - this._sAbs);
        this._sPos = deAbs;
    }
    this._trim(false);
};
MkvSubDemux.prototype._trim = function (keepTail) {
    var drop = (this._sPos - this._sAbs);
    // While resyncing, keep a chunk of tail so a cluster marker + its validation
    // bytes (size + CRC/Void + Timestamp) aren't split across a chunk boundary.
    if (keepTail) drop = Math.max(0, this._sPending.length - 64);
    if (drop > 0) { this._sPending = this._sPending.slice(drop); this._sAbs += drop; if (this._sPos < this._sAbs) this._sPos = this._sAbs; }
};
// Walk children of a master element occupying [start,end).
MkvSubDemux.prototype._walk = function (buf, start, end, parent) {
    var pos = start;
    while (pos < end) {
        var idr = readId(buf, pos); if (!idr) break;
        var szr = readSize(buf, pos + idr.len); if (!szr) break;
        var ds = pos + idr.len + szr.len;
        var de = szr.unknown ? end : ds + szr.value;
        if (de > end) de = end;                             // clamp (streaming/truncation safe)
        if (idr.id === IDS.CLUSTER) { this.clusterOffsets.push(pos); this._curCluster = pos; } // real cluster boundary
        this._element(idr.id, buf, ds, de, parent);
        pos = de;
    }
};
// Top-level: parse a complete buffer (whole file). For streaming, see push().
MkvSubDemux.prototype.parseAll = function (buf) {
    var pos = 0;
    while (pos < buf.length) {
        var idr = readId(buf, pos); if (!idr) break;
        var szr = readSize(buf, pos + idr.len); if (!szr) break;
        var ds = pos + idr.len + szr.len;
        var de = szr.unknown ? buf.length : Math.min(buf.length, ds + szr.value);
        if (idr.id === IDS.SEGMENT) this._walk(buf, ds, de, IDS.SEGMENT);
        pos = de;
    }
};

module.exports = { MkvSubDemux: MkvSubDemux, readId: readId, readSize: readSize, IDS: IDS, reconstruct: reconstruct, fmtTs: fmtTs };
