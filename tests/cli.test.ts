import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "bun";
import { ensureDataDir, readAllPrompts, readQueueJobs, writeConfig } from "../src/storage.ts";
import { defaultConfig } from "../src/schemas.ts";

describe("CLI report command", () => {
  const projectRoot = path.resolve(import.meta.dir, "..");

  const runCli = async (args: string[]): Promise<{ stdout: string; code: number }> => {
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
    const code = await proc.exited;
    return { stdout: out, code };
  };

  it("generates and saves a daily report in temp data dir", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-report-"));
    const dataDir = path.join(baseDir, "data");

    const { stdout, code } = await runCli(["report", "daily", "--data-dir", dataDir]);
    expect(code).toBe(0);
    const marker = "Report saved: ";
    const line = stdout
      .split(/\n/)
      .map((x) => x.trim())
      .find((x) => x.startsWith(marker));
    expect(line).toBeDefined();

    const reportPath = line!.slice(marker.length);
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.period).toBe("daily");

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("run treats first positional argument as prompt", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-run-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    writeConfig(dataDir, { ...defaultConfig(), acpCommand: "/bin/false", verificationEnabled: false });

    const prompt = "hello from cli";
    const { code } = await runCli(["run", prompt, "--data-dir", dataDir]);
    expect(code).toBe(0);

    const prompts = readAllPrompts(dataDir);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.prompt).toBe(prompt);

    const jobs = readQueueJobs(dataDir);
    expect(jobs).toHaveLength(1);

    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});
