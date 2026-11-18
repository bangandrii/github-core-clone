import type { ServerResponse } from 'node:http';
import { store, putObject, getObject, nodeId, nowIso, type RepoRec } from './store.ts';
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
import { VIEWER, USERS } from './scenario.ts';
import { type Ctx, HttpError, sendJson } from './http.ts';

export function userJson(u = VIEWER) {
  return {
    login: u.login,
    id: u.id,
    node_id: nodeId('User', u.id),
    name: u.name,
    email: u.email,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: RepoRec) {
  const ownerUser = USERS.find((u) => u.login === repo.owner) ?? {
    id: 1000,
    login: repo.owner,
    name: repo.owner,
    email: `${repo.owner}@example.invalid`,
  };
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private === true,
    owner: userJson(ownerUser),
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    html_url: '',
    fork: false,
  };
}

export function refOf(repo: RepoRec, branch: string): string | null {
  if (!branch) return null;
  if (repo.refs.has(branch)) {
    return repo.refs.get(branch)!;
  }
  const fullRef = `refs/heads/${branch}`;
  if (repo.refs.has(fullRef)) {
    return repo.refs.get(fullRef)!;
  }
  return null;
}

export function tipTree(repo: RepoRec, ref?: string | null): string | null {
  const target = ref || repo.default_branch;
  const obj = getObject(repo, target);
  if (obj && obj.type === 'commit') {
    return treeOfCommit(repo, target);
  }
  const sha = refOf(repo, target);
  if (!sha) return null;
  return treeOfCommit(repo, sha);
}

function parseIdentLine(line: string): { name: string; email: string; date: string } {
  const match = line.match(/^(.*?)\s+<([^>]+)>\s+(\d+)\s+([+-]\d{4})$/);
  if (!match) {
    return { name: line, email: '', date: new Date().toISOString() };
  }
  const [, name, email, tsStr] = match;
  const ts = parseInt(tsStr, 10);
  const date = new Date(ts * 1000).toISOString();
  return { name, email, date };
}

export async function handleRest(ctx: Ctx, res: ServerResponse): Promise<boolean> {
  const segs = ctx.segments;
  if (segs.length < 2 || segs[0] !== 'api' || segs[1] !== 'v3') {
    return false;
  }

  // GET meta
  if (ctx.method === 'GET' && segs.length === 3 && segs[2] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // GET user
  if (ctx.method === 'GET' && segs.length === 3 && segs[2] === 'user') {
    sendJson(res, 200, userJson());
    return true;
  }

  // user/repos
  if (segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos') {
    if (ctx.method === 'GET') {
      const page = Math.max(1, parseInt(ctx.query.get('page') || '1', 10));
      const perPage = Math.max(1, parseInt(ctx.query.get('per_page') || '30', 10));
      const allRepos = store.listRepos(VIEWER.login);
      const total = allRepos.length;
      const lastPage = Math.max(1, Math.ceil(total / perPage));
      const start = (page - 1) * perPage;
      const slice = allRepos.slice(start, start + perPage);
      const pageList = slice.map(repoJson);

      const headers: Record<string, string> = {};
      if (page < lastPage) {
        const nextUrl = `http://${ctx.host}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}`;
        const lastUrl = `http://${ctx.host}/api/v3/user/repos?page=${lastPage}&per_page=${perPage}`;
        headers['link'] = `<${nextUrl}>; rel="next", <${lastUrl}>; rel="last"`;
      }
      sendJson(res, 200, pageList, headers);
      return true;
    }

    if (ctx.method === 'POST') {
      const body = ctx.json() as { name?: string; description?: string; private?: boolean };
      const name = body?.name;
      if (!name || typeof name !== 'string' || name.length === 0) {
        throw new HttpError(422, 'Repository name is missing');
      }
      if (store.getRepo(VIEWER.login, name)) {
        throw new HttpError(422, 'Repository already exists');
      }
      const repo = store.createRepo(VIEWER.login, name, body.description ?? null, !!body.private);
      sendJson(res, 201, repoJson(repo));
      return true;
    }
  }

  // repos/:owner/:name/...
  if (segs.length >= 5 && segs[2] === 'repos') {
    const owner = segs[3];
    const name = segs[4];
    const repo = store.getRepo(owner, name);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    const rest = segs.slice(5);

    // GET / PATCH / DELETE repos/:owner/:name
    if (rest.length === 0) {
      if (ctx.method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (ctx.method === 'PATCH') {
        const body = ctx.json() as { name?: string; description?: string };
        if (body?.description !== undefined) {
          repo.description = body.description ?? null;
        }
        if (body?.name !== undefined && body.name !== repo.name) {
          const newName = body.name;
          if (store.getRepo(owner, newName)) {
            throw new HttpError(422, 'Repository already exists');
          }
          store.deleteRepo(owner, repo.name);
          repo.name = newName;
          store.repos.set(`${owner}/${newName}`, repo);
        }
        repo.updated_at = nowIso();
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (ctx.method === 'DELETE') {
        store.deleteRepo(owner, name);
        res.writeHead(204);
        res.end();
        return true;
      }
    }

    // POST repos/:owner/:name/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (ctx.method === 'POST') {
        const body = ctx.json() as { ref?: string; sha?: string };
        const ref = body?.ref;
        const sha = body?.sha;
        if (!ref || !sha) {
          throw new HttpError(422, 'Missing ref or sha');
        }
        const obj = getObject(repo, sha);
        if (!obj || obj.type !== 'commit') {
          throw new HttpError(422, 'sha is not a stored commit');
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, {
          ref,
          node_id: nodeId('Ref', repo.id),
          object: { sha, type: 'commit' },
        });
        return true;
      }
    }

    // GET repos/:owner/:name/branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (ctx.method === 'GET') {
        const branches: { name: string; commit: { sha: string }; protected: boolean }[] = [];
        for (const [refKey, sha] of repo.refs.entries()) {
          if (refKey.startsWith('refs/heads/')) {
            const bName = refKey.slice(11);
            branches.push({
              name: bName,
              commit: { sha },
              protected: false,
            });
          }
        }
        branches.sort((a, b) => a.name.localeCompare(b.name));
        sendJson(res, 200, branches);
        return true;
      }
    }

    // GET repos/:owner/:name/commits
    if (rest.length === 1 && rest[0] === 'commits') {
      if (ctx.method === 'GET') {
        const shaParam = ctx.query.get('sha');
        let currentSha = shaParam ? (refOf(repo, shaParam) || shaParam) : refOf(repo, repo.default_branch);

        const commitsList: any[] = [];
        const visited = new Set<string>();

        while (currentSha && commitsList.length < 100 && !visited.has(currentSha)) {
          visited.add(currentSha);
          const obj = getObject(repo, currentSha);
          if (!obj || obj.type !== 'commit') break;
          const commit = parseCommit(obj.data);
          const authorInfo = parseIdentLine(commit.author);
          const committerInfo = parseIdentLine(commit.committer);

          commitsList.push({
            sha: currentSha,
            node_id: nodeId('Commit', repo.id),
            commit: {
              message: commit.message,
              author: authorInfo,
              committer: committerInfo,
              tree: { sha: commit.tree },
            },
            parents: commit.parents.map((pSha) => ({ sha: pSha })),
          });

          currentSha = commit.parents[0];
        }

        sendJson(res, 200, commitsList);
        return true;
      }
    }

    // Contents routes: /contents/...
    if (rest.length >= 1 && rest[0] === 'contents') {
      const pathSegments = rest.slice(1);
      const pathStr = pathSegments.join('/');

      if (ctx.method === 'GET') {
        const refParam = ctx.query.get('ref');
        const treeSha = tipTree(repo, refParam);
        if (!treeSha) {
          throw new HttpError(404, 'Ref or tree not found');
        }

        if (pathStr === '') {
          // Root listing
          const obj = getObject(repo, treeSha);
          if (!obj || obj.type !== 'tree') {
            throw new HttpError(404, 'Not found');
          }
          const entries = parseTree(obj.data);
          entries.sort((a, b) => a.name.localeCompare(b.name));

          const result = entries.map((e) => {
            const isDir = e.mode === '40000' || e.mode === '040000' || e.mode.startsWith('4');
            let size = 0;
            if (!isDir) {
              const childObj = getObject(repo, e.sha);
              size = childObj?.data.length ?? 0;
            }
            return {
              name: e.name,
              path: e.name,
              sha: e.sha,
              size,
              type: isDir ? 'dir' : 'file',
            };
          });
          sendJson(res, 200, result);
          return true;
        } else {
          // Specific path
          const found = readPath(repo, treeSha, pathStr);
          if (!found) {
            throw new HttpError(404, 'Path not found');
          }

          if (found.type === 'blob') {
            const blobObj = getObject(repo, found.sha);
            if (!blobObj || blobObj.type !== 'blob') {
              throw new HttpError(404, 'Blob not found');
            }
            const base64Str = blobObj.data.toString('base64');
            const wrapped = base64Str.match(/.{1,60}/g)?.join('\n') || '';
            const fileName = pathSegments[pathSegments.length - 1];

            sendJson(res, 200, {
              name: fileName,
              path: pathStr,
              sha: found.sha,
              size: blobObj.data.length,
              type: 'file',
              encoding: 'base64',
              content: wrapped,
            });
            return true;
          } else if (found.type === 'tree') {
            const treeObj = getObject(repo, found.sha);
            if (!treeObj || treeObj.type !== 'tree') {
              throw new HttpError(404, 'Tree not found');
            }
            const entries = parseTree(treeObj.data);
            entries.sort((a, b) => a.name.localeCompare(b.name));

            const result = entries.map((e) => {
              const isDir = e.mode === '40000' || e.mode === '040000' || e.mode.startsWith('4');
              let size = 0;
              if (!isDir) {
                const childObj = getObject(repo, e.sha);
                size = childObj?.data.length ?? 0;
              }
              return {
                name: e.name,
                path: `${pathStr}/${e.name}`,
                sha: e.sha,
                size,
                type: isDir ? 'dir' : 'file',
              };
            });
            sendJson(res, 200, result);
            return true;
          }
        }
      }

      if (ctx.method === 'PUT') {
        const body = ctx.json() as { message?: string; content?: string; sha?: string; branch?: string };
        const message = body?.message;
        const contentBase64 = body?.content;
        if (!message || typeof message !== 'string') {
          throw new HttpError(422, 'Missing commit message');
        }
        if (typeof contentBase64 !== 'string') {
          throw new HttpError(422, 'Missing file content');
        }

        const targetBranch = body.branch || repo.default_branch;
        const refName = targetBranch.startsWith('refs/') ? targetBranch : `refs/heads/${targetBranch}`;
        const oldCommitSha = repo.refs.get(refName);
        const oldTreeSha = oldCommitSha ? treeOfCommit(repo, oldCommitSha) : null;

        const blobBuf = Buffer.from(contentBase64, 'base64');
        const blobSha = putObject(repo, 'blob', blobBuf);

        let isUpdate = false;
        if (oldTreeSha) {
          const existing = readPath(repo, oldTreeSha, pathStr);
          if (existing) {
            if (existing.type !== 'blob') {
              throw new HttpError(409, 'Path is not a file');
            }
            if (body.sha && body.sha !== existing.sha) {
              throw new HttpError(409, 'sha does not match');
            }
            isUpdate = true;
          }
        }

        const newTreeSha = setPath(repo, oldTreeSha, pathStr, blobSha);
        const commitRec = {
          tree: newTreeSha,
          parents: oldCommitSha ? [oldCommitSha] : [],
          author: ident(VIEWER.name, VIEWER.email),
          committer: ident(VIEWER.name, VIEWER.email),
          message,
        };
        const commitBuf = encodeCommit(commitRec);
        const commitSha = putObject(repo, 'commit', commitBuf);
        repo.refs.set(refName, commitSha);
        repo.updated_at = nowIso();

        const fileName = pathSegments[pathSegments.length - 1];
        sendJson(res, isUpdate ? 200 : 201, {
          content: {
            name: fileName,
            path: pathStr,
            sha: blobSha,
            size: blobBuf.length,
            type: 'file',
            encoding: 'base64',
          },
          commit: {
            sha: commitSha,
            message,
          },
        });
        return true;
      }

      if (ctx.method === 'DELETE') {
        const body = ctx.json() as { message?: string; sha?: string; branch?: string };
        const message = body?.message;
        const expectedSha = body?.sha;
        if (!message || typeof message !== 'string') {
          throw new HttpError(422, 'Missing commit message');
        }
        if (!expectedSha) {
          throw new HttpError(422, 'Missing sha');
        }

        const targetBranch = body.branch || repo.default_branch;
        const refName = targetBranch.startsWith('refs/') ? targetBranch : `refs/heads/${targetBranch}`;
        const oldCommitSha = repo.refs.get(refName);
        const oldTreeSha = oldCommitSha ? treeOfCommit(repo, oldCommitSha) : null;
        if (!oldTreeSha) {
          throw new HttpError(404, 'File absent');
        }

        const existing = readPath(repo, oldTreeSha, pathStr);
        if (!existing || existing.type !== 'blob') {
          throw new HttpError(404, 'File absent');
        }
        if (existing.sha !== expectedSha) {
          throw new HttpError(409, 'sha does not match');
        }

        const newTreeSha = setPath(repo, oldTreeSha, pathStr, null);
        const commitRec = {
          tree: newTreeSha,
          parents: oldCommitSha ? [oldCommitSha] : [],
          author: ident(VIEWER.name, VIEWER.email),
          committer: ident(VIEWER.name, VIEWER.email),
          message,
        };
        const commitBuf = encodeCommit(commitRec);
        const commitSha = putObject(repo, 'commit', commitBuf);
        repo.refs.set(refName, commitSha);
        repo.updated_at = nowIso();

        sendJson(res, 200, {
          content: null,
          commit: {
            sha: commitSha,
          },
        });
        return true;
      }
    }

    // POST repos/:owner/:name/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (ctx.method === 'POST') {
        const body = ctx.json() as { name?: string; color?: string };
        const labelName = body?.name;
        if (!labelName || typeof labelName !== 'string') {
          throw new HttpError(422, 'Missing label name');
        }
        if (repo.labels.some((l) => l.name === labelName)) {
          throw new HttpError(422, 'Label already exists');
        }
        const color = body.color ?? 'ededed';
        repo.labels.push({ name: labelName, color });
        sendJson(res, 201, { name: labelName, color });
        return true;
      }
    }
  }

  return false;
}
