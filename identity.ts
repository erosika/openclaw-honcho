/**
 * Three-layer identity injection for OpenClaw agents.
 *
 * Identity loading is three-layered:
 *   Layer 1 (Foundation): Peer card -- curated by the owner, stable, never degrades
 *   Layer 2 (Deep alignment): peer.chat() -- synthesized from ALL conclusions,
 *     scoped by question, never truncated by maxConclusions
 *   Layer 3 (Recent context): representation with searchQuery -- ephemeral,
 *     supplementary, role-scoped
 *
 * Not all conclusions should be communicated. Layer 1 is explicitly curated.
 * Layer 2 is scoped by what we ask. Layer 3 uses semantic search to filter.
 */

import type { Peer } from "@honcho-ai/sdk";

// ============================================================================
// Types
// ============================================================================

export type IdentityConfig = {
  /** Dialectic questions asked via peer.chat() for Layer 2 alignment. */
  alignmentQueries?: string[];
  /** Semantic search query for Layer 3 recent context. */
  representationQuery?: string;
  /** Max conclusions for Layer 3 representation. Default: 20. */
  maxConclusions?: number;
  /** Top-K for Layer 3 semantic search. Default: 15. */
  searchTopK?: number;
  /** Patterns that indicate internal/operational context to strip from Layer 3. */
  safetyPatterns?: RegExp[];
  /** Operating principles injected after the identity layers. */
  principles?: string[];
  /** Values line. Default: none. */
  values?: string;
  /** Role name for the system prompt header. Default: "agent". */
  roleName?: string;
};

export type IdentityContext = {
  peerCard: string[] | null;
  alignmentResponses: string[];
  representation: string | null;
  systemPrompt: string;
};

// ============================================================================
// Default Safety Patterns
// ============================================================================

/**
 * Default patterns for stripping operational/internal context.
 * These prevent infrastructure details from leaking into public-facing contexts.
 * Users can extend or replace these via config.
 */
export const DEFAULT_SAFETY_PATTERNS: RegExp[] = [
  /\$\d+\.\d{2,}/,                          // cost figures ($0.0042)
  /budget|spending|cost.*usd|daily.*limit/i, // budget language
  /\bport\s*\d{2,5}\b/i,                    // port numbers
  /\b(?:droplet|thinkpad|raspberry|node)\b/i, // infrastructure names
  /(?:\/Users\/|\/home\/)\w+\//,             // system paths
  /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,     // Tailscale IPs
  /\b\w+\.tailnet[\w.-]*/,                   // Tailscale DNS
  /health.*(?:check|report|status)/i,        // health reports
  /error.*(?:rate|count|spike)/i,            // error metrics
  /uptime.*\d+%/i,                           // uptime percentages
  /cron|schedule.*(?:every|interval)/i,      // scheduling internals
];

// ============================================================================
// Layer Loading
// ============================================================================

/**
 * Load three-layer identity context from Honcho.
 *
 * Layer 1: peer.getCard() -- curated facts, stable anchor
 * Layer 2: peer.chat(query) per alignment query -- dialectic synthesis over ALL conclusions
 * Layer 3: peer.representation({searchQuery}) -- recent, role-scoped context
 */
export async function loadIdentityContext(
  ownerPeer: Peer,
  config: IdentityConfig = {},
): Promise<IdentityContext> {
  const {
    alignmentQueries = [],
    representationQuery,
    maxConclusions = 20,
    searchTopK = 15,
    safetyPatterns,
  } = config;

  // Layer 1: Peer card -- curated by owner, never degrades
  let peerCard: string[] | null = null;
  try {
    peerCard = await ownerPeer.getCard();
  } catch {
    // No card yet -- that's fine
  }

  // Layer 2: Deep alignment via dialectic queries
  // peer.chat() reasons over ALL conclusions -- no maxConclusions truncation
  const alignmentResponses: string[] = [];
  if (alignmentQueries.length > 0) {
    const chatResults = await Promise.allSettled(
      alignmentQueries.map((query) => ownerPeer.chat(query)),
    );
    for (const result of chatResults) {
      if (result.status === "fulfilled" && result.value) {
        alignmentResponses.push(result.value);
      }
    }
  }

  // Layer 3: Recent relevant context via semantic search
  let representation: string | null = null;
  try {
    representation = await ownerPeer.representation({
      ...(representationQuery ? { searchQuery: representationQuery, searchTopK } : {}),
      includeMostFrequent: true,
      maxConclusions,
    });
  } catch {
    // Not enough data yet
  }

  // Apply safety filter to Layer 3
  if (representation && safetyPatterns !== undefined) {
    representation = stripInternalContext(representation, safetyPatterns);
  }

  const systemPrompt = formatSystemPrompt(
    peerCard,
    alignmentResponses,
    representation,
    config,
  );

  return { peerCard, alignmentResponses, representation, systemPrompt };
}

// ============================================================================
// Safety Filter
// ============================================================================

/**
 * Strip operational/internal context from a Honcho representation.
 *
 * Filters line-by-line: any line matching a safety pattern is removed.
 * Prevents the agent from accidentally surfacing infrastructure details,
 * costs, or internal operations in public conversations.
 *
 * Pass an empty array to disable filtering. Pass undefined to skip entirely.
 */
export function stripInternalContext(
  representation: string,
  patterns: RegExp[],
): string | null {
  if (patterns.length === 0) return representation;

  const lines = representation.split("\n");
  const filtered = lines.filter(
    (line) => !patterns.some((pattern) => pattern.test(line)),
  );

  // Reset lastIndex on any global-flagged patterns
  for (const p of patterns) {
    p.lastIndex = 0;
  }

  const result = filtered.join("\n").trim();
  return result || null;
}

// ============================================================================
// System Prompt Formatting
// ============================================================================

/**
 * Format a system prompt from three-layer identity context.
 *
 * Structure:
 *   1. Role declaration
 *   2. Peer card (Layer 1 -- stable foundation)
 *   3. Deep alignment (Layer 2 -- synthesized understanding)
 *   4. Recent context (Layer 3 -- filtered representation)
 *   5. Values + operating principles
 */
export function formatSystemPrompt(
  peerCard: string[] | null,
  alignmentResponses: string[],
  representation: string | null,
  config: IdentityConfig = {},
): string {
  const { roleName = "agent", values, principles = [] } = config;
  const parts: string[] = [];

  parts.push(`You are operating as the ${roleName}.`);
  parts.push("");

  // Layer 1: Stable identity foundation
  if (peerCard && peerCard.length > 0) {
    parts.push("## Identity");
    parts.push(peerCard.map((f) => `• ${f}`).join("\n"));
    parts.push("");
  }

  // Layer 2: Deep alignment from dialectic
  if (alignmentResponses.length > 0) {
    parts.push("## Understanding");
    for (const response of alignmentResponses) {
      parts.push(response);
      parts.push("");
    }
  }

  // Layer 3: Recent relevant conclusions
  if (representation) {
    parts.push("## Recent Context");
    parts.push(representation);
    parts.push("");
  }

  // Values
  if (values) {
    parts.push("## Values");
    parts.push(values);
    parts.push("");
  }

  // Operating principles
  if (principles.length > 0) {
    parts.push("## Operating Principles");
    for (const p of principles) {
      parts.push(`- ${p}`);
    }
  }

  return parts.join("\n");
}
