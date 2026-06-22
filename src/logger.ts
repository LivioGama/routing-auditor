import fs from "fs";
import path from "path";
import pino from "pino";
import { defaultDataDir } from "./storage.ts";
import { getLogLevel } from "./env.ts";

const LOG_LEVEL = getLogLevel();

export const createLogger = (dataDir: string): pino.Logger => {
  fs.mkdirSync(dataDir, { recursive: true });
  const dest = pino.destination(path.join(dataDir, "daemon.log"));
  return pino(
    {
      level: LOG_LEVEL,
      redact: {
        paths: [
          "prompt",
          "output",
          "actual_output",
          "explanation",
          "reasoning",
          "error.stack",
        ],
        censor: "[REDACTED]",
      },
    },
    dest,
  );
};

let _defaultLogger: pino.Logger | null = null;
export const getDefaultLogger = (): pino.Logger => {
  if (!_defaultLogger) _defaultLogger = createLogger(defaultDataDir());
  return _defaultLogger;
};