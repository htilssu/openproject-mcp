# openproject-mcp

MCP server for OpenProject API v3. It exposes project/work-package tools and a hosted-friendly attachment workflow for Codex/Claude/other MCP clients.

## Attachment design in v1.2

The MCP server does **not** read arbitrary files from its own filesystem anymore. There is no `OPENPROJECT_ALLOWED_UPLOAD_DIRS`.

For a file that exists on the user's machine:

1. The AI reads only local metadata (`fileName`, exact byte size, MIME type).
2. It calls `op_prepare_work_package_attachment`.
3. If OpenProject supports direct uploads, the tool returns the presigned storage instruction. The AI uploads the local file directly from the user's machine to that storage, then calls `op_complete_work_package_attachment`.
4. If direct uploads are unavailable and relay mode is configured, the tool returns a short-lived one-time relay URL. The user's machine `PUT`s the raw file bytes to that URL. The MCP host streams those bytes into OpenProject and never writes them to disk.

This supports local files even when the MCP server is hosted remotely.

## Tools

Read tools:

- `op_get_instance`
- `op_get_configuration`
- `op_list_projects`
- `op_get_project`
- `op_list_project_types`
- `op_list_statuses`
- `op_list_priorities`
- `op_list_users`
- `op_list_work_packages`
- `op_get_work_package`
- `op_list_work_package_activities`
- `op_list_work_package_attachments`
- `op_raw_get`

Write tools (enabled by default; set `OPENPROJECT_ALLOW_WRITE=false` to disable):

- `op_create_work_package`
- `op_update_work_package`
- `op_add_comment`
- `op_prepare_work_package_attachment`
- `op_complete_work_package_attachment`
- `op_upload_work_package_attachment_from_url`

## Requirements

- Node.js 20.12+
- OpenProject API v3 enabled
- An OpenProject API token

## Quick start (npx)

No clone or build needed. Add it to Claude Code with your own token:

```bash
claude mcp add --scope user openproject \
  -e OPENPROJECT_URL=https://openproject.example.com \
  -e OPENPROJECT_API_TOKEN=... \
  -- npx -y @htilssu/openproject-mcp@latest
```

On native Windows (not WSL), wrap `npx` with `cmd /c`:

```bash
claude mcp add --scope user openproject -e OPENPROJECT_URL=... -e OPENPROJECT_API_TOKEN=... -- cmd /c npx -y @htilssu/openproject-mcp@latest
```

Keep the `@latest` suffix: without it, running inside a checkout of this repository makes `npx` resolve the local package instead of the published one and fail with "'openproject-mcp' is not recognized".

Or run it directly:

```bash
OPENPROJECT_URL=https://openproject.example.com \
OPENPROJECT_API_TOKEN=... \
npx -y @htilssu/openproject-mcp@latest
```

Any MCP client that launches stdio servers can use `npx -y @htilssu/openproject-mcp@latest` as the command.

## Install from source

```bash
npm install
npm run build
```

Run over stdio:

```bash
OPENPROJECT_URL=https://openproject.example.com \
OPENPROJECT_API_TOKEN=... \
node dist/index.js
```

`stdout` is reserved for MCP. Logs are written to `stderr`.

Configuration can also be placed in a `.env` file (see `.env.example`). The server loads the first file found:
`OPENPROJECT_ENV_FILE` (explicit path), then `.env` in the working directory, then `.env` in the package root.
Variables already set in the environment override values from the file.

## Basic configuration

```env
OPENPROJECT_URL=https://openproject.example.com
OPENPROJECT_API_TOKEN=replace-me
OPENPROJECT_ALLOW_WRITE=true
OPENPROJECT_TIMEOUT_MS=30000
OPENPROJECT_MAX_RETRIES=2
OPENPROJECT_RETRY_BASE_MS=500
OPENPROJECT_MAX_RESPONSE_BYTES=5242880
```

Write operations are enabled by default. Set `OPENPROJECT_ALLOW_WRITE=false` for a read-only server.

## Local file upload: direct mode

First determine the local file metadata. Example on PowerShell:

```powershell
$file = Get-Item 'C:\Users\Hieu\Desktop\bug.png'
$file.Name
$file.Length
```

Then call the MCP tool with metadata only:

```json
{
  "workPackageId": 123,
  "fileName": "bug.png",
  "fileSize": 843122,
  "contentType": "image/png",
  "description": "Login error screenshot"
}
```

When the result is:

```json
{
  "mode": "direct",
  "attachmentId": 456,
  "upload": {
    "url": "https://storage.example.com/",
    "method": "POST",
    "fieldsInOrder": [
      { "name": "key", "value": "..." },
      { "name": "policy", "value": "..." }
    ],
    "fileField": "file",
    "fileFieldMustBeLast": true
  }
}
```

the MCP client/agent must submit every returned field in the returned order, then append the local file as the **last** multipart field named `file`. The file bytes go from the local machine directly to the storage backend, not through the MCP host.

After the storage request succeeds, call:

```json
{
  "attachmentId": 456
}
```

with `op_complete_work_package_attachment`.

## Local file upload: relay fallback

OpenProject returns HTTP 422 from `attachments/prepare` when direct storage upload is unavailable. The MCP server only falls back when the error is specifically the documented direct-upload configuration error; ordinary 422 validation errors are returned to the agent.

The relay is **enabled by default in local mode** (whenever writes are enabled): with no `OPENPROJECT_RELAY_PUBLIC_BASE_URL`, it listens on `127.0.0.1` on a random free port, uses a per-process random secret, and returns `http://127.0.0.1:<port>/upload/...` URLs. This works when the MCP client and the files are on the same machine, and several MCP processes can run side by side. If the relay cannot start (for example a fixed port is in use), the MCP server keeps running and uploads report the relay as unavailable. Set `OPENPROJECT_RELAY_ENABLED=false` to turn it off.

For a hosted relay reachable from other machines, set a public URL and a fixed secret:

```env
OPENPROJECT_RELAY_ENABLED=true
OPENPROJECT_RELAY_HOST=0.0.0.0
OPENPROJECT_RELAY_PORT=8788
OPENPROJECT_RELAY_PUBLIC_BASE_URL=https://openproject-mcp.example.com
OPENPROJECT_RELAY_SECRET=replace-with-a-random-secret-at-least-32-characters
OPENPROJECT_RELAY_TOKEN_TTL_SECONDS=300
OPENPROJECT_RELAY_MAX_UPLOAD_BYTES=52428800
```

Route `https://openproject-mcp.example.com/upload/*` to port `8788` of the MCP process/container.

Relay result example:

```json
{
  "mode": "relay",
  "upload": {
    "url": "https://openproject-mcp.example.com/upload/<signed-token>",
    "method": "PUT",
    "headers": { "Content-Type": "image/png" },
    "contentLength": 843122,
    "body": "raw file bytes (not multipart, not base64)"
  },
  "completeRequired": false,
  "persistedOnMcpServer": false
}
```

PowerShell example:

```powershell
curl.exe -X PUT `
  -H "Content-Type: image/png" `
  --data-binary "@C:\Users\Hieu\Desktop\bug.png" `
  "https://openproject-mcp.example.com/upload/<signed-token>"
```

The relay requires the exact `Content-Length` prepared by the tool. Tokens are signed, short lived, one-time and bound to the target work package/file metadata. If a relay request fails after it starts, request a new prepare token rather than replaying the old one.

The relay does not create `/uploads`, `/tmp` files, or any persistent attachment copy on the MCP host.

## Upload from an Internet URL

This is disabled by default. Configure trusted public hosts explicitly:

```env
OPENPROJECT_REMOTE_UPLOAD_ALLOWED_HOSTS=cdn.example.com,*.githubusercontent.com
OPENPROJECT_REMOTE_UPLOAD_MAX_BYTES=20971520
OPENPROJECT_REMOTE_UPLOAD_MAX_REDIRECTS=3
```

Then use `op_upload_work_package_attachment_from_url`:

```json
{
  "workPackageId": 123,
  "url": "https://cdn.example.com/bug.png",
  "fileName": "bug.png",
  "description": "Screenshot"
}
```

Only HTTPS is accepted. Every redirect must remain on the configured allowlist. The file is held in memory only for the duration of the request and is not persisted by this MCP server.

## Error behavior

- Safe reads retry transient network errors, 429, 502, 503 and 504 with bounded backoff.
- POST/PATCH/upload operations are not blindly retried.
- Ambiguous write failures expose `operationMayHaveSucceeded` so an agent can verify state before repeating anything.
- Work-package update obtains the latest `lockVersion` immediately before PATCH and does not overwrite a 409 conflict automatically.
- OpenProject error payloads retain `errorIdentifier` and details.
- A 404 may also mean the current OpenProject account does not have permission to see a resource.
- `op_complete_work_package_attachment` attempts to recover a completion call whose response was lost by checking the resulting attachment.

## Docker

```bash
docker build -t openproject-mcp:1.2.0 .
```

For relay mode expose the relay port, for example:

```bash
docker run --rm -i \
  -e OPENPROJECT_URL=https://openproject.example.com \
  -e OPENPROJECT_API_TOKEN=... \
  -e OPENPROJECT_ALLOW_WRITE=true \
  -e OPENPROJECT_RELAY_ENABLED=true \
  -e OPENPROJECT_RELAY_PUBLIC_BASE_URL=https://openproject-mcp.example.com \
  -e OPENPROJECT_RELAY_SECRET=replace-with-at-least-32-random-characters \
  -p 8788:8788 \
  openproject-mcp:1.2.0
```

## Tests

```bash
npm test
npm run typecheck
```
