'use strict';

const { config } = require('./src/config');
const { startHealthServer } = require('./src/http');
const { loadGcpCredentialsMaybe, createStorageClient } = require('./src/clients/gcp');
const { createAnthropicClient } = require('./src/clients/anthropic');
const { createOpenAIClient } = require('./src/clients/openai');
const { createOctokit } = require('./src/clients/github');
const { createBrain } = require('./src/brain/brain');
const { createGmailClient } = require('./src/clients/gmail');
const { indexRepos } = require('./src/repo-index');

(async () => {
  console.log(`Starting OpenClaw (platform: ${config.messagingPlatform})...`);
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

  const deps = { config, anthropic, openai, octokit, storage, brain, gmail };

  if (config.messagingPlatform === 'sms') {
    // SMS/WhatsApp mode — Express server handles both health + webhooks
    const { startSmsApp } = require('./src/sms');
    await startSmsApp(deps);
  } else {
    // Slack mode (default)
    startHealthServer(config.port);
    const { startSlackApp } = require('./src/app');
    await startSlackApp(deps);
  }

  console.log(`OpenClaw started in ${Date.now() - startTime}ms`);

  // Index repos in background (don't block startup)
  const repoList = (process.env.OPENCLAW_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);
  indexRepos({ octokit, brain, repos: repoList }).catch(e => console.error('Repo index error:', e?.message || e));
})();
