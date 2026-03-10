'use strict';

const fs = require('fs');
const path = require('path');

function nowIso() {
  return new Date().toISOString();
}

function clampString(s, n) {
  return String(s || '').slice(0, n);
}

function brainObjectPath(prefix, kind, key) {
  const safe = String(key).replace(/[^a-zA-Z0-9._:@-]/g, '_');
  return `${prefix}/${kind}/${safe}.json`;
}

// Local filesystem storage (fast reads/writes on VM)
const LOCAL_BRAIN_DIR = process.env.OPENCLAW_BRAIN_DIR || '/tmp/openclaw-brain';

function localPath(objectName) {
  return path.join(LOCAL_BRAIN_DIR, objectName);
}

function localReadJson(objectName) {
  try {
    const fp = localPath(objectName);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function localWriteJson(objectName, obj) {
  const fp = localPath(objectName);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2), 'utf8');
}

// GCS storage (backup)
async function gcsReadJson(storage, bucketName, objectName) {
  try {
    const [buf] = await storage.bucket(bucketName).file(objectName).download();
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    if (e?.code === 404 || e?.statusCode === 404) return null;
    return null;
  }
}

async function gcsWriteJson(storage, bucketName, objectName, obj) {
  const text = JSON.stringify(obj, null, 2);
  await storage.bucket(bucketName).file(objectName).save(text, {
    resumable: false,
    contentType: 'application/json; charset=utf-8',
  });
}

function threadKeyFromEvent(event) {
  const threadTs = event.thread_ts || event.ts;
  return `${event.team || 'team'}:${event.channel}:${threadTs}`;
}

function repoKey(owner, repo) {
  return `${owner}/${repo}`;
}

function sanitizePlanForStorage(plan) {
  const safe = {
    prTitle: clampString(plan?.prTitle, 200),
    prBody: clampString(plan?.prBody, 6000),
    commitMessage: clampString(plan?.commitMessage, 200),
    summaryBullets: Array.isArray(plan?.summaryBullets) ? plan.summaryBullets.slice(0, 30).map((x) => clampString(x, 300)) : [],
    testPlanBullets: Array.isArray(plan?.testPlanBullets) ? plan.testPlanBullets.slice(0, 30).map((x) => clampString(x, 300)) : [],
    steps: Array.isArray(plan?.steps)
      ? plan.steps.slice(0, 40).map((st) => ({
          cmd: clampString(st?.cmd, 20),
          args: Array.isArray(st?.args) ? st.args.slice(0, 30).map((a) => clampString(a, 300)) : [],
        }))
      : [],
    verify: {
      failed: !!plan?.verify?.failed,
      logs: clampString(plan?.verify?.logs, 8000),
      commands: Array.isArray(plan?.verify?.commands)
        ? plan.verify.commands.slice(0, 10).map((cmdArr) => (Array.isArray(cmdArr) ? cmdArr.slice(0, 30).map((x) => clampString(x, 200)) : []))
        : [],
    },
  };
  return safe;
}

function createBrain({ storage, bucket, prefix }) {
  const gcsEnabled = !!storage && !!bucket;
  const enabled = true; // always enabled — local storage is always available

  // Ensure local brain dir exists
  fs.mkdirSync(LOCAL_BRAIN_DIR, { recursive: true });

  // Async GCS backup (fire-and-forget, never blocks)
  function backupToGcs(objPath, data) {
    if (!gcsEnabled) return;
    gcsWriteJson(storage, bucket, objPath, data).catch((e) => {
      console.error(`GCS backup failed for ${objPath}:`, e?.message || e);
    });
  }

  // Read: local first, fall back to GCS if local miss
  async function readJson(objPath) {
    const local = localReadJson(objPath);
    if (local) return local;
    if (!gcsEnabled) return null;
    const remote = await gcsReadJson(storage, bucket, objPath);
    if (remote) localWriteJson(objPath, remote); // cache locally
    return remote;
  }

  // Write: local (sync, fast) + async GCS backup
  async function writeJson(objPath, data) {
    localWriteJson(objPath, data);
    backupToGcs(objPath, data);
  }

  async function loadThread(threadKey) {
    const objPath = brainObjectPath(prefix, 'threads', threadKey);
    return await readJson(objPath);
  }

  async function saveThread(threadKey, patch) {
    const objPath = brainObjectPath(prefix, 'threads', threadKey);
    const existing = (await readJson(objPath)) || {};
    const merged = {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
      version: 1,
    };
    await writeJson(objPath, merged);
  }

  async function loadRepo(owner, repo) {
    const key = repoKey(owner, repo);
    const objPath = brainObjectPath(prefix, 'repos', key);
    return await readJson(objPath);
  }

  async function saveRepo(owner, repo, patch) {
    const key = repoKey(owner, repo);
    const objPath = brainObjectPath(prefix, 'repos', key);
    const existing = (await readJson(objPath)) || {};
    const merged = {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
      version: 1,
    };
    await writeJson(objPath, merged);
  }

  async function recordThreadError(threadKey, patch) {
    try {
      await saveThread(threadKey, {
        lastErrorAt: nowIso(),
        ...patch,
      });
    } catch (e) {
      // silently ignore
    }
  }

  async function loadSummary() {
    const objPath = brainObjectPath(prefix, 'global', 'summary');
    return await readJson(objPath);
  }

  async function saveSummary(patch) {
    const objPath = brainObjectPath(prefix, 'global', 'summary');
    const existing = (await readJson(objPath)) || { entries: [] };
    const entry = {
      ...patch,
      at: nowIso(),
    };
    existing.entries = [...(existing.entries || []).slice(-49), entry];
    existing.updatedAt = nowIso();
    await writeJson(objPath, existing);
  }

  function threadKeyFromPhone(phoneNumber) {
    const safe = String(phoneNumber).replace(/[^0-9+]/g, '');
    return `sms:${safe}`;
  }

  async function listRepos() {
    const reposDir = path.join(LOCAL_BRAIN_DIR, prefix, 'repos');
    try {
      if (!fs.existsSync(reposDir)) return [];
      const files = fs.readdirSync(reposDir).filter(f => f.endsWith('.json'));
      return files.map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(reposDir, f), 'utf8'));
          return { name: data.name || f.replace('.json', ''), language: data.language, description: data.description };
        } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  return {
    enabled,
    threadKeyFromEvent,
    threadKeyFromPhone,
    loadThread,
    saveThread,
    loadRepo,
    saveRepo,
    listRepos,
    recordThreadError,
    sanitizePlanForStorage,
    loadSummary,
    saveSummary,
  };
}

module.exports = { createBrain };
