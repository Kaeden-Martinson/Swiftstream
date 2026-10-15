import readline from 'node:readline/promises';

// Terminal styling for the CLI. Colors switch off when output isn't a terminal or NO_COLOR is set.
const colorOn = !process.env.NO_COLOR && !!process.stderr.isTTY;
const wrap = (open, close) => (s) => (colorOn ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
};

export const ok = (msg) => console.log(`${c.green('✓')} ${msg}`);
export const info = (msg) => console.error(`${c.cyan('›')} ${msg}`);
export const warn = (msg) => console.error(`${c.yellow('!')} ${msg}`);

export function printError({ message, hint }) {
  console.error(`${c.red('✗')} ${message}`);
  if (hint) console.error(c.dim(hint.replace(/^/gm, '  ')));
}

/** Ask a question; returns the default when the user just presses enter. */
export async function ask(question, fallback = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${c.cyan('?')} ${question}${fallback ? c.dim(` (${fallback})`) : ''} `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

export async function confirm(question, fallback = false) {
  const answer = await ask(`${question} ${c.dim(fallback ? '[Y/n]' : '[y/N]')}`);
  return answer ? /^y(es)?$/i.test(answer) : fallback;
}

/** Simple aligned table; the first row is the header. */
export function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows
    .map((r, idx) => {
      const line = r.map((cell, i) => String(cell).padEnd(widths[i])).join('   ').trimEnd();
      return idx === 0 ? c.dim(line) : line;
    })
    .join('\n');
}
