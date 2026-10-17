import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithConnectTimeout } from "../src/http.js";

describe("fetchWithConnectTimeout", () => {
  afterEach(() => vi.restoreAllMocks());

  it("aborts when headers do not arrive in time", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    await expect(fetchWithConnectTimeout("https://x.test", {}, 10)).rejects.toThrow("aborted");
  });

  it("propagates a caller abort", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const ac = new AbortController();
    const p = fetchWithConnectTimeout("https://x.test", { signal: ac.signal }, 60_000);
    ac.abort();
    await expect(p).rejects.toThrow("aborted");
  });
});
