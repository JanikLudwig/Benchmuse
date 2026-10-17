import type { FieldError } from "../domain/fields";

/** Base for errors that carry an HTTP status and a client-safe message. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(what: string, id: string) {
    super(404, "not_found", `${what} ${id} not found`);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, readonly fieldErrors: FieldError[] = []) {
    super(422, "validation_failed", message, fieldErrors.length ? { fieldErrors } : undefined);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, "conflict", message);
  }
}

/** Translate a Postgres unique-violation into a ConflictError with a readable message. */
export function rethrowUniqueViolation(error: unknown, message: string): never {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  if (code === "23505") throw new ConflictError(message);
  throw error;
}
