# Node SDK Bloat Reduction Track

Reviewer: @tai

## Goal

Keep the published Node SDK aligned with current contracts and reduce duplicated client logic shared with the browser SDK.

## Findings

- Generated contract metadata and conformance workflow pins are stale relative to the current contract.
- `contract-manifest.json` reports an older contract version than generated source metadata.
- Some `dist` generated files are stale relative to source.
- Large client modules such as responses, facade, control, chat, telemetry, server API, planner, and routing have forked from the browser SDK.
- `pnpm lint` exists but eslint config/dependencies are not complete.
- Normal CI does not appear to run the full typecheck/test/build path.

## Proposed Cleanup

- Regenerate Node contract types from the current contract and update workflow pins.
- Rebuild `dist` and add a package dry-run or generated-dist parity check.
- Extract shared SDK logic or generate it from one source where Node and browser behavior should match.
- Repair lint configuration or remove the script until it is real.
- Add normal CI for typecheck, tests, build, and exports checks.

## Validation

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm run exports:check
pnpm run lint
npm pack --dry-run --json
```
