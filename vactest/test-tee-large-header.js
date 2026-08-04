// Real anime releases can embed enough fonts to put the first Cluster beyond
// 16 MiB. Bootstrap must keep reading the bounded head range until that Cluster
// instead of retrying the same too-short prefix forever.
var assert = require('node:assert/strict');
var fs = require('fs');
var http = require('http');
var os = require('os');
var path = require('path');
var G = require('./mkv-gen.js');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-tee-large-header-'));
var mediaPath = path.join(tmp, 'episode.mkv');
var info = G.build({
    path: mediaPath,
    durSec: 2,
    bitrateBps: 1e6,
    seed: 11,
    headerPaddingBytes: 20 * 1024 * 1024,
});
var media = fs.readFileSync(mediaPath);
var bootstrapRanges = [];

function cleanup() {
    try { fs.unlinkSync(mediaPath); } catch (e) {}
    try { fs.rmdirSync(tmp); } catch (e) {}
}

function send(res, body, start) {
    res.writeHead(206, {
        'content-length': body.length,
        'content-range': 'bytes ' + start + '-' + (start + body.length - 1) + '/' + media.length,
        'accept-ranges': 'bytes',
        'content-type': 'video/x-matroska',
    });
    res.end(body);
}

var cdn = http.createServer(function (req, res) {
    var match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    var start = match ? +match[1] : 0;
    var end = match && match[2] ? Math.min(+match[2], media.length - 1) : media.length - 1;
    if (start === 0 && end > 0) bootstrapRanges.push(req.headers.range);
    send(res, media.slice(start, end + 1), start);
});

function fail(error) {
    console.error(error && error.stack || error);
    cleanup();
    cdn.close(function () { process.exit(1); });
}

cdn.listen(0, '127.0.0.1', function () {
    process.env.ASS_TEE_PORT = String(25000 + (process.pid % 10000));
    process.env.ASS_TEE_BOOTSTRAP_ATTEMPTS = '1';
    process.env.ASS_TEE_BOOTSTRAP_COOLDOWN_MS = '10000';
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
                        assert.ok(info.headerLen > 16 * 1024 * 1024, 'fixture must exceed the old bootstrap cap');
                        assert.equal(bootstrapRanges.length, 1, 'large header should bootstrap in one bounded stream');
                        assert.ok(+bootstrapRanges[0].split('-')[1] >= info.headerLen, 'bootstrap range must reach the first Cluster');
                        assert.equal(status.tracks.length, 1);
                        assert.equal(status.tracks[0].name, 'Full Subtitles');
                        console.log('PASSED subtitle bootstrap reaches a Cluster beyond 16 MiB');
                        cleanup();
                        return cdn.close(function () { process.exit(0); });
                    } catch (error) {
                        return fail(error);
                    }
                }
                if (Date.now() >= deadline)
                    return fail(new Error('subtitle bootstrap did not reach the large-header Cluster; ranges=' + bootstrapRanges.join(',')));
                setTimeout(poll, 20);
            })();
        });
    }).on('error', fail);
});
