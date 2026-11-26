#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DIST_DIR,
  PROJECT_ROOT,
  VALID_STAGES,
  readGitInfo,
  readReleaseManifest,
} from "./build-dist.mjs";
import { verifyDist } from "./verify-dist.mjs";

const __filename = fileURLToPath(import.meta.url);
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * CI / 清单驱动门禁入口：
 * - 从受版本控制的 deploy/release.json 读取显式 stage（candidate | release），未知或缺失立即失败。
 * - 始终绑定当前实际检出的干净提交（git rev-parse HEAD），适配 GitHub PR 合并提交检出，不混用 head SHA。
 * - candidate 阶段拒绝任何生产 domains 与非 candidate 配置；
 * - release 阶段强制执行干净树、精确提交 SHA、domains 与 allowedDomains 一致、released=false 及全部安全/白名单校验。
 */
export function runManifestGate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const distDir = path.resolve(options.distDir || path.join(projectRoot, "dist"));

  const manifest = readReleaseManifest(projectRoot);
  if (!VALID_STAGES.includes(manifest.stage)) {
    throw new Error(`Unsupported stage in deploy/release.json: ${manifest.stage}`);
  }

  const gitInfo = readGitInfo(projectRoot);
  if (!FULL_SHA_RE.test(gitInfo.sourceCommit || "")) {
    throw new Error(`Cannot determine checked-out git HEAD commit (got: ${gitInfo.sourceCommit})`);
  }

  const result = verifyDist({
    projectRoot,
    distDir,
    mode: manifest.stage,
    requireClean: true,
    expectCommit: gitInfo.sourceCommit,
  });

  return {
    ...result,
    checkedOutCommit: gitInfo.sourceCommit,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const res = runManifestGate({ projectRoot: PROJECT_ROOT, distDir: DEFAULT_DIST_DIR });
  console.log(
    `Verified manifest gate [stage=${res.mode}] on clean commit ${res.checkedOutCommit} (${res.files.length} files): ${res.files.join(", ")}`,
  );
}
