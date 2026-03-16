import { describe, it, expect } from "vitest";
import { ModelRef } from "../src/model-ref.js";
import { ModelCapability } from "../src/_generated/model_capability.js";

describe("ModelRef", () => {
  describe("id", () => {
    it("should create an id-based reference", () => {
      const ref = ModelRef.id("phi-4-mini");
      expect(ref.type).toBe("id");
      expect(ref.id).toBe("phi-4-mini");
    });
  });

  describe("capability", () => {
    it("should create a capability-based reference", () => {
      const ref = ModelRef.capability(ModelCapability.Chat);
      expect(ref.type).toBe("capability");
      expect(ref.capability).toBe(ModelCapability.Chat);
    });

    it("should support all capabilities", () => {
      for (const cap of Object.values(ModelCapability)) {
        const ref = ModelRef.capability(cap);
        expect(ref.type).toBe("capability");
        expect(ref.capability).toBe(cap);
      }
    });
  });
});
