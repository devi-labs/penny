# Contributing to Penny

Thanks for your interest in contributing! This doc covers how to get set up and guidelines for contributions.

## Development Setup

### 1. Clone and install

```bash
git clone https://github.com/devi-labs/penny.git
cd penny
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required for local dev:
- `TELEGRAM_BOT_TOKEN` — Get from [BotFather](https://t.me/botfather)
- `ANTHROPIC_API_KEY` — Claude API key

Optional:
- `GITHUB_TOKEN` — Personal access token with `repo` scope (needed for PR creation)

### 3. Run locally

```bash
node server.js
```

You should see:
```
⚡️ Penny Telegram server running on port 8080 (polling mode)
Claude: enabled | GitHub: enabled | Brain: enabled | Allowed users: (any)
```

### 4. Run tests

```bash
npm test
```

All tests use Node.js built-in test runner — no extra dependencies needed.

## Project Structure

```
server.js                    # Entry point
src/
├── telegram.js              # Telegram message handler + command router
├── config.js                # Environment config
├── skills.js                # Self-healing skill generator
├── reservations.js          # Restaurant booking
├── roundup.js               # Weekly digest emails
├── brain/brain.js           # Persistent memory (local fs + GCS backup)
├── agent/                   # Sandbox planner & executor
├── clients/                 # API client factories
├── github/                  # GitHub integrations
└── util/                    # Helpers (parse, proc, rateLimit)
test/
├── brain.test.js
├── parse.test.js
├── plan.test.js
└── skills.test.js
```

## Code Style

- Use `'use strict';` at the top of all modules
- Prefer `async/await` over promises
- Use CommonJS (`require`/`module.exports`) for consistency
- Keep functions focused (one job per function)
- Add comments for non-obvious logic
- Use descriptive variable names

## Pull Request Guidelines

1. **One feature per PR** — Keep changes focused
2. **Run tests** — `npm test` should pass with no failures
3. **Test locally** — Ensure the bot starts and responds in Telegram
4. **Update README** if adding user-facing features
5. **No secrets in code** — Use env vars, never hardcode tokens

## Adding New Commands

To add a new command to the Telegram handler:

1. Add the handler in `src/telegram.js` inside `handleMessage()`
2. Keep the handler concise; extract complex logic to separate modules
3. Update help text in the `helpText()` function
4. Add error handling and brain error recording

Example:

```javascript
if (lower.startsWith('my command')) {
  try {
    // Your logic here
    await sendReply(chatId, 'Response');
    return;
  } catch (err) {
    logError('My command error:', err?.message || err);
    await brain.recordThreadError(threadKey, {
      lastError: err?.message,
      lastErrorContext: 'mycommand',
    });
    await sendReply(chatId, `❌ Error: ${err?.message}`);
    return;
  }
}
```

## Adding New Sandbox Commands

The sandbox uses a denylist (not allowlist) — see `commandAllowed()` in `src/util/proc.js`. Commands like `rm`, `curl`, `wget`, `sudo`, and `docker` are blocked.

To modify the denylist:

1. Edit the `deny` set in `src/util/proc.js`
2. Update the planner prompt in `src/agent/plan.js` to match
3. Test thoroughly to ensure no security issues

## Security Considerations

When contributing, please ensure:

- **No arbitrary command execution** — Only safe commands should reach the sandbox
- **Input sanitization** — Don't trust user input in commands or prompts
- **Secret protection** — Never log or expose tokens
- **Sandbox isolation** — Generated skills run in `vm` with no `require`, `fs`, or `process`
- **Rate limiting** — Prevent abuse

## Questions?

Open an issue or discussion on GitHub. We're happy to help!

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
