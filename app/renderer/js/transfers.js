'use strict';
// Transfers: a card per active upload or download (bottom right) with pause, resume and cancel, and
// the Transfers list on the tab bar with recent ones. The jobs themselves run in the main process.

const cards = new Map(); // job id -> { card, bar, status, dirIcon, actions, job, samples, timer }
const transferJobs = new Map(); // job id -> latest snapshot, for the list and the tab bar count

const ACTIVE = ['running', 'paused', 'canceling'];

function formatDuration(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '';
  if (secs < 60) return `${Math.max(1, Math.round(secs))}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
  return `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m`;
}

function timeAgo(ms) {
  const secs = (Date.now() - ms) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** Speed over the last few seconds (not the whole run), so it follows the connection as it changes. */
function recentSpeed(samples) {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const secs = (last.t - first.t) / 1000;
  return secs > 0.3 ? (last.done - first.done) / secs : 0;
}

// ---------- cards ----------

function scheduleDismiss(id, ms) {
  const entry = cards.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => !entry.card.matches(':hover') && dismissCard(id), ms);
}

function dismissCard(id) {
  const entry = cards.get(id);
  if (!entry) return;
  cards.delete(id);
  entry.card.classList.add('leaving');
  entry.card.addEventListener('animationend', () => entry.card.remove(), { once: true });
}

function actionButton(label, iconName, onClick, className = '') {
  const b = el('button', { type: 'button', className: `job-action ${className}`, title: label, ariaLabel: label }, icon(iconName));
  b.addEventListener('click', onClick);
  return b;
}

function createCard(job) {
  const bar = el('div');
  const status = el('div', { className: 'job-status' }, el('span'), el('span'));
  const actions = el('span', { className: 'job-actions' });
  const dirIcon = el('span', { className: 'job-dir' }, icon(job.direction === 'up' ? 'up' : 'down'));
  const card = el(
    'div',
    { className: 'job' },
    el('div', { className: 'job-top' }, dirIcon, el('span', { className: 'job-label', textContent: job.label }), el('span', { className: 'job-host muted', textContent: job.host }), actions),
    el('div', { className: 'job-bar' }, bar),
    status,
  );
  // Pointing at a card keeps it open; it goes away again shortly after the pointer leaves.
  card.addEventListener('mouseenter', () => clearTimeout(cards.get(job.id)?.timer));
  card.addEventListener('mouseleave', () => {
    const entry = cards.get(job.id);
    if (entry && !ACTIVE.includes(entry.job.state)) scheduleDismiss(job.id, 2500);
  });
  $('transfers').prepend(card);
  const entry = { card, bar, status, actions, dirIcon, job, samples: [], timer: null };
  cards.set(job.id, entry);
  return entry;
}

function paintCard(entry) {
  const { job, card, bar, status, actions, dirIcon } = entry;
  card.classList.toggle('paused', job.state === 'paused');
  card.classList.toggle('done', job.state === 'done');
  card.classList.toggle('failed', job.state === 'failed');
  card.classList.toggle('canceled', job.state === 'canceled');
  card.querySelector('.job-error')?.remove();
  const pct = job.total ? Math.min(100, (job.done / job.total) * 100) : job.state === 'done' ? 100 : 0;
  bar.style.width = `${pct}%`;
  const [left, right] = status.children;
  right.replaceChildren();

  const buttons = [];
  if (job.state === 'running') {
    buttons.push(actionButton('Pause', 'pause', () => api.transfers.pause(job.id)));
    buttons.push(actionButton('Cancel', 'x', () => api.transfers.cancel(job.id), 'danger'));
  } else if (job.state === 'paused') {
    buttons.push(actionButton('Resume', 'play', () => api.transfers.resume(job.id)));
    buttons.push(actionButton('Cancel', 'x', () => api.transfers.cancel(job.id), 'danger'));
  } else if (job.state !== 'canceling') {
    buttons.push(actionButton('Dismiss', 'x', () => dismissCard(job.id)));
  }
  actions.replaceChildren(...buttons);

  if (job.state === 'running') {
    paintProgress(entry);
  } else if (job.state === 'paused') {
    left.textContent = `Paused at ${formatBytes(job.done)} of ${formatBytes(job.total)}`;
    right.textContent = 'Resume continues from here';
  } else if (job.state === 'canceling') {
    left.textContent = 'Canceling…';
  } else if (job.state === 'canceled') {
    dirIcon.replaceChildren(icon('x'));
    left.textContent = 'Canceled';
    right.append(retryButton(job));
    scheduleDismiss(job.id, 4000);
  } else if (job.state === 'failed') {
    dirIcon.replaceChildren(icon('alert'));
    left.textContent = 'Failed';
    right.append(retryButton(job));
    card.append(el('div', { className: 'job-error', textContent: `${job.error?.message || 'Something went wrong.'}${job.error?.hint ? ` ${job.error.hint}` : ''}` }));
    scheduleDismiss(job.id, 12000); // failures stay longer, so there's time to read them
  } else if (job.state === 'done') {
    dirIcon.replaceChildren(icon('check'));
    const secs = ((job.finishedAt || Date.now()) - job.startedAt) / 1000;
    left.textContent = `Done in ${secs < 10 ? secs.toFixed(1) : formatDuration(secs)}`;
    if (job.revealPath) right.append(revealButton(job));
    scheduleDismiss(job.id, 1500);
  }
}

function paintProgress(entry) {
  const { job, status, bar } = entry;
  const [left, right] = status.children;
  bar.style.width = `${job.total ? Math.min(100, (job.done / job.total) * 100) : 0}%`;
  left.textContent = `${formatBytes(job.done)} of ${formatBytes(job.total)}`;
  const speed = recentSpeed(entry.samples);
  const remaining = speed > 0 ? (job.total - job.done) / speed : NaN;
  right.textContent = speed > 0 ? `${formatBytes(speed)}/s${Number.isFinite(remaining) && remaining > 1 ? ` · ${formatDuration(remaining)} left` : ''}` : '';
}

function retryButton(job) {
  const b = el('button', { type: 'button', textContent: 'Retry' });
  b.addEventListener('click', () => api.transfers.retry(job.id));
  return b;
}

function revealButton(job) {
  const b = el('button', { type: 'button', textContent: 'Show in folder' });
  b.addEventListener('click', () => api.files.reveal(job.revealPath));
  return b;
}

api.transfers.onUpdate((job) => {
  const previous = transferJobs.get(job.id);
  transferJobs.set(job.id, job);
  let entry = cards.get(job.id);
  if (!entry && (ACTIVE.includes(job.state) || previous)) entry = createCard(job);
  if (entry) {
    if (job.state === 'running' && entry.job.state !== 'running') entry.samples = []; // fresh speed after a resume
    clearTimeout(entry.timer);
    entry.job = job;
    paintCard(entry);
  }
  if (job.state === 'done' && previous?.state !== 'done') onTransferFinished(job); // files.js: refresh panes
  renderTransfersButton();
  if (!$('transfers-panel').hidden) renderTransfersPanel();
});

api.transfers.onProgress(({ id, done, total }) => {
  const entry = cards.get(id);
  const job = transferJobs.get(id);
  if (job) Object.assign(job, { done, total });
  if (!entry || entry.job.state !== 'running') return;
  entry.job = { ...entry.job, done, total };
  const now = performance.now();
  entry.samples.push({ t: now, done });
  while (entry.samples.length > 2 && now - entry.samples[0].t > 5000) entry.samples.shift();
  paintProgress(entry);
});

// ---------- the Transfers list (tab bar) ----------

function renderTransfersButton() {
  const active = [...transferJobs.values()].filter((j) => j.state === 'running' || j.state === 'canceling').length;
  const paused = [...transferJobs.values()].filter((j) => j.state === 'paused').length;
  const badge = $('transfers-count');
  badge.hidden = !(active + paused);
  badge.textContent = String(active + paused);
  badge.classList.toggle('paused', !active && paused > 0);
  $('transfers-btn').title = active ? `${active} transfer${active === 1 ? '' : 's'} running` : paused ? `${paused} paused` : 'Recent transfers';
}

async function renderTransfersPanel() {
  const list = await call(api.transfers.list()).catch(() => []);
  for (const j of list) if (!transferJobs.has(j.id) || ACTIVE.includes(j.state)) transferJobs.set(j.id, { ...transferJobs.get(j.id), ...j });
  const rows = list.map((job) => {
    const live = transferJobs.get(job.id) || job;
    const state = live.state;
    const statusText =
      state === 'running'
        ? `${formatBytes(live.done)} of ${formatBytes(live.total)}`
        : state === 'paused'
        ? `Paused · ${formatBytes(live.done)} of ${formatBytes(live.total)}`
        : state === 'failed'
        ? `Failed · ${live.error?.message || ''}`
        : state === 'canceled'
        ? 'Canceled'
        : state === 'canceling'
        ? 'Canceling…'
        : `${formatBytes(live.total)} · ${timeAgo(live.finishedAt || live.startedAt)}`;
    const buttons = [];
    if (state === 'running') buttons.push(actionButton('Pause', 'pause', () => api.transfers.pause(job.id)), actionButton('Cancel', 'x', () => api.transfers.cancel(job.id), 'danger'));
    if (state === 'paused') buttons.push(actionButton('Resume', 'play', () => api.transfers.resume(job.id)), actionButton('Cancel', 'x', () => api.transfers.cancel(job.id), 'danger'));
    if (live.canRetry) buttons.push(actionButton('Retry', 'refresh', () => api.transfers.retry(job.id)));
    if (state === 'done' && live.revealPath) buttons.push(actionButton('Show in folder', 'folder', () => api.files.reveal(live.revealPath)));
    return el(
      'div',
      { className: `tp-row ${state}` },
      el('span', { className: 'job-dir' }, icon(state === 'failed' ? 'alert' : state === 'done' ? (live.direction === 'up' ? 'up' : 'down') : live.direction === 'up' ? 'up' : 'down')),
      el('span', { className: 'tp-meta' }, el('span', { className: 'tp-label', textContent: live.label, title: live.label }), el('span', { className: 'tp-sub muted', textContent: `${live.host} · ${statusText}`, title: statusText })),
      el('span', { className: 'job-actions' }, ...buttons),
    );
  });
  $('transfers-list').replaceChildren(...(rows.length ? rows : [el('div', { className: 'tp-empty muted', textContent: 'No transfers yet. Drag files between the panes to start one.' })]));
  $('transfers-clear').hidden = !list.some((j) => !ACTIVE.includes(j.state));
}

function toggleTransfersPanel(open = $('transfers-panel').hidden) {
  $('transfers-panel').hidden = !open;
  $('transfers-btn').classList.toggle('active', open);
  if (!open) return;
  // Line its right edge up with the Transfers button.
  const btn = $('transfers-btn').getBoundingClientRect();
  $('transfers-panel').style.right = `${Math.max(8, window.innerWidth - btn.right)}px`;
  renderTransfersPanel();
}

$('transfers-btn').addEventListener('click', () => toggleTransfersPanel());
$('transfers-clear').addEventListener('click', async () => {
  await call(api.transfers.clear());
  for (const [id, j] of transferJobs) if (!ACTIVE.includes(j.state)) transferJobs.delete(id);
  renderTransfersPanel();
});
document.addEventListener('pointerdown', (e) => {
  if (!$('transfers-panel').hidden && !e.target.closest('#transfers-panel, #transfers-btn')) toggleTransfersPanel(false);
});
window.addEventListener('keydown', (e) => e.key === 'Escape' && !$('transfers-panel').hidden && toggleTransfersPanel(false));
