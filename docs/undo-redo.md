# Gaia Mapper — Undo/Redo System

## Overview

The app tracks all tilemap and tileset modifications in an undo/redo stack managed by `src/ui/history.ts`. Maximum 200 actions are retained before the oldest is discarded.

## Action Types

### Tilemap Stamp Action

Created when the user releases the left mouse button after stamping tiles.

A single drag can paint multiple cells. All cells painted during one mousedown-to-mouseup drag are batched into a single undoable action. Duplicate stamps on the same cell within a drag are deduplicated (only the first old→new pair is kept).

**Data:** Array of `TileChange` records:
```typescript
interface TileChange {
  blockX: number;
  blockY: number;
  cellX: number;
  cellY: number;
  oldValue: number;  // previous metatile index
  newValue: number;  // stamped metatile index
}
```

**Undo:** Restores `oldValue` at each cell position.
**Redo:** Re-applies `newValue` at each cell position.

### Tileset Entry Action

Created when the user modifies a tileset entry: assigning a VRAM tile (click in GFX viewer) or changing a property flag (H-Flip, V-Flip, Priority, Block checkboxes).

**Data:** `entryIndex`, `oldWord`, `newWord` (the raw 16-bit tileset entry values).

**Undo:** Writes `oldWord` back to the tileset data via `setEntryWord()`.
**Redo:** Writes `newWord` back to the tileset data via `setEntryWord()`.

### Tilemap Resize Action

Created when the user confirms a tilemap resize operation via the resize dropdown.

**Data:** Two `TilemapState` snapshots — `oldSnap` (width, height, data copy before resize) and `newSnap` (width, height, data copy after resize). Also captures the `targetLayer` (1 or 2) at the time of the resize.

```typescript
interface TilemapState {
  width: number;
  height: number;
  data: Uint8Array;   // fresh copy per snapshot
}
```

**Undo:** Restores the old snapshot's width, height, and data (fresh `Uint8Array` copy) to the target layer's `TilemapManager`. Refreshes the tilemap editor and main view.
**Redo:** Re-applies the new snapshot's width, height, and data (fresh `Uint8Array` copy) to the target layer's `TilemapManager`. Refreshes the tilemap editor and main view.

The target layer is captured at resize time rather than using `state.activeLayer`, so undoing works correctly even if the user switches layers between the resize and the undo.

All three action types trigger a view refresh after undo/redo to update the canvas.

## Controls

| Input | Action |
|-------|--------|
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Ctrl+Y | Redo (alternative) |
| Toolbar ⟲ button | Undo |
| Toolbar ⟳ button | Redo |

Buttons are disabled when the respective stack is empty. The history is cleared when a new scene is loaded.

## Implementation Details

The `History` class in `src/ui/history.ts` is framework-agnostic:

- `push(action)` — adds to undo stack, clears redo stack
- `undo()` — pops from undo stack, calls `action.undo()`, pushes to redo stack
- `redo()` — pops from redo stack, calls `action.redo()`, pushes to undo stack
- `clear()` — empties both stacks

Action factories live in `src/index.ts`:
- `makeTilemapAction(changes: TileChange[])` — stamp batches
- `makeTilesetAction(entryIndex, oldWord, newWord)` — entry edits
- `makeResizeAction(targetLayer, oldSnap, newSnap)` — tilemap resize

Drag tracking is handled by `CanvasView.onDragEnd` callback, which fires on left-button mouseup. The tilemap editor's `commitStampBatch()` returns accumulated changes and resets the pending buffer.
