'use strict';

const express = require('express');

const { rateLimitOk } = require('./util/rateLimit');
const {
  parseGitHubPullUrl,
  parseOwnerRepo,
  parseGitHubRepoUrl,
  parseTaskBlock,
  parseKeyVals,
} = require('./util/parse');

const { sandboxFastPR } = require('./agent/sandbox');
const { fetchRepoAndReadme } = require('./github/repo');
const { summarizePullRequest } = require('./github/pr');

function normalizePhone(raw) {
  return String(raw || '').replace(/[^0-9+]/g, '');
}

function phonesMatch(a, b) {
  const na = normalizePhone(a).replace(/^\+?1/, '');
  const nb = normalizePhone(b).replace(/^\+?1/, '');
  return na === nb && na.length >= 10;
}

function helpText() {
  return [
    'OpenClaw can help with:',
    '',
    '• Dev agent (sandbox PRs):',
    '  repo: your-org/your-repo',
    '  task: create a hello world react app',
    '',
    '• GitHub PR summaries:',
    '  summarize https://github.com/ORG/REPO/pull/123',
    '',
    '• Repo info:',
    '  tell me about owner/repo',
    '',
    '• Brain: brain status / brain show / brain reset',
    '',
    '• Email: email check / email search <query> / email read <id> / email send <to> "Subject" Body',
    '',
    '• General questions: just ask!',
  ].join('\n');
}

async function startSmsApp({ config, anthropic, openai, octokit, storage, brain, gmail }) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get('/healthz', (_, res) => res.status(200).send('ok'));

  const twilioClient = require('./clients/twilio').createTwilioClient(
    config.twilio.accountSid,
    config.twilio.authToken,
  );

  if (!twilioClient) {
    throw new Error('Twilio credentials missing (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)');
  }

  const fromNumber = config.twilio.useWhatsApp
    ? `whatsapp:${config.twilio.phoneNumber}`
    : config.twilio.phoneNumber;

  async function sendReply(to, text) {
    // Ensure proper WhatsApp format for the 'to' number
    let toNumber = to;
    if (config.twilio.useWhatsApp) {
      const digits = String(to).replace(/[^0-9+]/g, '');
      toNumber = `whatsapp:${digits.startsWith('+') ? digits : '+' + digits}`;
    }

    const chunks = [];
    const maxLen = 1500;
    let remaining = text;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, maxLen));
      remaining = remaining.slice(maxLen);
    }
    for (const chunk of chunks) {
      await twilioClient.messages.create({
        body: chunk,
        from: fromNumber,
        to: toNumber,
      });
    }
  }

  app.post('/sms', async (req, res) => {
    // Respond immediately to Twilio (avoid timeout)
    res.status(200).type('text/xml').send('<Response></Response>');

    const incomingFrom = req.body.From || '';
    const messageBody = (req.body.Body || '').trim();

    if (!messageBody) return;

    // Allowlist check
    if (config.twilio.allowedNumber && !phonesMatch(incomingFrom, config.twilio.allowedNumber)) {
      await sendReply(incomingFrom, 'Not authorized.');
      return;
    }

    const userKey = `sms:${normalizePhone(incomingFrom)}`;

    if (!rateLimitOk(userKey)) {
      await sendReply(incomingFrom, 'Rate limit: try again in ~30 seconds');
      return;
    }

    const threadKey = brain.threadKeyFromPhone(incomingFrom);
    const threadState = await brain.loadThread(threadKey);
    const lower = messageBody.toLowerCase();

    try {
      // Help
      if (lower === 'help' || lower.includes('what can you do')) {
        await sendReply(incomingFrom, helpText());
        return;
      }

      // Brain status
      if (lower.startsWith('brain status')) {
        await sendReply(incomingFrom,
          `Brain: ${brain.enabled ? 'enabled' : 'disabled'}\n` +
          `Bucket: ${config.gcp.brainBucket || '(missing)'}\n` +
          `Prefix: ${config.gcp.brainPrefix}`
        );
        return;
      }
      if (lower.startsWith('brain show')) {
        const mem = JSON.stringify(threadState || {}, null, 2).slice(0, 1400);
        await sendReply(incomingFrom, `Thread memory:\n${mem}`);
        return;
      }
      if (/^brain\s+last\s+error/i.test(lower)) {
        const err = threadState?.lastError;
        if (!err) {
          await sendReply(incomingFrom, '✅ No recorded error.');
          return;
        }
        await sendReply(incomingFrom,
          `❌ Last error (${threadState?.lastErrorAt || '?'}):\n${err}`
        );
        return;
      }
      if (lower.startsWith('brain reset')) {
        if (!brain.enabled) {
          await sendReply(incomingFrom, 'Brain is disabled (no bucket).');
          return;
        }
        await brain.saveThread(threadKey, {
          clearedAt: new Date().toISOString(),
          lastRepo: null, lastTask: null, lastPrUrl: null,
          lastBranch: null, lastPlan: null, lastError: null,
          lastErrorAt: null, lastErrorJobId: null,
          lastErrorContext: null, lastErrorLogs: null,
          lastClaudeRawSnippet: null,
        });
        await sendReply(incomingFrom, '✅ Brain reset.');
        return;
      }

      // List indexed repos
      if (lower === 'repos' || lower === 'list repos') {
        const repoList = await brain.listRepos();
        if (!repoList.length) {
          await sendReply(incomingFrom, 'No repos indexed yet. Set OPENCLAW_REPOS or wait for auto-discovery.');
          return;
        }
        const list = repoList.map(r => `• ${r.name} (${r.language || '?'})`).join('\n');
        await sendReply(incomingFrom, `📦 Indexed repos:\n${list}`);
        return;
      }

      // PR summary
      const pr = parseGitHubPullUrl(messageBody);
      if (pr) {
        await sendReply(incomingFrom, 'Summarizing that PR...');
        const summary = await summarizePullRequest({
          octokit, anthropic,
          model: config.anthropic.model,
          pr, slackContext: messageBody,
        });
        await brain.saveThread(threadKey, {
          lastPrUrl: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.pull_number}`,
          lastRepo: `${pr.owner}/${pr.repo}`,
        });
        await sendReply(incomingFrom, summary);
        return;
      }

      // Dev agent task block
      const taskBlock = parseTaskBlock(messageBody);
      if (taskBlock) {
        if (!octokit) {
          await sendReply(incomingFrom, 'GitHub not configured (GITHUB_TOKEN missing).');
          return;
        }
        if (!anthropic) {
          await sendReply(incomingFrom, 'Claude not configured (ANTHROPIC_API_KEY missing).');
          return;
        }

        let owner = taskBlock.repoRef?.owner || null;
        let repo = taskBlock.repoRef?.repo || null;

        if ((!owner || !repo) && threadState?.lastRepo) {
          const m = parseOwnerRepo(threadState.lastRepo);
          if (m) { owner = m.owner; repo = m.repo; }
        }

        if (!owner || !repo) {
          await sendReply(incomingFrom, 'I need a repo. Send:\nrepo: owner/repo\ntask: what to do');
          return;
        }

        const sayProgress = async (t) => sendReply(incomingFrom, t);

        const repoMem = await brain.loadRepo(owner, repo);
        const summaryMemory = await brain.loadSummary();

        let repoContext = null;
        try {
          const { repoData, readmeText } = await fetchRepoAndReadme({ octokit, owner, repo });
          let rootPaths = [];
          try {
            const contentResp = await octokit.repos.getContent({ owner, repo, path: '', ref: repoData.default_branch });
            if (Array.isArray(contentResp.data)) rootPaths = contentResp.data.map((i) => i.path);
          } catch { rootPaths = []; }
          repoContext = {
            rootPaths,
            description: repoData.description || '',
            readmeSnippet: readmeText.slice(0, 4000),
          };
        } catch { repoContext = null; }

        await sayProgress(`🧠 Starting sandbox dev job for ${owner}/${repo}...`);
        const result = await sandboxFastPR({
          octokit, anthropic,
          model: config.anthropic.model,
          config, sayProgress,
          threadMemory: threadState || {},
          repoMemory: repoMem || {},
          repoContext, summaryMemory,
          threadKey,
          recordThreadError: brain.recordThreadError,
          owner, repo,
          task: taskBlock.task,
          constraints: taskBlock.constraints,
          acceptance: taskBlock.acceptance,
          context: taskBlock.context,
        });

        if (result.needsClarification) {
          const questions = (result.plan.questions || []).slice(0, 3);
          const msg = [
            '🤔 Before I proceed:',
            '',
            `Understanding: ${result.plan.restatement || '(unclear)'}`,
            '',
            ...questions.map((q, i) => `${i + 1}. ${q}`),
            '',
            'Reply with answers and I\'ll build the PR.',
          ].join('\n');
          await sendReply(incomingFrom, msg);
          return;
        }

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

        await brain.saveSummary({
          repo: `${owner}/${repo}`,
          task: taskBlock.task,
          result: `PR created: ${result.prUrl}`,
          branch: result.branch,
        });

        await sendReply(incomingFrom, `✅ PR created: ${result.prUrl}\nBranch: ${result.branch}`);
        return;
      }

      // Repo summary
      const repoRef = parseGitHubRepoUrl(messageBody) || parseOwnerRepo(messageBody);
      if (repoRef && (lower.startsWith('tell me about') || lower.startsWith('describe') || lower.startsWith('what is'))) {
        if (!octokit) {
          await sendReply(incomingFrom, 'GitHub not configured.');
          return;
        }
        await sendReply(incomingFrom, `Looking up ${repoRef.owner}/${repoRef.repo}...`);
        const { repoData, readmeText } = await fetchRepoAndReadme({ octokit, ...repoRef });
        await brain.saveThread(threadKey, { lastRepo: `${repoRef.owner}/${repoRef.repo}` });

        if (anthropic) {
          const prompt = [
            'Summarize this GitHub repository briefly (for SMS, keep it short).',
            `Repo: ${repoData.full_name}`,
            `Description: ${repoData.description || '(none)'}`,
            `README:\n${readmeText.slice(0, 4000)}`,
          ].join('\n');

          const resp = await anthropic.messages.create({
            model: config.anthropic.model,
            max_tokens: 500,
            system: 'You are OpenClaw. Be very concise — this goes via SMS.',
            messages: [{ role: 'user', content: prompt }],
          });
          const text = resp.content?.find((c) => c.type === 'text')?.text?.trim() || '(No response)';
          await sendReply(incomingFrom, text);
        } else {
          await sendReply(incomingFrom, `${repoData.full_name}\n${repoData.description || ''}\n${repoData.html_url}`);
        }
        return;
      }

      // Gmail commands
      if (gmail && lower.startsWith('email')) {
        const emailCmd = lower.replace(/^email\s*/, '').trim();

        if (emailCmd === 'check' || emailCmd === 'inbox' || emailCmd === '') {
          const msgs = await gmail.listMessages({ maxResults: 5 });
          if (!msgs.length) {
            await sendReply(incomingFrom, '📭 No recent emails.');
            return;
          }
          const lines = msgs.map((m, i) =>
            `${i + 1}. ${m.from.slice(0, 40)}\n   ${m.subject}\n   ${m.date}`
          );
          await sendReply(incomingFrom, `📬 Recent emails:\n\n${lines.join('\n\n')}`);
          return;
        }

        if (emailCmd.startsWith('search ')) {
          const query = emailCmd.replace(/^search\s*/, '').trim();
          const msgs = await gmail.listMessages({ query, maxResults: 5 });
          if (!msgs.length) {
            await sendReply(incomingFrom, `No emails found for: ${query}`);
            return;
          }
          const lines = msgs.map((m, i) =>
            `${i + 1}. ${m.from.slice(0, 40)}\n   ${m.subject}`
          );
          await sendReply(incomingFrom, `📬 Results for "${query}":\n\n${lines.join('\n\n')}`);
          return;
        }

        if (emailCmd.startsWith('read ')) {
          const msgId = emailCmd.replace(/^read\s*/, '').trim();
          const msg = await gmail.readMessage(msgId);
          await sendReply(incomingFrom,
            `📧 From: ${msg.from}\nSubject: ${msg.subject}\nDate: ${msg.date}\n\n${msg.body.slice(0, 1200)}`
          );
          return;
        }

        if (emailCmd.startsWith('send ')) {
          const sendMatch = emailCmd.match(/^send\s+(\S+)\s+"([^"]+)"\s+(.+)$/s);
          if (!sendMatch) {
            await sendReply(incomingFrom, 'Usage: email send user@email.com "Subject" Body text here');
            return;
          }
          await gmail.sendEmail({ to: sendMatch[1], subject: sendMatch[2], body: sendMatch[3] });
          await sendReply(incomingFrom, `✅ Email sent to ${sendMatch[1]}`);
          return;
        }

        await sendReply(incomingFrom,
          'Email commands:\n• email check\n• email search <query>\n• email read <id>\n• email send user@email.com "Subject" Body'
        );
        return;
      }

      // Claude general response fallback
      if (!anthropic) {
        await sendReply(incomingFrom, 'Claude not configured. Send "help" for commands.');
        return;
      }

      // Load conversation history from brain
      const historyKey = `${threadKey}:history`;
      const historyState = await brain.loadThread(historyKey);
      const history = Array.isArray(historyState?.messages) ? historyState.messages : [];

      // Add current message
      history.push({ role: 'user', content: messageBody });

      // Keep last 20 messages to stay within token limits
      const trimmed = history.slice(-20);

      // Build repo context
      const indexedRepos = await brain.listRepos();
      const repoContext = indexedRepos.length
        ? `\nUser's repos:\n${indexedRepos.map(r => `- ${r.name} (${r.language || '?'}): ${r.description || 'no description'}`).join('\n')}`
        : '';

      const systemPrompt = [
        'You are OpenClaw, a helpful assistant via SMS/WhatsApp. Be very concise.',
        'You can create PRs (user sends "repo: owner/repo" + "task: ..."), send emails ("email send ..."), and check brain memory.',
        threadState?.lastRepo ? `User last worked on repo: ${threadState.lastRepo}` : '',
        threadState?.lastTask ? `Last task: ${threadState.lastTask}` : '',
        repoContext,
      ].filter(Boolean).join('\n');

      const resp = await anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: 500,
        system: systemPrompt,
        messages: trimmed,
      });
      const text = resp.content?.find((c) => c.type === 'text')?.text?.trim() || '(No response)';

      // Save assistant reply to history
      trimmed.push({ role: 'assistant', content: text });
      await brain.saveThread(historyKey, { messages: trimmed.slice(-20) });

      await sendReply(incomingFrom, text);

    } catch (err) {
      console.error('SMS handler error:', err?.message || err);
      await brain.recordThreadError(threadKey, {
        lastError: (err?.message || 'unknown error').slice(0, 800),
        lastErrorContext: 'sms:handler',
      });
      await sendReply(incomingFrom, `❌ Error: ${(err?.message || 'unknown').slice(0, 200)}`);
    }
  });

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`⚡️ OpenClaw SMS/WhatsApp server running on port ${config.port}`);
    console.log(
      `Claude: ${anthropic ? 'enabled' : 'disabled'} | GitHub: ${octokit ? 'enabled' : 'disabled'} | ` +
      `Brain: ${brain.enabled ? 'enabled' : 'disabled'} | ` +
      `WhatsApp: ${config.twilio.useWhatsApp ? 'yes' : 'no'} | ` +
      `Allowed number: ${config.twilio.allowedNumber || '(any)'}`
    );
  });

  return app;
}

module.exports = { startSmsApp };
