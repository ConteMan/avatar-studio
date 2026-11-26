#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const DEFAULT_DIST_DIR = path.join(PROJECT_ROOT, "dist");

/**
 * 显式发布白名单：只包含应用入口、页面实际引用的静态资源及 Workers _headers 配置。
 * 绝不把仓库根目录直接作为静态资产目录。
 */
export const ASSET_WHITELIST = Object.freeze([
  { src: "index.html", dest: "index.html", publicAsset: true },
  { src: "assets/mark.svg", dest: "assets/mark.svg", publicAsset: true },
  { src: "assets/favicon-32.png", dest: "assets/favicon-32.png", publicAsset: true },
  { src: "deploy/_headers", dest: "_headers", publicAsset: false },
]);

export const RELEASE_MANIFEST_REL = "deploy/release.json";
export const VALID_STAGES = Object.freeze(["candidate", "release"]);
export const META_FILENAME = "build-meta.json";

export const EXPECTED_DIST_FILES = Object.freeze(
  [...ASSET_WHITELIST.map((item) => item.dest), META_FILENAME].sort(),
);

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function readReleaseManifest(projectRoot = PROJECT_ROOT) {
  const manifestPath = path.join(path.resolve(projectRoot), RELEASE_MANIFEST_REL);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing release manifest: ${RELEASE_MANIFEST_REL}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`Invalid JSON in ${RELEASE_MANIFEST_REL}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${RELEASE_MANIFEST_REL} must be a JSON object`);
  }
  if (!VALID_STAGES.includes(parsed.stage)) {
    throw new Error(`${RELEASE_MANIFEST_REL} stage must be one of ${VALID_STAGES.join(", ")}`);
  }
  if (typeof parsed.plannedVersion !== "string" || !parsed.plannedVersion.trim()) {
    throw new Error(`${RELEASE_MANIFEST_REL} plannedVersion must be a non-empty string`);
  }
  if (
    !Array.isArray(parsed.allowedDomains) ||
    !parsed.allowedDomains.every((d) => typeof d === "string" && d.trim().length > 0)
  ) {
    throw new Error(`${RELEASE_MANIFEST_REL} allowedDomains must be an array of non-empty strings`);
  }
  return {
    stage: parsed.stage,
    plannedVersion: parsed.plannedVersion.trim(),
    allowedDomains: parsed.allowedDomains.map((d) => d.trim()),
  };
}

export function readGitInfo(cwd) {
  const runGit = (args) => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };

  const commit = runGit(["rev-parse", "HEAD"]);
  const shortCommit = runGit(["rev-parse", "--short=12", "HEAD"]);
  const status = runGit(["status", "--porcelain"]);
  return {
    sourceCommit: commit || "unknown",
    sourceShortCommit: shortCommit || "unknown",
    sourceDirty: status === null ? null : status.length > 0,
  };
}

function assertSafeTargetDir(projectRoot, distDir) {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedDist = path.resolve(distDir);
  if (resolvedDist === resolvedRoot) {
    throw new Error("Refusing to clean project root as dist directory.");
  }
  const rel = path.relative(resolvedRoot, resolvedDist);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    // Allow explicit temporary test directories outside the repo only if named with dist leaf
    if (path.basename(resolvedDist) !== "dist") {
      throw new Error(`Refusing to clean unexpected directory: ${resolvedDist}`);
    }
  }
  if (fs.existsSync(resolvedDist)) {
    const stat = fs.lstatSync(resolvedDist);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to clean symlinked dist directory: ${resolvedDist}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Expected dist path to be a directory: ${resolvedDist}`);
    }
  }
}

export function buildDist(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const distDir = path.resolve(options.distDir || path.join(projectRoot, "dist"));

  assertSafeTargetDir(projectRoot, distDir);
  const releaseManifest = readReleaseManifest(projectRoot);

  // 清除本脚本拥有的旧 dist 产物，保证重复构建幂等无残留
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  const fileDigests = {};

  for (const entry of ASSET_WHITELIST) {
    const srcPath = path.join(projectRoot, entry.src);
    const destPath = path.join(distDir, entry.dest);

    if (!fs.existsSync(srcPath)) {
      throw new Error(`Missing whitelisted source file: ${entry.src}`);
    }
    const srcStat = fs.lstatSync(srcPath);
    if (!srcStat.isFile()) {
      throw new Error(`Whitelisted source is not a regular file: ${entry.src}`);
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const content = fs.readFileSync(srcPath);
    fs.writeFileSync(destPath, content);

    if (entry.publicAsset) {
      fileDigests[entry.dest] = {
        bytes: content.length,
        sha256: sha256Buffer(content),
      };
    }
  }

  const gitInfo = readGitInfo(projectRoot);
  const pkgPath = path.join(projectRoot, "package.json");
  let packageVersion = "0.1.0-candidate.0";
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (typeof pkg.version === "string" && pkg.version) {
        packageVersion = pkg.version;
      }
    } catch {
      // Keep default version if package.json is unavailable
    }
  }

  // 静态预发布产物始终保持 released=false：是否上线只能在实际部署并复测公开地址后确认，
  // 绝不在静态构建阶段提前宣称已发布。
  const meta = {
    app: "avatar-studio",
    stage: releaseManifest.stage,
    plannedVersion: releaseManifest.plannedVersion,
    packageVersion,
    released: false,
    sourceCommit: gitInfo.sourceCommit,
    sourceShortCommit: gitInfo.sourceShortCommit,
    sourceDirty: gitInfo.sourceDirty,
    files: fileDigests,
  };

  const metaJson = `${JSON.stringify(meta, null, 2)}\n`;
  fs.writeFileSync(path.join(distDir, META_FILENAME), metaJson, "utf8");

  return {
    distDir,
    files: EXPECTED_DIST_FILES,
    meta,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const result = buildDist();
  console.log(`Built ${result.files.length} files into dist/ (commit ${result.meta.sourceShortCommit}, stage=${result.meta.stage}):`);
  for (const rel of result.files) {
    const fullPath = path.join(result.distDir, rel);
    const buf = fs.readFileSync(fullPath);
    console.log(`  - ${rel} (${buf.length} bytes, sha256=${sha256Buffer(buf).slice(0, 16)}...)`);
  }
}
