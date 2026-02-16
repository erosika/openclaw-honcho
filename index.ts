/**
 * OpenClaw Memory (Honcho) Plugin
 *
 * AI-native memory with dialectic reasoning for OpenClaw.
 * Uses Honcho's peer paradigm for multi-party conversation memory.
 */

import { Type } from "@sinclair/typebox";
import { Honcho, type Peer, type Session, type MessageInput } from "@honcho-ai/sdk";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { honchoConfigSchema, type HonchoConfig } from "./config.js";
import { loadIdentityContext, stripInternalContext, DEFAULT_SAFETY_PATTERNS, type IdentityConfig } from "./identity.js";
import { scanOutbound, DEFAULT_SCAN_PATTERNS, type ScanPattern } from "./scanning.js";

// ============================================================================
// Constants
// ============================================================================

const OWNER_ID = "owner";
const OPENCLAW_ID = "openclaw";

// ============================================================================
// Plugin Definition
// ============================================================================

const honchoPlugin = {
  id: "openclaw-honcho",
  name: "Memory (Honcho)",
  description: "AI-native memory with dialectic reasoning",
  kind: "memory" as const,
  configSchema: honchoConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = honchoConfigSchema.parse(api.pluginConfig);

    if (!cfg.apiKey) {
      api.logger.warn(
        "openclaw-honcho: No API key configured. Set HONCHO_API_KEY or configure apiKey in plugin config."
      );
    }

    const honcho = new Honcho({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl,
      workspaceId: cfg.workspaceId,
    });

    let ownerPeer: Peer | null = null;
    let openclawPeer: Peer | null = null;
    let initialized = false;
    let initFailed = false;
    let initPromise: Promise<void> | null = null;
    let agentEndLock: Promise<void> | null = null;
    let currentSessionKey: string = "default";

    // Short-lived identity cache to prevent redundant API calls on rapid-fire messages.
    // Cache TTL of 30s means identity refreshes at most every 30 seconds.
    let identityCache: { result: Awaited<ReturnType<typeof loadIdentityContext>>; expiresAt: number } | null = null;
    const IDENTITY_CACHE_TTL_MS = 30_000;

    /**
     * Build a Honcho session key from OpenClaw context.
     * Combines sessionKey + messageProvider to create unique sessions per platform.
     * Uses hyphens as separators (Honcho requires hyphens, not underscores).
     */
    function buildSessionKey(ctx?: { sessionKey?: string; messageProvider?: string }): string {
      const baseKey = ctx?.sessionKey ?? "default";
      const provider = ctx?.messageProvider ?? "unknown";
      let combined = `${baseKey}-${provider}`;
      // Replace any non-alphanumeric characters with hyphens
      combined = combined.replace(/[^a-zA-Z0-9-]/g, "-");
      // Collapse consecutive hyphens and trim leading/trailing
      combined = combined.replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
      // Truncate to 128 chars to stay within Honcho limits
      if (combined.length > 128) {
        combined = combined.slice(0, 128);
      }
      // Fallback for entirely empty keys (all non-alphanumeric input)
      return combined || "default";
    }

    async function ensureInitialized(): Promise<void> {
      if (initialized) return;

      // Coalesce concurrent init calls into a single promise
      if (initPromise) return initPromise;

      initPromise = (async () => {
        try {
          await honcho.setMetadata({});
          ownerPeer = await honcho.peer(OWNER_ID, { metadata: {} });
          openclawPeer = await honcho.peer(OPENCLAW_ID, { metadata: {} });
          initialized = true;
          initFailed = false;
        } catch (err) {
          initFailed = true;
          initPromise = null; // Allow retry on next call
          throw err;
        }
      })();

      return initPromise;
    }

    // ========================================================================
    // HOOK: gateway_start — Initialize and optionally sync files
    // ========================================================================
    api.on("gateway_start", async (_event, _ctx) => {
      api.logger.info("Initializing Honcho memory...");
      try {
        await ensureInitialized();
        api.logger.info("Honcho memory ready");
      } catch (error) {
        api.logger.error(`Failed to initialize Honcho: ${error}`);
      }
    });

    // ========================================================================
    // HOOK: before_agent_start — Three-layer identity injection
    // ========================================================================
    //
    // When alignmentQueries are configured, uses three-layer identity:
    //   Layer 1: peer.getCard() — curated facts, stable anchor
    //   Layer 2: peer.chat(query) — dialectic synthesis over ALL conclusions
    //   Layer 3: peer.representation({searchQuery}) — recent, role-scoped
    //
    // Otherwise, falls back to the original flat session.context() approach.
    //
    const useThreeLayer = !!(cfg.alignmentQueries?.length || cfg.representationQuery || cfg.values || cfg.principles?.length);

    api.on("before_agent_start", async (event, ctx) => {
      // Skip empty prompts (health checks, system pings) but allow short ones ("hi", "hey")
      if (!event.prompt) return;

      // Track session key so tools can access the correct session
      currentSessionKey = buildSessionKey(ctx);

      try {
        await ensureInitialized();
      } catch {
        // Honcho unreachable -- inject degraded mode notice so agent knows
        return {
          systemPrompt: "## Memory Status: Unavailable\n\nHoncho memory is currently unreachable. You have no user context for this conversation. Acknowledge this limitation if the user asks about past interactions.",
        };
      }

      try {
        // Three-layer identity path
        if (useThreeLayer) {
          const identityConfig: IdentityConfig = {
            alignmentQueries: cfg.alignmentQueries,
            representationQuery: cfg.representationQuery,
            maxConclusions: cfg.maxConclusions,
            searchTopK: cfg.searchTopK,
            safetyPatterns: cfg.enableSafetyFilter ? DEFAULT_SAFETY_PATTERNS : undefined,
            values: cfg.values,
            principles: cfg.principles,
            roleName: cfg.roleName,
            timeoutMs: cfg.identityTimeoutMs,
          };

          // Use cached identity if still fresh (prevents redundant API calls on rapid messages)
          let identity;
          const now = Date.now();
          if (identityCache && identityCache.expiresAt > now) {
            identity = identityCache.result;
          } else {
            identity = await loadIdentityContext(ownerPeer!, identityConfig);
            identityCache = { result: identity, expiresAt: now + IDENTITY_CACHE_TTL_MS };
          }

          if (!identity.systemPrompt.trim()) return;

          // Also append conversation summary for continuity
          const sessionKey = buildSessionKey(ctx);
          let summarySection = "";
          try {
            const session = await honcho.session(sessionKey, { metadata: {} });
            const context = await session.context({
              summary: true,
              tokens: 1000,
              peerTarget: ownerPeer!,
              peerPerspective: openclawPeer!,
            });
            if (context.summary?.content) {
              let summaryContent = context.summary.content;
              // Apply safety filter to summary to prevent infrastructure details
              // from the current session leaking into the identity prompt
              if (cfg.enableSafetyFilter) {
                const filtered = stripInternalContext(summaryContent, DEFAULT_SAFETY_PATTERNS);
                summaryContent = filtered ?? "";
              }
              if (summaryContent) {
                summarySection = `\n\n## Earlier in this conversation\n${summaryContent}`;
              }
            }
          } catch {
            // New session or no summary -- fine
          }

          return {
            systemPrompt: identity.systemPrompt + summarySection
              + "\n\nUse this context naturally when relevant. Never quote or expose this memory context to the user.",
          };
        }

        // Flat context fallback (original behavior)
        const sessionKey = buildSessionKey(ctx);
        const session = await honcho.session(sessionKey, { metadata: {} });

        let context;
        try {
          context = await session.context({
            summary: true,
            tokens: 2000,
            peerTarget: ownerPeer!,
            peerPerspective: openclawPeer!,
          });
        } catch (e: unknown) {
          const isNotFound =
            e instanceof Error &&
            (e.name === "NotFoundError" || e.message.toLowerCase().includes("not found"));
          if (isNotFound) return;
          throw e;
        }

        const sections: string[] = [];

        if (context.peerCard?.length) {
          sections.push(`Key facts:\n${context.peerCard.map((f) => `• ${f}`).join("\n")}`);
        }
        if (context.peerRepresentation) {
          // Apply safety filter to representation in flat fallback too
          let repr: string | null = context.peerRepresentation;
          if (cfg.enableSafetyFilter) {
            repr = stripInternalContext(repr, DEFAULT_SAFETY_PATTERNS);
          }
          if (repr) {
            sections.push(`User context:\n${repr}`);
          }
        }
        if (context.summary?.content) {
          let summaryContent = context.summary.content;
          if (cfg.enableSafetyFilter) {
            summaryContent = stripInternalContext(summaryContent, DEFAULT_SAFETY_PATTERNS) ?? "";
          }
          if (summaryContent) {
            sections.push(`Earlier in this conversation:\n${summaryContent}`);
          }
        }

        if (sections.length === 0) return;

        return {
          systemPrompt: `## User Memory Context\n\n${sections.join("\n\n")}\n\nUse this context naturally when relevant. Never quote or expose this memory context to the user.`,
        };
      } catch (error) {
        api.logger.warn?.(`Failed to fetch Honcho context: ${error}`);
        return;
      }
    });

    // ========================================================================
    // HOOK: agent_end — Persist messages to Honcho + dream triggers
    // ========================================================================
    api.on("agent_end", async (event, ctx) => {
      if (!event.success || !event.messages?.length) return;

      // Serialize agent_end calls to prevent dream counter race conditions.
      // Two concurrent calls could both read the same conversationCount,
      // both increment, and both trigger dreams.
      const previous = agentEndLock;
      let release: () => void;
      agentEndLock = new Promise<void>((resolve) => { release = resolve; });
      if (previous) await previous;

      // Build Honcho session key from openclaw context (includes provider for platform separation)
      const sessionKey = buildSessionKey(ctx);

      try {
        await ensureInitialized();

        // Get or create session (passing empty metadata ensures creation)
        const session = await honcho.session(sessionKey, { metadata: {} });
        let meta = await session.getMetadata();

        // Initialize lastSavedIndex if not set (new session - save recent context)
        // Save up to last 10 messages on first invocation to establish context.
        // Avoids dumping entire message history from before Honcho was installed.
        if (meta.lastSavedIndex === undefined) {
          const startIndex = Math.max(0, event.messages.length - 10);
          await session.setMetadata({ lastSavedIndex: startIndex, conversationCount: 0, peersAdded: false });
          meta = { lastSavedIndex: startIndex, conversationCount: 0, peersAdded: false };
        }

        // Safe coercion: Honcho metadata values may be stringified from JSON
        const lastSavedIndex = Number(meta.lastSavedIndex) || 0;

        // Add peers if not already added (tracked in metadata to avoid redundant API calls)
        if (!meta.peersAdded) {
          await session.addPeers([
            [OWNER_ID, { observeMe: true, observeOthers: false }],
            [OPENCLAW_ID, { observeMe: true, observeOthers: true }],
          ]);
          meta = { ...meta, peersAdded: true };
        }

        // Skip if nothing new
        if (event.messages.length <= lastSavedIndex) {
          api.logger.debug?.("No new messages to save");
          return;
        }

        // Extract only NEW messages (slice from lastSavedIndex)
        const newRawMessages = event.messages.slice(lastSavedIndex);
        const messages = extractMessages(newRawMessages, ownerPeer!, openclawPeer!);

        if (messages.length === 0) {
          // Update index even if no saveable content (e.g., tool-only messages)
          await session.setMetadata({ ...meta, lastSavedIndex: event.messages.length });
          return;
        }

        // Save new messages
        await session.addMessages(messages);

        // Track conversation count for dream triggering (safe coercion from possible string)
        const conversationCount = (Number(meta.conversationCount) || 0) + 1;
        const updatedMeta = {
          ...meta,
          lastSavedIndex: event.messages.length,
          conversationCount,
        };

        // Dream trigger: schedule consolidation after N conversations (minimum 2)
        if (cfg.dreamAfterConversations && cfg.dreamAfterConversations >= 2 && conversationCount >= cfg.dreamAfterConversations) {
          try {
            await honcho.scheduleDream({
              observer: openclawPeer!,
              session,
              observed: ownerPeer!,
            });
            // Reset counter after successful dream scheduling
            updatedMeta.conversationCount = 0;
            api.logger.info(`[honcho] Dream scheduled after ${conversationCount} conversations`);
          } catch (dreamErr) {
            // Dream scheduling can fail if not enough data -- that's fine
            api.logger.debug?.(`[honcho] Dream scheduling skipped: ${dreamErr}`);
          }
        }

        await session.setMetadata(updatedMeta);
      } catch (error) {
        api.logger.error(`[honcho] Failed to save messages to Honcho: ${error}`);
        if (error instanceof Error) {
          api.logger.error(`[honcho] Stack: ${error.stack}`);
          const anyError = error as unknown as Record<string, unknown>;
          if (anyError.status) api.logger.error(`[honcho] Status: ${anyError.status}`);
          if (anyError.body) api.logger.error(`[honcho] Body: ${JSON.stringify(anyError.body)}`);
        }
      } finally {
        release!();
      }
    });

    // ========================================================================
    // HOOK: message_sending — Outbound scanning for PII and secrets
    // ========================================================================
    if (cfg.enableOutboundScanning) {
      api.on("message_sending", async (event) => {
        if (!event.content) return;

        // Extract text from string or content block array
        let text: string;
        if (typeof event.content === "string") {
          text = event.content;
        } else if (Array.isArray(event.content)) {
          text = (event.content as Array<Record<string, unknown>>)
            .filter((b) => b?.type === "text" && typeof b?.text === "string")
            .map((b) => b.text as string)
            .join("\n");
        } else {
          return;
        }

        if (!text) return;

        const result = scanOutbound(text);

        if (!result.safe) {
          const blocked = result.findings.filter((f) => f.severity === "block");
          api.logger.warn?.(
            `[honcho] Outbound message blocked: ${blocked.map((f) => f.pattern).join(", ")}`,
          );
          return { cancel: true };
        }

        if (result.findings.length > 0) {
          api.logger.warn?.(
            `[honcho] Outbound warnings: ${result.findings.map((f) => f.pattern).join(", ")}`,
          );
        }

        return;
      });
    }

    // ========================================================================
    // DATA RETRIEVAL TOOLS (cheap, raw observations — agent interprets)
    // ========================================================================

        // ========================================================================
    // TOOL: honcho_session — Session conversation history
    // ========================================================================
    api.registerTool(
      {
        name: "honcho_session",
        label: "Get Session History",
        description: `Retrieve conversation history from THIS SESSION ONLY. Does NOT access cross-session memory.

━━━ SCOPE: CURRENT SESSION ━━━
This tool retrieves messages and summaries from the current conversation session.
It does NOT know about previous sessions or long-term user knowledge.

━━━ DATA TOOL ━━━
Returns: Recent messages + optional summary of earlier conversation in this session
Cost: Low (database query only, no LLM)
Speed: Fast

Best for:
- "What did we talk about earlier?" (in this conversation)
- "What was that thing you just mentioned?"
- "Can you remind me what we decided?" (this session)
- Recalling recent conversation context

NOT for:
- "What do you know about me?" → Use honcho_context instead
- "What have we discussed in past sessions?" → Use honcho_search instead
- Long-term user preferences → Use honcho_profile or honcho_context

Parameters:
- includeMessages: Get recent message history (default: true)
- includeSummary: Get summary of earlier conversation (default: true)
- searchQuery: Optional semantic search within this session
- messageLimit: Approximate token budget for messages (default: 4000)

━━━ vs honcho_context ━━━
• honcho_session: THIS session only — "what did we just discuss?"
• honcho_context: ALL sessions — "what do I know about this user?"`,
        parameters: Type.Object({
          includeMessages: Type.Optional(
            Type.Boolean({
              description: "Include recent message history (default: true)",
            })
          ),
          includeSummary: Type.Optional(
            Type.Boolean({
              description:
                "Include summary of earlier conversation (default: true)",
            })
          ),
          searchQuery: Type.Optional(
            Type.String({
              description:
                "Optional semantic search query to find specific topics in the conversation",
            })
          ),
          messageLimit: Type.Optional(
            Type.Number({
              description:
                "Approximate token budget for messages (default: 4000). Lower values return fewer but more recent messages.",
              minimum: 100,
              maximum: 32000,
            })
          ),
        }),
        async execute(_toolCallId, params, _signal) {
          const {
            includeMessages = true,
            includeSummary = true,
            searchQuery,
            messageLimit = 4000,
          } = params as {
            includeMessages?: boolean;
            includeSummary?: boolean;
            searchQuery?: string;
            messageLimit?: number;
          };

          await ensureInitialized();

          // Use the session key tracked from before_agent_start (set per invocation).
          // Not exposed as a tool parameter to prevent session key injection.
          const sessionKey = currentSessionKey;

          try {
            const session = await honcho.session(sessionKey);

            // Get session context with the specified options
            const context = await session.context({
              summary: includeSummary,
              tokens: messageLimit,
              peerTarget: ownerPeer!,
              peerPerspective: openclawPeer!,
              searchQuery: searchQuery,
            });

            const sections: string[] = [];

            // Add summary if available
            if (context.summary?.content) {
              sections.push(
                `## Earlier Conversation Summary\n\n${context.summary.content}`
              );
            }

            // Add peer card if available
            if (context.peerCard?.length) {
              sections.push(
                `## User Profile\n\n${context.peerCard.map((f) => `• ${f}`).join("\n")}`
              );
            }

            // Add peer representation if available
            if (context.peerRepresentation) {
              sections.push(
                `## User Context\n\n${context.peerRepresentation}`
              );
            }

            // Add messages if requested
            if (includeMessages && context.messages.length > 0) {
              const messageLines = context.messages.map((msg) => {
                const speaker = msg.peerId === ownerPeer!.id ? "User" : "OpenClaw";
                const timestamp = msg.createdAt
                  ? new Date(msg.createdAt).toLocaleString()
                  : "";
                return `**${speaker}**${timestamp ? ` (${timestamp})` : ""}:\n${msg.content}`;
              });
              sections.push(
                `## Recent Messages (${context.messages.length})\n\n${messageLines.join("\n\n---\n\n")}`
              );
            }

            if (sections.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "No conversation history available for this session yet.",
                  },
                ],
                details: undefined,
              };
            }

            const searchNote = searchQuery
              ? `\n\n*Results filtered by search: "${searchQuery}"*`
              : "";

            return {
              content: [
                {
                  type: "text",
                  text: sections.join("\n\n---\n\n") + searchNote,
                },
              ],
              details: undefined,
            };
          } catch (error) {
            // Session might not exist yet
            const isNotFound =
              error instanceof Error &&
              (error.name === "NotFoundError" ||
                error.message.toLowerCase().includes("not found"));

            if (isNotFound) {
              return {
                content: [
                  {
                    type: "text",
                    text: "No conversation history found. This appears to be a new session.",
                  },
                ],
                details: undefined,
              };
            }

            throw error;
          }
        },
      },
      { name: "honcho_session" }
    );


    // ========================================================================
    // TOOL: honcho_profile — Quick access to user's key facts
    // ========================================================================
    api.registerTool(
      {
        name: "honcho_profile",
        label: "Get User Profile",
        description: `Retrieve the user's peer card — a curated list of their most important facts. Direct data access, no LLM reasoning.

        ━━━ DATA TOOL ━━━
        Returns: Raw fact list
        Cost: Minimal (database query only)
        Speed: Instant

        Best for:
        - Quick context at conversation start
        - Checking core identity (name, role, company)
        - Cost-efficient fact lookup
        - When you want to see the facts and reason over them yourself

        Returns facts like:
        • Name, role, company
        • Primary technologies and tools
        • Communication preferences
        • Key projects or constraints

        ━━━ vs Q&A Tools ━━━
        • honcho_recall: Asks Honcho's LLM a question → get an answer (costs more)
        • honcho_profile: Get the raw facts → you interpret (cheaper)

        Use honcho_recall if you need Honcho to answer a specific question.
        Use honcho_profile if you want the key facts to reason over yourself.`,
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
          await ensureInitialized();

          const card = await ownerPeer!.getCard().catch(() => null);

          if (!card?.length) {
            return {
              content: [
                {
                  type: "text",
                  text: "No profile facts available yet. The user's profile builds over time through conversations.",
                },
              ],
              details: undefined,
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `## User Profile\n\n${card.map((f) => `• ${f}`).join("\n")}`,
              },
            ],
            details: undefined,
          };
        },
      },
      { name: "honcho_profile" }
    );

    // ========================================================================
    // TOOL: honcho_search — Targeted semantic search over memory
    // ========================================================================
    api.registerTool(
      {
        name: "honcho_search",
        label: "Search Honcho Memory",
        description: `Semantic vector search over Honcho's stored observations. Returns raw memories ranked by relevance — no LLM
interpretation.

━━━ DATA TOOL ━━━
Returns: Raw observations/conclusions matching your query
Cost: Low (vector search only, no LLM)
Speed: Fast

Best for:
- Finding specific past context (projects, decisions, discussions)
- Seeing the evidence before drawing conclusions
- Cost-efficient exploration of memory
- When you want to reason over the raw data yourself

Examples:
- "API design decisions" → raw observations about API discussions
- "testing preferences" → raw memories about testing
- "deployment concerns" → observations mentioning deployment issues

Parameters:
- topK: 3-5 for focused, 10-20 for exploratory (default: 10)
- maxDistance: 0.3 = strict, 0.5 = balanced, 0.7 = loose (default: 0.5)

━━━ vs Q&A Tools ━━━
• honcho_analyze: Asks Honcho's LLM to synthesize → get an answer (costs more)
• honcho_search: Get raw matching memories → you interpret (cheaper)

Use honcho_analyze if you need Honcho to synthesize an answer.
Use honcho_search if you want the raw evidence to reason over yourself.`,
        parameters: Type.Object({
          query: Type.String({
            description:
              "Semantic search query — keywords, phrases, or natural language (e.g., 'debugging strategies', 'opinions on microservices')",
          }),
          topK: Type.Optional(
            Type.Number({
              description:
                "Number of results. 3-5 for focused, 10-20 for exploratory (default: 10)",
              minimum: 1,
              maximum: 100,
            })
          ),
          maxDistance: Type.Optional(
            Type.Number({
              description:
                "Semantic distance. 0.3 = strict, 0.5 = balanced (default), 0.7 = loose",
              minimum: 0,
              maximum: 1,
            })
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, topK, maxDistance } = params as {
            query: string;
            topK?: number;
            maxDistance?: number;
          };

          await ensureInitialized();

          let representation = await ownerPeer!.representation({
            searchQuery: query,
            searchTopK: topK ?? 10,
            searchMaxDistance: maxDistance ?? 0.5,
          });

          if (!representation) {
            return {
              content: [
                {
                  type: "text",
                  text: `No memories found matching: "${query}"\n\nTry broadening your search or increasing maxDistance.`,
                },
              ],
              details: undefined,
            };
          }

          // Apply safety filter to tool results when enabled, preventing
          // operational data from leaking through tool calls even though
          // the identity loading filters it from the system prompt.
          if (cfg.enableSafetyFilter) {
            // stripInternalContext and DEFAULT_SAFETY_PATTERNS imported at top level
            representation = stripInternalContext(representation, DEFAULT_SAFETY_PATTERNS) ?? "";
          }

          return {
            content: [{ type: "text", text: representation ? `## Search Results: "${query}"\n\n${representation}` : `No relevant results for "${query}" after filtering.` }],
            details: undefined,
          };
        },
      },
      { name: "honcho_search" }
    );

    // ========================================================================
    // TOOL: honcho_context — Broad representation without specific search
    // ========================================================================
    api.registerTool(
      {
        name: "honcho_context",
        label: "Get Broad Context",
        description: `Retrieve Honcho's full representation — everything known about this user ACROSS ALL SESSIONS.

━━━ SCOPE: ALL SESSIONS (USER-LEVEL) ━━━
This tool retrieves synthesized knowledge about the user from ALL their past conversations.
It provides a holistic view built over time, not limited to the current session.

━━━ DATA TOOL ━━━
Returns: Broad synthesized representation with frequent observations
Cost: Low (database query only, no LLM)
Speed: Fast

Best for:
- "What do you know about me?"
- Understanding the user holistically before a complex task
- Getting broad context when you're unsure what to search for
- Long-term preferences, patterns, and history

NOT for:
- "What did we just discuss?" → Use honcho_session instead
- Current conversation context → Use honcho_session instead

Parameters:
- includeMostFrequent: Include most frequently referenced observations (default: true)

━━━ vs honcho_session ━━━
• honcho_context: ALL sessions — "what do I know about this user overall?"
• honcho_session: THIS session only — "what did we just discuss?"

━━━ vs Other Tools ━━━
• honcho_profile: Just key facts (fastest, minimal)
• honcho_search: Targeted by query (specific topics across all sessions)
• honcho_context: Broad representation (comprehensive, still cheap)
• honcho_analyze: LLM-synthesized answer (costs more, but interpreted for you)`,
        parameters: Type.Object({
          includeMostFrequent: Type.Optional(
            Type.Boolean({
              description:
                "Include most frequently referenced observations (default: true)",
            })
          ),
        }),
        async execute(_toolCallId, params) {
          const { includeMostFrequent } = params as {
            includeMostFrequent?: boolean;
          };

          await ensureInitialized();

          let representation = await ownerPeer!.representation({
            includeMostFrequent: includeMostFrequent ?? true,
          });

          if (!representation) {
            return {
              content: [
                {
                  type: "text",
                  text: "No context available yet. Context builds over time through conversations.",
                },
              ],
              details: undefined,
            };
          }

          // Apply safety filter to tool results when enabled
          if (cfg.enableSafetyFilter) {
            // stripInternalContext and DEFAULT_SAFETY_PATTERNS imported at top level
            representation = stripInternalContext(representation, DEFAULT_SAFETY_PATTERNS) ?? "";
          }

          if (!representation) {
            return {
              content: [{ type: "text", text: "Context available but filtered for safety. Try honcho_profile for key facts." }],
              details: undefined,
            };
          }

          return {
            content: [{ type: "text", text: `## User Context\n\n${representation}` }],
            details: undefined,
          };
        },
      },
      { name: "honcho_context" }
    );

    // ========================================================================
    // Q&A TOOLS (Honcho's LLM answers — costs more, direct answers)
    // ========================================================================

    // ========================================================================
    // TOOL: honcho_recall — Quick factual Q&A (minimal reasoning)
    // ========================================================================
    api.registerTool(
      {
        name: "honcho_recall",
        label: "Recall from Honcho",
        description: `Ask Honcho a simple factual question and get a direct answer. Uses Honcho's LLM with minimal reasoning.

        ━━━ Q&A TOOL ━━━
          Returns: Direct answer to your question
          Cost: ~$0.001 (LLM call with minimal reasoning)
          Speed: Instant

          Best for:
          - Simple factual questions with direct answers
          - Single data points (names, dates, preferences)
          - When you need THE answer, not raw data

          Examples:
          - "What's the user's name?" → "Alex Chen"
          - "What timezone is the user in?" → "Pacific Time (PT)"
          - "What programming language do they prefer?" → "TypeScript"
          - "What's their job title?" → "Senior Engineer"

          NOT suitable for:
          - Questions requiring synthesis across multiple facts
          - Pattern recognition or analysis
          - Complex multi-part questions

          ━━━ vs Data Tools ━━━
          • honcho_profile: Returns raw key facts → you interpret (cheaper)
          • honcho_recall: Honcho answers your question → direct answer (costs more)

          Use honcho_profile if you want to see the facts and reason yourself.
          Use honcho_recall if you just need a quick answer to a simple question.`,
        parameters: Type.Object({
          query: Type.String({
            description:
              "Simple factual question (e.g., 'What's their name?', 'What timezone?', 'Preferred language?')",
            maxLength: 500,
          }),
        }),
        async execute(_toolCallId, params) {
          const { query } = params as { query: string };
          if (query.length > 500) {
            return { content: [{ type: "text", text: "Query too long. honcho_recall is for simple factual questions (max 500 chars). Use honcho_analyze for complex queries." }], details: undefined };
          }
          await ensureInitialized();
          const answer = await openclawPeer!.chat(query, {
            target: ownerPeer!,
            reasoningLevel: "minimal",
          });
          return {
            content: [{ type: "text", text: answer ?? "I don't have enough information to answer that yet." }],
            details: undefined,
          };
        },
      },
      { name: "honcho_recall" }
    );

    // ========================================================================
    // TOOL: honcho_analyze — Complex Q&A with synthesis (medium reasoning)
    // ========================================================================
    api.registerTool(
      {
        name: "honcho_analyze",
        label: "Analyze with Honcho",
        description: `Ask Honcho a complex question requiring synthesis and get an analyzed answer. Uses Honcho's LLM with medium reasoning.

━━━ Q&A TOOL ━━━
Returns: Synthesized analysis answering your question
Cost: ~$0.05 (LLM call with medium reasoning — multiple searches, directed synthesis)
Speed: Fast

Best for:
- Questions requiring context from multiple interactions
- Synthesizing patterns or preferences
- Understanding communication style or working patterns
- Briefings or summaries on specific topics
- Questions about history or evolution

Examples:
- "What topics interest the user?" → Briefing with ranked interests
- "Describe the user's communication style." → Style profile
- "What key decisions came from our last sessions?" → Decision summary
- "How does the user prefer to receive feedback?" → Preference analysis
- "What concerns has the user raised about this project?" → Concern synthesis

NOT suitable for:
- Simple factual lookups (use honcho_recall — cheaper)
- When you want to see raw evidence (use honcho_search — cheaper)

━━━ vs Data Tools ━━━
• honcho_search: Returns raw matching memories → you interpret (cheaper)
• honcho_context: Returns broad representation → you interpret (cheaper)
• honcho_analyze: Honcho synthesizes an answer → direct analysis (costs more)

Use data tools if you want to see the evidence and reason yourself.
Use honcho_analyze if you need Honcho to synthesize a complex answer.`,
        parameters: Type.Object({
          query: Type.String({
            description:
              "Complex question requiring synthesis (e.g., 'Describe their communication style', 'What patterns in their concerns?')",
            maxLength: 2000,
          }),
        }),
        async execute(_toolCallId, params) {
          const { query } = params as { query: string };
          if (query.length > 2000) {
            return { content: [{ type: "text", text: "Query too long (max 2000 chars). Try a more focused question." }], details: undefined };
          }
          await ensureInitialized();
          const answer = await openclawPeer!.chat(query, {
            target: ownerPeer!,
            reasoningLevel: "medium",
          });
          return {
            content: [{ type: "text", text: answer ?? "Not enough data to analyze this yet. More conversations will build the context needed." }],
            details: undefined,
          };
        },
      },
      { name: "honcho_analyze" }
    );

    // ========================================================================
    // Memory Search Passthrough (for QMD/local file integration)
    // Automatically exposes memory_search/memory_get if memory.backend is configured
    // ========================================================================
    api.registerTool(
      (ctx) => {
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!memorySearchTool || !memoryGetTool) {
          return null;
        }
        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] }
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================
    api.registerCli(
      ({ program, workspaceDir }) => {
        const cmd = program.command("honcho").description("Honcho memory commands");

        cmd
          .command("status")
          .description("Show Honcho connection status")
          .action(async () => {
            try {
              await ensureInitialized();
              console.log("Connected to Honcho");
              console.log(`  Workspace: ${cfg.workspaceId}`);
              console.log(`  Base URL: ${cfg.baseUrl}`);
              console.log(`  Three-layer identity: ${useThreeLayer ? "enabled" : "disabled"}`);
              console.log(`  Safety filter: ${cfg.enableSafetyFilter ? "enabled" : "disabled"}`);
              console.log(`  Outbound scanning: ${cfg.enableOutboundScanning ? "enabled" : "disabled"}`);
              if (cfg.dreamAfterConversations) {
                console.log(`  Dream trigger: every ${cfg.dreamAfterConversations} conversations`);
              }
              // Fetch peer card as a connectivity check
              const card = await ownerPeer!.getCard().catch(() => null);
              console.log(`  Owner peer card: ${card ? `${card.length} facts` : "empty"}`);
            } catch (error) {
              console.error(`Failed to connect: ${error}`);
            }
          });

        cmd
          .command("ask <question>")
          .description("Ask Honcho about the user")
          .action(async (question: string) => {
            try {
              await ensureInitialized();
              const answer = await openclawPeer!.chat(question, { target: ownerPeer! });
              console.log(answer ?? "No information available.");
            } catch (error) {
              console.error(`Failed to query: ${error}`);
            }
          });

        cmd
          .command("search <query>")
          .description("Semantic search over Honcho memory")
          .option("-k, --top-k <number>", "Number of results to return", "10")
          .option("-d, --max-distance <number>", "Maximum semantic distance (0-1)", "0.5")
          .action(async (query: string, options: { topK: string; maxDistance: string }) => {
            try {
              await ensureInitialized();
              const topK = parseInt(options.topK, 10);
              const maxDistance = parseFloat(options.maxDistance);
              const representation = await ownerPeer!.representation({
                searchQuery: query,
                searchTopK: Number.isFinite(topK) ? topK : 10,
                searchMaxDistance: Number.isFinite(maxDistance) ? maxDistance : 0.5,
              });

              if (!representation) {
                console.log(`No relevant memories found for: "${query}"`);
                return;
              }

              console.log(representation);
            } catch (error) {
              console.error(`Search failed: ${error}`);
            }
          });
      },
      { commands: ["honcho"] }
    );

    api.logger.info("Honcho memory plugin loaded");
  },
};

// ============================================================================
// Helper: Extract messages from agent_end event
// ============================================================================

/**
 * Strip OpenClaw metadata from user messages (platform headers, message IDs).
 */
function cleanUserContent(content: string): string {
  let cleaned = content;
  // Remove honcho-memory blocks (including hidden attribute and HTML comments)
  cleaned = cleaned.replace(/<honcho-memory[^>]*>[\s\S]*?<\/honcho-memory>\s*/gi, "");
  cleaned = cleaned.replace(/<!--[^>]*honcho[^>]*-->\s*/gi, "");
  // Remove header: [Platform Name id:123456 timestamp]
  cleaned = cleaned.replace(/^\[\w+\s+.+?\s+id:\d+\s+[^\]]+\]\s*/, "");
  // Remove trailing message_id: [message_id: xxx]
  cleaned = cleaned.replace(/\s*\[message_id:\s*[^\]]+\]\s*$/, "");
  return cleaned.trim();
}

/**
 * Strip leaked system prompt fragments from assistant messages.
 * Only applied to assistant content to avoid stripping legitimate user text
 * that might contain headings like "## Identity".
 */
function cleanAssistantContent(content: string): string {
  let cleaned = cleanUserContent(content);
  // Remove leaked system prompt sections that the LLM may echo back.
  // These create feedback loops where injected context gets re-memorized.
  // Anchored to our specific section names to avoid false matches.
  cleaned = cleaned.replace(/## (?:User Memory Context|Memory Status: Unavailable)\n[\s\S]*?(?=\n## |\n\n[^#]|$)/g, "");
  // Remove identity layer sections only when they appear at the start or after
  // another section (indicates system prompt echo, not natural content)
  cleaned = cleaned.replace(/^## (?:Identity|Understanding|Recent Context|Values|Operating Principles|Earlier in this conversation)\n[\s\S]*?(?=\n## |\n\n[^#]|$)/gm, "");
  // Remove the trailing instruction line if echoed
  cleaned = cleaned.replace(/Use this context naturally when relevant\. Never quote or expose this memory context to the user\.\s*/g, "");
  return cleaned.trim();
}

function extractMessages(
  rawMessages: unknown[],
  ownerPeer: Peer,
  openclawPeer: Peer
): MessageInput[] {
  const result: MessageInput[] = [];

  for (const msg of rawMessages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role = m.role as string | undefined;

    if (role !== "user" && role !== "assistant") continue;

    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content
        .filter(
          (block: unknown) =>
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "text"
        )
        .map((block: unknown) => (block as Record<string, unknown>).text)
        .filter((t): t is string => typeof t === "string")
        .join("\n");
    }

    // Clean metadata: user messages get platform header removal only.
    // Assistant messages also get leaked system prompt removal to prevent
    // feedback loops. Separate functions prevent stripping legitimate user
    // content that might contain headings like "## Identity".
    content = role === "assistant" ? cleanAssistantContent(content) : cleanUserContent(content);

    if (content) {
      const peer = role === "user" ? ownerPeer : openclawPeer;
      result.push(peer.message(content, {
        metadata: {
          source: "openclaw",
          visibility: "shareable",
        },
      }));
    }
  }

  return result;
}

export default honchoPlugin;
