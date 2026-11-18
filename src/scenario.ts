export const MASK = (1n << 64n) - 1n;
export const SCENARIO_SEED = 0x6a09e667f3bcc909n;

/**
 * Computes FNV-1a 64-bit hash of a string.
 */
export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & MASK;
  }
  return hash;
}

/**
 * Mixes a 64-bit integer using SplitMix64 finalizer logic.
 */
export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}

/**
 * 64-bit Xorshift PRNG.
 */
export class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & MASK;
    x = (x ^ ((x << 25n) & MASK)) & MASK;
    x = (x ^ (x >> 27n)) & MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(n: number): number {
    if (n === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % n);
    while (true) {
      const v = this.nextU32();
      if (v < limit) {
        return v % n;
      }
    }
  }

  pick<T>(items: T[]): T {
    return items[this.nextInt(items.length)];
  }
}

/**
 * Creates an Rng instance seeded for a specific scenario label.
 */
export function scenarioRng(label: string): Rng {
  return new Rng(mix64(SCENARIO_SEED ^ fnv1a64(label)));
}

export const FIRST = 'ada,bram,cora,dmitri,elena,felix,greta,hugo,iris,jonas,kira,lars,mira,nico,olga,pavel,quinn,rosa,sven,tess,ulla,vito,wren,yara,zane'.split(',');
export const LAST = 'anders,bauer,costa,dahl,eriksen,fischer,garcia,holm,iversen,jansen,keller,lind,moreau,novak,olsen,peters,quist,rossi,sato,turi,ulrich,vega,weber,xu,yilmaz,zimmer'.split(',');

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

/**
 * Generates a list of deterministic scenario users.
 */
export function generateUsers(count: number): ScenarioUser[] {
  const rng = scenarioRng('users');
  const users: ScenarioUser[] = [];
  const taken = new Set<string>();

  for (let i = 0; i < count; i++) {
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
    const base = (first + last).replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (taken.has(login)) {
      login = `${base}-${suffix}`;
      suffix++;
    }
    taken.add(login);

    const id = 1000 + i;
    const name = `${first} ${last}`;
    const email = `${login}@example.invalid`;

    users.push({ id, login, name, email });
  }

  return users;
}

export const USERS = generateUsers(12);
export const VIEWER = USERS[0];
export const TEAMMATE = USERS[1];
export const STRANGER = USERS[2];
