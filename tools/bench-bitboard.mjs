// Chunked, bit-parallel Game of Life stepper + benchmark.
//
//   node tools/bench-bitboard.mjs            # correctness suite + benchmarks
//   node tools/bench-bitboard.mjs --quick    # correctness only
//
// WHY A CUSTOM STEPPER: the app's current core is a sparse `Map<"x,y", 1>`.
// That is excellent for a few hundred live cells and poor once the population
// climbs, because every generation allocates two Maps holding ~9n string keys.
// This file measures how far a bitboard gets us in the same runtime (plain JS,
// no WASM, no build step) and doubles as a reference the app can port.
//
// REPRESENTATION
//   The universe is a Map<chunkKey, Uint32Array(32)>.
//   A chunk covers 32x32 cells. rows[r] holds the 32 cells of local row r,
//   with bit b = local column b (bit 0 = leftmost). Cells outside every chunk
//   are dead, so the universe stays unbounded and sparse: cost is proportional
//   to the *occupied* area, not to the viewport.
//
// STEP
//   Row r's eight neighbour planes come from shifts:
//     up-left  = (u << 1) | uLeftCarry     where u = row (r-1)
//     up-right = (u >>> 1) | uRightCarry
//   The left/right carries are bit 31 / bit 0 of the horizontally adjacent
//   chunk's word for the same global row; the up/down words come from the
//   vertically adjacent chunk at the seam. Nothing wraps — a cell on one edge
//   of a chunk reads its real neighbour from the next chunk, so borders are
//   exact and a pattern can straddle any number of chunks.
//
//   The eight one-bit planes are then summed *bit-sliced*: a carry-save adder
//   tree (4 half adders + 4 full adders) compresses eight one-bit inputs into
//   the four bits of the per-cell neighbour count, in parallel across all 32
//   columns of the row. No per-cell loop, no 2^9 lookup table: 8 planes in,
//   count bits out. `compress8` is verified exhaustively over all 256 inputs.
//
//   born/survive sets then become masks over the count bits:
//     born    = OR over k in rule.born    of (count == k)
//     survive = OR over k in rule.survive of (count == k)
//     next    = (born & ~alive) | (survive & alive)
//
//   Rules with 0 in the born set (B0/...) are rejected: they fill the infinite
//   plane, which the sparse representation cannot express.

import { performance } from 'node:perf_hooks';
import { PATTERNS, RULE_LIFE, MapCore, parseRule, referenceStep, randomSoup,
         gliderGrid, gunArray, shapeSig, bench, table, ms, cellsPerSec, memMB } from './bench-common.mjs';

const CHUNK = 32;
const CHUNK_BITS = 5;   // 32 == 1 << 5
const MASK = CHUNK - 1;

// Chunks are indexed by a single number:
//   key = (cx + CB) * STRIDE + (cy + CB)
// Numeric keys are 4-10x faster to hash than the equivalent "cx,cy" string, and
// `STRIDE` doubles as the key delta for one chunk in x, so neighbour lookups in
// the step loop are pure addition — no string building, no allocation. The bias
// keeps every key non-negative, which makes encode/decode exact with plain `/`
// and `%`. Compatibility range is |cx|,|cy| < 2^19 chunks, i.e. +/-16.7M cells
// per axis; `set()` rejects coordinates beyond that instead of wrapping.
const CB = 1 << 19;
const STRIDE = 1 << 20;

/** Chunk index -> key. Throws outside the +/-16.7M cell compatibility range. */
export function encodeChunk(cx, cy) {
  if (cx <= -CB || cx >= CB || cy <= -CB || cy >= CB) {
    throw new RangeError(`BitboardUniverse: chunk (${cx},${cy}) is outside the +/-${CB * CHUNK} cell working range`);
  }
  return (cx + CB) * STRIDE + (cy + CB);
}

function decodeChunk(key) {
  const t = key % STRIDE;
  return [((key - t) / STRIDE) - CB, t - CB];
}

/** decodeChunk, exported for the round-trip test. */
export function decodeChunkTest(key) {
  return decodeChunk(key);
}

// ---------------------------------------------------------------------------
// Bit-sliced 8-input counter
// ---------------------------------------------------------------------------

// full adder: x + y + z = sum + 2*carry
const faCarry = (x, y, z) => (x & y) | (z & (x ^ y));

/**
 * Count eight one-bit planes per column, bit-sliced. Writes the four count
 * planes (weights 1, 2, 4, 8) into module scratch variables `_s0.._s3` so the
 * caller can read them without an allocation; callers must consume them before
 * the next call. Exported for the exhaustive 256-input test below.
 */
let _s0 = 0, _s1 = 0, _s2 = 0, _s3 = 0;
function compress8(a, b, c, d, e, f, g, h) {
  // four half adders: 8 inputs -> 4 weight-1 terms + 4 weight-2 terms
  const t1 = a ^ b, c1 = a & b;
  const t2 = c ^ d, c2 = c & d;
  const t3 = e ^ f, c3 = e & f;
  const t4 = g ^ h, c4 = g & h;
  // reduce the four weight-1 terms to one
  const t5 = t1 ^ t2, c5 = t1 & t2;
  const t6 = t3 ^ t4, c6 = t3 & t4;
  _s0 = t5 ^ t6;
  const c7 = t5 & t6;
  // seven weight-2 terms (sum <= 4) -> weight-2 / weight-4 terms
  const t7 = c1 ^ c2, c8 = c1 & c2;
  const t8 = c3 ^ c4, c9 = c3 & c4;
  const t9 = c5 ^ c6 ^ c7, c10 = faCarry(c5, c6, c7);
  _s1 = t7 ^ t8 ^ t9;
  const c11 = faCarry(t7, t8, t9);
  // four weight-4 terms (sum <= 4) -> weight-4 / weight-8 terms
  const e1 = c8 ^ c9, f1 = c8 & c9;
  const e2 = c10 ^ c11, f2 = c10 & c11;
  _s2 = e1 ^ e2;
  const f3 = e1 & e2;
  // three weight-8 terms: only reachable for a count of 8
  _s3 = f1 ^ f2 ^ f3;
}

/** Read the count planes set by the last compress8 call. */
export function lastCountPlanes() {
  return [_s0, _s1, _s2, _s3];
}

function popcount(v) {
  v = v - ((v >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  return ((v + (v >> 4) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

// Scratch buffers, reused per chunk. `_U` holds the centre column's 34 words:
// index 0 is the row borrowed from the chunk above, 1..32 are this chunk's own
// rows, 33 is the row borrowed from the chunk below. `_WL` / `_EL` hold the
// *already shifted* edge bits the horizontal neighbours contribute to each of
// those rows, so the row loop needs no per-row branches or copies.
const _U = new Uint32Array(CHUNK + 2);
const _WL = new Uint32Array(CHUNK + 2);
const _EL = new Uint32Array(CHUNK + 2);
const ZERO = new Uint32Array(CHUNK);

/**
 * Gather everything chunk `key` needs from its 8 neighbours: the centre
 * column's words plus the horizontal edge bits, at all 34 rows that can matter.
 */
function gather(key, chunks) {
  // STRIDE is the chunk-x step, 1 is the chunk-y step.
  const n = chunks.get(key - 1) ?? ZERO;
  const here = chunks.get(key) ?? ZERO;
  const s = chunks.get(key + 1) ?? ZERO;
  const nw = chunks.get(key - STRIDE - 1) ?? ZERO;
  const w = chunks.get(key - STRIDE) ?? ZERO;
  const sw = chunks.get(key - STRIDE + 1) ?? ZERO;
  const ne = chunks.get(key + STRIDE - 1) ?? ZERO;
  const e = chunks.get(key + STRIDE) ?? ZERO;
  const se = chunks.get(key + STRIDE + 1) ?? ZERO;
  for (let i = 0; i < CHUNK; i++) {
    _U[i + 1] = here[i];
    _WL[i + 1] = w[i] >>> 31;   // west chunk's cell immediately left of bit 0
    _EL[i + 1] = e[i] << 31;    // east chunk's cell immediately right of bit 31
  }
  _U[0] = n[CHUNK - 1]; _WL[0] = nw[CHUNK - 1] >>> 31; _EL[0] = ne[CHUNK - 1] << 31;
  _U[CHUNK + 1] = s[0]; _WL[CHUNK + 1] = sw[0] >>> 31; _EL[CHUNK + 1] = se[0] << 31;
}

// ---------------------------------------------------------------------------
// The universe
// ---------------------------------------------------------------------------

export class BitboardUniverse {
  /**
   * @param {string} rule B/S rule string, e.g. "B3/S23"
   * @param {{trackStats?: boolean}} [opts]
   */
  constructor(rule = RULE_LIFE, opts = {}) {
    this.trackStats = opts.trackStats !== false;
    this.chunks = new Map();   // numeric chunk key -> Uint32Array(32)
    this.active = null;        // cached dilation of `chunks`, invalidated on edit
    this.generation = 0;
    this.population = 0;
    this.births = 0;
    this.deaths = 0;
    this._next = new Uint32Array(CHUNK);
    this.setRule(rule);
  }

  /**
   * Install a B/S rule, rebuilding the per-row rule kernel. Rules with 0 in the
   * born set are rejected: every dead cell of the infinite plane would be born,
   * which the sparse representation cannot express.
   */
  setRule(rule) {
    const r = parseRule(rule);
    for (const k of r.born) {
      if (k < 0 || k > 8) throw new RangeError(`BitboardUniverse: born count ${k} out of range`);
    }
    if (r.born.has(0)) {
      throw new RangeError(`BitboardUniverse: rule ${rule} has B0; every dead cell in the infinite plane would be born`);
    }
    this.rule = rule;
    this.bornCounts = [...r.born].sort((a, b) => a - b);
    this.surviveCounts = [...r.survive].sort((a, b) => a - b);

    // For every count the rule cares about, precompute the four "must this
    // count bit be set" flags plus separate born/survive membership (a count can
    // be in both sets: 3 births an empty cell and keeps a live one alive). Per
    // row this becomes a branchless mask: `count == k` is
    //   (s0 ^ (V0-1)) & (s1 ^ (V1-1)) & (s2 ^ (V2-1)) & (s3 ^ (V3-1))
    // because `x ^ -1` is `~x`.
    const wanted = [...new Set([...r.born, ...r.survive])].sort((a, b) => a - b);
    this.termV0 = Int32Array.from(wanted, v => v & 1);
    this.termV1 = Int32Array.from(wanted, v => (v & 2 ? 1 : 0));
    this.termV2 = Int32Array.from(wanted, v => (v & 4 ? 1 : 0));
    this.termV3 = Int32Array.from(wanted, v => (v & 8 ? 1 : 0));
    this.termBorn = Int32Array.from(wanted, v => (r.born.has(v) ? 1 : 0));
    this.termSurv = Int32Array.from(wanted, v => (r.survive.has(v) ? 1 : 0));
    this.termCount = wanted.length;
    return this;
  }

  // -- editing, mapped 1:1 onto the app's grid.set / grid.delete ------------

  set(x, y, alive = true) {
    const key = encodeChunk(x >> CHUNK_BITS, y >> CHUNK_BITS);
    let rows = this.chunks.get(key);
    if (alive) {
      if (!rows) { rows = new Uint32Array(CHUNK); this.chunks.set(key, rows); }
      rows[y & MASK] |= 1 << (x & MASK);
    } else if (rows) {
      rows[y & MASK] &= ~(1 << (x & MASK));
      if (!rows.some(v => v !== 0)) this.chunks.delete(key);
    }
    this.active = null;
    return this;
  }

  get(x, y) {
    const rows = this.chunks.get(encodeChunk(x >> CHUNK_BITS, y >> CHUNK_BITS));
    return rows ? ((rows[y & MASK] >>> (x & MASK)) & 1) === 1 : false;
  }

  toggle(x, y) {
    return this.set(x, y, !this.get(x, y));
  }

  load(cells) {
    this.chunks.clear();
    for (const [x, y] of cells) this.set(x, y, true);
    this.population = this.countAll();
    this.generation = 0;
    return this;
  }

  clear() {
    this.chunks.clear();
    this.active = null;
    this.generation = 0;
    this.population = 0;
    return this;
  }

  /** Deep copy (for the app's undo history — 128 bytes per occupied chunk). */
  clone() {
    const copy = Object.create(BitboardUniverse.prototype);
    Object.assign(copy, this);
    copy.chunks = new Map();
    for (const [key, rows] of this.chunks) copy.chunks.set(key, rows.slice());
    copy.active = null;
    copy._next = new Uint32Array(CHUNK);
    return copy;
  }

  /** Tight bounding box of the live cells, or null when empty. */
  bounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [key, rows] of this.chunks) {
      const [cx, cy] = decodeChunk(key);
      for (let r = 0; r < CHUNK; r++) {
        const w = rows[r];
        if (!w) continue;
        const y = cy * CHUNK + r;
        const lo = cx * CHUNK + (31 - Math.clz32(w & -w));
        const hi = cx * CHUNK + (31 - Math.clz32(w));
        if (lo < minX) minX = lo;
        if (hi > maxX) maxX = hi;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }

  // -- simulation ----------------------------------------------------------

  /** Advance `n` generations, exactly. Work is proportional to occupied area. */
  step(n = 1) {
    for (let g = 0; g < n; g++) this.stepOnce();
    return this;
  }

  stepOnce() {
    const { chunks, _next, trackStats } = this;
    const V0 = this.termV0, V1 = this.termV1, V2 = this.termV2, V3 = this.termV3;
    const IN_BORN = this.termBorn, IN_SURV = this.termSurv;
    const nTerms = this.termCount;

    // Only chunks holding a live cell, or touching one, can change. `active` is
    // the dilation of the occupied set from the previous step; edits null it.
    const active = this.active ?? this.activeSet();
    const next = new Map();
    let population = 0, births = 0, deaths = 0;

    for (const key of active) {
      gather(key, chunks);
      let chunkEmpty = true;

      for (let r = 0; r < CHUNK; r++) {
        const up = _U[r], mid = _U[r + 1], down = _U[r + 2];
        const wu = _WL[r], wl = _WL[r + 1], wd = _WL[r + 2];
        const eu = _EL[r], el = _EL[r + 1], ed = _EL[r + 2];

        // Cheap skip: nothing in this row's cell column, its vertical
        // neighbours, or the neighbours' edge bits can make a live cell.
        if ((up | mid | down | wu | wl | wd | eu | el | ed) === 0) {
          _next[r] = 0;
          continue;
        }

        compress8(
          (up << 1) | wu, up, (up >>> 1) | eu,
          (mid << 1) | wl, (mid >>> 1) | el,
          (down << 1) | wd, down, (down >>> 1) | ed,
        );

        let bornMask = 0, survMask = 0;
        for (let i = 0; i < nTerms; i++) {
          const m = (_s0 ^ (V0[i] - 1)) & (_s1 ^ (V1[i] - 1)) & (_s2 ^ (V2[i] - 1)) & (_s3 ^ (V3[i] - 1));
          bornMask |= m & -IN_BORN[i];
          survMask |= m & -IN_SURV[i];
        }

        const nextRow = ((bornMask & ~mid) | (survMask & mid)) >>> 0;
        _next[r] = nextRow;
        if (nextRow !== 0) {
          chunkEmpty = false;
          if (trackStats) {
            population += popcount(nextRow);
            births += popcount(nextRow & ~mid);
            deaths += popcount(mid & ~nextRow);
          }
        } else if (trackStats) {
          deaths += popcount(mid);
        }
      }

      if (!chunkEmpty) next.set(key, _next.slice());
    }

    this.chunks = next;
    this.generation++;
    if (trackStats) {
      this.population = population;
      this.births = births;
      this.deaths = deaths;
    }
    // Cache the dilation of the *output* set, so the next step needs no pass
    // over the chunks just to find what to visit.
    this.active = this.activeSet();
    return this;
  }

  /** Occupied chunks plus their 8 neighbours, as a Set of numeric keys. */
  activeSet() {
    const out = new Set();
    for (const key of this.chunks.keys()) {
      out.add(key);
      out.add(key - 1); out.add(key + 1);
      out.add(key - STRIDE); out.add(key + STRIDE);
      out.add(key - STRIDE - 1); out.add(key - STRIDE + 1);
      out.add(key + STRIDE - 1); out.add(key + STRIDE + 1);
    }
    return out;
  }

  countAll() {
    let total = 0;
    for (const rows of this.chunks.values()) for (let r = 0; r < CHUNK; r++) total += popcount(rows[r]);
    return total;
  }

  /** Live cells as [x, y] pairs, for verification and for the app's renderer. */
  cells() {
    const out = [];
    for (const [key, rows] of this.chunks) {
      const [cx, cy] = decodeChunk(key);
      for (let r = 0; r < CHUNK; r++) {
        let w = rows[r];
        if (!w) continue;
        const y = cy * CHUNK + r;
        while (w) {
          const low = w & -w;
          out.push([cx * CHUNK + (31 - Math.clz32(low)), y]);
          w ^= low;
        }
      }
    }
    return out;
  }

  /**
   * Iterate live rows without materialising cells: `fn(x0, y, word)` where x0
   * is the global x of bit 0. This is what a renderer should use.
   */
  forEachRow(fn) {
    for (const [key, rows] of this.chunks) {
      const [cxi, cy] = decodeChunk(key);
      const cx = cxi * CHUNK;
      for (let r = 0; r < CHUNK; r++) {
        if (rows[r] !== 0) fn(cx, cy * CHUNK + r, rows[r]);
      }
    }
  }

  get occupiedChunks() { return this.chunks.size; }
}

// ---------------------------------------------------------------------------
// Correctness
// ---------------------------------------------------------------------------

/** Exhaustively verify the bit-sliced 8-input counter over all 256 inputs. */
export function testCompress8() {
  let bad = 0;
  for (let m = 0; m < 256; m++) {
    const bits = [];
    let want = 0;
    for (let i = 0; i < 8; i++) { const v = (m >> i) & 1; bits.push(v); want += v; }
    compress8(...bits);
    const [b0, b1, b2, b3] = lastCountPlanes();
    const got = (b0 & 1) | ((b1 & 1) << 1) | ((b2 & 1) << 2) | ((b3 & 1) << 3);
    if (got !== want) {
      bad++;
      if (bad <= 5) console.error(`  compress8(inputs 0b${m.toString(2).padStart(8, '0')}) = ${got}, want ${want}`);
    }
  }
  return { ok: bad === 0, bad };
}

/** The "must never regress" cases the app's own patterns are verified against. */
export async function testCorrectness(verbose = true) {
  const results = [];
  const check = (name, got, want) => results.push({ name, ok: got === want, got, want });

  // 1. Glider after 4 generations = the same shape translated (1,1).
  {
    const sim = new BitboardUniverse().load(PATTERNS.GLIDER);
    const before = shapeSig(sim.cells());
    sim.step(4);
    const after = sim.cells();
    check('glider 4 gens: same shape', shapeSig(after), before);
    const mnx = Math.min(...after.map(c => c[0])), mny = Math.min(...after.map(c => c[1]));
    const mnx0 = Math.min(...PATTERNS.GLIDER.map(c => c[0])), mny0 = Math.min(...PATTERNS.GLIDER.map(c => c[1]));
    check('glider 4 gens: translated (1,1)', `${mnx - mnx0},${mny - mny0}`, '1,1');
    check('glider 4 gens: population 5', sim.population, 5);
  }

  // 2. Blinker: period 2.
  {
    const sim = new BitboardUniverse().load(PATTERNS.BLINKER);
    const s0 = shapeSig(sim.cells());
    sim.step(1);
    const s1 = shapeSig(sim.cells());
    sim.step(1);
    check('blinker: changes at gen 1', s1 !== s0, true);
    check('blinker: period 2', shapeSig(sim.cells()), s0);
    check('blinker: population 3', sim.population, 3);
  }

  // 3. Block: still life.
  {
    const sim = new BitboardUniverse().load(PATTERNS.BLOCK);
    const s0 = shapeSig(sim.cells());
    sim.step(50);
    check('block: still life after 50 gens', shapeSig(sim.cells()), s0);
  }

  // 4. R-pentomino: exactly 116 cells at generation 1103.
  {
    const sim = new BitboardUniverse().load(PATTERNS.R_PENTOMINO);
    sim.step(1103);
    check('r-pentomino: generation', sim.generation, 1103);
    check('r-pentomino: 116 cells at gen 1103', sim.population, 116);
    check('r-pentomino: population == cell readback', sim.cells().length, 116);
  }

  // 5. Diehard: dies at generation 130.
  {
    const sim = new BitboardUniverse().load(PATTERNS.DIEHARD);
    sim.step(129);
    const before = sim.population;
    sim.step(1);
    check('diehard: alive at gen 129', before > 0, true);
    check('diehard: dead at gen 130', sim.population, 0);
  }

  // 6. Acorn: settles at generation 5206 with 633 cells.
  {
    const sim = new BitboardUniverse().load(PATTERNS.ACORN);
    sim.step(5206);
    check('acorn: generation', sim.generation, 5206);
    check('acorn: 633 cells at gen 5206', sim.population, 633);
  }

  // 7. Gosper gun: grows without bound, and agrees with the Map core exactly.
  {
    const sim = new BitboardUniverse().load(PATTERNS.GOSPER_GUN);
    sim.step(1000);
    const p1 = sim.population;
    sim.step(1000);
    check('gosper gun: population grows', sim.population > p1, true);
    const ref = new MapCore(RULE_LIFE).load(PATTERNS.GOSPER_GUN).step(2000);
    check('gosper gun: gen-2000 population == Map core', sim.population, ref.grid.size);
    check('gosper gun: shape == Map core', shapeSig(sim.cells()), shapeSig(ref.cells()));
  }

  // 8. Agreement with the repo's reference stepper, for every rule the app
  //    offers, on random soups wide enough to span several chunks in x and y so
  //    that every chunk seam gets exercised.
  {
    const cases = [
      ['B3/S23', 12], ['B36/S23', 10], ['B3678/S34678', 8], ['B2/S', 3],
    ];
    let mismatches = 0, checked = 0, firstBad = '';
    for (const [ruleStr, gens] of cases) {
      const rule = parseRule(ruleStr);
      for (const seed of [1, 2, 3]) {
        const cells = randomSoup(70, 70, 0.3, seed);
        let ref = cells.map(c => [...c]);
        const sim = new BitboardUniverse(ruleStr).load(cells);
        for (let g = 0; g < gens; g++) {
          ref = referenceStep(rule, ref);
          sim.step(1);
          checked++;
          if (ref.length !== sim.population || shapeSig(ref) !== shapeSig(sim.cells())) {
            mismatches++;
            if (!firstBad) firstBad = ` (${ruleStr} seed ${seed} gen ${g + 1}: ref ${ref.length} vs bitboard ${sim.population})`;
            break;
          }
        }
      }
    }
    check(`matches reference stepper, 4 rules (${checked} gen)${firstBad}`, mismatches, 0);
  }

  // 9. Chunk borders: a pattern deliberately straddling chunk seams in x and y.
  {
    const cells = [];
    for (let i = 0; i < 8; i++) cells.push([31 + i, 31 + i]); // diagonal across the (0,0)/(1,1) seam
    const sim = new BitboardUniverse().load(cells);
    const ref0 = cells.map(c => [...c]);
    let ref = referenceStep(parseRule(RULE_LIFE), ref0);
    sim.step(1);
    check('seam-straddling pattern: 1 gen', shapeSig(ref), shapeSig(sim.cells()));
    for (let g = 1; g < 10; g++) ref = referenceStep(parseRule(RULE_LIFE), ref);
    sim.step(9);
    check('seam-straddling pattern: 10 gens', shapeSig(ref), shapeSig(sim.cells()));
  }

  // 10. Patterns far from the origin (negative coordinates) stay correct.
  {
    const cells = PATTERNS.GLIDER.map(([x, y]) => [x - 5000, y - 5000]);
    const sim = new BitboardUniverse().load(cells);
    const readback = sim.cells();
    check('glider at (-5000,-5000): get() agrees with cells()',
      readback.every(([x, y]) => sim.get(x, y)) && !sim.get(0, 0), true);
    sim.step(4);
    check('glider at (-5000,-5000): population 5', sim.population, 5);
    check('glider at (-5000,-5000): same shape after 4 gens', shapeSig(sim.cells()), shapeSig(PATTERNS.GLIDER));
    check('glider at (-5000,-5000): cells() round-trips', sim.cells().every(([x, y]) => sim.get(x, y)), true);
  }

  // 11. Chunk key encoding round-trips across the whole supported range, and
  //     patterns far out on both axes still evolve correctly.
  {
    let roundTripOk = true;
    const probes = [-524287, -100000, -2, -1, 0, 1, 2, 100000, 524287];
    for (const cx of probes) {
      for (const cy of probes) {
        const [rx, ry] = decodeChunkTest(encodeChunk(cx, cy));
        if (rx !== cx || ry !== cy) roundTripOk = false;
      }
    }
    check('encode/decode round-trips at range extremes', roundTripOk, true);
    let threw = false;
    try { encodeChunk(1 << 19, 0); } catch { threw = true; }
    check('out-of-range chunk rejected', threw, true);

    const far = 900000;   // cells, not chunks: ~28k chunks out
    const sim = new BitboardUniverse().load(PATTERNS.GLIDER.map(([x, y]) => [x + far, y - far]));
    sim.step(4);
    check('glider at (+900k,-900k) still correct', shapeSig(sim.cells()), shapeSig(PATTERNS.GLIDER));
    check('glider at (+900k,-900k) population 5', sim.population, 5);
  }

  // 12. The helpers the app will need: clone / setRule / bounds.
  {
    const sim = new BitboardUniverse().load(PATTERNS.GLIDER);
    sim.step(5);
    const copy = sim.clone();
    check('clone: same population', copy.population, sim.population);
    check('clone: same shape', shapeSig(copy.cells()), shapeSig(sim.cells()));
    copy.set(0, 0, true);
    copy.step(3);
    check('clone: independent of the original', shapeSig(copy.cells()) !== shapeSig(sim.cells()), true);
    check('clone: original untouched', sim.population, 5);

    const b = sim.bounds();
    const cells = sim.cells();
    const bx = Math.min(...cells.map(c => c[0])), by = Math.min(...cells.map(c => c[1]));
    const bX = Math.max(...cells.map(c => c[0])), bY = Math.max(...cells.map(c => c[1]));
    check('bounds: matches cells()', `${b.minX},${b.minY},${b.maxX},${b.maxY}`, `${bx},${by},${bX},${bY}`);
    check('bounds: null when empty', new BitboardUniverse().bounds(), null);

    // setRule: same start, different rule -> different result
    const a = new BitboardUniverse('B3/S23').load(PATTERNS.R_PENTOMINO).step(20);
    const h = new BitboardUniverse('B36/S23').load(PATTERNS.R_PENTOMINO).step(20);
    const c = new BitboardUniverse('B3/S23').load(PATTERNS.R_PENTOMINO);
    c.setRule('B36/S23');
    c.step(20);
    check('setRule: matches a fresh HighLife universe', shapeSig(c.cells()), shapeSig(h.cells()));
    check('setRule: HighLife differs from Life here', shapeSig(c.cells()) !== shapeSig(a.cells()), true);
    let b0 = false;
    try { new BitboardUniverse('B0/S23'); } catch { b0 = true; }
    check('B0 rule rejected', b0, true);
  }

  if (verbose) {
    for (const r of results) {
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(46)} ${r.ok ? '' : `got ${r.got}, want ${r.want}`}`);
    }
  }
  return { results, ok: results.every(r => r.ok) };
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

/** Run the Map core for up to `gens` generations or `budgetMs`, whichever first. */
function benchMapCore(cells, rule, gens, budgetMs) {
  const sim = new MapCore(rule).load(cells);
  const t0 = performance.now();
  let g = 0;
  while (g < gens) {
    sim.stepCore();
    g++;
    if (performance.now() - t0 > budgetMs) break;
  }
  return { ms: performance.now() - t0, gens: g, truncated: g < gens, population: sim.grid.size };
}

function benchBitboard(cells, rule, gens, runOpts) {
  const r = bench(() => new BitboardUniverse(rule).load(cells).step(gens), runOpts);
  const sim = new BitboardUniverse(rule).load(cells).step(gens);
  return { ...r, sim };
}

/** ~1k, ~100k and ~1M live cells, plus small/structured patterns. */
const WORKLOADS = [
  { name: 'blinker (3 cells)', cells: PATTERNS.BLINKER, rule: RULE_LIFE, gens: 2000 },
  { name: 'r-pentomino (5 cells)', cells: PATTERNS.R_PENTOMINO, rule: RULE_LIFE, gens: 1103 },
  { name: 'acorn (7 cells)', cells: PATTERNS.ACORN, rule: RULE_LIFE, gens: 5206 },
  { name: 'gosper gun (36 cells)', cells: PATTERNS.GOSPER_GUN, rule: RULE_LIFE, gens: 10000 },
  { name: 'gun 3x3 array (324 cells)', cells: gunArray(3, 150), rule: RULE_LIFE, gens: 3000 },
  { name: 'glider grid 60x60 (18k)', cells: gliderGrid(60, 16), rule: RULE_LIFE, gens: 1000 },
  { name: 'random 45x45 soup (~1.0k)', cells: randomSoup(45, 45, 0.5), rule: RULE_LIFE, gens: 1000 },
  { name: 'random 100x100 soup (~5k)', cells: randomSoup(100, 100, 0.5), rule: RULE_LIFE, gens: 500 },
  { name: 'random 450x450 soup (~100k)', cells: randomSoup(450, 450, 0.5), rule: RULE_LIFE, gens: 100 },
  { name: 'random 1000x1000 soup (~500k)', cells: randomSoup(1000, 1000, 0.5), rule: RULE_LIFE, gens: 50 },
  { name: 'random 1415x1415 soup (~1M)', cells: randomSoup(1415, 1415, 0.5), rule: RULE_LIFE, gens: 20 },
  { name: 'seeds exploder (B2/S)', cells: PATTERNS.GLIDER, rule: 'B2/S', gens: 200 },
  { name: 'day & night 200x200', cells: randomSoup(200, 200, 0.5), rule: 'B3678/S34678', gens: 100 },
];

export function runBenchmarks({ budgetMs = 6000, runs = 3 } = {}) {
  const rows = [];
  for (const w of WORKLOADS) {
    const live = w.cells.length;
    // The Map core is ~1000x slower at 1M cells; don't try (and don't OOM).
    const map = live > 150000 ? null : benchMapCore(w.cells, w.rule, w.gens, budgetMs);
    const bit = benchBitboard(w.cells, w.rule, w.gens, { runs, warmup: 1 });
    const mapCell = !map ? 'skipped (too slow)'
      : map.truncated ? `${ms(map.ms)} @${map.gens}g`
      : ms(map.ms);
    const speedup = map && !map.truncated ? (map.ms / bit.median).toFixed(1) + 'x'
      : map && map.truncated ? '> ' + (map.ms / bit.median * (w.gens / map.gens)).toFixed(0) + 'x' : '—';
    rows.push([
      w.name, live.toLocaleString(), w.gens.toLocaleString(), mapCell,
      ms(bit.median), ms(bit.best), speedup,
      bit.sim.population.toLocaleString(), bit.sim.occupiedChunks.toLocaleString(),
    ]);
  }
  return table(
    ['workload', 'live', 'gens', 'Map core (current)', 'bitboard median', 'bitboard best', 'vs Map', 'pop', 'chunks'],
    rows,
  );
}

// ---------------------------------------------------------------------------
// Throughput at the three scales the brief asks about (1k / 100k / 1M cells),
// plus what tracking the population/birth/death counters costs.
// ---------------------------------------------------------------------------

const SCALE_WORKLOADS = [
  { label: '~1k', cells: randomSoup(45, 45, 0.5), gens: 200 },
  { label: '~100k', cells: randomSoup(450, 450, 0.5), gens: 50 },
  { label: '~1M', cells: randomSoup(1415, 1415, 0.5), gens: 10 },
];

export function runScaleBenchmarks({ runs = 3 } = {}) {
  const rows = [];
  for (const w of SCALE_WORKLOADS) {
    const live = w.cells.length;
    const withStats = bench(() => new BitboardUniverse(RULE_LIFE, { trackStats: true }).load(w.cells).step(w.gens), { runs, warmup: 1 });
    const noStats = bench(() => new BitboardUniverse(RULE_LIFE, { trackStats: false }).load(w.cells).step(w.gens), { runs, warmup: 1 });
    const cellGens = live * w.gens;
    rows.push([
      w.label, live.toLocaleString(), w.gens.toLocaleString(),
      ms(withStats.best),
      (withStats.best / w.gens).toFixed(2),
      (noStats.best / w.gens).toFixed(2),
      ((1 - noStats.best / withStats.best) * 100).toFixed(0) + '%',
      cellsPerSec(live, w.gens, withStats.best),
      ((withStats.best * 1e6) / cellGens).toFixed(1),
    ]);
  }
  return table(
    ['scale', 'live', 'gens', 'total', 'ms/gen', 'ms/gen no stats', 'stats overhead', 'throughput', 'ns/live-cell-gen'],
    rows,
  );
}

/**
 * The bitboard's real cost driver: one 32-cell chunk row. Run a fully dense
 * universe (every chunk occupied) so nothing is skipped, and report ns per
 * chunk-row, plus the same for the app's current core at the same population.
 */
export function runKernelBenchmark() {
  const SIDE = 32;                       // 32x32 chunks = 1M cells, all dense
  const cells = [];
  for (let y = 0; y < SIDE * CHUNK; y++) for (let x = 0; x < SIDE * CHUNK; x++) if ((x + y) & 1) cells.push([x, y]);
  const gens = 10;
  const rows = SIDE * SIDE * CHUNK * gens;
  const r = bench(() => new BitboardUniverse(RULE_LIFE, { trackStats: false }).load(cells).step(gens), { runs: 3, warmup: 1 });
  const rStats = bench(() => new BitboardUniverse(RULE_LIFE, { trackStats: true }).load(cells).step(gens), { runs: 3, warmup: 1 });
  return table(['universe', 'cells', 'chunk-rows/generation', 'ms/generation', 'ns per chunk-row', 'ns per chunk-row (with stats)'], [
    [`${SIDE}x${SIDE} chunks, fully occupied`, (cells.length).toLocaleString(), (SIDE * SIDE * CHUNK).toLocaleString(),
      (r.best / gens).toFixed(2), ((r.best * 1e6) / rows).toFixed(0), ((rStats.best * 1e6) / rows).toFixed(0)],
  ]);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (process.argv[1] && /bench-bitboard\.mjs$/.test(process.argv[1])) {
  const quick = process.argv.includes('--quick');
  console.log('== bit-sliced 8-input counter ==');
  const c8 = testCompress8();
  console.log(`  ${c8.ok ? 'ok  ' : 'FAIL'} all 256 input combinations (${c8.bad} bad)`);
  console.log("\n== correctness against the app's known-good cases ==");
  const { ok, results } = await testCorrectness();
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed`);
  if (!ok) process.exit(1);
  if (!quick) {
    console.log(`\n== node ${process.version} ==`);
    console.log(runBenchmarks());
    console.log('\n== bitboard scaling and the cost of population stats ==');
    console.log(runScaleBenchmarks());
    console.log('\n== the actual hot loop: one 32-cell chunk row ==');
    console.log(runKernelBenchmark());
    const m = memMB();
    console.log(`\nheap after benchmarks: ${m.heap} MB (rss ${m.rss} MB)`);
  }
}
