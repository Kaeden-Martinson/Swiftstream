'use strict';
// Transfer cards in the bottom right: progress, speed, done or failed.

const jobs = new Map();

function scheduleDismiss(id, ms) {
  const job = jobs.get(id);
  if (!job) return;
  clearTimeout(job.timer);
  job.timer = setTimeout(() => !job.card.matches(':hover') && dismissJob(id), ms);
}

function dismissJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  job.card.classList.add('leaving');
  job.card.addEventListener('animationend', () => job.card.remove(), { once: true });
}

api.transfers.onStart(({ id, host, label, direction, total }) => {
  const bar = el('div');
  const status = el('div', { className: 'job-status' }, el('span', { textContent: 'Starting…' }), el('span'));
  const close = el('button', { className: 'job-close', title: 'Dismiss', ariaLabel: 'Dismiss' }, icon('x'));
  const dirIcon = el('span', { className: 'job-dir' }, icon(direction === 'up' ? 'up' : 'down'));
  const card = el(
    'div',
    { className: 'job' },
    el('div', { className: 'job-top' }, dirIcon, el('span', { className: 'job-label', textContent: label }), el('span', { className: 'job-host muted', textContent: host }), close),
    el('div', { className: 'job-bar' }, bar),
    status,
  );
  close.addEventListener('click', () => dismissJob(id));
  // Pointing at a card keeps it open; it goes away again shortly after the pointer leaves.
  card.addEventListener('mouseenter', () => clearTimeout(jobs.get(id)?.timer));
  card.addEventListener('mouseleave', () => jobs.get(id)?.finished && scheduleDismiss(id, 2500));
  $('transfers').prepend(card);
  jobs.set(id, { card, bar, status, dirIcon, total, host, direction, started: performance.now() });
});

api.transfers.onProgress(({ id, done, total }) => {
  const job = jobs.get(id);
  if (!job) return;
  const secs = Math.max((performance.now() - job.started) / 1000, 0.001);
  job.bar.style.width = `${total ? Math.min(100, (done / total) * 100) : 100}%`;
  job.status.firstChild.textContent = `${formatBytes(done)} of ${formatBytes(total)}`;
  job.status.lastChild.textContent = `${formatBytes(done / secs)}/s`;
});

api.transfers.onDone(({ id, error, revealPath }) => {
  const job = jobs.get(id);
  if (!job) return;
  const secs = (performance.now() - job.started) / 1000;
  if (error) {
    job.card.classList.add('failed');
    job.dirIcon.replaceChildren(icon('alert'));
    job.status.firstChild.textContent = 'Failed';
    job.status.lastChild.textContent = '';
    job.card.append(el('div', { className: 'job-error', textContent: `${error.message}${error.hint ? ` ${error.hint}` : ''}` }));
    job.finished = true;
    scheduleDismiss(id, 12000); // failures stay longer, so there's time to read them
    return;
  }
  job.card.classList.add('done');
  job.dirIcon.replaceChildren(icon('check'));
  job.bar.style.width = '100%';
  job.status.firstChild.textContent = `Done in ${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s`;
  job.status.lastChild.textContent = '';
  if (revealPath) {
    const show = el('button', { textContent: 'Show in folder' });
    show.addEventListener('click', () => api.files.reveal(revealPath));
    job.status.lastChild.append(show);
  }
  onTransferFinished(job); // files.js: refresh the panes that changed
  job.finished = true;
  scheduleDismiss(id, revealPath ? 8000 : 4000);
});
