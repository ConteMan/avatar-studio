#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_DIST_DIR = path.join(PROJECT_ROOT, "dist");

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
});

// Workers Static Assets 内部配置文件，绝不直接向客户端提供
const INTERNAL_CONTROL_FILES = new Set(["/_headers", "/_redirects"]);

/**
 * 解析 Cloudflare Workers Static Assets 格式的 `_headers` 文件。
 */
export function parseHeadersFile(text) {
  const rules = [];
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^\s/.test(rawLine)) {
      if (!current) continue;
      if (trimmed.startsWith("!")) {
        const name = trimmed.slice(1).trim().toLowerCase();
        if (name) current.ops.push({ type: "detach", name });
      } else {
        const colon = trimmed.indexOf(":");
        if (colon > 0) {
          const name = trimmed.slice(0, colon).trim();
          const value = trimmed.slice(colon + 1).trim();
          current.ops.push({ type: "set", name, value });
        }
      }
    } else {
      current = { pattern: trimmed, ops: [] };
      rules.push(current);
    }
  }

  return rules;
}

function matchHeaderPattern(pattern, pathname) {
  if (pattern === pathname) return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(pathname);
}

function applyHeaderRules(rules, pathname, baseHeaders) {
  const headers = new Map();
  for (const [k, v] of Object.entries(baseHeaders)) {
    headers.set(k.toLowerCase(), { name: k, value: v });
  }

  // Track which headers were set by _headers rules so duplicate rules append like Cloudflare
  const setByRule = new Set();

  for (const rule of rules) {
    if (!matchHeaderPattern(rule.pattern, pathname)) continue;
    for (const op of rule.ops) {
      const lower = op.name.toLowerCase();
      if (op.type === "detach") {
        headers.delete(lower);
        setByRule.delete(lower);
      } else if (op.type === "set") {
        if (setByRule.has(lower) && headers.has(lower)) {
          const prev = headers.get(lower);
          headers.set(lower, { name: prev.name, value: `${prev.value}, ${op.value}` });
        } else {
          // Rule overrides Cloudflare default header on first match
          headers.set(lower, { name: op.name, value: op.value });
          setByRule.add(lower);
        }
      }
    }
  }

  const out = {};
  for (const { name, value } of headers.values()) {
    out[name] = value;
  }
  return out;
}

function resolveDistFile(distDir, relPath) {
  const normalized = relPath.replace(/^\/+/, "");
  const fullPath = path.resolve(distDir, normalized);
  const rel = path.relative(distDir, fullPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  if (!fs.existsSync(fullPath)) return null;
  const stat = fs.lstatSync(fullPath);
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  return fullPath;
}

/**
 * 创建仅服务于 `dist/` 的本地静态预览服务器，模拟 Workers Static Assets 关键行为：
 * - `htmlHandling: "auto-trailing-slash"`（/index.html 307 重定向至 / 并保留查询串）
 * - `notFoundHandling: "none"`（未知路径与缺失资产返回真实 404，不做 SPA 回退）
 * - 应用 `dist/_headers` 并禁止直接访问 `/_headers`、`_redirects`
 * - 默认附带 ETag 与 `Cache-Control: public, max-age=0, must-revalidate`
 */
export function createPreviewServer(options = {}) {
  const distDir = path.resolve(options.distDir || DEFAULT_DIST_DIR);
  if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
    throw new Error(`dist directory not found: ${distDir}. Run "npm run build" first.`);
  }

  const headersFile = path.join(distDir, "_headers");
  const headerRules = fs.existsSync(headersFile)
    ? parseHeadersFile(fs.readFileSync(headersFile, "utf8"))
    : [];

  return http.createServer((req, res) => {
    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
      res.end("Method Not Allowed\n");
      return;
    }

    const rawReqUrl = req.url || "/";
    const rawPathOnly = rawReqUrl.split(/[?#]/)[0];
    const rawSegments = rawPathOnly.split("/");
    if (
      rawSegments.some((s) => {
        const lower = s.toLowerCase();
        return lower === ".." || lower === "%2e%2e" || lower === ".%2e" || lower === "%2e.";
      })
    ) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(method === "HEAD" ? undefined : "Not Found\n");
      return;
    }

    let url;
    try {
      url = new URL(rawReqUrl, "http://127.0.0.1");
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad Request\n");
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad Request\n");
      return;
    }

    const decodedSegments = pathname.split("/");
    if (decodedSegments.some((s) => s === ".." || s.includes("\\") || s.includes("\0"))) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(method === "HEAD" ? undefined : "Not Found\n");
      return;
    }

    // 模拟 Workers Static Assets 的 auto-trailing-slash：/index.html 或 /index -> 307 到 /
    if (pathname === "/index.html" || pathname === "/index") {
      const location = `/${url.search}`;
      res.writeHead(307, { Location: location });
      res.end();
      return;
    }

    // 禁止直接读取 _headers / _redirects
    if (INTERNAL_CONTROL_FILES.has(pathname)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found\n");
      return;
    }

    const targetRel = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = resolveDistFile(distDir, targetRel);
    if (!filePath) {
      // notFoundHandling: "none" — 未知路径与缺失资产一律返回真实 404
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(method === "HEAD" ? undefined : "Not Found\n");
      return;
    }

    const body = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;

    const responseHeaders = applyHeaderRules(headerRules, pathname, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=0, must-revalidate",
      ETag: etag,
    });

    const ifNoneMatch = req.headers["if-none-match"];
    if (typeof ifNoneMatch === "string" && ifNoneMatch.trim() === etag) {
      res.writeHead(304, responseHeaders);
      res.end();
      return;
    }

    responseHeaders["Content-Length"] = String(body.length);
    res.writeHead(200, responseHeaders);
    res.end(method === "HEAD" ? undefined : body);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  let host = "127.0.0.1";
  let port = 8788;
  let distDir = DEFAULT_DIST_DIR;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--host" && args[i + 1]) {
      host = args[++i];
    } else if (args[i] === "--port" && args[i + 1]) {
      port = Number(args[++i]);
    } else if (args[i] === "--dist" && args[i + 1]) {
      distDir = path.resolve(args[++i]);
    }
  }

  const server = createPreviewServer({ distDir });
  server.listen(port, host, () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    console.log(`Preview server listening at http://${host}:${actualPort} (serving ${path.basename(distDir)}/)`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
