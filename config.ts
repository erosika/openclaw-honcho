/**
 * Configuration schema and parsing for the Honcho memory plugin.
 */

export type HonchoConfig = {
  apiKey?: string;
  workspaceId: string;
  baseUrl: string;

  // Three-layer identity
  alignmentQueries?: string[];
  representationQuery?: string;
  maxConclusions?: number;
  searchTopK?: number;
  values?: string;
  principles?: string[];
  roleName?: string;

  // Safety & scanning
  enableSafetyFilter?: boolean;
  enableOutboundScanning?: boolean;

  // Dream triggers
  dreamAfterConversations?: number;
};

/**
 * Resolve environment variable references in config values.
 * Supports ${ENV_VAR} syntax.
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

export const honchoConfigSchema = {
  parse(value: unknown): HonchoConfig {
    const cfg = (value ?? {}) as Record<string, unknown>;

    // Resolve API key with env var fallback
    let apiKey: string | undefined;
    if (typeof cfg.apiKey === "string" && cfg.apiKey.length > 0) {
      apiKey = resolveEnvVars(cfg.apiKey);
    } else {
      apiKey = process.env.HONCHO_API_KEY;
    }

    // Parse array fields from config or env
    const alignmentQueries = parseStringArray(cfg.alignmentQueries)
      ?? parseEnvArray("HONCHO_ALIGNMENT_QUERIES");
    const principles = parseStringArray(cfg.principles)
      ?? parseEnvArray("HONCHO_PRINCIPLES");

    return {
      apiKey,
      workspaceId:
        typeof cfg.workspaceId === "string" && cfg.workspaceId.length > 0
          ? cfg.workspaceId
          : process.env.HONCHO_WORKSPACE_ID ?? "openclaw",
      baseUrl:
        typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0
          ? cfg.baseUrl
          : process.env.HONCHO_BASE_URL ?? "https://api.honcho.dev",

      // Identity
      alignmentQueries,
      representationQuery:
        typeof cfg.representationQuery === "string" ? cfg.representationQuery
          : process.env.HONCHO_REPRESENTATION_QUERY ?? undefined,
      maxConclusions:
        typeof cfg.maxConclusions === "number" ? cfg.maxConclusions : undefined,
      searchTopK:
        typeof cfg.searchTopK === "number" ? cfg.searchTopK : undefined,
      values:
        typeof cfg.values === "string" ? cfg.values
          : process.env.HONCHO_VALUES ?? undefined,
      principles,
      roleName:
        typeof cfg.roleName === "string" ? cfg.roleName
          : process.env.HONCHO_ROLE_NAME ?? undefined,

      // Safety
      enableSafetyFilter: cfg.enableSafetyFilter === true
        || process.env.HONCHO_SAFETY_FILTER === "true",
      enableOutboundScanning: cfg.enableOutboundScanning === true
        || process.env.HONCHO_OUTBOUND_SCANNING === "true",

      // Dreams
      dreamAfterConversations:
        typeof cfg.dreamAfterConversations === "number" ? cfg.dreamAfterConversations
          : process.env.HONCHO_DREAM_AFTER ? parseInt(process.env.HONCHO_DREAM_AFTER, 10)
          : undefined,
    };
  },
};

/** Parse a value that might be a string array or undefined. */
function parseStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return undefined;
}

/** Parse a pipe-delimited env var into a string array. */
function parseEnvArray(envVar: string): string[] | undefined {
  const raw = process.env[envVar];
  if (!raw) return undefined;
  return raw.split("|").map((s) => s.trim()).filter(Boolean);
}
