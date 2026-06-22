import { describe, it, expect } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "bun";
import { ensureDataDir, writeConfig } from "../src/storage.ts";
import { defaultConfig } from "../src/schemas.ts";

describe("CLI status command", () => {
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

  it("does not treat live PID from daemon.identity.json as proof daemon is running", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-status-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    writeConfig(dataDir, defaultConfig());

    // Write daemon.identity.json with the current test process PID
    const currentPid = process.pid;
    const fakeIdentity = {
      pid: currentPid,
      command: "routing-auditor daemon",
      startTime: Date.now(),
      uuid: crypto.randomUUID(),
      dataDir,
    };
    fs.writeFileSync(path.join(dataDir, "daemon.identity.json"), JSON.stringify(fakeIdentity), "utf-8");

    // Run status command
    const { stdout, code } = await runCli(["status", "--data-dir", dataDir]);
    expect(code).toBe(0);

    // Assert that status does not report the routing-auditor daemon as healthy
    // The PID should be shown but with "stale/invalid identity" status
    expect(stdout).toContain(String(currentPid));
    expect(stdout).toContain("stale/invalid identity");
    expect(stdout).not.toContain("(running)");

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("reports not running when daemon.identity.json does not exist", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-status-"));
    const dataDir = path.join(baseDir, "data");
    ensureDataDir(dataDir);
    writeConfig(dataDir, defaultConfig());

    // Run status command without daemon.identity.json
    const { stdout, code } = await runCli(["status", "--data-dir", dataDir]);
    expect(code).toBe(0);

    // Assert that status reports daemon as not running
    expect(stdout).toContain("not running");
    expect(stdout).not.toContain("stale/invalid identity");

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("does not report a daemon for a path-prefix data dir as running", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-status-prefix-"));
    const dataDir = path.join(baseDir, "data");
    const otherDataDir = path.join(baseDir, "data-other");
    ensureDataDir(dataDir);
    ensureDataDir(otherDataDir);
    writeConfig(dataDir, defaultConfig());

    const proc = spawn({
      cmd: [
        "sh",
        "-c",
        `printf 'routing-auditor daemon --data-dir ${otherDataDir}\\n' >/dev/null; sleep 20`,
      ],
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      const fakeIdentity = {
        pid: proc.pid,
        command: "routing-auditor daemon",
        startTime: Date.now(),
        uuid: crypto.randomUUID(),
        dataDir,
      };
      fs.writeFileSync(path.join(dataDir, "daemon.identity.json"), JSON.stringify(fakeIdentity), "utf-8");

      const { stdout, code } = await runCli(["status", "--data-dir", dataDir]);
      expect(code).toBe(0);
      expect(stdout).toContain("stale/invalid identity");
      expect(stdout).not.toContain("(running)");
    } finally {
      proc.kill();
      await proc.exited.catch(() => {});
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
