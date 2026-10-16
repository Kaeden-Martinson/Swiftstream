// Loaded in <head>, before the page paints: use the saved theme, otherwise the system setting.
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('theme');
  } catch (e) {}
  var theme = saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#f7f8fa' : '#0e1013';
})();
