import { describe, it, expect, vi, beforeEach } from "vitest";
import { CapabilitiesClient } from "../src/capabilities.js";

// We can't spyOn node:os because its exports are non-configurable.
// Instead, mock the module and control the return values.
const mockTotalmem = vi.fn();
const mockFreemem = vi.fn();
const mockPlatform = vi.fn();

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    totalmem: (...args: unknown[]) => mockTotalmem(...args) as number,
    freemem: (...args: unknown[]) => mockFreemem(...args) as number,
    platform: (...args: unknown[]) => mockPlatform(...args) as string,
  };
});

describe("CapabilitiesClient", () => {
  let client: CapabilitiesClient;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mocks — roughly mimic a 16GB macOS machine
    mockTotalmem.mockReturnValue(17_179_869_184); // 16GB
    mockFreemem.mockReturnValue(8_589_934_592);   // 8GB free
    mockPlatform.mockReturnValue("darwin");
    client = new CapabilitiesClient();
  });

  it("returns a CapabilityProfile with expected fields", () => {
    const profile = client.current();

    expect(profile).toHaveProperty("deviceClass");
    expect(profile).toHaveProperty("availableRuntimes");
    expect(profile).toHaveProperty("memoryMb");
    expect(profile).toHaveProperty("storageMb");
    expect(profile).toHaveProperty("platform");
    expect(profile).toHaveProperty("accelerators");
  });

  it("always includes onnx in availableRuntimes", () => {
    const profile = client.current();
    expect(profile.availableRuntimes).toContain("onnx");
  });

  it("returns a valid deviceClass", () => {
    const profile = client.current();
    expect(["flagship", "high", "mid", "low"]).toContain(profile.deviceClass);
  });

  it("maps darwin platform to macos", () => {
    mockPlatform.mockReturnValue("darwin");
    const profile = client.current();
    expect(profile.platform).toBe("macos");
  });

  it("maps win32 platform to windows", () => {
    mockPlatform.mockReturnValue("win32");
    const profile = client.current();
    expect(profile.platform).toBe("windows");
  });

  it("maps linux platform to linux", () => {
    mockPlatform.mockReturnValue("linux");
    const profile = client.current();
    expect(profile.platform).toBe("linux");
  });

  it("reports memoryMb based on os.totalmem()", () => {
    mockTotalmem.mockReturnValue(17_179_869_184); // 16GB
    const profile = client.current();
    expect(profile.memoryMb).toBe(16384);
  });

  it("reports storageMb based on os.freemem()", () => {
    mockFreemem.mockReturnValue(4_294_967_296); // 4GB
    const profile = client.current();
    expect(profile.storageMb).toBe(4096);
  });

  it("accelerators is an array", () => {
    const profile = client.current();
    expect(Array.isArray(profile.accelerators)).toBe(true);
  });

  describe("deviceClass classification", () => {
    it("classifies flagship for >= 32GB", () => {
      mockTotalmem.mockReturnValue(34_359_738_368); // 32GB
      const profile = new CapabilitiesClient().current();
      expect(profile.deviceClass).toBe("flagship");
    });

    it("classifies high for >= 16GB, < 32GB", () => {
      mockTotalmem.mockReturnValue(17_179_869_184); // 16GB
      const profile = new CapabilitiesClient().current();
      expect(profile.deviceClass).toBe("high");
    });

    it("classifies mid for >= 8GB, < 16GB", () => {
      mockTotalmem.mockReturnValue(8_589_934_592); // 8GB
      const profile = new CapabilitiesClient().current();
      expect(profile.deviceClass).toBe("mid");
    });

    it("classifies low for < 8GB", () => {
      mockTotalmem.mockReturnValue(4_294_967_296); // 4GB
      const profile = new CapabilitiesClient().current();
      expect(profile.deviceClass).toBe("low");
    });
  });
});
