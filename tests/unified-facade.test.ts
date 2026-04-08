import { describe, it, expect, vi, beforeEach } from "vitest";
import { Octomil, OctomilNotInitializedError } from "../src/facade.js";
import type { ResponseObj } from "../src/responses.js";

// ---------------------------------------------------------------------------
// Mock configure() so it never hits the network
// ---------------------------------------------------------------------------

vi.mock("../src/configure.js", () => ({
  configure: vi.fn().mockResolvedValue({}),
  getDeviceContext: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Mock ResponsesClient
// ---------------------------------------------------------------------------

const mockCreate = vi.fn<() => Promise<ResponseObj>>();
const mockStream = vi.fn();

vi.mock("../src/responses.js", async (importOriginal) => {
  const original =
    (await importOriginal()) as typeof import("../src/responses.js");
  return {
    ...original,
    ResponsesClient: vi.fn().mockImplementation(() => ({
      create: mockCreate,
      stream: mockStream,
    })),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Octomil unified facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- Constructor ----------------------------------------------------------

  describe("constructor", () => {
    it("creates a client with publishableKey", () => {
      const client = new Octomil({
        publishableKey: "oct_pub_test_abc123",
      });
      expect(client).toBeInstanceOf(Octomil);
    });

    it("creates a client with apiKey + orgId", () => {
      const client = new Octomil({
        apiKey: "edg_sk_abc",
        orgId: "org_123",
      });
      expect(client).toBeInstanceOf(Octomil);
    });

    it("rejects invalid publishable key prefix", () => {
      expect(() => {
        new Octomil({ publishableKey: "bad_prefix_key" });
      }).toThrow("oct_pub_test_");
    });
  });

  // -- initialize() ---------------------------------------------------------

  describe("initialize()", () => {
    it("is idempotent", async () => {
      const client = new Octomil({
        publishableKey: "oct_pub_test_abc123",
      });
      await client.initialize();
      await client.initialize(); // second call is a no-op
      // Should not throw
    });

    it("throws when no auth method is provided", async () => {
      const client = new Octomil({});
      await expect(client.initialize()).rejects.toThrow(
        "Octomil requires one of",
      );
    });

    it("throws when apiKey is provided without orgId", async () => {
      const client = new Octomil({ apiKey: "edg_sk_abc" });
      await expect(client.initialize()).rejects.toThrow(
        "orgId is required",
      );
    });
  });

  // -- responses before initialize() ----------------------------------------

  describe("responses before initialize()", () => {
    it("responses.create() throws OctomilNotInitializedError", () => {
      const client = new Octomil({
        publishableKey: "oct_pub_test_abc123",
      });
      expect(() => client.responses).toThrow(OctomilNotInitializedError);
    });

    it("responses getter throws with correct message", () => {
      const client = new Octomil({ apiKey: "edg_sk_abc", orgId: "org_1" });
      expect(() => client.responses).toThrow(
        "Octomil client is not initialized",
      );
    });
  });

  // -- responses.create() ---------------------------------------------------

  describe("responses.create()", () => {
    it("delegates to ResponsesClient and adds outputText", async () => {
      const fakeResponse: ResponseObj = {
        id: "resp_1",
        model: "phi-4-mini",
        output: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
        finishReason: "stop",
      };
      mockCreate.mockResolvedValueOnce(fakeResponse);

      const client = new Octomil({
        publishableKey: "oct_pub_test_abc123",
      });
      await client.initialize();

      const result = await client.responses.create({
        model: "phi-4-mini",
        input: "Hi",
      });

      expect(result.id).toBe("resp_1");
      expect(result.outputText).toBe("Hello world");
      expect(mockCreate).toHaveBeenCalledOnce();
    });
  });

  // -- responses.stream() ---------------------------------------------------

  describe("responses.stream()", () => {
    it("delegates to ResponsesClient stream", async () => {
      const events = [
        { type: "text_delta" as const, delta: "Hi" },
        {
          type: "done" as const,
          response: {
            id: "resp_2",
            model: "phi-4-mini",
            output: [{ type: "text" as const, text: "Hi" }],
            finishReason: "stop",
          },
        },
      ];

      mockStream.mockImplementationOnce(async function* () {
        for (const e of events) {
          yield e;
        }
      });

      const client = new Octomil({
        publishableKey: "oct_pub_test_abc123",
      });
      await client.initialize();

      const collected = [];
      for await (const event of client.responses.stream({
        model: "phi-4-mini",
        input: "Hi",
      })) {
        collected.push(event);
      }

      expect(collected).toHaveLength(2);
      expect(collected[0]!.type).toBe("text_delta");
      expect(collected[1]!.type).toBe("done");
    });
  });

  // -- outputText -----------------------------------------------------------

  describe("outputText", () => {
    it("concatenates text output items", async () => {
      const fakeResponse: ResponseObj = {
        id: "resp_3",
        model: "test",
        output: [
          { type: "reasoning", reasoningContent: "thinking..." },
          { type: "text", text: "Part 1 " },
          { type: "tool_call", toolCall: { id: "tc1", name: "fn", arguments: "{}" } },
          { type: "text", text: "Part 2" },
        ],
        finishReason: "stop",
      };
      mockCreate.mockResolvedValueOnce(fakeResponse);

      const client = new Octomil({ apiKey: "k", orgId: "o" });
      await client.initialize();
      const result = await client.responses.create({
        model: "test",
        input: "x",
      });

      expect(result.outputText).toBe("Part 1 Part 2");
    });

    it("returns empty string when no text items", async () => {
      const fakeResponse: ResponseObj = {
        id: "resp_4",
        model: "test",
        output: [
          { type: "tool_call", toolCall: { id: "tc1", name: "fn", arguments: "{}" } },
        ],
        finishReason: "stop",
      };
      mockCreate.mockResolvedValueOnce(fakeResponse);

      const client = new Octomil({ apiKey: "k", orgId: "o" });
      await client.initialize();
      const result = await client.responses.create({
        model: "test",
        input: "x",
      });

      expect(result.outputText).toBe("");
    });
  });

  // -- OctomilNotInitializedError -------------------------------------------

  describe("OctomilNotInitializedError", () => {
    it("has correct name and message", () => {
      const err = new OctomilNotInitializedError();
      expect(err.name).toBe("OctomilNotInitializedError");
      expect(err.message).toContain("not initialized");
      expect(err).toBeInstanceOf(Error);
    });
  });
});
