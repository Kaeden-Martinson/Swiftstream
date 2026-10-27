import nodeFs from 'node:fs';
import { createRequire } from 'node:module';

// Files on this computer, as they are on disk. Inside Electron (the desktop app), node:fs opens any
// file ending in .asar as if it were a folder (that's how Electron reads its own packaged code), so
// uploading an Electron app's build folder failed on resources/app.asar. Electron keeps the plain
// file functions as "original-fs"; everywhere else node:fs is already plain. (Only Electron runs the
// require: in the single-file server bundle import.meta.url is empty and createRequire would throw.)
export const fs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs;
export const fsp = fs.promises;
