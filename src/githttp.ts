import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, getObject, putObject, type RepoRec } from './store.ts';
import { parseCommit, parseTree, treeOfCommit, flattenTree, parsePack, buildPack } from './gitobj.ts';
import { type Ctx, HttpError } from './http.ts';

/**
 * Encodes a payload into a git packet line with a 4-hex-digit length prefix.
 * An empty payload (string or Buffer of length 0) returns a flush packet '0000'.
 */
export function pktLine(payload: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = buf.length + 4;
  if (len === 4) {
    return Buffer.from('0000', 'ascii');
  }
  const hex = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(hex, 'ascii'), buf]);
}

/**
 * Returns a git flush packet '0000'.
 */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/**
 * Returns a git delim packet '0001'.
 */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/**
 * Parses consecutive pkt-lines until a flush or end, returning payloads (without the 4-byte prefix)
 * and the offset after the last consumed line (pointing past the flush when read).
 */
export function readPktLines(buf: Buffer, offset = 0): { lines: Buffer[]; offset: number } {
  const lines: Buffer[] = [];
  let pos = offset;
  while (pos + 4 <= buf.length) {
    const lenHex = buf.toString('ascii', pos, pos + 4);
    const len = parseInt(lenHex, 16);
    if (isNaN(len)) {
      break;
    }
    if (len === 0) {
      pos += 4;
      break;
    }
    if (pos + len > buf.length) {
      break;
    }
    const payload = buf.subarray(pos + 4, pos + len);
    lines.push(payload);
    pos += len;
  }
  return { lines, offset: pos };
}

function readV2Packets(buf: Buffer): { sections: Buffer[][] } {
  const sections: Buffer[][] = [];
  let currentSection: Buffer[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const lenHex = buf.toString('ascii', pos, pos + 4);
    const len = parseInt(lenHex, 16);
    if (isNaN(len)) break;
    if (len === 0) {
      pos += 4;
      break;
    }
    if (len === 1) {
      pos += 4;
      sections.push(currentSection);
      currentSection = [];
      continue;
    }
    if (pos + len > buf.length) break;
    const payload = buf.subarray(pos + 4, pos + len);
    currentSection.push(payload);
    pos += len;
  }
  if (currentSection.length > 0) {
    sections.push(currentSection);
  }
  return { sections };
}

function isAncestor(repo: RepoRec, ancestorSha: string, commitSha: string): boolean {
  if (ancestorSha === commitSha) return true;
  const visited = new Set<string>();
  const queue = [commitSha];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr === ancestorSha) return true;
    if (visited.has(curr)) continue;
    visited.add(curr);
    const obj = getObject(repo, curr);
    if (obj && obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      for (const p of commit.parents) {
        queue.push(p);
      }
    }
  }
  return false;
}

function collectUploadPackObjects(
  repo: RepoRec,
  wants: Set<string>,
  haves: Set<string>,
  opts?: { depth?: number | null; clientShallow?: Set<string> }
): { objects: { type: string; data: Buffer }[]; shallow: string[]; unshallow: string[] } {
  const depthLimit = opts?.depth ?? null;
  const clientShallow = opts?.clientShallow ?? new Set<string>();

  function tagTarget(data: Buffer): string | null {
    const firstLine = data.toString('utf8').split('\n', 1)[0];
    if (firstLine && firstLine.startsWith('object ')) return firstLine.slice(7).trim();
    return null;
  }

  // Full closure of the haves: everything the client already holds.
  const haveClosure = new Set<string>();
  function walkHave(sha: string) {
    if (haveClosure.has(sha)) return;
    const obj = getObject(repo, sha);
    if (!obj) return;
    haveClosure.add(sha);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree) walkHave(c.tree);
      if (!clientShallow.has(sha)) {
        for (const p of c.parents) walkHave(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) walkHave(e.sha);
    } else if (obj.type === 'tag') {
      const t = tagTarget(obj.data);
      if (t) walkHave(t);
    }
  }
  for (const h of haves) walkHave(h);

  // Assign depths: BFS from the wants (tags resolve to their target commit at depth 1).
  const commitDepth = new Map<string, number>();
  const extraObjects = new Set<string>(); // tag objects named directly by wants
  const queue: { sha: string; depth: number }[] = [];
  function seedWant(sha: string) {
    const obj = getObject(repo, sha);
    if (!obj) return;
    if (obj.type === 'tag') {
      extraObjects.add(sha);
      const t = tagTarget(obj.data);
      if (t) seedWant(t);
    } else if (obj.type === 'commit') {
      queue.push({ sha, depth: 1 });
    } else {
      extraObjects.add(sha);
    }
  }
  for (const w of wants) seedWant(w);
  while (queue.length) {
    const { sha, depth } = queue.shift()!;
    const prev = commitDepth.get(sha);
    if (prev !== undefined && prev <= depth) continue;
    commitDepth.set(sha, depth);
    if (depthLimit !== null && depth >= depthLimit) continue;
    const obj = getObject(repo, sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push({ sha: p, depth: depth + 1 });
  }

  // Boundary: included commits at the depth limit that still have parents in the store.
  const boundary = new Set<string>();
  if (depthLimit !== null) {
    for (const [sha, depth] of commitDepth) {
      if (depth !== depthLimit) continue;
      const obj = getObject(repo, sha);
      if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) boundary.add(sha);
    }
  }

  // Collect the object set: included commits + their trees/blobs + wanted tag/tree extras, minus haveClosure.
  const objectShas = new Set<string>();
  const visitedTrees = new Set<string>();
  function collectTree(treeSha: string) {
    if (visitedTrees.has(treeSha)) return;
    visitedTrees.add(treeSha);
    const obj = getObject(repo, treeSha);
    if (!obj || obj.type !== 'tree') return;
    objectShas.add(treeSha);
    for (const e of parseTree(obj.data)) {
      objectShas.add(e.sha);
      if (e.mode === '40000' || e.mode === '040000' || e.mode.startsWith('4')) collectTree(e.sha);
    }
  }
  for (const sha of commitDepth.keys()) {
    objectShas.add(sha);
    const obj = getObject(repo, sha);
    if (obj && obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree) collectTree(c.tree);
    }
  }
  for (const sha of extraObjects) {
    objectShas.add(sha);
    const obj = getObject(repo, sha);
    if (obj && obj.type === 'tree') collectTree(sha);
  }
  for (const sha of haveClosure) objectShas.delete(sha);

  const shallow: string[] = [...boundary].filter((s) => !haveClosure.has(s));
  const unshallow: string[] = [...clientShallow].filter((s) => commitDepth.has(s) && !boundary.has(s));

  const objects: { type: string; data: Buffer }[] = [];
  for (const sha of objectShas) {
    const obj = getObject(repo, sha);
    if (obj) objects.push({ type: obj.type, data: obj.data });
  }
  return { objects, shallow, unshallow };
}

/**
 * Handles Git Smart HTTP requests for repositories.
 */
export async function handleGitHttp(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const segments = ctx.segments;
  if (segments.length < 3) return false;

  const owner = segments[0];
  const rawName = segments[1];
  const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName;

  const repo = store.getRepo(owner, name);
  if (!repo) return false;

  const servicePath = segments.slice(2).join('/');

  // GET /info/refs?service=...
  if (ctx.method === 'GET' && servicePath === 'info/refs') {
    const service = ctx.query.get('service');
    if (!service || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
      return false;
    }

    const bufs: Buffer[] = [];
    bufs.push(pktLine(`# service=${service}\n`));
    bufs.push(pktFlush());

    if (service === 'git-upload-pack') {
      const gitProtocol = req.headers['git-protocol'];
      const isV2 = typeof gitProtocol === 'string' && gitProtocol.includes('version=2');

      if (isV2) {
        bufs.push(pktLine('version 2\n'));
        bufs.push(pktLine('agent=forge\n'));
        bufs.push(pktLine('ls-refs=unborn\n'));
        bufs.push(pktLine('fetch=shallow wait-for-done\n'));
        bufs.push(pktLine('object-format=sha1\n'));
        bufs.push(pktFlush());
      } else {
        const defaultRef = `refs/heads/${repo.default_branch}`;
        const headSha = repo.refs.get(defaultRef) || repo.refs.get('HEAD') || '0000000000000000000000000000000000000000';
        const hasCommits = headSha !== '0000000000000000000000000000000000000000' && repo.objects.has(headSha);
        const advertHeadSha = hasCommits ? headSha : '0000000000000000000000000000000000000000';

        let caps = 'multi_ack thin-pack side-band side-band-64k ofs-delta deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed object-format=sha1 agent=forge';
        if (!hasCommits) caps += ' unborn';
        caps += ' symref=HEAD:' + defaultRef;

        bufs.push(pktLine(`${advertHeadSha} HEAD\0${caps}\n`));

        const sortedRefs = [...repo.refs.entries()]
          .filter(([refname]) => refname !== 'HEAD')
          .sort((a, b) => a[0].localeCompare(b[0]));

        function tagTarget(data: Buffer): string | null {
          const firstLine = data.toString('utf8').split('\n', 1)[0];
          if (firstLine && firstLine.startsWith('object ')) return firstLine.slice(7).trim();
          return null;
        }
        function peelTag(sha: string): string {
          let curr = sha;
          while (true) {
            const obj = getObject(repo, curr);
            if (!obj || obj.type !== 'tag') break;
            const t = tagTarget(obj.data);
            if (!t) break;
            curr = t;
          }
          return curr;
        }

        for (const [refname, sha] of sortedRefs) {
          bufs.push(pktLine(`${sha} ${refname}\n`));
          if (refname.startsWith('refs/tags/')) {
            const peeled = peelTag(sha);
            if (peeled !== sha) {
              bufs.push(pktLine(`${peeled} ${refname}^{}\n`));
            }
          }
        }
        bufs.push(pktFlush());
      }
    } else if (service === 'git-receive-pack') {
      const defaultRef = `refs/heads/${repo.default_branch}`;
      const headSha = repo.refs.get(defaultRef) || repo.refs.get('HEAD') || '0000000000000000000000000000000000000000';
      const hasCommits = headSha !== '0000000000000000000000000000000000000000' && repo.objects.has(headSha);
      const advertHeadSha = hasCommits ? headSha : '0000000000000000000000000000000000000000';
      const recCaps = 'report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta object-format=sha1 agent=forge push-options symref=HEAD:' + defaultRef;

      const sortedRefs = [...repo.refs.entries()]
        .filter(([refname]) => refname !== 'HEAD')
        .sort((a, b) => a[0].localeCompare(b[0]));

      if (sortedRefs.length > 0) {
        const [firstRef, firstSha] = sortedRefs[0];
        bufs.push(pktLine(`${firstSha} ${firstRef}\0${recCaps}\n`));
        for (let i = 1; i < sortedRefs.length; i++) {
          bufs.push(pktLine(`${sortedRefs[i][1]} ${sortedRefs[i][0]}\n`));
        }
      } else {
        bufs.push(pktLine(`${advertHeadSha} HEAD\0${recCaps}\n`));
      }
      bufs.push(pktFlush());
    }

    res.writeHead(200, {
      'content-type': `application/x-${service}-advertisement`,
      'cache-control': 'no-cache',
    });
    res.end(Buffer.concat(bufs));
    return true;
  }

  // POST /git-upload-pack
  if (ctx.method === 'POST' && servicePath === 'git-upload-pack') {
    const gitProtocol = req.headers['git-protocol'];
    const isV2 = typeof gitProtocol === 'string' && gitProtocol.includes('version=2');

    if (isV2) {
      const { sections } = readV2Packets(ctx.body);
      const cmdSection = sections[0] || [];
      const argSection = sections[1] || [];

      let command = '';
      for (const line of cmdSection) {
        const text = line.toString('utf8').trim();
        if (text.startsWith('command=')) {
          command = text.slice(8).trim();
        }
      }

      if (command === 'ls-refs') {
        const refPrefixes: string[] = [];
        let symrefs = false;
        let peel = false;
        for (const line of argSection) {
          const text = line.toString('utf8').trim();
          if (text.startsWith('ref-prefix ')) {
            refPrefixes.push(text.slice(11).trim());
          } else if (text === 'symrefs') {
            symrefs = true;
          } else if (text === 'peel') {
            peel = true;
          }
        }

        const bufs: Buffer[] = [];
        const defaultRef = `refs/heads/${repo.default_branch}`;
        const headSha = repo.refs.get(defaultRef) ?? '0000000000000000000000000000000000000000';
        if (refPrefixes.length === 0 || refPrefixes.some((p) => 'HEAD'.startsWith(p))) {
          let headLine = `${headSha} HEAD`;
          if (symrefs) headLine += ` symref-target:${defaultRef}`;
          bufs.push(pktLine(`${headLine}\n`));
        }

        for (const [refname, sha] of repo.refs.entries()) {
          if (refPrefixes.length > 0 && !refPrefixes.some((p) => refname.startsWith(p))) {
            continue;
          }
          let line = `${sha} ${refname}`;
          if (symrefs && (refname === 'HEAD' || refname === defaultRef)) {
            line += ` symref-target:${defaultRef}`;
          }
          if (peel && refname.startsWith('refs/tags/')) {
            let finalSha = sha;
            while (true) {
              const obj = getObject(repo, finalSha);
              if (!obj || obj.type !== 'tag') break;
              const firstLine = obj.data.toString('utf8').split('\n', 1)[0];
              if (!firstLine || !firstLine.startsWith('object ')) break;
              const nextSha = firstLine.slice(7).trim();
              if (!nextSha) break;
              finalSha = nextSha;
            }
            if (finalSha !== sha) {
              line += ` peeled:${finalSha}`;
            }
          }
          bufs.push(pktLine(`${line}\n`));
        }
        bufs.push(pktFlush());

        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
        res.end(Buffer.concat(bufs));
        return true;
      } else if (command === 'fetch') {
        const wants = new Set<string>();
        const haves = new Set<string>();
        const clientShallow = new Set<string>();
        let depth: number | null = null;
        let done = false;

        for (const line of argSection) {
          const text = line.toString('utf8').trim();
          if (text.startsWith('want ')) {
            const sha = text.slice(5).trim().split(' ')[0];
            if (sha) wants.add(sha);
          } else if (text.startsWith('have ')) {
            const sha = text.slice(5).trim().split(' ')[0];
            if (sha) haves.add(sha);
          } else if (text.startsWith('deepen ')) {
            const n = parseInt(text.slice(7).trim(), 10);
            if (!isNaN(n)) depth = n;
          } else if (text.startsWith('shallow ')) {
            const sha = text.slice(8).trim().split(' ')[0];
            if (sha) clientShallow.add(sha);
          } else if (text === 'done') {
            done = true;
          }
        }

        const fetchResult = collectUploadPackObjects(repo, wants, haves, { depth, clientShallow });
        const packBuf = buildPack(fetchResult.objects);

        const resBufs: Buffer[] = [];
        if (haves.size > 0 && !done) {
          resBufs.push(pktLine('acknowledgments\n'));
          for (const h of haves) {
            resBufs.push(pktLine(`ack ${h}\n`));
          }
          resBufs.push(pktLine('ready\n'));
          resBufs.push(pktFlush());
        }

        if (fetchResult.shallow.length > 0 || fetchResult.unshallow.length > 0) {
          resBufs.push(pktLine('shallow-info\n'));
          for (const sha of fetchResult.shallow) {
            resBufs.push(pktLine(`shallow ${sha}\n`));
          }
          for (const sha of fetchResult.unshallow) {
            resBufs.push(pktLine(`unshallow ${sha}\n`));
          }
          resBufs.push(pktDelim());
        }

        resBufs.push(pktLine('packfile\n'));
        const chunkSize = 65515;
        for (let i = 0; i < packBuf.length; i += chunkSize) {
          const chunk = packBuf.subarray(i, i + chunkSize);
          const payload = Buffer.concat([Buffer.from([0x01]), chunk]);
          resBufs.push(pktLine(payload));
        }
        resBufs.push(pktFlush());

        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
        res.end(Buffer.concat(resBufs));
        return true;
      }
    } else {
      // v0/v1 upload-pack
      const { lines } = readPktLines(ctx.body, 0);
      const wants = new Set<string>();
      const haves = new Set<string>();

      for (const lineBuf of lines) {
        const text = lineBuf.toString('utf8').trim();
        if (text.startsWith('want ')) {
          const sha = text.slice(5).trim().split(' ')[0];
          if (sha) wants.add(sha);
        } else if (text.startsWith('have ')) {
          const sha = text.slice(5).trim().split(' ')[0];
          if (sha) haves.add(sha);
        }
      }

      const objects = collectUploadPackObjects(repo, wants, haves).objects;
      const packBuf = buildPack(objects);

      const responseBufs: Buffer[] = [];
      responseBufs.push(pktLine('NAK\n'));

      const chunkSize = 65515;
      for (let i = 0; i < packBuf.length; i += chunkSize) {
        const chunk = packBuf.subarray(i, i + chunkSize);
        const payload = Buffer.concat([Buffer.from([0x01]), chunk]);
        responseBufs.push(pktLine(payload));
      }
      responseBufs.push(pktFlush());

      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
      res.end(Buffer.concat(responseBufs));
      return true;
    }
  }

  // POST /git-receive-pack
  if (ctx.method === 'POST' && servicePath === 'git-receive-pack') {
    const { lines, offset } = readPktLines(ctx.body, 0);
    const packBytes = ctx.body.subarray(offset);

    const commands: { oldSha: string; newSha: string; refname: string }[] = [];
    let capabilities: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      let lineStr = lines[i].toString('utf8').trim();
      if (i === 0) {
        const nulIdx = lineStr.indexOf('\0');
        if (nulIdx !== -1) {
          const capsStr = lineStr.slice(nulIdx + 1);
          capabilities = capsStr.split(' ');
          lineStr = lineStr.slice(0, nulIdx);
        }
      }
      const parts = lineStr.split(' ');
      if (parts.length >= 3) {
        commands.push({
          oldSha: parts[0],
          newSha: parts[1],
          refname: parts.slice(2).join(' '),
        });
      }
    }

    if (packBytes.length > 12) {
      try {
        parsePack(repo, packBytes);
      } catch {}
    }

    const zeroSha = '0000000000000000000000000000000000000000';
    const refStatuses: string[] = [];

    for (const cmd of commands) {
      const { oldSha, newSha, refname } = cmd;
      if (newSha === zeroSha) {
        repo.refs.delete(refname);
        refStatuses.push(`ok ${refname}`);
      } else if (oldSha === zeroSha) {
        repo.refs.set(refname, newSha);
        refStatuses.push(`ok ${refname}`);
      } else {
        const isFf = isAncestor(repo, oldSha, newSha);
        if (isFf) {
          repo.refs.set(refname, newSha);
          refStatuses.push(`ok ${refname}`);
        } else {
          refStatuses.push(`ng ${refname} non-fast-forward`);
        }
      }
    }

    const reportStatus = capabilities.includes('report-status') || capabilities.includes('report-status-v2');
    const hasSideBand = capabilities.includes('side-band-64k') || capabilities.includes('side-band');

    const responseBufs: Buffer[] = [];
    if (reportStatus) {
      const innerLines: Buffer[] = [];
      innerLines.push(pktLine('unpack ok\n'));
      for (const st of refStatuses) {
        innerLines.push(pktLine(`${st}\n`));
      }
      innerLines.push(pktFlush());
      const innerBytes = Buffer.concat(innerLines);

      if (hasSideBand) {
        const chunkSize = 65516;
        for (let i = 0; i < innerBytes.length; i += chunkSize) {
          const chunk = innerBytes.subarray(i, i + chunkSize);
          const payload = Buffer.concat([Buffer.from([0x01]), chunk]);
          responseBufs.push(pktLine(payload));
        }
        responseBufs.push(pktFlush());
      } else {
        responseBufs.push(innerBytes);
      }
    }

    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
    res.end(Buffer.concat(responseBufs));
    return true;
  }

  return false;
}
