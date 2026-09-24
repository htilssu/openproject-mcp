import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { AppConfig } from "../src/config.js";
import {
  isDirectUploadUnavailable,
  OpenProjectClient,
  OpenProjectError,
  validateJsonArrayString,
} from "../src/openproject.js";
import { createRelayUploadUrl, RelayTokenManager, startRelayServer } from "../src/relay.js";
import { downloadTrustedRemoteFile } from "../src/remote-file.js";

const nativeFetch = globalThis.fetch;

function config(extra: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: "https://op.example.test",
    apiToken: "secret",
    allowWrite: true,
    timeoutMs: 1_000,
    maxRetries: 2,
    retryBaseMs: 1,
    maxResponseBytes: 1024 * 1024,
    relay: {
      enabled: false,
      host: "127.0.0.1",
      port: 8788,
      tokenTtlSeconds: 300,
      maxUploadBytes: 1024 * 1024,
    },
    remoteUpload: {
      allowedHosts: [],
      maxBytes: 1024 * 1024,
      maxRedirects: 3,
    },
    ...extra,
  };
}

async function testGetRetries(): Promise<void> {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) {
      return new Response(JSON.stringify({ message: "busy" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = new OpenProjectClient(config());
  assert.deepEqual(await client.get("/api/v3/projects"), { ok: true });
  assert.equal(calls, 3);
}

async function testWriteDoesNotRetry(): Promise<void> {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ errorIdentifier: "urn:test", message: "boom" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  };

  const client = new OpenProjectClient(config());
  await assert.rejects(
    () => client.post("/api/v3/work_packages/1/activities", { comment: { raw: "x" } }),
    (error: unknown) => {
      assert(error instanceof OpenProjectError);
      assert.equal(error.status, 503);
      assert.equal(error.operationMayHaveSucceeded, true);
      return true;
    },
  );
  assert.equal(calls, 1);
}

async function testPrepareDirectUpload(): Promise<void> {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    if (String(url).endsWith("/api/v3/configuration")) {
      return new Response(JSON.stringify({ maximumAttachmentFileSize: 5000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    assert(String(url).endsWith("/api/v3/work_packages/42/attachments/prepare"));
    assert.equal(init?.method, "POST");
    assert(init?.body instanceof FormData);
    const metadata = init.body.get("metadata");
    assert.equal(typeof metadata, "string");
    assert.deepEqual(JSON.parse(metadata as string), {
      fileName: "shot.png",
      fileSize: 8,
      contentType: "image/png",
      description: { raw: "screen" },
    });
    assert.equal(init.body.get("file"), null);
    return new Response(JSON.stringify({
      _type: "AttachmentUpload",
      id: 9,
      _links: {
        addAttachment: { href: "https://storage.test/", method: "post", form_fields: { key: "x" } },
        completeUpload: { href: "/api/v3/attachments/9/uploaded" },
      },
    }), { status: 200, headers: { "content-type": "application/hal+json" } });
  };

  const client = new OpenProjectClient(config());
  const result = await client.prepareWorkPackageAttachment(42, {
    fileName: "shot.png",
    fileSize: 8,
    contentType: "image/png",
    description: "screen",
  });
  assert.equal((result as { id: number }).id, 9);
  assert.equal(calls, 2);
}

function testDirectUploadFallbackDetection(): void {
  const unavailable = new OpenProjectError(
    "prepare failed",
    422,
    {
      errorIdentifier: "urn:openproject-org:api:v3:errors:PropertyConstraintViolation",
      message: "Direct file upload is not available due to a system configuration issue. Please contact your administrator.",
    },
  );
  assert.equal(isDirectUploadUnavailable(unavailable), true);

  const unavailableShort = new OpenProjectError(
    "prepare failed",
    422,
    {
      errorIdentifier: "urn:openproject-org:api:v3:errors:PropertyConstraintViolation",
      message: "is not available due to a system configuration.",
      _embedded: { details: { attribute: "base" } },
    },
  );
  assert.equal(isDirectUploadUnavailable(unavailableShort), true);

  const invalidMime = new OpenProjectError(
    "prepare failed",
    422,
    {
      errorIdentifier: "urn:openproject-org:api:v3:errors:PropertyConstraintViolation",
      message: "'text/plain' is not allowed for upload.",
    },
  );
  assert.equal(isDirectUploadUnavailable(invalidMime), false);
}

async function consumeBody(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function testRelayStreamMultipart(): Promise<void> {
  const file = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]);
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    if (String(url).endsWith("/api/v3/configuration")) {
      return new Response(JSON.stringify({ maximumAttachmentFileSize: 1024 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    assert(String(url).endsWith("/api/v3/work_packages/42/attachments"));
    assert.equal(init?.method, "POST");
    const type = new Headers(init?.headers).get("content-type") ?? "";
    assert.match(type, /^multipart\/form-data; boundary=/);
    const body = await consumeBody(init?.body);
    const text = body.toString("latin1");
    assert(text.includes('name="metadata"'));
    assert(text.includes('"fileName":"shot.png"'));
    assert(text.includes('name="file"; filename="shot.png"'));
    assert(text.includes("image/png"));
    assert(body.includes(file));
    assert.equal(Number(new Headers(init?.headers).get("content-length")), body.length);
    return new Response(JSON.stringify({ id: 77, fileName: "shot.png" }), {
      status: 200,
      headers: { "content-type": "application/hal+json" },
    });
  };

  const client = new OpenProjectClient(config());
  const result = await client.uploadWorkPackageAttachmentStream(
    42,
    Readable.from([file]),
    { fileName: "shot.png", fileSize: file.length, contentType: "image/png", description: "screen" },
    1024,
  );
  assert.deepEqual(result, { id: 77, fileName: "shot.png" });
  assert.equal(calls, 2);
}

async function testCompleteRecovery(): Promise<void> {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    if (String(url).endsWith("/api/v3/attachments/9/uploaded")) {
      return new Response(JSON.stringify({ message: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    assert(String(url).endsWith("/api/v3/attachments/9"));
    return new Response(JSON.stringify({ id: 9, status: "uploaded" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new OpenProjectClient(config());
  const result = await client.completePreparedAttachment(9) as { completionRecovered: boolean };
  assert.equal(result.completionRecovered, true);
  assert.equal(calls, 2);
}

function testRelayTokens(): void {
  const tokens = new RelayTokenManager("12345678901234567890123456789012", 300);
  const cfg = config({
    relay: {
      enabled: true,
      host: "0.0.0.0",
      port: 8788,
      publicBaseUrl: "https://mcp.example.test",
      secret: "12345678901234567890123456789012",
      tokenTtlSeconds: 300,
      maxUploadBytes: 1000,
    },
  });
  const result = createRelayUploadUrl(cfg, tokens, {
    workPackageId: 42,
    fileName: "shot.png",
    fileSize: 8,
    contentType: "image/png",
  });
  const token = decodeURIComponent(result.uploadUrl.split("/upload/")[1]);
  const payload = tokens.verifyAndClaim(token);
  assert.equal(payload.workPackageId, 42);
  assert.equal(payload.fileSize, 8);
  assert.throws(() => tokens.verifyAndClaim(token), /already been used/);
}


async function testRelayHttpEndpoint(): Promise<void> {
  const secret = "12345678901234567890123456789012";
  const cfg = config({
    relay: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: "http://127.0.0.1",
      secret,
      tokenTtlSeconds: 300,
      maxUploadBytes: 1000,
    },
  });
  const tokens = new RelayTokenManager(secret, 300);
  const bytes = Buffer.from("local-user-file");
  let received = Buffer.alloc(0);
  const fakeClient = {
    async uploadWorkPackageAttachmentStream(workPackageId: number, source: AsyncIterable<Uint8Array | Buffer | string>, metadata: { fileName: string; fileSize: number; contentType?: string }, maxBytes: number) {
      assert.equal(workPackageId, 42);
      assert.equal(metadata.fileName, "local.png");
      assert.equal(metadata.fileSize, bytes.length);
      assert.equal(metadata.contentType, "image/png");
      assert.equal(maxBytes, 1000);
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      received = Buffer.concat(chunks);
      return { id: 88, fileName: metadata.fileName };
    },
  } as unknown as OpenProjectClient;

  const server = startRelayServer(cfg, fakeClient, tokens);
  assert(server);
  await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
  const address = server!.address();
  assert(address && typeof address === "object");

  const { token } = tokens.create({
    workPackageId: 42,
    fileName: "local.png",
    fileSize: bytes.length,
    contentType: "image/png",
  });
  globalThis.fetch = nativeFetch;
  const response = await fetch(`http://127.0.0.1:${address.port}/upload/${encodeURIComponent(token)}`, {
    method: "PUT",
    headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) },
    body: bytes,
  });
  assert.equal(response.status, 200);
  const result = await response.json() as { persistedOnMcpServer: boolean };
  assert.equal(result.persistedOnMcpServer, false);
  assert.deepEqual(received, bytes);

  const replay = await fetch(`http://127.0.0.1:${address.port}/upload/${encodeURIComponent(token)}`, {
    method: "PUT",
    headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) },
    body: bytes,
  });
  assert.equal(replay.status, 409);
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
}

async function testRemoteUrlAllowlist(): Promise<void> {
  const cfg = config({
    remoteUpload: {
      allowedHosts: ["cdn.example.test"],
      maxBytes: 100,
      maxRedirects: 1,
    },
  });
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://cdn.example.test/a.png");
    return new Response(Buffer.from("image-bytes"), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "11" },
    });
  };
  const remote = await downloadTrustedRemoteFile("https://cdn.example.test/a.png", cfg);
  assert.equal(remote.contentType, "image/png");
  assert.equal(remote.bytes.toString(), "image-bytes");
  await assert.rejects(
    () => downloadTrustedRemoteFile("https://evil.example.test/a.png", cfg),
    /not allowed/,
  );
  await assert.rejects(
    () => downloadTrustedRemoteFile("http://cdn.example.test/a.png", cfg),
    /must use HTTPS/,
  );
}

function testFilters(): void {
  assert.equal(validateJsonArrayString("[]", "filters"), "[]");
  assert.throws(() => validateJsonArrayString("{}", "filters"), /must be a valid JSON array string/);
}

await testGetRetries();
await testWriteDoesNotRetry();
await testPrepareDirectUpload();
testDirectUploadFallbackDetection();
await testRelayStreamMultipart();
await testCompleteRecovery();
testRelayTokens();
await testRelayHttpEndpoint();
await testRemoteUrlAllowlist();
testFilters();
console.log("all openproject client tests passed");
