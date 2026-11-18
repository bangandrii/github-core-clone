import type { ServerResponse } from 'node:http';
import { store, nowIso, getObject, putObject, type RepoRec, type IssueRec, type PullRec } from './store.ts';
import { repoJson, userJson, refOf } from './rest.ts';
import { issueJson, pullJson } from './social.ts';
import { VIEWER } from './scenario.ts';
import { type Ctx, sendJson } from './http.ts';
import {
  treeOfCommit,
  flattenTree,
  setPath,
  encodeCommit,
  parseCommit,
  ident,
} from './gitobj.ts';

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const TOOLS = [
  {
    name: 'create_repo',
    description: 'Creates a repository owned by the viewer',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Retrieves a repository by owner and name',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Creates an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'Lists issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state (open, closed, all)' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Creates a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch' },
        base: { type: 'string', description: 'Base branch' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merges a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

function getReachableCommits(repo: RepoRec, startSha: string): Set<string> {
  const reachable = new Set<string>();
  const queue = [startSha];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (reachable.has(sha)) continue;
    reachable.add(sha);
    const obj = getObject(repo, sha);
    if (obj && obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      for (const p of commit.parents) {
        if (!reachable.has(p)) {
          queue.push(p);
        }
      }
    }
  }
  return reachable;
}

function findMergeBase(repo: RepoRec, baseSha: string, headSha: string): string | null {
  const baseReachable = getReachableCommits(repo, baseSha);
  const queue = [headSha];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (visited.has(sha)) continue;
    visited.add(sha);
    if (baseReachable.has(sha)) {
      return sha;
    }
    const obj = getObject(repo, sha);
    if (obj && obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      for (const p of commit.parents) {
        if (!visited.has(p)) {
          queue.push(p);
        }
      }
    }
  }
  return null;
}

export async function handleMcp(ctx: Ctx, res: ServerResponse): Promise<boolean> {
  const segs = ctx.segments;
  if (segs.length !== 1 || segs[0] !== 'mcp') {
    return false;
  }

  let json: unknown;
  try {
    const text = ctx.body.toString('utf8');
    json = JSON.parse(text);
  } catch {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return true;
  }

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    const reqObj = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
    const id = reqObj && 'id' in reqObj ? reqObj.id : null;
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      error: { code: -32600, message: 'Invalid Request' },
    });
    return true;
  }

  const reqObj = json as Record<string, unknown>;
  const hasId = 'id' in reqObj;
  const id = hasId ? reqObj.id : null;
  const method = reqObj.method;
  const params = reqObj.params as Record<string, unknown> | undefined;

  if (typeof method !== 'string') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      error: { code: -32600, message: 'Invalid Request' },
    });
    return true;
  }

  if (!hasId) {
    res.writeHead(202);
    res.end();
    return true;
  }

  let result: unknown;
  try {
    if (method === 'server/discover') {
      result = {
        protocolVersion: '2026-07-28',
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        capabilities: { tools: {} },
        serverInfo: { name: 'forge-mcp', version: '1.0.0' },
      };
    } else if (method === 'initialize') {
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'forge-mcp', version: '1.0.0' },
      };
    } else if (method === 'ping') {
      result = {};
    } else if (method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (method === 'tools/call') {
      const toolParams = params && typeof params === 'object' ? params : {};
      const toolName = toolParams.name;
      const toolArgs = (toolParams.arguments && typeof toolParams.arguments === 'object' ? toolParams.arguments : {}) as Record<string, unknown>;

      if (typeof toolName !== 'string') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Missing tool name' },
        });
        return true;
      }

      // Check if tool name is known
      const knownToolNames = TOOLS.map((t) => t.name);
      if (!knownToolNames.includes(toolName as any)) {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
        });
        return true;
      }

      const toolRes = executeTool(toolName, toolArgs);
      result = toolRes;
    } else {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return true;
    }

    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result,
    });
    return true;
  } catch (err) {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
    });
    return true;
  }
}

function executeTool(name: string, args: Record<string, unknown>): { content: { type: 'text'; text: string }[]; isError: boolean } {
  if (name === 'create_repo') {
    const repoName = args.name;
    if (!repoName || typeof repoName !== 'string') {
      return { content: [{ type: 'text', text: 'Repository name is missing' }], isError: true };
    }
    if (store.getRepo(VIEWER.login, repoName)) {
      return { content: [{ type: 'text', text: 'Repository already exists' }], isError: true };
    }
    const repo = store.createRepo(
      VIEWER.login,
      repoName,
      typeof args.description === 'string' ? args.description : null,
      typeof args.private === 'boolean' ? args.private : false
    );
    return { content: [{ type: 'text', text: JSON.stringify(repoJson(repo)) }], isError: false };
  }

  if (name === 'get_repo') {
    const owner = args.owner;
    const repoName = args.repo;
    if (!owner || typeof owner !== 'string' || !repoName || typeof repoName !== 'string') {
      return { content: [{ type: 'text', text: 'Missing owner or repo' }], isError: true };
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      return { content: [{ type: 'text', text: 'Repository not found' }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(repoJson(repo)) }], isError: false };
  }

  if (name === 'create_issue') {
    const owner = args.owner;
    const repoName = args.repo;
    const title = args.title;
    if (!owner || typeof owner !== 'string' || !repoName || typeof repoName !== 'string' || !title || typeof title !== 'string') {
      return { content: [{ type: 'text', text: 'Missing owner, repo, or title' }], isError: true };
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      return { content: [{ type: 'text', text: 'Repository not found' }], isError: true };
    }
    const number = repo.next_number++;
    const id = repo.id * 100000 + number;
    const issue: IssueRec = {
      id,
      number,
      title,
      body: typeof args.body === 'string' ? args.body : null,
      state: 'open',
      labels: [],
      comments: [],
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    repo.issues.push(issue);
    repo.updated_at = nowIso();
    const payload = issueJson(repo, issue);
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
  }

  if (name === 'list_issues') {
    const owner = args.owner;
    const repoName = args.repo;
    if (!owner || typeof owner !== 'string' || !repoName || typeof repoName !== 'string') {
      return { content: [{ type: 'text', text: 'Missing owner or repo' }], isError: true };
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      return { content: [{ type: 'text', text: 'Repository not found' }], isError: true };
    }
    const stateParam = typeof args.state === 'string' ? args.state : 'open';
    let filtered = repo.issues;
    if (stateParam === 'open') {
      filtered = filtered.filter((i) => i.state === 'open');
    } else if (stateParam === 'closed') {
      filtered = filtered.filter((i) => i.state === 'closed');
    }
    const sorted = [...filtered].sort((a, b) => b.number - a.number);
    const payload = sorted.map((i) => issueJson(repo, i));
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
  }

  if (name === 'create_pull_request') {
    const owner = args.owner;
    const repoName = args.repo;
    const title = args.title;
    const head = args.head;
    const base = args.base;
    if (!owner || typeof owner !== 'string' || !repoName || typeof repoName !== 'string' || !title || typeof title !== 'string' || !head || typeof head !== 'string' || !base || typeof base !== 'string') {
      return { content: [{ type: 'text', text: 'Missing owner, repo, title, head, or base' }], isError: true };
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      return { content: [{ type: 'text', text: 'Repository not found' }], isError: true };
    }
    if (!refOf(repo, head) || !refOf(repo, base)) {
      return { content: [{ type: 'text', text: 'Head or base branch does not exist' }], isError: true };
    }
    const number = repo.next_number++;
    const id = repo.id * 100000 + number;
    const head_sha = refOf(repo, head)!;
    const base_sha = refOf(repo, base)!;
    const pr: PullRec = {
      id,
      number,
      title,
      body: typeof args.body === 'string' ? args.body : null,
      state: 'open',
      merged: false,
      head_ref: head,
      head_sha,
      base_ref: base,
      base_sha,
      head,
      base,
      created_at: nowIso(),
      updated_at: nowIso(),
      merged_at: null,
    };
    repo.pulls.push(pr);
    repo.updated_at = nowIso();
    const payload = pullJson(repo, pr);
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
  }

  if (name === 'merge_pull_request') {
    const owner = args.owner;
    const repoName = args.repo;
    const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
    if (!owner || typeof owner !== 'string' || !repoName || typeof repoName !== 'string' || isNaN(pullNumber)) {
      return { content: [{ type: 'text', text: 'Missing owner, repo, or pull_number' }], isError: true };
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      return { content: [{ type: 'text', text: 'Repository not found' }], isError: true };
    }
    const pr = repo.pulls.find((p) => p.number === pullNumber);
    if (!pr) {
      return { content: [{ type: 'text', text: 'Pull request not found' }], isError: true };
    }
    if (pr.state !== 'open' || pr.merged) {
      return { content: [{ type: 'text', text: 'Pull Request is not mergeable' }], isError: true };
    }

    const headRef = pr.head_ref || pr.head || '';
    const baseRef = pr.base_ref || pr.base || '';
    const baseTipSha = refOf(repo, baseRef);
    const headTipSha = refOf(repo, headRef);
    if (!baseTipSha || !headTipSha) {
      return { content: [{ type: 'text', text: 'Base or head ref not found' }], isError: true };
    }

    const forkSha = findMergeBase(repo, baseTipSha, headTipSha);
    const baseTreeSha = treeOfCommit(repo, baseTipSha) || EMPTY_TREE_SHA;
    const headTreeSha = treeOfCommit(repo, headTipSha) || EMPTY_TREE_SHA;
    const forkTreeSha = forkSha ? (treeOfCommit(repo, forkSha) || EMPTY_TREE_SHA) : EMPTY_TREE_SHA;

    const baseFiles = new Map(flattenTree(repo, baseTreeSha).map((f) => [f.path, f.sha]));
    const headFiles = new Map(flattenTree(repo, headTreeSha).map((f) => [f.path, f.sha]));
    const forkFiles = new Map(flattenTree(repo, forkTreeSha).map((f) => [f.path, f.sha]));

    const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...forkFiles.keys()]);
    const finalMap = new Map<string, string | null>();

    for (const path of allPaths) {
      const baseSha = baseFiles.get(path) ?? null;
      const headSha = headFiles.get(path) ?? null;
      const forkShaPath = forkFiles.get(path) ?? null;

      const headChanged = headSha !== forkShaPath;
      const baseChanged = baseSha !== forkShaPath;

      if (!headChanged && !baseChanged) {
        finalMap.set(path, baseSha);
      } else if (headChanged && !baseChanged) {
        finalMap.set(path, headSha);
      } else if (!headChanged && baseChanged) {
        finalMap.set(path, baseSha);
      } else {
        if (headSha === baseSha) {
          finalMap.set(path, headSha);
        } else {
          return { content: [{ type: 'text', text: 'Merge conflict' }], isError: true };
        }
      }
    }

    let mergedTreeSha = baseTreeSha;
    for (const [path, blobSha] of finalMap.entries()) {
      const currentBaseSha = baseFiles.get(path) ?? null;
      if (blobSha !== currentBaseSha) {
        mergedTreeSha = setPath(repo, mergedTreeSha, path, blobSha);
      }
    }

    const commitRec = {
      tree: mergedTreeSha,
      parents: [baseTipSha],
      author: ident(VIEWER.name, VIEWER.email),
      committer: ident(VIEWER.name, VIEWER.email),
      message: pr.title,
    };
    const commitBuf = encodeCommit(commitRec);
    const commitSha = putObject(repo, 'commit', commitBuf);

    repo.refs.set(baseRef, commitSha);
    if (!baseRef.startsWith('refs/')) {
      repo.refs.set(`refs/heads/${baseRef}`, commitSha);
    }

    pr.merged = true;
    pr.state = 'closed';
    pr.updated_at = nowIso();
    pr.merged_at = nowIso();
    repo.updated_at = nowIso();

    const payload = { merged: true, sha: commitSha };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}
