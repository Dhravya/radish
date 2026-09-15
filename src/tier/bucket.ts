export interface ColdObject {
  readonly bytes: Uint8Array;
  readonly version: string;
}

export interface ColdBucket {
  put(objectKey: string, bytes: Uint8Array): Promise<string>;
  get(objectKey: string): Promise<ColdObject | null>;
  delete(objectKey: string): Promise<void>;
  list(prefix: string): Promise<{ objectKey: string; version: string }[]>;
}

export const COLD_OBJECT_PREFIX = "k/";

const HEX = "0123456789abcdef";

const NIBBLE_BITS = 4;
const LOW_NIBBLE = 0x0f;
const HEX_PER_BYTE = 2;
const NOT_HEX = -1;
const NOT_FOUND = -1;

export const objectKeyFor = (key: Uint8Array): string => {
  let out = COLD_OBJECT_PREFIX;
  for (const byte of key) {
    out += HEX[byte >> NIBBLE_BITS];
    out += HEX[byte & LOW_NIBBLE];
  }
  return out;
};

const hexDigit = (code: number): number => {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return NOT_HEX;
};

export const keyForObject = (objectKey: string): Uint8Array | null => {
  if (!objectKey.startsWith(COLD_OBJECT_PREFIX)) return null;
  const hex = objectKey.slice(COLD_OBJECT_PREFIX.length);
  if (hex.length % HEX_PER_BYTE !== 0) return null;

  const key = new Uint8Array(hex.length / HEX_PER_BYTE);
  for (let i = 0; i < key.length; i += 1) {
    const high = hexDigit(hex.charCodeAt(i * HEX_PER_BYTE));
    const low = hexDigit(hex.charCodeAt(i * HEX_PER_BYTE + 1));
    if (high === NOT_HEX || low === NOT_HEX) return null;
    key[i] = (high << NIBBLE_BITS) | low;
  }
  return key;
};

export type ColdBucketOp = "put" | "get" | "delete" | "list";

export interface ColdBucketFault {
  readonly op: ColdBucketOp;
  readonly objectKey?: string;
  readonly error: Error;
}

export interface ColdBucketCall {
  readonly op: ColdBucketOp;
  readonly objectKey: string;
}

export interface InMemoryColdBucket extends ColdBucket {
  readonly objects: Map<string, ColdObject>;
  readonly calls: ColdBucketCall[];
  latencyMs: number;
  failNext(fault: ColdBucketFault): void;
  failAlways(fault: ColdBucketFault): void;
  clearFaults(): void;
  forget(objectKey: string): void;
}

const matchesFault = (fault: ColdBucketFault, op: ColdBucketOp, objectKey: string): boolean =>
  fault.op === op && (fault.objectKey === undefined || fault.objectKey === objectKey);

export const inMemoryColdBucket = (): InMemoryColdBucket => {
  const objects = new Map<string, ColdObject>();
  const calls: ColdBucketCall[] = [];
  let once: ColdBucketFault[] = [];
  let always: ColdBucketFault[] = [];
  let versionSeq = 0;
  let latencyMs = 0;

  const enter = async (op: ColdBucketOp, objectKey: string): Promise<void> => {
    calls.push({ op, objectKey });
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    const pending = once.findIndex((fault) => matchesFault(fault, op, objectKey));
    if (pending !== NOT_FOUND) throw once.splice(pending, 1)[0]!.error;
    const standing = always.find((fault) => matchesFault(fault, op, objectKey));
    if (standing !== undefined) throw standing.error;
  };

  return {
    objects,
    calls,

    get latencyMs() {
      return latencyMs;
    },
    set latencyMs(value: number) {
      latencyMs = value;
    },

    failNext(fault) {
      once.push(fault);
    },
    failAlways(fault) {
      always.push(fault);
    },
    clearFaults() {
      once = [];
      always = [];
    },
    forget(objectKey) {
      objects.delete(objectKey);
    },

    async put(objectKey, bytes) {
      await enter("put", objectKey);
      versionSeq += 1;
      const version = `v${versionSeq}`;
      objects.set(objectKey, { bytes: bytes.slice(), version });
      return version;
    },

    async get(objectKey) {
      await enter("get", objectKey);
      const found = objects.get(objectKey);
      return found === undefined ? null : { bytes: found.bytes.slice(), version: found.version };
    },

    async delete(objectKey) {
      await enter("delete", objectKey);
      objects.delete(objectKey);
    },

    async list(prefix) {
      await enter("list", prefix);
      const out: { objectKey: string; version: string }[] = [];
      for (const [objectKey, held] of objects) {
        if (objectKey.startsWith(prefix)) out.push({ objectKey, version: held.version });
      }
      return out.sort((a, b) => (a.objectKey < b.objectKey ? -1 : a.objectKey > b.objectKey ? 1 : 0));
    },
  };
};

interface R2ObjectLike {
  readonly key: string;
  readonly version: string;
}

interface R2BodyLike extends R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2ListLike {
  readonly objects: R2ObjectLike[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

interface R2BucketLike {
  put(objectKey: string, value: ArrayBuffer | ArrayBufferView): Promise<R2ObjectLike | null>;
  get(objectKey: string): Promise<R2BodyLike | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2ListLike>;
}

const R2_LIST_PAGE = 1000;

const R2_PUT_REFUSED = "radish: R2 refused the put and returned no object";

export const r2ColdBucket = (bucket: R2BucketLike): ColdBucket => ({
  async put(objectKey, bytes) {
    const written = await bucket.put(objectKey, bytes);
    if (written === null) throw new Error(`${R2_PUT_REFUSED}: ${objectKey}`);
    return written.version;
  },

  async get(objectKey) {
    const object = await bucket.get(objectKey);
    if (object === null) return null;
    return { bytes: new Uint8Array(await object.arrayBuffer()), version: object.version };
  },

  async delete(objectKey) {
    await bucket.delete(objectKey);
  },

  async list(prefix) {
    const out: { objectKey: string; version: string }[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await bucket.list(
        cursor === undefined
          ? { prefix, limit: R2_LIST_PAGE }
          : { prefix, limit: R2_LIST_PAGE, cursor },
      );
      for (const object of page.objects) out.push({ objectKey: object.key, version: object.version });
      if (!page.truncated || page.cursor === undefined) return out;
      cursor = page.cursor;
    }
  },
});
