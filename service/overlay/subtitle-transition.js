(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SubtitleTransition = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function resetSelection(root) {
        root.__assSel = null;
        root.__assActive = false;
    }

    function shouldRetryTrackProbe(supportedSubtitleCount, attempt, maxAttempts) {
        return supportedSubtitleCount === 0 && attempt < maxAttempts;
    }

    function createSelectionLatch() {
        var stream = null;
        var applied = false;

        function load(nextStream) {
            if (nextStream !== stream) {
                stream = nextStream;
                applied = false;
            }
        }

        function shouldApply() {
            return stream !== null && !applied;
        }

        function markApplied() {
            applied = true;
        }

        return {
            load: load,
            shouldApply: shouldApply,
            markApplied: markApplied
        };
    }

    return {
        resetSelection: resetSelection,
        shouldRetryTrackProbe: shouldRetryTrackProbe,
        createSelectionLatch: createSelectionLatch
    };
}));
