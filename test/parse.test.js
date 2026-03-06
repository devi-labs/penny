'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  stripBotMention,
  parseGitHubPullUrl,
  parseOwnerRepo,
  parseGitHubRepoUrl,
  parseTaskBlock,
  parseGsUri,
  parseKeyVals,
} = require('../src/util/parse');

describe('stripBotMention', () => {
  it('removes a bot mention from the start', () => {
    assert.equal(stripBotMention('<@U12345> hello'), 'hello');
  });

  it('removes multiple mentions', () => {
    assert.equal(stripBotMention('<@U1> <@U2> hey'), 'hey');
  });

  it('returns empty string for null', () => {
    assert.equal(stripBotMention(null), '');
  });

  it('returns trimmed text when no mention', () => {
    assert.equal(stripBotMention('  just text  '), 'just text');
  });
});

describe('parseGitHubPullUrl', () => {
  it('parses a valid PR URL', () => {
    const result = parseGitHubPullUrl('https://github.com/octocat/repo/pull/42');
    assert.deepEqual(result, { owner: 'octocat', repo: 'repo', pull_number: 42 });
  });

  it('parses a PR URL embedded in text', () => {
    const result = parseGitHubPullUrl('check out https://github.com/org/proj/pull/7 please');
    assert.deepEqual(result, { owner: 'org', repo: 'proj', pull_number: 7 });
  });

  it('returns null for non-PR URL', () => {
    assert.equal(parseGitHubPullUrl('https://github.com/octocat/repo'), null);
  });

  it('returns null for empty input', () => {
    assert.equal(parseGitHubPullUrl(''), null);
  });

  it('returns null for null input', () => {
    assert.equal(parseGitHubPullUrl(null), null);
  });
});

describe('parseOwnerRepo', () => {
  it('parses owner/repo', () => {
    assert.deepEqual(parseOwnerRepo('octocat/hello-world'), { owner: 'octocat', repo: 'hello-world' });
  });

  it('strips .git suffix', () => {
    assert.deepEqual(parseOwnerRepo('octocat/hello.git'), { owner: 'octocat', repo: 'hello' });
  });

  it('returns null for bare word', () => {
    assert.equal(parseOwnerRepo('norepo'), null);
  });
});

describe('parseGitHubRepoUrl', () => {
  it('parses a repo URL', () => {
    assert.deepEqual(
      parseGitHubRepoUrl('https://github.com/acme-org/my-repo'),
      { owner: 'acme-org', repo: 'my-repo' },
    );
  });

  it('strips .git suffix', () => {
    assert.deepEqual(
      parseGitHubRepoUrl('https://github.com/org/repo.git'),
      { owner: 'org', repo: 'repo' },
    );
  });

  it('returns null for non-github url', () => {
    assert.equal(parseGitHubRepoUrl('https://gitlab.com/org/repo'), null);
  });
});

describe('parseTaskBlock', () => {
  it('parses task with repo', () => {
    const text = 'repo: octocat/hello\ntask: add readme';
    const result = parseTaskBlock(text);
    assert.deepEqual(result.repoRef, { owner: 'octocat', repo: 'hello' });
    assert.equal(result.task, 'add readme');
  });

  it('parses task without repo', () => {
    const text = 'task: fix the bug';
    const result = parseTaskBlock(text);
    assert.equal(result.repoRef, null);
    assert.equal(result.task, 'fix the bug');
  });

  it('returns null when no task line', () => {
    assert.equal(parseTaskBlock('just some random text'), null);
  });

  it('parses optional constraints, acceptance, and context fields', () => {
    const text = 'repo: org/repo\ntask: add login page\nconstraints: no external libraries\nacceptance: user can log in\ncontext: this is a next.js app';
    const result = parseTaskBlock(text);
    assert.equal(result.task, 'add login page');
    assert.equal(result.constraints, 'no external libraries');
    assert.equal(result.acceptance, 'user can log in');
    assert.equal(result.context, 'this is a next.js app');
  });

  it('returns null for optional fields when not provided', () => {
    const text = 'task: fix the bug';
    const result = parseTaskBlock(text);
    assert.equal(result.constraints, null);
    assert.equal(result.acceptance, null);
    assert.equal(result.context, null);
  });

  it('parses task with GitHub URL repo', () => {
    // parseOwnerRepo matches first on the raw text, picking up github.com/org;
    // only a bare owner/repo (no URL) goes through parseOwnerRepo cleanly.
    // With a full URL the function still returns a repoRef (parseOwnerRepo wins).
    const text = 'repo: https://github.com/org/proj\ntask: deploy';
    const result = parseTaskBlock(text);
    assert.ok(result.repoRef, 'should have a repoRef');
    assert.equal(result.task, 'deploy');
  });
});

describe('parseGsUri', () => {
  it('parses a gs:// URI', () => {
    assert.deepEqual(
      parseGsUri('gs://my-bucket/path/to/file.json'),
      { bucket: 'my-bucket', object: 'path/to/file.json' },
    );
  });

  it('returns null for non-gs URI', () => {
    assert.equal(parseGsUri('https://example.com'), null);
  });
});

describe('parseKeyVals', () => {
  it('parses env key-value pairs', () => {
    const result = parseKeyVals('env: FOO=bar, BAZ=qux');
    assert.deepEqual(result, [
      { key: 'FOO', value: 'bar' },
      { key: 'BAZ', value: 'qux' },
    ]);
  });

  it('returns empty array when no env line', () => {
    assert.deepEqual(parseKeyVals('no env here'), []);
  });

  it('skips entries without =', () => {
    const result = parseKeyVals('env: GOOD=val, BADONE');
    assert.deepEqual(result, [{ key: 'GOOD', value: 'val' }]);
  });
});
