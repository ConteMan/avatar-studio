#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  if (segments.some((seg) => seg.startsWith("."))) {
    errors.push(`Config field "${fieldName}" must not reference hidden dotfiles/directories: ${trimmed}`);
    return null;
  }

  const normalized = segments.join("/");
  if (normalized.startsWith("rounds/")) {
    errors.push(`Config field "${fieldName}" must not reference master logo directory "rounds/": ${normalized}`);
    return null;
  }
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix)) {
      errors.push(`Config field "${fieldName}" points to a forbidden repository path: ${normalized}`);
      return null;
    }
  }
  if (normalized === "dist-selfhost" || normalized.startsWith("dist-selfhost/")) {
    errors.push(`Config field "${fieldName}" must not reference generated output directory "dist-selfhost/": ${normalized}`);
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

  const buffer = fs.readFileSync(fullPath);
  const beforeErrors = errors.length;
  const meta = validateAssetContent(buffer, norm.ext, fieldName, norm.normalized, errors);
  if (errors.length > beforeErrors) return null;

  return {
    fieldName,
    source: norm.normalized,
    ext: norm.ext,
    mime: MIME_BY_EXT[norm.ext],
    buffer,
    sha256: sha256Buffer(buffer),
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

export function renderBrandedHtml(sourceHtml, resolved) {
  const headMatches = [...sourceHtml.matchAll(/<head\b[^>]*>[\s\S]*?<\/head>/gi)];
  if (headMatches.length !== 1) {
    throw new Error(`Expected exactly 1 <head>...</head> section in source index.html, found ${headMatches.length}`);
  }

  const headStart = headMatches[0].index;
  const headEnd = headStart + headMatches[0][0].length;
  let headBlock = headMatches[0][0];

  // 1. 替换浏览器标题 <title>
  headBlock = replaceExactlyOnce(
    headBlock,
    /<title>[\s\S]*?<\/title>/gi,
    () => `<title>${escapeHtml(resolved.config.title)}</title>`,
    "<title> tag in <head>",
  );

  // 2. 替换页面描述 <meta name="description">
  headBlock = replaceExactlyOnce(
    headBlock,
    /<meta\b[^>]*\bname\s*=\s*(?:"description"|'description')[^>]*>/gi,
    () => `<meta name="description" content="${escapeHtml(resolved.config.description)}">`,
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

  const sourceHtml = fs.readFileSync(indexPath, "utf8");
  const brandedHtml = renderBrandedHtml(sourceHtml, resolved);
  const htmlBuffer = Buffer.from(brandedHtml, "utf8");

  const files = new Map();
  files.set("index.html", {
    dest: "index.html",
    source: "index.html",
    buffer: htmlBuffer,
    bytes: htmlBuffer.length,
    sha256: sha256Buffer(htmlBuffer),
  });

  for (const [dest, asset] of resolved.outputAssets.entries()) {
    files.set(dest, {
      dest,
      source: asset.source,
      buffer: asset.buffer,
      bytes: asset.bytes,
      sha256: asset.sha256,
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
    logo: resolved.logo,
    favicons: resolved.favicons,
    files,
    expectedFiles,
    digests,
  };
}

export function assertSafeOutputDir(projectRoot, outDir) {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedOut = path.resolve(outDir);

  if (resolvedOut === resolvedRoot) {
    throw new Error("Refusing to clean project root as self-host output directory.");
  }

  const relFromOutToRoot = path.relative(resolvedOut, resolvedRoot);
  if (relFromOutToRoot && !relFromOutToRoot.startsWith("..") && !path.isAbsolute(relFromOutToRoot)) {
    throw new Error(`Refusing to clean ancestor directory of project root: ${resolvedOut}`);
  }

  const rel = path.relative(resolvedRoot, resolvedOut);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    const base = path.basename(resolvedOut);
    if (base !== "dist-selfhost" && !base.startsWith("dist-selfhost-")) {
      throw new Error(
        `Refusing to clean unexpected directory outside project root: ${resolvedOut} (basename must be "dist-selfhost" or "dist-selfhost-*")`,
      );
    }
  } else {
    const firstSegment = rel.split(path.sep)[0];
    if (PROTECTED_ROOT_DIRS.has(firstSegment)) {
      throw new Error(`Refusing to write self-host output into protected directory "${firstSegment}": ${resolvedOut}`);
    }
  }

  if (fs.existsSync(resolvedOut)) {
    const stat = fs.lstatSync(resolvedOut);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to clean symlinked output directory: ${resolvedOut}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Expected self-host output path to be a directory: ${resolvedOut}`);
    }
  }
}

export function buildSelfhost(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const outDir = path.resolve(
    projectRoot,
    options.outDir || path.join(projectRoot, "dist-selfhost"),
  );

  assertSafeOutputDir(projectRoot, outDir);
  const plan = computeSelfhostBuildPlan({
    projectRoot,
    configPath: options.configPath,
  });

  // 清除旧产物，保证可重现且无历史残留
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const rel of plan.expectedFiles) {
    const entry = plan.files.get(rel);
    const destPath = path.join(outDir, rel);
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
