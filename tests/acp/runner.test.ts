import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanAcpOutput, runPrompt, runPromptWithConfig } from "../../src/acp/runner.ts";
import { defaultConfig } from "../../src/schemas.ts";

const fakeAgentSource = `
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{protocolVersion:"0.2",capabilities:{},agentInfo:{name:"fake"}}}) + "\\n");
    } else if (msg.method === "session/new") {
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{sessionId:"s1"}}) + "\\n");
    } else if (msg.method === "session/prompt") {
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{sessionId:msg.params.sessionId,update:{type:"message",role:"assistant",content:[{type:"text",text:"Hello world"}]}}}) + "\\n");
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{stopReason:"stop",usage:{input_tokens:5,output_tokens:3}}}) + "\\n");
    }
  }
});
process.stdin.on("end", () => { process.exit(0); });
`;

const fakeNoUsageSource = fakeAgentSource.replace(
  "result:{stopReason:\"stop\",usage:{input_tokens:5,output_tokens:3}}",
  "result:{stopReason:\"stop\"}",
);

const fakeExitSource = `
process.exit(7);
`;

const fakeEnvSource = `
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{protocolVersion:"0.2",capabilities:{},agentInfo:{name:"fake"}}}) + "\\n");
    } else if (msg.method === "session/new") {
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{sessionId:"s1"}}) + "\\n");
    } else if (msg.method === "session/prompt") {
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{sessionId:msg.params.sessionId,update:{type:"message",role:"assistant",content:[{type:"text",text:process.env.ROUTING_AUDITOR_INTERNAL || "missing"}]}}}) + "\\n");
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{stopReason:"stop",usage:{input_tokens:1,output_tokens:1}}}) + "\\n");
    }
  }
});
process.stdin.on("end", () => { process.exit(0); });
`;

const fakeAgentPath = join(tmpdir(), "routing-auditor-runner-fake.ts");
const fakeNoUsagePath = join(tmpdir(), "routing-auditor-runner-fake-nousage.ts");
const fakeExitPath = join(tmpdir(), "routing-auditor-runner-fake-exit.ts");
const fakeEnvPath = join(tmpdir(), "routing-auditor-runner-fake-env.ts");

beforeAll(() => {
  writeFileSync(fakeAgentPath, fakeAgentSource, "utf8");
  writeFileSync(fakeNoUsagePath, fakeNoUsageSource, "utf8");
  writeFileSync(fakeExitPath, fakeExitSource, "utf8");
  writeFileSync(fakeEnvPath, fakeEnvSource, "utf8");
});

afterAll(() => {
  try { rmSync(fakeAgentPath); } catch {}
  try { rmSync(fakeNoUsagePath); } catch {}
  try { rmSync(fakeExitPath); } catch {}
  try { rmSync(fakeEnvPath); } catch {}
});

describe("runPrompt", () => {
  test("cleanAcpOutput removes codex-acp skill budget warning", () => {
    const raw =
      "Warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.\n\nOK";
    expect(cleanAcpOutput(raw)).toBe("OK");
  });

  test("returns RunResult with usage", async () => {
    const result = await runPrompt("hello world prompt", {
      command: process.argv[0]!,
      args: [fakeAgentPath],
      model: "gpt-5.5",
      tier: "high",
    });
    expect(result.output).toBe("Hello world");
    expect(result.input_tokens).toBe(5);
    expect(result.output_tokens).toBe(3);
    expect(result.estimated).toBe(false);
    expect(result.latencyMs).toBeGreaterThan(0);
  });

  test("estimates tokens when usage absent", async () => {
    const result = await runPrompt("hello world prompt", {
      command: process.argv[0]!,
      args: [fakeNoUsagePath],
      model: "gpt-5.5",
      tier: "high",
    });
    expect(result.output).toBe("Hello world");
    expect(result.estimated).toBe(true);
    expect(result.input_tokens).toBeGreaterThan(0);
    expect(result.output_tokens).toBeGreaterThan(0);
  });

  test("closes client even on error (agent exits immediately)", async () => {
    await expect(
      runPrompt("hello", {
        command: process.argv[0]!,
        args: [fakeExitPath],
        model: "gpt-5.5",
        tier: "high",
      }),
    ).rejects.toThrow();
  });

  test("marks spawned ACP calls as internal routing-auditor work", async () => {
    const result = await runPrompt("hello", {
      command: process.argv[0]!,
      args: [fakeEnvPath],
      env: { ROUTING_AUDITOR_INTERNAL: "0" },
      model: "gpt-5.5",
      tier: "high",
    });
    expect(result.output).toBe("1");
  });
});

describe("runPromptWithConfig", () => {
  test("uses config.acpCommand/args and passes model+tier", async () => {
    const config = defaultConfig({
      acpCommand: process.argv[0]!,
      acpArgs: [fakeAgentPath],
      assessmentModel: "gpt-5.5-high",
    });
    const result = await runPromptWithConfig("hi", config);
    expect(result.output).toBe("Hello world");
    expect(result.estimated).toBe(false);
  });
});
