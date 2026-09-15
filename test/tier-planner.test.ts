import { test, expect, describe } from "bun:test";
import {
  planEvictions,
  scoreCandidate,
  exclusionReason,
  readAmplification,
  readProbability,
  churnPenalty,
  DEFAULT_POLICY,
  TTL_HORIZON_MS,
  MIN_EVICTABLE_BYTES,
  CHURN_EXCLUSION_MS,
  IDLE_HALF_LIFE_MS,
  AGGREGATE_ELEMENT_BYTES,
  TOUCH_CLOCK_LAG_MS,
  estimatedElements,
  SKIP_ALREADY_COLD,
  SKIP_MISSING,
  SKIP_SIZE_UNKNOWN,
  type Candidate,
  type EvictionPlan,
  type PlannedEviction,
  type PlannerPolicy,
  type Tier,
} from "../src/tier/planner";
import type { KeyType } from "../src/types";

const KiB = 1024;
const MiB = 1024 * 1024;

const k = (name: string): Uint8Array => new TextEncoder().encode(name);
const name = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const candidate = (overrides: Omit<Partial<Candidate>, "key"> & { key: string }): Candidate => ({
  key: k(overrides.key),
  tier: overrides.tier ?? "hot",
  type: overrides.type ?? "string",
  bytes: overrides.bytes ?? 64 * KiB,
  idleMs: overrides.idleMs ?? 3_600_000,
  ttlMs: overrides.ttlMs ?? null,
  writtenWithinMs: overrides.writtenWithinMs ?? null,
});

const plan = (candidates: readonly Candidate[], target: number, policy: PlannerPolicy = DEFAULT_POLICY) =>
  planEvictions(candidates, target, policy);

const planned = (p: EvictionPlan): PlannedEviction[] => [...p.free, ...p.upload];
const plannedNames = (p: EvictionPlan): string[] => planned(p).map((e) => name(e.key));
const skippedNames = (p: EvictionPlan): string[] => p.skipped.map((e) => name(e.key));

describe("free evictions before paid ones", () => {
  test("a warm candidate is planned before any hot candidate, however good the hot one looks", () => {
    const p = plan(
      [
        candidate({ key: "hot-ideal", tier: "hot", type: "string", bytes: 1 * MiB, idleMs: 86_400_000 }),
        candidate({ key: "warm-mediocre", tier: "warm", type: "hash", bytes: 8 * KiB, idleMs: 1_000 }),
      ],
      8 * KiB,
    );

    expect(plannedNames(p)).toEqual(["warm-mediocre"]);
    expect(p.upload).toHaveLength(0);
    expect(p.reachesTarget).toBe(true);
  });

  test("no upload is planned while an eligible free eviction remains unplanned", () => {
    const warms = Array.from({ length: 5 }, (_, i) =>
      candidate({ key: `warm-${i}`, tier: "warm", bytes: 16 * KiB, idleMs: 10_000 }),
    );
    const hots = Array.from({ length: 5 }, (_, i) =>
      candidate({ key: `hot-${i}`, tier: "hot", bytes: 512 * KiB, idleMs: 86_400_000 }),
    );

    const p = plan([...hots, ...warms], 5 * MiB);

    expect(p.free).toHaveLength(5);
    expect(p.upload.length).toBeGreaterThan(0);
    expect(p.free.every((e) => e.tier === "warm")).toBe(true);
    expect(p.upload.every((e) => e.tier === "hot")).toBe(true);
  });

  test("warm evictions carry no upload in their reason and hot ones say they do", () => {
    const p = plan(
      [
        candidate({ key: "w", tier: "warm", bytes: 64 * KiB }),
        candidate({ key: "h", tier: "hot", bytes: 64 * KiB }),
      ],
      128 * KiB,
    );

    expect(p.free[0]?.reason).toContain("no upload");
    expect(p.upload[0]?.reason).toContain("upload required");
  });
});

describe("hard exclusions", () => {
  test("a key expiring inside the ttl horizon is never planned, even as the coldest largest thing present", () => {
    const expiring = candidate({
      key: "expiring",
      tier: "hot",
      type: "string",
      bytes: 1 * MiB,
      idleMs: 30 * 86_400_000,
      ttlMs: 30_000,
    });
    const ordinary = candidate({ key: "ordinary", tier: "hot", bytes: 8 * KiB, idleMs: 1_000 });

    const p = plan([expiring, ordinary], 8 * KiB);

    expect(plannedNames(p)).not.toContain("expiring");
    expect(plannedNames(p)).toEqual(["ordinary"]);
    expect(p.skipped.find((s) => name(s.key) === "expiring")?.reason).toContain("ttl horizon");
  });

  test("the ttl horizon boundary excludes at the horizon and admits just past it", () => {
    const at = candidate({ key: "at", ttlMs: TTL_HORIZON_MS });
    const past = candidate({ key: "past", ttlMs: TTL_HORIZON_MS + 1 });

    const p = plan([at, past], 1 * MiB);

    expect(skippedNames(p)).toEqual(["at"]);
    expect(plannedNames(p)).toEqual(["past"]);
  });

  test("a ttl that is already negative is excluded, not raced", () => {
    const p = plan([candidate({ key: "gone", ttlMs: -1 })], 1);
    expect(p.free).toHaveLength(0);
    expect(p.upload).toHaveLength(0);
    expect(p.skipped).toHaveLength(1);
  });

  test("a value under the size floor is never planned", () => {
    const tiny = candidate({ key: "tiny", bytes: 200, idleMs: 30 * 86_400_000 });
    const p = plan([tiny], 200);

    expect(planned(p)).toHaveLength(0);
    expect(p.reachesTarget).toBe(false);
    expect(p.skipped[0]?.reason).toContain("size floor");
  });

  test("ten thousand sub-floor values cannot be aggregated into a plan", () => {
    const crumbs = Array.from({ length: 10_000 }, (_, i) =>
      candidate({ key: `crumb-${i}`, bytes: MIN_EVICTABLE_BYTES - 1, idleMs: 86_400_000 }),
    );
    const p = plan(crumbs, 1 * MiB);

    expect(planned(p)).toHaveLength(0);
    expect(p.skipped).toHaveLength(10_000);
    expect(p.projectedBytesReclaimed).toBe(0);
    expect(p.reachesTarget).toBe(false);
  });

  test("the size floor boundary admits exactly at the floor", () => {
    const p = plan(
      [candidate({ key: "under", bytes: MIN_EVICTABLE_BYTES - 1 }), candidate({ key: "at", bytes: MIN_EVICTABLE_BYTES })],
      1 * MiB,
    );

    expect(plannedNames(p)).toEqual(["at"]);
    expect(skippedNames(p)).toEqual(["under"]);
  });

  test("an uncounted collection is reported as unknown-size, not as under the floor", () => {
    const uncounted = candidate({ key: "uncounted", type: "hash", bytes: 0, idleMs: 30 * 86_400_000 });
    const p = plan([uncounted], 1 * MiB);

    expect(planned(p)).toHaveLength(0);
    expect(p.skipped[0]?.reason).toBe(SKIP_SIZE_UNKNOWN);
    expect(p.skipped[0]?.reason).not.toContain("size floor");
  });

  test("the unknown-size skip names the repair, because the store reports 0 for an uncounted card", () => {
    const p = plan([candidate({ key: "u", type: "zset", bytes: 0 })], 1 * MiB);

    expect(p.skipped[0]?.reason).toContain("never been counted");
    expect(p.skipped[0]?.reason).toContain("count the key");
  });

  test("a cold candidate reclaims nothing and is skipped", () => {
    const p = plan([candidate({ key: "cold", tier: "cold", bytes: 1 * MiB })], 1 * MiB);

    expect(planned(p)).toHaveLength(0);
    expect(p.skipped[0]?.reason).toBe(SKIP_ALREADY_COLD);
  });

  test("a nonexistent key is skipped", () => {
    const p = plan([candidate({ key: "ghost", type: "none", bytes: 1 * MiB })], 1 * MiB);

    expect(planned(p)).toHaveLength(0);
    expect(p.skipped[0]?.reason).toBe(SKIP_MISSING);
  });

  test("a hot key written inside the churn window is excluded outright", () => {
    const churning = candidate({ key: "churning", tier: "hot", bytes: 1 * MiB, writtenWithinMs: 1_000 });
    const p = plan([churning], 1 * MiB);

    expect(planned(p)).toHaveLength(0);
    expect(p.skipped[0]?.reason).toContain("churn window");
  });

  test("a warm key written inside the churn window is still eligible because no upload is wasted", () => {
    const churning = candidate({ key: "churning", tier: "warm", bytes: 1 * MiB, writtenWithinMs: 1_000 });
    const p = plan([churning], 1 * MiB);

    expect(plannedNames(p)).toEqual(["churning"]);
    expect(p.free).toHaveLength(1);
  });
});

describe("scoring", () => {
  test("between equal-size candidates a string outranks a large hash", () => {
    const str = candidate({ key: "str", type: "string", bytes: 512 * KiB });
    const hash = candidate({ key: "hash", type: "hash", bytes: 512 * KiB });

    expect(scoreCandidate(str, DEFAULT_POLICY)).toBeGreaterThan(scoreCandidate(hash, DEFAULT_POLICY));

    const p = plan([hash, str], 512 * KiB);
    expect(plannedNames(p)).toEqual(["str"]);
  });

  test("every aggregate type loses to a string of the same size", () => {
    const aggregates: KeyType[] = ["hash", "set", "zset", "list"];
    const str = candidate({ key: "str", type: "string", bytes: 256 * KiB });

    for (const type of aggregates) {
      const agg = candidate({ key: type, type, bytes: 256 * KiB });
      expect(scoreCandidate(str, DEFAULT_POLICY)).toBeGreaterThan(scoreCandidate(agg, DEFAULT_POLICY));
    }
  });

  test("a larger aggregate is penalised more per byte than a smaller one", () => {
    const small = readAmplification("hash", 4 * KiB, 3, DEFAULT_POLICY);
    const large = readAmplification("hash", 1 * MiB, 3, DEFAULT_POLICY);

    expect(large).toBeGreaterThan(small);
    expect(readAmplification("string", 1 * MiB, 3, DEFAULT_POLICY)).toBe(1);
  });

  test("the element estimate inverts the store's byte formula exactly", () => {
    for (const keyLength of [1, 16, 64, 256]) {
      for (const elements of [1, 10, 1_000, 100_000]) {
        const bytes = elements * (keyLength + AGGREGATE_ELEMENT_BYTES);
        expect(estimatedElements(bytes, keyLength, DEFAULT_POLICY)).toBeCloseTo(elements, 6);
      }
    }
  });

  test("a long key name does not make a collection look like it has more elements", () => {
    const elements = 1_000;
    const shortKey = candidate({
      key: "s",
      type: "hash",
      bytes: elements * (1 + AGGREGATE_ELEMENT_BYTES),
    });
    const longKey = candidate({
      key: "s".repeat(200),
      type: "hash",
      bytes: elements * (200 + AGGREGATE_ELEMENT_BYTES),
    });

    expect(readAmplification("hash", shortKey.bytes, 1, DEFAULT_POLICY)).toBeCloseTo(
      readAmplification("hash", longKey.bytes, 200, DEFAULT_POLICY),
      6,
    );
  });

  test("between equal-idle candidates the larger one wins", () => {
    const small = candidate({ key: "small", bytes: 8 * KiB, idleMs: 60_000 });
    const large = candidate({ key: "large", bytes: 512 * KiB, idleMs: 60_000 });

    expect(scoreCandidate(large, DEFAULT_POLICY)).toBeGreaterThan(scoreCandidate(small, DEFAULT_POLICY));

    const p = plan([small, large], 8 * KiB);
    expect(plannedNames(p)).toEqual(["large"]);
  });

  test("one large value is preferred over many small ones covering the same bytes", () => {
    const many = Array.from({ length: 64 }, (_, i) =>
      candidate({ key: `small-${i}`, bytes: 16 * KiB, idleMs: 3_600_000 }),
    );
    const one = candidate({ key: "one", bytes: 1 * MiB, idleMs: 3_600_000 });

    const p = plan([...many, one], 1 * MiB);

    expect(plannedNames(p)).toEqual(["one"]);
    expect(planned(p)).toHaveLength(1);
  });

  test("a recently-written key loses to an equally-cold key that is not being written", () => {
    const quiet = candidate({ key: "quiet", bytes: 256 * KiB, idleMs: 3_600_000, writtenWithinMs: null });
    const churny = candidate({
      key: "churny",
      bytes: 256 * KiB,
      idleMs: 3_600_000,
      writtenWithinMs: CHURN_EXCLUSION_MS + 1_000,
    });

    expect(scoreCandidate(quiet, DEFAULT_POLICY)).toBeGreaterThan(scoreCandidate(churny, DEFAULT_POLICY));

    const p = plan([churny, quiet], 256 * KiB);
    expect(plannedNames(p)).toEqual(["quiet"]);
  });

  test("churn penalty decays toward one and read probability decays toward its floor", () => {
    expect(churnPenalty(null, DEFAULT_POLICY)).toBe(1);
    expect(churnPenalty(0, DEFAULT_POLICY)).toBeGreaterThan(churnPenalty(60_000, DEFAULT_POLICY));
    expect(churnPenalty(86_400_000, DEFAULT_POLICY)).toBeCloseTo(1, 6);

    expect(readProbability(0, DEFAULT_POLICY)).toBeCloseTo(1, 6);
    expect(readProbability(0, DEFAULT_POLICY)).toBeGreaterThan(readProbability(600_000, DEFAULT_POLICY));
    expect(readProbability(IDLE_HALF_LIFE_MS, DEFAULT_POLICY)).toBeCloseTo(
      DEFAULT_POLICY.minReadProbability + (1 - DEFAULT_POLICY.minReadProbability) / 2,
      6,
    );
  });

  test("the idle term never saturates, so days-idle keys stay strictly ordered", () => {
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    const idles = [4 * HOUR, 13 * HOUR, 15 * HOUR, DAY, 2 * DAY, 7 * DAY, 30 * DAY, 365 * DAY, 1.7e12];

    for (let i = 1; i < idles.length; i++) {
      const older = idles[i] ?? 0;
      const newer = idles[i - 1] ?? 0;
      expect(readProbability(older, DEFAULT_POLICY)).toBeLessThan(readProbability(newer, DEFAULT_POLICY));
      expect(readProbability(older, DEFAULT_POLICY)).toBeGreaterThan(DEFAULT_POLICY.minReadProbability);
    }
  });

  test("a 40-day-idle key outranks a 4-hour-idle key of equal size and type", () => {
    const fourHours = candidate({ key: "fresh", bytes: 256 * KiB, idleMs: 4 * 3_600_000 });
    const fortyDays = candidate({ key: "ancient", bytes: 256 * KiB, idleMs: 40 * 86_400_000 });

    expect(scoreCandidate(fortyDays, DEFAULT_POLICY)).toBeGreaterThan(scoreCandidate(fourHours, DEFAULT_POLICY));
    expect(plannedNames(plan([fourHours, fortyDays], 256 * KiB))).toEqual(["ancient"]);
  });

  test("idleMs breaks a score tie before key order does", () => {
    const policy: PlannerPolicy = { ...DEFAULT_POLICY, minReadProbability: 1 };
    const aaaFresh = candidate({ key: "aaa", bytes: 64 * KiB, idleMs: 60_000 });
    const zzzStale = candidate({ key: "zzz", bytes: 64 * KiB, idleMs: 40 * 86_400_000 });

    expect(scoreCandidate(aaaFresh, policy)).toBe(scoreCandidate(zzzStale, policy));
    expect(plannedNames(plan([aaaFresh, zzzStale], 64 * KiB, policy))).toEqual(["zzz"]);
  });

  test("equal-size equal-type keys idle for days are evicted oldest first, not in key order", () => {
    const DAY = 86_400_000;
    const keyspace = [
      candidate({ key: "aaa-newest", bytes: 64 * KiB, idleMs: 1 * DAY }),
      candidate({ key: "mmm-middle", bytes: 64 * KiB, idleMs: 7 * DAY }),
      candidate({ key: "zzz-oldest", bytes: 64 * KiB, idleMs: 30 * DAY }),
    ];

    const p = plan(keyspace, 64 * KiB);

    expect(plannedNames(p)).toEqual(["zzz-oldest"]);
    expect(plannedNames(plan(keyspace, 128 * KiB))).toEqual(["zzz-oldest", "mmm-middle"]);
  });

  test("the decay resolves anything the touch clock can, at every idle level", () => {
    const DAY = 86_400_000;
    const YEAR = 365 * DAY;

    for (const base of [3_600_000, DAY, 7 * DAY, 30 * DAY, YEAR, 10 * YEAR, 1.7e12]) {
      expect(readProbability(base + TOUCH_CLOCK_LAG_MS, DEFAULT_POLICY)).toBeLessThan(
        readProbability(base, DEFAULT_POLICY),
      );
    }
  });

  test("keys idle for years still rank by idle once they differ by more than the touch clock", () => {
    const now = 1.7e12;
    const keyspace = Array.from({ length: 10 }, (_, i) =>
      candidate({ key: `key-${i}`, bytes: 64 * KiB, idleMs: now - i * TOUCH_CLOCK_LAG_MS }),
    );

    expect(plannedNames(plan(keyspace, 64 * KiB))).toEqual(["key-0"]);
    expect(plannedNames(plan(keyspace, 3 * 64 * KiB))).toEqual(["key-0", "key-1", "key-2"]);
  });

  test("a colder key of equal size and type outranks a warmer one", () => {
    const warmRead = candidate({ key: "recent", bytes: 256 * KiB, idleMs: 1_000 });
    const coldRead = candidate({ key: "stale", bytes: 256 * KiB, idleMs: 86_400_000 });

    expect(scoreCandidate(coldRead, DEFAULT_POLICY)).toBeGreaterThan(scoreCandidate(warmRead, DEFAULT_POLICY));
  });

  test("a full-keyspace scan cancels out of the ranking instead of inverting it", () => {
    const keyspace: readonly Candidate[] = [
      candidate({ key: "a", type: "string", bytes: 512 * KiB, idleMs: 3_600_000 }),
      candidate({ key: "b", type: "hash", bytes: 512 * KiB, idleMs: 7_200_000 }),
      candidate({ key: "c", type: "string", bytes: 64 * KiB, idleMs: 600_000 }),
      candidate({ key: "d", type: "zset", bytes: 1 * MiB, idleMs: 86_400_000 }),
    ];

    const uniform = (idleMs: number) => keyspace.map((c) => ({ ...c, idleMs }));
    const scannedNow = plannedNames(plan(uniform(0), 4 * MiB));

    for (const idleMs of [1_000, 600_000, 86_400_000]) {
      expect(plannedNames(plan(uniform(idleMs), 4 * MiB))).toEqual(scannedNow);
    }

    const recencyFree = plannedNames(plan(keyspace, 4 * MiB, { ...DEFAULT_POLICY, minReadProbability: 1 }));
    expect(scannedNow).toEqual(recencyFree);
  });

  test("a scan cannot promote an excluded key or lift an aggregate above a same-size string", () => {
    const keyspace: readonly Candidate[] = [
      candidate({ key: "str", type: "string", bytes: 256 * KiB, idleMs: 86_400_000 }),
      candidate({ key: "hash", type: "hash", bytes: 256 * KiB, idleMs: 86_400_000 }),
      candidate({ key: "expiring", type: "string", bytes: 4 * MiB, idleMs: 86_400_000, ttlMs: 30_000 }),
    ];
    const scanned = keyspace.map((c) => ({ ...c, idleMs: 0 }));

    const p = plan(scanned, 256 * KiB);

    expect(plannedNames(p)).toEqual(["str"]);
    expect(skippedNames(p)).toEqual(["expiring"]);
  });
});

describe("plan shape", () => {
  test("the plan never exceeds what is needed to hit the target", () => {
    const p = plan(
      [
        candidate({ key: "a", bytes: 512 * KiB, idleMs: 86_400_000 }),
        candidate({ key: "b", bytes: 512 * KiB, idleMs: 86_400_000 }),
        candidate({ key: "c", bytes: 512 * KiB, idleMs: 86_400_000 }),
        candidate({ key: "d", bytes: 512 * KiB, idleMs: 86_400_000 }),
      ],
      1 * MiB,
    );

    expect(planned(p)).toHaveLength(2);
    expect(p.projectedBytesReclaimed).toBe(1 * MiB);
  });

  test("no planned eviction can be removed while still reaching the target", () => {
    const p = plan(
      [
        candidate({ key: "crumb", bytes: 8 * KiB, idleMs: 86_400_000, type: "string" }),
        candidate({ key: "slab", bytes: 1 * MiB, idleMs: 60_000, type: "hash" }),
      ],
      16 * KiB,
    );

    const total = p.projectedBytesReclaimed;
    for (const entry of planned(p)) {
      expect(total - entry.bytes).toBeLessThan(16 * KiB);
    }
  });

  test("a redundant high-score crumb is pruned when a later slab covers the target alone", () => {
    const p = plan(
      [
        candidate({ key: "crumb", bytes: 4 * KiB, type: "string", idleMs: 86_400_000 }),
        candidate({ key: "slab", bytes: 4 * MiB, type: "hash", idleMs: 1_000 }),
      ],
      1 * MiB,
    );

    expect(plannedNames(p)).toEqual(["slab"]);
  });

  test("a zero or negative target produces an empty plan that already reaches its target", () => {
    for (const target of [0, -1]) {
      const p = plan([candidate({ key: "big", bytes: 1 * MiB })], target);
      expect(p.free).toHaveLength(0);
      expect(p.upload).toHaveLength(0);
      expect(p.projectedBytesReclaimed).toBe(0);
      expect(p.reachesTarget).toBe(true);
    }
  });

  test("an empty keyspace against a real target reports failure, not success", () => {
    const p = plan([], 1 * MiB);
    expect(p.reachesTarget).toBe(false);
    expect(p.projectedBytesReclaimed).toBe(0);
    expect(p.skipped).toHaveLength(0);
  });

  test("reachesTarget is false when every candidate is excluded, and the plan is empty rather than half-hearted", () => {
    const p = plan(
      [
        candidate({ key: "expiring", bytes: 4 * MiB, ttlMs: 1_000 }),
        candidate({ key: "tiny", bytes: 64 }),
        candidate({ key: "cold", tier: "cold", bytes: 4 * MiB }),
        candidate({ key: "ghost", type: "none", bytes: 4 * MiB }),
        candidate({ key: "churning", bytes: 4 * MiB, writtenWithinMs: 100 }),
      ],
      1 * MiB,
    );

    expect(p.free).toEqual([]);
    expect(p.upload).toEqual([]);
    expect(p.projectedBytesReclaimed).toBe(0);
    expect(p.reachesTarget).toBe(false);
    expect(p.skipped).toHaveLength(5);
  });

  test("an unreachable target still plans everything eligible and reports the shortfall", () => {
    const p = plan(
      [
        candidate({ key: "a", tier: "warm", bytes: 64 * KiB }),
        candidate({ key: "b", tier: "hot", bytes: 64 * KiB }),
      ],
      10 * MiB,
    );

    expect(p.reachesTarget).toBe(false);
    expect(p.projectedBytesReclaimed).toBe(128 * KiB);
    expect(p.free).toHaveLength(1);
    expect(p.upload).toHaveLength(1);
  });

  test("every returned eviction carries a non-empty reason and every skip explains itself", () => {
    const p = plan(
      [
        candidate({ key: "planned-warm", tier: "warm", bytes: 256 * KiB }),
        candidate({ key: "planned-hot", tier: "hot", bytes: 256 * KiB }),
        candidate({ key: "skip-ttl", bytes: 256 * KiB, ttlMs: 10 }),
        candidate({ key: "skip-floor", bytes: 1 }),
        candidate({ key: "skip-cold", tier: "cold", bytes: 256 * KiB }),
        candidate({ key: "skip-none", type: "none", bytes: 256 * KiB }),
        candidate({ key: "skip-churn", bytes: 256 * KiB, writtenWithinMs: 0 }),
      ],
      512 * KiB,
    );

    expect(planned(p)).toHaveLength(2);
    for (const entry of planned(p)) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.reason).toContain(`${entry.bytes}B`);
      expect(Number.isFinite(entry.score)).toBe(true);
    }

    expect(p.skipped).toHaveLength(5);
    const reasons = new Set<string>();
    for (const entry of p.skipped) {
      expect(entry.reason.length).toBeGreaterThan(0);
      reasons.add(entry.reason);
    }
    expect(reasons.size).toBe(5);
  });

  test("ordering is deterministic and independent of input order", () => {
    const keyspace = Array.from({ length: 40 }, (_, i) =>
      candidate({
        key: `key-${i}`,
        tier: i % 3 === 0 ? "warm" : "hot",
        type: i % 2 === 0 ? "string" : "hash",
        bytes: 8 * KiB + (i % 7) * 64 * KiB,
        idleMs: (i % 5) * 600_000,
      }),
    );
    const shuffled = [...keyspace].reverse();

    expect(plannedNames(plan(shuffled, 2 * MiB))).toEqual(plannedNames(plan(keyspace, 2 * MiB)));
  });

  test("a fully tied keyspace breaks the tie deterministically but not in key order", () => {
    const tied = Array.from({ length: 200 }, (_, i) =>
      candidate({ key: `tenant:${String(i).padStart(3, "0")}:blob`, bytes: 64 * KiB, idleMs: 60_000 }),
    );

    const first = plannedNames(plan(tied, 20 * 64 * KiB));
    expect(plannedNames(plan([...tied].reverse(), 20 * 64 * KiB))).toEqual(first);

    const sortedByKey = [...tied].map((c) => name(c.key)).sort();
    const lexicographicPrefix = sortedByKey.slice(0, first.length);
    expect(first).not.toEqual(lexicographicPrefix);

    const indices = first.map((n) => Number(n.split(":")[1]));
    const span = Math.max(...indices) - Math.min(...indices);
    expect(span).toBeGreaterThan(first.length * 2);
  });

  test("the planner does not mutate its input", () => {
    const input = [
      candidate({ key: "a", bytes: 64 * KiB }),
      candidate({ key: "b", bytes: 128 * KiB }),
      candidate({ key: "c", bytes: 32 * KiB }),
    ];
    const snapshot = input.map((c) => name(c.key));

    plan(input, 1 * MiB);

    expect(input.map((c) => name(c.key))).toEqual(snapshot);
  });

  test("the same input planned twice gives the same plan", () => {
    const input = Array.from({ length: 30 }, (_, i) =>
      candidate({ key: `key-${i}`, bytes: 8 * KiB * (i + 1), idleMs: i * 30_000 }),
    );

    const first = plan(input, 1 * MiB);
    const second = plan(input, 1 * MiB);

    expect(plannedNames(second)).toEqual(plannedNames(first));
    expect(second.projectedBytesReclaimed).toBe(first.projectedBytesReclaimed);
  });
});

describe("policy is data, not hardcoding", () => {
  test("raising the ttl horizon excludes a key the default admits", () => {
    const c = candidate({ key: "a", bytes: 1 * MiB, ttlMs: 600_000 });

    expect(exclusionReason(c, DEFAULT_POLICY)).toBeNull();
    expect(exclusionReason(c, { ...DEFAULT_POLICY, ttlHorizonMs: 900_000 })).toContain("ttl horizon");
  });

  test("lowering the size floor admits a key the default rejects", () => {
    const c = candidate({ key: "a", bytes: 512 });

    expect(exclusionReason(c, DEFAULT_POLICY)).toContain("size floor");
    expect(exclusionReason(c, { ...DEFAULT_POLICY, minEvictableBytes: 256 })).toBeNull();
  });

  test("the idle half-life stays far above the touch clock's sampling lag", () => {
    expect(TOUCH_CLOCK_LAG_MS).toBe(16_000);
    expect(IDLE_HALF_LIFE_MS).toBeGreaterThan(TOUCH_CLOCK_LAG_MS * 10);
  });

  const lagDrift = (idleMs: number): number => {
    const truth = scoreCandidate(candidate({ key: "k", bytes: 256 * KiB, idleMs }), DEFAULT_POLICY);
    const lagged = scoreCandidate(
      candidate({ key: "k", bytes: 256 * KiB, idleMs: idleMs + TOUCH_CLOCK_LAG_MS }),
      DEFAULT_POLICY,
    );
    return Math.abs(lagged - truth) / truth;
  };

  test("a touch-clock-sized error is negligible wherever eviction actually happens", () => {
    for (const idleMs of [3_600_000, 4 * 3_600_000, 86_400_000, 7 * 86_400_000, 40 * 86_400_000]) {
      expect(lagDrift(idleMs)).toBeLessThan(0.005);
    }
  });

  test("the touch-clock error peaks on just-read keys, which are never evicted anyway", () => {
    expect(lagDrift(0)).toBeLessThan(0.03);
    expect(lagDrift(0)).toBeGreaterThan(lagDrift(3_600_000));

    const justRead = candidate({ key: "just-read", bytes: 256 * KiB, idleMs: 0 });
    const day = candidate({ key: "day-idle", bytes: 256 * KiB, idleMs: 86_400_000 });
    expect(plannedNames(plan([justRead, day], 256 * KiB))).toEqual(["day-idle"]);
  });

  test("zeroing the aggregate weight makes a hash score like a string", () => {
    const policy: PlannerPolicy = { ...DEFAULT_POLICY, aggregateAmplificationWeight: 0 };
    const str = candidate({ key: "s", type: "string", bytes: 256 * KiB });
    const hash = candidate({ key: "h", type: "hash", bytes: 256 * KiB });

    expect(scoreCandidate(hash, policy)).toBe(scoreCandidate(str, policy));
  });

  test("DEFAULT_POLICY exposes every threshold the scoring reads", () => {
    expect(Object.keys(DEFAULT_POLICY).sort()).toEqual(
      [
        "aggregateAmplificationWeight",
        "aggregateElementBytes",
        "churnExclusionMs",
        "churnHalfLifeMs",
        "churnPenaltyMax",
        "idleHalfLifeMs",
        "minEvictableBytes",
        "minReadProbability",
        "ttlHorizonMs",
      ].sort(),
    );
    for (const value of Object.values(DEFAULT_POLICY)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe("property: randomized keyspaces", () => {
  const mulberry32 = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  const TIERS: readonly Tier[] = ["hot", "warm", "cold"];
  const TYPES: readonly KeyType[] = ["none", "string", "hash", "list", "set", "zset"];

  const randomKeyspace = (rand: () => number, size: number): Candidate[] =>
    Array.from({ length: size }, (_, i) => ({
      key: k(`k-${i}`),
      tier: TIERS[Math.floor(rand() * TIERS.length)] ?? "hot",
      type: TYPES[Math.floor(rand() * TYPES.length)] ?? "string",
      bytes: rand() < 0.15 ? 0 : Math.floor(rand() * 2 * MiB),
      idleMs: Math.floor(rand() * 7 * 86_400_000),
      ttlMs: rand() < 0.4 ? Math.floor(rand() * 3_600_000) : null,
      writtenWithinMs: rand() < 0.4 ? Math.floor(rand() * 600_000) : null,
    }));

  test("planned bytes reach the target whenever reachesTarget, and no excluded key is ever planned", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = mulberry32(seed);
      const keyspace = randomKeyspace(rand, 1 + Math.floor(rand() * 120));
      const target = Math.floor(rand() * 40 * MiB);
      const p = plan(keyspace, target);

      const byKey = new Map(keyspace.map((c) => [name(c.key), c]));
      const sum = planned(p).reduce((acc, e) => acc + e.bytes, 0);

      expect(p.projectedBytesReclaimed).toBe(sum);
      if (p.reachesTarget) expect(sum).toBeGreaterThanOrEqual(target);

      for (const entry of planned(p)) {
        const c = byKey.get(name(entry.key));
        expect(c).toBeDefined();
        if (c === undefined) continue;
        expect(exclusionReason(c, DEFAULT_POLICY)).toBeNull();
        expect(c.tier).not.toBe("cold");
        expect(c.type).not.toBe("none");
        expect(c.bytes).toBeGreaterThanOrEqual(MIN_EVICTABLE_BYTES);
        if (c.ttlMs !== null) expect(c.ttlMs).toBeGreaterThan(TTL_HORIZON_MS);
        if (c.tier === "hot" && c.writtenWithinMs !== null) {
          expect(c.writtenWithinMs).toBeGreaterThan(CHURN_EXCLUSION_MS);
        }
        expect(entry.reason.length).toBeGreaterThan(0);
        expect(entry.bytes).toBe(c.bytes);
        expect(entry.tier).toBe(c.tier);
      }

      for (const entry of p.skipped) expect(entry.reason.length).toBeGreaterThan(0);
      expect(planned(p).length + p.skipped.length).toBeLessThanOrEqual(keyspace.length);
    }
  });

  test("every key appears at most once, and free and upload lists are disjoint and correctly tiered", () => {
    for (let seed = 500; seed < 600; seed++) {
      const rand = mulberry32(seed);
      const keyspace = randomKeyspace(rand, 1 + Math.floor(rand() * 120));
      const p = plan(keyspace, Math.floor(rand() * 40 * MiB));

      const seen = new Set(plannedNames(p));
      expect(seen.size).toBe(planned(p).length);
      expect(p.free.every((e) => e.tier === "warm")).toBe(true);
      expect(p.upload.every((e) => e.tier === "hot")).toBe(true);
    }
  });

  test("uploads appear only after every eligible free eviction is already planned", () => {
    for (let seed = 900; seed < 1_000; seed++) {
      const rand = mulberry32(seed);
      const keyspace = randomKeyspace(rand, 1 + Math.floor(rand() * 120));
      const p = plan(keyspace, Math.floor(rand() * 40 * MiB));
      if (p.upload.length === 0) continue;

      const eligibleFree = keyspace.filter(
        (c) => c.tier === "warm" && exclusionReason(c, DEFAULT_POLICY) === null,
      );
      expect(p.free).toHaveLength(eligibleFree.length);
      expect(new Set(plannedNames(p))).toEqual(
        new Set([...eligibleFree.map((c) => name(c.key)), ...p.upload.map((e) => name(e.key))]),
      );
    }
  });

  test("no planned upload is removable while the target is still reached", () => {
    for (let seed = 1_300; seed < 1_400; seed++) {
      const rand = mulberry32(seed);
      const keyspace = randomKeyspace(rand, 1 + Math.floor(rand() * 120));
      const target = Math.floor(rand() * 40 * MiB);
      const p = plan(keyspace, target);
      if (!p.reachesTarget) continue;

      for (const entry of p.upload) {
        expect(p.projectedBytesReclaimed - entry.bytes).toBeLessThan(target);
      }
      if (p.upload.length === 0) {
        for (const entry of p.free) {
          expect(p.projectedBytesReclaimed - entry.bytes).toBeLessThan(target);
        }
      }
    }
  });

  test("a stricter policy never plans a key a looser policy excluded", () => {
    const strict: PlannerPolicy = {
      ...DEFAULT_POLICY,
      ttlHorizonMs: TTL_HORIZON_MS * 4,
      minEvictableBytes: MIN_EVICTABLE_BYTES * 8,
      churnExclusionMs: CHURN_EXCLUSION_MS * 10,
    };

    for (let seed = 2_000; seed < 2_100; seed++) {
      const rand = mulberry32(seed);
      const keyspace = randomKeyspace(rand, 1 + Math.floor(rand() * 80));
      const target = Math.floor(rand() * 40 * MiB);

      const loose = plan(keyspace, target);
      const tight = plan(keyspace, target, strict);

      const looseEligible = new Set(
        keyspace.filter((c) => exclusionReason(c, DEFAULT_POLICY) === null).map((c) => name(c.key)),
      );
      for (const planName of plannedNames(tight)) {
        expect(looseEligible.has(planName)).toBe(true);
      }
      expect(tight.projectedBytesReclaimed).toBeLessThanOrEqual(
        Math.max(loose.projectedBytesReclaimed, tight.projectedBytesReclaimed),
      );
    }
  });
});
