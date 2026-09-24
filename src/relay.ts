import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AppConfig } from "./config.js";
import { OpenProjectClient, OpenProjectError, type AttachmentMetadata } from "./openproject.js";

type RelayTokenPayload = {
  v: 1;
  jti: string;
  exp: number;
  workPackageId: number;
  fileName: string;
  fileSize: number;
  contentType?: string;
  description?: string;
};

function jsonBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signPart(part: string, secret: string): string {
  return createHmac("sha256", secret).update(part).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseTokenPayload(encoded: string): RelayTokenPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new OpenProjectError("Invalid relay upload token", 401);
  }
  if (!parsed || typeof parsed !== "object") throw new OpenProjectError("Invalid relay upload token", 401);
  const value = parsed as Partial<RelayTokenPayload>;
  if (
    value.v !== 1 ||
    typeof value.jti !== "string" ||
    typeof value.exp !== "number" ||
    typeof value.workPackageId !== "number" ||
    typeof value.fileName !== "string" ||
    typeof value.fileSize !== "number"
  ) {
    throw new OpenProjectError("Invalid relay upload token payload", 401);
  }
  return value as RelayTokenPayload;
}

export class RelayTokenManager {
  private readonly claimed = new Map<string, number>();

  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {}

  create(input: Omit<RelayTokenPayload, "v" | "jti" | "exp">): { token: string; expiresAt: string } {
    const exp = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    const payload: RelayTokenPayload = {
      v: 1,
      jti: randomUUID(),
      exp,
      ...input,
    };
    const encoded = jsonBase64Url(payload);
    return {
      token: `${encoded}.${signPart(encoded, this.secret)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  verifyAndClaim(token: string): RelayTokenPayload {
    this.cleanup();
    const parts = token.split(".");
    if (parts.length !== 2) throw new OpenProjectError("Invalid relay upload token", 401);
    const [encoded, signature] = parts;
    if (!safeEqual(signature, signPart(encoded, this.secret))) {
      throw new OpenProjectError("Invalid relay upload token signature", 401);
    }
    const payload = parseTokenPayload(encoded);
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) throw new OpenProjectError("Relay upload token has expired", 401);
    if (this.claimed.has(payload.jti)) throw new OpenProjectError("Relay upload token has already been used", 409);

    // Claim before reading bytes so concurrent requests cannot reuse the same token.
    // If an upload fails, request a new prepare token instead of replaying an ambiguous write.
    this.claimed.set(payload.jti, payload.exp);
    return payload;
  }

  private cleanup(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, exp] of this.claimed) {
      if (exp <= now) this.claimed.delete(jti);
    }
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body, null, 2));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(data.length),
    "cache-control": "no-store",
  });
  response.end(data);
}

function errorPayload(error: unknown): { status: number; body: unknown } {
  if (error instanceof OpenProjectError) {
    return {
      status: error.status && error.status >= 400 && error.status < 600 ? error.status : 502,
      body: {
        error: error.message,
        status: error.status,
        errorIdentifier: error.errorIdentifier,
        operationMayHaveSucceeded: error.operationMayHaveSucceeded,
        details: error.details,
      },
    };
  }
  return {
    status: 500,
    body: { error: error instanceof Error ? error.message : String(error) },
  };
}

function getBearerlessToken(pathname: string): string | undefined {
  const prefix = "/upload/";
  if (!pathname.startsWith(prefix)) return undefined;
  const value = pathname.slice(prefix.length);
  if (!value || value.includes("/")) return undefined;
  return value;
}

export function createRelayUploadUrl(
  config: AppConfig,
  tokens: RelayTokenManager,
  metadata: AttachmentMetadata & { workPackageId: number },
): { uploadUrl: string; expiresAt: string } {
  if (!config.relay.enabled || !config.relay.publicBaseUrl) {
    throw new OpenProjectError("Relay upload is not configured on this hosted MCP server");
  }
  if (metadata.fileSize > config.relay.maxUploadBytes) {
    throw new OpenProjectError(
      `Attachment exceeds relay limit (${metadata.fileSize} bytes; limit ${config.relay.maxUploadBytes})`,
      413,
    );
  }
  const { token, expiresAt } = tokens.create({
    workPackageId: metadata.workPackageId,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    contentType: metadata.contentType,
    description: metadata.description,
  });
  return {
    uploadUrl: `${config.relay.publicBaseUrl}/upload/${encodeURIComponent(token)}`,
    expiresAt,
  };
}

export function startRelayServer(
  config: AppConfig,
  client: OpenProjectClient,
  tokens: RelayTokenManager,
): Server | undefined {
  if (!config.relay.enabled) return undefined;

  const server = createHttpServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://relay.local");
      if (request.method === "GET" && requestUrl.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }

      const token = getBearerlessToken(requestUrl.pathname);
      if (!token) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      if (request.method !== "PUT") {
        response.setHeader("allow", "PUT");
        sendJson(response, 405, { error: "Use PUT with the raw file bytes as the request body" });
        return;
      }

      const payload = tokens.verifyAndClaim(token);
      const contentLengthHeader = request.headers["content-length"];
      if (!contentLengthHeader) {
        throw new OpenProjectError("Content-Length is required for relay uploads", 411);
      }
      const contentLength = Number(contentLengthHeader);
      if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
        throw new OpenProjectError("Invalid Content-Length", 400);
      }
      if (contentLength !== payload.fileSize) {
        throw new OpenProjectError(
          `Content-Length ${contentLength} does not match prepared fileSize ${payload.fileSize}`,
          400,
        );
      }
      if (contentLength > config.relay.maxUploadBytes) {
        throw new OpenProjectError(`Upload exceeds relay limit ${config.relay.maxUploadBytes}`, 413);
      }

      const requestContentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (payload.contentType && requestContentType && requestContentType !== payload.contentType.toLowerCase()) {
        throw new OpenProjectError(
          `Content-Type ${requestContentType} does not match prepared contentType ${payload.contentType}`,
          400,
        );
      }

      const attachment = await client.uploadWorkPackageAttachmentStream(
        payload.workPackageId,
        request,
        {
          fileName: payload.fileName,
          fileSize: payload.fileSize,
          contentType: payload.contentType || requestContentType || "application/octet-stream",
          description: payload.description,
        },
        config.relay.maxUploadBytes,
      );
      sendJson(response, 200, {
        mode: "relay",
        attachment,
        persistedOnMcpServer: false,
      });
    } catch (error) {
      // Stop accepting additional body data after a validation/upstream failure.
      request.resume();
      const mapped = errorPayload(error);
      sendJson(response, mapped.status, mapped.body);
    }
  });

  // A relay failure (e.g. port in use) must not take down the MCP server; uploads then report the relay as disabled.
  server.on("error", (error) => {
    config.relay.enabled = false;
    console.error(`openproject-mcp relay unavailable: ${error.message}`);
  });
  server.listen(config.relay.port, config.relay.host, () => {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : config.relay.port;
    if (!config.relay.publicBaseUrl) {
      const host = config.relay.host === "0.0.0.0" || config.relay.host === "::" ? "127.0.0.1" : config.relay.host;
      config.relay.publicBaseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
    }
    console.error(`openproject-mcp relay listening on ${config.relay.host}:${port}`);
  });
  return server;
}
