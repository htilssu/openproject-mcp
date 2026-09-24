# Changelog

## Unreleased

- Published as `@htilssu/openproject-mcp`; run with `npx -y @htilssu/openproject-mcp`.
- Configuration is also loaded from a `.env` file (`OPENPROJECT_ENV_FILE`, working directory, or package root); real environment variables take precedence. Requires Node.js 20.12+.
- **Breaking default:** write tools are enabled by default. Set `OPENPROJECT_ALLOW_WRITE=false` for a read-only server.
- **Breaking default:** the upload relay is enabled by default in local mode (`127.0.0.1`, random free port, per-process secret) whenever writes are enabled. Set `OPENPROJECT_RELAY_ENABLED=false` to disable it.
- A relay startup failure (e.g. port in use) no longer crashes the MCP server.
- Fixed `attachments/prepare` returning HTTP 500: metadata is now sent as a plain string form field.
- Direct-upload fallback also recognizes the short "is not available due to a system configuration." 422 message.

## 1.2.0

- Removed server-local `filePath` upload and `OPENPROJECT_ALLOWED_UPLOAD_DIRS`.
- Added `op_prepare_work_package_attachment` for files that live on the AI/user machine.
- Prefer OpenProject direct upload (`/attachments/prepare`) so file bytes can go directly from the user's machine to attachment storage.
- Added `op_complete_work_package_attachment` with recovery for ambiguous/repeated completion calls.
- Added optional one-time hosted relay fallback when OpenProject direct upload is unavailable. The relay streams bytes into OpenProject and never writes files to disk.
- Relay tokens are signed, short-lived, one-time, bound to work package, filename, exact file size and content type.
- Added optional `op_upload_work_package_attachment_from_url` for allowlisted HTTPS hosts; remote bytes stay in memory only.
- Direct-upload fallback is used only for the documented "Direct file upload is not available" 422, not arbitrary validation errors.

## 1.1.0

- Added local attachment upload, OpenProject error details, safe GET retries, validation and attachment-size checks.
