import { describe, it, expect, beforeEach } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DaemonIdentitySchema,
  splitCommandLine,
  getDataDirArg,
  sameResolvedPath,
  readDaemonIdentity,
  writeDaemonIdentity,
  removeDaemonIdentity,
} from "../src/daemon-identity.ts";

describe("daemon-identity", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(tmpdir(), `ra-daemon-identity-test-${Date.now()}`);
    mkdirSync(dataDir, { recursive: true });
  });

  describe("DaemonIdentitySchema", () => {
    it("accepts valid identity", () => {
      const identity = {
        pid: 12345,
        command: "bun run bin/routing-auditor.ts daemon",
        startTime: Date.now(),
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        dataDir: "/home/user/.routing-auditor",
      };
      const parsed = DaemonIdentitySchema.parse(identity);
      expect(parsed).toEqual(identity);
    });

    it("rejects invalid pid", () => {
      const identity = {
        pid: -1,
        command: "bun run bin/routing-auditor.ts daemon",
        startTime: Date.now(),
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        dataDir: "/home/user/.routing-auditor",
      };
      expect(() => DaemonIdentitySchema.parse(identity)).toThrow();
    });

    it("rejects invalid uuid", () => {
      const identity = {
        pid: 12345,
        command: "bun run bin/routing-auditor.ts daemon",
        startTime: Date.now(),
        uuid: "not-a-uuid",
        dataDir: "/home/user/.routing-auditor",
      };
      expect(() => DaemonIdentitySchema.parse(identity)).toThrow();
    });
  });

  describe("splitCommandLine", () => {
    it("splits simple command", () => {
      const result = splitCommandLine("bun run script.ts");
      expect(result).toEqual(["bun", "run", "script.ts"]);
    });

    it("handles quoted arguments", () => {
      const result = splitCommandLine('bun run "script with spaces.ts"');
      expect(result).toEqual(["bun", "run", "script with spaces.ts"]);
    });

    it("handles single quotes", () => {
      const result = splitCommandLine("bun run 'script.ts'");
      expect(result).toEqual(["bun", "run", "script.ts"]);
    });

    it("handles escaped spaces", () => {
      const result = splitCommandLine("bun run script\\ with\\ spaces.ts");
      expect(result).toEqual(["bun", "run", "script with spaces.ts"]);
    });

    it("handles mixed quotes", () => {
      const result = splitCommandLine('cmd "arg1" \'arg2\' arg3');
      expect(result).toEqual(["cmd", "arg1", "arg2", "arg3"]);
    });

    it("handles empty string", () => {
      const result = splitCommandLine("");
      expect(result).toEqual([]);
    });
  });

  describe("getDataDirArg", () => {
    it("extracts --data-dir with space", () => {
      const args = ["daemon", "--data-dir", "/custom/path"];
      expect(getDataDirArg(args)).toBe("/custom/path");
    });

    it("extracts --data-dir with equals", () => {
      const args = ["daemon", "--data-dir=/custom/path"];
      expect(getDataDirArg(args)).toBe("/custom/path");
    });

    it("returns null when --data-dir not present", () => {
      const args = ["daemon", "--once"];
      expect(getDataDirArg(args)).toBe(null);
    });

    it("returns null when --data-dir has no value", () => {
      const args = ["daemon", "--data-dir"];
      expect(getDataDirArg(args)).toBe(null);
    });
  });

  describe("sameResolvedPath", () => {
    it("returns true for same path", () => {
      expect(sameResolvedPath("/home/user/.routing-auditor", "/home/user/.routing-auditor")).toBe(true);
    });

    it("returns true for equivalent paths with dots", () => {
      expect(sameResolvedPath("/home/user/./.routing-auditor", "/home/user/.routing-auditor")).toBe(true);
    });

    it("returns false for different paths", () => {
      expect(sameResolvedPath("/home/user/.routing-auditor", "/home/other/.routing-auditor")).toBe(false);
    });
  });

  describe("readDaemonIdentity", () => {
    it("returns null when file does not exist", () => {
      const result = readDaemonIdentity(dataDir);
      expect(result).toBe(null);
    });

    it("reads and parses valid identity file", () => {
      const identity = {
        pid: 12345,
        command: "bun run bin/routing-auditor.ts daemon",
        startTime: Date.now(),
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        dataDir,
      };
      writeDaemonIdentity(dataDir, identity);
      const result = readDaemonIdentity(dataDir);
      expect(result).toEqual(identity);
    });

    it("returns null for malformed identity file", () => {
      const identityPath = join(dataDir, "daemon.identity.json");
      require("node:fs").writeFileSync(identityPath, "invalid json", "utf-8");
      const result = readDaemonIdentity(dataDir);
      expect(result).toBe(null);
    });
  });

  describe("writeDaemonIdentity", () => {
    it("writes identity file", () => {
      const identity = {
        pid: 12345,
        command: "bun run bin/routing-auditor.ts daemon",
        startTime: Date.now(),
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        dataDir,
      };
      writeDaemonIdentity(dataDir, identity);
      const result = readDaemonIdentity(dataDir);
      expect(result).toEqual(identity);
    });
  });

  describe("removeDaemonIdentity", () => {
    it("removes identity file when it exists", () => {
      const identity = {
        pid: 12345,
        command: "bun run bin/routing-auditor.ts daemon",
        startTime: Date.now(),
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        dataDir,
      };
      writeDaemonIdentity(dataDir, identity);
      removeDaemonIdentity(dataDir);
      const result = readDaemonIdentity(dataDir);
      expect(result).toBe(null);
    });

    it("does not throw when file does not exist", () => {
      expect(() => removeDaemonIdentity(dataDir)).not.toThrow();
    });
  });
});