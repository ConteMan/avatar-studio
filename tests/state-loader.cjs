'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');

function loadState(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0][1].trim(), '');
  const source = scripts[0][2];
  const boundary = "if (typeof document !== 'undefined') (function () {";
  assert.equal(source.split(boundary).length, 2, '状态层与 UI 的边界必须唯一');
  const context = vm.createContext({ module: { exports: {} }, TextEncoder, TextDecoder, atob, btoa }, {
    codeGeneration: { strings: false, wasm: false }
  });
  new vm.Script(source.slice(0, source.indexOf(boundary)) + '\nmodule.exports = { Engine, AvatarState, Export, WorkLibrary: typeof WorkLibrary !== "undefined" ? WorkLibrary : undefined };')
    .runInContext(context, { timeout: 1000 });
  assert.equal(typeof context.module.exports.AvatarState.randomize, 'function');
  assert.equal(typeof context.module.exports.Export.copyText, 'function');
  assert.equal(typeof context.module.exports.Export.exportPng, 'function');
  return context.module.exports;
}

module.exports = { loadState };
