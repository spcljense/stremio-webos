(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.StreamProbeSession = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function create() {
        var generation = 0;
        var activeUrl = null;
        var probeStarted = false;

        function load(url) {
            generation++;
            activeUrl = typeof url === 'string' ? url : null;
            probeStarted = false;
        }

        function unload() {
            generation++;
            activeUrl = null;
            probeStarted = false;
        }

        function start(url) {
            if (!activeUrl || url !== activeUrl || probeStarted) return null;
            probeStarted = true;
            return { generation: generation, url: activeUrl };
        }

        function isCurrent(token) {
            return !!token && token.generation === generation && token.url === activeUrl;
        }

        return { load: load, unload: unload, start: start, isCurrent: isCurrent };
    }

    return { create: create };
}));
