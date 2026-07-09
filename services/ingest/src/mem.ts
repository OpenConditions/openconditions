const MB = 1024 * 1024;
const mb = (bytes: number): number => Math.round(bytes / MB);

/**
 * One-line process-memory snapshot. `rss` is the OS-resident total the cgroup
 * OOM-killer watches; `heap` is the V8 heap (capped by --max-old-space-size);
 * `ext`/`ab` are off-heap ArrayBuffers/Buffers (fetch bodies, gzip, SAX). The
 * gap `rss − heap` is the off-heap footprint — the split that says whether an OOM
 * is a JS-heap leak or a Buffer/allocator problem.
 */
export function memLine(tag: string): string {
  const m = process.memoryUsage();
  return `[mem] ${tag} rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB ext=${mb(m.external)}MB ab=${mb(m.arrayBuffers)}MB`;
}

/** Logs {@link memLine} every `intervalMs`; returns a stop fn. Timer is unref'd. */
export function startMemTelemetry(intervalMs = 15_000): () => void {
  const timer = setInterval(() => console.info(memLine("tick")), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
