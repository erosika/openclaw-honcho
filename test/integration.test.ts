import { describe, it, expect, vi } from "vitest";
import {
  loadIdentityContext,
  stripInternalContext,
  formatSystemPrompt,
  DEFAULT_SAFETY_PATTERNS,
} from "../identity.js";
import {
  scanOutbound,
  redactOutbound,
  stripCodeBlocks,
} from "../scanning.js";

// ============================================================================
// Simulated Chat Scenarios
// ============================================================================

describe("Chat Scenario: Identity boundary enforcement", () => {
  it("strips infrastructure details from Layer 3 before injection", () => {
    const representation = [
      "eri values essentialism and precision above all",
      "The sentinel agent runs on port 8080 every 30 minutes",
      "Budget is $4.20 per day across all agents",
      "eri believes in headless sovereignty for AI agents",
      "Running on ThinkPad with Tailscale at 100.64.0.1",
      "Cron schedule configured for sentinel: */30 * * * *",
      "eri's vision for ANIMA involves autonomous cognition",
    ].join("\n");

    const filtered = stripInternalContext(representation, DEFAULT_SAFETY_PATTERNS);
    expect(filtered).toContain("essentialism");
    expect(filtered).toContain("headless sovereignty");
    expect(filtered).toContain("ANIMA");
    expect(filtered).not.toContain("port 8080");
    expect(filtered).not.toContain("$4.20");
    expect(filtered).not.toContain("ThinkPad");
    expect(filtered).not.toContain("100.64.0.1");
    expect(filtered).not.toContain("Cron");
  });

  it("blocks outbound messages containing real secrets", () => {
    // Scenario: LLM tries to share a system path
    const response = "Your configuration file is located at /Users/ijane/Documents/coding/cosmania/.env";
    const result = scanOutbound(response);
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.pattern === "system-path")).toBe(true);
  });

  it("allows outbound messages with code examples", () => {
    // Scenario: LLM explains how to set an env var
    const response = "To configure the API key, add this to your `.env` file:\n```\nexport HONCHO_API_KEY=your_key_here\n```\nThen restart the service.";
    const result = scanOutbound(response);
    // The secret is inside a code block, so it should be safe
    expect(result.safe).toBe(true);
  });

  it("catches secrets outside code blocks even when code blocks present", () => {
    const response = "Here's an example:\n```\nexport FOO=bar\n```\nBut the real key is sk-live123456789abcdefghijklmn";
    const result = scanOutbound(response);
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.pattern === "api-key")).toBe(true);
  });
});

describe("Chat Scenario: Multi-layer identity assembly", () => {
  function mockPeer(opts: {
    card?: string[] | null;
    chatResponses?: (string | null)[];
    representation?: string | null;
  }) {
    let chatCallIndex = 0;
    return {
      getCard: vi.fn().mockResolvedValue(opts.card ?? null),
      chat: vi.fn().mockImplementation(() => {
        const resp = opts.chatResponses?.[chatCallIndex] ?? null;
        chatCallIndex++;
        return Promise.resolve(resp);
      }),
      representation: vi.fn().mockResolvedValue(opts.representation ?? null),
    } as any;
  }

  it("assembles communicator identity from all three layers", async () => {
    const peer = mockPeer({
      card: [
        "eri builds autonomous AI agents under Operation ANIMA",
        "Values: essentialism, precision, care",
        "Works with Obsidian, TypeScript, and astrology",
      ],
      chatResponses: [
        "eri prioritizes foundational infrastructure stability over competitive features. She treats unreliable foundations as damage to both technical integrity and market credibility.",
        "eri applies identical precision standards across technical, aesthetic, and strategic domains. Design should be sharp yet kawaii, precise yet warm.",
      ],
      representation: "Recently focused on three-layer identity injection for the communicator agent. Working on Honcho plugin architecture with safety filters and dream triggers.",
    });

    const result = await loadIdentityContext(peer, {
      alignmentQueries: [
        "What are eri's priorities for building software?",
        "How does eri approach design and aesthetics?",
      ],
      representationQuery: "values philosophy public identity",
      roleName: "communicator",
      values: "Essentialism, precision, care.",
      principles: [
        "Strip away the non-essential.",
        "Earn trust through memory.",
        "Never expose operational details.",
      ],
    });

    // All layers present
    expect(result.peerCard).toHaveLength(3);
    expect(result.alignmentResponses).toHaveLength(2);
    expect(result.representation).toContain("three-layer");

    // System prompt structure
    expect(result.systemPrompt).toContain("communicator");
    expect(result.systemPrompt).toContain("## Identity");
    expect(result.systemPrompt).toContain("## Understanding");
    expect(result.systemPrompt).toContain("## Recent Context");
    expect(result.systemPrompt).toContain("## Values");
    expect(result.systemPrompt).toContain("## Operating Principles");

    // Content
    expect(result.systemPrompt).toContain("essentialism");
    expect(result.systemPrompt).toContain("foundational infrastructure");
    expect(result.systemPrompt).toContain("Earn trust through memory");
  });

  it("degrades gracefully when only card available", async () => {
    const peer = mockPeer({
      card: ["eri builds AI agents"],
      chatResponses: [],
      representation: null,
    });
    peer.chat.mockRejectedValue(new Error("timeout"));

    const result = await loadIdentityContext(peer, {
      alignmentQueries: ["What are their values?"],
      roleName: "communicator",
    });

    expect(result.peerCard).toEqual(["eri builds AI agents"]);
    expect(result.alignmentResponses).toEqual([]);
    expect(result.representation).toBeNull();
    expect(result.systemPrompt).toContain("## Identity");
    expect(result.systemPrompt).not.toContain("## Understanding");
    expect(result.systemPrompt).not.toContain("## Recent Context");
  });

  it("applies safety filter to representation with infrastructure data", async () => {
    const peer = mockPeer({
      card: ["eri builds autonomous agents"],
      representation: [
        "eri values essentialism",
        "Budget is $4.20 per day",
        "Running on port 3000",
        "eri believes in headless sovereignty",
      ].join("\n"),
    });

    const result = await loadIdentityContext(peer, {
      representationQuery: "values",
      safetyPatterns: DEFAULT_SAFETY_PATTERNS,
    });

    expect(result.representation).toContain("essentialism");
    expect(result.representation).toContain("sovereignty");
    expect(result.representation).not.toContain("$4.20");
    expect(result.representation).not.toContain("port 3000");
  });
});

describe("Chat Scenario: Outbound message redaction", () => {
  it("redacts real paths but preserves code examples", () => {
    const text = [
      "To set up the project, create a config file:",
      "```",
      "export CONFIG_PATH=/Users/yourname/project/.env",
      "```",
      "",
      "I found the issue at /Users/ijane/Documents/coding/cosmania/src/main.ts",
    ].join("\n");

    const redacted = redactOutbound(text);
    // Code block preserved
    expect(redacted).toContain("/Users/yourname/project/.env");
    // Real path redacted
    expect(redacted).not.toContain("/Users/ijane");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts inline code examples correctly", () => {
    const text = "Run `export TOKEN=your_token` but the real config is at /home/user/app/config";
    const redacted = redactOutbound(text);
    expect(redacted).toContain("`export TOKEN=your_token`");
    expect(redacted).not.toContain("/home/user");
  });
});

describe("Chat Scenario: Prompt construction edge cases", () => {
  it("handles empty alignment responses gracefully", () => {
    const prompt = formatSystemPrompt(
      ["fact 1"],
      [],
      "recent context",
      { roleName: "communicator" },
    );
    expect(prompt).toContain("## Identity");
    expect(prompt).not.toContain("## Understanding");
    expect(prompt).toContain("## Recent Context");
  });

  it("handles all null/empty layers", () => {
    const prompt = formatSystemPrompt(null, [], null, { roleName: "communicator" });
    expect(prompt).toContain("communicator");
    expect(prompt).not.toContain("## Identity");
    expect(prompt).not.toContain("## Understanding");
    expect(prompt).not.toContain("## Recent Context");
  });

  it("assembles a realistic communicator prompt", () => {
    const prompt = formatSystemPrompt(
      [
        "eri builds autonomous AI agents under Operation ANIMA",
        "Core values: essentialism, precision, care",
      ],
      [
        "eri believes AI should be autonomous but aligned, operating with minimal human intervention while maintaining deep value alignment.",
      ],
      "Recently working on Honcho plugin for identity injection.",
      {
        roleName: "communicator",
        values: "Essentialism, precision, care, liberation.",
        principles: [
          "Strip away the non-essential.",
          "Earn trust through memory.",
          "Never expose operational details.",
        ],
      },
    );

    // Verify section order
    const sections = ["## Identity", "## Understanding", "## Recent Context", "## Values", "## Operating Principles"];
    let lastPos = -1;
    for (const section of sections) {
      const pos = prompt.indexOf(section);
      expect(pos).toBeGreaterThan(lastPos);
      lastPos = pos;
    }

    // Verify content
    expect(prompt).toContain("Operation ANIMA");
    expect(prompt).toContain("autonomous but aligned");
    expect(prompt).toContain("Honcho plugin");
    expect(prompt).toContain("liberation");
    expect(prompt).toContain("- Strip away the non-essential.");
  });
});

describe("Chat Scenario: Code block edge cases in scanning", () => {
  it("handles nested-looking code blocks", () => {
    const text = "Outer text\n```\nInner `code` block\n```\nMore text with API_KEY=secret";
    const result = scanOutbound(text);
    // The fenced block contains inline code — fenced block should be stripped first
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.pattern === "env-secret")).toBe(true);
  });

  it("handles empty code blocks", () => {
    const text = "Before\n```\n```\nAfter with normal text";
    const stripped = stripCodeBlocks(text);
    expect(stripped).toContain("Before");
    expect(stripped).toContain("After");
  });

  it("handles code blocks with language specifiers", () => {
    const text = "Config:\n```yaml\napi_key: sk-test123456789abcdefghi\n```\nDone.";
    const result = scanOutbound(text);
    // YAML code block should be stripped — sk-test... inside code
    expect(result.findings.filter((f) => f.pattern === "api-key")).toEqual([]);
  });
});

describe("Chat Scenario: Safety pattern edge cases", () => {
  it("strips multiple infrastructure items from single representation", () => {
    const text = [
      "User values precision",
      "AWS account 123456789012 hosts the service",
      "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 for auth",
      "Service at db.internal for database",
      "Webhook at webhooks.slack.com/services/T123",
      "Running at localhost:3000",
      "User cares about aesthetics",
    ].join("\n");

    const filtered = stripInternalContext(text, DEFAULT_SAFETY_PATTERNS);
    expect(filtered).toContain("precision");
    expect(filtered).toContain("aesthetics");
    expect(filtered).not.toContain("123456789012");
    expect(filtered).not.toContain("Bearer");
    expect(filtered).not.toContain("db.internal");
    expect(filtered).not.toContain("webhooks");
    expect(filtered).not.toContain("localhost");
  });

  it("preserves URLs that aren't infrastructure", () => {
    // Public URLs should NOT be stripped
    const text = "Check out https://github.com/erosika for the code\nValues matter";
    const filtered = stripInternalContext(text, DEFAULT_SAFETY_PATTERNS);
    expect(filtered).toContain("github.com");
    expect(filtered).toContain("Values");
  });
});
