/** Single source for normalizing unknown throwables into user-visible messages. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
