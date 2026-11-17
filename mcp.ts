import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForgeStore, Repository } from './store.ts';

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

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get details about a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository' },
        repo: { type: 'string', description: 'The name of the repository' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository' },
        repo: { type: 'string', description: 'The name of the repository' },
        title: { type: 'string', description: 'The title of the issue' },
        body: { type: 'string', description: 'The contents of the issue' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository' },
        repo: { type: 'string', description: 'The name of the repository' },
        state: { type: 'string', description: 'State of the issues to return (open, closed, all)' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository' },
        repo: { type: 'string', description: 'The name of the repository' },
        title: { type: 'string', description: 'The title of the pull request' },
        head: { type: 'string', description: 'The branch that contains the commits' },
        base: { type: 'string', description: 'The branch you want the changes pulled into' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository' },
        repo: { type: 'string', description: 'The name of the repository' },
        pull_number: { type: 'number', description: 'The number of the pull request' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export function handleMcp(
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
      sendJson(
        res,
        400,
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        { 'x-github-request-id': requestId },
      );
      return;
    }

    const id = body?.id ?? null;
    const method = body?.method;
    const params = body?.params ?? {};

    // 1. server/discover
    if (method === 'server/discover') {
      sendJson(
        res,
        200,
        {
          jsonrpc: '2.0',
          id,
          result: {
            serverInfo: { name: 'makefun-github-core-clone', version: '1.0.0' },
            supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
            capabilities: { tools: {} },
          },
        },
        { 'x-github-request-id': requestId },
      );
      return;
    }

    // 2. initialize
    if (method === 'initialize') {
      const clientVer = params?.protocolVersion || '2026-07-28';
      sendJson(
        res,
        200,
        {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: clientVer,
            serverInfo: { name: 'makefun-github-core-clone', version: '1.0.0' },
            capabilities: { tools: {} },
          },
        },
        { 'x-github-request-id': requestId },
      );
      return;
    }

    // 3. notifications/initialized
    if (method === 'notifications/initialized') {
      res.writeHead(204, { 'x-github-request-id': requestId });
      res.end();
      return;
    }

    // 4. tools/list
    if (method === 'tools/list') {
      sendJson(
        res,
        200,
        {
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS,
          },
        },
        { 'x-github-request-id': requestId },
      );
      return;
    }

    // 5. tools/call
    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      // Canonical tool matching (strip server prefix if present)
      const canonical = TOOLS.find((t) => t.name === toolName || toolName?.endsWith(`/${t.name}`) || toolName?.endsWith(`_${t.name}`));
      if (!canonical) {
        sendJson(
          res,
          200,
          {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Tool not found: ${toolName}` },
          },
          { 'x-github-request-id': requestId },
        );
        return;
      }

      // Check required arguments
      const missing = canonical.inputSchema.required.filter((prop) => args[prop] === undefined || args[prop] === null);
      if (missing.length > 0) {
        sendJson(
          res,
          200,
          {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }],
            },
          },
          { 'x-github-request-id': requestId },
        );
        return;
      }

      // Execute tool
      let outcome: any = null;

      if (canonical.name === 'create_repo') {
        const owner = args.owner || store.viewerLogin;
        const repo = store.createRepo(owner, args.name, {
          description: args.description,
          private: args.private ?? true,
        });
        outcome = {
          name: repo.name,
          full_name: repo.full_name,
          owner: { login: repo.owner.login },
          private: repo.private,
          description: repo.description,
          default_branch: repo.default_branch,
        };
      } else if (canonical.name === 'get_repo') {
        const repo = store.getRepo(args.owner, args.repo);
        if (!repo) {
          sendJson(
            res,
            200,
            {
              jsonrpc: '2.0',
              id,
              result: { isError: true, content: [{ type: 'text', text: 'Repository not found' }] },
            },
            { 'x-github-request-id': requestId },
          );
          return;
        }
        outcome = {
          name: repo.name,
          full_name: repo.full_name,
          owner: { login: repo.owner.login },
          private: repo.private,
          description: repo.description,
          default_branch: repo.default_branch,
        };
      } else if (canonical.name === 'create_issue') {
        const repo = store.getRepo(args.owner, args.repo);
        if (!repo) {
          sendJson(
            res,
            200,
            {
              jsonrpc: '2.0',
              id,
              result: { isError: true, content: [{ type: 'text', text: 'Repository not found' }] },
            },
            { 'x-github-request-id': requestId },
          );
          return;
        }
        const issue = store.createIssue(repo, args.title, args.body ?? '');
        outcome = {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
        };
      } else if (canonical.name === 'list_issues') {
        const repo = store.getRepo(args.owner, args.repo);
        if (!repo) {
          sendJson(
            res,
            200,
            {
              jsonrpc: '2.0',
              id,
              result: { isError: true, content: [{ type: 'text', text: 'Repository not found' }] },
            },
            { 'x-github-request-id': requestId },
          );
          return;
        }
        let issues = [...repo.issues.values()];
        if (args.state && args.state !== 'all') {
          issues = issues.filter((i) => i.state === args.state);
        }
        outcome = issues.map((i) => ({
          id: i.id,
          number: i.number,
          title: i.title,
          state: i.state,
        }));
      } else if (canonical.name === 'create_pull_request') {
        const repo = store.getRepo(args.owner, args.repo);
        if (!repo) {
          sendJson(
            res,
            200,
            {
              jsonrpc: '2.0',
              id,
              result: { isError: true, content: [{ type: 'text', text: 'Repository not found' }] },
            },
            { 'x-github-request-id': requestId },
          );
          return;
        }
        const pull = store.createPull(repo, args.title, args.head, args.base, args.body ?? '');
        outcome = {
          id: pull.id,
          number: pull.number,
          title: pull.title,
          state: pull.state,
          head: { ref: pull.headRefName, sha: pull.head.sha },
          base: { ref: pull.baseRefName, sha: pull.base.sha },
        };
      } else if (canonical.name === 'merge_pull_request') {
        const repo = store.getRepo(args.owner, args.repo);
        if (!repo) {
          sendJson(
            res,
            200,
            {
              jsonrpc: '2.0',
              id,
              result: { isError: true, content: [{ type: 'text', text: 'Repository not found' }] },
            },
            { 'x-github-request-id': requestId },
          );
          return;
        }
        const mergeRes = store.mergePull(repo, args.pull_number);
        if (!mergeRes.ok) {
          sendJson(
            res,
            200,
            {
              jsonrpc: '2.0',
              id,
              result: { isError: true, content: [{ type: 'text', text: mergeRes.error ?? 'Merge failed' }] },
            },
            { 'x-github-request-id': requestId },
          );
          return;
        }
        outcome = {
          merged: true,
          sha: mergeRes.sha,
          message: 'Pull Request successfully merged',
        };
      }

      sendJson(
        res,
        200,
        {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(outcome) }],
          },
        },
        { 'x-github-request-id': requestId },
      );
      return;
    }

    // Default unknown method
    sendJson(
      res,
      200,
      {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      },
      { 'x-github-request-id': requestId },
    );
  });
}
