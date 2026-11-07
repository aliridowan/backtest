// Trade screenshots (JPEG data URLs) in IndexedDB: too big for localStorage.
// Key: `${sessionId}/${tradeId}/${"entry" | "exit"}`.

export type ShotKind = "entry" | "exit";
const DB = "bm.shots", STORE = "shots";
let dbp: Promise<IDBDatabase> | null = null;

function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
  });
  return dbp;
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const store = (await db()).transaction(STORE, mode).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const shotKey = (sid: string, tid: string, kind: ShotKind) => `${sid}/${tid}/${kind}`;
export const putShot = (key: string, url: string) => run("readwrite", (s) => s.put(url, key));
export const getShot = (key: string) => run<string | undefined>("readonly", (s) => s.get(key));
// Every screenshot of a session (when it is deleted).
export const deleteShots = (sid: string) => run("readwrite", (s) => s.delete(IDBKeyRange.bound(`${sid}/`, `${sid}/￿`)));
