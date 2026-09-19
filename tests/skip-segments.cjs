const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../frontend-webos/skip-segments.js');

const identity = api.getIdentity({
    selected: { streamRequest: { path: { id: 'tt1234567:2:9' } } },
    seriesInfo: { season: 2, episode: 9 }
});
assert.deepEqual(identity, { imdbId: 'tt1234567', season: 2, episode: 9 });
assert.deepEqual(
    api.getIdentity({ selected: { streamRequest: { path: { id: 'tt7654321:1:12' } } } }),
    { imdbId: 'tt7654321', season: 1, episode: 12 },
    'anime-style episode paths fall back to the season/episode suffix'
);
assert.deepEqual(
    api.getIdentity({ selected: { streamRequest: { path: { id: 'tt7654321:0:1' } } } }),
    { imdbId: 'tt7654321', season: 0, episode: 1 },
    'anime specials keep season zero'
);

const response = {
    segments: {
        recap: { start_ms: 0, end_ms: 40000, match: 'exact', confidence: 0.9 },
        intro: { start_ms: 40000, end_ms: 100000, match: 'shifted', confidence: 0.8 },
        outro: { start_ms: 1300000, end_ms: 1400000, match: 'exact', confidence: 0.95 },
        preview: { start_ms: 1400000, end_ms: 1450000, match: 'out-of-range', confidence: 0.5 }
    }
};
const skipDb = api.normalizeSkipDb(response);
assert.deepEqual(skipDb.map(segment => segment.type), ['intro', 'recap', 'outro']);
assert.equal(skipDb.some(segment => segment.type === 'preview'), false, 'unsafe out-of-range matches are ignored');
assert.equal(
    api.normalizeSkipDb({ segments: { outro: { start_ms: 90000, end_ms: 110000, match: 'exact' } } }, 100000)[0].to,
    100000,
    'segment ends are clamped to the current stream duration'
);

const official = api.normalizeOfficial({
    intro: { from: 45000, to: 105000 },
    outro: 1320000
}, 1450000);
const merged = api.merge(official, skipDb);
assert.equal(merged.find(segment => segment.type === 'intro').source, 'stremio');
assert.equal(merged.find(segment => segment.type === 'intro').to, 105000, 'official Stremio timing wins');
assert.equal(merged.find(segment => segment.type === 'recap').source, 'skipdb');

const url = api.buildUrl(identity, 1450123);
assert.match(url, /^https:\/\/api\.skipdb\.tv\/api\/segments\?/);
assert.match(url, /imdb_id=tt1234567/);
assert.match(url, /season=2/);
assert.match(url, /episode=9/);
assert.match(url, /duration=1450/);
assert.match(url, /adjust=conservative/);

let capturedRequest;
api.fetchSegments(identity, 1450123, (requestUrl, options) => {
    capturedRequest = { requestUrl, options };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(response) });
}).then(segments => {
    assert.equal(segments.length, 3);
    assert.equal(capturedRequest.options.method, 'GET');
    assert.equal(capturedRequest.options.headers, undefined, 'read-only SkipDB access must not embed an API key');

    const player = fs.readFileSync(path.join(__dirname, '..', 'frontend-webos', 'player.chunk.js'), 'utf8');
    assert.match(player, /skip-segment-marker/);
    assert.match(player, /skip-segment-legend-item/);
    assert.match(player, /pendingSkip/);
    assert.match(player, /event\.keyCode !== 40 && event\.keyCode !== 29461/);
    console.log('PASS: SkipDB identity, safe matching, official priority, keyless reads and UI hooks');
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
