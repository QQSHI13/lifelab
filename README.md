# LifeLab 🔬

Conway's Game of Life — an advanced cellular automaton simulator with a comprehensive pattern library. Watch complex behaviors emerge from simple rules.

**Live Demo**: https://qqshi13.github.io/lifelab/

---

## ✨ Features

### Core Simulation
- **🎮 80x60 Grid** — Infinite canvas with smooth pan and zoom
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

Powered by [OpenClaw](https://openclaw.ai)

Pattern definitions adapted from LifeWiki and classic CA literature.
