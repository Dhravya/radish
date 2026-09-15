import { TYPE_TABLE, type SqlStorage, type SqlValue } from "../schema";
import { byteKey, type EvictionCandidate, type Tier } from "../store";
import type { KeyType } from "../types";
import { objectKeyFor, keyForObject, COLD_OBJECT_PREFIX, type ColdBucket } from "./bucket";
import { decodeValue, encodeValue, type EvictedValue, type StoredType } from "./codec";
import { DEFAULT_POLICY, planEvictions, type Candidate, type PlannerPolicy } from "./planner";

export interface TierStore {
  readonly sql: SqlStorage;
  typeOf(key: Uint8Array): KeyType;
  tierOf(key: Uint8Array): Tier;
  markHot(key: Uint8Array): void;
  markWarm(key: Uint8Array, version: string): void;
  markCold(key: Uint8Array): void;
  touch(key: Uint8Array, nowMs: number): void;
  evictionCandidates(limit: number, ttlHorizonMs: number): readonly EvictionCandidate[];
  databaseBytes(): number;
}

export interface ColdIndex {
  readonly size: number;
  readonly primed: boolean;
  holds(key: Uint8Array): boolean;
  remember(key: Uint8Array): void;
  forget(key: Uint8Array): void;
  prime(keys: Iterable<Uint8Array>): void;
}

export const coldIndex = (): ColdIndex => {
  const cold = new Set<string>();
  let primed = false;

  return {
    get size() {
      return cold.size;
    },
    get primed() {
      return primed;
    },
    holds(key) {
      return cold.has(byteKey(key));
    },
    remember(key) {
      cold.add(byteKey(key));
    },
    forget(key) {
      cold.delete(byteKey(key));
    },
    prime(keys) {
      cold.clear();
      for (const key of keys) cold.add(byteKey(key));
      primed = true;
    },
  };
};

export interface MaintenanceGate {
  readonly busy: boolean;
  run<T>(body: () => Promise<T>): Promise<T>;
}

export const maintenanceGate = (): MaintenanceGate => {
  let tail: Promise<unknown> = Promise.resolve();
  let depth = 0;

  return {
    get busy() {
      return depth > 0;
    },
    run(body) {
      depth += 1;
      const next = tail.then(body, body).finally(() => {
        depth -= 1;
      });
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
};

export interface TierDeps {
  readonly store: TierStore;
  readonly bucket: ColdBucket;
  readonly index: ColdIndex;
  readonly maintenance: MaintenanceGate;
  atomically<T>(run: () => T): T;
  now(): number;
}

export interface TierPolicy {
  readonly highWatermarkBytes: number;
  readonly lowWatermarkBytes: number;
  readonly maxEvictionsPerPass: number;
  readonly planner?: PlannerPolicy;
}

export const WRITE_CLOCK_NOT_RECORDED = null;

const GIB = 1024 * 1024 * 1024;

export const DEFAULT_TIER_POLICY: TierPolicy = {
  highWatermarkBytes: 8 * GIB,
  lowWatermarkBytes: 6 * GIB,
  maxEvictionsPerPass: 256,
};

export class ColdObjectMissing extends Error {
  constructor(readonly objectKey: string) {
    super(`radish: cold key ${objectKey} has no R2 object — its only copy is gone`);
    this.name = "ColdObjectMissing";
  }
}

export class ColdKeyNotResident extends Error {
  constructor(readonly objectKey: string) {
    super(`radish: a write reached cold key ${objectKey} without faulting it in first`);
    this.name = "ColdKeyNotResident";
  }
}

export class TierRowShapeError extends Error {
  constructor(type: StoredType, got: number, want: number) {
    super(`radish: a decoded ${type} row has ${got} columns, the table takes ${want}`);
    this.name = "TierRowShapeError";
  }
}

const VALUE_COLUMNS: Readonly<Record<StoredType, readonly string[]>> = {
  string: ["val"],
  hash: ["field", "val"],
  list: ["seq", "val"],
  set: ["member"],
  zset: ["member", "score"],
};

const ORDER_COLUMN: Readonly<Record<StoredType, string>> = {
  string: "val",
  hash: "field",
  list: "seq",
  set: "member",
  zset: "member",
};

const readRows = (sql: SqlStorage, type: StoredType, key: Uint8Array): SqlValue[][] => {
  const rows: SqlValue[][] = [];
  for (const row of sql
    .exec(
      `SELECT ${VALUE_COLUMNS[type].join(", ")} FROM ${TYPE_TABLE[type]}
        WHERE key = ? ORDER BY ${ORDER_COLUMN[type]}`,
      key,
    )
    .raw()) {
    rows.push(row);
  }
  return rows;
};

const insertRows = (
  sql: SqlStorage,
  type: StoredType,
  key: Uint8Array,
  rows: readonly (readonly SqlValue[])[],
): void => {
  const columns = VALUE_COLUMNS[type];
  const statement = `INSERT INTO ${TYPE_TABLE[type]} (key, ${columns.join(", ")})
     VALUES (?, ${columns.map(() => "?").join(", ")})`;
  for (const row of rows) {
    if (row.length !== columns.length) throw new TierRowShapeError(type, row.length, columns.length);
    sql.exec(statement, key, ...row);
  }
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) if (left[i] !== right[i]) return false;
  return true;
};

const encodedNow = (deps: TierDeps, key: Uint8Array, type: KeyType): Uint8Array | null =>
  type === "none" ? null : encodeValue({ type, rows: readRows(deps.store.sql, type, key) });

const isCold = (deps: TierDeps, key: Uint8Array): boolean =>
  deps.index.primed ? deps.index.holds(key) : deps.store.tierOf(key) === "cold";

interface FetchedValue {
  readonly key: Uint8Array;
  readonly value: EvictedValue<StoredType>;
  readonly version: string;
}

export const faultIn = async (deps: TierDeps, keys: readonly Uint8Array[]): Promise<void> => {
  if (deps.index.primed && deps.index.size === 0) return;

  const cold: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const id = byteKey(key);
    if (seen.has(id)) continue;
    seen.add(id);
    if (isCold(deps, key)) cold.push(key);
  }
  if (cold.length === 0) return;

  const fetched = await Promise.all(cold.map((key) => fetchCold(deps, key)));

  deps.atomically(() => {
    for (const held of fetched) {
      if (held === null) continue;
      if (deps.store.tierOf(held.key) !== "cold") continue;
      insertRows(deps.store.sql, held.value.type, held.key, held.value.rows);
      deps.store.markWarm(held.key, held.version);
      deps.store.touch(held.key, deps.now());
    }
  });

  for (const key of cold) deps.index.forget(key);
};

const fetchCold = async (deps: TierDeps, key: Uint8Array): Promise<FetchedValue | null> => {
  if (deps.store.tierOf(key) !== "cold") {
    deps.index.forget(key);
    return null;
  }

  const objectKey = objectKeyFor(key);
  const held = await deps.bucket.get(objectKey);
  if (held === null) {
    if (deps.store.tierOf(key) === "cold") throw new ColdObjectMissing(objectKey);
    return null;
  }
  return { key, value: decodeValue(held.bytes), version: held.version };
};

export const assertFaultedIn = (deps: TierDeps, keys: readonly Uint8Array[]): void => {
  if (deps.index.primed && deps.index.size === 0) return;
  for (const key of keys) {
    if (isCold(deps, key)) throw new ColdKeyNotResident(objectKeyFor(key));
  }
};

export interface TierPass {
  readonly promoted: number;
  readonly demoted: number;
  readonly bytesReclaimed: number;
}

const CANDIDATE_BATCH = 64;

const toCandidate = (row: EvictionCandidate): Candidate => ({
  key: row.key,
  tier: row.tier,
  type: row.type,
  bytes: row.bytes,
  idleMs: row.idleMs,
  ttlMs: row.ttlMs,
  writtenWithinMs: WRITE_CLOCK_NOT_RECORDED,
});

export const relievePressure = async (deps: TierDeps, policy: TierPolicy): Promise<TierPass> =>
  deps.maintenance.run(async () => {
    let promoted = 0;
    let demoted = 0;
    let bytesReclaimed = 0;
    if (deps.store.databaseBytes() <= policy.highWatermarkBytes) {
      return { promoted, demoted, bytesReclaimed };
    }

    const plannerPolicy = policy.planner ?? DEFAULT_POLICY;
    const attempted = new Set<string>();
    let budget = policy.maxEvictionsPerPass;
    let reachedLowWatermark = false;

    while (budget > 0 && !reachedLowWatermark) {
      const overBytes = deps.store.databaseBytes() - policy.lowWatermarkBytes;
      if (overBytes <= 0) break;

      const fresh = deps.store
        .evictionCandidates(Math.min(budget, CANDIDATE_BATCH), plannerPolicy.ttlHorizonMs)
        .filter((row) => !attempted.has(byteKey(row.key)))
        .map(toCandidate);
      if (fresh.length === 0) break;

      const plan = planEvictions(fresh, overBytes, plannerPolicy);
      if (plan.free.length === 0 && plan.upload.length === 0) break;

      for (const eviction of [...plan.free, ...plan.upload]) {
        if (budget === 0 || reachedLowWatermark) break;
        attempted.add(byteKey(eviction.key));
        budget -= 1;

        if (eviction.tier === "hot") {
          if (!(await promote(deps, eviction.key))) continue;
          promoted += 1;
        }
        if (!demote(deps, eviction.key)) continue;
        demoted += 1;
        bytesReclaimed += eviction.bytes;
        reachedLowWatermark = deps.store.databaseBytes() <= policy.lowWatermarkBytes;
      }
    }

    return { promoted, demoted, bytesReclaimed };
  });

const promote = async (deps: TierDeps, key: Uint8Array): Promise<boolean> => {
  const type = deps.store.typeOf(key);
  const bytes = encodedNow(deps, key, type);
  if (bytes === null) {
    deps.index.forget(key);
    return false;
  }

  const version = await deps.bucket.put(objectKeyFor(key), bytes);

  const current = encodedNow(deps, key, deps.store.typeOf(key));
  if (current === null || !sameBytes(bytes, current)) return false;
  if (deps.store.tierOf(key) === "cold") return false;
  deps.store.markWarm(key, version);
  return true;
};

const demote = (deps: TierDeps, key: Uint8Array): boolean =>
  deps.atomically(() => {
    if (deps.store.tierOf(key) !== "warm") return false;
    deps.store.markCold(key);
    if (deps.store.tierOf(key) !== "cold") return false;
    deps.index.remember(key);
    return true;
  });

export const MAX_ORPHANS_PER_PASS = 128;

export const collectOrphans = async (deps: TierDeps): Promise<number> =>
  deps.maintenance.run(async () => {
    const objects = await deps.bucket.list(COLD_OBJECT_PREFIX);
    let removed = 0;

    for (const object of objects) {
      if (removed === MAX_ORPHANS_PER_PASS) break;
      const key = keyForObject(object.objectKey);
      if (key === null) continue;
      const tier = deps.store.tierOf(key);
      if (tier === "warm" || tier === "cold") continue;
      await deps.bucket.delete(object.objectKey);
      removed += 1;
    }

    return removed;
  });
