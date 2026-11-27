'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { loadState } = require('./state-loader.cjs');

const { Engine: engine, AvatarState: app, WorkLibrary: lib } = loadState(
  readFileSync(join(__dirname, '..', 'index.html'), 'utf8')
);
const plain = value => JSON.parse(JSON.stringify(value));

function memoryStorage(initial) {
  const data = new Map();
  const calls = { get: 0, set: 0, remove: 0 };
  if (initial !== undefined) data.set(app.DRAFT_KEY, initial);
  return {
    calls,
    raw: data,
    getItem(key) { calls.get += 1; return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { calls.set += 1; data.set(key, String(value)); },
    removeItem(key) { calls.remove += 1; data.delete(key); },
  };
}

/**
 * 支持真实事务回滚、配额错误与失败注入的轻量 IndexedDB 测试替身。
 */
function createMockIDB(hooks = {}) {
  const dbs = new Map();

  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  function makeStoreData(keyPath) {
    return { keyPath, records: new Map(), indexes: new Set() };
  }

  function makeQuotaError() {
    const err = new Error('QuotaExceededError');
    err.name = 'QuotaExceededError';
    err.code = 22;
    return err;
  }

  function createFakeDb(name) {
    let record = dbs.get(name);
    if (!record) {
      record = { version: 0, stores: new Map() };
      dbs.set(name, record);
    }

    const db = {
      objectStoreNames: {
        contains(storeName) { return record.stores.has(storeName); }
      },
      createObjectStore(storeName, opts) {
        const s = makeStoreData(opts.keyPath);
        record.stores.set(storeName, s);
        return {
          createIndex(indexName) { s.indexes.add(indexName); }
        };
      },
      close() {},
      transaction(storeNames, mode) {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        // 事务快照：abort 或出错时完全回滚
        const snapshot = new Map();
        for (const sn of names) {
          const st = record.stores.get(sn);
          assert.ok(st, `missing objectStore: ${sn}`);
          snapshot.set(sn, new Map([...st.records.entries()].map(([k, v]) => [k, clone(v)])));
        }

        let aborted = false;
        let finished = false;
        let pendingOps = 0;

        const tx = {
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          abort() {
            if (aborted || finished) return;
            aborted = true;
            for (const [sn, snap] of snapshot.entries()) {
              record.stores.get(sn).records = snap;
            }
            finished = true;
            queueMicrotask(() => {
              if (typeof tx.onabort === 'function') tx.onabort();
            });
          },
          objectStore(sn) {
            const st = record.stores.get(sn);
            assert.ok(st, `store ${sn} not in tx`);
            function schedule(fn) {
              const req = { result: undefined, error: null, onsuccess: null, onerror: null };
              pendingOps += 1;
              queueMicrotask(() => {
                if (aborted) return;
                try {
                  req.result = fn();
                  if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
                } catch (err) {
                  req.error = err;
                  tx.error = err;
                  if (typeof req.onerror === 'function') req.onerror({ target: req });
                  tx.abort();
                  return;
                } finally {
                  pendingOps -= 1;
                }
                queueMicrotask(() => {
                  if (!aborted && !finished && pendingOps === 0) {
                    finished = true;
                    if (typeof tx.oncomplete === 'function') tx.oncomplete();
                  }
                });
              });
              return req;
            }
            return {
              get(key) {
                return schedule(() => clone(st.records.get(key)));
              },
              getAll() {
                return schedule(() => [...st.records.values()].map(clone));
              },
              put(value) {
                if (mode !== 'readwrite') throw new Error('ReadOnlyError');
                return schedule(() => {
                  if (typeof hooks.onPut === 'function') {
                    hooks.onPut(sn, value, { makeQuotaError });
                  }
                  const key = value[st.keyPath];
                  st.records.set(key, clone(value));
                  return key;
                });
              }
            };
          }
        };
        return tx;
      }
    };
    return { db, record };
  }

  return {
    dbs,
    open(name, version) {
      if (typeof hooks.onOpen === 'function') {
        hooks.onOpen(name, version, { makeQuotaError });
      }
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (hooks.openError) {
          req.error = hooks.openError;
          if (typeof req.onerror === 'function') req.onerror({ target: req });
          return;
        }
        const { db, record } = createFakeDb(name);
        req.result = db;
        if (record.version < version) {
          record.version = version;
          if (typeof req.onupgradeneeded === 'function') req.onupgradeneeded({ target: req });
        }
        if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
      });
      return req;
    }
  };
}

test('旧草稿事务迁移：原子写入且保留旧键，重复启动不重复导入', async () => {
  const idb = createMockIDB();
  let tick = 1000;
  let seq = 0;
  const store = lib.createStore({
    indexedDB: idb,
    now: () => (tick += 100),
    randomId: () => `work-${++seq}`,
  });

  const legacy = app.defaultState();
  legacy.seed = '旧草稿🐱';
  legacy.drawingSeed = '旧发型🌱';
  legacy.slots.bg = 'rays';
  legacy.slots.hair = 'bob';
  legacy.locks.hair = true;
  legacy.view = 'bust';
  const rawDraft = JSON.stringify({ v: 1, state: app.persistableState(app.sanitizeState(legacy)) });
  const storage = memoryStorage(rawDraft);

  const first = await store.migrateLegacyDraft(storage);
  assert.equal(first.ok, true);
  assert.equal(first.migrated, true);
  assert.equal(first.work.title, '旧草稿');
  assert.equal(first.work.source, 'legacy-draft');
  assert.equal(first.work.v, lib.STORAGE_VERSION);
  assert.equal(first.work.rev, 1);
  assert.equal(first.work.currentIndex, 0);
  assert.equal(first.work.snapshots.length, 1);
  assert.equal(first.work.snapshots[0].state.drawingSeed, '旧发型🌱');
  assert.equal(first.work.snapshots[0].state.slots.bg, 'rays');
  assert.equal(first.work.snapshots[0].state.locks.hair, true);
  assert.equal(app.render(lib.currentStateOf(first.work)), app.render(app.sanitizeState(legacy)));

  // 保留旧键以支持回退
  assert.equal(storage.raw.get(app.DRAFT_KEY), rawDraft);
  assert.equal(storage.calls.set, 0);
  assert.equal(storage.calls.remove, 0);

  // 重复启动不会重复导入
  const second = await store.migrateLegacyDraft(storage);
  assert.equal(second.ok, true);
  assert.equal(second.migrated, false);
  assert.equal(second.alreadyDone, true);

  const listed = await store.listWorks();
  assert.equal(listed.ok, true);
  assert.equal(listed.works.length, 1);
  assert.equal(listed.activeWorkId, first.work.id);
});

test('旧草稿迁移事务失败原子回滚、仍可读取原草稿，重试只生成一份旧草稿', async () => {
  let failMetaWrite = true;
  const idb = createMockIDB({
    onPut(storeName, value, { makeQuotaError }) {
      // 模拟作品写入后、迁移标记写入时发生配额不足，验证同一事务回滚
      if (failMetaWrite && storeName === lib.STORE_META && value.key === lib.META_MIGRATION) {
        throw makeQuotaError();
      }
    }
  });
  let tick = 2000;
  let seq = 0;
  const store = lib.createStore({
    indexedDB: idb,
    now: () => (tick += 100),
    randomId: () => `retry-${++seq}`,
  });

  const legacy = app.randomize(app.defaultState(), '迁移重试🎨');
  legacy.drawingSeed = '重试线稿🐱';
  const rawDraft = JSON.stringify({ v: 1, state: app.persistableState(legacy) });
  const storage = memoryStorage(rawDraft);

  const failed = await store.migrateLegacyDraft(storage);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'quota');
  assert.ok(failed.fallbackDraft);
  assert.equal(failed.fallbackDraft.drawingSeed, '重试线稿🐱');
  assert.equal(app.render(failed.fallbackDraft), app.render(legacy));

  // 事务必须回滚：works 和 meta 都为空，无孤立作品
  const afterFail = await store.listWorks();
  assert.equal(afterFail.ok, true);
  assert.equal(afterFail.works.length, 0);

  // 恢复后重试：只导入一份旧草稿
  failMetaWrite = false;
  const retried = await store.migrateLegacyDraft(storage);
  assert.equal(retried.ok, true);
  assert.equal(retried.migrated, true);

  const third = await store.migrateLegacyDraft(storage);
  assert.equal(third.migrated, false);
  assert.equal(third.alreadyDone, true);

  const afterRetry = await store.listWorks();
  assert.equal(afterRetry.works.length, 1);
  assert.equal(afterRetry.works[0].title, '旧草稿');
  assert.equal(afterRetry.works[0].snapshots[0].state.drawingSeed, '重试线稿🐱');
});

test('空库与损坏旧草稿不建记录，不破坏旧键', async () => {
  const idb = createMockIDB();
  const store = lib.createStore({ indexedDB: idb });

  const emptyRes = await store.migrateLegacyDraft(memoryStorage());
  assert.equal(emptyRes.ok, true);
  assert.equal(emptyRes.migrated, false);
  assert.equal((await store.listWorks()).works.length, 0);

  const corruptStorage = memoryStorage('{bad-json');
  const corruptRes = await store.migrateLegacyDraft(corruptStorage);
  assert.equal(corruptRes.ok, true);
  assert.equal(corruptRes.migrated, false);
  assert.equal(corruptRes.draftError, 'corrupt');
  assert.equal(corruptStorage.raw.get(app.DRAFT_KEY), '{bad-json');
  assert.equal((await store.listWorks()).works.length, 0);
});

test('新建作品与连续编辑保留第零步和当前快照，跳过重复快照并按更新时间排序', async () => {
  const idb = createMockIDB();
  let tick = 5000;
  let seq = 0;
  const store = lib.createStore({
    indexedDB: idb,
    now: () => (tick += 1000),
    randomId: () => `w-${++seq}`,
  });

  const baseA = app.defaultState();
  const editA1 = app.selectSlot(baseA, 'hair', 'bob');
  const createdA = await store.createWork({
    source: 'editor',
    baseState: baseA,
    baseLabel: '初始形象',
    currentState: editA1,
    currentLabel: '选择部件',
  });
  assert.equal(createdA.ok, true);
  assert.equal(createdA.work.title, '作品 1');
  assert.equal(createdA.work.rev, 1);
  assert.equal(createdA.work.currentIndex, 1);
  assert.equal(createdA.work.snapshots.length, 2);
  assert.equal(createdA.work.snapshots[0].state.slots.hair, 'cloud');
  assert.equal(createdA.work.snapshots[1].state.slots.hair, 'bob');

  // 重复快照跳过，不增修订号
  const dup = await store.saveWorkEdit({
    id: createdA.work.id,
    expectedRev: 1,
    nextState: editA1,
    label: '重复',
  });
  assert.equal(dup.ok, true);
  assert.equal(dup.skipped, true);
  assert.equal(dup.work.rev, 1);

  // 再次编辑：保留第零步，更新当前快照（第一阶段最多保留第零步与当前快照）
  const editA2 = app.selectSlot(editA1, 'eyes', 'wink');
  const savedA2 = await store.saveWorkEdit({
    id: createdA.work.id,
    expectedRev: 1,
    nextState: editA2,
    label: '选择部件',
  });
  assert.equal(savedA2.ok, true);
  assert.equal(savedA2.work.rev, 2);
  assert.equal(savedA2.work.snapshots.length, 2);
  assert.equal(savedA2.work.snapshots[0].state.slots.hair, 'cloud');
  assert.equal(savedA2.work.snapshots[0].state.slots.eyes, 'round');
  assert.equal(savedA2.work.snapshots[1].state.slots.hair, 'bob');
  assert.equal(savedA2.work.snapshots[1].state.slots.eyes, 'wink');

  // 分享预览另存（无修改）：仅第零步，currentIndex=0
  const shareB = app.randomize(app.defaultState(), '分享B🎨');
  const createdB = await store.createWork({
    source: 'share',
    baseState: shareB,
    baseLabel: '分享原稿',
  });
  assert.equal(createdB.ok, true);
  assert.equal(createdB.work.title, '作品 2');
  assert.equal(createdB.work.snapshots.length, 1);
  assert.equal(createdB.work.currentIndex, 0);

  // 列表按最近编辑倒序：B 在 A 前
  const listed = await store.listWorks();
  assert.deepEqual(plain(listed.works.map(w => w.id)), [createdB.work.id, createdA.work.id]);
  assert.equal(listed.activeWorkId, createdB.work.id);

  // 重命名 A 并切回 A
  const renamed = await store.renameWork({ id: createdA.work.id, expectedRev: 2, title: '  春日头像  ' });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.work.title, '春日头像');
  assert.equal(renamed.work.rev, 3);
  const switched = await store.setActiveWork(createdA.work.id);
  assert.equal(switched.ok, true);
  assert.equal((await store.listWorks()).activeWorkId, createdA.work.id);
});

test('跨标签页修订号冲突：拒绝旧修订覆盖，支持保存副本与重新载入新版', async () => {
  const sharedIDB = createMockIDB();
  let tick = 10000;
  let seq = 0;
  const tab1 = lib.createStore({ indexedDB: sharedIDB, now: () => (tick += 100), randomId: () => `t1-${++seq}` });
  const tab2 = lib.createStore({ indexedDB: sharedIDB, now: () => (tick += 100), randomId: () => `t2-${++seq}` });

  const base = app.defaultState();
  const created = await tab1.createWork({
    title: '协作测试',
    source: 'editor',
    baseState: base,
    currentState: app.selectSlot(base, 'hair', 'curly'),
  });
  assert.equal(created.ok, true);
  const workId = created.work.id;

  // 两个标签页均持有 rev=1
  const loadedByTab2 = await tab2.getWork(workId);
  assert.equal(loadedByTab2.work.rev, 1);

  // 标签页 2 先保存 -> rev=2
  const tab2State = app.selectSlot(lib.currentStateOf(loadedByTab2.work), 'topper', 'dog');
  const tab2Saved = await tab2.saveWorkEdit({
    id: workId,
    expectedRev: 1,
    nextState: tab2State,
    label: '标签2修改',
  });
  assert.equal(tab2Saved.ok, true);
  assert.equal(tab2Saved.work.rev, 2);

  // 标签页 1 拿旧 rev=1 保存 -> 必须触发冲突且不覆盖标签页 2
  const tab1State = app.selectSlot(lib.currentStateOf(created.work), 'topper', 'bird');
  const conflictRes = await tab1.saveWorkEdit({
    id: workId,
    expectedRev: 1,
    nextState: tab1State,
    label: '标签1修改',
  });
  assert.equal(conflictRes.ok, false);
  assert.equal(conflictRes.reason, 'conflict');
  assert.equal(conflictRes.latest.rev, 2);
  assert.equal(conflictRes.latest.snapshots[1].state.slots.topper, 'dog');

  // 标签页 1 拿旧 rev=1 重命名也必须拦截
  const renameConflict = await tab1.renameWork({ id: workId, expectedRev: 1, title: '旧标签改名' });
  assert.equal(renameConflict.ok, false);
  assert.equal(renameConflict.reason, 'conflict');

  // 确认库中仍是标签页 2 的版本
  const latestInDb = await tab1.getWork(workId);
  assert.equal(latestInDb.work.rev, 2);
  assert.equal(latestInDb.work.snapshots[1].state.slots.topper, 'dog');

  // 标签页 1 选择保存为副本：保留原第零步且不覆盖原作品
  const copy = await tab1.createWork({
    copyFromTitle: created.work.title,
    source: 'duplicate',
    baseState: lib.stepZeroStateOf(created.work),
    currentState: tab1State,
    currentLabel: '保存为副本',
  });
  assert.equal(copy.ok, true);
  assert.equal(copy.work.title, '协作测试（副本）');
  assert.equal(copy.work.snapshots[0].state.slots.hair, 'cloud');
  assert.equal(copy.work.snapshots[1].state.slots.topper, 'bird');

  const allWorks = await tab1.listWorks();
  assert.equal(allWorks.works.length, 2);
  const originalStillIntact = allWorks.works.find(w => w.id === workId);
  assert.equal(originalStillIntact.snapshots[1].state.slots.topper, 'dog');
});

test('存储不可用、配额不足与未来版本记录不破坏既有数据和渲染', async () => {
  // 1. IndexedDB 不可用
  const noIdb = lib.createStore({ indexedDB: null });
  const unavail = await noIdb.listWorks();
  assert.equal(unavail.ok, false);
  assert.equal(unavail.reason, 'unavailable');

  // 2. 写入中途配额不足：保留上次成功保存的版本
  let quotaFull = false;
  const idb = createMockIDB({
    onPut(storeName, _value, { makeQuotaError }) {
      if (quotaFull && storeName === lib.STORE_WORKS) throw makeQuotaError();
    }
  });
  const store = lib.createStore({ indexedDB: idb, randomId: () => 'quota-work' });
  const base = app.defaultState();
  const v1State = app.selectSlot(base, 'mouth', 'cat');
  const created = await store.createWork({ baseState: base, currentState: v1State });
  assert.equal(created.ok, true);

  quotaFull = true;
  const v2State = app.selectSlot(v1State, 'eyes', 'shades');
  const failedSave = await store.saveWorkEdit({ id: 'quota-work', expectedRev: 1, nextState: v2State });
  assert.equal(failedSave.ok, false);
  assert.equal(failedSave.reason, 'quota');

  // 上次成功保存的版本必须完整保留
  quotaFull = false;
  const intact = await store.getWork('quota-work');
  assert.equal(intact.work.rev, 1);
  assert.equal(intact.work.snapshots[1].state.slots.mouth, 'cat');
  assert.equal(intact.work.snapshots[1].state.slots.eyes, 'round');

  // 3. 未来存储版本安全跳过，不影响当前版本记录
  idb.dbs.get(lib.DB_NAME).stores.get(lib.STORE_WORKS).records.set('future-1', {
    v: 99,
    id: 'future-1',
    title: '未来版本',
    createdAt: 1,
    updatedAt: 999999,
    rev: 1,
    currentIndex: 0,
    snapshots: [{ state: app.persistableState(base), label: 'future', at: 1 }],
  });
  const listed = await store.listWorks();
  assert.equal(listed.ok, true);
  assert.equal(listed.skippedFuture, true);
  assert.equal(listed.works.length, 1);
  assert.equal(listed.works[0].id, 'quota-work');
});

test('改回第零步同值时收束为单步且 currentIndex=0，不写入重复快照', async () => {
  const idb = createMockIDB();
  let tick = 20000;
  const store = lib.createStore({ indexedDB: idb, now: () => (tick += 100), randomId: () => 'dedup-work' });

  const step0 = app.defaultState();
  const edited = app.sanitizeState(step0);
  edited.params.volume = 1.24;
  const created = await store.createWork({
    baseState: step0,
    baseLabel: '初始形象',
    currentState: edited,
    currentLabel: '调整形状',
  });
  assert.equal(created.ok, true);
  assert.equal(created.work.snapshots.length, 2);
  assert.equal(created.work.currentIndex, 1);

  // 将参数改回第零步同值
  const backToStep0 = await store.saveWorkEdit({
    id: 'dedup-work',
    expectedRev: 1,
    nextState: step0,
    label: '调整形状',
  });
  assert.equal(backToStep0.ok, true);
  assert.equal(backToStep0.work.rev, 2);
  assert.equal(backToStep0.work.snapshots.length, 1);
  assert.equal(backToStep0.work.currentIndex, 0);
  assert.equal(backToStep0.work.snapshots[0].state.params.volume, 1);

  // 再次提交同一第零步状态直接跳过
  const dupAgain = await store.saveWorkEdit({
    id: 'dedup-work',
    expectedRev: 2,
    nextState: step0,
    label: '调整形状',
  });
  assert.equal(dupAgain.ok, true);
  assert.equal(dupAgain.skipped, true);
  assert.equal(dupAgain.work.rev, 2);
});

test('待保存暂存键支持卸载前编辑回放、幂等去重、修订冲突检测，且不改动旧草稿键', async () => {
  const idb = createMockIDB();
  let tick = 30000;
  let seq = 0;
  const store = lib.createStore({ indexedDB: idb, now: () => (tick += 100), randomId: () => `rec-${++seq}` });

  const legacyRaw = JSON.stringify({ v: 1, state: app.persistableState(app.defaultState()) });
  const storage = memoryStorage(legacyRaw);

  // 1. 已有作品编辑中途卸载 -> replayPendingEdit 补落盘并清理暂存键
  const base = app.defaultState();
  const v1 = app.selectSlot(base, 'hair', 'bob');
  const created = await store.createWork({ baseState: base, currentState: v1 });
  assert.equal(created.ok, true);

  const v2 = app.sanitizeState(v1);
  v2.params.volume = 1.33;
  assert.equal(lib.writePendingEdit(storage, {
    kind: 'edit',
    workId: created.work.id,
    expectedRev: 1,
    source: 'editor',
    baseState: base,
    baseLabel: '初始形象',
    nextState: v2,
    label: '调整形状',
    at: tick,
  }), true);
  assert.ok(storage.raw.has(lib.PENDING_KEY));
  assert.equal(storage.raw.get(app.DRAFT_KEY), legacyRaw);

  const replayedEdit = await store.replayPendingEdit(storage);
  assert.equal(replayedEdit.ok, true);
  assert.equal(replayedEdit.recovered, true);
  assert.equal(replayedEdit.work.rev, 2);
  assert.equal(replayedEdit.work.snapshots[1].state.params.volume, 1.33);
  assert.equal(storage.raw.has(lib.PENDING_KEY), false);
  assert.equal(storage.raw.get(app.DRAFT_KEY), legacyRaw);

  // 2. 幂等：若 IDB 已落盘同状态，回放不增 rev 并清理暂存键
  lib.writePendingEdit(storage, {
    kind: 'edit',
    workId: created.work.id,
    expectedRev: 1,
    source: 'editor',
    baseState: base,
    baseLabel: '初始形象',
    nextState: v2,
    label: '调整形状',
    at: tick,
  });
  const idem = await store.replayPendingEdit(storage);
  assert.equal(idem.ok, true);
  assert.equal(idem.recovered, false);
  assert.equal(idem.work.rev, 2);
  assert.equal(storage.raw.has(lib.PENDING_KEY), false);

  // 3. 冲突：另一标签已前进到 rev=2 且内容不同，旧 rev=1 暂存绝不覆盖
  const stale = app.sanitizeState(v1);
  stale.params.volume = 0.78;
  lib.writePendingEdit(storage, {
    kind: 'edit',
    workId: created.work.id,
    expectedRev: 1,
    source: 'editor',
    baseState: base,
    baseLabel: '初始形象',
    nextState: stale,
    label: '旧标签编辑',
    at: tick,
  });
  const conflicted = await store.replayPendingEdit(storage);
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.reason, 'conflict');
  assert.equal(conflicted.latest.rev, 2);
  assert.equal(conflicted.latest.snapshots[1].state.params.volume, 1.33);
  lib.clearPendingEdit(storage);

  // 4. 新建作品中途卸载（含确定性 workId）-> 回放建档，且已建档时不重复建
  const shareBase = app.randomize(app.defaultState(), '未落盘分享🎨');
  const shareEdited = app.selectSlot(shareBase, 'eyes', 'wink');
  lib.writePendingEdit(storage, {
    tabId: 'tab-share-1',
    kind: 'create',
    workId: 'det-share-work-1',
    source: 'share',
    baseState: shareBase,
    baseLabel: '分享原稿',
    nextState: shareEdited,
    label: '选择部件',
    at: tick,
  });
  const replayedCreate = await store.replayPendingEdit(storage, 'tab-share-1');
  assert.equal(replayedCreate.ok, true);
  assert.equal(replayedCreate.recovered, true);
  assert.equal(replayedCreate.work.id, 'det-share-work-1');
  assert.equal(replayedCreate.work.snapshots[0].state.seed, '未落盘分享🎨');
  assert.equal(replayedCreate.work.snapshots[1].state.slots.eyes, 'wink');

  // 重复回放同一 workId 不产生副本（即使时间前进超过窗口）
  lib.writePendingEdit(storage, {
    tabId: 'tab-share-1',
    kind: 'create',
    workId: 'det-share-work-1',
    source: 'share',
    baseState: shareBase,
    baseLabel: '分享原稿',
    nextState: shareEdited,
    label: '选择部件',
    at: tick + 60000,
  });
  const dupCreate = await store.replayPendingEdit(storage, 'tab-share-1');
  assert.equal(dupCreate.ok, true);
  assert.equal(dupCreate.recovered, false);
  assert.equal((await store.listWorks()).works.length, 2);

  // 5. 多标签归属隔离：标签 B 清理自身记录不误删标签 A 的待保存记录
  lib.writePendingEdit(storage, {
    tabId: 'tab-A',
    kind: 'edit',
    workId: created.work.id,
    expectedRev: 2,
    source: 'editor',
    baseState: base,
    nextState: app.selectSlot(v2, 'mouth', 'cat'),
    label: '标签A编辑',
    at: tick + 100,
  });
  lib.writePendingEdit(storage, {
    tabId: 'tab-B',
    kind: 'edit',
    workId: 'det-share-work-1',
    expectedRev: 1,
    source: 'share',
    baseState: shareBase,
    nextState: app.selectSlot(shareEdited, 'topper', 'dog'),
    label: '标签B编辑',
    at: tick + 200,
  });
  lib.clearPendingEdit(storage, 'tab-B', tick + 250);
  const stillTabA = lib.readPendingEdit(storage, 'tab-A', tick + 300);
  assert.ok(stillTabA);
  assert.equal(stillTabA.tabId, 'tab-A');
  assert.equal(stillTabA.nextState.slots.mouth, 'cat');
  lib.clearPendingEdit(storage, 'tab-A', tick + 350);
  assert.equal(storage.raw.has(lib.PENDING_KEY), false);
});

test('R1 显式分享另存后立即刷新：已提交未回调与未提交均按确定 workId 接管，不猜测历史独立导入', async () => {
  const idb = createMockIDB();
  let tick = 40000;
  let seq = 0;
  const store = lib.createStore({ indexedDB: idb, now: () => (tick += 100), randomId: () => `r1-${++seq}` });
  const storage = memoryStorage();

  const shareBase = app.randomize(app.defaultState(), 'R1分享原稿🎨');
  const otherShare = app.randomize(app.defaultState(), '另一份分享🌱');
  const sharePreview = { kind: 'share', baseState: app.persistableState(shareBase) };
  const otherPreview = { kind: 'share', baseState: app.persistableState(otherShare) };

  // 1. 事务已提交但 UI 回调未执行（暂存仍存在，workId 已落库）
  const preCommitted = await store.createWork({
    id: 'share-save-op-1',
    source: 'share',
    baseState: shareBase,
    baseLabel: '分享原稿',
    currentState: null,
    setActive: true,
  });
  assert.equal(preCommitted.ok, true);
  lib.writePendingEdit(storage, {
    tabId: 'tab-r1',
    kind: 'create',
    workId: 'share-save-op-1',
    source: 'share',
    baseState: shareBase,
    baseLabel: '分享原稿',
    nextState: shareBase,
    label: '分享原稿',
    explicitCreate: true,
    at: tick,
  });

  const replayCommitted = await store.replayPendingEdit(storage, 'tab-r1');
  assert.equal(replayCommitted.ok, true);
  assert.equal(replayCommitted.recovered, false);
  assert.equal(replayCommitted.committedBeforeUnload, true);
  assert.equal(replayCommitted.work.id, 'share-save-op-1');
  assert.equal(storage.raw.has(lib.PENDING_KEY), false);

  // 同标签同预览应接管；不同标签或不同分享预览绝不接管
  assert.equal(lib.shouldAdoptShareReplay(sharePreview, replayCommitted, 'tab-r1'), true);
  assert.equal(lib.shouldAdoptShareReplay(sharePreview, replayCommitted, 'tab-other'), false);
  assert.equal(lib.shouldAdoptShareReplay(otherPreview, replayCommitted, 'tab-r1'), false);
  assert.equal((await store.listWorks()).works.length, 1);

  // 2. 刷新后再次打开同一分享（无暂存）-> 不按内容/时间猜测接管既有作品，可再建独立作品
  const normalOpenReplay = await store.replayPendingEdit(storage, 'tab-r1');
  assert.equal(normalOpenReplay.none, true);
  assert.equal(lib.shouldAdoptShareReplay(sharePreview, normalOpenReplay, 'tab-r1'), false);

  // 3. 事务尚未提交时立即刷新 -> 回放建档为第 2 件独立作品并接管
  lib.writePendingEdit(storage, {
    tabId: 'tab-r1',
    kind: 'create',
    workId: 'share-save-op-2',
    source: 'share',
    baseState: shareBase,
    baseLabel: '分享原稿',
    nextState: shareBase,
    label: '分享原稿',
    explicitCreate: true,
    at: tick + 500,
  });
  const replayUncommitted = await store.replayPendingEdit(storage, 'tab-r1');
  assert.equal(replayUncommitted.ok, true);
  assert.equal(replayUncommitted.recovered, true);
  assert.equal(replayUncommitted.committedBeforeUnload, false);
  assert.equal(replayUncommitted.work.id, 'share-save-op-2');
  assert.equal(lib.shouldAdoptShareReplay(sharePreview, replayUncommitted, 'tab-r1'), true);
  assert.equal((await store.listWorks()).works.length, 2);
});
