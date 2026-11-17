/**
 * A dependency-free git smart-HTTP client (protocol v2 and v0) for the github-core-clone-01
 * envelope. The trial pod has no `git` binary and no internet: every request this module makes
 * goes to the entry's base URL (`wire.ts`), and everything else is done in-process here.
 *
 * What it implements, and where:
 *   - pkt-line codec: 0000 flush, 0001 delim, 0002 response-end, 4-hex-length framing, max 65520
 *     bytes a packet (git's LARGE_PACKET_MAX). `PktLineDecoder` parses incrementally so a fetch
 *     response is never buffered whole just to be framed.
 *   - ref advertisement: v0 (`<oid> <ref>\0<caps>`, peeled tags, `symref=HEAD:...`, the empty
 *     repo's `capabilities^{}` pseudo-ref) and v2 (`version 2` + capability lines).
 *   - ls-refs (v2: `peel`, `symrefs`, `unborn`, `ref-prefix`; v0: the advertisement's ref list).
 *   - fetch (v2 sections `acknowledgments`, `shallow-info`, `wanted-refs`, `packfile`; v0
 *     `want`/`have`/`done`/`deepen` with side-band-64k), including shallow deepen.
 *   - receive-pack push (command list, create/update/delete, report-status and report-status-v2,
 *     side-band-64k), refusing nothing itself: the server's per-ref `ng` report is returned.
 *   - packfile READ: version 2/3 packs, zlib-inflated objects, OFS_DELTA and REF_DELTA (resolved
 *     recursively, thin-pack bases supplied by the caller), trailer checksum verified.
 *   - packfile WRITE: plain objects only (no deltas), for pushes. Small and correct.
 *   - object model: SHA-1 object hashing exactly as git computes it, commit/tree/tag parsing and
 *     building, and a reachability walk so a clone can be verified object-for-object.
 *
 * Every public call takes an `AbortSignal` and a per-call timeout; no call can hang a trial. A
 * check compares object hashes and bytes only: nothing here turns a duration into a pass bit.
 *
 * Runtime: Node 22, erasable TypeScript only (this file is loaded by `node --experimental-strip-types`
 * from sdk/run.ts and inlined by the bundle builder), Node built-ins only, no dependencies.
 */

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The all-zero object id: an unborn branch's old/new value in a receive-pack command list. */
export const ZERO_OID = '0'.repeat(40);
/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length. */
export const PKT_LINE_MAX = 65520;
/** The largest pkt-line payload (length minus the 4-byte header). */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** The per-request timeout every client call falls back to when its options name none. */
export const DEFAULT_GIT_TIMEOUT_MS = 8000;
/** The agent string the client advertises where a server advertises the `agent` capability. */
export const GIT_CLIENT_AGENT = 'makefun-git-client/1.0';
/** The only object format the client speaks (the contest's rules state SHA-1). */
export const GIT_OBJECT_FORMAT = 'sha1';

/** The two smart-HTTP services. */
export type GitService = 'git-upload-pack' | 'git-receive-pack';

/** The four object types git stores. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** Any error the client raises about the wire, with a stable machine-readable code. */
export class GitProtocolError extends Error {
  readonly code: string;

  constructor(message: string, code = 'protocol') {
    super(message);
    this.name = 'GitProtocolError';
    this.code = code;
  }
}

/** A non-200 (or unexpected) HTTP response from the entry. */
export class GitHttpError extends Error {
  readonly url: string;
  readonly status: number;
  readonly bodySnippet: string;

  constructor(message: string, url: string, status: number, bodySnippet = '') {
    super(message);
    this.name = 'GitHttpError';
    this.url = url;
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

/** One decoded pkt-line. `raw` is the exact bytes framing it, needed by the v0 raw-pack fallback. */
export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer; readonly raw: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new GitProtocolError(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`, 'pktline-too-long');
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a mixed sequence; the string `'flush'`/`'delim'`/`'response-end'` are the control packets. */
export function encodePktLines(
  items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>,
): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * An incremental pkt-line decoder. Push response chunks as they arrive; `next()` returns a packet
 * when one is complete and `null` when it needs more bytes. `finish()` marks the stream ended and
 * refuses trailing bytes, so a truncated packet is an error rather than silent data loss.
 */
export class PktLineDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  constructor(initial?: Uint8Array) {
    if (initial && initial.length) this.push(initial);
  }

  get bufferedBytes(): number {
    return this.buffered;
  }

  push(chunk: Uint8Array): void {
    if (this.ended) throw new GitProtocolError('pkt-line decoder received bytes after finish()', 'pktline-after-end');
    if (!chunk.length) return;
    this.chunks.push(asBuffer(chunk));
    this.buffered += chunk.length;
  }

  /** Mark the stream ended. A caller that expects raw trailing bytes takes them before this. */
  finish(): void {
    this.ended = true;
  }

  /** True once the stream is ended and every byte was consumed. */
  get complete(): boolean {
    return this.ended && this.buffered === 0;
  }

  /** A view of the next `n` bytes without consuming them, or null if fewer are buffered. */
  private peek(n: number): Buffer | null {
    if (this.buffered < n) return null;
    const first = this.chunks[0];
    if (first.length >= n) return first.subarray(0, n);
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    for (const chunk of this.chunks) {
      const need = n - filled;
      if (need <= 0) break;
      const take = Math.min(need, chunk.length);
      chunk.copy(out, filled, 0, take);
      filled += take;
    }
    return out;
  }

  /** Consume exactly `n` buffered bytes and return them. */
  private take(n: number): Buffer {
    if (this.buffered < n) throw new GitProtocolError('pkt-line decoder underrun', 'pktline-underrun');
    const first = this.chunks[0];
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0];
      const need = n - filled;
      if (chunk.length <= need) {
        chunk.copy(out, filled);
        filled += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(out, filled, 0, need);
        this.chunks[0] = chunk.subarray(need);
        filled = n;
      }
    }
    this.buffered -= n;
    return out;
  }

  /** True when the next four buffered bytes look like a pkt-line length, not raw pack data. */
  private nextLooksFramed(): boolean {
    const head = this.peek(4);
    return head !== null && HEX4.test(head.toString('ascii'));
  }

  /** Remove and return every buffered byte (the v0 raw-pack fallback). */
  takeBuffered(): Buffer {
    if (!this.buffered) return Buffer.alloc(0);
    const out = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    return out;
  }

  /**
   * The next packet, or null when more bytes are needed. Throws on a malformed header or a
   * truncated stream (after `finish()`), never returns a bogus packet.
   */
  next(): GitPacket | null {
    if (this.buffered < 4) {
      if (this.ended && this.buffered > 0) {
        throw new GitProtocolError(`truncated pkt-line: ${this.buffered} trailing byte(s)`, 'pktline-truncated');
      }
      return null;
    }
    const header = this.peek(4)!;
    if (!HEX4.test(header.toString('ascii'))) {
      throw new GitProtocolError(`invalid pkt-line length ${JSON.stringify(header.toString('ascii'))}`, 'pktline-header');
    }
    const length = Number.parseInt(header.toString('ascii'), 16);
    if (length === 0) {
      this.take(4);
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.take(4);
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.take(4);
      return { kind: 'response-end' };
    }
    if (length === 3) {
      throw new GitProtocolError('invalid pkt-line length 0003', 'pktline-header');
    }
    if (length > PKT_LINE_MAX) {
      throw new GitProtocolError(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`, 'pktline-too-long');
    }
    if (this.buffered < length) {
      if (this.ended) {
        throw new GitProtocolError(`truncated pkt-line: ${length} announced, ${this.buffered} available`, 'pktline-truncated');
      }
      return null;
    }
    const raw = this.take(length);
    return { kind: 'data', payload: raw.subarray(4), raw };
  }

  /**
   * Switch the decoder to raw (unframed) mode for a v0 fetch response without sideband: returns
   * the buffered bytes untouched when the next four bytes are not a pkt-line length.
   */
  nextIsRaw(): boolean {
    if (this.buffered < 4) return false;
    return !this.nextLooksFramed();
  }
}

/** Decode a complete buffer into packets; refuses trailing bytes. */
export function decodePktLines(bytes: Uint8Array, options: { allowTrailing?: boolean } = {}): GitPacket[] {
  const decoder = new PktLineDecoder(bytes);
  decoder.finish();
  const packets: GitPacket[] = [];
  for (;;) {
    if (options.allowTrailing && decoder.nextIsRaw()) break;
    const packet = decoder.next();
    if (packet === null) break;
    packets.push(packet);
  }
  return packets;
}

/** The decoded text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// object model
// ---------------------------------------------------------------------------------------------

/** A git object: its type and its exact byte content (no header, as the hash is computed over it). */
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The loose-object header `<type> <size>\0` that prefixes the bytes a SHA-1 is computed over. */
export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = asBuffer(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

/** The full loose-object bytes (header + content), as `git cat-file` would hash them. */
export function encodeLooseObject(type: GitObjectType, data: Uint8Array): Buffer {
  const body = asBuffer(data);
  return Buffer.concat([objectHeader(type, body.length), body]);
}

const HEX40 = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-hex object id (the only id form the client accepts). */
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** A parsed tree entry. `mode` is git's ASCII mode (`100644`, `40000`, `160000`, ...). */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  /** Any headers before the blank line that the client does not model (`gpgsig`, `encoding`, ...). */
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = asBuffer(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new GitProtocolError('tree entry has no mode separator', 'tree-parse');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new GitProtocolError('tree entry has no name terminator', 'tree-parse');
    if (nul + 21 > buffer.length) throw new GitProtocolError('tree entry has a truncated object id', 'tree-parse');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new GitProtocolError(`tree entry mode ${JSON.stringify(mode)} is not octal`, 'tree-parse');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new GitProtocolError(`tree entry ${entry.name} has a bad object id`, 'tree-build');
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object; refuses a malformed header layout. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  if (!isObjectId(tree)) throw new GitProtocolError('commit has no valid tree header', 'commit-parse');
  for (const parent of parents) if (!isObjectId(parent)) throw new GitProtocolError('commit has a bad parent id', 'commit-parse');
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new GitProtocolError(`tag header ${JSON.stringify(line)} has no value`, 'tag-parse');
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new GitProtocolError('tag has no valid object header', 'tag-parse');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new GitProtocolError(`tag has bad type ${JSON.stringify(type)}`, 'tag-parse');
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Fields for a deterministic commit object. */
export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  /** Unix seconds. Callers pass a fixed constant, never Date.now(). */
  readonly timestamp?: number;
  /** `+0000` by default, so two runs produce the same bytes. */
  readonly timezone?: string;
}

/** The default identity every generated commit and tag carries, so bytes are reproducible. */
export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';

/** Build a commit object's bytes. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new GitProtocolError('buildCommit needs a valid tree id', 'commit-build');
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new GitProtocolError('buildCommit needs valid parent ids', 'commit-build');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  if (!isObjectId(fields.object)) throw new GitProtocolError('buildTag needs a valid object id', 'tag-build');
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

/** A lookup from object id to object; a plain Map is the common case in the suite. */
export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `roots`: commit → tree + parents, tree → entries (gitlinks skipped),
 * tag → its target, blob → nothing. Throws on a missing object unless `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new GitProtocolError(`object ${oid} is missing from the store`, 'missing-object');
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue; // a gitlink names a commit the repo does not hold
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// packfile read
// ---------------------------------------------------------------------------------------------

export interface PackEntry {
  /** Byte offset of this entry's header in the pack. */
  readonly offset: number;
  /** The type stored in the pack (a delta entry reports `ofs-delta`/`ref-delta` through `delta`). */
  readonly type: GitObjectType;
  readonly size: number;
  readonly data: Buffer;
  readonly oid: string;
  readonly delta: { readonly kind: 'ofs' | 'ref'; readonly baseOid: string } | null;
}

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly entries: PackEntry[];
  readonly trailer: string;
  readonly computedTrailer: string;
  readonly checksumOk: boolean;
  readonly deltaCount: number;
  readonly byteLength: number;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new GitProtocolError('pack entry has no size header', 'pack-truncated');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitProtocolError('pack entry size varint is truncated', 'pack-truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new GitProtocolError('pack entry size varint is too long', 'pack-corrupt');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new GitProtocolError('ofs-delta has no base offset', 'pack-truncated');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitProtocolError('ofs-delta base offset is truncated', 'pack-truncated');
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = asBuffer(buffer).subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new GitProtocolError(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`, 'pack-zlib');
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new GitProtocolError(`zlib stream at offset ${offset} consumed no bytes`, 'pack-zlib');
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = asBuffer(base);
  const deltaBuffer = asBuffer(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new GitProtocolError('delta size varint is truncated', 'delta-corrupt');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new GitProtocolError('delta size varint is too long', 'delta-corrupt');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) {
    throw new GitProtocolError(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`, 'delta-base-size');
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new GitProtocolError('delta copy offset is truncated', 'delta-corrupt');
          copyOffset += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new GitProtocolError('delta copy size is truncated', 'delta-corrupt');
          copySize += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new GitProtocolError('delta copy is out of the base', 'delta-corrupt');
      if (written + copySize > targetSize) throw new GitProtocolError('delta writes past its target size', 'delta-corrupt');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new GitProtocolError('delta insert is truncated', 'delta-corrupt');
      if (written + literal > targetSize) throw new GitProtocolError('delta writes past its target size', 'delta-corrupt');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new GitProtocolError('delta opcode 0 is invalid', 'delta-corrupt');
    }
  }
  if (written !== targetSize) throw new GitProtocolError(`delta produced ${written} of ${targetSize} bytes`, 'delta-size');
  return out;
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Uint8Array): string {
  const buffer = asBuffer(pack);
  if (buffer.length < 20) throw new GitProtocolError('pack is shorter than its trailer', 'pack-truncated');
  return createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and REF_DELTA.
 * `resolveBase` supplies a base object a thin pack leaves out (the client already has it).
 * Every object's SHA-1 is recomputed and its declared size checked; a mismatch is an error, so a
 * corruption cannot be reported as a successful clone.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = asBuffer(pack);
  if (buffer.length < 32) throw new GitProtocolError(`pack is ${buffer.length} bytes, too short`, 'pack-truncated');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new GitProtocolError('pack does not start with PACK', 'pack-header');
  }
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new GitProtocolError(`unsupported pack version ${version}`, 'pack-version');
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new GitProtocolError(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`, 'pack-delta');
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new GitProtocolError('ref-delta base id is truncated', 'pack-truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new GitProtocolError(`pack entry ${index} has unknown type code ${typeCode}`, 'pack-type');
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new GitProtocolError(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
        'pack-size',
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new GitProtocolError(`pack has ${trailerStart - offset} stray bytes before its trailer`, 'pack-trailing');
  }

  const entries: PackEntry[] = [];
  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  // Resolved entries by their computed id, so a REF_DELTA base is an O(1) lookup, not a scan.
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new GitProtocolError(`delta cycle at pack offset ${entry.offset}`, 'pack-delta-cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new GitProtocolError(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`, 'pack-delta-base');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) {
          throw new GitProtocolError(`ref-delta base ${wanted} is neither in the pack nor supplied by the client`, 'pack-delta-base');
        }
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
    entries.push({
      offset: entry.offset,
      type: resolved.type,
      size: entry.size,
      data: entry.data,
      oid: resolved.oid,
      delta:
        entry.typeCode === 6
          ? { kind: 'ofs', baseOid: byOffset.get(entry.baseOffset!)?.oid ?? '' }
          : entry.typeCode === 7
            ? { kind: 'ref', baseOid: entry.baseOid! }
            : null,
    });
  }

  return {
    version,
    declaredCount,
    objects,
    entries,
    trailer,
    computedTrailer,
    checksumOk,
    deltaCount,
    byteLength: buffer.length,
  };
}

// ---------------------------------------------------------------------------------------------
// packfile write
// ---------------------------------------------------------------------------------------------

export interface GitObjectInput {
  readonly type: GitObjectType;
  readonly data: Uint8Array;
}

/** Encode one object's pack header: the type/size varint git's pack format uses. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas). The order is the caller's; git does not require
 * a particular order for index-pack to accept it. The trailer is SHA-1 over everything before it.
 */
export function writePack(objects: Iterable<GitObjectInput>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = asBuffer(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** True when the pack's trailer matches its bytes. */
export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const buffer = asBuffer(pack);
  const actual = buffer.subarray(buffer.length - 20).toString('hex');
  const expected = packChecksum(buffer);
  return { ok: actual === expected, expected, actual };
}

/** The objects reachable from `newTips` that a server holding `serverTips` does not have. */
export function objectsToSend(
  lookup: ObjectLookup,
  serverTips: Iterable<string>,
  newTips: Iterable<string>,
): GitObject[] {
  const onServer = collectReachable(serverTips, lookup, { allowMissing: true });
  const wanted = collectReachable(newTips, lookup);
  const send: GitObject[] = [];
  for (const oid of wanted) {
    if (onServer.has(oid)) continue;
    const object = lookup(oid);
    if (object) send.push(object);
  }
  return send;
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------------------------

/** The subset of `fetch`'s Response the client uses; declared here to avoid a DOM dependency. */
export interface GitHttpResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: AsyncIterable<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export type GitFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: Uint8Array;
    signal: AbortSignal;
    redirect: 'error';
  },
) => Promise<GitHttpResponse>;

const defaultFetch: GitFetchLike = (url, init) =>
  (globalThis as unknown as { fetch: GitFetchLike }).fetch(url, init);

interface TimeoutBox {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
}

/** Combine the caller's signal with a per-call timeout, and say later which one fired. */
function withTimeout(parent: AbortSignal | undefined, timeoutMs: number): TimeoutBox {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new GitProtocolError(`request timed out after ${timeoutMs} ms`, 'timeout'));
  }, Math.max(1, timeoutMs));
  const timerWithUnref = timer as unknown as { unref?: () => void };
  if (typeof timerWithUnref.unref === 'function') timerWithUnref.unref();
  let listener: (() => void) | null = null;
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else {
      listener = () => controller.abort(parent.reason);
      parent.addEventListener('abort', listener, { once: true });
    }
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      if (parent && listener) parent.removeEventListener('abort', listener);
    },
  };
}

async function* responseChunks(response: GitHttpResponse): AsyncGenerator<Uint8Array> {
  if (response.body) {
    for await (const chunk of response.body) yield chunk;
    return;
  }
  const whole = Buffer.from(await response.arrayBuffer());
  if (whole.length) yield whole;
}

async function readAllPackets(response: GitHttpResponse): Promise<GitPacket[]> {
  const decoder = new PktLineDecoder();
  const packets: GitPacket[] = [];
  for await (const chunk of responseChunks(response)) {
    decoder.push(chunk);
    for (let packet = decoder.next(); packet !== null; packet = decoder.next()) packets.push(packet);
  }
  decoder.finish();
  return packets;
}

/** Read packets incrementally; the callback may throw to stop. */
export async function streamPackets(
  response: GitHttpResponse,
  onPacket: (packet: GitPacket) => void,
): Promise<void> {
  const decoder = new PktLineDecoder();
  for await (const chunk of responseChunks(response)) {
    decoder.push(chunk);
    for (let packet = decoder.next(); packet !== null; packet = decoder.next()) onPacket(packet);
  }
  decoder.finish();
}

/** The `# service=...` smart-HTTP preamble is optional in some v2 servers; detect and skip it. */
interface AdvertisementParseResult {
  readonly advertisement: Advertisement;
  readonly hadServiceHeader: boolean;
}

export interface AdvertisedRef {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
  readonly symrefTarget?: string;
  readonly unborn?: boolean;
}

export interface AdvertisementV0 {
  readonly protocol: 0;
  readonly service: GitService;
  readonly refs: AdvertisedRef[];
  readonly capabilities: ReadonlyMap<string, string>;
  readonly headSymref: string | null;
  readonly hadServiceHeader: boolean;
}

export interface AdvertisementV2 {
  readonly protocol: 2;
  readonly service: GitService;
  readonly capabilities: ReadonlyMap<string, string>;
  readonly versionLine: string;
  readonly hadServiceHeader: boolean;
}

export type Advertisement = AdvertisementV0 | AdvertisementV2;

function parseCapabilityList(text: string): Map<string, string> {
  const capabilities = new Map<string, string>();
  for (const token of text.split(' ')) {
    if (!token) continue;
    const equals = token.indexOf('=');
    if (equals < 0) capabilities.set(token, '');
    else capabilities.set(token.slice(0, equals), token.slice(equals + 1));
  }
  return capabilities;
}

/**
 * Parse an info/refs body into a v0 ref advertisement or a v2 capability advertisement.
 * v0: `<oid> <ref>` lines (peeled tags `^{}`, the empty repo's `capabilities^{}` pseudo-ref) with
 * capabilities after a NUL on the first line. v2: `version 2` followed by capability lines.
 */
export function parseAdvertisement(packets: readonly GitPacket[], service: GitService): AdvertisementParseResult {
  const lines: string[] = [];
  let hadServiceHeader = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (lines.length === 0 && !hadServiceHeader && text.startsWith('# service=')) {
      hadServiceHeader = true;
      continue;
    }
    lines.push(text);
  }
  const first = (lines[0] ?? '').replace(/\n$/, '');
  if (first === 'version 2' || first.startsWith('version 2 ')) {
    const capabilities = new Map<string, string>();
    for (const line of lines) {
      const text = line.replace(/\n$/, '');
      if (!text) continue;
      if (text === 'version 2') continue;
      const equals = text.indexOf('=');
      if (equals < 0) capabilities.set(text, '');
      else capabilities.set(text.slice(0, equals), text.slice(equals + 1));
    }
    const format = capabilities.get('object-format');
    if (format && format !== GIT_OBJECT_FORMAT) {
      throw new GitProtocolError(`server speaks object-format ${format}, this client speaks ${GIT_OBJECT_FORMAT}`, 'object-format');
    }
    return {
      hadServiceHeader,
      advertisement: { protocol: 2, service, capabilities, versionLine: first, hadServiceHeader },
    };
  }
  const refs: AdvertisedRef[] = [];
  let capabilities = new Map<string, string>();
  let headSymref: string | null = null;
  const rawRefs: Array<{ oid: string; name: string; peeled?: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].replace(/\n$/, '');
    if (!line) continue;
    if (index === 0) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        capabilities = parseCapabilityList(line.slice(nul + 1));
        line = line.slice(0, nul);
      }
    }
    const space = line.indexOf(' ');
    if (space < 0) throw new GitProtocolError(`v0 advertisement line has no ref: ${JSON.stringify(line.slice(0, 60))}`, 'advertisement');
    const oid = line.slice(0, space);
    const name = line.slice(space + 1);
    if (!isObjectId(oid)) throw new GitProtocolError(`v0 advertisement names a bad object id ${JSON.stringify(oid)}`, 'advertisement');
    if (name.trim() === 'capabilities^{}') continue;
    if (name.endsWith('^{}')) {
      const base = name.slice(0, -3);
      const existing = rawRefs.find((ref) => ref.name === base);
      if (existing) existing.peeled = oid;
      else rawRefs.push({ oid, name: base, peeled: oid });
      continue;
    }
    rawRefs.push({ oid, name });
  }
  for (const ref of rawRefs) {
    if (ref.oid === ZERO_OID) {
      refs.push({ oid: ref.oid, name: ref.name, unborn: true, peeled: ref.peeled });
      continue;
    }
    const entry: { oid: string; name: string; peeled?: string; symrefTarget?: string } = { oid: ref.oid, name: ref.name, peeled: ref.peeled };
    if (ref.name === 'HEAD') {
      const symref = capabilities.get('symref');
      if (symref && symref.startsWith('HEAD:')) {
        entry.symrefTarget = symref.slice(5);
        headSymref = entry.symrefTarget;
      }
    }
    refs.push(entry);
  }
  return {
    hadServiceHeader,
    advertisement: { protocol: 0, service, refs, capabilities, headSymref, hadServiceHeader },
  };
}

/** Options every client call accepts. */
export interface GitCallOptions {
  /** Aborts this call (and every HTTP request it makes). */
  readonly signal?: AbortSignal;
  /** This call's own timeout; defaults to the client's. */
  readonly timeoutMs?: number;
}

export interface GitClientOptions {
  /** The entry's base URL from wire.ts, e.g. `http://127.0.0.1:PORT` (no trailing slash). */
  readonly baseUrl: string;
  /** Bearer token, used only by the optional REST repo-create helper. */
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** `auto` (v2 when advertised), `2` (require v2), `0` (never request v2). */
  readonly gitProtocol?: 'auto' | 2 | 0;
  readonly fetchImpl?: GitFetchLike;
  readonly agent?: string;
}

/** A single receive-pack command. `oldOid`/`newOid` may be `ZERO_OID` for create/delete. */
export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export interface PushRefReport {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason: string;
  readonly options: ReadonlyMap<string, string>;
}

export interface PushReport {
  readonly unpackOk: boolean;
  readonly unpackDetail: string;
  readonly refs: PushRefReport[];
}

export interface PushResult {
  readonly report: PushReport | null;
  readonly progress: string;
  readonly sideband: boolean;
  readonly capabilities: ReadonlyMap<string, string>;
}

export interface LsRefsResult {
  readonly protocol: 0 | 2;
  /** Every ref the server sent, before the client-side prefix filter (proves server-side ref-prefix). */
  readonly rawRefs: AdvertisedRef[];
  readonly refs: AdvertisedRef[];
  readonly capabilities: ReadonlyMap<string, string>;
  readonly headSymref: string | null;
}

export interface FetchRequest {
  readonly wants: readonly string[];
  readonly haves?: readonly string[];
  readonly depth?: number;
  /** The client's current shallow boundary (required when deepening a shallow clone). */
  readonly shallow?: readonly string[];
  readonly deepenSince?: number;
  readonly deepenNot?: readonly string[];
  /** Send `done` with this request (default true). False leaves negotiation open. */
  readonly done?: boolean;
  /** Skip pack parsing (the benchmark's shallow clones only checksum the stream). */
  readonly parse?: boolean;
  /** Objects the client already has, so a thin pack's REF_DELTA can resolve. */
  readonly haveObjects?: ReadonlyMap<string, GitObject>;
  readonly thinPack?: boolean;
  readonly noProgress?: boolean;
  readonly filter?: string;
  /** Observes every response packet, for the sideband-framing check. */
  readonly observe?: (packet: GitPacket) => void;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface FetchResult {
  readonly protocol: 0 | 2;
  readonly pack: Buffer | null;
  readonly packBytes: number;
  readonly checksumOk: boolean;
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly acks: string[];
  readonly nak: boolean;
  readonly ready: boolean;
  readonly wantedRefs: ReadonlyArray<{ oid: string; ref: string }>;
  readonly progress: string;
}

export interface CloneOptions extends GitCallOptions {
  readonly depth?: number;
  readonly parse?: boolean;
  /** Want every head and tag (default) or only the default branch's tip. */
  readonly singleBranch?: boolean;
}

export interface CloneResult {
  readonly protocol: 0 | 2;
  readonly refs: AdvertisedRef[];
  readonly head: string | null;
  readonly objects: Map<string, GitObject>;
  readonly pack: Buffer | null;
  readonly packBytes: number;
  readonly checksumOk: boolean;
  readonly deltaCount: number;
  readonly shallow: string[];
  readonly progress: string;
}

interface RequestOptions extends GitCallOptions {
  readonly method?: 'GET' | 'POST';
  readonly contentType?: string;
  readonly accept?: string;
  readonly body?: Buffer;
  readonly service?: GitService;
  readonly gitProtocolVersion?: 2 | 0;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function snippet(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function isAbortError(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

// ---------------------------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------------------------

/**
 * A smart-HTTP client bound to one entry base URL. Construct it once per trial; every method takes
 * its own signal/timeout. Nothing outside `baseUrl` is ever requested.
 */
export class GitClient {
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly agent: string;
  private readonly timeoutMs: number;
  private readonly parentSignal: AbortSignal | undefined;
  private readonly protocolPreference: 'auto' | 2 | 0;
  private readonly fetchImpl: GitFetchLike;

  constructor(options: GitClientOptions) {
    if (!options || !options.baseUrl) throw new GitProtocolError('GitClient needs the entry base URL', 'config');
    this.baseUrl = trimBase(options.baseUrl);
    this.token = options.token;
    this.agent = options.agent ?? GIT_CLIENT_AGENT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    this.parentSignal = options.signal;
    this.protocolPreference = options.gitProtocol ?? 'auto';
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  /** `/<owner>/<repo>.git`: the smart-HTTP path the entry serves (stated in the rules). */
  repoPath(owner: string, repo: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(owner)) throw new GitProtocolError(`invalid owner ${JSON.stringify(owner)}`, 'repo-name');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo) || repo.endsWith('.git')) {
      throw new GitProtocolError(`invalid repo ${JSON.stringify(repo)}`, 'repo-name');
    }
    return `/${owner}/${repo}.git`;
  }

  /** The absolute URL of a repo's git path plus a suffix (e.g. `/info/refs?service=...`). */
  repoUrl(owner: string, repo: string, suffix: string): string {
    const url = `${this.baseUrl}${this.repoPath(owner, repo)}${suffix}`;
    if (!url.startsWith(`${this.baseUrl}/`)) throw new GitProtocolError('request would leave the entry base URL', 'url');
    return url;
  }

  private async request(url: string, options: RequestOptions): Promise<GitHttpResponse> {
    if (!url.startsWith(`${this.baseUrl}/`)) {
      throw new GitProtocolError(`refusing to request ${url}, outside the entry base URL`, 'url');
    }
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const box = withTimeout(options.signal ?? this.parentSignal, timeoutMs);
    const headers: Record<string, string> = {
      'User-Agent': this.agent,
      Accept: options.accept ?? '*/*',
    };
    if (options.contentType) headers['Content-Type'] = options.contentType;
    if (options.body) headers['Content-Length'] = String(options.body.length);
    if (options.gitProtocolVersion === 2) headers['Git-Protocol'] = 'version=2';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    try {
      const response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        signal: box.signal,
        redirect: 'error',
      });
      return response;
    } catch (err) {
      if (box.timedOut()) {
        throw new GitProtocolError(`request to ${url} timed out after ${timeoutMs} ms`, 'timeout');
      }
      if (isAbortError(err) || box.signal.aborted) {
        throw new GitProtocolError(`request to ${url} was aborted`, 'aborted');
      }
      throw err;
    } finally {
      box.dispose();
    }
  }

  private expectedType(service: GitService, kind: 'advertisement' | 'result'): string {
    return `application/x-${service}-${kind}`;
  }

  private async expectOk(response: GitHttpResponse, url: string, contentType: string | null, expected: string): Promise<void> {
    if (response.status !== 200) {
      let body = '';
      try {
        body = snippet(await response.text());
      } catch {
        body = '';
      }
      throw new GitHttpError(`${url} returned HTTP ${response.status}${body ? `: ${body}` : ''}`, url, response.status, body);
    }
    if (contentType !== null && !contentType.toLowerCase().includes(expected)) {
      throw new GitProtocolError(
        `${url} returned content-type ${JSON.stringify(contentType)}, expected ${expected}`,
        'content-type',
      );
    }
  }

  /**
   * GET info/refs for a service and return the raw status/content-type/packets, without throwing on
   * a non-200. The conformance checks use this to prove a missing repo answers 404 and that the
   * server is still healthy afterwards.
   */
  async infoRefs(
    owner: string,
    repo: string,
    service: GitService,
    options: GitCallOptions = {},
  ): Promise<{ status: number; contentType: string | null; packets: GitPacket[]; bodySnippet: string }> {
    const version: 2 | 0 | null =
      service !== 'git-upload-pack' || this.protocolPreference === 0 ? null : 2;
    const url = this.repoUrl(owner, repo, `/info/refs?service=${service}`);
    const response = await this.request(url, {
      method: 'GET',
      accept: '*/*',
      gitProtocolVersion: version === 2 ? 2 : 0,
      ...options,
    });
    const contentType = response.headers.get('content-type');
    if (response.status !== 200) {
      let body = '';
      try {
        body = snippet(await response.text());
      } catch {
        body = '';
      }
      return { status: response.status, contentType, packets: [], bodySnippet: body };
    }
    const packets = await readAllPackets(response);
    return { status: 200, contentType, packets, bodySnippet: '' };
  }

  /** Fetch and parse a ref/capability advertisement. */
  async advertisement(
    owner: string,
    repo: string,
    service: GitService,
    options: GitCallOptions = {},
  ): Promise<Advertisement> {
    const raw = await this.infoRefs(owner, repo, service, options);
    if (raw.status !== 200) {
      throw new GitHttpError(
        `${this.repoPath(owner, repo)}/info/refs?service=${service} returned HTTP ${raw.status}`,
        this.repoUrl(owner, repo, `/info/refs?service=${service}`),
        raw.status,
        raw.bodySnippet,
      );
    }
    const expected = this.expectedType(service, 'advertisement');
    if (raw.contentType !== null && !raw.contentType.toLowerCase().includes(expected)) {
      throw new GitProtocolError(
        `info/refs returned content-type ${JSON.stringify(raw.contentType)}, expected ${expected}`,
        'content-type',
      );
    }
    const parsed = parseAdvertisement(raw.packets, service);
    if (parsed.advertisement.protocol === 2 && this.protocolPreference === 0) {
      throw new GitProtocolError('server answered v2 while the client requested v0', 'protocol-mismatch');
    }
    if (parsed.advertisement.protocol === 0 && this.protocolPreference === 2) {
      throw new GitProtocolError('server does not support protocol v2', 'protocol-v2-required');
    }
    return parsed.advertisement;
  }

  private async post(
    owner: string,
    repo: string,
    service: GitService,
    body: Buffer,
    options: RequestOptions,
  ): Promise<GitHttpResponse> {
    const url = this.repoUrl(owner, repo, `/${service}`);
    const response = await this.request(url, {
      ...options,
      method: 'POST',
      contentType: `application/x-${service}-request`,
      accept: `application/x-${service}-result`,
      body,
    });
    await this.expectOk(response, url, response.headers.get('content-type'), this.expectedType(service, 'result'));
    return response;
  }

  /** v2 ls-refs (or the v0 advertisement's ref list, filtered client-side). */
  async lsRefs(
    owner: string,
    repo: string,
    options: GitCallOptions & { prefixes?: readonly string[]; peel?: boolean; symrefs?: boolean; unborn?: boolean } = {},
  ): Promise<LsRefsResult> {
    const advertisement = await this.advertisement(owner, repo, 'git-upload-pack', options);
    const prefixes = options.prefixes ?? [];
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    if (advertisement.protocol === 0) {
      return {
        protocol: 0,
        rawRefs: advertisement.refs,
        refs: advertisement.refs.filter((ref) => keep(ref.name)),
        capabilities: advertisement.capabilities,
        headSymref: advertisement.headSymref,
      };
    }
    const fetchCapability = advertisement.capabilities.get('ls-refs') ?? '';
    const lines: Array<string | 'flush' | 'delim'> = ['command=ls-refs\n'];
    if (advertisement.capabilities.has('agent')) lines.push(`agent=${this.agent}\n`);
    if (advertisement.capabilities.has('object-format')) lines.push(`object-format=${GIT_OBJECT_FORMAT}\n`);
    lines.push('delim');
    if (options.peel !== false) lines.push('peel\n');
    if (options.symrefs !== false) lines.push('symrefs\n');
    if (options.unborn !== false && fetchCapability.split(' ').includes('unborn')) lines.push('unborn\n');
    for (const prefix of prefixes) lines.push(`ref-prefix ${prefix}\n`);
    lines.push('flush');
    const response = await this.post(owner, repo, 'git-upload-pack', encodePktLines(lines), {
      ...options,
      service: 'git-upload-pack',
      gitProtocolVersion: 2,
    });
    const refs: AdvertisedRef[] = [];
    await streamPackets(response, (packet) => {
      if (packet.kind !== 'data') return;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (!line) return;
      const firstSpace = line.indexOf(' ');
      if (firstSpace < 0) throw new GitProtocolError(`ls-refs line has no ref name: ${JSON.stringify(line.slice(0, 60))}`, 'ls-refs');
      const first = line.slice(0, firstSpace);
      const rest = line.slice(firstSpace + 1);
      const tokens = rest.split(' ');
      const name = tokens[0];
      let symrefTarget: string | undefined;
      let peeled: string | undefined;
      for (const token of tokens.slice(1)) {
        if (token.startsWith('symref-target:')) symrefTarget = token.slice('symref-target:'.length);
        else if (token.startsWith('peeled:')) peeled = token.slice('peeled:'.length);
      }
      if (first === 'unborn') {
        refs.push({ oid: ZERO_OID, name, unborn: true, symrefTarget });
        return;
      }
      if (!isObjectId(first)) throw new GitProtocolError(`ls-refs names a bad object id ${JSON.stringify(first)}`, 'ls-refs');
      refs.push({ oid: first, name, peeled, symrefTarget });
    });
    return {
      protocol: 2,
      rawRefs: refs,
      refs: refs.filter((ref) => keep(ref.name)),
      capabilities: advertisement.capabilities,
      headSymref: refs.find((ref) => ref.name === 'HEAD')?.symrefTarget ?? null,
    };
  }

  /** Fetch objects. Chooses v2 when the server advertises it, v0 otherwise. */
  async fetch(owner: string, repo: string, request: FetchRequest, options: GitCallOptions = {}): Promise<FetchResult> {
    const callOptions: GitCallOptions = {
      signal: options.signal ?? request.signal,
      timeoutMs: options.timeoutMs ?? request.timeoutMs,
    };
    const advertisement = await this.advertisement(owner, repo, 'git-upload-pack', callOptions);
    if (advertisement.protocol === 2) return this.fetchV2(owner, repo, advertisement, request, callOptions);
    return this.fetchV0(owner, repo, advertisement, request, callOptions);
  }

  private async fetchV2(
    owner: string,
    repo: string,
    advertisement: AdvertisementV2,
    request: FetchRequest,
    options: GitCallOptions,
  ): Promise<FetchResult> {
    const wants = [...new Set(request.wants)];
    for (const want of wants) if (!isObjectId(want)) throw new GitProtocolError(`fetch wants a bad object id ${JSON.stringify(want)}`, 'fetch-want');
    const empty: FetchResult = {
      protocol: 2,
      pack: null,
      packBytes: 0,
      checksumOk: true,
      objects: new Map(),
      deltaCount: 0,
      shallow: [],
      unshallow: [],
      acks: [],
      nak: false,
      ready: false,
      wantedRefs: [],
      progress: '',
    };
    if (!wants.length) return empty;
    const features = (advertisement.capabilities.get('fetch') ?? '').split(' ').filter(Boolean);
    if (request.depth != null && !features.includes('shallow')) {
      throw new GitProtocolError('server does not advertise shallow fetches (fetch=shallow)', 'fetch-shallow');
    }
    if (request.filter != null && !features.includes('filter')) {
      throw new GitProtocolError('server does not advertise fetch filtering', 'fetch-filter');
    }
    const lines: Array<string | 'flush' | 'delim'> = ['command=fetch\n'];
    if (advertisement.capabilities.has('agent')) lines.push(`agent=${this.agent}\n`);
    if (advertisement.capabilities.has('object-format')) lines.push(`object-format=${GIT_OBJECT_FORMAT}\n`);
    lines.push('delim');
    if (request.thinPack !== false) lines.push('thin-pack\n');
    if (request.noProgress !== false) lines.push('no-progress\n');
    lines.push('ofs-delta\n');
    if (request.filter != null) lines.push(`filter ${request.filter}\n`);
    for (const want of wants) lines.push(`want ${want}\n`);
    for (const have of request.haves ?? []) {
      if (!isObjectId(have)) throw new GitProtocolError(`fetch have is a bad object id ${JSON.stringify(have)}`, 'fetch-have');
      lines.push(`have ${have}\n`);
    }
    for (const boundary of request.shallow ?? []) {
      if (!isObjectId(boundary)) throw new GitProtocolError(`fetch shallow boundary is a bad object id ${JSON.stringify(boundary)}`, 'fetch-shallow');
      lines.push(`shallow ${boundary}\n`);
    }
    if (request.depth != null) lines.push(`deepen ${request.depth}\n`);
    if (request.deepenSince != null) lines.push(`deepen-since ${request.deepenSince}\n`);
    for (const not of request.deepenNot ?? []) lines.push(`deepen-not ${not}\n`);
    if (request.done !== false) lines.push('done\n');
    lines.push('flush');
    const response = await this.post(owner, repo, 'git-upload-pack', encodePktLines(lines), {
      ...options,
      service: 'git-upload-pack',
      gitProtocolVersion: 2,
    });
    return this.parseV2Fetch(response, request);
  }

  private async parseV2Fetch(response: GitHttpResponse, request: FetchRequest): Promise<FetchResult> {
    type Section = '' | 'acknowledgments' | 'shallow-info' | 'wanted-refs' | 'packfile' | 'packfile-uris';
    let section: Section = '';
    const packChunks: Buffer[] = [];
    const shallow: string[] = [];
    const unshallow: string[] = [];
    const acks: string[] = [];
    const wantedRefs: Array<{ oid: string; ref: string }> = [];
    let progress = '';
    let nak = false;
    let ready = false;
    let sidebandPackets = 0;
    const decoder = new PktLineDecoder();
    const consume = (packet: GitPacket): void => {
      request.observe?.(packet);
      if (packet.kind === 'flush') {
        section = '';
        return;
      }
      if (packet.kind === 'delim') {
        section = '';
        return;
      }
      if (packet.kind !== 'data') throw new GitProtocolError('unexpected control packet in a fetch section', 'fetch-section');
      const payload = packet.payload;
      if (section === '') {
        const line = payload.toString('utf8');
        if (line === 'acknowledgments\n') section = 'acknowledgments';
        else if (line === 'shallow-info\n') section = 'shallow-info';
        else if (line === 'wanted-refs\n') section = 'wanted-refs';
        else if (line === 'packfile\n') section = 'packfile';
        else if (line === 'packfile-uris\n') section = 'packfile-uris';
        else {
          throw new GitProtocolError(`unexpected v2 fetch section ${JSON.stringify(line.slice(0, 40))}`, 'fetch-section');
        }
        return;
      }
      if (section === 'packfile') {
        sidebandPackets += 1;
        if (payload.length < 1) throw new GitProtocolError('empty sideband packet in a packfile section', 'sideband');
        const band = payload[0];
        const data = payload.subarray(1);
        if (band === 1) packChunks.push(data);
        else if (band === 2) progress += data.toString('utf8');
        else if (band === 3) throw new GitProtocolError(`server sideband error: ${data.toString('utf8').trim()}`, 'sideband-error');
        else throw new GitProtocolError(`invalid sideband band ${band}`, 'sideband');
        return;
      }
      const line = payload.toString('utf8').replace(/\n$/, '');
      if (section === 'acknowledgments') {
        if (line === 'NAK') nak = true;
        else if (line === 'ready') ready = true;
        else if (line.startsWith('ACK ')) acks.push(line.slice(4).trim());
        else throw new GitProtocolError(`bad acknowledgments line ${JSON.stringify(line.slice(0, 40))}`, 'fetch-ack');
        return;
      }
      if (section === 'shallow-info') {
        if (line.startsWith('shallow ')) shallow.push(line.slice(8));
        else if (line.startsWith('unshallow ')) unshallow.push(line.slice(10));
        else throw new GitProtocolError(`bad shallow-info line ${JSON.stringify(line.slice(0, 40))}`, 'fetch-shallow');
        return;
      }
      if (section === 'wanted-refs') {
        const space = line.indexOf(' ');
        if (space < 0) throw new GitProtocolError('bad wanted-refs line', 'fetch-wanted-refs');
        const oid = line.slice(0, space);
        if (!isObjectId(oid)) throw new GitProtocolError('wanted-refs names a bad object id', 'fetch-wanted-refs');
        wantedRefs.push({ oid, ref: line.slice(space + 1) });
        return;
      }
      throw new GitProtocolError(`unexpected packet in section ${section}`, 'fetch-section');
    };
    for await (const chunk of responseChunks(response)) {
      decoder.push(chunk);
      for (let packet = decoder.next(); packet !== null; packet = decoder.next()) consume(packet);
    }
    decoder.finish();
    if ((section as Section) === 'packfile' && sidebandPackets === 0) {
      throw new GitProtocolError('packfile section carried no packets', 'sideband');
    }
    const pack = packChunks.length ? Buffer.concat(packChunks) : null;
    let checksumOk = true;
    let objects = new Map<string, GitObject>();
    let deltaCount = 0;
    if (pack) {
      const checksum = verifyPackChecksum(pack);
      checksumOk = checksum.ok;
      if (!checksumOk) {
        throw new GitProtocolError(`pack trailer ${checksum.actual} does not match its bytes ${checksum.expected}`, 'pack-checksum');
      }
      if (request.parse !== false) {
        const read = readPack(pack, {
          resolveBase: (oid) => request.haveObjects?.get(oid),
        });
        objects = read.objects;
        deltaCount = read.deltaCount;
      }
    }
    return {
      protocol: 2,
      pack,
      packBytes: pack?.length ?? 0,
      checksumOk,
      objects,
      deltaCount,
      shallow,
      unshallow,
      acks,
      nak,
      ready,
      wantedRefs,
      progress,
    };
  }

  private async fetchV0(
    owner: string,
    repo: string,
    advertisement: AdvertisementV0,
    request: FetchRequest,
    options: GitCallOptions,
  ): Promise<FetchResult> {
    const wants = [...new Set(request.wants)];
    for (const want of wants) if (!isObjectId(want)) throw new GitProtocolError(`fetch wants a bad object id ${JSON.stringify(want)}`, 'fetch-want');
    const empty: FetchResult = {
      protocol: 0,
      pack: null,
      packBytes: 0,
      checksumOk: true,
      objects: new Map(),
      deltaCount: 0,
      shallow: [],
      unshallow: [],
      acks: [],
      nak: false,
      ready: false,
      wantedRefs: [],
      progress: '',
    };
    if (!wants.length) return empty;
    const sideband = advertisement.capabilities.has('side-band-64k');
    if (!sideband) {
      throw new GitProtocolError('v0 server does not advertise side-band-64k, so a fetch cannot be framed', 'sideband');
    }
    const features: string[] = ['side-band-64k'];
    if (advertisement.capabilities.has('multi_ack_detailed')) features.push('multi_ack_detailed');
    else if (advertisement.capabilities.has('multi_ack')) features.push('multi_ack');
    if (request.thinPack !== false && advertisement.capabilities.has('thin-pack')) features.push('thin-pack');
    if (request.noProgress !== false) features.push('no-progress');
    if (advertisement.capabilities.has('ofs-delta')) features.push('ofs-delta');
    let first = true;
    const lines: Array<string | 'flush'> = [];
    for (const want of wants) {
      lines.push(first && features.length ? `want ${want} ${features.join(' ')}\n` : `want ${want}\n`);
      first = false;
    }
    for (const boundary of request.shallow ?? []) {
      if (!isObjectId(boundary)) throw new GitProtocolError(`fetch shallow boundary is a bad object id ${JSON.stringify(boundary)}`, 'fetch-shallow');
      lines.push(`shallow ${boundary}\n`);
    }
    if (request.depth != null) {
      if (!advertisement.capabilities.has('shallow')) {
        throw new GitProtocolError('v0 server does not advertise shallow', 'fetch-shallow');
      }
      lines.push(`deepen ${request.depth}\n`);
    }
    if (request.deepenSince != null) lines.push(`deepen-since ${request.deepenSince}\n`);
    for (const not of request.deepenNot ?? []) lines.push(`deepen-not ${not}\n`);
    // v0 is two sections: wants (with shallow/deepen) terminated by a flush, then the negotiation
    // (have lines and done) terminated by a second flush. A single section is a v2 shape and makes
    // upload-pack answer "expected to get object ID, not 'done'".
    lines.push('flush');
    for (const have of request.haves ?? []) {
      if (!isObjectId(have)) throw new GitProtocolError(`fetch have is a bad object id ${JSON.stringify(have)}`, 'fetch-have');
      lines.push(`have ${have}\n`);
    }
    if (request.done !== false) lines.push('done\n');
    lines.push('flush');
    const response = await this.post(owner, repo, 'git-upload-pack', encodePktLines(lines), {
      ...options,
      service: 'git-upload-pack',
      gitProtocolVersion: 0,
    });
    const shallow: string[] = [];
    const unshallow: string[] = [];
    const acks: string[] = [];
    let nak = false;
    let progress = '';
    const packChunks: Buffer[] = [];
    const decoder = new PktLineDecoder();
    const consume = (packet: GitPacket): void => {
      request.observe?.(packet);
      if (packet.kind !== 'data') return;
      if (packet.payload.length < 1) throw new GitProtocolError('empty v0 fetch packet', 'fetch-v0');
      const band = packet.payload[0];
      if (band === 1 || band === 2 || band === 3) {
        const data = packet.payload.subarray(1);
        if (band === 1) packChunks.push(data);
        else if (band === 2) progress += data.toString('utf8');
        else throw new GitProtocolError(`server sideband error: ${data.toString('utf8').trim()}`, 'sideband-error');
        return;
      }
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('shallow ')) {
        shallow.push(line.slice(8));
        return;
      }
      if (line.startsWith('unshallow ')) {
        unshallow.push(line.slice(10));
        return;
      }
      if (line === 'NAK') {
        nak = true;
        return;
      }
      if (line.startsWith('ACK ')) {
        acks.push(line.slice(4));
        return;
      }
      throw new GitProtocolError(`unexpected v0 fetch packet ${JSON.stringify(line.slice(0, 40))}`, 'fetch-v0');
    };
    for await (const chunk of responseChunks(response)) {
      decoder.push(chunk);
      for (let packet = decoder.next(); packet !== null; packet = decoder.next()) consume(packet);
    }
    decoder.finish();
    const pack = packChunks.length ? Buffer.concat(packChunks) : null;
    let checksumOk = true;
    let objects = new Map<string, GitObject>();
    let deltaCount = 0;
    if (pack) {
      const checksum = verifyPackChecksum(pack);
      checksumOk = checksum.ok;
      if (!checksumOk) {
        throw new GitProtocolError(`pack trailer ${checksum.actual} does not match its bytes ${checksum.expected}`, 'pack-checksum');
      }
      if (request.parse !== false) {
        const read = readPack(pack, { resolveBase: (oid) => request.haveObjects?.get(oid) });
        objects = read.objects;
        deltaCount = read.deltaCount;
      }
    }
    return {
      protocol: 0,
      pack,
      packBytes: pack?.length ?? 0,
      checksumOk,
      objects,
      deltaCount,
      shallow,
      unshallow,
      acks,
      nak,
      ready: false,
      wantedRefs: [],
      progress,
    };
  }

  /** Fetch a repo's refs and objects from nothing, optionally shallow. */
  async clone(owner: string, repo: string, options: CloneOptions = {}): Promise<CloneResult> {
    const advertisement = await this.advertisement(owner, repo, 'git-upload-pack', options);
    let refs: AdvertisedRef[] = [];
    let headSymref: string | null = null;
    if (advertisement.protocol === 0) {
      refs = advertisement.refs;
      headSymref = advertisement.headSymref;
    } else {
      const ls = await this.lsRefs(owner, repo, { ...options, peel: true, symrefs: true });
      refs = ls.refs;
      headSymref = ls.headSymref ?? refs.find((ref) => ref.name === 'HEAD')?.symrefTarget ?? null;
    }
    const base: Omit<CloneResult, 'protocol' | 'objects' | 'pack' | 'packBytes' | 'checksumOk' | 'deltaCount' | 'shallow' | 'progress'> = {
      refs,
      head: headSymref,
    };
    const wants = new Set<string>();
    if (options.depth != null || options.singleBranch) {
      const headRef = refs.find((ref) => ref.name === (headSymref ?? 'HEAD'));
      const tip = headRef?.oid ?? refs.find((ref) => ref.name.startsWith('refs/heads/'))?.oid;
      if (tip && tip !== ZERO_OID) wants.add(tip);
      if (!tip && options.depth == null) {
        for (const ref of refs) if (ref.name.startsWith('refs/heads/')) wants.add(ref.oid);
      }
    } else {
      for (const ref of refs) {
        if (ref.oid === ZERO_OID) continue;
        if (ref.name.startsWith('refs/heads/') || ref.name.startsWith('refs/tags/')) wants.add(ref.oid);
      }
    }
    if (!wants.size) {
      return {
        ...base,
        protocol: advertisement.protocol,
        objects: new Map(),
        pack: null,
        packBytes: 0,
        checksumOk: true,
        deltaCount: 0,
        shallow: [],
        progress: '',
      };
    }
    const fetch = await this.fetch(
      owner,
      repo,
      { wants: [...wants], depth: options.depth, parse: options.parse },
      options,
    );
    return {
      ...base,
      protocol: advertisement.protocol,
      objects: fetch.objects,
      pack: fetch.pack,
      packBytes: fetch.packBytes,
      checksumOk: fetch.checksumOk,
      deltaCount: fetch.deltaCount,
      shallow: fetch.shallow,
      progress: fetch.progress,
    };
  }

  /**
   * Push a command list. `options.objects` (or a prebuilt `options.pack`) carries the objects the
   * server lacks; deletes need neither. A rejection is returned in `report` (an `ng` line), never
   * thrown: HTTP 200 with a refused ref is a successful exchange of a refused update.
   */
  async push(
    owner: string,
    repo: string,
    commands: readonly PushCommand[],
    options: GitCallOptions & { objects?: readonly GitObjectInput[]; pack?: Uint8Array; capabilities?: readonly string[] } = {},
  ): Promise<PushResult> {
    if (!commands.length) throw new GitProtocolError('push needs at least one command', 'push-command');
    for (const command of commands) {
      if (!isObjectId(command.oldOid) || !isObjectId(command.newOid)) {
        throw new GitProtocolError('push command has a bad object id', 'push-command');
      }
      if (!command.ref.startsWith('refs/') || command.ref.length > 200 || /[\s\u0000-\u001f]/.test(command.ref)) {
        throw new GitProtocolError(`push command has a bad ref ${JSON.stringify(command.ref)}`, 'push-command');
      }
    }
    const advertisement = await this.advertisement(owner, repo, 'git-receive-pack', options);
    if (advertisement.protocol !== 0) {
      throw new GitProtocolError('receive-pack must advertise protocol v0', 'push-protocol');
    }
    const capabilities: string[] = [...(options.capabilities ?? [])];
    // Prefer report-status-v2 (a superset carrying option lines) when the server offers it; fall
    // back to report-status. Both parse through parsePushReport.
    if (advertisement.capabilities.has('report-status-v2')) capabilities.push('report-status-v2');
    else if (advertisement.capabilities.has('report-status')) capabilities.push('report-status');
    if (advertisement.capabilities.has('side-band-64k')) capabilities.push('side-band-64k');
    if (advertisement.capabilities.has('ofs-delta')) capabilities.push('ofs-delta');
    if (advertisement.capabilities.has('agent')) capabilities.push(`agent=${this.agent}`);
    // A receive-pack command list that creates or updates a ref always carries a pack, even an empty
    // one: real git's receive-pack reports "unpacker error" for a bare command list. A delete-only
    // command list carries no pack at all (git sends none there either).
    const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
    const pack = options.pack
      ? Buffer.from(options.pack)
      : updatesRef || (options.objects !== undefined && options.objects.length > 0)
        ? writePack(options.objects ?? [])
        : null;
    const lines: Array<string | 'flush'> = [];
    commands.forEach((command, index) => {
      const prefix = `${command.oldOid} ${command.newOid} ${command.ref}`;
      lines.push(index === 0 && capabilities.length ? `${prefix}\u0000${capabilities.join(' ')}\n` : `${prefix}\n`);
    });
    lines.push('flush');
    const body = Buffer.concat([encodePktLines(lines), pack ?? Buffer.alloc(0)]);
    const sideband = capabilities.includes('side-band-64k');
    const response = await this.post(owner, repo, 'git-receive-pack', body, {
      ...options,
      service: 'git-receive-pack',
      gitProtocolVersion: 0,
    });
    const reportChunks: Buffer[] = [];
    let progress = '';
    const decoder = new PktLineDecoder();
    const consume = (packet: GitPacket): void => {
      if (packet.kind !== 'data') return;
      if (!packet.payload.length) return;
      if (sideband) {
        const band = packet.payload[0];
        const data = packet.payload.subarray(1);
        if (band === 1) reportChunks.push(data);
        else if (band === 2) progress += data.toString('utf8');
        else if (band === 3) throw new GitProtocolError(`server sideband error: ${data.toString('utf8').trim()}`, 'sideband-error');
        else throw new GitProtocolError(`invalid push sideband band ${band}`, 'sideband');
        return;
      }
      reportChunks.push(packet.payload);
    };
    for await (const chunk of responseChunks(response)) {
      decoder.push(chunk);
      for (let packet = decoder.next(); packet !== null; packet = decoder.next()) consume(packet);
    }
    decoder.finish();
    const reportBytes = reportChunks.length ? Buffer.concat(reportChunks) : Buffer.alloc(0);
    const report = this.parsePushReport(reportBytes);
    return { report, progress, sideband, capabilities: advertisement.capabilities };
  }

  private parsePushReport(bytes: Buffer): PushReport | null {
    if (!bytes.length) return null;
    // With side-band-64k the report-status stream is itself pkt-lined inside band 1; without it the
    // body is the report-status pkt-line stream directly. Either way the lines are pkt-framed.
    let text: string;
    if (/^[0-9a-fA-F]{4}$/.test(bytes.subarray(0, 4).toString('ascii'))) {
      const packets = decodePktLines(bytes);
      text = packets
        .filter((packet) => packet.kind === 'data')
        .map((packet) => (packet.kind === 'data' ? packet.payload.toString('utf8') : ''))
        .join('');
    } else {
      text = bytes.toString('utf8');
    }
    let unpackOk = false;
    let unpackDetail = 'missing';
    const refs: Array<{ ref: string; ok: boolean; reason: string; options: Map<string, string> }> = [];
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line) continue;
      if (line.startsWith('unpack ')) {
        const detail = line.slice('unpack '.length);
        unpackOk = detail === 'ok';
        unpackDetail = detail;
      } else if (line.startsWith('ok ')) {
        refs.push({ ref: line.slice(3), ok: true, reason: '', options: new Map() });
      } else if (line.startsWith('ng ')) {
        const rest = line.slice(3);
        const space = rest.indexOf(' ');
        if (space < 0) throw new GitProtocolError(`bad ng line ${JSON.stringify(line)}`, 'push-report');
        refs.push({ ref: rest.slice(0, space), ok: false, reason: rest.slice(space + 1), options: new Map() });
      } else if (line.startsWith('option ')) {
        const rest = line.slice(7);
        const space = rest.indexOf(' ');
        const last = refs[refs.length - 1];
        if (!last) throw new GitProtocolError(`report option with no ref: ${JSON.stringify(line)}`, 'push-report');
        if (space < 0) last.options.set(rest, '');
        else last.options.set(rest.slice(0, space), rest.slice(space + 1));
      } else {
        throw new GitProtocolError(`bad report-status line ${JSON.stringify(line.slice(0, 80))}`, 'push-report');
      }
    }
    if (unpackDetail === 'missing') throw new GitProtocolError('report-status has no unpack line', 'push-report');
    return { unpackOk, unpackDetail, refs };
  }

  /**
   * Create a repo through the entry's REST surface (`POST /api/v3/user/repos`), the one agreed
   * creation path in the rules: a smart-HTTP push cannot invent a repository. A 422 that says the
   * repo already exists is accepted, so a re-run against a live server is idempotent.
   */
  async createRepo(owner: string, name: string, options: GitCallOptions = {}): Promise<void> {
    const url = `${this.baseUrl}/api/v3/user/repos`;
    if (!url.startsWith(`${this.baseUrl}/`)) throw new GitProtocolError('repo creation would leave the entry base URL', 'url');
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const box = withTimeout(options.signal ?? this.parentSignal, timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'User-Agent': this.agent,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: Buffer.from(JSON.stringify({ name, description: `git conformance for ${owner}/${name}`, private: true, auto_init: false }), 'utf8'),
        signal: box.signal,
        redirect: 'error',
      });
      if (response.status === 201 || response.status === 200) {
        await response.arrayBuffer().catch(() => undefined);
        return;
      }
      let body = '';
      try {
        body = snippet(await response.text());
      } catch {
        body = '';
      }
      if (response.status === 422 && /already exists/i.test(body)) return;
      throw new GitHttpError(
        `POST /api/v3/user/repos for ${owner}/${name} returned HTTP ${response.status}${body ? `: ${body}` : ''}`,
        url,
        response.status,
        body,
      );
    } catch (err) {
      if (box.timedOut()) throw new GitProtocolError(`repo creation timed out after ${timeoutMs} ms`, 'timeout');
      throw err;
    } finally {
      box.dispose();
    }
  }

  /** A convenience health probe: true when a repo's upload-pack advertisement answers 200. */
  async repoExists(owner: string, repo: string, options: GitCallOptions = {}): Promise<boolean> {
    const raw = await this.infoRefs(owner, repo, 'git-upload-pack', options);
    return raw.status === 200;
  }

  /**
   * POST a service body without validating the response: the conformance checks use it to hand the
   * server a malformed pkt-line and then prove the server still serves a healthy clone.
   */
  async postRaw(
    owner: string,
    repo: string,
    service: GitService,
    body: Uint8Array,
    options: GitCallOptions = {},
  ): Promise<{ status: number; contentType: string | null; bodySnippet: string }> {
    const url = this.repoUrl(owner, repo, `/${service}`);
    const response = await this.request(url, {
      ...options,
      method: 'POST',
      contentType: `application/x-${service}-request`,
      accept: `application/x-${service}-result`,
      body: Buffer.from(body),
    });
    let text = '';
    try {
      text = snippet(await response.text(), 200);
    } catch {
      text = '';
    }
    return { status: response.status, contentType: response.headers.get('content-type'), bodySnippet: text };
  }
}


// ---------------------------------------------------------------------------------------------
// Server-side Git helpers
// ---------------------------------------------------------------------------------------------

export interface FileItem {
  readonly path: string;
  readonly data: Buffer;
}

export function treeFromFiles(
  files: readonly FileItem[],
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  interface Node {
    files: Map<string, Buffer>;
    dirs: Map<string, Node>;
  }
  const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = makeNode();

  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i];
      if (!node.dirs.has(seg)) node.dirs.set(seg, makeNode());
      node = node.dirs.get(seg)!;
    }
    node.files.set(segments[segments.length - 1], file.data);
  }

  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    const sortedFileKeys = [...node.files.keys()].sort();
    for (const name of sortedFileKeys) {
      const data = node.files.get(name)!;
      const blobOid = put('blob', data);
      entries.push({ mode: '100644', name, oid: blobOid });
    }
    const sortedDirKeys = [...node.dirs.keys()].sort();
    for (const name of sortedDirKeys) {
      const child = node.dirs.get(name)!;
      const childOid = build(child);
      entries.push({ mode: '40000', name, oid: childOid });
    }
    const treeData = buildTree(entries);
    return put('tree', treeData);
  };

  return build(root);
}

export function filesFromTree(
  rootOid: string,
  lookup: ObjectLookup,
  prefix = '',
): Map<string, { oid: string; data: Buffer }> {
  const result = new Map<string, { oid: string; data: Buffer }>();
  const treeObj = lookup(rootOid);
  if (!treeObj || treeObj.type !== 'tree') return result;

  const entries = parseTree(treeObj.data);
  for (const entry of entries) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000' || entry.mode === '040000') {
      const sub = filesFromTree(entry.oid, lookup, fullPath);
      for (const [p, f] of sub) result.set(p, f);
    } else {
      const blobObj = lookup(entry.oid);
      if (blobObj) {
        result.set(fullPath, { oid: entry.oid, data: blobObj.data });
      }
    }
  }
  return result;
}

export function isAncestor(lookup: ObjectLookup, ancestorOid: string, descendantOid: string): boolean {
  if (ancestorOid === descendantOid) return true;
  if (!ancestorOid || !descendantOid || ancestorOid === ZERO_OID || descendantOid === ZERO_OID) return false;

  const descObj = lookup(descendantOid);
  if (!descObj || descObj.type !== 'commit') return false;
  const descCommit = parseCommit(descObj.data);
  if (descCommit.parents.includes(ancestorOid)) return true;

  const queue: string[] = [...descCommit.parents];
  const visited = new Set<string>([descendantOid]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (current === ancestorOid) return true;

    const obj = lookup(current);
    if (obj && obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      for (const parent of commit.parents) {
        if (!visited.has(parent)) queue.push(parent);
      }
    }
  }
  return false;
}

export function findMergeBase(lookup: ObjectLookup, oid1: string, oid2: string): string | null {
  if (oid1 === oid2) return oid1;
  const reachableFrom1 = new Set<string>();
  const q1 = [oid1];
  while (q1.length > 0) {
    const cur = q1.shift()!;
    if (reachableFrom1.has(cur)) continue;
    reachableFrom1.add(cur);
    const obj = lookup(cur);
    if (obj && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) q1.push(p);
    }
  }

  const q2 = [oid2];
  const visited2 = new Set<string>();
  while (q2.length > 0) {
    const cur = q2.shift()!;
    if (visited2.has(cur)) continue;
    visited2.add(cur);
    if (reachableFrom1.has(cur)) return cur;
    const obj = lookup(cur);
    if (obj && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) q2.push(p);
    }
  }
  return null;
}

export function checkMergeConflict(lookup: ObjectLookup, baseCommitOid: string, headCommitOid: string): boolean {
  const mergeBaseOid = findMergeBase(lookup, baseCommitOid, headCommitOid);
  if (!mergeBaseOid) return false;

  const baseCommitObj = lookup(baseCommitOid);
  const headCommitObj = lookup(headCommitOid);
  const mbCommitObj = lookup(mergeBaseOid);
  if (!baseCommitObj || !headCommitObj || !mbCommitObj) return false;

  const baseCommit = parseCommit(baseCommitObj.data);
  const headCommit = parseCommit(headCommitObj.data);
  const mbCommit = parseCommit(mbCommitObj.data);

  const baseFiles = filesFromTree(baseCommit.tree, lookup);
  const headFiles = filesFromTree(headCommit.tree, lookup);
  const mbFiles = filesFromTree(mbCommit.tree, lookup);

  const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of allPaths) {
    const inMb = mbFiles.get(path);
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);

    const baseChanged = inBase?.oid !== inMb?.oid;
    const headChanged = inHead?.oid !== inMb?.oid;

    if (baseChanged && headChanged) {
      if (inBase?.oid !== inHead?.oid) {
        return true;
      }
    }
  }
  return false;
}
