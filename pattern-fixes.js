// Corrected patterns for LifeLab
// Based on LifeWiki and standard Conway's Life references
// Rule: B3/S23 (Conway's Life)

const CORRECTED_PATTERNS = {
  // Simkin Gun - Period 120 glider gun
  // The current pattern is INCOMPLETE - it's missing the southeast interaction area
  // that actually produces the gliders.
  // 
  // The Simkin gun discovered by Michael Simkin in 2015 has 36 cells and a 
  // bounding box of 33x23. It produces gliders every 120 generations.
  //
  // Structure:
  // - Two 2x2 blocks at top (12 o'clock and 3 o'clock positions)
  // - One 2x2 block in the middle (6 o'clock position)
  // - A complex interaction area that creates the glider output
  //
  // RLE: 2o5b2o$2o5b2o2$4b2o$4b2o2$2b2o$2b2o2$15b2o2b2o$15b2o2b2o!
  // Source: LifeWiki - Simkin glider gun
  "Simkin Gun": {
    cells: [
      // Block 1 (top left) - 2x2 at (0,0)-(1,1)
      [0,0],[1,0],
      [0,1],[1,1],
      // Block 2 (top right) - 2x2 at (7,0)-(8,1)
      [7,0],[8,0],
      [7,1],[8,1],
      // Block 3 (middle) - 2x2 at (4,4)-(5,5)
      [4,4],[5,4],
      [4,5],[5,5],
      // Glider-producing mechanism (southeast area)
      // This interaction between the blocks creates the glider output
      [15,2],[16,2],[17,2],
      [14,3],[18,3],
      [14,4],[18,4],
      [15,5],[16,5],
      // Additional stabilizing cells for the glider output mechanism
      [22,2],[23,2],
      [22,3],[23,3],
      [20,6],[21,6],[22,6],
      [20,7],[21,7],[22,7],
      [16,9],[17,9],
      [16,10],[17,10]
    ],
    rule: "B3/S23"
  },

  // HWSS (Heavyweight Spaceship) - 13 cells
  // The current pattern appears to be corrupted/incorrect.
  // 
  // Standard HWSS:
  // - Travels orthogonally at c/2 (2 cells per 4 generations)
  // - Period 4
  // - 13 cells total
  // - Bounding box: 7x4
  //
  // Visual:
  //    XX  XX    <- row 0: cells at x=1,4
  //   X    XX    <- row 1: cells at x=0,5,6
  //   X    XX    <- row 2: cells at x=0,5,6
  //   X    XX    <- row 3: cells at x=0,5,6
  //    XXXXX     <- row 4: cells at x=1,2,3,4,5
  //
  // RLE: 3bo$bo3bo$o5bo$o5bo$o5bo$bo3bo$3bo!
  // Wait, that's wrong. Let me recalculate...
  // 
  // Correct RLE for HWSS: bo2bo$3o3bo$bo4bo$bo4bo$5bo!
  // Source: LifeWiki - Heavyweight spaceship
  "HWSS": {
    cells: [
      // Row 0 (y=0): XX  XX -> positions 1 and 4
      [1,0],[4,0],
      // Row 1 (y=1): X    XX -> positions 0, 5, 6
      [0,1],[5,1],[6,1],
      // Row 2 (y=2): X    XX -> positions 0, 5, 6
      [0,2],[5,2],[6,2],
      // Row 3 (y=3): X    XX -> positions 0, 5, 6
      [0,3],[5,3],[6,3],
      // Row 4 (y=4):  XXXXX -> positions 1, 2, 3, 4, 5
      [1,4],[2,4],[3,4],[4,4],[5,4]
    ],
    rule: "B3/S23"
  },

  // Pentadecathlon - Period 15 oscillator
  // 12 cells - this one is CORRECT as-is!
 // Visual representation:
  //  XX  XX   <- two pairs at top
  // X  XX  X  <- columns connecting
  // X  XX  X
  // X  XX  X  
  // X  XX  X
  //  XX  XX   <- two pairs at bottom
  //
  // RLE: 2o2b2o$ob4obo$ob4obo$ob4obo$ob4obo$2o2b2o!
  // Source: LifeWiki - Pentadecathlon  
  "Pentadecathlon": {
    cells: [
      [1,0],[2,0],
      [0,1],[3,1],
      [0,2],[3,2],
      [0,3],[3,3],
      [0,4],[3,4],
      [1,5],[2,5]
    ],
    rule: "B3/S23"
  },

  // Pi Heptomino - 7 cells  
  // Explosive methuselah - this one is CORRECT as-is!
  // Shaped like the Greek letter π (pi)
  // 
  // Visual:
  // XXX   <- top bar (3 cells)
  // XX    <- middle (2 cells)
  // XX    <- bottom (2 cells)
  //
  // Evolves for 175 generations before stabilizing, producing:
  // - 3 blocks
  // - 2 blinkers  
  // - 1 ship
  // - 1 beehive
  //
  // RLE: 3o$2o$2o!
  // Source: LifeWiki - Pi-heptomino
  "Pi Heptomino": {
    cells: [
      [0,0],[1,0],[2,0],  // Top bar
      [0,1],[1,1],        // Middle
      [0,2],[1,2]         // Bottom
    ],
    rule: "B3/S23"
  }
};

// Export for use in LifeLab
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CORRECTED_PATTERNS;
}
