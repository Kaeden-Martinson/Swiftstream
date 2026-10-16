import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { push, pushDir } from './transfer.js';
import { formatBytes } from './util.js';

const REMOTE_DIR = '.swiftstream-bench';

function ssh(host, args, { cmd = 'ssh' } = {}) {
  const portFlag = cmd === 'scp' ? '-P' : '-p';
  const full = [...(host.sshPort ? [portFlag, String(host.sshPort)] : []), ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, full, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

async function timed(fn) {
  const start = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - start) / 1e9;
}

/**
 * Upload the same data with scp (SFTP protocol on OpenSSH 9+) and with swiftstream,
 * once as one big file and once as many small files, and compare wall-clock time.
 */
export async function bench(client, host, { size, files, parallel, chunkSize }) {
  if (!host.ssh) throw new Error('bench compares against scp, so the host needs an ssh target (hosts added with "swiftstream deploy" have one)');
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftstream-bench-'));
  const quiet = { parallel, chunkSize, meter: { add() {}, finish() {}, stop() {} } };
  try {
    const big = path.join(local, 'big.bin');
    fs.writeFileSync(big, crypto.randomBytes(size));
    const smallDir = path.join(local, 'small');
    fs.mkdirSync(smallDir);
    for (let i = 0; i < files; i++) {
      fs.writeFileSync(path.join(smallDir, `f${String(i).padStart(5, '0')}.txt`), crypto.randomBytes(2048 + (i % 7) * 1024));
    }
    const smallBytes = fs.readdirSync(smallDir).reduce((s, f) => s + fs.statSync(path.join(smallDir, f)).size, 0);

    process.stderr.write(`benchmarking against ${host.ssh} (${formatBytes(size)} file, ${files} small files)...\n`);
    await ssh(host, [host.ssh, `rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR}`]);

    const rows = [];
    const row = (label, bytes, scpSecs, swiftSecs) => rows.push({ label, bytes, scpSecs, swiftSecs });

    row('1 large file', size,
      await timed(() => ssh(host, ['-q', big, `${host.ssh}:${REMOTE_DIR}/scp-big.bin`], { cmd: 'scp' })),
      await timed(() => push(client, big, `~/${REMOTE_DIR}/swift-big.bin`, quiet)));
    row(`${files} small files`, smallBytes,
      await timed(() => ssh(host, ['-q', '-r', smallDir, `${host.ssh}:${REMOTE_DIR}/scp-small`], { cmd: 'scp' })),
      await timed(() => pushDir(client, smallDir, `~/${REMOTE_DIR}/swift-small`, quiet)));

    await ssh(host, [host.ssh, `rm -rf ${REMOTE_DIR}`]).catch(() => {});
    return rows;
  } finally {
    fs.rmSync(local, { recursive: true, force: true });
  }
}

export function formatBench(rows) {
  const rate = (bytes, secs) => `${formatBytes(bytes / secs)}/s`;
  const lines = [['test', 'scp/sftp', 'swiftstream', 'speedup']];
  for (const r of rows) {
    lines.push([
      r.label,
      `${r.scpSecs.toFixed(2)}s (${rate(r.bytes, r.scpSecs)})`,
      `${r.swiftSecs.toFixed(2)}s (${rate(r.bytes, r.swiftSecs)})`,
      `${(r.scpSecs / r.swiftSecs).toFixed(1)}x`,
    ]);
  }
  const widths = lines[0].map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  return lines.map((l) => l.map((c, i) => c.padEnd(widths[i])).join('  ')).join('\n');
}
