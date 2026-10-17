// SSH key with a passphrase: the app asks for it (wrong once, then right) and sets up the server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ssh2, startEnv } from './harness.js';

const env = await startEnv('passphrase', { extraUsers: { keyuser: 'no-password-login' } });
try {
  const key = ssh2.utils.generateKeyPairSync('ed25519', { passphrase: 'correct horse', cipher: 'aes256-cbc', comment: 'test' });
  const keyFile = path.join(env.work, 'id_test_locked');
  fs.writeFileSync(keyFile, key.private);
  fs.writeFileSync(path.join(env.users.keyuser.home, '.ssh', 'authorized_keys'), `${key.public}\n`);
  const config = path.join(env.work, 'ssh_config');
  fs.writeFileSync(config, `Host keybox\n  HostName 127.0.0.1\n  User keyuser\n  Port ${env.sshPort}\n  IdentityFile ${keyFile.split(path.sep).join('/')}\n`);

  const { result, error } = await env.runApp(
    `
    await until(() => document.querySelector('.import-card'));
    const card = [...document.querySelectorAll('.import-card')].find((c) => c.querySelector('.host-name').textContent === 'keybox');
    card.querySelector('.btn').click();
    await until(() => document.getElementById('add-dialog').open);
    document.getElementById('add-form').requestSubmit();
    const titles = [];
    const answer = async (text) => {
      await until(() => document.getElementById('prompt-dialog').open);
      titles.push(document.getElementById('prompt-title').textContent);
      document.getElementById('prompt-input').value = text;
      if (text === 'correct horse') { await sleep(500); await api.devShot('passphrase'); }
      document.getElementById('prompt-form').requestSubmit();
      await until(() => !document.getElementById('prompt-dialog').open);
    };
    await answer('wrong');
    await answer('correct horse');
    await until(() => !document.getElementById('add-dialog').open, 60000);
    const error = document.getElementById('add-error').hidden ? null : document.getElementById('add-error').innerText;
    return { titles, saved: state.hosts.map((h) => h.name + ' ' + (h.ssh || '')), error };
  `,
    { env: { SWIFTSTREAM_SSH_CONFIG: config } },
  );
  assert.ok(result, error);
  assert.deepEqual(result.titles, ['Passphrase for id_test_locked', 'Wrong passphrase']);
  assert.ok(result.saved.includes('keybox keyuser@127.0.0.1'), result.saved.join(', '));
  assert.ok(fs.existsSync(path.join(env.users.keyuser.home, '.swiftstream', 'bin', 'swiftstream.cjs')), 'Swiftstream was not installed for keyuser');
  console.log('ok  passphrase asked, a wrong one retried, key unlocked, server set up');
} finally {
  env.stop(); // stops keyuser's server too
}
