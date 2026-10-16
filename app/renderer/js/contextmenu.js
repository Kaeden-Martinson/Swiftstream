'use strict';
// A small right-click menu. items: [{ label, icon, run, danger, disabled, hint }] or 'separator'.

let openMenu = null;

function closeMenu() {
  if (!openMenu) return;
  const menu = openMenu;
  openMenu = null;
  menu.classList.add('closing');
  setTimeout(() => menu.remove(), 120);
  window.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('blur', closeMenu);
  window.removeEventListener('resize', closeMenu);
  document.removeEventListener('scroll', closeMenu, true);
}

function onOutside(e) {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}

function showMenu(x, y, items) {
  closeMenu();
  const list = items.filter((item, i, all) => item !== 'separator' || (i > 0 && i < all.length - 1 && all[i - 1] !== 'separator'));
  if (!list.length) return;
  const menu = el('div', { className: 'ctx-menu', role: 'menu' });
  const buttons = [];
  for (const item of list) {
    if (item === 'separator') {
      menu.append(el('div', { className: 'ctx-sep', role: 'separator' }));
      continue;
    }
    if (item.heading) {
      menu.append(el('div', { className: 'ctx-heading', textContent: item.heading }));
      continue;
    }
    const button = el(
      'button',
      { type: 'button', role: 'menuitem', className: `ctx-item${item.danger ? ' danger' : ''}`, disabled: !!item.disabled },
      item.icon ? icon(item.icon) : el('span', { className: 'ctx-icon-gap' }),
      el('span', { className: 'ctx-label', textContent: item.label }),
      item.hint ? el('span', { className: 'ctx-hint', textContent: item.hint }) : null,
    );
    button.addEventListener('click', () => {
      closeMenu();
      item.run?.();
    });
    buttons.push(button);
    menu.append(button);
  }
  menu.addEventListener('keydown', (e) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const i = enabled.indexOf(document.activeElement);
    if (e.key === 'Escape') closeMenu();
    else if (e.key === 'ArrowDown') enabled[(i + 1) % enabled.length]?.focus();
    else if (e.key === 'ArrowUp') enabled[(i - 1 + enabled.length) % enabled.length]?.focus();
    else return;
    e.preventDefault();
  });
  document.body.append(menu);
  // Keep the menu inside the window.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 6)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 6)}px`;
  openMenu = menu;
  buttons.find((b) => !b.disabled)?.focus({ preventScroll: true });
  setTimeout(() => {
    window.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    document.addEventListener('scroll', closeMenu, true);
  });
}

/** Attach a menu to an element; build(e) returns the items when the menu opens. */
function onContextMenu(node, build) {
  node.addEventListener('contextmenu', (e) => {
    const items = build(e);
    if (!items) return;
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, items);
  });
}

// Anywhere without a menu of its own: suppress the browser's default menu, except in text fields.
window.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea, .xterm')) e.preventDefault();
});
