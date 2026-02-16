import { describe, it, expect } from "vitest";
import {
  scanOutbound,
  redactOutbound,
  stripCodeBlocks,
  DEFAULT_SCAN_PATTERNS,
} from "../scanning.js";

// ============================================================================
// stripCodeBlocks
// ============================================================================

describe("stripCodeBlocks", () => {
  it("strips fenced code blocks", () => {
    const text = "Here's an example:\n```\nexport API_KEY=secret123\n```\nDone!";
    const result = stripCodeBlocks(text);
    expect(result).not.toContain("API_KEY=secret123");
    expect(result).toContain("Here's an example:");
    expect(result).toContain("Done!");
  });

  it("strips fenced code blocks with language tags", () => {
    const text = "Example:\n```bash\nexport TOKEN=abc\n```";
    const result = stripCodeBlocks(text);
    expect(result).not.toContain("TOKEN=abc");
  });

  it("strips inline code", () => {
    const text = "Set `API_KEY=your_key` in the env";
    const result = stripCodeBlocks(text);
    expect(result).not.toContain("API_KEY=your_key");
    expect(result).toContain("Set ");
    expect(result).toContain(" in the env");
  });

  it("strips multiple code blocks", () => {
    const text = "First `code1`, then:\n```\ncode2\n```\nand `code3`";
    const result = stripCodeBlocks(text);
    expect(result).not.toContain("code1");
    expect(result).not.toContain("code2");
    expect(result).not.toContain("code3");
  });

  it("preserves text without code blocks", () => {
    const text = "No code here, just plain text.";
    expect(stripCodeBlocks(text)).toBe(text);
  });

  it("handles empty string", () => {
    expect(stripCodeBlocks("")).toBe("");
  });
});

// ============================================================================
// scanOutbound
// ============================================================================

describe("scanOutbound", () => {
  it("passes clean text", () => {
    const result = scanOutbound("Hello! How can I help you today?");
    expect(result.safe).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("blocks API keys", () => {
    const result = scanOutbound("Here's the key: sk-abc123def456ghi789jkl012mno345");
    expect(result.safe).toBe(false);
    expect(result.findings[0].pattern).toBe("api-key");
  });

  it("blocks private keys", () => {
    const result = scanOutbound("-----BEGIN RSA PRIVATE KEY-----\nMIIE...");
    expect(result.safe).toBe(false);
    expect(result.findings[0].pattern).toBe("private-key");
  });

  it("blocks env secrets", () => {
    const result = scanOutbound("Set API_KEY=my_super_secret_key123");
    expect(result.safe).toBe(false);
    expect(result.findings[0].pattern).toBe("env-secret");
  });

  it("blocks bearer tokens", () => {
    const result = scanOutbound("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc");
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.pattern === "bearer-token")).toBe(true);
  });

  it("blocks system paths", () => {
    const result = scanOutbound("The config is at /Users/eri/Documents/config.json");
    expect(result.safe).toBe(false);
    expect(result.findings[0].pattern).toBe("system-path");
  });

  it("blocks Tailscale IPs", () => {
    const result = scanOutbound("Connect to 100.64.0.1 for the service");
    expect(result.safe).toBe(false);
    expect(result.findings[0].pattern).toBe("tailscale-ip");
  });

  it("blocks Tailscale DNS", () => {
    const result = scanOutbound("The server is at mynode.tailnet-abc.ts.net");
    expect(result.safe).toBe(false);
    expect(result.findings[0].pattern).toBe("tailscale-dns");
  });

  it("blocks localhost ports", () => {
    const result = scanOutbound("Running on localhost:3000");
    expect(result.safe).toBe(false);
    expect(result.findings[0].pattern).toBe("internal-port");
  });

  it("warns on internal DNS but stays safe", () => {
    const result = scanOutbound("Service at db.internal is healthy");
    expect(result.safe).toBe(true);
    expect(result.findings.some((f) => f.pattern === "internal-dns")).toBe(true);
    expect(result.findings[0].severity).toBe("warn");
  });

  it("warns on email addresses but stays safe", () => {
    const result = scanOutbound("Contact me at user@example.com");
    expect(result.safe).toBe(true); // warn, not block
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0].severity).toBe("warn");
  });

  it("warns on phone numbers but stays safe", () => {
    const result = scanOutbound("Call me at 555-123-4567");
    expect(result.safe).toBe(true);
    expect(result.findings[0].pattern).toBe("phone");
    expect(result.findings[0].severity).toBe("warn");
  });

  it("blocks SSNs", () => {
    const result = scanOutbound("My SSN is 123-45-6789");
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.pattern === "ssn")).toBe(true);
  });

  it("detects multiple findings", () => {
    const result = scanOutbound(
      "Config at /Users/eri/app, API_KEY=secret123, connect to 100.64.0.1",
    );
    expect(result.safe).toBe(false);
    expect(result.findings.length).toBeGreaterThanOrEqual(3);
  });

  it("truncates long matches in findings", () => {
    const result = scanOutbound("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(result.findings[0].match.length).toBeLessThanOrEqual(23); // 20 + "..."
  });

  it("works with custom patterns", () => {
    const custom = [
      { name: "custom", pattern: /forbidden/i, severity: "block" as const },
    ];
    const result = scanOutbound("This is forbidden content", custom);
    expect(result.safe).toBe(false);
    expect(result.findings[0].pattern).toBe("custom");
  });

  it("returns safe for empty text", () => {
    const result = scanOutbound("");
    expect(result.safe).toBe(true);
  });

  it("preserves case-insensitive flag on patterns", () => {
    // env-secret pattern has /i flag. Without flag preservation,
    // lowercase variants would silently pass through.
    const result = scanOutbound("Set api_key=my_super_secret_value");
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.pattern === "env-secret")).toBe(true);
  });

  // Code block exemption tests
  it("ignores secrets inside fenced code blocks", () => {
    const text = "Here's how to set it up:\n```\nexport API_KEY=your_secret_here\n```\nThat's it!";
    const result = scanOutbound(text);
    expect(result.safe).toBe(true);
  });

  it("ignores secrets inside inline code", () => {
    const text = "Run `export TOKEN=abc123` to configure";
    const result = scanOutbound(text);
    // The inline code is stripped, so TOKEN=abc123 shouldn't be scanned
    expect(result.findings.filter((f) => f.pattern === "env-secret")).toEqual([]);
  });

  it("still catches secrets outside code blocks", () => {
    const text = "Run this:\n```\necho hello\n```\nAlso set API_KEY=real_secret_value";
    const result = scanOutbound(text);
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.pattern === "env-secret")).toBe(true);
  });

  it("handles mixed code blocks and real secrets", () => {
    const text = "Example: `export FOO=bar`\n\nBut the real key is sk-abc123def456ghi789jkl012mno345";
    const result = scanOutbound(text);
    expect(result.safe).toBe(false); // real API key outside code
    expect(result.findings.some((f) => f.pattern === "api-key")).toBe(true);
  });
});

// ============================================================================
// redactOutbound
// ============================================================================

describe("redactOutbound", () => {
  it("redacts API keys", () => {
    const result = redactOutbound("Key: sk-abc123def456ghi789jkl012mno345");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-abc123");
  });

  it("redacts system paths", () => {
    const result = redactOutbound("File at /Users/eri/Documents/secret.txt");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("/Users/eri");
  });

  it("redacts multiple patterns", () => {
    const text = "Path: /home/user/app, IP: 100.64.0.1";
    const result = redactOutbound(text);
    expect(result).not.toContain("/home/user");
    expect(result).not.toContain("100.64.0.1");
  });

  it("leaves clean text unchanged", () => {
    const text = "Hello, how are you today?";
    expect(redactOutbound(text)).toBe(text);
  });

  it("redacts bearer tokens", () => {
    const result = redactOutbound("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6");
    expect(result).not.toContain("eyJhbGci");
  });

  // Code block preservation tests
  it("preserves secrets inside fenced code blocks", () => {
    const text = "Example:\n```\nexport API_KEY=secret123\n```\nReal path: /Users/eri/app";
    const result = redactOutbound(text);
    // Fenced code should be preserved
    expect(result).toContain("API_KEY=secret123");
    // Real path outside code should be redacted
    expect(result).not.toContain("/Users/eri");
    expect(result).toContain("[REDACTED]");
  });

  it("preserves secrets inside inline code", () => {
    const text = "Run `export TOKEN=abc` but /Users/eri/docs is real";
    const result = redactOutbound(text);
    expect(result).toContain("`export TOKEN=abc`");
    expect(result).not.toContain("/Users/eri");
  });

  it("redacts only outside code blocks when mixed", () => {
    const text = "Code: `sk-example123456789abcdefg` and key: sk-real123456789abcdefghij";
    const result = redactOutbound(text);
    // Inline code preserved
    expect(result).toContain("`sk-example123456789abcdefg`");
    // Real key outside redacted
    expect(result).not.toContain("sk-real123456789abcdefghij");
  });
});
