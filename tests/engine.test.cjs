'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { extractEngine, loadEngine } = require('./engine-loader.cjs');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const source = extractEngine(html);
const engine = loadEngine(source);
const baseline = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'svg-baseline.json'), 'utf8'));
const views = { half: '0 0 600 600', bust: '60 60 480 480', head: '140 60 320 340' };
const layerOrder = ['bgLayer', 'neck', 'bodyBack', 'hairBack', 'face', 'hairMain', 'eyes', 'mouth', 'bodyFront', 'extra', 'topper'];

function digest(svg) {
  return createHash('sha256').update(svg).digest('hex');
}

function freezeDeep(value) {
  Object.values(value).forEach(child => {
    if (child && typeof child === 'object') freezeDeep(child);
  });
  return Object.freeze(value);
}

function checkedRender(state, override) {
  const before = JSON.stringify(state);
  const overrideBefore = JSON.stringify(override);
  freezeDeep(state);
  if (override) freezeDeep(override);
  const svg = engine.render(state, override);
  assert.equal(engine.render(state, override), svg, '相同输入重复渲染必须逐字节一致');
  assert.equal(JSON.stringify(state), before, 'render 不得修改输入状态');
  assert.equal(JSON.stringify(override), overrideBefore, 'render 不得修改 override');
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
  const viewBox = override?.viewBox ?? views[state.view];
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + viewBox + '" width="600" height="600">'));
  assert.ok(svg.endsWith('</svg>'));
  return svg;
}

test('固定输入 SVG SHA-256 与保存的原引擎基线一致', () => {
  assert.equal(baseline.fixed.length, 4);
  for (const fixture of baseline.fixed) {
    assert.equal(digest(checkedRender(structuredClone(fixture.state))), fixture.sha256, fixture.name);
  }
});

test('默认状态重复渲染一致且输入不可变', () => {
  const state = engine.defaultState();
  assert.equal(JSON.stringify(state), JSON.stringify(baseline.fixed[0].state));
  assert.equal(digest(checkedRender(state)), baseline.fixed[0].sha256);
});

test('48 部件选项 × 3 裁切：144 次摘要、有限数值、确定性、不可变及 override 等价检查', () => {
  assert.equal(engine.SLOTS.length, 7);
  assert.equal(engine.SLOTS.reduce((sum, slot) => sum + slot.options.length, 0), 48);
  assert.equal(engine.comboCount(), 653184);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.VIEWS)), views);
  const visited = [];
  for (const slot of engine.SLOTS) {
    for (const option of slot.options) {
      for (const [view, viewBox] of Object.entries(views)) {
        const state = engine.defaultState();
        state.slots[slot.key] = option;
        state.view = view;
        const key = [slot.key, option, view].join('/');
        const svg = checkedRender(state);
        assert.equal(digest(svg), baseline.options[key], key);
        const original = engine.defaultState();
        const override = { slot: slot.key, value: option, viewBox };
        assert.equal(checkedRender(original, override), svg, key + ' 缩略图覆盖与直接配置应等价');
        visited.push(key);
      }
    }
  }
  assert.equal(visited.length, 144);
  assert.deepEqual(visited.sort(), Object.keys(baseline.options).sort(), '固定基线必须精确覆盖所有 144 个用例');
});

test('实际绘图 11 层：调用顺序与 SVG 片段顺序一致', () => {
  const renderBoundary = '  function render(state, override) {';
  assert.equal(source.split(renderBoundary).length, 2, '测试插桩边界必须唯一');
  const calls = [];
  const wrappers = layerOrder.map(name =>
    name + ' = (function(draw) { return function(st, colors) {' +
    '__layerCalls.push("' + name + '");' +
    'return "<!--layer:' + name + '-->" + draw(st, colors); }; })(' + name + ');'
  ).join('\n');
  const traced = loadEngine(source.replace(renderBoundary, wrappers + '\n' + renderBoundary), { __layerCalls: calls });
  for (const fixture of baseline.fixed) {
    calls.length = 0;
    const state = freezeDeep(structuredClone(fixture.state));
    const svg = traced.render(state);
    assert.deepEqual(calls, layerOrder, fixture.name + ' 实际调用顺序');
    const markers = [...svg.matchAll(/<!--layer:(\w+)-->/g)].map(match => match[1]);
    assert.deepEqual(markers, layerOrder, fixture.name + ' 实际输出顺序');
    assert.equal(svg.replace(/<!--layer:\w+-->/g, ''), engine.render(state), '插桩不得改变绘图结果');
  }
});

test('Logo 母版 SHA-256 保持定稿值', () => {
  const logo = readFileSync(join(__dirname, '..', 'rounds', 'R05-2026-11-26', 'shu.svg'));
  assert.equal(digest(logo), '1376fb705bb7a10c74c2a8f6f746c93cb44313e4ddf86da3895c6b9569d4317f');
});
