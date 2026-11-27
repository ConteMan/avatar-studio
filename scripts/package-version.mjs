import fs from "node:fs";
import path from "node:path";

export const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function normalizePackageVersion(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || !SEMVER_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function readPackageVersion(projectRoot) {
  const pkgPath = path.join(path.resolve(projectRoot), "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error("Missing package.json");
  }
  const stat = fs.lstatSync(pkgPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("package.json must be a regular file");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch (err) {
    throw new Error(`Invalid JSON in package.json: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("package.json must be a JSON object");
  }
  const version = normalizePackageVersion(parsed.version);
  if (!version) {
    throw new Error(`package.json version must be a valid SemVer string (got: ${String(parsed.version)})`);
  }
  return version;
}
