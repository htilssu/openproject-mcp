import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AppConfig = {
  baseUrl: string;
  apiToken: string;
  allowWrite: boolean;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  maxResponseBytes: number;
  relay: {
    enabled: boolean;
    host: string;
    port: number;
    publicBaseUrl?: string;
    secret?: string;
    tokenTtlSeconds: number;
    maxUploadBytes: number;
  };
  remoteUpload: {
    allowedHosts: string[];
    maxBytes: number;
    maxRedirects: number;
  };
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? String(fallback));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function nonNegativeInteger(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? String(fallback));
  return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}

function boolEnv(name: string, fallback = false): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? String(fallback));
}

function csvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function normalizePublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const url = new URL(trimmed);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OPENPROJECT_RELAY_PUBLIC_BASE_URL must use http:// or https://");
  }
  return trimmed.replace(/\/+$/, "");
}

// Loads the first .env found: OPENPROJECT_ENV_FILE, then the working directory, then the package root.
// Variables already set in the process environment take precedence over the file.
export function loadDotEnv(): string | undefined {
  const explicit = process.env.OPENPROJECT_ENV_FILE?.trim();
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new Error(`OPENPROJECT_ENV_FILE not found: ${path}`);
    process.loadEnvFile(path);
    return path;
  }
  const candidates = [resolve(process.cwd(), ".env"), fileURLToPath(new URL("../.env", import.meta.url))];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path) process.loadEnvFile(path);
  return path;
}

export function loadConfig(): AppConfig {
  loadDotEnv();
  const baseUrl = requireEnv("OPENPROJECT_URL").replace(/\/+$/, "");
  const apiToken = requireEnv("OPENPROJECT_API_TOKEN");
  const allowWrite = boolEnv("OPENPROJECT_ALLOW_WRITE", true);
  const timeoutMs = positiveNumber("OPENPROJECT_TIMEOUT_MS", 30_000);
  const maxRetries = nonNegativeInteger("OPENPROJECT_MAX_RETRIES", 2);
  const retryBaseMs = positiveNumber("OPENPROJECT_RETRY_BASE_MS", 500);
  const maxResponseBytes = positiveNumber("OPENPROJECT_MAX_RESPONSE_BYTES", 5 * 1024 * 1024);

  // Relay is on by default (local-only). An explicit OPENPROJECT_RELAY_ENABLED=true with writes disabled is a
  // config error; the implicit default just turns the relay off for read-only servers.
  const relayExplicit = process.env.OPENPROJECT_RELAY_ENABLED?.trim();
  const relayEnabled = boolEnv("OPENPROJECT_RELAY_ENABLED", true) && (allowWrite || Boolean(relayExplicit));
  const relayPublicBaseUrl = normalizePublicBaseUrl(process.env.OPENPROJECT_RELAY_PUBLIC_BASE_URL);
  const relaySecretEnv = process.env.OPENPROJECT_RELAY_SECRET?.trim();

  if (relayEnabled && !allowWrite) {
    throw new Error("OPENPROJECT_RELAY_ENABLED=true requires OPENPROJECT_ALLOW_WRITE=true");
  }
  if (relayEnabled && relaySecretEnv && relaySecretEnv.length < 32) {
    throw new Error("OPENPROJECT_RELAY_SECRET must be at least 32 characters when relay upload is enabled");
  }
  // Relay tokens only need to verify within this process, so a per-process random secret is enough locally.
  const relaySecret = relaySecretEnv || randomBytes(32).toString("hex");
  // Without a public URL the relay serves this machine only: loopback on an ephemeral port (so several
  // MCP processes can coexist), with the URL filled in once the server is listening.
  const relayDefaultPort = relayPublicBaseUrl ? 8788 : 0;

  return {
    baseUrl,
    apiToken,
    allowWrite,
    timeoutMs,
    maxRetries,
    retryBaseMs,
    maxResponseBytes,
    relay: {
      enabled: relayEnabled,
      host: process.env.OPENPROJECT_RELAY_HOST?.trim() || (relayPublicBaseUrl ? "0.0.0.0" : "127.0.0.1"),
      port: nonNegativeInteger("OPENPROJECT_RELAY_PORT", relayDefaultPort),
      publicBaseUrl: relayPublicBaseUrl,
      secret: relaySecret,
      tokenTtlSeconds: positiveNumber("OPENPROJECT_RELAY_TOKEN_TTL_SECONDS", 300),
      maxUploadBytes: positiveNumber("OPENPROJECT_RELAY_MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
    },
    remoteUpload: {
      allowedHosts: csvEnv("OPENPROJECT_REMOTE_UPLOAD_ALLOWED_HOSTS"),
      maxBytes: positiveNumber("OPENPROJECT_REMOTE_UPLOAD_MAX_BYTES", 20 * 1024 * 1024),
      maxRedirects: nonNegativeInteger("OPENPROJECT_REMOTE_UPLOAD_MAX_REDIRECTS", 3),
    },
  };
}
