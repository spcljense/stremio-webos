(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.AssTrackMap = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function resolve(selection, tracks) {
        var match = typeof selection === 'string' && /^EMBEDDED_(\d+)$/.exec(selection);
        if (!match || !Array.isArray(tracks)) return -1;
        var id = +match[1];

        // WebOsVideo's public contract numbers supported subtitle tracks from
        // zero. Prefer that canonical meaning whenever the value is in range.
        if (id >= 0 && id < tracks.length) return id;

        // Older/restored native selections can contain the ffprobe stream index
        // (video/audio included). Translate that identity to the tee's compact
        // subtitle-only order.
        for (var i = 0; i < tracks.length; i++) {
            if (+tracks[i].streamIndex === id) return tracks[i].index == null ? i : +tracks[i].index;
        }
        return -1;
    }

    return { resolve: resolve };
}));
