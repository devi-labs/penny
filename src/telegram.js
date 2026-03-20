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
const { handleLearnCommand, handleChallengeResponse, learnHelpText } = require('./learn');
const { matchIntent, extractDueDate } = require('./matchers');

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
    '👋 Here\'s what I can help you with:',
    '',
    '📋 To-Do List — "what\'s on my plate?" or "remind me to..."',
    '📅 Calendar — "what\'s on my schedule?" or "any meetings tomorrow?"',
    '📧 Email — "check my email" or "send an email to..."',
    '🎓 Learn — "learn" to start coding lessons',
    '📰 Roundup — "catch me up" for your daily briefing',
    '🍽️ Reservations — "book a table for 2 at Nobu Saturday 7pm"',
    '💻 GitHub — create tasks and PRs from chat',
    '',
    'Just talk to me naturally! I understand most things.',
    '',
    'Type "todo help", "cal help", "email help", "learn help",',
    '"roundup help", "reserve help", or "github help" for details.',
    '',
    'Having issues? Type "support" and I\'ll get help for you.',
  ].join('\n');
}

function todoHelpText() {
  return [
    '📋 To-Do List Commands:',
    '',
    '  todo list — show tasks from your default list',
    '  todo list <name or #> — show tasks from a specific list',
    '  todo all — show all your task lists',
    '  todo add <task> — add to default list',
    '  todo add <task> list <name> — add to a specific list',
    '  todo add <task> by <date> — add with a due date',
    '  todo done <#> — mark a task as done',
    '  todo delete <#> — remove a task',
    '',
    'Or just say things like:',
    '  "remind me to call Bob"',
    '  "what\'s on my plate?"',
    '  "mark 3 as done"',
    '  "add buy groceries to my list by Friday"',
  ].join('\n');
}

function calHelpText() {
  return [
    '📅 Calendar Commands:',
    '',
    '  cal — today\'s events',
    '  cal list tomorrow — events for a specific day',
    '  cal list week — this week\'s events',
    '  cal calendars — see all your calendars',
    '  cal default <#> — set your default calendar',
    '  cal create "Title" <date> <time> <duration>',
    '  cal update <#> title="New Title" time=3pm',
    '  cal delete <#>',
    '',
    'Or just say things like:',
    '  "what\'s on my schedule today?"',
    '  "any meetings tomorrow?"',
    '  "schedule a meeting for Friday at 2pm"',
    '  "am I free on Monday?"',
  ].join('\n');
}

function emailHelpText() {
  return [
    '📧 Email Commands:',
    '',
    '  email check — show recent emails',
    '  email search <query> — search your inbox',
    '  email read <id> — read a full email',
    '  email send user@email.com "Subject" Body text',
    '',
    'Or just say things like:',
    '  "any new emails?"',
    '  "find emails from Sarah"',
    '  "send an email to bob@example.com about the meeting"',
    '',
    'Emails are previewed before sending — reply "send" to confirm.',
  ].join('\n');
}

function roundupHelpText() {
  return [
    '📰 Roundup Commands:',
    '',
    '  roundup — get your daily briefing now',
    '  roundup weekly — get the weekly digest',
    '  roundup topics — see your topics & Twitter handles',
    '  roundup add <topic> — add a news topic',
    '  roundup remove <topic> — remove a topic',
    '  roundup follow <handle> — follow a Twitter account',
    '  roundup unfollow <handle> — unfollow',
    '',
    'Or just say: "catch me up", "what\'s the news", "give me my briefing"',
    '',
    'Your daily roundup includes calendar, todos, tweets, and news.',
    'It\'s sent automatically every morning via Telegram.',
  ].join('\n');
}

function reserveHelpText() {
  return [
    '🍽️ Reservation Commands:',
    '',
    'Just tell me what you need:',
    '  "book a table for 2 at Nobu on Saturday at 7pm"',
    '  "make a reservation at The French Laundry for 4"',
    '  "dinner for 6 at Carbone tomorrow"',
    '',
    'I\'ll get you an OpenTable booking link.',
    '',
    'Want me to call the restaurant instead?',
    '  "call Nobu and reserve a table for 2 on Saturday at 7pm"',
  ].join('\n');
}

function githubHelpText() {
  return [
    '💻 GitHub Commands:',
    '',
    '  repos — list your indexed repos',
    '  tell me about owner/repo — get a repo summary',
    '  summarize <PR URL> — summarize a pull request',
    '',
    'To create a PR, send:',
    '  repo: owner/repo',
    '  task: describe what you want built',
    '',
    'I\'ll clone the repo, write the code, and open a PR for you.',
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

  async function sendReply(chatId, text, { saveToHistory = true } = {}) {
    try {
      await tg.sendMessage(chatId, text);
      // Save bot response to message history for support/debug
      if (saveToHistory && brain && chatId) {
        const tk = brain.threadKeyFromTelegram(chatId);
        const state = (await brain.loadThread(tk)) || {};
        const msgs = Array.isArray(state.messages) ? state.messages : [];
        msgs.push({ role: 'assistant', content: text.slice(0, 1000), at: new Date().toISOString() });
        await brain.saveThread(tk, { messages: msgs.slice(-20) });
      }
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

    // Save every user message for support/debug history
    const existingState = threadState || {};
    const msgHistory = Array.isArray(existingState.messages) ? existingState.messages : [];
    msgHistory.push({ role: 'user', content: messageBody, at: new Date().toISOString() });
    await brain.saveThread(threadKey, { messages: msgHistory.slice(-20) });

    // ── Pending email confirmation ───────────────────────────────
    if (threadState?.pendingEmail && (lower === 'send' || lower === 'yes' || lower === 'confirm')) {
      const { to, subject, body } = threadState.pendingEmail;
      try {
        await gmail.sendEmail({ to, subject, body });
        await brain.saveThread(threadKey, { pendingEmail: null });
        await sendReply(chatId, `✅ Email sent to ${to}`);
      } catch (err) {
        await sendReply(chatId, `❌ Email send failed: ${(err?.message || 'unknown').slice(0, 200)}`);
      }
      return;
    }
    if (threadState?.pendingEmail && (lower === 'cancel' || lower === 'no' || lower === 'discard' || lower === 'nevermind')) {
      await brain.saveThread(threadKey, { pendingEmail: null });
      await sendReply(chatId, '✅ Email discarded.');
      return;
    }

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

      // Help — main and drill-down
      if (lower === 'help' || lower === '/help' || lower === '/start') {
        await sendReply(chatId, helpText());
        return;
      }
      if (lower === 'todo help' || lower === 'task help' || lower === 'tasks help') {
        await sendReply(chatId, todoHelpText());
        return;
      }
      if (lower === 'cal help' || lower === 'calendar help') {
        await sendReply(chatId, calHelpText());
        return;
      }
      if (lower === 'email help' || lower === 'mail help') {
        await sendReply(chatId, emailHelpText());
        return;
      }
      if (lower === 'roundup help' || lower === 'news help') {
        await sendReply(chatId, roundupHelpText());
        return;
      }
      if (lower === 'reserve help' || lower === 'reservation help' || lower === 'restaurant help') {
        await sendReply(chatId, reserveHelpText());
        return;
      }
      if (lower === 'github help' || lower === 'repo help' || lower === 'pr help') {
        await sendReply(chatId, githubHelpText());
        return;
      }
      if (lower === 'learn help' || lower === 'coding help' || lower === 'lesson help') {
        await sendReply(chatId, learnHelpText());
        return;
      }

      // ── Admin support ──────────────────────────────────────────────
      // User types the support keyword → sends last 10 messages to admin
      if (config.telegram.adminUserId && lower === config.telegram.supportKeyword.toLowerCase()) {
        const adminChatId = config.telegram.adminUserId;
        const state = await brain.loadThread(threadKey);
        const history = state?.messages || [];
        const last10 = history.slice(-10);

        if (!last10.length) {
          await sendReply(chatId, '📩 Support request sent! Someone will check in with you.');
          try {
            await tg.sendMessage(adminChatId,
              `🆘 Support request from user ${userId} (chat ${chatId})\n\nNo message history available.`
            );
          } catch (err) {
            console.error('[support] Failed to send to admin:', err?.message || err);
          }
          return;
        }

        const transcript = last10.map(m => {
          const who = m.role === 'user' ? '👤 User' : '🤖 Bot';
          const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          return `${who}: ${text.slice(0, 500)}`;
        }).join('\n\n');

        try {
          await tg.sendMessage(adminChatId,
            `🆘 Support request from user ${userId} (chat ${chatId})\n\n📝 Last ${last10.length} messages:\n\n${transcript.slice(0, 3500)}`
          );
          await sendReply(chatId, '📩 Support request sent! Someone will check in with you shortly.');
        } catch (err) {
          console.error('[support] Failed to send to admin:', err?.message || err);
          await sendReply(chatId, '📩 Support request noted. We\'ll look into it.');
        }
        return;
      }

      // ── Admin broadcast ───────────────────────────────────────────
      // Admin types "broadcast <message>" → sends to all active chats
      if (lower.startsWith('broadcast ') && config.telegram.adminUserId && String(userId) === String(config.telegram.adminUserId)) {
        const message = messageBody.replace(/^broadcast\s+/i, '').trim();
        if (!message) {
          await sendReply(chatId, 'Usage: broadcast <message>');
          return;
        }
        const chatIds = await brain.loadActiveChats();
        let sent = 0;
        for (const cid of chatIds) {
          try {
            await tg.sendMessage(cid, `📢 ${message}`);
            sent++;
          } catch (err) {
            console.error(`[broadcast] Failed to send to ${cid}:`, err?.message || err);
          }
        }
        await sendReply(chatId, `✅ Broadcast sent to ${sent}/${chatIds.length} chat(s).`, { saveToHistory: false });
        return;
      }
      if (lower.startsWith('broadcast ') && (!config.telegram.adminUserId || String(userId) !== String(config.telegram.adminUserId))) {
        // Non-admin trying to broadcast — ignore silently
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

      // ── Natural language matchers ──────────────────────────────────
      // Catches common phrasings before falling through to rigid commands.
      const matched = matchIntent(lower);
      if (matched) {
        // Help
        if (matched.intent === 'help') {
          await sendReply(chatId, helpText());
          return;
        }

        // Brain
        if (matched.intent === 'brain_status') {
          await sendReply(chatId, `🧠 Brain: ${brain ? 'active' : 'disabled'}\nBucket: ${config.gcp.brainBucket || '(none)'}\nPrefix: ${config.gcp.brainPrefix}`);
          return;
        }
        if (matched.intent === 'brain_show') {
          const state = await brain.loadThread(threadKey);
          await sendReply(chatId, `🧠 Thread memory:\n\`\`\`\n${JSON.stringify(state || {}, null, 2).slice(0, 3000)}\n\`\`\``);
          return;
        }
        if (matched.intent === 'brain_reset') {
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

        // Repos
        if (matched.intent === 'repos_list') {
          const repoList = await brain.listRepos();
          if (!repoList.length) {
            await sendReply(chatId, 'No repos indexed yet. Set OPENCLAW_REPOS or wait for auto-discovery.');
            return;
          }
          const list = repoList.map(r => `• ${r.name} (${r.language || '?'})`).join('\n');
          await sendReply(chatId, `📦 Indexed repos:\n${list}`);
          return;
        }

        // Learn to Code
        if (matched.intent === 'learn') {
          const userName = message.from.first_name || message.from.username || String(message.from.id);
          await handleLearnCommand({
            command: 'learn',
            args: matched.args,
            userId,
            userName,
            threadKey,
            threadState,
            brain,
            octokit,
            anthropic,
            model: config.anthropic.model,
            config,
            sendReply: (text) => sendReply(chatId, text),
            sendAdminAlert: config.telegram.adminUserId
              ? (text) => tg.sendMessage(config.telegram.adminUserId, text).catch(e => console.error('[learn] Admin alert failed:', e?.message || e))
              : null,
          });
          return;
        }

        // Roundup
        if (matched.intent === 'roundup_daily') {
          const deps = { config, anthropic, gmail, calendar, tasks, brain };
          await sendReply(chatId, '📰 Sending daily roundup...');
          try {
            await sendDailyRoundup(deps);
            await sendReply(chatId, '✅ Daily roundup sent!');
          } catch (err) {
            await sendReply(chatId, `❌ Daily roundup failed: ${(err?.message || 'unknown').slice(0, 300)}`);
          }
          return;
        }
        if (matched.intent === 'roundup_weekly') {
          const deps = { config, anthropic, gmail, calendar, tasks, brain };
          await sendReply(chatId, '📰 Sending weekly roundup...');
          try {
            await sendWeeklyRoundup(deps);
            await sendReply(chatId, '✅ Weekly roundup sent!');
          } catch (err) {
            await sendReply(chatId, `❌ Weekly roundup failed: ${(err?.message || 'unknown').slice(0, 300)}`);
          }
          return;
        }

        // Email
        if (matched.intent === 'email_check' && gmail) {
          const msgs = await gmail.listMessages({ maxResults: 5 });
          if (!msgs.length) { await sendReply(chatId, '📭 No recent emails.'); return; }
          const lines = msgs.map((m, i) => `${i + 1}. ${m.from.slice(0, 40)}\n   ${m.subject}\n   ${m.date}`);
          await sendReply(chatId, `📬 Recent emails:\n\n${lines.join('\n\n')}`);
          return;
        }
        if (matched.intent === 'email_search_nl' && gmail && anthropic) {
          // Use Claude to extract the search query from the natural language
          const queryResp = await anthropic.messages.create({
            model: config.anthropic.model,
            max_tokens: 100,
            system: 'Extract a Gmail search query from the user message. Return ONLY the search string, nothing else.',
            messages: [{ role: 'user', content: matched.raw }],
          });
          const query = queryResp.content?.find(c => c.type === 'text')?.text?.trim() || '';
          if (query) {
            const msgs = await gmail.listMessages({ query, maxResults: 5 });
            if (!msgs.length) { await sendReply(chatId, `No emails found for: ${query}`); return; }
            const lines = msgs.map((m, i) => `${i + 1}. ${m.from.slice(0, 40)}\n   ${m.subject}`);
            await sendReply(chatId, `📬 Results for "${query}":\n\n${lines.join('\n\n')}`);
          } else {
            await sendReply(chatId, 'I couldn\'t figure out what to search for. Try: email search <query>');
          }
          return;
        }
        if (matched.intent === 'email_send_nl' && gmail && anthropic) {
          // Let the intent router handle the complex extraction — pass through to existing flow
          // by not returning here, it'll fall through to the intent router
        }

        // Calendar
        if (matched.intent === 'cal_calendars' && calendar) {
          const cals = await calendar.listCalendars();
          if (!cals.length) { await sendReply(chatId, '📅 No calendars found.'); return; }
          const calendarIdMap = {};
          const lines = cals.map((c, i) => {
            const num = i + 1;
            calendarIdMap[num] = c.id;
            const badge = c.primary ? ' (primary)' : '';
            const role = c.accessRole ? ` [${c.accessRole}]` : '';
            return `${num}. ${c.summary}${badge}${role}`;
          });
          await brain.saveThread(threadKey, { calendarIdMap });
          await sendReply(chatId, `📅 Your calendars:\n\n${lines.join('\n')}\n\nUse the number when creating events, e.g.: cal create 2 "Meeting" tomorrow 3pm 1h`);
          return;
        }
        if (matched.intent === 'cal_list' && calendar) {
          let events;
          if (matched.date && matched.date !== 'today') {
            if (matched.date === 'this week' || matched.date === 'next week') {
              const now = new Date();
              const offset = matched.date === 'next week' ? 7 : 0;
              const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).toISOString();
              const timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset + 7).toISOString();
              events = await calendar.listEvents({ timeMin, timeMax });
            } else {
              const dateStr = calendar.resolveDate(matched.date);
              const timeMin = new Date(`${dateStr}T00:00:00`).toISOString();
              const timeMax = new Date(`${dateStr}T23:59:59`).toISOString();
              events = await calendar.listEvents({ timeMin, timeMax });
            }
          } else {
            events = await calendar.listEvents();
          }
          if (!events.length) {
            await sendReply(chatId, `📅 No events ${matched.date ? `for ${matched.date}` : 'today'}.`);
            return;
          }
          await sendReply(chatId, `📅 Events${matched.date ? ` (${matched.date})` : ' today'}:\n\n${events.map(e => e.formatted).join('\n\n')}`);
          return;
        }
        if (matched.intent === 'cal_create_nl' && calendar && anthropic) {
          // Use Claude to extract event details from natural language
          const today = new Date().toISOString().slice(0, 10);
          const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' });
          const parseResp = await anthropic.messages.create({
            model: config.anthropic.model,
            max_tokens: 300,
            system:
              `Extract calendar event details from the user message. Today is ${dayOfWeek}, ${today}. ` +
              'Return ONLY valid JSON: {"title":"string","date":"YYYY-MM-DD","time":"HH:MM" (24h),"duration":"1h","location":"string or null","attendees":"comma-sep emails or null"}. ' +
              'Resolve relative dates. If a field is missing, set to null.',
            messages: [{ role: 'user', content: matched.raw }],
          });
          let raw = parseResp.content?.find(c => c.type === 'text')?.text?.trim() || '';
          raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
          try {
            const ev = JSON.parse(raw);
            if (!ev.title || !ev.date || !ev.time) {
              await sendReply(chatId, `I got "${ev.title || '?'}" but need a date and time. Try:\ncal create "Title" <date> <time> <duration>`);
              return;
            }
            const attendees = ev.attendees ? ev.attendees.split(',').map(s => s.trim()).filter(Boolean) : [];
            const result = await calendar.createEvent({
              summary: ev.title, date: ev.date, time: ev.time,
              duration: ev.duration || '1h', attendees, location: ev.location || '',
            });
            await sendReply(chatId, `✅ Event created: ${result.summary}\n${result.htmlLink || ''}`);
          } catch (err) {
            await sendReply(chatId, 'I couldn\'t parse those event details. Try:\ncal create "Title" <date> <time> <duration>');
          }
          return;
        }

        // Todos
        if (matched.intent === 'todo_list' && tasks?.enabled) {
          const items = await tasks.listTasks();
          if (!items.length) { await sendReply(chatId, '✅ No todos! You\'re all caught up.'); return; }
          const todoIdMap = {};
          items.forEach((t, i) => { todoIdMap[i + 1] = { id: t.id, tasklist: null }; });
          await brain.saveThread(threadKey, { todoIdMap });
          const lines = items.map((t, i) =>
            `${i + 1}. ${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ''}${t.notes ? `\n   ${t.notes.slice(0, 100)}` : ''}`
          );
          await sendReply(chatId, `📋 Todos:\n\n${lines.join('\n\n')}`);
          return;
        }
        if (matched.intent === 'todo_add' && tasks?.enabled && matched.title) {
          const due = matched.due && calendar ? calendar.resolveDate(matched.due) : matched.due || undefined;
          const result = await tasks.addTask({ title: matched.title, due });
          await sendReply(chatId, `✅ Added: ${result.title}${due ? ` (due ${due})` : ''}`);
          return;
        }
        if (matched.intent === 'todo_done' && tasks?.enabled && matched.index) {
          const num = parseInt(matched.index, 10);
          let taskId = matched.index;
          let tasklist = null;
          if (!isNaN(num) && num >= 1) {
            const state = await brain.loadThread(threadKey);
            if (state?.todoIdMap?.[num]) { taskId = state.todoIdMap[num].id; tasklist = state.todoIdMap[num].tasklist; }
          }
          const result = await tasks.completeTask(taskId, tasklist);
          await sendReply(chatId, `✅ Completed: ${result.title}`);
          return;
        }
        if (matched.intent === 'todo_delete' && tasks?.enabled && matched.index) {
          const num = parseInt(matched.index, 10);
          let taskId = matched.index;
          let tasklist = null;
          if (!isNaN(num) && num >= 1) {
            const state = await brain.loadThread(threadKey);
            if (state?.todoIdMap?.[num]) { taskId = state.todoIdMap[num].id; tasklist = state.todoIdMap[num].tasklist; }
          }
          await tasks.deleteTask(taskId, tasklist);
          await sendReply(chatId, '✅ Todo deleted.');
          return;
        }

        // Reservations
        if (matched.intent === 'reserve_nl' && anthropic) {
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
        if (matched.intent === 'reserve_call_nl' && anthropic) {
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
            const callId = await makeReservationCall(rc.blandApiKey, { phone, restaurant: details.restaurant, date: details.date, time: details.time, partySize: details.partySize, callerName: rc.callerName });
            await sendReply(chatId, '📞 Call in progress...');
            const result = await waitForCallCompletion(rc.blandApiKey, callId, { onProgress: msg => sendReply(chatId, msg) });
            await sendReply(chatId, formatCallResult(details, result));
          } catch (err) {
            await sendReply(chatId, `❌ Call failed: ${(err?.message || 'unknown error').slice(0, 200)}`);
          }
          return;
        }

        // If we matched but the required service isn't configured, let user know
        if ((matched.intent.startsWith('email') && !gmail) ||
            (matched.intent.startsWith('todo') && !tasks?.enabled) ||
            (matched.intent.startsWith('cal') && !calendar)) {
          const service = matched.intent.startsWith('email') ? 'Gmail' : matched.intent.startsWith('todo') ? 'Google Tasks' : 'Google Calendar';
          await sendReply(chatId, `${service} is not configured. Check your .env file for the required credentials.`);
          return;
        }
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
          // Save pending email for confirmation
          await brain.saveThread(threadKey, {
            pendingEmail: { to: sendMatch[1], subject: sendMatch[2], body },
          });
          await sendReply(chatId, `📧 Preview:\n\nTo: ${sendMatch[1]}\nSubject: ${sendMatch[2]}\n\n${body.slice(0, 1000)}\n\n✉️ Reply "send" to confirm or "cancel" to discard.`);
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

      if (lower.startsWith('reserve') || lower.startsWith('book') || lower.startsWith('reservation') || lower.startsWith('make a reservation') || lower.startsWith('get a table') || lower.startsWith('find a table')) {
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
        // Google Task ID + tasklist from the last listed items saved in thread state.
        async function resolveTodoId(input) {
          const num = parseInt(input, 10);
          if (!isNaN(num) && String(num) === input && num >= 1) {
            const state = await brain.loadThread(threadKey);
            const map = state?.todoIdMap;
            if (map && map[num]) return map[num]; // { id, tasklist }
          }
          return { id: input, tasklist: null }; // fall back to raw ID
        }

        // Resolve a list name to a tasklist ID using the saved mapping
        async function resolveListName(name) {
          if (!name) return null;
          const state = await brain.loadThread(threadKey);
          const map = state?.taskListMap;
          if (map) {
            // Try exact match first, then case-insensitive
            for (const [key, val] of Object.entries(map)) {
              if (val.title.toLowerCase() === name.toLowerCase()) return val.id;
            }
            // Try by number
            const num = parseInt(name, 10);
            if (!isNaN(num) && map[num]) return map[num].id;
          }
          return null;
        }

        // Show all task lists with counts
        if (todoCmd === 'all' || todoCmd === 'lists') {
          const lists = await tasks.listTaskLists();
          if (!lists.length) {
            await sendReply(chatId, '📋 No task lists found.');
            return;
          }
          const taskListMap = {};
          const lines = [];
          for (let i = 0; i < lists.length; i++) {
            const tl = lists[i];
            taskListMap[i + 1] = { id: tl.id, title: tl.title };
            try {
              const items = await tasks.listTasks({ tasklist: tl.id, maxResults: 100 });
              lines.push(`${i + 1}. ${tl.title} (${items.length} task${items.length === 1 ? '' : 's'})`);
            } catch {
              lines.push(`${i + 1}. ${tl.title} (unable to read)`);
            }
          }
          await brain.saveThread(threadKey, { taskListMap });
          await sendReply(chatId, `📋 Your task lists:\n\n${lines.join('\n')}\n\nUse "todo list <#>" to see tasks in a list.\nUse "todo add <task> list <name>" to add to a specific list.`);
          return;
        }

        // List tasks — optionally from a specific list
        if (todoCmd === '' || todoCmd === 'list' || todoCmd === 'show' || todoCmd.startsWith('list ')) {
          let tasklist = null;
          let listLabel = '';
          const listArg = todoCmd.replace(/^(?:list|show)\s*/, '').trim();
          if (listArg) {
            tasklist = await resolveListName(listArg);
            if (!tasklist) {
              // Try as a number from taskListMap
              const state = await brain.loadThread(threadKey);
              const num = parseInt(listArg, 10);
              if (!isNaN(num) && state?.taskListMap?.[num]) {
                tasklist = state.taskListMap[num].id;
                listLabel = state.taskListMap[num].title;
              } else {
                await sendReply(chatId, `List "${listArg}" not found. Run "todo all" to see your lists.`);
                return;
              }
            }
          }

          const items = await tasks.listTasks({ tasklist });
          if (!items.length) {
            await sendReply(chatId, `✅ No todos${listLabel ? ` in "${listLabel}"` : ''}! You're all caught up.`);
            return;
          }
          // Save number→ID mapping so user can say "todo done 2"
          const todoIdMap = {};
          items.forEach((t, i) => { todoIdMap[i + 1] = { id: t.id, tasklist: tasklist || null }; });
          await brain.saveThread(threadKey, { todoIdMap });

          const lines = items.map((t, i) =>
            `${i + 1}. ${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ''}${t.notes ? `\n   ${t.notes.slice(0, 100)}` : ''}`
          );
          await sendReply(chatId, `📋 Todos${listLabel ? ` (${listLabel})` : ''}:\n\n${lines.join('\n\n')}`);
          return;
        }

        if (todoCmd.startsWith('add ')) {
          const raw = todoCmdRaw.replace(/^add\s*/i, '').trim();
          if (!raw) {
            await sendReply(chatId, 'Usage: todo add <task>\n       todo add pick up groceries\n       todo add buy milk by Friday');
            return;
          }

          let tasklist = null;
          let listLabel = '';
          let taskText = raw;

          // Check if the first word(s) match a known list name
          // e.g. "Work amazon order" → list=Work, task="amazon order"
          // e.g. "My Tasks buy milk" → list=My Tasks, task="buy milk"
          const state = await brain.loadThread(threadKey);
          const listMap = state?.taskListMap;
          if (listMap) {
            // Sort list names longest first so "My Tasks" matches before "My"
            const listNames = Object.values(listMap).map(v => v.title).sort((a, b) => b.length - a.length);
            for (const name of listNames) {
              if (raw.toLowerCase().startsWith(name.toLowerCase() + ' ')) {
                tasklist = Object.values(listMap).find(v => v.title.toLowerCase() === name.toLowerCase())?.id;
                listLabel = name;
                taskText = raw.slice(name.length).trim();
                break;
              }
            }
          }

          // Also still support "list <name>" at the end as fallback
          if (!tasklist) {
            const listMatch = raw.match(/\s+list\s+(.+)$/i);
            if (listMatch) {
              const listName = listMatch[1].trim();
              taskText = raw.slice(0, listMatch.index).trim();
              tasklist = await resolveListName(listName);
              if (!tasklist) {
                await sendReply(chatId, `List "${listName}" not found. Run "todo all" to see your lists.`);
                return;
              }
              listLabel = listName;
            }
          }

          const { title, due: dueRaw } = extractDueDate(taskText);
          const due = dueRaw && calendar ? calendar.resolveDate(dueRaw) : dueRaw || undefined;
          const result = await tasks.addTask({ title, due, tasklist });
          await sendReply(chatId, `✅ Added: ${result.title}${due ? ` (due ${due})` : ''}${listLabel ? ` → ${listLabel}` : ''}`);
          return;
        }

        if (todoCmd.startsWith('done ')) {
          const input = todoCmd.replace(/^done\s*/, '').trim();
          const { id: taskId, tasklist } = await resolveTodoId(input);
          const result = await tasks.completeTask(taskId, tasklist);
          await sendReply(chatId, `✅ Completed: ${result.title}`);
          return;
        }

        if (todoCmd.startsWith('delete ') || todoCmd.startsWith('remove ')) {
          const input = todoCmd.replace(/^(?:delete|remove)\s*/, '').trim();
          const { id: taskId, tasklist } = await resolveTodoId(input);
          await tasks.deleteTask(taskId, tasklist);
          await sendReply(chatId, '✅ Todo deleted.');
          return;
        }

        await sendReply(chatId,
          'Todo commands:\n• todo list — tasks from default list\n• todo list <name or #> — tasks from a specific list\n• todo all — show all your task lists\n• todo add <task> — add to default list\n• todo add <task> list <name> — add to a specific list\n• todo add <task> by <date> — add with due date\n• todo done <#>\n• todo delete <#>'
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

        if (roundupCmd.startsWith('follow ')) {
          let handle = messageBody.replace(/^roundup\s+follow\s+/i, '').trim().replace(/^@/, '');
          if (!handle) { await sendReply(chatId, 'Usage: roundup follow <handle>\nExample: roundup follow elonmusk'); return; }
          const handles = await brain.loadRoundupHandles();
          if (handles.includes(handle.toLowerCase())) {
            await sendReply(chatId, `Already following @${handle} in your roundup.`);
            return;
          }
          handles.push(handle.toLowerCase());
          await brain.saveRoundupHandles(handles);
          await sendReply(chatId, `✅ Now following @${handle} in your daily roundup.`);
          return;
        }

        if (roundupCmd.startsWith('unfollow ')) {
          let handle = messageBody.replace(/^roundup\s+unfollow\s+/i, '').trim().replace(/^@/, '').toLowerCase();
          if (!handle) { await sendReply(chatId, 'Usage: roundup unfollow <handle>'); return; }
          const handles = await brain.loadRoundupHandles();
          const filtered = handles.filter(h => h !== handle);
          if (filtered.length === handles.length) {
            await sendReply(chatId, `@${handle} wasn't in your roundup.`);
            return;
          }
          await brain.saveRoundupHandles(filtered);
          await sendReply(chatId, `✅ Unfollowed @${handle} from your daily roundup.`);
          return;
        }

        if (roundupCmd === 'topics' || roundupCmd === 'list') {
          const brainTopics = await brain.loadRoundupTopics();
          const envTopics = (config.roundup.dailyTopics || '').split(',').map(s => s.trim()).filter(Boolean);
          const allTopics = [...new Set([...envTopics, ...brainTopics])];
          const brainHandles = await brain.loadRoundupHandles();
          const envHandles = (config.roundup.twitterHandles || '').split(',').map(s => s.trim()).filter(Boolean);
          const allHandles = [...new Set([...envHandles, ...brainHandles])];

          const lines = [];
          if (allTopics.length) lines.push('📰 Topics:\n' + allTopics.map(t => `  • ${t}`).join('\n'));
          if (allHandles.length) lines.push('🐦 Following:\n' + allHandles.map(h => `  • @${h}`).join('\n'));
          if (!lines.length) { await sendReply(chatId, 'No roundup topics or handles configured.'); return; }
          await sendReply(chatId, `📰 Your roundup:\n\n${lines.join('\n\n')}`);
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

        await sendReply(chatId, 'Roundup commands:\n• roundup — send daily digest now\n• roundup weekly — send weekly digest\n• roundup topics — see topics & handles\n• roundup add <topic> — add a news topic\n• roundup remove <topic> — remove a topic\n• roundup follow <handle> — follow a Twitter account\n• roundup unfollow <handle> — unfollow');
        return;
      }

      // Calendar commands
      if (calendar && lower.startsWith('cal')) {
        const calCmd = lower.replace(/^cal\s*/, '').trim();
        const calCmdRaw = messageBody.replace(/^cal\s*/i, '').trim();

        if (calCmd === 'calendars') {
          const cals = await calendar.listCalendars();
          if (!cals.length) {
            await sendReply(chatId, '📅 No calendars found.');
            return;
          }
          const calendarIdMap = {};
          const lines = cals.map((c, i) => {
            const num = i + 1;
            calendarIdMap[num] = c.id;
            const badge = c.primary ? ' (primary)' : '';
            const role = c.accessRole ? ` [${c.accessRole}]` : '';
            return `${num}. ${c.summary}${badge}${role}`;
          });
          await brain.saveThread(threadKey, { calendarIdMap });
          await sendReply(chatId, `📅 Your calendars:\n\n${lines.join('\n')}\n\nUse the number when creating events, e.g.: cal create 2 "Meeting" tomorrow 3pm 1h`);
          return;
        }

        // Helper: save event number mapping and format event list
        async function formatAndSaveEvents(events, label) {
          const eventIdMap = {};
          events.forEach((e, i) => { eventIdMap[i + 1] = { id: e.id, calendarId: e.calendarId || 'primary' }; });
          await brain.saveThread(threadKey, { eventIdMap });
          const lines = events.map((e, i) => `${i + 1}. ${e.formatted}`);
          await sendReply(chatId, `📅 ${label}:\n\n${lines.join('\n\n')}`);
        }

        if (calCmd === 'default') {
          const state = await brain.loadThread(threadKey);
          const defaultCal = state?.defaultCalendarId;
          if (defaultCal) {
            await sendReply(chatId, `📅 Default calendar: ${defaultCal}\nUse "cal default <#>" to change it, or "cal default clear" to reset.`);
          } else {
            await sendReply(chatId, '📅 No default calendar set. Use "cal default <#>" after running "cal calendars".');
          }
          return;
        }

        if (calCmd.startsWith('default ')) {
          const arg = calCmd.replace(/^default\s*/, '').trim();
          if (arg === 'clear' || arg === 'reset' || arg === 'none') {
            await brain.saveThread(threadKey, { defaultCalendarId: null });
            await sendReply(chatId, '✅ Default calendar cleared. Events will be created on your primary calendar.');
            return;
          }
          const num = parseInt(arg, 10);
          if (isNaN(num) || num < 1) {
            await sendReply(chatId, 'Usage: cal default <#>\nRun "cal calendars" first to see your calendar numbers.');
            return;
          }
          const state = await brain.loadThread(threadKey);
          const calId = state?.calendarIdMap?.[num];
          if (!calId) {
            await sendReply(chatId, `Calendar #${num} not found. Run "cal calendars" first.`);
            return;
          }
          await brain.saveThread(threadKey, { defaultCalendarId: calId });
          await sendReply(chatId, `✅ Default calendar set to #${num}. All new events will be created there unless you specify a different number.`);
          return;
        }

        if (calCmd === '' || calCmd === 'list' || calCmd === 'today') {
          const events = await calendar.listEvents();
          if (!events.length) {
            await sendReply(chatId, '📅 No events today.');
            return;
          }
          await formatAndSaveEvents(events, "Today's events");
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
          await formatAndSaveEvents(events, `Events (${arg})`);
          return;
        }

        if (calCmd.startsWith('get ')) {
          const eventId = calCmd.replace(/^get\s*/, '').trim();
          const ev = await calendar.getEvent(eventId);
          await sendReply(chatId, `📅 ${ev.formatted}\n${ev.htmlLink || ''}`);
          return;
        }

        if (calCmd.startsWith('create ')) {
          // Flexible regex: optional calendar number, title in quotes, date, time, then rest (duration + extras)
          const createMatch = calCmdRaw.match(/^create\s+(?:(\d)\s+)?["\u201c\u201e\u00ab]([^"\u201d\u201f\u00bb]+)["\u201d\u201f\u00bb]\s+(.+?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s+(.+)$/is);
          if (!createMatch) {
            await sendReply(chatId, 'Usage: cal create [#] "Title" <date> <time> <duration>\nExamples:\n• cal create "Dentist" 03/19 2pm 1 hour\n• cal create 2 "Lunch" tomorrow 12:30pm 1h30m\n\nUse "cal calendars" to see calendar numbers.');
            return;
          }
          const [, calNum, title, date, time, remainder] = createMatch;
          // Resolve calendar: explicit number > default > primary
          let calendarId = null;
          const threadState2 = await brain.loadThread(threadKey);
          if (calNum) {
            calendarId = threadState2?.calendarIdMap?.[parseInt(calNum, 10)] || null;
            if (!calendarId) {
              await sendReply(chatId, `Calendar #${calNum} not found. Run "cal calendars" first to see your calendars.`);
              return;
            }
          } else if (threadState2?.defaultCalendarId) {
            calendarId = threadState2.defaultCalendarId;
          }
          // Extract duration from the front of remainder, leaving attendees/location behind
          const { minutes, rest } = calendar.extractDuration(remainder);
          const locMatch = (rest || '').match(/location\s*:\s*["\u201c]([^"\u201d]+)["\u201d]/i);
          const location = locMatch ? locMatch[1] : '';
          const attendeePart = (rest || '').replace(/location\s*:\s*["\u201c][^"\u201d]*["\u201d]/i, '').trim();
          const attendees = attendeePart ? attendeePart.split(',').map(s => s.trim()).filter(Boolean) : [];

          const result = await calendar.createEvent({ summary: title, date, time, duration: `${minutes}m`, attendees, location, calendarId });
          await sendReply(chatId, `✅ Event created: ${result.summary}\n${result.htmlLink || ''}`);
          return;
        }

        if (calCmd.startsWith('update ')) {
          const parts = calCmdRaw.replace(/^update\s*/i, '').trim().split(/\s+/);
          let eventRef = parts[0];
          if (!eventRef || parts.length < 2) {
            await sendReply(chatId, 'Usage: cal update <#> title="New Title" time=14:00 date=2026-03-15 duration=1h\n\nUse the event number from "cal list".');
            return;
          }
          // Resolve event number to real ID
          let eventId = eventRef;
          const num = parseInt(eventRef, 10);
          if (!isNaN(num) && String(num) === eventRef && num >= 1) {
            const state = await brain.loadThread(threadKey);
            if (state?.eventIdMap?.[num]) eventId = state.eventIdMap[num].id;
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
          const eventRef = calCmd.replace(/^delete\s*/, '').trim();
          // Resolve event number to real ID
          let eventId = eventRef;
          const num = parseInt(eventRef, 10);
          if (!isNaN(num) && String(num) === eventRef && num >= 1) {
            const state = await brain.loadThread(threadKey);
            if (state?.eventIdMap?.[num]) eventId = state.eventIdMap[num].id;
          }
          await calendar.deleteEvent(eventId);
          await sendReply(chatId, `✅ Event deleted.`);
          return;
        }

        await sendReply(chatId,
          'Calendar commands:\n• cal / cal list / cal list <date> / cal list week\n• cal calendars — list all calendars\n• cal default <#> — set default calendar\n• cal create [#] "Title" <date> <time> <duration>\n• cal update <#> field=value\n• cal delete <#>\n\nUse event numbers from "cal list" for update/delete.'
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
              '• {"intent":"help"} — user asking what the bot can do, how to use it, or listing commands\n' +
              '• {"intent":"email_check"} — user wants to see inbox/recent emails\n' +
              '• {"intent":"email_search","query":"search terms"} — search emails\n' +
              '• {"intent":"email_send","to":"addr","subject":"subj","body":"text"} — send an email\n' +
              '• {"intent":"todo_list"} — list todos, tasks, or what\'s on their plate\n' +
              '• {"intent":"todo_add","title":"task text"} — add a todo, reminder, or task\n' +
              '• {"intent":"todo_done","index":"number"} — complete/check off a todo by its list number\n' +
              '• {"intent":"todo_delete","index":"number"} — delete/remove a todo by its list number\n' +
              '• {"intent":"cal_list","date":"date or empty"} — list calendar events, schedule, meetings\n' +
              '• {"intent":"cal_create","title":"t","date":"d","time":"t","duration":"d","location":"optional","attendees":"optional comma-sep emails"} — create/schedule an event or meeting\n' +
              '• {"intent":"reserve","restaurant":"name","city":"optional","date":"YYYY-MM-DD","time":"HH:MM","partySize":2} — make a restaurant reservation (OpenTable link)\n' +
              '• {"intent":"reserve_call","restaurant":"name","city":"optional","date":"YYYY-MM-DD","time":"HH:MM","partySize":2} — call a restaurant to make a reservation\n' +
              '• {"intent":"roundup_daily"} — get the daily news briefing/digest\n' +
              '• {"intent":"roundup_weekly"} — get the weekly digest\n' +
              '• {"intent":"repos_list"} — list repos/projects\n' +
              '• {"intent":"brain_show"} — show what the bot remembers\n' +
              '• {"intent":"brain_reset"} — clear/reset bot memory\n' +
              '• {"intent":"none"} — conversational, greeting, thanks, or doesn\'t match any action\n\n' +
              'Disambiguation:\n' +
              '- "what\'s on my plate" / "what do I need to do" = todo_list (tasks)\n' +
              '- "what do I have going on" / "how does my day look" = cal_list (calendar)\n' +
              '- "remind me to X" / "don\'t forget to X" / "I need to X" = todo_add\n' +
              '- "schedule a meeting" / "set up a call" / "block time" = cal_create\n' +
              '- "catch me up" / "what did I miss" / "give me the news" = roundup_daily\n' +
              '- "hi" / "thanks" / "ok" / "how are you" = none (conversational)\n\n' +
              'Examples:\n' +
              '- "any meetings tomorrow?" -> {"intent":"cal_list","date":"tomorrow"}\n' +
              '- "remind me to call the dentist" -> {"intent":"todo_add","title":"call the dentist"}\n' +
              '- "check my inbox" -> {"intent":"email_check"}\n' +
              '- "book dinner for 4 at Nobu Saturday 7pm" -> {"intent":"reserve","restaurant":"Nobu","date":"...","time":"19:00","partySize":4}\n' +
              '- "send Sarah an email about the Q4 report" -> {"intent":"email_send","to":"sarah","subject":"Q4 Report","body":"..."}\n' +
              '- "what can you do?" -> {"intent":"help"}',
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
            await brain.saveThread(threadKey, {
              pendingEmail: { to: intent.to, subject: intent.subject, body },
            });
            await sendReply(chatId, `📧 Preview:\n\nTo: ${intent.to}\nSubject: ${intent.subject}\n\n${body.slice(0, 1000)}\n\n✉️ Reply "send" to confirm or "cancel" to discard.`);
            return;
          }
          if (intent.intent === 'todo_list' && tasks?.enabled) {
            const items = await tasks.listTasks();
            if (!items.length) { await sendReply(chatId, '✅ No todos! You\'re all caught up.'); return; }
            const todoIdMap = {};
            items.forEach((t, i) => { todoIdMap[i + 1] = { id: t.id, tasklist: null }; });
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
            let tasklist = null;
            if (!isNaN(num) && num >= 1) {
              const state = await brain.loadThread(threadKey);
              if (state?.todoIdMap?.[num]) { taskId = state.todoIdMap[num].id; tasklist = state.todoIdMap[num].tasklist; }
            }
            if (intent.intent === 'todo_done') {
              const result = await tasks.completeTask(taskId, tasklist);
              await sendReply(chatId, `✅ Completed: ${result.title}`);
            } else {
              await tasks.deleteTask(taskId, tasklist);
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
          if (intent.intent === 'reserve' && anthropic && intent.restaurant) {
            const details = { restaurant: intent.restaurant, city: intent.city || null, date: intent.date, time: intent.time, partySize: intent.partySize || 2 };
            if (!details.date || !details.time) {
              await sendReply(chatId, `I found "${details.restaurant}" but need a date and time. Try:\nreserve ${details.restaurant} for ${details.partySize || 2} on Saturday at 7pm`);
              return;
            }
            const openTableUrl = buildOpenTableUrl(details);
            const mapsUrl = buildGoogleMapsUrl(details);
            await sendReply(chatId, formatReservationReply(details, openTableUrl, mapsUrl));
            return;
          }
          if (intent.intent === 'reserve_call' && anthropic && intent.restaurant) {
            const rc = config.reservations;
            if (!rc.blandApiKey) {
              // Fall back to OpenTable link
              const details = { restaurant: intent.restaurant, city: intent.city || null, date: intent.date, time: intent.time, partySize: intent.partySize || 2 };
              if (details.date && details.time) {
                const openTableUrl = buildOpenTableUrl(details);
                const mapsUrl = buildGoogleMapsUrl(details);
                await sendReply(chatId, 'Phone calls not configured. Here\'s an OpenTable link instead:\n\n' + formatReservationReply(details, openTableUrl, mapsUrl));
              } else {
                await sendReply(chatId, 'Phone calls not configured (BLAND_API_KEY missing). Try "reserve" instead for an OpenTable link.');
              }
              return;
            }
            const details = { restaurant: intent.restaurant, city: intent.city || null, date: intent.date, time: intent.time, partySize: intent.partySize || 2 };
            if (!details.date || !details.time) {
              await sendReply(chatId, `I found "${details.restaurant}" but need a date and time. Try:\ncall ${details.restaurant} and reserve for ${details.partySize || 2} on Saturday at 7pm`);
              return;
            }
            let phone = null;
            if (rc.placesApiKey) {
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
              const callId = await makeReservationCall(rc.blandApiKey, { phone, restaurant: details.restaurant, date: details.date, time: details.time, partySize: details.partySize, callerName: rc.callerName });
              await sendReply(chatId, '📞 Call in progress...');
              const result = await waitForCallCompletion(rc.blandApiKey, callId, { onProgress: msg => sendReply(chatId, msg) });
              await sendReply(chatId, formatCallResult(details, result));
            } catch (err) {
              await sendReply(chatId, `❌ Call failed: ${(err?.message || 'unknown error').slice(0, 200)}`);
            }
            return;
          }
          // New intents added to safety net
          if (intent.intent === 'help') {
            await sendReply(chatId, helpText());
            return;
          }
          if (intent.intent === 'roundup_daily') {
            const rdeps = { config, anthropic, gmail, calendar, tasks, brain };
            await sendReply(chatId, '📰 Sending daily roundup...');
            try { await sendDailyRoundup(rdeps); await sendReply(chatId, '✅ Daily roundup sent!'); }
            catch (err) { await sendReply(chatId, `❌ Daily roundup failed: ${(err?.message || 'unknown').slice(0, 300)}`); }
            return;
          }
          if (intent.intent === 'roundup_weekly') {
            const rdeps = { config, anthropic, gmail, calendar, tasks, brain };
            await sendReply(chatId, '📰 Sending weekly roundup...');
            try { await sendWeeklyRoundup(rdeps); await sendReply(chatId, '✅ Weekly roundup sent!'); }
            catch (err) { await sendReply(chatId, `❌ Weekly roundup failed: ${(err?.message || 'unknown').slice(0, 300)}`); }
            return;
          }
          if (intent.intent === 'repos_list') {
            const repoList = await brain.listRepos();
            if (!repoList.length) { await sendReply(chatId, 'No repos indexed yet.'); return; }
            const list = repoList.map(r => `• ${r.name} (${r.language || '?'})`).join('\n');
            await sendReply(chatId, `📦 Indexed repos:\n${list}`);
            return;
          }
          if (intent.intent === 'brain_show') {
            const state = await brain.loadThread(threadKey);
            await sendReply(chatId, `🧠 Thread memory:\n\`\`\`\n${JSON.stringify(state || {}, null, 2).slice(0, 3000)}\n\`\`\``);
            return;
          }
          if (intent.intent === 'brain_reset') {
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
          // intent === 'none' → fall through to skill pipeline / chat
        } catch (intentErr) {
          // Intent parsing failed — fall through silently
          log('Intent router error (falling through):', intentErr?.message || intentErr);
        }
      }

      // ── Learn: name onboarding or challenge response ─────────────
      // If user has an active lesson or we're awaiting their name,
      // treat their message as a learn response.
      if (threadState?.activeLesson || threadState?.learnProgress?.awaitingName) {
        const userName = message.from.first_name || message.from.username || String(message.from.id);
        const handled = await handleChallengeResponse({
          userCode: messageBody,
          userName,
          threadKey,
          threadState,
          brain,
          octokit,
          anthropic,
          model: config.anthropic.model,
          config,
          sendReply: (text) => sendReply(chatId, text),
        });
        if (handled) return;
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
