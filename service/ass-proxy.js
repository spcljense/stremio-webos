// Localhost range-proxy: ffmpeg hits 127.0.0.1 (no DNS), we forward the Range to
// the debrid CDN following redirects, and PIN the resolved CDN URL so later ranges
// skip the slow /resolve hop. Extracted verbatim from ass-extract.js so the tests
// exercise the real code.
var http = require('http'), https = require('https'), urlmod = require('url');

function fetchRange(u, range, cb, n) {
    n = n == null ? 6 : n;
    var lib = /^https:/.test(u) ? https : http;
    var opt = urlmod.parse(u);
    opt.headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
    if (range) opt.headers.Range = range;
    var rq;
    try {
        rq = lib.get(opt, function (r) {
            if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && n > 0) {
                r.resume(); return fetchRange(urlmod.resolve(u, r.headers.location), range, cb, n - 1);
            }
            cb(null, r, u); // u = final (post-redirect) URL
        });
    } catch (e) { return cb(e); }
    rq.on('error', function (e) { cb(e); });
    rq.setTimeout(30000, function () { rq.destroy(new Error('proxy timeout')); });
}

// Request handler bound to a { key -> mediaUrl } map (mutated in place to pin CDN).
function makeHandler(mediaMap) {
    return function (req, res) {
        var key = decodeURIComponent((req.url || '/').slice(1).split('?')[0]);
        var u = mediaMap[key];
        if (!u) { res.writeHead(404); res.end(); return; }
        fetchRange(u, req.headers.range, function (err, r, finalUrl) {
            if (err || !r) { try { res.writeHead(502); res.end(); } catch (e) {} return; }
            if (finalUrl && finalUrl !== mediaMap[key] && /^https?:/.test(finalUrl) && finalUrl.indexOf('/resolve/') < 0) mediaMap[key] = finalUrl;
            var h = {};
            ['content-length', 'content-range', 'accept-ranges', 'content-type'].forEach(function (k) { if (r.headers[k]) h[k] = r.headers[k]; });
            try { res.writeHead(r.statusCode, h); } catch (e) { try { r.destroy(); } catch (x) {} return; }
            r.on('error', function () { try { res.end(); } catch (e) {} });
            res.on('close', function () { try { r.destroy(); } catch (e) {} });
            r.pipe(res);
        });
    };
}

module.exports = { fetchRange: fetchRange, makeHandler: makeHandler };
