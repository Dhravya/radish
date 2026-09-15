/* Ported from Redis deps/fpconv (fpconv_dtoa.c, fpconv_powers.h).
 *
 * Copyright (c) 2021, Redis Labs
 * Copyright (c) 2013-2019, night-shift <as.smljk at gmail dot com>
 * Copyright (c) 2009, Florian Loitsch <florian.loitsch at inria dot fr>
 * All rights reserved.
 *
 * Distributed under the Boost Software License, Version 1.0, whose terms
 * require this notice to be retained in source distributions:
 * https://www.boost.org/LICENSE_1_0.txt
 */

interface Fp {
  frac: bigint;
  exp: number;
}

const MASK_64 = (1n << 64n) - 1n;
const MASK_32 = 0xffffffffn;
const FRACTION = 0x000fffffffffffffn;
const EXPONENT = 0x7ff0000000000000n;
const HIDDEN_BIT = 0x0010000000000000n;
const SIGN = 0x8000000000000000n;
const EXPONENT_BIAS = 1023 + 52;

const DIGIT_ZERO = 0x30;

const TENS: readonly bigint[] = [
  10000000000000000000n,
  1000000000000000000n,
  100000000000000000n,
  10000000000000000n,
  1000000000000000n,
  100000000000000n,
  10000000000000n,
  1000000000000n,
  100000000000n,
  10000000000n,
  1000000000n,
  100000000n,
  10000000n,
  1000000n,
  100000n,
  10000n,
  1000n,
  100n,
  10n,
  1n,
];

const POWERS_TEN: readonly (readonly [bigint, number])[] = [
  [18054884314459144840n, -1220],
  [13451937075301367670n, -1193],
  [10022474136428063862n, -1166],
  [14934650266808366570n, -1140],
  [11127181549972568877n, -1113],
  [16580792590934885855n, -1087],
  [12353653155963782858n, -1060],
  [18408377700990114895n, -1034],
  [13715310171984221708n, -1007],
  [10218702384817765436n, -980],
  [15227053142812498563n, -954],
  [11345038669416679861n, -927],
  [16905424996341287883n, -901],
  [12595523146049147757n, -874],
  [9384396036005875287n, -847],
  [13983839803942852151n, -821],
  [10418772551374772303n, -794],
  [15525180923007089351n, -768],
  [11567161174868858868n, -741],
  [17236413322193710309n, -715],
  [12842128665889583758n, -688],
  [9568131466127621947n, -661],
  [14257626930069360058n, -635],
  [10622759856335341974n, -608],
  [15829145694278690180n, -582],
  [11793632577567316726n, -555],
  [17573882009934360870n, -529],
  [13093562431584567480n, -502],
  [9755464219737475723n, -475],
  [14536774485912137811n, -449],
  [10830740992659433045n, -422],
  [16139061738043178685n, -396],
  [12024538023802026127n, -369],
  [17917957937422433684n, -343],
  [13349918974505688015n, -316],
  [9946464728195732843n, -289],
  [14821387422376473014n, -263],
  [11042794154864902060n, -236],
  [16455045573212060422n, -210],
  [12259964326927110867n, -183],
  [18268770466636286478n, -157],
  [13611294676837538539n, -130],
  [10141204801825835212n, -103],
  [15111572745182864684n, -77],
  [11258999068426240000n, -50],
  [16777216000000000000n, -24],
  [12500000000000000000n, 3],
  [9313225746154785156n, 30],
  [13877787807814456755n, 56],
  [10339757656912845936n, 83],
  [15407439555097886824n, 109],
  [11479437019748901445n, 136],
  [17105694144590052135n, 162],
  [12744735289059618216n, 189],
  [9495567745759798747n, 216],
  [14149498560666738074n, 242],
  [10542197943230523224n, 269],
  [15709099088952724970n, 295],
  [11704190886730495818n, 322],
  [17440603504673385349n, 348],
  [12994262207056124023n, 375],
  [9681479787123295682n, 402],
  [14426529090290212157n, 428],
  [10748601772107342003n, 455],
  [16016664761464807395n, 481],
  [11933345169920330789n, 508],
  [17782069995880619868n, 534],
  [13248674568444952270n, 561],
  [9871031767461413346n, 588],
  [14708983551653345445n, 614],
  [10959046745042015199n, 641],
  [16330252207878254650n, 667],
  [12166986024289022870n, 694],
  [18130221999122236476n, 720],
  [13508068024458167312n, 747],
  [10064294952495520794n, 774],
  [14996968138956309548n, 800],
  [11173611982879273257n, 827],
  [16649979327439178909n, 853],
  [12405201291620119593n, 880],
  [9242595204427927429n, 907],
  [13772540099066387757n, 933],
  [10261342003245940623n, 960],
  [15290591125556738113n, 986],
  [11392378155556871081n, 1013],
  [16975966327722178521n, 1039],
  [12648080533535911531n, 1066],
];

const FIRST_POWER = -348;
const STEP_POWERS = 8;
const POWER_COUNT = 87;
const EXP_MAX = -32;
const EXP_MIN = -60;
const LOG10_OF_TWO = 0.30102999566398114;

const PROBE = new DataView(new ArrayBuffer(8));

const bitsOf = (value: number): bigint => {
  PROBE.setFloat64(0, value);
  return PROBE.getBigUint64(0);
};

const findCachedPow10 = (exp: number): { power: Fp; k: number } => {
  const approx = Math.trunc(-(exp + POWER_COUNT) * LOG10_OF_TWO);
  let idx = Math.trunc((approx - FIRST_POWER) / STEP_POWERS);

  for (;;) {
    const entry = POWERS_TEN[idx]!;
    const current = exp + entry[1] + 64;
    if (current < EXP_MIN) {
      idx += 1;
      continue;
    }
    if (current > EXP_MAX) {
      idx -= 1;
      continue;
    }
    return { power: { frac: entry[0], exp: entry[1] }, k: FIRST_POWER + idx * STEP_POWERS };
  }
};

const buildFp = (bits: bigint): Fp => {
  let frac = bits & FRACTION;
  let exp = Number((bits & EXPONENT) >> 52n);

  if (exp !== 0) {
    frac += HIDDEN_BIT;
    exp -= EXPONENT_BIAS;
  } else {
    exp = -EXPONENT_BIAS + 1;
  }

  return { frac, exp };
};

const normalize = (fp: Fp): Fp => {
  let { frac, exp } = fp;
  while ((frac & HIDDEN_BIT) === 0n) {
    frac <<= 1n;
    exp -= 1;
  }
  const shift = 64 - 52 - 1;
  return { frac: (frac << BigInt(shift)) & MASK_64, exp: exp - shift };
};

const normalizedBoundaries = (fp: Fp): { lower: Fp; upper: Fp } => {
  let upperFrac = ((fp.frac << 1n) + 1n) & MASK_64;
  let upperExp = fp.exp - 1;

  while ((upperFrac & (HIDDEN_BIT << 1n)) === 0n) {
    upperFrac = (upperFrac << 1n) & MASK_64;
    upperExp -= 1;
  }

  const upperShift = 64 - 52 - 2;
  upperFrac = (upperFrac << BigInt(upperShift)) & MASK_64;
  upperExp -= upperShift;

  const lowerShift = fp.frac === HIDDEN_BIT ? 2n : 1n;
  const lowerFrac = ((fp.frac << lowerShift) - 1n) & MASK_64;
  const lowerExp = fp.exp - Number(lowerShift);

  return {
    lower: { frac: (lowerFrac << BigInt(lowerExp - upperExp)) & MASK_64, exp: upperExp },
    upper: { frac: upperFrac, exp: upperExp },
  };
};

const multiply = (a: Fp, b: Fp): Fp => {
  const ahBl = (a.frac >> 32n) * (b.frac & MASK_32);
  const alBh = (a.frac & MASK_32) * (b.frac >> 32n);
  const alBl = (a.frac & MASK_32) * (b.frac & MASK_32);
  const ahBh = (a.frac >> 32n) * (b.frac >> 32n);

  const tmp = ((ahBl & MASK_32) + (alBh & MASK_32) + (alBl >> 32n) + (1n << 31n)) & MASK_64;

  return {
    frac: (ahBh + (ahBl >> 32n) + (alBh >> 32n) + (tmp >> 32n)) & MASK_64,
    exp: a.exp + b.exp + 64,
  };
};

const roundDigit = (
  digits: number[],
  ndigits: number,
  delta: bigint,
  start: bigint,
  kappa: bigint,
  frac: bigint,
): void => {
  let rem = start;
  for (;;) {
    const ahead = (rem + kappa) & MASK_64;
    const closerFromBelow = ((frac - rem) & MASK_64) > ((ahead - frac) & MASK_64);
    if (rem >= frac || ((delta - rem) & MASK_64) < kappa) return;
    if (ahead >= frac && !closerFromBelow) return;
    digits[ndigits - 1] = digits[ndigits - 1]! - 1;
    rem = ahead;
  }
};

interface Digits {
  ndigits: number;
  k: number;
}

const generateDigits = (fp: Fp, upper: Fp, lower: Fp, digits: number[], start: number): Digits => {
  const wfrac = (upper.frac - fp.frac) & MASK_64;
  let delta = (upper.frac - lower.frac) & MASK_64;

  const oneShift = BigInt(-upper.exp);
  const oneFrac = 1n << oneShift;

  let part1 = upper.frac >> oneShift;
  let part2 = upper.frac & (oneFrac - 1n);

  let idx = 0;
  let kappa = 10;
  let k = start;

  for (let power = 10; kappa > 0; power += 1) {
    const div = TENS[power]!;
    const digit = part1 / div;

    if (digit !== 0n || idx !== 0) {
      digits[idx] = Number(digit) + DIGIT_ZERO;
      idx += 1;
    }

    part1 -= digit * div;
    kappa -= 1;

    const remainder = ((part1 << oneShift) + part2) & MASK_64;
    if (remainder <= delta) {
      roundDigit(digits, idx, delta, remainder, (div << oneShift) & MASK_64, wfrac);
      return { ndigits: idx, k: k + kappa };
    }
  }

  let unit = 18;
  for (;;) {
    part2 = (part2 * 10n) & MASK_64;
    delta = (delta * 10n) & MASK_64;
    kappa -= 1;

    const digit = part2 >> oneShift;
    if (digit !== 0n || idx !== 0) {
      digits[idx] = Number(digit) + DIGIT_ZERO;
      idx += 1;
    }

    part2 &= oneFrac - 1n;
    if (part2 < delta) {
      roundDigit(digits, idx, delta, part2, oneFrac, (wfrac * TENS[unit]!) & MASK_64);
      return { ndigits: idx, k: k + kappa };
    }

    unit -= 1;
  }
};

const grisu2 = (bits: bigint, digits: number[]): Digits => {
  const value = buildFp(bits);
  const { lower, upper } = normalizedBoundaries(value);
  const normalized = normalize(value);
  const { power, k } = findCachedPow10(upper.exp);

  const scaled = multiply(normalized, power);
  const scaledUpper = multiply(upper, power);
  const scaledLower = multiply(lower, power);

  scaledLower.frac = (scaledLower.frac + 1n) & MASK_64;
  scaledUpper.frac = (scaledUpper.frac - 1n) & MASK_64;

  return generateDigits(scaled, scaledUpper, scaledLower, digits, -k);
};

const MAX_SCIENTIFIC_DIGITS = 18;
const PLAIN_INTEGER_SLACK = 7;

const text = (digits: readonly number[], from: number, count: number): string =>
  String.fromCharCode(...digits.slice(from, from + count));

const emitDigits = (digits: readonly number[], count: number, k: number, negative: boolean): string => {
  const exp = Math.abs(k + count - 1);

  if (k >= 0 && exp < count + PLAIN_INTEGER_SLACK) {
    return text(digits, 0, count) + "0".repeat(k);
  }

  if (k < 0 && (k > -PLAIN_INTEGER_SLACK || exp < 4)) {
    const offset = count - Math.abs(k);
    if (offset <= 0) {
      return `0.${"0".repeat(-offset)}${text(digits, 0, count)}`;
    }
    return `${text(digits, 0, offset)}.${text(digits, offset, count - offset)}`;
  }

  const shown = Math.min(count, MAX_SCIENTIFIC_DIGITS - (negative ? 1 : 0));
  const head = text(digits, 0, 1);
  const tail = shown > 1 ? `.${text(digits, 1, shown - 1)}` : "";
  const sign = k + shown - 1 < 0 ? "-" : "+";

  return `${head}${tail}e${sign}${exp.toString()}`;
};

const LONG_LONG_HALF_MAX = 4611686018427387904;

const printsAsInteger = (value: number): boolean =>
  value >= -LONG_LONG_HALF_MAX && value <= LONG_LONG_HALF_MAX && Number.isInteger(value);

export const formatDouble = (value: number): string => {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  if (printsAsInteger(value)) return BigInt(value).toString();

  const bits = bitsOf(value);
  const negative = (bits & SIGN) !== 0n;
  const digits: number[] = [];
  const { ndigits, k } = grisu2(bits, digits);

  return (negative ? "-" : "") + emitDigits(digits, ndigits, k, negative);
};
