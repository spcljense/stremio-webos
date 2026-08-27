var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

function flush() { return new Promise(function (done) { setImmediate(done); }); }

(async function () {
    var intervals = [];
    var timeouts = [];
    var requests = [];
    var hash = '0123456789abcdef0123456789abcdef01234567';
    var episodeOneUrl = 'https://debrid.example/resolve/web/token/' + hash + '/' + encodeURIComponent('[SubsPlease] Show - 01.mkv');
    var episodeTwoUrl = 'https://debrid.example/resolve/web/token/' + hash + '/' + encodeURIComponent('[SubsPlease] Show - 02.mkv');
    var video = {
        readyState: 1,
        currentSrc: 'http://127.0.0.1:11474/s/' + encodeURIComponent(episodeOneUrl),
        currentTime: 0,
        isConnected: true,
        textTracks: [],
        addEventListener: function () {},
        removeEventListener: function () {},
    };
    var context = {
        console: console,
        location: { hash: '#/player/blob/stream/x/series/anime/kitsu%3A100%3A1' },
        localStorage: { getItem: function () { return null; }, setItem: function () {} },
        document: {
            querySelector: function (selector) { return selector === 'video' ? video : null; },
            addEventListener: function () {}, removeEventListener: function () {}, documentElement: {}, body: {},
        },
        performance: { now: function () { return 0; }, getEntriesByType: function () { return []; } },
        setInterval: function (fn, delay) { intervals.push({ fn: fn, delay: delay }); return intervals.length; },
        clearInterval: function () {},
        setTimeout: function (fn, delay) { timeouts.push({ fn: fn, delay: delay }); return timeouts.length; },
        clearTimeout: function () {},
        requestAnimationFrame: function () { return 1; }, cancelAnimationFrame: function () {},
        fetch: function (url) {
            requests.push(url);
            if (url.indexOf('/ass/track?') === 0) return Promise.resolve({ json: function () { return Promise.resolve({ tracks: [] }); } });
            if (url.indexOf('/next-episodes?') === 0) return Promise.resolve({ json: function () { return Promise.resolve({ next: ['kitsu:100:2'] }); } });
            if (url.indexOf('/anime-streams?') === 0) return Promise.resolve({ json: function () { return Promise.resolve({ streams: [{ url: episodeTwoUrl, name: 'Nyaa', title: '[SubsPlease] Show - 02' }] }); } });
            if (url.indexOf('/ass/prepare?') === 0) return Promise.resolve({});
            throw new Error('unexpected fetch ' + url);
        },
        URL: URL,
        btoa: function (value) { return Buffer.from(value, 'binary').toString('base64'); },
        unescape: unescape, encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    };
    context.window = context;
    context.self = context;

    var source = fs.readFileSync(path.join(__dirname, '../service/overlay/ass-controller.js'), 'utf8');
    vm.runInNewContext(source, context, { filename: 'ass-controller.js' });
    intervals.find(function (entry) { return entry.delay === 700; }).fn();

    var prefetch = timeouts.find(function (entry) { return entry.delay === 30000; });
    assert.ok(prefetch, 'tee playback schedules same-release-group prefetch');
    prefetch.fn();
    await flush(); await flush(); await flush();

    assert.equal(context.__assBinge.streams['kitsu:100:2'].url, episodeTwoUrl, 'episode 2 is locked to the same torrent hash');
    assert.equal(requests.some(function (url) { return url.indexOf('/ass/prepare?') === 0; }), false, 'tee prefetch does not start a duplicate subtitle extraction');
    assert.ok(context.__assBinge.lockHash('kitsu:100:2'), 'binge lock can consume the prefetched stream');
    console.log('PASSED tee playback prefetches the same release group for binge rollover');
})().catch(function (error) {
    console.error(error);
    process.exit(1);
});
