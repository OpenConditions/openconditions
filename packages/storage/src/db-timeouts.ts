const codeOf = (err: unknown): unknown =>
  typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;

/** Whether a statement gave up waiting for a lock (`lock_timeout`, 55P03). */
export function isLockTimeout(err: unknown): boolean {
  return codeOf(err) === "55P03";
}

/** Whether a statement ran past `statement_timeout` (57014) or waited past `lock_timeout`. */
export function isDbTimeout(err: unknown): boolean {
  return codeOf(err) === "57014" || isLockTimeout(err);
}
