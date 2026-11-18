import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { getObject, putObject, hashObject, type RepoRec } from './store.ts';

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Ensures the well-known empty tree object exists in the repository object store.
 */
function ensureEmptyTree(repo: RepoRec): void {
  if (!repo.objects.has(EMPTY_TREE_SHA)) {
    repo.objects.set(EMPTY_TREE_SHA, { type: 'tree', data: Buffer.alloc(0) });
  }
}

/**
 * Represents an entry in a Git tree object.
 */
export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/**
 * Encodes an array of TreeEntry objects into Git's binary tree format.
 * Sorted by name (directories, mode '40000', sort as if the name ended with '/'),
 * each entry as `${mode} ${name}` + NUL + 20 raw bytes of the sha.
 */
export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aKey = a.name + (a.mode === '40000' || a.mode === '040000' || a.mode.startsWith('4') ? '/' : '');
    const bKey = b.name + (b.mode === '40000' || b.mode === '040000' || b.mode.startsWith('4') ? '/' : '');
    if (aKey < bKey) return -1;
    if (aKey > bKey) return 1;
    return 0;
  });

  const buffers: Buffer[] = [];
  for (const entry of sorted) {
    const modeName = `${entry.mode} ${entry.name}`;
    buffers.push(
      Buffer.from(modeName, 'utf8'),
      Buffer.from([0]),
      Buffer.from(entry.sha, 'hex')
    );
  }
  return Buffer.concat(buffers);
}

/**
 * Parses Git's binary tree format into an array of TreeEntry objects.
 */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const spaceIdx = data.indexOf(32, pos); // ' '
    if (spaceIdx === -1) break;
    const mode = data.toString('utf8', pos, spaceIdx);

    const nulIdx = data.indexOf(0, spaceIdx + 1); // NUL
    if (nulIdx === -1) break;
    const name = data.toString('utf8', spaceIdx + 1, nulIdx);

    const shaStart = nulIdx + 1;
    const shaEnd = shaStart + 20;
    if (shaEnd > data.length) break;
    const sha = data.toString('hex', shaStart, shaEnd);

    entries.push({ mode, name, sha });
    pos = shaEnd;
  }
  return entries;
}

/**
 * Represents a Git commit record.
 */
export interface CommitRec {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/**
 * Encodes a CommitRec into Git's binary commit object format.
 */
export function encodeCommit(c: CommitRec): Buffer {
  const lines: string[] = [];
  lines.push(`tree ${c.tree}`);
  for (const p of c.parents) {
    lines.push(`parent ${p}`);
  }
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  lines.push('');
  lines.push(c.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/**
 * Parses Git's binary commit object format into a CommitRec.
 */
export function parseCommit(data: Buffer): CommitRec {
  const text = data.toString('utf8');
  const parts = text.split('\n\n');
  const headerText = parts[0];
  const message = parts.slice(1).join('\n\n');
  const lines = headerText.split('\n');

  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';

  for (const line of lines) {
    if (line.startsWith('tree ')) {
      tree = line.slice(5).trim();
    } else if (line.startsWith('parent ')) {
      parents.push(line.slice(7).trim());
    } else if (line.startsWith('author ')) {
      author = line.slice(7);
    } else if (line.startsWith('committer ')) {
      committer = line.slice(10);
    }
  }

  return { tree, parents, author, committer, message };
}

/**
 * Generates a Git author/committer ident string.
 */
export function ident(name: string, email: string, date: Date = new Date()): string {
  return `${name} <${email}> ${Math.floor(date.getTime() / 1000)} +0000`;
}

/**
 * Returns the tree SHA of a given commit, or null if not found or invalid.
 */
export function treeOfCommit(repo: RepoRec, commitSha: string): string | null {
  const obj = getObject(repo, commitSha);
  if (!obj || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  return commit.tree || null;
}

/**
 * Walks path segments in a tree; type is 'tree' for directory (mode '40000') else 'blob'.
 */
export function readPath(repo: RepoRec, treeSha: string, path: string): { sha: string; type: string } | null {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) {
    return { sha: treeSha, type: 'tree' };
  }
  let currentSha = treeSha;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const obj = getObject(repo, currentSha);
    if (!obj || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data);
    const entry = entries.find((e) => e.name === seg);
    if (!entry) return null;
    if (i === segments.length - 1) {
      const isDir = entry.mode === '40000' || entry.mode === '040000' || entry.mode.startsWith('4');
      return { sha: entry.sha, type: isDir ? 'tree' : 'blob' };
    }
    currentSha = entry.sha;
  }
  return null;
}

/**
 * Sets or removes a path in a tree, creating intermediate trees, and stores new trees with putObject.
 */
export function setPath(repo: RepoRec, treeSha: string | null, path: string, blobSha: string | null): string {
  ensureEmptyTree(repo);
  const rootSha = treeSha || EMPTY_TREE_SHA;
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) {
    return rootSha;
  }
  return updateTreeAtSegments(repo, rootSha, segments, blobSha);
}

function updateTreeAtSegments(repo: RepoRec, currentTreeSha: string, segments: string[], blobSha: string | null): string {
  const [head, ...rest] = segments;
  const treeObj = getObject(repo, currentTreeSha);
  const entries: TreeEntry[] = treeObj && treeObj.type === 'tree' ? parseTree(treeObj.data) : [];

  const existingIdx = entries.findIndex((e) => e.name === head);

  if (rest.length === 0) {
    if (blobSha === null) {
      if (existingIdx !== -1) {
        entries.splice(existingIdx, 1);
      }
    } else {
      if (existingIdx !== -1) {
        entries[existingIdx].sha = blobSha;
        entries[existingIdx].mode = '100644';
      } else {
        entries.push({ mode: '100644', name: head, sha: blobSha });
      }
    }
  } else {
    let subTreeSha = EMPTY_TREE_SHA;
    if (existingIdx !== -1 && (entries[existingIdx].mode === '40000' || entries[existingIdx].mode === '040000' || entries[existingIdx].mode.startsWith('4'))) {
      subTreeSha = entries[existingIdx].sha;
    }
    const newSubTreeSha = updateTreeAtSegments(repo, subTreeSha, rest, blobSha);

    if (newSubTreeSha === EMPTY_TREE_SHA) {
      if (existingIdx !== -1) {
        entries.splice(existingIdx, 1);
      }
    } else {
      if (existingIdx !== -1) {
        entries[existingIdx].sha = newSubTreeSha;
        entries[existingIdx].mode = '40000';
      } else {
        entries.push({ mode: '40000', name: head, sha: newSubTreeSha });
      }
    }
  }

  if (entries.length === 0) {
    return EMPTY_TREE_SHA;
  }

  const encoded = encodeTree(entries);
  return putObject(repo, 'tree', encoded);
}

/**
 * Returns every blob under a tree, recursively.
 */
export function flattenTree(repo: RepoRec, treeSha: string, prefix = ''): { path: string; sha: string; mode: string }[] {
  const obj = getObject(repo, treeSha);
  if (!obj || obj.type !== 'tree') return [];
  const entries = parseTree(obj.data);
  const results: { path: string; sha: string; mode: string }[] = [];

  for (const entry of entries) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const isDir = entry.mode === '40000' || entry.mode === '040000' || entry.mode.startsWith('4');
    if (isDir) {
      results.push(...flattenTree(repo, entry.sha, fullPath));
    } else {
      results.push({ path: fullPath, sha: entry.sha, mode: entry.mode });
    }
  }
  return results;
}

/**
 * Finds the smallest slice length whose zlib.inflateSync succeeds and yields exactly expectedSize bytes.
 */
export function inflateExact(data: Buffer, expectedSize: number): { out: Buffer; consumed: number } {
  let low = 1;
  let high = data.length;
  let bestOut: Buffer | null = null;
  let bestLen = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    try {
      const out = zlib.inflateSync(data.subarray(0, mid));
      if (out.length === expectedSize) {
        bestOut = out;
        bestLen = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    } catch {
      low = mid + 1;
    }
  }

  if (bestOut !== null) {
    return { out: bestOut, consumed: bestLen };
  }

  for (let len = 1; len <= data.length; len++) {
    try {
      const out = zlib.inflateSync(data.subarray(0, len));
      if (out.length === expectedSize) {
        return { out, consumed: len };
      }
    } catch {}
  }

  throw new Error(`Failed to inflate exact size ${expectedSize}`);
}

function readVarint(buf: Buffer, pos: number): { value: number; consumed: number } {
  let shift = 0;
  let value = 0;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) {
      return { value, consumed: p - pos };
    }
    shift += 7;
  }
  throw new Error('Truncated varint');
}

function readPackHeader(buf: Buffer, pos: number): { typeCode: number; size: number; consumed: number } {
  let p = pos;
  const b = buf[p++];
  const typeCode = (b >> 4) & 0x07;
  let size = b & 0x0f;
  let shift = 4;
  let c = b;
  while (c & 0x80) {
    if (p >= buf.length) throw new Error('Truncated pack header');
    c = buf[p++];
    size |= (c & 0x7f) << shift;
    shift += 7;
  }
  return { typeCode, size, consumed: p - pos };
}

function readOfsOffset(buf: Buffer, pos: number): { offset: number; consumed: number } {
  let p = pos;
  let c = buf[p++];
  let val = c & 0x7f;
  while (c & 0x80) {
    if (p >= buf.length) throw new Error('Truncated ofs-delta offset');
    c = buf[p++];
    val = ((val + 1) << 7) | (c & 0x7f);
  }
  return { offset: val, consumed: p - pos };
}

/**
 * Applies git delta format: two varints (source size, target size), copy ops and insert ops.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const srcSizeRes = readVarint(delta, pos);
  pos += srcSizeRes.consumed;
  const targetSizeRes = readVarint(delta, pos);
  pos += targetSizeRes.consumed;

  const targetSize = targetSizeRes.value;
  const target = Buffer.alloc(targetSize);
  let targetPos = 0;

  while (pos < delta.length) {
    const cmd = delta[pos++];
    if (cmd & 0x80) {
      let cp_off = 0;
      if (cmd & 0x01) cp_off |= delta[pos++] << 0;
      if (cmd & 0x02) cp_off |= delta[pos++] << 8;
      if (cmd & 0x04) cp_off |= delta[pos++] << 16;
      if (cmd & 0x08) cp_off |= delta[pos++] << 24;

      let cp_size = 0;
      if (cmd & 0x10) cp_size |= delta[pos++] << 0;
      if (cmd & 0x20) cp_size |= delta[pos++] << 8;
      if (cmd & 0x40) cp_size |= delta[pos++] << 16;
      if (cp_size === 0) cp_size = 0x10000;

      base.copy(target, targetPos, cp_off, cp_off + cp_size);
      targetPos += cp_size;
    } else {
      const len = cmd;
      if (len === 0) {
        throw new Error('Invalid delta insert opcode 0');
      }
      delta.copy(target, targetPos, pos, pos + len);
      targetPos += len;
      pos += len;
    }
  }
  return target;
}

/**
 * Represents a parsed pack object.
 */
export interface PackObject {
  sha: string;
  type: string;
  data: Buffer;
}

/**
 * Parses a packfile, storing every object into the repo with putObject and returning them with their SHAs.
 */
export function parsePack(repo: RepoRec, pack: Buffer): PackObject[] {
  if (pack.length < 12) throw new Error('Pack file too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('Invalid PACK header');
  }
  const count = pack.readUInt32BE(8);
  let pos = 12;

  const packObjects: { offset: number; sha: string; type: string; data: Buffer }[] = [];
  const results: PackObject[] = [];

  for (let i = 0; i < count; i++) {
    const objOffset = pos;
    const header = readPackHeader(pack, pos);
    pos += header.consumed;

    const typeCode = header.typeCode;
    const size = header.size;

    const inflated = inflateExact(pack.subarray(pos), size);
    pos += inflated.consumed;
    const payload = inflated.out;

    let objType = '';
    let objData: Buffer;

    if (typeCode === 1) {
      objType = 'commit';
      objData = payload;
    } else if (typeCode === 2) {
      objType = 'tree';
      objData = payload;
    } else if (typeCode === 3) {
      objType = 'blob';
      objData = payload;
    } else if (typeCode === 4) {
      objType = 'tag';
      objData = payload;
    } else if (typeCode === 6) {
      const offsetRes = readOfsOffset(pack, pos);
      pos += offsetRes.consumed;
      const baseOffset = objOffset - offsetRes.offset;
      const baseObj = packObjects.find((o) => o.offset === baseOffset);
      if (!baseObj) {
        throw new Error(`Base object at offset ${baseOffset} not found for ofs-delta`);
      }
      objType = baseObj.type;
      objData = applyDelta(baseObj.data, payload);
    } else if (typeCode === 7) {
      if (pos + 20 > pack.length) throw new Error('Truncated ref-delta base SHA');
      const baseSha = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;

      let baseData: Buffer;
      let baseType: string;

      const localBase = packObjects.find((o) => o.sha === baseSha);
      if (localBase) {
        baseData = localBase.data;
        baseType = localBase.type;
      } else {
        const repoObj = getObject(repo, baseSha);
        if (!repoObj) {
          throw new Error(`Base object ${baseSha} not found in pack or repo for ref-delta`);
        }
        baseData = repoObj.data;
        baseType = repoObj.type;
      }
      objType = baseType;
      objData = applyDelta(baseData, payload);
    } else {
      throw new Error(`Unknown pack object type code: ${typeCode}`);
    }

    const sha = hashObject(objType, objData);
    putObject(repo, objType as any, objData);

    const packObj = { offset: objOffset, sha, type: objType, data: objData };
    packObjects.push(packObj);
    results.push({ sha, type: objType, data: objData });
  }

  return results;
}

function encodePackHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) {
    b |= 0x80;
    bytes.push(b);
    while (size > 0) {
      let nextB = size & 0x7f;
      size >>= 7;
      if (size > 0) {
        nextB |= 0x80;
      }
      bytes.push(nextB);
    }
  } else {
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/**
 * Builds a packfile containing the given objects without deltas, with trailing SHA-1 checksum.
 */
export function buildPack(objects: { type: string; data: Buffer }[]): Buffer {
  const buffers: Buffer[] = [];
  buffers.push(Buffer.from('PACK', 'ascii'));
  const verBuf = Buffer.alloc(4);
  verBuf.writeUInt32BE(2, 0);
  buffers.push(verBuf);
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(objects.length, 0);
  buffers.push(countBuf);

  const shasum = crypto.createHash('sha1');
  for (const b of buffers) {
    shasum.update(b);
  }

  for (const obj of objects) {
    let typeCode = 3;
    if (obj.type === 'commit') typeCode = 1;
    else if (obj.type === 'tree') typeCode = 2;
    else if (obj.type === 'blob') typeCode = 3;
    else if (obj.type === 'tag') typeCode = 4;

    const headerBuf = encodePackHeader(typeCode, obj.data.length);
    buffers.push(headerBuf);
    shasum.update(headerBuf);

    const deflated = zlib.deflateSync(obj.data);
    buffers.push(deflated);
    shasum.update(deflated);
  }

  const digest = shasum.digest();
  buffers.push(digest);

  return Buffer.concat(buffers);
}
