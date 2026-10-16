'use strict';
// Small modal helpers: text/password prompt, confirm, and the upload destination choice.

function prompt({ title, text, value, ok, input = true, secret = false, danger = false }) {
  const dialog = $('prompt-dialog');
  $('prompt-title').textContent = title;
  $('prompt-text').textContent = text || '';
  $('prompt-field').hidden = !input;
  $('prompt-input').type = secret ? 'password' : 'text';
  $('prompt-input').value = value || '';
  $('prompt-ok').textContent = ok || 'OK';
  $('prompt-ok').classList.toggle('btn-danger', danger);
  dialog.showModal();
  if (input) {
    $('prompt-input').focus();
    $('prompt-input').select();
  }
  return new Promise((resolve) => {
    const finish = (result) => {
      $('prompt-form').removeEventListener('submit', onSubmit);
      $('prompt-cancel').removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onCancel);
      dialog.close();
      resolve(result);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      const entered = $('prompt-input').value;
      $('prompt-input').value = '';
      finish(input ? (secret ? entered : entered.trim()) : true);
    };
    const onCancel = (e) => {
      e?.preventDefault();
      finish(null);
    };
    $('prompt-form').addEventListener('submit', onSubmit);
    $('prompt-cancel').addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onCancel);
  });
}

const confirmDialog = (title, text, ok, danger = false) => prompt({ title, text, ok, input: false, danger });

/**
 * Ask where an upload should go when this source folder has a remembered destination that
 * differs from where the files were dropped. Resolves with the chosen remote path, or null.
 */
function chooseDestination({ count, sourceDir, remembered, current }) {
  const dialog = $('dest-dialog');
  $('dest-title').textContent = `Upload ${count === 1 ? '1 item' : `${count} items`} to…`;
  $('dest-remembered').querySelector('[data-part="path"]').textContent = remembered;
  $('dest-remembered').querySelector('[data-part="why"]').textContent = `Where files from ${basenameOf(sourceDir)} went last time`;
  $('dest-current').querySelector('[data-part="path"]').textContent = current;
  dialog.showModal();
  $('dest-remembered').focus();
  return new Promise((resolve) => {
    const finish = (value) => {
      for (const [node, handler] of handlers) node.removeEventListener('click', handler);
      dialog.removeEventListener('cancel', onCancel);
      dialog.close();
      resolve(value);
    };
    const onCancel = (e) => {
      e?.preventDefault();
      finish(null);
    };
    const handlers = [
      [$('dest-remembered'), () => finish(remembered)],
      [$('dest-current'), () => finish(current)],
      [$('dest-cancel'), onCancel],
    ];
    for (const [node, handler] of handlers) node.addEventListener('click', handler);
    dialog.addEventListener('cancel', onCancel);
  });
}

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    await api.copy($(btn.dataset.copy).textContent);
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = old), 1200);
  });
}

