/**
 * Tiny IndexedDB key/value store.
 *
 * Holds the raw bytes of the files you loaded so a browser refresh does not
 * make you pick them again. Everything stays on this machine — the app has no
 * server and never uploads a ROM or a log.
 */

const DB_NAME = '4b11-tuner';
const STORE = 'files';
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    return await tx<T>('readonly', (s) => s.get(key) as IDBRequest<T>);
  } catch {
    return undefined;
  }
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(value, key) as IDBRequest<unknown>);
  } catch {
    /* storage is a convenience; never block the app on it */
  }
}

export async function idbDelete(key: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
  } catch {
    /* ignore */
  }
}
