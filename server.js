'use strict';

const { config } = require('./src/config');
const { loadGcpCredentialsMaybe, createStorageClient } = require('./src/clients/gcp');
const { createAnthropicClient } = require('./src/clients/anthropic');
const { createOpenAIClient } = require('./src/clients/openai');
const { createOctokit } = require('./src/clients/github');
const { createBrain } = require('./src/brain/brain');
const { createGmailClient } = require('./src/clients/gmail');
const { createCalendarClient } = require('./src/clients/calendar');
const { createTasksClient } = require('./src/clients/tasks');
const { indexRepos } = require('./src/repo-index');

(async () => {
  console.log('Starting OpenClaw...');
  const startTime = Date.now();
  
  // Load GCP credentials if needed
  loadGcpCredentialsMaybe();

  // Create clients
  const anthropic = createAnthropicClient(config.anthropic.apiKey);
  const openai = createOpenAIClient(config.openai.apiKey);
  const octokit = createOctokit(config.github.token);
  const storage = createStorageClient(config.gcp.projectId);

  // Create brain
  const brain = createBrain({
    storage,
    bucket: config.gcp.brainBucket,
    prefix: config.gcp.brainPrefix,
  });

  // Create Gmail client
  const gmail = createGmailClient(config.gmail);

  // Create Calendar client (reuses Gmail OAuth2 creds)
  const calendar = createCalendarClient(config.gmail);

  // Create Tasks client (reuses Gmail OAuth2 creds + optional default list)
  const tasksClient = createTasksClient({ ...config.gmail, defaultListId: config.tasks?.listId });

  const deps = { config, anthropic, openai, octokit, storage, brain, gmail, calendar, tasks: tasksClient };

  const { startTelegramApp } = require('./src/telegram');
  await startTelegramApp(deps);

  // Start roundup scheduler (background)
  const { startRoundupScheduler } = require('./src/roundup');
  startRoundupScheduler(deps);

  console.log(`OpenClaw started in ${Date.now() - startTime}ms`);

  // Index repos in background (don't block startup)
  const repoList = (process.env.OPENCLAW_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);
  indexRepos({ octokit, brain, repos: repoList }).catch(e => console.error('Repo index error:', e?.message || e));
})();
