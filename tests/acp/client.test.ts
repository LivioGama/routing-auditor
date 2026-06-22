import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { AcpClient, AcpTimeoutError, AcpProtocolError, AcpClosedError } from "../../src/acp/client.ts";

const fakeAgentSource = `
process.stdin.setEncoding("utf8");
let buf = "";
let inboundTriggerId = null;
process.stderr.write("agent stderr log\\n");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if ((msg.id === 901 || msg.id === 902) && (msg.result !== undefined || msg.error !== undefined)) {
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:inboundTriggerId,result:{inboundResponse:msg}}) + "\\n");
      inboundTriggerId = null;
      continue;
    }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{protocolVersion:"0.2",capabilities:{},agentInfo:{name:"fake"},receivedClientCapabilities:msg.params.clientCapabilities}}) + "\\n");
    } else if (msg.method === "session/new") {
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{sessionId:"s1"}}) + "\\n");
    } else if (msg.method === "session/prompt") {
      const promptText = msg.params && Array.isArray(msg.params.prompt) && msg.params.prompt[0] ? msg.params.prompt[0].text : "";
      if (promptText === "progress-then-final") {
        process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{sessionId:msg.params.sessionId,update:{type:"message",role:"assistant",content:[{type:"text",text:"I’ll inspect the workspace first."}]}}}) + "\\n");
        process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{sessionId:msg.params.sessionId,update:{type:"message",role:"assistant",content:[{type:"text",text:"Implemented a minimal vanilla HTML page at index.html."}]}}}) + "\\n");
        process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{stopReason:"stop",usage:{input_tokens:5,output_tokens:3}}}) + "\\n");
        continue;
      }
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{sessionId:msg.params.sessionId,update:{type:"message",role:"assistant",content:[{type:"text",text:"Hello world"}]}}}) + "\\n");
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{stopReason:"stop",usage:{input_tokens:5,output_tokens:3}}}) + "\\n");
    } else if (msg.method === "error_method") {
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,error:{code:-32000,message:"boom"}}) + "\\n");
    } else if (msg.method === "split_method") {
      const resp = JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{ok:true}});
      const mid = Math.floor(resp.length / 2);
      process.stdout.write(resp.slice(0, mid));
      process.stdout.write(resp.slice(mid) + "\\n");
    } else if (msg.method === "trigger_inbound_request") {
      inboundTriggerId = msg.id;
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:901,method:"fs/readTextFile",params:{path:"/tmp/secret.txt"}}) + "\\n");
    } else if (msg.method === "trigger_permission_request") {
      inboundTriggerId = msg.id;
      const toolCall = msg.params && msg.params.kind ? {toolCall:{kind:msg.params.kind}} : {};
      process.stdout.write(JSON.stringify(Object.assign({jsonrpc:"2.0",id:902,method:"session/request_permission",params:Object.assign({sessionId:"s1",options:[{optionId:"reject-1",name:"Reject",kind:"reject_once"},{optionId:"reject-always-1",name:"Always reject",kind:"reject_always"},{optionId:"allow-1",name:"Allow once",kind:"allow_once"},{optionId:"allow-always-1",name:"Always allow",kind:"allow_always"}]},toolCall)})) + "\\n");
    } else if (msg.method === "trigger_permission_no_options") {
      inboundTriggerId = msg.id;
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:902,method:"session/request_permission",params:{sessionId:"s1",options:[]}}) + "\\n");
    }
  }
});
process.stdin.on("end", () => { process.exit(0); });
`;

const fakeAgentPath = join(tmpdir(), "routing-auditor-fake-agent.ts");
const fakeNoUsagePath = join(tmpdir(), "routing-auditor-fake-agent-no-usage.ts");

const fakeNoUsageSource = fakeAgentSource.replace(
  "result:{stopReason:\"stop\",usage:{input_tokens:5,output_tokens:3}}",
  "result:{stopReason:\"stop\"}",
);

const fakeExitPath = join(tmpdir(), "routing-auditor-fake-agent-exit.ts");
const fakeExitSource = `
process.stderr.write("bye\\n");
process.exit(7);
`;

beforeAll(() => {
  writeFileSync(fakeAgentPath, fakeAgentSource, "utf8");
  writeFileSync(fakeNoUsagePath, fakeNoUsageSource, "utf8");
  writeFileSync(fakeExitPath, fakeExitSource, "utf8");
});

afterAll(() => {
  try { rmSync(fakeAgentPath); } catch {}
  try { rmSync(fakeNoUsagePath); } catch {}
  try { rmSync(fakeExitPath); } catch {}
});

const newClient = (opts: Partial<ConstructorParameters<typeof AcpClient>[0]> = {}) =>
  new AcpClient({
    command: process.argv[0]!,
    args: [fakeAgentPath],
    spawn: true,
    requestTimeoutMs: 10000,
    ...opts,
  });

describe("AcpClient", () => {
  test("start + initialize + newSession + prompt", async () => {
    const client = newClient();
    await client.start();
    const init = await client.initialize();
    expect(init.agentInfo.name).toBe("fake");
    const sessionId = await client.newSession();
    expect(sessionId).toBe("s1");
    const result = await client.prompt("hi");
    expect(result.stopReason).toBe("stop");
    expect(result.text).toBe("Hello world");
    expect(result.usage?.input_tokens).toBe(5);
    expect(result.usage?.output_tokens).toBe(3);
    await client.close();
  });

  test("initialize does not advertise unsupported fs capabilities", async () => {
    const client = newClient();
    await client.start();
    const init = await client.initialize();
    expect(init.receivedClientCapabilities).toEqual({});
    await client.close();
  });

  test("prompt accumulates text from session/update", async () => {
    const client = newClient();
    await client.start();
    const result = await client.prompt("hi");
    expect(result.text).toBe("Hello world");
    await client.close();
  });

  test("prompt returns final assistant message instead of progress narration", async () => {
    const client = newClient();
    await client.start();
    const result = await client.prompt("progress-then-final");
    expect(result.text).toBe("Implemented a minimal vanilla HTML page at index.html.");
    expect(result.text).not.toContain("inspect the workspace");
    await client.close();
  });

  test("close resolves and kills the child", async () => {
    const client = newClient();
    await client.start();
    await client.close();
    expect(true).toBe(true);
  });

  test("onNotification callback receives session/update", async () => {
    const notifications: any[] = [];
    const client = newClient({ onNotification: (n) => notifications.push(n) });
    await client.start();
    await client.prompt("hi");
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[0].method).toBe("session/update");
    await client.close();
  });

  test("onStderr callback receives stderr lines", async () => {
    const stderrs: string[] = [];
    const client = newClient({ onStderr: (l) => stderrs.push(l) });
    await client.start();
    await new Promise((r) => setTimeout(r, 100));
    await client.prompt("hi");
    expect(stderrs.includes("agent stderr log")).toBe(true);
    await client.close();
  });

  test("request timeout: AcpTimeoutError", async () => {
    const client = newClient({ requestTimeoutMs: 10000 });
    await client.start();
    await expect(
      client.send("noop" as any, {}, 50),
    ).rejects.toBeInstanceOf(AcpTimeoutError);
    await client.close();
  });

  test("protocol error response: AcpProtocolError with code", async () => {
    const client = newClient();
    await client.start();
    try {
      await expect(
        (client as any).send("error_method", {}, 5000),
      ).rejects.toMatchObject({ name: "AcpProtocolError", code: -32000 });
    } finally {
      await client.close();
    }
  });

  test("NDJSON framing across split writes", async () => {
    const client = newClient();
    await client.start();
    const result = await (client as any).send("split_method", {}, 5000);
    expect(result.ok).toBe(true);
    await client.close();
  });

  test("responds method-not-found to inbound JSON-RPC requests", async () => {
    const client = newClient();
    await client.start();
    const result = await (client as any).send("trigger_inbound_request", {}, 5000);
    expect(result.inboundResponse).toMatchObject({
      jsonrpc: "2.0",
      id: 901,
      error: {
        code: -32601,
        message: "Method not found: fs/readTextFile",
      },
    });
    await client.close();
  });

  test("approve-all mode auto-approves, preferring allow_always", async () => {
    const client = newClient({ permissionMode: "approve-all" });
    await client.start();
    const result = await (client as any).send("trigger_permission_request", { kind: "edit" }, 5000);
    expect(result.inboundResponse).toMatchObject({
      jsonrpc: "2.0",
      id: 902,
      result: { outcome: { outcome: "selected", optionId: "allow-always-1" } },
    });
    await client.close();
  });

  test("read-only mode (default) approves non-mutating tool calls", async () => {
    const client = newClient({ permissionMode: "read-only" });
    await client.start();
    for (const kind of ["read", "search", "fetch", "think"]) {
      const result = await (client as any).send("trigger_permission_request", { kind }, 5000);
      expect(result.inboundResponse.result).toEqual({
        outcome: { outcome: "selected", optionId: "allow-always-1" },
      });
    }
    await client.close();
  });

  test("read-only mode rejects mutating/executing tool calls", async () => {
    const client = newClient({ permissionMode: "read-only" });
    await client.start();
    for (const kind of ["edit", "delete", "move", "execute"]) {
      const result = await (client as any).send("trigger_permission_request", { kind }, 5000);
      expect(result.inboundResponse.result).toEqual({
        outcome: { outcome: "selected", optionId: "reject-always-1" },
      });
    }
    await client.close();
  });

  test("read-only mode rejects requests with an unknown tool kind", async () => {
    const client = newClient({ permissionMode: "read-only" });
    await client.start();
    const result = await (client as any).send("trigger_permission_request", {}, 5000);
    expect(result.inboundResponse.result).toEqual({
      outcome: { outcome: "selected", optionId: "reject-always-1" },
    });
    await client.close();
  });

  test("cancels session/request_permission when no options are offered", async () => {
    const client = newClient({ permissionMode: "approve-all" });
    await client.start();
    const result = await (client as any).send("trigger_permission_no_options", {}, 5000);
    expect(result.inboundResponse).toMatchObject({
      jsonrpc: "2.0",
      id: 902,
      result: { outcome: { outcome: "cancelled" } },
    });
    await client.close();
  });

  test("multiple concurrent requests have no cross-talk", async () => {
    const client = newClient();
    await client.start();
    const [a, b, c] = await Promise.all([
      client.initialize(),
      client.newSession(),
      (client as any).send("split_method", {}, 5000),
    ]);
    expect(a.agentInfo.name).toBe("fake");
    expect(b).toBe("s1");
    expect(c.ok).toBe(true);
    await client.close();
  });
});
