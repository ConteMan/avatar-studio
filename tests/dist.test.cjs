"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const PROJECT_ROOT = path.resolve(__dirname, "..");

function httpRequest(port, reqPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method: options.method || "GET",
        headers: options.headers || {},
      },
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

test("显式白名单构建 dist 可重复执行、清除旧产物并通过白名单校验", async () => {
  const { buildDist, EXPECTED_DIST_FILES } = await import("../scripts/build-dist.mjs");
  const { verifyDist } = await import("../scripts/verify-dist.mjs");

  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-studio-dist-"));
  const distDir = path.join(tmpParent, "dist");

  try {
    // 预先制造残留文件和敏感目录，验证构建前会自动清理
    fs.mkdirSync(path.join(distDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(distDir, "stale.txt"), "old-artifact", "utf8");
    fs.writeFileSync(path.join(distDir, "docs", "leak.md"), "should-not-exist", "utf8");

    const first = buildDist({ projectRoot: PROJECT_ROOT, distDir });
    assert.deepEqual(first.files, [...EXPECTED_DIST_FILES]);
    assert.equal(fs.existsSync(path.join(distDir, "stale.txt")), false);
    assert.equal(fs.existsSync(path.join(distDir, "docs")), false);

    const verified = verifyDist({ projectRoot: PROJECT_ROOT, distDir });
    assert.deepEqual(verified.files, [...EXPECTED_DIST_FILES]);
    assert.equal(verified.meta.stage, "candidate");
    assert.equal(verified.meta.released, false);

    // 重复执行一次，结果应完全一致
    const firstMeta = fs.readFileSync(path.join(distDir, "build-meta.json"), "utf8");
    const second = buildDist({ projectRoot: PROJECT_ROOT, distDir });
    assert.deepEqual(second.files, first.files);
    assert.equal(fs.readFileSync(path.join(distDir, "build-meta.json"), "utf8"), firstMeta);

    // 注入白名单之外的文件必须触发校验失败
    fs.writeFileSync(path.join(distDir, "extra.txt"), "nope", "utf8");
    assert.throws(() => verifyDist({ projectRoot: PROJECT_ROOT, distDir }), /Unexpected files/);
  } finally {
    fs.rmSync(tmpParent, { recursive: true, force: true });
  }
});

test("dist 本地预览满足静态资源、查询分享、Content-Type、缓存头与真实 404 策略", async () => {
  const { buildDist } = await import("../scripts/build-dist.mjs");
  const { createPreviewServer } = await import("../scripts/preview-dist.mjs");

  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-studio-preview-"));
  const distDir = path.join(tmpParent, "dist");
  buildDist({ projectRoot: PROJECT_ROOT, distDir });

  const server = createPreviewServer({ distDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const srcIndex = fs.readFileSync(path.join(PROJECT_ROOT, "index.html"));

    // 首页
    const home = await httpRequest(port, "/");
    assert.equal(home.status, 200);
    assert.equal(home.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(home.headers["cache-control"], "public, max-age=0, must-revalidate");
    assert.equal(home.headers["x-content-type-options"], "nosniff");
    assert.equal(home.headers["x-frame-options"], "DENY");
    assert.ok(home.headers.etag);
    assert.deepEqual(home.body, srcIndex);

    // ETag 条件请求 304
    const notModified = await httpRequest(port, "/", {
      headers: { "If-None-Match": home.headers.etag },
    });
    assert.equal(notModified.status, 304);

    // 查询分享 URL 返回首页
    const share = await httpRequest(port, "/?s=eyJ2IjoxfQ&utm=demo");
    assert.equal(share.status, 200);
    assert.equal(share.headers["content-type"], "text/html; charset=utf-8");
    assert.deepEqual(share.body, srcIndex);

    // /index.html 遵循 auto-trailing-slash 307 重定向至 / 且保留查询串
    const redir = await httpRequest(port, "/index.html?s=abc123");
    assert.equal(redir.status, 307);
    assert.equal(redir.headers.location, "/?s=abc123");

    // 实际引用的静态资产与 Content-Type / 缓存头
    const mark = await httpRequest(port, "/assets/mark.svg");
    assert.equal(mark.status, 200);
    assert.equal(mark.headers["content-type"], "image/svg+xml; charset=utf-8");
    assert.equal(mark.headers["cache-control"], "public, max-age=3600, must-revalidate");
    assert.deepEqual(mark.body, fs.readFileSync(path.join(PROJECT_ROOT, "assets/mark.svg")));

    const icon = await httpRequest(port, "/assets/favicon-32.png");
    assert.equal(icon.status, 200);
    assert.equal(icon.headers["content-type"], "image/png");
    assert.equal(icon.headers["cache-control"], "public, max-age=3600, must-revalidate");
    assert.deepEqual(icon.body, fs.readFileSync(path.join(PROJECT_ROOT, "assets/favicon-32.png")));

    // 候选元数据可读且不伪造发布版本
    const metaRes = await httpRequest(port, "/build-meta.json");
    assert.equal(metaRes.status, 200);
    assert.equal(metaRes.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(metaRes.headers["cache-control"], "no-cache, must-revalidate");
    assert.equal(metaRes.headers["x-robots-tag"], "noindex");
    const meta = JSON.parse(metaRes.body.toString("utf8"));
    assert.equal(meta.stage, "candidate");
    assert.equal(meta.released, false);

    // _headers 内部控制文件不可直接下载
    const headersLeak = await httpRequest(port, "/_headers");
    assert.equal(headersLeak.status, 404);

    // 未知路径、缺失资产及仓库非发布目录必须返回真实 404（禁止 SPA 回退）
    const must404 = [
      "/unknown-route",
      "/assets/missing.svg",
      "/docs/",
      "/docs/DESIGN.md",
      "/rounds/R05-2026-11-26/shu.svg",
      "/tests/engine.test.cjs",
      "/scripts/selftest.sh",
      "/.git/HEAD",
      "/package.json",
      "/cloudflare.config.ts",
      "/../package.json",
      "/%2e%2e/index.html",
    ];
    for (const p of must404) {
      const res = await httpRequest(port, p);
      assert.equal(res.status, 404, `Expected 404 for ${p}, got ${res.status}`);
      assert.doesNotMatch(res.headers["content-type"] || "", /text\/html/i, `Must not SPA-fallback HTML for ${p}`);
    }

    // 非 GET/HEAD 返回 405
    const postRes = await httpRequest(port, "/", { method: "POST" });
    assert.equal(postRes.status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpParent, { recursive: true, force: true });
  }
});
