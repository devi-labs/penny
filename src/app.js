'use strict';

const { App } = require('@slack/bolt');

const { rateLimitOk } = require('./util/rateLimit');
const {
  stripBotMention,
  parseGitHubPullUrl,
  parseOwnerRepo,
  parseGitHubRepoUrl,
  parseTaskBlock,
  parseGsUri,
  parseKeyVals,
} = require('./util/parse');

const { sandboxFastPR } = require('./agent/sandbox');
const { fetchRepoAndReadme } = require('./github/repo');
const { summarizePullRequest } = require('./github/pr');
const { getRunClient } = require('./clients/gcp');

function helpText() {
  return [
    '*OpenClaw* can help with:',
    '• General questions / drafting: `@OpenClaw write...`',
    '• GitHub repo info: `@OpenClaw tell me about owner/repo` or paste a repo URL',
    '• GitHub PR summaries: `@OpenClaw summarize https://github.com/ORG/REPO/pull/123`',
    '• Dev agent (sandbox, fast PRs):',
    '  ```',
    '  repo: your-org/your-repo',
    '  task: create a hello world react app and open a pr',
    '  ```',
    '  (If brain is enabled, you can omit repo in the same thread.)',
    '• Brain:',
    '  - `brain status`',
    '  - `brain show`',
    '  - `brain reset`',
    '  - `brain last error`',
    '• GCP (beta): `gcp status`, `gcs ls`, `gcs cat gs://bucket/path`, `gcs put gs://bucket/path ...`, `cloudrun ls`, `cloudrun deploy service:NAME image:... env:K=V,...`',
    '',
    '_Notes:_',
    '• Dev agent uses Claude when `ANTHROPIC_API_KEY` is set.',
    '• GitHub requires `GITHUB_TOKEN`.',
    '• Brain requires `OPENCLAW_BRAIN_BUCKET` + GCP access.',
    '• Optional: `OPENCLAW_RUN_TESTS=1` to run verify commands (still non-blocking).',
  ].join('\n');
}

async function startSlackApp({ config, anthropic, octokit, storage, brain }) {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });

  const gcpEnabled = !!config.gcp.projectId;
  const getStorageClient = () => storage;

  // ============================================================================
  // GCS + Cloud Run helpers
  // ============================================================================
  async function gcsListBuckets() {
    const st = getStorageClient();
    if (!st) throw new Error('GCS not configured');
    const [buckets] = await st.getBuckets();
    return buckets.map((b) => b.name);
  }

  async function gcsListObjects(bucketName, prefix = '') {
    const st = getStorageClient();
    if (!st) throw new Error('GCS not configured');
    const [files] = await st.bucket(bucketName).getFiles({ prefix });
    return files.map((f) => f.name);
  }

  async function gcsReadObject(bucketName, objectName) {
    const st = getStorageClient();
    if (!st) throw new Error('GCS not configured');
    const [buf] = await st.bucket(bucketName).file(objectName).download();
    return buf.toString('utf8');
  }

  async function gcsWriteObject(bucketName, objectName, text) {
    const st = getStorageClient();
    if (!st) throw new Error('GCS not configured');
    await st.bucket(bucketName).file(objectName).save(text, {
      resumable: false,
      contentType: 'text/plain; charset=utf-8',
    });
  }

  async function cloudRunListServices() {
    if (!config.gcp.projectId) throw new Error('Cloud Run not configured (missing GCP_PROJECT_ID)');
    if (!config.gcp.region) throw new Error('Missing GCP_REGION (e.g., us-central1)');
    const run = await getRunClient();
    if (!run) throw new Error('Cloud Run client not available');

    const parent = `projects/${config.gcp.projectId}/locations/${config.gcp.region}`;
    const resp = await run.projects.locations.services.list({ parent });
    const services = resp.data.services || [];
    return services.map((s) => ({
      name: s.name,
      uri: s.uri,
      latestReadyRevision: s.latestReadyRevision,
    }));
  }

  async function cloudRunDeployImage({ serviceName, image, envPairs = [] }) {
    if (!config.gcp.projectId) throw new Error('Cloud Run not configured');
    if (!config.gcp.region) throw new Error('Missing GCP_REGION');

    const run = await getRunClient();
    if (!run) throw new Error('Cloud Run client not available');

    const name = `projects/${config.gcp.projectId}/locations/${config.gcp.region}/services/${serviceName}`;
    const getResp = await run.projects.locations.services.get({ name });
    const svc = getResp.data;

    const containers = svc.template?.containers || [];
    if (!containers.length) throw new Error('Service has no containers to update');

    containers[0].image = image;

    if (envPairs.length) {
      const map = new Map((containers[0].env || []).map((e) => [e.name, e.value]));
      for (const { key, value } of envPairs) map.set(key, value);
      containers[0].env = Array.from(map.entries()).map(([name, value]) => ({ name, value }));
    }

    svc.template.containers = containers;

    const patchResp = await run.projects.locations.services.patch({
      name,
      updateMask: 'template.containers',
      requestBody: svc,
    });

    return patchResp.data.name;
  }

  // ============================================================================
  // Slack mention handler
  // ============================================================================
  app.event('app_mention', async ({ event, say }) => {
    const cleaned = stripBotMention(event.text).trim();
    if (!cleaned) return;

    const reply = event.thread_ts ? { thread_ts: event.thread_ts } : { thread_ts: event.ts };
    const userKey = `${event.user}:${event.channel}`;

    if (!rateLimitOk(userKey)) {
      await say({ text: 'Rate limit: try again in ~30 seconds 🙏', ...reply });
      return;
    }

    const lower = cleaned.toLowerCase();
    const threadKey = brain.threadKeyFromEvent(event);
    const threadState = await brain.loadThread(threadKey);

    // Help
    if (lower === 'help' || lower.startsWith('help ') || lower.includes('what can you do')) {
      await say({ text: helpText(), ...reply });
      return;
    }

    // Status commands
    if (lower === 'github status') {
      await say({ text: `GitHub integration: ${octokit ? 'enabled' : 'disabled'}`, ...reply });
      return;
    }
    if (lower === 'gcp status') {
      await say({
        text: `GCP: ${gcpEnabled ? 'enabled' : 'disabled'} | GCS: ${getStorageClient() ? 'enabled' : 'disabled'} | Project: ${config.gcp.projectId || '(missing)'} | Region: ${config.gcp.region || '(missing)'}`,
        ...reply,
      });
      return;
    }
    if (lower.startsWith('brain status')) {
      await say({
        text:
          `Brain: ${brain.enabled ? 'enabled' : 'disabled'}\n` +
          `Bucket: ${config.gcp.brainBucket || '(missing)'}\n` +
          `Prefix: ${config.gcp.brainPrefix}\n` +
          `Thread key: ${threadKey}\n`,
        ...reply,
      });
      return;
    }
    if (lower.startsWith('brain show')) {
      await say({
        text: `Thread memory:\n\`\`\`\n${JSON.stringify(threadState || {}, null, 2).slice(0, 3800)}\n\`\`\``,
        ...reply,
      });
      return;
    }
    if (/^brain\s+last\s+error(\s|$|[?.!,]|please)/i.test(lower.trim())) {
      const err = threadState?.lastError;
      if (!err) {
        await say({ text: '✅ No recorded error for this thread.', ...reply });
        return;
      }
      const msg =
        `❌ Last error (${threadState?.lastErrorAt || 'unknown time'}):\n` +
        `• job: ${threadState?.lastErrorJobId || '(n/a)'}\n` +
        `• where: ${threadState?.lastErrorContext || '(n/a)'}\n` +
        `• error: ${err}\n` +
        (threadState?.lastErrorLogs ? `\nLogs:\n\`\`\`\n${String(threadState.lastErrorLogs).slice(0, 3000)}\n\`\`\`\n` : '') +
        (threadState?.lastClaudeRawSnippet ? `\nClaude snippet:\n\`\`\`\n${String(threadState.lastClaudeRawSnippet).slice(0, 1800)}\n\`\`\`\n` : '');
      await say({ text: msg.slice(0, 3900), ...reply });
      return;
    }
    if (lower.startsWith('brain reset')) {
      if (!brain.enabled) {
        await say({ text: 'Brain is disabled (no bucket or GCS access).', ...reply });
        return;
      }
      await brain.saveThread(threadKey, {
        clearedAt: new Date().toISOString(),
        lastRepo: null,
        lastTask: null,
        lastPrUrl: null,
        lastBranch: null,
        lastPlan: null,
        lastError: null,
        lastErrorAt: null,
        lastErrorJobId: null,
        lastErrorContext: null,
        lastErrorLogs: null,
        lastClaudeRawSnippet: null,
      });
      await say({ text: '✅ Cleared thread memory.', ...reply });
      return;
    }

    // -------------------- GCS commands --------------------
    if (lower.startsWith('gcs ')) {
      try {
        if (!gcpEnabled || !getStorageClient()) {
          await say({ text: 'GCS not configured. Set GCP_PROJECT_ID and ensure the runtime SA has GCS perms.', ...reply });
          return;
        }

        const parts = cleaned.split(/\s+/);
        const sub = (parts[1] || '').toLowerCase();

        if (sub === 'ls') {
          if (parts.length === 2) {
            const buckets = await gcsListBuckets();
            await say({ text: `Buckets:\n${buckets.map((b) => `• ${b}`).join('\n') || '(none)'}`, ...reply });
            return;
          }
          const bucket = parts[2];
          const objects = await gcsListObjects(bucket);
          await say({
            text: `gs://${bucket} objects:\n${objects.slice(0, 50).map((o) => `• ${o}`).join('\n') || '(none)'}${objects.length > 50 ? '\n...(truncated)' : ''}`,
            ...reply,
          });
          return;
        }

        if (sub === 'cat') {
          const gs = parseGsUri(cleaned);
          if (!gs) {
            await say({ text: 'Usage: `gcs cat gs://bucket/path`', ...reply });
            return;
          }
          const text = await gcsReadObject(gs.bucket, gs.object);
          await say({ text: `\`\`\`\n${text.slice(0, 3500)}\n\`\`\`${text.length > 3500 ? '\n...(truncated)' : ''}`, ...reply });
          return;
        }

        if (sub === 'put') {
          const gs = parseGsUri(cleaned);
          if (!gs) {
            await say({ text: 'Usage: `gcs put gs://bucket/path some text...`', ...reply });
            return;
          }
          const idx = cleaned.toLowerCase().indexOf('put');
          const afterPut = cleaned.slice(idx + 3).trim();
          const firstSpace = afterPut.indexOf(' ');
          if (firstSpace === -1) {
            await say({ text: 'Usage: `gcs put gs://bucket/path some text...`', ...reply });
            return;
          }
          const textToWrite = afterPut.slice(firstSpace + 1);
          await gcsWriteObject(gs.bucket, gs.object, textToWrite);
          await say({ text: `✅ Wrote to gs://${gs.bucket}/${gs.object}`, ...reply });
          return;
        }

        await say({ text: 'Unknown GCS command. Try: `gcs ls`, `gcs cat ...`, `gcs put ...`', ...reply });
        return;
      } catch (e) {
        console.error('GCS error:', e?.message || e);
        await brain.recordThreadError(threadKey, { lastError: `GCS error: ${e?.message || 'unknown'}`, lastErrorContext: 'gcs', lastErrorLogs: null });
        await say({ text: `GCS error: ${e?.message || 'unknown'}`, ...reply });
        return;
      }
    }

    // -------------------- Cloud Run commands --------------------
    if (lower.startsWith('cloudrun ')) {
      try {
        if (!gcpEnabled) {
          await say({ text: 'Cloud Run not configured. Set GCP_PROJECT_ID and GCP_REGION.', ...reply });
          return;
        }

        const parts = cleaned.split(/\s+/);
        const sub = (parts[1] || '').toLowerCase();

        if (sub === 'ls') {
          const services = await cloudRunListServices();
          await say({
            text:
              `Cloud Run services in ${config.gcp.projectId}/${config.gcp.region}:\n` +
              (services.map((s) => `• ${s.name?.split('/').pop()} - ${s.uri || '(no uri yet)'}`).join('\n') || '(none)'),
            ...reply,
          });
          return;
        }

        if (sub === 'deploy') {
          const sm = cleaned.match(/service\s*:\s*([a-z0-9-]+)/i);
          const im = cleaned.match(/image\s*:\s*([^\s]+)/i);
          if (!sm || !im) {
            await say({ text: 'Usage: `cloudrun deploy service:NAME image:gcr.io/... env:K=V,...`', ...reply });
            return;
          }

          const serviceName = sm[1];
          const image = im[1];
          const envPairs = parseKeyVals(cleaned);

          await say({ text: `Deploying ${serviceName} -> ${image} ...`, ...reply });
          const opName = await cloudRunDeployImage({ serviceName, image, envPairs });
          await say({ text: `✅ Deploy requested. Operation: ${opName}`, ...reply });
          return;
        }

        await say({ text: 'Unknown Cloud Run command. Try: `cloudrun ls`, `cloudrun deploy ...`', ...reply });
        return;
      } catch (e) {
        console.error('Cloud Run error:', e?.message || e);
        await brain.recordThreadError(threadKey, { lastError: `Cloud Run error: ${e?.message || 'unknown'}`, lastErrorContext: 'cloudrun', lastErrorLogs: null });
        await say({ text: `Cloud Run error: ${e?.message || 'unknown'}`, ...reply });
        return;
      }
    }

    // -------------------- GitHub PR summary --------------------
    const pr = parseGitHubPullUrl(cleaned);
    if (pr) {
      try {
        await say({ text: 'Got it - summarizing that PR...', ...reply });
        const summary = await summarizePullRequest({ octokit, anthropic, model: config.anthropic.model, pr, slackContext: cleaned });
        await say({ text: summary, ...reply });

        await brain.saveThread(threadKey, {
          lastPrUrl: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.pull_number}`,
          lastRepo: `${pr.owner}/${pr.repo}`,
        });
      } catch (err) {
        console.error('GitHub PR summary error:', err?.message || err);
        await brain.recordThreadError(threadKey, { lastError: err?.message || 'PR summary error', lastErrorContext: 'pr:summary' });
        await say({ text: 'I hit an error summarizing that PR. Check logs.', ...reply });
      }
      return;
    }

    // -------------------- Dev agent task block (sandbox) --------------------
    const taskBlock = parseTaskBlock(cleaned);
    if (taskBlock) {
      try {
        if (!octokit) {
          await say({ text: "GitHub isn\'t configured (`GITHUB_TOKEN` missing).", ...reply });
          return;
        }
        if (!anthropic) {
          await say({ text: "Claude isn\'t configured (`ANTHROPIC_API_KEY` missing).", ...reply });
          return;
        }

        // Determine repo: explicit repo or remembered lastRepo
        let owner = taskBlock.repoRef?.owner || null;
        let repo = taskBlock.repoRef?.repo || null;

        if ((!owner || !repo) && threadState?.lastRepo) {
          const m = parseOwnerRepo(threadState.lastRepo);
          if (m) { owner = m.owner; repo = m.repo; }
        }

        if (!owner || !repo) {
          await say({ text: 'I need a repo. Provide:\n```\nrepo: owner/repo\ntask: ...\n```', ...reply });
          return;
        }

        const sayProgress = async (t) => say({ text: t, ...reply });

        // Load repo memory
        const repoMem = await brain.loadRepo(owner, repo);

        // Repo context for planner (file tree + README so Claude knows empty vs existing)
        let repoContext = null;
        try {
          const { repoData, readmeText } = await fetchRepoAndReadme({ octokit, owner, repo });
          let rootPaths = [];
          try {
            const contentResp = await octokit.repos.getContent({
              owner,
              repo,
              path: '',
              ref: repoData.default_branch,
            });
            if (Array.isArray(contentResp.data)) rootPaths = contentResp.data.map((i) => i.path);
          } catch {
            rootPaths = [];
          }
          repoContext = {
            rootPaths,
            description: repoData.description || '',
            readmeSnippet: readmeText.slice(0, 4000),
          };
        } catch {
          repoContext = null;
        }

        await sayProgress(`🧠 Starting sandbox dev job for ${owner}/${repo}...`);

        const summaryMemory = await brain.loadSummary();

        const result = await sandboxFastPR({
          octokit,
          anthropic,
          model: config.anthropic.model,
          config,
          sayProgress,
          threadMemory: threadState || {},
          repoMemory: repoMem || {},
          repoContext,
          summaryMemory,
          threadKey,
          recordThreadError: brain.recordThreadError,
          owner,
          repo,
          task: taskBlock.task,
          constraints: taskBlock.constraints,
          acceptance: taskBlock.acceptance,
          context: taskBlock.context,
        });

        // Handle clarification response
        if (result.needsClarification) {
          const questions = (result.plan.questions || []).slice(0, 3);
          const msg = [
            `🤔 I want to make sure I get this right.`,
            '',
            `*My understanding:* ${result.plan.restatement || '(unclear)'}`,
            '',
            `*Before I proceed, I need to know:*`,
            ...questions.map((q, i) => `${i + 1}. ${q}`),
            '',
            `Reply with answers and I'll build the PR.`,
          ].join('\n');
          await say({ text: msg, ...reply });
          return;
        }

        // Save brain updates
        await brain.saveThread(threadKey, {
          lastRepo: `${owner}/${repo}`,
          lastTask: taskBlock.task,
          lastPrUrl: result.prUrl,
          lastBranch: result.branch,
          lastJobId: result.jobId,
          lastPlan: brain.sanitizePlanForStorage(result.plan),
        });

        await brain.saveRepo(owner, repo, {
          lastTouchedAt: new Date().toISOString(),
          lastPrUrl: result.prUrl,
          lastBranch: result.branch,
          preferences: { fastPRs: true, testsSecondary: true },
        });

        // Save task summary for cross-conversation memory
        await brain.saveSummary({
          repo: `${owner}/${repo}`,
          task: taskBlock.task,
          result: `PR created: ${result.prUrl}`,
          branch: result.branch,
        });

        await say({
          text: `✅ PR created: ${result.prUrl}\nBranch: ${result.branch}\nJob: ${result.jobId}`,
          ...reply,
        });
        return;
      } catch (e) {
        console.error('Sandbox dev error:', e?.message || e);
        await brain.recordThreadError(threadKey, {
          lastError: (e?.message || 'unknown error').slice(0, 800),
          lastErrorContext: 'sandbox:task',
        });
        await say({ text: `❌ Sandbox dev failed: ${e?.message || 'unknown error'}`, ...reply });
        return;
      }
    }

    // -------------------- GitHub repo summary --------------------
    const repoRef = parseGitHubRepoUrl(cleaned) || parseOwnerRepo(cleaned);
    if (repoRef) {
      try {
        await say({ text: `Got it - looking up ${repoRef.owner}/${repoRef.repo}...`, ...reply });

        if (!octokit) {
          await say({ text: "GitHub isn\'t configured (`GITHUB_TOKEN` missing).", ...reply });
          return;
        }

        const { repoData, readmeText } = await fetchRepoAndReadme({ octokit, ...repoRef });

        await brain.saveThread(threadKey, { lastRepo: `${repoRef.owner}/${repoRef.repo}` });

        if (anthropic) {
          let rootPaths = [];
          try {
            const resp = await octokit.repos.getContent({
              owner: repoRef.owner,
              repo: repoRef.repo,
              path: '',
              ref: repoData.default_branch,
            });
            if (Array.isArray(resp.data)) rootPaths = resp.data.map((i) => i.path);
          } catch {
            rootPaths = [];
          }

          const prompt = [
            'Summarize this GitHub repository for a Slack reply.',
            'Be honest if it is empty / newly created.',
            'Output:',
            '1) What it is (1-2 sentences)',
            '2) What\'s in it right now (bullets)',
            '3) How to run it (bullets, if applicable)',
            '4) What to do next (bullets)',
            '',
            `Repo: ${repoData.full_name}`,
            `Description: ${repoData.description || '(none)'}`,
            `Default branch: ${repoData.default_branch}`,
            `URL: ${repoData.html_url}`,
            '',
            `Top-level files (${rootPaths.length}):`,
            ...rootPaths.slice(0, 40).map((p) => `- ${p}`),
            '',
            `README:\n${readmeText.slice(0, 12000)}`,
          ].join('\n');

          const resp = await anthropic.messages.create({
            model: config.anthropic.model,
            max_tokens: 900,
            system: 'You are OpenClaw. You CAN access GitHub via server-side integration. Never reveal secrets.',
            messages: [{ role: 'user', content: prompt }],
          });

          const text = resp.content?.find((c) => c.type === 'text')?.text?.trim() || '(No response)';
          await say({ text, ...reply });
          return;
        }

        await say({
          text: [
            `*${repoData.full_name}*`,
            repoData.description || '',
            repoData.html_url,
            '',
            '*README (first ~20 lines):*',
            readmeText.split('\n').slice(0, 20).join('\n'),
          ].join('\n'),
          ...reply,
        });
        return;
      } catch (err) {
        console.error('GitHub repo summary error:', err?.message || err);
        await brain.recordThreadError(threadKey, { lastError: err?.message || 'repo summary error', lastErrorContext: 'repo:summary' });
        await say({ text: 'I hit an error reading that repo. Check logs.', ...reply });
        return;
      }
    }

    // -------------------- Claude general response fallback --------------------
    if (!anthropic) {
      await say({
        text: "Claude isn\'t configured (`ANTHROPIC_API_KEY` missing). I can still do GitHub summaries (if `GITHUB_TOKEN` is set) or show help: `@OpenClaw help`.",
        ...reply,
      });
      return;
    }

    try {
      const resp = await anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: 800,
        system: 'You are OpenClaw, a helpful assistant in Slack. Be concise and practical. Never reveal secrets.',
        messages: [{ role: 'user', content: cleaned }],
      });

      const text = resp.content?.find((c) => c.type === 'text')?.text?.trim() || '(No response)';
      await say({ text, ...reply });
    } catch (err) {
      console.error('Claude error:', err?.message || err);
      await brain.recordThreadError(threadKey, { lastError: err?.message || 'claude error', lastErrorContext: 'claude:fallback' });
      await say({ text: 'Claude call failed - check logs.', ...reply });
    }
  });

  await app.start();
  console.log('⚡️ OpenClaw Slack bot running (Socket Mode)');
  console.log(
    `Claude: ${anthropic ? 'enabled' : 'disabled'} | GitHub: ${octokit ? 'enabled' : 'disabled'} | ` +
    `GCP: ${gcpEnabled ? 'enabled' : 'disabled'} | GCS: ${getStorageClient() ? 'enabled' : 'disabled'} | ` +
    `Brain: ${brain.enabled ? 'enabled' : 'disabled'}`
  );

  return app;
}

module.exports = { startSlackApp };
