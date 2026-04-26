import { describe, it, expect, vi } from "vitest";
import {
  prepareForFacade,
  canPrepareCandidate,
  PREPAREABLE_CAPABILITIES,
} from "../src/prepare/prepare.js";
import { OctomilError } from "../src/types.js";
import type {
  ArtifactDownloadEndpoint,
  RuntimeArtifactPlan,
  RuntimeCandidatePlan,
  RuntimePlanResponse,
} from "../src/planner/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REAL_ENDPOINT: ArtifactDownloadEndpoint = {
  url: "https://cdn.example.com/",
};

function realArtifact(
  overrides: Partial<RuntimeArtifactPlan> = {},
): RuntimeArtifactPlan {
  return {
    model_id: "kokoro-en-v0_19",
    artifact_id: "kokoro-en-v0_19",
    digest: "sha256:" + "0".repeat(64),
    download_urls: [REAL_ENDPOINT],
    ...overrides,
  };
}

function localCandidate(
  overrides: Partial<RuntimeCandidatePlan> = {},
): RuntimeCandidatePlan {
  return {
    locality: "local",
    priority: 0,
    confidence: 0.9,
    reason: "test",
    engine: "sherpa-onnx",
    artifact: realArtifact(),
    delivery_mode: "sdk_runtime",
    prepare_required: true,
    prepare_policy: "lazy",
    ...overrides,
  };
}

function planWith(candidates: RuntimeCandidatePlan[]): RuntimePlanResponse {
  return {
    model: "kokoro-en-v0_19",
    capability: "tts",
    policy: "local_first",
    candidates,
    fallback_candidates: [],
    fallback_allowed: false,
    server_generated_at: new Date().toISOString(),
    public_client_allowed: false,
  };
}

function fakePlannerClient(plan: RuntimePlanResponse | null) {
  return {
    fetchPlan: vi.fn().mockResolvedValue(plan),
  } as unknown as Parameters<typeof prepareForFacade>[0];
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("prepareForFacade", () => {
  it("returns a structured outcome for a real preparable candidate", async () => {
    const plan = planWith([localCandidate()]);
    const planner = fakePlannerClient(plan);

    const outcome = await prepareForFacade(planner, {
      model: "@app/eternum/tts",
    });

    expect(outcome.artifactId).toBe("kokoro-en-v0_19");
    expect(outcome.deliveryMode).toBe("sdk_runtime");
    expect(outcome.preparePolicy).toBe("lazy");
    expect(outcome.prepareRequired).toBe(true);
    expect(outcome.downloadUrls).toEqual([REAL_ENDPOINT]);
    expect(outcome.digest).toBe("sha256:" + "0".repeat(64));
    expect(outcome.prepared).toBe(false); // Node SDK does not download yet
  });

  it("works for explicit_only candidates (the EXPLICIT mode contract)", async () => {
    const plan = planWith([
      localCandidate({ prepare_policy: "explicit_only" }),
    ]);
    const planner = fakePlannerClient(plan);

    const outcome = await prepareForFacade(planner, { model: "@app/x/tts" });
    expect(outcome.preparePolicy).toBe("explicit_only");
  });

  it("accepts every supported capability", async () => {
    for (const cap of PREPAREABLE_CAPABILITIES) {
      const plan = planWith([localCandidate()]);
      const planner = fakePlannerClient(plan);
      const outcome = await prepareForFacade(planner, {
        model: "m",
        capability: cap,
      });
      expect(outcome.capability).toBe(cap);
    }
  });

  it("only TTS is in the supported set today (parity with Python #444)", () => {
    expect(Array.from(PREPAREABLE_CAPABILITIES)).toEqual(["tts"]);
  });
});

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

describe("prepareForFacade rejection paths", () => {
  it("rejects an unknown capability with INVALID_INPUT", async () => {
    const planner = fakePlannerClient(planWith([localCandidate()]));
    await expect(
      // @ts-expect-error invalid capability for the test
      prepareForFacade(planner, { model: "m", capability: "vision" }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it.each(["transcription", "embeddings", "chat", "responses"] as const)(
    "rejects unwired capability %s with an actionable INVALID_INPUT message",
    async (cap) => {
      const planner = fakePlannerClient(planWith([localCandidate()]));
      try {
        await prepareForFacade(planner, { model: "m", capability: cap });
        throw new Error("expected rejection");
      } catch (err) {
        expect(err).toBeInstanceOf(OctomilError);
        const msg = (err as OctomilError).message;
        expect((err as OctomilError).code).toBe("INVALID_INPUT");
        expect(msg).toContain(cap);
        expect(msg.toLowerCase()).toContain("tts");
      }
    },
  );

  it("raises RUNTIME_UNAVAILABLE when the planner returns null", async () => {
    const planner = fakePlannerClient(null);
    await expect(
      prepareForFacade(planner, { model: "m" }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("raises RUNTIME_UNAVAILABLE when no local sdk_runtime candidate exists", async () => {
    const planner = fakePlannerClient(
      planWith([
        {
          ...localCandidate(),
          locality: "cloud",
        },
      ]),
    );
    await expect(
      prepareForFacade(planner, { model: "m" }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("rejects a candidate with missing download_urls", async () => {
    const plan = planWith([
      localCandidate({ artifact: realArtifact({ download_urls: [] }) }),
    ]);
    const planner = fakePlannerClient(plan);
    await expect(
      prepareForFacade(planner, { model: "m" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a candidate with no digest", async () => {
    const plan = planWith([
      localCandidate({ artifact: realArtifact({ digest: undefined }) }),
    ]);
    const planner = fakePlannerClient(plan);
    await expect(
      prepareForFacade(planner, { model: "m" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a multi-file artifact (no per-file manifest yet)", async () => {
    const plan = planWith([
      localCandidate({
        artifact: realArtifact({ required_files: ["a.bin", "b.bin"] }),
      }),
    ]);
    const planner = fakePlannerClient(plan);
    await expect(
      prepareForFacade(planner, { model: "m" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it.each([
    "../escaped.bin",
    ".",
    "./",
    "subdir/../escape",
    "/abs/path",
    "back\\slash",
  ])("rejects unsafe required_files path %s", async (badPath) => {
    const plan = planWith([
      localCandidate({ artifact: realArtifact({ required_files: [badPath] }) }),
    ]);
    const planner = fakePlannerClient(plan);
    await expect(
      prepareForFacade(planner, { model: "m" }),
    ).rejects.toBeInstanceOf(OctomilError);
  });

  it("rejects a disabled prepare_policy", async () => {
    const plan = planWith([localCandidate({ prepare_policy: "disabled" })]);
    const planner = fakePlannerClient(plan);
    await expect(
      prepareForFacade(planner, { model: "m" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("accepts a prepare_required=false candidate as preparable", async () => {
    // prepare_required=false is the engine-managed-bytes path; it's a valid
    // outcome even with an empty artifact plan.
    const plan = planWith([
      localCandidate({
        prepare_required: false,
        artifact: { model_id: "kokoro-en-v0_19" },
      }),
    ]);
    const planner = fakePlannerClient(plan);
    const outcome = await prepareForFacade(planner, { model: "m" });
    expect(outcome.prepareRequired).toBe(false);
    expect(outcome.downloadUrls).toEqual([]);
  });

  it("accepts a prepare_required=false candidate with NO artifact plan", async () => {
    // Reviewer's reproducer: planner may legitimately omit `artifact` when
    // the engine manages its own bytes. Earlier code dereferenced
    // `candidate.artifact!` and crashed; now we surface a no-files outcome.
    const plan = planWith([
      localCandidate({
        prepare_required: false,
        artifact: undefined,
        engine: "ollama",
      }),
    ]);
    const planner = fakePlannerClient(plan);
    const outcome = await prepareForFacade(planner, { model: "m" });
    expect(outcome.prepareRequired).toBe(false);
    expect(outcome.downloadUrls).toEqual([]);
    expect(outcome.requiredFiles).toEqual([]);
    expect(outcome.digest).toBeNull();
    expect(outcome.manifestUri).toBeNull();
  });

  it("accepts a single-file artifact (empty required_files)", async () => {
    // Reviewer's reproducer: an empty required_files list represents the
    // single-file artifact case (e.g. one .gguf). prepare must NOT reject
    // it just because the list happens to be empty.
    const plan = planWith([
      localCandidate({
        artifact: realArtifact({ required_files: [] }),
      }),
    ]);
    const planner = fakePlannerClient(plan);
    const outcome = await prepareForFacade(planner, { model: "m" });
    expect(outcome.requiredFiles).toEqual([]);
    expect(outcome.prepared).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canPrepareCandidate
// ---------------------------------------------------------------------------

describe("canPrepareCandidate", () => {
  it("returns true for a real preparable candidate", () => {
    expect(canPrepareCandidate(localCandidate())).toBe(true);
  });

  it("returns false for cloud locality", () => {
    expect(
      canPrepareCandidate({ ...localCandidate(), locality: "cloud" }),
    ).toBe(false);
  });

  it("returns false for hosted_gateway delivery", () => {
    expect(
      canPrepareCandidate({
        ...localCandidate(),
        delivery_mode: "hosted_gateway",
      }),
    ).toBe(false);
  });

  it("returns false for synthetic artifact (no digest, no urls)", () => {
    expect(
      canPrepareCandidate({
        ...localCandidate(),
        artifact: { model_id: "kokoro-en-v0_19" },
      }),
    ).toBe(false);
  });

  it("returns false for traversal in required_files", () => {
    expect(
      canPrepareCandidate({
        ...localCandidate(),
        artifact: realArtifact({ required_files: ["../escape.bin"] }),
      }),
    ).toBe(false);
  });
});
