var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

var lifecycleIntervals = [];
var pendingTimeouts = [];
var video = makeVideo();

function makeVideo() {
    return {
        readyState: 1,
        currentSrc: '',
        isConnected: true,
        textTracks: [],
        addEventListener: function () {},
        removeEventListener: function () {},
    };
}

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
    setInterval: function (fn) { lifecycleIntervals.push(fn); return lifecycleIntervals.length; },
    clearInterval: function () {},
    setTimeout: function (fn) { pendingTimeouts.push(fn); return pendingTimeouts.length; },
    clearTimeout: function () {},
    requestAnimationFrame: function () { return 1; },
    cancelAnimationFrame: function () {},
    fetch: function () { throw new Error('unexpected fetch'); },
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

var lifecycle = lifecycleIntervals[lifecycleIntervals.length - 1];
lifecycle();
var firstController = context.__assCtl;
assert.equal(firstController.video, video, 'first episode owns its video element');
var oldCanvasRemoved = false;
firstController.jassub = {
    _canvasParent: { remove: function () { oldCanvasRemoved = true; } },
    destroy: function () {},
};

var firstVideo = video;
firstVideo.isConnected = false;
video = makeVideo();
context.location.hash = '#/player/episode-2';
lifecycle();

assert.equal(firstController.jassub, null, 'old controller is detached');
assert.equal(oldCanvasRemoved, true, 'detached episode canvas is removed explicitly');
assert.notEqual(context.__assCtl, firstController, 'binge rollover creates a fresh controller');
assert.equal(context.__assCtl.video, video, 'fresh controller owns episode 2 video');

console.log('PASSED subtitle controller follows binge video replacement');
