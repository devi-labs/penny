# Learn to Code — Setup Guide

This is the lesson repo for the **Learn to Code** feature. The bot reads lessons from this repo at runtime — to add or edit lessons, just push to this repo.

## Quick Start

1. Create a GitHub repo (e.g. `your-org/learn`)
2. Copy everything from this `learn-example/` folder into that repo
3. Set the env vars in your bot's `.env`:

```
LEARN_REPO=your-org/learn
LEARN_PROJECT_REPOS=your-org/learn-projects
```

4. Make sure your `GITHUB_TOKEN` has access to both repos
5. Create the project repo too (can be empty — the bot creates files via commits)
6. Restart the bot
7. Type `learn` in Telegram

## Repo Structure

```
your-learn-repo/
├── syllabus.md          # Ordered lesson list (bot reads this)
├── topics.md            # Learner-submitted topic requests (bot manages this)
└── lessons/
    ├── 01-what-is-github.md
    ├── 02-what-is-code.md
    ├── 03-variables.md
    ├── 04-if-else.md
    ├── 05-loops.md
    ├── 06-functions.md
    ├── 07-html-basics.md
    ├── 08-css-basics.md
    ├── 09-javascript-browser.md
    └── 10-first-project.md
```

## How syllabus.md Works

The bot parses `syllabus.md` to get the ordered lesson list. Two formats are supported:

**Markdown links (recommended):**
```markdown
1. [What is GitHub?](lessons/01-what-is-github.md)
2. [What is Code?](lessons/02-what-is-code.md)
```

**Plain paths:**
```markdown
1. lessons/01-what-is-github.md
2. lessons/02-what-is-code.md
```

To add a new lesson: create the `.md` file in `lessons/`, add a line to `syllabus.md`, push. The bot picks it up immediately.

## How Lesson Files Work

Each lesson file only needs **three sections** — the bot (Claude) generates the actual teaching content at delivery time. Keep them short:

```markdown
# Lesson Title

## Topic
What to teach. A sentence or two is enough — Claude knows how to explain coding concepts.

## Challenge
What the learner should try. Be specific about what to type/write.

## Success Criteria
How to evaluate their attempt. What counts as correct. Be lenient for beginners.
```

That's it. Claude adapts the topic into a conversational phone-friendly message, delivers the challenge, and evaluates the learner's response using the success criteria.

## How topics.md Works

Learners can type `learn more about APIs` and the bot commits it to `topics.md` automatically. This is a wishlist for future lessons. Admins see requested topics in the daily roundup.

Admins can remove topics: `learn remove APIs`

## Telegram Commands

| Command | Who | What |
|---|---|---|
| `learn` | Anyone | Show progress + current lesson |
| `learn next` | Anyone | Start the next lesson |
| `learn syllabus` | Anyone | See all lessons with progress |
| `learn list` | Anyone | Show requested topics |
| `learn more about <topic>` | Anyone | Request a new topic |
| `learn language Spanish` | Anyone | Switch teaching language |
| `learn in French` | Anyone | Same as above, shorthand |
| `learn off` | Anyone | Pause nudges (alerts admin) |
| `learn on` | Anyone | Resume nudges |
| `learn help` | Anyone | Show all commands |
| `learn remove <topic>` | Admin | Remove a requested topic |
| `learn reset` | Admin | Reset a learner's progress |

## How It Works

1. Learner types `learn next`
2. Bot fetches the lesson `.md` from this repo via GitHub API
3. Claude adapts it into a conversational Telegram message (optimized for phone)
4. Learner replies with their code attempt
5. Claude evaluates it against the success criteria
6. Correct → saves code to the project repo, advances to next lesson
7. Wrong → gives hints, lets them retry

## Multi-Language Support

Learners can type `learn language Spanish` (or any language) and Claude will teach in that language. Code keywords stay in English — everything else (explanations, encouragement, feedback) switches to the chosen language.

## Daily Roundup Nudge

If the learner hasn't paused (`learn off`), the daily roundup includes:

```
🎓 Ready for today's coding lesson? You're on Lesson 3: Variables!
Type "learn" to jump in 🚀

📝 Requested topics: APIs, Databases
```

## Project Repo

When a learner passes a challenge, their code is saved to the project repo under their name:

```
learn-projects/
├── alex/
│   ├── lesson-01/code.js
│   ├── lesson-02/code.js
│   └── lesson-03/code.js
└── maria/
    ├── lesson-01/code.js
    └── lesson-02/code.js
```

Learners can browse their code in the GitHub mobile app.

## Adding More Lessons

1. Create `lessons/11-your-topic.md` with Topic, Challenge, and Success Criteria sections
2. Add `11. [Your Topic](lessons/11-your-topic.md)` to `syllabus.md`
3. Push to the repo
4. Done — learners who haven't finished will see it when they get there
