var assert = require('node:assert/strict');
var ProbeSession = require('../service/overlay/stream-probe-session.js');

var session = ProbeSession.create();
session.load('episode-1');
var episodeOne = session.start('episode-1');
assert.ok(episodeOne, 'first episode starts one probe');
assert.equal(session.start('episode-1'), null, 'same stream cannot start duplicate probes');

session.load('episode-2');
var episodeTwo = session.start('episode-2');
assert.ok(episodeTwo, 'new stream resets the probe latch');
assert.equal(session.isCurrent(episodeOne), false, 'late episode-1 callbacks are invalidated');
assert.equal(session.isCurrent(episodeTwo), true, 'episode-2 callback remains current');

session.unload();
assert.equal(session.isCurrent(episodeTwo), false, 'unload invalidates in-flight callbacks');
assert.equal(session.start('episode-2'), null, 'unloaded sessions cannot start probes');

session.load('episode-2');
var replay = session.start('episode-2');
assert.ok(replay, 'reloading the same URL still creates a fresh lifecycle generation');
assert.notEqual(replay.generation, episodeTwo.generation);

console.log('PASSED stream probe lifecycle resets per episode and rejects stale callbacks');
