import { describe, it, expect } from "vitest";
import { OctomilError } from "../src/types.js";
import type { OctomilErrorCode } from "../src/types.js";

describe("OctomilError", () => {
  describe("constructor", () => {
    it("sets name to OctomilError", () => {
      const err = new OctomilError("UNKNOWN", "test");
      expect(err.name).toBe("OctomilError");
    });

    it("sets message and code", () => {
      const err = new OctomilError("INFERENCE_FAILED", "something broke");
      expect(err.message).toBe("something broke");
      expect(err.code).toBe("INFERENCE_FAILED");
    });

    it("sets optional cause", () => {
      const cause = new TypeError("bad type");
      const err = new OctomilError("UNKNOWN", "wrapped", cause);
      expect(err.cause).toBe(cause);
    });

    it("is an instance of Error", () => {
      const err = new OctomilError("UNKNOWN", "test");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("canonical error codes", () => {
    const canonicalCodes: OctomilErrorCode[] = [
      "MODEL_NOT_FOUND",
      "MODEL_LOAD_FAILED",
      "MODEL_DISABLED",
      "INFERENCE_FAILED",
      "NETWORK_UNAVAILABLE",
      "INVALID_INPUT",
      "INVALID_API_KEY",
      "AUTHENTICATION_FAILED",
      "FORBIDDEN",
      "REQUEST_TIMEOUT",
      "RATE_LIMITED",
      "SERVER_ERROR",
      "DOWNLOAD_FAILED",
      "CHECKSUM_MISMATCH",
      "INSUFFICIENT_STORAGE",
      "INSUFFICIENT_MEMORY",
      "RUNTIME_UNAVAILABLE",
      "CANCELLED",
      "UNKNOWN",
    ];

    it("accepts all 19 canonical error codes", () => {
      for (const code of canonicalCodes) {
        const err = new OctomilError(code, `test ${code}`);
        expect(err.code).toBe(code);
      }
    });

  });

  describe("retryable", () => {
    const retryableCodes: OctomilErrorCode[] = [
      "NETWORK_UNAVAILABLE",
      "REQUEST_TIMEOUT",
      "SERVER_ERROR",
      "DOWNLOAD_FAILED",
      "CHECKSUM_MISMATCH",
      "MODEL_LOAD_FAILED",
      "INFERENCE_FAILED",
      "RATE_LIMITED",
    ];

    for (const code of retryableCodes) {
      it(`${code} is retryable`, () => {
        const err = new OctomilError(code, "test");
        expect(err.retryable).toBe(true);
      });
    }

    const nonRetryableCodes: OctomilErrorCode[] = [
      "MODEL_NOT_FOUND",
      "MODEL_DISABLED",
      "INVALID_INPUT",
      "INVALID_API_KEY",
      "AUTHENTICATION_FAILED",
      "FORBIDDEN",
      "INSUFFICIENT_STORAGE",
      "INSUFFICIENT_MEMORY",
      "RUNTIME_UNAVAILABLE",
      "CANCELLED",
      "UNKNOWN",
    ];

    for (const code of nonRetryableCodes) {
      it(`${code} is NOT retryable`, () => {
        const err = new OctomilError(code, "test");
        expect(err.retryable).toBe(false);
      });
    }
  });

  describe("fromHttpStatus", () => {
    it("maps 400 to INVALID_INPUT", () => {
      const err = OctomilError.fromHttpStatus(400);
      expect(err.code).toBe("INVALID_INPUT");
    });

    it("maps 401 to AUTHENTICATION_FAILED", () => {
      const err = OctomilError.fromHttpStatus(401);
      expect(err.code).toBe("AUTHENTICATION_FAILED");
      expect(err.message).toBe("HTTP 401");
    });

    it("maps 403 to FORBIDDEN", () => {
      const err = OctomilError.fromHttpStatus(403, "Access denied");
      expect(err.code).toBe("FORBIDDEN");
      expect(err.message).toBe("Access denied");
    });

    it("maps 404 to MODEL_NOT_FOUND", () => {
      const err = OctomilError.fromHttpStatus(404);
      expect(err.code).toBe("MODEL_NOT_FOUND");
    });

    it("maps 429 to RATE_LIMITED", () => {
      const err = OctomilError.fromHttpStatus(429);
      expect(err.code).toBe("RATE_LIMITED");
    });

    it("maps 500 to SERVER_ERROR", () => {
      const err = OctomilError.fromHttpStatus(500);
      expect(err.code).toBe("SERVER_ERROR");
    });

    it("maps 502 to SERVER_ERROR", () => {
      const err = OctomilError.fromHttpStatus(502);
      expect(err.code).toBe("SERVER_ERROR");
    });

    it("maps 503 to SERVER_ERROR", () => {
      const err = OctomilError.fromHttpStatus(503, "Service Unavailable");
      expect(err.code).toBe("SERVER_ERROR");
      expect(err.message).toBe("Service Unavailable");
    });

    it("maps unknown 4xx status to UNKNOWN", () => {
      const err = OctomilError.fromHttpStatus(418);
      expect(err.code).toBe("UNKNOWN");
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
      expect(OctomilError.fromHttpStatus(429).retryable).toBe(true);   // RATE_LIMITED
      expect(OctomilError.fromHttpStatus(500).retryable).toBe(true);   // SERVER_ERROR
      expect(OctomilError.fromHttpStatus(401).retryable).toBe(false);  // AUTHENTICATION_FAILED
      expect(OctomilError.fromHttpStatus(403).retryable).toBe(false);  // FORBIDDEN
      expect(OctomilError.fromHttpStatus(404).retryable).toBe(false);  // MODEL_NOT_FOUND
    });
  });

  describe("fromServerResponse", () => {
    it("maps server code field to SDK error code", () => {
      const err = OctomilError.fromServerResponse(400, {
        code: "rate_limited",
        message: "Too many requests",
      });
      expect(err.code).toBe("RATE_LIMITED");
      expect(err.message).toBe("Too many requests");
    });

    it("falls back to HTTP status when code is absent", () => {
      const err = OctomilError.fromServerResponse(404, {
        message: "Not found",
      });
      expect(err.code).toBe("MODEL_NOT_FOUND");
      expect(err.message).toBe("Not found");
    });

    it("falls back to HTTP status when code is unrecognized", () => {
      const err = OctomilError.fromServerResponse(500, {
        code: "something_unknown",
        message: "Oops",
      });
      expect(err.code).toBe("SERVER_ERROR");
      expect(err.message).toBe("Oops");
    });

    it("uses error field as fallback message", () => {
      const err = OctomilError.fromServerResponse(403, {
        error: "Forbidden zone",
      });
      expect(err.code).toBe("FORBIDDEN");
      expect(err.message).toBe("Forbidden zone");
    });

    it("uses HTTP status as message when body is null", () => {
      const err = OctomilError.fromServerResponse(500, null);
      expect(err.code).toBe("SERVER_ERROR");
      expect(err.message).toBe("HTTP 500");
    });
  });
});
