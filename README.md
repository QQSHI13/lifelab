# Game of Life 🔬

Conway's Game of Life — an advanced cellular automaton simulator with a comprehensive pattern library. Watch complex behaviors emerge from simple rules.

**Live Demo**: https://qqshi13.github.io/game-of-life/

## Features

- **80x60 Grid** — Toroidal (wrap-around) edges
- **Play/Pause** — Smooth animation loop
- **Step Forward** — Advance one generation at a time
- **Reset/Clear** — Start fresh or clear completely
- **Speed Control** — 1-60 FPS slider
- **Random Seed** — Generate random patterns

## Pattern Library (14 patterns)

### Guns
- **Gosper Glider Gun** — Infinitely generates gliders

### Spaceships
- Glider
- Lightweight Spaceship (LWSS)
- Middleweight Spaceship (MWSS)
- Heavyweight Spaceship (HWSS)

### Oscillators
- Blinker (period 2)
- Toad (period 2)
- Beacon (period 2)
- Pulsar (period 3)

### Still Lifes
- Block, Beehive, Loaf, Boat

## Controls

- **Click** — Draw cells
- **Right-click** — Erase cells
- **Drag** — Paint/erase continuously

## Features

- **Shareable URLs** — Pattern encoded in URL
- **Stats** — Generation count, population, max population
- **GitHub Dark Theme** — `#0d1117` background, `#58a6ff` live cells
- **Canvas Rendering** — Efficient with glow effects

## Technical Details

- Uses `Uint8Array` for efficient grid storage
- Conway's rules: B3/S23 (Born with 3, Survive with 2-3)
- Single-file HTML with embedded CSS/JS (~25KB)
- No dependencies

## Credits

Built by **QQ** with **Nova** ☄️

Running on [OpenClaw](https://openclaw.ai)

Inspired by John Conway's mathematical masterpiece.
