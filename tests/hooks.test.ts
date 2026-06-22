import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "bun";
import {
  handleUserPromptSubmit,
  UserPromptSubmitInputSchema,
} from "../src/hooks/userPromptSubmit.ts";
import { awaitCompletionNotice } from "../src/hooks/awaitNotice.ts";
import { handleStop, runStopHookCore } from "../src/hooks/stop.ts";
import { buildTaskCompletionNotice } from "../src/hooks/taskCompletionNotice.ts";
import {
  ensureDataDir,
  writeConfig,
  readAllPrompts,
  readQueueJobs,
  findPromptBySession,
  updatePrompt,
} from "../src/storage.ts";
import { defaultConfig, type PromptRecord } from "../src/schemas.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-hooks-"));
  ensureDataDir(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("handleUserPromptSubmit", () => {
  it("creates a PromptRecord and a QueueJob", () => {
    const res = handleUserPromptSubmit(
      { session_id: "s1", prompt: "hello", model: "gpt-5.5", model_reasoning_effort: "medium" },
      dataDir,
    );
    expect(res.record_id).toBeTruthy();
    expect(res.job_id).toBeTruthy();

    const prompts = readAllPrompts(dataDir);
    expect(prompts.length).toBe(1);
    expect(prompts[0]!.id).toBe(res.record_id);
    expect(prompts[0]!.session_id).toBe("s1");
    expect(prompts[0]!.codex_tier).toBe("medium");

    const jobs = readQueueJobs(dataDir);
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.id).toBe(res.job_id);
    expect(jobs[0]!.prompt_record_id).toBe(res.record_id);
    expect(jobs[0]!.status).toBe("queued");
  });

  it("clamps xhigh to high", () => {
    const res = handleUserPromptSubmit(
      { session_id: "s2", prompt: "hi", model_reasoning_effort: "xhigh" },
      dataDir,
    );
    const prompts = readAllPrompts(dataDir);
    expect(prompts[0]!.codex_tier).toBe("high");
    expect(res.record_id).toBeTruthy();
  });

  it("defaults model to gpt-5.5 when missing", () => {
    handleUserPromptSubmit({ session_id: "s3", prompt: "hi" }, dataDir);
    const prompts = readAllPrompts(dataDir);
    expect(prompts[0]!.codex_model).toBe("gpt-5.5");
  });

  it("throws when prompt is missing", () => {
    expect(() => handleUserPromptSubmit({ session_id: "s4" }, dataDir)).toThrow();
  });

  it("tolerates extra unknown fields", () => {
    expect(() =>
      handleUserPromptSubmit(
        { session_id: "s5", prompt: "hi", model: "gpt-5.5", extra: { foo: 1 } },
        dataDir,
      ),
    ).not.toThrow();
    const prompts = readAllPrompts(dataDir);
    expect(prompts.length).toBe(1);
  });

  it("preserves turn_id for Stop matching", () => {
    const res = handleUserPromptSubmit(
      { session_id: "s6", turn_id: "turn-1", prompt: "hi" },
      dataDir,
    );
    const prompts = readAllPrompts(dataDir);
    expect(prompts[0]!.id).toBe(res.record_id);
    expect(prompts[0]!.turn_id).toBe("turn-1");
    const jobs = readQueueJobs(dataDir);
    expect(jobs[0]!.turn_id).toBe("turn-1");
  });
});

describe("handleStop", () => {
  it("sets actual_execution with estimated=true when no tokens", async () => {
    handleUserPromptSubmit(
      { session_id: "sx", prompt: "hi", model_reasoning_effort: "high" },
      dataDir,
    );
    const { updated } = await handleStop({ session_id: "sx" }, dataDir);
    expect(updated).toBe(true);
    const prompts = readAllPrompts(dataDir);
    expect(prompts[0]!.actual_execution).toBeDefined();
    expect(prompts[0]!.actual_execution!.captured).toBe(true);
    expect(prompts[0]!.actual_execution!.estimated).toBe(true);
  });

  it("sets actual_execution with provided fields and estimated=false", async () => {
    handleUserPromptSubmit(
      { session_id: "sy", prompt: "hi", model_reasoning_effort: "high" },
      dataDir,
    );
    await handleStop(
      {
        session_id: "sy",
        output: "result",
        input_tokens: 100,
        output_tokens: 50,
        latency_ms: 1234,
      },
      dataDir,
    );
    const prompts = readAllPrompts(dataDir);
    const ae = prompts[0]!.actual_execution!;
    expect(ae.output).toBe("result");
    expect(ae.input_tokens).toBe(100);
    expect(ae.output_tokens).toBe(50);
    expect(ae.latency_ms).toBe(1234);
    expect(ae.estimated).toBe(false);
    expect(ae.captured).toBe(true);
  });

  it("captures workspace artifacts for file-writing prompts", async () => {
    const workspace = path.join(dataDir, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "index.html"), "<h1>Hello world</h1>");
    handleUserPromptSubmit(
      { session_id: "artifact-stop", prompt: "implement a simple hello world vanilla html page" },
      dataDir,
    );

    await handleStop(
      {
        session_id: "artifact-stop",
        last_assistant_message: "Created index.html",
      },
      dataDir,
      { artifactRoot: workspace },
    );

    const prompts = readAllPrompts(dataDir);
    expect(prompts[0]!.actual_execution!.artifacts).toEqual([
      { path: "index.html", content: "<h1>Hello world</h1>", truncated: false },
    ]);
  });

  it("captures artifacts from file paths mentioned in the final output", async () => {
    const workspace = path.join(dataDir, "workspace-by-link");
    const file = path.join(workspace, "index.html");
    fs.mkdirSync(workspace);
    fs.writeFileSync(file, "<h1>Hello from link</h1>");
    handleUserPromptSubmit(
      { session_id: "artifact-stop-link", prompt: "implement a simple hello world vanilla html page" },
      dataDir,
    );

    await handleStop(
      {
        session_id: "artifact-stop-link",
        last_assistant_message: `Implemented page at [index.html](${file}:1).`,
      },
      dataDir,
      { artifactRoot: os.homedir() },
    );

    const prompts = readAllPrompts(dataDir);
    expect(prompts[0]!.actual_execution!.artifacts).toEqual([
      {
        path: file,
        content: "<h1>Hello from link</h1>",
        truncated: false,
      },
    ]);
  });

  it("prefers Codex last_assistant_message over synthetic output", async () => {
    handleUserPromptSubmit(
      { session_id: "real-output", prompt: "hi", model_reasoning_effort: "high" },
      dataDir,
    );
    await handleStop(
      {
        session_id: "real-output",
        last_assistant_message: "real Codex answer",
        output: "synthetic fallback",
      },
      dataDir,
    );
    const prompts = readAllPrompts(dataDir);
    expect(prompts[0]!.actual_execution!.output).toBe("real Codex answer");
  });

  it("updates the prompt with the matching turn_id in a multi-turn session", async () => {
    handleUserPromptSubmit({ session_id: "multi-turn", turn_id: "turn-1", prompt: "first" }, dataDir);
    handleUserPromptSubmit({ session_id: "multi-turn", turn_id: "turn-2", prompt: "second" }, dataDir);

    const { updated } = await handleStop(
      { session_id: "multi-turn", turn_id: "turn-2", last_assistant_message: "second answer" },
      dataDir,
    );

    expect(updated).toBe(true);
    const prompts = readAllPrompts(dataDir);
    expect(prompts[0]!.actual_execution).toBeUndefined();
    expect(prompts[1]!.actual_execution!.output).toBe("second answer");
  });

  it("falls back to the latest unfinished prompt in a multi-turn session", async () => {
    handleUserPromptSubmit({ session_id: "latest-unfinished", prompt: "first" }, dataDir);
    handleUserPromptSubmit({ session_id: "latest-unfinished", prompt: "second" }, dataDir);

    const { updated } = await handleStop(
      { session_id: "latest-unfinished", last_assistant_message: "second answer" },
      dataDir,
    );

    expect(updated).toBe(true);
    const prompts = readAllPrompts(dataDir);
    expect(prompts[0]!.actual_execution).toBeUndefined();
    expect(prompts[1]!.actual_execution!.output).toBe("second answer");
  });

  it("does not update a completed prompt when no unfinished prompt remains", async () => {
    handleUserPromptSubmit({ session_id: "all-finished", prompt: "first" }, dataDir);
    await handleStop({ session_id: "all-finished", last_assistant_message: "first answer" }, dataDir);

    const { updated } = await handleStop(
      { session_id: "all-finished", last_assistant_message: "late duplicate" },
      dataDir,
    );

    expect(updated).toBe(false);
    const prompts = readAllPrompts(dataDir);
    expect(prompts[0]!.actual_execution!.output).toBe("first answer");
  });

  it("returns updated:false when session not found", async () => {
    const before = readAllPrompts(dataDir);
    const res = await handleStop({ session_id: "nope" }, dataDir);
    expect(res).toEqual({ updated: false });
    const after = readAllPrompts(dataDir);
    expect(after.length).toBe(before.length);
  });

  it("returns updated:false on empty session_id", async () => {
    expect(await handleStop({ session_id: "" }, dataDir)).toEqual({ updated: false });
    expect(await handleStop({}, dataDir)).toEqual({ updated: false });
  });

  it("returns a task-completion notice for a verified successful cheaper route", async () => {
    handleUserPromptSubmit({ session_id: "notice1", prompt: "test" }, dataDir);
    const prompt = findPromptBySession(dataDir, "notice1");
    expect(prompt).toBeDefined();
    await updatePrompt(dataDir, prompt!.id, (r) => ({
      ...r,
      verified: true,
      verification_succeeded: true,
      verification: {
        model: "gpt-5.4-mini",
        tier: "low",
        status: "succeeded",
        output: "done",
        input_tokens: 8,
        output_tokens: 3,
        estimated: false,
        latency_ms: 50,
        error: "",
        verified_at: new Date().toISOString(),
      },
    }));
    const { updated, message } = await handleStop(
      { session_id: "notice1", output: "done", input_tokens: 8, output_tokens: 3, latency_ms: 50 },
      dataDir,
    );
    expect(updated).toBe(true);
    expect(message).toBe("Routing Auditor: the previous task could have run with gpt-5.4-mini low.");
    const updatedPrompt = findPromptBySession(dataDir, "notice1");
    expect(updatedPrompt!.completion_notice_shown).toBe(true);
  });
});

describe("UserPromptSubmit pending completion notices", () => {
  it("does not show pending completion notices on next prompt submit", async () => {
    handleUserPromptSubmit({ session_id: "pending1", prompt: "test" }, dataDir);
    const prompt1 = findPromptBySession(dataDir, "pending1");
    expect(prompt1).toBeDefined();
    await updatePrompt(dataDir, prompt1!.id, (r) => ({
      ...r,
      verified: true,
      verification_succeeded: true,
      verification: {
        model: "gpt-5.4-mini",
        tier: "low",
        status: "succeeded",
        output: "done",
        input_tokens: 8,
        output_tokens: 3,
        estimated: false,
        latency_ms: 50,
        error: "",
        verified_at: new Date().toISOString(),
      },
      completion_notice_shown: false,
    }));

    const res = handleUserPromptSubmit({ session_id: "new", prompt: "new prompt" }, dataDir);

    expect(res.notices).toHaveLength(0);
    const updatedPrompt1 = findPromptBySession(dataDir, "pending1");
    expect(updatedPrompt1!.completion_notice_shown).toBe(false);

    const prompts = readAllPrompts(dataDir);
    expect(prompts.length).toBe(2);
  });

  it("does not show notice if already shown", async () => {
    // Create a verified prompt with completion_notice_shown=true
    handleUserPromptSubmit({ session_id: "already-shown", prompt: "test" }, dataDir);
    const prompt1 = findPromptBySession(dataDir, "already-shown");
    expect(prompt1).toBeDefined();
    await updatePrompt(dataDir, prompt1!.id, (r) => ({
      ...r,
      verified: true,
      verification_succeeded: true,
      verification: {
        model: "gpt-5.4-mini",
        tier: "low",
        status: "succeeded",
        output: "done",
        input_tokens: 8,
        output_tokens: 3,
        estimated: false,
        latency_ms: 50,
        error: "",
        verified_at: new Date().toISOString(),
      },
      completion_notice_shown: true,
    }));

    const res = handleUserPromptSubmit({ session_id: "new2", prompt: "new prompt" }, dataDir);

    expect(res.notices).toHaveLength(0);
  });

  it("does not show multiple pending notices", async () => {
    const { appendPrompt, generatePromptId } = await import("../src/storage.ts");

    const prompt1: PromptRecord = {
      id: generatePromptId(),
      timestamp: new Date().toISOString(),
      session_id: "pending1",
      prompt: "test1",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      verified: true,
      verification_succeeded: true,
      verification: {
        model: "gpt-5.4-mini",
        tier: "low",
        status: "succeeded",
        output: "done1",
        input_tokens: 8,
        output_tokens: 3,
        estimated: false,
        latency_ms: 50,
        error: "",
        verified_at: new Date().toISOString(),
      },
      completion_notice_shown: false,
    };
    appendPrompt(dataDir, prompt1);

    const prompt2: PromptRecord = {
      id: generatePromptId(),
      timestamp: new Date().toISOString(),
      session_id: "pending2",
      prompt: "test2",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      verified: true,
      verification_succeeded: true,
      verification: {
        model: "gpt-5.4-mini",
        tier: "low",
        status: "succeeded",
        output: "done2",
        input_tokens: 8,
        output_tokens: 3,
        estimated: false,
        latency_ms: 50,
        error: "",
        verified_at: new Date().toISOString(),
      },
      completion_notice_shown: false,
    };
    appendPrompt(dataDir, prompt2);

    const res = handleUserPromptSubmit({ session_id: "new", prompt: "new prompt" }, dataDir);

    expect(res.notices).toHaveLength(0);

    const updatedPrompt1 = findPromptBySession(dataDir, "pending1");
    const updatedPrompt2 = findPromptBySession(dataDir, "pending2");
    expect(updatedPrompt1!.completion_notice_shown).toBe(false);
    expect(updatedPrompt2!.completion_notice_shown).toBe(false);
  });
});

describe("hook subprocess integration", () => {
  const projectRoot = path.resolve(import.meta.dir, "..");

  const runHook = async (
    entry: string,
    payload: string,
    env: Record<string, string>,
  ): Promise<{ stdout: string; code: number }> => {
    const payloadFile = path.join(dataDir, "_payload.json");
    fs.writeFileSync(payloadFile, payload, "utf8");
    const proc = spawn({
      cmd: ["bun", "-e", `import { ${entry} } from './${entryPath(entry)}'; ${entry}()`],
      cwd: projectRoot,
      stdin: Bun.file(payloadFile),
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const out = await new Response(proc.stdout).text();
    const status = await proc.exited;
    return { stdout: out, code: status };
  };

  const runHookCli = async (
    payload: string,
    env: Record<string, string>,
  ): Promise<{ stdout: string; code: number }> => {
    const payloadFile = path.join(dataDir, "_payload_cli.json");
    fs.writeFileSync(payloadFile, payload, "utf8");
    const proc = spawn({
      cmd: ["bun", path.join(projectRoot, "bin", "routing-auditor.ts"), "hook", "user-prompt-submit"],
      cwd: projectRoot,
      stdin: Bun.file(payloadFile),
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const out = await new Response(proc.stdout).text();
    const status = await proc.exited;
    return { stdout: out, code: status };
  };

  const entryPath = (entry: string): string => {
    if (entry === "runUserPromptSubmitHook") return "src/hooks/userPromptSubmit.ts";
    return "src/hooks/stop.ts";
  };

  it("runUserPromptSubmitHook emits no stdout and creates job", async () => {
    const { stdout, code } = await runHook(
      "runUserPromptSubmitHook",
      JSON.stringify({ session_id: "sub1", prompt: "hello" }),
      { ROUTING_AUDITOR_DATA_DIR: dataDir, PATH: process.env.PATH ?? "", HOME: os.homedir() },
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
    const jobs = readQueueJobs(dataDir);
    expect(jobs.length).toBe(1);
  });

  it("runUserPromptSubmitHook ignores prompts when disabled", async () => {
    writeConfig(dataDir, { ...defaultConfig(), enabled: false });
    const { stdout, code } = await runHook(
      "runUserPromptSubmitHook",
      JSON.stringify({ session_id: "paused", prompt: "hello" }),
      { ROUTING_AUDITOR_DATA_DIR: dataDir, PATH: process.env.PATH ?? "", HOME: os.homedir() },
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(readAllPrompts(dataDir)).toHaveLength(0);
    expect(readQueueJobs(dataDir)).toHaveLength(0);
  });

  it("runUserPromptSubmitHook ignores internal routing-auditor ACP prompts", async () => {
    const { stdout, code } = await runHook(
      "runUserPromptSubmitHook",
      JSON.stringify({ session_id: "internal", prompt: "You are a routing auditor. Analyze this." }),
      {
        ROUTING_AUDITOR_DATA_DIR: dataDir,
        ROUTING_AUDITOR_INTERNAL: "1",
        PATH: process.env.PATH ?? "",
        HOME: os.homedir(),
      },
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(readAllPrompts(dataDir)).toHaveLength(0);
    expect(readQueueJobs(dataDir)).toHaveLength(0);
  });

  it("hooks tolerate empty or invalid inherited Routing Auditor env vars", async () => {
    const env = {
      ROUTING_AUDITOR_DATA_DIR: dataDir,
      ROUTING_AUDITOR_INTERNAL: "",
      ROUTING_AUDITOR_TTY_FD: "",
      ROUTING_AUDITOR_LOG_LEVEL: "verbose",
      PATH: process.env.PATH ?? "",
      HOME: os.homedir(),
    };

    const submit = await runHook(
      "runUserPromptSubmitHook",
      JSON.stringify({ session_id: "messy-env", turn_id: "turn-1", prompt: "hello" }),
      env,
    );
    expect(submit.code).toBe(0);
    expect(submit.stdout).toBe("");

    const stop = await runHook(
      "runStopHook",
      JSON.stringify({ session_id: "messy-env", turn_id: "turn-1", last_assistant_message: "done" }),
      env,
    );
    expect(stop.code).toBe(0);
    expect(stop.stdout).toBe("");

    const prompts = readAllPrompts(dataDir);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.actual_execution!.output).toBe("done");
  });

  it("runStopHook emits no stdout when there is no Codex message", async () => {
    handleUserPromptSubmit({ session_id: "sub2", prompt: "hi" }, dataDir);
    writeConfig(dataDir, defaultConfig({ noticeTimeoutMs: 0 }));
    const { stdout, code } = await runHook(
      "runStopHook",
      JSON.stringify({ session_id: "sub2", last_assistant_message: "done", input_tokens: 5, output_tokens: 3, latency_ms: 10 }),
      { ROUTING_AUDITOR_DATA_DIR: dataDir, PATH: process.env.PATH ?? "", HOME: os.homedir() },
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
    const prompts = readAllPrompts(dataDir);
    expect(prompts[0]!.actual_execution!.output).toBe("done");
  });

  it("runStopHook updates the latest unfinished prompt for same-session turns", async () => {
    handleUserPromptSubmit({ session_id: "sub-multi", prompt: "first" }, dataDir);
    handleUserPromptSubmit({ session_id: "sub-multi", prompt: "second" }, dataDir);
    writeConfig(dataDir, defaultConfig({ noticeTimeoutMs: 0 }));
    const { stdout, code } = await runHook(
      "runStopHook",
      JSON.stringify({ session_id: "sub-multi", last_assistant_message: "second done" }),
      { ROUTING_AUDITOR_DATA_DIR: dataDir, PATH: process.env.PATH ?? "", HOME: os.homedir() },
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
    const prompts = readAllPrompts(dataDir);
    expect(prompts[0]!.actual_execution).toBeUndefined();
    expect(prompts[1]!.actual_execution!.output).toBe("second done");
  });

  it("runStopHookCore asks Codex to print an already-ready completion notice", async () => {
    handleUserPromptSubmit({ session_id: "sub3", prompt: "test" }, dataDir);
    const prompt = findPromptBySession(dataDir, "sub3");
    expect(prompt).toBeDefined();
    await updatePrompt(dataDir, prompt!.id, (r) => ({
      ...r,
      verified: true,
      verification_succeeded: true,
      verification: {
        model: "gpt-5.4-mini",
        tier: "low",
        status: "succeeded",
        output: "done",
        input_tokens: 8,
        output_tokens: 3,
        estimated: false,
        latency_ms: 50,
        error: "",
        verified_at: new Date().toISOString(),
      },
    }));
    const output = await runStopHookCore(
      { session_id: "sub3", output: "done", input_tokens: 8, output_tokens: 3, latency_ms: 50 },
      dataDir,
    );
    expect(output).toBe(JSON.stringify({
      decision: "block",
      reason: "Reply with exactly this single sentence and do not run tools: Routing Auditor: the previous task could have run with gpt-5.4-mini low.",
    }));
    const updated = findPromptBySession(dataDir, "sub3");
    expect(updated!.completion_notice_shown).toBe(true);
  });

  it("runStopHookCore surfaces an older pending completion notice for the same session", async () => {
    handleUserPromptSubmit({ session_id: "pending-same-session", turn_id: "turn-1", prompt: "first" }, dataDir);
    const first = findPromptBySession(dataDir, "pending-same-session");
    expect(first).toBeDefined();
    await updatePrompt(dataDir, first!.id, (r) => ({
      ...r,
      actual_execution: {
        model: "gpt-5.5",
        tier: "high",
        output: "done",
        input_tokens: 1,
        output_tokens: 1,
        estimated: true,
        latency_ms: 1,
        captured: true,
      },
      verified: true,
      verification_succeeded: true,
      verification: {
        model: "gpt-5.4-mini",
        tier: "low",
        status: "succeeded",
        output: "done",
        input_tokens: 1,
        output_tokens: 1,
        estimated: true,
        latency_ms: 1,
        error: "",
        verified_at: new Date().toISOString(),
      },
    }));
    handleUserPromptSubmit({ session_id: "pending-same-session", turn_id: "turn-2", prompt: "second" }, dataDir);

    const output = await runStopHookCore(
      { session_id: "pending-same-session", turn_id: "turn-2", last_assistant_message: "second done" },
      dataDir,
      { openTtyFd: () => undefined },
    );

    expect(output).toBe(JSON.stringify({
      decision: "block",
      reason: "Reply with exactly this single sentence and do not run tools: Routing Auditor: the previous task could have run with gpt-5.4-mini low.",
    }));
    const updatedFirst = readAllPrompts(dataDir).find((p) => p.id === first!.id)!;
    expect(updatedFirst.completion_notice_shown).toBe(true);
    const second = readAllPrompts(dataDir).find((p) => p.turn_id === "turn-2")!;
    expect(second.actual_execution!.output).toBe("second done");
  });

  it("runStopHookCore long-polls and returns a block notice when verification finishes", async () => {
    handleUserPromptSubmit({ session_id: "sync-wait", turn_id: "turn-1", prompt: "test" }, dataDir);
    const prompt = findPromptBySession(dataDir, "sync-wait");
    expect(prompt).toBeDefined();
    const calls: any[] = [];
    const fakeSpawn: any = (...args: any[]) => {
      calls.push(args);
      return { unref: () => {} };
    };

    const waiting = runStopHookCore(
      { session_id: "sync-wait", turn_id: "turn-1", last_assistant_message: "done" },
      dataDir,
      {
        spawnFn: fakeSpawn,
        openTtyFd: () => undefined,
        synchronousWaitMs: 100,
        pollIntervalMs: 1,
      },
    );

    setTimeout(() => {
      updatePrompt(dataDir, prompt!.id, (r) => ({
        ...r,
        verified: true,
        verification_succeeded: true,
        verification: {
          model: "gpt-5.4-mini",
          tier: "low",
          status: "succeeded",
          output: "done",
          input_tokens: 8,
          output_tokens: 3,
          estimated: false,
          latency_ms: 50,
          error: "",
          verified_at: new Date().toISOString(),
        },
      }));
    }, 5);

    expect(await waiting).toBe(JSON.stringify({
      decision: "block",
      reason: "Reply with exactly this single sentence and do not run tools: Routing Auditor: the previous task could have run with gpt-5.4-mini low.",
    }));
    expect(calls).toHaveLength(0);
    const updated = findPromptBySession(dataDir, "sync-wait")!;
    expect(updated.completion_notice_shown).toBe(true);
  });

  it("runStopHook stays silent for Codex continuation Stop events", async () => {
    handleUserPromptSubmit({ session_id: "sub4", prompt: "test" }, dataDir);
    const prompt = findPromptBySession(dataDir, "sub4");
    expect(prompt).toBeDefined();
    await updatePrompt(dataDir, prompt!.id, (r) => ({
      ...r,
      verified: true,
      verification_succeeded: true,
      verification: {
        model: "gpt-5.4-mini",
        tier: "low",
        status: "succeeded",
        output: "done",
        input_tokens: 8,
        output_tokens: 3,
        estimated: false,
        latency_ms: 50,
        error: "",
        verified_at: new Date().toISOString(),
      },
    }));
    const { stdout, code } = await runHook(
      "runStopHook",
      JSON.stringify({ session_id: "sub4", stop_hook_active: true, output: "done" }),
      { ROUTING_AUDITOR_DATA_DIR: dataDir, PATH: process.env.PATH ?? "", HOME: os.homedir() },
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("hook never exits non-zero on bad input", async () => {
    const { stdout, code } = await runHook(
      "runUserPromptSubmitHook",
      "{not json",
      { ROUTING_AUDITOR_DATA_DIR: dataDir, PATH: process.env.PATH ?? "", HOME: os.homedir() },
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("runUserPromptSubmitHook CLI path initializes fresh data dirs", async () => {
    const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ra-fresh-hook-"));
    const cliDataDir = path.join(freshRoot, "fresh-data");
    const { stdout, code } = await runHookCli(
      JSON.stringify({ session_id: "fresh", prompt: "hello", model_reasoning_effort: "low" }),
      { ROUTING_AUDITOR_DATA_DIR: cliDataDir, PATH: process.env.PATH ?? "", HOME: os.homedir() },
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
    const prompts = readAllPrompts(cliDataDir);
    const jobs = readQueueJobs(cliDataDir);
    expect(prompts).toHaveLength(1);
    expect(jobs).toHaveLength(1);
    fs.rmSync(freshRoot, { recursive: true, force: true });
  });

  it("runStopHookCore spawns the await-notice watcher without waiting", async () => {
    handleUserPromptSubmit({ session_id: "spawn-s1", turn_id: "turn-1", prompt: "test" }, dataDir);
    writeConfig(dataDir, defaultConfig({ noticeTimeoutMs: 1234 }));
    const calls: any[] = [];
    let unrefCalled = false;
    const fakeSpawn: any = (command: string, args: string[], options: any) => {
      calls.push({ command, args, options });
      return { unref: () => { unrefCalled = true; } };
    };

    const started = Date.now();
    const output = await runStopHookCore(
      { session_id: "spawn-s1", turn_id: "turn-1", last_assistant_message: "done" },
      dataDir,
      { spawnFn: fakeSpawn, openTtyFd: () => undefined, synchronousWaitMs: 0 },
    );

    expect(Date.now() - started).toBeLessThan(50);
    expect(output).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args).toContain("await-notice");
    expect(calls[0].args).toContain("--session");
    expect(calls[0].args).toContain("spawn-s1");
    expect(calls[0].args).toContain("--turn");
    expect(calls[0].args).toContain("turn-1");
    expect(calls[0].args).toContain("--timeout-ms");
    expect(calls[0].args).toContain("1234");
    expect(calls[0].options.detached).toBe(true);
    expect(calls[0].options.stdio).toBe("ignore");
    expect(calls[0].options.env.ROUTING_AUDITOR_DATA_DIR).toBe(dataDir);
    expect(calls[0].options.env.ROUTING_AUDITOR_TTY_FD).toBeUndefined();
    expect(unrefCalled).toBe(true);
  });

  it("runStopHookCore passes an inherited tty fd to the await-notice watcher when available", async () => {
    handleUserPromptSubmit({ session_id: "spawn-tty", turn_id: "turn-1", prompt: "test" }, dataDir);
    const calls: any[] = [];
    const closed: number[] = [];
    const fakeSpawn: any = (command: string, args: string[], options: any) => {
      calls.push({ command, args, options });
      return { unref: () => {} };
    };

    const output = await runStopHookCore(
      { session_id: "spawn-tty", turn_id: "turn-1", last_assistant_message: "done" },
      dataDir,
      { spawnFn: fakeSpawn, openTtyFd: () => 99, closeFd: (fd) => closed.push(fd), synchronousWaitMs: 0 },
    );

    expect(output).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].options.stdio).toEqual(["ignore", "ignore", "ignore", 99]);
    expect(calls[0].options.env.ROUTING_AUDITOR_TTY_FD).toBe("3");
    expect(closed).toEqual([99]);
  });

  it("runStopHookCore respects backgroundNoticeEnabled false", async () => {
    handleUserPromptSubmit({ session_id: "spawn-off", turn_id: "turn-1", prompt: "test" }, dataDir);
    writeConfig(dataDir, defaultConfig({ backgroundNoticeEnabled: false }));
    const calls: any[] = [];
    const fakeSpawn: any = (...args: any[]) => {
      calls.push(args);
      return { unref: () => {} };
    };

    const output = await runStopHookCore(
      { session_id: "spawn-off", turn_id: "turn-1", last_assistant_message: "done" },
      dataDir,
      { spawnFn: fakeSpawn, openTtyFd: () => undefined, synchronousWaitMs: 0 },
    );

    expect(output).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("awaitCompletionNotice", () => {
  const createPrompt = async (over: Partial<PromptRecord> = {}): Promise<PromptRecord> => {
    const { record_id } = handleUserPromptSubmit(
      { session_id: "await-s1", turn_id: "turn-1", prompt: "test", model: "gpt-5.5", model_reasoning_effort: "high" },
      dataDir,
    );
    const prompt = readAllPrompts(dataDir).find((p) => p.id === record_id)!;
    await updatePrompt(dataDir, prompt.id, (r) => ({
      ...r,
      actual_execution: {
        model: "gpt-5.5",
        tier: "high",
        output: "done",
        input_tokens: 10,
        output_tokens: 5,
        estimated: false,
        latency_ms: 100,
        captured: true,
      },
      ...over,
    }));
    return readAllPrompts(dataDir).find((p) => p.id === record_id)!;
  };

  const markSucceeded = async (id: string): Promise<void> => {
    await updatePrompt(dataDir, id, (r) => ({
      ...r,
      verified: true,
      verification_succeeded: true,
      verification: {
        model: "gpt-5.4-mini",
        tier: "low",
        status: "succeeded",
        output: "done",
        input_tokens: 8,
        output_tokens: 3,
        estimated: false,
        latency_ms: 50,
        error: "",
        verified_at: new Date().toISOString(),
      },
    }));
  };

  it("delivers a colored notice once verification succeeds and marks it shown", async () => {
    const prompt = await createPrompt();
    const displayed: string[] = [];
    const waiting = awaitCompletionNotice({
      dataDir,
      sessionId: "await-s1",
      turnId: "turn-1",
      timeoutMs: 100,
      pollIntervalMs: 1,
      displayNotice: (notice) => {
        displayed.push(notice);
        return true;
      },
    });

    setTimeout(() => {
      markSucceeded(prompt.id);
    }, 5);

    expect(await waiting).toBe(true);
    expect(displayed).toHaveLength(1);
    expect(displayed[0]).toContain("\x1b[");
    expect(displayed[0]).toContain("Routing Auditor");
    const updated = readAllPrompts(dataDir).find((p) => p.id === prompt.id)!;
    expect(updated.completion_notice_shown).toBe(true);
  });

  it("exits silently on verification failure", async () => {
    const prompt = await createPrompt({
      verified: true,
      verification_succeeded: false,
      verification: {
        model: "gpt-5.4-mini",
        tier: "low",
        status: "failed",
        output: "",
        input_tokens: 0,
        output_tokens: 0,
        estimated: false,
        latency_ms: 0,
        error: "failed",
        verified_at: new Date().toISOString(),
      },
    });
    const displayed: string[] = [];

    expect(await awaitCompletionNotice({
      dataDir,
      sessionId: "await-s1",
      turnId: "turn-1",
      timeoutMs: 20,
      pollIntervalMs: 1,
      displayNotice: (notice) => {
        displayed.push(notice);
        return true;
      },
    })).toBe(false);
    expect(displayed).toHaveLength(0);
    expect(readAllPrompts(dataDir).find((p) => p.id === prompt.id)!.completion_notice_shown).toBe(false);
  });

  it("exits silently on timeout and leaves the notice pending", async () => {
    const prompt = await createPrompt();
    const displayed: string[] = [];

    expect(await awaitCompletionNotice({
      dataDir,
      sessionId: "await-s1",
      turnId: "turn-1",
      timeoutMs: 5,
      pollIntervalMs: 1,
      displayNotice: (notice) => {
        displayed.push(notice);
        return true;
      },
    })).toBe(false);
    expect(displayed).toHaveLength(0);
    expect(readAllPrompts(dataDir).find((p) => p.id === prompt.id)!.completion_notice_shown).toBe(false);
  });

  it("does not deliver when the notice was already shown", async () => {
    const prompt = await createPrompt({ completion_notice_shown: true });
    await markSucceeded(prompt.id);
    const displayed: string[] = [];

    expect(await awaitCompletionNotice({
      dataDir,
      sessionId: "await-s1",
      turnId: "turn-1",
      timeoutMs: 20,
      pollIntervalMs: 1,
      displayNotice: (notice) => {
        displayed.push(notice);
        return true;
      },
    })).toBe(false);
    expect(displayed).toHaveLength(0);
    expect(readAllPrompts(dataDir).find((p) => p.id === prompt.id)!.completion_notice_shown).toBe(true);
  });

  it("does not mark the notice shown when display fails", async () => {
    const prompt = await createPrompt();
    await markSucceeded(prompt.id);
    const displayed: string[] = [];

    expect(await awaitCompletionNotice({
      dataDir,
      sessionId: "await-s1",
      turnId: "turn-1",
      timeoutMs: 5,
      pollIntervalMs: 1,
      displayNotice: (notice) => {
        displayed.push(notice);
        return false;
      },
    })).toBe(false);
    expect(displayed.length).toBeGreaterThan(0);
    expect(readAllPrompts(dataDir).find((p) => p.id === prompt.id)!.completion_notice_shown).toBe(false);
  });
});

describe("buildTaskCompletionNotice", () => {
  it("returns notice when verification succeeded", () => {
    const record: PromptRecord = {
      id: "test-id",
      timestamp: new Date().toISOString(),
      session_id: "session-1",
      prompt: "test prompt",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      completion_notice_shown: false,
      verified: true,
      verification_succeeded: true,
      verification: {
        model: "gpt-5.4-mini",
        tier: "low",
        output: "ok",
        input_tokens: 10,
        output_tokens: 2,
        estimated: false,
        latency_ms: 25,
        status: "succeeded",
        error: "",
        verified_at: new Date().toISOString(),
      },
    };
    const result = buildTaskCompletionNotice(record);
    expect(result).toBe("Routing Auditor: the previous task could have run with gpt-5.4-mini low.");
  });

  it("returns notice with just the verified model when tier is missing", () => {
    const record = {
      id: "test-id",
      timestamp: new Date().toISOString(),
      session_id: "session-1",
      prompt: "test prompt",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      verified: true,
      verification_succeeded: true,
      verification: {
        model: " gpt-5.4-mini ",
        output: "ok",
        input_tokens: 10,
        output_tokens: 2,
        estimated: false,
        latency_ms: 25,
        status: "succeeded",
        error: "",
        verified_at: new Date().toISOString(),
      },
    } as unknown as PromptRecord;
    const result = buildTaskCompletionNotice(record);
    expect(result).toBe("Routing Auditor: the previous task could have run with gpt-5.4-mini.");
  });

  it("returns undefined when verified model is blank", () => {
    const record: PromptRecord = {
      id: "test-id",
      timestamp: new Date().toISOString(),
      session_id: "session-1",
      prompt: "test prompt",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      completion_notice_shown: false,
      verified: true,
      verification_succeeded: true,
      verification: {
        model: "   ",
        tier: "low",
        output: "ok",
        input_tokens: 10,
        output_tokens: 2,
        estimated: false,
        latency_ms: 25,
        status: "succeeded",
        error: "",
        verified_at: new Date().toISOString(),
      },
    };
    const result = buildTaskCompletionNotice(record);
    expect(result).toBeUndefined();
  });

  it("returns undefined when verification_succeeded is false", () => {
    const record: PromptRecord = {
      id: "test-id",
      timestamp: new Date().toISOString(),
      session_id: "session-1",
      prompt: "test prompt",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      completion_notice_shown: false,
      verified: true,
      verification_succeeded: false,
      verification: {
        model: "gpt-5.4-mini",
        tier: "low",
        output: "ok",
        input_tokens: 10,
        output_tokens: 2,
        estimated: false,
        latency_ms: 25,
        status: "succeeded",
        error: "",
        verified_at: new Date().toISOString(),
      },
    };
    const result = buildTaskCompletionNotice(record);
    expect(result).toBeUndefined();
  });

  it("returns undefined when verified is false", () => {
    const record: PromptRecord = {
      id: "test-id",
      timestamp: new Date().toISOString(),
      session_id: "session-1",
      prompt: "test prompt",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      completion_notice_shown: false,
      verified: false,
      verification_succeeded: true,
      verification: {
        model: "gpt-5.4-mini",
        tier: "low",
        output: "ok",
        input_tokens: 10,
        output_tokens: 2,
        estimated: false,
        latency_ms: 25,
        status: "succeeded",
        error: "",
        verified_at: new Date().toISOString(),
      },
    };
    const result = buildTaskCompletionNotice(record);
    expect(result).toBeUndefined();
  });

  it("returns undefined when verification is missing", () => {
    const record: PromptRecord = {
      id: "test-id",
      timestamp: new Date().toISOString(),
      session_id: "session-1",
      prompt: "test prompt",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      completion_notice_shown: false,
      verified: true,
      verification_succeeded: true,
    };
    const result = buildTaskCompletionNotice(record);
    expect(result).toBeUndefined();
  });

  it("returns undefined when verification.status is failed", () => {
    const record: PromptRecord = {
      id: "test-id",
      timestamp: new Date().toISOString(),
      session_id: "session-1",
      prompt: "test prompt",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      completion_notice_shown: false,
      verified: true,
      verification_succeeded: true,
      verification: {
        model: "gpt-5.4-mini",
        tier: "low",
        output: "ok",
        input_tokens: 10,
        output_tokens: 2,
        estimated: false,
        latency_ms: 25,
        status: "failed",
        error: "error",
        verified_at: new Date().toISOString(),
      },
    };
    const result = buildTaskCompletionNotice(record);
    expect(result).toBeUndefined();
  });
});
