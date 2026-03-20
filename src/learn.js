'use strict';

// ── Learn to Code — interactive coding tutor ─────────────────────
// Lessons live in a GitHub repo (syllabus.md + lessons/*.md).
// Progress is tracked per-user in the brain's thread state.

// ── GitHub helpers ───────────────────────────────────────────────

async function fetchFileFromRepo(octokit, repoFullName, filePath) {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) return null;
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: filePath });
    if (data.encoding === 'base64' && data.content) {
      return Buffer.from(data.content, 'base64').toString('utf8');
    }
    return null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function commitFileToRepo(octokit, repoFullName, filePath, content, message) {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) throw new Error('Invalid repo');

  let sha;
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: filePath });
    sha = data.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  await octokit.repos.createOrUpdateFileContents({
    owner, repo, path: filePath,
    message,
    content: Buffer.from(content).toString('base64'),
    ...(sha ? { sha } : {}),
  });
}

// ── Syllabus parsing ────────────────────────────────────────────

function parseSyllabus(markdown) {
  // Expects lines like:
  //   1. lessons/01-what-is-github.md
  //   2. lessons/02-what-is-code.md
  // Or:  - [What is GitHub?](lessons/01-what-is-github.md)
  const lessons = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    // Markdown link style: [Title](path)
    const linkMatch = line.match(/\[([^\]]+)\]\(([^)]+\.md)\)/);
    if (linkMatch) {
      lessons.push({ title: linkMatch[1].trim(), path: linkMatch[2].trim() });
      continue;
    }
    // Plain path style: 1. lessons/01-foo.md or - lessons/01-foo.md
    const pathMatch = line.match(/(?:^\s*(?:\d+[.)]\s*|-\s*))?(lessons\/[^\s]+\.md)/);
    if (pathMatch) {
      const path = pathMatch[1].trim();
      const title = path.replace(/^lessons\//, '').replace(/\.md$/, '').replace(/^\d+-/, '').replace(/-/g, ' ');
      lessons.push({ title, path });
    }
  }
  return lessons;
}

// ── Lesson parsing ──────────────────────────────────────────────

function parseLesson(markdown) {
  const sections = {
    title: '',
    explanation: '',
    codeExample: '',
    challenge: '',
    successCriteria: '',
    raw: markdown,
  };

  // Extract title from first heading
  const titleMatch = markdown.match(/^#\s+(.+)/m);
  if (titleMatch) sections.title = titleMatch[1].trim();

  // Split by headings (## or ###)
  const headingPattern = /^#{2,3}\s+(.+)/gm;
  const headings = [];
  let match;
  while ((match = headingPattern.exec(markdown)) !== null) {
    headings.push({ name: match[1].trim().toLowerCase(), index: match.index, fullMatch: match[0] });
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index + headings[i].fullMatch.length;
    const end = i + 1 < headings.length ? headings[i + 1].index : markdown.length;
    const content = markdown.slice(start, end).trim();
    const name = headings[i].name;

    if (/concept|explanation|what|learn/i.test(name)) {
      sections.explanation = content;
    } else if (/example|code/i.test(name)) {
      sections.codeExample = content;
    } else if (/challenge|try|exercise|your turn/i.test(name)) {
      sections.challenge = content;
    } else if (/success|criteria|check|evaluation/i.test(name)) {
      sections.successCriteria = content;
    }
  }

  // Fallback: if no structured sections found, treat everything after title as explanation
  if (!sections.explanation && !sections.challenge) {
    const afterTitle = titleMatch ? markdown.slice(titleMatch.index + titleMatch[0].length).trim() : markdown;
    sections.explanation = afterTitle;
  }

  return sections;
}

// ── Progress helpers ────────────────────────────────────────────

function getProgress(threadState) {
  return threadState?.learnProgress || {
    currentLesson: 1,
    completed: [],
    lastActivity: null,
  };
}

function progressSummary(progress, syllabus) {
  const total = syllabus.length;
  const done = (progress.completed || []).length;
  const current = progress.currentLesson || 1;

  const greeting = progress.learnerName ? `Hey ${progress.learnerName}! ` : '';
  const langNote = progress.language && progress.language.toLowerCase() !== 'english'
    ? `\n🌍 Learning in: ${progress.language}`
    : '';

  if (done >= total) {
    return `${greeting}You've completed all ${total} lessons! Amazing work! 🎉${langNote}`;
  }

  const currentLesson = syllabus[current - 1];
  const lessonName = currentLesson ? currentLesson.title : `Lesson ${current}`;
  const pct = Math.round((done / total) * 100);
  const bar = progressBar(done, total);

  return [
    `🎓 ${greeting}Learn to Code`,
    '',
    `${bar} ${done}/${total} lessons (${pct}%)`,
    '',
    `📖 Next up: Lesson ${current} — ${lessonName}`,
    progress.lastActivity ? `Last activity: ${progress.lastActivity}` : '',
    langNote,
    '',
    'Type "learn next" to start your next lesson!',
    '',
    '📱 Browse your code in the GitHub app on your phone!',
  ].filter(Boolean).join('\n');
}

function progressBar(done, total) {
  const filled = Math.round((done / total) * 10);
  return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

// ── Topics (learn more about X) ─────────────────────────────────

function parseTopics(markdown) {
  if (!markdown) return [];
  return markdown.split('\n')
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function formatTopics(topics) {
  if (!topics.length) return 'No topics requested yet. Use "learn more about <topic>" to add one!';
  return '📝 Requested Topics:\n\n' + topics.map((t, i) => `${i + 1}. ${t}`).join('\n');
}

function addTopicToMarkdown(existingMarkdown, topic) {
  const lines = (existingMarkdown || '').trim();
  return lines ? `${lines}\n- ${topic}` : `- ${topic}`;
}

function removeTopicFromMarkdown(existingMarkdown, topic) {
  const lines = (existingMarkdown || '').split('\n');
  const filtered = lines.filter(line => {
    const clean = line.replace(/^[-*]\s*/, '').trim().toLowerCase();
    return clean !== topic.toLowerCase();
  });
  return filtered.join('\n').trim();
}

// ── Lesson delivery (Claude adapts lesson for Telegram) ─────────

async function deliverLesson(anthropic, model, lesson, lessonNumber, { learnerName, language } = {}) {
  const nameCtx = learnerName ? `The learner's name is ${learnerName}. Use their name occasionally to make it personal.` : '';
  const langCtx = language && language.toLowerCase() !== 'english'
    ? `IMPORTANT: Teach this lesson in ${language}. All explanations, analogies, encouragement, and the challenge prompt must be in ${language}. Code keywords and syntax stay in English (they have to — that's how code works), but everything else should be in ${language}.`
    : '';

  const prompt = [
    `Adapt this coding lesson for a Telegram chat conversation. The learner is a total beginner who has never coded before.`,
    nameCtx,
    langCtx,
    '',
    `Lesson ${lessonNumber}: ${lesson.title}`,
    '',
    lesson.explanation ? `Topic:\n${lesson.explanation}` : '',
    lesson.codeExample ? `Code example:\n${lesson.codeExample}` : '',
    lesson.challenge ? `Challenge:\n${lesson.challenge}` : '',
  ].filter(Boolean).join('\n');

  try {
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 1500,
      system:
        'You are a friendly, encouraging coding tutor teaching someone who has NEVER coded before. ' +
        'Adapt the lesson content into a conversational Telegram message. ' +
        'The learner is on their PHONE — keep messages short, use short lines, and break things into small chunks. ' +
        'Use simple analogies. Break concepts into small pieces. ' +
        'Use emojis sparingly to keep it fun. ' +
        'End with the challenge prompt — tell them to reply with their attempt. ' +
        'If there\'s a code example, keep it short and format it nicely. ' +
        'Keep the tone casual and encouraging, like a patient friend teaching. ' +
        'Do NOT use markdown headers — just plain text with line breaks. ' +
        'When referencing files or repos, mention they can view them in the GitHub app on their phone. ' +
        (langCtx ? `Remember: teach in ${language}, but code stays in English.` : ''),
      messages: [{ role: 'user', content: prompt }],
    });
    return resp.content?.find(c => c.type === 'text')?.text?.trim() || lesson.raw;
  } catch {
    return lesson.raw;
  }
}

// ── Challenge evaluation ────────────────────────────────────────

async function evaluateChallenge(anthropic, model, lesson, userCode, { learnerName, language } = {}) {
  const nameCtx = learnerName ? `The student's name is ${learnerName}.` : '';
  const langCtx = language && language.toLowerCase() !== 'english'
    ? `Write your feedback in ${language}.`
    : '';

  const prompt = [
    `A coding student submitted this attempt for a challenge.`,
    nameCtx,
    '',
    `Lesson: ${lesson.title}`,
    lesson.challenge ? `Challenge: ${lesson.challenge}` : '',
    lesson.successCriteria ? `Success criteria: ${lesson.successCriteria}` : '',
    '',
    `Student's code:`,
    '```',
    userCode,
    '```',
    '',
    'Evaluate their attempt. Return JSON: {"passed": true/false, "feedback": "conversational feedback"}',
    'Be encouraging even if wrong. If close, give a hint. If correct, celebrate!',
    langCtx,
  ].filter(Boolean).join('\n');

  try {
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 500,
      system:
        'You are a friendly coding tutor evaluating a beginner\'s challenge attempt. ' +
        'Return ONLY valid JSON with "passed" (boolean) and "feedback" (string). ' +
        'Be encouraging and conversational. Give specific hints if wrong. Celebrate if correct. ' +
        (langCtx ? `Write the feedback string in ${language}.` : ''),
      messages: [{ role: 'user', content: prompt }],
    });
    let raw = resp.content?.find(c => c.type === 'text')?.text?.trim() || '';
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(raw);
  } catch {
    return { passed: false, feedback: 'I had trouble checking your answer — try again or type "learn next" to move on!' };
  }
}

// ── Save code to project repo ───────────────────────────────────

async function saveToProjectRepo(octokit, projectRepo, userName, lessonNumber, code, filename) {
  if (!projectRepo) return null;
  const safeUser = (userName || 'learner').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const filePath = filename || `${safeUser}/lesson-${String(lessonNumber).padStart(2, '0')}/code.js`;
  try {
    await commitFileToRepo(octokit, projectRepo, filePath, code, `Add ${safeUser}'s code from lesson ${lessonNumber}`);
    return { repo: projectRepo, path: filePath };
  } catch (e) {
    console.error('[learn] Failed to save to project repo:', e?.message || e);
    return null;
  }
}

// ── Main command handler ────────────────────────────────────────

async function handleLearnCommand({
  command, args, userId, userName, threadKey, threadState,
  brain, octokit, anthropic, model, config,
  sendReply, sendAdminAlert,
}) {
  const learnRepo = config.learn?.repo;
  if (!learnRepo) {
    await sendReply('Learn to Code is not configured. Set LEARN_REPO in your .env file.');
    return;
  }
  if (!octokit) {
    await sendReply('GitHub is not configured (GITHUB_TOKEN missing).');
    return;
  }

  const progress = getProgress(threadState);
  const isAdmin = config.telegram.adminUserId && String(userId) === String(config.telegram.adminUserId);
  const projectRepos = (config.learn?.projectRepos || '').split(',').map(s => s.trim()).filter(Boolean);

  // ── learn off ──────────────────────────────────────────────────
  if (command === 'learn' && args === 'off') {
    await brain.saveThread(threadKey, {
      learnProgress: { ...progress, paused: true },
    });
    await sendReply('🔇 Learning paused. You won\'t get lesson nudges in the daily roundup.\n\nType "learn on" whenever you\'re ready to come back!');
    // Alert admin
    if (sendAdminAlert && (!isAdmin)) {
      const displayName = userName || `User ${userId}`;
      await sendAdminAlert(`⚠️ ${displayName} (${userId}) turned off learning nudges.`);
    }
    return;
  }

  // ── learn on ──────────────────────────────────────────────────
  if (command === 'learn' && args === 'on') {
    await brain.saveThread(threadKey, {
      learnProgress: { ...progress, paused: false },
    });
    await sendReply('🔔 Learning is back on! You\'ll get nudges in the daily roundup again.\n\nType "learn next" to jump back in!');
    return;
  }

  // ── learn language <lang> ───────────────────────────────────────
  if (command === 'learn' && args && args.startsWith('language ')) {
    const lang = args.replace(/^language\s+/, '').trim();
    if (!lang) {
      await sendReply('Usage: learn language Spanish\n\nThis changes the language lessons are taught in. Code stays in English (it has to!) but explanations, encouragement, and feedback will be in your language.');
      return;
    }
    await brain.saveThread(threadKey, {
      learnProgress: { ...progress, language: lang },
    });
    await sendReply(`🌍 Got it! I'll teach you in ${lang} from now on. Code keywords stay in English, but everything else will be in ${lang}.\n\nType "learn language English" to switch back.`);
    return;
  }

  // ── learn (show progress or onboard) ────────────────────────────
  if (command === 'learn' && !args) {
    // First time — ask for their name
    if (!progress.learnerName) {
      await brain.saveThread(threadKey, {
        learnProgress: { ...progress, awaitingName: true },
      });
      await sendReply('🎓 Welcome to Learn to Code!\n\nWhat\'s your name?');
      return;
    }

    const syllabusText = await fetchFileFromRepo(octokit, learnRepo, 'syllabus.md');
    if (!syllabusText) {
      await sendReply('Could not find syllabus.md in the learn repo. Make sure it exists!');
      return;
    }
    const syllabus = parseSyllabus(syllabusText);
    if (!syllabus.length) {
      await sendReply('The syllabus is empty. Add some lessons to syllabus.md!');
      return;
    }
    await sendReply(progressSummary(progress, syllabus));
    return;
  }

  // ── learn next ────────────────────────────────────────────────
  if (command === 'learn' && args === 'next') {
    if (!anthropic) {
      await sendReply('Claude is not configured (ANTHROPIC_API_KEY missing).');
      return;
    }

    const syllabusText = await fetchFileFromRepo(octokit, learnRepo, 'syllabus.md');
    if (!syllabusText) {
      await sendReply('Could not find syllabus.md in the learn repo.');
      return;
    }
    const syllabus = parseSyllabus(syllabusText);
    if (!syllabus.length) {
      await sendReply('The syllabus is empty!');
      return;
    }

    const current = progress.currentLesson || 1;
    if (current > syllabus.length) {
      await sendReply('🎉 You\'ve completed all the lessons! Amazing work!\n\nWant to learn more? Use "learn more about <topic>" to request new lessons.');
      return;
    }

    const lessonEntry = syllabus[current - 1];
    await sendReply(`📖 Loading Lesson ${current}: ${lessonEntry.title}...`);

    const lessonMd = await fetchFileFromRepo(octokit, learnRepo, lessonEntry.path);
    if (!lessonMd) {
      await sendReply(`Could not load ${lessonEntry.path} from the learn repo.`);
      return;
    }

    const lesson = parseLesson(lessonMd);
    const adapted = await deliverLesson(anthropic, model, lesson, current, {
      learnerName: progress.learnerName,
      language: progress.language,
    });

    // Save the active lesson so we can evaluate the challenge response
    await brain.saveThread(threadKey, {
      learnProgress: {
        ...progress,
        lastActivity: new Date().toISOString().slice(0, 10),
      },
      activeLesson: {
        number: current,
        title: lesson.title,
        challenge: lesson.challenge,
        successCriteria: lesson.successCriteria,
        path: lessonEntry.path,
      },
    });

    await sendReply(adapted);
    return;
  }

  // ── learn list (show requested topics) ────────────────────────
  if (command === 'learn' && args === 'list') {
    const topicsMd = await fetchFileFromRepo(octokit, learnRepo, 'topics.md');
    const topics = parseTopics(topicsMd || '');
    await sendReply(formatTopics(topics));
    return;
  }

  // ── learn more about <topic> ──────────────────────────────────
  if (command === 'learn' && args && args.startsWith('more about ')) {
    const topic = args.replace(/^more about\s+/, '').trim();
    if (!topic) {
      await sendReply('What would you like to learn about? Try: learn more about APIs');
      return;
    }

    const topicsMd = await fetchFileFromRepo(octokit, learnRepo, 'topics.md') || '';
    const existing = parseTopics(topicsMd);
    if (existing.some(t => t.toLowerCase() === topic.toLowerCase())) {
      await sendReply(`"${topic}" is already on the list! We'll get to it.`);
      return;
    }

    const updated = addTopicToMarkdown(topicsMd, topic);
    await commitFileToRepo(octokit, learnRepo, 'topics.md', updated, `Add topic request: ${topic}`);
    await sendReply(`✅ Added "${topic}" to the learning wishlist! I'll work on creating a lesson for that.`);
    return;
  }

  // ── learn remove <topic> (admin only) ─────────────────────────
  if (command === 'learn' && args && args.startsWith('remove ')) {
    if (!isAdmin) {
      await sendReply('Only admins can remove topics.');
      return;
    }
    const topic = args.replace(/^remove\s+/, '').trim();
    if (!topic) {
      await sendReply('Usage: learn remove <topic>');
      return;
    }

    const topicsMd = await fetchFileFromRepo(octokit, learnRepo, 'topics.md') || '';
    const updated = removeTopicFromMarkdown(topicsMd, topic);
    await commitFileToRepo(octokit, learnRepo, 'topics.md', updated, `Remove topic: ${topic}`);
    await sendReply(`✅ Removed "${topic}" from the topics list.`);
    return;
  }

  // ── learn reset (admin only) ──────────────────────────────────
  if (command === 'learn' && args === 'reset') {
    if (!isAdmin) {
      await sendReply('Only admins can reset progress.');
      return;
    }
    await brain.saveThread(threadKey, {
      learnProgress: { currentLesson: 1, completed: [], lastActivity: null },
      activeLesson: null,
    });
    await sendReply('✅ Learning progress has been reset. Start fresh with "learn next"!');
    return;
  }

  // ── learn syllabus (show full lesson list) ─────────────────────
  if (command === 'learn' && args === 'syllabus') {
    const syllabusText = await fetchFileFromRepo(octokit, learnRepo, 'syllabus.md');
    if (!syllabusText) {
      await sendReply('Could not find syllabus.md in the learn repo.');
      return;
    }
    const syllabus = parseSyllabus(syllabusText);
    if (!syllabus.length) {
      await sendReply('The syllabus is empty!');
      return;
    }
    const completed = progress.completed || [];
    const lines = syllabus.map((l, i) => {
      const num = i + 1;
      const check = completed.includes(num) ? '✅' : (num === (progress.currentLesson || 1) ? '👉' : '  ');
      return `${check} ${num}. ${l.title}`;
    });
    await sendReply(`📚 Lesson Plan:\n\n${lines.join('\n')}\n\n📱 View the full lessons in the GitHub app!`);
    return;
  }

  // ── learn help ────────────────────────────────────────────────
  if (command === 'learn' && args === 'help') {
    await sendReply(learnHelpText());
    return;
  }

  await sendReply('I didn\'t understand that. Try "learn", "learn next", or "learn help".');
}

// ── Challenge response handler ──────────────────────────────────
// Called when a user sends a message while they have an active lesson
// or when we're awaiting their name during onboarding.

async function handleChallengeResponse({
  userCode, userName, threadKey, threadState,
  brain, octokit, anthropic, model, config,
  sendReply,
}) {
  // ── Onboarding: awaiting name ─────────────────────────────────
  const progress = getProgress(threadState);
  if (progress.awaitingName) {
    const learnerName = userCode.trim().split(/\s+/).slice(0, 3).join(' '); // cap at 3 words
    await brain.saveThread(threadKey, {
      learnProgress: { ...progress, learnerName, awaitingName: false },
    });
    await sendReply(`Nice to meet you, ${learnerName}! 🎉\n\nLet's start your first lesson...`);

    // Auto-start lesson 1
    const learnRepo = config.learn?.repo;
    if (!learnRepo || !octokit || !anthropic) return true;

    const syllabusText = await fetchFileFromRepo(octokit, learnRepo, 'syllabus.md');
    if (!syllabusText) { await sendReply('Could not find syllabus.md in the learn repo.'); return true; }
    const syllabus = parseSyllabus(syllabusText);
    if (!syllabus.length) { await sendReply('The syllabus is empty!'); return true; }

    const lessonEntry = syllabus[0];
    const lessonMd = await fetchFileFromRepo(octokit, learnRepo, lessonEntry.path);
    if (!lessonMd) { await sendReply(`Could not load ${lessonEntry.path}.`); return true; }

    const lesson = parseLesson(lessonMd);
    const adapted = await deliverLesson(anthropic, model, lesson, 1, {
      learnerName,
      language: progress.language,
    });

    await brain.saveThread(threadKey, {
      learnProgress: { ...progress, learnerName, awaitingName: false, lastActivity: new Date().toISOString().slice(0, 10) },
      activeLesson: {
        number: 1,
        title: lesson.title,
        challenge: lesson.challenge,
        successCriteria: lesson.successCriteria,
        path: lessonEntry.path,
      },
    });

    await sendReply(adapted);
    return true;
  }

  const activeLesson = threadState?.activeLesson;
  if (!activeLesson) return false; // No active lesson

  if (!anthropic) {
    await sendReply('Claude is not configured — can\'t evaluate your code right now.');
    return true;
  }

  const lesson = {
    title: activeLesson.title,
    challenge: activeLesson.challenge,
    successCriteria: activeLesson.successCriteria,
  };

  const result = await evaluateChallenge(anthropic, model, lesson, userCode, {
    learnerName: progress.learnerName,
    language: progress.language,
  });

  if (result.passed) {
    const completed = [...new Set([...(progress.completed || []), activeLesson.number])];
    const nextLesson = activeLesson.number + 1;

    await brain.saveThread(threadKey, {
      learnProgress: {
        ...progress,
        currentLesson: nextLesson,
        completed,
        lastActivity: new Date().toISOString().slice(0, 10),
      },
      activeLesson: null,
    });

    let saveMsg = '';
    const projectRepo = (config.learn?.projectRepos || '').split(',').map(s => s.trim()).filter(Boolean)[0];
    if (projectRepo && octokit) {
      const saved = await saveToProjectRepo(octokit, projectRepo, userName, activeLesson.number, userCode);
      if (saved) {
        saveMsg = `\n\n📁 I saved your code to your project! Open the GitHub app on your phone to see it.`;
      }
    }

    await sendReply(
      `${result.feedback}${saveMsg}\n\n` +
      `✅ Lesson ${activeLesson.number} complete! Type "learn next" for the next one.`
    );
  } else {
    await sendReply(
      `${result.feedback}\n\n` +
      'Give it another try! Or type "learn next" to skip ahead.'
    );
  }

  return true;
}

// ── Learn nudge for daily roundup ───────────────────────────────

async function getLearnNudge(brain, octokit, config) {
  const learnRepo = config.learn?.repo;
  if (!learnRepo || !octokit) return null;

  try {
    const chatIds = await brain.loadActiveChats();
    if (!chatIds.length) return null;

    // Check the first active user's progress (for single-user setups)
    // In multi-user setups, we'd loop over users — keeping it simple for now
    const threadKey = brain.threadKeyFromTelegram(chatIds[0]);
    const threadState = await brain.loadThread(threadKey);
    const progress = getProgress(threadState);

    // Respect the paused flag — no nudge if learner turned it off
    if (progress.paused) return null;

    const syllabusText = await fetchFileFromRepo(octokit, learnRepo, 'syllabus.md');
    if (!syllabusText) return null;

    const syllabus = parseSyllabus(syllabusText);
    if (!syllabus.length) return null;

    const parts = [];

    const done = (progress.completed || []).length;
    if (done < syllabus.length) {
      const current = progress.currentLesson || 1;
      const currentLesson = syllabus[current - 1];
      const lessonName = currentLesson ? currentLesson.title : `Lesson ${current}`;
      parts.push(`🎓 Ready for today's coding lesson? You're on Lesson ${current}: ${lessonName}!\nType "learn" to jump in 🚀`);
    } else {
      parts.push('🎓 You finished all lessons! Amazing! Check "learn list" for new topic requests.');
    }

    // Show any requested topics so the admin/teacher sees them in the roundup
    const topicsMd = await fetchFileFromRepo(octokit, learnRepo, 'topics.md');
    if (topicsMd) {
      const topics = parseTopics(topicsMd);
      if (topics.length) {
        parts.push(`📝 Requested topics: ${topics.join(', ')}`);
      }
    }

    return parts.join('\n');
  } catch (e) {
    console.error('[learn] Nudge error:', e?.message || e);
    return null;
  }
}

function learnHelpText() {
  return [
    '🎓 Learn to Code Commands:',
    '',
    '  learn — show your progress',
    '  learn next — start/continue the next lesson',
    '  learn syllabus — see all lessons',
    '  learn list — see requested topics',
    '  learn more about <topic> — request a new topic',
    '  learn language Spanish — learn in another language',
    '  learn off — pause lesson nudges',
    '  learn on — resume lesson nudges',
    '  learn help — this message',
    '',
    'Admin/teacher:',
    '  learn remove <topic> — remove a topic',
    '  learn reset — reset a learner\'s progress',
    '',
    'When you\'re in a lesson, just type your code right here and I\'ll check it!',
    '',
    '📱 Tip: Download the GitHub app on your phone to browse your code and projects!',
    'iOS: apps.apple.com/app/github/id1477376905',
    'Android: play.google.com/store/apps/details?id=com.github.android',
  ].join('\n');
}

module.exports = {
  fetchFileFromRepo,
  commitFileToRepo,
  parseSyllabus,
  parseLesson,
  getProgress,
  progressSummary,
  progressBar,
  parseTopics,
  formatTopics,
  addTopicToMarkdown,
  removeTopicFromMarkdown,
  deliverLesson,
  evaluateChallenge,
  saveToProjectRepo,
  handleLearnCommand,
  handleChallengeResponse,
  getLearnNudge,
  learnHelpText,
};
