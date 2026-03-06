# OpenClaw

**AI-powered development agent that creates PRs from Slack or WhatsApp**

Describe a task in plain language. OpenClaw clones your repo, plans the changes with Claude, executes them in a sandbox, and opens a pull request — all from a text message or Slack.

## What It Does

- 🤖 **Describe a task → get a PR** — No IDE needed
- 📱 **Works via Slack, WhatsApp, or SMS** — Your choice
- 📧 **Gmail access** — Check, search, read, and send emails
- 🧠 **Remembers context** — Local-first memory that persists across conversations
- 🔒 **Secure sandbox** — Only runs `git`, `npm`, `node` — nothing else
- ☁️ **Runs on a GCE VM** — Always on, no cold starts

## Quick Start

### What You'll Need

1. **Anthropic API Key** → [console.anthropic.com](https://console.anthropic.com/)
2. **GitHub Token** → Personal access token with `repo` scope
3. **A messaging platform** — either:
   - **Slack** → App with Socket Mode enabled
   - **Twilio** → For WhatsApp or SMS ([twilio.com/try-twilio](https://www.twilio.com/try-twilio))
4. **GCP Project** *(optional)* → For cloud deployment and memory backup

### Install & Run

```bash
git clone https://github.com/your-org/openclaw-secure-setup.git
cd openclaw-secure-setup
npm install
```

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

Then start:

```bash
node server.js
```

That's it. OpenClaw will connect to Slack or start listening for Twilio webhooks depending on your `MESSAGING_PLATFORM` setting.

### Run with Docker/Podman

```bash
podman build -t openclaw:local .
podman run -d --name openclaw --env-file .env openclaw:local
```

### Deploy to GCE

See the [deployment guide](docs/DEPLOY.md) or use the included `deploy.sh` as a template. The key steps are:

1. Build and push your container image
2. Create a GCE VM with the container
3. Set your env vars (secrets via metadata or Secret Manager)
4. Open port 8080 for Twilio webhooks
5. Set your Twilio webhook URL to `http://<VM_IP>:8080/sms`

## Choose Your Messaging Platform

Set `MESSAGING_PLATFORM` in your `.env`:

| Platform | Setting | You'll Need |
|----------|---------|-------------|
| **Slack** (default) | `MESSAGING_PLATFORM=slack` | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` |
| **WhatsApp** | `MESSAGING_PLATFORM=sms` + `TWILIO_USE_WHATSAPP=1` | Twilio account + phone number |
| **SMS** | `MESSAGING_PLATFORM=sms` | Twilio account + phone number |

To restrict access to a single phone number:

```
TWILIO_ALLOWED_NUMBER=+1XXXXXXXXXX
```

## Usage

### Create a PR

```
repo: your-org/your-repo
task: add a health check endpoint to the express server
```

OpenClaw clones the repo, plans the work, runs the commands, and opens a PR.

### Other Commands

| Command | What it does |
|---------|-------------|
| `help` | Show available commands |
| `tell me about owner/repo` | Summarize a GitHub repo |
| `summarize https://github.com/.../pull/123` | Summarize a PR |
| `brain status` | Check memory status |
| `brain show` | Show what OpenClaw remembers |
| `brain reset` | Clear memory |
| `email check` | Show recent emails |
| `email search invoices` | Search your inbox |
| `email send user@email.com "Subject" Body` | Send an email |

Or just ask a question — Claude responds directly.

## How It Works

1. You send a message with a repo and task
2. Claude plans the implementation as a JSON execution plan
3. The sandbox clones the repo, creates a branch, and runs each step
4. Changes are committed, pushed, and a PR is opened
5. You get a link to the PR

All commands run in isolation — only `git`, `npm`, and `node` are allowed. No shell access, no `curl`, no `wget`.

### Memory

OpenClaw remembers things across conversations:

- **What repo you were working on** — so you don't have to repeat it
- **What tasks you've done** — global summary across all conversations
- **What went wrong** — error context for debugging

Memory is stored locally on the VM (instant reads) and backed up to Google Cloud Storage.

## Environment Variables

See [`.env.example`](.env.example) for the full list. The essentials:

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | ✅ | Claude API key |
| `GITHUB_TOKEN` | ✅ | GitHub PAT with `repo` scope |
| `MESSAGING_PLATFORM` | | `slack` or `sms` (default: `slack`) |
| `SLACK_BOT_TOKEN` | Slack | Slack bot token |
| `SLACK_APP_TOKEN` | Slack | Slack app-level token |
| `TWILIO_ACCOUNT_SID` | SMS | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | SMS | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | SMS | Your Twilio number |
| `TWILIO_ALLOWED_NUMBER` | | Restrict to one phone number |
| `TWILIO_USE_WHATSAPP` | | Set to `1` for WhatsApp |
| `GMAIL_CLIENT_ID` | Email | Gmail OAuth2 client ID |
| `GMAIL_CLIENT_SECRET` | Email | Gmail OAuth2 client secret |
| `GMAIL_REFRESH_TOKEN` | Email | Gmail OAuth2 refresh token |
| `GMAIL_USER_EMAIL` | Email | Your Gmail address |

## Security

- Only `git`, `npm`, `node` can run — everything else is blocked
- Non-root container with read-only filesystem
- Rate limiting (6 requests per 30 seconds per user)
- Phone number allowlist for SMS/WhatsApp
- Secrets stay in Secret Manager or Keychain — never exposed to the LLM

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Brain says "disabled" | GCS backup is off — memory still works locally. Set `OPENCLAW_BRAIN_BUCKET` for backup. |
| Claude plan JSON parse failed | Run `brain last error` to see what happened. Check your API key. |
| WhatsApp not receiving | Check Twilio webhook URL is `http://<IP>:8080/sms` (POST). Check firewall allows port 8080. |
| Unauthorized number rejected | Make sure `TWILIO_ALLOWED_NUMBER` matches your phone with country code (e.g., `+1`). |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome.

## License

MIT — see [LICENSE](LICENSE).

## Credits

See [CREDITS.md](CREDITS.md).

---

⚠️ **OpenClaw executes code based on AI-generated plans. Always review PRs before merging.**
