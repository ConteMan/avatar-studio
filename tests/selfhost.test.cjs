"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2c5282"/></svg>\n`;
const SAMPLE_SVG_ALT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#2f855a"/></svg>\n`;

// 最小合法 16x16 PNG 文件头与 IHDR（用于魔数与尺寸解析校验）
function makeMinimalPng(width = 32, height = 32) {
  const buf = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 6; // RGBA
  return buf;
}

function makeMinimalIco() {
  const buf = Buffer.alloc(22);
  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(1, 2); // ICO
  buf.writeUInt16LE(1, 4); // 1 image
  buf[6] = 16;
  buf[7] = 16;
  return buf;
}

function makeMinimalWebp() {
  const buf = Buffer.alloc(16);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(8, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8 ", 12, "ascii");
  return buf;
}

function makeMinimalJpeg() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function snapshotDir(dir, prefix = "") {
  const map = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(map, snapshotDir(full, rel));
    } else {
      map[rel] = sha256File(full);
    }
  }
  return map;
}

function httpRequest(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * 创建完全无 Git、无 deploy/、无 rounds/、无 node_modules/ 的源码包临时副本，
 * 验证自建静态部署在无 Git 压缩包场景下的完整链路。
 */
function createNoGitBundleFixture(configOverride, extraFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-studio-nogit-"));
  const copyFile = (rel) => {
    const src = path.join(PROJECT_ROOT, rel);
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  };

  for (const rel of [
    "index.html",
    "site.config.json",
    "site.config.example.json",
    "assets/mark.svg",
    "assets/favicon-32.png",
    "package.json",
    "scripts/build-selfhost.mjs",
    "scripts/verify-selfhost.mjs",
    "scripts/preview-dist.mjs",
  ]) {
    copyFile(rel);
  }

  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  if (configOverride === null) {
    fs.rmSync(path.join(dir, "site.config.json"), { force: true });
  } else if (typeof configOverride === "string") {
    fs.writeFileSync(path.join(dir, "site.config.json"), configOverride, "utf8");
  } else if (configOverride !== undefined) {
    fs.writeFileSync(
      path.join(dir, "site.config.json"),
      `${JSON.stringify(configOverride, null, 2)}\n`,
      "utf8",
    );
  }

  return dir;
}

test("默认 site.config.json 与 site.config.example.json 均可独立构建、校验、清理旧残留且可重现", async () => {
  const { buildSelfhost } = await import("../scripts/build-selfhost.mjs");
  const { verifySelfhost } = await import("../scripts/verify-selfhost.mjs");

  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-studio-selfhost-"));
  const outDir = path.join(tmpParent, "dist-selfhost");
  const exampleOutDir = path.join(tmpParent, "dist-selfhost-example");
  const origRootIndexHash = sha256File(path.join(PROJECT_ROOT, "index.html"));

  try {
    // 预先制造残留文件与敏感目录，确认构建前自动清空
    fs.mkdirSync(path.join(outDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "stale.txt"), "stale", "utf8");
    fs.writeFileSync(path.join(outDir, "docs", "secret.md"), "nope", "utf8");

    const first = buildSelfhost({ projectRoot: PROJECT_ROOT, outDir });
    assert.deepEqual(first.files, ["assets/favicon.png", "assets/logo.svg", "index.html"]);
    assert.equal(fs.existsSync(path.join(outDir, "stale.txt")), false);
    assert.equal(fs.existsSync(path.join(outDir, "docs")), false);

    const verified = verifySelfhost({ projectRoot: PROJECT_ROOT, outDir });
    assert.deepEqual(verified.files, first.files);
    assert.equal(verified.config.siteName, "半身像工坊");

    // 重复构建输出逐字节可重现
    const snap1 = snapshotDir(outDir);
    buildSelfhost({ projectRoot: PROJECT_ROOT, outDir });
    const snap2 = snapshotDir(outDir);
    assert.deepEqual(snap2, snap1);

    // 示例配置 site.config.example.json 可直接构建并通过校验
    const exampleRes = buildSelfhost({
      projectRoot: PROJECT_ROOT,
      configPath: "site.config.example.json",
      outDir: exampleOutDir,
    });
    assert.equal(exampleRes.config.siteName, "星尘头像工坊");
    const exampleVerified = verifySelfhost({
      projectRoot: PROJECT_ROOT,
      configPath: "site.config.example.json",
      outDir: exampleOutDir,
    });
    assert.deepEqual(exampleVerified.files, ["assets/favicon.png", "assets/logo.svg", "index.html"]);
    const exampleHtml = fs.readFileSync(path.join(exampleOutDir, "index.html"), "utf8");
    assert.match(exampleHtml, /<title>星尘头像工坊 · 自建半身像<\/title>/);
    assert.match(exampleHtml, /<h1>星尘头像工坊<\/h1>/);

    // 根页 index.html 保持逐字节不变
    assert.equal(sha256File(path.join(PROJECT_ROOT, "index.html")), origRootIndexHash);
  } finally {
    fs.rmSync(tmpParent, { recursive: true, force: true });
  }
});

test("自定义品牌支持多种图标格式、单路径 favicon、同源去重及 HTML 特殊字符/$安全转义", async () => {
  const { buildSelfhost } = await import("../scripts/build-selfhost.mjs");
  const { verifySelfhost } = await import("../scripts/verify-selfhost.mjs");

  const dir = createNoGitBundleFixture(
    {
      siteName: 'A & B <工坊> "$1" $$',
      title: 'A & B · $& <Avatar> "Studio"',
      description: `自定义描述 <script>alert(1)</script> & '引号' $1`,
      logo: "brand/logo.png",
      favicon: {
        svg: "brand/icon.svg",
        png: "brand/fav.png",
        ico: "brand/fav.ico",
      },
    },
    {
      "brand/logo.png": makeMinimalPng(64, 64),
      "brand/icon.svg": SAMPLE_SVG,
      "brand/fav.png": makeMinimalPng(32, 32),
      "brand/fav.ico": makeMinimalIco(),
      "brand/logo.webp": makeMinimalWebp(),
      "brand/logo.jpg": makeMinimalJpeg(),
    },
  );

  try {
    const built = buildSelfhost({ projectRoot: dir });
    assert.deepEqual(built.files, [
      "assets/favicon.ico",
      "assets/favicon.png",
      "assets/favicon.svg",
      "assets/logo.png",
      "index.html",
    ]);
    verifySelfhost({ projectRoot: dir });

    const html = fs.readFileSync(path.join(dir, "dist-selfhost", "index.html"), "utf8");
    assert.ok(html.includes("<title>A &amp; B · $&amp; &lt;Avatar&gt; &quot;Studio&quot;</title>"));
    assert.ok(
      html.includes(
        '<meta name="description" content="自定义描述 &lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;引号&#39; $1">',
      ),
    );
    assert.ok(html.includes("<h1>A &amp; B &lt;工坊&gt; &quot;$1&quot; $$</h1>"));
    assert.ok(html.includes('<img class="mark" src="assets/logo.png" width="32" height="32" alt="">'));
    assert.ok(html.includes('<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">'));
    assert.ok(html.includes('<link rel="icon" href="assets/favicon.png" sizes="32x32" type="image/png">'));
    assert.ok(html.includes('<link rel="icon" href="assets/favicon.ico" type="image/x-icon">'));

    // 单字符串 favicon 与 logo 同源时自动去重，并支持 WebP/JPEG
    fs.writeFileSync(
      path.join(dir, "site.config.json"),
      `${JSON.stringify(
        {
          siteName: "极简站",
          title: "极简站",
          description: "同源 WebP 图标",
          logo: "brand/logo.webp",
          favicon: "brand/logo.webp",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const dedupBuilt = buildSelfhost({ projectRoot: dir });
    assert.deepEqual(dedupBuilt.files, ["assets/logo.webp", "index.html"]);
    verifySelfhost({ projectRoot: dir });

    // JPEG Logo + ICO 单字符串 favicon
    fs.writeFileSync(
      path.join(dir, "site.config.json"),
      `${JSON.stringify(
        {
          siteName: "摄影社",
          title: "摄影社头像",
          description: "JPEG 标志与 ICO 图标",
          logo: "brand/logo.jpg",
          favicon: "brand/fav.ico",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const jpgBuilt = buildSelfhost({ projectRoot: dir });
    assert.deepEqual(jpgBuilt.files, ["assets/favicon.ico", "assets/logo.jpg", "index.html"]);
    verifySelfhost({ projectRoot: dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("无 Git 源码包端到端：CLI 构建、校验与本地预览（含自定义品牌与 404 防泄露）且与 Git 仓库逐字节一致", async () => {
  const { buildSelfhost } = await import("../scripts/build-selfhost.mjs");
  const { createPreviewServer } = await import("../scripts/preview-dist.mjs");

  const customCfg = {
    siteName: "无仓库自建站",
    title: "无仓库自建站 · Avatar",
    description: "从无 Git 压缩包直接构建的纯静态头像工坊。",
    logo: "brand/mark.svg",
    favicon: {
      svg: "brand/mark.svg",
      png: "brand/icon-48.png",
    },
  };
  const customPng = makeMinimalPng(48, 48);
  const noGitDir = createNoGitBundleFixture(customCfg, {
    "brand/mark.svg": SAMPLE_SVG,
    "brand/icon-48.png": customPng,
  });

  // 确认完全不存在 .git、deploy、cloudflare.config.ts、rounds
  assert.equal(fs.existsSync(path.join(noGitDir, ".git")), false);
  assert.equal(fs.existsSync(path.join(noGitDir, "deploy")), false);
  assert.equal(fs.existsSync(path.join(noGitDir, "cloudflare.config.ts")), false);

  const tmpRepoOutParent = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-studio-repro-"));
  const repoOutDir = path.join(tmpRepoOutParent, "dist-selfhost");
  const noGitDefaultDir = createNoGitBundleFixture();

  try {
    // 1. 直接运行 CLI 构建与校验（零 npm install、无 Git）
    const buildRun = spawnSync(process.execPath, ["scripts/build-selfhost.mjs"], {
      cwd: noGitDir,
      encoding: "utf8",
    });
    assert.equal(buildRun.status, 0, buildRun.stderr);
    assert.match(buildRun.stdout, /Built 3 self-host files into dist-selfhost\//);

    const verifyRun = spawnSync(process.execPath, ["scripts/verify-selfhost.mjs"], {
      cwd: noGitDir,
      encoding: "utf8",
    });
    assert.equal(verifyRun.status, 0, verifyRun.stderr);
    assert.match(verifyRun.stdout, /Verified dist-selfhost\//);

    // 2. 启动预览服务器验证静态服务、自定义品牌与真实 404 防泄露
    const distSelfhostDir = path.join(noGitDir, "dist-selfhost");
    const server = createPreviewServer({ distDir: distSelfhostDir });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    try {
      const home = await httpRequest(port, "/");
      assert.equal(home.status, 200);
      assert.equal(home.headers["content-type"], "text/html; charset=utf-8");
      const html = home.body.toString("utf8");
      assert.match(html, /<title>无仓库自建站 · Avatar<\/title>/);
      assert.match(html, /<h1>无仓库自建站<\/h1>/);
      assert.match(html, /<img class="mark" src="assets\/logo\.svg"/);
      assert.match(html, /<link rel="icon" href="assets\/favicon\.png" sizes="48x48" type="image\/png">/);

      const share = await httpRequest(port, "/?s=eyJ2IjoxfQ");
      assert.equal(share.status, 200);
      assert.deepEqual(share.body, home.body);

      const logoRes = await httpRequest(port, "/assets/logo.svg");
      assert.equal(logoRes.status, 200);
      assert.equal(logoRes.headers["content-type"], "image/svg+xml; charset=utf-8");
      assert.equal(logoRes.body.toString("utf8"), SAMPLE_SVG);

      const favRes = await httpRequest(port, "/assets/favicon.png");
      assert.equal(favRes.status, 200);
      assert.equal(favRes.headers["content-type"], "image/png");
      assert.deepEqual(favRes.body, customPng);

      for (const blocked of [
        "/site.config.json",
        "/brand/mark.svg",
        "/assets/mark.svg",
        "/package.json",
        "/scripts/build-selfhost.mjs",
        "/docs/",
        "/rounds/R05-2026-11-26/shu.svg",
        "/_headers",
        "/unknown-path",
      ]) {
        const res = await httpRequest(port, blocked);
        assert.equal(res.status, 404, `Expected 404 for ${blocked}, got ${res.status}`);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // 3. Git 仓库默认构建与无 Git 源码包默认构建逐字节完全一致（跨环境可重现）
    buildSelfhost({ projectRoot: PROJECT_ROOT, outDir: repoOutDir });
    buildSelfhost({ projectRoot: noGitDefaultDir });
    assert.deepEqual(snapshotDir(path.join(noGitDefaultDir, "dist-selfhost")), snapshotDir(repoOutDir));
  } finally {
    fs.rmSync(noGitDir, { recursive: true, force: true });
    fs.rmSync(noGitDefaultDir, { recursive: true, force: true });
    fs.rmSync(tmpRepoOutParent, { recursive: true, force: true });
  }
});

test("缺件与无效字段检测：缺配置、缺图、多余字段、非法路径、不安全 SVG 与损坏图片均有明确报错", async () => {
  const { buildSelfhost } = await import("../scripts/build-selfhost.mjs");

  const cases = [
    {
      name: "缺失 site.config.json",
      config: null,
      expect: /Missing site config file/,
    },
    {
      name: "非法 JSON 语法",
      config: "{ broken json",
      expect: /Invalid JSON in site config/,
    },
    {
      name: "顶层不是对象",
      config: "[]",
      expect: /must be a JSON object/,
    },
    {
      name: "缺少必填字段",
      config: { siteName: "A", title: "B", logo: "assets/mark.svg", favicon: "assets/mark.svg" },
      expect: /Missing required config field "description"/,
    },
    {
      name: "包含未支持的未知字段（如分享卡）",
      config: {
        siteName: "A",
        title: "B",
        description: "C",
        logo: "assets/mark.svg",
        favicon: "assets/mark.svg",
        ogImage: "assets/mark.svg",
      },
      expect: /Unknown config field "ogImage"/,
    },
    {
      name: "favicon 对象包含未知键",
      config: {
        siteName: "A",
        title: "B",
        description: "C",
        logo: "assets/mark.svg",
        favicon: { svg: "assets/mark.svg", apple: "assets/favicon-32.png" },
      },
      expect: /Unknown favicon field "favicon\.apple"/,
    },
    {
      name: "favicon 空对象",
      config: {
        siteName: "A",
        title: "B",
        description: "C",
        logo: "assets/mark.svg",
        favicon: {},
      },
      expect: /must define at least one of/,
    },
    {
      name: "空字符串与换行控制字符",
      config: {
        siteName: "   ",
        title: "line1\nline2",
        description: "desc",
        logo: "assets/mark.svg",
        favicon: "assets/mark.svg",
      },
      expect: /must be a non-empty string[\s\S]*must not contain control characters/,
    },
    {
      name: "超长站名",
      config: {
        siteName: "站".repeat(81),
        title: "B",
        description: "C",
        logo: "assets/mark.svg",
        favicon: "assets/mark.svg",
      },
      expect: /exceeds maximum length of 80/,
    },
    {
      name: "缺失 Logo 图片文件",
      config: {
        siteName: "A",
        title: "B",
        description: "C",
        logo: "brand/missing-logo.svg",
        favicon: "assets/favicon-32.png",
      },
      expect: /Missing asset file for "logo": brand\/missing-logo\.svg/,
    },
    {
      name: "缺失 favicon 图片文件",
      config: {
        siteName: "A",
        title: "B",
        description: "C",
        logo: "assets/mark.svg",
        favicon: { png: "brand/missing-fav.png" },
      },
      expect: /Missing asset file for "favicon\.png": brand\/missing-fav\.png/,
    },
    {
      name: "禁止外部 URL",
      config: {
        siteName: "A",
        title: "B",
        description: "C",
        logo: "https://example.com/logo.svg",
        favicon: "assets/favicon-32.png",
      },
      expect: /not an external\/data URL/,
    },
    {
      name: "禁止路径穿越",
      config: {
        siteName: "A",
        title: "B",
        description: "C",
        logo: "../etc/passwd.svg",
        favicon: "assets/favicon-32.png",
      },
      expect: /invalid path segments/,
    },
    {
      name: "禁止直接引用母版 rounds/",
      config: {
        siteName: "A",
        title: "B",
        description: "C",
        logo: "rounds/R05-2026-11-26/shu.svg",
        favicon: "assets/favicon-32.png",
      },
      expect: /must not reference master logo directory "rounds\/"/,
    },
    {
      name: "禁止不支持的扩展名",
      config: {
        siteName: "A",
        title: "B",
        description: "C",
        logo: "brand/logo.gif",
        favicon: "assets/favicon-32.png",
      },
      expect: /unsupported file extension "\.gif"/,
    },
    {
      name: "SVG 含 script 标签必须拒绝",
      config: {
        siteName: "A",
        title: "B",
        description: "C",
        logo: "brand/evil.svg",
        favicon: "assets/favicon-32.png",
      },
      extraFiles: {
        "brand/evil.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      },
      expect: /failed self-contained safety check/,
    },
    {
      name: "SVG 含外部 url() 引用必须拒绝",
      config: {
        siteName: "A",
        title: "B",
        description: "C",
        logo: "brand/ext-url.svg",
        favicon: "assets/favicon-32.png",
      },
      extraFiles: {
        "brand/ext-url.svg": '<svg xmlns="http://www.w3.org/2000/svg" style="background:url(https://evil.test/x)"></svg>',
      },
      expect: /must not contain external url\(\) references/,
    },
    {
      name: "伪造损坏的 PNG 必须拒绝",
      config: {
        siteName: "A",
        title: "B",
        description: "C",
        logo: "assets/mark.svg",
        favicon: { png: "brand/fake.png" },
      },
      extraFiles: {
        "brand/fake.png": "not a real png file at all",
      },
      expect: /invalid PNG header/,
    },
    {
      name: "空资产文件必须拒绝",
      config: {
        siteName: "A",
        title: "B",
        description: "C",
        logo: "brand/empty.svg",
        favicon: "assets/favicon-32.png",
      },
      extraFiles: {
        "brand/empty.svg": "",
      },
      expect: /Asset file for "logo" is empty/,
    },
  ];

  for (const tc of cases) {
    const dir = createNoGitBundleFixture(tc.config, tc.extraFiles || {});
    try {
      assert.throws(() => buildSelfhost({ projectRoot: dir }), tc.expect, `Case failed: ${tc.name}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // 符号链接资产必须被拒绝
  const symDir = createNoGitBundleFixture({
    siteName: "A",
    title: "B",
    description: "C",
    logo: "brand/link.svg",
    favicon: "assets/favicon-32.png",
  });
  try {
    fs.mkdirSync(path.join(symDir, "brand"), { recursive: true });
    fs.symlinkSync(path.join(symDir, "assets", "mark.svg"), path.join(symDir, "brand", "link.svg"));
    assert.throws(() => buildSelfhost({ projectRoot: symDir }), /must not be a symlink/);
  } finally {
    fs.rmSync(symDir, { recursive: true, force: true });
  }

  // 危险输出目录保护（禁止覆写项目根、官方 dist/、assets/ 或任意外部路径）
  const guardDir = createNoGitBundleFixture();
  try {
    assert.throws(() => buildSelfhost({ projectRoot: guardDir, outDir: guardDir }), /Refusing to clean project root/);
    assert.throws(() => buildSelfhost({ projectRoot: guardDir, outDir: path.join(guardDir, "dist") }), /protected directory "dist"/);
    assert.throws(() => buildSelfhost({ projectRoot: guardDir, outDir: path.join(guardDir, "assets") }), /protected directory "assets"/);
    assert.throws(() => buildSelfhost({ projectRoot: guardDir, outDir: os.tmpdir() }), /ancestor directory of project root/);
    assert.throws(
      () => buildSelfhost({ projectRoot: guardDir, outDir: path.join(os.tmpdir(), "arbitrary-unrelated-dir") }),
      /unexpected directory outside project root/,
    );
  } finally {
    fs.rmSync(guardDir, { recursive: true, force: true });
  }
});

test("漂移、白名单、缺失产物与引用检测：配置/源码/图标/产物任一漂移均立即失败", async () => {
  const { buildSelfhost } = await import("../scripts/build-selfhost.mjs");
  const { verifySelfhost } = await import("../scripts/verify-selfhost.mjs");

  const dir = createNoGitBundleFixture(
    {
      siteName: "初始品牌",
      title: "初始品牌 · 工坊",
      description: "初始描述",
      logo: "brand/logo.svg",
      favicon: {
        svg: "brand/logo.svg",
        png: "brand/fav.png",
      },
    },
    {
      "brand/logo.svg": SAMPLE_SVG,
      "brand/fav.png": makeMinimalPng(32, 32),
    },
  );

  const outDir = path.join(dir, "dist-selfhost");

  try {
    // 0. 尚未构建时校验必须提示先构建
    assert.throws(() => verifySelfhost({ projectRoot: dir }), /does not exist/);

    // 正常构建并校验通过
    buildSelfhost({ projectRoot: dir });
    verifySelfhost({ projectRoot: dir });

    // 1. 构建后修改 site.config.json 未重建 -> 触发 index.html 漂移报错
    const origCfg = fs.readFileSync(path.join(dir, "site.config.json"), "utf8");
    fs.writeFileSync(path.join(dir, "site.config.json"), origCfg.replace("初始品牌", "变更后品牌"), "utf8");
    assert.throws(() => verifySelfhost({ projectRoot: dir }), /Artifact drift in index\.html/);
    fs.writeFileSync(path.join(dir, "site.config.json"), origCfg, "utf8");
    verifySelfhost({ projectRoot: dir });

    // 2. 构建后修改源 Logo 文件内容未重建 -> 触发资产漂移报错
    fs.writeFileSync(path.join(dir, "brand/logo.svg"), SAMPLE_SVG_ALT, "utf8");
    assert.throws(() => verifySelfhost({ projectRoot: dir }), /Artifact drift in assets\/logo\.svg/);
    fs.writeFileSync(path.join(dir, "brand/logo.svg"), SAMPLE_SVG, "utf8");
    verifySelfhost({ projectRoot: dir });

    // 3. 构建后修改源 index.html 未重建 -> 触发 index.html 漂移报错
    const origIndex = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    fs.writeFileSync(path.join(dir, "index.html"), `${origIndex}\n<!-- drift -->\n`, "utf8");
    assert.throws(() => verifySelfhost({ projectRoot: dir }), /Artifact drift in index\.html/);
    fs.writeFileSync(path.join(dir, "index.html"), origIndex, "utf8");
    verifySelfhost({ projectRoot: dir });

    // 4. 手工篡改 dist-selfhost/index.html -> 触发漂移报错
    const builtIndexPath = path.join(outDir, "index.html");
    const origBuiltIndex = fs.readFileSync(builtIndexPath, "utf8");
    fs.writeFileSync(builtIndexPath, origBuiltIndex.replace("初始品牌", "手工篡改"), "utf8");
    assert.throws(() => verifySelfhost({ projectRoot: dir }), /Artifact drift in index\.html/);
    fs.writeFileSync(builtIndexPath, origBuiltIndex, "utf8");

    // 5. 注入白名单之外的多余文件或敏感配置文件 -> 拒绝
    fs.writeFileSync(path.join(outDir, "site.config.json"), "{}", "utf8");
    assert.throws(
      () => verifySelfhost({ projectRoot: dir }),
      /Unexpected files[\s\S]*Forbidden path leaked/,
    );
    fs.rmSync(path.join(outDir, "site.config.json"));

    // 6. 删除白名单产物文件 -> 触发缺失文件与引用缺失报错
    const favOutPath = path.join(outDir, "assets", "favicon.png");
    const favBytes = fs.readFileSync(favOutPath);
    fs.rmSync(favOutPath);
    assert.throws(
      () => verifySelfhost({ projectRoot: dir }),
      /Missing whitelisted files[\s\S]*references missing output asset: assets\/favicon\.png/,
    );
    fs.writeFileSync(favOutPath, favBytes);

    // 7. 注入符号链接到输出目录 -> 拒绝
    fs.symlinkSync(path.join(dir, "package.json"), path.join(outDir, "leak.json"));
    assert.throws(() => verifySelfhost({ projectRoot: dir }), /Unexpected symlink/);
    fs.rmSync(path.join(outDir, "leak.json"));

    // 恢复后再次校验通过
    verifySelfhost({ projectRoot: dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("输出路径与祖先符号链接防御性回归：阻止绕过受保护目录与项目边界，拒绝时受保护文件与外部文件保持完整且无副作用", async () => {
  const { buildSelfhost } = await import("../scripts/build-selfhost.mjs");
  const { verifySelfhost } = await import("../scripts/verify-selfhost.mjs");

  const fixtureDir = createNoGitBundleFixture();
  const outsideVictimDir = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-studio-outside-victim-"));
  const extLinkDir = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-studio-ext-links-"));
  const extSafeParent = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-studio-ext-safe-"));

  try {
    // 准备隔离夹具内的受保护目录与受保护文件
    const docsKeepPath = path.join(fixtureDir, "docs", "important", "keep.txt");
    const docsDistKeepPath = path.join(fixtureDir, "docs", "dist-selfhost", "keep.txt");
    fs.mkdirSync(path.dirname(docsKeepPath), { recursive: true });
    fs.mkdirSync(path.dirname(docsDistKeepPath), { recursive: true });
    fs.writeFileSync(docsKeepPath, "protected-doc-content\n", "utf8");
    fs.writeFileSync(docsDistKeepPath, "protected-docs-dist-content\n", "utf8");

    // 准备工作区外文件（普通子目录 + 恰好名为 dist-selfhost 的外部目录）
    const outsidePreciousKeep = path.join(outsideVictimDir, "precious", "keep.txt");
    const outsideDistKeep = path.join(outsideVictimDir, "dist-selfhost", "keep.txt");
    fs.mkdirSync(path.dirname(outsidePreciousKeep), { recursive: true });
    fs.mkdirSync(path.dirname(outsideDistKeep), { recursive: true });
    fs.writeFileSync(outsidePreciousKeep, "outside-precious-content\n", "utf8");
    fs.writeFileSync(outsideDistKeep, "outside-dist-selfhost-content\n", "utf8");

    // 1. 项目内祖先符号链接指向受保护目录 docs/（覆盖已存在末段与未创建末段）
    fs.symlinkSync(path.join(fixtureDir, "docs"), path.join(fixtureDir, "output-link"));

    assert.throws(
      () => buildSelfhost({ projectRoot: fixtureDir, outDir: path.join(fixtureDir, "output-link", "important") }),
      /containing symlink "output-link"|protected directory "docs"/,
    );
    assert.throws(
      () => verifySelfhost({ projectRoot: fixtureDir, outDir: path.join(fixtureDir, "output-link", "important") }),
      /containing symlink "output-link"|protected directory "docs"/,
    );
    assert.equal(fs.readFileSync(docsKeepPath, "utf8"), "protected-doc-content\n");

    const uncreatedDocsTarget = path.join(fixtureDir, "docs", "uncreated-sub");
    assert.throws(
      () => buildSelfhost({ projectRoot: fixtureDir, outDir: path.join(fixtureDir, "output-link", "uncreated-sub") }),
      /containing symlink "output-link"|protected directory "docs"/,
    );
    assert.equal(fs.existsSync(uncreatedDocsTarget), false);

    // 2. 项目内祖先符号链接逃逸到工作区外（无论末段是否为 dist-selfhost、无论是否存在）
    fs.symlinkSync(outsideVictimDir, path.join(fixtureDir, "escape-link"));

    assert.throws(
      () => buildSelfhost({ projectRoot: fixtureDir, outDir: path.join(fixtureDir, "escape-link", "precious") }),
      /containing symlink "escape-link"|escapes project root/,
    );
    assert.equal(fs.readFileSync(outsidePreciousKeep, "utf8"), "outside-precious-content\n");

    assert.throws(
      () => buildSelfhost({ projectRoot: fixtureDir, outDir: path.join(fixtureDir, "escape-link", "dist-selfhost") }),
      /containing symlink "escape-link"|escapes project root/,
    );
    assert.equal(fs.readFileSync(outsideDistKeep, "utf8"), "outside-dist-selfhost-content\n");

    assert.throws(
      () => buildSelfhost({ projectRoot: fixtureDir, outDir: path.join(fixtureDir, "escape-link", "uncreated-escape") }),
      /containing symlink "escape-link"|escapes project root/,
    );
    assert.equal(fs.existsSync(path.join(outsideVictimDir, "uncreated-escape")), false);

    // 3. 工作区外符号链接祖先回指受保护目录 docs/（即使末段叫 dist-selfhost / dist-selfhost-new）
    fs.symlinkSync(path.join(fixtureDir, "docs"), path.join(extLinkDir, "to-docs"));

    assert.throws(
      () => buildSelfhost({ projectRoot: fixtureDir, outDir: path.join(extLinkDir, "to-docs", "dist-selfhost") }),
      /protected directory "docs"/,
    );
    assert.equal(fs.readFileSync(docsDistKeepPath, "utf8"), "protected-docs-dist-content\n");

    assert.throws(
      () => buildSelfhost({ projectRoot: fixtureDir, outDir: path.join(extLinkDir, "to-docs", "dist-selfhost-new") }),
      /protected directory "docs"/,
    );
    assert.equal(fs.existsSync(path.join(fixtureDir, "docs", "dist-selfhost-new")), false);

    // 4. 末段本身是符号链接（指向外部目录）、断链祖先、普通文件祖先均拒绝且无副作用
    fs.symlinkSync(path.join(outsideVictimDir, "precious"), path.join(fixtureDir, "dist-selfhost-sym"));
    assert.throws(
      () => buildSelfhost({ projectRoot: fixtureDir, outDir: path.join(fixtureDir, "dist-selfhost-sym") }),
      /symlink/,
    );
    assert.equal(fs.readFileSync(outsidePreciousKeep, "utf8"), "outside-precious-content\n");

    fs.symlinkSync(path.join(outsideVictimDir, "missing-target"), path.join(extLinkDir, "broken-link"));
    assert.throws(
      () => buildSelfhost({ projectRoot: fixtureDir, outDir: path.join(extLinkDir, "broken-link", "dist-selfhost") }),
      /broken symlink ancestor/,
    );

    const fileAncestor = path.join(fixtureDir, "regular-file");
    fs.writeFileSync(fileAncestor, "keep-file\n", "utf8");
    assert.throws(
      () => buildSelfhost({ projectRoot: fixtureDir, outDir: path.join(fileAncestor, "dist-selfhost") }),
      /ancestor is not a directory/,
    );
    assert.equal(fs.readFileSync(fileAncestor, "utf8"), "keep-file\n");

    // 5. 保留默认与自定义安全输出路径（项目内嵌套未创建目录与项目外 dist-selfhost-* 目录）
    const defaultBuilt = buildSelfhost({ projectRoot: fixtureDir });
    assert.deepEqual(defaultBuilt.files, ["assets/favicon.png", "assets/logo.svg", "index.html"]);
    verifySelfhost({ projectRoot: fixtureDir });

    const nestedSafeOut = path.join(fixtureDir, "custom-out", "site-a");
    const nestedBuilt = buildSelfhost({ projectRoot: fixtureDir, outDir: nestedSafeOut });
    assert.deepEqual(nestedBuilt.files, ["assets/favicon.png", "assets/logo.svg", "index.html"]);
    verifySelfhost({ projectRoot: fixtureDir, outDir: nestedSafeOut });

    const extSafeOut = path.join(extSafeParent, "dist-selfhost-custom");
    const extBuilt = buildSelfhost({ projectRoot: fixtureDir, outDir: extSafeOut });
    assert.deepEqual(extBuilt.files, ["assets/favicon.png", "assets/logo.svg", "index.html"]);
    verifySelfhost({ projectRoot: fixtureDir, outDir: extSafeOut });

    // 所有受保护文件与工作区外文件全程完好
    assert.equal(fs.readFileSync(docsKeepPath, "utf8"), "protected-doc-content\n");
    assert.equal(fs.readFileSync(docsDistKeepPath, "utf8"), "protected-docs-dist-content\n");
    assert.equal(fs.readFileSync(outsidePreciousKeep, "utf8"), "outside-precious-content\n");
    assert.equal(fs.readFileSync(outsideDistKeep, "utf8"), "outside-dist-selfhost-content\n");
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.rmSync(outsideVictimDir, { recursive: true, force: true });
    fs.rmSync(extLinkDir, { recursive: true, force: true });
    fs.rmSync(extSafeParent, { recursive: true, force: true });
  }
});
