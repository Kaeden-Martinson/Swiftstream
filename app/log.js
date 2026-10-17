// The app's log: one file in ~/.swiftstream/logs, swapped to swiftstream.old.log at 1 MB (so it never
// grows past about 2 MB). It records what helps with a bug report: startup, errors, transfers, server
// health and crashes. Never passwords, passphrases or keys: callers pass messages, not credentials.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;

export function createLog(dirFn) {
  let file = null;
  const target = () => {
    if (!file) {
      const dir = dirFn();
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, 'swiftstream.log');
    }
    return file;
  };

  const write = (level, message, details) => {
    try {
      const f = target();
      if ((fs.statSync(f, { throwIfNoEntry: false })?.size || 0) > MAX_BYTES) fs.renameSync(f, f.replace(/\.log$/, '.old.log'));
      const extra = details === undefined ? '' : ` ${typeof details === 'string' ? details : JSON.stringify(details)}`;
      fs.appendFileSync(f, `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${extra}\n`);
    } catch {
      /* logging must never break the app */
    }
  };

  return {
    info: (message, details) => write('info', message, details),
    warn: (message, details) => write('warn', message, details),
    error: (message, details) => write('error', message, details),
    dir: () => path.dirname(target()),
    /** The last `lines` lines, oldest first (from the previous file too when this one is short). */
    tail(lines = 200) {
      try {
        const f = target();
        const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);
        const all = [...read(f.replace(/\.log$/, '.old.log')), ...read(f)];
        return all.slice(-lines);
      } catch {
        return [];
      }
    },
  };
}
