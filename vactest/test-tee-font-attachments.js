// Anime MKVs commonly attach both subtitle fonts and cover art. Only actual
// fonts may be passed into libass, including legacy octet-stream font entries.
var assert = require('node:assert/strict');
var fs = require('fs');
var http = require('http');
var os = require('os');
var path = require('path');
var G = require('./mkv-gen.js');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-tee-fonts-'));
var mediaPath = path.join(tmp, 'episode.mkv');
G.build({
    path: mediaPath,
    durSec: 2,
    bitrateBps: 1e6,
    events: [{ start: 0.25, end: 1.5, text: 'Dialogue', style: 'Default' }],
    attachments: [
        { name: 'Fansub Font.TTF', mime: 'application/octet-stream', data: Buffer.from('not-a-real-test-font') },
        { name: 'cover.jpg', mime: 'application/octet-stream', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
        { name: 'release-notes.xml', mime: 'application/xml', data: Buffer.from('<release/>') },
    ],
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
    process.env.ASS_TEE_PORT = String(27000 + (process.pid % 9000));
    var tee = require('../service/ass-tee');
    var source = 'http://127.0.0.1:' + cdn.address().port + '/episode.mkv';

    http.get({ host: '127.0.0.1', port: tee.PORT, path: '/s/' + encodeURIComponent(source) }, function (res) {
        res.resume();
        res.on('end', function () {
            var deadline = Date.now() + 1500;
            (function poll() {
                var status = tee.status(source);
                if (status.ready) {
                    try {
                        assert.deepEqual(status.fonts, ['Fansub Font.TTF'], 'cover art and ancillary files must not be sent to libass');
                        assert.equal(tee.fontData(source, 'Fansub Font.TTF').toString(), 'not-a-real-test-font');
                        assert.equal(tee.fontData(source, 'cover.jpg'), null);
                        console.log('PASSED tee exposes font attachments without cover art or ancillary files');
                        cleanup();
                        return cdn.close(function () { process.exit(0); });
                    } catch (error) {
                        return fail(error);
                    }
                }
                if (Date.now() >= deadline) return fail(new Error('font attachment fixture did not bootstrap'));
                setTimeout(poll, 20);
            })();
        });
    }).on('error', fail);
});
