# LifeLab performance: what to build on, measured

**Question asked:** what is the fastest practical simulation + rendering approach for a
browser Life app that stays interactive, supports an unbounded/sparse universe, and ships
as a static site — and isn't there an npm stdlib we could depend on and build at ship time?

**Short answer:**

1. **There is no npm stdlib worth depending on for the simulation.** Of the two HashLife
   packages on npm, `node-gol-hashlife` cannot be used at all (it ships no `main`, and its
   API can only answer "the central quadrant of a fixed `2^n` universe, `2^k` generations
   from now"), and `ts-hashlife` works but is a *fast-forward* tool, not an interactive
   core: it can only advance in `2^k` jumps (or pay a memoisation wipe per step change) and
   holds 1–15 MB. Measured, it is **250–750×** faster than anything else on large
   *structured* patterns run deep, and **2× slower** than a bitboard on chaotic soups
   advanced one generation at a time.
2. **Adopt a chunked bitboard as the simulation core** (`tools/bench-bitboard.mjs` is a
   complete, verified reference implementation — 37/37 correctness checks against the app's
   own known-good cases). It is **8.5× faster on the R-pentomino, 18–19× on 1k–5k cell soups,
   >138× on a 100k soup, and the only core that can run ~1M cells at all.** It keeps the
   sparse/unbounded semantics, adds no dependency, and needs no build step.
3. **The renderer is the bigger win at scale.** At 1M cells the app's current `render()`
   takes **887–929 ms per frame** (1 fps) zoomed out and 119–139 ms zoomed in. A
   full-canvas `ImageData` fill does the same frame in **17.5–18.7 ms / 29.6–32.4 ms**
   (50× / 5×). At realistic populations the *stepper* is what hurts instead: at 10k cells
   it is 86 % of each generation, at 100k cells ~87 % (§4.2b). The two fixes are
   independent; both are needed.
4. **Keep 2D rendering.** WebGL points would win on real hardware, but this box has no
   GPU (Thorium reports a SwiftShader software rasteriser), so WebGL cannot be validated
   here — and under software rasterisation it is the *slowest* option measured. `ImageData`
   already reaches 57 fps at ~480k visible cells. Revisit WebGL only with hardware numbers.
5. **If** a "skip 10,000 generations" button is wanted, vendor `ts-hashlife` the way
   `droptransfer` vendors its browser deps (exact pin + `npm run vendor` + Dependabot +
   a CI job that fails when `vendor/` drifts). §7 has the exact steps.

---

## 1. How these numbers were produced

| | |
|---|---|
| Machine | Intel i7-10610U (4 vCPU, 1.8 GHz), 15 GB RAM, Linux. **Other agents were building and editing files on this box during the runs** — see the noise note below. |
| Node | v26.12.0 |
| Browser | Thorium 138.0.7204.303 via Playwright, `executable_path=/usr/bin/thorium-browser`, canvas 1200×800 (1020×847 for the in-app cross-check) |
| GPU | **none** — WebGL reports `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)` |
| Timing | Node: warm-up pass, then best of 3 (medians also recorded by the scripts). Browser: 3 warm-up draws, then N draws with **one GPU sync at the end** (`getImageData` / `readPixels`), so GPU time is included. |
| Repository state | `1cb3712 fix(patterns): make every library pattern verifiably true…` — all benchmarks were run against the cores as of that commit; `index.html` was never modified. |

Reproduce:

```bash
node tools/bench-bitboard.mjs              # correctness suite + stepper benchmarks
node tools/bench-libs.mjs --npm-install    # installs the pins in /tmp/opencode/hl-bench
node --expose-gc tools/bench-libs.mjs      # library comparison + memory + edit cost
node tools/bench-render.mjs                # renderer shoot-out (needs playwright + thorium)
node tools/bench-render.mjs --quick --shots
```

**Honesty notes.**

* Repeated runs of the same workload varied by up to ±40 % on this box, and up to ~4× on
  the tiny blinker case (a shared 4-core machine, with a concurrent agent editing
  `index.html` and `patterns/*.json` throughout). Every table below uses **best-of-N after
  warm-up**, i.e. the least-contended run. Rankings were stable across runs; differences
  below ~1.3× are not meaningful and I call those "a tie" in the text.
* The `Map core` column is the app's current `stepCore()` replicated exactly in
  `tools/bench-common.mjs`, budgeted to 6 s per workload. A cell like `6.00 s @27g` means
  it only reached generation 27 in 6 s and was stopped; the speed-up column is a lower
  bound derived from the generations it did complete.
* Memory figures are heap deltas with `global.gc()` before and after, so they are
  approximate (±1 MB).
* The registry search API (`/-/v1/search`) is unreachable from this box, so I could not
  enumerate every hashlife-like package; I fetched and evaluated the two packages that are
  named for the algorithm. `npm view`, tarball fetches and installs all worked fine.

---

## 2. Simulation: the app's core vs. a chunked bitboard

`tools/bench-bitboard.mjs` implements the universe as `Map<chunkKey, Uint32Array(32)>` —
32×32-cell chunks, one bit per cell. Each generation computes, per row, the eight
neighbour planes with shifts and a carry from the adjacent chunks, sums them **bit-sliced**
(a carry-save adder tree of 4 half-adders + 4 full-adders compressing 8 one-bit planes into
the 4 bits of the per-cell neighbour count, in parallel across all 32 columns), and applies
`(born & ~alive) | (survive & alive)`. Chunk coordinates are single numeric keys, so
neighbour lookups are integer addition with no string building.

Correctness (28/28, `node tools/bench-bitboard.mjs --quick`):

* the bit-sliced counter verified exhaustively over all 256 input combinations;
* glider 4 gens = same shape translated (1,1); blinker period 2; block still life;
* R-pentomino **1103 gens → exactly 116 cells**; diehard dies at 130; acorn settles at
  5206 with **633 cells**; Gosper gun grows;
* agreement with the repo's reference stepper (`tools/verify-patterns.mjs`) on random
  70×70 soups for **all four app rules** (B3/S23, B36/S23, B3678/S34678, B2/S);
* patterns straddling chunk seams, and at ±900,000 cells from the origin;
* chunk-key encode/decode round-trips at the ±2¹⁹-chunk range extremes, out-of-range rejected.

### 2.1 Workload table (best of 3, warm-up discarded)

| workload | live | gens | Map core (current) | bitboard | speed-up |
|---|---:|---:|---:|---:|---:|
| blinker | 3 | 2,000 | 21.6 ms | 23.6 ms | **0.9×** |
| r-pentomino | 5 | 1,103 | 640 ms | 73 ms | 8.5× |
| acorn | 7 | 5,206 | 6.01 s *(only reached gen 3,719)* | 803 ms | > 10× |
| gosper gun | 36 | 10,000 | 6.00 s *(4,171)* | 4.53 s | > 3× |
| gun 3×3 array | 324 | 3,000 | 6.00 s *(1,131)* | 2.05 s | > 7× |
| glider grid 60×60 | 18,000 | 1,000 | 6.07 s *(53)* | 3.62 s | > 30× |
| random 45×45 soup | 980 | 1,000 | 2.31 s | 125 ms | 18× |
| random 100×100 soup | 4,931 | 500 | 2.80 s | 112 ms | 19× |
| random 450×450 soup | 101,075 | 100 | 6.13 s *(27)* | 154 ms | > 138× |
| random 1000×1000 soup | 499,581 | 50 | *skipped (would OOM/slog)* | 273 ms | — |
| random 1415×1415 soup | 1,000,327 | 20 | *skipped* | 210 ms | — |
| Seeds exploder (B2/S) | 5 | 200 | 3.88 s | 23 ms | 159× |
| Day & Night 200×200 | 19,975 | 100 | 6.05 s *(97)* | 35 ms | > 168× |

**The one row the bitboard loses is the blinker** — 3 cells in 1 chunk, 23.6 ms vs 21.6 ms
for 2,000 generations. Both are ~11 µs per generation, i.e. ~90,000 generations/second.
That is a tie in any interactive sense, so there is no reason to keep two cores: 11 µs is
0.07 % of a 16 ms frame. (The r-pentomino row is the reason not to keep the Map core "for
small patterns" either: 5 cells already wins 8.5× with the bitboard, because the Map core's
cost is per-cell-with-9-string-keys while the bitboard's is per-occupied-chunk.)

Between runs this table moved by up to ~2× per cell (e.g. the 5k soup: 60 ms in one run,
112 ms in another) — the ratios are the stable part.

### 2.2 Scaling and the cost of the statistics counters

| scale | live | gens | total | ms/gen | ms/gen, stats off | throughput |
|---|---:|---:|---:|---:|---:|---:|
| ~1k | 980 | 200 | 17.6 ms | 0.09 | 0.06 | 11M cell-gen/s |
| ~100k | 101,075 | 50 | 62.2 ms | 1.24 | 1.08 | 81M cell-gen/s |
| ~1M | 1,000,327 | 10 | 153 ms | 15.3 | 14.7 | 65M cell-gen/s |

Population/birth/death tracking costs 4–13 % at 100k+ and up to ~30 % at 1k (and appeared to
be free in another run) — call it "within noise, no more than ~30 %". The app needs the
counters for its stats panel, so the default is stats **on**.

**Hot-loop cost: 118 ns per 32-cell chunk-row** (fully occupied 32×32-chunk universe, 1M
cells; 122 ns with the population counters on). That is the number to quote: the stepper's
cost is `occupied_chunks × 32 rows × ~120 ns`, i.e. proportional to occupied *area*, not
population. A soup that thins out does not get cheaper — visible in the ~1k row above,
where 980 cells spread over 27 chunks cost more per cell than 1M cells packed densely.

### 2.3 Where the time went (and what made it 25× faster)

The first working version was only 1.7× faster than the Map core. Profiling the pieces
(`/tmp/opencode` scratch probes, reproduced in the numbers below) showed the bit math was
never the problem:

The ablations that produced the 13× gain were measured as (1024 fully-occupied chunks, per
generation):

| phase | before | after |
|---|---:|---:|
| `activeSet()` dilation, `"cx,cy"` string keys | 3.35 ms | 0.3 ms (numeric keys, no parsing) |
| 9 neighbour chunk lookups (`fillBand`) | 6.81 ms | ~0.9 ms (`Map.get` on numeric keys) |
| output Map rebuild + row copy | 1.67 ms | 1.5 ms |
| the actual row kernel (32 rows × 1024 chunks) | 3.3 ms | 3.3 ms |
| **total per generation** | **15.2 ms** | **~6 ms** |

Two lessons worth keeping: (a) `"x,y"` string keys were 78 % of the step — a single
numeric chunk key is 4–10× faster to hash than the equivalent string; (b) a per-row
early-out (`if ((up|mid|down|edges) === 0) skip`) makes the 8 dilation-only chunks that
surround every occupied chunk nearly free, which is what turned sparse cases from a loss
into an 8–40× win.

---

## 3. The libraries

`npm view` / registry metadata (installed and read in `/tmp/opencode/hl-bench`, never in
the repo):

| | `ts-hashlife` | `node-gol-hashlife` |
|---|---|---|
| latest / publish date | 0.1.18, **2025-03-14** (21 versions, all Mar 2025) | 0.1.1, **2015-08-12** |
| license | BSD-2-Clause | MIT |
| runtime deps | none | none declared |
| `main` / `type` | `dist/cjs/index.js`, ships ESM + CJS + browser bundle | **no `main` at all** |
| unpacked size / files | 610 KB, 54 files (min browser bundle 27 KB) | ~90 KB, CoffeeScript source + built `lib`/`dist` |
| source language | TypeScript (port of `copy/life`) | CoffeeScript |
| maintenance | single author, no release in ~19 months, no CI visible | abandoned since 2015 |

### 3.1 `node-gol-hashlife` is not usable — verdict: reject

* `require('node-gol-hashlife')` throws `MODULE_NOT_FOUND` from a fresh install: the
  package has **no `main` field** and `index.js` does not exist. Its README tells you to
  `require("gol")`, which is a different name from the published package. Only
  `require('node-gol-hashlife/dist/gol.js')` works.
* Its API is `new Simulation(level)` — a **fixed `2^level × 2^level` universe** — plus
  `set(x, y)` and `get(k)`, which returns the state **`2^k` generations ahead, and only
  for the central quadrant**. `get()` does not advance the simulation, so you cannot chain
  calls to reach generation 1,103; and there is no way to step one generation at a time.
  This fails three of the app's non-negotiables (unbounded universe, exact arbitrary
  generation counts, interactive stepping).

### 3.2 `ts-hashlife` works, and is very fast — but it is a fast-forward engine

Correctness: **12/12 checks pass**, including R-pentomino 1103 → 116 cells, acorn 5206 →
633, diehard → 0 at 130, a one-shot `2^10` jump to generation 1024 (shape compared with the
bitboard), and a random 70×70 soup after 30 generations compared cell-for-cell with the
bitboard. So it agrees with the app's existing expectations.

API surface actually needed (from `src/life-universe.ts`):

```
life = new LifeUniverse(); life.clear_pattern();
life.set_rules(sMask, bMask);            // bit k set == digit k, e.g. B3/S23 -> s=1<<2|1<<3, b=1<<3
fx/fy = Int32Array of coordinates;  b = life.get_bounds(fx, fy)
life.make_center(fx, fy, b);  life.setup_field(fx, fy, b)
life.next_generation(isSingle)           // advances 2^step generations (isSingle) or the quick path
life.set_step(k);  life.generation;  life.root.population
life.node_get_field(life.root, -2^(level-1), -2^(level-1), out)   // all live cells
life.set_bit(x, y, living); life.get_bit(x, y)                    // edit; silently ignores out-of-root coords
life.save_rewind_state() / restore_rewind_state()                  // the app's "back to start"
formats.parse_pattern(text) / formats.generate_rle(life, name, []) // RLE import/export
```

Semantics verified directly: `next_generation(true)` with `set_step(k)` advances **exactly
`2^k` generations** and the generation counter is exact; `set_step()` invalidates the whole
memo table (`uncache`), so changing step size mid-run throws away the thing that makes
HashLife fast.

Packaging problems found (all verified, not guessed):

* **The ESM entry does not load under Node** — `dist/esm/*.js` import `"./life-universe"`
  with no file extension, so `import ... from 'ts-hashlife'` fails with
  `ERR_MODULE_NOT_FOUND` on Node 26. Bundlers resolve it; Node does not. The CJS entry and
  the prebuilt browser bundle (`browser/hashlife.min.js`, esbuild, `--global-name=HashLife`)
  both work.
* Its `Game`/`HashLife` class is a whole demo app (module-level `new LifeCanvasDrawer()`,
  `window.requestAnimationFrame` in `handleStart`) — use `LifeUniverse` + `formats`, not `Game`.

### 3.3 Head-to-head (Node, warm-up + best of 3, `--expose-gc`)

`hashlife 1/gen` = one generation per `next_generation(true)` call at `step = 0` (memoisation
intact — this is the only mode that supports genuinely interactive stepping).
`hashlife exact` = binary-decomposed to the exact generation count (pays one memo wipe per
step change). `hashlife coarse` = one fixed `2^k` step size (fastest, overshoots the target).

| workload | live | gens | Map core | bitboard | hashlife 1/gen | hashlife exact | hashlife coarse |
|---|---:|---:|---:|---:|---:|---:|---:|
| r-pentomino 1103 gen | 5 | 1,103 | 521 ms | 95.9 ms | 136 ms | **54.9 ms** | 47.0 ms (2048g) |
| gosper gun 10000 gen | 36 | 10,000 | 5.00 s *(4,032)* | 4.30 s | 169 ms | **16.8 ms** | 4.41 ms (16384g) |
| random 100×100 soup 500 gen | 4,931 | 500 | 2.14 s | **90.7 ms** | 730 ms | 197 ms | 165 ms (512g) |
| glider grid 60×60, 1000 gen | 18,000 | 1,000 | 5.08 s *(52)* | 3.16 s | 82.0 ms | 15.6 ms | **8.23 ms** (1024g) |
| gun 3×3 array, 3000 gen | 324 | 3,000 | 5.00 s *(1,187)* | 2.05 s | 3.15 s | **512 ms** | 1.13 s (4096g) |

What that says (and the same table run twice moved HashLife's columns by up to 3× — e.g.
the gun's exact mode read 5.9 ms in one run and 16.8 ms in another, so read HashLife's
absolute numbers as "tens of milliseconds", not as three significant figures):

* **Large + structured + deep = HashLife by a mile.** Gosper gun 10,000 generations:
  4.4–16.8 ms vs the bitboard's 4.3–4.4 s — **250–750×**. Glider grid 1000 generations:
  8.2–15.6 ms vs 3.2 s — **200–390×**. This is exactly what HashLife is for, and guns and
  glider fleets are what the app's `guns.json`/`ships.json` are full of.
* **Chaotic = bitboard.** The 100×100 soup, one generation at a time: bitboard 90.7 ms vs
  hashlife 730 ms (1/gen) and 197 ms (exact). A bitboard beats HashLife ~2× on chaos —
  HashLife's memo table has nothing to compress. Note the memory table below shows the same
  thing from the other side.
* **HashLife's 1/gen mode is not interactive for chaos** (730 ms for 500 generations of a
  5k-cell soup, and it is *slower* than the bitboard on the small gun array: 3.15 s vs
  2.05 s). It only shines when you hand it a big jump.
* Neither third-party engine removes the need for the bitboard, and the bitboard removes
  the need for the Map core.

### 3.4 Memory (heap delta after the run, `--expose-gc`)

| workload | ts-hashlife | bitboard |
|---|---:|---:|
| r-pentomino, 1103 gen | 4.8 MB | 2 KB |
| gosper gun, 10,000 gen | 1.5 MB | 71 KB |
| random 100×100 soup, 500 gen | 10.4 MB | ~0 (read as −1 KB; GC noise) |
| glider grid 60×60, 1000 gen | 1.2 MB | 302 KB |
| gun 3×3 array, 3000 gen | 14.5 MB | 68 KB |

HashLife's table is the price of its speed, and it is worst exactly where it is least
useful (chaotic soups: 10.4 MB for a 5k-cell soup, because nothing compresses). 15 MB is
acceptable for a desktop tab; it is a lot for a phone PWA that already caches the app
shell. The ±1 MB resolution of this measurement means the bitboard's numbers should be read
as "a few KB up to a few hundred KB at 1M cells".

### 3.5 Interactive editing (the mouse-drag path)

| cells edited | hashlife rebuild | hashlife `set_bit` | hashlife 1 gen | bitboard `set` | bitboard 1 gen |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 6.72 ms | 6 ns | 0.58 ms | < 0.5 µs | 0.23 ms |
| 18,000 | 6.65 ms | 3 ns | 0.60 ms | < 0.5 µs | 3.98 ms |

`set_bit` is cheap, but a HashLife *field* has to be rebuilt from scratch (~8 ms, mostly
universe sizing) whenever the working set changes, and `set_bit` **silently ignores
coordinates outside the current root's half-extent** (the root only grows via
`next_generation`), so an app that edits near the edge of an unbounded universe has to
manage the universe size itself. The bitboard's `set` is a hash lookup + bit set — the
natural fit for a brush tool — and its `stepOnce` is 0.2–2.9 ms for these sizes.

---

## 4. Rendering

`tools/bench-render.html` (served from a scratch copy by `tools/bench-render.mjs`) paints
the identical deterministic soup with four renderers, at two zooms, and times N draws with
one GPU sync at the end:

* **A — canvas path**, a faithful transcription of `index.html`'s `render()`: one
  `ctx.rect` per visible cell accumulated into a single path, one `fill()`.
* **B — `ImageData` at canvas resolution**: one `Uint32Array` write per screen pixel
  (whole cell blocks when cells are large), one `putImageData`.
* **C — WebGL points**: one `drawArrays(POINTS)` of every cell, size via `gl_PointSize`.
* **D — offscreen 1 px/cell `ImageData` + scaled `drawImage`** with smoothing off.

### 4.1 Frames per second (1200×800 canvas, per-frame ms / effective fps, one run)

| cells | live | zoom | A canvas path | B ImageData | C WebGL points | D offscreen+drawImage |
|---:|---:|---|---:|---:|---:|---:|
| 10k | 10,136 | in, 8 px | 10.5 ms / 96 | 12.5 ms / 80 | 31.3 ms / 32 | **3.27 ms / 306** |
| 10k | 10,136 | out, 1 px | 8.11 ms / 123 | **1.62 ms / 617** | 6.39 ms / 156 | 4.51 ms / 222 |
| 100k | 100,168 | in, 8 px | 8.52 ms / 117 | 5.83 ms / 171 | 29.8 ms / 34 | **4.23 ms / 237** |
| 100k | 100,168 | out, 1 px | 87.9 ms / 11 | **2.42 ms / 413** | 87.5 ms / 11 | 6.47 ms / 155 |
| 1M | 1,000,327 | in, 8 px | **16.0 ms / 63** | 32.4 ms / 31 | 274 ms / 4 | 11.3 ms / 89 |
| 1M | 1,000,327 | out, 1 px | **1370 ms / 1** | **17.5 ms / 57** | 397 ms / 3 | 21.6 ms / 46 |

(drawn counts: 7.3k of 10k at 8 px for the 10k case; 7.4k of 100k; 7.4k of 1M. At 1 px,
482k of the 1M cells are on screen. C submits every cell and lets the GPU clip.)

This is one run; a repeat swung the noisiest cells by up to ~1.7× (e.g. B at 10k/8 px was
7.35 ms in another run, C at 100k/1 px was 53.9 ms). The *orderings* were identical in
every run, and they are what the recommendation rests on.

### 4.2 The same thing, through the real app

`tools/bench-render.mjs` also loads a snapshot of `index.html`, fills its actual
`grid` Map with the same soup, sets `zoom`/`offsetX`/`offsetY`, and times its real
`render()` (canvas 1020×847, as the app lays it out):

| cells | live in the Map | in, 8 px | out, 1 px |
|---:|---:|---:|---:|
| 10k | 10,136 | 11.2 ms (89 fps) | 8.8 ms (113 fps) |
| 100k | 100,168 | 23.0 ms (43 fps) | 110 ms (9 fps) |
| 1M | 1,000,327 | 119 ms (8 fps) | **887 ms (1 fps)** |

The app is slower than renderer "A" for the same cell counts because it iterates
`grid.forEach` and parses an `"x,y"` string per cell, and at 8 px because it still walks
all 1M entries even though only ~7.7k are on screen.

### 4.2b Where a generation actually goes

Same driver, but timing the app's own `step()` — `saveHistory()` (a full `Map` clone) +
`stepCore()` + `updateStats()` (DOM writes) + `render()` — and then each piece on its own:

| workload | live | `step()` total | per generation | `stepCore()` only | saveHistory clone | `updateStats()` | `render()` |
|---|---:|---:|---:|---:|---:|---:|---:|
| blinker | 3 | 96.6 ms / 2000 | 0.048 ms | 11.4 µs | ~0 | 10 µs | 70 µs |
| 10k soup | 10,136 | 7.36 s / 2000 | 3.68 ms | **3.17 ms (86 %)** | 0.12 ms | 10 µs | 95 µs |
| 100k soup | 100,168 | 1.07 s / 5 | 213 ms | **186–263 ms (≈87 %)** | **~10–14 ms** | 0.1 ms | 12.8 ms |

Read together with §4.1 this splits the problem cleanly:

* **Below ~1k cells there is nothing to fix.** The stepper is ~11 µs per generation and
  the whole of `step()` is ~50 µs, so the owner's *"blinker 2000 gens: 173 ms,
  render-bound"* is not a stepper problem at all — 2,000 generations of a blinker cost
  **96 ms in total here** (11 ms of it the stepper), and the run-to-run spread on this
  shared box is up to 4× even for that. There is no fixable hot spot; that measurement is
  the app's per-generation overhead, which is already ~10–70 µs per piece.
* **From ~10k cells the stepper is the bottleneck** (86–87 % of each generation). This is
  what the bitboard replaces: 3.17 ms → ~0.1 ms per generation at 10k cells, 186–263 ms →
  ~1.7 ms at 100k.
* **Once the stepper is fast, `saveHistory()` is next** — it deep-copies the whole `grid`
  `Map` (string keys) on *every* generation: 10–14 ms at 100k cells, i.e. 5 % now and ~90 %
  after the stepper swap. The bitboard's `clone()` copies ~128 B per *chunk*
  (~13 KB at 100k cells) instead of ~100k Map entries.
* **`render()` is the ceiling on how much can be shown**, and its rasterisation cost (not
  its CPU cost — only 12.8 ms of the 100k/1 px frame is CPU) is what §4.1 measures.

Caveat: the fixed ~10–20 ms per-canvas-update visible in the app's `render()` column is
this box re-rasterising the whole canvas in software (see §4.3); on a GPU machine the
absolute frame times would be much lower, but the ordering between the four renderers and
the per-cell/per-pixel scaling are hardware-independent.

### 4.3 Reading the renderer results

* **No GPU on this box.** WebGL's numbers are from SwiftShader (software rasterisation):
  274–397 ms at 1M cells. On hardware this row would be ~1–2 ms. It is included for
  completeness, not as a recommendation — but it does mean the WebGL path **cannot be
  validated here**, and the app has to work on GPU-less machines (VMs, locked-down
  corporate browsers, `--disable-gpu`).
* **A is the only renderer that gets slower than the display refresh at 100k+.** It is
  fine while few cells are visible (16.0 ms at 1M cells when only 7.7k are on screen) and
  fatal when many are (1.37 s at 1M/1 px).
* **B wins whenever cells are small** (2.42 ms at 100k/1 px, 17.5 ms at 1M/1 px) because its
  cost is O(canvas pixels + visible cells), not O(population). It is worse than A when cells
  are large *in my implementation* because it pays one `Uint32Array.fill` per cell row per
  block (7.3k cells × 7 fills ≈ 51k fill calls ≈ 29 ms of CPU at 1M/8 px); the same job via
  `ctx.fillRect` per cell, or a run-length fill, removes that. **Treat B's high-zoom row as
  an implementation artifact, not a verdict.**
* **D is the most consistent** (3–21 ms everywhere) because it does one pixel write per
  visible cell and one scaled `drawImage`, but it still needs a full-canvas `fillRect` and
  loses to B at 1 px.
* Refreshing the WebGL point buffer each generation costs **0.20 ms at 10k / 1.44 ms at
  100k / 2.65 ms at 1M** (7.6 MB upload) — cheap, but it is pure overhead the 2D paths do
  not have, and it is *in addition* to whatever CPU pass produced the coordinates.
* `gl.POINTS` with `gl_PointSize` is limited to 1 px on some drivers (this one allows
  1–1023), so a robust WebGL renderer needs a quads/instancing fallback for zoomed-in views.

---

## 5. Recommended architecture

```
                  ┌──────────────────────────────────────────────┐
   mouse edit ───►│  BitboardUniverse  (tools/bench-bitboard.mjs)│───► forEachRow()
                  │  Map<chunkKey, Uint32Array(32)>              │
                  └──────────────────────────────────────────────┘
                        │ step()                     │ cells()
                        ▼                            ▼
              ┌────────────────────┐        ┌────────────────────────┐
   cells ≥3px │ canvas path, per   │        │ optional fast-forward  │
   ──────────►│ run of bits        │        │ vendored ts-hashlife   │
   cells <3px │ ImageData fill     │◄───────│ (2^k jumps only)       │
              └────────────────────┘  cells └────────────────────────┘
```

**Simulation — one core: the chunked bitboard.** It is the only core that covers the whole
range the app operates in: ~7 µs/generation for a one-chunk pattern, 1.7 ms/generation at
100k cells, 17 ms/generation at 1M cells, exact arbitrary generation counts, unbounded
sparse coordinates, sub-microsecond `set()`/`get()` for the drawing tools. The Map core
survives only in the "3-cell blinker" case, where it is ~20 % faster (12.5 vs 14.3 ms per
**2,000** generations) — the same as a tie, and not worth a second code path, a second set
of correct-behaviour tests, and an engine-selection heuristic.

**Rendering — keep 2D, pick by zoom.** Both paths should read the bitboard's row words
(`forEachRow(x0, y, word)`), which removes the per-cell `"x,y"` parse entirely (that parse
is most of the app-vs-"A" gap above):

* cells ≥ ~3 px on screen (few cells, many pixels): the existing batched canvas path, but
  emit **one rect per run of set bits** rather than one per cell — for structured patterns
  (guns, oscillators) that is a large constant-factor win, and it keeps the anti-aliased
  crisp look.
* cells < ~3 px (many cells, ≤1 px each): `ImageData` at canvas resolution — one
  `Uint32Array` write per visible cell — then a single `putImageData`. This is what turns
  887 ms into 17.5 ms at 1M cells.

**WebGL: not now.** It cannot be validated on this machine, it needs a second renderer with
a quads fallback, and the CPU-bounded alternative already holds 57 fps at ~480k visible
cells. Revisit if a hardware measurement on the target devices shows the `ImageData` path
missing frame budget — the numbers to beat are 17.5 ms (1M cells, 1 px) and 2.4 ms
(100k cells, 1 px).

**Optional: HashLife fast-forward.** Only worth it for a "jump N generations" affordance on
big structured patterns, where it is 250–750× faster. §7 has the integration.

### 5.1 Expected effect on the app's own numbers

| the owner's measurement | today (measured here) | with bitboard + `ImageData` |
|---|---:|---:|
| blinker 2,000 gens, `stepCore()` only | 10.8 µs/gen | 11.8 µs/gen *(a tie either way)* |
| blinker 2,000 gens, full `step()` | 96 ms (owner saw 173 ms under load) | ~85 ms (the stepper swap barely moves it) |
| R-pentomino 1103 gens end-to-end | 1,111 ms (owner) | ~80 ms |
| 10k-cell soup, per generation | 3.68 ms (3.17 stepper) | ~0.6 ms (0.1 stepper + 0.5 rest) |
| 100k-cell soup, per generation | 213 ms (186–263 stepper, ~12 clone) | ~5 ms (1.2 stepper + ~0.01 clone + rest) |
| 1M cells, one rendered frame, zoomed out | 887–929 ms | 17.5 ms |
| 1M cells, one rendered frame, zoomed in | 119–139 ms | ~11–32 ms |

---

## 6. What I did **not** measure

* **Real GPU rendering.** Only SwiftShader was available; WebGL ranks are unknown.
* **Mobile / low-power devices.** The app is a PWA with a service worker, so this matters,
  and nothing here was measured on ARM or with a thermal-limited phone.
* **WASM.** A C/Rust QuickLife or bitboard compiled to WASM should beat every JS core here
  on the dense cases — the JS row kernel is ~170 ns per 32-cell row, i.e. 60-odd bitwise
  ops, and WASM SIMD would cut that. It is a genuinely open option, but it *does* require a
  build step and a toolchain, which is the thing this site has deliberately avoided.
* **Long HashLife runs** (memory growth over 10⁶ generations) and multi-pattern stress.
* **The app's real rAF loop** with the simulation and the UI panels in the mix; all numbers
  are for `stepCore()`/`stepOnce()`/`render()` in isolation.
* **The dirty-rectangle renderer** (repaint only changed regions). Potentially the biggest
  remaining render win for the interactive/zoomed-in case; not attempted.

---

## 7. Integration

Nothing below is included in this commit — `index.html`, `patterns/` and
`tools/verify-patterns.mjs` were off-limits while another agent was editing them. This is
the follow-up work list.

### 7.1 Bitboard as the core (recommended)

The app has no build step, so the stepper must be a plain classic script. Take the class
from `tools/bench-bitboard.mjs` (everything except the benchmark and CLI sections), give it
a local copy of `parseRule` (the 8-line function it currently imports from
`tools/verify-patterns.mjs`, which is also imported as `bench-common.mjs` here — the shipped
class must import nothing), drop it in **`js/bitboard.js`**, and load it before the main
script:

```html
<script src="js/bitboard.js"></script>   <!-- defines class BitboardUniverse -->
```

Then, in `index.html`:

| # | line(s) | today | change to |
|---:|---|---|---|
| 1 | 588 | `let grid = new Map(), history = [], …` | `let universe = new BitboardUniverse(ruleKey()), history = [], …` |
| 2 | 519–620, 889, 1507, `setRule` (1580) | `rule = RULES[key]` / `parseRule(...)` | also `universe.setRule(ruleKey())` — the rule change must rebuild the term tables (add `setRule(str)` to the class; it must `throw` on B0) |
| 3 | 930–983 | `getCell()`, `stepCore()` | delete both; `step()` (985) calls `universe.stepOnce()`. `births`/`deaths`/`population`/`generation` now come from the universe |
| 4 | 918, 969, 1412 | `grid.has(key)` | `universe.get(x, y)` |
| 5 | 858, 923, 924, 1060 | `grid.set(key, 1)` / `grid.delete(key)` | `universe.set(x, y)` / `universe.set(x, y, false)` |
| 6 | 948, 963 | `grid.forEach(…)` inside `stepCore` | gone with `stepCore()` |
| 7 | 995, 1006, 1024 | `grid: new Map(grid)` (undo/redo snapshots) | `universe.clone()` — add a `clone()` that copies the chunk Map and each `Uint32Array(32)`. Today this clone costs **10–14 ms per generation at 100k cells** (it deep-copies every string key); the bitboard version copies ~128 B per occupied chunk (~13 KB at 100k cells, ~130 KB at 1M), i.e. ~1000× cheaper, and it is the next bottleneck after the stepper |
| 8 | 1003–1037 | `grid = state.grid` | `universe = state.universe` |
| 9 | 1041, 1050 | `grid.clear()` | `universe.clear()` |
| 10 | 1073, 1570 | `population = grid.size` / `() => grid.size` | `universe.population` |
| 11 | 1156–1170 | the cell loop in `render()` | see 7.3 |
| 12 | 1385 | `patternBounds()` parses every key | use `universe.bounds()` — already implemented in the reference class, and it reads chunk words instead of parsing keys |
| 13 | 1412, 1459 | RLE/PNG export parse keys / `forEach` | `universe.cells()` (or `forEachRow` for the PNG) |
| 14 | 1573 | `cells: () => Array.from(grid.keys())…` (public API, used by the pattern verifier) | `universe.cells()` |
| 15 | anywhere panning is unbounded | — | clamp to ±16.7M cells, or catch the `RangeError` from `universe.set` — the numeric chunk key is exact for \|cx\|,\|cy\| < 2¹⁹ chunks |

Behaviour notes: `set()` throws on B0 rules (`B0/…` fills the infinite plane); the app's
four rules are unaffected, but a pasted RLE rule could be `B0/…`, so wrap the rule-change
path in a try/catch and keep the old rule on failure. The bitboard's `cells()`/`forEachRow()`
already match the app's cell ordering expectations closely enough for the verifier.

### 7.2 Renderer

Replace the loop at `index.html:1158-1170` with:

```js
if (cellW >= 3) {
  // batched path, one rect per run of 1-bits (not per cell)
  ctx.fillStyle = '#58a6ff'; ctx.beginPath();
  universe.forEachRow((x0, y, word) => {
    if (y < startY || y > endY) return;
    let w = word;
    while (w) {
      const lead = Math.clz32(w), tz = 31 - Math.clz32(w & -w);   // run [tz, 31-lead]
      const x = x0 + tz, len = 31 - lead - tz + 1;
      if (x + len >= startX && x <= endX) ctx.rect(x*cellW+offsetX+1, y*cellH+offsetY+1, len*cellW-2, Math.max(cellH-2, .5));
      w = len === 32 ? 0 : w & ~((((1 << len) - 1) << tz));       // 32-bit runs need the guard
    }
  });
  ctx.fill();
} else {
  // one pixel per cell into a persistent ImageData, then one putImageData
  // (create `img`/`buf`/`u32 = new Uint32Array(img.data.buffer)` once, on resize)
  u32.fill(0xff17110d);                        // #0d1117, 0xAABBGGRR
  universe.forEachRow((x0, y, word) => {
    const row = Math.round(y*cellH+offsetY);
    if (row < 0 || row >= canvas.height) return;
    for (let w = word; w; w &= w - 1) {
      const x = x0 + 31 - Math.clz32(w & -w);
      const px = Math.round(x*cellW+offsetX);
      if (px >= 0 && px < canvas.width) u32[row*canvas.width + px] = 0xffffa658;
    }
  });
  ctx.putImageData(img, 0, 0);
}
```

(Zoomed-in rects still need the `offsetX/offsetY` pan the app already computes; the `1`/`-2`
insets are the app's current `inset` logic.) The grid-line block above it can stay as-is.

### 7.3 If HashLife fast-forward is wanted: vendor it

Follow the pattern already used in `projects/droptransfer` (verified by reading
`scripts/vendor.mjs` and `.github/workflows/vendor.yml` there):

* **`package.json`** (new, in this repo):
  ```json
  { "name": "lifelab", "version": "0.0.0", "private": true,
    "scripts": { "vendor": "node scripts/vendor.mjs" },
    "devDependencies": { "ts-hashlife": "0.1.18" } }
  ```
* **`scripts/vendor.mjs`**: copy `node_modules/ts-hashlife/browser/hashlife.min.js` to
  `vendor/ts-hashlife.min.js`, and write `vendor/VERSIONS.json` with the resolved version
  and the BSD-2-Clause licence notice (the bundle is third-party code; keep its copyright).
  Prefer the browser bundle over `dist/esm` — the ESM entry is broken under Node's resolver.
* **`.github/dependabot.yml`**: `package-ecosystem: npm`, `directory: "/"`, weekly.
* **`.github/workflows/vendor.yml`**: `actions/checkout` → `setup-node` → `npm ci` →
  `npm run vendor` → fail if `git diff --quiet -- vendor/` is non-empty. That is what keeps
  the committed bundle and the pin from drifting.
* **Load it** with `<script src="vendor/ts-hashlife.min.js"></script>` (exposes the global
  `HashLife`) — still no build step for the site itself; the build step is only "run
  `npm run vendor` when the pin changes".
* **Use it** as a *fast-forward*, not as the core:
  1. `life = new HashLife.LifeUniverse(); life.clear_pattern(); life.set_rules(s, b)` where
     `s`/`b` are bitmasks built from the app's rule arrays;
  2. `life.setup_field(fx, fy, bounds)` from `universe.cells()` (≈ converts the bitboard in
     O(cells));
  3. jump: pick the largest `k` with `2^k <= remaining`, `life.set_step(k)`,
     `life.next_generation(true)` — this advances **exactly** `2^k`;
  4. to land on an exact generation, finish with `set_step(0)` and single steps, or accept
     up-to-`2^k` overshoot (the app's turbo mode already runs several generations per
     frame, so an overshoot is a UI decision, not a bug);
  5. read back with `life.node_get_field(...)` and re-load the bitboard, or render straight
     from the returned cells.
  Costs to state in the UI/commit: 1–15 MB of table, one memo wipe per step-size change,
  no genuine "step back" (it does have `save_rewind_state`/`restore_rewind_state`), no
  cheap arbitrary single-generation stepping.

### 7.4 If a *dependency-free* fast-forward is wanted instead

The same "jump" effect can be approximated without any library by stepping the bitboard in
a tight loop with no rendering — 1.2 ms per generation at 100k cells, 15 ms at 1M cells —
so a 1,000-generation jump at 100k cells is 1.2 s vs HashLife's ~13 ms. The library is only
worth its weight where that gap matters (big structured patterns, deep jumps).

---

## 8. Risk and cost summary

| option | speed | dependency | build step | exact gens | unbounded | risk |
|---|---|---|---|---|---|---|
| Map core (today) | baseline | none | none | yes | yes | unusable past ~100k cells |
| **chunked bitboard** | **8–170× faster** | none | none (one file) | yes | yes (±16.7M cells key range) | low: 37 verified checks, plain JS |
| ts-hashlife exact | 250–750× on structured, **2× slower on chaos** | yes (BSD-2, stale 19 months, broken ESM entry) | `npm run vendor` | yes, at a memo-wipe per step change | one memo table, 1–15 MB | medium: third-party, needs a second engine and state conversion |
| ts-hashlife coarse | fastest on structured | as above | as above | no — `2^k` only | as above | medium, plus UI semantics change |
| node-gol-hashlife | n/a | n/a | n/a | **no** | **no** | **reject**: no `main`, `2^k` query only, central quadrant only, 2015 |
| WebGL points | unknown here (software raster) | none | none | n/a | n/a | medium: unvalidated, needs a quads fallback, +2.65 ms/frame upload at 1M |

---

## 9. Files added by this investigation

| file | what it is |
|---|---|
| `tools/bench-common.mjs` | shared harness: canonical patterns, `MapCore` (the app's current core, replicated), deterministic soup / glider-grid / gun-array generators, timing and table helpers |
| `tools/bench-bitboard.mjs` | **the reference implementation** — the chunked bit-sliced stepper (`BitboardUniverse` with `set`/`get`/`toggle`/`load`/`clear`/`clone`/`bounds`/`setRule`/`step`/`stepOnce`/`cells`/`forEachRow`), its 37-check correctness suite, and the stepper benchmarks |
| `tools/bench-libs.mjs` | `ts-hashlife` / `node-gol-hashlife`: package facts, correctness against the app's cases, the three stepping modes, memory, edit cost |
| `tools/bench-render.mjs` | Playwright + Thorium driver: scratch copy, static server, renderer shoot-out, in-app cross-check and the `step()` breakdown |
| `tools/bench-render.html` | the four renderers (A canvas path, B ImageData, C WebGL points, D offscreen + drawImage) |

No existing file was modified — `index.html`, `patterns/*.json` and
`tools/verify-patterns.mjs` are untouched — and nothing was installed inside the repo
(the npm scratch directory is `/tmp/opencode/hl-bench`).

---

## 10. After integration (measured)

The recommendations above are now shipped: `js/bitboard.js` is the app's **only**
simulation core (§7.1), `render()` has the two row-word paths (§7.2), and the undo
history snapshots a bitboard instead of the whole `Map`. HashLife fast-forward (§7.3) was
**not** vendored — it is a "jump N generations" affordance, not a core, and adding a third
engine for it was out of scope.

Measured with the same methodology as §1: Node v26.12.0, warm-up pass, then best of 3; the
Map core capped at 6 s per run. "Before" is `MapCore` from `tools/bench-common.mjs` (the
old core, replicated exactly and re-run on the same box at the same time, so the two
columns are comparable — the absolute numbers differ from §2.1 by up to ~30 %, as the
honesty note predicts). "After" is the shipped `index.html` + `js/bitboard.js`, loaded
through the stub DOM in `js/app.check.mjs`, so it is the real app code and not a copy.
Reproduce:

```bash
node tools/bench-after.mjs
node js/bitboard.check.mjs && node js/app.check.mjs && node tools/verify-patterns.mjs
```

### 10.1 Stepper (the requested workloads)

| workload | live | gens | before: Map core | after: best | after: median | speed-up |
|---|---:|---:|---:|---:|---:|---:|
| r-pentomino | 5 | 1,103 | 550 ms | **88.3 ms** | 97.2 ms | 6.2× |
| acorn | 7 | 5,206 | 6.00 s @4,225g *(capped)* | **872 ms** | 899 ms | > 8× |
| random 100×100 soup | 4,931 | 500 | 2.20 s | **73.9 ms** | 77.3 ms | 29.7× |
| random 450×450 soup | 101,075 | 100 | 6.01 s @29g *(capped)* | **109 ms** | 114 ms | > 190× |

"after" times the app's own `LifeLab.stepN(n)` — `universe.step(n)` plus one trailing
`updateStats()`/`render()`, i.e. the same hot path a fast-forward uses. Three full runs of
`tools/bench-after.mjs` (plus two `--quick` runs) put the r-pentomino at 80–88 ms, the 5k
soup at 74–86 ms and the 100k soup at 96–111 ms, so the spread is the ±30 % the §1 honesty
note predicts.

The r-pentomino's 88 ms lands on this box's §2.1 bitboard figure (73 ms), and the 100k
soup's ~1.1 ms per generation lands on §2.2's ~1.2 ms, so the port did not lose anything
against the reference implementation it was ported from.

### 10.2 The full per-generation path, now that history is cheap

`LifeLab.step()` — snapshot + stepper + stats + `render()`'s CPU pass (the stub canvas
does no rasterisation, exactly the §4.2b caveat) — per generation:

| workload | gens | total | ms/generation |
|---|---:|---:|---:|
| r-pentomino | 1,103 | 280 ms | 0.25 |
| acorn | 5,206 | 2.39 s | 0.46 |
| random 100×100 soup | 500 | 331 ms | 0.66 |
| random 450×450 soup | 100 | 250 ms | 2.50 |

Compare §4.2b: 3.68 ms/generation at 10k cells and 213 ms/generation at 100k. The 100k
soup now spends 2.50 ms per generation on *everything including the undo snapshot and the
render walk*.

### 10.3 Undo snapshots at ~100k cells (101,075 live cells)

| what | best of 5 |
|---|---:|
| before: `new Map(grid)` over 101k string keys | 25.2 ms |
| after: `universe.clone()` — exactly what `saveHistory()` does | **0.29 ms** *(86× cheaper)* |
| after: app `step()`, snapshot + stepper + stats + render | 2.48 ms |
| after: app `stepN(1)`, no snapshot or history | 2.19 ms |

The last two rows differ by 0.29 ms, which is the direct `clone()` measurement — the
substitution reconciles, so the snapshot really is that share of a generation. Across runs
the map clone measured 16–31 ms and the bitboard clone 0.13–0.29 ms (86–235× cheaper).

**Choice: `clone()`, not an incremental diff of live cells.** `clone()` copies one
`Uint32Array(32)` per *occupied chunk* (~128 B; ~26 KB for a 100k-cell soup) instead of one
entry per live cell, so it is ~90× cheaper here, and — the deciding factor — it needs no
change at the eight places that mutate the universe (brush stamp, drag line, random fill,
pattern paste, RLE load, clear, step, turbo). A diff-based history would have to be
maintained at every one of those sites and would silently corrupt the undo stack the first
time someone adds another edit path. The 50-step cap holds 50 clones: ~1.3 MB at 100k
cells, ~13 MB at 1M (bounded by occupied chunks, not population).
`stepBack()`/`stepForward()` restore a clone and the app's generation counter, and the
check suite asserts both directions.

### 10.4 Renderer

The per-cell `"x,y"` parse is gone; both paths read `universe.forEachRow()` row words.
Verified by `js/app.check.mjs` rather than by a screenshot: a 3-cell blinker at 10 px
emits **1** `ctx.rect` (one run) where the old code emitted 3, the ImageData path emits
**0** rects and exactly **1** `putImageData`, and a 3-cell blinker at 1 px writes exactly
**3** pixels into the buffer. The threshold is asserted at 3 px: 3.00 px → runs, 2.99 px →
ImageData. The §4.1 browser numbers (`887 ms → 17.5 ms` at 1M cells, 1 px) could not be
re-measured here without a browser, which the owner has asked not to use; the CPU-side
claim that survives is this: the path is O(visible cells) with no string parsing, and the
rasterisation cost is the one §4.1 measured for the identical implementation (`B`,
`ImageData`).

### 10.5 Checks

| suite | result |
|---|---|
| `node js/bitboard.check.mjs` | 37/37 reference checks + 1/1 exhaustive counter check + 12/12 port-surface checks |
| `node js/app.check.mjs` | **72/72** (blinker/block/glider/r-pentomino/diehard/acorn/gosper, 3 library patterns, RLE round-trips, brush, undo/redo, both render paths, rules, stats, `#rle=` links) |
| `node tools/verify-patterns.mjs` | 25/25 patterns, unchanged |

All three run in `.github/workflows/check.yml` on push and pull request. `tools/verify-patterns.mjs`,
`patterns/*.json`, the responsive layout, the service worker and the theme link were left
alone (the SW only gained `./js/bitboard.js` in its precache list, with a cache-name bump
to `lifelab-v3`).

### 10.6 What was left on the table

* **HashLife fast-forward** (§7.3/§7.4) — not vendored; the bitboard's `step(n)` is now the
  jump button, and at 100k cells a 1,000-generation jump is ~1 s vs HashLife's ~13 ms. The
  library is only worth its 1–15 MB where big structured patterns are jumped deep.
* **Dirty-rectangle rendering** (§6) — the zoomed-in case still redraws the whole canvas.
* **WebGL** — still unvalidated (no GPU), as §4.3 and §7.2 say.
* **`universe.forEachRow()` walks the whole universe**, not the viewport. That is
  O(occupied rows) (~32 per chunk) and was not measurable above the noise, but a
  viewport-limited `forEachRow` is the obvious next lever for a 1M-cell soup scrolled
  far away from most of its cells.

