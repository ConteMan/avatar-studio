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

test('UI 标签按槽位区分 dots 和 cat，Engine 接口原值保持', () => {
  assert.equal(app.labelFor('bg', 'dots'), '圆点');
  assert.equal(app.labelFor('eyes', 'dots'), '点眼');
  assert.equal(app.labelFor('mouth', 'cat'), '猫嘴');
  assert.equal(app.labelFor('topper', 'cat'), '黑猫');
  assert.equal(engine.LABELS.dots, '点眼');
  assert.equal(engine.LABELS.cat, '黑猫');
});
