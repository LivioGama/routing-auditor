import fs from "fs";
import { spawnSync } from "node:child_process";
import {
  findLatestUnfinishedPromptBySession,
  findPromptBySessionTurn,
  readAllPrompts,
  readConfig,
  updatePrompt,
} from "../storage.ts";
import type { Config, PromptRecord } from "../schemas.ts";
import { buildTaskCompletionNotice } from "./taskCompletionNotice.ts";
import { getTtyFd } from "../env.ts";

export type NoticeDisplay = (notice: string, config: Config) => boolean;

export interface AwaitNoticeOptions {
  dataDir: string;
  sessionId: string;
  turnId?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  displayNotice?: NoticeDisplay;
}

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const latestPromptBySession = (dataDir: string, sessionId: string): PromptRecord | undefined => {
  const records = readAllPrompts(dataDir).filter((r) => r.session_id === sessionId);
  return records.at(-1);
};

const findAwaitedPrompt = (dataDir: string, sessionId: string, turnId: string): PromptRecord | undefined => {
  return (
    findPromptBySessionTurn(dataDir, sessionId, turnId) ??
    findLatestUnfinishedPromptBySession(dataDir, sessionId) ??
    latestPromptBySession(dataDir, sessionId)
  );
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const writeTty = (notice: string): boolean => {
  const inheritedFd = getTtyFd();
  if (inheritedFd !== undefined) {
    try {
      fs.writeSync(inheritedFd, `${notice}\n`);
      return true;
    } catch {}
  }

  try {
    fs.appendFileSync("/dev/tty", `${notice}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
};

const displayDesktopNotification = (notice: string): boolean => {
  const message = stripAnsi(notice);
  if (process.platform === "darwin") {
    const result = spawnSync("osascript", [
      "-e",
      `display notification ${JSON.stringify(message)} with title "Routing Auditor"`,
    ], {
      stdio: "ignore",
    });
    return result.status === 0;
  }
  if (process.platform === "linux") {
    const result = spawnSync("notify-send", ["Routing Auditor", message], {
      stdio: "ignore",
    });
    return result.status === 0;
  }
  return false;
};

export const displayCompletionNotice: NoticeDisplay = (notice, config): boolean => {
  if (config.noticeChannel === "tty") {
    if (!writeTty(notice)) {
      return displayDesktopNotification(notice);
    }
    return true;
  }
  if (config.noticeChannel === "desktop") {
    return displayDesktopNotification(notice);
  }

  const ttyShown = writeTty(notice);
  const desktopShown = displayDesktopNotification(notice);
  return ttyShown || desktopShown;
};

const isTerminalFailure = (record: PromptRecord): boolean => {
  return (
    (record.verified && record.verification_succeeded === false) ||
    record.verification?.status === "failed"
  );
};

export const awaitCompletionNotice = async (opts: AwaitNoticeOptions): Promise<boolean> => {
  const config = readConfig(opts.dataDir);
  const timeoutMs = opts.timeoutMs ?? config.noticeTimeoutMs;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const displayNotice = opts.displayNotice ?? displayCompletionNotice;
  const deadline = Date.now() + timeoutMs;
  const turnId = opts.turnId ?? "";

  while (Date.now() <= deadline) {
    const record = findAwaitedPrompt(opts.dataDir, opts.sessionId, turnId);
    if (record) {
      if (record.completion_notice_shown) {
        return false;
      }
      const notice = buildTaskCompletionNotice(record, { color: true });
      if (notice) {
        if (!displayNotice(notice, config)) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await sleep(Math.min(pollIntervalMs, remaining));
          continue;
        }
        await updatePrompt(opts.dataDir, record.id, (r) => ({
          ...r,
          completion_notice_shown: true,
        }));
        return true;
      }
      if (isTerminalFailure(record)) {
        return false;
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  return false;
};
