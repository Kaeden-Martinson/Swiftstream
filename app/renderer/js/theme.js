'use strict';
// Loaded in <head> so the first paint has the right colors. The main process sets Electron's theme
// source from Settings › Appearance (System, Light or Dark), so prefers-color-scheme is the answer.
(function () {
  const light = window.matchMedia('(prefers-color-scheme: light)');
  const apply = (fade) => {
    const root = document.documentElement;
    const theme = light.matches ? 'light' : 'dark';
    if (root.dataset.theme === theme) return;
    if (fade) {
      root.classList.add('theme-fading');
      setTimeout(() => root.classList.remove('theme-fading'), 260);
    }
    root.dataset.theme = theme;
    window.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  };
  apply(false);
  light.addEventListener('change', () => apply(true));
})();
