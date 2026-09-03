# Gaia Mapper — Design Decisions Log

Decisions made during development and the reasoning behind them.

## Bundler: tsdown (rolldown)

**Decision:** Use `tsdown` with IIFE output, `platform: 'browser'`.

**Alternatives considered:** esbuild directly, vite, webpack.

**Rationale:** `tsdown` wraps rolldown (Rust-based, fast) with sensible defaults. IIFE output avoids ESM complexity. The `platform: 'browser'` setting is critical — it ensures `fflate` resolves to its browser-specific export (`esm/browser.js`) instead of the Node.js entry that uses `module.createRequire`. Without this, the bundle throws `ReferenceError: module is not defined` at runtime.

## ZIP Library: fflate

**Decision:** Use `fflate` for both payload building (Node) and payload loading (browser).

**Rationale:** Lightweight (~13KB gzipped), pure JavaScript, works in both environments. The `deps: { alwaysBundle: ['fflate'] }` config ensures it's inlined into the IIFE bundle rather than treated as an external.

## No UI Framework

**Decision:** Vanilla TypeScript + DOM.

**Rationale:** The UI is static (defined in HTML, no dynamic creation), the app has ~6 interactive controls, and canvas rendering dominates the complexity. A framework would add bundle size and abstraction layers with no benefit.

## Shared Mutable State (AppState)

**Decision:** Single `AppState` object passed by reference to all components.

**Rationale:** Simple and sufficient for a single-page app with ~10 state fields. The event bus provides decoupled notifications. Immutable state or a store library would add ceremony without clear benefit at this scale.

## Metatile Count: 256 (not 128)

**Decision:** `METATILE_COUNT = 256`, `TILESET_ENTRIES = 1024`.

**Background:** The tileset binary is 2048 bytes (0x800). Each entry is 2 bytes, giving 1024 entries. Each metatile is 4 entries, giving 256 metatiles arranged in an 8×32 grid. The initial implementation incorrectly used 128 metatiles (512 entries), which prevented selecting tiles in the bottom half of the grid.

## Layer 2 VRAM Page

**Decision:** Explicitly set `effectTileset.useOffset = true` after loading.

**Background:** The legacy C# app toggles `useOffset` via a UI control. PPU commands in the asset list do set the BG character base registers, but the legacy code ignores them for `useOffset` — it's a manual toggle. We match this behavior by hardcoding the effect layer to use VRAM page 1 (offset 0x6000).

## Jump/Label Resolution

**Decision:** Build a global label index at manifest parse time and follow jumps recursively with cycle detection.

**Background:** 172 of ~240 IOG scenes use `jump` commands to inherit graphics from parent scenes. Without following jumps, many scenes (including common ones like Eric's House) render blank because they have no direct bitmap/tileset asset commands.

**Implementation:** `buildLabelIndex()` scans all scenes for `label` entries. `executeAssetList()` processes commands sequentially, and on encountering a `jump`, recursively processes the target scene's asset list starting after the label. A `Set<number>` of visited labels prevents infinite loops.

## DPR Scaling

**Decision:** Scale canvas backing store by `devicePixelRatio`, apply DPR transform to context.

**Background:** On high-DPI displays (e.g., 2× Retina), a canvas with CSS size 400×300 but backing store 400×300 will be upscaled by the browser, causing blur. Setting the backing store to 800×600 and scaling the context by 2× produces crisp pixels.

**Applied to:** Main canvas (`CanvasView.resize()`), tileset picker, GFX viewer, palette viewer — all canvases in the app.

## Stamp Drag Batching

**Decision:** Batch all stamps from a single mousedown-to-mouseup drag into one undo action.

**Rationale:** Without batching, dragging across 50 cells would create 50 individual undo entries. Batching makes undo feel natural — one Ctrl+Z reverses the entire stroke. Deduplication within a batch prevents redundant entries when the mouse re-enters a cell.

## Quad Selection (8×8 within 16×16)

**Decision:** Track both `selectedMetatile` (0-255) and `selectedQuad` (0-3) in AppState.

**Background:** Tilemaps operate on 16×16 metatiles, but tileset entries are 8×8 tiles. Users need to edit individual 8×8 components (assign VRAM tiles, flip flags, etc.) while still stamping full 16×16 metatiles on the map.

**Layout:** Quad indices follow TL=0, TR=1, BL=2, BR=3 order, matching the tileset entry storage: `entryBase = metatile * 4`, `entryIndex = entryBase + quad`.

## View Preservation on Tileset Edit

**Decision:** Split refresh into `refreshMainView()` (resets viewport) and `updateMainPixels()` (preserves viewport).

**Background:** Assigning a VRAM tile to a tileset entry triggers `tileset:changed`, which needs to update the main canvas. But calling `fitToView()` on every tileset edit was resetting the user's carefully positioned viewport. The split allows pixel-level updates without disturbing pan/zoom.

## Asset Dropdown (replacing Layer Toggle + Import/Export buttons)

**Decision:** Merge the Layer toggle, Import GFX, and Export buttons into a single "Layer N" dropdown that lists all loaded scene assets grouped by type.

**Alternatives considered:** Keeping separate import/export buttons per asset type; a file manager panel.

**Rationale:** A scene can contain many assets (multiple bitmaps, palettes, tilesets, tilemaps) loaded through jump chains. The old "Import GFX" button only handled raw VRAM bitmap import, and "Export" only exported the active tilemap. The asset dropdown gives per-asset import/export with correct file type filtering, and tilemaps get an edit button to switch layers. This consolidates three buttons into one that scales with scene complexity.

**Implementation:** During `loadScene()`, each `executeAssetCommand` call pushes a `LoadedAsset` entry (type, filename, resolved payload key, extension, layer bitmask, meta offsets) to `SceneState.loadedAssets`. The dropdown is rebuilt each time it opens, reading from this array. Import replays the original load with stored meta offsets; export reconstructs the original file by overlaying modified bytes.

## Tilemap Resize with Anchor Grid

**Decision:** Use a toolbar dropdown with width/height inputs and a 3×3 anchor selector. Default anchor is top-right.

**Alternatives considered:** Modal dialog; resize handles on the tilemap itself; a menu command.

**Rationale:** A dropdown keeps the resize control accessible without obscuring the tilemap. The 3×3 anchor grid is the standard UX pattern for resize alignment (used in Photoshop, Tiled, Aseprite). Top-right default was chosen because IOG maps typically expand southward (content is anchored to the top) and leftward (content starts at the right edge of the block grid).

**Constraint:** `width × height ≤ 32` blocks (TILEMAP_MAX_DATA / TILEMAP_BLOCK_SIZE). The Resize button is disabled with an error message when the constraint is violated.

## Ctrl+Click Dropper Mode

**Decision:** Ctrl+left-click acts as the eyedropper (same as right-click pick) on the tilemap canvas.

**Alternatives considered:** Dedicated tool button in toolbar; keyboard shortcut to toggle mode.

**Rationale:** Ctrl+click is the standard modifier-based dropper shortcut in pixel editors (Photoshop, Aseprite, GIMP). It allows single-hand dropper access without switching tools. The `ctrlKey` boolean is forwarded through `CanvasView.onClick` and remapped to button 2 in the tilemap handler. Visual feedback: the cursor changes to `copy` while Ctrl is held.

**Drag suppression:** Ctrl+left-click does not start a stamp drag (`isLeftDragging` stays false when `ctrlKey` is true), preventing accidental tile stamping during dropper use.

## Layer Reset on Scene Switch

**Decision:** Automatically reset `activeLayer` to 1 when loading a new scene.

**Rationale:** Users were sometimes confused when switching scenes while on layer 2 — the new scene's effect layer might be empty or look wrong. Resetting to layer 1 ensures the most common view (main tilemap) is shown first. The layer button text is updated immediately before the scene loads.
