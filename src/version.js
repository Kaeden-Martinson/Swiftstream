import fs from 'node:fs';

/* global __SWIFTSSH_VERSION__ */
// Bundled builds (dist/swiftssh.cjs, swiftssh.exe) have the version inlined by scripts/build.js.
// Running from a source checkout, read it from package.json.
export const VERSION =
  typeof __SWIFTSSH_VERSION__ !== 'undefined'
    ? __SWIFTSSH_VERSION__
    : JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
