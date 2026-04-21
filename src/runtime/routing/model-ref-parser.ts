/**
 * Model reference parser.
 *
 * Parses the various model reference formats used in the Octomil SDK:
 *   - `@app/<slug>/<cap>`         -> kind "app"
 *   - `@capability/<cap>`         -> kind "capability"
 *   - `deploy_<id>`               -> kind "deployment"
 *   - `exp/<id>` or `<exp>/<var>` -> kind "experiment" (with variant)
 *   - plain string                -> kind "model" (bare model ID)
 *
 * The server resolves these; the SDK just classifies the ref and passes it
 * through. The parsed `kind` feeds into RouteMetadata.model.requested.kind.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelRefKind =
  | "app"
  | "capability"
  | "deployment"
  | "experiment"
  | "model";

export interface ParsedModelRef {
  /** Original string as passed by the caller. */
  raw: string;
  /** Classification of the reference. */
  kind: ModelRefKind;
  /** For app refs: the app slug. */
  appSlug?: string;
  /** For app/capability refs: the capability string. */
  capability?: string;
  /** For deployment refs: the deployment ID. */
  deploymentId?: string;
  /** For experiment refs: the experiment ID. */
  experimentId?: string;
  /** For experiment refs: the variant ID. */
  variantId?: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const APP_REF_RE = /^@app\/([^/]+)\/([^/]+)$/;
const CAPABILITY_REF_RE = /^@capability\/([^/]+)$/;
const DEPLOY_REF_RE = /^deploy_(.+)$/;
const EXPERIMENT_REF_RE = /^exp[_/]([^/]+)(?:\/(.+))?$/;

/**
 * Parse a model string into a structured reference.
 *
 * Does NOT validate whether the ref resolves to an actual model.
 * That is the server's job. The SDK only classifies the format so
 * route metadata can record the `kind` field.
 */
export function parseModelRef(model: string): ParsedModelRef {
  const trimmed = model.trim();

  // @app/slug/capability
  const appMatch = APP_REF_RE.exec(trimmed);
  if (appMatch) {
    return {
      raw: trimmed,
      kind: "app",
      appSlug: appMatch[1],
      capability: appMatch[2],
    };
  }

  // @capability/cap
  const capMatch = CAPABILITY_REF_RE.exec(trimmed);
  if (capMatch) {
    return {
      raw: trimmed,
      kind: "capability",
      capability: capMatch[1],
    };
  }

  // deploy_xxx
  const deployMatch = DEPLOY_REF_RE.exec(trimmed);
  if (deployMatch) {
    return {
      raw: trimmed,
      kind: "deployment",
      deploymentId: deployMatch[1],
    };
  }

  // exp/id or exp/id/variant — also handles exp_id/variant
  const expMatch = EXPERIMENT_REF_RE.exec(trimmed);
  if (expMatch) {
    return {
      raw: trimmed,
      kind: "experiment",
      experimentId: expMatch[1],
      variantId: expMatch[2],
    };
  }

  // Also catch "exp_id/variant" pattern from fixtures (e.g. "exp_test_001/variant_a")
  if (trimmed.includes("/") && !trimmed.startsWith("@")) {
    const [first, ...rest] = trimmed.split("/");
    if (first && rest.length > 0) {
      return {
        raw: trimmed,
        kind: "experiment",
        experimentId: first,
        variantId: rest.join("/"),
      };
    }
  }

  // Bare model ID
  return {
    raw: trimmed,
    kind: "model",
  };
}
