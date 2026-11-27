#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePackageVersion, readPackageVersion } from "./package-version.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const DEFAULT_SELFHOST_CONFIG_REL = "site.config.json";
export const DEFAULT_SELFHOST_DIR = path.join(PROJECT_ROOT, "dist-selfhost");

export const ALLOWED_TOP_LEVEL_KEYS = Object.freeze([
  "siteName",
  "title",
  "description",
  "logo",
  "favicon",
]);

export const ALLOWED_FAVICON_KEYS = Object.freeze(["svg", "png", "ico"]);

const LOGO_EXTENSIONS = new Set([".svg", ".png", ".webp", ".jpg", ".jpeg"]);
const FAVICON_STRING_EXTENSIONS = new Set([".svg", ".png", ".ico", ".webp"]);
const MAX_ASSET_BYTES = 2 * 1024 * 1024; // 2 MiB
// 定稿母版 rounds/R05-2026-11-26/shu.svg 的 SHA-256：母版始终禁止进入自建产物
const LOGO_MASTER_SHA256 = "1376fb705bb7a10c74c2a8f6f746c93cb44313e4ddf86da3895c6b9569d4317f";

const TEXT_LIMITS = Object.freeze({
  siteName: 80,
  title: 120,
  description: 300,
});

const PROTECTED_ROOT_DIRS = new Set([
  "dist",
  "assets",
  "deploy",
  "docs",
  "rounds",
  "scripts",
  "tests",
  ".git",
  ".github",
  "node_modules",
  ".cloudflare",
]);

export const FORBIDDEN_PREFIXES = Object.freeze([
  "docs/",
  "rounds/",
  "tests/",
  "scripts/",
  "deploy/",
  "dist/",
  ".git",
  ".github",
  "node_modules/",
  ".env",
  ".cloudflare",
  "site.config.json",
  "site.config.example.json",
  "package.json",
  "package-lock.json",
  "cloudflare.config.ts",
  "_headers",
  "_redirects",
  "build-meta.json",
]);

const MIME_BY_EXT = Object.freeze({
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
});

export function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTextField(obj, field, maxLen, errors) {
  const raw = obj[field];
  if (typeof raw !== "string") {
    errors.push(`Config field "${field}" must be a non-empty string`);
    return "";
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    errors.push(`Config field "${field}" must not contain control characters or newlines`);
    return "";
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    errors.push(`Config field "${field}" must be a non-empty string`);
    return "";
  }
  if (trimmed.length > maxLen) {
    errors.push(`Config field "${field}" exceeds maximum length of ${maxLen} characters (got ${trimmed.length})`);
    return "";
  }
  return trimmed;
}

function checkForbiddenAssetPath(relPosix, fieldName, displayPath, errors) {
  const segments = relPosix.split("/");
  if (segments.some((seg) => seg.startsWith("."))) {
    errors.push(`Config field "${fieldName}" must not reference hidden dotfiles/directories: ${displayPath}`);
    return false;
  }

  // 统一转小写检查，兼容大小写不敏感文件系统（macOS/Windows）
  const lower = relPosix.toLowerCase();
  if (lower === "rounds" || lower.startsWith("rounds/")) {
    errors.push(`Config field "${fieldName}" must not reference master logo directory "rounds/": ${displayPath}`);
    return false;
  }
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (lower === prefix || lower.startsWith(prefix)) {
      errors.push(`Config field "${fieldName}" points to a forbidden repository path: ${displayPath}`);
      return false;
    }
  }
  if (lower === "dist-selfhost" || lower.startsWith("dist-selfhost/")) {
    errors.push(`Config field "${fieldName}" must not reference generated output directory "dist-selfhost/": ${displayPath}`);
    return false;
  }
  return true;
}

function normalizeAssetRelPath(rawValue, fieldName, allowedExts, errors) {
  if (typeof rawValue !== "string") {
    errors.push(`Config field "${fieldName}" must be a relative local file path string`);
    return null;
  }
  if (/[\u0000-\u001f\u007f]/.test(rawValue)) {
    errors.push(`Config field "${fieldName}" must not contain control characters`);
    return null;
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    errors.push(`Config field "${fieldName}" must be a non-empty relative path`);
    return null;
  }
  if (trimmed.includes("\\")) {
    errors.push(`Config field "${fieldName}" must use POSIX forward slashes ("/"): ${trimmed}`);
    return null;
  }
  if (trimmed.includes("?") || trimmed.includes("#")) {
    errors.push(`Config field "${fieldName}" must not include query strings or hash fragments: ${trimmed}`);
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
    errors.push(`Config field "${fieldName}" must be a local file path, not an external/data URL: ${trimmed}`);
    return null;
  }
  if (trimmed.startsWith("/")) {
    errors.push(`Config field "${fieldName}" must be a relative path, not an absolute path: ${trimmed}`);
    return null;
  }

  const segments = trimmed.split("/");
  if (segments.some((seg) => !seg || seg === "." || seg === "..")) {
    errors.push(`Config field "${fieldName}" contains invalid path segments ("..", "." or empty): ${trimmed}`);
    return null;
  }

  const normalized = segments.join("/");
  if (!checkForbiddenAssetPath(normalized, fieldName, normalized, errors)) {
    return null;
  }

  const ext = path.extname(normalized).toLowerCase();
  if (!allowedExts.has(ext)) {
    errors.push(
      `Config field "${fieldName}" has unsupported file extension "${ext || "(none)"}" (allowed: ${[...allowedExts].join(", ")})`,
    );
    return null;
  }

  return { normalized, ext };
}

function validateAssetContent(buffer, ext, fieldName, sourceRel, errors) {
  if (buffer.length === 0) {
    errors.push(`Asset file for "${fieldName}" is empty: ${sourceRel}`);
    return {};
  }
  if (buffer.length > MAX_ASSET_BYTES) {
    errors.push(`Asset file for "${fieldName}" exceeds ${MAX_ASSET_BYTES} bytes (${buffer.length} bytes): ${sourceRel}`);
    return {};
  }

  if (ext === ".svg") {
    if (buffer.includes(0)) {
      errors.push(`SVG asset for "${fieldName}" contains NUL bytes: ${sourceRel}`);
      return {};
    }
    const text = buffer.toString("utf8");
    if (!/<svg\b/i.test(text) || !/<\/svg>/i.test(text)) {
      errors.push(`SVG asset for "${fieldName}" does not contain a valid <svg>...</svg> element: ${sourceRel}`);
      return {};
    }
    const unsafePatterns = [
      { re: /<(?:script|foreignObject|iframe|object|embed|image|use)\b/i, reason: "disallowed active/external SVG tag" },
      { re: /\bon[a-z]+\s*=/i, reason: "inline event handler attribute" },
      { re: /\b(?:javascript|vbscript):/i, reason: "script URI scheme" },
      { re: /\bxlink:href\b/i, reason: "xlink:href reference" },
      { re: /@import\b/i, reason: "CSS @import rule" },
      { re: /\bdata:/i, reason: "embedded data: URI" },
    ];
    for (const { re, reason } of unsafePatterns) {
      if (re.test(text)) {
        errors.push(`SVG asset for "${fieldName}" failed self-contained safety check (${reason}): ${sourceRel}`);
        return {};
      }
    }
    const urlRe = /url\(\s*([^)]*?)\s*\)/gi;
    let urlMatch;
    while ((urlMatch = urlRe.exec(text)) !== null) {
      const inner = urlMatch[1].trim().replace(/^["']|["']$/g, "");
      if (!inner.startsWith("#")) {
        errors.push(`SVG asset for "${fieldName}" must not contain external url() references: ${sourceRel}`);
        return {};
      }
    }
    return {};
  }

  if (ext === ".png") {
    const sig = buffer.subarray(0, 8).toString("hex");
    if (buffer.length < 24 || sig !== "89504e470d0a1a0a" || buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
      errors.push(`PNG asset for "${fieldName}" has invalid PNG header: ${sourceRel}`);
      return {};
    }
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 4096 || height > 4096) {
      errors.push(`PNG asset for "${fieldName}" has invalid dimensions (${width}x${height}): ${sourceRel}`);
      return {};
    }
    return { width, height };
  }

  if (ext === ".ico") {
    if (
      buffer.length < 6 ||
      buffer[0] !== 0x00 ||
      buffer[1] !== 0x00 ||
      buffer[2] !== 0x01 ||
      buffer[3] !== 0x00 ||
      buffer.readUInt16LE(4) < 1
    ) {
      errors.push(`ICO asset for "${fieldName}" has invalid ICO header: ${sourceRel}`);
      return {};
    }
    return {};
  }

  if (ext === ".webp") {
    if (
      buffer.length < 12 ||
      buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
      buffer.subarray(8, 12).toString("ascii") !== "WEBP"
    ) {
      errors.push(`WebP asset for "${fieldName}" has invalid WebP header: ${sourceRel}`);
      return {};
    }
    return {};
  }

  if (ext === ".jpg" || ext === ".jpeg") {
    if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
      errors.push(`JPEG asset for "${fieldName}" has invalid JPEG header: ${sourceRel}`);
      return {};
    }
    return {};
  }

  return {};
}

function readAndValidateAsset(projectRoot, projectRealRoot, fieldName, rawValue, allowedExts, errors) {
  const norm = normalizeAssetRelPath(rawValue, fieldName, allowedExts, errors);
  if (!norm) return null;

  const fullPath = path.resolve(projectRoot, norm.normalized);
  const relFromRoot = path.relative(projectRoot, fullPath);
  if (!relFromRoot || relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
    errors.push(`Asset path for "${fieldName}" escapes project root: ${norm.normalized}`);
    return null;
  }

  if (!fs.existsSync(fullPath)) {
    errors.push(`Missing asset file for "${fieldName}": ${norm.normalized}`);
    return null;
  }

  const stat = fs.lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    errors.push(`Asset file for "${fieldName}" must not be a symlink: ${norm.normalized}`);
    return null;
  }
  if (!stat.isFile()) {
    errors.push(`Asset path for "${fieldName}" is not a regular file: ${norm.normalized}`);
    return null;
  }

  const realFull = fs.realpathSync(fullPath);
  const realRel = path.relative(projectRealRoot, realFull);
  if (!realRel || realRel.startsWith("..") || path.isAbsolute(realRel)) {
    errors.push(`Asset path for "${fieldName}" resolves outside project root via symlinked directory: ${norm.normalized}`);
    return null;
  }

  const realRelPosix = realRel.split(path.sep).join("/");
  if (!checkForbiddenAssetPath(realRelPosix, fieldName, `${norm.normalized} -> ${realRelPosix}`, errors)) {
    return null;
  }

  const buffer = fs.readFileSync(realFull);
  const sha256 = sha256Buffer(buffer);
  if (sha256 === LOGO_MASTER_SHA256) {
    errors.push(
      `Asset file for "${fieldName}" matches the protected master logo (rounds/R05-2026-11-26/shu.svg); use derived assets/mark.svg or a custom brand asset instead: ${norm.normalized}`,
    );
    return null;
  }

  const beforeErrors = errors.length;
  const meta = validateAssetContent(buffer, norm.ext, fieldName, norm.normalized, errors);
  if (errors.length > beforeErrors) return null;

  return {
    fieldName,
    source: norm.normalized,
    realPath: realFull,
    ext: norm.ext,
    mime: MIME_BY_EXT[norm.ext],
    buffer,
    sha256,
    bytes: buffer.length,
    ...meta,
  };
}

export function loadSiteConfig(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const configPath = options.configPath
    ? path.resolve(projectRoot, options.configPath)
    : path.join(projectRoot, DEFAULT_SELFHOST_CONFIG_REL);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing site config file: ${configPath}`);
  }
  const cfgStat = fs.lstatSync(configPath);
  if (cfgStat.isSymbolicLink() || !cfgStat.isFile()) {
    throw new Error(`Site config path must be a regular file: ${configPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`Invalid JSON in site config (${path.basename(configPath)}): ${err.message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Site config (${path.basename(configPath)}) must be a JSON object`);
  }

  const errors = [];
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.includes(key)) {
      errors.push(`Unknown config field "${key}" (allowed: ${ALLOWED_TOP_LEVEL_KEYS.join(", ")})`);
    }
  }
  for (const required of ALLOWED_TOP_LEVEL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, required)) {
      errors.push(`Missing required config field "${required}"`);
    }
  }

  const siteName = Object.prototype.hasOwnProperty.call(parsed, "siteName")
    ? validateTextField(parsed, "siteName", TEXT_LIMITS.siteName, errors)
    : "";
  const title = Object.prototype.hasOwnProperty.call(parsed, "title")
    ? validateTextField(parsed, "title", TEXT_LIMITS.title, errors)
    : "";
  const description = Object.prototype.hasOwnProperty.call(parsed, "description")
    ? validateTextField(parsed, "description", TEXT_LIMITS.description, errors)
    : "";

  const projectRealRoot = fs.realpathSync(projectRoot);
  const logoAsset = Object.prototype.hasOwnProperty.call(parsed, "logo")
    ? readAndValidateAsset(projectRoot, projectRealRoot, "logo", parsed.logo, LOGO_EXTENSIONS, errors)
    : null;

  const faviconAssets = [];
  if (Object.prototype.hasOwnProperty.call(parsed, "favicon")) {
    const rawFav = parsed.favicon;
    if (typeof rawFav === "string") {
      const asset = readAndValidateAsset(
        projectRoot,
        projectRealRoot,
        "favicon",
        rawFav,
        FAVICON_STRING_EXTENSIONS,
        errors,
      );
      if (asset) faviconAssets.push(asset);
    } else if (isPlainObject(rawFav)) {
      const keys = Object.keys(rawFav);
      for (const k of keys) {
        if (!ALLOWED_FAVICON_KEYS.includes(k)) {
          errors.push(`Unknown favicon field "favicon.${k}" (allowed: ${ALLOWED_FAVICON_KEYS.join(", ")})`);
        }
      }
      const presentValidKeys = ALLOWED_FAVICON_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(rawFav, k));
      if (presentValidKeys.length === 0) {
        errors.push(`Config field "favicon" object must define at least one of: ${ALLOWED_FAVICON_KEYS.join(", ")}`);
      }
      for (const k of presentValidKeys) {
        const expectedExt = `.${k}`;
        const asset = readAndValidateAsset(
          projectRoot,
          projectRealRoot,
          `favicon.${k}`,
          rawFav[k],
          new Set([expectedExt]),
          errors,
        );
        if (asset) faviconAssets.push(asset);
      }
    } else {
      errors.push('Config field "favicon" must be a relative path string or an object with svg/png/ico keys');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid site config:\n- ${errors.join("\n- ")}`);
  }

  // 归一化输出路径到 assets/，同源路径自动去重，绝不暴露源码目录结构或产生同名冲突
  const outputAssets = new Map();
  const sourceToDest = new Map();

  const logoDest = `assets/logo${logoAsset.ext}`;
  sourceToDest.set(logoAsset.source, logoDest);
  outputAssets.set(logoDest, {
    dest: logoDest,
    source: logoAsset.source,
    realPath: logoAsset.realPath,
    mime: logoAsset.mime,
    ext: logoAsset.ext,
    buffer: logoAsset.buffer,
    sha256: logoAsset.sha256,
    bytes: logoAsset.bytes,
    width: logoAsset.width,
    height: logoAsset.height,
  });

  const resolvedFavicons = [];
  for (const fav of faviconAssets) {
    let dest = sourceToDest.get(fav.source);
    if (!dest) {
      dest = `assets/favicon${fav.ext}`;
      sourceToDest.set(fav.source, dest);
      outputAssets.set(dest, {
        dest,
        source: fav.source,
        realPath: fav.realPath,
        mime: fav.mime,
        ext: fav.ext,
        buffer: fav.buffer,
        sha256: fav.sha256,
        bytes: fav.bytes,
        width: fav.width,
        height: fav.height,
      });
    }
    resolvedFavicons.push({
      dest,
      source: fav.source,
      mime: fav.mime,
      ext: fav.ext,
      width: fav.width,
      height: fav.height,
    });
  }

  return {
    configPath,
    config: {
      siteName,
      title,
      description,
      logo: logoAsset.source,
      favicon: parsed.favicon,
    },
    logo: {
      dest: logoDest,
      source: logoAsset.source,
      mime: logoAsset.mime,
    },
    favicons: resolvedFavicons,
    outputAssets,
  };
}

function buildFaviconLinks(favicons) {
  return favicons.map((fav) => {
    const sizesPart = fav.ext === ".png" && fav.width && fav.height ? ` sizes="${fav.width}x${fav.height}"` : "";
    return `<link rel="icon" href="${fav.dest}"${sizesPart} type="${fav.mime}">`;
  });
}

function replaceExactlyOnce(source, regex, replacer, label) {
  const matches = [...source.matchAll(regex)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly 1 ${label} in source index.html, found ${matches.length}`);
  }
  return source.replace(regex, replacer);
}

const APP_VERSION_META_RE = /<meta\b[^>]*\bname\s*=\s*(?:"app-version"|'app-version')[^>]*>/gi;

export function renderBrandedHtml(sourceHtml, resolved, appVersion) {
  const normalizedVersion = normalizePackageVersion(appVersion ?? resolved?.appVersion);
  if (!normalizedVersion) {
    throw new Error(`Self-host build requires a valid SemVer appVersion (got: ${String(appVersion ?? resolved?.appVersion)})`);
  }

  const headMatches = [...sourceHtml.matchAll(/<head\b[^>]*>[\s\S]*?<\/head>/gi)];
  if (headMatches.length !== 1) {
    throw new Error(`Expected exactly 1 <head>...</head> section in source index.html, found ${headMatches.length}`);
  }

  const headStart = headMatches[0].index;
  const headEnd = headStart + headMatches[0][0].length;
  let headBlock = headMatches[0][0];

  if ([...headBlock.matchAll(APP_VERSION_META_RE)].length > 0) {
    throw new Error('Source index.html <head> must not predefine <meta name="app-version">');
  }

  // 1. 替换浏览器标题 <title>
  headBlock = replaceExactlyOnce(
    headBlock,
    /<title>[\s\S]*?<\/title>/gi,
    () => `<title>${escapeHtml(resolved.config.title)}</title>`,
    "<title> tag in <head>",
  );

  // 2. 替换页面描述 <meta name="description">，并紧随其后注入唯一 <meta name="app-version">
  headBlock = replaceExactlyOnce(
    headBlock,
    /([ \t]*)<meta\b[^>]*\bname\s*=\s*(?:"description"|'description')[^>]*>/gi,
    (_full, indent = "") =>
      `${indent}<meta name="description" content="${escapeHtml(resolved.config.description)}">\n${indent}<meta name="app-version" content="${escapeHtml(normalizedVersion)}">`,
    '<meta name="description"> tag in <head>',
  );

  // 3. 替换 <link rel="icon"> 图标标签
  const iconRe = /[ \t]*<link\b[^>]*\brel\s*=\s*(?:"(?:shortcut\s+)?icon"|'(?:shortcut\s+)?icon')[^>]*>[ \t]*(?:\r?\n)?/gi;
  const iconMatches = [...headBlock.matchAll(iconRe)];
  if (iconMatches.length < 1) {
    throw new Error('Expected at least 1 <link rel="icon"> tag in <head> of source index.html');
  }
  const iconLinks = buildFaviconLinks(resolved.favicons);
  const firstMatch = iconMatches[0][0];
  const indentMatch = firstMatch.match(/^([ \t]*)/);
  const indent = indentMatch ? indentMatch[1] : "";
  const newline = firstMatch.includes("\r\n") ? "\r\n" : firstMatch.endsWith("\n") ? "\n" : "";
  const replacementIcons = `${iconLinks.map((line) => `${indent}${line}`).join("\n")}${newline}`;

  let replacedFirstIcon = false;
  headBlock = headBlock.replace(iconRe, () => {
    if (!replacedFirstIcon) {
      replacedFirstIcon = true;
      return replacementIcons;
    }
    return "";
  });

  const withHead = sourceHtml.slice(0, headStart) + headBlock + sourceHtml.slice(headEnd);

  // 4. 在 </head> 之后、首个正文 <script> 之前定位唯一的 <header>...</header>
  const bodyPrefixLen = headStart + headBlock.length;
  const afterHead = withHead.slice(bodyPrefixLen);
  const scriptRelIdx = afterHead.search(/<script\b/i);
  const bodyBeforeScript = scriptRelIdx >= 0 ? afterHead.slice(0, scriptRelIdx) : afterHead;

  const headerMatches = [...bodyBeforeScript.matchAll(/<header\b[^>]*>[\s\S]*?<\/header>/gi)];
  if (headerMatches.length !== 1) {
    throw new Error(`Expected exactly 1 <header>...</header> section before <script> in source index.html, found ${headerMatches.length}`);
  }

  const headerStart = bodyPrefixLen + headerMatches[0].index;
  const headerEnd = headerStart + headerMatches[0][0].length;
  let headerBlock = headerMatches[0][0];

  // 5. 替换页头 Logo <img class="...mark..."> 的 src
  headerBlock = replaceExactlyOnce(
    headerBlock,
    /<img\b[^>]*\bclass\s*=\s*(?:"[^"]*\bmark\b[^"]*"|'[^']*\bmark\b[^']*')[^>]*>/gi,
    (imgTag) =>
      replaceExactlyOnce(
        imgTag,
        /\bsrc\s*=\s*(?:"[^"]*"|'[^']*')/gi,
        () => `src="${resolved.logo.dest}"`,
        'src attribute on <img class="mark">',
      ),
    '<img class="mark"> tag in <header>',
  );

  // 6. 替换页头站名 <h1>
  headerBlock = replaceExactlyOnce(
    headerBlock,
    /<h1(\b[^>]*)>[\s\S]*?<\/h1>/gi,
    (_full, attrs) => `<h1${attrs}>${escapeHtml(resolved.config.siteName)}</h1>`,
    "<h1> tag in <header>",
  );

  return withHead.slice(0, headerStart) + headerBlock + withHead.slice(headerEnd);
}

export function computeSelfhostBuildPlan(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const indexPath = path.join(projectRoot, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Missing source entry file: ${indexPath}`);
  }
  const indexStat = fs.lstatSync(indexPath);
  if (indexStat.isSymbolicLink() || !indexStat.isFile()) {
    throw new Error(`Source entry index.html must be a regular file: ${indexPath}`);
  }

  const resolved = loadSiteConfig({
    projectRoot,
    configPath: options.configPath,
  });
  const appVersion = readPackageVersion(projectRoot);

  const sourceHtml = fs.readFileSync(indexPath, "utf8");
  const brandedHtml = renderBrandedHtml(sourceHtml, resolved, appVersion);
  const htmlBuffer = Buffer.from(brandedHtml, "utf8");

  const files = new Map();
  files.set("index.html", {
    dest: "index.html",
    source: "index.html",
    buffer: htmlBuffer,
    bytes: htmlBuffer.length,
    sha256: sha256Buffer(htmlBuffer),
  });

  const sourceAssets = [];
  for (const [dest, asset] of resolved.outputAssets.entries()) {
    files.set(dest, {
      dest,
      source: asset.source,
      realPath: asset.realPath,
      buffer: asset.buffer,
      bytes: asset.bytes,
      sha256: asset.sha256,
    });
    sourceAssets.push({
      source: asset.source,
      realPath: asset.realPath,
    });
  }

  const expectedFiles = [...files.keys()].sort();
  const digests = {};
  for (const rel of expectedFiles) {
    const item = files.get(rel);
    digests[rel] = { bytes: item.bytes, sha256: item.sha256 };
  }

  return {
    projectRoot,
    configPath: resolved.configPath,
    config: resolved.config,
    appVersion,
    logo: resolved.logo,
    favicons: resolved.favicons,
    sourceAssets,
    files,
    expectedFiles,
    digests,
  };
}

function isSameOrChildPath(parentDir, candidatePath) {
  const normParent = path.resolve(parentDir).toLowerCase();
  const normCandidate = path.resolve(candidatePath).toLowerCase();
  if (normParent === normCandidate) return true;
  const rel = path.relative(normParent, normCandidate);
  return Boolean(rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function checkRelativePathBoundary(rootPath, targetPath, displayTarget) {
  if (targetPath.toLowerCase() === rootPath.toLowerCase()) {
    throw new Error(`Refusing to clean project root as self-host output directory: ${displayTarget}`);
  }

  const relFromTargetToRoot = path.relative(targetPath.toLowerCase(), rootPath.toLowerCase());
  if (relFromTargetToRoot && !relFromTargetToRoot.startsWith("..") && !path.isAbsolute(relFromTargetToRoot)) {
    throw new Error(`Refusing to clean ancestor directory of project root: ${displayTarget}`);
  }

  const rel = path.relative(rootPath, targetPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    const base = path.basename(targetPath);
    if (base !== "dist-selfhost" && !base.startsWith("dist-selfhost-")) {
      throw new Error(
        `Refusing to clean unexpected directory outside project root: ${displayTarget} (basename must be "dist-selfhost" or "dist-selfhost-*")`,
      );
    }
    return { insideRoot: false, rel: null };
  }

  const firstSegment = rel.split(path.sep)[0];
  if (PROTECTED_ROOT_DIRS.has(firstSegment.toLowerCase())) {
    throw new Error(
      `Refusing to write self-host output into protected directory "${firstSegment}": ${displayTarget}`,
    );
  }
  return { insideRoot: true, rel };
}

function assertNoSymlinkSegmentsInsideRoot(rootPath, rel, displayTarget) {
  const segments = rel.split(path.sep).filter(Boolean);
  let current = rootPath;
  for (const seg of segments) {
    current = path.join(current, seg);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        // 后续末段尚未创建，停止逐段检查
        break;
      }
      if (err && err.code === "ENOTDIR") {
        throw new Error(`Cannot use self-host output path because an ancestor is not a directory: ${displayTarget}`);
      }
      if (err && err.code === "ELOOP") {
        throw new Error(`Refusing self-host output path with symlink loop: ${displayTarget}`);
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing self-host output path containing symlink "${seg}": ${displayTarget}`);
    }
  }
}

function resolveRealTargetPath(resolvedOut) {
  let leafStat = null;
  try {
    leafStat = fs.lstatSync(resolvedOut);
  } catch (err) {
    if (err && err.code === "ENOTDIR") {
      throw new Error(`Cannot use self-host output path because an ancestor is not a directory: ${resolvedOut}`);
    }
    if (err && err.code === "ELOOP") {
      throw new Error(`Refusing self-host output path with symlink loop: ${resolvedOut}`);
    }
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
  }

  if (leafStat) {
    if (leafStat.isSymbolicLink()) {
      throw new Error(`Refusing to clean symlinked output directory: ${resolvedOut}`);
    }
    if (!leafStat.isDirectory()) {
      throw new Error(`Expected self-host output path to be a directory: ${resolvedOut}`);
    }
    return fs.realpathSync(resolvedOut);
  }

  // 输出末段尚不存在：向上回溯至最近已存在祖先，解析真实目的地再拼接未创建后缀
  let cursor = resolvedOut;
  const missingSegments = [];
  while (true) {
    let stat = null;
    try {
      stat = fs.lstatSync(cursor);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          throw new Error(`Cannot resolve existing ancestor for self-host output path: ${resolvedOut}`);
        }
        missingSegments.unshift(path.basename(cursor));
        cursor = parent;
        continue;
      }
      if (err && err.code === "ENOTDIR") {
        throw new Error(`Cannot use self-host output path because an ancestor is not a directory: ${resolvedOut}`);
      }
      if (err && err.code === "ELOOP") {
        throw new Error(`Refusing self-host output path with symlink loop: ${resolvedOut}`);
      }
      throw err;
    }

    if (stat.isSymbolicLink()) {
      let resolvedAncestor;
      try {
        resolvedAncestor = fs.realpathSync(cursor);
      } catch {
        throw new Error(`Refusing self-host output path with broken symlink ancestor "${cursor}": ${resolvedOut}`);
      }
      const targetStat = fs.statSync(resolvedAncestor);
      if (!targetStat.isDirectory()) {
        throw new Error(`Cannot use self-host output path because an ancestor is not a directory: ${resolvedOut}`);
      }
      return path.join(resolvedAncestor, ...missingSegments);
    }

    if (!stat.isDirectory()) {
      throw new Error(`Cannot use self-host output path because an ancestor is not a directory: ${resolvedOut}`);
    }

    const resolvedAncestor = fs.realpathSync(cursor);
    return path.join(resolvedAncestor, ...missingSegments);
  }
}

export function assertSafeOutputDir(projectRoot, outDir) {
  const resolvedRoot = path.resolve(projectRoot);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Project root directory does not exist: ${resolvedRoot}`);
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const resolvedOut = path.resolve(resolvedRoot, outDir);

  // 1. 先检查逻辑路径边界与项目内逐段符号链接（覆盖已存在与未创建末段）
  const logicalCheck = checkRelativePathBoundary(resolvedRoot, resolvedOut, resolvedOut);
  if (logicalCheck.insideRoot) {
    assertNoSymlinkSegmentsInsideRoot(resolvedRoot, logicalCheck.rel, resolvedOut);
  }

  // 2. 解析输出路径（含未创建末段）对应的真实目的地，拦截末段符号链接、断链祖先与非目录祖先
  const realOut = resolveRealTargetPath(resolvedOut);
  const displayTarget = realOut === resolvedOut ? resolvedOut : `${resolvedOut} -> ${realOut}`;

  // 3. 对真实目的地再次执行完整的项目边界与受保护目录校验
  const realCheck = checkRelativePathBoundary(realRoot, realOut, displayTarget);

  // 4. 禁止位于项目内的逻辑路径通过符号链接逃逸到项目之外，且确保真实路径在项目内不含符号链接段
  if (logicalCheck.insideRoot && !realCheck.insideRoot) {
    throw new Error(`Refusing self-host output path that escapes project root via symlink: ${displayTarget}`);
  }
  if (realCheck.insideRoot) {
    assertNoSymlinkSegmentsInsideRoot(realRoot, realCheck.rel, displayTarget);
  }

  return realOut;
}

export function assertOutputDoesNotOverlapSources(projectRoot, safeOutDir, displayOutDir, plan) {
  const realRoot = fs.realpathSync(path.resolve(projectRoot));

  for (const asset of plan.sourceAssets || []) {
    const assetRealPath = asset.realPath;
    const assetDir = path.dirname(assetRealPath);
    if (isSameOrChildPath(safeOutDir, assetRealPath)) {
      throw new Error(
        `Refusing self-host output directory overlapping configured brand asset "${asset.source}": ${displayOutDir}`,
      );
    }
    if (assetDir.toLowerCase() !== realRoot.toLowerCase() && isSameOrChildPath(assetDir, safeOutDir)) {
      throw new Error(
        `Refusing self-host output directory inside configured brand asset directory for "${asset.source}": ${displayOutDir}`,
      );
    }
  }

  if (plan.configPath && fs.existsSync(plan.configPath)) {
    const realConfigPath = fs.realpathSync(plan.configPath);
    const configDir = path.dirname(realConfigPath);
    if (isSameOrChildPath(safeOutDir, realConfigPath)) {
      throw new Error(
        `Refusing self-host output directory overlapping site config file "${path.basename(realConfigPath)}": ${displayOutDir}`,
      );
    }
    if (configDir.toLowerCase() !== realRoot.toLowerCase() && isSameOrChildPath(configDir, safeOutDir)) {
      throw new Error(
        `Refusing self-host output directory inside site config directory "${configDir}": ${displayOutDir}`,
      );
    }
  }
}

export function buildSelfhost(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const outDir = path.resolve(
    projectRoot,
    options.outDir || path.join(projectRoot, "dist-selfhost"),
  );

  // 先完成输出路径真实目的地安全校验、构建计划计算及源素材目录重叠校验，再执行任何目录清理或写入副作用
  const safeOutDir = assertSafeOutputDir(projectRoot, outDir);
  const plan = computeSelfhostBuildPlan({
    projectRoot,
    configPath: options.configPath,
  });
  assertOutputDoesNotOverlapSources(projectRoot, safeOutDir, outDir, plan);

  // 清除旧产物，保证可重现且无历史残留
  fs.rmSync(safeOutDir, { recursive: true, force: true });
  fs.mkdirSync(safeOutDir, { recursive: true });

  for (const rel of plan.expectedFiles) {
    const entry = plan.files.get(rel);
    const destPath = path.join(safeOutDir, rel);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, entry.buffer);
  }

  return {
    outDir,
    configPath: plan.configPath,
    config: plan.config,
    files: plan.expectedFiles,
    digests: plan.digests,
  };
}

export function parseCliArgs(argv) {
  const opts = {
    configPath: null,
    outDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      if (!argv[i + 1]) throw new Error("Missing value for --config");
      opts.configPath = path.resolve(process.cwd(), argv[++i]);
    } else if (arg.startsWith("--config=")) {
      const val = arg.slice("--config=".length);
      if (!val) throw new Error("Missing value for --config");
      opts.configPath = path.resolve(process.cwd(), val);
    } else if (arg === "--out") {
      if (!argv[i + 1]) throw new Error("Missing value for --out");
      opts.outDir = path.resolve(process.cwd(), argv[++i]);
    } else if (arg.startsWith("--out=")) {
      const val = arg.slice("--out=".length);
      if (!val) throw new Error("Missing value for --out");
      opts.outDir = path.resolve(process.cwd(), val);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const cliOpts = parseCliArgs(process.argv.slice(2));
  const result = buildSelfhost({
    projectRoot: PROJECT_ROOT,
    configPath: cliOpts.configPath || undefined,
    outDir: cliOpts.outDir || DEFAULT_SELFHOST_DIR,
  });
  const displayOut = path.relative(PROJECT_ROOT, result.outDir) || result.outDir;
  console.log(`Built ${result.files.length} self-host files into ${displayOut}/ (brand="${result.config.siteName}"):`);
  for (const rel of result.files) {
    const info = result.digests[rel];
    console.log(`  - ${rel} (${info.bytes} bytes, sha256=${info.sha256.slice(0, 16)}...)`);
  }
}
