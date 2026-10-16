/* global Terminal, FitAddon */
'use strict';
// One xterm per server tab, kept alive while you switch tabs.

const terminals = new Map(); // terminal id -> session id

const TERM_THEME = {
  background: '#0e1013',
  foreground: '#e7e9ec',
  cursor: '#3ddc97',
  cursorAccent: '#0e1013',
  selectionBackground: '#2b4a3d',
  black: '#1b1f26', brightBlack: '#5d6574',
  red: '#ff7a7a', brightRed: '#ff9c9c',
  green: '#3ddc97', brightGreen: '#6fe8b4',
  yellow: '#f5c35b', brightYellow: '#f8d488',
  blue: '#6aa8ff', brightBlue: '#94c0ff',
  magenta: '#d68cff', brightMagenta: '#e3adff',
  cyan: '#4fd6e0', brightCyan: '#82e4eb',
  white: '#c9ced6', brightWhite: '#ffffff',
};

function ensureTerminal(session) {
  const v = session;
  const name = session.host;
  if (v.term) {
    requestAnimationFrame(() => fitTerminal(v.term));
    v.term.xterm.focus();
    return;
  }
  const container = el('div', { className: 'term' });
  container.dataset.session = session.id;
  $('terminal-pane').append(container);
  const xterm = new Terminal({
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, Menlo, monospace",
    fontSize: 13.5,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    theme: TERM_THEME,
  });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(container);
  container.append(
    el(
      'div',
      { className: 'term-loading' },
      ...['46%', '30%', '58%', '22%'].map((w) => el('div', { className: 'sk-line' }, skeleton(w))),
      el('div', { className: 'term-loading-label', textContent: `Connecting to ${name}…` }),
    ),
  );
  v.term = { xterm, fit, id: null, pty: true, line: '', container };
  // Ctrl+Shift+C copies, like other terminals on Windows and Linux.
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      const text = xterm.getSelection();
      if (text) api.copy(text);
      return false;
    }
    return true;
  });
  xterm.onData((data) => onTerminalInput(v.term, data));
  xterm.onResize(({ cols, rows }) => v.term.id && api.term.resize(v.term.id, cols, rows));
  requestAnimationFrame(() => {
    fitTerminal(v.term);
    startSession(session);
    xterm.focus();
  });
}

function fitTerminal(term) {
  try {
    term.fit.fit();
  } catch {
    /* hidden; fitted again when shown */
  }
}

/** End a tab's terminal session and free its xterm (closing its tab). */
function disposeTerminal(session) {
  const v = session;
  if (!v?.term) return;
  if (v.term.id) {
    api.term.close(v.term.id);
    terminals.delete(v.term.id);
  }
  v.term.xterm.dispose();
  v.term.container.remove();
  v.term = null;
}

async function startSession(session) {
  const term = session.term;
  if (!term) return;
  term.container.classList.add('connecting');
  try {
    term.id = await call(api.term.open(session.host, term.xterm.cols, term.xterm.rows));
    terminals.set(term.id, session.id);
  } catch (err) {
    term.container.classList.remove('connecting');
    term.xterm.write(`\x1b[31m${err.message}\x1b[0m\r\n${err.hint ? `\x1b[2m${err.hint.replace(/\n/g, '\r\n')}\x1b[0m\r\n` : ''}`);
    term.ended = true;
    term.xterm.write('\r\n\x1b[2mPress Enter to try again.\x1b[0m\r\n');
  }
}

function onTerminalInput(term, data) {
  if (term.ended) {
    if (data === '\r') {
      term.ended = false;
      term.xterm.reset();
      startSession(state.sessions.get(term.container.dataset.session));
    }
    return;
  }
  if (!term.id) return;
  if (term.pty) return api.term.write(term.id, data);
  // No terminal on the server side: simple line editing here.
  for (const ch of data) {
    if (ch === '\r') {
      term.xterm.write('\r\n');
      api.term.write(term.id, `${term.line}\n`);
      term.line = '';
    } else if (ch === '\x7f' || ch === '\b') {
      if (term.line) {
        term.line = term.line.slice(0, -1);
        term.xterm.write('\b \b');
      }
    } else if (ch >= ' ') {
      term.line += ch;
      term.xterm.write(ch);
    }
  }
}

const termFor = (id) => state.sessions.get(terminals.get(id))?.term || null;

api.term.onHello((id, { pty }) => {
  const term = termFor(id);
  if (!term) return;
  term.pty = pty;
  term.container.classList.remove('connecting');
  term.xterm.reset();
  if (!pty) {
    term.xterm.options.convertEol = true;
    term.xterm.write("\x1b[2mBasic terminal: full-screen programs like vim won't work on this server.\x1b[0m\r\n");
  }
});
api.term.onData((id, data) => termFor(id)?.xterm.write(data));
api.term.onExit((id, code) => {
  const term = termFor(id);
  terminals.delete(id);
  if (!term) return;
  term.id = null;
  term.ended = true;
  term.xterm.write(`\r\n\x1b[2mSession ended${code ? ` (exit ${code})` : ''}. Press Enter to start a new one.\x1b[0m\r\n`);
  // 255 = the connection dropped without an exit code: check now rather than waiting for the next round.
  const host = state.sessions.get(term.container.dataset.session)?.host;
  if (code === 255 && host) call(api.health.check(host)).catch(() => {});
});
api.term.onError((id, err) => termFor(id)?.xterm.write(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`));

new ResizeObserver(() => {
  const term = activeSession()?.term;
  if (term && !$('terminal-pane').hidden) fitTerminal(term);
}).observe($('terminal-pane'));
