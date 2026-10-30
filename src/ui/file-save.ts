/**
 * Saving files through a "Save as" dialog.
 *
 * Uses the File System Access API (`showSaveFilePicker`) so the user picks the
 * location for every export instead of the browser dropping the file into its
 * downloads folder. Each picker `id` makes the browser remember the folder last
 * used with it, so the dialog opens where that kind of file was saved before.
 *
 * The API only exists in Chromium browsers, and only on pages served over
 * HTTPS or from localhost, outside cross-origin frames. Anywhere else the file
 * falls back to a plain download, and the result says why so the status bar can
 * tell the user instead of silently saving to the downloads folder.
 */

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  id?: string;
  suggestedName?: string;
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
}

interface WritableHandle {
  name: string;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}

type ShowSaveFilePicker = (options?: SaveFilePickerOptions) => Promise<WritableHandle>;

/** Folder memory slots: each remembers the last folder used with it. */
export type SavePlace = 'mapper-assets' | 'mapper-images';

export interface SaveRequest {
  /** Proposed file name, including extension. The user may change it. */
  suggestedName: string;
  /** Text shown for the file type in the dialog, e.g. "PNG image". */
  description: string;
  mime: string;
  /** Extension with the leading dot, e.g. ".png". */
  extension: string;
  place: SavePlace;
}

export type SaveResult =
  /** The user chose a location in the save dialog. `name` is the file name they chose. */
  | { kind: 'saved'; name: string }
  /** The user closed the dialog without saving. */
  | { kind: 'cancelled' }
  /** No dialog was possible; the file went to the browser's downloads. `reason` says why. */
  | { kind: 'downloaded'; name: string; reason: string };

/** The save dialog function, or the reason it can't be used on this page. */
function getPicker(): { picker: ShowSaveFilePicker } | { reason: string } {
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (!window.isSecureContext) {
    return { reason: `this page (${location.origin}) is not HTTPS or localhost, so the browser hides the save dialog` };
  }
  if (typeof picker !== 'function') {
    return { reason: 'this browser has no save dialog support (use Chrome or Edge)' };
  }
  return { picker: picker.bind(window) };
}

function downloadFallback(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking right away can cancel the download of a large blob before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Ask the user where to save, then write the file.
 *
 * Call this directly from the click handler: the browser only opens the dialog
 * for a real user click. `produce` runs after the dialog is open, so slow work
 * (image encoding) doesn't delay the dialog past that click.
 */
export async function saveFile(
  request: SaveRequest,
  produce: () => Blob | Promise<Blob>,
): Promise<SaveResult> {
  const found = getPicker();
  if ('reason' in found) {
    downloadFallback(await produce(), request.suggestedName);
    return { kind: 'downloaded', name: request.suggestedName, reason: found.reason };
  }

  let handle: WritableHandle;
  try {
    handle = await found.picker({
      id: request.place,
      suggestedName: request.suggestedName,
      types: [{ description: request.description, accept: { [request.mime]: [request.extension] } }],
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return { kind: 'cancelled' };
    if (err instanceof DOMException && err.name === 'SecurityError') {
      // Blocked in this context (cross-origin frame, or not a user click): download instead.
      downloadFallback(await produce(), request.suggestedName);
      return { kind: 'downloaded', name: request.suggestedName, reason: err.message };
    }
    throw err;
  }

  const blob = await produce();
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
  return { kind: 'saved', name: handle.name };
}

/** Copy an ImageData onto a new canvas (a snapshot: later edits to the ImageData don't affect it). */
export function imageDataToCanvas(image: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  return canvas;
}

/** Encode a canvas as a PNG (lossless, keeps transparency). */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))),
      'image/png',
    );
  });
}

/** A file-name-safe version of a scene description. */
export function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim() || 'map';
}
