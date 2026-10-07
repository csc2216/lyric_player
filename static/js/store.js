// Minimal promise wrapper around IndexedDB: one store of song records + a small key/value meta store.

const DB_NAME = "lyric-player";
const DB_VERSION = 1;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class Store {
  constructor() {
    this.db = null;
  }

  async open() {
    if (this.db) return this;
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("songs")) db.createObjectStore("songs", { keyPath: "key" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    this.db = await promisify(request);
    return this;
  }

  #tx(name, mode = "readonly") {
    return this.db.transaction(name, mode).objectStore(name);
  }

  allSongs() {
    return promisify(this.#tx("songs").getAll());
  }

  putSong(record) {
    return promisify(this.#tx("songs", "readwrite").put(record));
  }

  deleteSong(key) {
    return promisify(this.#tx("songs", "readwrite").delete(key));
  }

  getMeta(key) {
    return promisify(this.#tx("meta").get(key));
  }

  setMeta(key, value) {
    return promisify(this.#tx("meta", "readwrite").put(value, key));
  }
}
