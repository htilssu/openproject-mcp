import type { AppConfig } from "./config.js";
import { OpenProjectError } from "./openproject.js";

export type RemoteFile = {
  bytes: Buffer;
  contentType: string;
  finalUrl: string;
};

function hostMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const wanted = pattern.toLowerCase();
  if (wanted.startsWith("*.")) {
    const suffix = wanted.slice(1); // .example.com
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === wanted;
}

function assertAllowedUrl(url: URL, allowedHosts: string[]): void {
  if (url.protocol !== "https:") {
    throw new OpenProjectError("Remote attachment URL must use HTTPS", 400);
  }
  if (!allowedHosts.length) {
    throw new OpenProjectError(
      "Remote URL uploads are disabled. Configure OPENPROJECT_REMOTE_UPLOAD_ALLOWED_HOSTS with trusted public hosts.",
      403,
    );
  }
  if (!allowedHosts.some((pattern) => hostMatches(url.hostname, pattern))) {
    throw new OpenProjectError(`Remote attachment host is not allowed: ${url.hostname}`, 403, { allowedHosts });
  }
  if (url.username || url.password) {
    throw new OpenProjectError("Credentials in remote attachment URLs are not allowed", 400);
  }
}

function contentTypeOnly(value: string | null): string {
  return (value ?? "application/octet-stream").split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
}

export async function downloadTrustedRemoteFile(urlInput: string, config: AppConfig): Promise<RemoteFile> {
  let current: URL;
  try {
    current = new URL(urlInput);
  } catch {
    throw new OpenProjectError("Invalid remote attachment URL", 400);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    for (let redirect = 0; redirect <= config.remoteUpload.maxRedirects; redirect += 1) {
      assertAllowedUrl(current, config.remoteUpload.allowedHosts);
      let response: Response;
      try {
        response = await fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { Accept: "*/*" },
        });
      } catch (error) {
        if (controller.signal.aborted) throw new OpenProjectError("Remote attachment download timed out", 504);
        throw new OpenProjectError(
          `Remote attachment download failed: ${error instanceof Error ? error.message : String(error)}`,
          502,
        );
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect >= config.remoteUpload.maxRedirects) {
          throw new OpenProjectError("Remote attachment exceeded redirect limit", 400);
        }
        const location = response.headers.get("location");
        if (!location) throw new OpenProjectError("Remote attachment redirect omitted Location header", 502);
        current = new URL(location, current);
        continue;
      }

      if (!response.ok) {
        throw new OpenProjectError(`Remote attachment server returned HTTP ${response.status}`, 502);
      }

      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > config.remoteUpload.maxBytes) {
        throw new OpenProjectError(
          `Remote attachment is too large (${declared} bytes; limit ${config.remoteUpload.maxBytes})`,
          413,
        );
      }
      if (!response.body) throw new OpenProjectError("Remote attachment response had no body", 502);

      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk);
        total += buffer.length;
        if (total > config.remoteUpload.maxBytes) {
          throw new OpenProjectError(
            `Remote attachment exceeded limit while downloading (${total} bytes; limit ${config.remoteUpload.maxBytes})`,
            413,
          );
        }
        chunks.push(buffer);
      }
      if (total <= 0) throw new OpenProjectError("Remote attachment is empty", 422);

      return {
        bytes: Buffer.concat(chunks, total),
        contentType: contentTypeOnly(response.headers.get("content-type")),
        finalUrl: current.toString(),
      };
    }
    throw new OpenProjectError("Remote attachment exceeded redirect limit", 400);
  } finally {
    clearTimeout(timer);
  }
}
