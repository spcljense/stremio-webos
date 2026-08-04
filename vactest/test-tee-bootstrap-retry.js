// A truncated MKV header must not poison the subtitle session forever.
// The first retry burst ends immediately before the first Cluster. A later
// status poll must start a fresh burst, receive the complete synthetic MKV, and
// publish its embedded subtitle track instead of preserving a poisoned session.
var assert = require('node:assert/strict');
var fs = require('fs');
var http = require('http');
var os = require('os');
var path = require('path');
var G = require('./mkv-gen.js');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-tee-bootstrap-'));
var mediaPath = path.join(tmp, 'episode.mkv');
var info = G.build({ path: mediaPath, durSec: 2, bitrateBps: 1e6, seed: 7 });
var media = fs.readFileSync(mediaPath);
var bootstrapHits = 0;

function cleanup() {
    try { fs.unlinkSync(mediaPath); } catch (e) {}
    try { fs.rmdirSync(tmp); } catch (e) {}
}

function send(res, body, start) {
    start = start || 0;
    res.writeHead(206, {
        'content-length': body.length,
        'content-range': 'bytes ' + start + '-' + (start + body.length - 1) + '/' + media.length,
        'accept-ranges': 'bytes',
        'content-type': 'video/x-matroska',
    });
    res.end(body);
}

var cdn = http.createServer(function (req, res) {
    var range = req.headers.range || '';
    if (range === 'bytes=0-16777215') {
        bootstrapHits++;
        return send(res, bootstrapHits <= 2 ? media.slice(0, info.headerLen) : media);
    }
    var match = /bytes=(\d+)-(\d*)/.exec(range);
    var start = match ? +match[1] : 0;
    var end = match && match[2] ? Math.min(+match[2], media.length - 1) : media.length - 1;
    send(res, media.slice(start, end + 1), start);
});

function fail(error) {
    console.error(error && error.stack || error);
    cleanup();
    cdn.close(function () { process.exit(1); });
}

cdn.listen(0, '127.0.0.1', function () {
    process.env.ASS_TEE_PORT = String(24000 + (process.pid % 10000));
    process.env.ASS_TEE_BOOTSTRAP_ATTEMPTS = '2';
    process.env.ASS_TEE_BOOTSTRAP_RETRY_MS = '20';
    process.env.ASS_TEE_BOOTSTRAP_COOLDOWN_MS = '50';
    var tee = require('../service/ass-tee');
    var source = 'http://127.0.0.1:' + cdn.address().port + '/episode.mkv';

    http.get({
        host: '127.0.0.1',
        port: tee.PORT,
        path: '/s/' + encodeURIComponent(source),
        headers: { Range: 'bytes=0-0' },
    }, function (res) {
        res.resume();
        res.on('end', function () {
            var deadline = Date.now() + 1500;
            (function poll() {
                var status = tee.status(source);
                if (status.ready) {
                    try {
                        assert.equal(bootstrapHits, 3);
                        assert.equal(status.tracks.length, 1);
                        assert.equal(status.tracks[0].name, 'Full Subtitles');
                        console.log('PASSED incomplete subtitle bootstrap retries and recovers');
                        cleanup();
                        return cdn.close(function () { process.exit(0); });
                    } catch (error) {
                        return fail(error);
                    }
                }
                if (Date.now() >= deadline)
                    return fail(new Error('subtitle bootstrap remained poisoned after ' + bootstrapHits + ' attempt(s)'));
                setTimeout(poll, 20);
            })();
        });
    }).on('error', fail);
});
