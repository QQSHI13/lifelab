# LifeLab 🔬

Conway's Game of Life — an advanced cellular automaton simulator with a comprehensive pattern library. Watch complex behaviors emerge from simple rules.

**Live Demo**: https://qqshi13.github.io/lifelab/

## Features

- **80x60 Grid** — Infinite canvas with pan and zoom
- **Play/Pause** — Smooth animation loop
- **Step Forward/Back** — Navigate through generations
- **Reset/Clear** — Start fresh or clear completely
- **Speed Control** — 1-60 FPS slider
- **Random Seed** — Generate random patterns
- **Multiple Rules** — Conway's Life, HighLife, Seeds, Day & Night

## Pattern Library (30+ patterns)

### Guns (2)
- **Gosper Glider Gun** — Period 30 glider gun
- **Simkin Glider Gun** — Period 120 glider gun

### Spaceships (8)
- Glider (period 4, diagonal)
- Lightweight Spaceship (LWSS)
- Middleweight Spaceship (MWSS)
- Heavyweight Spaceship (HWSS)
- Replicator (HighLife)
- Bomber (HighLife c/6)
- Butterfly (Day&Night)
- Snail (Day&Night p4)

### Oscillators (8)
- Blinker (period 2)
- Toad (period 2)
- Beacon (period 2)
- Pulsar (period 3)
- Pentadecathlon (period 15)
- Figure Eight (HighLife period 8)
- D&N P2/P4 (Day&Night)

### Still Lifes (6)
- Block, Beehive, Loaf, Boat
- Honey Farm
- White Dwarf (Day&Night)

### Methuselahs (5)
- R-pentomino, Diehard, Acorn
- Pi Heptomino
- Multiple Replicators

## Controls

- **Click** — Draw cells
- **Right-click** — Erase cells
- **Drag** — Paint/erase continuously
- **Space** — Play/pause simulation
- **Middle-click/Space+drag** — Pan canvas
- **Scroll** — Zoom in/out

## Features

- **Undo/Redo** — Step back through generations
- **Stats** — Generation count, population, births, deaths
- **GitHub Dark Theme** — `#0d1117` background, `#58a6ff` live cells
- **Canvas Rendering** — Efficient with pan and zoom
- **Touch Support** — Mobile-friendly with panning

## Technical Details

- Uses `Map` for sparse grid storage (efficient for large patterns)
- Supports multiple rule sets: B3/S23, B36/S23, B2/S, B3678/S34678
- Single-file HTML with embedded CSS/JS (~30KB)
- No dependencies

## Pattern JSON Schema

Patterns are stored in `patterns/*.json` files with the following structure:

```json
{
  "category": "still",
  "patterns": [
    {
      "name": "Block",
      "desc": "4 cells",
      "cells": [[0,0],[1,0],[0,1],[1,1]],
      "rule": ["B3/S23", "B36/S23"]
    }
  ]
}
```

The `rule` field accepts either:
- A single rule string: `"rule": "B3/S23"`
- An array of compatible rules: `"rule": ["B3/S23", "B36/S23"]`
- Omit for patterns that work with any rule

## Credits

Built by **QQ** with **Nova** ☄️

Running on [OpenClaw](https://openclaw.ai)

Inspired by John Conway's mathematical masterpiece.
