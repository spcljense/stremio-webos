var zlib = require('zlib');
process.env.NODE_PATH = (process.env.NODE_PATH || '') + ':/usr/lib/node_modules:/usr/lib/nodejs';
require('module').Module._initPaths();
process.env.APP_PATH = process.env.APP_PATH || __dirname;

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var url = require('url');
var Service = require('webos-service');
var srtAss = require('./srt-ass.js');

// Dedicated Agent with Keep-Alive to minimize local loopback socket churn
var proxyAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 64,
    keepAliveMsecs: 30000
});

var service = new Service('io.strem.webos.server');
var ready = false;
var streamingReady = false;
var pendingMessages = [];

// Keep the service alive indefinitely on webOS
service.activityManager.create('keepAlive', function() {});

// Register the start method — responds once the HTTP server is listening
service.register('start', function(message) {
    if (ready) {
        message.respond({ ready: true });
    } else {
        pendingMessages.push(message);
    }
});

// Static file serving configuration
var wwwDir = path.join(__dirname, 'www');
var mimeTypes = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon', '.gif': 'image/gif', '.webp': 'image/webp',
    '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.json': 'application/json',
    '.map': 'application/json', '.txt': 'text/plain', '.mp3': 'audio/mpeg'
};

function serveStatic(urlPath, req, res, next) {
    var filePath = path.join(wwwDir, urlPath === '/' ? 'index.html' : urlPath);
    var normalizedWwwDir = path.resolve(wwwDir);
    var normalizedFilePath = path.resolve(filePath);

    // Reject path traversal
    if (normalizedFilePath !== normalizedWwwDir &&
        normalizedFilePath.indexOf(normalizedWwwDir + path.sep) !== 0) {
        return next();
    }

    fs.stat(filePath, function(err, stat) {
        if (err || !stat.isFile()) return next();

        var ext = path.extname(filePath).toLowerCase();
        var etag = '"' + stat.size.toString(16) + '-' + stat.mtime.getTime().toString(16) + '"';
        var lastMod = stat.mtime.toUTCString();
        var isEntry = path.relative(wwwDir, filePath) === 'index.html';
        var cacheControl = isEntry ? 'no-cache' : 'max-age=31536000';

        var inm = req.headers['if-none-match'];
        var ims = req.headers['if-modified-since'];

        if ((inm && inm === etag) || (!inm && ims && ims === lastMod)) {
            res.writeHead(304, {
                'ETag': etag,
                'Last-Modified': lastMod,
                'Cache-Control': cacheControl
            });
            return res.end();
        }

        res.writeHead(200, {
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'ETag': etag,
            'Last-Modified': lastMod,
            'Cache-Control': cacheControl
        });

        if (req.method === 'HEAD') {
            return res.end();
        }

        var stream = fs.createReadStream(filePath);

        stream.on('error', function() {
            try { res.end(); } catch (_) {}
        });

        // Abort reading file from disk if client closes connection early
        res.on('close', function() {
            stream.destroy();
        });

        stream.pipe(res);
    });
}

// Proxies video/API traffic to 127.0.0.1:11470 with backpressure & abort handling
function proxyToStreaming(req, res, retryCount) {
    retryCount = retryCount || 0;

    var forwardHeaders = {};
    for (var key in req.headers) {
        if (Object.prototype.hasOwnProperty.call(req.headers, key)) {
            forwardHeaders[key] = req.headers[key];
        }
    }
    forwardHeaders.host = '127.0.0.1:11470';

    var opts = {
        hostname: '127.0.0.1',
        port: 11470,
        path: req.url,
        method: req.method,
        headers: forwardHeaders,
        agent: proxyAgent
    };

    var proxyReq = http.request(opts, function(proxyRes) {
        streamingReady = true;
        try { proxyReq.setTimeout(0); } catch (e) {}
        try { if (proxyRes.socket) proxyRes.socket.setTimeout(0); } catch (e) {}

        if (!res.headersSent) {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
        }

        proxyRes.pipe(res);

        // PREVENT OOM: If TV pauses/seeks/exits, kill the upstream video stream immediately
        res.on('close', function() {
            proxyRes.destroy();
            proxyReq.abort();
        });
    });

    // Abort upstream connection if incoming request terminates
    req.on('close', function() {
        proxyReq.abort();
    });

    proxyReq.on('error', function(err) {
        // Startup grace period: retry initial GET/HEAD requests while server.js boots
        if (err.code === 'ECONNREFUSED' && !streamingReady && retryCount < 10 && (req.method === 'GET' || req.method === 'HEAD')) {
            setTimeout(function() {
                proxyToStreaming(req, res, retryCount + 1);
            }, 250);
            return;
        }

        // Prevent ERR_HTTP_HEADERS_SENT process crash
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
        }
        res.end('Streaming server unavailable');
    });

    req.pipe(proxyReq);
}

// Subtitle Proxy: handles redirects, memory caps, and timeouts
function handleExtSub(req, res) {
    var q = url.parse(req.url, true).query || {};
    var u = q.u;

    if (!u || !/^https?:\/\//i.test(u)) {
        res.writeHead(400);
        return res.end('Invalid subtitle URL');
    }

    function fetchSub(targetUrl, redirectsRemaining) {
        if (redirectsRemaining <= 0) {
            res.writeHead(502);
            return res.end('Too many redirects');
        }

        var parsed = url.parse(targetUrl);
        var client = parsed.protocol === 'https:' ? https : http;

        var subReq = client.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (SmartTV; webOS)', 'Accept': '*/*' },
            timeout: 10000
        }, function(r) {
            // Follow 301, 302, 307, 308 redirects from subtitle CDNs
            if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
                r.resume();
                var redirectUrl = url.resolve(targetUrl, r.headers.location);
                return fetchSub(redirectUrl, redirectsRemaining - 1);
            }

            // Sickerine pause immunity: disarm connect timeout once headers arrive
            try { subReq.setTimeout(0); } catch (e) {}
            try { if (r.socket) r.socket.setTimeout(0); } catch (e) {}

            if (r.statusCode !== 200) {
                r.resume();
                res.writeHead(502);
                return res.end('');
            }

            var encoding = (r.headers["content-encoding"] || "").toLowerCase();
            var stream = r;
            if (encoding === "gzip") {
                stream = r.pipe(zlib.createGunzip());
            } else if (encoding === "deflate") {
                stream = r.pipe(zlib.createInflate());
            }

            var chunks = [];
            var totalBytes = 0;
            var MAX_BYTES = 5 * 1024 * 1024;

            stream.on("data", function(d) {
                totalBytes += d.length;
                if (totalBytes > MAX_BYTES) {
                    stream.destroy();
                    res.writeHead(413);
                    return res.end("Subtitle exceeds size limit");
                }
                chunks.push(d);
            });

            stream.on("end", function() {
                try {
                    var txt = Buffer.concat(chunks).toString('utf8');
                    var ass = srtAss.srtToAss(txt, parseInt(q.rx, 10) || 1920, parseInt(q.ry, 10) || 1080);
                    res.writeHead(200, {
                        'Content-Type': 'text/plain; charset=utf-8',
                        'Cache-Control': 'public, max-age=3600'
                    });
                    res.end(ass);
                } catch (e) {
                    console.error('ext-sub error:', e);
                    res.writeHead(500);
                    res.end('');
                }
            });
        });

        subReq.on('timeout', function() {
            subReq.abort();
            res.writeHead(504);
            res.end('Subtitle request timed out');
        });

        subReq.on('error', function() {
            res.writeHead(502);
            res.end('');
        });
    }

    fetchSub(u, 5);
}

// Single server: static files first, then proxy to streaming server
var server = http.createServer(function(req, res) {
    var urlPath = req.url.split('?')[0];

    if (urlPath === '/ext-sub') {
        return handleExtSub(req, res);
    }

    serveStatic(urlPath, req, res, function() {
        proxyToStreaming(req, res);
    });
});

server.listen(8080, function() {
    ready = true;

    // Respond immediately so the UI can start loading without waiting
    // for the Stremio streaming server to initialize.
    pendingMessages.forEach(function(msg) { msg.respond({ ready: true }); });
    pendingMessages = [];

    // Point the streaming server at the bundled ffmpeg binaries.
    process.env.FFMPEG_BIN = path.join(__dirname, 'bin', 'ffmpeg');
    process.env.FFPROBE_BIN = path.join(__dirname, 'bin', 'ffprobe');

    // Defer loading the large Stremio streaming server until the UI
    // server has started and the ready response has been sent.
    setImmediate(function() {
        try {
            require('./server.js');
        } catch (e) {
            console.error('Failed to load Stremio server.js:', e);
        }
    });
});

// Clean shutdown handler to free port 8080 on service stop/restart
process.on('SIGTERM', function() {
    try { server.close(); } catch (_) {}
    process.exit(0);
});