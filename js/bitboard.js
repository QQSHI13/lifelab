/*!
 * LifeLab simulation core — a chunked, bit-parallel Conway stepper.
 *
 * Part of LifeLab, GPL-3.0. Dependency-free classic script: no modules, no
 * imports, no build step. Load it before the app's inline script:
 *
 *     <script src="js/bitboard.js"></script>
 *
 * It exposes one global, `BitboardUniverse`, which is the app's *only*
 * simulation core. It is a cleaned-up port of `tools/bench-bitboard.mjs` (the
 * reference implementation measured in docs/PERF.md), whose own correctness
 * suite lives on as `js/bitboard.check.mjs`.
 *
 * REPRESENTATION
 *   The universe is a Map<chunkKey, Uint32Array(32)>.
 *   A chunk covers 32x32 cells. rows[r] holds the 32 cells of local row r, with
 *   bit b = local column b (bit 0 = leftmost). Cells outside every chunk are
 *   dead, so the universe stays unbounded and sparse: the cost of a generation
 *   is proportional to the *occupied area*, not to the viewport or to the
 *   population, and a pattern may straddle any number of chunks.
 *
 * STEP  (bit-sliced, no per-cell loop)
 *   Row r's eight neighbour planes come from shifts; the left/right carries are
 *   bit 31 / bit 0 of the horizontally adjacent chunk's word, and the up/down
 *   words come from the vertically adjacent chunk at the seam. The eight one-bit
 *   planes are then summed bit-sliced — a carry-save adder tree (4 half adders +
 *   4 full adders) compresses them into the four bits of the per-cell neighbour
 *   count, in parallel across all 32 columns of the row. `compress8` is verified
 *   exhaustively over all 256 input combinations by the check script.
 *
 *   born/survive then become masks over the count bits:
 *     born    = OR over k in rule.born    of (count == k)
 *     survive = OR over k in rule.survive of (count == k)
 *     next    = (born & ~alive) | (survive & alive)
 *
 * DOMAIN LIMIT
 *   Chunks are indexed by a single number, key = (cx + CB) * STRIDE + (cy + CB),
 *   which keeps keys non-negative so encode/decode is exact with plain `/` and
 *   `%`. Integer keys are 4-10x faster to hash than an "x,y" string, and STRIDE
 *   doubles as the key delta for one chunk in x, so neighbour lookups are pure
 *   addition. The price is a finite coordinate space: |cx|,|cy| < 2^19 chunks,
 *   i.e. **+/-16,777,215 (about +/-16.7M) cells per axis**. `set()` throws a
 *   RangeError beyond that rather than wrapping around silently; callers that
 *   cannot bound their coordinates (the app's pan tool) should catch it.
 *   Bitboards are ordinary JS numbers, so a "chunk" far outside the range would
 *   still be a valid double, but the key would collide with a different chunk.
 *
 * Rules with 0 in the born set (B0/...) are rejected: every dead cell of the
 * infinite plane would be born, which a sparse representation cannot express.
 */
(function (global) {
  'use strict';

  var CHUNK = 32;
  var CHUNK_BITS = 5;            // 32 == 1 << 5
  var MASK = CHUNK - 1;

  // Key space: |cx|,|cy| < CB chunks, STRIDE = the chunk-x step.
  var CB = 1 << 19;
  var STRIDE = 1 << 20;
  // Largest coordinate the key space can represent, in cells (+/- 16.7M).
  var MAX_COORD = CB * CHUNK - 1;

  var DEFAULT_RULE = 'B3/S23';

  /** Chunk index -> key. Throws outside the +/-16.7M cell working range. */
  function encodeChunk(cx, cy) {
    if (cx <= -CB || cx >= CB || cy <= -CB || cy >= CB) {
      throw new RangeError(
        'BitboardUniverse: chunk (' + cx + ',' + cy + ') is outside the +/-' +
        (CB * CHUNK) + ' cell working range');
    }
    return (cx + CB) * STRIDE + (cy + CB);
  }

  /** Key -> [cx, cy]. Exact because every key is a non-negative integer. */
  function decodeChunk(key) {
    var t = key % STRIDE;
    return [(key - t) / STRIDE - CB, t - CB];
  }

  /**
   * Parse "B3/S23" (also accepts "S23/B3", lowercase, spaces, and the bare
   * "23/3" S/B style) into { born: Set, survive: Set }.
   */
  function parseRule(str) {
    var text = String(str == null ? DEFAULT_RULE : str)
      .replace(/\s+/g, '')
      .toUpperCase();
    var born = '', survive = '';
    var m = text.match(/^B([0-8]*)\/S([0-8]*)$/);
    if (m) {
      born = m[1];
      survive = m[2];
    } else if ((m = text.match(/^S([0-8]*)\/B([0-8]*)$/))) {
      survive = m[1];
      born = m[2];
    } else if ((m = text.match(/^([0-8]*)\/([0-8]*)$/))) {
      // "23/3" is the traditional S/B shorthand for B3/S23.
      survive = m[1];
      born = m[2];
    } else {
      throw new Error('BitboardUniverse: cannot parse rule "' + str + '"');
    }
    return { born: digitsToSet(born), survive: digitsToSet(survive) };
  }

  function digitsToSet(digits) {
    var out = new Set();
    for (var i = 0; i < digits.length; i++) out.add(digits.charCodeAt(i) - 48);
    return out;
  }

  // -------------------------------------------------------------------------
  // Bit-sliced 8-input counter
  // -------------------------------------------------------------------------

  // full adder: x + y + z = sum + 2*carry
  function faCarry(x, y, z) { return (x & y) | (z & (x ^ y)); }

  // The four count planes (weights 1, 2, 4, 8), written as module scratch so the
  // row loop can read them without allocating. Callers must consume them before
  // the next compress8 call.
  var _s0 = 0, _s1 = 0, _s2 = 0, _s3 = 0;

  /**
   * Count eight one-bit planes per column, bit-sliced. Writes the four count
   * planes into `_s0.._s3`. Exposed for the exhaustive 256-input check.
   */
  function compress8(a, b, c, d, e, f, g, h) {
    // four half adders: 8 inputs -> 4 weight-1 terms + 4 weight-2 terms
    var t1 = a ^ b, c1 = a & b;
    var t2 = c ^ d, c2 = c & d;
    var t3 = e ^ f, c3 = e & f;
    var t4 = g ^ h, c4 = g & h;
    // reduce the four weight-1 terms to one
    var t5 = t1 ^ t2, c5 = t1 & t2;
    var t6 = t3 ^ t4, c6 = t3 & t4;
    _s0 = t5 ^ t6;
    var c7 = t5 & t6;
    // seven weight-2 terms (sum <= 4) -> weight-2 / weight-4 terms
    var t7 = c1 ^ c2, c8 = c1 & c2;
    var t8 = c3 ^ c4, c9 = c3 & c4;
    var t9 = c5 ^ c6 ^ c7, c10 = faCarry(c5, c6, c7);
    _s1 = t7 ^ t8 ^ t9;
    var c11 = faCarry(t7, t8, t9);
    // four weight-4 terms (sum <= 4) -> weight-4 / weight-8 terms
    var e1 = c8 ^ c9, f1 = c8 & c9;
    var e2 = c10 ^ c11, f2 = c10 & c11;
    _s2 = e1 ^ e2;
    var f3 = e1 & e2;
    // three weight-8 terms: only reachable for a count of 8
    _s3 = f1 ^ f2 ^ f3;
  }

  function lastCountPlanes() { return [_s0, _s1, _s2, _s3]; }

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
  var _U = new Uint32Array(CHUNK + 2);
  var _WL = new Uint32Array(CHUNK + 2);
  var _EL = new Uint32Array(CHUNK + 2);
  var ZERO = new Uint32Array(CHUNK);

  /**
   * Gather everything chunk `key` needs from its 8 neighbours: the centre
   * column's words plus the horizontal edge bits, at all 34 rows that matter.
   */
  function gather(key, chunks) {
    // STRIDE is the chunk-x step, 1 is the chunk-y step.
    var n = chunks.get(key - 1) || ZERO;
    var here = chunks.get(key) || ZERO;
    var s = chunks.get(key + 1) || ZERO;
    var nw = chunks.get(key - STRIDE - 1) || ZERO;
    var w = chunks.get(key - STRIDE) || ZERO;
    var sw = chunks.get(key - STRIDE + 1) || ZERO;
    var ne = chunks.get(key + STRIDE - 1) || ZERO;
    var e = chunks.get(key + STRIDE) || ZERO;
    var se = chunks.get(key + STRIDE + 1) || ZERO;
    for (var i = 0; i < CHUNK; i++) {
      _U[i + 1] = here[i];
      _WL[i + 1] = w[i] >>> 31;   // west chunk's cell immediately left of bit 0
      _EL[i + 1] = e[i] << 31;    // east chunk's cell immediately right of bit 31
    }
    _U[0] = n[CHUNK - 1]; _WL[0] = nw[CHUNK - 1] >>> 31; _EL[0] = ne[CHUNK - 1] << 31;
    _U[CHUNK + 1] = s[0]; _WL[CHUNK + 1] = sw[0] >>> 31; _EL[CHUNK + 1] = se[0] << 31;
  }

  // -------------------------------------------------------------------------
  // The universe
  // -------------------------------------------------------------------------

  /**
   * A sparse, unbounded Game of Life universe over 32x32 bitboard chunks.
   *
   * @param {string} [rule] B/S rule string, e.g. "B3/S23"
   * @param {{trackStats?: boolean}} [opts] `trackStats: false` skips the
   *        population/birth/death counters (they cost 4-13% at 100k+ cells).
   */
  function BitboardUniverse(rule, opts) {
    opts = opts || {};
    this.trackStats = opts.trackStats !== false;
    this.chunks = new Map();   // numeric chunk key -> Uint32Array(32)
    this.active = null;        // cached dilation of `chunks`, invalidated on edit
    this.rule = DEFAULT_RULE;
    this.generation = 0;
    this.population = 0;
    this.births = 0;
    this.deaths = 0;
    this._next = new Uint32Array(CHUNK);
    this.setRule(rule == null ? DEFAULT_RULE : rule);
  }

  /**
   * Install a B/S rule, rebuilding the per-row rule kernel. Rules with 0 in the
   * born set are rejected: every dead cell of the infinite plane would be born.
   * Throws without changing the current rule if the string (or the rule) is not
   * usable, so callers can keep the old rule on failure.
   */
  BitboardUniverse.prototype.setRule = function (rule) {
    var r = parseRule(rule);
    var born = [], survive = [];
    r.born.forEach(function (k) { born.push(k); });
    r.survive.forEach(function (k) { survive.push(k); });
    born.sort(function (a, b) { return a - b; });
    survive.sort(function (a, b) { return a - b; });
    if (born.length && born[0] === 0) {
      throw new RangeError('BitboardUniverse: rule ' + rule +
        ' has B0; every dead cell in the infinite plane would be born');
    }
    this.rule = String(rule);
    this.bornCounts = born;
    this.surviveCounts = survive;

    // For every count the rule cares about, precompute the four "must this count
    // bit be set" flags plus separate born/survive membership (a count can be in
    // both sets: 3 births an empty cell and keeps a live one alive). Per row this
    // becomes a branchless mask: `count == k` is
    //   (s0 ^ (V0-1)) & (s1 ^ (V1-1)) & (s2 ^ (V2-1)) & (s3 ^ (V3-1))
    // because `x ^ -1` is `~x`.
    var wantedSet = new Set();
    born.forEach(function (v) { wantedSet.add(v); });
    survive.forEach(function (v) { wantedSet.add(v); });
    var wanted = [];
    wantedSet.forEach(function (v) { wanted.push(v); });
    wanted.sort(function (a, b) { return a - b; });

    var n = wanted.length;
    var V0 = new Int32Array(n), V1 = new Int32Array(n);
    var V2 = new Int32Array(n), V3 = new Int32Array(n);
    var IN_BORN = new Int32Array(n), IN_SURV = new Int32Array(n);
    var bornHas = r.born, survHas = r.survive;
    for (var i = 0; i < n; i++) {
      var v = wanted[i];
      V0[i] = v & 1;
      V1[i] = v & 2 ? 1 : 0;
      V2[i] = v & 4 ? 1 : 0;
      V3[i] = v & 8 ? 1 : 0;
      IN_BORN[i] = bornHas.has(v) ? 1 : 0;
      IN_SURV[i] = survHas.has(v) ? 1 : 0;
    }
    this.termV0 = V0; this.termV1 = V1; this.termV2 = V2; this.termV3 = V3;
    this.termBorn = IN_BORN; this.termSurv = IN_SURV;
    this.termCount = n;
    return this;
  };

  // -- editing --------------------------------------------------------------

  /**
   * Set (or clear) one cell. O(1); throws a RangeError outside the +/-16.7M
   * cell domain. `population` is maintained incrementally, so it is always the
   * true number of live cells, not a value that needs a recount after editing.
   */
  BitboardUniverse.prototype.set = function (x, y, alive) {
    if (alive === undefined) alive = true;
    var key = encodeChunk(x >> CHUNK_BITS, y >> CHUNK_BITS);
    var bit = 1 << (x & MASK);
    var r = y & MASK;
    var rows = this.chunks.get(key);
    if (alive) {
      if (rows) {
        if (rows[r] & bit) return this;          // already alive
        rows[r] |= bit;
      } else {
        rows = new Uint32Array(CHUNK);
        rows[r] = bit;
        this.chunks.set(key, rows);
      }
      this.population++;
    } else if (rows) {
      if (!(rows[r] & bit)) return this;         // already dead
      rows[r] &= ~bit;
      this.population--;
      if (!rows.some(nonZero)) this.chunks.delete(key);
    } else {
      return this;
    }
    this.active = null;
    return this;
  };

  function nonZero(v) { return v !== 0; }

  /** Is the cell alive? */
  BitboardUniverse.prototype.get = function (x, y) {
    var rows = this.chunks.get(encodeChunk(x >> CHUNK_BITS, y >> CHUNK_BITS));
    return rows ? ((rows[y & MASK] >>> (x & MASK)) & 1) === 1 : false;
  };

  /** Flip one cell. */
  BitboardUniverse.prototype.toggle = function (x, y) {
    return this.set(x, y, !this.get(x, y));
  };

  /** Replace the contents with `cells` (an iterable of [x, y] pairs). */
  BitboardUniverse.prototype.load = function (cells) {
    this.chunks.clear();
    this.active = null;
    this.generation = 0;
    this.births = 0;
    this.deaths = 0;
    this.population = 0;
    for (var i = 0; i < cells.length; i++) this.set(cells[i][0], cells[i][1], true);
    return this;
  };

  /** Empty the universe and reset every counter. */
  BitboardUniverse.prototype.clear = function () {
    this.chunks.clear();
    this.active = null;
    this.generation = 0;
    this.population = 0;
    this.births = 0;
    this.deaths = 0;
    return this;
  };

  /**
   * Deep copy, for undo snapshots. Costs ~128 B per *occupied chunk* (a 100k
   * cell soup is ~200 chunks, i.e. ~26 KB) instead of one entry per live cell.
   * The rule tables are shared (setRule replaces them wholesale, never mutates).
   */
  BitboardUniverse.prototype.clone = function () {
    var copy = Object.create(BitboardUniverse.prototype);
    Object.assign(copy, this);
    copy.chunks = new Map();
    this.chunks.forEach(function (rows, key) { copy.chunks.set(key, rows.slice()); });
    copy.active = null;              // recomputed on the next step
    copy._next = new Uint32Array(CHUNK);
    return copy;
  };

  /** Tight bounding box of the live cells, or null when empty. */
  BitboardUniverse.prototype.bounds = function () {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    this.chunks.forEach(function (rows, key) {
      var c = decodeChunk(key), cx = c[0], cy = c[1];
      for (var r = 0; r < CHUNK; r++) {
        var w = rows[r];
        if (!w) continue;
        var y = cy * CHUNK + r;
        var lo = cx * CHUNK + (31 - Math.clz32(w & -w));
        var hi = cx * CHUNK + (31 - Math.clz32(w));
        if (lo < minX) minX = lo;
        if (hi > maxX) maxX = hi;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    });
    return isFinite(minX) ? { minX: minX, minY: minY, maxX: maxX, maxY: maxY } : null;
  };

  // -- simulation -----------------------------------------------------------

  /** Advance `n` generations, exactly. Work is proportional to occupied area. */
  BitboardUniverse.prototype.step = function (n) {
    if (n === undefined) n = 1;
    for (var g = 0; g < n; g++) this.stepOnce();
    return this;
  };

  BitboardUniverse.prototype.stepOnce = function () {
    var chunks = this.chunks;
    var nextRows = this._next;
    var trackStats = this.trackStats;
    var V0 = this.termV0, V1 = this.termV1, V2 = this.termV2, V3 = this.termV3;
    var IN_BORN = this.termBorn, IN_SURV = this.termSurv;
    var nTerms = this.termCount;

    // Only chunks holding a live cell, or touching one, can change. `active` is
    // the dilation of the occupied set from the previous step; edits null it.
    var active = this.active || this.activeSet();
    var next = new Map();
    var population = 0, births = 0, deaths = 0;

    active.forEach(function (key) {
      gather(key, chunks);
      var chunkEmpty = true;

      for (var r = 0; r < CHUNK; r++) {
        var up = _U[r], mid = _U[r + 1], down = _U[r + 2];
        var wu = _WL[r], wl = _WL[r + 1], wd = _WL[r + 2];
        var eu = _EL[r], el = _EL[r + 1], ed = _EL[r + 2];

        // Cheap skip: nothing in this row's cell column, its vertical
        // neighbours, or the neighbours' edge bits can make a live cell.
        if ((up | mid | down | wu | wl | wd | eu | el | ed) === 0) {
          nextRows[r] = 0;
          continue;
        }

        compress8(
          (up << 1) | wu, up, (up >>> 1) | eu,
          (mid << 1) | wl, (mid >>> 1) | el,
          (down << 1) | wd, down, (down >>> 1) | ed
        );

        var bornMask = 0, survMask = 0;
        for (var i = 0; i < nTerms; i++) {
          var m = (_s0 ^ (V0[i] - 1)) & (_s1 ^ (V1[i] - 1)) &
                  (_s2 ^ (V2[i] - 1)) & (_s3 ^ (V3[i] - 1));
          bornMask |= m & -IN_BORN[i];
          survMask |= m & -IN_SURV[i];
        }

        var nextRow = ((bornMask & ~mid) | (survMask & mid)) >>> 0;
        nextRows[r] = nextRow;
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

      if (!chunkEmpty) next.set(key, nextRows.slice());
    });

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
  };

  /** Occupied chunks plus their 8 neighbours, as a Set of numeric keys. */
  BitboardUniverse.prototype.activeSet = function () {
    var out = new Set();
    this.chunks.forEach(function (rows, key) {
      out.add(key);
      out.add(key - 1); out.add(key + 1);
      out.add(key - STRIDE); out.add(key + STRIDE);
      out.add(key - STRIDE - 1); out.add(key - STRIDE + 1);
      out.add(key + STRIDE - 1); out.add(key + STRIDE + 1);
    });
    return out;
  };

  /** Recount the population from the bits (edits keep it correct already). */
  BitboardUniverse.prototype.countAll = function () {
    var total = 0;
    this.chunks.forEach(function (rows) {
      for (var r = 0; r < CHUNK; r++) total += popcount(rows[r]);
    });
    return total;
  };

  /** Live cells as [x, y] pairs. Materialises every cell — prefer forEachRow. */
  BitboardUniverse.prototype.cells = function () {
    var out = [];
    this.chunks.forEach(function (rows, key) {
      var c = decodeChunk(key), cx = c[0], cy = c[1];
      for (var r = 0; r < CHUNK; r++) {
        var w = rows[r];
        if (!w) continue;
        var y = cy * CHUNK + r;
        while (w) {
          var low = w & -w;
          out.push([cx * CHUNK + (31 - Math.clz32(low)), y]);
          w ^= low;
        }
      }
    });
    return out;
  };

  /**
   * Iterate live rows without materialising cells: `fn(x0, y, word)` where x0 is
   * the global x of bit 0 and `word` holds the row's 32 bits. This is what the
   * renderer should use — bit 31 - Math.clz32(word) is a run end, so a row can
   * be drawn as runs of set bits with no per-cell coordinates at all.
   */
  BitboardUniverse.prototype.forEachRow = function (fn) {
    this.chunks.forEach(function (rows, key) {
      var c = decodeChunk(key), cx = c[0] * CHUNK, cy = c[1] * CHUNK;
      for (var r = 0; r < CHUNK; r++) {
        if (rows[r] !== 0) fn(cx, cy + r, rows[r]);
      }
    });
  };

  Object.defineProperty(BitboardUniverse.prototype, 'occupiedChunks', {
    get: function () { return this.chunks.size; },
  });

  BitboardUniverse.CHUNK = CHUNK;
  BitboardUniverse.MAX_COORD = MAX_COORD;

  // Test hook for js/bitboard.check.mjs (the exhaustive counter check needs the
  // internal scratch planes). Not part of the app's API.
  BitboardUniverse._internals = {
    compress8: compress8,
    lastCountPlanes: lastCountPlanes,
    encodeChunk: encodeChunk,
    decodeChunk: decodeChunk,
    parseRule: parseRule,
    CHUNK: CHUNK,
    MAX_COORD: MAX_COORD,
  };

  global.BitboardUniverse = BitboardUniverse;
})(typeof globalThis !== 'undefined' ? globalThis : this);
