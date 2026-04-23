/**
 * Model reference parser.
 *
 * Parses the various model reference formats used in the Octomil SDK:
 *   - `@app/<slug>/<cap>`         -> kind "app"
 *   - `@capability/<cap>`         -> kind "capability"
 *   - `deploy_<id>`               -> kind "deployment"
 *   - `exp_<id>/<var>`            -> kind "experiment"
 *   - plain string                -> kind "model" (bare model ID)
 *
 * The server resolves these; the SDK just classifies the ref and passes it
 * through. The parsed `kind` feeds into RouteMetadata.model.requested.kind.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelRefKind =
  | "model"
  | "app"
  | "capability"
  | "deployment"
  | "experiment"
  | "alias"
  | "default"
  | "unknown";

export interface ParsedModelRef {
  /** Original string as passed by the caller. */
  raw: string;
  /** Classification of the reference. */
  kind: ModelRefKind;
  /** For bare model refs: canonical model slug. */
  modelSlug?: string;
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
const ALIAS_REF_RE = /^alias:(.+)$/;

/**
 * Parse a model string into a structured reference.
 *
 * Does NOT validate whether the ref resolves to an actual model.
 * That is the server's job. The SDK only classifies the format so
 * route metadata can record the `kind` field.
 */
export function parseModelRef(model: string): ParsedModelRef {
  const trimmed = model.trim();

  if (!trimmed) {
    return {
      raw: trimmed,
      kind: "default",
    };
  }

  if (trimmed.includes("://")) {
    return {
      raw: trimmed,
      kind: "unknown",
    };
  }

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

  if (trimmed.startsWith("deploy_") && trimmed.length > "deploy_".length) {
    return {
      raw: trimmed,
      kind: "deployment",
      deploymentId: trimmed,
    };
  }
  if (trimmed === "deploy_") {
    return {
      raw: trimmed,
      kind: "unknown",
    };
  }

  // exp_id/variant
  if (trimmed.startsWith("exp_") && trimmed.includes("/")) {
    const [experimentId, variantId] = trimmed.split("/", 2);
    if (!experimentId || !variantId) {
      return {
        raw: trimmed,
        kind: "unknown",
      };
    }
    return {
      raw: trimmed,
      kind: "experiment",
      experimentId,
      variantId,
    };
  }

  const aliasMatch = ALIAS_REF_RE.exec(trimmed);
  if (aliasMatch) {
    return {
      raw: trimmed,
      kind: aliasMatch[1] ? "alias" : "unknown",
    };
  }
  if (trimmed === "alias:") {
    return {
      raw: trimmed,
      kind: "unknown",
    };
  }

  if (trimmed.startsWith("@")) {
    return {
      raw: trimmed,
      kind: "unknown",
    };
  }

  // Bare model ID
  return {
    raw: trimmed,
    kind: "model",
    modelSlug: trimmed,
  };
}
