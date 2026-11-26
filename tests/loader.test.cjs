'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { extractEngine, loadEngine } = require('./engine-loader.cjs');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

test('只提取并运行 CommonJS 导出之前的原引擎，不执行 UI', () => {
  const poisonedUi = html.replace('</script>', 'throw new Error("UI 不得执行");</script>');
  const source = extractEngine(poisonedUi);
  assert.doesNotMatch(source, /document|UI 不得执行/);
  const engine = loadEngine(source);
  assert.ok(engine.render(engine.defaultState()).endsWith('</svg>'));
});

test('缺失或歧义提取边界必须失败', () => {
  assert.throws(() => extractEngine(html.replace('module.exports = Engine;', 'module.exports = null;')));
  assert.throws(() => extractEngine(html + '<script></script>'));
  assert.throws(() => extractEngine(html.replace('<script>', '<script src="outside.js">')));
  const boundary = "if (typeof module !== 'undefined' && module.exports) module.exports = Engine;";
  assert.throws(() => extractEngine(html.replace(boundary, boundary + boundary)));
});

test('VM 未提供进程、文件、网络入口且禁止动态代码生成', () => {
  const source = extractEngine(html);
  const probe = 'module.exports.probe = [typeof process, typeof require, typeof fetch, typeof document];';
  assert.deepEqual(Array.from(loadEngine(source + probe).probe), ['undefined', 'undefined', 'undefined', 'undefined']);
  assert.throws(() => loadEngine(source + 'Function("return 1")();'), /Code generation from strings disallowed/);
});
