#!/usr/bin/env bun
/**
 * Smoke script to demonstrate the empty actual output handling.
 * This script creates a temp data directory, runs a job with empty actual output,
 * and prints the final stored JSON record to show the unambiguous verification status.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { processJob } from "../src/daemon.ts";
import { defaultConfig } from "../src/schemas.ts";
import { ensureDataDir, appendPrompt, enqueueJob, findPrompt } from "../src/storage.ts";

async function main() {
  const dataDir = path.join(os.tmpdir(), `ra-smoke-empty-output-${Date.now()}`);
  
  try {
    ensureDataDir(dataDir);
    
    console.log("Smoke test: Empty actual output handling");
    console.log(`Data directory: ${dataDir}`);
    console.log();
    
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
    };
    
    appendPrompt(dataDir, record);
    console.log("Created prompt record with empty but captured actual_execution");
    console.log();
    
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
    console.log("Created queued job");
    console.log();
    
    // Mock the runner to return a result (predicted model succeeds)
    const mockRunner = async () => ({
      output: "some predicted output",
      latencyMs: 500,
      input_tokens: 50,
      output_tokens: 20,
      estimated: false,
    });
    
    const config = defaultConfig();
    config.verificationEnabled = true;
    
    console.log("Processing job with empty actual output...");
    console.log();
    
    // Process the job
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
    
    console.log(`processJob returned: ${result}`);
    console.log();
    
    // Get the final record
    const finalRecord = findPrompt(dataDir, "prompt1");
    
    if (!finalRecord) {
      console.error("Final record not found.");
      process.exit(1);
    }
    
    console.log("FINAL STORED JSON RECORD:");
    console.log("=" .repeat(80));
    console.log(JSON.stringify(finalRecord, null, 2));
    console.log("=" .repeat(80));
    console.log();
    
    console.log("KEY ASSERTIONS:");
    console.log(`  - verified: ${finalRecord.verified} (should be true - audit attempt completed)`);
    console.log(`  - verification_succeeded: ${finalRecord.verification_succeeded} (should be false)`);
    console.log(`  - verification.status: ${finalRecord.verification?.status} (should be "failed")`);
    console.log(`  - verification.error: ${finalRecord.verification?.error} (should contain clear error message)`);
    console.log(`  - judge: ${finalRecord.judge ? "exists" : "undefined"} (should be undefined - no judge call)`);
    console.log();
    
    // Verify assertions
    const assertions = [
      finalRecord.verified === true,
      finalRecord.verification_succeeded === false,
      finalRecord.verification?.status === "failed",
      finalRecord.verification?.error === "actual output was captured but empty; cannot judge verification",
      finalRecord.judge === undefined,
    ];
    
    const allPassed = assertions.every(a => a);
    
    if (allPassed) {
      console.log("All assertions passed.");
      console.log();
      console.log("The verification status is now unambiguous:");
      console.log("    - Predicted model run: succeeded (output generated)");
      console.log("    - Final verification: FAILED (actual output was empty, cannot judge)");
      console.log("    - Status field: 'failed' with clear error message");
      console.log("    - No judge was called (correctly skipped)");
    } else {
      console.log("Some assertions failed.");
      process.exit(1);
    }
    
  } finally {
    // Cleanup
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      console.log();
      console.log(`Cleaned up data directory: ${dataDir}`);
    } catch {}
  }
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
