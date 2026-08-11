var assert = require('node:assert/strict');
var SubtitleTransition = require('../service/overlay/subtitle-transition.js');

var root = { __assSel: 'EMBEDDED_2', __assActive: true };
SubtitleTransition.resetSelection(root);
assert.equal(root.__assSel, null, 'a new stream clears the previous embedded-track ordinal');
assert.equal(root.__assActive, false, 'a new stream detaches the previous ASS selection');

assert.equal(
    SubtitleTransition.shouldRetryTrackProbe(0, 1, 15),
    true,
    'an audio-only probe is not proof that subtitle discovery has finished'
);
assert.equal(
    SubtitleTransition.shouldRetryTrackProbe(1, 1, 15),
    false,
    'discovery stops as soon as a supported subtitle is available'
);
assert.equal(
    SubtitleTransition.shouldRetryTrackProbe(0, 15, 15),
    false,
    'discovery remains bounded for files with no supported subtitles'
);

var selection = SubtitleTransition.createSelectionLatch();
var toonshub = { url: 'toonshub' };
selection.load(toonshub);
assert.equal(selection.shouldApply(), true, 'episode stream may apply the preferred language');
selection.markApplied();
selection.load(toonshub);
assert.equal(selection.shouldApply(), false, 'same stream does not override a manual language choice');
selection.load({ url: 'feibanyama-4k' });
assert.equal(selection.shouldApply(), true, 'new stream reapplies language by meaning, not the old ordinal');
selection.markApplied();
selection.load({ url: 'anime-time' });
assert.equal(selection.shouldApply(), true, 'every stream transition gets one fresh language selection');

console.log('PASSED subtitle menu and preferred-language state reset per stream');
