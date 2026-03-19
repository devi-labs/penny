'use strict';

const { createTelegramClient } = require('./clients/telegram');

// Helper: parse comma-separated env string into array
function parseList(s) {
  return (s || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Send roundup digest to all active Telegram chats
async function sendTelegramDigest(config, brain, body, subject) {
  const tg = createTelegramClient(config.telegram.botToken);
  if (!tg || !brain) return;
  try {
    const chatIds = await brain.loadActiveChats();
    if (!chatIds.length) return;
    for (const chatId of chatIds) {
      try {
        await tg.sendMessage(chatId, `${subject}\n\n${body}`);
      } catch (err) {
        console.error(`[roundup] Telegram send error for chat ${chatId}:`, err?.message || err);
      }
    }
    console.log(`[roundup] Telegram roundup sent to ${chatIds.length} chat(s)`);
  } catch (err) {
    console.error('[roundup] Telegram digest error:', err?.message || err);
  }
}

// Fetch recent tweets for a handle via X API v2
async function fetchTweets(bearerToken, handle) {
  try {
    const userResp = await fetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (!userResp.ok) return [];
    const userData = await userResp.json();
    const userId = userData.data?.id;
    if (!userId) return [];

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const tweetsResp = await fetch(
      `https://api.x.com/2/users/${userId}/tweets?max_results=10&start_time=${since}&tweet.fields=created_at,text`,
      { headers: { Authorization: `Bearer ${bearerToken}` } },
    );
    if (!tweetsResp.ok) return [];
    const tweetsData = await tweetsResp.json();
    return (tweetsData.data || []).map(t => ({
      text: t.text,
      date: t.created_at ? new Date(t.created_at).toLocaleDateString() : '',
    }));
  } catch (err) {
    console.error(`[roundup] Twitter fetch error for @${handle}:`, err?.message || err);
    return [];
  }
}

// Fetch news via Google News RSS
async function fetchNewsRSS(topic, maxItems = 10) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const xml = await resp.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < maxItems) {
      const block = match[1];
      const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      const cleanTitle = title
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"');
      items.push({ title: cleanTitle, link, date: pubDate });
    }
    return items;
  } catch (err) {
    console.error(`[roundup] News fetch error for "${topic}":`, err?.message || err);
    return [];
  }
}

// Fetch LinkedIn activity for a person (best effort via Google News)
async function fetchLinkedInUpdates(name) {
  const displayName = name.replace(/-/g, ' ');
  return fetchNewsRSS(`${displayName} linkedin`, 5);
}

// Use Claude to compile a digest
async function compileDigest(anthropic, model, sections, kind) {
  try {
    const rawContent = sections.map(s => `## ${s.heading}\n${s.items.join('\n')}`).join('\n\n');

    const resp = await anthropic.messages.create({
      model,
      max_tokens: 2000,
      system:
        `You are OpenClaw's digest writer. Compile these raw items into a clean, scannable ${kind} email digest. ` +
        'Keep it concise — short summaries, bullet points, include all links. ' +
        'Do not invent information. Do not add items that are not in the source data.',
      messages: [{ role: 'user', content: `Compile this into a readable ${kind} digest email:\n\n${rawContent}` }],
    });

    return resp.content?.find(c => c.type === 'text')?.text?.trim() || rawContent;
  } catch (err) {
    console.error('[roundup] Claude digest error:', err?.message || err);
    return sections.map(s => `${s.heading}\n${s.items.join('\n')}`).join('\n\n');
  }
}

// ── Daily Roundup ────────────────────────────────────────────────
// News topics + Twitter + LinkedIn, sent every day

async function sendDailyRoundup({ config, anthropic, gmail, calendar, tasks, brain }) {
  const rc = config.roundup;
  const dailyTopics = parseList(rc.dailyTopics);
  const handles = parseList(rc.twitterHandles);
  const linkedinNames = parseList(rc.linkedinNames);

  const canEmail = gmail?.enabled && rc.emailTo;
  const canTelegram = config.telegram.botToken && brain;
  if (!canEmail && !canTelegram) { console.log('[roundup] No delivery method configured, skipping daily roundup'); return; }

  console.log('[roundup] Building daily roundup...');
  const sections = [];

  // Today's calendar events
  if (calendar?.enabled) {
    try {
      const events = await calendar.listEvents();
      if (events.length) {
        sections.push({
          heading: '📅 Today\'s Schedule',
          items: events.map(e => {
            const start = e.start ? new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
            return `• ${start} — ${e.summary}${e.location ? ` (${e.location})` : ''}`;
          }),
        });
      }
    } catch (err) {
      console.error('[roundup] Calendar fetch error:', err?.message || err);
    }
  }

  // Open todos
  if (tasks?.enabled) {
    try {
      const items = await tasks.listTasks({ maxResults: 20 });
      if (items.length) {
        sections.push({
          heading: '✅ Open Todos',
          items: items.map(t => `• ${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ''}`),
        });
      }
    } catch (err) {
      console.error('[roundup] Tasks fetch error:', err?.message || err);
    }
  }

  // News
  if (dailyTopics.length) {
    for (const topic of dailyTopics) {
      const articles = await fetchNewsRSS(topic, 2);
      if (articles.length) {
        sections.push({
          heading: `📰 ${topic}`,
          items: articles.map(a => `• ${a.title} — ${a.link}`),
        });
      }
    }
  }

  // Twitter
  if (handles.length && !rc.xBearerToken) {
    console.log('[roundup] Twitter handles configured but X_BEARER_TOKEN is missing — skipping Twitter');
  }
  if (handles.length && rc.xBearerToken) {
    const allTweets = [];
    for (const handle of handles) {
      const tweets = await fetchTweets(rc.xBearerToken, handle);
      allTweets.push(...tweets.map(t => `@${handle}: ${t.text} (${t.date})`));
    }
    if (allTweets.length) sections.push({ heading: '🐦 Twitter/X', items: allTweets });
  }

  // LinkedIn
  if (linkedinNames.length) {
    const allUpdates = [];
    for (const name of linkedinNames) {
      const updates = await fetchLinkedInUpdates(name);
      allUpdates.push(...updates.map(u => `${name}: ${u.title} — ${u.link}`));
    }
    if (allUpdates.length) sections.push({ heading: '💼 LinkedIn', items: allUpdates });
  }

  if (!sections.length) { console.log('[roundup] No content for daily roundup'); return null; }

  let body;
  if (anthropic) {
    body = await compileDigest(anthropic, config.anthropic.model, sections, 'daily');
  } else {
    body = sections.map(s => `${s.heading}\n${s.items.join('\n')}`).join('\n\n');
  }

  const subject = `OpenClaw Daily — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`;
  if (gmail?.enabled && rc.emailTo) {
    try {
      await gmail.sendEmail({ to: rc.emailTo, subject, body, from: rc.emailFrom || undefined });
      console.log(`[roundup] Daily roundup emailed to ${rc.emailTo}`);
    } catch (err) {
      console.error('[roundup] Email send failed:', err?.message || err);
    }
  } else {
    console.log(`[roundup] Email skipped — gmail.enabled=${gmail?.enabled}, emailTo=${rc.emailTo || '(empty)'}`);
  }
  await sendTelegramDigest(config, brain, body, subject);
  return `${subject}\n\n${body}`;
}

// ── Weekly Roundup ───────────────────────────────────────────────
// Deep-dive topics, sent on the configured day (default: Saturday)

async function sendWeeklyRoundup({ config, anthropic, gmail, brain }) {
  const rc = config.roundup;
  const topics = parseList(rc.weeklyTopics);

  if (!topics.length) return;
  const canEmail = gmail?.enabled && rc.emailTo;
  const canTelegram = config.telegram.botToken && brain;
  if (!canEmail && !canTelegram) { console.log('[roundup] No delivery method configured, skipping weekly roundup'); return; }

  console.log('[roundup] Building weekly roundup...');
  const sections = [];

  for (const topic of topics) {
    const articles = await fetchNewsRSS(topic, 8);
    if (articles.length) {
      sections.push({
        heading: `📰 ${topic}`,
        items: articles.map(a => `• ${a.title} — ${a.link}`),
      });
    }
  }

  if (!sections.length) { console.log('[roundup] No content for weekly roundup'); return; }

  let body;
  if (anthropic) {
    body = await compileDigest(anthropic, config.anthropic.model, sections, 'weekly');
  } else {
    body = sections.map(s => `${s.heading}\n${s.items.join('\n')}`).join('\n\n');
  }

  const subject = `OpenClaw Weekly — ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
  if (canEmail) {
    await gmail.sendEmail({ to: rc.emailTo, subject, body });
    console.log(`[roundup] Weekly roundup sent to ${rc.emailTo}`);
  }
  await sendTelegramDigest(config, brain, body, subject);
}

// ── Scheduler ────────────────────────────────────────────────────

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function startRoundupScheduler(deps) {
  const rc = deps.config.roundup;
  const hasNewsContent = parseList(rc.dailyTopics).length || parseList(rc.twitterHandles).length || parseList(rc.linkedinNames).length;
  const hasPersonalContent = deps.calendar?.enabled || deps.tasks?.enabled || deps.gmail?.enabled;
  const hasDaily = hasNewsContent || hasPersonalContent;
  const hasWeekly = parseList(rc.weeklyTopics).length;

  const hasDelivery = rc.emailTo || deps.config.telegram.botToken;
  if (!hasDelivery || (!hasDaily && !hasWeekly)) {
    console.log('[roundup] No roundup configured, scheduler inactive');
    return;
  }

  console.log(`[roundup] Scheduler active — daily: ${hasDaily ? 'yes' : 'no'}, weekly: ${hasWeekly ? rc.weeklyDay : 'no'}`);

  let lastDailySent = null;
  let lastWeeklySent = null;

  const CHECK_INTERVAL = 60 * 60 * 1000;

  async function check() {
    const now = new Date();
    const today = DAY_NAMES[now.getDay()];
    const dateKey = now.toISOString().slice(0, 10);

    // Daily — send every day after 8am
    if (hasDaily && now.getHours() >= 8 && lastDailySent !== dateKey) {
      lastDailySent = dateKey;
      try {
        await sendDailyRoundup(deps);
      } catch (err) {
        console.error('[roundup] Daily roundup error:', err?.message || err);
      }
    }

    // Weekly — send on the configured day after 8am
    if (hasWeekly && today === rc.weeklyDay.toLowerCase() && now.getHours() >= 8 && lastWeeklySent !== dateKey) {
      lastWeeklySent = dateKey;
      try {
        await sendWeeklyRoundup(deps);
      } catch (err) {
        console.error('[roundup] Weekly roundup error:', err?.message || err);
      }
    }
  }

  setTimeout(check, 10_000);
  setInterval(check, CHECK_INTERVAL);
}

module.exports = { startRoundupScheduler, sendDailyRoundup, sendWeeklyRoundup };
