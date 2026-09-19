(function(root, factory) {
    var api = factory(root);
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.StremioSkipSegments = api;
})(typeof window !== "undefined" ? window : null, function(root) {
    "use strict";

    var TYPES = ["recap", "intro", "outro", "preview"];
    var COLORS = {
        intro: "#2ed573",
        recap: "#f5c518",
        outro: "#ff6b6b",
        preview: "#38bdf8"
    };
    var LABELS = {
        intro: "Intro",
        recap: "Recap",
        outro: "Outro",
        preview: "Preview"
    };

    function findImdbId(value) {
        var match = typeof value === "string" ? value.match(/tt\d{5,}/i) : null;
        return match ? match[0].toLowerCase() : null;
    }

    function getIdentity(state) {
        var selected = state && state.selected;
        var pathId = selected && selected.streamRequest && selected.streamRequest.path ? selected.streamRequest.path.id : null;
        var readyMeta = state && state.metaItem ? state.metaItem.ready : null;
        var seriesInfo = state ? state.seriesInfo : null;
        var imdbId = findImdbId(pathId) ||
            findImdbId(readyMeta && readyMeta.id) ||
            findImdbId(state && state.metaItem && state.metaItem.id) ||
            findImdbId(state && state.libraryItem && state.libraryItem.state && state.libraryItem.state.video_id);
        var season = seriesInfo && Number(seriesInfo.season);
        var episode = seriesInfo && Number(seriesInfo.episode);
        var parts = typeof pathId === "string" ? pathId.split(":") : [];

        if ((!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 0) && parts.length >= 3) {
            season = Number(parts[parts.length - 2]);
            episode = Number(parts[parts.length - 1]);
        }

        return imdbId ? {
            imdbId: imdbId,
            season: Number.isInteger(season) && season >= 0 ? season : null,
            episode: Number.isInteger(episode) && episode >= 0 ? episode : null
        } : null;
    }

    function normalizeOfficial(introOutro, duration) {
        var segments = [];
        var intro = introOutro && introOutro.intro;
        var outro = introOutro && introOutro.outro;

        if (intro && Number.isFinite(intro.from) && Number.isFinite(intro.to) && intro.to > intro.from) {
            segments.push({ type: "intro", from: intro.from, to: intro.to, source: "stremio" });
        }
        if (Number.isFinite(outro) && Number.isFinite(duration) && duration > outro) {
            segments.push({ type: "outro", from: outro, to: duration, source: "stremio" });
        }
        return segments;
    }

    function normalizeSkipDb(response, duration) {
        var segments = response && response.segments ? response.segments : {};
        var normalized = [];

        ["intro", "recap", "outro", "preview"].forEach(function(type) {
            var segment = segments[type];
            if (!segment || segment.match === "out-of-range" || !Number.isFinite(segment.start_ms) ||
                !Number.isFinite(segment.end_ms) || segment.start_ms < 0) return;
            var end = Number.isFinite(duration) ? Math.min(segment.end_ms, duration) : segment.end_ms;
            if (end <= segment.start_ms) return;
            normalized.push({
                type: type,
                from: segment.start_ms,
                to: end,
                source: "skipdb",
                confidence: segment.confidence
            });
        });
        return normalized;
    }

    function merge(official, skipDb) {
        var merged = {};
        (skipDb || []).forEach(function(segment) { merged[segment.type] = segment; });
        (official || []).forEach(function(segment) { merged[segment.type] = segment; });
        return TYPES.map(function(type) { return merged[type]; })
            .filter(Boolean)
            .sort(function(left, right) { return left.from - right.from; });
    }

    function buildUrl(identity, duration) {
        var url = "https://api.skipdb.tv/api/segments?imdb_id=" + encodeURIComponent(identity.imdbId) +
            "&duration=" + Math.max(1, Math.round(duration / 1000)) + "&adjust=conservative";
        if (identity.season !== null && identity.episode !== null) {
            url += "&season=" + identity.season + "&episode=" + identity.episode;
        }
        return url;
    }

    function fetchSegments(identity, duration, fetchImpl) {
        var request = fetchImpl || (root && root.fetch ? root.fetch.bind(root) : null);
        if (!request) return Promise.reject(new Error("Fetch is unavailable"));
        return request(buildUrl(identity, duration), { method: "GET", mode: "cors" })
            .then(function(response) {
                if (!response.ok) throw new Error("SkipDB request failed: " + response.status);
                return response.json();
            })
            .then(function(response) { return normalizeSkipDb(response, duration); });
    }

    return {
        types: TYPES,
        colors: COLORS,
        labels: LABELS,
        findImdbId: findImdbId,
        getIdentity: getIdentity,
        normalizeOfficial: normalizeOfficial,
        normalizeSkipDb: normalizeSkipDb,
        merge: merge,
        buildUrl: buildUrl,
        fetchSegments: fetchSegments
    };
});
