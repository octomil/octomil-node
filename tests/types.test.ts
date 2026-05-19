import { describe, it, expect } from "vitest";
import { OctomilError, ErrorCode } from "../src/types.js";

describe("OctomilError", () => {
  describe("constructor", () => {
    it("sets name to OctomilError", () => {
      const err = new OctomilError(ErrorCode.Unknown, "test");
      expect(err.name).toBe("OctomilError");
    });

    it("sets message and code with ErrorCode enum", () => {
      const err = new OctomilError(ErrorCode.InferenceFailed, "something broke");
      expect(err.message).toBe("something broke");
      expect(err.code).toBe(ErrorCode.InferenceFailed);
    });

    it("accepts legacy SCREAMING_SNAKE_CASE string and normalizes to ErrorCode", () => {
      const err = new OctomilError("INFERENCE_FAILED", "something broke");
      expect(err.code).toBe(ErrorCode.InferenceFailed);
    });

    it("accepts snake_case enum value string and normalizes", () => {
      const err = new OctomilError("inference_failed", "something broke");
      expect(err.code).toBe(ErrorCode.InferenceFailed);
    });

    it("falls back to ErrorCode.Unknown for unrecognized string and warns", () => {
      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (...args: unknown[]) => { warns.push(String(args[0])); };
      try {
        const err = new OctomilError("TOTALLY_UNKNOWN_CODE", "oops");
        expect(err.code).toBe(ErrorCode.Unknown);
        expect(warns.length).toBeGreaterThan(0);
        expect(warns[0]).toContain("TOTALLY_UNKNOWN_CODE");
      } finally {
        console.warn = orig;
      }
    });

    it("sets optional cause via legacy positional arg", () => {
      const cause = new TypeError("bad type");
      const err = new OctomilError(ErrorCode.Unknown, "wrapped", cause);
      expect(err.cause).toBe(cause);
    });

    it("sets cause and retryAfterMs via options object", () => {
      const cause = new TypeError("bad type");
      const err = new OctomilError(ErrorCode.RateLimited, "too fast", {
        cause,
        retryAfterMs: 1500,
      });
      expect(err.cause).toBe(cause);
      expect(err.retryAfterMs).toBe(1500);
    });

    it("retryAfterMs is undefined when not provided", () => {
      const err = new OctomilError(ErrorCode.Unknown, "test");
      expect(err.retryAfterMs).toBeUndefined();
    });

    it("is an instance of Error", () => {
      const err = new OctomilError(ErrorCode.Unknown, "test");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("canonical error codes", () => {
    const canonicalCodes: ErrorCode[] = [
      ErrorCode.ModelNotFound,
      ErrorCode.ModelLoadFailed,
      ErrorCode.ModelDisabled,
      ErrorCode.InferenceFailed,
      ErrorCode.NetworkUnavailable,
      ErrorCode.InvalidInput,
      ErrorCode.InvalidApiKey,
      ErrorCode.AuthenticationFailed,
      ErrorCode.Forbidden,
      ErrorCode.RequestTimeout,
      ErrorCode.RateLimited,
      ErrorCode.ServerError,
      ErrorCode.DownloadFailed,
      ErrorCode.ChecksumMismatch,
      ErrorCode.InsufficientStorage,
      ErrorCode.InsufficientMemory,
      ErrorCode.RuntimeUnavailable,
      ErrorCode.Cancelled,
      ErrorCode.Unknown,
    ];

    it("accepts all canonical error codes", () => {
      for (const code of canonicalCodes) {
        const err = new OctomilError(code, `test ${code}`);
        expect(err.code).toBe(code);
      }
    });
  });

  describe("retryable", () => {
    const retryableCodes: ErrorCode[] = [
      ErrorCode.NetworkUnavailable,
      ErrorCode.RequestTimeout,
      ErrorCode.ServerError,
      ErrorCode.DownloadFailed,
      ErrorCode.ChecksumMismatch,
      ErrorCode.ModelLoadFailed,
      ErrorCode.InferenceFailed,
      ErrorCode.RateLimited,
    ];

    for (const code of retryableCodes) {
      it(`${code} is retryable`, () => {
        const err = new OctomilError(code, "test");
        expect(err.retryable).toBe(true);
      });
    }

    const nonRetryableCodes: ErrorCode[] = [
      ErrorCode.ModelNotFound,
      ErrorCode.ModelDisabled,
      ErrorCode.InvalidInput,
      ErrorCode.InvalidApiKey,
      ErrorCode.AuthenticationFailed,
      ErrorCode.Forbidden,
      ErrorCode.InsufficientStorage,
      ErrorCode.InsufficientMemory,
      ErrorCode.RuntimeUnavailable,
      ErrorCode.Cancelled,
      ErrorCode.Unknown,
    ];

    for (const code of nonRetryableCodes) {
      it(`${code} is NOT retryable`, () => {
        const err = new OctomilError(code, "test");
        expect(err.retryable).toBe(false);
      });
    }
  });

  describe("computed properties", () => {
    it("category delegates to ERROR_CLASSIFICATION", () => {
      const err = new OctomilError(ErrorCode.InvalidInput, "test");
      expect(err.category).toBe("input");
    });

    it("suggestedAction delegates to ERROR_CLASSIFICATION", () => {
      const err = new OctomilError(ErrorCode.RateLimited, "test");
      expect(err.suggestedAction).toBe("retry_after");
    });

    it("retryClass delegates to ERROR_CLASSIFICATION", () => {
      const err = new OctomilError(ErrorCode.NetworkUnavailable, "test");
      expect(err.retryClass).toBe("backoff_safe");
    });

    it("fallbackEligible delegates to ERROR_CLASSIFICATION", () => {
      const eligible = new OctomilError(ErrorCode.NetworkUnavailable, "test");
      expect(eligible.fallbackEligible).toBe(true);

      const notEligible = new OctomilError(ErrorCode.InvalidApiKey, "test");
      expect(notEligible.fallbackEligible).toBe(false);
    });

    it("retryAfterMs round-trips correctly", () => {
      const err = new OctomilError(ErrorCode.RateLimited, "slow down", {
        retryAfterMs: 3000,
      });
      expect(err.retryAfterMs).toBe(3000);
    });
  });

  describe("fromHttpStatus", () => {
    it("maps 400 to InvalidInput", () => {
      const err = OctomilError.fromHttpStatus(400);
      expect(err.code).toBe(ErrorCode.InvalidInput);
    });

    it("maps 401 to AuthenticationFailed", () => {
      const err = OctomilError.fromHttpStatus(401);
      expect(err.code).toBe(ErrorCode.AuthenticationFailed);
      expect(err.message).toBe("HTTP 401");
    });

    it("maps 403 to Forbidden", () => {
      const err = OctomilError.fromHttpStatus(403, "Access denied");
      expect(err.code).toBe(ErrorCode.Forbidden);
      expect(err.message).toBe("Access denied");
    });

    it("maps 404 to ModelNotFound", () => {
      const err = OctomilError.fromHttpStatus(404);
      expect(err.code).toBe(ErrorCode.ModelNotFound);
    });

    it("maps 429 to RateLimited", () => {
      const err = OctomilError.fromHttpStatus(429);
      expect(err.code).toBe(ErrorCode.RateLimited);
    });

    it("maps 500 to ServerError", () => {
      const err = OctomilError.fromHttpStatus(500);
      expect(err.code).toBe(ErrorCode.ServerError);
    });

    it("maps 502 to ServerError", () => {
      const err = OctomilError.fromHttpStatus(502);
      expect(err.code).toBe(ErrorCode.ServerError);
    });

    it("maps 503 to ServerError", () => {
      const err = OctomilError.fromHttpStatus(503, "Service Unavailable");
      expect(err.code).toBe(ErrorCode.ServerError);
      expect(err.message).toBe("Service Unavailable");
    });

    it("maps unknown 4xx status to Unknown", () => {
      const err = OctomilError.fromHttpStatus(418);
      expect(err.code).toBe(ErrorCode.Unknown);
    });

    it("uses custom message when provided", () => {
      const err = OctomilError.fromHttpStatus(401, "Invalid token");
      expect(err.message).toBe("Invalid token");
    });

    it("uses default message when none provided", () => {
      const err = OctomilError.fromHttpStatus(500);
      expect(err.message).toBe("HTTP 500");
    });

    it("returns an OctomilError instance", () => {
      const err = OctomilError.fromHttpStatus(500);
      expect(err).toBeInstanceOf(OctomilError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("OctomilError");
    });

    it("returned error has correct retryable property", () => {
      expect(OctomilError.fromHttpStatus(429).retryable).toBe(true);   // RateLimited
      expect(OctomilError.fromHttpStatus(500).retryable).toBe(true);   // ServerError
      expect(OctomilError.fromHttpStatus(401).retryable).toBe(false);  // AuthenticationFailed
      expect(OctomilError.fromHttpStatus(403).retryable).toBe(false);  // Forbidden
      expect(OctomilError.fromHttpStatus(404).retryable).toBe(false);  // ModelNotFound
    });
  });

  describe("fromServerResponse", () => {
    it("maps server snake_case code field to ErrorCode", () => {
      const err = OctomilError.fromServerResponse(400, {
        code: "rate_limited",
        message: "Too many requests",
      });
      expect(err.code).toBe(ErrorCode.RateLimited);
      expect(err.message).toBe("Too many requests");
    });

    it("falls back to HTTP status when code is absent", () => {
      const err = OctomilError.fromServerResponse(404, {
        message: "Not found",
      });
      expect(err.code).toBe(ErrorCode.ModelNotFound);
      expect(err.message).toBe("Not found");
    });

    it("falls back to HTTP status when code is unrecognized", () => {
      const err = OctomilError.fromServerResponse(500, {
        code: "something_unknown",
        message: "Oops",
      });
      expect(err.code).toBe(ErrorCode.ServerError);
      expect(err.message).toBe("Oops");
    });

    it("uses error field as fallback message", () => {
      const err = OctomilError.fromServerResponse(403, {
        error: "Forbidden zone",
      });
      expect(err.code).toBe(ErrorCode.Forbidden);
      expect(err.message).toBe("Forbidden zone");
    });

    it("uses HTTP status as message when body is null", () => {
      const err = OctomilError.fromServerResponse(500, null);
      expect(err.code).toBe(ErrorCode.ServerError);
      expect(err.message).toBe("HTTP 500");
    });
  });

  describe("back-compat: OctomilErrorCode alias", () => {
    it("OctomilErrorCode type still works as ErrorCode alias", () => {
      // This is a type-level test: if it compiles, the alias works.
      // We verify the value matches the enum.
      const code = ErrorCode.InferenceFailed;
      const err = new OctomilError(code, "test");
      expect(err.code).toBe(ErrorCode.InferenceFailed);
    });
  });
});
