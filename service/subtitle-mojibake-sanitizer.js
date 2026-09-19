'use strict';

/*
 * Repairs UTF-8 text that was incorrectly decoded as Windows-1252.
 * Examples:
 *   presidentiÃ«le -> presidentiële
 *   cafÃ©         -> café
 *   geÃ¼pload     -> geüpload
 *   GEÃœPLOAD     -> GEÜPLOAD
 *   â€™            -> ’
 *   â€“            -> –
 */

var cp1252 = {
    0x20AC: 0x80,
    0x201A: 0x82,
    0x0192: 0x83,
    0x201E: 0x84,
    0x2026: 0x85,
    0x2020: 0x86,
    0x2021: 0x87,
    0x02C6: 0x88,
    0x2030: 0x89,
    0x0160: 0x8A,
    0x2039: 0x8B,
    0x0152: 0x8C,
    0x017D: 0x8E,
    0x2018: 0x91,
    0x2019: 0x92,
    0x201C: 0x93,
    0x201D: 0x94,
    0x2022: 0x95,
    0x2013: 0x96,
    0x2014: 0x97,
    0x02DC: 0x98,
    0x2122: 0x99,
    0x0161: 0x9A,
    0x203A: 0x9B,
    0x0153: 0x9C,
    0x017E: 0x9E,
    0x0178: 0x9F
};

function suspiciousScore(s) {
    var m = String(s || '').match(/[ÃÂâðÐÑ]/g);
    var score = m ? m.length : 0;

    m = String(s || '').match(/\uFFFD/g);
    if (m) score += m.length * 4;

    return score;
}

function windows1252ToBytes(s) {
    var bytes = [];

    for (var i = 0; i < s.length; i++) {
        var code = s.charCodeAt(i);

        if (code <= 0xFF) {
            bytes.push(code);
        } else if (Object.prototype.hasOwnProperty.call(cp1252, code)) {
            bytes.push(cp1252[code]);
        } else {
            return null;
        }
    }

    return bytes;
}

function repairOnce(s) {
    var bytes = windows1252ToBytes(s);
    if (!bytes) return s;

    try {
        var buf = typeof Buffer.from === 'function'
            ? Buffer.from(bytes)
            : new Buffer(bytes);

        return buf.toString('utf8');
    } catch (e) {
        return s;
    }
}

function sanitizeSubtitleMojibake(input) {
    if (input === null || input === undefined) return input;

    var text = String(input).replace(/^\uFEFF/, '');

    for (var pass = 0; pass < 2; pass++) {
        var before = suspiciousScore(text);

        if (!before) break;

        var repaired = repairOnce(text);
        var after = suspiciousScore(repaired);

        if (after >= before) break;
        if ((repaired.match(/\uFFFD/g) || []).length >
            (text.match(/\uFFFD/g) || []).length) break;

        text = repaired;
    }

    return text;
}

module.exports = {
    sanitizeSubtitleMojibake: sanitizeSubtitleMojibake
};
