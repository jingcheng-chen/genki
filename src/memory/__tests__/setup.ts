// Vitest setup — installs a fake IndexedDB polyfill so `idb-keyval`
// runs headlessly. `fake-indexeddb/auto` mutates `globalThis` on
// import, so pulling this as a setupFile is the cleanest hook.
import 'fake-indexeddb/auto'
