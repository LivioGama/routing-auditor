import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import {
  install,
  uninstall,
  enable,
  disable,
  computeBinPath,
  computeCliInvocation,
  resolveAcpCommand,
  InstallOptions,
} from "../src/install.ts";
import { defaultConfig, type QueueJob } from "../src/schemas.ts";
import { ensureDataDir, enqueueJob, generateJobId, generatePromptId, readConfig, readQueueJobs } from "../src/storage.ts";

let codexDir: string;
let dataDir: string;
let binPath: string;

beforeEach(() => {
  codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-codex-"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-data-"));
  binPath = path.join(os.tmpdir(), "ra-bin", "routing-auditor.ts");
});

afterEach(() => {
  fs.rmSync(codexDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const baseOpts = (): InstallOptions => ({
  binPath,
  codexDir,
  dataDir,
  startDaemon: false,
});

const readHooks = (): any => {
  return JSON.parse(fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8"));
};

const makeJob = (overrides: Partial<QueueJob> = {}): QueueJob => ({
  id: generateJobId(),
  prompt_record_id: generatePromptId(),
  session_id: "",
  prompt: "hello",
  codex_model: "gpt-5.5",
  codex_tier: "high",
  status: "queued",
  attempts: 0,
  max_attempts: 3,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_error: "",
  actual_output: "",
  actual_captured: false,
  ...overrides,
});

const isPidRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const state = execSync(`ps -p ${pid} -o stat=`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return !state.startsWith("Z");
  } catch {
    return true;
  }
};

const waitForPidExit = (pid: number, timeoutMs = 1000): boolean => {
  const sleepBuffer = new SharedArrayBuffer(4);
  const sleepView = new Int32Array(sleepBuffer);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return true;
    Atomics.wait(sleepView, 0, 0, 25);
  }
  return !isPidRunning(pid);
};

const terminatePid = (pid: number | undefined): void => {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  if (!waitForPidExit(pid) && isPidRunning(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    waitForPidExit(pid, 500);
  }
};

const spawnLegacyDaemon = (): { pid: number; scriptPath: string; cleanup: () => void } => {
  const scriptPath = path.join(os.tmpdir(), `routing-auditor-daemon-legacy-${Date.now()}-${Math.random()}.ts`);
  fs.writeFileSync(scriptPath, "setInterval(() => {}, 1000);\n", "utf8");
  const child = spawn(process.argv[0]!, [scriptPath, "daemon", "--data-dir", dataDir], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (!child.pid) throw new Error("legacy daemon did not start");
  const cleanup = (): void => {
    terminatePid(child.pid);
    try {
      fs.rmSync(scriptPath, { force: true });
    } catch {}
  };
  return { pid: child.pid, scriptPath, cleanup };
};

describe("install", () => {
  it("creates hooks.json when missing", async () => {
    const res = await install(baseOpts());
    expect(res.installed.UserPromptSubmit).toBe(true);
    expect(res.installed.Stop).toBe(true);
    const f = readHooks();
    const up = f.hooks.UserPromptSubmit[0].hooks.find((h: any) => h.command.includes("routing-auditor"));
    const st = f.hooks.Stop[0].hooks.find((h: any) => h.command.includes("routing-auditor"));
    expect(up).toBeDefined();
    expect(st).toBeDefined();
    expect(up.command).toContain("hook user-prompt-submit");
    expect(st.command).toContain("hook stop");
  });

  it("preserves existing hooks and appends ours", async () => {
    const existing = {
      hooks: {
        PermissionRequest: [
          { hooks: [{ command: "'/usr/local/bin/vibe-island-bridge' --source codex", timeout: 7200, type: "command" }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ command: "'/usr/local/bin/vibe-island-bridge' --source codex", timeout: 5, type: "command" }] },
        ],
        Stop: [
          { hooks: [{ command: "'/usr/local/bin/vibe-island-bridge' --source codex", timeout: 5, type: "command" }] },
        ],
      },
    };
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "hooks.json"), JSON.stringify(existing), "utf8");

    await install(baseOpts());
    const f = readHooks();

    expect(f.hooks.PermissionRequest[0].hooks.length).toBe(1);
    expect(f.hooks.PermissionRequest[0].hooks[0].command).toContain("vibe-island-bridge");

    const upHooks = f.hooks.UserPromptSubmit[0].hooks;
    expect(upHooks.length).toBe(2);
    expect(upHooks.some((h: any) => h.command.includes("vibe-island-bridge"))).toBe(true);
    expect(upHooks.some((h: any) => h.command.includes("routing-auditor"))).toBe(true);

    const stopHooks = f.hooks.Stop[0].hooks;
    expect(stopHooks.length).toBe(2);
    expect(stopHooks.some((h: any) => h.command.includes("vibe-island-bridge"))).toBe(true);
    expect(stopHooks.some((h: any) => h.command.includes("routing-auditor"))).toBe(true);
  });

  it("does not install the Stop hook when stopHookEnabled=false", async () => {
    ensureDataDir(dataDir);
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify(defaultConfig({ stopHookEnabled: false }), null, 2),
    );

    const res = await install(baseOpts());
    expect(res.installed.UserPromptSubmit).toBe(true);
    expect(res.installed.Stop).toBe(false);
    const f = readHooks();
    expect(f.hooks.UserPromptSubmit[0].hooks.some((h: any) => h.command.includes("routing-auditor"))).toBe(true);
    expect(f.hooks.Stop).toBeUndefined();
  });

  it("is idempotent on second run", async () => {
    await install(baseOpts());
    await install(baseOpts());
    const f = readHooks();
    const up = f.hooks.UserPromptSubmit[0].hooks.filter((h: any) => h.command.includes("routing-auditor"));
    const st = f.hooks.Stop[0].hooks.filter((h: any) => h.command.includes("routing-auditor"));
    expect(up.length).toBe(1);
    expect(st.length).toBe(1);
  });

  it("force rewrites our entry", async () => {
    await install(baseOpts());
    const newBin = path.join(os.tmpdir(), "ra-bin2", "routing-auditor.ts");
    await install({ ...baseOpts(), binPath: newBin, force: true });
    const f = readHooks();
    const up = f.hooks.UserPromptSubmit[0].hooks.filter((h: any) => h.command.includes("routing-auditor"));
    expect(up.length).toBe(1);
    expect(up[0].command).toContain(newBin);
  });

  it("force install cleans queued jobs", async () => {
    ensureDataDir(dataDir);
    enqueueJob(dataDir, makeJob({ id: "j1", status: "queued" }));
    enqueueJob(dataDir, makeJob({ id: "j2", status: "assessed" }));

    const res = await install({ ...baseOpts(), force: true });

    expect(res.queueCleaned).toBe(2);
    expect(res.message).toContain("Cleaned 2 queued job(s).");
    expect(readQueueJobs(dataDir)).toHaveLength(0);
  });

  it("normal install preserves queued jobs", async () => {
    ensureDataDir(dataDir);
    enqueueJob(dataDir, makeJob({ id: "j1", status: "queued" }));

    const res = await install(baseOpts());

    expect(res.queueCleaned).toBe(0);
    expect(readQueueJobs(dataDir).map((j) => j.id)).toEqual(["j1"]);
  });

  it("writes config.json only if missing and leaves current defaults unchanged", async () => {
    const r1 = await install(baseOpts());
    expect(r1.configWritten).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "config.json"))).toBe(true);
    const before = fs.readFileSync(path.join(dataDir, "config.json"), "utf8");
    expect(JSON.parse(before).acpCommand).toContain(path.join("node_modules", ".bin", "codex-acp"));
    const r2 = await install(baseOpts());
    expect(r2.configWritten).toBe(false);
    const after = fs.readFileSync(path.join(dataDir, "config.json"), "utf8");
    expect(after).toBe(before);
  });

  it("migrates existing config with missing defaults without wiping user overrides", async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({
        enabled: false,
        assessmentModel: "custom-assessor",
        pricing: {
          "gpt-5.5-high": { input: 99, output: 100 },
        },
        models: [{ name: "custom-model", tiers: ["high"] }],
      }),
      "utf8",
    );

    const r = await install(baseOpts());
    const migrated = readConfig(dataDir);

    expect(r.configWritten).toBe(true);
    expect(migrated.enabled).toBe(false);
    expect(migrated.assessmentModel).toBe("custom-assessor");
    expect(migrated.pricing["gpt-5.5-high"]).toEqual({ input: 99, output: 100 });
    expect(migrated.pricing["gpt-5.4-mini-low"]).toBeDefined();
    expect(migrated.models.some((m) => m.name === "custom-model")).toBe(true);
    expect(migrated.acpCommand).toContain(path.join("node_modules", ".bin", "codex-acp"));
  });

  it("preserves explicit custom acpCommand during config migration", async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ ...defaultConfig(), acpCommand: "/opt/custom/codex-acp" }),
      "utf8",
    );

    await install(baseOpts());

    expect(readConfig(dataDir).acpCommand).toBe("/opt/custom/codex-acp");
  });

  it("starts the daemon by default", async () => {
    const projectRoot = path.resolve(import.meta.dir, "..");
    const res = await install({
      binPath: path.join(projectRoot, "bin", "routing-auditor.ts"),
      codexDir,
      dataDir,
    });
    expect(res.daemon.started).toBe(true);
    expect(res.daemon.pid).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dataDir, "daemon.pid"))).toBe(true);
    terminatePid(res.daemon.pid);
  });

  it("force install restarts an already-running daemon", async () => {
    const projectRoot = path.resolve(import.meta.dir, "..");
    const first = await install({
      binPath: path.join(projectRoot, "bin", "routing-auditor.ts"),
      codexDir,
      dataDir,
    });
    expect(first.daemon.started).toBe(true);
    expect(first.daemon.pid).toBeGreaterThan(0);

    const second = await install({
      binPath: path.join(projectRoot, "bin", "routing-auditor.ts"),
      codexDir,
      dataDir,
      force: true,
    });

    expect(second.daemon.started).toBe(true);
    expect(second.daemon.restarted).toBe(true);
    expect(second.daemon.previousPid).toBe(first.daemon.pid);
    expect(second.daemon.pid).toBeGreaterThan(0);
    expect(second.daemon.pid).not.toBe(first.daemon.pid);
    terminatePid(second.daemon.pid);
  });

  it("force install restarts a pid-file daemon even when identity is missing", async () => {
    ensureDataDir(dataDir);
    const legacy = spawnLegacyDaemon();
    fs.writeFileSync(path.join(dataDir, "daemon.pid"), `${legacy.pid}\n`, "utf8");

    try {
      const projectRoot = path.resolve(import.meta.dir, "..");
      const result = await install({
        binPath: path.join(projectRoot, "bin", "routing-auditor.ts"),
        codexDir,
        dataDir,
        force: true,
      });

      expect(result.daemon.started).toBe(true);
      expect(result.daemon.restarted).toBe(true);
      expect(result.daemon.previousPid).toBe(legacy.pid);
      expect(isPidRunning(legacy.pid)).toBe(false);
      expect(result.daemon.pid).toBeGreaterThan(0);
      expect(result.daemon.pid).not.toBe(legacy.pid);
      terminatePid(result.daemon.pid);
    } finally {
      legacy.cleanup();
    }
  });

  it("preserves user config values while refreshing managed defaults", async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    const custom = { ...defaultConfig(), assessmentModel: "custom-model" };
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(custom), "utf8");
    const r = await install(baseOpts());
    expect(r.configWritten).toBe(true);
    const after = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    expect(after.assessmentModel).toBe("custom-model");
    expect(after.acpCommand).toContain(path.join("node_modules", ".bin", "codex-acp"));
  });
});

describe("uninstall", () => {
  it("removes Routing Auditor hooks and preserves unrelated hooks", async () => {
    const existing = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              { command: "'/usr/local/bin/other-tool'", timeout: 5, type: "command" },
              { command: "'/tmp/routing-auditor.ts' hook user-prompt-submit", timeout: 5, type: "command" },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              { command: "'/tmp/routing-auditor.ts' hook stop", timeout: 5, type: "command" },
            ],
          },
        ],
      },
    };
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "hooks.json"), JSON.stringify(existing), "utf8");

    const res = await uninstall({ codexDir, dataDir });
    expect(res.removedHooks).toBe(2);
    const f = readHooks();
    expect(f.hooks.UserPromptSubmit[0].hooks).toHaveLength(1);
    expect(f.hooks.UserPromptSubmit[0].hooks[0].command).toContain("other-tool");
    expect(f.hooks.Stop).toBeUndefined();
  });

  it("keeps data by default and removes it with --remove-data behavior", async () => {
    fs.writeFileSync(path.join(dataDir, "sample.txt"), "data", "utf8");
    const keep = await uninstall({ codexDir, dataDir });
    expect(keep.dataRemoved).toBe(false);
    expect(fs.existsSync(dataDir)).toBe(true);

    const remove = await uninstall({ codexDir, dataDir, removeData: true });
    expect(remove.dataRemoved).toBe(true);
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("stops a running daemon", async () => {
    const projectRoot = path.resolve(import.meta.dir, "..");
    const installed = await install({
      binPath: path.join(projectRoot, "bin", "routing-auditor.ts"),
      codexDir,
      dataDir,
    });
    expect(installed.daemon.pid).toBeGreaterThan(0);

    const removed = await uninstall({ codexDir, dataDir });
    expect(removed.daemon.stopped).toBe(true);
    expect(removed.daemon.pid).toBe(installed.daemon.pid);
    expect(fs.existsSync(path.join(dataDir, "daemon.pid"))).toBe(false);
  });

  it("stops a pid-file daemon even when identity is missing", async () => {
    ensureDataDir(dataDir);
    const legacy = spawnLegacyDaemon();
    fs.writeFileSync(path.join(dataDir, "daemon.pid"), `${legacy.pid}\n`, "utf8");

    try {
      const removed = await uninstall({ codexDir, dataDir });

      expect(removed.daemon.stopped).toBe(true);
      expect(removed.daemon.trusted).toBe(true);
      expect(removed.daemon.pid).toBe(legacy.pid);
      expect(isPidRunning(legacy.pid)).toBe(false);
      expect(fs.existsSync(path.join(dataDir, "daemon.pid"))).toBe(false);
    } finally {
      legacy.cleanup();
    }
  });
});

describe("enable / disable", () => {
  it("disable sets enabled=false and stops the daemon", async () => {
    const projectRoot = path.resolve(import.meta.dir, "..");
    const installed = await install({
      binPath: path.join(projectRoot, "bin", "routing-auditor.ts"),
      codexDir,
      dataDir,
    });
    expect(installed.daemon.pid).toBeGreaterThan(0);

    const result = await disable({ dataDir });
    expect(result.enabled).toBe(false);
    expect(readConfig(dataDir).enabled).toBe(false);
    expect(result.daemon.stopped).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "daemon.pid"))).toBe(false);
  });

  it("enable sets enabled=true and starts the daemon", async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ ...defaultConfig(), enabled: false }), "utf8");
    const projectRoot = path.resolve(import.meta.dir, "..");

    const result = await enable({
      binPath: path.join(projectRoot, "bin", "routing-auditor.ts"),
      dataDir,
    });
    expect(result.enabled).toBe(true);
    expect(readConfig(dataDir).enabled).toBe(true);
    expect(result.daemon.started).toBe(true);
    expect(result.daemon.pid).toBeGreaterThan(0);
    terminatePid(result.daemon.pid);
  });
});

describe("computeBinPath", () => {
  it("returns argv1 when it points to routing-auditor.ts", () => {
    expect(computeBinPath("/x/bin/routing-auditor.ts", "/x")).toBe("/x/bin/routing-auditor.ts");
  });

  it("returns argv1 when it points to routing-auditor", () => {
    expect(computeBinPath("/x/bin/routing-auditor", "/x")).toBe("/x/bin/routing-auditor");
  });

  it("falls back to cwd/bin/routing-auditor.ts for weird argv1", () => {
    expect(computeBinPath("/some/other/script.ts", "/proj")).toBe("/proj/bin/routing-auditor.ts");
  });
});

describe("computeCliInvocation", () => {
  it("uses the script path for normal installs", () => {
    const invocation = computeCliInvocation("/repo/bin/routing-auditor.ts");
    expect(invocation.command).toBe("/repo/bin/routing-auditor.ts");
    expect(invocation.args).toEqual([]);
    expect(invocation.shellCommand).toBe("'/repo/bin/routing-auditor.ts'");
  });

  it("uses a stable bunx GitHub command for bunx installs", () => {
    const invocation = computeCliInvocation(
      "/private/tmp/bunx-501-routing-auditor@github@123/node_modules/routing-auditor/bin/routing-auditor.ts",
    );
    expect(invocation.command).toBe("bunx");
    expect(invocation.args).toEqual(["github:LivioGama/routing-auditor"]);
    expect(invocation.shellCommand).toBe("bunx github:LivioGama/routing-auditor");
  });
});

describe("resolveAcpCommand", () => {
  it("prefers the project-local Zed codex-acp binary", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-acp-root-"));
    const localBin = path.join(root, "node_modules", ".bin", "codex-acp");
    fs.mkdirSync(path.dirname(localBin), { recursive: true });
    fs.writeFileSync(localBin, "#!/bin/sh\n", "utf8");

    expect(resolveAcpCommand(path.join(root, "bin", "routing-auditor.ts"), "/elsewhere")).toBe(localBin);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("falls back to codex-acp when no local binary exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-acp-root-"));
    expect(resolveAcpCommand(path.join(root, "bin", "routing-auditor.ts"), root)).toBe("codex-acp");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
