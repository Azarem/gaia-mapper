import { events } from './ui/events';
import { setupResizeObserver } from './ui/layout';
import { CanvasView } from './ui/canvas-view';
import { History, type UndoAction } from './ui/history';
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

const PAYLOAD_URL = 'payload.zip';

export interface AppState {
  manifest: PayloadManifest | null;
  payload: Map<string, Uint8Array> | null;
  scene: SceneState | null;
  activeLayer: 1 | 2;
  gridEnabled: boolean;
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
  gridEnabled: false,
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
    state.payload = await fetchPayload(PAYLOAD_URL);
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
      const changes = tilemapEditor.commitStampBatch();
      if (changes) {
        history.push(makeTilemapAction(changes));
        updateUndoRedoButtons();
      }
    },
  });

  setupResizeObserver(mainCanvas, (w, h) => {
    mainView.resize(w, h);
    mainView.fitToView();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Control') mainCanvas.style.cursor = 'copy';
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Control') mainCanvas.style.cursor = 'crosshair';
  });

  const tilesetEditor = new TilesetEditor(state);
  const tilemapEditor = new TilemapEditor(state);
  const gfxViewer = new GfxViewer($('gfx-canvas') as HTMLCanvasElement, state);
  const paletteViewer = new PaletteViewer($('palette-canvas') as HTMLCanvasElement, state);

  // --- View refresh helpers ---

  function refreshMainView(): void {
    if (!state.scene) return;
    const img = tilemapEditor.getImageData();
    if (img) {
      mainView.setContentSize(img.width, img.height);
      mainView.setImageData(img);
      mainView.fitToView();
    }
  }

  function updateMainPixels(): void {
    if (!state.scene) return;
    const img = tilemapEditor.getImageData();
    if (img) {
      mainView.setImageData(img);
      mainView.redraw();
    }
  }

  function refreshAll(): void {
    tilesetEditor.refresh();
    tilemapEditor.refresh();
    gfxViewer.refresh();
    paletteViewer.refresh();
    refreshMainView();
  }

  function refreshAfterTilesetEdit(): void {
    tilesetEditor.refresh();
    tilemapEditor.refresh();
    gfxViewer.refresh();
    updateMainPixels();
  }

  // --- Undo/redo action factories ---

  function makeTilemapAction(changes: TileChange[]): UndoAction {
    return {
      description: `Stamp ${changes.length} tile(s)`,
      undo() {
        tilemapEditor.applyTileChanges(changes, false);
        updateMainPixels();
      },
      redo() {
        tilemapEditor.applyTileChanges(changes, true);
        updateMainPixels();
      },
    };
  }

  function makeTilesetAction(entryIndex: number, oldWord: number, newWord: number): UndoAction {
    return {
      description: `Edit tileset entry ${entryIndex}`,
      undo() {
        const ts = state.activeLayer === 2
          ? state.scene?.effectTileset
          : state.scene?.mainTileset;
        ts?.setEntryWord(entryIndex, oldWord);
        refreshAfterTilesetEdit();
      },
      redo() {
        const ts = state.activeLayer === 2
          ? state.scene?.effectTileset
          : state.scene?.mainTileset;
        ts?.setEntryWord(entryIndex, newWord);
        refreshAfterTilesetEdit();
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

  function switchLayer(layer: 1 | 2): void {
    if (state.activeLayer === layer) return;
    state.activeLayer = layer;
    updateLayerButton();
    events.emit('layer:changed', { layer });
    refreshAll();
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
          const target = (a.layer & 1) ? 1 : 2;
          html += `<button class="asset-btn edit-btn" data-action="edit" data-layer="${target}" title="Edit this tilemap">${ICON_EDIT}</button>`;
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

  function downloadBlob(data: Uint8Array, filename: string): void {
    const blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
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

    if (action === 'edit') {
      const layer = Number(btn.dataset.layer) as 1 | 2;
      switchLayer(layer);
      closeDropdown();
      events.emit('status:info', `Editing layer ${layer} tilemap`);
      return;
    }

    if (action === 'export' && asset) {
      const data = exportAssetData(state.scene, asset, state.payload);
      if (data) {
        const filename = getExportFilename(asset);
        downloadBlob(data, filename);
        events.emit('status:info', `Exported ${filename}`);
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
      history.push(makeTilesetAction(change.entryIndex, change.oldWord, change.newWord));
      updateUndoRedoButtons();
    }
    events.emit('tileset:changed');
  }

  propHFlip.addEventListener('change', onPropChange);
  propVFlip.addEventListener('change', onPropChange);
  propPriority.addEventListener('change', onPropChange);
  propBlock.addEventListener('change', onPropChange);


  // --- Event subscriptions ---

  events.on('scene:loaded', () => {
    history.clear();
    updateUndoRedoButtons();
    refreshAll();
  });

  events.on('tileset:changed', refreshAfterTilesetEdit);

  events.on('tileset:selected', ({ metatileIndex, quadIndex }) => {
    state.selectedMetatile = metatileIndex;
    state.selectedQuad = quadIndex;
    tilesetEditor.updatePropertyPanel();
    tilesetEditor.syncGfxAndPalette();
    tilesetEditor.refreshPicker();
    gfxViewer.refresh();
    paletteViewer.refresh();
    mainView.redraw();
  });

  events.on('palette:selected', ({ paletteIndex }) => {
    state.selectedPalette = paletteIndex;
    gfxViewer.refresh();
    paletteViewer.refresh();
  });

  events.on('gfx:selected', ({ tileIndex }) => {
    state.selectedGfxTile = tileIndex;
    const change = tilesetEditor.assignTile(tileIndex);
    if (change) {
      history.push(makeTilesetAction(change.entryIndex, change.oldWord, change.newWord));
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

  // Scene selection handler
  sceneSelector.onSelect(async (entry: SceneEntry) => {
    if (!state.payload || !state.manifest) return;
    events.emit('status:info', `Loading ${entry.description}...`);

    state.activeLayer = 1;
    updateLayerButton();

    state.scene = loadScene(state.manifest, state.payload, entry.group, entry.name);
    events.emit('scene:loaded');
    events.emit('status:info', `Loaded: ${entry.description} (ID ${entry.id})`);
  });
}

document.addEventListener('DOMContentLoaded', init);
