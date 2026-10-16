import fs from 'node:fs';

/* global __SWIFTSTREAM_VERSION__ */
// Bundled builds (dist/swiftstream.cjs, swiftstream.exe) have the version inlined by scripts/build.js.
// Running from a source checkout, read it from package.json.
export const VERSION =
  typeof __SWIFTSTREAM_VERSION__ !== 'undefined'
    ? __SWIFTSTREAM_VERSION__
    : JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
