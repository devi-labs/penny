'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSyllabus,
  parseLesson,
  getProgress,
  progressSummary,
  progressBar,
  parseTopics,
  formatTopics,
  addTopicToMarkdown,
  removeTopicFromMarkdown,
} = require('../src/learn');

const { matchLearn } = require('../src/matchers');

// ── Syllabus parsing ────────────────────────────────────────────

describe('parseSyllabus', () => {
  it('parses markdown link style', () => {
    const md = [
      '# Syllabus',
      '',
      '1. [What is GitHub?](lessons/01-what-is-github.md)',
      '2. [What is Code?](lessons/02-what-is-code.md)',
      '3. [Variables](lessons/03-variables.md)',
    ].join('\n');
    const result = parseSyllabus(md);
    assert.equal(result.length, 3);
    assert.equal(result[0].title, 'What is GitHub?');
    assert.equal(result[0].path, 'lessons/01-what-is-github.md');
    assert.equal(result[2].title, 'Variables');
  });

  it('parses plain path style', () => {
    const md = [
      '1. lessons/01-what-is-github.md',
      '2. lessons/02-what-is-code.md',
    ].join('\n');
    const result = parseSyllabus(md);
    assert.equal(result.length, 2);
    assert.equal(result[0].path, 'lessons/01-what-is-github.md');
    assert.equal(result[0].title, 'what is github');
  });

  it('parses bullet style', () => {
    const md = [
      '- lessons/01-what-is-github.md',
      '- lessons/02-what-is-code.md',
    ].join('\n');
    const result = parseSyllabus(md);
    assert.equal(result.length, 2);
  });

  it('returns empty for no lessons', () => {
    assert.deepEqual(parseSyllabus('# Empty'), []);
    assert.deepEqual(parseSyllabus(''), []);
  });
});

// ── Lesson parsing ──────────────────────────────────────────────

describe('parseLesson', () => {
  it('extracts structured sections', () => {
    const md = [
      '# Variables',
      '',
      '## Concept',
      'Variables are labeled boxes.',
      '',
      '## Code Example',
      '```js',
      'let name = "Alex";',
      '```',
      '',
      '## Challenge',
      'Create variables for your name and age.',
      '',
      '## Success Criteria',
      'Must use let or const. Must assign string and number values.',
    ].join('\n');

    const lesson = parseLesson(md);
    assert.equal(lesson.title, 'Variables');
    assert.ok(lesson.explanation.includes('labeled boxes'));
    assert.ok(lesson.codeExample.includes('let name'));
    assert.ok(lesson.challenge.includes('Create variables'));
    assert.ok(lesson.successCriteria.includes('let or const'));
  });

  it('uses fallback when no sections', () => {
    const md = '# Intro\n\nSome content here.';
    const lesson = parseLesson(md);
    assert.equal(lesson.title, 'Intro');
    assert.ok(lesson.explanation.includes('Some content'));
  });

  it('handles empty content', () => {
    const lesson = parseLesson('');
    assert.equal(lesson.title, '');
    assert.equal(lesson.raw, '');
  });
});

// ── Progress ────────────────────────────────────────────────────

describe('getProgress', () => {
  it('returns defaults when no state', () => {
    const p = getProgress(null);
    assert.equal(p.currentLesson, 1);
    assert.deepEqual(p.completed, []);
    assert.equal(p.lastActivity, null);
  });

  it('returns existing progress', () => {
    const p = getProgress({ learnProgress: { currentLesson: 3, completed: [1, 2], lastActivity: '2026-03-19' } });
    assert.equal(p.currentLesson, 3);
    assert.deepEqual(p.completed, [1, 2]);
  });

  it('preserves paused flag', () => {
    const p = getProgress({ learnProgress: { currentLesson: 2, completed: [1], paused: true } });
    assert.equal(p.paused, true);
  });

  it('preserves learnerName and language', () => {
    const p = getProgress({ learnProgress: { currentLesson: 2, completed: [1], learnerName: 'Maria', language: 'Spanish' } });
    assert.equal(p.learnerName, 'Maria');
    assert.equal(p.language, 'Spanish');
  });
});

describe('progressBar', () => {
  it('generates bar', () => {
    assert.equal(progressBar(0, 10), '░░░░░░░░░░');
    assert.equal(progressBar(5, 10), '▓▓▓▓▓░░░░░');
    assert.equal(progressBar(10, 10), '▓▓▓▓▓▓▓▓▓▓');
  });
});

describe('progressSummary', () => {
  const syllabus = [
    { title: 'What is GitHub?', path: 'lessons/01.md' },
    { title: 'What is Code?', path: 'lessons/02.md' },
    { title: 'Variables', path: 'lessons/03.md' },
  ];

  it('shows current lesson', () => {
    const summary = progressSummary({ currentLesson: 2, completed: [1] }, syllabus);
    assert.ok(summary.includes('Lesson 2'));
    assert.ok(summary.includes('What is Code?'));
    assert.ok(summary.includes('1/3'));
  });

  it('shows completion message', () => {
    const summary = progressSummary({ currentLesson: 4, completed: [1, 2, 3] }, syllabus);
    assert.ok(summary.includes('completed all'));
  });

  it('includes learner name when set', () => {
    const summary = progressSummary({ currentLesson: 2, completed: [1], learnerName: 'Maria' }, syllabus);
    assert.ok(summary.includes('Maria'));
  });

  it('shows language when non-English', () => {
    const summary = progressSummary({ currentLesson: 2, completed: [1], language: 'Spanish' }, syllabus);
    assert.ok(summary.includes('Spanish'));
  });

  it('does not show language note for English', () => {
    const summary = progressSummary({ currentLesson: 2, completed: [1], language: 'English' }, syllabus);
    assert.ok(!summary.includes('Learning in'));
  });
});

// ── Topics ──────────────────────────────────────────────────────

describe('parseTopics', () => {
  it('parses bullet list', () => {
    const md = '- APIs\n- Databases\n- CSS Grid';
    assert.deepEqual(parseTopics(md), ['APIs', 'Databases', 'CSS Grid']);
  });

  it('handles empty', () => {
    assert.deepEqual(parseTopics(''), []);
    assert.deepEqual(parseTopics(null), []);
  });
});

describe('addTopicToMarkdown', () => {
  it('adds to empty', () => {
    assert.equal(addTopicToMarkdown('', 'APIs'), '- APIs');
  });

  it('appends to existing', () => {
    const result = addTopicToMarkdown('- CSS\n- HTML', 'APIs');
    assert.ok(result.includes('- CSS'));
    assert.ok(result.includes('- APIs'));
  });
});

describe('removeTopicFromMarkdown', () => {
  it('removes a topic', () => {
    const result = removeTopicFromMarkdown('- CSS\n- APIs\n- HTML', 'APIs');
    assert.ok(!result.includes('APIs'));
    assert.ok(result.includes('CSS'));
    assert.ok(result.includes('HTML'));
  });

  it('case-insensitive', () => {
    const result = removeTopicFromMarkdown('- APIs', 'apis');
    assert.equal(result.trim(), '');
  });
});

// ── Matchers ────────────────────────────────────────────────────

describe('matchLearn', () => {
  const exact = [
    ['learn', null],
    ['learn next', 'next'],
    ['learn list', 'list'],
    ['learn help', 'help'],
    ['learn reset', 'reset'],
    ['learn syllabus', 'syllabus'],
    ['learn off', 'off'],
    ['learn on', 'on'],
  ];

  for (const [phrase, expectedArgs] of exact) {
    it(`exact: "${phrase}" → args=${expectedArgs}`, () => {
      const r = matchLearn(phrase);
      assert.ok(r);
      assert.equal(r.intent, 'learn');
      assert.equal(r.args, expectedArgs);
    });
  }

  it('learn more about <topic>', () => {
    const r = matchLearn('learn more about apis');
    assert.ok(r);
    assert.equal(r.args, 'more about apis');
  });

  it('learn remove <topic>', () => {
    const r = matchLearn('learn remove css grid');
    assert.ok(r);
    assert.equal(r.args, 'remove css grid');
  });

  it('learn language <lang>', () => {
    const r = matchLearn('learn language spanish');
    assert.ok(r);
    assert.equal(r.args, 'language spanish');
  });

  it('learn in <lang>', () => {
    const r = matchLearn('learn in french');
    assert.ok(r);
    assert.equal(r.args, 'language french');
  });

  const nlPhrases = [
    'teach me to code',
    'start learning',
    'next lesson',
    'continue lesson',
    'my lesson',
  ];

  for (const phrase of nlPhrases) {
    it(`NL: "${phrase}" → learn next`, () => {
      const r = matchLearn(phrase.toLowerCase());
      assert.ok(r, `should match: ${phrase}`);
      assert.equal(r.intent, 'learn');
      assert.equal(r.args, 'next');
    });
  }

  it('does not match unrelated', () => {
    assert.equal(matchLearn('what is the weather'), null);
    assert.equal(matchLearn('learn me some cooking tips please this is a long sentence that should not match'), null);
  });
});
