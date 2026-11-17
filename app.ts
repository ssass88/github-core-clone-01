import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ForgeStore } from './store.ts';
import { handleSmartGit } from './smartgit.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

let reqCounter = 0;
function nextRequestId(): string {
  reqCounter = (reqCounter + 1) & 0x7fffffff;
  return `req-${Date.now().toString(36)}-${reqCounter.toString(36)}`;
}

function pathOf(rawUrl: string): string {
  const qIdx = rawUrl.indexOf('?');
  return qIdx < 0 ? rawUrl : rawUrl.slice(0, qIdx);
}

export function createApp(): Server {
  const store = new ForgeStore();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.socket?.setNoDelay(true);
    res.socket?.setNoDelay(true);
    const requestId = nextRequestId();
    const rawUrl = req.url ?? '/';
    const path = pathOf(rawUrl);
    const method = req.method ?? 'GET';

    // 1. Health probe
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true }, { 'x-github-request-id': requestId });
      return;
    }

    // 2. Git Smart HTTP: /:owner/:repo.git/...
    const gitMatch = path.match(/^\/([^\/]+)\/([^\/]+)\.git\/(.+)$/);
    if (gitMatch) {
      const owner = gitMatch[1];
      const repoName = gitMatch[2];
      const gitAction = gitMatch[3];
      handleSmartGit(req, res, store, owner, repoName, gitAction, requestId);
      return;
    }

    // 3. GraphQL v4: POST /api/graphql
    if (path === '/api/graphql') {
      if (method === 'POST') {
        handleGraphQL(req, res, store, requestId);
        return;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId });
      return;
    }

    // 4. Model Context Protocol: /mcp
    if (path === '/mcp') {
      if (method === 'POST') {
        handleMcp(req, res, store, requestId);
        return;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId });
      return;
    }

    // 5. REST v3: /api/v3/...
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      handleRest(req, res, store, requestId);
      return;
    }

    // Everything else: 404
    sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
  });
  return server;
}
