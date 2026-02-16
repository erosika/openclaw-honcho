import { describe, it, expect } from "vitest";
import {
  scanOutbound,
  redactOutbound,
  DEFAULT_SCAN_PATTERNS,
} from "../scanning.js";

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
});

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
});
