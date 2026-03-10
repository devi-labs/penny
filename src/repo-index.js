'use strict';

async function indexRepos({ octokit, brain, repos }) {
  if (!octokit) {
    console.log('Repo index: skipped (no GitHub token)');
    return;
  }

  const repoList = repos && repos.length > 0
    ? repos
    : await discoverRepos(octokit);

  console.log(`Repo index: indexing ${repoList.length} repos...`);

  for (const fullName of repoList) {
    try {
      const [owner, repo] = fullName.split('/');
      const existing = await brain.loadRepo(owner, repo);

      // Skip if indexed within the last 24 hours
      if (existing?.indexedAt && Date.now() - new Date(existing.indexedAt).getTime() < 24 * 60 * 60 * 1000) {
        console.log(`  ✓ ${fullName} (cached)`);
        continue;
      }

      const summary = await fetchRepoSummary(octokit, owner, repo);
      await brain.saveRepo(owner, repo, {
        ...summary,
        indexedAt: new Date().toISOString(),
      });
      console.log(`  ✓ ${fullName} (indexed)`);
    } catch (e) {
      console.error(`  ✗ ${fullName}: ${e?.message || e}`);
    }
  }

  console.log('Repo index: done');
}

async function discoverRepos(octokit) {
  const repos = [];
  try {
    const { data } = await octokit.repos.listForAuthenticatedUser({
      sort: 'pushed',
      per_page: 20,
      type: 'owner',
    });
    for (const r of data) {
      repos.push(r.full_name);
    }
  } catch (e) {
    console.error('Repo discovery failed:', e?.message || e);
  }
  return repos;
}

async function fetchRepoSummary(octokit, owner, repo) {
  const { data: repoData } = await octokit.repos.get({ owner, repo });

  // Get file tree (top 2 levels)
  let tree = [];
  try {
    const { data: treeData } = await octokit.git.getTree({
      owner, repo,
      tree_sha: repoData.default_branch,
      recursive: 'false',
    });
    tree = treeData.tree.map((t) => t.path).slice(0, 100);
  } catch {}

  // Get README
  let readme = '';
  try {
    const { data: readmeData } = await octokit.repos.getReadme({ owner, repo });
    readme = Buffer.from(readmeData.content, 'base64').toString('utf8').slice(0, 3000);
  } catch {}

  return {
    name: repoData.full_name,
    description: repoData.description || '',
    language: repoData.language || '',
    defaultBranch: repoData.default_branch,
    topics: repoData.topics || [],
    fileTree: tree,
    readme,
  };
}

module.exports = { indexRepos };
