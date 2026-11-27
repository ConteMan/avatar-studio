'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { loadState } = require('./state-loader.cjs');

const PROJECT_ROOT = join(__dirname, '..');
const html = readFileSync(join(PROJECT_ROOT, 'index.html'), 'utf8');
const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
const { AppVersion } = loadState(html);

function makeDoc({ metaContent = null, attrVersion = null } = {}) {
  return {
    querySelector(selector) {
      if (selector === 'meta[name="app-version"]' && metaContent !== null) {
        return { getAttribute(name) { return name === 'content' ? metaContent : null; } };
      }
      return null;
    },
    documentElement: {
      getAttribute(name) {
        return name === 'data-app-version' ? attrVersion : null;
      },
    },
  };
}

function makeVersionElement() {
  const attrs = new Map([['data-version-state', 'source']]);
  return {
    textContent: '源码预览',
    attrs,
    setAttribute(name, value) { attrs.set(name, String(value)); },
    removeAttribute(name) { attrs.delete(name); },
  };
}

test('源码入口静态默认显示源码预览且不硬编码版本号', () => {
  assert.match(html, /<span[^>]*id="aboutVersion"[^>]*data-version-state="source"[^>]*>源码预览<\/span>/);
  assert.doesNotMatch(html, /<meta\b[^>]*name=["']app-version["']/i);
  assert.doesNotMatch(html, /data-app-version\s*=/i);
});

test('版本规范化与文案格式化仅接受合法 SemVer', () => {
  assert.equal(AppVersion.normalizeVersion('0.2.0'), '0.2.0');
  assert.equal(AppVersion.normalizeVersion(' 1.2.3-rc.1+build.4 '), '1.2.3-rc.1+build.4');
  assert.equal(AppVersion.formatLabel('0.2.0'), '版本 0.2.0');
  assert.equal(AppVersion.formatLabel(null), '源码预览');

  for (const invalid of ['', '   ', 'v0.2.0', '0.2', '01.2.3', '0.2.0<script>', '0.2.0\n1', '1.' + '0'.repeat(70), 123, {}]) {
    assert.equal(AppVersion.normalizeVersion(invalid), null, `应拒绝非法版本: ${String(invalid)}`);
    assert.equal(AppVersion.formatLabel(invalid), '源码预览');
  }
});

test('extractMetaVersion 优先读取 packageVersion 并兼容轻量 version 字段', () => {
  assert.equal(AppVersion.extractMetaVersion({ packageVersion: '0.2.0', version: '0.1.0' }), '0.2.0');
  assert.equal(AppVersion.extractMetaVersion({ version: '0.2.0' }), '0.2.0');
  assert.equal(AppVersion.extractMetaVersion({ packageVersion: 'bad', version: '0.2.0' }), '0.2.0');
  assert.equal(AppVersion.extractMetaVersion({ packageVersion: 'bad' }), null);
  assert.equal(AppVersion.extractMetaVersion([]), null);
  assert.equal(AppVersion.extractMetaVersion(null), null);
});

test('内联 meta[name="app-version"] 或 data-app-version 命中时不发网络请求（含 file:// 场景）', async () => {
  let fetchCalled = 0;
  const fetchSpy = () => {
    fetchCalled += 1;
    throw new Error('should not fetch');
  };

  const byMeta = await AppVersion.resolve({
    document: makeDoc({ metaContent: pkg.version }),
    fetch: fetchSpy,
    protocol: 'file:',
  });
  assert.deepEqual({ ...byMeta }, { version: pkg.version, label: `版本 ${pkg.version}`, source: 'inline' });
  assert.equal(fetchCalled, 0);

  const byAttr = await AppVersion.resolve({
    document: makeDoc({ attrVersion: '0.2.0-beta.1' }),
    fetch: fetchSpy,
    protocol: 'file:',
  });
  assert.deepEqual({ ...byAttr }, { version: '0.2.0-beta.1', label: '版本 0.2.0-beta.1', source: 'inline' });
  assert.equal(fetchCalled, 0);
});

test('HTTP/HTTPS 真实构建读取相对路径 build-meta.json 显示版本号', async () => {
  const calls = [];
  const res = await AppVersion.resolve({
    document: makeDoc(),
    protocol: 'https:',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({ app: 'avatar-studio', packageVersion: pkg.version }),
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'build-meta.json');
  assert.deepEqual({ ...calls[0].init }, { cache: 'no-cache' });
  assert.deepEqual({ ...res }, { version: pkg.version, label: `版本 ${pkg.version}`, source: 'meta' });

  const el = makeVersionElement();
  AppVersion.applyToElement(el, res);
  assert.equal(el.textContent, `版本 ${pkg.version}`);
  assert.equal(el.attrs.get('data-version-state'), 'resolved');
  assert.equal(el.attrs.get('data-app-version'), pkg.version);
});

test('直接打开源码（file://）或版本读取异常一律安静回退为源码预览', async () => {
  let fetchCalled = 0;
  const fileRes = await AppVersion.resolve({
    document: makeDoc(),
    protocol: 'file:',
    fetch: () => {
      fetchCalled += 1;
      return Promise.reject(new Error('file scheme blocked'));
    },
  });
  assert.equal(fetchCalled, 0);
  assert.deepEqual({ ...fileRes }, { version: null, label: '源码预览', source: 'source' });

  const cases = [
    { name: '无 fetch', fetch: null },
    { name: '同步抛错', fetch: () => { throw new Error('sync fail'); } },
    { name: '网络拒绝', fetch: () => Promise.reject(new Error('network down')) },
    { name: 'HTTP 404', fetch: async () => ({ ok: false, status: 404, json: async () => ({ packageVersion: '0.2.0' }) }) },
    { name: '损坏 JSON', fetch: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }) },
    { name: '缺失版本字段', fetch: async () => ({ ok: true, json: async () => ({ app: 'avatar-studio' }) }) },
    { name: '非法版本号', fetch: async () => ({ ok: true, json: async () => ({ packageVersion: 'not-semver' }) }) },
  ];

  for (const c of cases) {
    const out = await AppVersion.resolve({
      document: makeDoc(),
      protocol: 'http:',
      fetch: c.fetch,
    });
    assert.deepEqual({ ...out }, { version: null, label: '源码预览', source: 'source' }, `场景失败: ${c.name}`);
  }

  const el = makeVersionElement();
  AppVersion.applyToElement(el, { version: '0.2.0', label: '版本 0.2.0', source: 'meta' });
  AppVersion.applyToElement(el, fileRes);
  assert.equal(el.textContent, '源码预览');
  assert.equal(el.attrs.get('data-version-state'), 'source');
  assert.equal(el.attrs.has('data-app-version'), false);
});
