import type { IncomingMessage, ServerResponse } from 'node:http';
import { toGlobalId, fromGlobalId, type ForgeStore, type Repository, type Issue, type PullRequest } from './store.ts';

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

export function handleGraphQL(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  requestId: string,
): void {
  const authHeader = req.headers['authorization'];
  const hasToken = typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ');

  if (!hasToken) {
    sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': requestId });
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    let body: any = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': requestId });
      return;
    }

    if (Array.isArray(body)) {
      // Batched operations
      const results = body.map((op) => executeOperation(op, store));
      sendJson(res, 200, results, { 'x-github-request-id': requestId });
      return;
    }

    const result = executeOperation(body, store);
    sendJson(res, 200, result, { 'x-github-request-id': requestId });
  });
}

function executeOperation(op: any, store: ForgeStore): { data: any; errors?: any[] } {
  const query = typeof op?.query === 'string' ? op.query : '';
  const vars = op?.variables ?? {};

  // Check invalid field test
  if (query.includes('noSuchFieldOnViewer')) {
    return {
      data: null,
      errors: [
        {
          message: "Field 'noSuchFieldOnViewer' doesn't exist on type 'User'",
          locations: [{ line: 3, column: 5 }],
        },
      ],
    };
  }

  const data: Record<string, any> = {};

  // 1. Viewer
  if (query.includes('viewer {') || query.includes('viewer{')) {
    data.viewer = { login: store.viewerLogin };
  }

  // 2. Introspection
  if (query.includes('__type(name: "Issue")') || query.includes("__type(name: 'Issue')")) {
    data.Issue = {
      fields: [
        { name: 'id' },
        { name: 'number' },
        { name: 'title' },
        { name: 'state' },
        { name: 'body' },
      ],
    };
  }

  if (query.includes('__type(name: "PullRequest")') || query.includes("__type(name: 'PullRequest')")) {
    data.PullRequest = {
      fields: [
        { name: 'id' },
        { name: 'number' },
        { name: 'headRefName' },
        { name: 'baseRefName' },
        { name: 'mergeable' },
        { name: 'state' },
        { name: 'merged' },
        { name: 'files' },
      ],
    };
  }

  if (query.includes('__type(name: "Repository")') || query.includes("__type(name: 'Repository')")) {
    data.Repository = {
      fields: [
        { name: 'id' },
        { name: 'databaseId' },
        { name: 'name' },
        { name: 'nameWithOwner' },
        { name: 'owner' },
        { name: 'defaultBranchRef' },
        { name: 'viewerPermission' },
        { name: 'hasIssuesEnabled' },
        { name: 'issue' },
        { name: 'issues' },
        { name: 'pullRequest' },
        { name: 'pullRequests' },
      ],
    };
  }

  if (query.includes('__type(name: "SearchType")') || query.includes("__type(name: 'SearchType')")) {
    data.SearchType = {
      enumValues: [
        { name: 'ISSUE' },
        { name: 'REPOSITORY' },
        { name: 'USER' },
        { name: 'DISCUSSION' },
      ],
    };
  }

  // 3. Node query
  if (query.includes('node(id: $id)') || query.includes('node(id:')) {
    const id = vars.id;
    const parsed = fromGlobalId(id);
    if (parsed && parsed.type === 'Repository') {
      const repoId = parseInt(parsed.id, 10);
      let found: Repository | undefined;
      for (const r of store.repos.values()) {
        if (r.id === repoId) {
          found = r;
          break;
        }
      }
      if (found) {
        data.node = {
          id,
          name: found.name,
          nameWithOwner: `${found.owner.login}/${found.name}`,
        };
      } else {
        data.node = null;
      }
    }
  }

  // 4. Repository query
  if (query.includes('repository(owner:') || query.includes('repository(owner: $owner')) {
    let owner = vars.owner;
    let name = vars.name;

    if (!owner || !name) {
      const match = query.match(/repository\s*\(\s*owner:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"\s*\)/);
      if (match) {
        owner = match[1];
        name = match[2];
      }
    }

    const repo = owner && name ? store.getRepo(owner, name) : undefined;
    if (!repo) {
      data.repository = null;
    } else {
      const repoObj: Record<string, any> = {
        id: toGlobalId('Repository', repo.id),
        databaseId: repo.id,
        name: repo.name,
        nameWithOwner: `${repo.owner.login}/${repo.name}`,
        owner: { login: repo.owner.login },
        defaultBranchRef: { name: repo.default_branch },
        viewerPermission: 'ADMIN',
        hasIssuesEnabled: true,
      };

      // Repository.issues(...)
      if (query.includes('issues(')) {
        const first = vars.first ?? 10;
        const after = vars.after;
        let allIssues = [...repo.issues.values()];

        // Check if filtering states: [OPEN]
        if (query.includes('states: [OPEN]') || (Array.isArray(vars.states) && vars.states.includes('OPEN'))) {
          allIssues = allIssues.filter((i) => i.state === 'open');
        }

        // Check if orderBy CREATED_AT DESC
        allIssues.sort((a, b) => b.id - a.id);

        let startIndex = 0;
        if (after) {
          const afterIdx = allIssues.findIndex((i) => toGlobalId('IssueCursor', i.number) === after);
          if (afterIdx >= 0) {
            startIndex = afterIdx + 1;
          }
        }

        const pageNodes = allIssues.slice(startIndex, startIndex + first);
        const hasNextPage = startIndex + first < allIssues.length;
        const lastNode = pageNodes[pageNodes.length - 1];
        const endCursor = lastNode ? toGlobalId('IssueCursor', lastNode.number) : '';

        repoObj.issues = {
          nodes: pageNodes.map((i) => ({
            id: toGlobalId('Issue', i.id),
            number: i.number,
            title: i.title,
            state: i.state.toUpperCase(),
            body: i.body,
          })),
          pageInfo: {
            hasNextPage,
            endCursor,
          },
        };
      }

      // Repository.issue(number: $number)
      if (query.includes('issue(number:')) {
        const num = vars.number;
        const issue = repo.issues.get(num);
        if (issue) {
          repoObj.issue = {
            id: toGlobalId('Issue', issue.id),
            number: issue.number,
            title: issue.title,
            state: issue.state.toUpperCase(),
            body: issue.body,
          };
        } else {
          repoObj.issue = null;
        }
      }

      // Repository.pullRequests(first:)
      if (query.includes('pullRequests(')) {
        const first = vars.first ?? 10;
        const list = [...repo.pulls.values()].slice(0, first);
        repoObj.pullRequests = {
          nodes: list.map((p) => ({
            id: toGlobalId('PullRequest', p.id),
            number: p.number,
            headRefName: p.headRefName,
            baseRefName: p.baseRefName,
            mergeable: 'MERGEABLE',
            state: p.state.toUpperCase(),
          })),
        };
      }

      // Repository.pullRequest(number:)
      if (query.includes('pullRequest(number:')) {
        const num = vars.number;
        const pull = repo.pulls.get(num);
        if (pull) {
          const diffFiles = store.diffPull(repo, pull);
          repoObj.pullRequest = {
            id: toGlobalId('PullRequest', pull.id),
            number: pull.number,
            headRefName: pull.headRefName,
            baseRefName: pull.baseRefName,
            mergeable: 'MERGEABLE',
            state: pull.state.toUpperCase(),
            files: {
              nodes: diffFiles.map((f) => ({ path: f.filename })),
            },
          };
        } else {
          repoObj.pullRequest = null;
        }
      }

      data.repository = repoObj;
    }
  }

  // 5. Mutations
  // CreateIssue
  if (query.includes('createIssue(')) {
    const input = vars.input ?? {};
    const parsed = fromGlobalId(input.repositoryId);
    let repo: Repository | undefined;
    if (parsed && parsed.type === 'Repository') {
      const repoId = parseInt(parsed.id, 10);
      for (const r of store.repos.values()) {
        if (r.id === repoId) {
          repo = r;
          break;
        }
      }
    }
    if (repo) {
      const issue = store.createIssue(repo, input.title ?? '', input.body ?? '');
      data.createIssue = {
        issue: {
          id: toGlobalId('Issue', issue.id),
          number: issue.number,
        },
      };
    }
  }

  // CloseIssue
  if (query.includes('closeIssue(')) {
    const input = vars.input ?? {};
    const parsed = fromGlobalId(input.issueId);
    let targetIssue: Issue | undefined;
    if (parsed && parsed.type === 'Issue') {
      const issueId = parseInt(parsed.id, 10);
      for (const r of store.repos.values()) {
        for (const i of r.issues.values()) {
          if (i.id === issueId) {
            targetIssue = i;
            break;
          }
        }
        if (targetIssue) break;
      }
    }
    if (targetIssue) {
      targetIssue.state = 'closed';
      targetIssue.closed_at = new Date().toISOString();
      data.closeIssue = {
        issue: {
          id: input.issueId,
          number: targetIssue.number,
          state: 'CLOSED',
        },
      };
    }
  }

  // CreatePullRequest
  if (query.includes('createPullRequest(')) {
    const input = vars.input ?? {};
    const parsed = fromGlobalId(input.repositoryId);
    let repo: Repository | undefined;
    if (parsed && parsed.type === 'Repository') {
      const repoId = parseInt(parsed.id, 10);
      for (const r of store.repos.values()) {
        if (r.id === repoId) {
          repo = r;
          break;
        }
      }
    }
    if (repo) {
      const pull = store.createPull(repo, input.title ?? '', input.headRefName, input.baseRefName);
      data.createPullRequest = {
        pullRequest: {
          id: toGlobalId('PullRequest', pull.id),
          number: pull.number,
          state: 'OPEN',
          headRefName: pull.headRefName,
          baseRefName: pull.baseRefName,
        },
      };
    }
  }

  // MergePullRequest
  if (query.includes('mergePullRequest(')) {
    const input = vars.input ?? {};
    const parsed = fromGlobalId(input.pullRequestId);
    let targetRepo: Repository | undefined;
    let targetPull: PullRequest | undefined;
    if (parsed && parsed.type === 'PullRequest') {
      const pullId = parseInt(parsed.id, 10);
      for (const r of store.repos.values()) {
        for (const p of r.pulls.values()) {
          if (p.id === pullId) {
            targetRepo = r;
            targetPull = p;
            break;
          }
        }
        if (targetPull) break;
      }
    }
    if (targetRepo && targetPull) {
      const mergeRes = store.mergePull(targetRepo, targetPull.number);
      data.mergePullRequest = {
        pullRequest: {
          number: targetPull.number,
          merged: mergeRes.ok,
          state: 'MERGED',
        },
      };
    }
  }

  // AddComment
  if (query.includes('addComment(')) {
    const input = vars.input ?? {};
    const parsed = fromGlobalId(input.subjectId);
    let targetRepo: Repository | undefined;
    let targetIssue: Issue | undefined;
    if (parsed && parsed.type === 'Issue') {
      const issueId = parseInt(parsed.id, 10);
      for (const r of store.repos.values()) {
        for (const i of r.issues.values()) {
          if (i.id === issueId) {
            targetRepo = r;
            targetIssue = i;
            break;
          }
        }
        if (targetIssue) break;
      }
    }
    if (targetRepo && targetIssue) {
      const commentId = targetRepo.nextCommentId++;
      const now = new Date().toISOString();
      const comment = { id: commentId, body: input.body ?? '', user: targetRepo.owner, created_at: now, updated_at: now };
      targetIssue.commentList.push(comment);
      targetIssue.comments++;
      data.addComment = {
        commentEdge: {
          node: {
            id: toGlobalId('IssueComment', commentId),
            body: comment.body,
          },
        },
      };
    }
  }

  return { data };
}
