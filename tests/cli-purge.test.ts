import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "bun";
import { ensureDataDir, readConfig, writeConfig, appendPrompt } from "../src/storage.ts";
import { defaultConfig } from "../src/schemas.ts";

describe("CLI purge corrupt line handling", () => {
  const projectRoot = path.resolve(import.meta.dir, "..");

  const runCli = async (args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
    const proc = spawn({
      cmd: ["bun", path.join(projectRoot, "bin", "routing-auditor.ts"), ...args],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: os.homedir(),
      },
    });

    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { stdout: out, stderr: err, code };
  };

  it("preserves corrupt lines to sidecar file and reports count", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-purge-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    
    const config = defaultConfig();
    config.retentionDays = 1;
    writeConfig(dataDir, config);

    const promptsPath = path.join(dataDir, "prompts.jsonl");
    
    // Create an old record (should be purged)
    const oldRecord = {
      id: "old-1",
      timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      session_id: "test-session",
      prompt: "old prompt",
      codex_model: "gpt-4",
      codex_tier: "high" as const,
      verified: false,
      verification_succeeded: false,
      completion_notice_shown: false,
    };
    appendPrompt(dataDir, oldRecord);
    
    // Create a new record (should be kept)
    const newRecord = {
      id: "new-1",
      timestamp: new Date().toISOString(),
      session_id: "test-session",
      prompt: "new prompt",
      codex_model: "gpt-4",
      codex_tier: "high" as const,
      verified: false,
      verification_succeeded: false,
      completion_notice_shown: false,
    };
    appendPrompt(dataDir, newRecord);
    
    // Append a corrupt line
    fs.appendFileSync(promptsPath, "this is not valid json\n", "utf-8");
    
    const { stdout, stderr, code } = await runCli(["purge", "--data-dir", dataDir]);
    expect(code).toBe(0);
    expect(stdout).toContain("Deleted 1 old prompt(s)");
    expect(stdout).toContain("Kept 1 prompt(s)");
    expect(stderr).toContain("Preserved 1 corrupt line(s)");
    
    // Verify the sidecar file was created
    const corruptFiles = fs.readdirSync(dataDir).filter(f => f.startsWith("prompts.jsonl.corrupt."));
    expect(corruptFiles.length).toBe(1);
    
    const corruptPath = path.join(dataDir, corruptFiles[0]!);
    const corruptContent = fs.readFileSync(corruptPath, "utf-8");
    expect(corruptContent).toContain("this is not valid json");
    
    // Verify the main file only has the new record
    const mainContent = fs.readFileSync(promptsPath, "utf-8");
    const lines = mainContent.split("\n").filter(l => l.trim() !== "");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.id).toBe("new-1");
    
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("dry-run reports corrupt line count without creating sidecar", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-purge-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    
    const config = defaultConfig();
    config.retentionDays = 1;
    writeConfig(dataDir, config);

    const promptsPath = path.join(dataDir, "prompts.jsonl");
    
    // Create an old record (should be purged)
    const oldRecord = {
      id: "old-1",
      timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      session_id: "test-session",
      prompt: "old prompt",
      codex_model: "gpt-4",
      codex_tier: "high" as const,
      verified: false,
      verification_succeeded: false,
      completion_notice_shown: false,
    };
    appendPrompt(dataDir, oldRecord);
    
    // Create a new record (should be kept)
    const newRecord = {
      id: "new-1",
      timestamp: new Date().toISOString(),
      session_id: "test-session",
      prompt: "new prompt",
      codex_model: "gpt-4",
      codex_tier: "high" as const,
      verified: false,
      verification_succeeded: false,
      completion_notice_shown: false,
    };
    appendPrompt(dataDir, newRecord);
    
    // Append a corrupt line
    fs.appendFileSync(promptsPath, "this is not valid json\n", "utf-8");
    
    const { stdout, code } = await runCli(["purge", "--dry-run", "--data-dir", dataDir]);
    expect(code).toBe(0);
    expect(stdout).toContain("Would delete 1 old prompt(s)");
    expect(stdout).toContain("Would keep 1 prompt(s)");
    expect(stdout).toContain("Would preserve 1 corrupt line(s)");
    
    // Verify no sidecar file was created
    const corruptFiles = fs.readdirSync(dataDir).filter(f => f.startsWith("prompts.jsonl.corrupt."));
    expect(corruptFiles.length).toBe(0);
    
    // Verify the original file is unchanged
    const mainContent = fs.readFileSync(promptsPath, "utf-8");
    expect(mainContent).toContain("this is not valid json");
    
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("handles multiple corrupt lines", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-purge-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    
    const config = defaultConfig();
    config.retentionDays = 1;
    writeConfig(dataDir, config);

    const promptsPath = path.join(dataDir, "prompts.jsonl");
    
    // Create a new record (should be kept)
    const newRecord = {
      id: "new-1",
      timestamp: new Date().toISOString(),
      session_id: "test-session",
      prompt: "new prompt",
      codex_model: "gpt-4",
      codex_tier: "high" as const,
      verified: false,
      verification_succeeded: false,
      completion_notice_shown: false,
    };
    appendPrompt(dataDir, newRecord);
    
    // Append multiple corrupt lines
    fs.appendFileSync(promptsPath, "corrupt line 1\n", "utf-8");
    fs.appendFileSync(promptsPath, "corrupt line 2\n", "utf-8");
    fs.appendFileSync(promptsPath, "corrupt line 3\n", "utf-8");
    
    const { stdout, stderr, code } = await runCli(["purge", "--data-dir", dataDir]);
    expect(code).toBe(0);
    expect(stdout).toContain("Kept 1 prompt(s)");
    expect(stderr).toContain("Preserved 3 corrupt line(s)");
    
    // Verify the sidecar file was created
    const corruptFiles = fs.readdirSync(dataDir).filter(f => f.startsWith("prompts.jsonl.corrupt."));
    expect(corruptFiles.length).toBe(1);
    
    const corruptPath = path.join(dataDir, corruptFiles[0]!);
    const corruptContent = fs.readFileSync(corruptPath, "utf-8");
    expect(corruptContent).toContain("corrupt line 1");
    expect(corruptContent).toContain("corrupt line 2");
    expect(corruptContent).toContain("corrupt line 3");
    
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});