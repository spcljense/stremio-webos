# Skip segments

The webOS player combines two segment sources:

1. Stremio Core's existing `introOutro` state remains the preferred source for intro and outro data.
2. The public, read-only [SkipDB API](https://skipdb.tv/docs) fills missing intro, recap, outro and preview segments for users without Stremio Premium.

No API key, account token or device identifier is embedded in the app. A lookup contains only the IMDb ID, optional season and episode numbers, and the current stream duration. The player requests data once for each episode/duration combination and silently falls back to Stremio data if the request fails.

Only exact and safely adjusted results are used. `out-of-range` matches are ignored to avoid skipping the wrong part of a release with a different duration.

## Player behavior

- Recap is yellow, intro is green, outro is coral and preview is blue.
- Each segment is drawn as a separate block on the seek bar.
- A legend shows the type and exact start/end time while player controls are visible.
- SkipDB-derived data is attributed in the player legend.
- Enter/OK skips to the segment end and hides the popup immediately.
- Down reveals and focuses the normal player controls without seeking or pausing.
- A pending seek remains protected against repeated OK presses and can be retried after the existing timeout.

SkipDB data is provided under ODbL 1.0 plus its service-provider reciprocity terms. This integration is read-only and does not create or augment a private segment database.
