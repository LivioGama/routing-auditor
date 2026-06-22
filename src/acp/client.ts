import { type ChildProcess, spawn } from "node:child_process";
import { getMinimalChildEnv } from "../env.ts";

export type PermissionMode = "approve-all" | "read-only";

export interface AcpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  onStderr?: (line: string) => void;
  onUpdate?: (update: any) => void;
  onNotification?: (notification: any) => void;
  requestTimeoutMs?: number;
  spawn?: boolean;
  child?: ChildProcess;
  /**
   * How to answer inbound `session/request_permission` requests.
   * - "approve-all": auto-approve every request (lets the agent edit/run tools).
   * - "read-only": approve non-mutating tool calls, reject anything that would
   *   edit/delete/move files or execute shell commands.
   * - undefined (default): Don't handle permission requests unless server
   *   explicitly supports them. Use this with servers that don't support
   *   the permission protocol to avoid "Method not found" errors.
   */
  permissionMode?: PermissionMode;
}

// ACP ToolKind values that mutate state or run arbitrary commands.
const MUTATING_TOOL_KINDS = new Set(["edit", "delete", "move", "execute"]);

export interface AcpResult {
  stopReason: string;
  text: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  raw: any;
}

interface AcpModelInfo {
  modelId: string;
}

interface AcpSessionInfo {
  sessionId: string;
  availableModels: AcpModelInfo[];
  currentModelId?: string;
}

export class AcpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpTimeoutError";
  }
}

export class AcpClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpClosedError";
  }
}

export class AcpProtocolError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "AcpProtocolError";
    this.code = code;
  }
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * Minimal ACP client: NDJSON JSON-RPC 2.0 over stdio.
 */
export class AcpClient {
  private options: AcpClientOptions;
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private writeQueue: Promise<void> = Promise.resolve();
  private stdoutBuf = "";
  private stderrBuf = "";
  private closed = false;
  private closeListeners: Array<() => void> = [];
  private startPromise?: Promise<void>;
  private onUpdateHandler?: (update: any) => void;
  private sessionInfo = new Map<string, AcpSessionInfo>();
  private serverSupportsPermissions = false; // Detect during initialization

  constructor(options: AcpClientOptions) {
    this.options = options;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start();
    return this.startPromise;
  }

  private async _start(): Promise<void> {
    const shouldSpawn = this.options.spawn !== false;
    if (shouldSpawn) {
      const minimalEnv: Record<string, string | undefined> = {
        ...getMinimalChildEnv(),
        ...this.options.env,
      };
      this.child = spawn(this.options.command, this.options.args ?? [], {
        env: minimalEnv,
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      this.child = this.options.child!;
    }
    const child = this.child!;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => this.onStdoutData(chunk));
    child.stderr?.on("data", (chunk: string) => this.onStderrData(chunk));

    child.on("close", (code) => this.onClose(code));
    child.on("error", (err) => {
      this.onClose(-1, err);
    });
  }

  private onStdoutData(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private onStderrData(chunk: string): void {
    this.stderrBuf += chunk;
    let idx: number;
    while ((idx = this.stderrBuf.indexOf("\n")) >= 0) {
      const line = this.stderrBuf.slice(0, idx);
      this.stderrBuf = this.stderrBuf.slice(idx + 1);
      const trimmed = line.trim();
      if (trimmed) this.options.onStderr?.(trimmed);
    }
  }

  private handleMessage(msg: any): void {
    if (!msg || typeof msg !== "object") return;

    if (typeof msg.method === "string") {
      if (Object.prototype.hasOwnProperty.call(msg, "id")) {
        if (msg.method === "session/request_permission") {
          // Handle permission requests if:
          // 1. Server explicitly supports permissions, OR
          // 2. Client has permissionMode configured (user wants permission handling)
          // This ensures backward compatibility with tests while preventing errors with servers
          // that don't support permissions when permissionMode is not set
          if (this.serverSupportsPermissions || this.options.permissionMode) {
            this.respondPermission(msg.id, msg.params);
          } else {
            // Server doesn't support permissions and client doesn't have permissionMode
            // Respond with method not found to tell server not to send permission requests
            this.respondMethodNotFound(msg.id, msg.method);
          }
          return;
        }
        // Respond with method not found for other unknown requests
        this.respondMethodNotFound(msg.id, msg.method);
        return;
      }
      this.handleNotification(msg);
      return;
    }

    if (typeof msg.id === "number" && msg.id > 0) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (msg.error) {
        pending.reject(new AcpProtocolError(msg.error.message ?? "JSON-RPC error", msg.error.code));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
  }

  private handleNotification(msg: any): void {
    if (msg.method === "session/update") {
      const update = msg.params?.update ?? msg.params;
      if (this.onUpdateHandler) this.onUpdateHandler(update);
      if (this.options.onUpdate) this.options.onUpdate(update);
    }
    this.options.onNotification?.(msg);
  }

  private respondPermission(id: any, params: any): void {
    // Routing Auditor reruns prompts non-interactively. In read-only mode it
    // rejects any tool call that would mutate the filesystem or run a command,
    // so verification/assessment never produce side effects; otherwise it
    // auto-approves so the agent can use its tools freely.
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    const mode = this.options.permissionMode ?? "read-only";
    const toolKind = params?.toolCall?.kind;

    const deny = mode === "read-only" && (typeof toolKind !== "string" || MUTATING_TOOL_KINDS.has(toolKind));

    const byKind = (kind: string) => options.find((o) => o?.kind === kind);
    const chosen = deny
      ? byKind("reject_always") ??
        byKind("reject_once") ??
        options.find((o) => typeof o?.kind === "string" && o.kind.startsWith("reject")) ??
        options.find((o) => typeof o?.optionId === "string" && /reject|deny|no/i.test(o.optionId))
      : byKind("allow_always") ??
        byKind("allow_once") ??
        options.find((o) => typeof o?.kind === "string" && o.kind.startsWith("allow")) ??
        options.find((o) => typeof o?.optionId === "string" && /allow|approve|yes/i.test(o.optionId));

    const result = chosen?.optionId
      ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
      : { outcome: { outcome: "cancelled" } };

    void this.writeLine({ jsonrpc: "2.0", id, result }).catch(() => {});
  }

  private respondMethodNotFound(id: any, method: string): void {
    void this.writeLine({
      jsonrpc: "2.0",
      id,
      error: {
        code: JSON_RPC_METHOD_NOT_FOUND,
        message: `Method not found: ${method}`,
      },
    }).catch(() => {});
  }

  private onClose(code: number | null, err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const error = new AcpClosedError(
      err ? `Child process error: ${err.message}` : `ACP child closed (code=${code})`,
    );
    for (const [, pending] of this.pending) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch {}
    }
    this.closeListeners = [];
  }

  private writeLine(obj: any): Promise<void> {
    const run = async (): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        const line = JSON.stringify(obj) + "\n";
        const stdin = this.child?.stdin;
        if (!stdin || this.closed) {
          reject(new AcpClosedError("Cannot write: stdin unavailable"));
          return;
        }
        const ok = stdin.write(line, (err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
        if (ok && !stdin.writableEnded) {
          resolve();
        }
      });
    };
    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }

  send<T = any>(method: string, params?: any, timeoutMs?: number): Promise<T> {
    const id = this.nextId++;
    const obj: any = { jsonrpc: "2.0", id, method };
    if (params !== undefined) obj.params = params;
    const timeout = timeoutMs ?? (method === "session/prompt" ? this.options.requestTimeoutMs ?? 600_000 : 30_000);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new AcpTimeoutError(`Timeout after ${timeout}ms: ${method}`));
        }
      }, timeout);
      this.pending.set(id, {
        resolve: resolve as (value: any) => void,
        reject,
        timeout: timer,
      });
      this.writeLine(obj).catch((err) => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  async initialize(): Promise<any> {
    const result = await this.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    
    // Detect if server supports permission handling from capabilities
    // Some servers advertise this explicitly, others we need to infer
    const capabilities = result?.capabilities ?? {};
    this.serverSupportsPermissions = 
      capabilities.supportsPermissions === true ||
      capabilities.permissions === true ||
      // Check if the server has any permission-related capabilities
      Object.keys(capabilities).some(key => 
        key.toLowerCase().includes('permission')
      );
    
    return result;
  }

  async newSession(): Promise<string> {
    const result = await this.send<any>("session/new", {
      cwd: this.options.cwd ?? process.cwd(),
      mcpServers: [],
    });
    const sessionId = result.sessionId;
    const info: AcpSessionInfo = {
      sessionId,
      availableModels: result?.models?.availableModels ?? [],
      currentModelId: result?.models?.currentModelId,
    };
    this.sessionInfo.set(sessionId, info);
    return sessionId;
  }

  private modelCandidates(model?: string, reasoningEffort?: string): string[] {
    if (!model) return [];
    const candidates = [model];
    if (reasoningEffort && !model.endsWith(`]`)) {
      candidates.unshift(`${model}[${reasoningEffort}]`);
    }
    return [...new Set(candidates)];
  }

  private async setModelIfAdvertised(sessionId: string, model?: string, reasoningEffort?: string): Promise<boolean> {
    const info = this.sessionInfo.get(sessionId);
    if (!info || info.availableModels.length === 0 || !model) return false;
    const advertised = new Set(info.availableModels.map((m) => m.modelId));
    const modelId = this.modelCandidates(model, reasoningEffort).find((candidate) => advertised.has(candidate));
    if (!modelId) return false;
    if (info.currentModelId === modelId) return true;
    await this.send("session/set_model", { sessionId, modelId });
    info.currentModelId = modelId;
    return true;
  }

  async prompt(
    text: string,
    options?: { sessionId?: string; model?: string; reasoningEffort?: string },
  ): Promise<AcpResult> {
    await this.start();
    let sessionId = options?.sessionId;
    if (!sessionId) sessionId = await this.newSession();
    const modelSet = await this.setModelIfAdvertised(sessionId, options?.model, options?.reasoningEffort);
    const params: any = { sessionId, prompt: [{ type: "text", text }] };
    if (!modelSet) {
      if (options?.model) params.model = options.model;
      if (options?.reasoningEffort) params.reasoningEffort = options.reasoningEffort;
    }

    let accumulated = "";
    let latestMessage = "";
    const handler = (update: any) => {
      if (!update || typeof update !== "object") return;
      if (update.sessionUpdate === "agent_message_chunk" && update.content) {
        const content = Array.isArray(update.content) ? update.content : [update.content];
        for (const block of content) {
          if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
            accumulated += block.text;
          }
        }
        return;
      }
      if (update.type !== "message") return;
      if (update.role && update.role !== "assistant") return;
      const content = update.content;
      if (!Array.isArray(content)) return;
      let messageText = "";
      for (const block of content) {
        if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
          messageText += block.text;
        }
      }
      if (messageText !== "") {
        latestMessage = messageText;
        accumulated += messageText;
      }
    };
    this.onUpdateHandler = handler;

    try {
      const result = await this.send<any>("session/prompt", params);
      const usage = result?.usage;
      return {
        stopReason: result?.stopReason ?? result?.stop_reason ?? "stop",
        text: latestMessage || accumulated,
        usage: usage ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : undefined,
        raw: result,
      };
    } finally {
      this.onUpdateHandler = undefined;
    }
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.child || this.closed) {
        resolve();
        return;
      }
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      this.closeListeners.push(done);
      const child = this.child;
      const kill = (sig: NodeJS.Signals) => {
        try {
          child.kill(sig);
        } catch {}
      };
      try {
        kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          kill("SIGKILL");
        } catch {}
      }, 1000);
      setTimeout(done, 3000);
    });
  }
}
