// Runs the shipped WebOsVideo module with a deterministic native-video double.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const EventEmitter = require('node:events');
const source = fs.readFileSync(process.env.VIDEO_SOURCE || path.join(__dirname, '../frontend-webos/video.chunk.js'), 'utf8');
let video;
class Element {
    constructor() { this.style = {}; this.sheet = { insertRule() {} }; }
    appendChild() {} removeChild() {}
}
class Video extends Element {
    constructor() {
        super(); this.readyState = 0; this.HAVE_METADATA = 1; this.HAVE_FUTURE_DATA = 3;
        this.textTracks = []; this.buffered = { length: 0 }; this.position = 35;
        this.duration = 1800; this.paused = false; this.assignments = []; this.fail = false;
    }
    get currentTime() { return this.position; }
    set currentTime(value) {
        if (this.fail) throw new Error('native player temporarily rejects seek');
        this.position = value; this.assignments.push(value);
    }
    play() { this.paused = false; } pause() { this.paused = true; }
    load() {} removeAttribute() {}
}
const ctx = {
    self: { webpackChunkstremio_theater: [] }, HTMLElement: Element,
    document: { createElement(tag) { return tag === 'video' ? (video = new Video()) : new Element(); } },
    window: { webOS: { service: { request() {} } } },
    console: { log() {}, warn() {} }, setInterval() { return 1; }, clearInterval() {}, setTimeout() {}
};
vm.runInNewContext(source, ctx);
const moduleFactory = ctx.self.webpackChunkstremio_theater.flatMap(c => Object.entries(c[1])).find(([id]) => id === '8904')[1];
const moduleObject = { exports: {} };
const deps = { 5852: EventEmitter, 5126: x => x, 6435: x => x, 6205: {}, 4775: () => {} };
moduleFactory(moduleObject, {}, id => { assert(id in deps, 'unexpected dependency'); return deps[id]; });
const player = new moduleObject.exports({ containerElement: new Element() });
const load = () => player.dispatch({ type: 'command', commandName: 'load', commandArgs: { stream: { url: 'test://video' }, time: 5000 } });
const seek = time => player.dispatch({ type: 'setProp', propName: 'time', propValue: time });
load(); seek(90000);
assert.equal(video.currentTime, 35, 'seek waits for metadata');
video.readyState = 1; video.onloadedmetadata();
assert.equal(video.currentTime, 90, 'queued Skip wins over initial resume position');
assert.equal(video.paused, false);
console.log('PASS: early Skip is retained until metadata arrives');
video.readyState = 0; seek(120000); seek(140000); video.readyState = 1; video.oncanplay();
assert.equal(video.currentTime, 140, 'latest seek wins');
console.log('PASS: latest seek replaces an earlier pending seek');
video.fail = true; seek(180000); video.fail = false; video.onloadeddata();
assert.equal(video.currentTime, 180, 'transient exception is retried on readiness');
console.log('PASS: transient native seek exception is retried');
video.paused = true; seek(200000); assert.equal(video.currentTime, 200); assert.equal(video.paused, true);
const count = video.assignments.length; video.oncanplay();
assert.equal(video.assignments.length, count, 'completed seek is not replayed');
console.log('PASS: normal seeks preserve pause and execute once');
video.readyState = 0; seek(250000);
player.dispatch({ type: 'command', commandName: 'unload' });
load(); video.readyState = 1; video.onloadedmetadata();
assert.equal(video.currentTime, 5, 'old request cannot leak into next stream');
console.log('PASS: unloading discards pending seek');
