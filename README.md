# Penny

**Your Personal AI Assistant & Tutor.** Penny lives in your Telegram — she manages your to-do lists, calendar, email, daily news, restaurant reservations, and even teaches you to code. Just text her like you would a friend.

---

## Getting Started

When you first open your Penny bot in Telegram, she'll greet you:

> "Welcome to Penny - Personal AI Assistant & Tutor. Give me the secret passcode for the room"

Send the passcode your admin gave you. Once you're in, type **help** — this will show you everything Penny can do.

---

## What Can Penny Do?

Here's a quick overview. Each feature has its own help command so you can dive deeper.

### To-Do Lists

Type **`todo help`** for the full rundown.

You can create and manage multiple lists. Add items to specific lists by name:

```
todo add buy groceries
todo add schedule dentist list Personal
todo list
todo done 3
```

You can also just talk naturally: *"remind me to call Bob by Friday"* or *"what's on my plate?"*

### Daily Roundup

Type **`roundup help`** to learn more.

Say **`roundup`** anytime and Penny will give you:
- Your calendar for the day
- Your to-do list
- Tweets from people you follow
- News on topics you care about

You can add and remove topics and Twitter handles from the list anytime. Penny also sends this automatically every morning.

### Email

Type **`email help`** for details.

Draft and send emails to anyone right through your bot. Penny will show you a preview before sending, so nothing goes out without your approval. Emails are rewritten to sound natural — not like AI wrote them.

```
check my email
find emails from Sarah
email send bob@example.com "Meeting tomorrow" Hey Bob, are we still on for tomorrow?
```

### Calendar

Type **`cal help`** for details.

Try *"what's on my schedule for today?"* — Penny can see all your calendars and manage them for you.

```
what's on my schedule?
any meetings tomorrow?
cal create "Lunch with team" 03/25 12pm 1 hour
cal calendars
```

### Learn to Code

Type **`learn`** to get started.

This is a fun one. Penny will guide you step by step through GitHub, learning how to code, and anything else you add to your list. You'll get gentle nudges during your daily roundup to keep going. You can turn it off anytime with `learn off`.

Want to learn something specific? Say **`learn more about <topic>`** anytime and Penny will draft future lessons for you.

### Restaurant Reservations

Type **`reserve help`** for details.

Two ways to book:
- **`reserve`** — Penny generates an OpenTable booking link for you
- **`call`** — Penny actually calls the restaurant and makes the reservation by phone

> Be mindful with `call` — it really does call and reserve a table.

```
book a table for 4 at Nobu on Saturday at 7pm
call +13125551234 and reserve dinner for 2 at Carbone Friday 8pm
```

### GitHub & Code

Penny can write code and open pull requests on your GitHub repos:

```
repo: your-username/your-repo
task: add a health check endpoint to the express server
```

She can also answer random questions that need computation — *"convert 72F to celsius"*, *"what day is December 25 2026"*, *"generate a random password"*. She'll write the code, run it, and remember the skill for next time.

### Support

If something isn't working right, type your configured support keyword (e.g. `support`) and Penny will send your admin a message with debug info so they can look into it. Keep the description generic but helpful.

---

## Talk Naturally

You don't need to memorize commands. Just say what you need:

| What you say | What happens |
|---|---|
| "what's on my schedule today?" | Shows your calendar |
| "remind me to call Bob by Friday" | Adds a todo with a due date |
| "what's on my plate?" | Shows your todo list |
| "mark 3 as done" | Completes todo #3 |
| "check my email" | Shows recent emails |
| "catch me up" | Sends the daily roundup |
| "learn" | Starts your next coding lesson |
| "book dinner for 4 at Nobu Saturday 7pm" | Gets a reservation link |
| "what can you do?" | Shows all commands |

---

## Quick Reference

| Command | What it does |
|---|---|
| `help` | Show everything Penny can do |
| `todo help` | To-do list commands |
| `cal help` | Calendar commands |
| `email help` | Email commands |
| `learn` | Start or continue a coding lesson |
| `learn help` | Learning system commands |
| `roundup help` | Roundup commands |
| `reserve help` | Reservation commands |
| `github help` | GitHub/PR commands |
| `brain status` | Check if memory is working |
| `skills list` | See all learned skills |

---

# Setup Guide (For Admins)

Everything below is for setting up and deploying Penny. If you're just using the bot, you can stop here.

---

## Requirements

You only need **two things** to get started:

### 1. Create a Telegram Bot

1. Open Telegram and search for **@BotFather** (blue checkmark)
2. Send: `/newbot`
3. Give it a name and username
4. Copy the **token** it gives you — save it somewhere safe

### 2. Get an Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Create an account or sign in
3. Go to **API Keys** → **Create Key**
4. Copy the key (starts with `sk-ant-`)

---

## Installation

```bash
git clone https://github.com/devi-labs/penny.git
cd penny
npm install
cp .env.example .env
```

Edit `.env` and add your tokens:

```
TELEGRAM_BOT_TOKEN=your-telegram-token
ANTHROPIC_API_KEY=your-anthropic-key
TELEGRAM_JOIN_CODE=your-secret-passcode
```

Start it up:

```bash
node server.js
```

You should see:

```
Starting Penny...
⚡️ Penny Telegram server running on port 8080 (polling mode)
```

That's it. Open Telegram, find your bot, send the passcode, and you're in.

---

## Optional Features

Add what you want, skip what you don't.

### GitHub Pull Requests

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens?type=beta)
2. Generate a new token with **`repo`** scope
3. Add to `.env`: `GITHUB_TOKEN=ghp_your-token`

### Google APIs (Email, Calendar, Todos)

These share the same credentials. Set up once, get all three.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create/select a project
2. Enable: **Gmail API**, **Google Calendar API**, **Tasks API**
3. Set up **OAuth consent screen** (External, add your email as test user)
4. Create **OAuth client ID** (Web app, redirect URI: `https://developers.google.com/oauthplayground`)
5. Go to [OAuth Playground](https://developers.google.com/oauthplayground/), use your credentials, authorize all three scopes:
   - `https://mail.google.com/`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/tasks`
6. Add to `.env`:

```
GMAIL_CLIENT_ID=your-client-id
GMAIL_CLIENT_SECRET=your-client-secret
GMAIL_REFRESH_TOKEN=your-refresh-token
GMAIL_USER_EMAIL=you@gmail.com
```

### Daily & Weekly Roundups

Penny sends a morning briefing every day at 9am EST. Add to `.env`:

```
ROUNDUP_DAILY_TOPICS=AI,startups,cybersecurity
ROUNDUP_TWITTER_HANDLES=elonmusk,naval
ROUNDUP_WEEKLY_TOPICS=machine learning,venture capital
ROUNDUP_WEEKLY_DAY=saturday
ROUNDUP_SEND_HOUR=9
X_BEARER_TOKEN=your-x-bearer-token
```

Calendar and todos are included automatically if Google APIs are set up. News works with no API keys.

### Restaurant Reservations (Phone Calls)

For AI phone calls, add to `.env`:

```
BLAND_API_KEY=your-bland-api-key
RESERVATION_CALLER_NAME=Your Name
GOOGLE_PLACES_API_KEY=your-places-key
```

### Learn to Code

Point Penny at a GitHub repo with your lesson plan:

```
LEARN_REPO=org/learn
LEARN_PROJECT_REPOS=org/learn-projects
```

---

## Keeping It Running 24/7

### Option A: Google Cloud VM (Recommended)

```bash
bash deploy-gce.sh .env
bash setup.sh .env
```

### Option B: Docker

```bash
docker build -t penny:local .
docker run -d --name penny --restart=always --env-file .env -p 8080:8080 penny:local
```

Logs: `docker logs -f penny` · Stop: `docker rm -f penny`

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Bot doesn't respond | Make sure `node server.js` is running |
| "Send the passcode" | Send the `TELEGRAM_JOIN_CODE` value |
| "ANTHROPIC_API_KEY missing" | Add your key to `.env` |
| "GITHUB_TOKEN missing" | Add a GitHub token (needed for PRs) |
| PR creation fails | Send `brain last error` to see what happened |
| Bot is slow | Claude is thinking — complex tasks take 30-60 seconds |

---

## Security

- Dangerous commands are blocked (`rm`, `curl`, `sudo`, `docker`, etc.)
- Generated code runs in a sandboxed VM with no filesystem or network access
- Per-user rate limiting (default: 20 requests per 30 seconds)
- Passcode + user ID allowlist for access control
- Outgoing emails are humanized so they sound natural
- API keys never reach generated code or AI prompts

---

## Contributing

Want to help improve Penny? See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).

## Credits

See [CREDITS.md](CREDITS.md).
