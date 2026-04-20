# SDK Parity Fixtures

Vendored from `octomil-contracts` — canonical SDK behavior matrix.

Each fixture defines a complete routing scenario: request, planner response,
expected route metadata, telemetry payload, and policy result. The contract
conformance test suite loads all fixtures in this directory and validates
the Node SDK can decode and process them correctly.

## Fixture structure

```json
{
  "description": "Human-readable scenario description",
  "request": { "model": "...", "capability": "...", "routing_policy": "..." },
  "planner_response": { "model": "...", "candidates": [...], "fallback_allowed": bool },
  "expected_route_metadata": { "status": "...", "execution": {...}, "attempts": [...], "fallback": {...} },
  "expected_telemetry": { "route_id": "...", ... },
  "expected_policy_result": { "cloud_allowed": bool, "fallback_allowed": bool },
  "rules_tested": [...]
}
```

## Updating

When the contract schema changes in `octomil-contracts`, re-vendor these files.
Do not edit them directly — they represent the canonical behavior expected across
all SDK platforms.
