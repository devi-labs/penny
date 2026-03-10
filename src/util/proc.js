'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');

function makeJobId() {
  return crypto.randomBytes(6).toString('hex');
}

function safeLogChunk(s, max = 3500) {
  const text = String(s || '');
  return text.length > max ? text.slice(0, max) + '\n…(truncated)…\n' : text;
}

function httpsRepoUrl(owner, repo, token) {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

function commandAllowed(cmd, args) {
  const deny = new Set([
    'rm', 'rmdir', 'mkfs', 'dd', 'shutdown', 'reboot', 'halt', 'poweroff',
    'passwd', 'useradd', 'userdel', 'groupadd', 'chown', 'chmod',
    'mount', 'umount', 'fdisk', 'parted',
    'iptables', 'ip6tables', 'nft',
    'systemctl', 'service', 'init',
    'sudo', 'su', 'doas',
    'docker', 'podman', 'kubectl',
    'kill', 'killall', 'pkill',
  ]);
  if (deny.has(cmd)) return false;

  // Only check the command + first few args for dangerous patterns (not file content)
  const cmdPrefix = [cmd, ...args.slice(0, 2)].join(' ').toLowerCase();

  const blocked = [
    'bash -c', 'sh -c',
    'nc ', 'netcat',
    'ssh ', 'scp ', 'sftp',
    '| sh', '| bash',
  ];
  if (blocked.some((b) => cmdPrefix.includes(b))) return false;

  return true;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      ...opts,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString('utf8')));
    p.stderr.on('data', (d) => (err += d.toString('utf8')));

    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

module.exports = {
  makeJobId,
  safeLogChunk,
  httpsRepoUrl,
  commandAllowed,
  runCmd,
};
