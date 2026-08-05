var assert = require('node:assert/strict');
var map = require('../service/overlay/ass-track-map.js');

var tracks = [
    { index: 0, streamIndex: 2, number: 3, lang: 'eng' },
    { index: 1, streamIndex: 3, number: 4, lang: 'spa' },
];

// Current WebOsVideo IDs are positions inside the supported subtitle list.
assert.equal(map.resolve('EMBEDDED_0', tracks), 0);
assert.equal(map.resolve('EMBEDDED_1', tracks), 1);

// A restored/native ID can instead be the all-stream ffprobe index.  It must
// map to the same subtitle, not be used directly against the tee's short list.
assert.equal(map.resolve('EMBEDDED_2', tracks), 0);
assert.equal(map.resolve('EMBEDDED_3', tracks), 1);
assert.equal(map.resolve('EMBEDDED_9', tracks), -1);
assert.equal(map.resolve(null, tracks), -1);

console.log('PASSED embedded subtitle IDs map to the tee track order');
