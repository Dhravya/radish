import type { KeyType } from "../types";
import { ESTIMATED_BYTES_PER_ELEMENT, TOUCH_CLOCK_RESOLUTION_MS, TOUCH_SAMPLE_ONE_IN, type Tier } from "../store";

export type { Tier };

export const TOUCH_CLOCK_LAG_MS = TOUCH_SAMPLE_ONE_IN * TOUCH_CLOCK_RESOLUTION_MS;

export interface Candidate {
  readonly key: Uint8Array;
  readonly tier: Tier;
  readonly type: KeyType;
  readonly bytes: number;
  readonly idleMs: number;
  readonly ttlMs: number | null;
  readonly writtenWithinMs: number | null;
}

export interface PlannedEviction {
  readonly key: Uint8Array;
  readonly tier: Tier;
  readonly bytes: number;
  readonly score: number;
  readonly reason: string;
}

export interface SkippedCandidate {
  readonly key: Uint8Array;
  readonly reason: string;
}

export interface EvictionPlan {
  readonly free: readonly PlannedEviction[];
  readonly upload: readonly PlannedEviction[];
  readonly skipped: readonly SkippedCandidate[];
  readonly projectedBytesReclaimed: number;
  readonly reachesTarget: boolean;
}

export interface PlannerPolicy {
  readonly ttlHorizonMs: number;
  readonly minEvictableBytes: number;
  readonly churnExclusionMs: number;
  readonly churnHalfLifeMs: number;
  readonly churnPenaltyMax: number;
  readonly idleHalfLifeMs: number;
  readonly minReadProbability: number;
  readonly aggregateElementBytes: number;
  readonly aggregateAmplificationWeight: number;
}

export const TTL_HORIZON_MS = 300_000;
export const MIN_EVICTABLE_BYTES = 4_096;
export const CHURN_EXCLUSION_MS = 5_000;
export const CHURN_HALF_LIFE_MS = 60_000;
export const CHURN_PENALTY_MAX = 8;
export const IDLE_HALF_LIFE_MS = 900_000;
export const MIN_READ_PROBABILITY = 0.05;
export const AGGREGATE_ELEMENT_BYTES = ESTIMATED_BYTES_PER_ELEMENT;
export const AGGREGATE_AMPLIFICATION_WEIGHT = 4;

export const DEFAULT_POLICY: PlannerPolicy = {
  ttlHorizonMs: TTL_HORIZON_MS,
  minEvictableBytes: MIN_EVICTABLE_BYTES,
  churnExclusionMs: CHURN_EXCLUSION_MS,
  churnHalfLifeMs: CHURN_HALF_LIFE_MS,
  churnPenaltyMax: CHURN_PENALTY_MAX,
  idleHalfLifeMs: IDLE_HALF_LIFE_MS,
  minReadProbability: MIN_READ_PROBABILITY,
  aggregateElementBytes: AGGREGATE_ELEMENT_BYTES,
  aggregateAmplificationWeight: AGGREGATE_AMPLIFICATION_WEIGHT,
};

export const SKIP_ALREADY_COLD = "already cold: no sqlite rows left to reclaim";
export const SKIP_MISSING = "key does not exist: nothing to evict";

export const SKIP_SIZE_UNKNOWN =
  "size unknown: cardinality has never been counted, so the store reports 0 bytes; count the key to make it evictable";

const compareKeys = (a: Uint8Array, b: Uint8Array): number => {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left - right;
  }
  return a.length - b.length;
};

export const readProbability = (idleMs: number, policy: PlannerPolicy): number => {
  const idle = Number.isFinite(idleMs) ? Math.max(0, idleMs) : Number.POSITIVE_INFINITY;
  const decay = policy.idleHalfLifeMs > 0 ? 1 / (1 + Math.log2(1 + idle / policy.idleHalfLifeMs)) : 0;
  return policy.minReadProbability + (1 - policy.minReadProbability) * decay;
};

export const estimatedElements = (
  bytes: number,
  keyLength: number,
  policy: PlannerPolicy,
): number => {
  const perElement = keyLength + policy.aggregateElementBytes;
  return perElement > 0 ? Math.max(1, bytes / perElement) : 1;
};

export const readAmplification = (
  type: KeyType,
  bytes: number,
  keyLength: number,
  policy: PlannerPolicy,
): number => {
  if (type === "string" || type === "none") return 1;
  return 1 + policy.aggregateAmplificationWeight * Math.log2(1 + estimatedElements(bytes, keyLength, policy));
};

export const churnPenalty = (writtenWithinMs: number | null, policy: PlannerPolicy): number => {
  if (writtenWithinMs === null) return 1;
  const since = Number.isFinite(writtenWithinMs) ? Math.max(0, writtenWithinMs) : Number.POSITIVE_INFINITY;
  const decay = policy.churnHalfLifeMs > 0 ? Math.pow(2, -since / policy.churnHalfLifeMs) : 0;
  return 1 + policy.churnPenaltyMax * decay;
};

export const scoreCandidate = (candidate: Candidate, policy: PlannerPolicy): number => {
  const pain =
    readProbability(candidate.idleMs, policy) *
    readAmplification(candidate.type, candidate.bytes, candidate.key.length, policy) *
    churnPenalty(candidate.writtenWithinMs, policy);
  return pain > 0 ? candidate.bytes / pain : Number.POSITIVE_INFINITY;
};

export const exclusionReason = (candidate: Candidate, policy: PlannerPolicy): string | null => {
  if (candidate.tier === "cold") return SKIP_ALREADY_COLD;
  if (candidate.type === "none") return SKIP_MISSING;
  if (candidate.ttlMs !== null && candidate.ttlMs <= policy.ttlHorizonMs) {
    return `expires in ${Math.round(candidate.ttlMs)}ms, inside the ${policy.ttlHorizonMs}ms ttl horizon: the bytes free themselves`;
  }
  if (!(candidate.bytes > 0)) return SKIP_SIZE_UNKNOWN;
  if (!(candidate.bytes >= policy.minEvictableBytes)) {
    return `${candidate.bytes}B under the ${policy.minEvictableBytes}B size floor: one r2 round trip costs more than the bytes reclaimed`;
  }
  if (
    candidate.tier === "hot" &&
    candidate.writtenWithinMs !== null &&
    candidate.writtenWithinMs <= policy.churnExclusionMs
  ) {
    return `written ${Math.round(candidate.writtenWithinMs)}ms ago, inside the ${policy.churnExclusionMs}ms churn window: the upload would be invalidated before it lands`;
  }
  return null;
};

const describe = (candidate: Candidate): string => {
  const move =
    candidate.tier === "warm"
      ? "warm->cold, object already in r2, no upload"
      : "hot->cold, upload required";
  const shape =
    candidate.type === "string"
      ? "whole-key read amplification 1"
      : "aggregate, one element read faults in the whole collection";
  const ttl = candidate.ttlMs === null ? "no ttl" : `ttl ${Math.round(candidate.ttlMs)}ms`;
  const written =
    candidate.writtenWithinMs === null
      ? "not recently written"
      : `written ${Math.round(candidate.writtenWithinMs)}ms ago`;
  return `${move}; ${candidate.bytes}B ${candidate.type}; ${shape}; idle ${Math.round(candidate.idleMs)}ms; ${ttl}; ${written}`;
};

interface Ranked {
  readonly candidate: Candidate;
  readonly score: number;
}

const FNV_OFFSET_BASIS = 0x811c9dc5;

const FNV_PRIME = 0x01000193;

const keyDispersion = (key: Uint8Array): number => {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of key) hash = Math.imul(hash ^ byte, FNV_PRIME);
  return hash >>> 0;
};

const byDescendingValue = (a: Ranked, b: Ranked): number => {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1;
  if (a.candidate.bytes !== b.candidate.bytes) return a.candidate.bytes > b.candidate.bytes ? -1 : 1;
  if (a.candidate.idleMs !== b.candidate.idleMs) return a.candidate.idleMs > b.candidate.idleMs ? -1 : 1;
  const spreadA = keyDispersion(a.candidate.key);
  const spreadB = keyDispersion(b.candidate.key);
  if (spreadA !== spreadB) return spreadA - spreadB;
  return compareKeys(a.candidate.key, b.candidate.key);
};

const toPlanned = (ranked: Ranked): PlannedEviction => ({
  key: ranked.candidate.key,
  tier: ranked.candidate.tier,
  bytes: ranked.candidate.bytes,
  score: ranked.score,
  reason: describe(ranked.candidate),
});

const totalBytes = (planned: readonly PlannedEviction[]): number =>
  planned.reduce((sum, entry) => sum + entry.bytes, 0);

const dropRedundant = (
  planned: readonly PlannedEviction[],
  slack: number,
): { readonly kept: PlannedEviction[]; readonly slack: number } => {
  const kept: PlannedEviction[] = [];
  let remaining = slack;
  for (let i = planned.length - 1; i >= 0; i--) {
    const entry = planned[i];
    if (entry === undefined) continue;
    if (entry.bytes <= remaining) {
      remaining -= entry.bytes;
      continue;
    }
    kept.push(entry);
  }
  kept.reverse();
  return { kept, slack: remaining };
};

const takeUntil = (
  pool: readonly Ranked[],
  need: number,
  alreadyReclaimed: number,
): { readonly taken: PlannedEviction[]; readonly reclaimed: number } => {
  const taken: PlannedEviction[] = [];
  let reclaimed = alreadyReclaimed;
  for (const ranked of pool) {
    if (reclaimed >= need) break;
    taken.push(toPlanned(ranked));
    reclaimed += ranked.candidate.bytes;
  }
  return { taken, reclaimed };
};

export const planEvictions = (
  candidates: readonly Candidate[],
  targetBytes: number,
  policy: PlannerPolicy,
): EvictionPlan => {
  const skipped: SkippedCandidate[] = [];
  const freePool: Ranked[] = [];
  const uploadPool: Ranked[] = [];

  for (const candidate of candidates) {
    const excluded = exclusionReason(candidate, policy);
    if (excluded !== null) {
      skipped.push({ key: candidate.key, reason: excluded });
      continue;
    }
    const ranked: Ranked = { candidate, score: scoreCandidate(candidate, policy) };
    if (candidate.tier === "warm") freePool.push(ranked);
    else uploadPool.push(ranked);
  }

  freePool.sort(byDescendingValue);
  uploadPool.sort(byDescendingValue);

  const need = Number.isFinite(targetBytes) ? Math.max(0, targetBytes) : Number.POSITIVE_INFINITY;

  const freeTake = takeUntil(freePool, need, 0);
  const uploadTake = takeUntil(uploadPool, need, freeTake.reclaimed);

  let free = freeTake.taken;
  let upload = uploadTake.taken;
  const gross = uploadTake.reclaimed;
  const reachesTarget = gross >= need;

  if (reachesTarget && Number.isFinite(need)) {
    const trimmedUpload = dropRedundant(upload, gross - need);
    upload = trimmedUpload.kept;
    if (upload.length === 0) {
      free = dropRedundant(free, trimmedUpload.slack).kept;
    }
  }

  return {
    free,
    upload,
    skipped,
    projectedBytesReclaimed: totalBytes(free) + totalBytes(upload),
    reachesTarget,
  };
};
