import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "bun";
import { ensureDataDir, readConfig, writeConfig } from "../src/storage.ts";
import { defaultConfig } from "../src/schemas.ts";

describe("CLI config --set numeric validation", () => {
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

  it("rejects malformed numeric value '1abc'", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-config-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    writeConfig(dataDir, defaultConfig());

    const originalConfig = readConfig(dataDir);
    const originalValue = originalConfig.datasetValuePerRecord;

    const { stderr, code } = await runCli(["config", "--set", "datasetValuePerRecord=1abc", "--data-dir", dataDir]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("Invalid number value");

    const configAfter = readConfig(dataDir);
    expect(configAfter.datasetValuePerRecord).toBe(originalValue);

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("rejects empty string for numeric config", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-config-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    writeConfig(dataDir, defaultConfig());

    const originalConfig = readConfig(dataDir);
    const originalValue = originalConfig.datasetValuePerRecord;

    const { stderr, code } = await runCli(["config", "--set", "datasetValuePerRecord=", "--data-dir", dataDir]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("empty string");

    const configAfter = readConfig(dataDir);
    expect(configAfter.datasetValuePerRecord).toBe(originalValue);

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("rejects 'Infinity' for numeric config", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-config-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    writeConfig(dataDir, defaultConfig());

    const originalConfig = readConfig(dataDir);
    const originalValue = originalConfig.datasetValuePerRecord;

    const { stderr, code } = await runCli(["config", "--set", "datasetValuePerRecord=Infinity", "--data-dir", dataDir]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("finite number");

    const configAfter = readConfig(dataDir);
    expect(configAfter.datasetValuePerRecord).toBe(originalValue);

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("rejects '-Infinity' for numeric config", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-config-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    writeConfig(dataDir, defaultConfig());

    const originalConfig = readConfig(dataDir);
    const originalValue = originalConfig.datasetValuePerRecord;

    const { stderr, code } = await runCli(["config", "--set", "datasetValuePerRecord=-Infinity", "--data-dir", dataDir]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("finite number");

    const configAfter = readConfig(dataDir);
    expect(configAfter.datasetValuePerRecord).toBe(originalValue);

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("rejects 'NaN' for numeric config", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-config-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    writeConfig(dataDir, defaultConfig());

    const originalConfig = readConfig(dataDir);
    const originalValue = originalConfig.datasetValuePerRecord;

    const { stderr, code } = await runCli(["config", "--set", "datasetValuePerRecord=NaN", "--data-dir", dataDir]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("finite number");

    const configAfter = readConfig(dataDir);
    expect(configAfter.datasetValuePerRecord).toBe(originalValue);

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("config file contents unchanged after failed numeric set", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-config-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    writeConfig(dataDir, defaultConfig());

    const originalConfig = readConfig(dataDir);
    const originalConfigJson = JSON.stringify(originalConfig);

    await runCli(["config", "--set", "datasetValuePerRecord=invalid", "--data-dir", dataDir]);

    const configAfter = readConfig(dataDir);
    const configAfterJson = JSON.stringify(configAfter);

    expect(configAfterJson).toBe(originalConfigJson);

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("valid numeric update is written successfully", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-config-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    writeConfig(dataDir, defaultConfig());

    const { stdout, code } = await runCli(["config", "--set", "datasetValuePerRecord=0.15", "--data-dir", dataDir]);
    expect(code).toBe(0);
    expect(stdout).toContain("Set datasetValuePerRecord = 0.15");

    const configAfter = readConfig(dataDir);
    expect(configAfter.datasetValuePerRecord).toBe(0.15);

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("accepts finite numeric literals that normalize to a different string", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-config-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    writeConfig(dataDir, defaultConfig());

    const { stdout, code } = await runCli(["config", "--set", "datasetValuePerRecord=1.0", "--data-dir", dataDir]);
    expect(code).toBe(0);
    expect(stdout).toContain("Set datasetValuePerRecord = 1.0");

    const configAfter = readConfig(dataDir);
    expect(configAfter.datasetValuePerRecord).toBe(1);

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("valid integer numeric update is written successfully", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-config-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    writeConfig(dataDir, defaultConfig());

    const { stdout, code } = await runCli(["config", "--set", "maxConcurrentJobs=3", "--data-dir", dataDir]);
    expect(code).toBe(0);
    expect(stdout).toContain("Set maxConcurrentJobs = 3");

    const configAfter = readConfig(dataDir);
    expect(configAfter.maxConcurrentJobs).toBe(3);

    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});
