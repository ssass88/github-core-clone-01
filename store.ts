import {
  hashObject,
  buildCommit,
  buildTree,
  parseCommit,
  parseTree,
  filesFromTree,
  treeFromFiles,
  isAncestor,
  checkMergeConflict,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type ObjectLookup,
  type FileItem,
} from './git.ts';

export interface User {
  login: string;
  id: number;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: User;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  commentList: Comment[];
  cachedJson?: string;
  jsonBuf?: Buffer;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  mergeable: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  headRefName: string;
  baseRefName: string;
  user: User;
  created_at: string;
  updated_at: string;
}

export interface Repository {
  id: number;
  databaseId: number;
  name: string;
  full_name: string;
  owner: User;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  nextLabelId: number;
}

export function toGlobalId(type: string, id: number | string): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}

export function fromGlobalId(globalId: string): { type: string; id: string } | null {
  try {
    const raw = Buffer.from(globalId, 'base64').toString('utf8');
    const idx = raw.indexOf(':');
    if (idx < 0) return null;
    return { type: raw.slice(0, idx), id: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}

export function updateIssueCache(issue: Issue): void {
  const formatted = {
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
  issue.cachedJson = `${JSON.stringify(formatted)}\n`;
  issue.jsonBuf = Buffer.from(issue.cachedJson, 'utf8');
}

export class ForgeStore {
  readonly repos = new Map<string, Repository>();
  private nextRepoId = 1;
  private nextGlobalId = 1000;
  viewerLogin = 'adaiversen';

  setViewer(login: string): void {
    if (login) this.viewerLogin = login;
  }

  getRepo(owner: string, name: string): Repository | undefined {
    return this.repos.get(`${owner.toLowerCase()}/${name.toLowerCase()}`);
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean; defaultBranch?: string } = {}): Repository {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    const existing = this.repos.get(key);
    if (existing) return existing;

    const id = this.nextRepoId++;
    const now = new Date().toISOString();
    const repo: Repository = {
      id,
      databaseId: id,
      name,
      full_name: `${owner}/${name}`,
      owner: { login: owner, id: 1 },
      description: options.description ?? '',
      private: options.private ?? true,
      default_branch: options.defaultBranch ?? 'main',
      created_at: now,
      updated_at: now,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map([
        ['bug', { id: 1, name: 'bug', color: 'd73a4a' }],
        ['enhancement', { id: 2, name: 'enhancement', color: 'a2eeef' }],
        ['documentation', { id: 3, name: 'documentation', color: '0075ca' }],
      ]),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      nextLabelId: 10,
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner.toLowerCase()}/${name.toLowerCase()}`);
  }

  listReposForOwner(owner: string): Repository[] {
    const res: Repository[] = [];
    const lowerOwner = owner.toLowerCase();
    for (const repo of this.repos.values()) {
      if (repo.owner.login.toLowerCase() === lowerOwner) {
        res.push(repo);
      }
    }
    return res;
  }

  putObject(repo: Repository, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
    }
    return oid;
  }

  lookupObject(repo: Repository): ObjectLookup {
    return (oid: string) => repo.objects.get(oid);
  }

  // Branch and commit operations
  getTipSha(repo: Repository, branchName: string): string | undefined {
    const ref = branchName.startsWith('refs/heads/') ? branchName : `refs/heads/${branchName}`;
    return repo.refs.get(ref);
  }

  setBranchTip(repo: Repository, branchName: string, sha: string): void {
    const ref = branchName.startsWith('refs/heads/') ? branchName : `refs/heads/${branchName}`;
    repo.refs.set(ref, sha);
  }

  createCommit(
    repo: Repository,
    branchName: string,
    files: readonly FileItem[],
    message: string,
    authorName = 'Ada Iversen',
    authorEmail = 'ada@example.com',
  ): { commitSha: string; treeSha: string } {
    const put = (type: GitObjectType, data: Buffer) => this.putObject(repo, type, data);
    const treeSha = treeFromFiles(files, put);
    const parentSha = this.getTipSha(repo, branchName);
    const parents = parentSha && parentSha !== ZERO_OID ? [parentSha] : [];

    const commitData = buildCommit({
      tree: treeSha,
      parents,
      author: {
        name: authorName,
        email: authorEmail,
        timestamp: Math.floor(Date.now() / 1000),
        timezone: '+0000',
      },
      committer: {
        name: authorName,
        email: authorEmail,
        timestamp: Math.floor(Date.now() / 1000),
        timezone: '+0000',
      },
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    this.setBranchTip(repo, branchName, commitSha);
    return { commitSha, treeSha };
  }

  // Issue operations
  createIssue(repo: Repository, title: string, body = '', labels: string[] = []): Issue {
    const number = repo.nextIssueNumber++;
    const id = this.nextGlobalId++;
    const now = new Date().toISOString();
    const labelObjs: Label[] = [];
    for (const labelName of labels) {
      let l = repo.labels.get(labelName);
      if (!l) {
        l = { id: repo.nextLabelId++, name: labelName, color: 'ededed' };
        repo.labels.set(labelName, l);
      }
      labelObjs.push(l);
    }
    const issue: Issue = {
      id,
      number,
      title,
      body,
      state: 'open',
      labels: labelObjs,
      user: repo.owner,
      comments: 0,
      created_at: now,
      updated_at: now,
      closed_at: null,
      commentList: [],
    };
    updateIssueCache(issue);
    repo.issues.set(number, issue);
    return issue;
  }

  // Pull request operations
  createPull(repo: Repository, title: string, head: string, base: string, body = ''): PullRequest {
    const number = repo.nextPullNumber++;
    const id = this.nextGlobalId++;
    const now = new Date().toISOString();
    const headBranch = head.replace(/^refs\/heads\//, '');
    const baseBranch = base.replace(/^refs\/heads\//, '');
    const headSha = this.getTipSha(repo, headBranch) ?? ZERO_OID;
    const baseSha = this.getTipSha(repo, baseBranch) ?? ZERO_OID;

    const pull: PullRequest = {
      id,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      mergeable: true,
      head: { ref: headBranch, sha: headSha },
      base: { ref: baseBranch, sha: baseSha },
      headRefName: headBranch,
      baseRefName: baseBranch,
      user: repo.owner,
      created_at: now,
      updated_at: now,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  mergePull(repo: Repository, number: number, message?: string): { ok: boolean; status: number; sha?: string; error?: string } {
    const pull = repo.pulls.get(number);
    if (!pull) return { ok: false, status: 404, error: 'Not Found' };
    if (pull.state === 'closed' || pull.merged) {
      return { ok: false, status: 405, error: 'Pull Request is already closed' };
    }

    const lookup = this.lookupObject(repo);
    const baseCommitSha = this.getTipSha(repo, pull.baseRefName) ?? pull.base.sha;
    const headCommitSha = this.getTipSha(repo, pull.headRefName) ?? pull.head.sha;

    if (checkMergeConflict(lookup, baseCommitSha, headCommitSha)) {
      return { ok: false, status: 405, error: 'Pull Request is not mergeable' };
    }

    // Squash merge: take files from head commit, combine onto base
    const headCommitObj = lookup(headCommitSha);
    const baseCommitObj = lookup(baseCommitSha);
    if (!headCommitObj || !baseCommitObj) {
      return { ok: false, status: 500, error: 'Missing commit objects' };
    }

    const headCommit = parseCommit(headCommitObj.data);
    const baseCommit = parseCommit(baseCommitObj.data);
    const headFiles = filesFromTree(headCommit.tree, lookup);
    const baseFiles = filesFromTree(baseCommit.tree, lookup);

    // Merge files (head takes precedence)
    const mergedFilesMap = new Map<string, Buffer>();
    for (const [p, item] of baseFiles) {
      mergedFilesMap.set(p, item.data);
    }
    for (const [p, item] of headFiles) {
      mergedFilesMap.set(p, item.data);
    }

    const fileList: FileItem[] = [...mergedFilesMap.entries()].map(([path, data]) => ({ path, data }));
    const put = (type: GitObjectType, data: Buffer) => this.putObject(repo, type, data);
    const newTreeSha = treeFromFiles(fileList, put);

    const now = new Date();
    const commitMsg = message || `Merge pull request #${pull.number} from ${pull.headRefName}\n\n${pull.title}`;
    const mergeCommitData = buildCommit({
      tree: newTreeSha,
      parents: [baseCommitSha],
      author: {
        name: 'Ada Iversen',
        email: 'ada@example.com',
        timestamp: Math.floor(now.getTime() / 1000),
        timezone: '+0000',
      },
      committer: {
        name: 'Ada Iversen',
        email: 'ada@example.com',
        timestamp: Math.floor(now.getTime() / 1000),
        timezone: '+0000',
      },
      message: commitMsg.endsWith('\n') ? commitMsg : `${commitMsg}\n`,
    });
    const mergeCommitSha = this.putObject(repo, 'commit', mergeCommitData);

    this.setBranchTip(repo, pull.baseRefName, mergeCommitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = now.toISOString();
    pull.merge_commit_sha = mergeCommitSha;

    return { ok: true, status: 200, sha: mergeCommitSha };
  }

  diffPull(repo: Repository, pull: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const lookup = this.lookupObject(repo);
    const baseCommitSha = this.getTipSha(repo, pull.baseRefName) ?? pull.base.sha;
    const headCommitSha = this.getTipSha(repo, pull.headRefName) ?? pull.head.sha;

    const baseCommitObj = lookup(baseCommitSha);
    const headCommitObj = lookup(headCommitSha);
    if (!headCommitObj) return [];

    const headCommit = parseCommit(headCommitObj.data);
    const headFiles = filesFromTree(headCommit.tree, lookup);
    const baseFiles = baseCommitObj ? filesFromTree(parseCommit(baseCommitObj.data).tree, lookup) : new Map();

    const result: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);

    for (const path of allPaths) {
      const inBase = baseFiles.get(path);
      const inHead = headFiles.get(path);
      if (!inBase && inHead) {
        const lines = inHead.data.toString('utf8').split('\n').length;
        result.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (inBase && !inHead) {
        const lines = inBase.data.toString('utf8').split('\n').length;
        result.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (inBase && inHead && inBase.oid !== inHead.oid) {
        const headLines = inHead.data.toString('utf8').split('\n').length;
        const baseLines = inBase.data.toString('utf8').split('\n').length;
        const changes = Math.max(1, Math.abs(headLines - baseLines) + 1);
        result.push({ filename: path, status: 'modified', additions: 1, deletions: 1, changes: 2 });
      }
    }
    return result;
  }
}
