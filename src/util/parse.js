'use strict';

function stripBotMention(text) {
  return (text || '').replace(/<@[^>]+>\s*/g, '').trim();
}

function parseGitHubPullUrl(text) {
  const m = (text || '').match(/https:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+)\/pull\/(\d+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2], pull_number: Number(m[3]) };
}

function parseOwnerRepo(text) {
  const m = (text || '').match(/\b([a-z0-9_.-]+)\/([a-z0-9_.-]+)\b/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
}

function parseGitHubRepoUrl(text) {
  const m = (text || '').match(/https:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
}

function parseTaskBlock(text) {
  const repoLine = (text || '').match(/^\s*repo\s*:\s*([^\n]+)\s*$/im);
  const taskLine = (text || '').match(/^\s*task\s*:\s*([^\n]+)\s*$/im);
  if (!taskLine) return null;

  const task = taskLine[1].trim();
  const repoText = repoLine ? repoLine[1].trim() : '';
  const repoRef = repoText ? (parseOwnerRepo(repoText) || parseGitHubRepoUrl(repoText)) : null;

  const constraintsLine = (text || '').match(/^\s*constraints?\s*:\s*([^\n]+)\s*$/im);
  const acceptanceLine = (text || '').match(/^\s*acceptance\s*:\s*([^\n]+)\s*$/im);
  const contextLine = (text || '').match(/^\s*context\s*:\s*([^\n]+)\s*$/im);

  return {
    repoRef,
    task,
    constraints: constraintsLine ? constraintsLine[1].trim() : null,
    acceptance: acceptanceLine ? acceptanceLine[1].trim() : null,
    context: contextLine ? contextLine[1].trim() : null,
  };
}

function parseGsUri(text) {
  const m = (text || '').match(/gs:\/\/([^\/\s]+)\/([^\s]+)/i);
  if (!m) return null;
  return { bucket: m[1], object: m[2] };
}

function parseKeyVals(text) {
  const m = (text || '').match(/env\s*:\s*([^\n]+)/i);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf('=');
      if (idx === -1) return null;
      return { key: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
    })
    .filter(Boolean);
}

module.exports = {
  stripBotMention,
  parseGitHubPullUrl,
  parseOwnerRepo,
  parseGitHubRepoUrl,
  parseTaskBlock,
  parseGsUri,
  parseKeyVals,
};
