// font-info.js — minimal OpenType/TrueType 'name' table reader.
// Extracts the font family name(s) so the subtitle pipeline can load fonts
// ON DEMAND (JASSUB availableFonts) by the name the ASS Style/\fn references,
// instead of eagerly loading all 14-18 embedded CJK fonts into the wasm heap.
// Handles .ttf/.otf (sfnt) and .ttc (collections). Returns lowercased names.
// Returns [] on any parse failure so the caller can fall back to eager loading
// (never lose a font).

function utf16be(buf, start, len) {
    var s = '';
    for (var i = 0; i + 1 < len; i += 2) s += String.fromCharCode((buf[start + i] << 8) | buf[start + i + 1]);
    return s;
}

// Parse a single sfnt at `base`, collecting family (nameID 1/16) and full (nameID 4)
// names into `out` (lowercased, deduped).
function readSfnt(buf, base, out) {
    if (base + 12 > buf.length) return;
    var numTables = buf.readUInt16BE(base + 4);
    var rec = base + 12, nameOff = -1;
    for (var i = 0; i < numTables && rec + 16 <= buf.length; i++, rec += 16) {
        if (buf.toString('latin1', rec, rec + 4) === 'name') { nameOff = buf.readUInt32BE(rec + 8); break; }
    }
    if (nameOff < 0 || nameOff + 6 > buf.length) return;
    var count = buf.readUInt16BE(nameOff + 2);
    var strBase = nameOff + buf.readUInt16BE(nameOff + 4);
    var p = nameOff + 6;
    for (var j = 0; j < count && p + 12 <= buf.length; j++, p += 12) {
        var platformID = buf.readUInt16BE(p);
        var nameID = buf.readUInt16BE(p + 6);
        if (nameID !== 1 && nameID !== 4 && nameID !== 6 && nameID !== 16) continue;   // 1=family 4=full 6=PostScript 16=typo family
        var len = buf.readUInt16BE(p + 8);
        var so = strBase + buf.readUInt16BE(p + 10);
        if (so + len > buf.length || len <= 0) continue;
        var s;
        if (platformID === 3 || platformID === 0) s = utf16be(buf, so, len);   // Windows / Unicode -> UTF-16BE
        else s = buf.toString('latin1', so, so + len);                          // Mac -> (near-)ASCII
        s = (s || '').replace(/\0/g, '').trim().toLowerCase();
        if (s && out.indexOf(s) < 0) out.push(s);
    }
}

// Return { names: [family/full names, lowercased] } for a font buffer, or {names:[]}.
function fontNames(buf) {
    try {
        if (!buf || buf.length < 12) return { names: [] };
        var out = [];
        var tag = buf.toString('latin1', 0, 4);
        if (tag === 'ttcf') {                          // TrueType Collection
            var num = buf.readUInt32BE(8);
            for (var i = 0; i < num && 12 + i * 4 + 4 <= buf.length; i++) readSfnt(buf, buf.readUInt32BE(12 + i * 4), out);
        } else {                                       // single sfnt (0x00010000, OTTO, true, typ1)
            readSfnt(buf, 0, out);
        }
        return { names: out };
    } catch (e) { return { names: [] }; }
}

module.exports = { fontNames: fontNames };
