#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSET_WHITELIST,
  DEFAULT_DIST_DIR,
  EXPECTED_DIST_FILES,
  META_FILENAME,
  PROJECT_ROOT,
  RELEASE_MANIFEST_REL,
  VALID_STAGES,
  readGitInfo,
  readReleaseManifest,
} from "./build-dist.mjs";
import { parseHeadersFile } from "./preview-dist.mjs";

const __filename = fileURLToPath(import.meta.url);

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function walkFiles(rootDir, prefix = "") {
  const results = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Unexpected symlink in dist/: ${rel}`);
    }
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, rel));
    } else if (entry.isFile()) {
      results.push(rel);
    } else {
      throw new Error(`Unexpected non-file entry in dist/: ${rel}`);
    }
  }
  return results.sort();
}

function extractLocalAssetRefs(html) {
  const refs = new Set();
  const attrRe = /\b(?:href|src)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  let match;
  while ((match = attrRe.exec(html)) !== null) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) {
      continue;
    }
    const clean = raw.split(/[?#]/)[0].replace(/^\/+/, "");
    if (clean) refs.add(clean);
  }
  return [...refs].sort();
}

/**
 * 去除 TypeScript/JS 单行与块级注释（跳过字符串字面量），避免注释中的示例干扰配置解析。
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  let inStr = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\" && i + 1 < source.length) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 解析 cloudflare.config.ts 中与静态资产发布门禁相关的关键字段（无需 npm 依赖）。
 */
export function inspectCloudflareConfig(cfConfigText) {
  const code = stripComments(cfConfigText);
  const notFoundMatch = code.match(/\bnotFoundHandling\s*:\s*["']([^"']+)["']/);
  const workersDevMatch = code.match(/\bworkersDev\s*:\s*(true|false)\b/);
  const hasEntrypoint = /\bentrypoint\s*:/.test(code);

  const domainsFieldMatch = code.match(/\bdomains\s*:\s*\[([\s\S]*?)\]/);
  const hasDomainsProperty = /\bdomains\s*:/.test(code);
  let domains = [];
  let domainsParseError = null;

  if (hasDomainsProperty) {
    if (!domainsFieldMatch) {
      domainsParseError = "cloudflare.config.ts domains must be an explicit array literal";
    } else {
      const inner = domainsFieldMatch[1].trim();
      if (inner.length > 0) {
        const items = [];
        // 仅允许静态字符串字面量或 { hostname: "..." } 对象字面量，防止动态绕过
        const strRe = /"([^"]+)"|'([^']+)'/g;
        let m;
        while ((m = strRe.exec(inner)) !== null) {
          items.push((m[1] ?? m[2]).trim());
        }
        const remainder = inner.replace(/"[^"]*"|'[^']*'|[\s,]/g, "");
        if (remainder.length > 0) {
          domainsParseError = "cloudflare.config.ts domains must contain static string hostnames only";
        } else {
          domains = items;
        }
      }
    }
  }

  return {
    notFoundHandling: notFoundMatch ? notFoundMatch[1] : null,
    workersDev: workersDevMatch ? workersDevMatch[1] === "true" : null,
    hasEntrypoint,
    hasDomainsProperty,
    domains,
    domainsParseError,
  };
}

export function parseCliArgs(argv) {
  const opts = {
    mode: "candidate",
    requireClean: false,
    expectCommit: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      if (!argv[i + 1]) throw new Error("Missing value for --mode");
      opts.mode = argv[++i];
    } else if (arg.startsWith("--mode=")) {
      opts.mode = arg.slice("--mode=".length);
    } else if (arg === "--require-clean") {
      opts.requireClean = true;
    } else if (arg === "--expect-commit") {
      if (!argv[i + 1]) throw new Error("Missing value for --expect-commit");
      opts.expectCommit = argv[++i].trim();
    } else if (arg.startsWith("--expect-commit=")) {
      opts.expectCommit = arg.slice("--expect-commit=".length).trim();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

export function verifyDist(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const distDir = path.resolve(options.distDir || path.join(projectRoot, "dist"));
  const mode = options.mode || "candidate";
  if (!VALID_STAGES.includes(mode)) {
    throw new Error(`Invalid verification mode "${mode}". Expected one of: ${VALID_STAGES.join(", ")}`);
  }
  const requireClean =
    options.requireClean !== undefined ? Boolean(options.requireClean) : mode === "release";
  const expectCommit = options.expectCommit ? String(options.expectCommit).trim() : null;

  const errors = [];

  if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
    throw new Error(`dist directory does not exist: ${distDir}`);
  }

  // 1. 严格白名单文件集合检查（禁止任何多出或缺失文件）
  const actualFiles = walkFiles(distDir);
  const expectedFiles = [...EXPECTED_DIST_FILES].sort();

  const extraFiles = actualFiles.filter((f) => !expectedFiles.includes(f));
  const missingFiles = expectedFiles.filter((f) => !actualFiles.includes(f));
  if (extraFiles.length > 0) {
    errors.push(`Unexpected files in dist/: ${extraFiles.join(", ")}`);
  }
  if (missingFiles.length > 0) {
    errors.push(`Missing whitelisted files in dist/: ${missingFiles.join(", ")}`);
  }

  // 2. 禁止包含任何敏感目录或源码/配置/凭据路径
  const forbiddenPrefixes = [
    "docs/",
    "rounds/",
    "tests/",
    "scripts/",
    ".git",
    ".github",
    "node_modules/",
    ".env",
    ".cloudflare",
  ];
  for (const file of actualFiles) {
    for (const prefix of forbiddenPrefixes) {
      if (file === prefix || file.startsWith(prefix)) {
        errors.push(`Forbidden path leaked into dist/: ${file}`);
      }
    }
  }

  // 3. 逐字节比对所有白名单源产物
  for (const entry of ASSET_WHITELIST) {
    const srcPath = path.join(projectRoot, entry.src);
    const destPath = path.join(distDir, entry.dest);
    if (fs.existsSync(srcPath) && fs.existsSync(destPath)) {
      if (sha256File(srcPath) !== sha256File(destPath)) {
        errors.push(`Hash mismatch between ${entry.src} and dist/${entry.dest}`);
      }
    }
  }

  // 4. 核对 index.html 引用的全部本地静态资源都在 dist/ 中，且未引用 rounds/
  const distIndexPath = path.join(distDir, "index.html");
  if (fs.existsSync(distIndexPath)) {
    const html = fs.readFileSync(distIndexPath, "utf8");
    const refs = extractLocalAssetRefs(html);
    for (const ref of refs) {
      if (ref.startsWith("rounds/")) {
        errors.push(`index.html must not reference master asset path directly: ${ref}`);
      }
      if (!actualFiles.includes(ref)) {
        errors.push(`index.html references missing dist asset: ${ref}`);
      }
    }
  }

  // 5. 校验 _headers 规则无重叠 Cache-Control 冲突
  const distHeadersPath = path.join(distDir, "_headers");
  if (fs.existsSync(distHeadersPath)) {
    const rules = parseHeadersFile(fs.readFileSync(distHeadersPath, "utf8"));
    const samplePaths = ["/", "/index.html", "/assets/mark.svg", "/assets/favicon-32.png", "/build-meta.json"];
    for (const samplePath of samplePaths) {
      let ccCount = 0;
      for (const rule of rules) {
        const escaped = rule.pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        if (!new RegExp(`^${escaped}$`).test(samplePath)) continue;
        for (const op of rule.ops) {
          if (op.name.toLowerCase() === "cache-control") {
            if (op.type === "detach") ccCount = 0;
            else ccCount += 1;
          }
        }
      }
      if (ccCount > 1) {
        errors.push(`Conflicting duplicate Cache-Control directives in _headers for ${samplePath}`);
      }
    }
  }

  // 6. 读取并校验 deploy/release.json 阶段与域名清单
  let releaseManifest = null;
  try {
    releaseManifest = readReleaseManifest(projectRoot);
  } catch (err) {
    errors.push(err.message);
  }

  if (releaseManifest) {
    if (releaseManifest.stage !== mode) {
      errors.push(
        `${RELEASE_MANIFEST_REL} stage="${releaseManifest.stage}" does not match verification mode="${mode}"`,
      );
    }
    if (mode === "candidate") {
      if (releaseManifest.allowedDomains.length > 0) {
        errors.push(
          `Candidate ${RELEASE_MANIFEST_REL} must keep allowedDomains empty (got: ${releaseManifest.allowedDomains.join(", ")})`,
        );
      }
    } else if (mode === "release") {
      if (releaseManifest.allowedDomains.length === 0) {
        errors.push(`Release ${RELEASE_MANIFEST_REL} must list at least one approved domain in allowedDomains`);
      }
      for (const d of releaseManifest.allowedDomains) {
        if (!HOSTNAME_RE.test(d)) {
          errors.push(`Invalid hostname in ${RELEASE_MANIFEST_REL} allowedDomains: ${d}`);
        }
      }
    }
  }

  // 7. 校验 build-meta.json 安全、阶段一致且永不在预发布产物中伪造已发布
  const metaPath = path.join(distDir, META_FILENAME);
  let meta = null;
  if (fs.existsSync(metaPath)) {
    const rawMeta = fs.readFileSync(metaPath, "utf8");
    if (/\/Users\/|\/home\/|[A-Za-z]:\\/.test(rawMeta)) {
      errors.push("build-meta.json must not contain local machine paths");
    }
    try {
      meta = JSON.parse(rawMeta);
      if (meta.app !== "avatar-studio") errors.push(`Unexpected meta.app: ${meta.app}`);
      if (meta.stage !== mode) {
        errors.push(`build-meta.json stage="${meta.stage}" does not match verification mode="${mode}"`);
      }
      if (meta.released !== false) {
        errors.push("Pre-deploy build-meta.json must keep released=false (never claim released before deployment)");
      }
      for (const entry of ASSET_WHITELIST.filter((e) => e.publicAsset)) {
        const recorded = meta.files?.[entry.dest];
        const actualHash = sha256File(path.join(distDir, entry.dest));
        if (!recorded || recorded.sha256 !== actualHash) {
          errors.push(`build-meta.json digest mismatch for ${entry.dest}`);
        }
      }
    } catch (err) {
      errors.push(`Invalid JSON in build-meta.json: ${err.message}`);
    }
  }

  // 8. 干净工作区与提交 SHA 精确绑定校验（release 模式默认强制启用，candidate 可通过参数开启）
  if (requireClean || expectCommit) {
    const liveGit = readGitInfo(projectRoot);
    if (!meta) {
      errors.push("Cannot verify commit/clean state without valid build-meta.json");
    } else {
      if (requireClean) {
        if (meta.sourceDirty !== false) {
          errors.push(`Build artifact was generated from a dirty or unknown working tree (sourceDirty=${meta.sourceDirty})`);
        }
        if (liveGit.sourceDirty !== false) {
          errors.push(`Current working tree is dirty or not a git repository (git sourceDirty=${liveGit.sourceDirty})`);
        }
        if (!FULL_SHA_RE.test(meta.sourceCommit || "")) {
          errors.push(`Invalid sourceCommit in build-meta.json: ${meta.sourceCommit}`);
        } else if (liveGit.sourceCommit !== meta.sourceCommit) {
          errors.push(
            `Stale build-meta.json sourceCommit (${meta.sourceCommit}) does not match current HEAD (${liveGit.sourceCommit})`,
          );
        }
      }
      if (expectCommit) {
        if (!FULL_SHA_RE.test(expectCommit)) {
          errors.push(`--expect-commit must be a full 40-character git SHA (got: ${expectCommit})`);
        } else {
          if (meta.sourceCommit !== expectCommit) {
            errors.push(`build-meta.json sourceCommit (${meta.sourceCommit}) does not match expected commit (${expectCommit})`);
          }
          if (liveGit.sourceCommit !== expectCommit) {
            errors.push(`Current HEAD (${liveGit.sourceCommit}) does not match expected commit (${expectCommit})`);
          }
        }
      }
    }
  }

  // 9. 核对 cf 配置唯一、安全且与当前模式/许可域名严格一致
  const cfConfigPath = path.join(projectRoot, "cloudflare.config.ts");
  if (!fs.existsSync(cfConfigPath)) {
    errors.push("Missing cloudflare.config.ts");
  } else {
    const cfConfigText = fs.readFileSync(cfConfigPath, "utf8");
    const parsedCf = inspectCloudflareConfig(cfConfigText);

    if (parsedCf.hasEntrypoint) {
      errors.push("cloudflare.config.ts must not configure a server entrypoint (assets-only Worker)");
    }
    if (parsedCf.notFoundHandling === "single-page-application") {
      errors.push("cloudflare.config.ts must not use single-page-application fallback");
    }
    if (parsedCf.notFoundHandling !== "none") {
      errors.push(`cloudflare.config.ts must explicitly set notFoundHandling: "none" (got: ${parsedCf.notFoundHandling})`);
    }
    if (parsedCf.workersDev !== false) {
      errors.push(`cloudflare.config.ts must keep workersDev: false (got: ${parsedCf.workersDev})`);
    }
    if (parsedCf.domainsParseError) {
      errors.push(parsedCf.domainsParseError);
    } else if (mode === "candidate") {
      if (parsedCf.hasDomainsProperty || parsedCf.domains.length > 0) {
        errors.push("Candidate cloudflare.config.ts must not apply production domains before approval");
      }
    } else if (mode === "release") {
      if (parsedCf.domains.length === 0) {
        errors.push("Release cloudflare.config.ts must configure approved domains");
      } else if (releaseManifest) {
        const expectedDomains = [...releaseManifest.allowedDomains].sort();
        const actualDomains = [...parsedCf.domains].sort();
        if (JSON.stringify(actualDomains) !== JSON.stringify(expectedDomains)) {
          errors.push(
            `cloudflare.config.ts domains [${actualDomains.join(", ")}] do not match ${RELEASE_MANIFEST_REL} allowedDomains [${expectedDomains.join(", ")}]`,
          );
        }
      }
    }
  }

  for (const legacy of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    if (fs.existsSync(path.join(projectRoot, legacy))) {
      errors.push(`Conflicting legacy Wrangler config present alongside cf config: ${legacy}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`dist verification (${mode}) failed:\n- ${errors.join("\n- ")}`);
  }

  return {
    distDir,
    mode,
    files: actualFiles,
    meta,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const cliOpts = parseCliArgs(process.argv.slice(2));
  const result = verifyDist(cliOpts);
  console.log(`Verified dist/ [${result.mode}] (${result.files.length} files): ${result.files.join(", ")}`);
}
