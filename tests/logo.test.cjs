'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const root = join(__dirname, '..');
const masterPath = join(root, 'rounds', 'R05-2026-11-26', 'shu.svg');
const fullPath = join(root, 'rounds', 'R05-2026-11-26', 'man.svg');
const markPath = join(root, 'assets', 'mark.svg');
const pngPath = join(root, 'assets', 'favicon-32.png');

function pathData(svg) {
  const match = svg.match(/\sd="([^"]+)"/);
  assert.ok(match, 'SVG 应有一条路径');
  return match[1];
}

test('页头标记派生自疏母版，不用满，且 SVG 自包含', () => {
  const master = readFileSync(masterPath, 'utf8');
  const full = readFileSync(fullPath, 'utf8');
  const mark = readFileSync(markPath, 'utf8');
  assert.equal(
    createHash('sha256').update(readFileSync(masterPath)).digest('hex'),
    '1376fb705bb7a10c74c2a8f6f746c93cb44313e4ddf86da3895c6b9569d4317f'
  );
  assert.equal(pathData(mark), pathData(master));
  assert.notEqual(pathData(mark), pathData(full));
  assert.match(mark, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.doesNotMatch(mark, /<(?:image|script|foreignObject|use)\b|xlink:href|@import|url\(/);
  assert.equal(mark.includes('#1b1a18'), true);

  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.match(html, /<img class="mark" src="assets\/mark\.svg" width="32" height="32" alt="">/);
  assert.match(html, /<link rel="icon" href="assets\/mark\.svg" type="image\/svg\+xml">/);
  assert.match(html, /<link rel="icon" href="assets\/favicon-32\.png" sizes="32x32" type="image\/png">/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  assert.match(html, /<meta name="theme-color" content="#f6f5f1">/);
  assert.doesNotMatch(html, /property="og:/);
});

test('32px PNG 图标存在且尺寸正确', () => {
  const png = readFileSync(pngPath);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);
});
