import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  encodePktLine,
  encodePktLines,
  pktLineFlush,
  pktLineDelim,
  decodePktLines,
  hashObject,
  parseCommit,
  parseTree,
  parseTag,
  readPack,
  writePack,
  objectsToSend,
  isAncestor,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type ObjectLookup,
} from './git.ts';
import type { ForgeStore, Repository } from './store.ts';

function sendBytes(res: ServerResponse, status: number, contentType: string, data: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': data.length,
    ...headers,
  });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, contentType: string, text: string, headers: Record<string, string> = {}): void {
  sendBytes(res, status, contentType, Buffer.from(text, 'utf8'), headers);
}

export function handleSmartGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  owner: string,
  repoName: string,
  gitAction: string,
  requestId: string,
): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendText(res, 404, 'application/json; charset=utf-8', JSON.stringify({ message: 'Not Found' }), {
      'x-github-request-id': requestId,
    });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://entry');
  const method = req.method ?? 'GET';

  // 1. GET info/refs
  if (method === 'GET' && gitAction === 'info/refs') {
    const service = url.searchParams.get('service');
    const gitProtocol = req.headers['git-protocol']?.toString() ?? '';
    const isV2 = gitProtocol.includes('version=2');

    if (service === 'git-upload-pack') {
      if (isV2) {
        // Protocol v2 advertisement
        const lines: Array<string | 'flush'> = [
          '# service=git-upload-pack\n',
          'flush',
          'version 2\n',
          'agent=makefun-forge/1.0\n',
          'ls-refs=peel symrefs unborn\n',
          'fetch=shallow filter\n',
          'object-format=sha1\n',
          'flush',
        ];
        sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', encodePktLines(lines), {
          'x-github-request-id': requestId,
        });
        return;
      }

      // Protocol v0 advertisement
      const lines: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush'];
      const refEntries = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

      if (refEntries.length === 0) {
        lines.push(`${ZERO_OID} capabilities^{}\0report-status delete-refs side-band-64k\n`);
      } else {
        const headTip = repo.refs.get('refs/heads/main') ?? refEntries[0][1];
        lines.push(`${headTip} HEAD\0report-status delete-refs side-band-64k symref=HEAD:refs/heads/main agent=makefun-forge/1.0\n`);
        for (const [name, oid] of refEntries) {
          lines.push(`${oid} ${name}\n`);
          // Peeled tag check
          const obj = repo.objects.get(oid);
          if (obj && obj.type === 'tag') {
            const tag = parseTag(obj.data);
            lines.push(`${tag.object} ${name}^{}\n`);
          }
        }
      }
      lines.push('flush');
      sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', encodePktLines(lines), {
        'x-github-request-id': requestId,
      });
      return;
    }

    if (service === 'git-receive-pack') {
      // receive-pack is v0 only
      const lines: Array<string | 'flush'> = ['# service=git-receive-pack\n', 'flush'];
      const refEntries = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

      if (refEntries.length === 0) {
        lines.push(`${ZERO_OID} capabilities^{}\0report-status report-status-v2 delete-refs side-band-64k\n`);
      } else {
        const headTip = repo.refs.get('refs/heads/main') ?? refEntries[0][1];
        lines.push(`${headTip} HEAD\0report-status report-status-v2 delete-refs side-band-64k symref=HEAD:refs/heads/main agent=makefun-forge/1.0\n`);
        for (const [name, oid] of refEntries) {
          lines.push(`${oid} ${name}\n`);
          const obj = repo.objects.get(oid);
          if (obj && obj.type === 'tag') {
            const tag = parseTag(obj.data);
            lines.push(`${tag.object} ${name}^{}\n`);
          }
        }
      }
      lines.push('flush');
      sendBytes(res, 200, 'application/x-git-receive-pack-advertisement', encodePktLines(lines), {
        'x-github-request-id': requestId,
      });
      return;
    }

    sendText(res, 400, 'application/json; charset=utf-8', JSON.stringify({ message: 'Bad service' }), {
      'x-github-request-id': requestId,
    });
    return;
  }

  // POST services: collect body
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    if (method === 'POST' && gitAction === 'git-upload-pack') {
      handleUploadPack(res, repo, body, requestId);
      return;
    }

    if (method === 'POST' && gitAction === 'git-receive-pack') {
      handleReceivePack(res, repo, body, requestId);
      return;
    }

    sendText(res, 404, 'application/json; charset=utf-8', JSON.stringify({ message: 'Not Found' }), {
      'x-github-request-id': requestId,
    });
  });
}

function handleUploadPack(res: ServerResponse, repo: Repository, body: Buffer, requestId: string): void {
  let packets;
  try {
    packets = decodePktLines(body, { allowTrailing: true });
  } catch {
    // Malformed packet
    sendText(res, 400, 'text/plain', 'malformed packet-line\n', { 'x-github-request-id': requestId });
    return;
  }

  const lines = packets.filter((p) => p.kind === 'data').map((p) => (p.kind === 'data' ? p.payload.toString('utf8').replace(/\n$/, '') : ''));
  const firstLine = lines[0] ?? '';

  // 1. command=ls-refs
  if (firstLine === 'command=ls-refs') {
    const peel = lines.includes('peel');
    const symrefs = lines.includes('symrefs');
    const unborn = lines.includes('unborn');
    const prefixes = lines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length));

    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const outLines: Array<string | 'flush'> = [];

    const refEntries = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const mainTip = repo.refs.get('refs/heads/main');

    if (refEntries.length === 0) {
      if (unborn) {
        outLines.push('unborn HEAD symref-target:refs/heads/main\n');
      }
    } else {
      if (keep('HEAD') && mainTip) {
        let headStr = `${mainTip} HEAD`;
        if (symrefs) headStr += ' symref-target:refs/heads/main';
        outLines.push(`${headStr}\n`);
      }
      for (const [name, oid] of refEntries) {
        if (!keep(name)) continue;
        let lineStr = `${oid} ${name}`;
        if (peel) {
          const obj = repo.objects.get(oid);
          if (obj && obj.type === 'tag') {
            const tag = parseTag(obj.data);
            lineStr += ` peeled:${tag.object}`;
          }
        }
        outLines.push(`${lineStr}\n`);
      }
    }
    outLines.push('flush');
    sendBytes(res, 200, 'application/x-git-upload-pack-result', encodePktLines(outLines), {
      'x-github-request-id': requestId,
    });
    return;
  }

  // 2. command=fetch
  if (firstLine === 'command=fetch') {
    const wants = lines.filter((l) => l.startsWith('want ')).map((l) => l.slice(5).trim());
    const haves = lines.filter((l) => l.startsWith('have ')).map((l) => l.slice(5).trim());
    const depthLine = lines.find((l) => l.startsWith('deepen '));
    const depth = depthLine ? parseInt(depthLine.slice(7).trim(), 10) : null;
    const clientShallow = lines.filter((l) => l.startsWith('shallow ')).map((l) => l.slice(8).trim());

    const lookup: ObjectLookup = (oid: string) => repo.objects.get(oid);

    // If wants is empty
    if (wants.length === 0) {
      const respLines: Array<string | 'flush' | 'delim'> = ['acknowledgments\n', 'ready\n', 'delim', 'packfile\n'];
      const emptyPack = writePack([]);
      const sidebandPack = encodePktLine(Buffer.concat([Buffer.from([1]), emptyPack]));
      const headerBytes = encodePktLines(respLines);
      sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat([headerBytes, sidebandPack, pktLineFlush()]), {
        'x-github-request-id': requestId,
      });
      return;
    }

    // Shallow fetch handling
    if (depth !== null) {
      // Collect commits down to depth from wants
      const commitsToSend: string[] = [];
      const shallowBoundaries: string[] = [];
      const unshallowBoundaries: string[] = [];

      for (const want of wants) {
        const queue: Array<{ oid: string; gen: number }> = [{ oid: want, gen: 1 }];
        const visited = new Set<string>();

        while (queue.length > 0) {
          const { oid, gen } = queue.shift()!;
          if (visited.has(oid)) continue;
          visited.add(oid);
          commitsToSend.push(oid);

          const obj = lookup(oid);
          if (obj && obj.type === 'commit') {
            const commit = parseCommit(obj.data);
            if (gen < depth) {
              for (const p of commit.parents) {
                queue.push({ oid: p, gen: gen + 1 });
              }
            } else {
              // At boundary
              if (commit.parents.length > 0) {
                shallowBoundaries.push(oid);
              }
            }
          }
        }
      }

      // If deepening: previous shallow boundaries that now have their parents included become unshallow
      for (const boundary of clientShallow) {
        if (!shallowBoundaries.includes(boundary) && commitsToSend.includes(boundary)) {
          unshallowBoundaries.push(boundary);
        }
      }

      // Collect trees and blobs for commitsToSend
      const objectsToSendMap = new Map<string, GitObject>();
      for (const cOid of commitsToSend) {
        const cObj = lookup(cOid);
        if (cObj) objectsToSendMap.set(cOid, cObj);
        if (cObj && cObj.type === 'commit') {
          const commit = parseCommit(cObj.data);
          // Collect root tree and subtrees and blobs
          const treeQueue = [commit.tree];
          while (treeQueue.length > 0) {
            const tOid = treeQueue.shift()!;
            if (objectsToSendMap.has(tOid)) continue;
            const tObj = lookup(tOid);
            if (!tObj) continue;
            objectsToSendMap.set(tOid, tObj);
            if (tObj.type === 'tree') {
              for (const entry of parseTree(tObj.data)) {
                if (entry.mode === '40000' || entry.mode === '040000') {
                  treeQueue.push(entry.oid);
                } else {
                  const bObj = lookup(entry.oid);
                  if (bObj) objectsToSendMap.set(entry.oid, bObj);
                }
              }
            }
          }
        }
      }

      // Exclude already held haves (if any)
      for (const have of haves) {
        objectsToSendMap.delete(have);
      }

      const packBytes = writePack(objectsToSendMap.values());
      const respLines: Array<string | 'flush' | 'delim'> = ['acknowledgments\n', 'ready\n', 'delim', 'shallow-info\n'];
      for (const sOid of shallowBoundaries) {
        respLines.push(`shallow ${sOid}\n`);
      }
      for (const uOid of unshallowBoundaries) {
        respLines.push(`unshallow ${uOid}\n`);
      }
      respLines.push('delim');
      respLines.push('packfile\n');

      const sidebandChunks: Buffer[] = [];
      const chunkSize = 65515;
      for (let offset = 0; offset < packBytes.length; offset += chunkSize) {
        const slice = packBytes.subarray(offset, offset + chunkSize);
        sidebandChunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
      }
      sidebandChunks.push(pktLineFlush());

      sendBytes(
        res,
        200,
        'application/x-git-upload-pack-result',
        Buffer.concat([encodePktLines(respLines), ...sidebandChunks]),
        { 'x-github-request-id': requestId },
      );
      return;
    }

    // Normal (non-shallow) fetch
    // Check if client already holds all wants
    const needed = objectsToSend(lookup, haves, wants);

    const respLines: Array<string | 'flush' | 'delim'> = ['acknowledgments\n', 'ready\n', 'delim', 'packfile\n'];
    const packBytes = writePack(needed);

    const sidebandChunks: Buffer[] = [];
    const chunkSize = 65515;
    for (let offset = 0; offset < packBytes.length; offset += chunkSize) {
      const slice = packBytes.subarray(offset, offset + chunkSize);
      sidebandChunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    sidebandChunks.push(pktLineFlush());

    sendBytes(
      res,
      200,
      'application/x-git-upload-pack-result',
      Buffer.concat([encodePktLines(respLines), ...sidebandChunks]),
      { 'x-github-request-id': requestId },
    );
    return;
  }

  // Default fallback
  sendText(res, 400, 'application/json; charset=utf-8', JSON.stringify({ message: 'Unknown git command' }), {
    'x-github-request-id': requestId,
  });
}

function handleReceivePack(res: ServerResponse, repo: Repository, body: Buffer, requestId: string): void {
  // Find where the command pkt-lines end (flush 0000)
  let flushIndex = -1;
  let offset = 0;
  const commandLines: string[] = [];

  while (offset + 4 <= body.length) {
    const lenStr = body.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(lenStr, 16);
    if (isNaN(len)) break;

    if (len === 0) {
      flushIndex = offset + 4;
      break;
    }
    const lineBuf = body.subarray(offset + 4, offset + len);
    commandLines.push(lineBuf.toString('utf8').replace(/\n$/, ''));
    offset += len;
  }

  if (flushIndex < 0) {
    sendText(res, 400, 'text/plain', 'malformed receive-pack command list\n', { 'x-github-request-id': requestId });
    return;
  }

  const packData = body.subarray(flushIndex);
  const lookup: ObjectLookup = (oid: string) => repo.objects.get(oid);

  // If packData is present, unpack it
  let unpackOk = true;
  let unpackDetail = 'ok';

  if (packData.length > 0) {
    try {
      const readRes = readPack(packData, { resolveBase: lookup });
      for (const entry of readRes.entries) {
        repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  // Parse commands and capabilities from first command
  let sideband = false;
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];

  commandLines.forEach((line, idx) => {
    let cleanLine = line;
    if (idx === 0) {
      const nullIdx = line.indexOf('\0');
      if (nullIdx >= 0) {
        const caps = line.slice(nullIdx + 1).split(' ');
        if (caps.includes('side-band-64k')) sideband = true;
        cleanLine = line.slice(0, nullIdx);
      }
    }
    const parts = cleanLine.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  });

  const refResults: Array<{ ref: string; ok: boolean; reason?: string }> = [];

  for (const cmd of commands) {
    if (!unpackOk) {
      refResults.push({ ref: cmd.ref, ok: false, reason: 'unpacker error' });
      continue;
    }

    if (cmd.newOid === ZERO_OID) {
      // Delete ref
      repo.refs.delete(cmd.ref);
      refResults.push({ ref: cmd.ref, ok: true });
    } else if (cmd.oldOid === ZERO_OID) {
      // Create ref
      repo.refs.set(cmd.ref, cmd.newOid);
      refResults.push({ ref: cmd.ref, ok: true });
    } else {
      // Update ref - check fast-forward
      const isFf = isAncestor(lookup, cmd.oldOid, cmd.newOid);
      if (isFf) {
        repo.refs.set(cmd.ref, cmd.newOid);
        refResults.push({ ref: cmd.ref, ok: true });
      } else {
        refResults.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      }
    }
  }

  // Build report status
  const innerLines: Array<string | 'flush'> = [`unpack ${unpackDetail}\n`];
  for (const resItem of refResults) {
    if (resItem.ok) {
      innerLines.push(`ok ${resItem.ref}\n`);
    } else {
      innerLines.push(`ng ${resItem.ref} ${resItem.reason ?? 'error'}\n`);
    }
  }
  innerLines.push('flush');
  const innerPayload = encodePktLines(innerLines);

  if (sideband) {
    const outerChunks: Buffer[] = [];
    const chunkSize = 65515;
    for (let pos = 0; pos < innerPayload.length; pos += chunkSize) {
      const slice = innerPayload.subarray(pos, pos + chunkSize);
      outerChunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    outerChunks.push(pktLineFlush());
    sendBytes(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(outerChunks), {
      'x-github-request-id': requestId,
    });
  } else {
    sendBytes(res, 200, 'application/x-git-receive-pack-result', innerPayload, {
      'x-github-request-id': requestId,
    });
  }
}
