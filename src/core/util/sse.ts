// Server-sent events over fetch. Written by hand because the one npm package that does this
// would be the extension's only runtime dependency, and an AI assistant asking an enterprise to
// trust a transitive dependency tree is asking for the thing it is meant to protect them from.

export async function* sseLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Events are separated by a blank line, but every provider we speak to sends exactly one
      // `data:` line per event, so splitting on newlines is enough and costs no buffering.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield line;
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock?.();
  }
}

/** `data: {...}` → the parsed payload. Returns undefined for comments, `[DONE]` and noise. */
export function sseData(line: string): unknown | undefined {
  if (!line.startsWith("data:")) return undefined;
  const raw = line.slice(5).trim();
  if (!raw || raw === "[DONE]") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
