'use strict';

// Copy-to-clipboard buttons ("npm i -g swiftssh").
const toast = document.getElementById('toast');
let toastTimer;
function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      showToast('Copied to clipboard');
    } catch {
      showToast(`Copy this: ${button.dataset.copy}`);
    }
  });
}

// App screen switcher: an accessible tablist (arrow keys move between tabs).
const tabs = [...document.querySelectorAll('.seg-tabs [role="tab"]')];
function selectTab(tab, focus) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
}
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (e.key === 'Home') selectTab(tabs[0], true);
    else if (e.key === 'End') selectTab(tabs[tabs.length - 1], true);
    else if (step) selectTab(tabs[(i + step + tabs.length) % tabs.length], true);
    else return;
    e.preventDefault();
  });
});

// The speed diagram plays once when it scrolls into view, so the stall is seen happening.
// Without JS, or with reduced motion, it simply shows the finished state.
const lanes = document.getElementById('lanes');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (lanes && 'IntersectionObserver' in window && !reduceMotion) {
  lanes.classList.add('armed');
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        requestAnimationFrame(() => lanes.classList.remove('armed'));
        observer.disconnect();
      }
    },
    { threshold: 0.45 },
  );
  observer.observe(lanes);
}
