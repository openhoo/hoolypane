/** Single source for normalizing unknown throwables into user-visible messages. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Null-safe errno discrimination for caught values of any shape: null, primitives, non-Error objects. */
export function isErrnoException(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
/** Contractual reason cap shared by RecordFailureSchema.reason and ReplayResultSchema.reason. */
export const FAILURE_REASON_MAX_LENGTH = 512;

/** Normalizes an unknown throwable into a schema-valid failure reason in one step. */
export function failureReason(error: unknown): string {
  return errorMessage(error).slice(0, FAILURE_REASON_MAX_LENGTH);
}
