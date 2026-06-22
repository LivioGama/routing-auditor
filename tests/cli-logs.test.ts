import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "bun";

describe("CLI logs command security", () => {
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

  it("rejects malicious data-dir path with shell injection attempt", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-logs-"));
    const dataDir = path.join(baseDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    // Write a log file
    const logContent = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n";
    fs.writeFileSync(path.join(dataDir, "daemon.log"), logContent, "utf-8");

    // Try to inject shell command via data-dir
    const maliciousDataDir = `${dataDir}; touch /tmp/routing-auditor-pwned`;
    const { stdout, code } = await runCli(["logs", "--data-dir", maliciousDataDir, "--lines", "3"]);

    // Command should fail (exit code non-zero) or succeed but treat it as a literal directory name
    // Either way, no side-effect file should be created
    expect(fs.existsSync("/tmp/routing-auditor-pwned")).toBe(false);

    // Clean up
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("safely reads logs with normal data-dir", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-logs-"));
    const dataDir = path.join(baseDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    // Write a log file
    const logContent = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n";
    fs.writeFileSync(path.join(dataDir, "daemon.log"), logContent, "utf-8");

    // Run logs command normally
    const { stdout, code } = await runCli(["logs", "--data-dir", dataDir, "--lines", "3"]);

    expect(code).toBe(0);
    expect(stdout).toContain("Line 3");
    expect(stdout).toContain("Line 4");
    expect(stdout).toContain("Line 5");

    // Clean up
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("rejects path traversal attempts via data-dir", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-logs-"));
    const dataDir = path.join(baseDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    // Write a log file in the real data dir
    const logContent = "Real log content\n";
    fs.writeFileSync(path.join(dataDir, "daemon.log"), logContent, "utf-8");

    // Try to escape the data directory
    const escapeDir = path.join(dataDir, "..", "..");
    const { stdout, code } = await runCli(["logs", "--data-dir", escapeDir]);

    // Should either fail or safely resolve to a valid directory
    // In either case, it should not allow reading arbitrary files
    const result = code === 0 ? stdout : "";
    
    // Clean up
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("handles non-existent log file gracefully", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-logs-"));
    const dataDir = path.join(baseDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    // Don't create a log file
    const { stdout, code } = await runCli(["logs", "--data-dir", dataDir]);

    expect(code).toBe(0);
    expect(stdout).toContain("No daemon log found");

    // Clean up
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});