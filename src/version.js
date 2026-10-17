import fs from 'node:fs';

/* global __SWIFTSTREAM_VERSION__ */
// Bundled builds (dist/swiftstream.cjs, swiftstream.exe) have the version inlined by scripts/build.js.
// Running from a source checkout, read it from package.json.
export const VERSION =
  typeof __SWIFTSTREAM_VERSION__ !== 'undefined'
    ? __SWIFTSTREAM_VERSION__
    : JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** True when version a (like "0.1.0") is older than b. Pre-release tags are ignored. */
export function isOlderVersion(a, b) {
  const parts = (v) => String(v).split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}
