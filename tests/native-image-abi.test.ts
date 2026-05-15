/**
 * Tests for the optional ABI-11 image-input bindings.
 *
 * Scope (per the BLOCKED_WITH_PROOF posture from octomil-runtime #86):
 *   1. Constant exports compile and have the expected numeric values that
 *      match runtime.h (closed enums; sentinel at 0).
 *   2. NativeImageView type/shape compiles.
 *   3. REQUIRED_ABI.minor STAYS at 10 — explicit regression pin.
 *      OPTIONAL_ABI_MINOR_IMAGE = 11.
 *   4. With a synthetic NativeRuntime that mimics a minor-10 loaded
 *      runtime (no optional image symbols), constructing a session and
 *      reading the optional binding fields does not throw / surface.
 *   5. With a synthetic runtime advertising minor-11 BUT without
 *      embeddings.image capability, sendImage throws
 *      NativeRuntimeError carrying the capability name.
 *   6. With a synthetic runtime that advertises embeddings.image AND
 *      has the symbol resolved, sendImage rejects bad inputs with
 *      INVALID_INPUT (the path still terminates without calling the
 *      runtime stub — we don't run the unsupported native stub here).
 *
 * Out of scope: integration tests that expect oct_session_send_image to
 * succeed. The capability is BLOCKED_WITH_PROOF at the runtime level.
 */

import { describe, expect, it } from "vitest";
import koffi from "koffi";
import { RuntimeCapability } from "../src/_generated/runtime_capability.js";
import {
  NativeImageView,
  NativeRuntime,
  NativeRuntimeError,
  NativeSession,
  OCT_EMBED_POOLING_IMAGE_CLIP,
  OCT_IMAGE_MIME_JPEG,
  OCT_IMAGE_MIME_PNG,
  OCT_IMAGE_MIME_RGB8,
  OCT_IMAGE_MIME_UNKNOWN,
  OCT_IMAGE_MIME_WEBP,
  OPTIONAL_ABI_MINOR_IMAGE,
  REQUIRED_ABI,
} from "../src/runtime/native/loader.js";

// ── 1. Constant exports ──────────────────────────────────────────────────

describe("ABI-11 image constants", () => {
  it("OCT_IMAGE_MIME_* values match runtime.h closed enum", () => {
    // Sentinel at 0 — matches OCT_VAD_TRANSITION_UNKNOWN / OCT_SAMPLE_FORMAT_UNKNOWN.
    expect(OCT_IMAGE_MIME_UNKNOWN).toBe(0);
    expect(OCT_IMAGE_MIME_PNG).toBe(1);
    expect(OCT_IMAGE_MIME_JPEG).toBe(2);
    expect(OCT_IMAGE_MIME_WEBP).toBe(3);
    expect(OCT_IMAGE_MIME_RGB8).toBe(4);
  });

  it("OCT_EMBED_POOLING_IMAGE_CLIP is 5 (appended to pooling enum)", () => {
    // Existing pooling values (MEAN=1, CLS=2, LAST=3, RANK=4) unchanged;
    // image CLIP is the new discriminator at 5.
    expect(OCT_EMBED_POOLING_IMAGE_CLIP).toBe(5);
  });
});

// ── 2. NativeImageView type compiles ─────────────────────────────────────

describe("NativeImageView", () => {
  it("structurally compiles as { bytes: Uint8Array; mime: number }", () => {
    const view: NativeImageView = {
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mime: OCT_IMAGE_MIME_PNG,
    };
    expect(view.bytes).toBeInstanceOf(Uint8Array);
    expect(view.bytes.length).toBe(4);
    expect(view.mime).toBe(OCT_IMAGE_MIME_PNG);
  });
});

// ── 3. ABI-required-minor invariant ──────────────────────────────────────

describe("REQUIRED_ABI vs OPTIONAL_ABI_MINOR_IMAGE", () => {
  it("REQUIRED_ABI.minor stays at 10 — image bindings stay optional", () => {
    // HARD GUARD: this assertion must NOT be relaxed when adding ABI-11
    // bindings. Flipping the required minor to 11 is a separate decision
    // that only happens once a public SDK surface mandates image support.
    expect(REQUIRED_ABI.major).toBe(0);
    expect(REQUIRED_ABI.minor).toBe(10);
  });

  it("OPTIONAL_ABI_MINOR_IMAGE === 11", () => {
    expect(OPTIONAL_ABI_MINOR_IMAGE).toBe(11);
    expect(OPTIONAL_ABI_MINOR_IMAGE).toBeGreaterThan(REQUIRED_ABI.minor);
  });
});

// ── Mock-runtime helpers ─────────────────────────────────────────────────

interface FakeBindings {
  eventType: ReturnType<typeof koffi.struct>;
  imageViewType: ReturnType<typeof koffi.struct> | null;
  octImageViewSize: (() => number | bigint) | null;
  octSessionSendImage:
    | ((session: unknown, view: Record<string, unknown>) => number)
    | null;
}

function makeFakeBindings(opts: {
  minor: number;
  sendImageImpl?: (session: unknown, view: Record<string, unknown>) => number;
}): FakeBindings {
  const eventType = koffi.struct({
    // Minimal — only needs to be a valid koffi type for alloc().
    version: "uint32_t",
    size: "size_t",
  });

  if (opts.minor < OPTIONAL_ABI_MINOR_IMAGE) {
    // Minor-10: optional fields are null. The NativeSession constructor
    // and its other call sites MUST NOT touch the image fields.
    return {
      eventType,
      imageViewType: null,
      octImageViewSize: null,
      octSessionSendImage: null,
    };
  }

  const imageViewType = koffi.struct({
    bytes: "uint8_t *",
    n_bytes: "size_t",
    mime: "uint32_t",
    _reserved0: "uint32_t",
  });

  return {
    eventType,
    imageViewType,
    octImageViewSize: () => koffi.sizeof(imageViewType),
    octSessionSendImage:
      opts.sendImageImpl ??
      ((_session, _view) => {
        // OCT_STATUS_UNSUPPORTED — matches the runtime stub posture.
        return 2;
      }),
  };
}

function makeFakeRuntime(opts: {
  bindings: FakeBindings;
  supportsImage: boolean;
}): {
  runtime: NativeRuntime;
  detachCalled: boolean;
} {
  const state = { detachCalled: false };

  const fakeRuntime = {
    bindings: opts.bindings,
    supports: (cap: string): boolean => {
      if (cap === RuntimeCapability.EmbeddingsImage) return opts.supportsImage;
      return false;
    },
    _detachSession: () => {
      state.detachCalled = true;
    },
  } as unknown as NativeRuntime;

  return {
    runtime: fakeRuntime,
    get detachCalled() {
      return state.detachCalled;
    },
  };
}

// ── 4. Minor-10 runtime — no symbol resolution, no surprise errors ───────

describe("NativeSession with minor-10 runtime", () => {
  it("session can be constructed and image fields stay null", () => {
    const bindings = makeFakeBindings({ minor: 10 });
    const { runtime } = makeFakeRuntime({ bindings, supportsImage: false });

    const session = new NativeSession(
      runtime,
      /* handle */ {},
      RuntimeCapability.AudioTranscription,
    );
    expect(session).toBeInstanceOf(NativeSession);

    // The optional fields stay null on a minor-10 runtime.
    expect(bindings.octSessionSendImage).toBeNull();
    expect(bindings.imageViewType).toBeNull();
  });

  it("sendImage on a minor-10 runtime throws NativeRuntimeError", () => {
    const bindings = makeFakeBindings({ minor: 10 });
    const { runtime } = makeFakeRuntime({ bindings, supportsImage: false });

    const session = new NativeSession(
      runtime,
      {},
      RuntimeCapability.AudioTranscription,
    );

    // Capability gate fires first when minor=10 AND no capability advertised.
    expect(() =>
      session.sendImage({
        bytes: new Uint8Array([1, 2, 3]),
        mime: OCT_IMAGE_MIME_PNG,
      }),
    ).toThrow(NativeRuntimeError);
  });
});

// ── 5. Minor-11 runtime but capability NOT advertised ────────────────────

describe("NativeSession with minor-11 runtime, no capability", () => {
  it("sendImage throws NativeRuntimeError carrying the capability name", () => {
    const bindings = makeFakeBindings({ minor: 11 });
    const { runtime } = makeFakeRuntime({ bindings, supportsImage: false });

    const session = new NativeSession(
      runtime,
      {},
      RuntimeCapability.EmbeddingsImage,
    );

    let caught: unknown;
    try {
      session.sendImage({
        bytes: new Uint8Array([1, 2, 3]),
        mime: OCT_IMAGE_MIME_PNG,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NativeRuntimeError);
    const err = caught as NativeRuntimeError;
    expect(err.code).toBe("RUNTIME_UNAVAILABLE");
    expect(err.message).toContain(RuntimeCapability.EmbeddingsImage);
  });
});

// ── 6. Minor-11 + capability advertised — surface routes to native call ──

describe("NativeSession with minor-11 runtime + capability advertised", () => {
  it("sendImage rejects empty bytes with INVALID_INPUT before touching FFI", () => {
    const bindings = makeFakeBindings({ minor: 11 });
    const { runtime } = makeFakeRuntime({ bindings, supportsImage: true });

    const session = new NativeSession(
      runtime,
      {},
      RuntimeCapability.EmbeddingsImage,
    );

    expect(() =>
      session.sendImage({ bytes: new Uint8Array(), mime: OCT_IMAGE_MIME_PNG }),
    ).toThrow(/non-empty Uint8Array/);
  });

  it("sendImage rejects unrecognized mime values with INVALID_INPUT", () => {
    const bindings = makeFakeBindings({ minor: 11 });
    const { runtime } = makeFakeRuntime({ bindings, supportsImage: true });

    const session = new NativeSession(
      runtime,
      {},
      RuntimeCapability.EmbeddingsImage,
    );

    // 99 is not in {PNG, JPEG, WEBP, RGB8}.
    expect(() =>
      session.sendImage({ bytes: new Uint8Array([1]), mime: 99 }),
    ).toThrow(/OCT_IMAGE_MIME_\*/);

    // UNKNOWN (sentinel) is also rejected — callers MUST send a known mime.
    expect(() =>
      session.sendImage({
        bytes: new Uint8Array([1]),
        mime: OCT_IMAGE_MIME_UNKNOWN,
      }),
    ).toThrow(/OCT_IMAGE_MIME_\*/);
  });

  it("sendImage forwards valid views and surfaces OCT_STATUS_UNSUPPORTED", () => {
    // Today's runtime stub returns OCT_STATUS_UNSUPPORTED (2) on every
    // call. The SDK must surface that as a RUNTIME_UNAVAILABLE error.
    // This test pins the failure mode so the day-of flip (adapter landing,
    // status 0 returned) is visible as a change.
    let sawCall = false;
    const bindings = makeFakeBindings({
      minor: 11,
      sendImageImpl: (_s, view) => {
        sawCall = true;
        // Sanity: the binding receives the encoded view.
        expect(view.mime).toBe(OCT_IMAGE_MIME_JPEG);
        return 2; // OCT_STATUS_UNSUPPORTED
      },
    });
    // The throwStatus path will call octLastThreadError; stub it to avoid
    // koffi-side dereferencing of a non-existent symbol.
    const stubBindings = bindings as unknown as {
      octLastThreadError?: (buf: Buffer, len: number) => number;
      octRuntimeLastError?: (
        runtime: unknown,
        buf: Buffer,
        len: number,
      ) => number;
    };
    stubBindings.octLastThreadError = () => 0;
    stubBindings.octRuntimeLastError = () => 0;

    const { runtime } = makeFakeRuntime({ bindings, supportsImage: true });

    const session = new NativeSession(
      runtime,
      {},
      RuntimeCapability.EmbeddingsImage,
    );

    expect(() =>
      session.sendImage({
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
        mime: OCT_IMAGE_MIME_JPEG,
      }),
    ).toThrow(NativeRuntimeError);
    expect(sawCall).toBe(true);
  });

  it("RGB8 is an accepted mime — raw decoded pixel path", () => {
    const bindings = makeFakeBindings({
      minor: 11,
      sendImageImpl: (_s, view) => {
        expect(view.mime).toBe(OCT_IMAGE_MIME_RGB8);
        return 2;
      },
    });
    const stubBindings = bindings as unknown as {
      octLastThreadError?: (buf: Buffer, len: number) => number;
      octRuntimeLastError?: (
        runtime: unknown,
        buf: Buffer,
        len: number,
      ) => number;
    };
    stubBindings.octLastThreadError = () => 0;
    stubBindings.octRuntimeLastError = () => 0;
    const { runtime } = makeFakeRuntime({ bindings, supportsImage: true });
    const session = new NativeSession(
      runtime,
      {},
      RuntimeCapability.EmbeddingsImage,
    );
    expect(() =>
      session.sendImage({
        bytes: new Uint8Array(224 * 224 * 3),
        mime: OCT_IMAGE_MIME_RGB8,
      }),
    ).toThrow(NativeRuntimeError);
  });
});
