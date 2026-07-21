// homebox-mcp
// Copyright (C) 2026 Bartłomiej Basztura
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

export type ErrorKind = "config" | "auth" | "validation" | "homebox" | "network" | "not_found" | "io" | "internal";

export class HomeboxMcpError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HomeboxMcpError";
  }
}

export function toSafeError(error: unknown): { kind: ErrorKind; message: string; status?: number } {
  if (error instanceof HomeboxMcpError) {
    return { kind: error.kind, message: error.message, status: error.status };
  }

  const fileSystemError = safeFileSystemError(error);
  if (fileSystemError) return fileSystemError;

  return { kind: "internal", message: "Unexpected internal error." };
}

function safeFileSystemError(error: unknown): { kind: "validation" | "io"; message: string } | undefined {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return undefined;

  switch (error.code) {
    case "ENOENT":
      return { kind: "validation", message: "Local file was not found. Check filePath and HOMEBOX_MCP_LOCAL_FILE_ROOT." };
    case "ENOTDIR":
      return { kind: "validation", message: "Local file path is invalid because a parent segment is not a directory." };
    case "EISDIR":
      return { kind: "validation", message: "filePath must reference a regular file, not a directory." };
    case "ELOOP":
      return { kind: "validation", message: "Local file path contains too many symbolic links." };
    case "ENAMETOOLONG":
      return { kind: "validation", message: "Local file path is too long." };
    case "EACCES":
    case "EPERM":
      return { kind: "io", message: "Local file could not be read due to filesystem permissions. Check HOMEBOX_MCP_LOCAL_FILE_ROOT and file permissions." };
    case "EMFILE":
    case "ENFILE":
      return { kind: "io", message: "Filesystem file-handle limit reached. Retry later or contact the server operator." };
    case "EBUSY":
      return { kind: "io", message: "Local file is busy. Retry later." };
    case "EIO":
      return { kind: "io", message: "Filesystem I/O failed. Retry or contact the server operator." };
    case "ENOSPC":
    case "EDQUOT":
    case "EROFS":
      return { kind: "io", message: "Filesystem storage is unavailable or read-only. Contact the server operator." };
    case "ERR_FS_FILE_TOO_LARGE":
      return { kind: "validation", message: "Local file exceeds the supported filesystem size." };
    default:
      return undefined;
  }
}
