# RLE Pattern Import Design

## Overview
Add RLE (Run Length Encoded) pattern import functionality to LifeLab, allowing users to copy-paste patterns from LifeWiki and place them anywhere on the grid using a paste cursor mode.

## Goals
- Support standard RLE format (`bo$2bo$3o!`)
- Real-time validation with clear feedback
- Paste cursor placement for precise positioning
- Consistent placement UX for both RLE imports and existing pattern library

## Architecture

### Components

1. **RLE Parser Module**
   - Parse header line: `x = 3, y = 3, rule = B3/S23`
   - Parse run-length encoded data: `b` (dead), `o` (alive), `$` (newline), digits (repeat count)
   - Extract cells as array of [x,y] coordinates
   - Return: `{ width, height, rule?, cells: [[x,y], ...] }`

2. **Settings Modal Extension**
   - New "Import RLE" section below "Pattern Tips"
   - Text area for RLE input
   - Real-time validation indicator
   - "Place Pattern" button

3. **Paste Cursor Mode**
   - Global state: `pasteMode = { active: boolean, pattern: Pattern | null }`
   - Cursor changes to crosshair with ghost preview
   - Click places pattern centered on cursor
   - Escape cancels paste mode

4. **Rule Change Prompt**
   - When RLE rule differs from current: show confirm dialog
   - Options: "Switch to B3/S23", "Keep current rule"

## Data Flow

```
User pastes RLE → Real-time parse → Validation feedback
                                     ↓
                    "Place Pattern" clicked → Enter paste mode
                                     ↓
                    User clicks canvas → Place pattern at cursor
                                     ↓
                    Rule mismatch? → Show confirm dialog
```

## UI Specification

### Settings Modal - Import RLE Section

```
┌─────────────────────────────────────┐
│ Import RLE                          │
├─────────────────────────────────────┤
│ Paste RLE pattern from LifeWiki:    │
│ ┌───────────────────────────────┐   │
│ │x = 3, y = 3, rule = B3/S23    │   │
│ │bo$2bo$3o!                     │   │
│ └───────────────────────────────┘   │
│ ● Valid RLE · 3×3 cells · 5 live    │
│ [Place Pattern]                     │
└─────────────────────────────────────┘
```

- Text area: 4 rows, monospace font, full width
- Status indicator: Green dot + details when valid, red dot + error message when invalid
- Place Pattern button: disabled until valid RLE entered

### Paste Cursor Mode

- Cursor: Crosshair with semi-transparent pattern preview following mouse
- Status overlay: "Click to place pattern · ESC to cancel"
- On click: Pattern centered on clicked cell
- On ESC: Cancel paste mode, return to previous tool

### Pattern Library Enhancement

- Shift+click on pattern button: Enter paste cursor mode with that pattern
- Regular click: Continue to auto-center (current behavior)
- Visual indicator on pattern buttons for shift+click behavior (tooltip: "Shift+click to place")

## Error Handling

| Error | Feedback |
|-------|----------|
| Missing `!` terminator | Red dot + "Missing end marker (!)" |
| Invalid character | Red dot + "Invalid character 'x' at position 12" |
| Missing header | Red dot + "Missing header (x = N, y = N)" |
| Mismatched row count | Red dot + "Expected 5 rows, found 3" |
| Empty pattern | Button disabled + "Enter RLE pattern" |

## RLE Format Support

### Full Format Example
```
x = 3, y = 3, rule = B3/S23
bo$2bo$3o!
```

### Minimal Format (also supported)
```
bo$2bo$3o!
```

### Parsing Rules
- Header: `x = N, y = N [, rule = B/S]` (optional, case-insensitive)
- Data: sequence of `b` (dead), `o` (alive), `$` (row end), digits (repeat count)
- Terminator: `!` marks end
- Whitespace in data section is ignored
- Digits apply to next character: `3b` = three dead cells

## Integration Points

### With Existing Systems

1. **History/Undo**: Pattern placement calls `saveHistory()` before placing
2. **Grid Storage**: Uses existing `setCell()` function
3. **Stats**: Placement triggers `updateStats()`
4. **Render**: Pattern preview uses existing render loop with overlay

### New Functions

```javascript
// RLE parsing
function parseRLE(rleString) -> { valid: boolean, error?: string, result?: RLEPattern }
function parseRLEHeader(line) -> { x, y, rule? }
function parseRLEData(data, width, height) -> [[x,y], ...]

// Paste mode
function enterPasteMode(pattern)
function exitPasteMode()
function placePatternAt(x, y, pattern)

// UI
function validateRLEInput(text)
function updateRLEStatus(result)
```

## Testing Considerations

- Valid RLE with header and rule
- Valid RLE without header
- Valid RLE with minimal format
- Invalid: missing terminator
- Invalid: bad characters
- Invalid: wrong dimensions
- Rule mismatch prompt behavior
- Paste mode exit (ESC, place, cancel)
- History undo after placement

## Success Criteria

1. Can paste Gosper Glider Gun RLE from LifeWiki and place it
2. Real-time validation shows status within 100ms of typing
3. Paste cursor mode allows precise placement
4. Rule mismatch shows confirm dialog
5. Pattern library shift+click works for all patterns
6. ESC cancels paste mode reliably
