import fs from "fs";
import path from "path";
import os from "os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { ensureDataDir, readConfig, writeConfig, resetRunningJobsToQueued, clearQueueJobs } from "./storage.ts";
import { ConfigSchema, ModelDefinitionSchema, defaultConfig, type Config, type ModelDefinition } from "./schemas.ts";
import { getMinimalChildEnv } from "./env.ts";
import {
  isPidRunning,
  isRoutingAuditorDaemon,
  readDaemonIdentity,
  writeDaemonIdentity,
  removeDaemonIdentity,
  type DaemonIdentity,
} from "./daemon-identity.ts";

export { migrateConfigObject };

export interface InstallOptions {
  binPath?: string;
  codexDir?: string;
  dataDir?: string;
  force?: boolean;
  startDaemon?: boolean;
}

export interface InstallResult {
  hooksPath: string;
  installed: { UserPromptSubmit: boolean; Stop: boolean };
  binPath: string;
  dataDir: string;
  configWritten: boolean;
  queueCleaned: number;
  daemon: DaemonStartResult;
  message: string;
}

export interface UninstallOptions {
  codexDir?: string;
  dataDir?: string;
  removeData?: boolean;
}

export interface UninstallResult {
  hooksPath: string;
  removedHooks: number;
  daemon: { stopped: boolean; pid?: number; wasRunning: boolean; trusted: boolean };
  dataRemoved: boolean;
  message: string;
}

export interface ToggleOptions {
  binPath?: string;
  dataDir?: string;
}

export interface ToggleResult {
  enabled: boolean;
  dataDir: string;
  daemon: {
    started?: boolean;
    stopped?: boolean;
    pid?: number;
    alreadyRunning?: boolean;
    wasRunning?: boolean;
    logPath?: string;
    restarted?: boolean;
    previousPid?: number;
    trusted?: boolean;
  };
  message: string;
}

interface DaemonStartResult {
  started: boolean;
  pid?: number;
  alreadyRunning: boolean;
  logPath: string;
  restarted?: boolean;
  previousPid?: number;
}

export const computeBinPath = (argv1: string, cwd: string): string => {
  const base = path.resolve(argv1);
  const basename = path.basename(base);
  if (basename === "routing-auditor.ts" || basename === "routing-auditor") {
    return base;
  }
  return path.join(cwd, "bin", "routing-auditor.ts");
};

const BUNX_SPEC = "github:LivioGama/routing-auditor";

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const isBunxPath = (binPath: string): boolean => {
  const normalized = path.normalize(binPath);
  return normalized.includes(`${path.sep}bunx-`) && normalized.includes(`${path.sep}node_modules${path.sep}routing-auditor${path.sep}`);
};

export interface CliInvocation {
  command: string;
  args: string[];
  shellCommand: string;
}

export const computeCliInvocation = (binPath: string): CliInvocation => {
  if (isBunxPath(binPath)) {
    return {
      command: "bunx",
      args: [BUNX_SPEC],
      shellCommand: `bunx ${BUNX_SPEC}`,
    };
  }
  return {
    command: binPath,
    args: [],
    shellCommand: shellQuote(binPath),
  };
};

export const resolveAcpCommand = (binPath: string, cwd: string): string => {
  const projectRoot = path.dirname(path.dirname(path.resolve(binPath)));
  const candidates = [
    path.join(projectRoot, "..", ".bin", "codex-acp"),
    path.join(projectRoot, "node_modules", ".bin", "codex-acp"),
    path.join(cwd, "node_modules", ".bin", "codex-acp"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "codex-acp";
};

const waitForPidExit = (pid: number, timeoutMs: number): boolean => {
  const sleepBuffer = new SharedArrayBuffer(4);
  const sleepView = new Int32Array(sleepBuffer);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return true;
    Atomics.wait(sleepView, 0, 0, 25);
  }
  return !isPidRunning(pid);
};

const readRunningDaemonPid = (pidPath: string): number | undefined => {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
    if (Number.isFinite(pid) && pid > 0 && isPidRunning(pid)) return pid;
  } catch {}
  return undefined;
};

const readRunningDaemonHandle = (dataDir: string): { pid: number; identity: DaemonIdentity | null } | null => {
  const pidPath = path.join(dataDir, "daemon.pid");
  const pid = readRunningDaemonPid(pidPath);
  if (!pid) return null;
  const identity = readDaemonIdentity(dataDir);
  return { pid, identity: identity?.pid === pid ? identity : null };
};

const stopDaemon = async (
  dataDir: string,
): Promise<{ stopped: boolean; pid?: number; wasRunning: boolean; trusted: boolean }> => {
  const pidPath = path.join(dataDir, "daemon.pid");
  const handle = readRunningDaemonHandle(dataDir);

  if (!handle) {
    try {
      fs.rmSync(pidPath, { force: true });
    } catch {}
    removeDaemonIdentity(dataDir);
    return { stopped: false, wasRunning: false, trusted: false };
  }

  const isTrusted = await isRoutingAuditorDaemon(handle.pid, dataDir);
  if (!isTrusted) {
    try {
      fs.rmSync(pidPath, { force: true });
    } catch {}
    removeDaemonIdentity(dataDir);
    return { stopped: false, pid: handle.pid, wasRunning: true, trusted: false };
  }

  try {
    process.kill(handle.pid, "SIGTERM");
  } catch {}
  if (!waitForPidExit(handle.pid, 200) && isPidRunning(handle.pid)) {
    try {
      process.kill(handle.pid, "SIGKILL");
    } catch {}
    waitForPidExit(handle.pid, 100);
  }
  try {
    fs.rmSync(pidPath, { force: true });
  } catch {}
  removeDaemonIdentity(dataDir);
  return { stopped: true, pid: handle.pid, wasRunning: true, trusted: true };
};

const startDaemon = async (
  dataDir: string,
  invocation: CliInvocation,
  options: { restartRunning?: boolean } = {},
): Promise<DaemonStartResult> => {
  const pidPath = path.join(dataDir, "daemon.pid");
  const logPath = path.join(dataDir, "daemon.log");
  const handle = readRunningDaemonHandle(dataDir);
  let previousPid: number | undefined;
  let restarted = false;
  if (handle) {
    if (!options.restartRunning) {
      return { started: false, pid: handle.pid, alreadyRunning: true, logPath };
    }
    previousPid = handle.pid;
    const stopped = await stopDaemon(dataDir);
    if (stopped.trusted) {
      // Reset running jobs to queued when we do a trusted restart
      const resetCount = resetRunningJobsToQueued(dataDir);
      restarted = true;
    }
  }

  const out = fs.openSync(logPath, "a");
  const child = spawn(invocation.command, [...invocation.args, "daemon", "--data-dir", dataDir], {
    detached: true,
    stdio: ["ignore", out, out],
    env: getMinimalChildEnv(),
  });
  child.unref();
  if (child.pid) {
    fs.writeFileSync(pidPath, `${child.pid}\n`, "utf-8");
    const daemonIdentity: DaemonIdentity = {
      pid: child.pid,
      command: invocation.shellCommand,
      startTime: Date.now(),
      uuid: crypto.randomUUID(),
      dataDir,
    };
    writeDaemonIdentity(dataDir, daemonIdentity);
  }
  return {
    started: true,
    pid: child.pid,
    alreadyRunning: false,
    logPath,
    restarted,
    previousPid,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isManagedAcpCommand = (value: unknown): boolean => {
  if (typeof value !== "string" || value.trim() === "") return true;
  if (value === "codex-acp") return true;
  const normalized = path.normalize(value);
  return normalized.endsWith(path.join("node_modules", ".bin", "codex-acp")) && !fs.existsSync(normalized);
};

const mergeModelDefinitions = (defaults: ModelDefinition[], existing: unknown): ModelDefinition[] => {
  if (!Array.isArray(existing)) return defaults;

  const userModels: ModelDefinition[] = [];
  for (const model of existing) {
    const parsed = ModelDefinitionSchema.safeParse(model);
    if (parsed.success) userModels.push(parsed.data);
  }

  const byName = new Map<string, ModelDefinition>();
  for (const model of defaults) byName.set(model.name, model);
  for (const model of userModels) byName.set(model.name, model);

  const merged: ModelDefinition[] = [];
  const seen = new Set<string>();
  for (const model of defaults) {
    const selected = byName.get(model.name);
    if (selected) {
      merged.push(selected);
      seen.add(selected.name);
    }
  }
  for (const model of userModels) {
    if (!seen.has(model.name)) {
      merged.push(model);
      seen.add(model.name);
    }
  }
  return merged;
};

const migrateConfigObject = (existing: unknown, defaults: Config): Config => {
  if (!isRecord(existing)) return defaults;

  const merged: Record<string, unknown> = { ...defaults };

  if (typeof existing.enabled === "boolean") {
    merged.enabled = existing.enabled;
  }

  if (typeof existing.assessmentModel === "string") {
    merged.assessmentModel = existing.assessmentModel;
  }

  if (typeof existing.judgeModel === "string") {
    merged.judgeModel = existing.judgeModel;
  }

  if (typeof existing.verificationEnabled === "boolean") {
    merged.verificationEnabled = existing.verificationEnabled;
  }

  if (typeof existing.stopHookEnabled === "boolean") {
    merged.stopHookEnabled = existing.stopHookEnabled;
  }

  if (typeof existing.backgroundNoticeEnabled === "boolean") {
    merged.backgroundNoticeEnabled = existing.backgroundNoticeEnabled;
  }

  if (typeof existing.noticeTimeoutMs === "number" && !Number.isNaN(existing.noticeTimeoutMs) && existing.noticeTimeoutMs >= 0) {
    merged.noticeTimeoutMs = existing.noticeTimeoutMs;
  }

  if (existing.noticeChannel === "tty" || existing.noticeChannel === "desktop" || existing.noticeChannel === "both") {
    merged.noticeChannel = existing.noticeChannel;
  }

  if (
    typeof existing.verificationThreshold === "number" &&
    !Number.isNaN(existing.verificationThreshold) &&
    Number.isFinite(existing.verificationThreshold) &&
    existing.verificationThreshold >= 0
  ) {
    merged.verificationThreshold = existing.verificationThreshold;
  }

  if (typeof existing.pollIntervalMs === "number" && !Number.isNaN(existing.pollIntervalMs) && existing.pollIntervalMs >= 100) {
    merged.pollIntervalMs = existing.pollIntervalMs;
  }

  if (
    typeof existing.datasetValuePerRecord === "number" &&
    !Number.isNaN(existing.datasetValuePerRecord) &&
    existing.datasetValuePerRecord >= 0
  ) {
    merged.datasetValuePerRecord = existing.datasetValuePerRecord;
  }

  if (
    typeof existing.projectionHorizonDays === "number" &&
    !Number.isNaN(existing.projectionHorizonDays) &&
    existing.projectionHorizonDays >= 1
  ) {
    merged.projectionHorizonDays = existing.projectionHorizonDays;
  }

  if (typeof existing.maxConcurrentJobs === "number" && !Number.isNaN(existing.maxConcurrentJobs) && existing.maxConcurrentJobs >= 1) {
    merged.maxConcurrentJobs = existing.maxConcurrentJobs;
  }

  if (
    typeof existing.maxSuggestedModels === "number" &&
    Number.isInteger(existing.maxSuggestedModels) &&
    existing.maxSuggestedModels >= 1
  ) {
    merged.maxSuggestedModels = existing.maxSuggestedModels;
  }

  if (typeof existing.fastMode === "boolean") {
    merged.fastMode = existing.fastMode;
  }

  if (
    typeof existing.retentionDays === "number" &&
    !Number.isNaN(existing.retentionDays) &&
    Number.isFinite(existing.retentionDays) &&
    existing.retentionDays >= 0
  ) {
    merged.retentionDays = existing.retentionDays;
  }

  if (typeof existing.redactPrompts === "boolean") {
    merged.redactPrompts = existing.redactPrompts;
  }

  if (typeof existing.redactOutputs === "boolean") {
    merged.redactOutputs = existing.redactOutputs;
  }

  if (isRecord(existing.pricing)) {
    const mergedPricing: Record<string, unknown> = { ...defaults.pricing };
    for (const [key, value] of Object.entries(existing.pricing)) {
      if (isRecord(value) && typeof value.input === "number" && typeof value.output === "number") {
        mergedPricing[key] = value;
      }
    }
    merged.pricing = mergedPricing;
  }

  merged.models = mergeModelDefinitions(defaults.models, existing.models);

  if (typeof existing.acpCommand === "string") {
    merged.acpCommand = isManagedAcpCommand(existing.acpCommand) ? defaults.acpCommand : existing.acpCommand;
  }

  if (Array.isArray(existing.acpArgs) && existing.acpArgs.every((arg) => typeof arg === "string")) {
    merged.acpArgs = existing.acpArgs;
  }

  return ConfigSchema.parse(merged);
};

const mergeConfigWithDefaults = (raw: unknown, defaults: Config): Config => {
  return migrateConfigObject(raw, defaults);
};

const readConfigJson = (configPath: string): unknown | undefined => {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return undefined;
  }
};

const writeJsonAtomic = (filePath: string, value: unknown): void => {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
};

const ensureMigratedConfig = (configPath: string, defaults: Config): boolean => {
  const raw = readConfigJson(configPath);
  const migrated = mergeConfigWithDefaults(raw, defaults);
  if (JSON.stringify(raw) === JSON.stringify(migrated)) return false;
  writeJsonAtomic(configPath, migrated);
  return true;
};

interface HookEntry {
  command: string;
  timeout?: number;
  type?: string;
}

interface MatcherGroup {
  matcher?: string;
  hooks: HookEntry[];
}

interface HooksFile {
  hooks?: Record<string, MatcherGroup[]>;
}

const RHOOK = "routing-auditor";

const ensureHookArray = (hooks: Record<string, MatcherGroup[]>, key: string): MatcherGroup[] => {
  if (!Array.isArray(hooks[key])) hooks[key] = [];
  return hooks[key] as MatcherGroup[];
};

const appendOurHook = (
  groups: MatcherGroup[],
  command: string,
  force: boolean,
  timeout: number,
): boolean => {
  let group: MatcherGroup | undefined;
  for (const g of groups) {
    if (g && Array.isArray(g.hooks)) {
      group = g;
      break;
    }
  }
  if (!group) {
    group = { hooks: [] };
    groups.push(group);
  }
  const existingHooks = group.hooks.filter((h) => h && typeof h.command === "string" && h.command.includes(RHOOK));
  const exists = existingHooks.length > 0;
  if (exists && !force) {
    let changed = false;
    for (const hook of existingHooks) {
      if (hook.command !== command || hook.timeout !== timeout || hook.type !== "command") {
        hook.command = command;
        hook.timeout = timeout;
        hook.type = "command";
        changed = true;
      }
    }
    return changed;
  }
  if (exists && force) {
    group.hooks = group.hooks.filter(
      (h) => !(h && typeof h.command === "string" && h.command.includes(RHOOK)),
    );
  }
  group.hooks.push({ command, timeout, type: "command" });
  return true;
};

const removeOurHooks = (groups: MatcherGroup[]): boolean => {
  let removed = false;
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue;
    const before = group.hooks.length;
    group.hooks = group.hooks.filter(
      (h) => !(h && typeof h.command === "string" && h.command.includes(RHOOK)),
    );
    if (group.hooks.length !== before) {
      removed = true;
    }
  }
  return removed;
};

export const install = async (options?: InstallOptions): Promise<InstallResult> => {
  const cwd = process.cwd();
  const binPath = options?.binPath ?? computeBinPath(process.argv[1] ?? "", cwd);
  const invocation = computeCliInvocation(binPath);
  const codexDir = options?.codexDir ?? path.join(os.homedir(), ".codex");
  const dataDir = options?.dataDir ?? path.join(os.homedir(), ".routing-auditor");
  const force = options?.force ?? false;
  const shouldStartDaemon = options?.startDaemon ?? true;
  const hooksPath = path.join(codexDir, "hooks.json");

  ensureDataDir(dataDir);
  const configPath = path.join(dataDir, "config.json");
  let configWritten = false;
  const configDefaults = defaultConfig({ acpCommand: resolveAcpCommand(binPath, cwd) });
  if (!fs.existsSync(configPath)) {
    writeJsonAtomic(configPath, configDefaults);
    configWritten = true;
  } else {
    configWritten = ensureMigratedConfig(configPath, configDefaults);
  }
  const config = readConfig(dataDir);

  let file: HooksFile = { hooks: {} };
  if (fs.existsSync(hooksPath)) {
    try {
      const raw = fs.readFileSync(hooksPath, "utf-8");
      file = JSON.parse(raw) as HooksFile;
    } catch {
      file = { hooks: {} };
    }
  }
  if (!file.hooks || typeof file.hooks !== "object") file.hooks = {};

  const upCommand = `${invocation.shellCommand} hook user-prompt-submit`;
  const stopCommand = `${invocation.shellCommand} hook stop`;
  const stopTimeoutSeconds = Math.ceil(config.noticeTimeoutMs / 1000) + 30;

  const upGroups = ensureHookArray(file.hooks, "UserPromptSubmit");
  const stopGroups = ensureHookArray(file.hooks, "Stop");
  const installedUserPrompt = appendOurHook(upGroups, upCommand, force, 5);
  const installedStop = config.stopHookEnabled
    ? appendOurHook(stopGroups, stopCommand, force, Math.max(5, stopTimeoutSeconds))
    : false;
  if (!config.stopHookEnabled) {
    removeOurHooks(stopGroups);
    file.hooks.Stop = stopGroups.filter((group) => group.hooks.length > 0);
    if (file.hooks.Stop.length === 0) {
      delete file.hooks.Stop;
    }
  }

  fs.mkdirSync(codexDir, { recursive: true });
  const tmp = `${hooksPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), "utf-8");
  fs.renameSync(tmp, hooksPath);

  const queueCleaned = force ? clearQueueJobs(dataDir) : 0;
  const daemon = shouldStartDaemon
    ? await startDaemon(dataDir, invocation, { restartRunning: true })
    : { started: false, alreadyRunning: false, logPath: path.join(dataDir, "daemon.log") };
  const daemonMessage = daemon.restarted
    ? `Daemon restarted in the background (old pid ${daemon.previousPid}, new pid ${daemon.pid}).`
    : daemon.alreadyRunning
    ? `Daemon already running (pid ${daemon.pid}).`
    : daemon.started
      ? `Daemon started in the background (pid ${daemon.pid}).`
      : "Daemon not started.";
  const queueMessage = force ? ` Cleaned ${queueCleaned} queued job(s).` : "";
  const message = `Installed Routing Auditor hooks to ${hooksPath}. Data dir: ${dataDir}.${queueMessage} ${daemonMessage}`;

  return {
    hooksPath,
    installed: { UserPromptSubmit: installedUserPrompt, Stop: installedStop },
    binPath,
    dataDir,
    configWritten,
    queueCleaned,
    daemon,
    message,
  };
};

export const uninstall = async (options?: UninstallOptions): Promise<UninstallResult> => {
  const codexDir = options?.codexDir ?? path.join(os.homedir(), ".codex");
  const dataDir = options?.dataDir ?? path.join(os.homedir(), ".routing-auditor");
  const hooksPath = path.join(codexDir, "hooks.json");
  let removedHooks = 0;

  if (fs.existsSync(hooksPath)) {
    try {
      const raw = fs.readFileSync(hooksPath, "utf-8");
      const file = JSON.parse(raw) as HooksFile;
      if (file.hooks && typeof file.hooks === "object") {
        for (const key of Object.keys(file.hooks)) {
          const groups = Array.isArray(file.hooks[key]) ? file.hooks[key] : [];
          const keptGroups: MatcherGroup[] = [];
          for (const group of groups) {
            if (!group || !Array.isArray(group.hooks)) continue;
            const before = group.hooks.length;
            group.hooks = group.hooks.filter(
              (hook) => !(hook && typeof hook.command === "string" && hook.command.includes(RHOOK)),
            );
            removedHooks += before - group.hooks.length;
            if (group.hooks.length > 0) keptGroups.push(group);
          }
          if (keptGroups.length > 0) file.hooks[key] = keptGroups;
          else delete file.hooks[key];
        }
      }
      fs.mkdirSync(codexDir, { recursive: true });
      const tmp = `${hooksPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(file, null, 2), "utf-8");
      fs.renameSync(tmp, hooksPath);
    } catch {}
  }

  const daemon = await stopDaemon(dataDir);
  const dataRemoved = options?.removeData === true;
  if (dataRemoved) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  const daemonMessage = daemon.stopped
    ? `Stopped daemon pid ${daemon.pid}.`
    : "No running daemon found.";
  const dataMessage = dataRemoved
    ? `Removed data dir ${dataDir}.`
    : `Kept data dir ${dataDir}.`;
  return {
    hooksPath,
    removedHooks,
    daemon,
    dataRemoved,
    message: `Removed ${removedHooks} Routing Auditor hook(s) from ${hooksPath}. ${daemonMessage} ${dataMessage}`,
  };
};

export const disable = async (options?: ToggleOptions): Promise<ToggleResult> => {
  const dataDir = options?.dataDir ?? path.join(os.homedir(), ".routing-auditor");
  ensureDataDir(dataDir);
  const config = readConfig(dataDir);
  writeConfig(dataDir, { ...config, enabled: false });
  const daemon = await stopDaemon(dataDir);
  const daemonMessage = daemon.stopped
    ? `Stopped daemon pid ${daemon.pid}.`
    : "No running daemon found.";
  return {
    enabled: false,
    dataDir,
    daemon,
    message: `Routing Auditor disabled. Hooks remain installed but will ignore new prompts. ${daemonMessage}`,
  };
};

export const enable = async (options?: ToggleOptions): Promise<ToggleResult> => {
  const cwd = process.cwd();
  const binPath = options?.binPath ?? computeBinPath(process.argv[1] ?? "", cwd);
  const invocation = computeCliInvocation(binPath);
  const dataDir = options?.dataDir ?? path.join(os.homedir(), ".routing-auditor");
  ensureDataDir(dataDir);
  const config = readConfig(dataDir);
  writeConfig(dataDir, { ...config, enabled: true });
  const daemon = await startDaemon(dataDir, invocation);
  const daemonMessage = daemon.alreadyRunning
    ? `Daemon already running (pid ${daemon.pid}).`
    : `Daemon started in the background (pid ${daemon.pid}).`;
  return {
    enabled: true,
    dataDir,
    daemon,
    message: `Routing Auditor enabled. ${daemonMessage}`,
  };
};
