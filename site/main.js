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
