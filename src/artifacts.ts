import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecutionArtifact } from "./schemas.ts";

export interface CaptureArtifactsOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
}

const DEFAULT_MAX_FILES = 25;
const DEFAULT_MAX_BYTES_PER_FILE = 20_000;
const DEFAULT_MAX_TOTAL_BYTES = 120_000;

const EXCLUDED_DIRS = new Set([
  ".git",
  ".next",
  ".routing-auditor",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

const INCLUDED_EXTENSIONS = new Set([
  ".astro",
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".yaml",
  ".yml",
]);

const INCLUDED_BASENAMES = new Set([
  "Dockerfile",
  "Makefile",
  "Procfile",
  "bunfig.toml",
  "package.json",
  "tsconfig.json",
  "vite.config.js",
  "vite.config.ts",
]);

const PATH_EXT_PATTERN = String.raw`astro|c|cc|cpp|cs|css|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|py|rs|sh|svelte|toml|ts|tsx|txt|vue|ya?ml`;

export const isLikelyArtifactTask = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return (
    /\b(add|build|create|edit|fix|generate|implement|make|modify|refactor|scaffold|update|write)\b/.test(normalized) ||
    /\b(app|component|css|file|html|javascript|page|react|script|test|typescript|ui)\b/.test(normalized) ||
    /\.(astro|css|go|html|java|js|jsx|json|md|py|rs|svelte|ts|tsx|vue|ya?ml)\b/.test(normalized)
  );
};

const stripLineSuffix = (rawPath: string): string =>
  rawPath.replace(/:\d+(?::\d+)?$/, "");

const stripFileUrl = (rawPath: string): string => {
  if (!rawPath.startsWith("file://")) return rawPath;
  try {
    return decodeURIComponent(new URL(rawPath).pathname);
  } catch {
    return rawPath.slice("file://".length);
  }
};

const decodePath = (rawPath: string): string => {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
};

const normalizeRelativePath = (root: string, filePath: string): string =>
  path.relative(root, filePath).split(path.sep).join("/");

const shouldIncludeFile = (filePath: string): boolean => {
  const base = path.basename(filePath);
  if (INCLUDED_BASENAMES.has(base)) return true;
  return INCLUDED_EXTENSIONS.has(path.extname(base).toLowerCase());
};

const isBroadRoot = (root: string): boolean => {
  const resolved = path.resolve(root);
  return resolved === "/" || resolved === os.homedir() || resolved === path.dirname(os.homedir());
};

const readTextPrefix = (
  filePath: string,
  maxBytes: number,
): { content: string; truncated: boolean } | undefined => {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;

    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes + 1));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const slice = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    if (slice.includes(0)) return undefined;
    return {
      content: slice.toString("utf8"),
      truncated: bytesRead > maxBytes || stat.size > maxBytes,
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
};

const captureFile = (
  root: string,
  filePath: string,
  maxBytes: number,
): ExecutionArtifact | undefined => {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(filePath);
  if (!shouldIncludeFile(resolvedPath)) return undefined;
  const read = readTextPrefix(resolvedPath, maxBytes);
  if (!read) return undefined;
  const rel = normalizeRelativePath(resolvedRoot, resolvedPath);
  return {
    path: rel.startsWith("..") ? resolvedPath : rel,
    content: read.content,
    truncated: read.truncated,
  };
};

export const captureReferencedArtifacts = (
  root: string,
  text: string,
  options: CaptureArtifactsOptions = {},
): ExecutionArtifact[] => {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const artifacts: ExecutionArtifact[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  const add = (raw: string): void => {
    if (artifacts.length >= maxFiles || totalBytes >= maxTotalBytes) return;
    const cleaned = stripLineSuffix(stripFileUrl(decodePath(raw.trim().replace(/^[`"']+|[`"',.;]+$/g, ""))));
    if (!cleaned || /^https?:\/\//i.test(cleaned)) return;
    const filePath = path.isAbsolute(cleaned) ? cleaned : path.join(root, cleaned);
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const artifact = captureFile(root, resolved, Math.min(maxBytesPerFile, maxTotalBytes - totalBytes));
    if (!artifact) return;
    artifacts.push(artifact);
    totalBytes += Buffer.byteLength(artifact.content, "utf8");
  };

  for (const match of text.matchAll(/\]\(([^)\n]+)\)/g)) {
    const target = match[1];
    if (target) add(target);
  }

  const codeSpanPathRe = new RegExp(String.raw`` + "`" + String.raw`([^` + "`" + String.raw`\n]+?\.(?:${PATH_EXT_PATTERN})(?::\d+(?::\d+)?)?)` + "`", "gi");
  for (const match of text.matchAll(codeSpanPathRe)) {
    const target = match[1];
    if (target) add(target);
  }

  const absolutePathRe = new RegExp(String.raw`(/[^"'()\s` + "`" + String.raw`]+?\.(?:${PATH_EXT_PATTERN})(?::\d+(?::\d+)?)?)`, "gi");
  for (const match of text.matchAll(absolutePathRe)) {
    const target = match[1];
    if (target) add(target);
  }

  const relativePathRe = new RegExp(String.raw`(?:^|[\s"'(` + "`" + String.raw`])((?:\.{1,2}/)?[A-Za-z0-9_./-]+?\.(?:${PATH_EXT_PATTERN})(?::\d+(?::\d+)?)?)`, "gim");
  for (const match of text.matchAll(relativePathRe)) {
    const target = match[1];
    if (target) add(target);
  }

  return artifacts;
};

export const captureArtifacts = (
  root: string,
  options: CaptureArtifactsOptions = {},
): ExecutionArtifact[] => {
  const resolvedRoot = path.resolve(root);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const artifacts: ExecutionArtifact[] = [];
  let totalBytes = 0;

  if (isBroadRoot(resolvedRoot)) return artifacts;

  const walk = (dir: string): void => {
    if (artifacts.length >= maxFiles || totalBytes >= maxTotalBytes) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const entry of entries) {
      if (artifacts.length >= maxFiles || totalBytes >= maxTotalBytes) return;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name) && (!entry.name.startsWith(".") || entry.name === ".github")) {
          walk(fullPath);
        }
        continue;
      }
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (!entry.isFile() || !shouldIncludeFile(fullPath)) continue;

      const remaining = maxTotalBytes - totalBytes;
      const read = readTextPrefix(fullPath, Math.min(maxBytesPerFile, remaining));
      if (!read) continue;

      artifacts.push({
        path: normalizeRelativePath(resolvedRoot, fullPath),
        content: read.content,
        truncated: read.truncated || read.content.length >= remaining,
      });
      totalBytes += Buffer.byteLength(read.content, "utf8");
    }
  };

  walk(resolvedRoot);
  return artifacts;
};
