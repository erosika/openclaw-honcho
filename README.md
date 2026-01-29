# Honcho Memory Plugin for Moltbot

AI-native memory with dialectic reasoning for Moltbot. Uses [Honcho's](https://honcho.dev) peer paradigm to build and maintain separate models of the user and the agent — enabling context-aware conversations that improve over time. No local infrastructure required.

## Install

```bash
moltbot plugins install @plastic-labs/moltbot-honcho
```

Restart Moltbot after installing.

## Configuration

The only required value is your Honcho API key. Get one at [honcho.dev](https://honcho.dev).

Set it as an environment variable:

```bash
export HONCHO_API_KEY="hc_..."
```

Or configure it directly in `moltbot.json`:

```json5
{
  "plugins": {
    "entries": {
      "moltbot-honcho": {
        "enabled": true,
        "config": {
          "apiKey": "${HONCHO_API_KEY}"
        }
      }
    }
  }
}
```

### Advanced options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `workspaceId` | `string` | `"moltbot"` | Honcho workspace ID for memory isolation. |
| `baseUrl` | `string` | `"https://api.honcho.dev"` | API endpoint (for self-hosted instances). |
| `syncOnStartup` | `boolean` | `true` | Sync Honcho representations to workspace files on startup. |
| `dailySyncEnabled` | `boolean` | `true` | Enable periodic sync of representations to files. |
| `syncFrequency` | `number` | `60` | Sync interval in minutes (1-1440). |

## How it works

Once installed, the plugin works automatically:

- **Context Injection** — Before every AI turn, the plugin queries Honcho's dialectic chat endpoint for relevant context about the user. The AI receives reasoning-based insights, not just raw memories.
- **Message Observation** — After every AI turn, the conversation is persisted to Honcho. Both user and agent messages are observed, allowing Honcho to build and refine its models.
- **Dual Peer Model** — Honcho maintains separate representations: one for the user (preferences, facts, communication style) and one for the agent (personality, learned behaviors).

Honcho handles all reasoning and synthesis in the cloud.

## Workspace Files

The plugin writes three markdown files to your workspace:

| File | Contents |
|------|----------|
| `USER.md` | User profile — facts and observations about the owner. |
| `SOUL.md` | Agent profile — Moltbot's self-model and characteristics. |
| `MEMORY.md` | Combined view of both peer representations. |

These files sync automatically and can be read by other tools in your workspace.

## AI Tools

| Tool | Description |
|------|-------------|
| `honcho_ask` | Query Honcho about the user mid-conversation (e.g., "What's their preferred communication style?"). |

## CLI Commands

```bash
moltbot honcho status           # Show connection status and representation sizes
moltbot honcho ask <question>   # Query Honcho about the user
moltbot honcho sync             # Manually sync representations to workspace files
```
