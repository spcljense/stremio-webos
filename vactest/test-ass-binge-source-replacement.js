var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

var intervals = [];
var sourceOne = 'https://cdn.example/episode-1.mkv';
var sourceTwo = 'https://cdn.example/episode-2.mkv';
var video = {
    readyState: 1,
    currentSrc: 'http://127.0.0.1:11470/s/' + encodeURIComponent(sourceOne),
    currentTime: 0,
    isConnected: true,
    textTracks: [],
    addEventListener: function () {},
    removeEventListener: function () {},
};

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
    performance: { now: function () { return 0; }, getEntriesByType: function () { return []; } },
    setInterval: function (fn, delay) { intervals.push({ fn: fn, delay: delay }); return intervals.length; },
    clearInterval: function () {},
    setTimeout: function () { return 1; },
    clearTimeout: function () {},
    requestAnimationFrame: function () { return 1; },
    cancelAnimationFrame: function () {},
    fetch: function () { return new Promise(function () {}); },
    URL: URL,
    btoa: function (value) { return Buffer.from(value, 'binary').toString('base64'); },
    unescape: unescape,
    encodeURIComponent: encodeURIComponent,
    decodeURIComponent: decodeURIComponent,
};
context.window = context;
context.self = context;

var source = fs.readFileSync(path.join(__dirname, '../service/overlay/ass-controller.js'), 'utf8');
vm.runInNewContext(source, context, { filename: 'ass-controller.js' });

var lifecycle = intervals.find(function (entry) { return entry.delay === 700; }).fn;
lifecycle();
var firstController = context.__assCtl;
assert.ok(firstController, 'episode 1 controller started');
lifecycle();
assert.equal(context.__assCtl, firstController, 'stable source does not churn controllers');

// WebOsVideo may retain its media node and only replace the source on next-up.
video.currentSrc = '';
lifecycle();
assert.equal(context.__assCtl, firstController, 'temporary source clearing waits for the replacement identity');
video.currentSrc = 'http://127.0.0.1:11470/s/' + encodeURIComponent(sourceTwo);
context.location.hash = '#/player/episode-2';
lifecycle();

assert.notEqual(context.__assCtl, firstController, 'source replacement creates a fresh controller');
assert.equal(context.__assCtl.video, video, 'fresh controller may own the reused video element');
console.log('PASSED subtitle controller follows binge source replacement');
