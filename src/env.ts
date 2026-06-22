import { z } from "zod";

export const ROUTING_AUDITOR_INTERNAL_ENV = "ROUTING_AUDITOR_INTERNAL";

export const EnvSchema = z.object({
  ROUTING_AUDITOR_DATA_DIR: z.string().optional(),
  ROUTING_AUDITOR_TTY_FD: z.string().optional(),
  ROUTING_AUDITOR_LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
  ROUTING_AUDITOR_INTERNAL: z.enum(["0", "1"]).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

const emptyToUndefined = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const optionalLogLevel = (value: string | undefined): Env["ROUTING_AUDITOR_LOG_LEVEL"] => {
  const normalized = emptyToUndefined(value);
  const parsed = EnvSchema.shape.ROUTING_AUDITOR_LOG_LEVEL.safeParse(normalized);
  return parsed.success ? parsed.data : undefined;
};

const optionalInternalFlag = (value: string | undefined): Env["ROUTING_AUDITOR_INTERNAL"] => {
  const normalized = emptyToUndefined(value);
  return normalized === "0" || normalized === "1" ? normalized : undefined;
};

export const getEnv = (): Env => {
  return EnvSchema.parse({
    ROUTING_AUDITOR_DATA_DIR: emptyToUndefined(process.env.ROUTING_AUDITOR_DATA_DIR),
    ROUTING_AUDITOR_TTY_FD: emptyToUndefined(process.env.ROUTING_AUDITOR_TTY_FD),
    ROUTING_AUDITOR_LOG_LEVEL: optionalLogLevel(process.env.ROUTING_AUDITOR_LOG_LEVEL),
    ROUTING_AUDITOR_INTERNAL: optionalInternalFlag(process.env.ROUTING_AUDITOR_INTERNAL),
  });
};

export const getDataDir = (defaultDir: string): string => {
  const env = getEnv();
  return env.ROUTING_AUDITOR_DATA_DIR ?? defaultDir;
};

export const getLogLevel = (): string => {
  const env = getEnv();
  return env.ROUTING_AUDITOR_LOG_LEVEL ?? "info";
};

export const getTtyFd = (): number | undefined => {
  const env = getEnv();
  if (!env.ROUTING_AUDITOR_TTY_FD) return undefined;
  const fd = Number.parseInt(env.ROUTING_AUDITOR_TTY_FD, 10);
  return /^\d+$/.test(env.ROUTING_AUDITOR_TTY_FD) && Number.isFinite(fd) && fd >= 3 ? fd : undefined;
};

export const isInternalHookProcess = (): boolean => {
  const env = getEnv();
  return env.ROUTING_AUDITOR_INTERNAL === "1";
};

export const getMinimalChildEnv = (): Record<string, string | undefined> => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
});
