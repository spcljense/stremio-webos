var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

function deferred() {
    var resolve;
    var promise = new Promise(function (done) { resolve = done; });
    return { promise: promise, resolve: resolve };
}

function flush() {
    return new Promise(function (done) { setImmediate(done); });
}

(async function () {
    var intervals = [];
    var timeouts = [];
    var requests = [];
    var trackLoads = [deferred(), deferred()];
    var renderers = [];
    var video = {
        readyState: 1,
        currentSrc: 'http://127.0.0.1:11470/s/' + encodeURIComponent('https://cdn.example/episode.mkv'),
        currentTime: 0,
        playbackRate: 1,
        paused: true,
        isConnected: true,
        textTracks: [],
        videoWidth: 1920,
        videoHeight: 1080,
        addEventListener: function () {},
        removeEventListener: function () {},
    };

    function FakeJassub(options) {
        this.options = options;
        this._canvasParent = { remove: function () {} };
        this._demandRender = function () {};
        this._unbusy = function () {};
        renderers.push(this);
    }
    FakeJassub.prototype.addEventListener = function () {};
    FakeJassub.prototype.resize = function () {};
    FakeJassub.prototype.renderAt = function () {};
    FakeJassub.prototype.setTrack = function (content) { this.options.subContent = content; };
    FakeJassub.prototype.destroy = function () {};

    var context = {
        console: console,
        location: { hash: '#/player/episode-1' },
        localStorage: { getItem: function () { return null; }, setItem: function () {} },
        document: {
            querySelector: function (selector) { return selector === 'video' ? video : null; },
            addEventListener: function () {},
            removeEventListener: function () {},
            documentElement: {},
            body: {},
        },
        performance: { now: function () { return 1000; }, getEntriesByType: function () { return []; } },
        setInterval: function (fn, delay) { intervals.push({ fn: fn, delay: delay }); return intervals.length; },
        clearInterval: function () {},
        setTimeout: function (fn, delay) { timeouts.push({ fn: fn, delay: delay }); return timeouts.length; },
        clearTimeout: function () {},
        requestAnimationFrame: function () { return 1; },
        cancelAnimationFrame: function () {},
        fetch: function (url) {
            requests.push(url);
            if (url.indexOf('/ass/track?') === 0) {
                return Promise.resolve({
                    json: function () {
                        return Promise.resolve({
                            tracks: [
                                { index: 0, streamIndex: 2, events: 1 },
                                { index: 1, streamIndex: 3, events: 1 },
                            ],
                            fonts: [],
                            videoFps: 23.976,
                        });
                    },
                });
            }
            if (url.indexOf('/ass/tget?') === 0) {
                var match = /[?&]trk=(\d+)/.exec(url);
                return trackLoads[+match[1]].promise.then(function (content) {
                    return { ok: true, text: function () { return Promise.resolve(content); } };
                });
            }
            throw new Error('unexpected fetch ' + url);
        },
        URL: URL,
        JASSUB: FakeJassub,
        AssTrackMap: require('../service/overlay/ass-track-map.js'),
        btoa: function (value) { return Buffer.from(value, 'binary').toString('base64'); },
        unescape: unescape,
        encodeURIComponent: encodeURIComponent,
        decodeURIComponent: decodeURIComponent,
    };
    context.window = context;
    context.self = context;

    var source = fs.readFileSync(path.join(__dirname, '../service/overlay/ass-controller.js'), 'utf8');
    vm.runInNewContext(source, context, { filename: 'ass-controller.js' });

    context.__assSel = 'EMBEDDED_0';
    intervals.find(function (entry) { return entry.delay === 700; }).fn();
    await flush();
    await flush();

    assert.ok(requests.some(function (url) { return /\/ass\/tget\?.*&trk=0(?:&|$)/.test(url); }), 'track 0 load started');

    // A slow track-0 response completes after the user has selected track 1.
    // It must never become visible, even briefly.
    context.__assSel = 'EMBEDDED_1';
    trackLoads[0].resolve('[Script Info]\n' + 'x'.repeat(40) + '\nDialogue: 0,0:00:00.00,0:00:30.00,Default,,0,0,0,,TRACK ZERO');
    await flush();
    await flush();

    assert.equal(renderers.length, 0, 'superseded embedded subtitle response must not attach');

    var nextPoll = timeouts.find(function (entry) { return entry.delay === 600; });
    assert.ok(nextPoll, 'selection polling remains scheduled after the stale response');
    nextPoll.fn();
    await flush();
    await flush();
    assert.ok(requests.some(function (url) { return /\/ass\/tget\?.*&trk=1(?:&|$)/.test(url); }), 'active track is retried');

    trackLoads[1].resolve('[Script Info]\n' + 'x'.repeat(40) + '\nDialogue: 0,0:00:00.00,0:00:30.00,Default,,0,0,0,,TRACK ONE');
    await flush();
    await flush();
    assert.equal(renderers.length, 1, 'the active selection attaches after retry');
    assert.match(renderers[0].options.subContent, /TRACK ONE/, 'only the active track reaches the renderer');
    console.log('PASSED stale embedded subtitle response cannot override the active selection');
})().catch(function (error) {
    console.error(error);
    process.exit(1);
});
