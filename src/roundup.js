'use strict';

const { createTelegramClient } = require('./clients/telegram');
const { getLearnNudge } = require('./learn');

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

// Fetch recent tweets — Twitter API v2 (primary), RSSHub (fallback), Google News (last resort)
async function fetchTweets(bearerToken, handle) {
  // ── Twitter API v2 (requires X_BEARER_TOKEN) ────────────────────
  if (bearerToken) {
    try {
      // Get user ID from username
      const userResp = await fetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}`, {
        headers: { Authorization: `Bearer ${bearerToken}` },
        signal: AbortSignal.timeout(10000),
      });
      if (userResp.ok) {
        const userData = await userResp.json();
        const userId = userData.data?.id;
        if (userId) {
          // Fetch tweets from yesterday only
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const startOfYesterday = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()).toISOString();
          const endOfYesterday = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate() + 1).toISOString();
          const params = new URLSearchParams({
            'tweet.fields': 'created_at,text',
            max_results: '10',
            start_time: startOfYesterday,
            end_time: endOfYesterday,
            exclude: 'replies,retweets',
          });
          const tweetsResp = await fetch(`https://api.x.com/2/users/${userId}/tweets?${params}`, {
            headers: { Authorization: `Bearer ${bearerToken}` },
            signal: AbortSignal.timeout(10000),
          });
          if (tweetsResp.ok) {
            const tweetsData = await tweetsResp.json();
            const tweets = (tweetsData.data || []).map(t => ({
              text: t.text?.slice(0, 280) || '',
              date: t.created_at ? new Date(t.created_at).toLocaleDateString() : '',
              link: `https://x.com/${handle}/status/${t.id}`,
            }));
            if (tweets.length) {
              console.log(`[roundup] Got ${tweets.length} tweets for @${handle} via Twitter API v2`);
              return tweets;
            }
            console.log(`[roundup] No tweets yesterday for @${handle} via API v2`);
          } else {
            const errBody = await tweetsResp.text().catch(() => '');
            console.error(`[roundup] Twitter API v2 tweets error for @${handle}: ${tweetsResp.status} ${errBody.slice(0, 200)}`);
          }
        }
      } else {
        const errBody = await userResp.text().catch(() => '');
        console.error(`[roundup] Twitter API v2 user lookup error for @${handle}: ${userResp.status} ${errBody.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[roundup] Twitter API v2 error for @${handle}:`, err?.message || err);
    }
  }

  // ── RSSHub fallback (free, no API key) ──────────────────────────
  const rsshubHosts = ['https://rsshub.app', 'https://rsshub.rssforever.com'];
  for (const host of rsshubHosts) {
    try {
      const resp = await fetch(`${host}/twitter/user/${encodeURIComponent(handle)}`, {
        headers: { 'User-Agent': 'OpenClaw/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) continue;
      const xml = await resp.text();
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
        const block = match[1];
        const title = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
        const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
        const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
        if (title) items.push({ text: title.replace(/<[^>]+>/g, '').trim(), date: pubDate ? new Date(pubDate).toLocaleDateString() : '', link });
      }
      if (items.length) {
        console.log(`[roundup] Got ${items.length} tweets for @${handle} via RSSHub`);
        return items;
      }
    } catch (err) {
      // Try next host
    }
  }

  // ── Google News fallback (last resort) ──────────────────────────
  try {
    console.log(`[roundup] API + RSSHub unavailable for @${handle}, falling back to Google News`);
    const articles = await fetchNewsRSS(`"@${handle}" OR "${handle}" twitter`, 3);
    return articles.map(a => ({
      text: a.title,
      date: a.date ? new Date(a.date).toLocaleDateString() : '',
      link: a.link,
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

// Fetch news mentions of a person associated with LinkedIn (not actual LinkedIn posts)
async function fetchLinkedInMentions(name) {
  const displayName = name.replace(/-/g, ' ');
  return fetchNewsRSS(`"${displayName}"`, 5);
}

// Use Claude to compile a digest
async function compileDigest(anthropic, model, sections, kind) {
  try {
    const rawContent = sections.map(s => `## ${s.heading}\n${s.items.join('\n')}`).join('\n\n');

    const resp = await anthropic.messages.create({
      model,
      max_tokens: 2000,
      system:
        `You are a digest writer. Compile these raw items into a clean, scannable ${kind} email digest. ` +
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

async function sendDailyRoundup({ config, anthropic, octokit, gmail, calendar, tasks, brain }) {
  const rc = config.roundup;
  const envTopics = parseList(rc.dailyTopics);
  const brainTopics = brain ? await brain.loadRoundupTopics() : [];
  const dailyTopics = [...new Set([...envTopics, ...brainTopics])];
  const envHandles = parseList(rc.twitterHandles);
  const brainHandles = brain ? await brain.loadRoundupHandles() : [];
  const handles = [...new Set([...envHandles, ...brainHandles])];
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

  // Learn nudge
  if (brain) {
    try {
      const nudge = await getLearnNudge(brain, octokit || null, config);
      if (nudge) {
        sections.push({ heading: '🎓 Coding Lesson', items: [nudge] });
      }
    } catch (err) {
      console.error('[roundup] Learn nudge error:', err?.message || err);
    }
  }

  // Twitter/X
  if (handles.length) {
    const allTweets = [];
    for (const handle of handles) {
      const tweets = await fetchTweets(rc.xBearerToken, handle);
      allTweets.push(...tweets.map(t => `• @${handle}: ${t.text}${t.link ? ` — ${t.link}` : ''}`));
    }
    if (allTweets.length) sections.push({ heading: '🐦 Twitter/X', items: allTweets });
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

  // People in the news (from LinkedIn names config)
  if (linkedinNames.length) {
    const allMentions = [];
    for (const name of linkedinNames) {
      const mentions = await fetchLinkedInMentions(name);
      const displayName = name.replace(/-/g, ' ');
      allMentions.push(...mentions.map(u => `• ${displayName}: ${u.title} — ${u.link}`));
    }
    if (allMentions.length) sections.push({ heading: '👤 People in the News', items: allMentions });
  }

  if (!sections.length) { console.log('[roundup] No content for daily roundup'); return null; }

  let body;
  if (anthropic) {
    body = await compileDigest(anthropic, config.anthropic.model, sections, 'daily');
  } else {
    body = sections.map(s => `${s.heading}\n${s.items.join('\n')}`).join('\n\n');
  }

  let githubUser = '';
  if (octokit) {
    try {
      const { data } = await octokit.users.getAuthenticated();
      githubUser = data.name || data.login || '';
    } catch { /* ignore */ }
  }
  const datePart = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const subject = githubUser ? `Roundup for ${githubUser}, ${datePart}` : `Roundup for ${datePart}`;
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

async function sendWeeklyRoundup({ config, anthropic, octokit, gmail, brain }) {
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

  let githubUser = '';
  if (octokit) {
    try {
      const { data } = await octokit.users.getAuthenticated();
      githubUser = data.name || data.login || '';
    } catch { /* ignore */ }
  }
  const datePart = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const subject = githubUser ? `Weekly Roundup for ${githubUser}, ${datePart}` : `Weekly Roundup for ${datePart}`;
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

  const CHECK_INTERVAL = 5 * 60 * 1000; // check every 5 minutes for more precise timing

  // Get current hour in EST/EDT
  function estHour() {
    return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
  }
  function estDay() {
    return new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long' }).toLowerCase();
  }
  function estDateKey() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  }

  async function check() {
    const hour = estHour();
    const today = estDay();
    const dateKey = estDateKey();

    // Daily — send every day at configured hour (EST), only during that hour
    const sendHour = rc.sendHour || 9;
    if (hasDaily && hour === sendHour && lastDailySent !== dateKey) {
      lastDailySent = dateKey;
      try {
        await sendDailyRoundup(deps);
      } catch (err) {
        console.error('[roundup] Daily roundup error:', err?.message || err);
      }
    }

    // Weekly — send on the configured day at configured hour (EST)
    if (hasWeekly && today === rc.weeklyDay.toLowerCase() && hour === sendHour && lastWeeklySent !== dateKey) {
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
