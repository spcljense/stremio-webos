process.env.NODE_PATH = (process.env.NODE_PATH || '') + ':/usr/lib/node_modules:/usr/lib/nodejs';
require('module').Module._initPaths();
process.env.APP_PATH = process.env.APP_PATH || __dirname;

var http = require('http');
var fs = require('fs');
var path = require('path');
var Service = require('webos-service');
var srtAss = require('./srt-ass.js');

var service = new Service('io.strem.webos.server');
var ready = false;
var pendingMessages = [];

// Keep the service alive indefinitely
service.activityManager.create('keepAlive', function() {});

// Register the start method — responds once the HTTP server is listening
service.register('start', function(message) {
    if (ready) {
        message.respond({ ready: true });
    } else {
        pendingMessages.push(message);
    }
});

// Static file serving
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
    // Reject path traversal
    var filePath = path.join(wwwDir, urlPath === '/' ? 'index.html' : urlPath);
    var normalizedWwwDir = path.resolve(wwwDir);
    var normalizedFilePath = path.resolve(filePath);

    if (normalizedFilePath !== normalizedWwwDir &&
        normalizedFilePath.indexOf(normalizedWwwDir + path.sep) !== 0) {
        return next();
    }

    fs.stat(filePath, function(err, stat) {
        if (err || !stat.isFile()) return next();

        var ext = path.extname(filePath).toLowerCase();

        // Generate a validator from file size + modification time.
        // A changed file automatically gets a new ETag.
        var etag = '"' +
            stat.size.toString(16) + '-' +
            stat.mtime.getTime().toString(16) +
            '"';

        var lastMod = stat.mtime.toUTCString();

        // index.html is the entry point, so always revalidate it.
        // Other static assets can be cached for a long time because
        // their ETag changes whenever the deployed file changes.
        var relativePath = path.relative(wwwDir, filePath);
        var isEntry = relativePath === 'index.html';

        var cacheControl = isEntry
            ? 'no-cache'
            : 'max-age=31536000';

        var inm = req.headers['if-none-match'];
        var ims = req.headers['if-modified-since'];

        if ((inm && inm === etag) ||
            (!inm && ims && ims === lastMod)) {

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

        stream.pipe(res);
    });
}

function proxyToStreaming(req, res) {
    var opts = { hostname: '127.0.0.1', port: 11470, path: req.url, method: req.method, headers: req.headers };
    var proxy = http.request(opts, function(proxyRes) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });
    proxy.on('error', function() { res.writeHead(502); res.end(); });
    req.pipe(proxy);
}

// Single server: static files first, then proxy to streaming server
http.createServer(function(req, res) {
    var urlPath = req.url.split('?')[0];

    if (urlPath === '/ext-sub') {
        var q = require('url').parse(req.url, true).query || {};
        var u = q.u;
        if (!u || !/^https?:\/\//i.test(u)) {
            res.writeHead(400);
            return res.end('');
        }

        var mod = /^https:/i.test(u) ? require('https') : require('http');
        mod.get(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' } }, function(r) {
            if (r.statusCode !== 200) {
                r.resume();
                res.writeHead(502);
                return res.end('');
            }

            var chunks = [];
            r.on('data', function(d) { chunks.push(d); });
            r.on('end', function() {
                try {
                    var txt = Buffer.concat(chunks).toString('utf8');
                    var ass = srtAss.srtToAss(txt, parseInt(q.rx, 10) || 1920, parseInt(q.ry, 10) || 1080);
                    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
                    res.end(ass);
                } catch (e) {
                    console.error('ext-sub:', e);
                    res.writeHead(500);
                    res.end('');
                }
            });
        }).on('error', function() {
            res.writeHead(502);
            res.end('');
        });

        return;
    }

    serveStatic(urlPath, req, res, function() { proxyToStreaming(req, res); });
}).listen(8080, function() {
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
        require('./server.js');
    });
});
