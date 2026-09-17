// srt-ass.js — Robust SRT/WebVTT to ASS converter
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

function assCs(t) {
    var m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(t);
    if (!m) return NaN;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + Math.round(parseInt((m[4] + '00').slice(0, 3), 10) / 10) / 100;
}

function convText(t) {
    if (!t) return '';
    t = t.replace(/\r/g, '');

    // Preserve {\an1..9} alignment tags, drop any other override block
    t = t.replace(/\{([^}]*)\}/g, function (m, inner) {
        var s = inner.trim();
        return /^\\an[1-9]$/.test(s) ? '{' + s + '}' : '';
    });

    // Convert HTML formatting to ASS tags
    t = t.replace(/<\s*i\s*>/gi, '{\\i1}').replace(/<\s*\/\s*i\s*>/gi, '{\\i0}')
        .replace(/<\s*b\s*>/gi, '{\\b1}').replace(/<\s*\/\s*b\s*>/gi, '{\\b0}')
        .replace(/<\s*u\s*>/gi, '{\\u1}').replace(/<\s*\/\s*u\s*>/gi, '{\\u0}')
        // Safely strip HTML tags without wiping out mathematical "<" or "<3"
        .replace(/<\/?(?:font|span|p|div|color|size|b|i|u)[^>]*>/gi, '')
        .replace(/<[^>]{1,50}>/g, '');

    // Convert hard breaks to ASS \N
    t = t.replace(/\n+/g, '\\N');
    t = t.replace(/^(?:\\N)+/, '').replace(/(?:\\N)+$/, '');
    return t.trim();
}

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

function srtToAss(src, resX, resY) {
    if (!src) return '';
    // Strip UTF-8 BOM
    src = src.replace(/^\uFEFF/, '').replace(/^﻿/, '');

    // Pass through if already ASS/SSA
    if (/^\s*\[Script Info\]/.test(src) || /\n\s*Dialogue\s*:/.test(src)) return src;

    var head = assHeader(resX, resY);
    var out = [];

    // Normalize line endings to \n
    var rawLines = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    var timeRegex = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
    var currentCue = null;
    var textLines = [];

    function pushCue() {
        if (!currentCue || !textLines.length) return;
        var body = convText(textLines.join('\n'));
        if (body) {
            out.push('Dialogue: 0,' + currentCue.s + ',' + currentCue.e + ',Default,,0,0,0,,' + body);
        }
        currentCue = null;
        textLines = [];
    }

    for (var i = 0; i < rawLines.length; i++) {
        var line = rawLines[i];
        var trimmed = line.trim();

        var tm = timeRegex.exec(trimmed);
        if (tm) {
            pushCue();

            var s = toAssTime(tm[1]);
            var e = toAssTime(tm[2]);
            if (s && e) {
                var startSec = assCs(tm[1]);
                var endSec = assCs(tm[2]);
                // Readability floor: ensure cues stay visible for at least 1.2s
                if (endSec < startSec + 1.2) {
                    var sec = startSec + Math.max(1.2, Math.min(3.5, trimmed.length * 0.06));
                    var hh = Math.floor(sec / 3600);
                    var mm = Math.floor((sec % 3600) / 60);
                    var ss = sec % 60;
                    e = hh + ':' + String(mm).padStart(2, '0') + ':' + ss.toFixed(2).padStart(5, '0');
                }
                currentCue = { s: s, e: e };
            }
            continue;
        }

        // Collect dialogue text (ignoring standalone numeric index lines between cues)
        if (currentCue) {
            if (/^\d+$/.test(trimmed) && i + 1 < rawLines.length && timeRegex.test(rawLines[i + 1])) {
                continue;
            }
            if (trimmed) {
                textLines.push(trimmed);
            }
        }
    }

    pushCue();

    return head + out.join('\n') + '\n';
}

module.exports = { srtToAss: srtToAss, assHeader: assHeader, textToAss: convText };
