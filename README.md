# Gaia Mapper

Browser-based SNES tileset and tilemap editor for Illusion of Gaia and other Quintet-engine games. Built with vanilla TypeScript, HTML5 Canvas 2D, and zero UI frameworks.

**[Live Editor](https://azarem.github.io/gaia-mapper/)** · **[Documentation](docs/)** · **[GitHub](https://github.com/Azarem/gaia-mapper)**

## Table of Contents

- [Getting Started](#getting-started)
- [Interface Overview](#interface-overview)
- [Loading a Scene](#loading-a-scene)
- [Navigating the Map](#navigating-the-map)
- [Editing Tilemaps](#editing-tilemaps)
- [Working with the Tileset](#working-with-the-tileset)
- [Side Panels](#side-panels)
- [Asset Management](#asset-management)
- [Undo and Redo](#undo-and-redo)
- [Grid Overlay](#grid-overlay)
- [Keyboard and Mouse Reference](#keyboard-and-mouse-reference)
- [Technical Reference](#technical-reference)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Documentation Index](#documentation-index)

---

## Getting Started

### Prerequisites

- **Node.js 18+**
- Access to the `gaia-iog-baserom` repository (for building the asset payload)

### Installation

```bash
cd gaia-mapper
npm install
```

### Building the Payload

The editor loads scene assets from a `payload.zip` file. This must be built from an extracted IOG baserom:

```bash
npm run payload ../gaia-iog-baserom
```

This reads scene definitions and file metadata from the baserom's `us/` directory, collects binary assets from `extracted/`, and produces a `payload.zip` (~600KB) in the project root. The payload is gitignored — each developer must build it locally.

> For full details on the payload build pipeline and manifest format, see **[Payload System](docs/payload.md)**.

### Running the Editor

```bash
npm run build         # produces dist/app.iife.js
npx serve .           # serves on http://localhost:3000
```

Open the URL in your browser. The editor will fetch `payload.zip`, cache it in IndexedDB, and populate the scene selector.

For development with auto-rebuild:

```bash
npm run dev           # watch mode with auto-rebuild
```

> **Note:** `file://` URLs will not work — `fetch()` requires HTTP.

---

## Interface Overview

The editor uses a three-panel layout with a toolbar and status bar:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Toolbar: [Scene ▾] [Layer 1 ▾] [Grid] [⊞ Resize] [⟲] [⟳]  Docs  │
├──────────┬──────────────────────────┬───────────────────────────────┤
│ Left     │ Main Canvas             │ Right Panel                   │
│ Panel    │                         │                               │
│          │ (Tilemap view —         │ VRAM Tiles (raw 8×8 grid)     │
│ Tileset  │  pannable, zoomable)    │                               │
│ Picker   │                         │ Palette (8 rows × 16 colors)  │
│ (8×32    │                         │                               │
│ metatile │                         │ Properties (flags, tile, pal) │
│ grid)    │                         │                               │
├──────────┴──────────────────────────┴───────────────────────────────┤
│  Status Bar: coordinates, info messages                             │
└─────────────────────────────────────────────────────────────────────┘
```

**Toolbar controls:**

| Control | Description |
|---------|-------------|
| **Scene selector** | Dropdown to choose which scene to load |
| **Layer N ▾** | Asset dropdown — lists all loaded assets; click to open |
| **Grid** | Toggle grid overlay on all canvases |
| **Resize** (icon) | Open the tilemap resize dropdown |
| **⟲ / ⟳** | Undo / Redo (also Ctrl+Z / Ctrl+Y) |
| **Docs** | Link to project documentation on GitHub |

> For full architectural details, see **[Architecture](docs/architecture.md)**. For editor component internals, see **[Editor Components](docs/editors.md)**.

---

## Loading a Scene

1. Use the **Scene selector** dropdown in the toolbar
2. Scenes are listed as `ID - Description` (e.g., `3 - South Cape`)
3. Select a scene — the editor executes the scene's asset commands, including following jump chains to inherit shared assets from parent scenes
4. The active layer is automatically reset to **Layer 1** when a new scene loads

Most IOG scenes use `jump` commands to inherit graphics from parent scenes. For example, Eric's House (ID 4) inherits bitmap and tileset data from Lance's House (ID 3), which in turn inherits from South Cape (ID 1).

> For details on the scene loading pipeline, jump/label resolution, and asset command types, see **[SNES Data Model — Scene Loading](docs/snes-data-model.md#scene-loading-scene-loaderts)**.

---

## Navigating the Map

The main canvas supports panning and zooming:

| Input | Action |
|-------|--------|
| **Mouse wheel** | Zoom in/out (0.25× to 32×, anchored to cursor position) |
| **Middle-click + drag** | Pan the viewport |
| **Shift + left-click + drag** | Pan the viewport (alternative) |

The cursor coordinates in the tilemap are shown in the status bar.

---

## Editing Tilemaps

### Stamping Tiles

1. Select a metatile in the **Tileset Picker** (left panel) by clicking on it
2. **Left-click** on the main canvas to stamp the selected metatile
3. **Left-click + drag** to paint multiple cells in a single stroke

All cells painted during one drag are batched into a single undoable action. Duplicate stamps on the same cell within a drag are deduplicated.

### Picking Tiles (Eyedropper)

Two ways to pick a metatile from the map:

| Method | How |
|--------|-----|
| **Right-click** | Click any cell to pick the metatile at that position |
| **Ctrl + left-click** | Hold Ctrl and left-click (dropper mode) |

Both methods select the metatile index **and** the 8×8 quadrant under the cursor. The picked metatile becomes the active selection in the tileset picker, and the corresponding VRAM tile and palette are highlighted in the right panel.

**Visual feedback:** Holding Ctrl changes the cursor to a `copy` icon. Ctrl+left-click does not start a stamp drag, so you can safely pick tiles without placing them.

### Resizing a Tilemap

Click the **Resize button** (overlapping rectangles icon) in the toolbar to open the resize dropdown:

- **Width / Height** inputs — in 256-pixel blocks, pre-populated with current dimensions
- **3×3 anchor grid** — controls where existing content is positioned within the new dimensions

```
┌────────────┬────────────┬────────────┐
│  Top-Left  │ Top-Center │ Top-Right  │   ← default
├────────────┼────────────┼────────────┤
│ Middle-Left│   Center   │Middle-Right│
├────────────┼────────────┼────────────┤
│Bottom-Left │Bottom-Centr│Bottom-Right│
└────────────┴────────────┴────────────┘
```

The anchor determines where existing tiles land in the resized map. For example, **Top-Right** (default) keeps content pinned to the top-right corner while the map expands left and/or downward.

**Constraints:** `width × height` must not exceed 32 blocks (8KB tilemap data limit). The info text shows the live block count and turns red when constraints are violated.

The resize operation is fully **undoable** — undo restores both the original dimensions and all tile data.

> For implementation details, see **[Editor Components — Tilemap Resize](docs/editors.md#tilemap-resize)** and **[Undo/Redo — Tilemap Resize Action](docs/undo-redo.md#tilemap-resize-action)**.

---

## Working with the Tileset

### Selecting Metatiles

The **Tileset Picker** (left panel) shows all 256 metatiles in an 8×32 grid (128×512 pixels).

- **Left-click** to select a metatile for stamping
- Clicking also selects the specific **8×8 quadrant** within the 16×16 metatile
- **Cyan box** = selected metatile; **orange box** = selected quadrant

### Editing Tileset Entries

Each metatile is composed of 4 tileset entries (one per 8×8 quadrant: TL, TR, BL, BR). Each entry is a 16-bit word:

| Bits | Field | Description |
|------|-------|-------------|
| 0-8 | Tile index | Which VRAM tile to display (0-511, spans both BG pages) |
| 9 | Block | Collision flag — prevents actors from moving into this tile |
| 10-12 | Palette | Which palette row to use (0-7) |
| 13 | Priority | BG priority bit |
| 14 | H-Flip | Horizontal mirror |
| 15 | V-Flip | Vertical mirror |

Use the **Properties panel** to toggle H-Flip, V-Flip, Priority, and Block flags on the currently selected quadrant. All property changes are undoable.

> **Tile page selection:** The 9-bit tile index (bits 0-8) inherently spans both VRAM pages — indices 0-255 address page 0 (`$4000`), indices 256-511 address page 1 (`$6000`). Bit 9 is **not** a page select — it is the collision block flag. See **[SNES Data Model — Tileset](docs/snes-data-model.md#tileset-tilesetsts)** for full details.

### Assigning VRAM Tiles

1. Select a metatile quadrant in the tileset picker
2. Click a tile in the **VRAM Tiles** panel (right panel)
3. The clicked VRAM tile is assigned to the selected entry's tile index

This operation is undoable.

---

## Side Panels

### VRAM Tiles Panel

Shows raw 8×8 tiles from the 64KB Virtual VRAM in a 16-column grid. Displays 256 tiles per page (page depends on the active layer's VRAM offset). Tiles are colorized using the currently selected palette.

- **Left-click** a tile to assign it to the selected tileset entry
- **Cyan highlight** marks the currently selected tile

### Palette Panel

Shows 8 palette rows of 16 color swatches each, representing the SNES CGRAM (512 bytes, BGR555 format).

- **Left-click** a row to select it as the active palette
- The selected palette affects tile preview in both the VRAM panel and tileset picker

### Properties Panel

Displays and controls flags for the currently selected tileset entry:

| Control | Description |
|---------|-------------|
| **H-Flip** | Horizontal mirror |
| **V-Flip** | Vertical mirror |
| **Priority** | BG priority bit |
| **Block** | Collision flag — prevents actor passage into this tile |
| **Tile** | Current VRAM tile index (read-only display) |
| **Palette** | Current palette row index (read-only display) |

> For rendering pipeline details, see **[Rendering Pipeline](docs/rendering.md)**.

---

## Asset Management

### Asset Dropdown

Click the **Layer N ▾** button to open the asset dropdown. This lists all assets loaded for the current scene, grouped by type:

1. **Tilemaps** (blue grid icon)
2. **Tilesets** (green grid icon)
3. **Bitmaps** (orange frame icon)
4. **Palettes** (purple circle icon)

Each asset entry shows a type icon, filename with layer hint, and action buttons:

| Button | Action |
|--------|--------|
| **✏ Edit** (tilemaps only) | Switch to editing that tilemap's layer |
| **↓ Import** | Replace asset data from a file |
| **↑ Export** | Save asset data to a file |

### Importing Assets

1. Click **Import** (↓) next to any asset
2. A file picker opens, filtered by extension (`.map`, `.set`, `.bin`, `.pal`)
3. Select a file — the raw data replaces the in-memory asset using the same load parameters as the original
4. All editors refresh automatically

### Exporting Assets

1. Click **Export** (↑) next to any asset
2. The editor reconstructs the native file format:
   - **Tilemaps**: Serialized from in-memory state (2-byte header + tile data)
   - **Tilesets, Bitmaps, Palettes**: Original payload file copied with modified byte ranges overlaid
3. The file downloads with its original filename

### Switching Layers

The editor supports two tilemap layers per scene:

- **Layer 1** (main): VRAM page 0 tiles
- **Layer 2** (effect): VRAM page 1 tiles

Click the **Edit** (pencil) button next to a tilemap in the asset dropdown to switch layers. Loading a new scene always resets to Layer 1.

> For details on the asset tracking system (LoadedAsset), import/export internals, and the scene loader, see **[Architecture — Asset Import/Export](docs/architecture.md#asset-importexport)** and **[SNES Data Model — LoadedAsset Tracking](docs/snes-data-model.md#loadedasset-tracking)**.

---

## Undo and Redo

All edits are tracked in an undo/redo stack (up to 200 actions).

| Input | Action |
|-------|--------|
| **Ctrl+Z** | Undo |
| **Ctrl+Shift+Z** or **Ctrl+Y** | Redo |
| **⟲ / ⟳ buttons** (toolbar) | Undo / Redo |

**Undoable operations:**

| Operation | What is restored |
|-----------|-----------------|
| Tile stamping | Previous metatile index at each painted cell |
| Tileset property change | Previous 16-bit entry word |
| VRAM tile assignment | Previous tile index in the entry |
| Tilemap resize | Previous dimensions and all tile data |

The history is cleared when a new scene is loaded.

> For full implementation details, action types, and factory functions, see **[Undo/Redo System](docs/undo-redo.md)**.

---

## Grid Overlay

Click **Grid** in the toolbar to toggle grid lines on all canvases:

- **Tilemap canvas**: 16×16 metatile grid
- **Tileset picker**: 16×16 grid + finer 8×8 sub-tile guides
- **VRAM Tiles**: 8×8 tile grid

---

## Keyboard and Mouse Reference

### Main Canvas (Tilemap)

| Input | Action |
|-------|--------|
| Left-click | Stamp selected metatile |
| Left-click + drag | Paint metatiles (batched undo action) |
| Right-click | Pick/eyedropper — select metatile at cursor |
| Ctrl + left-click | Pick/eyedropper (cursor shows `copy` icon) |
| Mouse wheel | Zoom in/out |
| Middle-click + drag | Pan viewport |
| Shift + left-click + drag | Pan viewport (alternative) |

### Side Panels

| Panel | Input | Action |
|-------|-------|--------|
| Tileset Picker | Left-click | Select metatile + quadrant |
| VRAM Tiles | Left-click | Assign tile to selected entry |
| Palette | Left-click | Select palette row |

### Global Shortcuts

| Input | Action |
|-------|--------|
| Ctrl+Z | Undo |
| Ctrl+Shift+Z / Ctrl+Y | Redo |
| Escape | Close any open dropdown |

---

## Technical Reference

This section provides a brief overview. For comprehensive details, see the linked documentation.

### Tilemap Data Model

Binary format: `[u8 width][u8 height][data...]` — width/height in 256-pixel blocks (16×16 metatile grids). Each data byte is an index into the tileset's 8×32 metatile grid (lower 3 bits = column, upper 5 bits = row). Maximum: 8192 bytes, constraining `width × height ≤ 32` blocks.

> See **[SNES Data Model — Tilemap](docs/snes-data-model.md#tilemap-tilemaptsts)**.

### Tileset Entry Format

Each entry is a 16-bit word. The 9-bit tile index (bits 0-8) addresses 512 VRAM tiles across both BG pages. Bit 9 is the **collision block flag** (prevents actor passage), not a page selector. Bits 10-15 encode palette, priority, and flip flags.

> See **[SNES Data Model — Tileset](docs/snes-data-model.md#tileset-tilesetsts)**.

### Virtual VRAM

The editor emulates the SNES 64KB Video RAM: BG tiles at `$4000-$7FFF` (two 8KB pages of 256 tiles each), sprite tiles at `$8000-$FFFF`. Layer 1 reads from page 0, Layer 2 from page 1.

> See **[SNES Data Model — Virtual VRAM](docs/snes-data-model.md#virtual-vram-vramts)** and **[Rendering Pipeline](docs/rendering.md)**.

### Palette / CGRAM

512-byte Color Generator RAM — 8 BG palettes × 16 colors in BGR555 format, converted to RGBA8 for display.

> See **[SNES Data Model — Palette](docs/snes-data-model.md#palette--cgram-palettets)**.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Editor shows blank after loading | Most scenes use `jump` chains — check console for missing label warnings |
| Blurry rendering | Ensure modern browser with `devicePixelRatio` support; all canvases enforce `imageSmoothingEnabled = false` |
| "Asset not found in payload" | Rebuild payload: `npm run payload ../gaia-iog-baserom` |
| Stale cached data | Clear IndexedDB: `indexedDB.deleteDatabase('gaia-mapper-cache')` then reload |
| Import produces unexpected results | Replacement file must match the expected binary format and size |

> See **[Developer Guide — Troubleshooting](docs/dev-guide.md#troubleshooting)** for more.

---

## Development

```bash
npm run build       # One-shot build → dist/app.iife.js
npm run dev         # Watch mode with auto-rebuild
npm run typecheck   # TypeScript type checking only
npm run payload     # Build payload.zip from baserom
```

The app is built as a single IIFE bundle via `tsdown` (rolldown). Only runtime dependency is `fflate` for ZIP handling. All UI is vanilla DOM — no frameworks.

> See **[Developer Guide](docs/dev-guide.md)** for conventions, setup, and contribution guidance.

---

## Documentation Index

Detailed documentation lives in the `docs/` directory:

| Document | Description |
|----------|-------------|
| **[Architecture](docs/architecture.md)** | System design, data flow diagram, event bus, `AppState` shape, asset import/export pipeline |
| **[Editor Components](docs/editors.md)** | All editor interactions — tilemap stamping, dropper mode, resize, asset dropdown, tileset picker, VRAM viewer, palette, properties, `CanvasView` internals |
| **[SNES Data Model](docs/snes-data-model.md)** | How the app emulates SNES hardware — Virtual VRAM, CGRAM palettes, 4bpp tile decoding, tileset entry bit layout, tilemap format, resize algorithm, `SceneState` and `LoadedAsset` tracking |
| **[Rendering Pipeline](docs/rendering.md)** | VRAM → decoded tiles → tileset bitmap → tilemap image → canvas, color conversion, refresh strategy, overlay drawing |
| **[Undo/Redo System](docs/undo-redo.md)** | History stack, action types (stamp, tileset edit, resize), action factories, keyboard shortcuts |
| **[Payload System](docs/payload.md)** | Payload build script, ZIP structure, manifest format, `AssetEntry` meta fields, file resolution, IndexedDB caching |
| **[Design Decisions](docs/design-decisions.md)** | Rationale for key choices — bundler, no UI framework, shared mutable state, metatile count, asset dropdown, resize anchor grid, Ctrl+click dropper, layer reset |
| **[Developer Guide](docs/dev-guide.md)** | Prerequisites, setup, project conventions, known limitations, troubleshooting, adding features, multi-game support |
