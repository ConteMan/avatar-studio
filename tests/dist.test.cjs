"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
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

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const CANDIDATE_CF_CONFIG = `import { defineConfig } from "cf/config";
export default defineConfig({
  worker: {
    name: "avatar-studio",
    compatibilityDate: "2026-11-26",
    workersDev: false,
    assets: {
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "none",
    },
  },
});
`;

const RELEASE_CF_CONFIG = `import { defineConfig } from "cf/config";
export default defineConfig({
  worker: {
    name: "avatar-studio",
    compatibilityDate: "2026-11-26",
    workersDev: false,
    domains: ["avatar.conteman.com"],
    assets: {
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "none",
    },
  },
});
`;

/**
 * 在隔离临时目录创建最小可提交项目副本，用于安全验证候选/正式模式、清单门禁、脏树、SHA 不符与域名一致性。
 */
function createIsolatedRepoFixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-studio-release-sim-"));
  const copyFile = (rel) => {
    const src = path.join(PROJECT_ROOT, rel);
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  };

  for (const rel of [
    ".gitignore",
    "index.html",
    "assets/mark.svg",
    "assets/favicon-32.png",
    "deploy/_headers",
    "deploy/release.json",
    "cloudflare.config.ts",
    "package.json",
  ]) {
    copyFile(rel);
  }

  if (overrides.releaseJson === null) {
    fs.rmSync(path.join(dir, "deploy/release.json"), { force: true });
  } else if (overrides.releaseJson !== undefined) {
    fs.writeFileSync(
      path.join(dir, "deploy/release.json"),
      `${JSON.stringify(overrides.releaseJson, null, 2)}\n`,
      "utf8",
    );
  }
  if (overrides.cloudflareConfig !== undefined) {
    fs.writeFileSync(path.join(dir, "cloudflare.config.ts"), overrides.cloudflareConfig, "utf8");
  }

  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.name", "Test Runner"]);
  runGit(dir, ["config", "user.email", "test@example.invalid"]);
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-q", "-m", "chore: 初始化隔离发布演练副本"]);
  const head = runGit(dir, ["rev-parse", "HEAD"]);

  return { dir, head };
}

test("项目根显式白名单构建 dist 可重复执行、清除旧产物并符合清单声明阶段校验", async () => {
  const { buildDist, EXPECTED_DIST_FILES, readReleaseManifest } = await import("../scripts/build-dist.mjs");
  const { verifyDist } = await import("../scripts/verify-dist.mjs");

  const manifest = readReleaseManifest(PROJECT_ROOT);
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

    // 项目根冒烟遵循 deploy/release.json 所声明阶段（支持 candidate 与经评审的 release 树）
    const verified = verifyDist({
      projectRoot: PROJECT_ROOT,
      distDir,
      mode: manifest.stage,
      requireClean: false,
    });
    assert.equal(verified.mode, manifest.stage);
    assert.deepEqual(verified.files, [...EXPECTED_DIST_FILES]);
    assert.equal(verified.meta.stage, manifest.stage);
    assert.equal(verified.meta.released, false);

    // 重复执行一次，结果应完全一致
    const firstMeta = fs.readFileSync(path.join(distDir, "build-meta.json"), "utf8");
    const second = buildDist({ projectRoot: PROJECT_ROOT, distDir });
    assert.deepEqual(second.files, first.files);
    assert.equal(fs.readFileSync(path.join(distDir, "build-meta.json"), "utf8"), firstMeta);

    // 注入白名单之外的文件必须触发校验失败
    fs.writeFileSync(path.join(distDir, "extra.txt"), "nope", "utf8");
    assert.throws(
      () => verifyDist({ projectRoot: PROJECT_ROOT, distDir, mode: manifest.stage, requireClean: false }),
      /Unexpected files/,
    );
  } finally {
    fs.rmSync(tmpParent, { recursive: true, force: true });
  }
});

test("隔离候选夹具：默认 candidate 模式放行干净候选配置，并拒绝生产 domains、release 阶段或未知/缺失清单", async () => {
  const { buildDist } = await import("../scripts/build-dist.mjs");
  const { verifyDist } = await import("../scripts/verify-dist.mjs");
  const { runManifestGate } = await import("../scripts/verify-manifest-gate.mjs");

  const cleanCandidate = createIsolatedRepoFixture({
    releaseJson: { stage: "candidate", plannedVersion: "0.1.0", allowedDomains: [] },
    cloudflareConfig: CANDIDATE_CF_CONFIG,
  });
  const withDomains = createIsolatedRepoFixture({
    releaseJson: { stage: "candidate", plannedVersion: "0.1.0", allowedDomains: [] },
    cloudflareConfig: RELEASE_CF_CONFIG,
  });
  const withReleaseStage = createIsolatedRepoFixture({
    releaseJson: { stage: "release", plannedVersion: "0.1.0", allowedDomains: ["avatar.conteman.com"] },
    cloudflareConfig: CANDIDATE_CF_CONFIG,
  });
  const withUnknownStage = createIsolatedRepoFixture({
    releaseJson: { stage: "staging", plannedVersion: "0.1.0", allowedDomains: [] },
    cloudflareConfig: CANDIDATE_CF_CONFIG,
  });
  const withMissingManifest = createIsolatedRepoFixture({
    releaseJson: null,
    cloudflareConfig: CANDIDATE_CF_CONFIG,
  });

  try {
    // 1. 干净候选夹具通过默认 candidate 校验与 verify:ci 清单门禁
    buildDist({ projectRoot: cleanCandidate.dir });
    const candOk = verifyDist({ projectRoot: cleanCandidate.dir });
    assert.equal(candOk.mode, "candidate");
    assert.equal(candOk.meta.stage, "candidate");
    assert.equal(candOk.meta.released, false);

    const ciCandOk = runManifestGate({ projectRoot: cleanCandidate.dir });
    assert.equal(ciCandOk.mode, "candidate");
    assert.equal(ciCandOk.checkedOutCommit, cleanCandidate.head);

    // 2. 候选阶段包含生产 domains -> 默认校验与清单门禁都必须拒绝
    buildDist({ projectRoot: withDomains.dir });
    assert.throws(
      () => verifyDist({ projectRoot: withDomains.dir }),
      /Candidate cloudflare\.config\.ts must not apply production domains/,
    );
    assert.throws(
      () => runManifestGate({ projectRoot: withDomains.dir }),
      /Candidate cloudflare\.config\.ts must not apply production domains/,
    );

    // 3. release 阶段但未配 domains -> 默认校验与清单门禁都必须拒绝
    buildDist({ projectRoot: withReleaseStage.dir });
    assert.throws(
      () => verifyDist({ projectRoot: withReleaseStage.dir }),
      /does not match verification mode="candidate"/,
    );
    assert.throws(
      () => runManifestGate({ projectRoot: withReleaseStage.dir }),
      /Release cloudflare\.config\.ts must configure approved domains/,
    );

    // 4. 未知 stage 或缺失 deploy/release.json -> 构建与清单门禁必须失败
    assert.throws(
      () => buildDist({ projectRoot: withUnknownStage.dir }),
      /stage must be one of candidate, release/,
    );
    assert.throws(
      () => runManifestGate({ projectRoot: withUnknownStage.dir }),
      /stage must be one of candidate, release/,
    );
    assert.throws(
      () => buildDist({ projectRoot: withMissingManifest.dir }),
      /Missing release manifest/,
    );
    assert.throws(
      () => runManifestGate({ projectRoot: withMissingManifest.dir }),
      /Missing release manifest/,
    );
  } finally {
    for (const f of [cleanCandidate, withDomains, withReleaseStage, withUnknownStage, withMissingManifest]) {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test("显式 release 模式与 verify:ci 清单门禁放行干净授权发布提交，并拦截脏树、SHA 不符、域名不匹配与伪造 released", async () => {
  const { buildDist } = await import("../scripts/build-dist.mjs");
  const { verifyDist } = await import("../scripts/verify-dist.mjs");
  const { runManifestGate } = await import("../scripts/verify-manifest-gate.mjs");

  const releaseFixture = createIsolatedRepoFixture({
    releaseJson: {
      stage: "release",
      plannedVersion: "0.1.0",
      allowedDomains: ["avatar.conteman.com"],
    },
    cloudflareConfig: RELEASE_CF_CONFIG,
  });

  try {
    const built = buildDist({ projectRoot: releaseFixture.dir });
    assert.equal(built.meta.stage, "release");
    assert.equal(built.meta.released, false);
    assert.equal(built.meta.sourceDirty, false);
    assert.equal(built.meta.sourceCommit, releaseFixture.head);

    // 1. 干净提交 + 域名与清单一致 + 精确 SHA -> release 模式与 verify:ci 均通过
    const ok = verifyDist({
      projectRoot: releaseFixture.dir,
      mode: "release",
      expectCommit: releaseFixture.head,
    });
    assert.equal(ok.mode, "release");
    assert.equal(ok.meta.sourceCommit, releaseFixture.head);
    assert.equal(ok.meta.released, false);

    const ciOk = runManifestGate({ projectRoot: releaseFixture.dir });
    assert.equal(ciOk.mode, "release");
    assert.equal(ciOk.checkedOutCommit, releaseFixture.head);

    // 2. 同副本下默认 candidate 模式（verify:dist）必须仍然拒绝
    assert.throws(
      () => verifyDist({ projectRoot: releaseFixture.dir }),
      /Candidate cloudflare\.config\.ts must not apply production domains/,
    );

    // 3. 预期 SHA 不符必须失败
    assert.throws(
      () =>
        verifyDist({
          projectRoot: releaseFixture.dir,
          mode: "release",
          expectCommit: "0000000000000000000000000000000000000000",
        }),
      /does not match expected commit/,
    );

    // 4. 伪造 released=true 必须失败（预发布产物不得提前宣称已发布）
    const metaPath = path.join(releaseFixture.dir, "dist/build-meta.json");
    const origMeta = fs.readFileSync(metaPath, "utf8");
    const tampered = JSON.parse(origMeta);
    tampered.released = true;
    fs.writeFileSync(metaPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    assert.throws(
      () => verifyDist({ projectRoot: releaseFixture.dir, mode: "release" }),
      /Pre-deploy build-meta\.json must keep released=false/,
    );
    assert.throws(
      () => runManifestGate({ projectRoot: releaseFixture.dir }),
      /Pre-deploy build-meta\.json must keep released=false/,
    );
    fs.writeFileSync(metaPath, origMeta, "utf8");

    // 5. 构建后工作区变脏（未提交修改）必须失败
    const cfgPath = path.join(releaseFixture.dir, "cloudflare.config.ts");
    const origCfg = fs.readFileSync(cfgPath, "utf8");
    fs.writeFileSync(cfgPath, `${origCfg}// uncommitted edit\n`, "utf8");
    assert.throws(
      () => verifyDist({ projectRoot: releaseFixture.dir, mode: "release" }),
      /Current working tree is dirty/,
    );
    assert.throws(
      () => runManifestGate({ projectRoot: releaseFixture.dir }),
      /Current working tree is dirty/,
    );

    // 6. 在脏工作区上直接重新构建（sourceDirty=true）也必须失败
    const dirtyBuilt = buildDist({ projectRoot: releaseFixture.dir });
    assert.equal(dirtyBuilt.meta.sourceDirty, true);
    assert.throws(
      () => verifyDist({ projectRoot: releaseFixture.dir, mode: "release" }),
      /Build artifact was generated from a dirty/,
    );
    assert.throws(
      () => runManifestGate({ projectRoot: releaseFixture.dir }),
      /Build artifact was generated from a dirty/,
    );

    // 7. cloudflare.config.ts 域名与 deploy/release.json 不一致必须失败
    fs.writeFileSync(
      cfgPath,
      origCfg.replace("avatar.conteman.com", "wrong.conteman.com"),
      "utf8",
    );
    runGit(releaseFixture.dir, ["add", "cloudflare.config.ts"]);
    runGit(releaseFixture.dir, ["commit", "-q", "-m", "test: 制造未授权域名偏差"]);
    buildDist({ projectRoot: releaseFixture.dir });
    assert.throws(
      () => verifyDist({ projectRoot: releaseFixture.dir, mode: "release" }),
      /do not match deploy\/release\.json allowedDomains/,
    );
    assert.throws(
      () => runManifestGate({ projectRoot: releaseFixture.dir }),
      /do not match deploy\/release\.json allowedDomains/,
    );
  } finally {
    fs.rmSync(releaseFixture.dir, { recursive: true, force: true });
  }
});

test("dist 本地预览满足静态资源、查询分享、Content-Type、缓存头与真实 404 策略", async () => {
  const { buildDist, readReleaseManifest } = await import("../scripts/build-dist.mjs");
  const { createPreviewServer } = await import("../scripts/preview-dist.mjs");

  const manifest = readReleaseManifest(PROJECT_ROOT);
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

    // 元数据与清单阶段一致且永不提前伪造已发布
    const metaRes = await httpRequest(port, "/build-meta.json");
    assert.equal(metaRes.status, 200);
    assert.equal(metaRes.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(metaRes.headers["cache-control"], "no-cache, must-revalidate");
    assert.equal(metaRes.headers["x-robots-tag"], "noindex");
    const meta = JSON.parse(metaRes.body.toString("utf8"));
    assert.equal(meta.stage, manifest.stage);
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
