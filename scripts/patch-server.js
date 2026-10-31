#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, '..', 'service', 'server.js');
const source = fs.readFileSync(target, 'utf8');

// Patch only the HTTP/HTTPS remote-stream Readable constructor (M). The
// local-file Readable constructor (N) intentionally keeps its default buffer.
const original = 'M=(function(e){c(r,e);var n=b(r);function r(e){var i;u(this,r),i=n.call(this),';
const patched = 'M=(function(e){c(r,e);var n=b(r);function r(e){var i;u(this,r),i=n.call(this,{highWaterMark:1048576}),';
const count = source.split(original).length - 1;
const alreadyPatched = source.split(patched).length - 1;

if (alreadyPatched === 1 && count === 0) {
    if (!source.includes('maxBytesLimit:26214400')) {
        throw new Error('Unexpected server bundle: maxBytesLimit guard was not found.');
    }
    console.log('Stremio server remote-stream buffer patch already applied.');
    process.exit(0);
}

if (count !== 1 || alreadyPatched !== 0) {
    throw new Error('Unexpected Stremio server bundle: expected exactly one unpatched remote-stream constructor; found ' + count + ' (already patched: ' + alreadyPatched + ').');
}
if (!source.includes('maxBytesLimit:26214400')) {
    throw new Error('Unexpected Stremio server bundle: maxBytesLimit guard was not found; refusing to patch.');
}

const output = source.replace(original, patched);
if (output === source || output.split(patched).length - 1 !== 1) {
    throw new Error('Stremio server patch verification failed.');
}

fs.writeFileSync(target, output, 'utf8');
console.log('Patched remote HTTP/HTTPS stream buffer to 1 MiB; maxBytesLimit remains unchanged.');
