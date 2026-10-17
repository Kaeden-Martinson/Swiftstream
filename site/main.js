'use strict';

// Everything here enhances a page that already works without JavaScript.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);

/** Run fn once, the first time el is mostly on screen. */
function onceVisible(el, fn, threshold = 0.4) {
  if (!el) return;
  if (!('IntersectionObserver' in window)) return fn();
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      fn();
    }
  }, { threshold });
  io.observe(el);
}

// ---------- copy buttons ----------
const toast = $('toast');
let toastTimer;
function showToast(text) {
  $('toast-text').textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1700);
}
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.classList.add('copied');
      setTimeout(() => button.classList.remove('copied'), 1400);
      showToast('Copied to clipboard');
    } catch {
      showToast(`Copy this: ${button.dataset.copy}`);
    }
  });
}

// ---------- nav: border on scroll, current section, mobile menu ----------
const nav = $('nav');
const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

const navLinks = [...document.querySelectorAll('.nav-links a')];
if ('IntersectionObserver' in window) {
  const sections = navLinks.map((a) => document.querySelector(a.getAttribute('href')));
  const spy = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const a of navLinks) a.classList.toggle('active', a.getAttribute('href') === `#${entry.target.id}`);
    }
  }, { rootMargin: '-45% 0px -50% 0px' });
  sections.forEach((s) => s && spy.observe(s));
}

const toggle = $('nav-toggle');
function setMenu(open) {
  nav.classList.toggle('open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}
toggle.addEventListener('click', () => setMenu(!nav.classList.contains('open')));
navLinks.forEach((a) => a.addEventListener('click', () => setMenu(false)));
document.addEventListener('keydown', (e) => e.key === 'Escape' && setMenu(false));

// ---------- light / dark theme (the first pick happens in <head>, before paint) ----------
const themeBtn = $('theme-btn');
const systemLight = window.matchMedia('(prefers-color-scheme: light)');
function applyTheme(theme, fade) {
  const root = document.documentElement;
  if (fade && !reduceMotion) {
    root.classList.add('theme-fading');
    setTimeout(() => root.classList.remove('theme-fading'), 300);
  }
  root.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f7f8fa' : '#0e1013';
  themeBtn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
}
applyTheme(document.documentElement.dataset.theme || 'dark', false);
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  try {
    // Choosing the theme the system already uses goes back to following the system.
    if (next === (systemLight.matches ? 'light' : 'dark')) localStorage.removeItem('theme');
    else localStorage.setItem('theme', next);
  } catch {
    /* storage blocked: the choice lasts for this visit */
  }
  applyTheme(next, true);
});
systemLight.addEventListener('change', (e) => {
  let saved = null;
  try {
    saved = localStorage.getItem('theme');
  } catch {
    /* ignore */
  }
  if (!saved) applyTheme(e.matches ? 'light' : 'dark', true);
});

// ---------- hero: an upload that finishes, then the next one starts ----------
const heroJob = {
  card: $('hero-job'),
  name: $('hero-job-name'),
  pct: $('hero-job-pct'),
  bar: $('hero-job-bar'),
  status: $('hero-job-status'),
};
const demoFiles = [
  { name: 'build-2026-10-15.tar.gz', mb: 184 },
  { name: 'assets/', mb: 41, files: 1268 },
  { name: 'db-backup.sql.gz', mb: 96 },
];

async function heroLoop() {
  if (reduceMotion || !heroJob.card) return;
  await sleep(1900); // let the skeleton resolve first
  for (let n = 0; ; n++) {
    const file = demoFiles[n % demoFiles.length];
    heroJob.card.classList.remove('done');
    heroJob.name.textContent = file.name;
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps;
      const pct = Math.round(frac * 100);
      heroJob.bar.style.width = `${pct}%`;
      heroJob.pct.textContent = `${pct}%`;
      heroJob.status.textContent = file.files
        ? `${Math.round(file.files * frac)} of ${file.files} files · bundled`
        : `${Math.round(file.mb * frac)} of ${file.mb} MB · 8 connections`;
      await sleep(document.hidden ? 1000 : 70);
    }
    heroJob.card.classList.add('done');
    heroJob.pct.textContent = '';
    heroJob.status.textContent = file.files ? `Uploaded · ${Math.round(file.files * 0.94)} unchanged files skipped` : 'Uploaded · checksum verified';
    await sleep(2600);
  }
}
heroLoop();

// ---------- speed diagram: plays once in view ----------
const lanes = $('lanes');
if (lanes && !reduceMotion) {
  lanes.classList.add('armed');
  onceVisible(lanes, () => requestAnimationFrame(() => lanes.classList.remove('armed')), 0.45);
}

// ---------- terminal: types itself out once in view ----------
const term = $('term-demo');
if (term && !reduceMotion) {
  const lines = [...term.querySelectorAll('.tl')];
  const typed = lines.map((l) => l.querySelector('.typed'));
  const fullText = typed.map((t) => t?.textContent ?? '');
  term.classList.add('playing');
  typed.forEach((t) => t && (t.textContent = ''));
  onceVisible(term, async () => {
    for (let i = 0; i < lines.length; i++) {
      lines[i].classList.add('shown');
      if (typed[i]) {
        await sleep(350);
        for (const ch of fullText[i]) {
          typed[i].textContent += ch;
          await sleep(22 + Math.random() * 30);
        }
        await sleep(420); // the command "runs"
      } else {
        await sleep(lines[i].classList.contains('gap') ? 60 : 160);
      }
    }
    term.classList.remove('playing');
  }, 0.5);
}

// ---------- app screens: tabs with a sliding indicator and a brief load ----------
const tabList = document.querySelector('.seg-tabs');
const tabs = [...document.querySelectorAll('.seg-tabs [role="tab"]')];
const indicator = document.querySelector('.seg-indicator');
const appMain = $('app-main');

function moveIndicator(tab) {
  indicator.style.width = `${tab.offsetWidth}px`;
  indicator.style.transform = `translateX(${tab.offsetLeft}px)`;
}

let switching = 0;
async function selectTab(tab, focus) {
  const run = ++switching;
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  moveIndicator(tab);
  if (focus) tab.focus();
  if (!reduceMotion) {
    // The real app shows a skeleton while it fetches; mirror that briefly.
    appMain.classList.add('loading');
    await sleep(260);
    if (run !== switching) return;
  }
  // The mockup's own tab bar follows along, like switching tabs in the real app.
  for (const m of document.querySelectorAll('.mock-tab[data-panel]')) m.classList.toggle('on', m.dataset.panel === tab.getAttribute('aria-controls'));
  for (const t of tabs) {
    const panel = $(t.getAttribute('aria-controls'));
    panel.hidden = t !== tab;
    panel.classList.toggle('entering', t === tab && !reduceMotion);
  }
  appMain.classList.remove('loading');
}

if (tabList) {
  tabList.classList.add('ready');
  moveIndicator(tabs.find((t) => t.getAttribute('aria-selected') === 'true'));
  window.addEventListener('resize', () => moveIndicator(tabs.find((t) => t.getAttribute('aria-selected') === 'true')));
  document.fonts?.ready.then(() => moveIndicator(tabs.find((t) => t.getAttribute('aria-selected') === 'true')));
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => tab.getAttribute('aria-selected') !== 'true' && selectTab(tab));
    tab.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      let next = null;
      if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      else if (step) next = tabs[(i + step + tabs.length) % tabs.length];
      if (!next) return;
      e.preventDefault();
      selectTab(next, true);
    });
  });
}

// ---------- "How the login works": animate open and closed ----------
const details = $('login-details');
if (details && !reduceMotion && details.animate) {
  const body = details.querySelector('.more-body');
  details.querySelector('summary').addEventListener('click', (e) => {
    e.preventDefault();
    if (details.open) {
      const anim = body.animate({ height: [`${body.offsetHeight}px`, '0px'], opacity: [1, 0] }, { duration: 220, easing: 'ease-in' });
      anim.onfinish = () => (details.open = false);
    } else {
      details.open = true;
      body.animate({ height: ['0px', `${body.offsetHeight}px`], opacity: [0, 1] }, { duration: 280, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    }
  });
}

// ---------- downloads: real files, sizes and checksums from downloads/latest.json ----------
const isWindows = /win/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
const formatSize = (bytes) => {
  const mb = bytes / 1024 / 1024;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

function applyManifest(manifest) {
  const byKind = Object.fromEntries(manifest.files.map((f) => [f.kind, f]));
  for (const row of document.querySelectorAll('#platforms [data-kind]')) {
    const file = byKind[row.dataset.kind];
    // Optional rows (the macOS and Linux apps) only show when that release has them.
    row.hidden = row.hasAttribute('data-optional') && !file;
    row.classList.toggle('unavailable', !file);
    if (!file) continue;
    row.querySelector('[data-dl-link]').href = `downloads/${file.name}`;
    const meta = row.querySelector('[data-dl-meta]');
    meta.textContent = `${meta.textContent.split(' · ')[0]} · ${formatSize(file.size)}`;
    const sum = row.querySelector('[data-dl-sum]');
    sum.dataset.copy = file.sha256;
    sum.textContent = `SHA-256 ${file.sha256.slice(0, 16)}…`;
    sum.title = 'Copy the full checksum';
    sum.hidden = false;
  }
  const deb = byKind['app-linux-deb'];
  document.querySelector('[data-dl-deb-note]').hidden = !deb;
  if (deb) document.querySelector('[data-dl-deb]').href = `downloads/${deb.name}`;
  // "Not packaged yet" only while a release has neither the macOS nor the Linux app.
  $('dl-later').hidden = !!(byKind['app-mac'] || byKind['app-linux']);

  const release = $('dl-release');
  release.replaceChildren(`Version ${manifest.version} · released ${manifest.released} · `, Object.assign(document.createElement('a'), { href: 'downloads/SHA256SUMS.txt', textContent: 'SHA256SUMS.txt' }));
  for (const v of document.querySelectorAll('.footer-ver')) v.textContent = `v${manifest.version}`;

  // The hero button offers what fits this computer: the desktop app if there's one for it, else the command line.
  const hero = $('hero-download');
  const system = isWindows ? 'windows' : isMac ? 'mac' : 'linux';
  const app = byKind[`app-${system}`];
  const pick = app || byKind['cli-portable'];
  if (pick) hero.href = `downloads/${pick.name}`;
  if (app) {
    hero.querySelector('use').setAttribute('href', `#i-${system === 'mac' ? 'apple' : system}`);
    hero.querySelector('span').textContent = `Download for ${{ windows: 'Windows', mac: 'macOS', linux: 'Linux' }[system]}`;
  } else if (pick) {
    hero.querySelector('use').setAttribute('href', '#i-terminal');
    hero.querySelector('span').textContent = 'Download the command line';
    $('hero-fine').textContent = 'The desktop app for this system is on its way. The command line needs Node.js 18+ on this computer.';
  }
}

(async () => {
  try {
    const res = await fetch('downloads/latest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    applyManifest(await res.json());
  } catch {
    // Opened without a published release (e.g. a local preview): say so instead of linking to missing files.
    for (const link of document.querySelectorAll('[data-dl-link], #hero-download')) {
      link.removeAttribute('download');
      link.href = '#download';
    }
    const note = $('dl-note');
    note.textContent = 'Downloads aren\'t published on this copy of the site yet. Run "npm run release", then "npm run publish-site".';
    note.hidden = false;
  }
})();
