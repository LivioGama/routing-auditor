import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureArtifacts, captureReferencedArtifacts, isLikelyArtifactTask } from "../src/artifacts.ts";

let dirs: string[] = [];

const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-artifacts-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe("captureArtifacts", () => {
  it("captures text/code files with relative paths", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>Hello</h1>");

    const artifacts = captureArtifacts(dir);

    expect(artifacts).toEqual([
      { path: "index.html", content: "<h1>Hello</h1>", truncated: false },
    ]);
  });

  it("skips dependency directories", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "ignored.js"), "module.exports = 1");
    fs.writeFileSync(path.join(dir, "app.js"), "console.log('ok')");

    const artifacts = captureArtifacts(dir);

    expect(artifacts.map((artifact) => artifact.path)).toEqual(["app.js"]);
  });

  it("truncates large files", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "big.ts"), "x".repeat(100));

    const artifacts = captureArtifacts(dir, { maxBytesPerFile: 10 });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.content).toBe("x".repeat(10));
    expect(artifacts[0]!.truncated).toBe(true);
  });

  it("does not recursively scan broad home directories", () => {
    const artifacts = captureArtifacts(os.homedir());

    expect(artifacts).toEqual([]);
  });
});

describe("captureReferencedArtifacts", () => {
  it("captures absolute paths from markdown links", () => {
    const dir = tempDir();
    const file = path.join(dir, "index.html");
    fs.writeFileSync(file, "<h1>Hello</h1>");

    const artifacts = captureReferencedArtifacts(os.homedir(), `Created [index.html](${file}:1).`);

    expect(artifacts).toEqual([
      { path: file, content: "<h1>Hello</h1>", truncated: false },
    ]);
  });

  it("captures relative paths against the provided root", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>Hello</h1>");

    const artifacts = captureReferencedArtifacts(dir, "Created `index.html`.");

    expect(artifacts).toEqual([
      { path: "index.html", content: "<h1>Hello</h1>", truncated: false },
    ]);
  });
});

describe("isLikelyArtifactTask", () => {
  it("matches coding and file-writing prompts", () => {
    expect(isLikelyArtifactTask("implement a simple hello world vanilla html page")).toBe(true);
    expect(isLikelyArtifactTask("Updated index.html")).toBe(true);
  });

  it("does not match ordinary prose by default", () => {
    expect(isLikelyArtifactTask("what is the capital of France?")).toBe(false);
  });
});
