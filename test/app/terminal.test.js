// Terminal: search, split panes, font size, close pane — in the real app against a throwaway server.
import assert from 'node:assert/strict';
import { startEnv } from './harness.js';

const env = await startEnv('terminal');
try {
  const { result, error } = await env.runApp(`
    // The terminal's text, with lines that wrapped at the pane's edge joined back up.
    const text = (pane) => { const b = pane.xterm.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) { const line = b.getLine(i); s += (line.isWrapped ? '' : '\\n') + line.translateToString(true); } return s; };
    openSession('box', 'terminal');
    const session = await until(() => activeSession()?.panes?.[0]?.id && activeSession());
    const first = session.panes[0];
    // Type only once the shell shows its prompt (slow machines, like CI, take a while to start one).
    const prompted = (pane) => /[>$#]\\s*$/.test(text(pane).trimEnd() + ' ');
    await until(() => !first.container.classList.contains('connecting') && prompted(first), 60000);
    await sleep(500);
    api.term.write(first.id, 'echo needle-one\\r\\necho hay\\r\\necho needle-two\\r\\n');
    const printed = (pane, word) => text(pane).split('\\n').some((l) => l.trim() === word);
    await until(() => printed(first, 'needle-two'), 60000);

    // Search
    openSearch();
    document.getElementById('term-search-input').value = 'needle';
    runSearch('next');
    await sleep(300);
    const searchCount = document.getElementById('term-search-count').textContent;
    await api.devShot('search');
    closeSearch();

    // Split: a second shell in the same tab
    splitPane(session);
    const second = await until(() => session.panes[1]?.id && session.panes[1]);
    await until(() => !second.container.classList.contains('connecting') && prompted(second), 60000);
    await sleep(500);
    api.term.write(second.id, 'echo from-second-pane\\r\\n');
    try {
      await until(() => printed(second, 'from-second-pane'), 60000);
    } catch {
      // Say what the second pane shows instead, for the CI annotation.
      throw new Error(\`no output in the second pane (\${second.xterm.cols} cols, pty \${second.pty}, id \${second.id}, first id \${first.id}); it shows: \${JSON.stringify(text(second).slice(-500))}\`);
    }
    const focusedIsSecond = session.term === second;
    const bothVisible = session.panes.map((p) => Math.round(p.container.getBoundingClientRect().width));

    // Font size
    setTerminalFontSize(16);
    const fontSizes = session.panes.map((p) => p.xterm.options.fontSize);
    await sleep(300);
    await api.devShot('split');

    // Context menu items, then close the second pane
    const menu = paneMenu(session, second).filter((i) => i !== 'separator').map((i) => i.label);
    closePane(session, second);
    await sleep(300);
    const panesAfterClose = session.panes.length;
    setTerminalFontSize(13.5);
    return { searchCount, focusedIsSecond, bothVisible, fontSizes, menu, panesAfterClose, firstStillWorks: !!first.id };
  `);
  assert.ok(result, error);
  assert.match(result.searchCount, /^1 of [2-4]$/); // both outputs, plus the echoed commands where they didn't wrap
  assert.equal(result.focusedIsSecond, true);
  assert.ok(result.bothVisible.every((w) => w > 200), `pane widths ${result.bothVisible}`);
  assert.deepEqual(result.fontSizes, [16, 16]);
  assert.deepEqual(result.menu, ['Copy', 'Paste', 'Find…', 'Split right', 'Close this terminal', 'Clear']);
  assert.equal(result.panesAfterClose, 1);
  assert.equal(result.firstStillWorks, true);
  console.log('ok  search, split panes, text size, close pane');
} finally {
  env.stop();
}
