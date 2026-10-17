import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { UserError } from './errors.js';

// `swiftstream app` opens the desktop app. The swiftstream.exe installed with the app finds it next to
// itself; an npm install looks where Windows recorded the install, then in the usual places.

const DOWNLOAD_URL = 'https://github.com/Kaeden-Martinson/Swiftstream#readme';

/** Install folders recorded by Windows for "Swiftstream" (per-user first, then per-machine). */
function registeredInstallDirs() {
  const dirs = [];
  for (const root of ['HKCU', 'HKLM']) {
    const r = spawnSync('reg', ['query', `${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/f', 'Swiftstream', '/d'], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !r.stdout) continue;
    // Each matching key is followed by its values; InstallLocation is the folder.
    for (const block of r.stdout.split(/\r?\n(?=HKEY_)/)) {
      if (!/DisplayName\s+REG_SZ\s+Swiftstream\b/i.test(block)) continue;
      const loc = block.match(/InstallLocation\s+REG_\w+\s+(.+)/i)?.[1]?.trim();
      if (loc) dirs.push(loc);
    }
  }
  return dirs;
}

/** Path of the installed desktop app, or null. */
export function findDesktopApp() {
  if (process.platform === 'win32') {
    const dirs = [
      // swiftstream.exe installed with the app lives in the app's resources/cli folder.
      path.join(path.dirname(process.execPath), '..', '..'),
      ...registeredInstallDirs(),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Swiftstream'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Swiftstream'),
    ].filter(Boolean);
    for (const dir of dirs) {
      const exe = path.join(dir, 'Swiftstream.exe');
      if (fs.existsSync(exe)) return exe;
    }
    return null;
  }
  if (process.platform === 'darwin') {
    for (const app of ['/Applications/Swiftstream.app', path.join(os.homedir(), 'Applications', 'Swiftstream.app')]) if (fs.existsSync(app)) return app;
    return null;
  }
  const r = spawnSync('sh', ['-c', 'command -v swiftstream-desktop'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Start the desktop app without tying it to this terminal. */
export function openDesktopApp() {
  const target = findDesktopApp();
  if (!target) {
    throw new UserError("The Swiftstream desktop app isn't installed on this computer.", `Download it from ${DOWNLOAD_URL}, then run "swiftstream app" again.`);
  }
  // If this terminal has ELECTRON_RUN_AS_NODE set, the app would start as plain Node instead.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const [file, args] = process.platform === 'darwin' ? ['open', ['-a', target]] : [target, []];
  const child = spawn(file, args, { detached: true, stdio: 'ignore', env, windowsHide: false });
  child.on('error', () => {});
  child.unref();
  return target;
}
