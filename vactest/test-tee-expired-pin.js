// Regression: a TorBox CDN redirect is temporary.  Once that pinned URL
// expires, the tee must go back through the stable resolver exactly once and
// continue the player's range request with the replacement CDN URL.
var assert = require('node:assert/strict');
var fs = require('fs');
var http = require('http');
var os = require('os');
var path = require('path');
var mkv = require('./mkv-gen');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-tee-expired-'));
var fixturePath = path.join(tmp, 'video.mkv');
mkv.build({ path: fixturePath, durSec: 8, bitrateBps: 1000000, seed: 7 });
var body = fs.readFileSync(fixturePath);
var resolverHits = 0;
var oldExpired = false;

function sendRange(req, res) {
    var match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    var start = match ? parseInt(match[1], 10) : 0;
    var requestedEnd = match && match[2] ? parseInt(match[2], 10) : body.length - 1;
    var end = Math.min(requestedEnd, body.length - 1);
    var chunk = body.slice(start, end + 1);
    res.writeHead(206, {
        'content-length': chunk.length,
        'content-range': 'bytes ' + start + '-' + end + '/' + body.length,
        'accept-ranges': 'bytes',
        'content-type': 'video/x-matroska',
    });
    res.end(chunk);
}

var upstream = http.createServer(function (req, res) {
    if (req.url === '/resolve/video') {
        resolverHits++;
        res.writeHead(302, { location: resolverHits === 1 ? '/cdn/old.mkv' : '/cdn/new.mkv' });
        return res.end();
    }
    if (req.url === '/cdn/old.mkv') {
        if (oldExpired) { res.writeHead(502); return res.end('expired'); }
        return sendRange(req, res);
    }
    if (req.url === '/cdn/new.mkv') return sendRange(req, res);
    res.writeHead(404);
    res.end();
});

function finish(error) {
    if (error) console.error(error && error.stack || error);
    upstream.close(function () {
        fs.rmSync(tmp, { recursive: true, force: true });
        process.exit(error ? 1 : 0);
    });
}

upstream.listen(0, '127.0.0.1', function () {
    process.env.ASS_TEE_PORT = String(23000 + (process.pid % 9000));
    var tee = require('../service/ass-tee');
    var source = 'http://127.0.0.1:' + upstream.address().port + '/resolve/video';
    var deadline = Date.now() + 3000;

    function waitForBootstrap() {
        if (tee.status(source).ready) {
            try { assert.equal(resolverHits, 1, 'bootstrap should resolve the source once'); }
            catch (error) { return finish(error); }
            oldExpired = true;
            return requestVideo();
        }
        if (Date.now() >= deadline) return finish(new Error('subtitle bootstrap did not finish; resolverHits=' + resolverHits + ' status=' + JSON.stringify(tee.status(source))));
        setTimeout(waitForBootstrap, 20);
    }

    http.get({
        host: '127.0.0.1',
        port: tee.PORT,
        path: '/s/' + encodeURIComponent(source),
        headers: { Range: 'bytes=0-0' },
    }, function (res) {
        res.resume();
        res.on('end', waitForBootstrap);
    }).on('error', finish);

    function requestVideo() {
        var req = http.get({
            host: '127.0.0.1',
            port: tee.PORT,
            path: '/s/' + encodeURIComponent(source),
            headers: { Range: 'bytes=0-1023' },
        }, function (res) {
            var chunks = [];
            res.on('data', function (chunk) { chunks.push(chunk); });
            res.on('end', function () {
                try {
                    assert.equal(res.statusCode, 206, 'expired pin should be refreshed before replying');
                    assert.deepEqual(Buffer.concat(chunks), body.slice(0, 1024));
                    assert.equal(resolverHits, 2, 'expired pin should trigger one resolver refresh');
                    console.log('PASSED expired CDN pin refreshes through the stable resolver');
                    finish();
                } catch (error) { finish(error); }
            });
        });
        req.on('error', finish);
    }
});
