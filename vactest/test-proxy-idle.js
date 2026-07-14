// Cause C: ass-proxy.fetchRange armed a 30s SOCKET-INACTIVITY timeout.
//
// The tee deliberately PAUSES the CDN stream while the player's buffer is full
// (backpressure). A paused socket is idle by design — but the inactivity timer
// could not tell the difference, so after 30s it destroyed a perfectly healthy
// stream. The player's response was then truncated mid-body, it reconnected with
// a Range, and the fresh demuxer resynced to the next cluster: every subtitle
// event in between was lost PERMANENTLY. Guaranteed on any pause > 30s.
//
// This test pauses a real stream for longer than the timeout and asserts the
// stream survives, delivers its full body, and calls cb exactly once.
var http = require('http');
var PX = require('../service/ass-proxy.js');

var BODY_LEN = 4 * 1024 * 1024;                 // 4MB, dribbled out
var IDLE_WAIT = 33000;                          // > the 30s timeout
var pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '  -- ' + d : '')); } }

var srv = http.createServer(function (req, res) {
    res.writeHead(200, { 'content-length': BODY_LEN, 'content-type': 'video/x-matroska' });
    var sent = 0;
    (function push() {
        if (sent >= BODY_LEN) return res.end();
        var n = Math.min(65536, BODY_LEN - sent);
        sent += n;
        if (res.write(Buffer.alloc(n, 1))) setImmediate(push);
        else res.once('drain', push);            // the consumer's pause propagates here
    })();
});

srv.listen(0, '127.0.0.1', function () {
    var url = 'http://127.0.0.1:' + srv.address().port + '/ep.mkv';
    var cbCalls = 0, got = 0, errored = null;

    console.log('ass-proxy: a deliberately PAUSED stream must survive the idle timeout\n');
    PX.fetchRange(url, null, function (err, up) {
        cbCalls++;
        if (err) { errored = err; return; }

        ok('socket-inactivity timer is DISARMED after headers (was 30000ms)',
            up.socket && up.socket.timeout === 0,
            'socket.timeout=' + (up.socket && up.socket.timeout));

        up.on('data', function (c) { got += c.length; });
        up.on('error', function (e) { errored = e; });

        // Read a little, then PAUSE for longer than the old timeout — exactly what
        // the tee's backpressure does when the player's buffer is full.
        up.pause();
        console.log('  .. paused the CDN stream for ' + (IDLE_WAIT / 1000) + 's (tee backpressure does this) ...');
        setTimeout(function () {
            ok('stream NOT destroyed while paused (no "aborted"/"proxy timeout")',
                !errored, errored && errored.message);
            up.resume();
            up.on('end', function () {
                ok('full body still delivered after the long pause', got === BODY_LEN, got + '/' + BODY_LEN);
                ok('cb called exactly once', cbCalls === 1, 'calls=' + cbCalls);
                console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' + (pass + fail) : 'PASSED ' + pass + ' passed, 0 failed'));
                srv.close();
                process.exit(fail ? 1 : 0);
            });
        }, IDLE_WAIT);
    });
});
