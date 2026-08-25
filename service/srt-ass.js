// srt-ass.js — convert an external subtitle (SRT, incl. SRT carrying inline
// {\anN} positioning tags) into ASS/SSA so it can render through our JASSUB
// path instead of the webOS player's plain-text overlay (which prints ASS
// override tags literally). Already-ASS input passes through unchanged.
//
// Preserves ONLY {\an1}..{\an9} alignment overrides (the common "sign at top"
// case); other raw brace overrides are dropped so a stray/garbled tag can't
// make libass mis-parse or hide a line. <i>/<b>/<u> map to the ASS toggles.

// H:MM:SS.cc from "HH:MM:SS,mmm" (or '.'). Centisecond rounding with carry.
function toAssTime(t) {
    var m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(t);
    if (!m) return null;
    var hh = +m[1], mm = +m[2], ss = +m[3];
    var cs = Math.round(parseInt((m[4] + '00').slice(0, 3), 10) / 10);
    if (cs >= 100) { cs -= 100; ss += 1; }
    if (ss >= 60) { ss -= 60; mm += 1; }
    if (mm >= 60) { mm -= 60; hh += 1; }
    return hh + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}
function assCs(t) { // seconds as a number, for the >= start+0.01 guard
    var m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(t);
    if (!m) return NaN;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + Math.round(parseInt((m[4] + '00').slice(0, 3), 10) / 10) / 100;
}

function convText(t) {
    t = t.replace(/\r/g, '');
    // keep {\an1..9}; drop any other {...} override block
    t = t.replace(/\{([^}]*)\}/g, function (m, inner) {
        var s = inner.trim();
        return /^\\an[1-9]$/.test(s) ? '{' + s + '}' : '';
    });
    // html styling -> ass toggles; strip any other html but keep its text
    t = t.replace(/<\s*i\s*>/gi, '{\\i1}').replace(/<\s*\/\s*i\s*>/gi, '{\\i0}')
        .replace(/<\s*b\s*>/gi, '{\\b1}').replace(/<\s*\/\s*b\s*>/gi, '{\\b0}')
        .replace(/<\s*u\s*>/gi, '{\\u1}').replace(/<\s*\/\s*u\s*>/gi, '{\\u0}')
        .replace(/<[^>]+>/g, '');
    t = t.replace(/\n/g, '\\N');   // SRT hard line break -> ASS \N
    t = t.replace(/^(?:\\N)+/, '').replace(/(?:\\N)+$/, '');   // no leading/trailing breaks
    return t.trim();
}

// Shared plain-text subtitle header. Embedded S_TEXT/UTF8 blocks already carry
// timing in Matroska, so the streaming demuxer reuses this header + convText()
// without round-tripping through a synthetic SRT document.
function assHeader(resX, resY) {
    var W = resX && isFinite(resX) ? Math.round(resX) : 1920;
    var H = resY && isFinite(resY) ? Math.round(resY) : 1080;
    var fs = Math.max(18, Math.round(60 * H / 1080));
    var ol = Math.max(1, +(3 * H / 1080).toFixed(1));
    var mv = Math.max(10, Math.round(40 * H / 1080));
    return '[Script Info]\nScriptType: v4.00+\nPlayResX: ' + W + '\nPlayResY: ' + H + '\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n'
        + '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
        + 'Style: Default,Liberation Sans,' + fs + ',&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,' + ol + ',0,2,60,60,' + mv + ',1\n\n'
        + '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
}

// resX/resY: script resolution (match the video; default 1920x1080). Style
// scales with resY so it looks right at any resolution.
function srtToAss(src, resX, resY) {
    if (!src) return '';
    src = src.replace(/^﻿/, '');                       // BOM
    if (/^\s*\[Script Info\]/.test(src) || /\n\s*Dialogue\s*:/.test(src)) return src;  // already ASS
    var head = assHeader(resX, resY);
    var out = [];
    var blocks = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n[ \t]*\n/);
    for (var i = 0; i < blocks.length; i++) {
        var lines = blocks[i].split('\n');
        while (lines.length && !lines[0].trim()) lines.shift();
        if (lines.length && /^\d+$/.test(lines[0].trim())) lines.shift();   // index line
        if (!lines.length) continue;
        var tm = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/.exec(lines[0]);
        if (!tm) continue;
        var s = toAssTime(tm[1]), e = toAssTime(tm[2]);
        if (!s || !e) continue;
        if (assCs(tm[2]) < assCs(tm[1]) + 0.01) {           // ensure end >= start + 1cs (avoid collapse)
            var sec = assCs(tm[1]) + 0.06, hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
            e = hh + ':' + String(mm).padStart(2, '0') + ':' + ss.toFixed(2).padStart(5, '0');
        }
        var body = convText(lines.slice(1).join('\n'));
        if (!body) continue;
        out.push('Dialogue: 0,' + s + ',' + e + ',Default,,0,0,0,,' + body);
    }
    return head + out.join('\n') + '\n';
}

module.exports = { srtToAss: srtToAss, assHeader: assHeader, textToAss: convText };
