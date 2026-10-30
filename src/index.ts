import { events } from './ui/events';
import { setupResizeObserver } from './ui/layout';
import { CanvasView } from './ui/canvas-view';
import { History, type UndoAction } from './ui/history';
import {
  saveFile, imageDataToCanvas, canvasToPng, sanitizeFileName, type SaveResult,
} from './ui/file-save';
import { fetchPayload } from './data/payload';
import { parseManifest, type PayloadManifest, type SceneEntry } from './data/manifest';
import {
  loadScene, importAssetData, exportAssetData,
  type SceneState, type LoadedAsset, type LoadedAssetType,
} from './data/scene-loader';
import { TilesetEditor } from './editor/tileset-editor';
import { TilemapEditor, type TileChange } from './editor/tilemap-editor';
import { GfxViewer } from './editor/gfx-viewer';
import { PaletteViewer } from './editor/palette-viewer';
import { SceneSelector } from './editor/scene-selector';
import {
  resizeTilemap, nudgeTilemap,
  type TilemapAnchor, type NudgeDirection, type TilemapState,
  TILEMAP_MAX_BLOCKS,
} from './core/tilemap';
import { describeBlend } from './core/display';

const PAYLOAD_URL = 'payload.zip';
/** Bump when the payload format changes (invalidates the IndexedDB cache). v2: ppu entries carry display registers. */
const PAYLOAD_VERSION = 2;

type Layer = 1 | 2;

export interface AppState {
  manifest: PayloadManifest | null;
  payload: Map<string, Uint8Array> | null;
  scene: SceneState | null;
  /** The layer edits apply to. Always a visible layer. */
  activeLayer: Layer;
  /** Which layers are displayed. At least one available layer is always visible. */
  layerVisible: Record<Layer, boolean>;
  gridEnabled: boolean;
  blockViewEnabled: boolean;
  selectedMetatile: number;
  selectedQuad: number;
  selectedPalette: number;
  selectedGfxTile: number;
}

export const state: AppState = {
  manifest: null,
  payload: null,
  scene: null,
  activeLayer: 1,
  layerVisible: { 1: true, 2: true },
  gridEnabled: false,
  blockViewEnabled: false,
  selectedMetatile: 0,
  selectedQuad: 0,
  selectedPalette: 0,
  selectedGfxTile: 0,
};

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

async function init(): Promise<void> {
  events.emit('status:info', 'Downloading payload...');

  try {
    state.payload = await fetchPayload(PAYLOAD_URL, PAYLOAD_VERSION);
  } catch (err) {
    events.emit('status:info', `Failed to load payload: ${err}`);
    return;
  }

  const manifestData = state.payload.get('manifest.json');
  if (!manifestData) {
    events.emit('status:info', 'Payload missing manifest.json');
    return;
  }

  state.manifest = parseManifest(manifestData);
  events.emit('status:info', `Loaded ${state.manifest.game} payload`);

  const history = new History();

  const sceneSelector = new SceneSelector(
    $('scene-selector') as HTMLSelectElement,
    state.manifest,
  );

  const mainCanvas = $('main-canvas') as HTMLCanvasElement;
  const mainView = new CanvasView({
    canvas: mainCanvas,
    pannable: true,
    zoomable: true,
    onHover: (x, y) => {
      tilemapEditor.onHover(x, y);
      mainView.redraw();
    },
    onClick: (x, y, btn, ctrlKey) => {
      const effectiveBtn = (btn === 0 && ctrlKey) ? 2 : btn;
      tilemapEditor.onClick(x, y, effectiveBtn);
      mainView.refreshOffscreen();
      mainView.redraw();
    },
    onDraw: (ctx, zoom) => tilemapEditor.drawOverlay(ctx, zoom),
    onDragEnd: () => {
      const interactionType = tilemapEditor.finalizeLeftDrag();
      if (interactionType === 'select') {
        updatePatternUI();
        mainView.redraw();
      } else {
        mainView.refreshOffscreen();
        const changes = tilemapEditor.commitStampBatch();
        if (changes) {
          history.push(makeTilemapAction(changes, state.activeLayer));
          updateUndoRedoButtons();
        }
        updatePatternUI();
        mainView.redraw();
      }
    },
    onRightDragStart: (x, y) => {
      tilemapEditor.beginPatternSelection(x, y);
      mainView.redraw();
    },
    onRightDrag: (x, y) => {
      tilemapEditor.updatePatternSelection(x, y);
      mainView.redraw();
    },
    onRightDragEnd: () => {
      tilemapEditor.finalizePatternSelection();
      if (tilemapEditor.hasPattern) {
        tilesetEditor.setPatternSource('tilemap');
      }
      updatePatternUI();
      mainView.redraw();
    },
  });

  setupResizeObserver(mainCanvas, (w, h) => {
    mainView.resize(w, h);
    mainView.fitToView();
  });

  function getBaseCursor(): string {
    if (tilemapEditor.patternMode && tilemapEditor.hasPattern) return 'copy';
    return 'crosshair';
  }

  function updatePatternUI(): void {
    const btn = $('btn-pattern') as HTMLButtonElement;
    btn.classList.toggle('active', tilemapEditor.patternMode);
    mainCanvas.style.cursor = getBaseCursor();
    mainCanvas.classList.toggle('pattern-stamp', tilemapEditor.patternMode && tilemapEditor.hasPattern);
    if (!tilemapEditor.patternMode || !tilemapEditor.hasPattern) {
      tilesetEditor.setPatternSource(null);
    }
    tilesetEditor.refreshPicker();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Control') mainCanvas.style.cursor = 'copy';
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Control') mainCanvas.style.cursor = getBaseCursor();
  });

  const tilesetEditor = new TilesetEditor(state);
  const tilemapEditor = new TilemapEditor(state);

  // Right-click drag on tileset picker → pattern for stamping
  tilesetEditor.initPickerInteraction((tiles, width, height, sourceCol, sourceRow) => {
    tilemapEditor.setExternalPattern(tiles, width, height);
    tilesetEditor.setPatternSource({
      c1: sourceCol, r1: sourceRow,
      c2: sourceCol + width - 1, r2: sourceRow + height - 1,
    });
    updatePatternUI();
    mainView.redraw();
    events.emit('status:info', `Pattern selected from tileset: ${width}\u00d7${height} metatiles`);
  });

  // Pattern stamp toggle
  const patternBtn = $('btn-pattern') as HTMLButtonElement;
  patternBtn.addEventListener('click', () => {
    const newMode = !tilemapEditor.patternMode;
    tilemapEditor.setPatternMode(newMode);
    updatePatternUI();
    mainView.redraw();
    events.emit('status:info', newMode ? 'Pattern mode ON \u2014 select a region' : 'Pattern mode OFF');
  });

  events.on('pattern:toggled', ({ enabled }) => {
    updatePatternUI();
    mainView.redraw();
    if (!enabled) {
      events.emit('status:info', 'Pattern mode OFF');
    }
  });
  const gfxViewer = new GfxViewer($('gfx-canvas') as HTMLCanvasElement, state);
  const paletteViewer = new PaletteViewer($('palette-canvas') as HTMLCanvasElement, state);

  // --- View refresh helpers ---

  let contentWidth = 0;
  let contentHeight = 0;

  /**
   * Push the blended image to the canvas. Pan/zoom are kept unless `fit` is
   * set or the image size changed (e.g. hiding the larger of two layers).
   */
  function showComposite(fit: boolean): void {
    const img = tilemapEditor.getImageData();
    if (!img) {
      contentWidth = 0;
      contentHeight = 0;
      mainView.clearContent();
      return;
    }
    if (fit || img.width !== contentWidth || img.height !== contentHeight) {
      contentWidth = img.width;
      contentHeight = img.height;
      mainView.setContentSize(img.width, img.height);
      mainView.setImageData(img);
      mainView.fitToView();
    } else {
      mainView.setImageData(img);
      mainView.redraw();
    }
  }

  function refreshMainView(): void {
    if (!state.scene) return;
    showComposite(true);
  }

  function updateMainPixels(): void {
    if (!state.scene) return;
    showComposite(false);
  }

  function refreshAll(): void {
    tilesetEditor.refresh();
    tilemapEditor.refresh();
    gfxViewer.refresh();
    paletteViewer.refresh();
    refreshMainView();
  }

  /** A layer's tileset changed: re-render that layer and re-blend. */
  function refreshAfterTilesetEdit(layer: Layer): void {
    tilesetEditor.refresh();
    tilemapEditor.refreshLayer(layer);
    gfxViewer.refresh();
    updateMainPixels();
  }

  // --- Undo/redo action factories ---
  // Actions capture the layer they were made on: the active layer may differ
  // by the time they are undone or redone.

  function makeTilemapAction(changes: TileChange[], layer: Layer): UndoAction {
    return {
      description: `Stamp ${changes.length} tile(s) on layer ${layer}`,
      undo() {
        tilemapEditor.applyTileChanges(changes, false, layer);
        updateMainPixels();
      },
      redo() {
        tilemapEditor.applyTileChanges(changes, true, layer);
        updateMainPixels();
      },
    };
  }

  function makeTilesetAction(entryIndex: number, oldWord: number, newWord: number, layer: Layer): UndoAction {
    const tileset = () => layer === 2
      ? state.scene?.effectTileset
      : state.scene?.mainTileset;
    return {
      description: `Edit layer ${layer} tileset entry ${entryIndex}`,
      undo() {
        tileset()?.setEntryWord(entryIndex, oldWord);
        refreshAfterTilesetEdit(layer);
      },
      redo() {
        tileset()?.setEntryWord(entryIndex, newWord);
        refreshAfterTilesetEdit(layer);
      },
    };
  }

  // --- Undo/redo UI ---

  const btnUndo = $('btn-undo') as HTMLButtonElement;
  const btnRedo = $('btn-redo') as HTMLButtonElement;

  function updateUndoRedoButtons(): void {
    btnUndo.disabled = !history.canUndo;
    btnRedo.disabled = !history.canRedo;
  }

  function performUndo(): void {
    const action = history.undo();
    if (action) {
      events.emit('status:info', `Undo: ${action.description}`);
      updateUndoRedoButtons();
    }
  }

  function performRedo(): void {
    const action = history.redo();
    if (action) {
      events.emit('status:info', `Redo: ${action.description}`);
      updateUndoRedoButtons();
    }
  }

  btnUndo.addEventListener('click', performUndo);
  btnRedo.addEventListener('click', performRedo);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      performUndo();
    } else if (e.ctrlKey && (e.key === 'y' || (e.key === 'Z' && e.shiftKey) || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      performRedo();
    }
  });

  // --- Asset dropdown ---

  const layerBtn = $('btn-layer') as HTMLButtonElement;
  const dropdown = $('asset-dropdown') as HTMLDivElement;
  const fileInput = $('file-import') as HTMLInputElement;
  const resizeDropdown = $('resize-dropdown') as HTMLDivElement;

  function updateLayerButton(): void {
    layerBtn.innerHTML = `Layer ${state.activeLayer} &#x25BE;`;
    layerBtn.classList.toggle('active', state.activeLayer === 2);
  }

  // --- Layer activation and visibility ---
  //
  // Both layers are drawn blended on one canvas (see core/compositor.ts), but
  // edits only ever touch the active layer, whose tileset fills the picker.
  // Invariant: the active layer is always visible, and at least one layer is.

  const OTHER_LAYER: Record<Layer, Layer> = { 1: 2, 2: 1 };

  function isLayerAvailable(layer: Layer): boolean {
    return !!tilemapEditor.managerFor(layer)?.tilemap;
  }

  /** Whether a layer is actually drawn: it has a tilemap and is toggled on. */
  function isLayerShown(layer: Layer): boolean {
    return isLayerAvailable(layer) && state.layerVisible[layer];
  }

  /** Make `layer` the edited layer. Tileset, VRAM and palette panels follow it. */
  function setActiveLayer(layer: Layer): void {
    if (state.activeLayer === layer) return;
    state.activeLayer = layer;
    updateLayerButton();
    tilemapEditor.setPatternMode(false);
    updatePatternUI();
    events.emit('layer:changed', { layer });
    tilesetEditor.refresh();
    gfxViewer.refresh();
    paletteViewer.refresh();
    mainView.redraw();
  }

  /** Re-blend after a visibility change, keeping pan/zoom unless the image size changed. */
  function applyLayerVisibility(): void {
    tilemapEditor.recomposite();
    updateMainPixels();
    if (dropdown.classList.contains('open')) buildDropdownContent();
  }

  /**
   * Edit button: make the layer active.
   * If both layers are shown nothing else changes. If only one is shown, the
   * shown layer is swapped for the one being edited.
   */
  function selectLayerForEdit(layer: Layer): void {
    if (!isLayerAvailable(layer)) return;
    const other = OTHER_LAYER[layer];
    if (isLayerAvailable(other) && !(isLayerShown(layer) && isLayerShown(other))) {
      state.layerVisible[layer] = true;
      state.layerVisible[other] = false;
    }
    setActiveLayer(layer);
    applyLayerVisibility();
  }

  /**
   * Visibility toggle. Turning a layer on only shows it. Turning the active
   * layer off hands editing to the other layer. The last visible layer cannot
   * be turned off.
   */
  function toggleLayerVisibility(layer: Layer): void {
    if (!isLayerAvailable(layer)) return;
    const other = OTHER_LAYER[layer];

    if (state.layerVisible[layer]) {
      if (!isLayerShown(other)) {
        events.emit('status:info', 'At least one layer must stay visible');
        return;
      }
      state.layerVisible[layer] = false;
      if (state.activeLayer === layer) setActiveLayer(other);
    } else {
      state.layerVisible[layer] = true;
    }
    applyLayerVisibility();

    // Showing or hiding layer 1 changes how the active layer 2 maps onto the canvas.
    const fit = tilemapEditor.describeLayerFit();
    if (fit) events.emit('status:info', fit);
  }

  const TYPE_ORDER: LoadedAssetType[] = ['tilemap', 'tileset', 'bitmap', 'palette'];
  const TYPE_LABELS: Record<LoadedAssetType, string> = {
    tilemap: 'Tilemaps', tileset: 'Tilesets', bitmap: 'Bitmaps', palette: 'Palettes',
  };

  const TYPE_SVG: Record<LoadedAssetType, string> = {
    tilemap: '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="5" height="5" rx=".5" fill="none" stroke="#4fc3f7" stroke-width="1.3"/><rect x="8" y="1" width="5" height="5" rx=".5" fill="none" stroke="#4fc3f7" stroke-width="1.3"/><rect x="1" y="8" width="5" height="5" rx=".5" fill="none" stroke="#4fc3f7" stroke-width="1.3"/><rect x="8" y="8" width="5" height="5" rx=".5" fill="none" stroke="#4fc3f7" stroke-width="1.3"/></svg>',
    tileset: '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" rx="1" fill="none" stroke="#81c784" stroke-width="1.3"/><line x1="1" y1="5" x2="13" y2="5" stroke="#81c784" stroke-width=".8" opacity=".6"/><line x1="1" y1="9" x2="13" y2="9" stroke="#81c784" stroke-width=".8" opacity=".6"/><line x1="5" y1="1" x2="5" y2="13" stroke="#81c784" stroke-width=".8" opacity=".6"/><line x1="9" y1="1" x2="9" y2="13" stroke="#81c784" stroke-width=".8" opacity=".6"/></svg>',
    bitmap: '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="2" width="12" height="10" rx="1" fill="none" stroke="#ffb74d" stroke-width="1.3"/><circle cx="4.5" cy="5.5" r="1.5" fill="#ffb74d"/><path d="M1 9.5l3.5-2.5 2 1.5L10 5l3 3.5" stroke="#ffb74d" stroke-width="1" fill="none" stroke-linejoin="round"/></svg>',
    palette: '<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="#ce93d8" stroke-width="1.3"/><circle cx="5" cy="5" r="1.3" fill="#ef5350"/><circle cx="9" cy="5" r="1.3" fill="#66bb6a"/><circle cx="7" cy="9.5" r="1.3" fill="#42a5f5"/></svg>',
  };

  const ICON_EDIT = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1.5 10.5l.8-3.2L9 .5l2 2L4.2 9.3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M7.8 1.8l2.4 2.4" stroke="currentColor" stroke-width="1" fill="none"/></svg>';
  const ICON_EYE = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M.8 6C2 3.6 3.9 2.4 6 2.4S10 3.6 11.2 6C10 8.4 8.1 9.6 6 9.6S2 8.4.8 6z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><circle cx="6" cy="6" r="1.6" fill="currentColor"/></svg>';
  const ICON_EYE_OFF = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M.8 6C2 3.6 3.9 2.4 6 2.4S10 3.6 11.2 6C10 8.4 8.1 9.6 6 9.6S2 8.4.8 6z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" opacity=".45"/><path d="M1.5 10.5l9-9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  const ICON_IMPORT = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 8V1.5M3.5 5.5L6 8l2.5-2.5M1.5 10.5h9" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_EXPORT = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 2v6.5M3.5 4.5L6 2l2.5 2.5M1.5 10.5h9" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function buildDropdownContent(): void {
    if (!state.scene) {
      dropdown.innerHTML = '<div class="asset-empty">No scene loaded</div>';
      return;
    }

    const assets = state.scene.loadedAssets;
    const grouped = new Map<LoadedAssetType, LoadedAsset[]>();
    for (const a of assets) grouped.set(a.type, [...(grouped.get(a.type) ?? []), a]);

    let html = '';
    for (const type of TYPE_ORDER) {
      const list = grouped.get(type);
      if (!list?.length) continue;
      html += `<div class="asset-type-header">${TYPE_LABELS[type]}</div>`;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        const globalIdx = assets.indexOf(a);
        const layerHint = a.layer ? ` L${a.layer}` : '';
        html += `<div class="asset-entry" data-index="${globalIdx}">`;
        if (type === 'tilemap') {
          const target: Layer = (a.layer & 1) ? 1 : 2;
          const visible = state.layerVisible[target];
          const isLast = visible && !isLayerShown(OTHER_LAYER[target]);
          const visTitle = isLast
            ? 'At least one layer must stay visible'
            : `${visible ? 'Hide' : 'Show'} layer ${target}`;
          html += `<button class="asset-btn vis-btn${visible ? '' : ' off'}" data-action="visibility" data-layer="${target}" title="${visTitle}"${isLast ? ' disabled' : ''}>${visible ? ICON_EYE : ICON_EYE_OFF}</button>`;
          const editing = state.activeLayer === target;
          html += `<button class="asset-btn edit-btn${editing ? ' active' : ''}" data-action="edit" data-layer="${target}" title="${editing ? 'Editing this tilemap' : 'Edit this tilemap'}">${ICON_EDIT}</button>`;
        }
        html += `<span class="asset-type-icon" title="${type}">${TYPE_SVG[type]}</span>`;
        html += `<span class="asset-name" title="${a.filename}${layerHint}">${a.filename}${layerHint}</span>`;
        html += `<button class="asset-btn import-btn" data-action="import" data-index="${globalIdx}" title="Import ${a.extension}">${ICON_IMPORT}</button>`;
        html += `<button class="asset-btn export-btn" data-action="export" data-index="${globalIdx}" title="Export ${a.extension}">${ICON_EXPORT}</button>`;
        html += '</div>';
      }
    }

    if (!html) html = '<div class="asset-empty">No editable assets</div>';
    dropdown.innerHTML = html;
  }

  function closeDropdown(): void {
    dropdown.classList.remove('open');
  }

  layerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    resizeDropdown.classList.remove('open');
    closeNudgeDropdown();
    const isOpen = dropdown.classList.contains('open');
    if (isOpen) {
      closeDropdown();
    } else {
      buildDropdownContent();
      dropdown.classList.add('open');
    }
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target as Node) && e.target !== layerBtn) {
      closeDropdown();
    }
  });

  /** Report a finished (or cancelled) export in the status bar. */
  function reportExport(result: SaveResult, detail = ''): void {
    const extra = detail ? ` (${detail})` : '';
    switch (result.kind) {
      case 'saved':
        events.emit('status:info', `Exported ${result.name}${extra}`);
        break;
      case 'cancelled':
        events.emit('status:info', 'Export cancelled');
        break;
      case 'downloaded':
        events.emit('status:info',
          `No save dialog: ${result.name}${extra} went to the browser's downloads — ${result.reason}`);
        break;
    }
  }

  function reportExportFailure(err: unknown): void {
    events.emit('status:info', `Export failed: ${err instanceof Error ? err.message : err}`);
  }

  function getExportFilename(asset: LoadedAsset): string {
    const base = asset.resolvedKey.replace(/^.*[\\/]/, '');
    if (base.includes('.')) return base;
    return asset.filename + asset.extension;
  }

  let pendingImportAsset: LoadedAsset | null = null;

  dropdown.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.asset-btn') as HTMLElement | null;
    if (!btn || !state.scene || !state.payload) return;

    const action = btn.dataset.action;
    const index = Number(btn.dataset.index);
    const asset = state.scene.loadedAssets[index];

    if (action === 'visibility') {
      // The dropdown is rebuilt in place (detaching the clicked button), so
      // keep this click from reaching the outside-click handler that closes it.
      e.stopPropagation();
      toggleLayerVisibility(Number(btn.dataset.layer) as Layer);
      return;
    }

    if (action === 'edit') {
      const layer = Number(btn.dataset.layer) as Layer;
      selectLayerForEdit(layer);
      closeDropdown();
      const fit = tilemapEditor.describeLayerFit();
      events.emit('status:info', `Editing layer ${layer} tilemap${fit ? ` \u2014 ${fit}` : ''}`);
      return;
    }

    if (action === 'export' && asset) {
      const data = exportAssetData(state.scene, asset, state.payload);
      if (data) {
        const filename = getExportFilename(asset);
        // Must be called straight from the click so the browser allows the dialog.
        saveFile({
          suggestedName: filename,
          description: `${asset.type} data`,
          mime: 'application/octet-stream',
          extension: asset.extension,
          place: 'mapper-assets',
        }, () => new Blob([data.buffer as ArrayBuffer], { type: 'application/octet-stream' }))
          .then((result) => reportExport(result))
          .catch(reportExportFailure);
      }
      return;
    }

    if (action === 'import' && asset) {
      pendingImportAsset = asset;
      fileInput.accept = asset.extension;
      fileInput.click();
      return;
    }
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file || !state.scene || !pendingImportAsset) return;

    const asset = pendingImportAsset;
    pendingImportAsset = null;

    const reader = new FileReader();
    reader.onload = () => {
      const data = new Uint8Array(reader.result as ArrayBuffer);
      importAssetData(state.scene!, asset, data, state.payload ?? undefined);
      events.emit('asset:imported');
      events.emit('status:info', `Imported ${file.name} as ${asset.type}`);
    };
    reader.readAsArrayBuffer(file);
    fileInput.value = '';
  });

  // Grid toggle
  const gridBtn = $('btn-grid') as HTMLButtonElement;
  gridBtn.addEventListener('click', () => {
    state.gridEnabled = !state.gridEnabled;
    gridBtn.classList.toggle('active', state.gridEnabled);
    events.emit('grid:toggled', { enabled: state.gridEnabled });
    mainView.redraw();
    tilesetEditor.refreshPicker();
    gfxViewer.refresh();
  });

  // Block view toggle
  const blockBtn = $('btn-block-view') as HTMLButtonElement;
  blockBtn.addEventListener('click', () => {
    state.blockViewEnabled = !state.blockViewEnabled;
    blockBtn.classList.toggle('active', state.blockViewEnabled);
    mainView.redraw();
    tilesetEditor.refreshPicker();
  });

  // --- Resize tilemap ---

  const resizeBtn = $('btn-resize') as HTMLButtonElement;
  const resizeWidthInput = $('resize-width') as HTMLInputElement;
  const resizeHeightInput = $('resize-height') as HTMLInputElement;
  const resizeAnchorGrid = $('resize-anchor') as HTMLDivElement;
  const resizeInfo = $('resize-info') as HTMLDivElement;
  const resizeConfirmBtn = $('resize-confirm') as HTMLButtonElement;
  const resizeCancelBtn = $('resize-cancel') as HTMLButtonElement;

  let currentAnchor: TilemapAnchor = 'top-right';

  function openResizeDropdown(): void {
    const tm = tilemapEditor.tilemapManager?.tilemap;
    if (!tm) {
      events.emit('status:info', 'No tilemap loaded');
      return;
    }
    resizeWidthInput.value = String(tm.width);
    resizeHeightInput.value = String(tm.height);
    updateResizeInfo();
    resizeDropdown.classList.add('open');
  }

  function closeResizeDropdown(): void {
    resizeDropdown.classList.remove('open');
  }

  function updateResizeInfo(): void {
    const w = parseInt(resizeWidthInput.value, 10) || 0;
    const h = parseInt(resizeHeightInput.value, 10) || 0;
    const total = w * h;

    if (w < 1 || h < 1) {
      resizeInfo.textContent = 'Width and height must be at least 1';
      resizeInfo.className = 'resize-info error';
      resizeConfirmBtn.disabled = true;
    } else if (total > TILEMAP_MAX_BLOCKS) {
      resizeInfo.textContent = `${w}\u00d7${h} = ${total} blocks (max ${TILEMAP_MAX_BLOCKS})`;
      resizeInfo.className = 'resize-info error';
      resizeConfirmBtn.disabled = true;
    } else {
      resizeInfo.textContent = `${w}\u00d7${h} = ${total} blocks (max ${TILEMAP_MAX_BLOCKS})`;
      resizeInfo.className = 'resize-info';
      resizeConfirmBtn.disabled = false;
    }
  }

  resizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeDropdown();
    closeNudgeDropdown();
    if (resizeDropdown.classList.contains('open')) {
      closeResizeDropdown();
    } else {
      openResizeDropdown();
    }
  });

  document.addEventListener('click', (e) => {
    if (!resizeDropdown.contains(e.target as Node) && !resizeBtn.contains(e.target as Node)) {
      closeResizeDropdown();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && resizeDropdown.classList.contains('open')) {
      closeResizeDropdown();
    }
  });

  resizeAnchorGrid.addEventListener('click', (e) => {
    const cell = (e.target as HTMLElement).closest('.anchor-cell') as HTMLElement | null;
    if (!cell) return;
    resizeAnchorGrid.querySelector('.anchor-cell.active')?.classList.remove('active');
    cell.classList.add('active');
    currentAnchor = cell.dataset.anchor as TilemapAnchor;
  });

  resizeWidthInput.addEventListener('input', updateResizeInfo);
  resizeHeightInput.addEventListener('input', updateResizeInfo);

  resizeCancelBtn.addEventListener('click', closeResizeDropdown);

  resizeConfirmBtn.addEventListener('click', () => {
    const tm = tilemapEditor.tilemapManager?.tilemap;
    if (!tm) return;

    const newWidth = parseInt(resizeWidthInput.value, 10);
    const newHeight = parseInt(resizeHeightInput.value, 10);

    if (newWidth < 1 || newHeight < 1 || newWidth * newHeight > TILEMAP_MAX_BLOCKS) return;
    if (newWidth === tm.width && newHeight === tm.height) {
      closeResizeDropdown();
      return;
    }

    const oldSnapshot: TilemapState = {
      width: tm.width,
      height: tm.height,
      data: new Uint8Array(tm.data),
    };

    const newState = resizeTilemap(oldSnapshot, newWidth, newHeight, currentAnchor);
    tilemapEditor.tilemapManager!.tilemap = newState;

    const targetLayer = state.activeLayer;
    history.push(makeResizeAction(targetLayer, oldSnapshot, {
      width: newState.width,
      height: newState.height,
      data: new Uint8Array(newState.data),
    }));
    updateUndoRedoButtons();

    tilemapEditor.refresh();
    refreshMainView();
    closeResizeDropdown();
    events.emit('status:info', `Resized tilemap to ${newWidth}\u00d7${newHeight}`);
  });

  function makeResizeAction(
    targetLayer: 1 | 2,
    oldSnap: TilemapState,
    newSnap: TilemapState,
  ): UndoAction {
    function getManager() {
      return targetLayer === 2
        ? state.scene?.effectTilemap
        : state.scene?.mainTilemap;
    }
    return {
      description: `Resize to ${newSnap.width}\u00d7${newSnap.height}`,
      undo() {
        const mgr = getManager();
        if (mgr) {
          mgr.tilemap = {
            width: oldSnap.width,
            height: oldSnap.height,
            data: new Uint8Array(oldSnap.data),
          };
        }
        tilemapEditor.refresh();
        refreshMainView();
      },
      redo() {
        const mgr = getManager();
        if (mgr) {
          mgr.tilemap = {
            width: newSnap.width,
            height: newSnap.height,
            data: new Uint8Array(newSnap.data),
          };
        }
        tilemapEditor.refresh();
        refreshMainView();
      },
    };
  }

  // --- Nudge tilemap ---

  const nudgeBtn = $('btn-nudge') as HTMLButtonElement;
  const nudgeDropdown = $('nudge-dropdown') as HTMLDivElement;
  const nudgeAmountInput = $('nudge-amount') as HTMLInputElement;
  const nudgeWrapInput = $('nudge-wrap') as HTMLInputElement;

  function openNudgeDropdown(): void {
    if (!tilemapEditor.tilemapManager?.tilemap) {
      events.emit('status:info', 'No tilemap loaded');
      return;
    }
    nudgeDropdown.classList.add('open');
  }

  function closeNudgeDropdown(): void {
    nudgeDropdown.classList.remove('open');
  }

  nudgeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeDropdown();
    closeResizeDropdown();
    if (nudgeDropdown.classList.contains('open')) {
      closeNudgeDropdown();
    } else {
      openNudgeDropdown();
    }
  });

  document.addEventListener('click', (e) => {
    if (!nudgeDropdown.contains(e.target as Node) && !nudgeBtn.contains(e.target as Node)) {
      closeNudgeDropdown();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nudgeDropdown.classList.contains('open')) {
      closeNudgeDropdown();
    }
  });

  nudgeDropdown.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.nudge-arrow') as HTMLElement | null;
    if (!btn) return;

    const tm = tilemapEditor.tilemapManager?.tilemap;
    if (!tm) return;

    const direction = btn.dataset.dir as NudgeDirection;
    const amount = Math.max(1, parseInt(nudgeAmountInput.value, 10) || 1);
    const wrap = nudgeWrapInput.checked;

    const oldSnapshot: TilemapState = {
      width: tm.width,
      height: tm.height,
      data: new Uint8Array(tm.data),
    };

    const newState = nudgeTilemap(oldSnapshot, direction, amount, wrap);
    tilemapEditor.tilemapManager!.tilemap = newState;

    const targetLayer = state.activeLayer;
    history.push(makeNudgeAction(targetLayer, direction, amount, oldSnapshot, {
      width: newState.width,
      height: newState.height,
      data: new Uint8Array(newState.data),
    }));
    updateUndoRedoButtons();

    tilemapEditor.refresh();
    refreshMainView();
    events.emit('status:info', `Nudged ${direction} by ${amount}${wrap ? ' (wrap)' : ''}`);
  });

  function makeNudgeAction(
    targetLayer: 1 | 2,
    direction: NudgeDirection,
    amount: number,
    oldSnap: TilemapState,
    newSnap: TilemapState,
  ): UndoAction {
    function getManager() {
      return targetLayer === 2
        ? state.scene?.effectTilemap
        : state.scene?.mainTilemap;
    }
    return {
      description: `Nudge ${direction} ${amount}`,
      undo() {
        const mgr = getManager();
        if (mgr) {
          mgr.tilemap = {
            width: oldSnap.width,
            height: oldSnap.height,
            data: new Uint8Array(oldSnap.data),
          };
        }
        tilemapEditor.refresh();
        refreshMainView();
      },
      redo() {
        const mgr = getManager();
        if (mgr) {
          mgr.tilemap = {
            width: newSnap.width,
            height: newSnap.height,
            data: new Uint8Array(newSnap.data),
          };
        }
        tilemapEditor.refresh();
        refreshMainView();
      },
    };
  }

  // Property controls
  const propHFlip = $('prop-hflip') as HTMLInputElement;
  const propVFlip = $('prop-vflip') as HTMLInputElement;
  const propPriority = $('prop-priority') as HTMLInputElement;
  const propBlock = $('prop-block') as HTMLInputElement;

  function onPropChange(): void {
    const change = tilesetEditor.setEntryFlags(
      propHFlip.checked,
      propVFlip.checked,
      propPriority.checked,
      propBlock.checked,
    );
    if (change) {
      history.push(makeTilesetAction(change.entryIndex, change.oldWord, change.newWord, state.activeLayer));
      updateUndoRedoButtons();
    }
    events.emit('tileset:changed');
  }

  propHFlip.addEventListener('change', onPropChange);
  propVFlip.addEventListener('change', onPropChange);
  propPriority.addEventListener('change', onPropChange);
  propBlock.addEventListener('change', onPropChange);

  // Alt+key shortcuts for property toggles
  document.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    switch (e.key.toLowerCase()) {
      case 'h':
        e.preventDefault();
        propHFlip.checked = !propHFlip.checked;
        onPropChange();
        break;
      case 'v':
        e.preventDefault();
        propVFlip.checked = !propVFlip.checked;
        onPropChange();
        break;
      case 'p':
        e.preventDefault();
        propPriority.checked = !propPriority.checked;
        onPropChange();
        break;
      case 'b':
        e.preventDefault();
        propBlock.checked = !propBlock.checked;
        onPropChange();
        break;
    }
  });

  // --- Event subscriptions ---

  events.on('scene:loaded', () => {
    history.clear();
    updateUndoRedoButtons();
    tilemapEditor.setPatternMode(false);
    updatePatternUI();
    refreshAll();
  });

  events.on('tileset:changed', () => refreshAfterTilesetEdit(state.activeLayer));

  events.on('tileset:selected', ({ metatileIndex, quadIndex }) => {
    state.selectedMetatile = metatileIndex;
    state.selectedQuad = quadIndex;
    if (tilemapEditor.patternMode) {
      tilemapEditor.setPatternMode(false);
      updatePatternUI();
    }
    tilesetEditor.updatePropertyPanel();
    tilesetEditor.syncGfxAndPalette();
    tilesetEditor.refreshPicker();
    gfxViewer.refresh();
    paletteViewer.refresh();
    mainView.redraw();
  });

  events.on('palette:selected', ({ paletteIndex }) => {
    state.selectedPalette = paletteIndex;
    const change = tilesetEditor.assignPalette(paletteIndex);
    if (change) {
      history.push(makeTilesetAction(change.entryIndex, change.oldWord, change.newWord, state.activeLayer));
      updateUndoRedoButtons();
      events.emit('tileset:changed');
      tilesetEditor.updatePropertyPanel();
    }
    gfxViewer.refresh();
    paletteViewer.refresh();
  });

  events.on('gfx:selected', ({ tileIndex }) => {
    state.selectedGfxTile = tileIndex;
    const change = tilesetEditor.assignTile(tileIndex);
    if (change) {
      history.push(makeTilesetAction(change.entryIndex, change.oldWord, change.newWord, state.activeLayer));
      updateUndoRedoButtons();
    }
    events.emit('tileset:changed');
  });

  events.on('asset:imported', () => refreshAll());

  events.on('status:coords', (text) => {
    ($('status-coords') as HTMLSpanElement).textContent = text;
  });

  events.on('status:info', (text) => {
    ($('status-info') as HTMLSpanElement).textContent = text;
  });

  // --- Map image export ---

  const exportImageBtn = $('btn-export-image') as HTMLButtonElement;

  /** Save the blended map exactly as shown on the canvas (visible layers only) as a PNG. */
  exportImageBtn.addEventListener('click', () => {
    const image = tilemapEditor.getImageData();
    if (!image || !currentScene) {
      events.emit('status:info', 'Nothing to export: no map is shown');
      return;
    }

    const shown = ([1, 2] as Layer[]).filter(isLayerShown);
    const layerNote = shown.length === 1 ? ` (layer ${shown[0]} only)` : '';
    const name = `${sanitizeFileName(currentScene.description)}${layerNote}.png`;

    // Snapshot now: the ImageData is edited in place and encoding happens after the dialog.
    const canvas = imageDataToCanvas(image);
    saveFile({
      suggestedName: name,
      description: 'PNG image',
      mime: 'image/png',
      extension: '.png',
      place: 'mapper-images',
    }, () => canvasToPng(canvas))
      .then((result) => reportExport(result, `${canvas.width}×${canvas.height}`))
      .catch(reportExportFailure);
  });

  events.on('scene:loaded', () => {
    exportImageBtn.disabled = !tilemapEditor.getImageData();
  });

  // Scene selection handler
  let currentScene: SceneEntry | null = null;
  sceneSelector.onSelect(async (entry: SceneEntry) => {
    if (!state.payload || !state.manifest) return;
    currentScene = entry;
    events.emit('status:info', `Loading ${entry.description}...`);

    state.activeLayer = 1;
    state.layerVisible = { 1: true, 2: true };
    updateLayerButton();

    state.scene = loadScene(state.manifest, state.payload, entry.group, entry.name);
    events.emit('scene:loaded');
    events.emit('status:info',
      `Loaded: ${entry.description} (ID ${entry.id}) \u2014 ${describeBlend(
        state.scene.blend, [isLayerAvailable(1), isLayerAvailable(2)])}`);
  });
}

document.addEventListener('DOMContentLoaded', init);
