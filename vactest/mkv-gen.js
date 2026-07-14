// Synthetic Matroska generator for the subtitle-dropout repro.
//
// Produces a REAL MKV that the REAL service/mkv-subs.js demuxer parses:
//   EBML header
//   Segment (unknown size)
//     Info: TimestampScale = 1ms
//     Tracks: #1 video (DefaultDuration -> 23.976fps), #2 subtitle S_TEXT/ASS + CodecPrivate
//     Cluster* : exactly ONE cluster per second of media, each exactly BYTES_PER_SEC bytes
//                (Timestamp + subtitle BlockGroups for that second + a video SimpleBlock
//                 padded so the cluster hits its byte target)
//
// One cluster == one second == a fixed number of bytes makes the byte<->media-time map
// EXACT, so "the demuxer only knows about bytes that have flowed" becomes measurable.

var fs = require('fs');

// ---- EBML primitives ---------------------------------------------------------
function idBuf(id) { var b = []; var x = id; while (x > 0) { b.unshift(x & 0xff); x = Math.floor(x / 256); } return Buffer.from(b); }
function vint(v, forceLen) {
    for (var L = forceLen || 1; L <= 8; L++) {
        var max = Math.pow(2, 7 * L) - 1;
        if (forceLen || v < max) {
            var b = Buffer.alloc(L), x = v;
            for (var i = L - 1; i >= 0; i--) { b[i] = x & 0xff; x = Math.floor(x / 256); }
            b[0] |= (1 << (8 - L));
            return b;
        }
    }
    throw new Error('vint too big: ' + v);
}
function uintBuf(v) { var b = []; do { b.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0); return Buffer.from(b); }
function el(id, data) { return Buffer.concat([idBuf(id), vint(data.length), data]); }
function elU(id, v) { return el(id, uintBuf(v)); }
function elS(id, s) { return el(id, Buffer.from(s, 'utf8')); }
function master(id, children) { return el(id, Buffer.concat(children)); }
var UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

var ID = {
    EBML: 0x1a45dfa3, SEGMENT: 0x18538067, INFO: 0x1549a966, TIMESTAMPSCALE: 0x2ad7b1,
    TRACKS: 0x1654ae6b, TRACKENTRY: 0xae, TRACKNUMBER: 0xd7, TRACKTYPE: 0x83, CODECID: 0x86,
    CODECPRIVATE: 0x63a2, LANGUAGE: 0x22b59c, NAME: 0x536e, DEFAULTDURATION: 0x23e383,
    CLUSTER: 0x1f43b675, TIMESTAMP: 0xe7, SIMPLEBLOCK: 0xa3, BLOCKGROUP: 0xa0, BLOCK: 0xa1, BLOCKDURATION: 0x9b,
};

var ASS_HEADER = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    'PlayResY: 1080',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Open Sans,66,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,54,1',
    'Style: Sign,Trebuchet MS,54,&H00FFFFFF,&H000000FF,&H00202020,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,60,60,54,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ''
].join('\n');

// ---- deterministic PRNG ------------------------------------------------------
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Realistic-ish anime dialogue: near-continuous lines with a couple of genuinely
// silent stretches (so the harness must distinguish "no sub here" from "sub lost").
function genEvents(durSec, seed) {
    var rnd = mulberry32(seed || 1), ev = [], t = 4.0, n = 0;
    var SILENT = [[97, 108], [206, 215]];   // deliberate silence -> control samples
    function silent(x) { for (var i = 0; i < SILENT.length; i++) if (x >= SILENT[i][0] && x < SILENT[i][1]) return SILENT[i][1]; return 0; }
    while (t < durSec - 6) {
        var s = silent(t); if (s) { t = s + 0.3; continue; }
        var dur = 1.6 + rnd() * 2.6;
        var end = Math.min(t + dur, durSec - 1);
        var s2 = silent(end); if (s2) { t = s2 + 0.3; continue; }
        ev.push({ start: +t.toFixed(2), end: +end.toFixed(2), text: 'Line ' + (n) + ' — the quick brown fox jumps over the lazy dog.', style: 'Default' });
        n++;
        t = end + rnd() * 0.25;             // near-continuous coverage
    }
    return ev;
}

// ---- writer ------------------------------------------------------------------
// opts: { path, durSec, bitrateBps, seed }
// returns { path, size, headerLen, bytesPerSec, durSec, events }
function build(opts) {
    var durSec = opts.durSec, BPS = Math.floor(opts.bitrateBps / 8);
    var events = opts.events || genEvents(durSec, opts.seed);

    var header = Buffer.concat([
        master(ID.EBML, [elU(0x4286, 1), elU(0x42f7, 1), elU(0x42f2, 4), elU(0x42f3, 8), elS(0x4282, 'matroska'), elU(0x4287, 4), elU(0x4285, 2)]),
        idBuf(ID.SEGMENT), UNKNOWN_SIZE,
        master(ID.INFO, [elU(ID.TIMESTAMPSCALE, 1000000)]),
        master(ID.TRACKS, [
            master(ID.TRACKENTRY, [elU(ID.TRACKNUMBER, 1), elU(ID.TRACKTYPE, 1), elS(ID.CODECID, 'V_MPEG4/ISO/AVC'), elU(ID.DEFAULTDURATION, 41708333)]),
            master(ID.TRACKENTRY, [elU(ID.TRACKNUMBER, 2), elU(ID.TRACKTYPE, 0x11), elS(ID.CODECID, 'S_TEXT/ASS'),
                elS(ID.NAME, 'Full Subtitles'), elS(ID.LANGUAGE, 'eng'), elS(ID.CODECPRIVATE, ASS_HEADER)]),
        ]),
    ]);

    // pre-bucket events into the cluster (== second) that contains their start
    var buckets = {};
    events.forEach(function (e, i) {
        var c = Math.floor(e.start);
        (buckets[c] || (buckets[c] = [])).push({ e: e, ro: i });
    });

    var fd = fs.openSync(opts.path, 'w');
    fs.writeSync(fd, header);
    var rnd = mulberry32(0xbeef);
    var pad = Buffer.alloc(BPS);           // reused scratch for the video payload

    for (var c = 0; c < durSec; c++) {
        var kids = [elU(ID.TIMESTAMP, c * 1000)];
        (buckets[c] || []).forEach(function (b) {
            var e = b.e;
            var rel = Math.round((e.start - c) * 1000);            // ms, relative to cluster ts
            var dur = Math.max(1, Math.round((e.end - e.start) * 1000));
            var payload = Buffer.from(b.ro + ',0,' + e.style + ',,0,0,0,,' + e.text, 'utf8');
            var blk = Buffer.concat([vint(2), Buffer.from([(rel >> 8) & 0xff, rel & 0xff, 0x00]), payload]);
            kids.push(master(ID.BLOCKGROUP, [el(ID.BLOCK, blk), elU(ID.BLOCKDURATION, dur)]));
        });
        var kidsBuf = Buffer.concat(kids);
        // cluster on the wire = 4 (id) + 4 (forced size vint) + children
        var childrenTarget = BPS - 8;
        var sbTotal = childrenTarget - kidsBuf.length;             // whole SimpleBlock element
        var padLen = sbTotal - (1 /*id*/ + 4 /*forced size vint*/ + 1 /*track vint*/ + 2 + 1);
        if (padLen < 1) throw new Error('bitrate too low for cluster ' + c);
        // deterministic filler; scrub any accidental Cluster ID so no false resync target
        for (var i = 0; i < padLen; i++) pad[i] = (rnd() * 256) | 0;
        for (var i = 0; i + 3 < padLen; i++) if (pad[i] === 0x1f && pad[i + 1] === 0x43 && pad[i + 2] === 0xb6 && pad[i + 3] === 0x75) pad[i] = 0x1e;
        var sbData = Buffer.concat([vint(1), Buffer.from([0x00, 0x00, 0x80]), pad.slice(0, padLen)]);
        var sb = Buffer.concat([idBuf(ID.SIMPLEBLOCK), vint(sbData.length, 4), sbData]);
        var cluster = Buffer.concat([idBuf(ID.CLUSTER), vint(kidsBuf.length + sb.length, 4), kidsBuf, sb]);
        if (cluster.length !== BPS) throw new Error('cluster ' + c + ' is ' + cluster.length + ' not ' + BPS);
        fs.writeSync(fd, cluster);
    }
    fs.closeSync(fd);

    return { path: opts.path, size: header.length + durSec * BPS, headerLen: header.length, bytesPerSec: BPS, durSec: durSec, events: events };
}

module.exports = { build: build, genEvents: genEvents, ASS_HEADER: ASS_HEADER };
