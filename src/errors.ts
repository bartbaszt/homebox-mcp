export type ErrorKind = "config" | "auth" | "validation" | "homebox" | "network" | "not_found";

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
  if (error instanceof Error) {
    return { kind: "network", message: error.message };
  }
  return { kind: "network", message: String(error) };
}
