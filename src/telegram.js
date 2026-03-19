'use strict';

const express = require('express');

const { rateLimitOk } = require('./util/rateLimit');
const {
  parseGitHubPullUrl,
  parseOwnerRepo,
  parseGitHubRepoUrl,
  parseTaskBlock,
} = require('./util/parse');

const { sandboxFastPR } = require('./agent/sandbox');
const { fetchRepoAndReadme } = require('./github/repo');
const { summarizePullRequest } = require('./github/pr');
const {
  parseReservationRequest, buildOpenTableUrl, buildGoogleMapsUrl, formatReservationReply,
  lookupRestaurantPhone, makeReservationCall, waitForCallCompletion, formatCallResult,
} = require('./reservations');
const { runSkillPipeline } = require('./skills');
const { sendDailyRoundup, sendWeeklyRoundup } = require('./roundup');

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}
function log(...args) { console.log(`[${ts()}]`, ...args); }
function logError(...args) { console.error(`[${ts()}]`, ...args); }

const METADATA_BASE = 'http://169.254.169.254/computeMetadata/v1';
const METADATA_HEADERS = { 'Metadata-Flavor': 'Google' };

async function fetchGceMetadata() {
  const [project, zonePath, instance] = await Promise.all([
    fetch(`${METADATA_BASE}/project/project-id`, { headers: METADATA_HEADERS }).then(r => r.text()),
    fetch(`${METADATA_BASE}/instance/zone`, { headers: METADATA_HEADERS }).then(r => r.text()),
    fetch(`${METADATA_BASE}/instance/name`, { headers: METADATA_HEADERS }).then(r => r.text()),
  ]);
  const zone = zonePath.split('/').pop();
  return { project, zone, instance };
}

async function stopGceInstance({ project, zone, instance }) {
  const tokenResp = await fetch(
    `${METADATA_BASE}/instance/service-accounts/default/token`,
    { headers: METADATA_HEADERS },
  );
  const { access_token } = await tokenResp.json();
  const url = `https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${instance}/stop`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Compute API ${resp.status}: ${body}`);
  }
}

async function humanize(anthropic, model, text) {
  try {
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 1000,
      system:
        'Rewrite this email to sound like a real person wrote it. ' +
        'Keep the same meaning, tone, and length. ' +
        'No filler phrases like "I hope this email finds you well." ' +
        'No bullet points unless the original had them. ' +
        'Use natural contractions (I\'m, don\'t, we\'ll). ' +
        'Vary sentence length. Be direct. ' +
        'Do NOT add a sign-off or greeting unless the original had one. ' +
        'Return ONLY the rewritten text, nothing else.',
      messages: [{ role: 'user', content: text }],
    });
    return resp.content?.find(c => c.type === 'text')?.text?.trim() || text;
  } catch {
    return text;
  }
}

function helpText() {
  return [
    '🤖 OpenClaw — here\'s everything I can do:',
    '',
    '📋 Tasks',
    '  todo list',
    '  todo add <task>',
    '  todo done <#>',
    '  todo delete <#>',
    '',
    '📧 Email',
    '  email check',
    '  email search <query>',
    '  email read <id>',
    '  email send user@example.com "Subject" Body text',
    '',
    '📅 Calendar',
    '  cal',
    '  cal list <date>',
    '  cal create "Title" <date> <time> <duration>',
    '  cal update <id> field=value',
    '  cal delete <id>',
    '',
    '🍽️ Reservations',
    '  reserve table for 2 at Nobu on Saturday at 7pm',
    '  call Nobu and reserve a table for 2 on Saturday at 7pm',
    '',
    '📰 Roundup',
    '  roundup — get your daily briefing now',
    '  roundup weekly — get the weekly digest',
    '',
    '🧠 Skills',
    '  skills list',
    '  skills delete <name>',
    '  (or just ask me anything — I learn on the fly!)',
    '',
    '💻 GitHub',
    '  repos',
    '  tell me about owner/repo',
    '  summarize https://github.com/.../pull/123',
    '  repo: owner/repo',
    '  task: describe what you want built',
    '',
    '🧠 Brain',
    '  brain status',
    '  brain last error',
    '  brain reset',
    '',
    '💥 self destruct — shut down the VM',
  ].join('\n');
}

async function startTelegramApp({ config, anthropic, openai, octokit, storage, brain, gmail, calendar, tasks }) {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (_, res) => res.status(200).send('ok'));

  const { createTelegramClient } = require('./clients/telegram');
  const tg = createTelegramClient(config.telegram.botToken);

  if (!tg) {
    throw new Error('Telegram bot token missing (TELEGRAM_BOT_TOKEN)');
  }

  const allowedUserIds = config.telegram.allowedUserIds
    .split(',').map(s => s.trim()).filter(Boolean);

  async function sendReply(chatId, text) {
    try {
      await tg.sendMessage(chatId, text);
    } catch (err) {
      logError(`Telegram send error: ${err.message || err}`);
    }
  }

  async function handleMessage(message) {
    if (!message?.text) return;

    const chatId = message.chat.id;
    const userId = String(message.from.id);
    const messageBody = message.text.trim();

    if (!messageBody) return;

    // Allowlist check
    if (allowedUserIds.length > 0 && !allowedUserIds.includes(userId)) {
      await sendReply(chatId, 'Not authorized.');
      return;
    }

    const userKey = `tg:${userId}`;

    if (!rateLimitOk(userKey)) {
      await sendReply(chatId, 'Rate limit: try again in ~30 seconds');
      return;
    }

    const threadKey = brain.threadKeyFromTelegram(userId);
    const threadState = await brain.loadThread(threadKey);
    const lower = messageBody.toLowerCase();

    // Join code gate — require code before responding to any messages
    const joinCode = config.telegram.joinCode;
    if (joinCode && !threadState?.joined) {
      if (messageBody === joinCode) {
        await brain.saveThread(threadKey, { joined: true, joinedAt: new Date().toISOString(), chatId });
        await brain.saveActiveChat(chatId);
        await sendReply(chatId, '✅ Welcome! Send "help" to see what I can do.');
        return;
      }
      await sendReply(chatId, 'Please send the joining code to get started.');
      return;
    }

    // Track this chat for roundup delivery
    await brain.saveActiveChat(chatId);

    // Strip /start command (Telegram sends this on first interaction)
    if (lower === '/start') {
      await sendReply(chatId, helpText());
      return;
    }

    try {
      // Self-destruct — stop the GCE VM (or exit if not on GCE)
      if (lower === 'self destruct' || lower === 'selfdestruct') {
        await sendReply(chatId, '💥 Self-destructing...');
        log(`Self-destruct triggered by user ${userId}`);
        try {
          const meta = await fetchGceMetadata();
          await stopGceInstance(meta);
          log(`VM stop requested: ${meta.instance} (${meta.zone})`);
        } catch (err) {
          logError('GCE stop failed, forcing process exit:', err?.message || err);
          setTimeout(() => process.exit(1), 500);
        }
        return;
      }

      // Help
      if (lower === 'help' || lower === '/help' || lower.includes('what can you do')) {
        await sendReply(chatId, helpText());
        return;
      }

      // Brain status
      if (lower.startsWith('brain status')) {
        await sendReply(chatId,
          `Brain: ${brain.enabled ? 'enabled' : 'disabled'}\n` +
          `Bucket: ${config.gcp.brainBucket || '(missing)'}\n` +
          `Prefix: ${config.gcp.brainPrefix}`
        );
        return;
      }
      if (lower.startsWith('brain show')) {
        const mem = JSON.stringify(threadState || {}, null, 2).slice(0, 3500);
        await sendReply(chatId, `Thread memory:\n${mem}`);
        return;
      }
      if (/^brain\s+last\s+error/i.test(lower)) {
        const err = threadState?.lastError;
        if (!err) {
          await sendReply(chatId, '✅ No recorded error.');
          return;
        }
        await sendReply(chatId,
          `❌ Last error (${threadState?.lastErrorAt || '?'}):\n${err}`
        );
        return;
      }
      if (lower.startsWith('brain reset')) {
        if (!brain.enabled) {
          await sendReply(chatId, 'Brain is disabled (no bucket).');
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
        await sendReply(chatId, '✅ Brain reset.');
        return;
      }

      // List indexed repos
      if (lower === 'repos' || lower === 'list repos') {
        const repoList = await brain.listRepos();
        if (!repoList.length) {
          await sendReply(chatId, 'No repos indexed yet. Set OPENCLAW_REPOS or wait for auto-discovery.');
          return;
        }
        const list = repoList.map(r => `• ${r.name} (${r.language || '?'})`).join('\n');
        await sendReply(chatId, `📦 Indexed repos:\n${list}`);
        return;
      }

      // PR summary
      const pr = parseGitHubPullUrl(messageBody);
      if (pr) {
        await sendReply(chatId, 'Summarizing that PR...');
        const summary = await summarizePullRequest({
          octokit, anthropic,
          model: config.anthropic.model,
          pr, context: messageBody,
        });
        await brain.saveThread(threadKey, {
          lastPrUrl: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.pull_number}`,
          lastRepo: `${pr.owner}/${pr.repo}`,
        });
        await sendReply(chatId, summary);
        return;
      }

      // Dev agent task block
      const taskBlock = parseTaskBlock(messageBody);
      if (taskBlock) {
        if (!octokit) {
          await sendReply(chatId, 'GitHub not configured (GITHUB_TOKEN missing).');
          return;
        }
        if (!anthropic) {
          await sendReply(chatId, 'Claude not configured (ANTHROPIC_API_KEY missing).');
          return;
        }

        let owner = taskBlock.repoRef?.owner || null;
        let repo = taskBlock.repoRef?.repo || null;

        if ((!owner || !repo) && threadState?.lastRepo) {
          const m = parseOwnerRepo(threadState.lastRepo);
          if (m) { owner = m.owner; repo = m.repo; }
        }

        if (!owner || !repo) {
          await sendReply(chatId, 'I need a repo. Send:\nrepo: owner/repo\ntask: what to do');
          return;
        }

        const sayProgress = async (t) => sendReply(chatId, t);

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
          await sendReply(chatId, msg);
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

        await sendReply(chatId, `✅ PR created: ${result.prUrl}\nBranch: ${result.branch}`);
        return;
      }

      // Repo summary
      const repoRef = parseGitHubRepoUrl(messageBody) || parseOwnerRepo(messageBody);
      if (repoRef && (lower.startsWith('tell me about') || lower.startsWith('describe') || lower.startsWith('what is'))) {
        if (!octokit) {
          await sendReply(chatId, 'GitHub not configured.');
          return;
        }
        await sendReply(chatId, `Looking up ${repoRef.owner}/${repoRef.repo}...`);
        const { repoData, readmeText } = await fetchRepoAndReadme({ octokit, ...repoRef });
        await brain.saveThread(threadKey, { lastRepo: `${repoRef.owner}/${repoRef.repo}` });

        if (anthropic) {
          const prompt = [
            'Summarize this GitHub repository briefly.',
            `Repo: ${repoData.full_name}`,
            `Description: ${repoData.description || '(none)'}`,
            `README:\n${readmeText.slice(0, 4000)}`,
          ].join('\n');

          const resp = await anthropic.messages.create({
            model: config.anthropic.model,
            max_tokens: 500,
            system: 'You are OpenClaw. Be concise.',
            messages: [{ role: 'user', content: prompt }],
          });
          const text = resp.content?.find((c) => c.type === 'text')?.text?.trim() || '(No response)';
          await sendReply(chatId, text);
        } else {
          await sendReply(chatId, `${repoData.full_name}\n${repoData.description || ''}\n${repoData.html_url}`);
        }
        return;
      }

      // Gmail commands
      if (gmail && lower.startsWith('email')) {
        const emailCmd = lower.replace(/^email\s*/, '').trim();
        const emailCmdRaw = messageBody.replace(/^email\s*/i, '').trim();

        if (emailCmd === 'check' || emailCmd === 'inbox' || emailCmd === '') {
          const msgs = await gmail.listMessages({ maxResults: 5 });
          if (!msgs.length) {
            await sendReply(chatId, '📭 No recent emails.');
            return;
          }
          const lines = msgs.map((m, i) =>
            `${i + 1}. ${m.from.slice(0, 40)}\n   ${m.subject}\n   ${m.date}`
          );
          await sendReply(chatId, `📬 Recent emails:\n\n${lines.join('\n\n')}`);
          return;
        }

        if (emailCmd.startsWith('search ')) {
          const query = emailCmd.replace(/^search\s*/, '').trim();
          const msgs = await gmail.listMessages({ query, maxResults: 5 });
          if (!msgs.length) {
            await sendReply(chatId, `No emails found for: ${query}`);
            return;
          }
          const lines = msgs.map((m, i) =>
            `${i + 1}. ${m.from.slice(0, 40)}\n   ${m.subject}`
          );
          await sendReply(chatId, `📬 Results for "${query}":\n\n${lines.join('\n\n')}`);
          return;
        }

        if (emailCmd.startsWith('read ')) {
          const msgId = emailCmd.replace(/^read\s*/, '').trim();
          const msg = await gmail.readMessage(msgId);
          await sendReply(chatId,
            `📧 From: ${msg.from}\nSubject: ${msg.subject}\nDate: ${msg.date}\n\n${msg.body.slice(0, 3500)}`
          );
          return;
        }

        if (emailCmd.startsWith('send ')) {
          const sendMatch = emailCmdRaw.match(/^send\s+(\S+)\s+["\u201c\u201e\u00ab]([^"\u201d\u201f\u00bb]+)["\u201d\u201f\u00bb]\s+(.+)$/is);
          if (!sendMatch) {
            await sendReply(chatId, 'Usage: email send user@email.com "Subject" Body text here');
            return;
          }
          let body = sendMatch[3];
          if (anthropic) {
            body = await humanize(anthropic, config.anthropic.model, body);
          }
          await gmail.sendEmail({ to: sendMatch[1], subject: sendMatch[2], body });
          await sendReply(chatId, `✅ Email sent to ${sendMatch[1]}`);
          return;
        }

        await sendReply(chatId,
          'Email commands:\n• email check\n• email search <query>\n• email read <id>\n• email send user@email.com "Subject" Body'
        );
        return;
      }

      // Reservations — "call" makes a phone call, "reserve/book" gives OpenTable link
      if (lower.startsWith('call') && /\breserv|table|dinner|lunch|brunch|book/i.test(lower)) {
        if (!anthropic) {
          await sendReply(chatId, 'Claude not configured (ANTHROPIC_API_KEY missing).');
          return;
        }
        const rc = config.reservations;
        if (!rc.blandApiKey) {
          await sendReply(chatId, 'Phone calls not configured (BLAND_API_KEY missing). Try "reserve" instead for an OpenTable link.');
          return;
        }

        await sendReply(chatId, '🍽️ Parsing your request...');
        const details = await parseReservationRequest(anthropic, config.anthropic.model, messageBody);
        if (!details || !details.restaurant) {
          await sendReply(chatId, 'I couldn\'t parse that. Try:\ncall Nobu Chicago and reserve a table for 2 on Saturday at 7pm');
          return;
        }
        if (!details.date || !details.time) {
          await sendReply(chatId, `I found "${details.restaurant}" but need a date and time. Try:\ncall ${details.restaurant} and reserve for ${details.partySize || 2} on Saturday at 7pm`);
          return;
        }

        // Find phone number: from message, then Google Places, then ask user
        let phone = details.phone;
        if (!phone && rc.placesApiKey) {
          await sendReply(chatId, `📞 Looking up ${details.restaurant}...`);
          const place = await lookupRestaurantPhone(rc.placesApiKey, details.restaurant, details.city);
          if (place?.phone) {
            phone = place.phone;
            await sendReply(chatId, `Found: ${place.name}\n${place.address}\n📞 ${place.phone}`);
          }
        }
        if (!phone) {
          await sendReply(chatId, `I couldn't find a phone number for ${details.restaurant}. Please include it:\ncall +1234567890 and reserve a table for 2 at ${details.restaurant} on ${details.date} at ${details.time}`);
          return;
        }

        details.phone = phone;
        await sendReply(chatId, `📞 Calling ${details.restaurant} at ${phone}...\nThis may take a minute or two.`);

        try {
          const callId = await makeReservationCall(rc.blandApiKey, {
            phone,
            restaurant: details.restaurant,
            date: details.date,
            time: details.time,
            partySize: details.partySize,
            callerName: rc.callerName,
          });

          await sendReply(chatId, '📞 Call in progress...');
          const result = await waitForCallCompletion(rc.blandApiKey, callId);
          await sendReply(chatId, formatCallResult(details, result));
        } catch (err) {
          logError('Reservation call error:', err?.message || err);
          await sendReply(chatId, `❌ Call failed: ${(err?.message || 'unknown error').slice(0, 200)}`);
        }
        return;
      }

      if (lower.startsWith('reserve') || lower.startsWith('book') || lower.startsWith('reservation')) {
        if (!anthropic) {
          await sendReply(chatId, 'Claude not configured (ANTHROPIC_API_KEY missing).');
          return;
        }
        await sendReply(chatId, '🍽️ Finding that restaurant...');
        const details = await parseReservationRequest(anthropic, config.anthropic.model, messageBody);
        if (!details || !details.restaurant) {
          await sendReply(chatId, 'I couldn\'t parse that. Try:\nreserve table for 2 at Nobu in Chicago on Saturday at 7pm');
          return;
        }
        if (!details.date || !details.time) {
          await sendReply(chatId, `I found "${details.restaurant}" but need a date and time. Try:\nreserve ${details.restaurant} for ${details.partySize || 2} on Saturday at 7pm`);
          return;
        }
        const openTableUrl = buildOpenTableUrl(details);
        const mapsUrl = buildGoogleMapsUrl(details);
        await sendReply(chatId, formatReservationReply(details, openTableUrl, mapsUrl));
        return;
      }

      // Todo commands (Google Tasks)
      if (lower.startsWith('todo')) {
        if (!tasks?.enabled) {
          await sendReply(chatId, 'Google Tasks not configured. Set up Gmail OAuth with the Tasks scope.');
          return;
        }

        const todoCmd = lower.replace(/^todo\s*/, '').trim();
        const todoCmdRaw = messageBody.replace(/^todo\s*/i, '').trim();

        // Resolve a user-provided ID: if it's a small number, look up the real
        // Google Task ID from the last listed items saved in thread state.
        async function resolveTodoId(input) {
          const num = parseInt(input, 10);
          if (!isNaN(num) && String(num) === input && num >= 1) {
            const state = await brain.loadThread(threadKey);
            const map = state?.todoIdMap;
            if (map && map[num]) return map[num];
          }
          return input; // fall back to raw ID
        }

        if (todoCmd === '' || todoCmd === 'list' || todoCmd === 'show') {
          const items = await tasks.listTasks();
          if (!items.length) {
            await sendReply(chatId, '✅ No todos! You\'re all caught up.');
            return;
          }
          // Save number→ID mapping so user can say "todo done 2"
          const todoIdMap = {};
          items.forEach((t, i) => { todoIdMap[i + 1] = t.id; });
          await brain.saveThread(threadKey, { todoIdMap });

          const lines = items.map((t, i) =>
            `${i + 1}. ${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ''}${t.notes ? `\n   ${t.notes.slice(0, 100)}` : ''}`
          );
          await sendReply(chatId, `📋 Todos:\n\n${lines.join('\n\n')}`);
          return;
        }

        if (todoCmd.startsWith('add ')) {
          const title = todoCmdRaw.replace(/^add\s*/i, '').trim();
          if (!title) {
            await sendReply(chatId, 'Usage: todo add Buy groceries');
            return;
          }
          const result = await tasks.addTask({ title });
          await sendReply(chatId, `✅ Added: ${result.title}`);
          return;
        }

        if (todoCmd.startsWith('done ')) {
          const input = todoCmd.replace(/^done\s*/, '').trim();
          const taskId = await resolveTodoId(input);
          const result = await tasks.completeTask(taskId);
          await sendReply(chatId, `✅ Completed: ${result.title}`);
          return;
        }

        if (todoCmd.startsWith('delete ') || todoCmd.startsWith('remove ')) {
          const input = todoCmd.replace(/^(?:delete|remove)\s*/, '').trim();
          const taskId = await resolveTodoId(input);
          await tasks.deleteTask(taskId);
          await sendReply(chatId, '✅ Todo deleted.');
          return;
        }

        await sendReply(chatId,
          'Todo commands:\n• todo list\n• todo add <task>\n• todo done <id>\n• todo delete <id>'
        );
        return;
      }

      // Skills management
      if (lower.startsWith('skills') || lower === 'skill list') {
        const skillCmd = lower.replace(/^skills?\s*/, '').trim();

        if (skillCmd === '' || skillCmd === 'list' || skillCmd === 'show') {
          const skills = await brain.loadSkills();
          if (!skills.length) {
            await sendReply(chatId, '🧠 No learned skills yet. Just ask me to do something and I\'ll learn!');
            return;
          }
          const lines = skills.map((s, i) =>
            `${i + 1}. ${s.name}\n   ${s.description}${s.successCount ? ` (used ${s.successCount}x)` : ''}`
          );
          await sendReply(chatId, `🧠 Learned skills:\n\n${lines.join('\n\n')}`);
          return;
        }

        if (skillCmd.startsWith('delete ') || skillCmd.startsWith('remove ')) {
          const name = skillCmd.replace(/^(?:delete|remove)\s*/, '').trim();
          await brain.deleteSkill(name);
          await sendReply(chatId, `✅ Skill "${name}" deleted.`);
          return;
        }

        await sendReply(chatId, 'Skill commands:\n• skills list\n• skills delete <name>');
        return;
      }

      // Roundup commands — send test digests
      if (lower.startsWith('roundup')) {
        const roundupCmd = lower.replace(/^roundup\s*/, '').trim();
        const deps = { config, anthropic, gmail, calendar, tasks, brain };

        if (roundupCmd.startsWith('add ')) {
          const topic = messageBody.replace(/^roundup\s+add\s+/i, '').trim();
          if (!topic) { await sendReply(chatId, 'Usage: roundup add <topic>'); return; }
          const topics = await brain.loadRoundupTopics();
          if (topics.includes(topic.toLowerCase())) {
            await sendReply(chatId, `"${topic}" is already in your roundup.`);
            return;
          }
          topics.push(topic.toLowerCase());
          await brain.saveRoundupTopics(topics);
          await sendReply(chatId, `✅ Added "${topic}" to your daily roundup.`);
          return;
        }

        if (roundupCmd.startsWith('remove ') || roundupCmd.startsWith('delete ')) {
          const topic = messageBody.replace(/^roundup\s+(?:remove|delete)\s+/i, '').trim().toLowerCase();
          if (!topic) { await sendReply(chatId, 'Usage: roundup remove <topic>'); return; }
          const topics = await brain.loadRoundupTopics();
          const filtered = topics.filter(t => t !== topic);
          if (filtered.length === topics.length) {
            await sendReply(chatId, `"${topic}" wasn't in your roundup.`);
            return;
          }
          await brain.saveRoundupTopics(filtered);
          await sendReply(chatId, `✅ Removed "${topic}" from your daily roundup.`);
          return;
        }

        if (roundupCmd === 'topics' || roundupCmd === 'list') {
          const brainTopics = await brain.loadRoundupTopics();
          const envTopics = (config.roundup.dailyTopics || '').split(',').map(s => s.trim()).filter(Boolean);
          const all = [...new Set([...envTopics, ...brainTopics])];
          if (!all.length) { await sendReply(chatId, 'No roundup topics configured.'); return; }
          await sendReply(chatId, `📰 Roundup topics:\n\n${all.map(t => `• ${t}`).join('\n')}`);
          return;
        }

        if (roundupCmd === 'daily' || roundupCmd === 'test' || roundupCmd === '') {
          await sendReply(chatId, '📰 Sending daily roundup...');
          try {
            await sendDailyRoundup(deps);
            await sendReply(chatId, '✅ Daily roundup sent! Check your email.');
          } catch (err) {
            await sendReply(chatId, `❌ Daily roundup failed: ${(err?.message || 'unknown').slice(0, 300)}`);
          }
          return;
        }

        if (roundupCmd === 'weekly') {
          await sendReply(chatId, '📰 Sending weekly roundup...');
          try {
            await sendWeeklyRoundup(deps);
            await sendReply(chatId, '✅ Weekly roundup sent! Check your email.');
          } catch (err) {
            await sendReply(chatId, `❌ Weekly roundup failed: ${(err?.message || 'unknown').slice(0, 300)}`);
          }
          return;
        }

        await sendReply(chatId, 'Roundup commands:\n• roundup — send daily digest now\n• roundup weekly — send weekly digest\n• roundup topics — see current topics\n• roundup add <topic> — add a topic\n• roundup remove <topic> — remove a topic');
        return;
      }

      // Calendar commands
      if (calendar && lower.startsWith('cal')) {
        const calCmd = lower.replace(/^cal\s*/, '').trim();
        const calCmdRaw = messageBody.replace(/^cal\s*/i, '').trim();

        if (calCmd === '' || calCmd === 'list' || calCmd === 'today') {
          const events = await calendar.listEvents();
          if (!events.length) {
            await sendReply(chatId, '📅 No events today.');
            return;
          }
          await sendReply(chatId, `📅 Today's events:\n\n${events.map(e => e.formatted).join('\n\n')}`);
          return;
        }

        if (calCmd.startsWith('list ')) {
          const arg = calCmd.replace(/^list\s*/, '').trim();
          let timeMin, timeMax;
          if (arg === 'week') {
            const now = new Date();
            timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
            timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).toISOString();
          } else {
            const dateStr = calendar.resolveDate(arg);
            timeMin = new Date(`${dateStr}T00:00:00`).toISOString();
            timeMax = new Date(`${dateStr}T23:59:59`).toISOString();
          }
          const events = await calendar.listEvents({ timeMin, timeMax });
          if (!events.length) {
            await sendReply(chatId, `📅 No events for ${arg}.`);
            return;
          }
          await sendReply(chatId, `📅 Events (${arg}):\n\n${events.map(e => e.formatted).join('\n\n')}`);
          return;
        }

        if (calCmd.startsWith('get ')) {
          const eventId = calCmd.replace(/^get\s*/, '').trim();
          const ev = await calendar.getEvent(eventId);
          await sendReply(chatId, `📅 ${ev.formatted}\n${ev.htmlLink || ''}`);
          return;
        }

        if (calCmd.startsWith('create ')) {
          // Flexible regex: title in quotes, date (any format), time (any format), then rest (duration + extras)
          const createMatch = calCmdRaw.match(/^create\s+["\u201c\u201e\u00ab]([^"\u201d\u201f\u00bb]+)["\u201d\u201f\u00bb]\s+(\S+)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(.+)$/is);
          if (!createMatch) {
            await sendReply(chatId, 'Usage: cal create "Title" <date> <time> <duration>\nExamples:\n• cal create "Dentist" 03/19 2pm 1 hour\n• cal create "Lunch" tomorrow 12:30pm 1h30m');
            return;
          }
          const [, title, date, time, remainder] = createMatch;
          // Extract duration from the front of remainder, leaving attendees/location behind
          const { minutes, rest } = calendar.extractDuration(remainder);
          const locMatch = (rest || '').match(/location\s*:\s*["\u201c]([^"\u201d]+)["\u201d]/i);
          const location = locMatch ? locMatch[1] : '';
          const attendeePart = (rest || '').replace(/location\s*:\s*["\u201c][^"\u201d]*["\u201d]/i, '').trim();
          const attendees = attendeePart ? attendeePart.split(',').map(s => s.trim()).filter(Boolean) : [];

          const result = await calendar.createEvent({ summary: title, date, time, duration: `${minutes}m`, attendees, location });
          await sendReply(chatId, `✅ Event created: ${result.summary}\n${result.htmlLink || ''}`);
          return;
        }

        if (calCmd.startsWith('update ')) {
          const parts = calCmdRaw.replace(/^update\s*/i, '').trim().split(/\s+/);
          const eventId = parts[0];
          if (!eventId || parts.length < 2) {
            await sendReply(chatId, 'Usage: cal update <eventId> title="New Title" time=14:00 date=2026-03-15 duration=1h location="Room"');
            return;
          }
          const updates = {};
          const kvStr = parts.slice(1).join(' ');
          const kvMatches = kvStr.matchAll(/(\w+)\s*=\s*["\u201c]([^"\u201d]+)["\u201d]|(\w+)\s*=\s*(\S+)/g);
          for (const m of kvMatches) {
            const key = m[1] || m[3];
            const val = m[2] || m[4];
            if (key === 'title') updates.summary = val;
            else if (key === 'attendees') updates.attendees = val.split(',').map(s => s.trim());
            else updates[key] = val;
          }
          const result = await calendar.updateEvent(eventId, updates);
          await sendReply(chatId, `✅ Event updated: ${result.summary}\n${result.htmlLink || ''}`);
          return;
        }

        if (calCmd.startsWith('delete ')) {
          const eventId = calCmd.replace(/^delete\s*/, '').trim();
          await calendar.deleteEvent(eventId);
          await sendReply(chatId, `✅ Event deleted.`);
          return;
        }

        await sendReply(chatId,
          'Calendar commands:\n• cal / cal list / cal list <date> / cal list week\n• cal get <id>\n• cal create "Title" <date> <time> <duration> [attendees]\n• cal update <id> field=value\n• cal delete <id>'
        );
        return;
      }

      // ── Natural language intent router ─────────────────────────────
      // If the message didn't match any rigid command, ask Claude to
      // classify it as a built-in action before falling through to skills/chat.
      if (anthropic) {
        try {
          const intentResp = await anthropic.messages.create({
            model: config.anthropic.model,
            max_tokens: 300,
            system:
              'You route natural-language messages to built-in commands for a Telegram bot. ' +
              'Return ONLY valid JSON. Pick the matching intent or return {"intent":"none"}.\n\n' +
              'Intents:\n' +
              '• {"intent":"email_check"} — user wants to see inbox/recent emails\n' +
              '• {"intent":"email_search","query":"search terms"} — search emails\n' +
              '• {"intent":"email_send","to":"addr","subject":"subj","body":"text"} — send an email\n' +
              '• {"intent":"todo_list"} — list todos\n' +
              '• {"intent":"todo_add","title":"task text"} — add a todo\n' +
              '• {"intent":"todo_done","index":"number"} — complete a todo by its list number\n' +
              '• {"intent":"todo_delete","index":"number"} — delete a todo by its list number\n' +
              '• {"intent":"cal_list","date":"date or empty"} — list calendar events\n' +
              '• {"intent":"cal_create","title":"t","date":"d","time":"t","duration":"d","location":"optional","attendees":"optional comma-sep emails"} — create event\n' +
              '• {"intent":"none"} — doesn\'t match any built-in action',
            messages: [{ role: 'user', content: messageBody }],
          });
          const intentRaw = intentResp.content?.find(c => c.type === 'text')?.text?.trim() || '';
          const intent = JSON.parse(intentRaw);

          if (intent.intent === 'email_check' && gmail) {
            const msgs = await gmail.listMessages({ maxResults: 5 });
            if (!msgs.length) { await sendReply(chatId, '📭 No recent emails.'); return; }
            const lines = msgs.map((m, i) => `${i + 1}. ${m.from.slice(0, 40)}\n   ${m.subject}\n   ${m.date}`);
            await sendReply(chatId, `📬 Recent emails:\n\n${lines.join('\n\n')}`);
            return;
          }
          if (intent.intent === 'email_search' && gmail && intent.query) {
            const msgs = await gmail.listMessages({ query: intent.query, maxResults: 5 });
            if (!msgs.length) { await sendReply(chatId, `No emails found for: ${intent.query}`); return; }
            const lines = msgs.map((m, i) => `${i + 1}. ${m.from.slice(0, 40)}\n   ${m.subject}`);
            await sendReply(chatId, `📬 Results for "${intent.query}":\n\n${lines.join('\n\n')}`);
            return;
          }
          if (intent.intent === 'email_send' && gmail && intent.to && intent.subject && intent.body) {
            let body = intent.body;
            body = await humanize(anthropic, config.anthropic.model, body);
            await gmail.sendEmail({ to: intent.to, subject: intent.subject, body });
            await sendReply(chatId, `✅ Email sent to ${intent.to}`);
            return;
          }
          if (intent.intent === 'todo_list' && tasks?.enabled) {
            const items = await tasks.listTasks();
            if (!items.length) { await sendReply(chatId, '✅ No todos! You\'re all caught up.'); return; }
            const todoIdMap = {};
            items.forEach((t, i) => { todoIdMap[i + 1] = t.id; });
            await brain.saveThread(threadKey, { todoIdMap });
            const lines = items.map((t, i) => `${i + 1}. ${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ''}`);
            await sendReply(chatId, `📋 Todos:\n\n${lines.join('\n\n')}`);
            return;
          }
          if (intent.intent === 'todo_add' && tasks?.enabled && intent.title) {
            const result = await tasks.addTask({ title: intent.title });
            await sendReply(chatId, `✅ Added: ${result.title}`);
            return;
          }
          if ((intent.intent === 'todo_done' || intent.intent === 'todo_delete') && tasks?.enabled && intent.index) {
            const num = parseInt(intent.index, 10);
            let taskId = intent.index;
            if (!isNaN(num) && num >= 1) {
              const state = await brain.loadThread(threadKey);
              if (state?.todoIdMap?.[num]) taskId = state.todoIdMap[num];
            }
            if (intent.intent === 'todo_done') {
              const result = await tasks.completeTask(taskId);
              await sendReply(chatId, `✅ Completed: ${result.title}`);
            } else {
              await tasks.deleteTask(taskId);
              await sendReply(chatId, '✅ Todo deleted.');
            }
            return;
          }
          if (intent.intent === 'cal_list' && calendar) {
            let events;
            if (intent.date && intent.date !== '') {
              const dateStr = calendar.resolveDate(intent.date);
              const timeMin = new Date(`${dateStr}T00:00:00`).toISOString();
              const timeMax = new Date(`${dateStr}T23:59:59`).toISOString();
              events = await calendar.listEvents({ timeMin, timeMax });
            } else {
              events = await calendar.listEvents();
            }
            if (!events.length) { await sendReply(chatId, '📅 No events found.'); return; }
            await sendReply(chatId, `📅 Events:\n\n${events.map(e => e.formatted).join('\n\n')}`);
            return;
          }
          if (intent.intent === 'cal_create' && calendar && intent.title && intent.date && intent.time) {
            const attendees = intent.attendees ? intent.attendees.split(',').map(s => s.trim()).filter(Boolean) : [];
            const result = await calendar.createEvent({
              summary: intent.title, date: intent.date, time: intent.time,
              duration: intent.duration || '1h', attendees, location: intent.location || '',
            });
            await sendReply(chatId, `✅ Event created: ${result.summary}\n${result.htmlLink || ''}`);
            return;
          }
          // intent === 'none' → fall through to skill pipeline / chat
        } catch (intentErr) {
          // Intent parsing failed — fall through silently
          log('Intent router error (falling through):', intentErr?.message || intentErr);
        }
      }

      // Claude general response fallback — with skill generation
      if (!anthropic) {
        await sendReply(chatId, 'Claude not configured. Send "help" for commands.');
        return;
      }

      // Try skill pipeline first (classify → match/generate → execute → verify → heal)
      try {
        const skillResult = await runSkillPipeline({
          anthropic,
          model: config.anthropic.model,
          brain,
          threadKey,
          userMessage: messageBody,
        });

        if (skillResult) {
          let reply = skillResult.result;
          if (skillResult.healed) reply = `🩹 (self-healed)\n\n${reply}`;
          if (!skillResult.reused) reply = `🧠 Learned: ${skillResult.skill.name}\n\n${reply}`;
          await sendReply(chatId, reply);
          return;
        }
      } catch (skillErr) {
        logError('Skill pipeline error (falling back to chat):', skillErr?.message || skillErr);
      }

      // Fall through to conversational chat
      const historyKey = `${threadKey}:history`;
      const historyState = await brain.loadThread(historyKey);
      const history = Array.isArray(historyState?.messages) ? historyState.messages : [];

      history.push({ role: 'user', content: messageBody });
      const trimmed = history.slice(-20);

      const indexedRepos = await brain.listRepos();
      const repoContext = indexedRepos.length
        ? `\nUser's repos:\n${indexedRepos.map(r => `- ${r.name} (${r.language || '?'}): ${r.description || 'no description'}`).join('\n')}`
        : '';

      const systemPrompt = [
        'You are OpenClaw, a helpful assistant via Telegram. Be concise.',
        'You can create PRs (user sends "repo: owner/repo" + "task: ..."), send emails ("email send ..."), manage calendar ("cal ..."), manage todos ("todo list/add/done/delete"), and check brain memory.',
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

      trimmed.push({ role: 'assistant', content: text });
      await brain.saveThread(historyKey, { messages: trimmed.slice(-20) });

      await sendReply(chatId, text);

    } catch (err) {
      logError('Telegram handler error:', err?.message || err);
      await brain.recordThreadError(threadKey, {
        lastError: (err?.message || 'unknown error').slice(0, 800),
        lastErrorContext: 'telegram:handler',
      });
      await sendReply(chatId, `❌ Error: ${(err?.message || 'unknown').slice(0, 200)}`);
    }
  }

  // Start polling for messages
  tg.startPolling((message) => {
    handleMessage(message).catch(err => logError('Unhandled message error:', err?.message || err));
  });

  app.listen(config.port, '0.0.0.0', () => {
    log(`⚡️ OpenClaw Telegram server running on port ${config.port} (polling mode)`);
    log(
      `Claude: ${anthropic ? 'enabled' : 'disabled'} | GitHub: ${octokit ? 'enabled' : 'disabled'} | ` +
      `Brain: ${brain.enabled ? 'enabled' : 'disabled'} | ` +
      `Allowed users: ${config.telegram.allowedUserIds || '(any)'}`
    );
  });

  return app;
}

module.exports = { startTelegramApp };
