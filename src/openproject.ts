import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { AppConfig } from "./config.js";

export type JsonObject = Record<string, unknown>;
export type QueryValue = string | number | boolean | undefined;

type RequestOptions = {
  query?: Record<string, QueryValue>;
  body?: unknown;
  formData?: FormData;
  rawBody?: BodyInit | Readable;
  headers?: Record<string, string>;
  retrySafe?: boolean;
  sideEffecting?: boolean;
  duplex?: boolean;
};

export type AttachmentMetadata = {
  fileName: string;
  fileSize: number;
  contentType?: string;
  description?: string;
};

export class OpenProjectError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
    public readonly errorIdentifier?: string,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
    public readonly operationMayHaveSucceeded = false,
  ) {
    super(message);
    this.name = "OpenProjectError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function getErrorIdentifier(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>).errorIdentifier;
  return typeof value === "string" ? value : undefined;
}

function getErrorMessage(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const value = (data as Record<string, unknown>).message;
  return typeof value === "string" ? value : "";
}

function validateAttachmentMetadata(metadata: AttachmentMetadata): void {
  if (!metadata.fileName.trim()) throw new OpenProjectError("fileName is required");
  if (!Number.isSafeInteger(metadata.fileSize) || metadata.fileSize <= 0) {
    throw new OpenProjectError("fileSize must be a positive integer number of bytes");
  }
  if (metadata.contentType !== undefined && !metadata.contentType.trim()) {
    throw new OpenProjectError("contentType cannot be blank when provided");
  }
}

function attachmentMetadataJson(metadata: AttachmentMetadata): JsonObject {
  validateAttachmentMetadata(metadata);
  return {
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
    ...(metadata.description !== undefined ? { description: { raw: metadata.description } } : {}),
  };
}

function escapeDispositionFileName(value: string): string {
  return value.replace(/[\r\n]/g, "_").replace(/"/g, "'");
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array | Buffer | string> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in value);
}

export function isDirectUploadUnavailable(error: unknown): boolean {
  if (!(error instanceof OpenProjectError) || error.status !== 422) return false;
  const message = getErrorMessage(error.details).toLowerCase();
  if (message.includes("direct file upload") && message.includes("not available")) return true;
  // Some versions return a shorter message on the "base" attribute: "is not available due to a system configuration."
  const embedded = (error.details as { _embedded?: { details?: { attribute?: unknown } } } | undefined)?._embedded;
  return embedded?.details?.attribute === "base" && message.includes("not available due to a system configuration");
}

export class OpenProjectClient {
  private readonly authHeader: string;

  constructor(private readonly config: AppConfig) {
    this.authHeader = `Basic ${Buffer.from(`apikey:${config.apiToken}`, "utf8").toString("base64")}`;
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): URL {
    if (!path.startsWith("/")) throw new OpenProjectError(`OpenProject API path must start with '/': ${path}`);
    if (/^\/\//.test(path) || /^https?:/i.test(path)) {
      throw new OpenProjectError("Absolute/external URLs are not allowed");
    }

    const url = new URL(`${this.config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async parseResponse(response: Response, operationMayHaveSucceeded = false): Promise<unknown> {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > this.config.maxResponseBytes) {
      throw new OpenProjectError(
        `OpenProject response is too large (${contentLength} bytes; limit ${this.config.maxResponseBytes})`,
        response.status,
        undefined,
        undefined,
        false,
        undefined,
        operationMayHaveSucceeded,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > this.config.maxResponseBytes) {
      throw new OpenProjectError(
        `OpenProject response is too large (${buffer.length} bytes; limit ${this.config.maxResponseBytes})`,
        response.status,
        undefined,
        undefined,
        false,
        undefined,
        operationMayHaveSucceeded,
      );
    }
    if (buffer.length === 0) return undefined;

    const text = buffer.toString("utf8");
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json") || /^[\s]*[\[{]/.test(text)) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  private async executeOnce(method: string, url: URL, options: RequestOptions): Promise<TypedResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const sideEffecting = options.sideEffecting ?? !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());

    try {
      const headers: Record<string, string> = {
        Authorization: this.authHeader,
        Accept: "application/hal+json, application/json",
        ...options.headers,
      };

      let body: BodyInit | Readable | undefined;
      if (options.formData) {
        body = options.formData;
      } else if (options.rawBody !== undefined) {
        body = options.rawBody;
      } else if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(options.body);
      }

      const init: RequestInit & { duplex?: "half" } = {
        method,
        signal: controller.signal,
        headers,
        body: body as BodyInit | null | undefined,
      };
      if (options.duplex) init.duplex = "half";

      const response = await fetch(url, init);
      const data = await this.parseResponse(response, sideEffecting && response.ok);
      return { response, data };
    } catch (error) {
      if (error instanceof OpenProjectError) throw error;
      if (error instanceof Error && (error.name === "AbortError" || controller.signal.aborted)) {
        throw new OpenProjectError(
          `OpenProject API ${method} ${url.pathname} timed out after ${this.config.timeoutMs}ms`,
          undefined,
          undefined,
          undefined,
          !sideEffecting,
          undefined,
          sideEffecting,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenProjectError(
        `OpenProject API ${method} ${url.pathname} network error: ${message}`,
        undefined,
        error,
        undefined,
        !sideEffecting,
        undefined,
        sideEffecting,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const bodyCount = [options.body !== undefined, Boolean(options.formData), options.rawBody !== undefined].filter(Boolean).length;
    if (bodyCount > 1) throw new OpenProjectError("Request can contain only one body type");

    const url = this.buildUrl(path, options.query);
    const upperMethod = method.toUpperCase();
    const sideEffecting = options.sideEffecting ?? !["GET", "HEAD", "OPTIONS"].includes(upperMethod);
    const safeToRetry = options.retrySafe ?? !sideEffecting;
    let attempt = 0;

    while (true) {
      try {
        const { response, data } = await this.executeOnce(upperMethod, url, { ...options, sideEffecting });
        if (response.ok) return data as T;

        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        const retryableStatus = response.status === 429 || [502, 503, 504].includes(response.status);
        const message = getErrorMessage(data);
        const identifier = getErrorIdentifier(data);
        const apiError = new OpenProjectError(
          `OpenProject API ${upperMethod} ${url.pathname} failed: HTTP ${response.status}${identifier ? ` ${identifier}` : ""}${message ? ` - ${message}` : ""}`,
          response.status,
          data,
          identifier,
          retryableStatus,
          retryAfterMs,
          sideEffecting && response.status >= 500,
        );

        if (!safeToRetry || !retryableStatus || attempt >= this.config.maxRetries) throw apiError;
        const waitMs = retryAfterMs ?? this.config.retryBaseMs * 2 ** attempt;
        attempt += 1;
        await sleep(waitMs);
      } catch (error) {
        if (!(error instanceof OpenProjectError)) throw error;
        if (!safeToRetry || !error.retryable || error.status !== undefined || attempt >= this.config.maxRetries) throw error;
        const waitMs = error.retryAfterMs ?? this.config.retryBaseMs * 2 ** attempt;
        attempt += 1;
        await sleep(waitMs);
      }
    }
  }

  get<T = unknown>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query, retrySafe: true });
  }

  post<T = unknown>(path: string, body?: unknown, query?: Record<string, QueryValue>) {
    return this.request<T>("POST", path, { body, query, retrySafe: false });
  }

  postMultipart<T = unknown>(path: string, formData: FormData, query?: Record<string, QueryValue>) {
    return this.request<T>("POST", path, { formData, query, retrySafe: false });
  }

  patch<T = unknown>(path: string, body?: unknown, query?: Record<string, QueryValue>) {
    return this.request<T>("PATCH", path, { body, query, retrySafe: false });
  }

  async checkAttachmentSize(fileSize: number): Promise<void> {
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new OpenProjectError("fileSize must be positive");
    try {
      const serverConfig = await this.get<Record<string, unknown>>("/api/v3/configuration");
      const serverMax = serverConfig.maximumAttachmentFileSize;
      if (typeof serverMax === "number" && serverMax > 0 && fileSize > serverMax) {
        throw new OpenProjectError(
          `Attachment is too large (${fileSize} bytes; OpenProject limit ${serverMax})`,
          422,
          { maximumAttachmentFileSize: serverMax, fileSize },
          "urn:openproject-org:api:v3:errors:PropertyConstraintViolation",
        );
      }
    } catch (error) {
      if (error instanceof OpenProjectError && error.status === 422) throw error;
      // Older/restricted servers may not expose configuration; the attachment endpoint remains authoritative.
    }
  }

  async prepareWorkPackageAttachment(workPackageId: number, metadata: AttachmentMetadata): Promise<unknown> {
    validateAttachmentMetadata(metadata);
    await this.checkAttachmentSize(metadata.fileSize);

    // Send metadata as a plain string part: with an application/json part, OpenProject pre-parses it
    // into a hash and the prepare endpoint fails with HTTP 500 ("no implicit conversion ... into String").
    const form = new FormData();
    form.append("metadata", JSON.stringify(attachmentMetadataJson(metadata)));
    return this.postMultipart(`/api/v3/work_packages/${workPackageId}/attachments/prepare`, form);
  }

  async completePreparedAttachment(attachmentId: number): Promise<unknown> {
    try {
      return await this.request("GET", `/api/v3/attachments/${attachmentId}/uploaded`, {
        retrySafe: false,
        sideEffecting: true,
      });
    } catch (error) {
      // Completion is GET but side-effecting. If the response was lost or the call was repeated,
      // OpenProject may answer 404 because the upload is already completed. Recover by reading it.
      if (error instanceof OpenProjectError && (error.status === 404 || error.operationMayHaveSucceeded)) {
        try {
          const attachment = await this.get<Record<string, unknown>>(`/api/v3/attachments/${attachmentId}`);
          if (attachment && attachment.id === attachmentId) {
            return { ...attachment, completionRecovered: true };
          }
        } catch {
          // Preserve the original completion error when recovery cannot prove success.
        }
      }
      throw error;
    }
  }

  async uploadWorkPackageAttachmentStream(
    workPackageId: number,
    source: AsyncIterable<Uint8Array | Buffer | string>,
    metadata: AttachmentMetadata,
    maxBytes: number,
  ): Promise<unknown> {
    validateAttachmentMetadata(metadata);
    if (!isAsyncIterable(source)) throw new OpenProjectError("Attachment source must be an async iterable stream");
    if (metadata.fileSize > maxBytes) {
      throw new OpenProjectError(`Attachment exceeds relay limit (${metadata.fileSize} bytes; limit ${maxBytes})`, 413);
    }
    await this.checkAttachmentSize(metadata.fileSize);

    const boundary = `----openproject-mcp-${randomBytes(18).toString("hex")}`;
    const json = JSON.stringify({
      fileName: metadata.fileName,
      ...(metadata.description !== undefined ? { description: { raw: metadata.description } } : {}),
    });
    const safeFileName = escapeDispositionFileName(metadata.fileName);
    const contentType = metadata.contentType || "application/octet-stream";
    const prefix = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="metadata"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${json}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
      "utf8",
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

    async function* multipartBody(): AsyncGenerator<Buffer> {
      yield prefix;
      let bytes = 0;
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes || bytes > metadata.fileSize) {
          throw new OpenProjectError(
            `Received attachment body exceeds declared/allowed size (${bytes} bytes)`,
            413,
          );
        }
        yield buffer;
      }
      if (bytes !== metadata.fileSize) {
        throw new OpenProjectError(
          `Received attachment size ${bytes} does not match declared fileSize ${metadata.fileSize}`,
          400,
        );
      }
      yield suffix;
    }

    const rawBody = Readable.from(multipartBody());
    const contentLength = prefix.length + metadata.fileSize + suffix.length;
    return this.request("POST", `/api/v3/work_packages/${workPackageId}/attachments`, {
      rawBody,
      duplex: true,
      retrySafe: false,
      sideEffecting: true,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(contentLength),
      },
    });
  }
}

type TypedResponse = { response: Response; data: unknown };

export function compactCollection(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const embedded = record._embedded as Record<string, unknown> | undefined;
  const elements = embedded?.elements;
  if (!Array.isArray(elements)) return value;
  return {
    _type: record._type,
    total: record.total,
    count: record.count,
    pageSize: record.pageSize,
    offset: record.offset,
    elements,
  };
}

export function validateJsonArrayString(value: string, fieldName: string): string {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("must be a JSON array");
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OpenProjectError(`${fieldName} must be a valid JSON array string: ${message}`);
  }
}
