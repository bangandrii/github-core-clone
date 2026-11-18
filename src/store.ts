import crypto from 'node:crypto';

/**
 * Represents a Git object stored in the repository object database.
 */
export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

/**
 * Represents an issue record in a repository.
 */
export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  created_at: string;
  updated_at: string;
  comments: { id: number; body: string; created_at: string }[];
}

/**
 * Represents a pull request record in a repository.
 */
export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  base_sha: string;
  head?: string;
  base?: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

/**
 * Represents a repository record containing refs, objects, issues, pulls, and metadata.
 */
export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: IssueRec[];
  pulls: PullRec[];
  labels: { name: string; color: string }[];
  next_number: number;
}

/**
 * Returns the current timestamp in ISO 8601 format.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Computes the Git object ID (SHA-1 hex of header `${type} ${data.length}\0` + data).
 */
export function hashObject(type: string, data: Buffer): string {
  const header = `${type} ${data.length}\0`;
  const shasum = crypto.createHash('sha1');
  shasum.update(header);
  shasum.update(data);
  return shasum.digest('hex');
}

/**
 * Stores a Git object in the repository and returns its SHA-1 object ID.
 */
export function putObject(repo: RepoRec, type: GitObject['type'], data: Buffer): string {
  const sha = hashObject(type, data);
  repo.objects.set(sha, { type, data });
  return sha;
}

/**
 * Retrieves a Git object from the repository by its SHA-1 ID, or null if not found.
 */
export function getObject(repo: RepoRec, sha: string): GitObject | null {
  return repo.objects.get(sha) || null;
}

/**
 * Encodes a node type and database ID into a base64 Node global ID string.
 */
export function nodeId(type: string, dbId: number): string {
  return Buffer.from(`${type}:${dbId}`).toString('base64');
}

/**
 * Decodes and parses a base64 Node global ID string into its type and database ID, or null if malformed.
 */
export function parseNodeId(id: string): { type: string; dbId: number } | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  try {
    const buf = Buffer.from(id, 'base64');
    if (buf.toString('base64') !== id) return null;
    const decoded = buf.toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx <= 0) return null;
    const type = decoded.slice(0, colonIdx);
    const dbIdStr = decoded.slice(colonIdx + 1);
    if (!dbIdStr) return null;
    const dbId = Number(dbIdStr);
    if (!Number.isInteger(dbId) || dbId < 0) return null;
    return { type, dbId };
  } catch {
    return null;
  }
}

/**
 * In-memory storage manager for repositories.
 */
export class Store {
  repos = new Map<string, RepoRec>();
  private nextRepoId = 1;

  /**
     * Creates a new repository record.
     */
  createRepo(owner: string, name: string, description: string | null, isPrivate: boolean = false): RepoRec {
    const key = `${owner}/${name}`;
    const now = nowIso();
    const repo: RepoRec = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      private: isPrivate,
      default_branch: 'main',
      created_at: now,
      updated_at: now,
      refs: new Map<string, string>(),
      objects: new Map<string, GitObject>(),
      issues: [],
      pulls: [],
      labels: [],
      next_number: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  /**
     * Retrieves a repository record by owner and name, or null if not found.
     */
  getRepo(owner: string, name: string): RepoRec | null {
    const key = `${owner}/${name}`;
    return this.repos.get(key) || null;
  }

  /**
     * Deletes a repository by owner and name. Returns true if deleted, false if not found.
     */
  deleteRepo(owner: string, name: string): boolean {
    const key = `${owner}/${name}`;
    return this.repos.delete(key);
  }

  /**
     * Lists repositories, optionally filtered by owner, sorted by repository id.
     */
  listRepos(owner?: string): RepoRec[] {
    const list: RepoRec[] = [];
    for (const repo of this.repos.values()) {
      if (owner === undefined || repo.owner === owner) {
        list.push(repo);
      }
    }
    list.sort((a, b) => a.id - b.id);
    return list;
  }
}

/**
 * The one shared store instance every surface uses.
 */
export const store = new Store();
