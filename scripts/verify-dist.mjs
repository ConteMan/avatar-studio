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
} from "./build-dist.mjs";
import { parseHeadersFile } from "./preview-dist.mjs";

const __filename = fileURLToPath(import.meta.url);

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

export function verifyDist(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const distDir = path.resolve(options.distDir || DEFAULT_DIST_DIR);
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

  // 6. 校验 build-meta.json 安全且不伪造发布状态
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
      if (meta.stage !== "candidate" || meta.released !== false) {
        errors.push("Candidate build-meta.json must declare stage='candidate' and released=false");
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

  // 7. 核对 cf 配置唯一且不冲突、不用 SPA 回退掩盖缺失资产
  const cfConfigPath = path.join(projectRoot, "cloudflare.config.ts");
  if (!fs.existsSync(cfConfigPath)) {
    errors.push("Missing cloudflare.config.ts");
  } else {
    const cfConfigText = fs.readFileSync(cfConfigPath, "utf8");
    if (/notFoundHandling\s*:\s*["']single-page-application["']/.test(cfConfigText)) {
      errors.push("cloudflare.config.ts must not use single-page-application fallback");
    }
    if (!/notFoundHandling\s*:\s*["']none["']/.test(cfConfigText)) {
      errors.push('cloudflare.config.ts should explicitly set notFoundHandling: "none"');
    }
    if (!/workersDev\s*:\s*false/.test(cfConfigText)) {
      errors.push("Candidate cloudflare.config.ts should keep workersDev: false");
    }
    if (/^\s*domains\s*:/m.test(cfConfigText)) {
      errors.push("Candidate cloudflare.config.ts must not apply production domains before approval");
    }
  }

  for (const legacy of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    if (fs.existsSync(path.join(projectRoot, legacy))) {
      errors.push(`Conflicting legacy Wrangler config present alongside cf config: ${legacy}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`dist verification failed:\n- ${errors.join("\n- ")}`);
  }

  return {
    distDir,
    files: actualFiles,
    meta,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const result = verifyDist();
  console.log(`Verified dist/ whitelist (${result.files.length} files): ${result.files.join(", ")}`);
}
