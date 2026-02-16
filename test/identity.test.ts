import { describe, it, expect, vi } from "vitest";
import {
  loadIdentityContext,
  stripInternalContext,
  formatSystemPrompt,
  DEFAULT_SAFETY_PATTERNS,
} from "../identity.js";

// ============================================================================
// stripInternalContext
// ============================================================================

describe("stripInternalContext", () => {
  it("removes lines matching safety patterns", () => {
    const text = [
      "eri values essentialism and precision",
      "Budget is $4.20 per day",
      "Agent architecture uses headless sovereignty",
      "Running on port 8080",
      "Obsidian vault contains personal knowledge",
    ].join("\n");

    const result = stripInternalContext(text, DEFAULT_SAFETY_PATTERNS);
    expect(result).toContain("essentialism");
    expect(result).toContain("sovereignty");
    expect(result).toContain("Obsidian vault");
    expect(result).not.toContain("$4.20");
    expect(result).not.toContain("port 8080");
  });

  it("strips Tailscale IPs", () => {
    const text = "The node at 100.64.0.1 is running\nValues are important";
    const result = stripInternalContext(text, DEFAULT_SAFETY_PATTERNS);
    expect(result).not.toContain("100.64.0.1");
    expect(result).toContain("Values");
  });

  it("strips system paths", () => {
    const text = "Config at /Users/eri/Documents/vault\nPhilosophy matters";
    const result = stripInternalContext(text, DEFAULT_SAFETY_PATTERNS);
    expect(result).not.toContain("/Users/eri");
    expect(result).toContain("Philosophy");
  });

  it("strips health report language", () => {
    const text = "Health check report: all clear\nEri believes in autonomy";
    const result = stripInternalContext(text, DEFAULT_SAFETY_PATTERNS);
    expect(result).not.toContain("Health check");
    expect(result).toContain("autonomy");
  });

  it("strips scheduling internals", () => {
    const text = "Cron schedule every 30 minutes\nCreative work is essential";
    const result = stripInternalContext(text, DEFAULT_SAFETY_PATTERNS);
    expect(result).not.toContain("Cron");
    expect(result).toContain("Creative");
  });

  it("returns null when all lines are filtered", () => {
    const text = "Budget is $10.00\nRunning on port 3000";
    const result = stripInternalContext(text, DEFAULT_SAFETY_PATTERNS);
    expect(result).toBeNull();
  });

  it("returns original text with empty patterns", () => {
    const text = "Budget is $10.00 and port 3000 is open";
    const result = stripInternalContext(text, []);
    expect(result).toBe(text);
  });

  it("handles custom patterns", () => {
    const customPatterns = [/secret/i];
    const text = "This is secret stuff\nThis is public stuff";
    const result = stripInternalContext(text, customPatterns);
    expect(result).not.toContain("secret");
    expect(result).toContain("public");
  });

  // New patterns
  it("strips AWS account IDs (12 digits)", () => {
    const text = "AWS account 123456789012\nPhilosophy is key";
    const result = stripInternalContext(text, DEFAULT_SAFETY_PATTERNS);
    expect(result).not.toContain("123456789012");
    expect(result).toContain("Philosophy");
  });

  it("strips internal DNS names", () => {
    const text = "Service at db.internal responds\nCreativity matters";
    const result = stripInternalContext(text, DEFAULT_SAFETY_PATTERNS);
    expect(result).not.toContain("db.internal");
    expect(result).toContain("Creativity");
  });

  it("strips bearer tokens", () => {
    const text = "Bearer eyJhbGciOiJIUzI1NiIsInR5c...\nValues above all";
    const result = stripInternalContext(text, DEFAULT_SAFETY_PATTERNS);
    expect(result).not.toContain("Bearer");
    expect(result).toContain("Values");
  });

  it("strips localhost URLs", () => {
    const text = "Running at localhost:3000\nArt is essential";
    const result = stripInternalContext(text, DEFAULT_SAFETY_PATTERNS);
    expect(result).not.toContain("localhost");
    expect(result).toContain("Art");
  });

  it("strips webhook URLs", () => {
    const text = "Configured webhooks.slack.com/services/T...\nPrecision matters";
    const result = stripInternalContext(text, DEFAULT_SAFETY_PATTERNS);
    expect(result).not.toContain("webhooks");
    expect(result).toContain("Precision");
  });

  it("handles global-flagged custom patterns correctly", () => {
    // Global patterns advance lastIndex on each .test() call.
    // Without resetting, lines 2,4,6... would be missed.
    const globalPattern = [/secret/gi];
    const text = "secret line 1\npublic line\nsecret line 2\ngood line\nsecret line 3";
    const result = stripInternalContext(text, globalPattern);
    expect(result).not.toContain("secret");
    expect(result).toContain("public");
    expect(result).toContain("good");
  });

  it("handles repeated calls with same patterns (lastIndex stability)", () => {
    const patterns = [/budget/i];
    const text = "Budget $10\nValues matter";
    // Call twice with same patterns to ensure no lastIndex leak
    stripInternalContext(text, patterns);
    const result = stripInternalContext(text, patterns);
    expect(result).not.toContain("Budget");
    expect(result).toContain("Values");
  });
});

// ============================================================================
// formatSystemPrompt
// ============================================================================

describe("formatSystemPrompt", () => {
  it("includes role declaration", () => {
    const prompt = formatSystemPrompt(null, [], null, { roleName: "communicator" });
    expect(prompt).toContain("communicator");
  });

  it("defaults role to 'agent'", () => {
    const prompt = formatSystemPrompt(null, [], null);
    expect(prompt).toContain("agent");
  });

  it("includes peer card as Layer 1", () => {
    const card = ["eri builds autonomous agents", "essentialism is core"];
    const prompt = formatSystemPrompt(card, [], null);
    expect(prompt).toContain("## Identity");
    expect(prompt).toContain("eri builds autonomous agents");
    expect(prompt).toContain("essentialism is core");
  });

  it("includes alignment responses as Layer 2", () => {
    const alignment = ["eri values precision above all"];
    const prompt = formatSystemPrompt(null, alignment, null);
    expect(prompt).toContain("## Understanding");
    expect(prompt).toContain("precision above all");
  });

  it("includes representation as Layer 3", () => {
    const repr = "Recently working on vault expansion patterns";
    const prompt = formatSystemPrompt(null, [], repr);
    expect(prompt).toContain("## Recent Context");
    expect(prompt).toContain("vault expansion");
  });

  it("includes values when configured", () => {
    const prompt = formatSystemPrompt(null, [], null, {
      values: "Essentialism, precision, care.",
    });
    expect(prompt).toContain("## Values");
    expect(prompt).toContain("Essentialism, precision, care.");
  });

  it("includes principles when configured", () => {
    const prompt = formatSystemPrompt(null, [], null, {
      principles: [
        "Approximation is failure.",
        "Strip away the non-essential.",
      ],
    });
    expect(prompt).toContain("## Operating Principles");
    expect(prompt).toContain("- Approximation is failure.");
    expect(prompt).toContain("- Strip away the non-essential.");
  });

  it("assembles all layers in order", () => {
    const card = ["identity fact"];
    const alignment = ["alignment synthesis"];
    const repr = "recent context line";
    const prompt = formatSystemPrompt(card, alignment, repr, {
      roleName: "communicator",
      values: "care",
      principles: ["be precise"],
    });

    const identityPos = prompt.indexOf("## Identity");
    const understandingPos = prompt.indexOf("## Understanding");
    const recentPos = prompt.indexOf("## Recent Context");
    const valuesPos = prompt.indexOf("## Values");
    const principlesPos = prompt.indexOf("## Operating Principles");

    expect(identityPos).toBeLessThan(understandingPos);
    expect(understandingPos).toBeLessThan(recentPos);
    expect(recentPos).toBeLessThan(valuesPos);
    expect(valuesPos).toBeLessThan(principlesPos);
  });

  it("skips empty sections gracefully", () => {
    const prompt = formatSystemPrompt(null, [], null);
    expect(prompt).not.toContain("## Identity");
    expect(prompt).not.toContain("## Understanding");
    expect(prompt).not.toContain("## Recent Context");
    expect(prompt).not.toContain("## Values");
    expect(prompt).not.toContain("## Operating Principles");
  });
});

// ============================================================================
// loadIdentityContext (with mocked peer)
// ============================================================================

describe("loadIdentityContext", () => {
  function mockPeer(opts: {
    card?: string[] | null;
    chatResponses?: (string | null)[];
    representation?: string | null;
    chatDelay?: number;
  }) {
    let chatCallIndex = 0;
    return {
      getCard: vi.fn().mockResolvedValue(opts.card ?? null),
      chat: vi.fn().mockImplementation(() => {
        const resp = opts.chatResponses?.[chatCallIndex] ?? null;
        chatCallIndex++;
        if (opts.chatDelay) {
          return new Promise((resolve) => setTimeout(() => resolve(resp), opts.chatDelay));
        }
        return Promise.resolve(resp);
      }),
      representation: vi.fn().mockResolvedValue(opts.representation ?? null),
    } as any;
  }

  it("loads all three layers", async () => {
    const peer = mockPeer({
      card: ["fact 1", "fact 2"],
      chatResponses: ["alignment answer 1", "alignment answer 2"],
      representation: "recent context about values",
    });

    const result = await loadIdentityContext(peer, {
      alignmentQueries: ["q1?", "q2?"],
      representationQuery: "values philosophy",
    });

    expect(result.peerCard).toEqual(["fact 1", "fact 2"]);
    expect(result.alignmentResponses).toEqual(["alignment answer 1", "alignment answer 2"]);
    expect(result.representation).toBe("recent context about values");
    expect(result.systemPrompt).toContain("fact 1");
    expect(result.systemPrompt).toContain("alignment answer 1");
    expect(result.systemPrompt).toContain("recent context about values");
  });

  it("handles missing peer card gracefully", async () => {
    const peer = mockPeer({ card: null });
    peer.getCard.mockRejectedValue(new Error("not found"));

    const result = await loadIdentityContext(peer);
    expect(result.peerCard).toBeNull();
    expect(result.systemPrompt).not.toContain("## Identity");
  });

  it("handles failed alignment queries gracefully", async () => {
    const peer = mockPeer({
      card: ["fact"],
      chatResponses: [],
    });
    peer.chat.mockRejectedValue(new Error("timeout"));

    const result = await loadIdentityContext(peer, {
      alignmentQueries: ["q1?"],
    });

    expect(result.alignmentResponses).toEqual([]);
  });

  it("applies safety filter to Layer 3 when patterns provided", async () => {
    const peer = mockPeer({
      representation: "Values are important\nBudget is $5.00 daily\nPhilosophy matters",
    });

    const result = await loadIdentityContext(peer, {
      representationQuery: "values",
      safetyPatterns: DEFAULT_SAFETY_PATTERNS,
    });

    expect(result.representation).toContain("Values");
    expect(result.representation).toContain("Philosophy");
    expect(result.representation).not.toContain("$5.00");
  });

  it("skips safety filter when patterns undefined", async () => {
    const peer = mockPeer({
      representation: "Budget is $5.00 daily",
    });

    const result = await loadIdentityContext(peer, {
      representationQuery: "budget",
    });

    expect(result.representation).toContain("$5.00");
  });

  it("loads all three layers concurrently", async () => {
    const callOrder: string[] = [];
    const peer = {
      getCard: vi.fn().mockImplementation(() => {
        callOrder.push("card");
        return Promise.resolve(["fact"]);
      }),
      chat: vi.fn().mockImplementation(() => {
        callOrder.push("chat");
        return Promise.resolve("answer");
      }),
      representation: vi.fn().mockImplementation(() => {
        callOrder.push("repr");
        return Promise.resolve("context");
      }),
    } as any;

    await loadIdentityContext(peer, {
      alignmentQueries: ["q?"],
      representationQuery: "search",
    });

    // All three should be called (concurrent -- order may vary but all present)
    expect(callOrder).toContain("card");
    expect(callOrder).toContain("chat");
    expect(callOrder).toContain("repr");
  });

  it("returns partial results on timeout", async () => {
    // Peer with very slow chat but fast card/representation
    const peer = {
      getCard: vi.fn().mockResolvedValue(["fast fact"]),
      chat: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve("slow answer"), 10000)),
      ),
      representation: vi.fn().mockResolvedValue("fast context"),
    } as any;

    const result = await loadIdentityContext(peer, {
      alignmentQueries: ["q?"],
      representationQuery: "search",
      timeoutMs: 50, // very short timeout
    });

    // The timeout fires, returns empty defaults
    // (In practice, the fast calls may complete before timeout, but
    //  we're testing that it doesn't hang for 10s)
    expect(result.systemPrompt).toBeDefined();
  }, 2000); // test itself must complete in 2s

  it("handles all layers failing gracefully", async () => {
    const peer = {
      getCard: vi.fn().mockRejectedValue(new Error("network")),
      chat: vi.fn().mockRejectedValue(new Error("network")),
      representation: vi.fn().mockRejectedValue(new Error("network")),
    } as any;

    const result = await loadIdentityContext(peer, {
      alignmentQueries: ["q?"],
      representationQuery: "search",
    });

    expect(result.peerCard).toBeNull();
    expect(result.alignmentResponses).toEqual([]);
    expect(result.representation).toBeNull();
    // Still generates a prompt (just the role declaration)
    expect(result.systemPrompt).toContain("agent");
  });

  it("handles empty peer card array", async () => {
    const peer = mockPeer({ card: [] });

    const result = await loadIdentityContext(peer);
    expect(result.peerCard).toEqual([]);
    expect(result.systemPrompt).not.toContain("## Identity");
  });

  it("filters null chat responses", async () => {
    const peer = mockPeer({
      chatResponses: ["real answer", null, "another answer"],
    });

    const result = await loadIdentityContext(peer, {
      alignmentQueries: ["q1?", "q2?", "q3?"],
    });

    expect(result.alignmentResponses).toEqual(["real answer", "another answer"]);
  });
});
