import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './errors.js';

// swiftstream runs three ways: from a source checkout (node bin/swiftstream.js), as a single-file
// bundle (node swiftstream.cjs, which is what gets uploaded to servers), or as a standalone
// executable (swiftstream.exe). These helpers hide the difference.

const sea = process.getBuiltinModule?.('node:sea');

export function isStandaloneExe() {
  try {
    return !!sea?.isSea();
  } catch {
    return false;
  }
}

/** The command that runs this same swiftstream again, e.g. to start the background server. */
export function selfCommand() {
  return isStandaloneExe() ? [process.execPath] : [process.execPath, path.resolve(process.argv[1])];
}

/**
 * The single-file server bundle to upload to a server. Looked up, in order: a path given by the
 * caller (the desktop app), SWIFTSTREAM_BUNDLE, the copy embedded in swiftstream.exe, this process's own
 * file when it is the bundle, and dist/ in a source checkout.
 */
export function loadServerBundle(explicitPath) {
  const candidates = [explicitPath, process.env.SWIFTSTREAM_BUNDLE];
  if (isStandaloneExe()) return Buffer.from(sea.getAsset('swiftstream.cjs'));
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  if (entry.endsWith('.cjs')) candidates.push(entry);
  if (entry) candidates.push(path.join(path.dirname(entry), '..', 'dist', 'swiftstream.cjs'));
  for (const file of candidates) {
    if (file && fs.existsSync(file)) return fs.readFileSync(file);
  }
  throw new UserError("The server bundle hasn't been built yet.", 'Run "npm run build" in the swiftstream folder, then try again.');
}
