'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  matchCalendar,
  matchTodo,
  matchEmail,
  matchReservation,
  matchRoundup,
  matchHelp,
  matchRepos,
  matchBrain,
  matchIntent,
} = require('../src/matchers');

// ── Calendar ─────────────────────────────────────────────────────

describe('matchCalendar', () => {
  const listPhrases = [
    "what's on my schedule today",
    "any meetings tomorrow",
    "do i have any meetings today",
    "am i free on friday",
    "what do i have going on today",
    "show me my calendar",
    "check my schedule",
    "pull up my agenda",
    "what's happening tomorrow",
    "how does my day look",
    "how's my week look",
    "what is on my calendar",
    "what have i got going on",
    "when's my next meeting",
    "any events this week",
    "got any calls today",
    "what's the plan today",
    "my schedule",
    "today's events",
    "my meetings",
  ];

  for (const phrase of listPhrases) {
    it(`LIST: "${phrase}"`, () => {
      const r = matchCalendar(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'cal_list');
    });
  }

  const createPhrases = [
    'schedule a meeting with bob on monday at 10am',
    'set up a call for tomorrow at 3pm',
    'create an event for friday',
    'add a meeting at 2pm',
    'block my calendar tomorrow afternoon',
    'book a slot for the standup',
    'set up a sync with the team',
    'schedule a check-in for next week',
    'block time for deep work',
  ];

  for (const phrase of createPhrases) {
    it(`CREATE: "${phrase}"`, () => {
      const r = matchCalendar(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'cal_create_nl');
    });
  }

  const calendarsPhrases = [
    'list my calendars',
    'show me my calendars',
    'which calendars do i have',
    'my calendars',
    'view all calendars',
  ];

  for (const phrase of calendarsPhrases) {
    it(`CALENDARS: "${phrase}"`, () => {
      const r = matchCalendar(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'cal_calendars');
    });
  }

  it('extracts date from "any meetings tomorrow"', () => {
    const r = matchCalendar('any meetings tomorrow');
    assert.equal(r.date, 'tomorrow');
  });

  it('does not match general chat', () => {
    assert.equal(matchCalendar('how are you'), null);
    assert.equal(matchCalendar('tell me a joke'), null);
    assert.equal(matchCalendar('what is javascript'), null);
  });
});

// ── Todos ────────────────────────────────────────────────────────

describe('matchTodo', () => {
  const listPhrases = [
    "what's on my plate",
    'show me my tasks',
    'my to-do list',
    'what do i need to do',
    'list my todos',
    "what's left",
    "what's pending",
    'anything to do',
    'my tasks',
    'check my list',
    'how many tasks do i have',
    "what's outstanding",
    'things to finish',
    'pull up my checklist',
    'view my todos',
  ];

  for (const phrase of listPhrases) {
    it(`LIST: "${phrase}"`, () => {
      const r = matchTodo(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'todo_list');
    });
  }

  const addPhrases = [
    ['remind me to call bob', 'call bob'],
    ['remind me to pick up groceries', 'pick up groceries'],
    ['add buy milk to my list', 'buy milk'],
    ['add send invoice to my tasks', 'send invoice'],
    ['i need to file taxes', 'file taxes'],
    ['i gotta call the dentist', 'call the dentist'],
    ["don't let me forget to water the plants", 'water the plants'],
    ["don't forget to send the report", 'send the report'],
    ['i should review the PR', 'review the PR'],
    ['add a task for cleaning', 'cleaning'],
    ['put laundry on my list', 'laundry'],
    ['new todo: buy birthday gift', 'buy birthday gift'],
    ['create a reminder to check in with sarah', 'check in with sarah'],
  ];

  for (const [phrase, expectedTitle] of addPhrases) {
    it(`ADD: "${phrase}" → "${expectedTitle}"`, () => {
      const r = matchTodo(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'todo_add');
      assert.equal(r.title, expectedTitle.toLowerCase());
    });
  }

  const donePhrases = [
    'mark 3 as done',
    'check off 2',
    'complete #1',
    'done with 4',
    'finish 2',
    '3 is done',
    '1 is completed',
  ];

  for (const phrase of donePhrases) {
    it(`DONE: "${phrase}"`, () => {
      const r = matchTodo(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'todo_done');
      assert.ok(r.index);
    });
  }

  it('does not match "what do i have going on" (calendar)', () => {
    assert.equal(matchTodo('what do i have going on'), null);
  });

  it('does not match general chat', () => {
    assert.equal(matchTodo('thanks'), null);
    assert.equal(matchTodo('tell me about javascript'), null);
  });
});

// ── Email ────────────────────────────────────────────────────────

describe('matchEmail', () => {
  const checkPhrases = [
    'check my email',
    'any new emails',
    'do i have any messages',
    "what's in my inbox",
    'show me my mail',
    'unread emails',
    'who emailed me',
    'recent emails',
    'new messages',
    'pull up my inbox',
    'any mail',
    'my inbox',
    'got any new messages',
    'latest emails',
  ];

  for (const phrase of checkPhrases) {
    it(`CHECK: "${phrase}"`, () => {
      const r = matchEmail(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'email_check');
    });
  }

  const searchPhrases = [
    'find emails from sarah',
    'search my email for invoice',
    'look for messages about budget',
    'what did bob send me',
    'emails from hr',
    'messages about the project',
    'find mail from the client',
    'search inbox for receipts',
  ];

  for (const phrase of searchPhrases) {
    it(`SEARCH: "${phrase}"`, () => {
      const r = matchEmail(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'email_search_nl');
    });
  }

  const sendPhrases = [
    'send an email to bob@example.com',
    'write a message to sarah@work.com',
    'compose an email to team@co.com',
    'email bob@test.com about the meeting',
    'fire off a note to alice@example.com',
    'reply to sarah@work.com',
  ];

  for (const phrase of sendPhrases) {
    it(`SEND: "${phrase}"`, () => {
      const r = matchEmail(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'email_send_nl');
    });
  }

  it('does not match general chat', () => {
    assert.equal(matchEmail('hello'), null);
    assert.equal(matchEmail('what time is it'), null);
  });
});

// ── Reservations ─────────────────────────────────────────────────

describe('matchReservation', () => {
  const reservePhrases = [
    'book a table for 2 at nobu on saturday at 7pm',
    'reserve a table for 4',
    'make a reservation at the french laundry',
    'dinner for 6 at carbone tomorrow',
    'get us a table at noma',
    'find a restaurant for tonight',
    'book dinner for two',
    'table for 4 at sushi nakazawa',
    'get a reservation at chez panisse',
    'find a place to eat',
    'where should we eat',
    "let's go grab dinner",
    'need a table for 3',
    'lunch for 2 at nobu tomorrow',
    'make a res at the steakhouse',
    'brunch for 4 at sarabeth on sunday',
  ];

  for (const phrase of reservePhrases) {
    it(`RESERVE: "${phrase}"`, () => {
      const r = matchReservation(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.ok(r.intent === 'reserve_nl' || r.intent === 'reserve_call_nl');
    });
  }

  const callPhrases = [
    'call nobu and reserve a table for 2',
    'call the restaurant and book a table',
    'phone the place and make a reservation',
  ];

  for (const phrase of callPhrases) {
    it(`CALL: "${phrase}"`, () => {
      const r = matchReservation(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'reserve_call_nl');
    });
  }

  it('does not match general chat', () => {
    assert.equal(matchReservation('what is a table'), null);
    assert.equal(matchReservation('how are you'), null);
  });
});

// ── Roundup ──────────────────────────────────────────────────────

describe('matchRoundup', () => {
  const dailyPhrases = [
    'give me my briefing',
    'morning digest',
    "what's the news",
    'catch me up',
    'what did i miss',
    "today's update",
    'daily summary',
    'give me the rundown',
    'fill me in',
    'bring me up to speed',
    "what's the latest",
    'any news',
    'daily briefing',
    'show me the news',
  ];

  for (const phrase of dailyPhrases) {
    it(`DAILY: "${phrase}"`, () => {
      const r = matchRoundup(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'roundup_daily');
    });
  }

  const weeklyPhrases = [
    'weekly digest',
    'weekly briefing',
    'weekly roundup',
    'give me the weekly summary',
  ];

  for (const phrase of weeklyPhrases) {
    it(`WEEKLY: "${phrase}"`, () => {
      const r = matchRoundup(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'roundup_weekly');
    });
  }

  it('does not match general chat', () => {
    assert.equal(matchRoundup('hello'), null);
    assert.equal(matchRoundup('thanks'), null);
  });
});

// ── Help ─────────────────────────────────────────────────────────

describe('matchHelp', () => {
  const phrases = [
    'what can you do',
    'how do i use this',
    'show me the commands',
    'what are the options',
    'what are your capabilities',
    "what's available",
    "how does this work",
    "help me",
    "list the features",
  ];

  for (const phrase of phrases) {
    it(`HELP: "${phrase}"`, () => {
      const r = matchHelp(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'help');
    });
  }

  it('does not match "help me write a function"', () => {
    // Long message with "help" is likely a task, not help request
    assert.equal(matchHelp('help me write a function that calculates fibonacci numbers'), null);
  });
});

// ── Repos ────────────────────────────────────────────────────────

describe('matchRepos', () => {
  const phrases = [
    'show me my repos',
    'list my projects',
    'what repos do i have',
    'my repositories',
    'show me my projects',
    'list repos',
    'what projects are available',
  ];

  for (const phrase of phrases) {
    it(`REPOS: "${phrase}"`, () => {
      const r = matchRepos(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'repos_list');
    });
  }

  it('does not match general chat', () => {
    assert.equal(matchRepos('what is a repo'), null);
  });
});

// ── Brain ────────────────────────────────────────────────────────

describe('matchBrain', () => {
  it('matches "what do you remember"', () => {
    const r = matchBrain('what do you remember about me');
    assert.ok(r);
    assert.equal(r.intent, 'brain_show');
  });

  it('matches "show me your memory"', () => {
    const r = matchBrain('show me your memory');
    assert.ok(r);
    assert.equal(r.intent, 'brain_show');
  });

  it('matches "clear your memory"', () => {
    const r = matchBrain('clear your memory');
    assert.ok(r);
    assert.equal(r.intent, 'brain_reset');
  });

  it('matches "forget everything"', () => {
    const r = matchBrain('forget everything');
    assert.ok(r);
    assert.equal(r.intent, 'brain_reset');
  });

  it('matches "memory status"', () => {
    const r = matchBrain('memory status');
    assert.ok(r);
    assert.equal(r.intent, 'brain_status');
  });

  it('does not match general chat', () => {
    assert.equal(matchBrain('hello'), null);
  });
});

// ── matchIntent ordering ─────────────────────────────────────────

describe('matchIntent', () => {
  it('"what\'s on my plate" → todo_list (not calendar)', () => {
    const r = matchIntent("what's on my plate");
    assert.ok(r);
    assert.equal(r.intent, 'todo_list');
  });

  it('"what do i have going on today" → cal_list', () => {
    const r = matchIntent('what do i have going on today');
    assert.ok(r);
    assert.equal(r.intent, 'cal_list');
  });

  it('"remind me to call bob" → todo_add', () => {
    const r = matchIntent('remind me to call bob');
    assert.ok(r);
    assert.equal(r.intent, 'todo_add');
    assert.equal(r.title, 'call bob');
  });

  it('"check my email" → email_check', () => {
    const r = matchIntent('check my email');
    assert.ok(r);
    assert.equal(r.intent, 'email_check');
  });

  it('"book dinner for 4 at nobu" → reserve_nl', () => {
    const r = matchIntent('book dinner for 4 at nobu');
    assert.ok(r);
    assert.equal(r.intent, 'reserve_nl');
  });

  it('"catch me up" → roundup_daily', () => {
    const r = matchIntent('catch me up');
    assert.ok(r);
    assert.equal(r.intent, 'roundup_daily');
  });

  it('"what can you do" → help', () => {
    const r = matchIntent('what can you do');
    assert.ok(r);
    assert.equal(r.intent, 'help');
  });

  it('"hello" → null (no match, falls through to chat)', () => {
    assert.equal(matchIntent('hello'), null);
  });

  it('"thanks" → null', () => {
    assert.equal(matchIntent('thanks'), null);
  });

  it('"how are you" → null', () => {
    assert.equal(matchIntent('how are you'), null);
  });
});
