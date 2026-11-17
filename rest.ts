import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  hashObject,
  parseCommit,
  parseTree,
  filesFromTree,
  treeFromFiles,
  type ObjectLookup,
  type FileItem,
} from './git.ts';
import type { ForgeStore, Repository, Issue, PullRequest, Label } from './store.ts';
import { updateIssueCache } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function send404(res: ServerResponse, requestId: string): void {
  sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
}

function send401(res: ServerResponse, requestId: string): void {
  sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': requestId });
}

function send400(res: ServerResponse, requestId: string, msg = 'Problems parsing JSON'): void {
  sendJson(res, 400, { message: msg }, { 'x-github-request-id': requestId });
}

function send422(res: ServerResponse, requestId: string, msg = 'Validation Failed'): void {
  sendJson(res, 422, { message: msg }, { 'x-github-request-id': requestId });
}

export function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  requestId: string,
): void {
  const url = new URL(req.url ?? '/', 'http://entry');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  // Authorization check
  const authHeader = req.headers['authorization'];
  const hasToken = typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ');

  // The root and meta routes
  if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) {
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org', 'x-github-request-id': requestId },
    );
    return;
  }

  if (method === 'GET' && pathname === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0' }, { 'x-github-request-id': requestId });
    return;
  }

  // All other /api/v3 routes require authentication
  if (!hasToken) {
    send401(res, requestId);
    return;
  }

  // Current user route: GET /api/v3/user
  if (method === 'GET' && pathname === '/api/v3/user') {
    sendJson(res, 200, { login: store.viewerLogin, id: 1 }, { 'x-github-request-id': requestId });
    return;
  }

  const dispatch = (bodyJson: any) => {
    // 1. User repositories: /api/v3/user/repos
    if (pathname === '/api/v3/user/repos') {
      if (method === 'POST') {
        const name = bodyJson?.name;
        if (!name || typeof name !== 'string') {
          send400(res, requestId, 'Repository name required');
          return;
        }
        const repo = store.createRepo(store.viewerLogin, name, {
          description: bodyJson.description,
          private: bodyJson.private ?? true,
        });
        sendJson(
          res,
          201,
          {
            id: repo.id,
            name: repo.name,
            full_name: repo.full_name,
            owner: { login: repo.owner.login },
            private: repo.private,
            description: repo.description,
            default_branch: repo.default_branch,
            created_at: repo.created_at,
            updated_at: repo.updated_at,
          },
          { 'x-github-request-id': requestId },
        );
        return;
      }

      if (method === 'GET') {
        const perPage = parseInt(url.searchParams.get('per_page') ?? '30', 10);
        const page = parseInt(url.searchParams.get('page') ?? '1', 10);
        const allRepos = store.listReposForOwner(store.viewerLogin);

        const start = (page - 1) * perPage;
        const pageItems = allRepos.slice(start, start + perPage);

        const headers: Record<string, string> = { 'x-github-request-id': requestId };
        if (start + perPage < allRepos.length) {
          const host = req.headers['host'] ?? '127.0.0.1';
          const nextUrl = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
          headers['link'] = `<${nextUrl}>; rel="next"`;
        }

        const out = pageItems.map((r) => ({
          id: r.id,
          name: r.name,
          full_name: r.full_name,
          owner: { login: r.owner.login },
          private: r.private,
          description: r.description,
          default_branch: r.default_branch,
          created_at: r.created_at,
          updated_at: r.updated_at,
        }));
        sendJson(res, 200, out, headers);
        return;
      }
    }

    // Parse /api/v3/repos/:owner/:repo/...
    const reposPrefix = '/api/v3/repos/';
    if (!pathname.startsWith(reposPrefix)) {
      send404(res, requestId);
      return;
    }

    const restPath = pathname.slice(reposPrefix.length);
    const slash1 = restPath.indexOf('/');
    if (slash1 < 0) {
      send404(res, requestId);
      return;
    }
    const owner = restPath.slice(0, slash1);
    const subAfterOwner = restPath.slice(slash1 + 1);
    const slash2 = subAfterOwner.indexOf('/');
    const repoName = slash2 < 0 ? subAfterOwner : subAfterOwner.slice(0, slash2);
    const subRoute = slash2 < 0 ? '' : subAfterOwner.slice(slash2 + 1);

    // Foreign token check: if requested owner does not match viewerLogin
    if (owner.toLowerCase() !== store.viewerLogin.toLowerCase()) {
      send404(res, requestId);
      return;
    }

    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      send404(res, requestId);
      return;
    }

    // Route against repository
    handleRepoRoute(req, res, store, repo, subRoute, method, url, bodyJson, requestId);
  };

  if (method === 'GET' || method === 'HEAD') {
    dispatch(null);
    return;
  }

  // Collect request body
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    let bodyJson: any = null;
    if (chunks.length > 0) {
      const rawText = Buffer.concat(chunks).toString('utf8');
      if (rawText.trim().length > 0) {
        try {
          bodyJson = JSON.parse(rawText);
        } catch {
          send400(res, requestId);
          return;
        }
      }
    }
    dispatch(bodyJson);
  });
}

function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  repo: Repository,
  subRoute: string,
  method: string,
  url: URL,
  bodyJson: any,
  requestId: string,
): void {
  // 1. Repo root: /api/v3/repos/:owner/:repo
  if (subRoute === '') {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          owner: { login: repo.owner.login },
          private: repo.private,
          description: repo.description,
          default_branch: repo.default_branch,
          created_at: repo.created_at,
          updated_at: repo.updated_at,
        },
        { 'x-github-request-id': requestId },
      );
      return;
    }

    if (method === 'PATCH') {
      if (typeof bodyJson?.description === 'string') {
        repo.description = bodyJson.description;
        repo.updated_at = new Date().toISOString();
      }
      sendJson(
        res,
        200,
        {
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          owner: { login: repo.owner.login },
          private: repo.private,
          description: repo.description,
          default_branch: repo.default_branch,
          created_at: repo.created_at,
          updated_at: repo.updated_at,
        },
        { 'x-github-request-id': requestId },
      );
      return;
    }

    if (method === 'DELETE') {
      store.deleteRepo(repo.owner.login, repo.name);
      res.writeHead(204, { 'x-github-request-id': requestId });
      res.end();
      return;
    }
  }

  // 2. Branches: /api/v3/repos/:owner/:repo/branches
  if (subRoute === 'branches' && method === 'GET') {
    const list: Array<{ name: string; commit: { sha: string } }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) {
        list.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
    }
    sendJson(res, 200, list, { 'x-github-request-id': requestId });
    return;
  }

  // 3. Git refs: /api/v3/repos/:owner/:repo/git/refs
  if (subRoute === 'git/refs' && method === 'POST') {
    const ref = bodyJson?.ref;
    const sha = bodyJson?.sha;
    if (!ref || !sha) {
      send400(res, requestId, 'ref and sha required');
      return;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha, type: 'commit' } }, { 'x-github-request-id': requestId });
    return;
  }

  // 4. Commits: /api/v3/repos/:owner/:repo/commits
  if (subRoute === 'commits' && method === 'GET') {
    const targetSha = url.searchParams.get('sha') ?? repo.default_branch;
    const lookup = store.lookupObject(repo);
    let startSha = targetSha;
    if (!repo.objects.has(startSha)) {
      startSha = store.getTipSha(repo, targetSha) ?? startSha;
    }

    const commits: Array<{ sha: string; commit: { message: string; author: { name: string; date: string } } }> = [];
    const queue = [startSha];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);

      const obj = lookup(cur);
      if (obj && obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        commits.push({
          sha: cur,
          commit: {
            message: commit.message.trim(),
          },
        });
        for (const p of commit.parents) {
          queue.push(p);
        }
      }
    }
    sendJson(res, 200, commits, { 'x-github-request-id': requestId });
    return;
  }

  // 5. Contents: /api/v3/repos/:owner/:repo/contents/:path*
  if (subRoute.startsWith('contents/') || subRoute === 'contents') {
    const filePath = subRoute === 'contents' ? '' : subRoute.slice('contents/'.length);
    handleContents(req, res, store, repo, filePath, method, url, bodyJson, requestId);
    return;
  }

  // 6. Labels: /api/v3/repos/:owner/:repo/labels
  if (subRoute === 'labels') {
    if (method === 'POST') {
      const name = bodyJson?.name;
      if (!name) {
        send400(res, requestId, 'name required');
        return;
      }
      const color = bodyJson.color ?? 'ededed';
      const label: Label = { id: repo.nextLabelId++, name, color };
      repo.labels.set(name, label);
      sendJson(res, 201, label, { 'x-github-request-id': requestId });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()], { 'x-github-request-id': requestId });
      return;
    }
  }

  // 7. Issues: /api/v3/repos/:owner/:repo/issues
  if (subRoute === 'issues') {
    if (method === 'POST') {
      const title = bodyJson?.title;
      if (!title) {
        send400(res, requestId, 'title required');
        return;
      }
      const labels = bodyJson?.labels ?? [];
      for (const lName of labels) {
        if (!repo.labels.has(lName)) {
          send422(res, requestId, `Label ${lName} not found`);
          return;
        }
      }
      const issue = store.createIssue(repo, title, bodyJson.body ?? '', labels);
      if (issue.jsonBuf) {
        res.writeHead(201, {
          'content-type': JSON_TYPE,
          'content-length': issue.jsonBuf.length,
          'x-github-request-id': requestId,
        });
        res.end(issue.jsonBuf);
        return;
      }
      sendJson(res, 201, formatIssue(issue), { 'x-github-request-id': requestId });
      return;
    }

    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';

      let list = [...repo.issues.values()];
      if (state !== 'all') {
        list = list.filter((i) => i.state === state);
      }
      list.sort((a, b) => {
        const mult = direction === 'asc' ? 1 : -1;
        return mult * (a.id - b.id);
      });
      sendJson(res, 200, list.map(formatIssue), { 'x-github-request-id': requestId });
      return;
    }
  }

  // 8. Single Issue & comments: /api/v3/repos/:owner/:repo/issues/:number[/comments]
  if (subRoute.startsWith('issues/')) {
    const issueSub = subRoute.slice('issues/'.length);
    const slash = issueSub.indexOf('/');
    const issueNumStr = slash < 0 ? issueSub : issueSub.slice(0, slash);
    const issueAction = slash < 0 ? '' : issueSub.slice(slash + 1);
    const issueNum = parseInt(issueNumStr, 10);

    const issue = repo.issues.get(issueNum);
    if (!issue) {
      send404(res, requestId);
      return;
    }

    if (issueAction === '') {
      if (method === 'GET') {
        if (issue.jsonBuf) {
          res.writeHead(200, {
            'content-type': JSON_TYPE,
            'content-length': issue.jsonBuf.length,
            'x-github-request-id': requestId,
          });
          res.end(issue.jsonBuf);
          return;
        }
        sendJson(res, 200, formatIssue(issue), { 'x-github-request-id': requestId });
        return;
      }
      if (method === 'PATCH') {
        if (bodyJson?.state) {
          issue.state = bodyJson.state;
          if (issue.state === 'closed') issue.closed_at = new Date().toISOString();
        }
        if (bodyJson?.title) issue.title = bodyJson.title;
        if (bodyJson?.body) issue.body = bodyJson.body;
        issue.updated_at = new Date().toISOString();
        updateIssueCache(issue);
        sendJson(res, 200, formatIssue(issue), { 'x-github-request-id': requestId });
        return;
      }
    }

    if (issueAction === 'comments') {
      if (method === 'POST') {
        const bodyText = bodyJson?.body;
        if (!bodyText) {
          send400(res, requestId, 'body required');
          return;
        }
        const commentId = repo.nextCommentId++;
        const now = new Date().toISOString();
        const comment = { id: commentId, body: bodyText, user: repo.owner, created_at: now, updated_at: now };
        issue.commentList.push(comment);
        issue.comments++;
        updateIssueCache(issue);
        sendJson(res, 201, comment, { 'x-github-request-id': requestId });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.commentList, { 'x-github-request-id': requestId });
        return;
      }
    }
  }

  // 9. Pull Requests: /api/v3/repos/:owner/:repo/pulls
  if (subRoute === 'pulls') {
    if (method === 'POST') {
      const title = bodyJson?.title;
      const head = bodyJson?.head;
      const base = bodyJson?.base;
      if (!title || !head || !base) {
        send400(res, requestId, 'title, head and base required');
        return;
      }
      const pull = store.createPull(repo, title, head, base, bodyJson.body ?? '');
      sendJson(res, 201, formatPull(pull), { 'x-github-request-id': requestId });
      return;
    }

    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') {
        list = list.filter((p) => p.state === state);
      }
      sendJson(res, 200, list.map(formatPull), { 'x-github-request-id': requestId });
      return;
    }
  }

  // 10. Single Pull Request & merge/files: /api/v3/repos/:owner/:repo/pulls/:number[/...]
  if (subRoute.startsWith('pulls/')) {
    const pullSub = subRoute.slice('pulls/'.length);
    const slash = pullSub.indexOf('/');
    const pullNumStr = slash < 0 ? pullSub : pullSub.slice(0, slash);
    const pullAction = slash < 0 ? '' : pullSub.slice(slash + 1);
    const pullNum = parseInt(pullNumStr, 10);

    const pull = repo.pulls.get(pullNum);

    if (pullAction === 'merge' && method === 'PUT') {
      if (!pull) {
        send404(res, requestId);
        return;
      }
      const mergeRes = store.mergePull(repo, pullNum, bodyJson?.commit_message);
      if (!mergeRes.ok) {
        sendJson(res, mergeRes.status, { message: mergeRes.error ?? 'Merge failed' }, { 'x-github-request-id': requestId });
        return;
      }
      sendJson(
        res,
        200,
        { sha: mergeRes.sha, merged: true, message: 'Pull Request successfully merged' },
        { 'x-github-request-id': requestId },
      );
      return;
    }

    if (!pull) {
      send404(res, requestId);
      return;
    }

    if (pullAction === '') {
      if (method === 'GET') {
        sendJson(res, 200, formatPull(pull), { 'x-github-request-id': requestId });
        return;
      }
    }

    if (pullAction === 'files' && method === 'GET') {
      const files = store.diffPull(repo, pull);
      sendJson(res, 200, files, { 'x-github-request-id': requestId });
      return;
    }
  }

  send404(res, requestId);
}

function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  repo: Repository,
  targetPath: string,
  method: string,
  url: URL,
  bodyJson: any,
  requestId: string,
): void {
  const branchName = bodyJson?.branch ?? url.searchParams.get('ref') ?? repo.default_branch;
  const tipSha = store.getTipSha(repo, branchName);
  const lookup = store.lookupObject(repo);

  if (method === 'GET') {
    if (!tipSha) {
      send404(res, requestId);
      return;
    }
    const tipCommitObj = lookup(tipSha);
    if (!tipCommitObj) {
      send404(res, requestId);
      return;
    }
    const tipCommit = parseCommit(tipCommitObj.data);
    const files = filesFromTree(tipCommit.tree, lookup);

    // If targetPath is exact file
    const file = files.get(targetPath);
    if (file) {
      const basename = targetPath.split('/').pop() ?? targetPath;
      const b64 = file.data.toString('base64');
      sendJson(
        res,
        200,
        {
          type: 'file',
          name: basename,
          path: targetPath,
          sha: file.oid,
          size: file.data.length,
          encoding: 'base64',
          content: b64,
        },
        { 'x-github-request-id': requestId },
      );
      return;
    }

    // Check if targetPath is a directory
    const dirPrefix = targetPath === '' ? '' : `${targetPath}/`;
    const dirEntries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }>();

    for (const [p, item] of files) {
      if (dirPrefix === '' || p.startsWith(dirPrefix)) {
        const sub = p.slice(dirPrefix.length);
        const slash = sub.indexOf('/');
        if (slash < 0) {
          dirEntries.set(sub, { type: 'file', name: sub, path: p, sha: item.oid, size: item.data.length });
        } else {
          const dirName = sub.slice(0, slash);
          if (!dirEntries.has(dirName)) {
            dirEntries.set(dirName, {
              type: 'dir',
              name: dirName,
              path: dirPrefix ? `${dirPrefix}${dirName}` : dirName,
              sha: '0'.repeat(40),
              size: 0,
            });
          }
        }
      }
    }

    if (dirEntries.size > 0) {
      sendJson(res, 200, [...dirEntries.values()], { 'x-github-request-id': requestId });
      return;
    }

    send404(res, requestId);
    return;
  }

  if (method === 'PUT') {
    const contentB64 = bodyJson?.content;
    const message = bodyJson?.message ?? 'commit via contents API';
    const expectedSha = bodyJson?.sha;
    if (contentB64 === undefined) {
      send400(res, requestId, 'content required');
      return;
    }

    const newBuffer = Buffer.from(contentB64, 'base64');
    const tipCommitObj = tipSha ? lookup(tipSha) : undefined;
    const existingFiles = tipCommitObj ? filesFromTree(parseCommit(tipCommitObj.data).tree, lookup) : new Map();

    const currentFile = existingFiles.get(targetPath);
    if (currentFile) {
      if (!expectedSha || expectedSha.toLowerCase() !== currentFile.oid.toLowerCase()) {
        sendJson(res, 409, { message: 'sha does not match' }, { 'x-github-request-id': requestId });
        return;
      }
    } else {
      if (expectedSha) {
        sendJson(res, 409, { message: 'sha does not match' }, { 'x-github-request-id': requestId });
        return;
      }
    }

    // Update files
    existingFiles.set(targetPath, { oid: '', data: newBuffer });
    const fileItems: FileItem[] = [...existingFiles.entries()].map(([p, item]) => ({ path: p, data: item.data }));

    const { commitSha } = store.createCommit(repo, branchName, fileItems, message);
    const newBlobSha = hashObject('blob', newBuffer);
    const basename = targetPath.split('/').pop() ?? targetPath;

    const status = currentFile ? 200 : 201;
    sendJson(
      res,
      status,
      {
        content: {
          name: basename,
          path: targetPath,
          sha: newBlobSha,
          size: newBuffer.length,
          encoding: 'base64',
        },
        commit: { sha: commitSha },
      },
      { 'x-github-request-id': requestId },
    );
    return;
  }

  if (method === 'DELETE') {
    const message = bodyJson?.message ?? 'delete via contents API';
    const expectedSha = bodyJson?.sha;
    if (!tipSha) {
      send404(res, requestId);
      return;
    }
    const tipCommitObj = lookup(tipSha);
    if (!tipCommitObj) {
      send404(res, requestId);
      return;
    }
    const existingFiles = filesFromTree(parseCommit(tipCommitObj.data).tree, lookup);
    const currentFile = existingFiles.get(targetPath);
    if (!currentFile) {
      send404(res, requestId);
      return;
    }
    if (expectedSha && expectedSha.toLowerCase() !== currentFile.oid.toLowerCase()) {
      sendJson(res, 409, { message: 'sha does not match' }, { 'x-github-request-id': requestId });
      return;
    }

    existingFiles.delete(targetPath);
    const fileItems: FileItem[] = [...existingFiles.entries()].map(([p, item]) => ({ path: p, data: item.data }));
    const { commitSha } = store.createCommit(repo, branchName, fileItems, message);

    sendJson(res, 200, { commit: { sha: commitSha }, content: null }, { 'x-github-request-id': requestId });
    return;
  }

  send404(res, requestId);
}

function formatIssue(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    user: issue.user,
    comments: issue.comments,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
  };
}

function formatPull(pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: pull.mergeable,
    head: pull.head,
    base: pull.base,
    user: pull.user,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
  };
}
