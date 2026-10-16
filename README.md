# LifeLab 🔬

Conway's Game of Life — an advanced cellular automaton simulator with a comprehensive pattern library. Watch complex behaviors emerge from simple rules.

**Live Demo**: https://qqshi13.github.io/lifelab/

---

## ✨ Features

### Core Simulation
- **♾️ Unbounded grid** — sparse universe with smooth zoom-to-cursor and pan
- **⏯️ Play/Pause** — Smooth animation loop at your preferred speed
- **⏭️ Step Forward/Back** — Navigate through generations frame by frame
- **🔄 Reset/Clear** — Start fresh with random seed or clear completely
- **⚡ Speed Control** — Adjustable FPS from 1 to 60

### Multiple Rulesets
- **Conway's Life** — Classic B3/S23 rules
- **HighLife** — B36/S23 (includes replicator pattern)
- **Seeds** — B2/S (explosive growth)
- **Day & Night** — B3678/S34678 (symmetric rules)

### Pattern Library (30+ Patterns)

#### Guns
- **Gosper Glider Gun** — Period 30 glider gun

#### Spaceships
- **Glider** — The classic diagonal ship
- **Lightweight/Middleweight/Heavyweight** — Orthogonal ships

#### Oscillators
- **Blinker, Toad, Beacon** — Period 2
- **Pulsar, Pentadecathlon** — Period 3 and 15

#### Still Lifes
- **Block, Beehive, Loaf, Boat** — Stable patterns

#### Methuselahs
- **R-pentomino** — Evolves for 1103 generations

And many more! Patterns are organized in a searchable sidebar library.

---

## 🆕 Interactions & tools

| Control | What it does |
|---|---|
| **Wheel / pinch** | Zoom **about the pointer**, so the cell under the cursor stays put |
| **Drag** | Draw; **right-drag erases** without switching tools |
| **Brush 1 / 2 / 3 / 5** | Round brush; strokes are interpolated so fast drags leave no gaps |
| **Turbo (T)** | 1× → 4× → 16× → 64× generations per frame, with a single redraw |
| **Grid (G)** | Toggle grid lines (auto-hidden when cells get smaller than 4px) |
| **Fit (0)** | Zoom the current pattern to fill the view |
| **PNG (P)** | Export the living pattern (not the screenshot viewport) at up to 2048px |
| **RLE (Y)** | Copy the pattern to the clipboard as canonical RLE |
| **Share (U)** | Copy a link that encodes the pattern in the URL hash |
| **Fullscreen (F)** | Fullscreen the canvas |

Other shortcuts: `space` play/pause · `s` step · `c` clear · `r` random · `d`/`e`/`v` draw/erase/pan
· `[` `]` brush size · `ctrl+z` / `ctrl+shift+z` step back / forward.

A population chart under the stats shows whether the universe is growing, stable or dying out.

## 🔌 Scripting API

The page exposes `window.LifeLab` for automation and embedding:

```js
LifeLab.placeCells([[1,0],[2,1],[0,2],[1,2],[2,2]])   // seed cells
LifeLab.place('Gosper Gun')                            // or a library pattern by name
LifeLab.stepN(1103)                                    // fast-forward, no rendering
LifeLab.population()  LifeLab.generation()  LifeLab.cells()
LifeLab.encodeRLE()   LifeLab.loadRLE(rleText)
LifeLab.setBrush(3)   LifeLab.setTurbo(16)  LifeLab.setRule('B36/S23')
```

## ✅ Verified behaviour

The simulation is checked against known results (not just "it looks alive"):

| Test | Expected | Result |
|---|---|---|
| Block, 10 generations | still life, 4 cells | ✅ |
| Blinker | vertical ⇄ horizontal, period 2 | ✅ |
| Glider, 4 generations | same shape, translated (1,1) | ✅ |
| **R-pentomino, 1103 generations** | **116 cells** | ✅ |
| RLE round-trip (glider, pulsar) | identical shape | ✅ |
| RLE from other tools | parses (`bo$2bo$3o!` → 5 cells) | ✅ |

Performance vs. the previous implementation, measured in-browser on the same machine
(1,000–2,000 generations, warm-up + best of three):

| Workload | Before | After |
|---|---|---|
| Blinker (render-bound) | 197 ms | **173 ms** |
| R-pentomino (large, 1103 gens) | 6,699 ms | **1,111 ms** (6× faster) |

The speed-up comes from tallying neighbour counts once per cell instead of re-evaluating
each cell up to nine times, and from batching every living cell into a single canvas path
rather than one `fillRect` per cell.

---

## 🚀 Usage

### Controls
- **Left Click** — Toggle cell state (draw/erase)
- **Drag** — Draw multiple cells
- **Space** — Play/Pause
- **Arrow Keys** — Step forward/backward
- **+/-** — Zoom in/out
- **R** — Random seed
- **C** — Clear grid

### UI Controls
- Play/Pause button for animation control
- Speed slider (1-60 FPS)
- Generation counter
- Pattern library sidebar with categories
- Rule selector dropdown

---

## 🛠️ Technologies

- **Frontend**: Vanilla HTML5 Canvas API
- **Language**: JavaScript (ES6+)
- **Styling**: CSS Variables, Flexbox
- **Fonts**: JetBrains Mono for the generation counter
- **Features**: PWA support, responsive design, dark theme

---

## 📦 Installation (Self-Host)

```bash
# Clone the repository
git clone https://github.com/QQSHI13/lifelab.git

# Open in browser
cd lifelab
# Open index.html in your browser or serve with any static server
```

---

## 🎓 Learn More

- [Conway's Game of Life (Wikipedia)](https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life)
- [LifeWiki](https://conwaylife.com/wiki/) — Comprehensive pattern database

---

## 📝 License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**.

See [LICENSE](./LICENSE) for details.

---

## 🙏 Credits

Built with ❤️ by **QQ** and **Nova** ☄️


Pattern definitions adapted from LifeWiki and classic CA literature.

## Star History

<a href="https://www.star-history.com/?repos=QQSHI13%2Flifelab&type=date&legend=top-left">
 <picture>
 <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=QQSHI13/lifelab&type=date&theme=dark&legend=top-left" />
 <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=QQSHI13/lifelab&type=date&legend=top-left" />
 <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=QQSHI13/lifelab&type=date&legend=top-left" />
 </picture>
</a>
