'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { loadState } = require('./state-loader.cjs');

const { AvatarState: app, Export: exp } = loadState(readFileSync(join(__dirname, '..', 'index.html'), 'utf8'));

function makeDocument(execCommand) {
  const input = {
    focus() { doc.activeElement = input; }
  };
  const doc = {
    activeElement: input,
    body: {
      children: [],
      appendChild(el) {
        this.children.push(el);
        el.parentNode = this;
      },
      removeChild(el) {
        const next = this.children.filter(item => item !== el);
        if (next.length === this.children.length) throw new Error('missing');
        this.children = next;
        el.parentNode = null;
      }
    },
    createElement() {
      return {
        value: '',
        style: {},
        parentNode: null,
        setAttribute() {},
        focus() { doc.activeElement = this; },
        select() {}
      };
    },
    contains(el) { return el === input; },
    execCommand
  };
  return { doc, input };
}

function notesOf() {
  const notes = [];
  return { notes, notify(message) { notes.push(message); } };
}

test('异步剪贴板成功时只提示成功，且不创建临时文本框', async () => {
  const { doc } = makeDocument(() => { throw new Error('不应回退'); });
  let created = 0;
  const original = doc.createElement;
  doc.createElement = function () { created += 1; return original.call(doc); };
  const sink = notesOf();
  let observed = null;
  await exp.copyText('分享链接', '分享链接已复制', {
    clipboard: { writeText(text) { observed = text; return Promise.resolve(); } },
    document: doc,
    notify: sink.notify
  });
  assert.equal(observed, '分享链接');
  assert.equal(created, 0);
  assert.deepEqual(sink.notes, ['分享链接已复制']);
  assert.equal(doc.body.children.length, 0);
});

test('剪贴板拒绝后回退成功，拒绝期间不提示成功', async () => {
  const { doc, input } = makeDocument(() => true);
  const sink = notesOf();
  let rejectWrite;
  const pending = exp.copyText('配置', '配置 JSON 已复制', {
    clipboard: { writeText() { return new Promise((resolve, reject) => { rejectWrite = reject; }); } },
    document: doc,
    notify: sink.notify
  });
  assert.deepEqual(sink.notes, []);
  assert.equal(doc.body.children.length, 0);
  rejectWrite(new Error('denied'));
  await pending;
  assert.deepEqual(sink.notes, ['配置 JSON 已复制']);
  assert.equal(doc.body.children.length, 0);
  assert.equal(doc.activeElement, input);
});

test('剪贴板拒绝且回退返回 false 时只提示失败', async () => {
  const { doc, input } = makeDocument(() => false);
  const sink = notesOf();
  await exp.copyText('配置', '配置 JSON 已复制', {
    clipboard: { writeText() { return Promise.reject(new Error('denied')); } },
    document: doc,
    notify: sink.notify
  });
  assert.deepEqual(sink.notes, [exp.COPY_FAIL]);
  assert.equal(doc.body.children.length, 0);
  assert.equal(doc.activeElement, input);
});

test('剪贴板同步抛错后回退，回退再抛错时提示失败并移除文本框', async () => {
  const { doc, input } = makeDocument(() => { throw new Error('exec'); });
  const sink = notesOf();
  await exp.copyText('hello', '已复制', {
    clipboard: { writeText() { throw new Error('sync'); } },
    document: doc,
    notify: sink.notify
  });
  assert.deepEqual(sink.notes, [exp.COPY_FAIL]);
  assert.equal(doc.body.children.length, 0);
  assert.equal(doc.activeElement, input);
});

test('没有剪贴板接口时回退，execCommand 返回 false 则失败', async () => {
  const { doc } = makeDocument(() => false);
  const sink = notesOf();
  await exp.copyText('hello', '已复制', { clipboard: null, document: doc, notify: sink.notify });
  assert.deepEqual(sink.notes, [exp.COPY_FAIL]);
  assert.equal(doc.body.children.length, 0);
});

test('JSON 复制使用统一状态且不含锁', () => {
  const state = app.defaultState();
  state.seed = '半身像工坊🌱';
  state.drawingSeed = 'hair-🌱';
  state.locks.params = true;
  const parsed = JSON.parse(exp.jsonText(state));
  assert.deepEqual(Object.keys(parsed), ['seed', 'drawingSeed', 'slots', 'params', 'colors', 'view']);
  assert.equal(parsed.seed, '半身像工坊🌱');
  assert.equal(parsed.drawingSeed, 'hair-🌱');
  assert.equal(parsed.view, state.view);
});

function pngHarness() {
  const images = [];
  const revoked = [];
  const saved = [];
  const drawn = [];
  const blobTypes = [];
  const svgSeen = [];
  const timers = [];
  let urlId = 0;
  const sink = notesOf();
  const canvases = [];
  const env = {
    createSvgUrl(svg) {
      svgSeen.push(svg);
      urlId += 1;
      return 'svg:' + urlId;
    },
    createBlobUrl(blob) {
      urlId += 1;
      return 'png:' + urlId + ':' + blob;
    },
    revokeObjectURL(url) { revoked.push(url); },
    Image: function ImageStub() {
      const img = {
        _src: '',
        set src(value) {
          this._src = value;
          images.push(this);
        }
      };
      return img;
    },
    createCanvas() {
      const canvas = {
        getContext() {
          return {
            drawImage(img, x, y, w, h) { drawn.push({ img, x, y, w, h }); }
          };
        },
        toBlob(callback, type) {
          blobTypes.push(type);
          canvas._callback = callback;
        }
      };
      canvases.push(canvas);
      return canvas;
    },
    notify: sink.notify,
    save(url, name) { saved.push({ url, name }); },
    schedule(fn) { timers.push(fn); }
  };
  return { images, revoked, saved, drawn, blobTypes, svgSeen, timers, sink, canvases, env };
}

test('PNG 成功导出使用点击快照，并只释放本次的对象 URL', async () => {
  const first = pngHarness();
  const second = {
    images: first.images,
    revoked: first.revoked,
    saved: first.saved,
    drawn: first.drawn,
    blobTypes: first.blobTypes,
    svgSeen: first.svgSeen,
    timers: first.timers,
    sink: notesOf(),
    canvases: [],
    env: null
  };
  second.env = Object.assign({}, first.env, {
    notify: second.sink.notify,
    createCanvas() {
      const canvas = first.env.createCanvas();
      second.canvases.push(canvas);
      return canvas;
    }
  });
  const snapA = { svg: '<svg id="a">甲</svg>', filename: 'avatar-甲.png' };
  const snapB = { svg: '<svg id="b">乙🌱</svg>', filename: 'avatar-乙🌱.png' };
  const pendingA = exp.exportPng(snapA, first.env);
  const pendingB = exp.exportPng(snapB, second.env);
  assert.equal(first.images.length, 2);
  assert.deepEqual(first.svgSeen, [snapA.svg, snapB.svg]);
  first.images[0].onload();
  first.canvases[0]._callback({ kind: 'blob-a' });
  await pendingA;
  assert.deepEqual(first.sink.notes, [exp.PNG_OK]);
  assert.equal(first.saved[0].name, 'avatar-甲.png');
  assert.deepEqual(first.drawn[0], { img: first.images[0], x: 0, y: 0, w: 1024, h: 1024 });
  assert.deepEqual(first.blobTypes, ['image/png']);
  assert.deepEqual(first.revoked, ['svg:1']);
  assert.equal(first.saved[0].url.startsWith('png:'), true);
  first.timers[0]();
  assert.deepEqual(first.revoked, ['svg:1', first.saved[0].url]);
  first.images[1].onload();
  second.canvases[0]._callback({ kind: 'blob-b' });
  await pendingB;
  assert.deepEqual(second.sink.notes, [exp.PNG_OK]);
  assert.equal(first.saved[1].name, 'avatar-乙🌱.png');
  assert.equal(first.saved[1].url !== first.saved[0].url, true);
  first.timers[1]();
  assert.deepEqual(first.revoked, ['svg:1', first.saved[0].url, 'svg:2', first.saved[1].url]);
});

test('PNG 点击快照不跟随之后的状态', () => {
  const state = app.defaultState();
  state.seed = '半身像工坊🌱';
  const snap = exp.capturePng(state, function (s) {
    return app.render(s);
  }, function (s) {
    return 'avatar-' + s.seed;
  });
  const svg = snap.svg;
  const filename = snap.filename;
  state.seed = 'changed';
  assert.equal(snap.svg, svg);
  assert.equal(snap.filename, 'avatar-半身像工坊🌱.png');
  assert.equal(svg.includes('<svg'), true);
  assert.equal(filename, snap.filename);
});

test('context 不可用时提示画布失败并释放本次 SVG URL', async () => {
  const h = pngHarness();
  h.env.createCanvas = function () { return { getContext() { return null; } }; };
  const pending = exp.exportPng({ svg: '<svg></svg>', filename: 'a.png' }, h.env);
  h.images[0].onload();
  await pending;
  assert.deepEqual(h.sink.notes, [exp.PNG_CONTEXT]);
  assert.deepEqual(h.revoked, ['svg:1']);
  assert.equal(h.saved.length, 0);
});

test('drawImage 抛错时提示绘制失败并释放本次 SVG URL', async () => {
  const h = pngHarness();
  h.env.createCanvas = function () {
    return { getContext() { return { drawImage() { throw new Error('draw'); } }; } };
  };
  const pending = exp.exportPng({ svg: '<svg></svg>', filename: 'a.png' }, h.env);
  h.images[0].onload();
  await pending;
  assert.deepEqual(h.sink.notes, [exp.PNG_DRAW]);
  assert.deepEqual(h.revoked, ['svg:1']);
  assert.equal(h.saved.length, 0);
});

test('toBlob 抛错时提示生成失败，且不影响另一次导出', async () => {
  const h = pngHarness();
  let mode = 'throw';
  h.env.createCanvas = function () {
    const current = mode;
    return {
      getContext() { return { drawImage() {} }; },
      toBlob(callback, type) {
        if (current === 'throw') throw new Error('toBlob');
        h.blobTypes.push(type);
        callback({ kind: 'ok' });
      }
    };
  };
  const failed = exp.exportPng({ svg: '<svg>1</svg>', filename: 'bad.png' }, h.env);
  h.images[0].onload();
  await failed;
  assert.deepEqual(h.sink.notes, [exp.PNG_BLOB]);
  assert.deepEqual(h.revoked, ['svg:1']);
  mode = 'ok';
  const again = exp.exportPng({ svg: '<svg>2</svg>', filename: 'good.png' }, h.env);
  h.images[1].onload();
  await again;
  assert.deepEqual(h.sink.notes, [exp.PNG_BLOB, exp.PNG_OK]);
  assert.equal(h.saved[0].name, 'good.png');
  h.timers[0]();
  assert.deepEqual(h.revoked, ['svg:1', 'svg:2', h.saved[0].url]);
});

test('toBlob 返回 null 时提示未返回图片', async () => {
  const h = pngHarness();
  const pending = exp.exportPng({ svg: '<svg></svg>', filename: 'a.png' }, h.env);
  h.images[0].onload();
  h.canvases[0]._callback(null);
  await pending;
  assert.deepEqual(h.sink.notes, [exp.PNG_EMPTY]);
  assert.deepEqual(h.revoked, ['svg:1']);
  assert.equal(h.saved.length, 0);
});

test('图片解码失败时提示解码错误并释放本次 SVG URL', async () => {
  const h = pngHarness();
  const pending = exp.exportPng({ svg: '<svg></svg>', filename: 'a.png' }, h.env);
  h.images[0].onerror();
  await pending;
  assert.deepEqual(h.sink.notes, [exp.PNG_DECODE]);
  assert.deepEqual(h.revoked, ['svg:1']);
  assert.equal(h.drawn.length, 0);
});
