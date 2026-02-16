/**
 * Outbound message scanning for safety and PII detection.
 *
 * Scans agent responses before they're sent to users in public channels.
 * Configurable pattern matching with severity levels.
 */

// ============================================================================
// Types
// ============================================================================

export type ScanPattern = {
  name: string;
  pattern: RegExp;
  severity: "block" | "warn";
};

export type ScanResult = {
  safe: boolean;
  findings: Array<{
    pattern: string;
    match: string;
    severity: "block" | "warn";
  }>;
};

// ============================================================================
// Default Patterns
// ============================================================================

/**
 * Default outbound scanning patterns.
 * Block = message should not be sent. Warn = log but allow.
 */
export const DEFAULT_SCAN_PATTERNS: ScanPattern[] = [
  // Block: secrets and credentials
  { name: "api-key", pattern: /\b(?:sk|hc|pk|ak|rk)[-_][a-zA-Z0-9]{20,}\b/, severity: "block" },
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, severity: "block" },
  { name: "env-secret", pattern: /(?:API_KEY|SECRET|TOKEN|PASSWORD)\s*=\s*\S+/i, severity: "block" },
  { name: "bearer-token", pattern: /Bearer\s+[a-zA-Z0-9._~+/=-]{20,}/i, severity: "block" },

  // Block: infrastructure
  { name: "system-path", pattern: /(?:\/Users\/|\/home\/)\w+\//, severity: "block" },
  { name: "tailscale-ip", pattern: /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, severity: "block" },
  { name: "tailscale-dns", pattern: /\b\w+\.tailnet[\w.-]*/, severity: "block" },
  { name: "internal-port", pattern: /\blocalhost:\d{2,5}\b/, severity: "block" },
  { name: "internal-dns", pattern: /\b\w+\.(?:internal|local)\b/, severity: "warn" },

  // Warn: PII (not blocked -- could be intentional sharing)
  { name: "email", pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/, severity: "warn" },
  { name: "phone", pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, severity: "warn" },

  // Block: high-severity PII
  { name: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/, severity: "block" },
];

// ============================================================================
// Scanner
// ============================================================================

/**
 * Strip fenced code blocks from text before scanning.
 * Code examples like `export API_KEY=your_key` are legitimate and should not
 * trigger false positives. Inline backtick code is also stripped.
 */
export function stripCodeBlocks(text: string): string {
  // Remove fenced code blocks (```...```)
  let stripped = text.replace(/```[\s\S]*?```/g, "");
  // Remove inline code (`...`)
  stripped = stripped.replace(/`[^`]+`/g, "");
  return stripped;
}

/**
 * Scan text for unsafe patterns.
 *
 * Returns a result with `safe: false` if any "block" pattern matches.
 * "warn" findings are included but don't make the result unsafe.
 *
 * Code blocks (fenced and inline) are excluded from scanning to prevent
 * false positives on code examples.
 */
export function scanOutbound(
  text: string,
  patterns: ScanPattern[] = DEFAULT_SCAN_PATTERNS,
): ScanResult {
  const findings: ScanResult["findings"] = [];

  // Strip code blocks -- code examples are not real secrets
  const scannable = stripCodeBlocks(text);

  for (const { name, pattern, severity } of patterns) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    const matches = scannable.matchAll(new RegExp(pattern, "g"));
    for (const match of matches) {
      findings.push({
        pattern: name,
        match: match[0].length > 20 ? match[0].slice(0, 20) + "..." : match[0],
        severity,
      });
    }
  }

  const hasBlocker = findings.some((f) => f.severity === "block");

  return { safe: !hasBlocker, findings };
}

/**
 * Redact matched patterns from text.
 * Replaces matches with [REDACTED] markers.
 */
export function redactOutbound(
  text: string,
  patterns: ScanPattern[] = DEFAULT_SCAN_PATTERNS,
): string {
  let redacted = text;
  for (const { pattern } of patterns) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(new RegExp(pattern, "g"), "[REDACTED]");
  }
  return redacted;
}
