// The subtitle bootstrap and the video response need the same resolved CDN URL.
// They must not race two calls through a slow serverless /resolve endpoint.
var assert = require('node:assert/strict');
var http = require('http');

var resolverHits = 0;
var cdnHits = 0;
var body = Buffer.alloc(1024, 1);

var upstream = http.createServer(function (req, res) {
    if (req.url === '/resolve/video') {
        resolverHits++;
        return setTimeout(function () {
            res.writeHead(302, { location: '/cdn/video.mkv' });
            res.end();
        }, 100);
    }
    if (req.url === '/cdn/video.mkv') {
        cdnHits++;
        res.writeHead(206, {
            'content-length': body.length,
            'content-range': 'bytes 0-1023/1024',
            'accept-ranges': 'bytes',
            'content-type': 'video/x-matroska',
        });
        return res.end(body);
    }
    res.writeHead(404);
    res.end();
});

function fail(error) {
    console.error(error && error.stack || error);
    upstream.close(function () { process.exit(1); });
}

upstream.listen(0, '127.0.0.1', function () {
    var teePort = 22000 + (process.pid % 10000);
    process.env.ASS_TEE_PORT = String(teePort);
    var tee = require('../service/ass-tee');
    var source = 'http://127.0.0.1:' + upstream.address().port + '/resolve/video';
    var path = '/s/' + encodeURIComponent(source);

    setTimeout(function () {
        var req = http.get({
            host: '127.0.0.1',
            port: tee.PORT,
            path: path,
            headers: { Range: 'bytes=0-1023' },
        }, function (res) {
            var received = 0;
            res.on('data', function (chunk) { received += chunk.length; });
            res.on('end', function () {
                try {
                    assert.equal(res.statusCode, 206);
                    assert.equal(received, body.length);
                    assert.equal(resolverHits, 1, 'bootstrap and player raced separate resolver calls');
                    assert.equal(cdnHits, 2, 'bootstrap and player should independently range-read the pinned CDN');
                    console.log('PASSED tee resolves once, then shares the pinned CDN URL');
                    upstream.close(function () { process.exit(0); });
                } catch (error) {
                    fail(error);
                }
            });
        });
        req.on('error', fail);
    }, 50);
});
