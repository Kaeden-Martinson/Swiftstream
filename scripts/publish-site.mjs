// Upload the website (including site/downloads from `npm run release`) to a server with SwiftSSH.
// Only changed files are sent.
//
//   npm run publish-site -- <server> [remote folder]
//
// The default remote folder is /var/www/swiftssh, the one deploy/void/install.sh --site serves
// (and makes writable by the SwiftSSH user).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(import.meta.dirname);
const [server, remote = '/var/www/swiftssh'] = process.argv.slice(2);
if (!server) {
  console.error('Usage: npm run publish-site -- <server> [remote folder]');
  process.exit(1);
}
const manifest = path.join(root, 'site', 'downloads', 'latest.json');
if (!fs.existsSync(manifest)) {
  console.error('site/downloads is empty, so the download buttons would have nothing to serve. Run "npm run release" first.');
  process.exit(1);
}
const { version, files } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
console.log(`Publishing the site with ${files.length} downloads (v${version}) to ${server}:${remote}`);
const result = spawnSync(process.execPath, [path.join(root, 'bin', 'swiftssh.js'), 'push', server, path.join(root, 'site'), remote], { stdio: 'inherit' });
process.exit(result.status ?? 1);
