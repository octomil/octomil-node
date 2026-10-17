export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Bounds time-to-headers only, so long-running response bodies are unaffected. */
export async function fetchWithConnectTimeout(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const outer = init.signal;
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
