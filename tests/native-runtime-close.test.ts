import { describe, expect, it, vi } from "vitest";

import {
  NativeModel,
  NativeRuntime,
  NativeRuntimeError,
  OCT_STATUS_BUSY,
  OCT_STATUS_OK,
} from "../src/runtime/native/loader.js";

function makeRuntime(modelCloseStatus: number) {
  const bindings = {
    octRuntimeClose: vi.fn(),
    octModelClose: vi.fn().mockReturnValue(modelCloseStatus),
    lib: { unload: vi.fn() },
  };
  const runtime = new (NativeRuntime as any)(bindings, {}) as NativeRuntime;
  const model = new NativeModel(runtime, {});
  (runtime as any).models.add(model);
  return { runtime, bindings };
}

describe("NativeRuntime.close", () => {
  it("does not tear down the runtime while a model is busy", () => {
    const { runtime, bindings } = makeRuntime(OCT_STATUS_BUSY);
    expect(() => runtime.close()).toThrow(NativeRuntimeError);
    expect(bindings.octRuntimeClose).not.toHaveBeenCalled();
    expect(bindings.lib.unload).not.toHaveBeenCalled();
  });

  it("tears down once models close cleanly", () => {
    const { runtime, bindings } = makeRuntime(OCT_STATUS_OK);
    runtime.close();
    expect(bindings.octRuntimeClose).toHaveBeenCalledOnce();
    expect(bindings.lib.unload).toHaveBeenCalledOnce();
  });

  it("marks the runtime closed even if octRuntimeClose throws", () => {
    const { runtime, bindings } = makeRuntime(OCT_STATUS_OK);
    bindings.octRuntimeClose.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => runtime.close()).toThrow("boom");
    expect(bindings.lib.unload).toHaveBeenCalledOnce();
    expect(() => runtime.close()).not.toThrow();
  });
});
