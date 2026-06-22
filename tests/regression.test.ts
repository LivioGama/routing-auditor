import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { enqueueJob, readQueueJobs, ensureDataDir } from "../src/storage.ts";

describe("Regression: PID-file safety", () => {
  it("does not kill arbitrary process with stale PID", async () => {
    const dataDir = path.join(os.tmpdir(), `ra-pid-safety-${Date.now()}`);
    
    try {
      ensureDataDir(dataDir);
      
      // Write a fake PID file with a non-existent process
      const fakePid = 999999;
      fs.writeFileSync(path.join(dataDir, "daemon.pid"), `${fakePid}\n`, "utf8");
      
      // Write a fake identity file
      const fakeIdentity = {
        pid: fakePid,
        command: "fake-command",
        startTime: Date.now(),
        uuid: "fake-uuid",
        dataDir,
      };
      fs.writeFileSync(path.join(dataDir, "daemon.identity.json"), JSON.stringify(fakeIdentity), "utf8");
      
      // Try to stop the daemon via uninstall - should not crash and should remove stale files
      const { uninstall } = await import("../src/install.ts");
      const result = await uninstall({ dataDir });
      
      expect(result.daemon.stopped).toBe(false);
      expect(result.daemon.trusted).toBe(false);
      expect(fs.existsSync(path.join(dataDir, "daemon.pid"))).toBe(false);
      expect(fs.existsSync(path.join(dataDir, "daemon.identity.json"))).toBe(false);
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("removes stale identity files when PID doesn't match", async () => {
    const dataDir = path.join(os.tmpdir(), `ra-pid-mismatch-${Date.now()}`);
    
    try {
      ensureDataDir(dataDir);
      
      // Write a PID file with one PID
      const pidInFile = 12345;
      fs.writeFileSync(path.join(dataDir, "daemon.pid"), `${pidInFile}\n`, "utf8");
      
      // Write an identity file with a different PID
      const identity = {
        pid: 54321, // Different PID
        command: "routing-auditor daemon",
        startTime: Date.now(),
        uuid: "some-uuid",
        dataDir,
      };
      fs.writeFileSync(path.join(dataDir, "daemon.identity.json"), JSON.stringify(identity), "utf8");
      
      // Try to stop via uninstall - should clean up mismatched files
      const { uninstall } = await import("../src/install.ts");
      const result = await uninstall({ dataDir });
      
      expect(result.daemon.stopped).toBe(false);
      expect(result.daemon.trusted).toBe(false);
      expect(fs.existsSync(path.join(dataDir, "daemon.pid"))).toBe(false);
      expect(fs.existsSync(path.join(dataDir, "daemon.identity.json"))).toBe(false);
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("returns trusted=false when identity verification fails", async () => {
    const dataDir = path.join(os.tmpdir(), `ra-pid-trust-${Date.now()}`);
    
    try {
      ensureDataDir(dataDir);
      
      // Write a PID file with current process (which is not routing-auditor)
      const currentPid = process.pid;
      fs.writeFileSync(path.join(dataDir, "daemon.pid"), `${currentPid}\n`, "utf8");
      
      // Write an identity file claiming this is routing-auditor
      const identity = {
        pid: currentPid,
        command: "routing-auditor daemon",
        startTime: Date.now(),
        uuid: "some-uuid",
        dataDir,
      };
      fs.writeFileSync(path.join(dataDir, "daemon.identity.json"), JSON.stringify(identity), "utf8");
      
      // Try to stop via uninstall - should detect this is not actually routing-auditor
      const { uninstall } = await import("../src/install.ts");
      const result = await uninstall({ dataDir });
      
      expect(result.daemon.trusted).toBe(false);
      expect(fs.existsSync(path.join(dataDir, "daemon.pid"))).toBe(false);
      expect(fs.existsSync(path.join(dataDir, "daemon.identity.json"))).toBe(false);
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe("Regression: Config migration robustness", () => {
  it("preserves valid fields when some fields have invalid types", async () => {
    const dataDir = path.join(os.tmpdir(), `ra-config-migration-${Date.now()}`);
    
    try {
      const { install } = await import("../src/install.ts");
      const { defaultConfig } = await import("../src/schemas.ts");
      
      fs.mkdirSync(dataDir, { recursive: true });
    
    // Write config with some invalid types
    const invalidConfig = {
      enabled: false, // valid
      assessmentModel: "custom-model", // valid
      verificationThreshold: "not-a-number", // invalid
      pollIntervalMs: -100, // invalid (negative)
      datasetValuePerRecord: "invalid", // invalid
      pricing: {
        "gpt-5.5-high": { input: 10, output: 20 }, // valid
        "gpt-5.5-medium": { input: "invalid", output: 20 }, // invalid
      },
    };
    
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(invalidConfig), "utf8");
    
    // Run install which should migrate the config
    await install({ dataDir, startDaemon: false });
    
    // Read the migrated config
    const { readConfig } = await import("../src/storage.ts");
    const migrated = readConfig(dataDir);
    
    // Valid fields should be preserved
    expect(migrated.enabled).toBe(false);
    expect(migrated.assessmentModel).toBe("custom-model");
    
    // Invalid fields should be replaced with defaults
    expect(typeof migrated.verificationThreshold).toBe("number");
    expect(migrated.verificationThreshold).toBeGreaterThanOrEqual(0);
    expect(migrated.pollIntervalMs).toBeGreaterThanOrEqual(100);
    expect(typeof migrated.datasetValuePerRecord).toBe("number");
    expect(migrated.datasetValuePerRecord).toBeGreaterThanOrEqual(0);
    
    // Valid pricing entries should be preserved, invalid ones replaced
    expect(migrated.pricing["gpt-5.5-high"]).toEqual({ input: 10, output: 20 });
    expect(typeof migrated.pricing["gpt-5.5-medium"]?.input).toBe("number");
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("handles completely invalid config without crashing", async () => {
    const dataDir = path.join(os.tmpdir(), `ra-config-invalid-${Date.now()}`);
    
    try {
      const { install } = await import("../src/install.ts");
      const { defaultConfig } = await import("../src/schemas.ts");
      
      fs.mkdirSync(dataDir, { recursive: true });
      
      // Write completely invalid config
      fs.writeFileSync(path.join(dataDir, "config.json"), "not valid json", "utf8");
      
      // Should not crash and should create valid config
      await install({ dataDir, startDaemon: false });
      
      const { readConfig } = await import("../src/storage.ts");
      const config = readConfig(dataDir);
      
      // Should have valid defaults
      expect(typeof config.enabled).toBe("boolean");
      expect(typeof config.assessmentModel).toBe("string");
      expect(typeof config.verificationThreshold).toBe("number");
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe("Regression: Queue recovery on restart", () => {
  it("resets running jobs to queued on trusted daemon restart", async () => {
    const dataDir = path.join(os.tmpdir(), `ra-queue-recovery-${Date.now()}`);
    
    try {
    ensureDataDir(dataDir);
    
    // Create some jobs in different states
    const queuedJob = {
      id: "job1",
      prompt_record_id: "prompt1",
      session_id: "session1",
      prompt: "test prompt",
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
    
    const runningJob = {
      id: "job2",
      prompt_record_id: "prompt2",
      session_id: "session1",
      prompt: "test prompt 2",
      codex_model: "gpt-5.5",
      codex_tier: "high" as const,
      status: "running" as const,
      attempts: 1,
      max_attempts: 3,
      created_at: new Date(Date.now() - 60000).toISOString(),
      updated_at: new Date().toISOString(),
      last_error: "",
      actual_output: "",
      actual_captured: false,
    };
    
    enqueueJob(dataDir, queuedJob);
    enqueueJob(dataDir, runningJob);
    
    // Reset running jobs
    const resetCount = await import("../src/storage.ts").then(m => m.resetRunningJobsToQueued(dataDir));
    
    expect(resetCount).toBe(1);
    
    // Check that running job is now queued
    const jobs = readQueueJobs(dataDir);
    const job2 = jobs.find(j => j.id === "job2");
    expect(job2?.status).toBe("queued");
    
    // Queued job should remain queued
    const job1 = jobs.find(j => j.id === "job1");
    expect(job1?.status).toBe("queued");
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe("Regression: Empty actual output handling", () => {
  it("does not auto-pass verification when actual captured but output is empty", async () => {
    const { processJob } = await import("../src/daemon.ts");
    const { defaultConfig } = await import("../src/schemas.ts");
    const { ensureDataDir, appendPrompt, enqueueJob, findPrompt, updatePrompt } = await import("../src/storage.ts");
    
    const dataDir = path.join(os.tmpdir(), `ra-empty-output-${Date.now()}`);
    
    try {
      ensureDataDir(dataDir);
      
      // Create a prompt record with empty but captured actual execution
      const record = {
        id: "prompt1",
        timestamp: new Date().toISOString(),
        session_id: "session1",
        prompt: "test prompt",
        codex_model: "gpt-5.5",
        codex_tier: "high" as const,
        actual_execution: {
          model: "gpt-5.5",
          tier: "high" as const,
          output: "", // Empty output
          input_tokens: 100,
          output_tokens: 0,
          estimated: false,
          latency_ms: 1000,
          captured: true, // But marked as captured
        },
        verified: false,
        verification_succeeded: false,
        completion_notice_shown: false,
      };

      appendPrompt(dataDir, record);
      
      // Create a job for this prompt
      const job = {
        id: "job1",
        prompt_record_id: "prompt1",
        session_id: "session1",
        prompt: "test prompt",
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
      
      // Mock the runner to return a result
      const mockRunner = async () => ({
        output: "some predicted output",
        latencyMs: 500,
        input_tokens: 50,
        output_tokens: 20,
        estimated: false,
      });
      
      // Track whether judger was called
      let judgerCalled = false;
      const mockJudger = async () => {
        judgerCalled = true;
        return {
          winner: "original" as const,
          original_quality_score: 90,
          cheaper_quality_score: 85,
          quality_gap_score: 5,
          reasoning: "",
          input_tokens: 30,
          output_tokens: 15,
          estimated: false,
          latency_ms: 300,
          judged_at: new Date().toISOString(),
        };
      };
      
      const config = defaultConfig();
      config.verificationEnabled = true;
      
      // Process the job - this should fail due to empty actual output
      const result = await processJob(dataDir, job, config, {
        runner: mockRunner,
        assesser: async () => ({
          recommended_model: "gpt-5.4",
          recommended_tier: "medium" as const,
          acceptable_models: [],
          confidence: 80,
          reasoning_score: 5,
          coding_score: 5,
          ambiguity_score: 5,
          context_pressure_score: 5,
          instruction_complexity_score: 5,
          explanation: "",
          model: "gpt-5.5",
          tier: "high" as const,
          input_tokens: 50,
          output_tokens: 20,
          latency_ms: 500,
        }),
        judger: mockJudger,
        log: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as any,
      });
      
      // The job should fail (verification_succeeded = false) due to empty actual output
      expect(result).toBe(false);
      
      // Verify judger was not called
      expect(judgerCalled).toBe(false);
      
      // Check the final record
      const finalRecord = findPrompt(dataDir, "prompt1");
      expect(finalRecord?.verified).toBe(true); // The audit attempt completed
      expect(finalRecord?.verification_succeeded).toBe(false);
      expect(finalRecord?.verification?.status).toBe("failed");
      expect(finalRecord?.verification?.error).toBe("actual output was captured but empty; cannot judge verification");
      
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("auto-passes when actual output was never captured", async () => {
    const { processJob } = await import("../src/daemon.ts");
    const { defaultConfig } = await import("../src/schemas.ts");
    const { ensureDataDir, appendPrompt, enqueueJob, findPrompt } = await import("../src/storage.ts");
    
    const dataDir = path.join(os.tmpdir(), `ra-not-captured-${Date.now()}`);
    
    try {
      ensureDataDir(dataDir);
      
      // Create a prompt record with no actual execution (not captured)
      const record = {
        id: "prompt1",
        timestamp: new Date().toISOString(),
        session_id: "session1",
        prompt: "test prompt",
        codex_model: "gpt-5.5",
        codex_tier: "high" as const,
        verified: false,
        verification_succeeded: false,
        completion_notice_shown: false,
      };

      appendPrompt(dataDir, record);
      
      // Create a job for this prompt
      const job = {
        id: "job1",
        prompt_record_id: "prompt1",
        session_id: "session1",
        prompt: "test prompt",
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
      
      // Mock the runner to return a result
      const mockRunner = async () => ({
        output: "some predicted output",
        latencyMs: 500,
        input_tokens: 50,
        output_tokens: 20,
        estimated: false,
      });
      
      const config = defaultConfig();
      config.verificationEnabled = true;
      
      // Process the job - this should succeed since actual was never captured
      const result = await processJob(dataDir, job, config, {
        runner: mockRunner,
        assesser: async () => ({
          recommended_model: "gpt-5.4",
          recommended_tier: "medium" as const,
          acceptable_models: [],
          confidence: 80,
          reasoning_score: 5,
          coding_score: 5,
          ambiguity_score: 5,
          context_pressure_score: 5,
          instruction_complexity_score: 5,
          explanation: "",
          model: "gpt-5.5",
          tier: "high" as const,
          input_tokens: 50,
          output_tokens: 20,
          latency_ms: 500,
        }),
        judger: async () => ({
          winner: "original" as const,
          original_quality_score: 90,
          cheaper_quality_score: 85,
          quality_gap_score: 5,
          reasoning: "",
          input_tokens: 30,
          output_tokens: 15,
          estimated: false,
          latency_ms: 300,
          judged_at: new Date().toISOString(),
        }),
        log: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as any,
      });
      
      // The job should succeed (verification_succeeded = true) since actual was never captured
      expect(result).toBe(true);
      
      // Check the final record
      const finalRecord = findPrompt(dataDir, "prompt1");
      expect(finalRecord?.verification_succeeded).toBe(true);
      
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
  });
});