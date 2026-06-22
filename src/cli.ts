import { Command } from "commander";
import { readConfig, readStats, writeConfig, defaultDataDir, ensureDataDir, readQueueJobs, readAllPrompts, appendPrompt, withFileLock, invalidatePromptsCache } from "./storage.ts";
import { renderLossesReport } from "./roi.ts";
import { renderStatsReport, renderRoiReport, renderInvestmentReport, generateAndSaveReport } from "./reports.ts";
import { runDaemon } from "./daemon.ts";
import {
  install as installHooks,
  uninstall as uninstallHooks,
  enable as enableAuditor,
  disable as disableAuditor,
} from "./install.ts";
import { runUserPromptSubmitHook } from "./hooks/userPromptSubmit.ts";
import { runStopHook } from "./hooks/stop.ts";
import { awaitCompletionNotice } from "./hooks/awaitNotice.ts";
import { defaultConfig, ConfigSchema, type Config, type PromptRecord, PromptRecordSchema } from "./schemas.ts";
import { redactPromptRecord, filterByRetention } from "./privacy.ts";
import { readDaemonIdentity, isRoutingAuditorDaemon, sameResolvedPath } from "./daemon-identity.ts";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getDataDir as getEnvDataDir } from "./env.ts";

const getDataDir = (): string => getEnvDataDir(defaultDataDir());

const parseStrictNumber = (value: string, key: string): number => {
  const trimmed = value.trim();
  if (trimmed === "") {
    console.error(`Invalid number value for ${key}: empty string`);
    process.exit(1);
  }
  if (trimmed === "Infinity" || trimmed === "-Infinity" || trimmed === "NaN") {
    console.error(`Invalid number value for ${key}: ${value}. Must be a finite number`);
    process.exit(1);
  }
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) {
    console.error(`Invalid number value for ${key}: ${value}. Must be a valid number`);
    process.exit(1);
  }
  const num = Number(trimmed);
  if (isNaN(num)) {
    console.error(`Invalid number value for ${key}: ${value}. Must be a valid number`);
    process.exit(1);
  }
  if (!isFinite(num)) {
    console.error(`Invalid number value for ${key}: ${value}. Must be a finite number`);
    process.exit(1);
  }
  return num;
};

const setConfigValue = (config: Config, key: string, value: string): Config => {
  const keys = key.split(".");
  let current: Record<string, unknown> = config as unknown as Record<string, unknown>;
  
  // Navigate to the parent object
  for (let i = 0; i < keys.length - 1; i++) {
    const segment = keys[i];
    if (segment === undefined || !(segment in current)) {
      console.error(`Unknown config key: ${key}`);
      process.exit(1);
    }
    current = current[segment] as Record<string, unknown>;
  }
  
  const finalKey = keys[keys.length - 1];
  if (finalKey === undefined) {
    console.error(`Unknown config key: ${key}`);
    process.exit(1);
  }
  
  // Type coercion based on the existing value type
  if (typeof current[finalKey] === "boolean") {
    if (value !== "true" && value !== "false") {
      console.error(`Invalid boolean value for ${key}: ${value}. Use: true or false`);
      process.exit(1);
    }
    current[finalKey] = value === "true";
  } else if (typeof current[finalKey] === "number") {
    current[finalKey] = parseStrictNumber(value, key);
  } else if (typeof current[finalKey] === "string") {
    current[finalKey] = value;
  } else if (Array.isArray(current[finalKey])) {
    try {
      current[finalKey] = JSON.parse(value);
    } catch {
      console.error(`Invalid array value for ${key}: ${value}. Must be valid JSON array`);
      process.exit(1);
    }
  } else if (typeof current[finalKey] === "object" && current[finalKey] !== null) {
    try {
      current[finalKey] = JSON.parse(value);
    } catch {
      console.error(`Invalid object value for ${key}: ${value}. Must be valid JSON object`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown config key: ${key}`);
    process.exit(1);
  }
  
  return config;
};

const getVersion = (): string => {
  try {
    const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    return packageJson.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
};

export const buildProgram = (): Command => {
  const program = new Command();

  program
    .name("routing-auditor")
    .description("Transparent Codex companion that audits whether a cheaper model/tier would have sufficed.")
    .version(getVersion());

  program
    .command("install")
    .description("Install Routing Auditor hooks into ~/.codex/hooks.json (idempotent, preserves existing hooks).")
    .option("--bin-path <path>", "absolute path to the routing-auditor binary")
    .option("--codex-dir <path>", "Codex config directory (default ~/.codex)")
    .option("--data-dir <path>", "Routing Auditor data directory (default ~/.routing-auditor)")
    .option("--force", "rewrite our hook entries even if already present")
    .option("--no-daemon", "install hooks and config without starting the daemon")
    .action(async (opts) => {
      const result = await installHooks({
        binPath: opts.binPath,
        codexDir: opts.codexDir,
        dataDir: opts.dataDir,
        force: opts.force ?? false,
        startDaemon: opts.daemon,
      });
      const config = readConfig(result.dataDir);
      console.log(result.message);
      console.log(`\nHooks path: ${result.hooksPath}`);
      console.log(`  UserPromptSubmit: ${result.installed.UserPromptSubmit ? "installed" : "already present"}`);
      console.log(`  Stop: ${config.stopHookEnabled ? (result.installed.Stop ? "installed" : "already present") : "disabled"}`);
      console.log(`\nDaemon log: ${result.daemon.logPath}`);
      console.log(`\nNext steps:`);
      console.log(`  1. Run Codex normally`);
      console.log(`  2. Check your losses: routing-auditor losses`);
      console.log(`  3. Edit pricing:     routing-auditor config --set datasetValuePerRecord=0.10`);
    });

  program
    .command("uninstall")
    .description("Remove Routing Auditor hooks and stop the background daemon.")
    .option("--codex-dir <path>", "Codex config directory (default ~/.codex)")
    .option("--data-dir <path>", "Routing Auditor data directory (default ~/.routing-auditor)")
    .option("--remove-data", "delete the Routing Auditor data directory after stopping the daemon")
    .action(async (opts) => {
      const result = await uninstallHooks({
        codexDir: opts.codexDir,
        dataDir: opts.dataDir,
        removeData: opts.removeData ?? false,
      });
      console.log(result.message);
    });

  program
    .command("enable")
    .description("Resume Routing Auditor and start the background daemon.")
    .option("--bin-path <path>", "absolute path to the routing-auditor binary")
    .option("--data-dir <path>", "Routing Auditor data directory (default ~/.routing-auditor)")
    .action(async (opts) => {
      const result = await enableAuditor({
        binPath: opts.binPath,
        dataDir: opts.dataDir,
      });
      console.log(result.message);
    });

  program
    .command("disable")
    .description("Pause Routing Auditor without removing hooks or data.")
    .option("--data-dir <path>", "Routing Auditor data directory (default ~/.routing-auditor)")
    .action(async (opts) => {
      const result = await disableAuditor({
        dataDir: opts.dataDir,
      });
      console.log(result.message);
    });

  program
    .command("daemon")
    .description("Run the background worker that assesses, verifies, and judges prompts.")
    .option("--data-dir <path>", "data directory")
    .option("--once", "process one job then exit (for testing)")
    .option("--poll-interval <ms>", "poll interval in milliseconds", parseInt)
    .action(async (opts) => {
      const dataDir = opts.dataDir ?? getDataDir();
      const result = await runDaemon({
        dataDir,
        once: opts.once ?? false,
        pollIntervalMs: opts.pollInterval,
      });
      console.log(`Daemon done: processed=${result.processed} succeeded=${result.succeeded} failed=${result.failed}`);
    });

  program
    .command("stats")
    .description("Display prompt analysis stats: routing accuracy, recommendations, savings.")
    .option("--data-dir <path>", "data directory")
    .action((opts) => {
      const dataDir = opts.dataDir ?? getDataDir();
      const config = readConfig(dataDir);
      const stats = readStats(dataDir);
      console.log(renderStatsReport(stats, config));
    });

  program
    .command("roi")
    .description("Display ROI: learning investment, gross/net savings, payback ratio, break-even.")
    .option("--data-dir <path>", "data directory")
    .action((opts) => {
      const dataDir = opts.dataDir ?? getDataDir();
      const config = readConfig(dataDir);
      const stats = readStats(dataDir);
      console.log(renderRoiReport(stats, config));
    });

  program
    .command("investment")
    .description("Display money spent learning, audit cost breakdown, current net position, future projections.")
    .option("--data-dir <path>", "data directory")
    .action((opts) => {
      const dataDir = opts.dataDir ?? getDataDir();
      const config = readConfig(dataDir);
      const stats = readStats(dataDir);
      console.log(renderInvestmentReport(stats, config));
    });

  program
    .command("losses")
    .description("Display the Learning Investment Report — is Routing Auditor paying for itself?")
    .option("--data-dir <path>", "data directory")
    .action((opts) => {
      const dataDir = opts.dataDir ?? getDataDir();
      const config = readConfig(dataDir);
      const stats = readStats(dataDir);
      console.log(renderLossesReport(stats, config));
    });

  program
    .command("config")
    .description("View or update configuration (assessment model, judge model, pricing, verification).")
    .option("--data-dir <path>", "data directory")
    .option("--set <key=value>", "set a config value (e.g. --set verificationEnabled=false)")
    .option("--reset", "reset config to defaults")
    .action((opts) => {
      const dataDir = opts.dataDir ?? getDataDir();
      ensureDataDir(dataDir);
      if (opts.reset) {
        writeConfig(dataDir, defaultConfig());
        console.log("Config reset to defaults.");
        return;
      }
      let config = readConfig(dataDir);
      if (opts.set) {
        const [key, ...rest] = opts.set.split("=");
        const value = rest.join("=");

        try {
          config = setConfigValue(config, key, value);
          
          // Validate against schema
          const validated = ConfigSchema.parse(config);
          writeConfig(dataDir, validated);
          console.log(`Set ${key} = ${value}`);
        } catch (error) {
          console.error(`Failed to set config: ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        }
        return;
      }
      console.log(JSON.stringify(config, null, 2));
    });

  program
    .command("status")
    .description("Show Routing Auditor status: enabled state, daemon PID, queue counts, data dir, ACP command.")
    .option("--data-dir <path>", "data directory")
    .action(async (opts) => {
      const dataDir = opts.dataDir ?? getDataDir();
      const config = readConfig(dataDir);

      // Check if daemon is running by reading daemon.identity.json
      const identity = readDaemonIdentity(dataDir);
      let daemonPid: number | null = null;
      let daemonRunning = false;
      let daemonStatus = "not running";

      if (identity) {
        daemonPid = identity.pid;
        // Verify the PID corresponds to a routing-auditor daemon for the same data dir
        const isTrusted = sameResolvedPath(identity.dataDir, dataDir) && await isRoutingAuditorDaemon(identity.pid, dataDir);
        if (isTrusted) {
          daemonRunning = true;
          daemonStatus = "running";
        } else {
          daemonStatus = "stale/invalid identity";
        }
      }

      // Get queue counts
      const jobs = readQueueJobs(dataDir);
      const queuedCount = jobs.filter(j => j.status === "queued").length;
      const runningCount = jobs.filter(j => j.status === "running").length;

      console.log("Routing Auditor Status");
      console.log("======================");
      console.log(`Enabled: ${config.enabled ? "yes" : "no"}`);
      console.log(`Daemon PID: ${daemonPid ?? "not running"} (${daemonStatus})`);
      console.log(`Queue: ${queuedCount} queued, ${runningCount} running`);
      console.log(`Data dir: ${dataDir}`);
      console.log(`ACP command: ${config.acpCommand}`);
      console.log(`Assessment model: ${config.assessmentModel}`);
      console.log(`Judge model: ${config.judgeModel}`);
      console.log(`Verification: ${config.verificationEnabled ? "enabled" : "disabled"}`);
      console.log(`Fast mode: ${config.fastMode ? "enabled" : "disabled"}`);
    });

  program
    .command("logs")
    .description("Show recent daemon log lines.")
    .option("--data-dir <path>", "data directory")
    .option("--lines <n>", "number of lines to show", "50")
    .action(async (opts) => {
      const dataDir = opts.dataDir ?? getDataDir();
      const lines = parseInt(opts.lines, 10);
      
      // Resolve and validate paths to prevent directory traversal
      const resolvedDataDir = resolve(dataDir);
      const logPath = join(resolvedDataDir, "daemon.log");
      const resolvedLogPath = resolve(logPath);
      
      // Ensure the log path is inside the data directory
      const relativePath = relative(resolvedDataDir, resolvedLogPath);
      if (relativePath.startsWith("..") || relativePath.startsWith("/")) {
        console.error("Invalid log path: must be inside data directory");
        process.exit(1);
      }
      
      if (!existsSync(resolvedLogPath)) {
        console.log("No daemon log found.");
        return;
      }
      
      try {
        // Read entire file and split into lines
        const content = readFileSync(resolvedLogPath, "utf-8");
        const allLines = content.split("\n");
        
        // Remove trailing empty line if present
        const linesWithoutTrailingEmpty = allLines[allLines.length - 1] === "" 
          ? allLines.slice(0, -1) 
          : allLines;
        
        // Get last N lines
        const tailLines = linesWithoutTrailingEmpty.slice(-lines);
        
        console.log(tailLines.join("\n"));
      } catch (err: any) {
        console.error(`Failed to read logs: ${err.message}`);
      }
    });

  program
    .command("purge")
    .description("Delete old prompt records based on retention policy.")
    .option("--data-dir <path>", "data directory")
    .option("--dry-run", "show what would be deleted without actually deleting")
    .action(async (opts) => {
      const dataDir = opts.dataDir ?? getDataDir();
      const config = readConfig(dataDir);
      const promptsPath = join(dataDir, "prompts.jsonl");

      if (!existsSync(promptsPath)) {
        console.log("No prompts found.");
        return;
      }

      const content = readFileSync(promptsPath, "utf-8");
      const lines = content.split("\n");
      const validRecords: PromptRecord[] = [];
      const corruptLines: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const parsed = JSON.parse(trimmed);
          validRecords.push(PromptRecordSchema.parse(parsed));
        } catch {
          corruptLines.push(line);
        }
      }

      const filtered = filterByRetention(validRecords, config.retentionDays);
      const toDelete = validRecords.length - filtered.length;

      if (opts.dryRun) {
        console.log(`Would delete ${toDelete} old prompt(s) (${config.retentionDays} day retention).`);
        console.log(`Would keep ${filtered.length} prompt(s).`);
        if (corruptLines.length > 0) {
          console.log(`Would preserve ${corruptLines.length} corrupt line(s) to sidecar file.`);
        }
        return;
      }

      if (toDelete === 0 && corruptLines.length === 0) {
        console.log("No old prompts to delete.");
        return;
      }

      // Rewrite the file with only the filtered records under lock
      await withFileLock(dataDir, "prompts.jsonl", () => {
        const newContent = filtered.map((r) => JSON.stringify(r)).join("\n") + "\n";
        writeFileSync(promptsPath, newContent, "utf-8");
        invalidatePromptsCache(dataDir);
      });

      console.log(`Deleted ${toDelete} old prompt(s) (${config.retentionDays} day retention).`);
      console.log(`Kept ${filtered.length} prompt(s).`);

      if (corruptLines.length > 0) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const corruptPath = join(dataDir, `prompts.jsonl.corrupt.${timestamp}.${randomUUID()}.jsonl`);
        const corruptContent = corruptLines.join("\n") + "\n";
        writeFileSync(corruptPath, corruptContent, "utf-8");
        console.error(`Preserved ${corruptLines.length} corrupt line(s) to ${corruptPath}`);
      }
    });

  program
    .command("export")
    .description("Export prompts to a file, optionally with redaction.")
    .option("--data-dir <path>", "data directory")
    .option("--output <file>", "output file path (default: prompts-export.jsonl)")
    .option("--redacted", "redact sensitive information")
    .action(async (opts) => {
      const dataDir = opts.dataDir ?? getDataDir();
      const config = readConfig(dataDir);
      const outputPath = opts.output || join(dataDir, "prompts-export.jsonl");
      
      const allPrompts = readAllPrompts(dataDir);
      const redactPrompts = opts.redacted || config.redactPrompts;
      const redactOutputs = opts.redacted || config.redactOutputs;
      
      const toExport = allPrompts.map((r) =>
        redactPromptRecord(r, redactPrompts, redactOutputs)
      );
      
      const content = toExport.map((r) => JSON.stringify(r)).join("\n") + "\n";
      writeFileSync(outputPath, content, "utf-8");
      
      console.log(`Exported ${toExport.length} prompt(s) to ${outputPath}`);
      if (opts.redacted) {
        console.log("Sensitive information has been redacted.");
      }
    });

  program
    .command("report")
    .description("Generate and save a report (daily, weekly, or monthly).")
    .option("--data-dir <path>", "data directory")
    .argument("[period]", "daily | weekly | monthly", "daily")
    .action((period, opts) => {
      const dataDir = opts.dataDir ?? getDataDir();
      const valid = ["daily", "weekly", "monthly"];
      if (!valid.includes(period)) {
        console.error(`Invalid period: ${period}. Use: ${valid.join(", ")}`);
        process.exit(1);
      }
      const path = generateAndSaveReport(dataDir, period as "daily" | "weekly" | "monthly");
      console.log(`Report saved: ${path}`);
    });

  program
    .command("run")
    .description("Manually run a prompt through the full assess + verify + judge pipeline (for testing).")
    .option("--data-dir <path>", "data directory")
    .argument("<prompt>", "the prompt to audit")
    .action(async (prompt, opts) => {
      const dataDir = opts.dataDir ?? getDataDir();
      ensureDataDir(dataDir);
      const { generatePromptId, generateJobId, appendPrompt, enqueueJob } = await import("./storage.ts");
      const record = {
        id: generatePromptId(),
        timestamp: new Date().toISOString(),
        session_id: "manual",
        prompt,
        codex_model: "gpt-5.5",
        codex_tier: "high" as const,
        verified: false,
        verification_succeeded: false,
        completion_notice_shown: false,
      };
      appendPrompt(dataDir, record);
      const job = {
        id: generateJobId(),
        prompt_record_id: record.id,
        session_id: "manual",
        prompt,
        codex_model: "gpt-5.5",
        codex_tier: "high" as const,
        status: "queued" as const,
        attempts: 0,
        max_attempts: 3,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_error: "",
        actual_output: "",
        actual_captured: false,
      };
      enqueueJob(dataDir, job);
      console.log(`Queued job ${job.id} for prompt ${record.id}. Running daemon once...`);
      const result = await runDaemon({ dataDir, once: true });
      console.log(`Done: processed=${result.processed} succeeded=${result.succeeded} failed=${result.failed}`);
      const { findPrompt } = await import("./storage.ts");
      const updated = findPrompt(dataDir, record.id);
      if (updated) console.log(JSON.stringify(updated, null, 2));
    });

  program
    .command("await-notice", { hidden: true })
    .description("Wait for an audited turn to finish verification and display its completion notice.")
    .requiredOption("--session <id>", "Codex session id")
    .option("--turn <id>", "Codex turn id")
    .option("--timeout-ms <ms>", "maximum wait in milliseconds", parseInt)
    .option("--data-dir <path>", "data directory")
    .action(async (opts) => {
      const dataDir = opts.dataDir ?? getDataDir();
      await awaitCompletionNotice({
        dataDir,
        sessionId: opts.session,
        turnId: opts.turn,
        timeoutMs: opts.timeoutMs,
      });
    });

  const hook = program.command("hook", { hidden: true });
  hook
    .command("user-prompt-submit")
    .description("Codex UserPromptSubmit hook entrypoint (reads stdin JSON).")
    .action(async () => {
      await runUserPromptSubmitHook();
    });
  hook
    .command("stop")
    .description("Codex Stop hook entrypoint (reads stdin JSON).")
    .action(async () => {
      await runStopHook();
    });

  return program;
};

export const runCli = async (argv: string[]): Promise<void> => {
  const program = buildProgram();
  await program.parseAsync(argv);
};
