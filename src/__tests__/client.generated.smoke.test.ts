import { describe, expect, it } from "vitest";

import { createApiClient } from "../generated/client.js";

describe("generated control-plane client", () => {
  it("issues a typed GET with path params interpolated", async () => {
    const calls: { url: string; method: string }[] = [];
    const mockFetch = async (req: Request) => {
      calls.push({ url: req.url, method: req.method });
      return new Response(JSON.stringify({ version: "v1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch: mockFetch,
    });

    await api.devices.desiredState({
      params: { path: { device_id: "d1" } },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.test/api/v1/devices/d1/desired-state");
  });

  it("issues a typed POST with a JSON body", async () => {
    const bodies: unknown[] = [];
    const mockFetch = async (req: Request) => {
      bodies.push(await req.json());
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const api = createApiClient({ baseUrl: "https://api.test", fetch: mockFetch });

    await api.telemetry.batch({ body: { events: [] } as never });

    expect(bodies).toEqual([{ events: [] }]);
  });

  it("exposes the namespaced surface shape", () => {
    const api = createApiClient({ baseUrl: "https://api.test" });
    expect(typeof api.devices.desiredState).toBe("function");
    expect(typeof api.telemetry.batch).toBe("function");
    expect(typeof api.federation.join).toBe("function");
  });
});
