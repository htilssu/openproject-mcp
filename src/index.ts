#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import {
  compactCollection,
  OpenProjectClient,
  OpenProjectError,
  isDirectUploadUnavailable,
  type JsonObject,
  validateJsonArrayString,
} from "./openproject.js";
import { createRelayUploadUrl, RelayTokenManager, startRelayServer } from "./relay.js";
import { downloadTrustedRemoteFile } from "./remote-file.js";
import { Readable } from "node:stream";

const config = loadConfig();
const client = new OpenProjectClient(config);
const relayTokens = config.relay.enabled
  ? new RelayTokenManager(config.relay.secret!, config.relay.tokenTtlSeconds)
  : undefined;
if (relayTokens) startRelayServer(config, client, relayTokens);

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorHint(error: OpenProjectError): string | undefined {
  if (error.operationMayHaveSucceeded) {
    return "Do not blindly repeat this write. Read the resource/attachments first to verify whether the operation already succeeded.";
  }
  if (error.status === 401) return "Authentication failed. Check OPENPROJECT_API_TOKEN and whether API access is enabled.";
  if (error.status === 403) return "The authenticated OpenProject user lacks the required permission.";
  if (error.status === 404) return "The resource may not exist, or OpenProject may intentionally hide it because this user lacks view permission.";
  if (error.status === 409 || error.errorIdentifier?.endsWith(":UpdateConflict")) {
    return "Concurrent modification detected. Re-read the resource and reconcile the intended change instead of overwriting it automatically.";
  }
  if (error.status === 422) return "Validation failed. Inspect errorIdentifier and details, especially the affected attribute and allowed values/schema.";
  if (error.status === 429) return "Rate limited. Respect retryAfterMs before retrying a safe/read request.";
  if (error.status && error.status >= 500) return "OpenProject/server-side failure. Reads may be retried; writes are not auto-retried because their outcome can be ambiguous.";
  if (error.retryable) return "Transient network failure. Safe/read operations may be retried.";
  return undefined;
}

function toolError(error: unknown) {
  const payload = error instanceof OpenProjectError
    ? {
        error: error.message,
        status: error.status,
        errorIdentifier: error.errorIdentifier,
        retryable: error.retryable,
        retryAfterMs: error.retryAfterMs,
        operationMayHaveSucceeded: error.operationMayHaveSucceeded,
        hint: errorHint(error),
        details: error.details,
      }
    : { error: error instanceof Error ? error.message : String(error) };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], isError: true };
}

function requireWrite() {
  if (!config.allowWrite) {
    throw new OpenProjectError("Write tools are disabled (OPENPROJECT_ALLOW_WRITE=false). Remove it or set it to true to enable them.");
  }
}

function link(id: number | undefined, resource: string) {
  return id ? { href: `/api/v3/${resource}/${id}` } : undefined;
}

function parseOptionalJsonArray(value: string | undefined, fieldName: string): string | undefined {
  return value === undefined ? undefined : validateJsonArrayString(value, fieldName);
}

function extraLinks(extra: JsonObject | undefined): JsonObject {
  const value = extra?._links;
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function createServer(): McpServer {
  const server = new McpServer({ name: "openproject-mcp", version: "1.2.0" });

  server.registerTool("op_get_instance", {
    description: "Get OpenProject API root and instance information. coreVersion may require admin permission.",
    inputSchema: z.object({}),
  }, async () => {
    try { return asText(await client.get("/api/v3")); } catch (e) { return toolError(e); }
  });

  server.registerTool("op_get_configuration", {
    description: "Get OpenProject client-relevant configuration such as maximumAttachmentFileSize.",
    inputSchema: z.object({}),
  }, async () => {
    try { return asText(await client.get("/api/v3/configuration")); } catch (e) { return toolError(e); }
  });

  server.registerTool("op_list_projects", {
    description: "List visible OpenProject projects.",
    inputSchema: z.object({
      pageSize: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(1).default(1),
      filters: z.string().optional().describe("OpenProject API v3 filters JSON array string"),
    }),
  }, async ({ pageSize, offset, filters }) => {
    try {
      const checkedFilters = parseOptionalJsonArray(filters, "filters");
      return asText(compactCollection(await client.get("/api/v3/projects", { pageSize, offset, filters: checkedFilters })));
    } catch (e) { return toolError(e); }
  });

  server.registerTool("op_get_project", {
    description: "Get one OpenProject project by numeric ID.",
    inputSchema: z.object({ projectId: z.number().int().positive() }),
  }, async ({ projectId }) => {
    try { return asText(await client.get(`/api/v3/projects/${projectId}`)); } catch (e) { return toolError(e); }
  });

  server.registerTool("op_list_project_types", {
    description: "List work package types available in a project.",
    inputSchema: z.object({ projectId: z.number().int().positive() }),
  }, async ({ projectId }) => {
    try { return asText(compactCollection(await client.get(`/api/v3/projects/${projectId}/types`))); } catch (e) { return toolError(e); }
  });

  server.registerTool("op_list_statuses", {
    description: "List work package statuses.",
    inputSchema: z.object({}),
  }, async () => {
    try { return asText(compactCollection(await client.get("/api/v3/statuses"))); } catch (e) { return toolError(e); }
  });

  server.registerTool("op_list_priorities", {
    description: "List work package priorities.",
    inputSchema: z.object({}),
  }, async () => {
    try { return asText(compactCollection(await client.get("/api/v3/priorities"))); } catch (e) { return toolError(e); }
  });

  server.registerTool("op_list_users", {
    description: "List OpenProject users. Depending on server/version this may require administrator permission.",
    inputSchema: z.object({
      pageSize: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(1).default(1),
      filters: z.string().optional(),
    }),
  }, async ({ pageSize, offset, filters }) => {
    try {
      const checkedFilters = parseOptionalJsonArray(filters, "filters");
      return asText(compactCollection(await client.get("/api/v3/users", { pageSize, offset, filters: checkedFilters })));
    } catch (e) { return toolError(e); }
  });

  server.registerTool("op_list_work_packages", {
    description: "List/search OpenProject work packages. filters and sortBy must be API v3 JSON array strings.",
    inputSchema: z.object({
      projectId: z.number().int().positive().optional().describe("If set, list work packages only for this project/workspace"),
      pageSize: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(1).default(1),
      filters: z.string().default("[]"),
      sortBy: z.string().optional().describe("OpenProject sortBy JSON array string"),
    }),
  }, async ({ projectId, pageSize, offset, filters, sortBy }) => {
    try {
      const path = projectId ? `/api/v3/projects/${projectId}/work_packages` : "/api/v3/work_packages";
      const checkedFilters = validateJsonArrayString(filters, "filters");
      const checkedSortBy = parseOptionalJsonArray(sortBy, "sortBy");
      return asText(compactCollection(await client.get(path, { pageSize, offset, filters: checkedFilters, sortBy: checkedSortBy })));
    } catch (e) { return toolError(e); }
  });

  server.registerTool("op_get_work_package", {
    description: "Get a work package by ID, including lockVersion used for safe updates.",
    inputSchema: z.object({ workPackageId: z.number().int().positive() }),
  }, async ({ workPackageId }) => {
    try { return asText(await client.get(`/api/v3/work_packages/${workPackageId}`)); } catch (e) { return toolError(e); }
  });

  server.registerTool("op_list_work_package_activities", {
    description: "List activities/comments of a work package.",
    inputSchema: z.object({
      workPackageId: z.number().int().positive(),
      pageSize: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(1).default(1),
    }),
  }, async ({ workPackageId, pageSize, offset }) => {
    try { return asText(compactCollection(await client.get(`/api/v3/work_packages/${workPackageId}/activities`, { pageSize, offset }))); } catch (e) { return toolError(e); }
  });

  server.registerTool("op_list_work_package_attachments", {
    description: "List files/images attached directly to a work package.",
    inputSchema: z.object({ workPackageId: z.number().int().positive() }),
  }, async ({ workPackageId }) => {
    try { return asText(compactCollection(await client.get(`/api/v3/work_packages/${workPackageId}/attachments`))); } catch (e) { return toolError(e); }
  });

  server.registerTool("op_create_work_package", {
    description: "Create a work package in a project. WRITE operation; disabled when OPENPROJECT_ALLOW_WRITE=false.",
    inputSchema: z.object({
      projectId: z.number().int().positive(),
      subject: z.string().min(1),
      description: z.string().optional(),
      typeId: z.number().int().positive().optional(),
      assigneeId: z.number().int().positive().optional(),
      statusId: z.number().int().positive().optional(),
      priorityId: z.number().int().positive().optional(),
      startDate: z.string().optional().describe("YYYY-MM-DD"),
      dueDate: z.string().optional().describe("YYYY-MM-DD"),
      notify: z.boolean().default(true),
      extra: z.record(z.string(), z.unknown()).optional().describe("Extra API v3 write fields merged into the request body"),
    }),
  }, async ({ projectId, subject, description, typeId, assigneeId, statusId, priorityId, startDate, dueDate, notify, extra }) => {
    try {
      requireWrite();
      const links: JsonObject = {};
      if (typeId) links.type = link(typeId, "types");
      if (assigneeId) links.assignee = link(assigneeId, "users");
      if (statusId) links.status = link(statusId, "statuses");
      if (priorityId) links.priority = link(priorityId, "priorities");
      const body: JsonObject = {
        ...extra,
        subject,
        ...(description !== undefined ? { description: { raw: description } } : {}),
        ...(startDate ? { startDate } : {}),
        ...(dueDate ? { dueDate } : {}),
        ...(Object.keys(links).length || Object.keys(extraLinks(extra)).length
          ? { _links: { ...extraLinks(extra), ...links } }
          : {}),
      };
      return asText(await client.post(`/api/v3/projects/${projectId}/work_packages`, body, { notify }));
    } catch (e) { return toolError(e); }
  });

  server.registerTool("op_update_work_package", {
    description: "Update a work package. Fetches the latest lockVersion immediately before PATCH. If OpenProject reports a conflict, the tool does not auto-retry or overwrite concurrent changes.",
    inputSchema: z.object({
      workPackageId: z.number().int().positive(),
      subject: z.string().min(1).optional(),
      description: z.string().optional(),
      assigneeId: z.number().int().positive().nullable().optional(),
      statusId: z.number().int().positive().optional(),
      priorityId: z.number().int().positive().optional(),
      startDate: z.string().nullable().optional(),
      dueDate: z.string().nullable().optional(),
      notify: z.boolean().default(true),
      extra: z.record(z.string(), z.unknown()).optional().describe("Extra API v3 write fields merged into the PATCH body"),
    }),
  }, async ({ workPackageId, subject, description, assigneeId, statusId, priorityId, startDate, dueDate, notify, extra }) => {
    try {
      requireWrite();
      const current = await client.get<Record<string, unknown>>(`/api/v3/work_packages/${workPackageId}`);
      const lockVersion = current.lockVersion;
      if (typeof lockVersion !== "number") throw new OpenProjectError("Current work package did not contain lockVersion");

      const links: JsonObject = {};
      if (assigneeId !== undefined) links.assignee = assigneeId === null ? { href: null } : link(assigneeId, "users");
      if (statusId) links.status = link(statusId, "statuses");
      if (priorityId) links.priority = link(priorityId, "priorities");

      const body: JsonObject = {
        ...extra,
        lockVersion,
        ...(subject !== undefined ? { subject } : {}),
        ...(description !== undefined ? { description: { raw: description } } : {}),
        ...(startDate !== undefined ? { startDate } : {}),
        ...(dueDate !== undefined ? { dueDate } : {}),
        ...(Object.keys(links).length || Object.keys(extraLinks(extra)).length
          ? { _links: { ...extraLinks(extra), ...links } }
          : {}),
      };
      return asText(await client.patch(`/api/v3/work_packages/${workPackageId}`, body, { notify }));
    } catch (e) { return toolError(e); }
  });

  server.registerTool("op_add_comment", {
    description: "Add a comment to a work package. WRITE operation. This does not upload files; use the attachment tool separately.",
    inputSchema: z.object({
      workPackageId: z.number().int().positive(),
      comment: z.string().min(1),
      internal: z.boolean().optional(),
      notify: z.boolean().default(true),
    }),
  }, async ({ workPackageId, comment, internal, notify }) => {
    try {
      requireWrite();
      const body: JsonObject = { comment: { raw: comment } };
      if (internal !== undefined) body.internal = internal;
      return asText(await client.post(`/api/v3/work_packages/${workPackageId}/activities`, body, { notify }));
    } catch (e) { return toolError(e); }
  });

  server.registerTool("op_prepare_work_package_attachment", {
    description: "Prepare an attachment upload for a file that exists on the AI/user machine. No server file path is accepted. Prefer OpenProject direct storage upload; when that is unavailable, return a short-lived relay URL that streams bytes through this MCP host without persisting them.",
    inputSchema: z.object({
      workPackageId: z.number().int().positive(),
      fileName: z.string().min(1),
      fileSize: z.number().int().positive().describe("Exact local file size in bytes"),
      contentType: z.string().min(1).optional().describe("MIME type such as image/png"),
      description: z.string().optional(),
    }),
  }, async ({ workPackageId, fileName, fileSize, contentType, description }) => {
    try {
      requireWrite();
      const metadata = { fileName, fileSize, contentType, description };
      try {
        const prepared = await client.prepareWorkPackageAttachment(workPackageId, metadata) as Record<string, unknown>;
        const links = prepared._links as Record<string, unknown> | undefined;
        const addAttachment = links?.addAttachment as Record<string, unknown> | undefined;
        const completeUpload = links?.completeUpload as Record<string, unknown> | undefined;
        const href = addAttachment?.href;
        const method = addAttachment?.method;
        const formFields = addAttachment?.form_fields;
        const attachmentId = prepared.id;
        if (typeof href !== "string" || typeof method !== "string" || typeof attachmentId !== "number") {
          throw new OpenProjectError("OpenProject returned an invalid direct-upload instruction", undefined, prepared);
        }
        const orderedFields = formFields && typeof formFields === "object" && !Array.isArray(formFields)
          ? Object.entries(formFields as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value) }))
          : [];
        return asText({
          mode: "direct",
          attachmentId,
          upload: {
            url: href,
            method: method.toUpperCase(),
            fieldsInOrder: orderedFields,
            fileField: "file",
            fileFieldMustBeLast: true,
          },
          complete: {
            tool: "op_complete_work_package_attachment",
            attachmentId,
            href: typeof completeUpload?.href === "string" ? completeUpload.href : `/api/v3/attachments/${attachmentId}/uploaded`,
          },
          instruction: "From the machine that owns the local file, send multipart/form-data directly to upload.url: append every fieldsInOrder entry in order, then append the local file as the final field named 'file'. After a successful storage upload, call op_complete_work_package_attachment.",
        });
      } catch (error) {
        if (!isDirectUploadUnavailable(error)) throw error;
        if (!relayTokens || !config.relay.enabled) {
          throw new OpenProjectError(
            "OpenProject direct attachment upload is unavailable and the hosted MCP relay is disabled. Enable OPENPROJECT_RELAY_ENABLED with a public relay URL/secret, or configure OpenProject direct storage uploads.",
            422,
            error instanceof OpenProjectError ? error.details : error,
          );
        }
        const relay = createRelayUploadUrl(config, relayTokens, { workPackageId, ...metadata });
        return asText({
          mode: "relay",
          upload: {
            url: relay.uploadUrl,
            method: "PUT",
            headers: { "Content-Type": contentType || "application/octet-stream" },
            contentLength: fileSize,
            body: "raw file bytes (not multipart, not base64)",
          },
          expiresAt: relay.expiresAt,
          completeRequired: false,
          persistedOnMcpServer: false,
          instruction: "From the machine that owns the local file, PUT the raw file bytes to upload.url with the exact Content-Length and Content-Type. The relay streams the request into OpenProject and does not write the file to disk.",
        });
      }
    } catch (e) { return toolError(e); }
  });


  server.registerTool("op_upload_work_package_attachment_from_url", {
    description: "Fetch a file/image from a trusted HTTPS host and attach it to a work package. The MCP host keeps the file only in memory for the request and never persists it. Disabled unless OPENPROJECT_REMOTE_UPLOAD_ALLOWED_HOSTS is configured.",
    inputSchema: z.object({
      workPackageId: z.number().int().positive(),
      url: z.string().url(),
      fileName: z.string().min(1).describe("Name to store in OpenProject"),
      contentType: z.string().min(1).optional().describe("Optional override; otherwise use the remote Content-Type"),
      description: z.string().optional(),
    }),
  }, async ({ workPackageId, url, fileName, contentType, description }) => {
    try {
      requireWrite();
      const remote = await downloadTrustedRemoteFile(url, config);
      const effectiveType = contentType || remote.contentType;
      const attachment = await client.uploadWorkPackageAttachmentStream(
        workPackageId,
        Readable.from([remote.bytes]),
        { fileName, fileSize: remote.bytes.length, contentType: effectiveType, description },
        config.remoteUpload.maxBytes,
      );
      return asText({
        attachment,
        sourceUrl: remote.finalUrl,
        persistedOnMcpServer: false,
      });
    } catch (e) { return toolError(e); }
  });

  server.registerTool("op_complete_work_package_attachment", {
    description: "Complete a direct attachment upload after the local client has successfully uploaded the file to the storage instruction returned by op_prepare_work_package_attachment. Not needed for relay mode.",
    inputSchema: z.object({ attachmentId: z.number().int().positive() }),
  }, async ({ attachmentId }) => {
    try {
      requireWrite();
      return asText(await client.completePreparedAttachment(attachmentId));
    } catch (e) { return toolError(e); }
  });

  server.registerTool("op_raw_get", {
    description: "Advanced read-only escape hatch: GET any /api/v3/... path on the configured OpenProject instance.",
    inputSchema: z.object({
      path: z.string().regex(/^\/api\/v3(?:\/|$)/),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    }),
  }, async ({ path, query }) => {
    try { return asText(await client.get(path, query)); } catch (e) { return toolError(e); }
  });

  return server;
}

void serveStdio(createServer);
console.error(`openproject-mcp v1.2.0 running on stdio (write=${config.allowWrite ? "enabled" : "disabled"}, relay=${config.relay.enabled ? "enabled" : "disabled"})`);
