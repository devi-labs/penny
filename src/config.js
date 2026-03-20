'use strict';

const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    allowedUserIds: process.env.TELEGRAM_ALLOWED_USER_IDS || '',
    joinCode: process.env.TELEGRAM_JOIN_CODE || '',
    adminUserId: process.env.TELEGRAM_ADMIN_USER_ID || '',
    adminEmail: process.env.ADMIN_EMAIL || '',
    supportKeyword: process.env.SUPPORT_KEYWORD || 'support',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-6',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-5',
  },
  gmail: {
    clientId: process.env.GMAIL_CLIENT_ID || '',
    clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
    refreshToken: process.env.GMAIL_REFRESH_TOKEN || '',
    userEmail: process.env.GMAIL_USER_EMAIL || '',
  },
  roundup: {
    emailTo: process.env.ROUNDUP_EMAIL_TO || '',
    emailFrom: process.env.ROUNDUP_EMAIL_FROM || '',
    // Daily digest
    dailyTopics: process.env.ROUNDUP_DAILY_TOPICS || '',
    twitterHandles: process.env.ROUNDUP_TWITTER_HANDLES || '',
    linkedinNames: process.env.ROUNDUP_LINKEDIN_NAMES || '',
    // Weekly digest (sent on weeklyDay)
    weeklyTopics: process.env.ROUNDUP_WEEKLY_TOPICS || '',
    weeklyDay: process.env.ROUNDUP_WEEKLY_DAY || 'saturday',
    sendHour: parseInt(process.env.ROUNDUP_SEND_HOUR || '9', 10),
    xBearerToken: process.env.X_BEARER_TOKEN || '',
  },
  tasks: {
    listId: process.env.GOOGLE_TASKS_LIST_ID || '',
  },
  reservations: {
    blandApiKey: process.env.BLAND_API_KEY || '',
    placesApiKey: process.env.GOOGLE_PLACES_API_KEY || '',
    callerName: process.env.RESERVATION_CALLER_NAME || '',
  },
  llmProvider: process.env.LLM_PROVIDER || 'anthropic', // 'anthropic' or 'openai'
  github: {
    token: process.env.GITHUB_TOKEN,
  },
  learn: {
    repo: process.env.LEARN_REPO || '',
    projectRepos: process.env.LEARN_PROJECT_REPOS || '',
  },
  gcp: {
    projectId: process.env.GCP_PROJECT_ID || '',
    region: process.env.GCP_REGION || '',
    brainBucket: process.env.OPENCLAW_BRAIN_BUCKET || '',
    brainPrefix: (process.env.OPENCLAW_BRAIN_PREFIX || 'openclaw-brain').replace(/\/+$/, ''),
  },
  workdir: process.env.OPENCLAW_WORKDIR || '/tmp/openclaw-jobs',
  runTests: process.env.OPENCLAW_RUN_TESTS === '1',
  port: process.env.PORT || 8080,
};

module.exports = { config };
