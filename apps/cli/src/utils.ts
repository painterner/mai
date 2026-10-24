let counter = 0;

/** Cheap monotonic id generator — good enough for in-memory message keys. */
export function genId(): string {
  counter += 1;
  return `m${counter}-${Date.now().toString(36)}`;
}
