/**
 * 图库持久化：把出过的图存进浏览器的 IndexedDB。
 *
 * 为什么不用 extension_settings：那张表会被 ST 每改一次设置就整份写回
 * settings.json，几 MB 的 base64 塞进去，服务器端会一路变慢到最后写失败。
 * IndexedDB 天生就是放二进制的，和设置彻底分开。
 *
 * 为什么不用 localStorage：容量 5MB，两三张 PNG 就满，而且满的时候是**静默失败**——
 * 用户看到的就是「刷新后图没了」。
 *
 * 「刷新后图全丢」这条 bug 历史上被修过两轮,但每次都还有人在别的浏览器上复发,
 * 所以这一版把三个真凶都堵死了:
 *
 * 1. **图片必须是 data URL**。ComfyUI 直接出的是 `URL.createObjectURL(blob)`,
 *    那只是当前页面内存里的句柄,刷新即失效。落地前统一 `toDataUrl()`。
 * 2. **IndexedDB 打不开时必须说出来**。隐私模式 / 存储被清 / `onblocked` 都让
 *    open 失败,旧实现静默退回内存 Map(刷新即丢),用户毫不知情。现在会把原因
 *    记下来,图库页和面板直接显示「这张图只存在内存里,刷新就没了」。
 * 3. **写库要串行**。一次出 3~8 张时并发开 transaction,Firefox 上会
 *    `TransactionInactiveError`,失败的正是最后几张——表现为「只丢了一部分」。
 *    这里所有写操作排一条队列,顺次开 tx。
 *
 * 兼容：无 IndexedDB 的环境（jsdom 单测、极老的浏览器）自动退回内存 Map，
 * 调用方无需区分，只是刷新即丢。
 */

export interface StoredImage {
  /** 唯一 id。 */
  id: string;
  /** 聊天 id；换聊天隔离。 */
  chatId: string;
  /** 楼层。 */
  floor: number;
  /** swipe 号。 */
  swipe: number;
  /** 同一楼里的第几张（从 0 起），决定回插顺序。 */
  index: number;
  /** 这一批一共几张(单张时 = 1)。图库卡片上显示「第 i/n 张」。 */
  total?: number;
  /** 该图对应的正向提示词。 */
  positive: string;
  /** 负面提示词。 */
  negative: string;
  /** 中转站原始输出。 */
  compiled: string;
  /** 种子。 */
  seed: number;
  /** data URL（不是 blob URL——blob URL 刷新即失效，这正是丢图的原因）。 */
  image: string;
  /** 回插定位片段：这段正文的结尾若干字。 */
  anchor: string;
  /** 回插定位片段：这段正文的开头若干字(锚点被 ST 重渲染改掉时用它兜底)。 */
  anchorStart?: string;
  /** 这张图插在第几段之后(0 起);插入提示词时用它决定插回哪一段。 */
  segmentIndex?: number;
  createdAt: number;
}

const DB_NAME = 'htj-zz-db';
const DB_VERSION = 1;
const STORE = 'images';

/** 内存兜底：无 IndexedDB 时用。 */
const memory = new Map<string, StoredImage>();

let dbPromise: Promise<IDBDatabase | null> | null = null;
/** 最近一次打开失败的原因(人话),给图库页与面板显示。 */
let storageProblem = '';

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>(resolve => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      storageProblem = '这个浏览器/上下文没有 IndexedDB(隐私模式常见),图只能留在内存里,刷新会丢。';
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      storageProblem = `打不开 IndexedDB:${error instanceof Error ? error.message : String(error)}`;
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('chat', 'chatId', { unique: false });
        store.createIndex('chatFloor', ['chatId', 'floor', 'swipe'], { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // 另一个标签页升版本时会被要求让路;把连接关掉,免得把自己钉成僵尸连接。
      db.onversionchange = () => db.close();
      storageProblem = '';
      resolve(db);
    };
    request.onerror = () => {
      storageProblem = `IndexedDB 打开失败:${request.error?.message ?? '未知原因'}(可能是隐私模式/存储被禁用)`;
      resolve(null);
    };
    request.onblocked = () => {
      storageProblem = 'IndexedDB 被另一个标签页占用(升级被阻塞),先关掉其它酒馆标签页再刷新。';
      resolve(null);
    };
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<boolean> {
  return new Promise(resolve => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

/* ---------------- 写队列 ---------------- */

/**
 * 所有写操作排一条链。
 *
 * 实测踩到的坑:一次出 5 张时每张都立刻 `db.transaction()`,前一个 showSaveFilePicker
 * 式的长事务还没提交,后面几个 tx 就 Janus 了(Firefox: TransactionInactiveError),
 * 结果是**最后几张丢了**。串行执行后每张都是独立、已提交的事务。
 */
let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeChain.then(task, task);
  // 不让失败卡住队列;调用方拿到的仍是自己的 reject。
  writeChain = next.catch(() => undefined);
  return next;
}

export function newImageId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}`;
}

/** 存一张图（同 id 覆盖）。 */
export async function saveStoredImage(entry: StoredImage): Promise<void> {
  memory.set(entry.id, entry);
  const db = await openDb();
  if (!db) return;
  await enqueue(async () => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry);
      const ok = await txDone(tx);
      if (!ok) storageProblem = '写 IndexedDB 失败(可能是存储空间已满),这张图只留在内存里。';
    } catch (error) {
      storageProblem = `写 IndexedDB 失败:${error instanceof Error ? error.message : String(error)}`;
    }
  });
}

function byFloorThenIndex(a: StoredImage, b: StoredImage): number {
  if (a.floor !== b.floor) return a.floor - b.floor;
  if (a.index !== b.index) return a.index - b.index;
  return a.createdAt - b.createdAt;
}

/** 某个聊天里的全部图，按楼层/序号排好。 */
export async function listStoredImages(chatId: string): Promise<StoredImage[]> {
  const fromMemory = [...memory.values()].filter(x => x.chatId === chatId);
  const db = await openDb();
  if (!db) return fromMemory.sort(byFloorThenIndex);
  try {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const rows = await new Promise<StoredImage[]>(resolve => {
      const request = store.index('chat').getAll(IDBKeyRange.only(chatId));
      request.onsuccess = () => resolve((request.result ?? []) as StoredImage[]);
      request.onerror = () => resolve([]);
    });
    // IndexedDB 与内存可能各有各的（本次会话新出的图还没落盘时），合并去重。
    const merged = new Map<string, StoredImage>();
    for (const row of rows) merged.set(row.id, row);
    for (const row of fromMemory) merged.set(row.id, row);
    return [...merged.values()].sort(byFloorThenIndex);
  } catch (error) {
    storageProblem = `读 IndexedDB 失败:${error instanceof Error ? error.message : String(error)}`;
    return fromMemory.sort(byFloorThenIndex);
  }
}

/** 某一楼（含 swipe）的图。 */
export async function listFloorImages(chatId: string, floor: number, swipe: number): Promise<StoredImage[]> {
  const all = await listStoredImages(chatId);
  return all.filter(x => x.floor === floor && x.swipe === swipe);
}

/** 删一张。 */
export async function deleteStoredImage(id: string): Promise<void> {
  memory.delete(id);
  const db = await openDb();
  if (!db) return;
  await enqueue(async () => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      await txDone(tx);
    } catch {
      /* 删失败只影响下一次水合,不影响出图 */
    }
  });
}

/**
 * 只清 IndexedDB 的某一楼(重出这一楼前用)。
 *
 * 注意不碰内存表:里面可能有别的楼层刚出、还没走完 readwrite 的条目。
 */
export async function deleteFloorImages(chatId: string, floor: number, swipe: number): Promise<void> {
  for (const [id, entry] of [...memory.entries()]) {
    if (entry.chatId === chatId && entry.floor === floor && entry.swipe === swipe) memory.delete(id);
  }
  const db = await openDb();
  if (!db) return;
  await enqueue(async () => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const keys = await new Promise<IDBValidKey[]>(resolve => {
        const request = store.index('chatFloor').getAllKeys(IDBKeyRange.only([chatId, floor, swipe]));
        request.onsuccess = () => resolve(request.result ?? []);
        request.onerror = () => resolve([]);
      });
      for (const key of keys) store.delete(key);
      await txDone(tx);
    } catch {
      /* 清失败不影响后续写入(新图 id 都是新的,不会撞) */
    }
  });
}

/** 清空某个聊天的图（换聊天重置 / 一键清理用）。 */
export async function clearChatImages(chatId: string): Promise<void> {
  for (const [id, entry] of [...memory.entries()]) {
    if (entry.chatId === chatId) memory.delete(id);
  }
  const db = await openDb();
  if (!db) return;
  await enqueue(async () => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const keys = await new Promise<IDBValidKey[]>(resolve => {
        const request = store.index('chat').getAllKeys(IDBKeyRange.only(chatId));
        request.onsuccess = () => resolve(request.result ?? []);
        request.onerror = () => resolve([]);
      });
      for (const key of keys) store.delete(key);
      await txDone(tx);
    } catch {
      /* ignore */
    }
  });
}

/** 超过上限时删掉最老的若干张。 */
export async function trimChatImages(chatId: string, limit: number): Promise<number> {
  const max = Math.max(1, Math.floor(Number(limit) || 0));
  const all = await listStoredImages(chatId);
  if (all.length <= max) return 0;
  const doomed = [...all].sort((a, b) => a.createdAt - b.createdAt).slice(0, all.length - max);
  for (const entry of doomed) await deleteStoredImage(entry.id);
  return doomed.length;
}

/**
 * blob URL / data URL → data URL。
 *
 * ComfyUI 出图走的是 `URL.createObjectURL(blob)`，那个 URL 只是当前页面内存里的一个句柄，
 * 刷新就失效——这正是「图库刷新后全丢」的直接原因。要活下来必须落成 base64。
 *
 * 注意:转换失败时**不要**把 blob URL 原样返回当成功——那等于把坏数据写进库,
 * 下次水合时是一张碎图。这里返回空串,调用方据此把这张标记为「未能落地」。
 */
export async function toDataUrl(url: string): Promise<string> {
  const text = String(url ?? '');
  if (!text) return '';
  if (text.startsWith('data:')) return text;
  try {
    const response = await fetch(text);
    if (!response.ok) return '';
    const blob = await response.blob();
    if (!blob.size) return '';
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(blob);
    });
  } catch {
    return '';
  }
}

/** 图库持久化现在是否真的可用;不可用时返回人话原因(供 UI 显示)。 */
export async function storageHealth(): Promise<{ ok: boolean; message: string }> {
  const db = await openDb();
  if (!db) return { ok: false, message: storageProblem || '浏览器没有可用的 IndexedDB' };
  return { ok: true, message: storageProblem };
}

/** 供测试用：清空内存兜底表。 */
export function resetGalleryMemory(): void {
  memory.clear();
  dbPromise = null;
  storageProblem = '';
  writeChain = Promise.resolve();
}
