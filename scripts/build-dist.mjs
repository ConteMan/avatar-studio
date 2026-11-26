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

export const META_FILENAME = "build-meta.json";

export const EXPECTED_DIST_FILES = Object.freeze(
  [...ASSET_WHITELIST.map((item) => item.dest), META_FILENAME].sort(),
);

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function readGitInfo(cwd) {
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
    // Allow explicit temporary test directories outside the repo only if named with dist prefix/leaf
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
  let candidateVersion = "0.1.0-candidate.0";
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (typeof pkg.version === "string" && pkg.version) {
        candidateVersion = pkg.version;
      }
    } catch {
      // Keep default candidate version if package.json is unavailable
    }
  }

  const meta = {
    app: "avatar-studio",
    stage: "candidate",
    plannedVersion: "0.1.0",
    candidateVersion,
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
