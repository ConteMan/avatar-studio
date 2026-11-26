'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { loadState } = require('./state-loader.cjs');

const { Engine: engine, AvatarState: app } = loadState(readFileSync(join(__dirname, '..', 'index.html'), 'utf8'));
const baseline = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'svg-baseline.json'), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(value).digest('hex');

function lockAll(state) {
  engine.SLOTS.forEach(slot => { state.locks[slot.key] = true; });
  state.locks.params = true;
  state.locks.colors = true;
  return state;
}

test('状态层兼容旧配置：四个固定摘要和 144 部件裁切基线不变', () => {
  for (const fixture of baseline.fixed) {
    const restored = app.sanitizeState(fixture.state);
    assert.equal(restored.drawingSeed, fixture.state.seed);
    assert.equal(digest(app.render(restored)), fixture.sha256, fixture.name);
    assert.equal(app.render(fixture.state), engine.render(fixture.state));
  }
  for (const [key, expected] of Object.entries(baseline.options)) {
    const [slot, value, view] = key.split('/');
    const state = app.defaultState();
    state.slots[slot] = value;
    state.view = view;
    assert.equal(digest(app.render(state)), expected, key);
  }
});

test('全部锁定：20 次不同种子随机和分享恢复的 SVG 逐字节一致', () => {
  let state = lockAll(app.defaultState());
  const expected = app.render(state);
  for (let index = 0; index < 20; index++) {
    state = app.randomize(state, '全锁🎨-' + index);
    assert.equal(state.seed, '全锁🎨-' + index);
    assert.equal(app.render(state), expected);
    state = app.sanitizeState(app.decodeState(app.encodeState(state)));
    assert.equal(app.render(state), expected);
  }
});

test('各槽位锁只保留自身选择，发型锁额外保留绘图种子', () => {
  for (const locked of engine.SLOTS) {
    const original = app.defaultState();
    original.locks[locked.key] = true;
    original.locks.params = true;
    original.locks.colors = true;
    for (let index = 0; index < 8; index++) {
      const seed = 'subset-' + index;
      const next = app.randomize(original, seed);
      for (const slot of engine.SLOTS) {
        assert.equal(next.slots[slot.key], slot.key === locked.key ? original.slots[slot.key] : engine.fromSeed(seed, slot.key));
      }
      assert.equal(next.drawingSeed, locked.key === 'hair' ? original.drawingSeed : seed);
      if (locked.key === 'hair') {
        const restoredSlots = { ...next, slots:original.slots };
        assert.equal(app.render(restoredSlots), app.render(original));
      }
    }
  }
});

test('参数锁与颜色锁独立，未锁参数和配色仍可影响锁定发型', () => {
  for (const paramsLocked of [false, true]) {
    for (const colorsLocked of [false, true]) {
      const original = app.defaultState();
      original.locks.hair = true;
      original.locks.params = paramsLocked;
      original.locks.colors = colorsLocked;
      original.colors.hair = '#123456';
      const next = app.randomize(original, 'independent-locks');
      assert.equal(next.slots.hair, original.slots.hair);
      assert.equal(next.drawingSeed, original.drawingSeed);
      assert.equal(JSON.stringify(next.params) === JSON.stringify(original.params), paramsLocked);
      assert.equal(JSON.stringify(next.colors) === JSON.stringify(original.colors), colorsLocked);
      const sameSlots = { ...next, slots:original.slots };
      assert.equal(app.render(sameSlots) === app.render(original), paramsLocked && colorsLocked);
    }
  }
});

test('手动点选和换一个可修改已锁槽位，并保留其它绘图输入', () => {
  const original = lockAll(app.defaultState());
  const before = JSON.stringify(original);
  let next = app.selectSlot(original, 'hair', 'bob');
  assert.equal(next.slots.hair, 'bob');
  assert.equal(next.locks.hair, true);
  assert.equal(next.drawingSeed, original.drawingSeed);
  assert.notEqual(app.render(next), app.render(original));
  for (let index = 0; index < 100; index++) {
    const previous = next;
    next = app.shuffleSlot(previous, 'hair');
    assert.notEqual(next.slots.hair, previous.slots.hair);
    assert.deepEqual(plain(next.params), plain(original.params));
    assert.deepEqual(plain(next.colors), plain(original.colors));
    assert.equal(next.drawingSeed, original.drawingSeed);
    assert.equal(next.locks.hair, true);
  }
  assert.equal(JSON.stringify(original), before);
});

test('固定种子确定性与输入不可变：同初态同锁集合一致，未锁随机有效', () => {
  const original = app.defaultState();
  const before = JSON.stringify(original);
  for (const seed of ['same-seed', '中文🐱种子', 'another-seed']) {
    const first = app.randomize(original, seed);
    const second = app.randomize(original, seed);
    assert.deepEqual(plain(first), plain(second));
    assert.equal(app.render(first), app.render(second));
    assert.notEqual(app.render(first), app.render(original));
    assert.equal(first.drawingSeed, seed);
    assert.doesNotMatch(app.render(first), /NaN|Infinity|undefined/);
  }
  assert.notEqual(app.render(app.randomize(original, 'same-seed')), app.render(app.randomize(original, 'another-seed')));
  assert.equal(JSON.stringify(original), before);
  const locked = lockAll(original);
  assert.equal(app.render(app.randomize(locked, '输入种子也守锁')), app.render(locked));
});

test('新旧分享含中文 emoji：独立绘图种子、锁和实际 SVG 完整往返', () => {
  const original = app.defaultState();
  original.seed = '抽签中文🎨';
  original.drawingSeed = '保留发型🐱';
  original.locks.hair = true;
  original.colors.hair = '#123456';
  const token = app.encodeState(original);
  const restored = app.sanitizeState(app.decodeState(token));
  assert.equal(restored.seed, original.seed);
  assert.equal(restored.drawingSeed, original.drawingSeed);
  assert.equal(restored.locks.hair, true);
  assert.equal(restored.palette, null);
  assert.equal(app.render(restored), app.render(original));
  const legacy = { ...plain(original) };
  delete legacy.drawingSeed;
  const legacyToken = Buffer.from(JSON.stringify(legacy), 'utf8').toString('base64');
  const legacyRestored = app.sanitizeState(app.decodeState(legacyToken));
  assert.equal(legacyRestored.drawingSeed, legacy.seed);
  assert.equal(app.render(legacyRestored), engine.render(legacy));
});

test('非法分享和配置安全回退，参数颜色槽位与 seed 不越界', () => {
  for (const value of [null, [], 'text', { slots:[] }, { params:[] }, { colors:[] }, { locks:[] }]) {
    assert.equal(app.sanitizeState(value), null);
  }
  for (const token of ['', '!', '%%%%', 'a'.repeat(8001), Buffer.from([0xff]).toString('base64'), Buffer.from('[]').toString('base64')]) {
    assert.equal(app.decodeState(token), null);
  }
  const result = app.sanitizeState({
    seed:'\u0000  种子🐱  ', drawingSeed:'\u0001' + '长'.repeat(300),
    slots:{ hair:'<script>', eyes:'cat' },
    params:{ volume:-999, wave:999, length:NaN, fringe:Infinity, faceW:'0.9', shoulders:1.12345 },
    colors:{ hair:'url(bad)', skin:'#ABCDEF' }, locks:{ hair:'true', colors:true, unknown:true },
    view:'invalid', palette:999
  });
  assert.equal(result.seed, '种子🐱');
  assert.equal(result.drawingSeed.length, 160);
  assert.equal(result.slots.hair, 'cloud');
  assert.equal(result.slots.eyes, 'round');
  assert.deepEqual(plain(result.params), { volume:0.72, wave:1, length:0.35, fringe:0.35, faceW:1, shoulders:1.12 });
  assert.equal(result.colors.hair, '#a9322b');
  assert.equal(result.colors.skin, '#abcdef');
  assert.deepEqual(plain(result.locks), { colors:true });
  assert.equal(result.view, 'half');
  assert.equal(app.sanitizeState({ seed:'后备', drawingSeed:42 }).drawingSeed, '后备');
  assert.doesNotMatch(app.render(result), /NaN|Infinity|undefined/);
});

test('配色匹配依据全部最终颜色，手调离开预设再恢复会重新选中', () => {
  for (let index = 0; index < engine.PALETTES.length; index++) {
    const state = app.applyPalette(app.defaultState(), index);
    assert.equal(app.sanitizeState(state).palette, index);
    const expected = state.colors.skin;
    state.colors.skin = '#123456';
    assert.equal(app.sanitizeState(state).palette, null);
    state.colors.skin = expected;
    assert.equal(app.sanitizeState(state).palette, index);
  }
});

function memoryStorage(initial) {
  const calls = { get:0, set:0, remove:0 };
  const data = new Map();
  if (initial !== undefined) data.set(app.DRAFT_KEY, initial);
  return {
    calls,
    getItem(key) { calls.get += 1; return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { calls.set += 1; data.set(key, String(value)); },
    removeItem(key) { calls.remove += 1; data.delete(key); },
  };
}

function tokenFor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

test('分享优先于草稿，首次打开不读写本地存储', () => {
  const draft = app.defaultState();
  draft.seed = '草稿🐱';
  draft.drawingSeed = '线稿🌱';
  draft.view = 'bust';
  draft.locks.params = true;
  draft.slots.hair = 'bob';
  const stored = app.sanitizeState(draft);
  const storage = memoryStorage(JSON.stringify({ v:1, state:stored }));
  const share = app.defaultState();
  share.seed = '分享🎨';
  share.drawingSeed = '分享发型🐱';
  const search = '?s=' + encodeURIComponent(app.encodeState(share));
  const opened = app.resolveInitial(search, storage);
  assert.equal(opened.source, 'share');
  assert.equal(opened.state.seed, '分享🎨');
  assert.equal(opened.state.drawingSeed, '分享发型🐱');
  assert.equal(app.render(opened.state), app.render(app.sanitizeState(share)));
  assert.notEqual(app.render(opened.state), app.render(stored));
  assert.deepEqual(storage.calls, { get:0, set:0, remove:0 });
  const saved = app.saveDraft(storage, opened.state);
  assert.equal(saved.ok, true);
  assert.equal(storage.calls.set, 1);
  assert.equal(app.readDraft(storage).state.seed, '分享🎨');
  assert.equal(app.readDraft(storage).state.drawingSeed, '分享发型🐱');
});

test('无分享时恢复草稿，没有草稿时用默认，编辑后保存最终值', () => {
  const empty = memoryStorage();
  const fresh = app.resolveInitial('', empty);
  assert.equal(fresh.source, 'default');
  assert.equal(fresh.notice, undefined);
  assert.equal(empty.calls.set, 0);
  assert.equal(app.render(fresh.state), app.render(app.defaultState()));
  const edited = app.randomize(fresh.state, '编辑后🐱');
  edited.drawingSeed = '单独绘图🌱';
  edited.view = 'head';
  edited.locks.hair = true;
  edited.slots.eyes = 'wink';
  edited.colors.hair = '#123456';
  edited.params.wave = 0.25;
  const saved = app.saveDraft(empty, edited);
  assert.equal(saved.ok, true);
  const again = app.resolveInitial('?kept=1', empty);
  assert.equal(again.source, 'draft');
  assert.equal(again.state.seed, '编辑后🐱');
  assert.equal(again.state.drawingSeed, '单独绘图🌱');
  assert.equal(again.state.view, 'head');
  assert.equal(again.state.locks.hair, true);
  assert.equal(again.state.slots.eyes, 'wink');
  assert.equal(again.state.colors.hair, '#123456');
  assert.equal(again.state.params.wave, 0.25);
  assert.equal(app.render(again.state), app.render(app.sanitizeState(edited)));
  const wire = JSON.parse(empty.getItem(app.DRAFT_KEY));
  assert.equal(wire.v, app.FORMAT_VERSION);
});

test('旧分享、新分享、未来版本和非法分享的优先级与同一 SVG', () => {
  const picture = app.defaultState();
  picture.seed = '抽签中文🎨';
  picture.drawingSeed = '保留发型🐱';
  picture.locks.hair = true;
  picture.colors.hair = '#123456';
  const normalized = app.sanitizeState(picture);
  const storage = memoryStorage(JSON.stringify({ v:1, state:{ seed:'不应读到的草稿' } }));
  const versioned = app.resolveInitial('?s=' + encodeURIComponent(app.encodeState(normalized)), storage);
  const legacyToken = Buffer.from(JSON.stringify(plain(normalized)), 'utf8').toString('base64');
  const legacy = app.resolveInitial('?s=' + encodeURIComponent(legacyToken), storage);
  assert.equal(versioned.source, 'share');
  assert.equal(legacy.source, 'legacy-share');
  assert.equal(app.render(versioned.state), app.render(normalized));
  assert.equal(app.render(legacy.state), app.render(normalized));
  assert.equal(app.render(legacy.state), app.render(versioned.state));
  assert.equal(versioned.state.drawingSeed, '保留发型🐱');
  assert.equal(legacy.state.drawingSeed, '保留发型🐱');
  const payload = JSON.parse(Buffer.from(app.encodeState(normalized), 'base64url').toString('utf8'));
  assert.equal(payload.v, 1);
  assert.equal(payload.state.seed, normalized.seed);
  const future = app.resolveInitial('?s=' + tokenFor({ v:2, state:plain(normalized) }), storage);
  assert.equal(future.source, 'default');
  assert.match(future.notice, /分享版本无法识别/);
  assert.equal(app.render(future.state), app.render(app.defaultState()));
  for (const search of ['?s=', '?s', '?s=&other=1', '?s=%', '?s=' + tokenFor({ v:1 }), '?s=' + 'a'.repeat(8001)]) {
    const rejected = app.resolveInitial(search, storage);
    assert.equal(rejected.source, 'default', search);
    assert.match(rejected.notice, /链接无效/, search);
    assert.equal(app.render(rejected.state), app.render(app.defaultState()));
  }
  assert.deepEqual(storage.calls, { get:0, set:0, remove:0 });
});

test('损坏、不可用和满额存储不阻断规范化、分享或渲染', () => {
  const broken = memoryStorage('{');
  const corrupt = app.resolveInitial('', broken);
  assert.equal(corrupt.source, 'default');
  assert.match(corrupt.notice, /草稿已损坏/);
  const futureDraft = memoryStorage(JSON.stringify({ v:9, state:app.defaultState() }));
  const unknown = app.resolveInitial('?', futureDraft);
  assert.equal(unknown.source, 'default');
  assert.match(unknown.notice, /草稿版本无法识别/);
  const disabled = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  const unavailable = app.resolveInitial('', disabled);
  assert.equal(unavailable.source, 'default');
  assert.match(unavailable.notice, /本地存储不可用/);
  const quota = {
    getItem() { return null; },
    setItem() {
      const error = new Error('full');
      error.name = 'QuotaExceededError';
      error.code = 22;
      throw error;
    },
  };
  const edited = app.randomize(app.defaultState(), '仍可导出🐱');
  const failed = app.saveDraft(quota, edited);
  assert.equal(failed.reason, 'quota');
  const first = app.storageWriteNotice('', failed);
  const second = app.storageWriteNotice(first.previous, failed);
  assert.match(first.notice, /存储空间不足/);
  assert.equal(second.notice, '');
  const denied = app.saveDraft(disabled, edited);
  const switched = app.storageWriteNotice(first.previous, denied);
  assert.match(switched.notice, /本地存储不可用/);
  const cleared = app.storageWriteNotice(switched.previous, { ok:true });
  assert.equal(cleared.notice, '');
  assert.equal(cleared.previous, '');
  assert.equal(app.render(edited), app.render(app.sanitizeState(app.decodeState(app.encodeState(edited)))));
  assert.doesNotMatch(app.render(unavailable.state), /NaN|Infinity|undefined/);
});

test('成功保存后去掉旧分享参数，刷新恢复最新草稿；失败时保留分享', () => {
  const shared = app.defaultState();
  shared.seed = '旧分享🎨';
  shared.drawingSeed = '旧发型🐱';
  shared.locks.hair = true;
  const normalized = app.sanitizeState(shared);
  const versioned = app.encodeState(normalized);
  const legacy = Buffer.from(JSON.stringify(plain(normalized)), 'utf8').toString('base64url');
  const edited = app.sanitizeState(normalized);
  edited.view = 'head';
  edited.slots.hair = 'bun';
  edited.drawingSeed = '新发型🌱';
  edited.locks.hair = true;
  const storage = memoryStorage();
  assert.equal(app.saveDraft(storage, edited).ok, true);

  for (const token of [versioned, legacy]) {
    const search = '?from=mail&s=' + encodeURIComponent(token) + '&s=' + encodeURIComponent(token) + '&tab=1';
    const held = app.searchAfterEdit(search, { ok:false, reason:'quota' });
    assert.equal(held, search);
    const stillShared = app.resolveInitial(held, storage);
    assert.notEqual(stillShared.source, 'draft');
    assert.equal(stillShared.state.drawingSeed, '旧发型🐱');
    assert.equal(storage.calls.remove, 0);
    const cleared = app.searchAfterEdit(search, { ok:true });
    assert.equal(cleared, '?from=mail&tab=1');
    assert.equal(app.shareParam(cleared).present, false);
    const restored = app.resolveInitial(cleared, storage);
    assert.equal(restored.source, 'draft');
    assert.equal(restored.state.seed, normalized.seed);
    assert.equal(restored.state.drawingSeed, '新发型🌱');
    assert.equal(restored.state.view, 'head');
    assert.equal(restored.state.slots.hair, 'bun');
    assert.equal(restored.state.locks.hair, true);
    assert.equal(app.render(restored.state), app.render(edited));
    assert.deepEqual(plain(restored.state), plain(app.sanitizeState(edited)));
  }
  assert.equal(app.locationWithoutShare('/index.html', '?s=one&keep=1&s=two', '#panel'), '/index.html?keep=1#panel');
  assert.equal(app.locationWithoutShare('/index.html', '?s=only', ''), '/index.html');
  assert.equal(app.locationWithoutShare('/', '?%73=abc&ok=1', ''), '/?ok=1');
  assert.equal(storage.calls.set, 1);
});

test('无分享编辑、显式分享后再编辑，直接刷新读到第二次；复制本身不改链接', () => {
  const storage = memoryStorage();
  const first = app.randomize(app.defaultState(), '第一次🐱');
  assert.equal(app.saveDraft(storage, first).ok, true);
  let search = app.searchAfterEdit('', { ok:true });
  assert.equal(search, '');
  const token = app.encodeState(first);
  search = '?s=' + encodeURIComponent(token) + '&s=' + encodeURIComponent(token);
  assert.equal(app.readDraft(storage).state.seed, '第一次🐱');
  assert.equal(app.searchAfterEdit(search, null), search);
  const second = app.sanitizeState(first);
  second.view = 'bust';
  second.seed = '第二次🌱';
  second.drawingSeed = '第二次绘图🐱';
  assert.equal(app.saveDraft(storage, second).ok, true);
  search = app.searchAfterEdit(search, { ok:true });
  assert.equal(search, '');
  const restored = app.resolveInitial(search, storage);
  assert.equal(restored.source, 'draft');
  assert.equal(restored.state.seed, '第二次🌱');
  assert.equal(restored.state.drawingSeed, '第二次绘图🐱');
  assert.equal(restored.state.view, 'bust');
  assert.equal(app.render(restored.state), app.render(second));
});

test('首次打开分享不清理参数也不改草稿；存储失败保留全部 s', () => {
  const edited = app.defaultState();
  edited.seed = '页面编辑';
  const older = app.defaultState();
  older.seed = '更旧草稿';
  const storage = memoryStorage(JSON.stringify({ v:1, state:app.sanitizeState(older) }));
  const token = app.encodeState(app.defaultState());
  const search = '?s=' + encodeURIComponent(token) + '&s=second&keep=1';
  const opened = app.resolveInitial(search, storage);
  assert.equal(opened.source, 'share');
  assert.equal(app.shareParam(search).present, true);
  assert.deepEqual(storage.calls, { get:0, set:0, remove:0 });
  assert.equal(app.searchAfterEdit(search, { ok:false, reason:'unavailable' }), search);
  const quota = {
    getItem(key) { return storage.getItem(key); },
    setItem() {
      const error = new Error('full');
      error.name = 'QuotaExceededError';
      error.code = 22;
      throw error;
    },
    removeItem() { throw new Error('should not clear'); },
  };
  const failed = app.saveDraft(quota, edited);
  assert.equal(failed.reason, 'quota');
  assert.equal(app.searchAfterEdit(search, failed), search);
  const reloaded = app.resolveInitial(app.searchAfterEdit(search, failed), quota);
  assert.equal(reloaded.source, 'share');
  assert.notEqual(reloaded.state.seed, '更旧草稿');
  const denied = app.saveDraft({
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  }, edited);
  assert.equal(denied.reason, 'unavailable');
  assert.equal(app.searchAfterEdit('?s=a&s=b', denied), '?s=a&s=b');
  const firstNotice = app.historyClearNotice('', { ok:false });
  const secondNotice = app.historyClearNotice(firstNotice.previous, { ok:false });
  assert.match(firstNotice.notice, /草稿已保存/);
  assert.match(firstNotice.notice, /旧分享/);
  assert.match(firstNotice.notice, /刷新/);
  assert.equal(secondNotice.notice, '');
  assert.equal(app.historyClearNotice(secondNotice.previous, { ok:true }).previous, '');
});

test('显式分享把 s 放在查询串，hash 留在后面', () => {
  const picture = app.defaultState();
  picture.seed = '要分享的头像🐈';
  picture.drawingSeed = '分享发型🌱';
  picture.view = 'head';
  picture.locks.hair = true;
  const normalized = app.sanitizeState(picture);
  const token = app.encodeState(normalized);
  const encoded = encodeURIComponent(token);
  assert.equal(app.shareLocation('/index.html', '', '#panel', token), '/index.html?s=' + encoded + '#panel');
  assert.equal(app.shareLocation('/index.html', '', '', token), '/index.html?s=' + encoded);
  assert.equal(
    app.shareLocation('/index.html', '?from=mail&tab=1', '#panel', token),
    '/index.html?from=mail&tab=1&s=' + encoded + '#panel'
  );
  assert.equal(
    app.shareLocation('/index.html', '?s=old&%73=again&keep=1', '#panel?x=1', token),
    '/index.html?keep=1&s=' + encoded + '#panel?x=1'
  );
  const tricky = app.shareLocation('/index.html', '?s=' + encoded, '#panel?s=fake', token);
  const query = tricky.slice(tricky.indexOf('?'), tricky.indexOf('#'));
  assert.equal(query.indexOf('s='), query.lastIndexOf('s='));
  assert.equal(tricky.endsWith('#panel?s=fake'), true);
  assert.equal(app.shareParam(query).present, true);
  const unrelated = memoryStorage(JSON.stringify({
    v: 1,
    state: app.sanitizeState(Object.assign(app.defaultState(), { seed: '收件人的无关草稿🌱' }))
  }));
  const opened = app.resolveInitial(query, unrelated);
  assert.equal(opened.source, 'share');
  assert.equal(opened.state.seed, '要分享的头像🐈');
  assert.equal(opened.state.drawingSeed, '分享发型🌱');
  assert.equal(opened.state.view, 'head');
  assert.equal(opened.state.locks.hair, true);
  assert.equal(app.render(opened.state), app.render(normalized));
  assert.equal(unrelated.calls.get, 0);
  const afterClear = app.searchAfterEdit('?s=' + encoded, { ok: true });
  assert.equal(afterClear, '');
  const again = app.shareLocation('/index.html', afterClear, '#panel', token);
  assert.equal(again, '/index.html?s=' + encoded + '#panel');
});

test('UI 标签按槽位区分 dots 和 cat，Engine 接口原值保持', () => {
  assert.equal(app.labelFor('bg', 'dots'), '圆点');
  assert.equal(app.labelFor('eyes', 'dots'), '点眼');
  assert.equal(app.labelFor('mouth', 'cat'), '猫嘴');
  assert.equal(app.labelFor('topper', 'cat'), '黑猫');
  assert.equal(engine.LABELS.dots, '点眼');
  assert.equal(engine.LABELS.cat, '黑猫');
});
