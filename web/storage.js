// Storage interface: load() resolves to the whole database object (or null when empty),
// save(data) replaces it atomically. The database mirrors the SQLite tables.

import { emptyBudget } from './budget/store.js';

export function emptyDatabase() {
  return { projects: [], milestones: [], settings: {}, seq: { projects: 0, milestones: 0 }, budget: emptyBudget() };
}

export function createMemoryStore(initial = null) {
  let data = initial ? structuredClone(initial) : null;
  return {
    async load() { return data ? structuredClone(data) : null; },
    async save(next) { data = structuredClone(next); },
  };
}

const DB_NAME = 'projtrack';
const STORE_NAME = 'kv';
const DATA_KEY = 'data';

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function createIndexedDbStore(factory = globalThis.indexedDB) {
  let opened = null;
  const open = () => {
    opened ??= new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return opened;
  };
  const objectStore = async (mode) => (await open()).transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  return {
    async load() { return (await promisify((await objectStore('readonly')).get(DATA_KEY))) ?? null; },
    async save(data) { await promisify((await objectStore('readwrite')).put(data, DATA_KEY)); },
  };
}
