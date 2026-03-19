# OpenClaw

**Text a task. Get a pull request.** OpenClaw is an AI coding agent you control from Telegram — it clones your repo, writes the code, and opens a PR. No IDE needed.

Powered by Claude. Describe what you want in plain English, and OpenClaw figures out the code changes, makes them, and opens a pull request on GitHub — all from a Telegram chat.

It also learns new skills on the fly. Ask it to do something it doesn't know how to do, and it'll write the code, test it, fix it if it breaks, and remember it for next time.

No coding experience needed to get it running. This guide walks you through every step.

---

## What Can It Do?

- 🤖 **Write code for you** — Describe a task, get a GitHub pull request
- 🧠 **Learn new skills** — Ask it anything actionable and it generates, tests, and self-heals code on the fly
- 💬 **Chat on Telegram** — Just text it like you would a friend
- 📧 **Manage your email** — Check, search, and send emails (auto-humanized so they don't sound like AI)
- 📅 **Manage your calendar** — View, create, and update events
- ✅ **Todo list** — Add, complete, and manage your Google Tasks
- 🍽️ **Make reservations** — Book restaurants via OpenTable or have AI call them for you
- 📰 **Daily & weekly roundups** — Get your schedule, todos, and news delivered via Telegram and/or email every morning
- 🧠 **Remembers everything** — Conversations, skills, and context persist across sessions
- 🔒 **Safe** — Sandboxed execution, rate limiting, command denylist, access control

---

## Before You Start — The Essentials

You only need **two things** to get started. Everything else is optional.

### Step 1: Create a Telegram Bot (required)

This is the bot you'll chat with on Telegram.

1. Open Telegram and search for **@BotFather** (it has a blue checkmark)
2. Send it the message: `/newbot`
3. BotFather will ask you for a **name** (e.g. `My OpenClaw`) and a **username** (e.g. `my_openclaw_bot`)
4. It will reply with a **token** that looks like `123456789:ABCdefGHI-jklMNOpqr` — **copy this and save it somewhere safe**

> 💡 This token is secret. Don't share it with anyone.

### Step 2: Get an Anthropic API Key (required)

This connects OpenClaw to Claude, the AI that does the thinking and coding.

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Create an account (or sign in)
3. Click **API Keys** in the sidebar
4. Click **Create Key**
5. Copy the key — it starts with `sk-ant-`

> 💡 Anthropic gives you some free credits to start. After that, usage is pay-as-you-go (typically a few cents per task).

**That's all you need.** The rest is optional — add features when you're ready.

---

## Installation

You'll need to use the **Terminal** (Mac/Linux) or **Command Prompt** (Windows) for these steps. Don't worry — just copy and paste each line.

### 1. Install Node.js

Node.js is what runs OpenClaw. Check if you already have it:

```bash
node --version
```

If you see a version number (like `v20.x.x`), you're good. If not:

- **Mac**: Go to [nodejs.org](https://nodejs.org/), download the LTS version, and run the installer
- **Windows**: Same — download from [nodejs.org](https://nodejs.org/) and run the installer
- **Linux**: Run `sudo apt install nodejs npm` (Ubuntu/Debian) or `sudo dnf install nodejs` (Fedora)

### 2. Download OpenClaw

```bash
git clone https://github.com/devi-labs/openclaw-secure-setup.git
cd openclaw-secure-setup
npm install
```

> 💡 If `git` isn't installed, download it from [git-scm.com](https://git-scm.com/).

### 3. Set Up Your Configuration

```bash
cp .env.example .env
```

Now open the `.env` file in any text editor (Notepad, TextEdit, VS Code — anything works).

Find these lines and fill in the values you got earlier:

```
TELEGRAM_BOT_TOKEN=paste-your-telegram-token-here
ANTHROPIC_API_KEY=paste-your-anthropic-key-here
```

If you want a joining code to keep strangers out (recommended):

```
TELEGRAM_JOIN_CODE=your-secret-code-here
```

Save the file.

### 4. Start OpenClaw

```bash
node server.js
```

You should see something like:

```
Starting OpenClaw...
⚡️ OpenClaw Telegram server running on port 8080 (polling mode)
Claude: enabled | GitHub: enabled | Brain: enabled | Allowed users: (any)
```

**That's it!** Open Telegram, find your bot, and send it a message.

> 💡 If you set a joining code, you'll need to send that code first before the bot responds.

---

## How to Use It

Open your bot in Telegram and start chatting. Here are some things you can do:

### Ask it to write code

```
repo: your-username/your-repo
task: add a health check endpoint to the express server
```

### Ask it anything actionable

Just ask — if it requires computation, data processing, or logic, OpenClaw will generate a skill, run it, and remember it:

```
convert 72°F to celsius
what day of the week is december 25 2026
generate a random 16 character password
base64 encode "hello world"
```

### Quick reference

| What to type | What it does |
|---|---|
| `help` | Show all commands |
| `repo: owner/repo` + `task: do something` | Create a pull request |
| `tell me about owner/repo` | Get a summary of a GitHub repo |
| `summarize https://github.com/.../pull/123` | Summarize a pull request |
| `email check` | Show recent emails |
| `email send user@example.com "Subject" Body` | Send an email (auto-humanized) |
| `cal` | Show today's calendar events |
| `cal create "Lunch" 03/20 12pm 1 hour` | Create a calendar event |
| `todo list` | Show your todos |
| `todo add Buy groceries` | Add a todo |
| `todo done <id>` | Complete a todo |
| `reserve table for 2 at Nobu on Saturday at 7pm` | Get an OpenTable booking link |
| `call Nobu and reserve a table for 2 on Saturday at 7pm` | AI calls the restaurant for you |
| `skills list` | See all learned skills |
| `skills delete <name>` | Remove a learned skill |
| `brain status` | Check if memory is working |
| `brain reset` | Clear conversation memory |
| `self destruct` | Shut down the VM |

---

## Self-Healing Skill System

OpenClaw learns new skills on the fly using a self-healing architecture inspired by [Voyager](https://voyager.minedojo.org/) and [Reflexion](https://arxiv.org/abs/2303.11366):

1. **Classify** — Claude decides if your message needs code or is just conversation
2. **Match** — Checks the skill library for an existing skill that fits
3. **Generate** — If no match, Claude writes a new JavaScript function
4. **Execute** — Runs the code in a sandboxed VM (no file system, no network abuse, 15s timeout)
5. **Verify** — Claude checks if the output actually answers your question (Reflexion pattern)
6. **Self-heal** — If execution or verification fails, the error is fed back to Claude to fix the code (up to 3 attempts). Each failed attempt is remembered so mistakes aren't repeated
7. **Persist** — Working skills are saved to the brain and reused on similar future requests

Skills are stored in the brain (local filesystem + optional GCS backup) and survive restarts. You can manage them with `skills list` and `skills delete <name>`.

---

## Keeping It Running 24/7

When you close your terminal, OpenClaw stops. If you want it running all the time, you have two options:

### Option A: Run in the Cloud (Recommended)

This puts OpenClaw on a Google Cloud VM that's always on. You'll need a [Google Cloud account](https://cloud.google.com/) (free tier available).

```bash
bash deploy-gce.sh .env
bash setup.sh .env
```

### Option B: Run Locally with Docker

```bash
docker build -t openclaw:local .
docker run -d --name openclaw --restart=always --env-file .env -p 8080:8080 openclaw:local
```

To check logs: `docker logs -f openclaw` · To stop: `docker rm -f openclaw`

---

## Something Not Working?

| What's happening | What to do |
|---|---|
| Bot doesn't respond at all | Make sure `node server.js` is running and check for errors in the terminal |
| Bot says "Please send the joining code" | Send the code you set in `TELEGRAM_JOIN_CODE` |
| "ANTHROPIC_API_KEY missing" | Make sure you added your Anthropic key to the `.env` file |
| "GITHUB_TOKEN missing" | Add your GitHub token to `.env` (needed for creating PRs) |
| PR creation fails | Send `brain last error` to see what went wrong |
| "Google Tasks not configured" | Re-authorize with the Tasks scope (see Google APIs section below) |
| Bot is slow to respond | Claude is thinking — complex tasks can take 30–60 seconds |
| Container keeps restarting | Check logs: `docker logs openclaw --tail 50` |

---

## Security

- **Command denylist** — `rm`, `curl`, `wget`, `sudo`, `docker`, and 20+ other dangerous commands are blocked
- **VM sandbox** — Generated skills run in Node.js `vm` with no `require`, `fs`, `process`, or `eval`
- **Rate limited** — Max 6 requests per 30 seconds per user to prevent abuse
- **Access control** — Use a joining code and/or user ID allowlist to restrict who can use it
- **Emails are humanized** — Outgoing emails are rewritten so they don't sound AI-generated
- **Secrets stay local** — API keys are read from env vars and never exposed to generated code or AI prompts
- **Temp cleanup** — Cloned repos are deleted after PR creation to prevent disk exhaustion

---

# Optional Features

Everything below is optional. Add what you want, skip what you don't.

---

## GitHub Pull Requests

Lets OpenClaw push code and create pull requests on your repos.

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens?type=beta)
2. Click **Generate new token (classic)** → name it `openclaw` → check **`repo`** scope → generate
3. Add to `.env`:

```
GITHUB_TOKEN=ghp_your-token-here
```

---

## Google APIs — Gmail, Calendar, and Todos

These three features share the same credentials. Set up once, and you get all three.

### What you'll enable

| Feature | Google API to enable | OAuth scope |
|---|---|---|
| Email (check, search, send) | Gmail API | `https://mail.google.com/` |
| Calendar (view, create, update) | Google Calendar API | `https://www.googleapis.com/auth/calendar` |
| Todos (list, add, complete) | Google Tasks API | `https://www.googleapis.com/auth/tasks` |

### Setup (about 10 minutes)

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project (or select one)

2. **Enable all three APIs** — search for each in the search bar and click **Enable**:
   - Gmail API
   - Google Calendar API
   - Tasks API

3. **Set up OAuth consent screen**:
   - Go to **APIs & Services → OAuth consent screen**
   - Choose **External**
   - Fill in the app name (e.g. "OpenClaw")
   - Add your email as a **test user**

4. **Create OAuth credentials**:
   - Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Under **Authorized redirect URIs**, add: `https://developers.google.com/oauthplayground`
   - Click **Create** → copy the **Client ID** and **Client Secret**

5. **Get a refresh token**:
   - Go to [OAuth Playground](https://developers.google.com/oauthplayground/)
   - Click the ⚙️ gear icon → check **"Use your own OAuth credentials"** → paste your Client ID and Secret
   - In the left panel, select **all three scopes**:
     - `https://mail.google.com/`
     - `https://www.googleapis.com/auth/calendar`
     - `https://www.googleapis.com/auth/tasks`
   - Click **Authorize APIs** → sign in with your Google account
   - Click **Exchange authorization code for tokens** → copy the **Refresh Token**

6. **Add to `.env`**:

```
GMAIL_CLIENT_ID=your-client-id
GMAIL_CLIENT_SECRET=your-client-secret
GMAIL_REFRESH_TOKEN=your-refresh-token
GMAIL_USER_EMAIL=you@gmail.com
```

Restart OpenClaw. You now have email, calendar, and todos working.

> 💡 If you already set up Gmail before and want to add calendar/todos, you just need to re-do step 5 with all three scopes selected, then update your refresh token in `.env`.

---

## Daily & Weekly Roundups

OpenClaw sends you a morning briefing every day at 8am — right in your Telegram chat (and optionally via email too). It automatically delivers to anyone who's messaged the bot.

**Daily roundup includes:**
- 📅 Today's calendar events
- ✅ Open todos
- 📰 News, Twitter, and LinkedIn updates

**Weekly roundup** — Deep-dive news topics, sent on Saturday (configurable)

Add to `.env`:

```
# Daily — news topics, Twitter, LinkedIn
ROUNDUP_DAILY_TOPICS=AI,startups,cybersecurity
ROUNDUP_TWITTER_HANDLES=elonmusk,naval,paulg
ROUNDUP_LINKEDIN_NAMES=satya-nadella,reid-hoffman

# Weekly — deep-dive topics (sent on Saturday)
ROUNDUP_WEEKLY_TOPICS=machine learning,venture capital
ROUNDUP_WEEKLY_DAY=saturday
```

Calendar and todos are included automatically if you have Google APIs configured (see above). News topics work with no API keys (uses Google News RSS).

To also receive roundups via email, add:

```
ROUNDUP_EMAIL_TO=you@email.com
ROUNDUP_EMAIL_FROM=you@gmail.com
```

**Test it:** Send `roundup` or `roundup daily` in your bot chat to get an instant preview.

| Key | What | Required? |
|---|---|---|
| `X_BEARER_TOKEN` | For Twitter. Get free at [developer.x.com](https://developer.x.com) | Only for Twitter |
| Gmail OAuth | For email delivery | Only if you want email (see Google APIs above) |

---

## AI Restaurant Reservations

Two ways to book:

- **`reserve`** — Generates an OpenTable booking link (no API keys needed)
- **`call`** — AI calls the restaurant and makes the reservation for you

For AI phone calls, add to `.env`:

```
BLAND_API_KEY=your-bland-api-key
RESERVATION_CALLER_NAME=Your Name
```

Get a Bland.ai key at [app.bland.ai](https://app.bland.ai).

**Optional:** Add `GOOGLE_PLACES_API_KEY` so OpenClaw can automatically look up restaurant phone numbers. Otherwise, include the number in your message: `call +13125551234 and reserve a table for 2 at Nobu on Saturday at 7pm`

---

## Architecture

```
server.js                    # Entry point
src/
├── telegram.js              # Telegram message handler + command router
├── config.js                # Environment config
├── skills.js                # Self-healing skill generator (Voyager/Reflexion)
├── reservations.js          # Restaurant booking (OpenTable + Bland.ai)
├── roundup.js               # Daily & weekly digests (schedule, todos, news)
├── brain/
│   └── brain.js             # Persistent memory (local fs + GCS backup)
├── agent/
│   ├── sandbox.js           # Sandboxed PR creation pipeline
│   └── plan.js              # Claude-powered code planner
├── clients/
│   ├── telegram.js          # Telegram polling client
│   ├── anthropic.js         # Claude client
│   ├── openai.js            # OpenAI client
│   ├── github.js            # Octokit wrapper
│   ├── gcp.js               # GCS client
│   ├── gmail.js             # Gmail client
│   ├── calendar.js          # Google Calendar client
│   └── tasks.js             # Google Tasks client
├── github/
│   ├── repo.js              # Repo info + README fetching
│   └── pr.js                # PR summarization
└── util/
    ├── proc.js              # Command runner + denylist
    ├── parse.js             # URL/task parsers
    └── rateLimit.js         # Per-user rate limiting
```

---

## Contributing

Want to help improve OpenClaw? See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).

## Credits

See [CREDITS.md](CREDITS.md).

---

⚠️ **OpenClaw writes code using AI. Always review pull requests before merging them into your project.**
