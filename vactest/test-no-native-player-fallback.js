"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const chunks = ["video.chunk.js", "1477.chunk.js"].map((name) => ({
  name,
  source: fs.readFileSync(path.join(__dirname, "..", "service", "www", name), "utf8"),
}));

for (const { name, source } of chunks) {
  assert.doesNotMatch(
    source,
    /com\.webos\.app\.(?:photovideo|smartshare|mediadiscovery)/,
    `${name} still launches an external LG media app`,
  );
  assert.match(source, /MEDIA_ERR_DECODE/, `${name} no longer reports decode errors`);
  assert.match(
    source,
    /MEDIA_ERR_SRC_NOT_SUPPORTED/,
    `${name} no longer reports unsupported-source errors`,
  );
}

console.log("PASSED media failures remain inside Stremio");
