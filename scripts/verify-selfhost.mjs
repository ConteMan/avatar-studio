#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SELFHOST_DIR,
  FORBIDDEN_PREFIXES,
  PROJECT_ROOT,
  assertSafeOutputDir,
  computeSelfhostBuildPlan,
  escapeHtml,
  parseCliArgs,
  sha256Buffer,
} from "./build-selfhost.mjs";

const __filename = fileURLToPath(import.meta.url);

function walkFiles(rootDir, prefix = "") {
  const results = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Unexpected symlink in self-host output: ${rel}`);
    }
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, rel));
    } else if (entry.isFile()) {
      results.push(rel);
    } else {
      throw new Error(`Unexpected non-file entry in self-host output: ${rel}`);
    }
  }
  return results.sort();
}

export function extractLocalAssetRefs(html) {
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

export function verifySelfhost(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const outDir = path.resolve(
    projectRoot,
    options.outDir || path.join(projectRoot, "dist-selfhost"),
  );

  // 1. 校验输出目录安全边界、配置、源资产和源 index.html，并在内存中计算预期白名单产物
  const safeOutDir = assertSafeOutputDir(projectRoot, outDir);
  const plan = computeSelfhostBuildPlan({
    projectRoot,
    configPath: options.configPath,
  });

  if (!fs.existsSync(safeOutDir)) {
    throw new Error(`Self-host output directory does not exist: ${outDir}. Run "npm run build:selfhost" first.`);
  }
  const outStat = fs.lstatSync(safeOutDir);
  if (outStat.isSymbolicLink() || !outStat.isDirectory()) {
    throw new Error(`Self-host output path must be a regular directory: ${outDir}`);
  }

  const errors = [];

  // 2. 遍历实际输出目录（拒绝符号链接和特殊文件）
  let actualFiles;
  try {
    actualFiles = walkFiles(safeOutDir);
  } catch (err) {
    throw new Error(`selfhost verification failed:\n- ${err.message}`);
  }

  // 3. 严格白名单文件集合检查（禁止多出或缺失文件）
  const extraFiles = actualFiles.filter((f) => !plan.expectedFiles.includes(f));
  const missingFiles = plan.expectedFiles.filter((f) => !actualFiles.includes(f));
  if (extraFiles.length > 0) {
    errors.push(`Unexpected files in self-host output: ${extraFiles.join(", ")}`);
  }
  if (missingFiles.length > 0) {
    errors.push(`Missing whitelisted files in self-host output: ${missingFiles.join(", ")}`);
  }

  // 4. 禁止泄露仓库内部目录、配置文件、源码或 Workers 控制文件
  for (const file of actualFiles) {
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (file === prefix || file.startsWith(prefix)) {
        errors.push(`Forbidden path leaked into self-host output: ${file}`);
      }
    }
  }

  // 5. 逐字节比对所有白名单文件，检测配置修改/资产变更/手动篡改导致的漂移
  const configLabel = path.relative(projectRoot, plan.configPath) || path.basename(plan.configPath);
  for (const rel of plan.expectedFiles) {
    const actualPath = path.join(safeOutDir, rel);
    if (!fs.existsSync(actualPath)) continue;
    const actualBuf = fs.readFileSync(actualPath);
    const actualHash = sha256Buffer(actualBuf);
    const expected = plan.files.get(rel);
    if (actualHash !== expected.sha256) {
      if (rel === "index.html") {
        errors.push(
          `Artifact drift in index.html: built HTML does not match current index.html + ${configLabel} (re-run build:selfhost)`,
        );
      } else {
        errors.push(
          `Artifact drift in ${rel}: built asset differs from source "${expected.source}" (re-run build:selfhost)`,
        );
      }
    }
  }

  // 6. 检查产物 index.html 的全部本地引用与品牌字段渲染结果
  const builtIndexPath = path.join(safeOutDir, "index.html");
  if (fs.existsSync(builtIndexPath)) {
    const html = fs.readFileSync(builtIndexPath, "utf8");
    const refs = extractLocalAssetRefs(html);

    for (const ref of refs) {
      if (ref.startsWith("rounds/")) {
        errors.push(`Built index.html must not reference master asset path directly: ${ref}`);
      }
      if (!actualFiles.includes(ref)) {
        errors.push(`Built index.html references missing output asset: ${ref}`);
      }
    }

    // 确认输出目录中的每个非 index.html 资产都被页面实际引用，没有冗余死文件
    for (const file of actualFiles) {
      if (file !== "index.html" && !refs.includes(file)) {
        errors.push(`Unreferenced asset file in self-host output: ${file}`);
      }
    }

    // 不在当前范围引入分享卡 OpenGraph 标签
    if (/property\s*=\s*["']og:/i.test(html)) {
      errors.push("Built index.html unexpectedly contains OpenGraph share card tags");
    }

    // 核对渲染后的品牌字段
    const expectedTitle = `<title>${escapeHtml(plan.config.title)}</title>`;
    if (!html.includes(expectedTitle)) {
      errors.push("Built index.html <title> does not match configured title");
    }

    const expectedDesc = `<meta name="description" content="${escapeHtml(plan.config.description)}">`;
    if (!html.includes(expectedDesc)) {
      errors.push('Built index.html <meta name="description"> does not match configured description');
    }

    const expectedH1 = `<h1>${escapeHtml(plan.config.siteName)}</h1>`;
    const h1Match = html.match(/<header\b[^>]*>[\s\S]*?<h1\b[^>]*>([\s\S]*?)<\/h1>[\s\S]*?<\/header>/i);
    if (!h1Match || h1Match[1] !== escapeHtml(plan.config.siteName)) {
      errors.push(`Built index.html header <h1> does not match configured siteName (expected ${expectedH1})`);
    }

    const logoMatch = html.match(/<header\b[^>]*>[\s\S]*?(<img\b[^>]*\bclass\s*=\s*(?:"[^"]*\bmark\b[^"]*"|'[^']*\bmark\b[^']*')[^>]*>)[\s\S]*?<\/header>/i);
    if (!logoMatch || !new RegExp(`\\bsrc=["']${plan.logo.dest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(logoMatch[1])) {
      errors.push(`Built index.html header logo does not reference ${plan.logo.dest}`);
    }

    for (const fav of plan.favicons) {
      const escapedHref = fav.dest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const escapedMime = fav.mime.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const favRe = new RegExp(`<link\\s+rel="icon"\\s+href="${escapedHref}"(?:\\s+sizes="\\d+x\\d+")?\\s+type="${escapedMime}">`);
      if (!favRe.test(html)) {
        errors.push(`Built index.html is missing expected favicon link for ${fav.dest} (${fav.mime})`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`selfhost verification failed:\n- ${errors.join("\n- ")}`);
  }

  return {
    outDir,
    configPath: plan.configPath,
    config: plan.config,
    files: actualFiles,
    digests: plan.digests,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const cliOpts = parseCliArgs(process.argv.slice(2));
  const result = verifySelfhost({
    projectRoot: PROJECT_ROOT,
    configPath: cliOpts.configPath || undefined,
    outDir: cliOpts.outDir || DEFAULT_SELFHOST_DIR,
  });
  const displayOut = path.relative(PROJECT_ROOT, result.outDir) || result.outDir;
  console.log(
    `Verified ${displayOut}/ (brand="${result.config.siteName}", ${result.files.length} files): ${result.files.join(", ")}`,
  );
}
