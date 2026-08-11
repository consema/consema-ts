/**
 * Pinned Python 3.14 / Unicode 16.0 default `optionxform` semantics.
 *
 * authority: crates/consema-ini/src/python_case.rs — the LOWER_RANGES table
 * (:9-99) and LOWER_SINGLES table (:101-199) are transcribed verbatim
 * (generated from Rust 1.85's Unicode 16.0 unconditional full lowercase
 * mappings and compacted into ordered ranges and exceptions; keeping the
 * data in the crate prevents compiler Unicode-table upgrades from changing
 * an already selected INI profile); the special case U+0130 LATIN CAPITAL
 * LETTER I WITH DOT ABOVE maps to "i" + U+0307 (:205-207); the algorithm is
 * `optionxform` (:201-215) and `simple_lowercase` (:217-232).
 *
 * The profile contract that consumes this table is RFC 0009 §7
 * (docs/rfcs/0009-ini-family-profiles-v1.md:235-239): option comparison and
 * duplicate detection use the Python 3.14 default lowercase `optionxform`,
 * pinned to Unicode 16.0 independently of the host runtime's Unicode
 * tables; original option spelling is still retained.
 *
 * Design (TypeScript-idiomatic): frozen tuples with the same layout as the
 * Rust slices; lookup is a binary search over the ordered range table
 * (partition-point semantics, python_case.rs:218-226) followed by a binary
 * search over the exception singles.
 */

/** (start, end, step, delta) ordered lowercase ranges (python_case.rs:9-99). */
const LOWER_RANGES: readonly (readonly [number, number, number, number])[] = [
  [0x000041, 0x00005a, 1, 32],
  [0x0000c0, 0x0000d6, 1, 32],
  [0x0000d8, 0x0000de, 1, 32],
  [0x000100, 0x00012e, 2, 1],
  [0x000132, 0x000136, 2, 1],
  [0x000139, 0x000147, 2, 1],
  [0x00014a, 0x000176, 2, 1],
  [0x000179, 0x00017d, 2, 1],
  [0x000182, 0x000184, 2, 1],
  [0x000189, 0x00018a, 1, 205],
  [0x0001a0, 0x0001a4, 2, 1],
  [0x0001b1, 0x0001b2, 1, 217],
  [0x0001b3, 0x0001b5, 2, 1],
  [0x0001cb, 0x0001db, 2, 1],
  [0x0001de, 0x0001ee, 2, 1],
  [0x0001f2, 0x0001f4, 2, 1],
  [0x0001f8, 0x00021e, 2, 1],
  [0x000222, 0x000232, 2, 1],
  [0x000246, 0x00024e, 2, 1],
  [0x000370, 0x000372, 2, 1],
  [0x000388, 0x00038a, 1, 37],
  [0x00038e, 0x00038f, 1, 63],
  [0x000391, 0x0003a1, 1, 32],
  [0x0003a3, 0x0003ab, 1, 32],
  [0x0003d8, 0x0003ee, 2, 1],
  [0x0003fd, 0x0003ff, 1, -130],
  [0x000400, 0x00040f, 1, 80],
  [0x000410, 0x00042f, 1, 32],
  [0x000460, 0x000480, 2, 1],
  [0x00048a, 0x0004be, 2, 1],
  [0x0004c1, 0x0004cd, 2, 1],
  [0x0004d0, 0x00052e, 2, 1],
  [0x000531, 0x000556, 1, 48],
  [0x0010a0, 0x0010c5, 1, 7264],
  [0x0013a0, 0x0013ef, 1, 38864],
  [0x0013f0, 0x0013f5, 1, 8],
  [0x001c90, 0x001cba, 1, -3008],
  [0x001cbd, 0x001cbf, 1, -3008],
  [0x001e00, 0x001e94, 2, 1],
  [0x001ea0, 0x001efe, 2, 1],
  [0x001f08, 0x001f0f, 1, -8],
  [0x001f18, 0x001f1d, 1, -8],
  [0x001f28, 0x001f2f, 1, -8],
  [0x001f38, 0x001f3f, 1, -8],
  [0x001f48, 0x001f4d, 1, -8],
  [0x001f59, 0x001f5f, 2, -8],
  [0x001f68, 0x001f6f, 1, -8],
  [0x001f88, 0x001f8f, 1, -8],
  [0x001f98, 0x001f9f, 1, -8],
  [0x001fa8, 0x001faf, 1, -8],
  [0x001fb8, 0x001fb9, 1, -8],
  [0x001fba, 0x001fbb, 1, -74],
  [0x001fc8, 0x001fcb, 1, -86],
  [0x001fd8, 0x001fd9, 1, -8],
  [0x001fda, 0x001fdb, 1, -100],
  [0x001fe8, 0x001fe9, 1, -8],
  [0x001fea, 0x001feb, 1, -112],
  [0x001ff8, 0x001ff9, 1, -128],
  [0x001ffa, 0x001ffb, 1, -126],
  [0x002160, 0x00216f, 1, 16],
  [0x0024b6, 0x0024cf, 1, 26],
  [0x002c00, 0x002c2f, 1, 48],
  [0x002c67, 0x002c6b, 2, 1],
  [0x002c7e, 0x002c7f, 1, -10815],
  [0x002c80, 0x002ce2, 2, 1],
  [0x002ceb, 0x002ced, 2, 1],
  [0x00a640, 0x00a66c, 2, 1],
  [0x00a680, 0x00a69a, 2, 1],
  [0x00a722, 0x00a72e, 2, 1],
  [0x00a732, 0x00a76e, 2, 1],
  [0x00a779, 0x00a77b, 2, 1],
  [0x00a77e, 0x00a786, 2, 1],
  [0x00a790, 0x00a792, 2, 1],
  [0x00a796, 0x00a7a8, 2, 1],
  [0x00a7b4, 0x00a7c2, 2, 1],
  [0x00a7c7, 0x00a7c9, 2, 1],
  [0x00a7d6, 0x00a7da, 2, 1],
  [0x00ff21, 0x00ff3a, 1, 32],
  [0x010400, 0x010427, 1, 40],
  [0x0104b0, 0x0104d3, 1, 40],
  [0x010570, 0x01057a, 1, 39],
  [0x01057c, 0x01058a, 1, 39],
  [0x01058c, 0x010592, 1, 39],
  [0x010594, 0x010595, 1, 39],
  [0x010c80, 0x010cb2, 1, 64],
  [0x010d50, 0x010d65, 1, 32],
  [0x0118a0, 0x0118bf, 1, 32],
  [0x016e40, 0x016e5f, 1, 32],
  [0x01e900, 0x01e921, 1, 34],
];

/** (upper, lower) exception singles (python_case.rs:101-199). */
const LOWER_SINGLES: readonly (readonly [number, number])[] = [
  [0x000178, 0x0000ff],
  [0x000181, 0x000253],
  [0x000186, 0x000254],
  [0x000187, 0x000188],
  [0x00018b, 0x00018c],
  [0x00018e, 0x0001dd],
  [0x00018f, 0x000259],
  [0x000190, 0x00025b],
  [0x000191, 0x000192],
  [0x000193, 0x000260],
  [0x000194, 0x000263],
  [0x000196, 0x000269],
  [0x000197, 0x000268],
  [0x000198, 0x000199],
  [0x00019c, 0x00026f],
  [0x00019d, 0x000272],
  [0x00019f, 0x000275],
  [0x0001a6, 0x000280],
  [0x0001a7, 0x0001a8],
  [0x0001a9, 0x000283],
  [0x0001ac, 0x0001ad],
  [0x0001ae, 0x000288],
  [0x0001af, 0x0001b0],
  [0x0001b7, 0x000292],
  [0x0001b8, 0x0001b9],
  [0x0001bc, 0x0001bd],
  [0x0001c4, 0x0001c6],
  [0x0001c5, 0x0001c6],
  [0x0001c7, 0x0001c9],
  [0x0001c8, 0x0001c9],
  [0x0001ca, 0x0001cc],
  [0x0001f1, 0x0001f3],
  [0x0001f6, 0x000195],
  [0x0001f7, 0x0001bf],
  [0x000220, 0x00019e],
  [0x00023a, 0x002c65],
  [0x00023b, 0x00023c],
  [0x00023d, 0x00019a],
  [0x00023e, 0x002c66],
  [0x000241, 0x000242],
  [0x000243, 0x000180],
  [0x000244, 0x000289],
  [0x000245, 0x00028c],
  [0x000376, 0x000377],
  [0x00037f, 0x0003f3],
  [0x000386, 0x0003ac],
  [0x00038c, 0x0003cc],
  [0x0003cf, 0x0003d7],
  [0x0003f4, 0x0003b8],
  [0x0003f7, 0x0003f8],
  [0x0003f9, 0x0003f2],
  [0x0003fa, 0x0003fb],
  [0x0004c0, 0x0004cf],
  [0x0010c7, 0x002d27],
  [0x0010cd, 0x002d2d],
  [0x001c89, 0x001c8a],
  [0x001e9e, 0x0000df],
  [0x001fbc, 0x001fb3],
  [0x001fcc, 0x001fc3],
  [0x001fec, 0x001fe5],
  [0x001ffc, 0x001ff3],
  [0x002126, 0x0003c9],
  [0x00212a, 0x00006b],
  [0x00212b, 0x0000e5],
  [0x002132, 0x00214e],
  [0x002183, 0x002184],
  [0x002c60, 0x002c61],
  [0x002c62, 0x00026b],
  [0x002c63, 0x001d7d],
  [0x002c64, 0x00027d],
  [0x002c6d, 0x000251],
  [0x002c6e, 0x000271],
  [0x002c6f, 0x000250],
  [0x002c70, 0x000252],
  [0x002c72, 0x002c73],
  [0x002c75, 0x002c76],
  [0x002cf2, 0x002cf3],
  [0x00a77d, 0x001d79],
  [0x00a78b, 0x00a78c],
  [0x00a78d, 0x000265],
  [0x00a7aa, 0x000266],
  [0x00a7ab, 0x00025c],
  [0x00a7ac, 0x000261],
  [0x00a7ad, 0x00026c],
  [0x00a7ae, 0x00026a],
  [0x00a7b0, 0x00029e],
  [0x00a7b1, 0x000287],
  [0x00a7b2, 0x00029d],
  [0x00a7b3, 0x00ab53],
  [0x00a7c4, 0x00a794],
  [0x00a7c5, 0x000282],
  [0x00a7c6, 0x001d8e],
  [0x00a7cb, 0x000264],
  [0x00a7cc, 0x00a7cd],
  [0x00a7d0, 0x00a7d1],
  [0x00a7dc, 0x00019b],
  [0x00a7f5, 0x00a7f6],
];

/** The Python 3.14 default optionxform pinned to Unicode 16.0 (python_case.rs:201-215). */
export function optionxform(value: string): string {
  let output = '';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code === 0x000130) {
      output += 'i';
      output += '\u{0307}';
    } else {
      const mapped = simpleLowercase(code);
      output += mapped === null ? character : String.fromCodePoint(mapped);
    }
  }
  return output;
}

/** One-scalar Unicode 16.0 unconditional full-lowercase mapping (python_case.rs:217-232). */
function simpleLowercase(code: number): number | null {
  // Partition point: the last range whose start is <= code.
  let low = 0;
  let high = LOWER_RANGES.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (LOWER_RANGES[mid][0] <= code) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  if (low > 0) {
    const [start, end, step, delta] = LOWER_RANGES[low - 1];
    if (code <= end && (code - start) % step === 0) {
      return code + delta;
    }
  }
  let singleLow = 0;
  let singleHigh = LOWER_SINGLES.length;
  while (singleLow < singleHigh) {
    const mid = (singleLow + singleHigh) >>> 1;
    if (LOWER_SINGLES[mid][0] < code) {
      singleLow = mid + 1;
    } else {
      singleHigh = mid;
    }
  }
  if (singleLow < LOWER_SINGLES.length && LOWER_SINGLES[singleLow][0] === code) {
    return LOWER_SINGLES[singleLow][1];
  }
  return null;
}
