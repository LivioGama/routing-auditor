import { execFile, execSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "node:path";
import { z } from "zod";

export const DaemonIdentitySchema = z.object({
  pid: z.number().int().positive(),
  command: z.string().min(1),
  startTime: z.number().positive(),
  uuid: z.string().uuid(),
  dataDir: z.string().min(1),
});

export type DaemonIdentity = z.infer<typeof DaemonIdentitySchema>;

export const getProcessCommand = (pid: number): Promise<string | null> => {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout.trim() || null);
    });
  });
};

export const isPidRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const state = execSync(`ps -p ${pid} -o stat=`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return !state.startsWith("Z");
  } catch {
    return true;
  }
};

export const splitCommandLine = (command: string): string[] => {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if ((char === "'" || char === '"') && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current !== "") {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current !== "") args.push(current);
  return args;
};

export const getDataDirArg = (args: string[]): string | null => {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--data-dir") return args[i + 1] ?? null;
    if (arg?.startsWith("--data-dir=")) return arg.slice("--data-dir=".length);
  }
  return null;
};

export const sameResolvedPath = (a: string, b: string): boolean => resolve(a) === resolve(b);

export const isRoutingAuditorDaemon = async (pid: number, dataDir: string): Promise<boolean> => {
  const command = await getProcessCommand(pid);
  if (!command) return false;
  const args = splitCommandLine(command);
  const commandLooksRight = command.includes("routing-auditor") && args.includes("daemon");
  const processDataDir = getDataDirArg(args);
  return commandLooksRight && processDataDir !== null && sameResolvedPath(processDataDir, dataDir);
};

export const readDaemonIdentity = (dataDir: string): DaemonIdentity | null => {
  const identityPath = join(dataDir, "daemon.identity.json");
  try {
    const raw = readFileSync(identityPath, "utf-8");
    return DaemonIdentitySchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
};

export const writeDaemonIdentity = (dataDir: string, identity: DaemonIdentity): void => {
  const identityPath = join(dataDir, "daemon.identity.json");
  writeFileSync(identityPath, JSON.stringify(identity, null, 2), "utf-8");
};

export const removeDaemonIdentity = (dataDir: string): void => {
  const identityPath = join(dataDir, "daemon.identity.json");
  try {
    rmSync(identityPath, { force: true });
  } catch {}
};
