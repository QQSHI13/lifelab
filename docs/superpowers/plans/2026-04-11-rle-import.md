# RLE Pattern Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add RLE pattern import functionality with real-time validation and paste cursor placement mode.

**Architecture:** Add RLE parser functions, paste cursor mode state machine, and UI components to the existing single-file HTML structure. Integrates with existing grid Map storage and history system.

**Tech Stack:** Vanilla JavaScript, HTML5 Canvas, inline CSS

---

### Task 1: Add RLE Parser Functions

**Files:**
- Modify: `index.html` - Add after line 383 (after parseRule function)

- [ ] **Step 1: Add RLE parsing functions**

Add these functions after the `parseRule` function (around line 383):

```javascript
// RLE Parser
function parseRLE(rleString) {
    if (!rleString || !rleString.trim()) {
        return { valid: false, error: 'Enter RLE pattern' };
    }
    
    const lines = rleString.trim().split('\n');
    let header = null;
    let dataStart = 0;
    
    // Find header line (starts with x =)
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('x =') || line.startsWith('x=')) {
            header = parseRLEHeader(line);
            dataStart = i + 1;
            break;
        }
    }
    
    // If no header, try to parse data anyway (minimal format)
    if (!header) {
        header = { x: null, y: null, rule: null };
    }
    
    // Extract data lines
    const dataLines = lines.slice(dataStart).join('').replace(/\s/g, '');
    
    if (!dataLines.includes('!')) {
        return { valid: false, error: "Missing end marker (!)" };
    }
    
    const data = dataLines.split('!')[0];
    
    try {
        const cells = parseRLEData(data, header.x, header.y);
        return {
            valid: true,
            result: {
                width: header.x || Math.max(...cells.map(c => c[0])) + 1,
                height: header.y || Math.max(...cells.map(c => c[1])) + 1,
                rule: header.rule,
                cells: cells
            }
        };
    } catch (err) {
        return { valid: false, error: err.message };
    }
}

function parseRLEHeader(line) {
    const result = { x: null, y: null, rule: null };
    
    // Parse x = N
    const xMatch = line.match(/x\s*=\s*(\d+)/i);
    if (xMatch) result.x = parseInt(xMatch[1]);
    
    // Parse y = N
    const yMatch = line.match(/y\s*=\s*(\d+)/i);
    if (yMatch) result.y = parseInt(yMatch[1]);
    
    // Parse rule = B/S
    const ruleMatch = line.match(/rule\s*=\s*B(\d*)\/S(\d*)/i);
    if (ruleMatch) {
        result.rule = `B${ruleMatch[1]}/S${ruleMatch[2]}`;
    }
    
    return result;
}

function parseRLEData(data, expectedWidth, expectedHeight) {
    const cells = [];
    let x = 0, y = 0;
    let i = 0;
    
    while (i < data.length) {
        // Parse run count
        let count = 0;
        while (i < data.length && /\d/.test(data[i])) {
            count = count * 10 + parseInt(data[i]);
            i++;
        }
        if (count === 0) count = 1;
        
        if (i >= data.length) break;
        
        const char = data[i];
        
        if (char === 'b') {
            // Dead cells - just advance x
            x += count;
        } else if (char === 'o') {
            // Live cells
            for (let j = 0; j < count; j++) {
                cells.push([x + j, y]);
            }
            x += count;
        } else if (char === '$') {
            // New row
            y += count;
            x = 0;
        } else {
            throw new Error(`Invalid character '${char}' at position ${i}`);
        }
        
        i++;
    }
    
    // Validate dimensions if header provided
    if (expectedWidth && expectedHeight) {
        const actualWidth = Math.max(...cells.map(c => c[0]), -1) + 1;
        const actualHeight = Math.max(...cells.map(c => c[1]), -1) + 1;
        
        // Allow some tolerance - RLE often has trailing dead cells
        if (actualWidth > expectedWidth || actualHeight > expectedHeight) {
            console.warn(`RLE dimensions mismatch: header ${expectedWidth}x${expectedHeight}, actual ${actualWidth}x${actualHeight}`);
        }
    }
    
    return cells;
}
```

- [ ] **Step 2: Test RLE parser in browser console**

Open browser dev console and test:
```javascript
parseRLE('x = 3, y = 3\nbo$2bo$3o!')
// Expected: valid: true, result.width: 3, result.height: 3, result.cells: [[1,0],[0,1],[2,1],[0,2],[1,2],[2,2]]

parseRLE('bo$2bo$3o!')
// Expected: valid: true (minimal format)

parseRLE('bo$2bo$3o')
// Expected: valid: false, error: "Missing end marker (!)"
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Add RLE parser functions

- parseRLE(): validates and parses full RLE format
- parseRLEHeader(): extracts x, y, rule from header line
- parseRLEData(): converts run-length data to cell coordinates

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add Paste Cursor Mode State and Core Functions

**Files:**
- Modify: `index.html` - Add after Task 1 functions, before init()

- [ ] **Step 1: Add paste mode state variables**

Add after the existing state variables (around line 393):

```javascript
// Paste cursor mode state
let pasteMode = { active: false, pattern: null };
```

- [ ] **Step 2: Add placePatternAt function**

Add after loadPattern function (around line 576):

```javascript
function placePatternAt(gridX, gridY, pattern) {
    saveHistory();
    futureHistory = [];
    
    // Calculate offset to center pattern on clicked cell
    const offsetX = gridX - Math.floor(pattern.width / 2);
    const offsetY = gridY - Math.floor(pattern.height / 2);
    
    pattern.cells.forEach(([x, y]) => {
        const finalX = offsetX + x;
        const finalY = offsetY + y;
        
        // Only place if within grid bounds (when not toroidal)
        if (toroidalMode || (finalX >= 0 && finalX < GRID_WIDTH && finalY >= 0 && finalY < GRID_HEIGHT)) {
            // Wrap for toroidal mode
            const wrapX = toroidalMode ? ((finalX % GRID_WIDTH) + GRID_WIDTH) % GRID_WIDTH : finalX;
            const wrapY = toroidalMode ? ((finalY % GRID_HEIGHT) + GRID_HEIGHT) % GRID_HEIGHT : finalY;
            grid.set(`${wrapX},${wrapY}`, 1);
        }
    });
    
    updateStats();
    render();
}
```

- [ ] **Step 3: Add paste mode enter/exit functions**

Add after placePatternAt:

```javascript
function enterPasteMode(pattern) {
    pasteMode = { active: true, pattern: pattern };
    canvas.style.cursor = 'crosshair';
}

function exitPasteMode() {
    pasteMode = { active: false, pattern: null };
    canvas.style.cursor = currentTool === 'pan' ? 'grab' : 'crosshair';
}
```

- [ ] **Step 4: Add rule mismatch check function**

Add after exitPasteMode:

```javascript
function checkAndApplyRule(patternRule) {
    if (!patternRule) return true;
    
    const currentRuleKey = Object.keys(RULES).find(k => RULES[k] === rule) || 'B3/S23';
    
    if (patternRule !== currentRuleKey) {
        const shouldSwitch = confirm(`This pattern was designed for ${patternRule} rule. Switch to this rule?\n\nCurrent: ${currentRuleKey}\nPattern: ${patternRule}`);
        if (shouldSwitch) {
            const ruleSelect = document.getElementById('rule-select');
            // Check if rule exists in dropdown
            const exists = Array.from(ruleSelect.options).some(opt => opt.value === patternRule);
            if (exists) {
                ruleSelect.value = patternRule;
                rule = RULES[patternRule];
                renderPatterns(document.querySelector('.tab.active').dataset.cat);
            } else {
                alert(`Rule ${patternRule} is not available in this simulator.`);
            }
        }
        return true;
    }
    return true;
}
```

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Add paste cursor mode infrastructure

- pasteMode state variable for tracking placement mode
- placePatternAt(): places pattern centered on given grid coordinates
- enterPasteMode()/exitPasteMode(): manage paste cursor state
- checkAndApplyRule(): prompt for rule mismatch with confirm dialog

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add Settings Modal HTML for RLE Import

**Files:**
- Modify: `index.html` - Add before closing `</div>` of modal-content (around line 308)

- [ ] **Step 1: Add Import RLE section to Settings modal**

Add this section as the last child of `modal-content` div, before the closing `</div>`:

```html
                <div class="modal-section">
                    <div class="modal-section-title">Import RLE</div>
                    <div style="margin-bottom: 12px;">
                        <textarea id="rle-input" placeholder="Paste RLE pattern from LifeWiki...&#10;x = 3, y = 3, rule = B3/S23&#10;bo$2bo$3o!" style="width: 100%; height: 80px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px; color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 12px; resize: vertical;"></textarea>
                    </div>
                    <div id="rle-status" style="font-size: 12px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
                        <span style="color: var(--text-secondary);">Enter RLE pattern</span>
                    </div>
                    <button class="btn" id="btn-place-rle" disabled style="width: 100%;">
                        Place Pattern
                    </button>
                </div>
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Add Import RLE section to Settings modal

- Text area for RLE input with monospace font
- Status indicator for validation feedback
- Place Pattern button (initially disabled)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Add Settings Modal JavaScript for RLE Import

**Files:**
- Modify: `index.html` - Add in init() function, near other modal event handlers (around line 433)

- [ ] **Step 1: Add RLE input event handlers in init()**

Add inside the `init()` function, after the toroidal toggle handler (around line 438):

```javascript
            // RLE import
            const rleInput = document.getElementById('rle-input');
            const rleStatus = document.getElementById('rle-status');
            const btnPlaceRLE = document.getElementById('btn-place-rle');
            
            rleInput.addEventListener('input', () => {
                const result = parseRLE(rleInput.value);
                updateRLEStatus(result);
            });
            
            btnPlaceRLE.addEventListener('click', () => {
                const result = parseRLE(rleInput.value);
                if (result.valid) {
                    // Check rule mismatch
                    if (result.result.rule) {
                        checkAndApplyRule(result.result.rule);
                    }
                    // Enter paste mode
                    enterPasteMode(result.result);
                    // Close modal
                    settingsModal.classList.remove('active');
                }
            });
```

- [ ] **Step 2: Add updateRLEStatus function**

Add after checkAndApplyRule function:

```javascript
function updateRLEStatus(parseResult) {
    const rleStatus = document.getElementById('rle-status');
    const btnPlaceRLE = document.getElementById('btn-place-rle');
    
    if (parseResult.valid) {
        const { width, height, cells, rule } = parseResult.result;
        const ruleInfo = rule ? ` · ${rule}` : '';
        rleStatus.innerHTML = `<span style="color: #238636;">●</span><span style="color: var(--text);">Valid RLE · ${width}×${height} · ${cells.length} cells${ruleInfo}</span>`;
        btnPlaceRLE.disabled = false;
        btnPlaceRLE.classList.add('primary');
    } else {
        const errorColor = parseResult.error === 'Enter RLE pattern' ? 'var(--text-secondary)' : '#da3633';
        rleStatus.innerHTML = `<span style="color: ${errorColor};">●</span><span style="color: ${errorColor};">${parseResult.error}</span>`;
        btnPlaceRLE.disabled = true;
        btnPlaceRLE.classList.remove('primary');
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Add RLE import event handlers and validation UI

- Real-time parsing on input with visual status indicator
- Place Pattern button activates paste mode and closes modal
- updateRLEStatus(): shows validation state with cell counts

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Integrate Paste Mode with Canvas Interactions

**Files:**
- Modify: `index.html` - Update onMouseDown, onMouseMove, add key handler for ESC

- [ ] **Step 1: Modify onMouseDown for paste mode**

Update the `onMouseDown` function (around line 796). Add this check at the very beginning of the function:

```javascript
        function onMouseDown(e) {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            // Handle paste mode click
            if (pasteMode.active && e.button === 0) {
                const cellX = Math.floor((x - offsetX) / (cellSize * zoom));
                const cellY = Math.floor((y - offsetY) / (cellSize * zoom));
                placePatternAt(cellX, cellY, pasteMode.pattern);
                exitPasteMode();
                return;
            }
            
            // ... rest of existing function
```

- [ ] **Step 2: Add paste mode preview to render()**

Update the `render()` function (around line 736). Add after the existing cells rendering (after line 768):

```javascript
            // Paste mode preview
            if (pasteMode.active && pasteMode.pattern) {
                const mousePos = lastMousePos;
                if (mousePos) {
                    const cellX = Math.floor((mousePos.x - offsetX) / (cellSize * zoom));
                    const cellY = Math.floor((mousePos.y - offsetY) / (cellSize * zoom));
                    const offsetX_cells = cellX - Math.floor(pasteMode.pattern.width / 2);
                    const offsetY_cells = cellY - Math.floor(pasteMode.pattern.height / 2);
                    
                    ctx.fillStyle = 'rgba(88, 166, 255, 0.5)';
                    pasteMode.pattern.cells.forEach(([x, y]) => {
                        const px = (offsetX_cells + x) * cellW + offsetX;
                        const py = (offsetY_cells + y) * cellH + offsetY;
                        ctx.fillRect(px + 1, py + 1, cellW - 1, cellH - 1);
                    });
                }
            }
```

- [ ] **Step 3: Track mouse position for preview**

Add state variable after other state variables (around line 393):

```javascript
let lastMousePos = null;
```

Update `onMouseMove` function (around line 830) to track position:

```javascript
        function onMouseMove(e) {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            // Track for paste mode preview
            lastMousePos = { x, y };
            
            // ... rest of existing function
```

- [ ] **Step 4: Add ESC key handler for paste mode**

Add to the keyboard shortcut handler in `init()` (around line 457), after the 'r' key handler:

```javascript
                // ESC to cancel paste mode
                if (e.key === 'Escape' && pasteMode.active && !modalOpen) {
                    e.preventDefault();
                    exitPasteMode();
                }
```

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Integrate paste mode with canvas interactions

- onMouseDown: places pattern and exits paste mode on click
- render(): shows semi-transparent ghost preview at cursor position
- Track lastMousePos for preview rendering
- ESC key cancels paste mode

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Add Shift+Click Support to Pattern Library

**Files:**
- Modify: `index.html` - Update renderPatterns function and pattern button onclick

- [ ] **Step 1: Modify loadPattern to support paste mode**

Add optional parameter to `loadPattern` function (around line 567):

```javascript
function loadPattern(pattern, usePasteMode = false) {
    if (usePasteMode) {
        // Enter paste cursor mode instead of direct placement
        enterPasteMode({
            width: pattern.width || (pattern.cells ? Math.max(...pattern.cells.map(c => c[0])) + 1 : 0),
            height: pattern.height || (pattern.cells ? Math.max(...pattern.cells.map(c => c[1])) + 1 : 0),
            cells: pattern.cells
        });
        return;
    }
    
    // Existing behavior
    saveHistory();
    futureHistory = [];
    const cx = Math.floor(GRID_WIDTH / 2), cy = Math.floor(GRID_HEIGHT / 2);
    pattern.cells.forEach(([x, y]) => {
        grid.set(`${cx + x},${cy + y}`, 1);
    });
    updateStats();
    render();
}
```

- [ ] **Step 2: Update pattern button click handler**

Modify the onclick in `renderPatterns` function (around line 561):

```javascript
                    btn.onclick = (e) => {
                        if (e.shiftKey) {
                            loadPattern(p, true); // Paste mode
                        } else {
                            loadPattern(p, false); // Center placement
                        }
                    };
```

- [ ] **Step 3: Add shift+click tooltip**

Update the pattern button creation in `renderPatterns` (around line 549) to add title:

```javascript
                    btn.className = 'pattern-btn';
                    btn.title = 'Click to center · Shift+click to place';
```

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Add shift+click paste mode to pattern library

- loadPattern(pattern, usePasteMode): optional paste mode placement
- Pattern buttons: shift+click enters paste cursor mode
- Tooltip shows shift+click behavior

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Test Full Integration

**Files:**
- Test: Manual browser testing

- [ ] **Step 1: Test RLE import flow**

1. Open app in browser
2. Open Settings modal
3. Paste this glider RLE:
   ```
   x = 3, y = 3, rule = B3/S23
   bo$2bo$3o!
   ```
4. Verify: Green status, "3×3 · 5 cells · B3/S23" shown
5. Click "Place Pattern"
6. Verify: Modal closes, cursor is crosshair, ghost preview visible
7. Click on canvas
8. Verify: Pattern placed at click location

- [ ] **Step 2: Test rule mismatch dialog**

1. Switch rule to "Seeds (B2/S)" in sidebar
2. Open Settings, paste glider RLE (B3/S23)
3. Click "Place Pattern"
4. Verify: Confirm dialog appears asking to switch rule
5. Click OK
6. Verify: Rule switches to Conway's Life

- [ ] **Step 3: Test invalid RLE handling**

1. Paste `bo$2bo$3o` (missing `!`)
2. Verify: Red dot, "Missing end marker (!)" shown
3. Button should be disabled

- [ ] **Step 4: Test pattern library shift+click**

1. Hold Shift and click "Gosper Gun" in sidebar
2. Verify: Paste mode activates
3. Click on canvas
4. Verify: Gun placed at click location

- [ ] **Step 5: Test ESC cancellation**

1. Enter paste mode (via RLE import or shift+click)
2. Press ESC
3. Verify: Cursor returns to normal, no pattern placed

- [ ] **Step 6: Final commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Complete RLE import feature

- Full integration tested: import, validation, placement, cancellation
- Rule mismatch dialog working
- Pattern library shift+click functional

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- ✅ RLE section in Settings modal - Task 3
- ✅ Real-time validation - Task 4
- ✅ Paste cursor mode - Tasks 2, 5
- ✅ Rule mismatch dialog - Task 2
- ✅ Pattern library shift+click - Task 6
- ✅ Integration with history/undo - Task 2 (placePatternAt calls saveHistory)

**2. Placeholder scan:**
- ✅ No TBD/TODO/fill in later
- ✅ All code shown in steps
- ✅ All function signatures consistent

**3. Type consistency:**
- ✅ `pasteMode` structure consistent across tasks
- ✅ `parseRLE` return format matches `updateRLEStatus` expectations

**Ready for execution.**
