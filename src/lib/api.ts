/** Browser-side client for the v1 REST API. Every UI mutation goes through here. */

export interface FieldErrorDetail {
  field: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: FieldErrorDetail[] = [],
  ) {
    super(message);
  }

  /** One readable line including field-level problems, for inline error text. */
  describe(): string {
    if (!this.fieldErrors.length) return this.message;
    return `${this.message}: ${this.fieldErrors.map((e) => `${e.field} ${e.message}`).join("; ")}`;
  }
}

export async function api<T = unknown>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error ?? {};
    throw new ApiError(res.status, err.code ?? "error", err.message ?? `Request failed (${res.status})`, err.details?.fieldErrors ?? []);
  }
  return json as T;
}

export function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.describe() : e instanceof Error ? e.message : String(e);
}
