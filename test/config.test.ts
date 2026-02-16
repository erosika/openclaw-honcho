import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { honchoConfigSchema } from "../config.js";

describe("honchoConfigSchema.parse", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("parses empty config with defaults", () => {
    const cfg = honchoConfigSchema.parse({});
    expect(cfg.workspaceId).toBe("openclaw");
    expect(cfg.baseUrl).toBe("https://api.honcho.dev");
    expect(cfg.alignmentQueries).toBeUndefined();
    expect(cfg.enableSafetyFilter).toBe(false);
    expect(cfg.enableOutboundScanning).toBe(false);
    expect(cfg.dreamAfterConversations).toBeUndefined();
  });

  it("reads API key from config", () => {
    const cfg = honchoConfigSchema.parse({ apiKey: "hc_test123" });
    expect(cfg.apiKey).toBe("hc_test123");
  });

  it("reads API key from env fallback", () => {
    process.env.HONCHO_API_KEY = "hc_from_env";
    const cfg = honchoConfigSchema.parse({});
    expect(cfg.apiKey).toBe("hc_from_env");
  });

  it("parses alignment queries from config array", () => {
    const cfg = honchoConfigSchema.parse({
      alignmentQueries: ["What are their values?", "What is their vision?"],
    });
    expect(cfg.alignmentQueries).toEqual([
      "What are their values?",
      "What is their vision?",
    ]);
  });

  it("parses alignment queries from pipe-delimited env var", () => {
    process.env.HONCHO_ALIGNMENT_QUERIES =
      "What are their values?|What is their vision?";
    const cfg = honchoConfigSchema.parse({});
    expect(cfg.alignmentQueries).toEqual([
      "What are their values?",
      "What is their vision?",
    ]);
  });

  it("config array takes precedence over env var", () => {
    process.env.HONCHO_ALIGNMENT_QUERIES = "env query";
    const cfg = honchoConfigSchema.parse({
      alignmentQueries: ["config query"],
    });
    expect(cfg.alignmentQueries).toEqual(["config query"]);
  });

  it("parses representation query from config", () => {
    const cfg = honchoConfigSchema.parse({
      representationQuery: "values philosophy public",
    });
    expect(cfg.representationQuery).toBe("values philosophy public");
  });

  it("parses representation query from env fallback", () => {
    process.env.HONCHO_REPRESENTATION_QUERY = "from env";
    const cfg = honchoConfigSchema.parse({});
    expect(cfg.representationQuery).toBe("from env");
  });

  it("parses values from config", () => {
    const cfg = honchoConfigSchema.parse({ values: "Essentialism, precision" });
    expect(cfg.values).toBe("Essentialism, precision");
  });

  it("parses values from env fallback", () => {
    process.env.HONCHO_VALUES = "care, liberation";
    const cfg = honchoConfigSchema.parse({});
    expect(cfg.values).toBe("care, liberation");
  });

  it("parses principles from config", () => {
    const cfg = honchoConfigSchema.parse({
      principles: ["Be precise.", "Strip non-essential."],
    });
    expect(cfg.principles).toEqual(["Be precise.", "Strip non-essential."]);
  });

  it("parses principles from env", () => {
    process.env.HONCHO_PRINCIPLES = "Be precise.|Strip non-essential.";
    const cfg = honchoConfigSchema.parse({});
    expect(cfg.principles).toEqual(["Be precise.", "Strip non-essential."]);
  });

  it("parses roleName from config", () => {
    const cfg = honchoConfigSchema.parse({ roleName: "communicator agent" });
    expect(cfg.roleName).toBe("communicator agent");
  });

  it("parses safety filter boolean", () => {
    const cfg = honchoConfigSchema.parse({ enableSafetyFilter: true });
    expect(cfg.enableSafetyFilter).toBe(true);
  });

  it("parses safety filter from env", () => {
    process.env.HONCHO_SAFETY_FILTER = "true";
    const cfg = honchoConfigSchema.parse({});
    expect(cfg.enableSafetyFilter).toBe(true);
  });

  it("parses outbound scanning boolean", () => {
    const cfg = honchoConfigSchema.parse({ enableOutboundScanning: true });
    expect(cfg.enableOutboundScanning).toBe(true);
  });

  it("parses outbound scanning from env", () => {
    process.env.HONCHO_OUTBOUND_SCANNING = "true";
    const cfg = honchoConfigSchema.parse({});
    expect(cfg.enableOutboundScanning).toBe(true);
  });

  it("parses dream interval from config", () => {
    const cfg = honchoConfigSchema.parse({ dreamAfterConversations: 5 });
    expect(cfg.dreamAfterConversations).toBe(5);
  });

  it("parses dream interval from env", () => {
    process.env.HONCHO_DREAM_AFTER = "10";
    const cfg = honchoConfigSchema.parse({});
    expect(cfg.dreamAfterConversations).toBe(10);
  });

  it("parses maxConclusions and searchTopK from config", () => {
    const cfg = honchoConfigSchema.parse({ maxConclusions: 30, searchTopK: 10 });
    expect(cfg.maxConclusions).toBe(30);
    expect(cfg.searchTopK).toBe(10);
  });

  it("handles null/undefined input", () => {
    const cfg = honchoConfigSchema.parse(null);
    expect(cfg.workspaceId).toBe("openclaw");
  });

  it("resolves ${ENV_VAR} in apiKey", () => {
    process.env.MY_HONCHO_KEY = "hc_resolved";
    const cfg = honchoConfigSchema.parse({ apiKey: "${MY_HONCHO_KEY}" });
    expect(cfg.apiKey).toBe("hc_resolved");
  });

  it("parses identityTimeoutMs from config", () => {
    const cfg = honchoConfigSchema.parse({ identityTimeoutMs: 3000 });
    expect(cfg.identityTimeoutMs).toBe(3000);
  });

  it("parses identityTimeoutMs from env", () => {
    process.env.HONCHO_IDENTITY_TIMEOUT = "2000";
    const cfg = honchoConfigSchema.parse({});
    expect(cfg.identityTimeoutMs).toBe(2000);
  });

  it("returns undefined for identityTimeoutMs when not set", () => {
    const cfg = honchoConfigSchema.parse({});
    expect(cfg.identityTimeoutMs).toBeUndefined();
  });

  it("returns undefined for non-numeric HONCHO_DREAM_AFTER", () => {
    process.env.HONCHO_DREAM_AFTER = "not_a_number";
    const cfg = honchoConfigSchema.parse({});
    // NaN from parseInt is converted to undefined (not silently stored)
    expect(cfg.dreamAfterConversations).toBeUndefined();
  });

  it("returns undefined for non-numeric HONCHO_IDENTITY_TIMEOUT", () => {
    process.env.HONCHO_IDENTITY_TIMEOUT = "abc";
    const cfg = honchoConfigSchema.parse({});
    expect(cfg.identityTimeoutMs).toBeUndefined();
  });

  it("handles empty HONCHO_ALIGNMENT_QUERIES", () => {
    process.env.HONCHO_ALIGNMENT_QUERIES = "";
    const cfg = honchoConfigSchema.parse({});
    // Empty string is falsy, parseEnvArray returns undefined
    expect(cfg.alignmentQueries).toBeUndefined();
  });

  it("trims whitespace from pipe-delimited arrays", () => {
    process.env.HONCHO_PRINCIPLES = " Be precise. | Strip non-essential. ";
    const cfg = honchoConfigSchema.parse({});
    expect(cfg.principles).toEqual(["Be precise.", "Strip non-essential."]);
  });
});
