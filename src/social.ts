import type { ServerResponse } from 'node:http';
import { store, putObject, getObject, nodeId, nowIso, type RepoRec, type IssueRec, type PullRec } from './store.ts';
import {
  encodeTree,
  parseTree,
  encodeCommit,
  parseCommit,
  ident,
  treeOfCommit,
  readPath,
  setPath,
  flattenTree,
} from './gitobj.ts';
import { userJson, repoJson, refOf, tipTree } from './rest.ts';
import { VIEWER } from './scenario.ts';
import { type Ctx, HttpError, sendJson } from './http.ts';

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function issueJson(repo: RepoRec, issue: IssueRec) {
  const id = repo.id * 100000 + issue.number;
  return {
    id,
    node_id: nodeId('Issue', id),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state,
    user: userJson(),
    labels: issue.labels.map((name) => ({
      name,
      color: repo.labels.find((l) => l.name === name)?.color ?? 'ededed',
    })),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: '',
  };
}

export function commentJson(
  repo: RepoRec,
  issue: IssueRec,
  c: { id: number; body: string; created_at: string; updated_at?: string }
) {
  return {
    id: c.id,
    node_id: nodeId('IssueComment', c.id),
    body: c.body,
    user: userJson(),
    created_at: c.created_at,
    updated_at: c.created_at,
  };
}

export function pullJson(repo: RepoRec, pr: PullRec) {
  const id = repo.id * 100000 + pr.number;
  const headRef = pr.head_ref || pr.head || '';
  const baseRef = pr.base_ref || pr.base || '';
  return {
    id,
    node_id: nodeId('PullRequest', id),
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.merged_at ?? null,
    merge_commit_sha: pr.merge_commit_sha ?? null,
    user: userJson(),
    head: {
      ref: headRef,
      sha: refOf(repo, headRef),
    },
    base: {
      ref: baseRef,
      sha: refOf(repo, baseRef),
    },
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    html_url: '',
  };
}

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

export async function handleSocial(ctx: Ctx, res: ServerResponse): Promise<boolean> {
  const segs = ctx.segments;
  if (segs.length < 5 || segs[0] !== 'api' || segs[1] !== 'v3' || segs[2] !== 'repos') {
    return false;
  }

  const owner = segs[3];
  const name = segs[4];
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  const rest = segs.slice(5);

  // ISSUES: /api/v3/repos/:owner/:name/issues
  if (rest.length >= 1 && rest[0] === 'issues') {
    // GET /issues
    if (rest.length === 1 && ctx.method === 'GET') {
      const stateParam = ctx.query.get('state') || 'open';
      const direction = ctx.query.get('direction') || 'desc';
      const page = Math.max(1, parseInt(ctx.query.get('page') || '1', 10));
      const perPage = Math.max(1, parseInt(ctx.query.get('per_page') || '30', 10));

      let filtered = repo.issues;
      if (stateParam === 'open') {
        filtered = filtered.filter((i) => i.state === 'open');
      } else if (stateParam === 'closed') {
        filtered = filtered.filter((i) => i.state === 'closed');
      }

      const sorted = [...filtered].sort((a, b) => {
        return direction === 'asc' ? a.number - b.number : b.number - a.number;
      });
      const start = (page - 1) * perPage;
      const slice = sorted.slice(start, start + perPage);
      sendJson(
        res,
        200,
        slice.map((i) => issueJson(repo, i))
      );
      return true;
    }

    // POST /issues
    if (rest.length === 1 && ctx.method === 'POST') {
      const body = ctx.json() as { title?: string; body?: string; labels?: string[] };
      const title = body?.title;
      if (!title || typeof title !== 'string' || title.length === 0) {
        throw new HttpError(422, 'Title is missing');
      }
      const labels = body.labels ?? [];
      if (!Array.isArray(labels)) {
        throw new HttpError(422, 'Labels must be an array');
      }
      for (const labelName of labels) {
        if (!repo.labels.some((l) => l.name === labelName)) {
          throw new HttpError(422, `Label '${labelName}' not found`);
        }
      }

      const number = repo.next_number++;
      const id = repo.id * 100000 + number;
      const issue: IssueRec = {
        id,
        number,
        title,
        body: body.body ?? null,
        state: 'open',
        labels,
        comments: [],
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      repo.issues.push(issue);
      repo.updated_at = nowIso();
      sendJson(res, 201, issueJson(repo, issue));
      return true;
    }

    if (rest.length === 2) {
      const n = parseInt(rest[1], 10);
      if (isNaN(n)) return false;
      const issue = repo.issues.find((i) => i.number === n);
      if (!issue) {
        throw new HttpError(404, 'Not Found');
      }

      // GET /issues/:n
      if (ctx.method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }

      // PATCH /issues/:n
      if (ctx.method === 'PATCH') {
        const body = ctx.json() as { title?: string; body?: string; state?: 'open' | 'closed'; labels?: string[] };
        if (body?.title !== undefined) {
          if (typeof body.title !== 'string') throw new HttpError(422, 'Invalid title');
          issue.title = body.title;
        }
        if (body?.body !== undefined) {
          issue.body = body.body ?? null;
        }
        if (body?.state !== undefined) {
          if (body.state !== 'open' && body.state !== 'closed') {
            throw new HttpError(422, 'Invalid state');
          }
          issue.state = body.state;
        }
        if (body?.labels !== undefined) {
          if (!Array.isArray(body.labels)) throw new HttpError(422, 'Labels must be an array');
          for (const labelName of body.labels) {
            if (!repo.labels.some((l) => l.name === labelName)) {
              throw new HttpError(422, `Label '${labelName}' not found`);
            }
          }
          issue.labels = body.labels;
        }
        issue.updated_at = nowIso();
        repo.updated_at = nowIso();
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
    }

    // COMMENTS: /issues/:n/comments
    if (rest.length === 3 && rest[2] === 'comments') {
      const n = parseInt(rest[1], 10);
      if (isNaN(n)) return false;
      const issue = repo.issues.find((i) => i.number === n);
      if (!issue) {
        throw new HttpError(404, 'Not Found');
      }

      // GET /issues/:n/comments
      if (ctx.method === 'GET') {
        sendJson(
          res,
          200,
          issue.comments.map((c) => commentJson(repo, issue, c))
        );
        return true;
      }

      // POST /issues/:n/comments
      if (ctx.method === 'POST') {
        const body = ctx.json() as { body?: string };
        const commentBody = body?.body;
        if (!commentBody || typeof commentBody !== 'string' || commentBody.length === 0) {
          throw new HttpError(422, 'Body is missing');
        }
        const commentId = repo.id * 1000000 + issue.number * 1000 + (issue.comments.length + 1);
        const c = { id: commentId, body: commentBody, created_at: nowIso() };
        issue.comments.push(c);
        issue.updated_at = nowIso();
        repo.updated_at = nowIso();
        sendJson(res, 201, commentJson(repo, issue, c));
        return true;
      }
    }
  }

  // PULLS: /api/v3/repos/:owner/:name/pulls
  if (rest.length >= 1 && rest[0] === 'pulls') {
    // GET /pulls
    if (rest.length === 1 && ctx.method === 'GET') {
      const stateParam = ctx.query.get('state') || 'open';
      const page = Math.max(1, parseInt(ctx.query.get('page') || '1', 10));
      const perPage = Math.max(1, parseInt(ctx.query.get('per_page') || '30', 10));

      let filtered = repo.pulls;
      if (stateParam === 'open') {
        filtered = filtered.filter((p) => p.state === 'open');
      } else if (stateParam === 'closed') {
        filtered = filtered.filter((p) => p.state === 'closed');
      }

      const sorted = [...filtered].sort((a, b) => b.number - a.number);
      const start = (page - 1) * perPage;
      const slice = sorted.slice(start, start + perPage);
      sendJson(
        res,
        200,
        slice.map((p) => pullJson(repo, p))
      );
      return true;
    }

    // POST /pulls
    if (rest.length === 1 && ctx.method === 'POST') {
      const body = ctx.json() as { title?: string; body?: string; head?: string; base?: string };
      const title = body?.title;
      const head = body?.head;
      const base = body?.base;
      if (!title || typeof title !== 'string' || !head || typeof head !== 'string' || !base || typeof base !== 'string') {
        throw new HttpError(422, 'Missing title, head, or base');
      }
      if (!refOf(repo, head) || !refOf(repo, base)) {
        throw new HttpError(422, 'Head or base branch does not exist');
      }

      const number = repo.next_number++;
      const id = repo.id * 100000 + number;
      const head_sha = refOf(repo, head)!;
      const base_sha = refOf(repo, base)!;
      const pr: PullRec = {
        id,
        number,
        title,
        body: body.body ?? null,
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
        merge_commit_sha: null,
      };
      repo.pulls.push(pr);
      repo.updated_at = nowIso();
      sendJson(res, 201, pullJson(repo, pr));
      return true;
    }

    if (rest.length === 2) {
      const n = parseInt(rest[1], 10);
      if (isNaN(n)) return false;
      const pr = repo.pulls.find((p) => p.number === n);
      if (!pr) {
        throw new HttpError(404, 'Not Found');
      }

      // GET /pulls/:n
      if (ctx.method === 'GET') {
        sendJson(res, 200, pullJson(repo, pr));
        return true;
      }
    }

    if (rest.length === 3 && rest[2] === 'files') {
      const n = parseInt(rest[1], 10);
      if (isNaN(n)) return false;
      const pr = repo.pulls.find((p) => p.number === n);
      if (!pr) {
        throw new HttpError(404, 'Not Found');
      }

      // GET /pulls/:n/files
      if (ctx.method === 'GET') {
        const headRef = pr.head_ref || pr.head || '';
        const baseRef = pr.base_ref || pr.base || '';
        const baseTreeSha = tipTree(repo, baseRef) || EMPTY_TREE_SHA;
        const headTreeSha = tipTree(repo, headRef) || EMPTY_TREE_SHA;

        const baseFiles = new Map(flattenTree(repo, baseTreeSha).map((f) => [f.path, f]));
        const headFiles = new Map(flattenTree(repo, headTreeSha).map((f) => [f.path, f]));

        const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
        const files: any[] = [];

        const linesOf = (sha: string | undefined): string[] => {
          if (!sha) return [];
          const obj = getObject(repo, sha);
          if (!obj || obj.type !== 'blob') return [];
          const text = obj.data.toString('utf8');
          if (text === '') return [];
          const parts = text.split('\n');
          if (parts[parts.length - 1] === '') parts.pop();
          return parts;
        };
        const lcsLen = (a: string[], b: string[]): number => {
          const dp = new Array(b.length + 1).fill(0);
          for (let i = 1; i <= a.length; i++) {
            let prev = 0;
            for (let j = 1; j <= b.length; j++) {
              const t = dp[j];
              dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
              prev = t;
            }
          }
          return dp[b.length];
        };

        for (const path of paths) {
          const b = baseFiles.get(path);
          const h = headFiles.get(path);
          if (!b && h) {
            const adds = linesOf(h.sha).length;
            files.push({ filename: path, status: 'added', sha: h.sha, additions: adds, deletions: 0, changes: adds });
          } else if (b && !h) {
            const dels = linesOf(b.sha).length;
            files.push({ filename: path, status: 'removed', sha: null, additions: 0, deletions: dels, changes: dels });
          } else if (b && h && b.sha !== h.sha) {
            const bl = linesOf(b.sha); const hl = linesOf(h.sha);
            const common = lcsLen(bl, hl);
            const adds = hl.length - common; const dels = bl.length - common;
            files.push({ filename: path, status: 'modified', sha: h.sha, additions: adds, deletions: dels, changes: adds + dels });
          }
        }

        files.sort((x, y) => x.filename.localeCompare(y.filename));
        sendJson(res, 200, files);
        return true;
      }
    }

    if (rest.length === 3 && rest[2] === 'merge') {
      const n = parseInt(rest[1], 10);
      if (isNaN(n)) return false;
      const pr = repo.pulls.find((p) => p.number === n);
      if (!pr) {
        throw new HttpError(404, 'Not Found');
      }

      // PUT /pulls/:n/merge
      if (ctx.method === 'PUT') {
        if (pr.state !== 'open' || pr.merged) {
          throw new HttpError(405, 'Pull Request is not mergeable');
        }

        const headRef = pr.head_ref || pr.head || '';
        const baseRef = pr.base_ref || pr.base || '';
        const baseTipSha = refOf(repo, baseRef);
        const headTipSha = refOf(repo, headRef);

        if (!baseTipSha || !headTipSha) {
          throw new HttpError(422, 'Base or head ref not found');
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
              throw new HttpError(405, 'Merge conflict');
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
        pr.merge_commit_sha = commitSha;
        repo.updated_at = nowIso();

        sendJson(res, 200, {
          sha: commitSha,
          merged: true,
          message: 'Pull Request successfully merged',
        });
        return true;
      }
    }
  }

  return false;
}
