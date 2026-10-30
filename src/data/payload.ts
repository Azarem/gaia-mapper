import { unzipSync } from 'fflate';

const DB_NAME = 'gaia-mapper-cache';
const STORE_NAME = 'payloads';
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCached(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function putCached(key: string, data: ArrayBuffer): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(data, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Cache write failure is non-fatal
  }
}

/** Remove every cached payload except `keepKey` (older payload versions). */
async function pruneCache(keepKey: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        for (const key of req.result) {
          if (key !== keepKey) store.delete(key);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Pruning failure is non-fatal
  }
}

/**
 * Download a ZIP payload, caching in IndexedDB.
 * Returns a Map from filename (with path) to Uint8Array contents.
 *
 * `version` is part of the cache key: bump it whenever the payload format
 * changes so clients re-download instead of reusing an incompatible cached ZIP.
 */
export async function fetchPayload(url: string, version: number): Promise<Map<string, Uint8Array>> {
  let buffer: ArrayBuffer;

  const cacheKey = `${url}?v=${version}`;
  const cached = await getCached(cacheKey);
  if (cached) {
    buffer = cached;
  } else {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Failed to fetch payload: ${response.status} ${response.statusText}`);
    }
    buffer = await response.arrayBuffer();
    await putCached(cacheKey, buffer);
    await pruneCache(cacheKey);
  }

  const zipData = new Uint8Array(buffer);
  const unzipped = unzipSync(zipData);

  const files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(unzipped)) {
    files.set(name, data);
  }

  return files;
}

/**
 * Clear the IndexedDB cache (for debugging/development).
 */
export async function clearCache(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
