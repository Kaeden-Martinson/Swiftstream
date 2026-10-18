/* global Terminal, FitAddon, SearchAddon */
'use strict';
// Terminal tabs: one or more xterm panes per tab, kept alive while you switch tabs.

const terminals = new Map(); // terminal id -> pane

const TERM_THEMES = {
  dark: {
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
  },
  light: {
    background: '#f7f8fa',
    foreground: '#1f242b',
    cursor: '#0f9d63',
    cursorAccent: '#f7f8fa',
    selectionBackground: '#c6ead8',
    black: '#1f242b', brightBlack: '#6b7380',
    red: '#c93636', brightRed: '#e05252',
    green: '#0c8a56', brightGreen: '#12a66a',
    yellow: '#9a6a12', brightYellow: '#b7811c',
    blue: '#2563c9', brightBlue: '#3b7be0',
    magenta: '#9b3fc4', brightMagenta: '#b05ad6',
    cyan: '#0e7f88', brightCyan: '#14979f',
    white: '#c9ced6', brightWhite: '#e7e9ec',
  },
};
const termTheme = () => TERM_THEMES[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'];

// Recolor open terminals when the theme changes.
window.addEventListener('themechange', () => {
  for (const pane of allPanes()) pane.xterm.options.theme = termTheme();
});

// A terminal tab holds one or more panes side by side (Split right), each its own shell on the same
// server. session.panes lists them; session.term is the one you're typing in.
const MAX_PANES = 4;
const FONT_SIZES = { min: 9, max: 28, default: 13.5 };
const allPanes = () => [...state.sessions.values()].flatMap((s) => s.panes || []);
const termFontSize = () => Math.min(FONT_SIZES.max, Math.max(FONT_SIZES.min, Number(settings().terminalFontSize) || FONT_SIZES.default));

function ensureTerminal(session) {
  if (session.panes?.length) {
    requestAnimationFrame(() => session.panes.forEach(fitTerminal));
    session.term.xterm.focus();
    return;
  }
  session.panes = [];
  session.group = el('div', { className: 'term-group' });
  session.group.dataset.session = session.id;
  $('terminal-pane').append(session.group);
  addPane(session);
}

function addPane(session) {
  const container = el('div', { className: 'term' });
  container.dataset.session = session.id;
  session.group.append(container);
  const xterm = new Terminal({
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, Menlo, monospace",
    fontSize: termFontSize(),
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true, // search result highlighting
    theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  xterm.loadAddon(fit);
  xterm.loadAddon(search);
  xterm.open(container);
  container.append(
    el(
      'div',
      { className: 'term-loading' },
      ...['46%', '30%', '58%', '22%'].map((w) => el('div', { className: 'sk-line' }, skeleton(w))),
      el('div', { className: 'term-loading-label', textContent: `Connecting to ${session.host}…` }),
    ),
  );
  const pane = { xterm, fit, search, id: null, pty: true, line: '', container, sessionId: session.id };
  session.panes.push(pane);
  session.term = pane;
  paintPanes(session);

  xterm.attachCustomKeyEventHandler((e) => onTerminalKey(session, pane, e));
  xterm.onData((data) => onTerminalInput(pane, data));
  xterm.onResize(({ cols, rows }) => pane.id && api.term.resize(pane.id, cols, rows));
  xterm.onSelectionChange(() => {
    const text = xterm.getSelection();
    if (text && settings().copyOnSelect) api.copy(text);
  });
  xterm.textarea?.addEventListener('focus', () => focusPane(session, pane, { fromXterm: true }));
  container.addEventListener('pointerdown', () => focusPane(session, pane));
  onContextMenu(container, () => paneMenu(session, pane));

  requestAnimationFrame(() => {
    session.panes.forEach(fitTerminal);
    startSession(session, pane);
    xterm.focus();
  });
  return pane;
}

function focusPane(session, pane, { fromXterm = false } = {}) {
  if (session.term === pane && fromXterm) return;
  session.term = pane;
  paintPanes(session);
  if (!fromXterm) pane.xterm.focus();
  if (!$('term-search').hidden) runSearch(); // search follows the pane you're in
}

function paintPanes(session) {
  session.group.classList.toggle('split', session.panes.length > 1);
  for (const p of session.panes) p.container.classList.toggle('focused', p === session.term);
}

function splitPane(session = activeSession()) {
  if (session?.kind !== 'terminal' || !session.panes) return;
  if (session.panes.length >= MAX_PANES) return toast(`A tab holds up to ${MAX_PANES} terminals`);
  addPane(session);
}

/** Close one pane; closing the last one closes the tab. */
function closePane(session, pane = session.term) {
  if (session.panes.length <= 1) return closeTab(session.id);
  disposePane(pane);
  session.panes = session.panes.filter((p) => p !== pane);
  session.term = session.panes[Math.max(0, session.panes.length - 1)];
  paintPanes(session);
  requestAnimationFrame(() => session.panes.forEach(fitTerminal));
  session.term.xterm.focus();
}

function disposePane(pane) {
  if (pane.id) {
    api.term.close(pane.id);
    terminals.delete(pane.id);
  }
  pane.xterm.dispose();
  pane.container.remove();
}

function fitTerminal(pane) {
  try {
    pane.fit.fit();
  } catch {
    /* hidden; fitted again when shown */
  }
}

/** End a tab's terminal sessions and free their xterms (closing its tab). */
function disposeTerminal(session) {
  if (!session?.panes) return;
  session.panes.forEach(disposePane);
  session.group.remove();
  session.panes = null;
  session.term = null;
}

async function startSession(session, pane = session.term) {
  if (!pane) return;
  pane.container.classList.add('connecting');
  try {
    pane.id = await call(api.term.open(session.host, pane.xterm.cols, pane.xterm.rows));
    terminals.set(pane.id, pane);
  } catch (err) {
    pane.container.classList.remove('connecting');
    pane.xterm.write(`\x1b[31m${err.message}\x1b[0m\r\n${err.hint ? `\x1b[2m${err.hint.replace(/\n/g, '\r\n')}\x1b[0m\r\n` : ''}`);
    pane.ended = true;
    pane.xterm.write('\r\n\x1b[2mPress Enter to try again.\x1b[0m\r\n');
  }
}

// ---------- keys: copy, search, font size, split ----------

function onTerminalKey(session, pane, e) {
  if (e.type !== 'keydown') return true;
  const key = e.key.toLowerCase();
  // Windows and Linux: Ctrl+Shift+C/F/D, so plain Ctrl+C/F/D still reach the shell. macOS: Cmd+C/F/D, like iTerm.
  const cmd = (code) => (IS_MAC ? e.metaKey && !e.shiftKey : e.ctrlKey && e.shiftKey) && e.code === code;
  if (cmd('KeyC')) {
    const text = pane.xterm.getSelection();
    if (text) api.copy(text);
    return false;
  }
  if (IS_MAC && e.metaKey && e.code === 'KeyV') return pasteInto(pane), false;
  if (cmd('KeyF')) return openSearch(), false;
  if (e.ctrlKey && (e.key === 'PageUp' || e.key === 'PageDown')) return false; // switching tabs (workspace.js)
  if (cmd('KeyD')) return splitPane(session), false;
  // Ctrl+= / Ctrl+- / Ctrl+0 (Cmd on a Mac): text size, for every terminal.
  if (modKey(e) && !e.shiftKey && !e.altKey && (key === '=' || key === '+' || key === '-' || key === '0')) {
    setTerminalFontSize(key === '0' ? FONT_SIZES.default : termFontSize() + (key === '-' ? -1 : 1));
    return false;
  }
  return true;
}

function setTerminalFontSize(size) {
  const next = Math.min(FONT_SIZES.max, Math.max(FONT_SIZES.min, size));
  updateSettings({ terminalFontSize: next });
  for (const p of allPanes()) {
    p.xterm.options.fontSize = next;
    fitTerminal(p);
  }
  if ($('set-font-size')) $('set-font-size').textContent = String(next);
  toast(`Terminal text size ${next}`);
}

async function pasteInto(pane) {
  const text = await call(api.readClipboard()).catch(() => '');
  if (text) pane.xterm.paste(text);
  pane.xterm.focus();
}

function paneMenu(session, pane) {
  focusPane(session, pane);
  const selection = pane.xterm.getSelection();
  return [
    { label: 'Copy', icon: 'copy', hint: IS_MAC ? '⌘C' : 'Ctrl+Shift+C', disabled: !selection, run: () => api.copy(selection) },
    { label: 'Paste', icon: 'files', hint: keyName('Ctrl+V'), run: () => pasteInto(pane) },
    { label: 'Find…', icon: 'search', hint: IS_MAC ? '⌘F' : 'Ctrl+Shift+F', run: openSearch },
    'separator',
    { label: 'Split right', icon: 'plus', hint: IS_MAC ? '⌘D' : 'Ctrl+Shift+D', disabled: session.panes.length >= MAX_PANES, run: () => splitPane(session) },
    { label: session.panes.length > 1 ? 'Close this terminal' : 'Close tab', icon: 'x', hint: keyName(session.panes.length > 1 ? 'Ctrl+Shift+W' : 'Ctrl+W'), run: () => closePane(session, pane) },
    'separator',
    { label: 'Clear', icon: 'trash', run: () => pane.xterm.clear() },
  ];
}

// ---------- search (Ctrl+Shift+F) ----------

// Match highlights, per theme (the active match stands out in the accent color).
const searchDecorations = () =>
  document.documentElement.dataset.theme === 'light'
    ? { matchBackground: '#c9ecda', activeMatchBackground: '#0f9d63', matchOverviewRuler: '#0f9d63', activeMatchColorOverviewRuler: '#0f9d63' }
    : { matchBackground: '#3a4a3f', activeMatchBackground: '#3ddc97', matchOverviewRuler: '#3ddc97', activeMatchColorOverviewRuler: '#3ddc97' };

function openSearch() {
  const pane = activeSession()?.term;
  if (!pane) return;
  $('term-search').hidden = false;
  const input = $('term-search-input');
  const selection = pane.xterm.getSelection();
  if (selection && !selection.includes('\n')) input.value = selection;
  input.focus();
  input.select();
  runSearch();
}

function closeSearch() {
  $('term-search').hidden = true;
  for (const p of allPanes()) p.search.clearDecorations();
  activeSession()?.term?.xterm.focus();
}

function runSearch(direction = 'next') {
  const pane = activeSession()?.term;
  const query = $('term-search-input').value;
  if (!pane) return;
  if (!query) {
    pane.search.clearDecorations();
    $('term-search-count').textContent = '';
    return;
  }
  const opts = { incremental: direction === 'incremental', decorations: searchDecorations() };
  const found = direction === 'previous' ? pane.search.findPrevious(query, opts) : pane.search.findNext(query, opts);
  $('term-search').classList.toggle('none', !found);
  if (!found) $('term-search-count').textContent = 'No results';
}

$('term-search-input').addEventListener('input', () => runSearch('incremental'));
$('term-search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch(e.shiftKey ? 'previous' : 'next');
  else if (e.key === 'Escape') closeSearch();
  else return;
  e.preventDefault();
});
$('term-search-prev').addEventListener('click', () => runSearch('previous'));
$('term-search-next').addEventListener('click', () => runSearch('next'));
$('term-search-close').addEventListener('click', closeSearch);

/** Result count from the search addon ("3 of 12"). */
function watchSearchResults(pane) {
  pane.search.onDidChangeResults?.(({ resultIndex, resultCount }) => {
    if (activeSession()?.term !== pane || $('term-search').hidden) return;
    $('term-search-count').textContent = resultCount ? `${resultIndex + 1} of ${resultCount}` : 'No results';
    $('term-search').classList.toggle('none', !resultCount);
  });
}

// ---------- input and output ----------

function onTerminalInput(pane, data) {
  if (pane.ended) {
    if (data === '\r') {
      pane.ended = false;
      pane.xterm.reset();
      startSession(state.sessions.get(pane.sessionId), pane);
    }
    return;
  }
  if (!pane.id) return;
  if (pane.pty) return api.term.write(pane.id, data);
  // No terminal on the server side: simple line editing here.
  for (const ch of data) {
    if (ch === '\r') {
      pane.xterm.write('\r\n');
      api.term.write(pane.id, `${pane.line}\n`);
      pane.line = '';
    } else if (ch === '\x7f' || ch === '\b') {
      if (pane.line) {
        pane.line = pane.line.slice(0, -1);
        pane.xterm.write('\b \b');
      }
    } else if (ch >= ' ') {
      pane.line += ch;
      pane.xterm.write(ch);
    }
  }
}

const termFor = (id) => terminals.get(id) || null;

api.term.onHello((id, { pty }) => {
  const pane = termFor(id);
  if (!pane) return;
  pane.pty = pty;
  pane.container.classList.remove('connecting');
  pane.xterm.reset();
  watchSearchResults(pane);
  if (!pty) {
    pane.xterm.options.convertEol = true;
    pane.xterm.write("\x1b[2mBasic terminal: full-screen programs like vim won't work on this server.\x1b[0m\r\n");
  }
});
api.term.onData((id, data) => termFor(id)?.xterm.write(data));
api.term.onExit((id, code) => {
  const pane = termFor(id);
  terminals.delete(id);
  if (!pane) return;
  pane.id = null;
  pane.ended = true;
  pane.xterm.write(`\r\n\x1b[2mSession ended${code ? ` (exit ${code})` : ''}. Press Enter to start a new one.\x1b[0m\r\n`);
  // 255 = the connection dropped without an exit code: check now rather than waiting for the next round.
  const host = state.sessions.get(pane.sessionId)?.host;
  if (code === 255 && host) call(api.health.check(host)).catch(() => {});
});
api.term.onError((id, err) => termFor(id)?.xterm.write(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`));

new ResizeObserver(() => {
  const session = activeSession();
  if (session?.panes && !$('terminal-pane').hidden) session.panes.forEach(fitTerminal);
}).observe($('terminal-pane'));
