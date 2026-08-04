// WEB-DL releases commonly carry S_TEXT/UTF8 rather than ASS. The tee must
// expose those embedded tracks and turn their timed text blocks into ASS events
// for the same JASSUB renderer used by styled anime subtitles.
var assert = require('node:assert/strict');
var fs = require('fs');
var http = require('http');
var os = require('os');
var path = require('path');
var G = require('./mkv-gen.js');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-tee-utf8-'));
var mediaPath = path.join(tmp, 'episode.mkv');
G.build({
    path: mediaPath,
    durSec: 8,
    bitrateBps: 1e6,
    subtitleCodec: 'S_TEXT/UTF8',
    events: [{ start: 1.25, end: 3.75, text: '<i>English dialogue</i>\nsecond line', style: 'Default' }],
});
var media = fs.readFileSync(mediaPath);

function cleanup() {
    try { fs.unlinkSync(mediaPath); } catch (e) {}
    try { fs.rmdirSync(tmp); } catch (e) {}
}

var cdn = http.createServer(function (req, res) {
    var match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    var start = match ? +match[1] : 0;
    var end = match && match[2] ? Math.min(+match[2], media.length - 1) : media.length - 1;
    var body = media.slice(start, end + 1);
    res.writeHead(206, {
        'content-length': body.length,
        'content-range': 'bytes ' + start + '-' + end + '/' + media.length,
        'accept-ranges': 'bytes',
        'content-type': 'video/x-matroska',
    });
    res.end(body);
});

function fail(error) {
    console.error(error && error.stack || error);
    cleanup();
    cdn.close(function () { process.exit(1); });
}

cdn.listen(0, '127.0.0.1', function () {
    process.env.ASS_TEE_PORT = String(26000 + (process.pid % 10000));
    var tee = require('../service/ass-tee');
    var source = 'http://127.0.0.1:' + cdn.address().port + '/episode.mkv';

    http.get({ host: '127.0.0.1', port: tee.PORT, path: '/s/' + encodeURIComponent(source) }, function (res) {
        res.resume();
        res.on('end', function () {
            var deadline = Date.now() + 1500;
            (function poll() {
                var status = tee.status(source);
                if (status.ready && status.tracks.length && status.tracks[0].events) {
                    try {
                        var ass = tee.trackText(source, 0);
                        assert.equal(status.tracks[0].name, 'Full Subtitles');
                        assert.match(ass, /Style: Default,Liberation Sans/);
                        assert.match(ass, /Dialogue: 0,0:00:01\.25,0:00:03\.75,Default/);
                        assert.match(ass, /\{\\i1\}English dialogue\{\\i0\}\\Nsecond line/);
                        console.log('PASSED embedded S_TEXT/UTF8 renders through JASSUB');
                        cleanup();
                        return cdn.close(function () { process.exit(0); });
                    } catch (error) {
                        return fail(error);
                    }
                }
                if (Date.now() >= deadline)
                    return fail(new Error('embedded UTF-8 subtitles were not exposed; tracks=' + JSON.stringify(status.tracks)));
                setTimeout(poll, 20);
            })();
        });
    }).on('error', fail);
});
