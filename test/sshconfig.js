// Reading ~/.ssh/config: aliases, defaults from "Host *", patterns, Include.
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseSshConfig } from '../src/sshconfig.js';

const files = { 'conf.d/work': 'Host work\n  HostName 10.0.0.5\n  User deploy\n' };
const config = `
# servers
Host prod web1
  HostName 203.0.113.7
  User ubuntu
  Port 2222
  IdentityFile ~/.ssh/prod_key

Host staging
  HostName=staging.example.com   # trailing comment

Host *.internal !secret.internal
  User admin

Match host something
  User ignored

Include conf.d/*

Host "quoted"
  HostName quoted.example.com

Host *
  User fallback
  Port 22
`;
const hosts = parseSshConfig(config, { readInclude: (p) => (p === 'conf.d/*' ? ['conf.d/work'] : []), readFile: (f) => files[f] });
const byAlias = Object.fromEntries(hosts.map((h) => [h.alias, h]));

assert.deepEqual(Object.keys(byAlias), ['prod', 'web1', 'staging', 'work', 'quoted']);
console.log('ok  aliases, wildcard hosts skipped');

assert.equal(byAlias.prod.hostname, '203.0.113.7');
assert.equal(byAlias.prod.user, 'ubuntu');
assert.equal(byAlias.prod.port, 2222);
assert.equal(path.basename(byAlias.prod.identityFile), 'prod_key');
assert.deepEqual({ ...byAlias.web1, alias: 'prod' }, byAlias.prod);
console.log('ok  HostName, User, Port, IdentityFile; one block for several aliases');

assert.equal(byAlias.staging.hostname, 'staging.example.com');
assert.equal(byAlias.staging.user, 'fallback');
assert.equal(byAlias.staging.port, 22);
console.log('ok  "Key=value", comments, defaults from Host *');

assert.equal(byAlias.work.hostname, '10.0.0.5');
assert.equal(byAlias.work.user, 'deploy');
console.log('ok  Include with a wildcard');

assert.equal(byAlias.quoted.hostname, 'quoted.example.com');
assert.equal(parseSshConfig('').length, 0);
console.log('ok  quoted aliases, empty config');

console.log('\nssh config tests passed');
