import { describe, it, expect, beforeEach } from "bun:test";
import { rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger, getDefaultLogger } from "../src/logger.ts";
import pino from "pino";

describe("logger", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(tmpdir(), `ra-logger-test-${Date.now()}`);
    mkdirSync(dataDir, { recursive: true });
  });

  describe("createLogger", () => {
    it("creates a pino logger", () => {
      const logger = createLogger(dataDir);
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.warn).toBe("function");
    });

    it("redacts sensitive fields", (done) => {
      const logger = createLogger(dataDir);
      logger.info({
        prompt: "secret prompt",
        output: "secret output",
        actual_output: "secret actual output",
        explanation: "secret explanation",
        reasoning: "secret reasoning",
        safe: "public data",
      }, "test message");

      setTimeout(() => {
        const logPath = join(dataDir, "daemon.log");
        const content = readFileSync(logPath, "utf-8");
        expect(content).toContain("[REDACTED]");
        expect(content).not.toContain("secret prompt");
        expect(content).not.toContain("secret output");
        expect(content).not.toContain("secret actual output");
        expect(content).not.toContain("secret explanation");
        expect(content).not.toContain("secret reasoning");
        expect(content).toContain("public data");
        done();
      }, 100);
    });
  });

  describe("getDefaultLogger", () => {
    it("returns a logger instance", () => {
      const logger = getDefaultLogger();
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
    });

    it("returns the same instance on subsequent calls", () => {
      const logger1 = getDefaultLogger();
      const logger2 = getDefaultLogger();
      expect(logger1).toBe(logger2);
    });
  });
});