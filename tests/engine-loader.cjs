'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');

function extractEngine(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  assert.equal(scripts.length, 1, '入口应恰有一个内联应用脚本；结构变化需人工检查提取边界');
  assert.equal(scripts[0][1].trim(), '', '应用脚本不应带 src 或其他属性');
  const script = scripts[0][2];
  const exportStatement = "if (typeof module !== 'undefined' && module.exports) module.exports = Engine;";
  const boundary = script.indexOf(exportStatement);
  assert.ok(boundary > 0, '未找到现有 CommonJS 导出边界');
  assert.equal(script.indexOf(exportStatement, boundary + 1), -1, 'CommonJS 导出边界必须唯一');
  assert.match(script.slice(0, boundary), /var Engine = \(function \(\) \{/);
  return script.slice(0, boundary + exportStatement.length);
}

function loadEngine(source, globals = {}) {
  const context = vm.createContext({ ...globals, module: { exports: {} } }, {
    codeGeneration: { strings: false, wasm: false }
  });
  new vm.Script(source, { filename: 'extracted-engine.js' }).runInContext(context, { timeout: 1000 });
  assert.equal(typeof context.module.exports.render, 'function', 'Engine 应导出 render');
  assert.equal(typeof context.module.exports.defaultState, 'function', 'Engine 应导出 defaultState');
  return context.module.exports;
}

module.exports = { extractEngine, loadEngine };
