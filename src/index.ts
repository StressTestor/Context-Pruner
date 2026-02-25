import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { resolveConfig, type ContextPrunerConfig } from "./config.js";
import { pruneMessages, estimateTokens, importanceDistribution } from "./pruner.js";
import { scoreMessage, type Message } from "./scorer.js";
import { readFileSync } from "node:fs";

let cfg: ContextPrunerConfig;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ── Module-scope cache for last known state ─────────────────────────
// Populated by hooks so tools/commands can report stats without needing
// direct message access (which the SDK doesn't provide).

interface CachedState {
  messages: Message[];
  sessionFile?: string;
  timestamp: number;
}

let lastState: CachedState | null = null;

/**
 * Parse a JSONL session file into Message[].
 * Each line is a JSON object with at least { role, content? }.
 * Lines that fail to parse are silently skipped.
 */
function readSessionMessages(sessionFile: string): Message[] {
  try {
    const raw = readFileSync(sessionFile, "utf-8");
    const messages: Message[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && obj.role) {
          messages.push(obj as Message);
        }
      } catch {
        // skip malformed lines
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/**
 * Get messages from the best available source:
 * 1. Direct event data (if provided)
 * 2. Session file (read from disk)
 * 3. Cached state from last hook invocation
 */
function getMessages(eventMessages?: unknown[], sessionFile?: string): Message[] {
  if (eventMessages && eventMessages.length > 0) return eventMessages as Message[];
  if (sessionFile) {
    const msgs = readSessionMessages(sessionFile);
    if (msgs.length > 0) return msgs;
  }
  if (lastState) return lastState.messages;
  return [];
}

const plugin = {
  id: "context-pruner",
  name: "Context Pruner",
  description: "intelligent context pruning — keeps decisions, code, and preferences. drops fluff.",

  register(api: OpenClawPluginApi) {
    cfg = resolveConfig(api.pluginConfig as Record<string, unknown> | undefined);
    api.logger.info(`context-pruner: initialized (max: ${cfg.maxMessages}, target: ${cfg.targetMessages}, auto: ${cfg.autoPrune})`);

    // ── Tools ─────────────────────────────────────────────────────────

    api.registerTool(
      {
        name: "context_stats",
        label: "Context Stats",
        description: "Show current context size, message count, estimated tokens, and importance distribution.",
        parameters: Type.Object({}),
        async execute(_toolCallId: string, _params: Record<string, unknown>) {
          const messages = lastState?.messages ?? [];
          const count = messages.length;
          const tokens = estimateTokens(messages);
          const dist = importanceDistribution(messages);

          const lines = [
            `messages: ${count}`,
            `estimated tokens: ${formatTokens(tokens)}`,
            `threshold: ${cfg.maxMessages} (prune to ${cfg.targetMessages})`,
            `auto-prune: ${cfg.autoPrune ? "on" : "off"}`,
            `data source: ${lastState ? "last hook snapshot" : "none (no data yet)"}`,
            "",
            "importance distribution:",
            `  critical (0.75-1.0): ${dist.critical}`,
            `  high     (0.55-0.74): ${dist.high}`,
            `  medium   (0.3-0.54): ${dist.medium}`,
            `  low      (0-0.29): ${dist.low}`,
          ];

          if (count > cfg.maxMessages) {
            lines.push("", `status: over threshold by ${count - cfg.maxMessages} messages`);
          } else if (count > 0) {
            lines.push("", `status: ${cfg.maxMessages - count} messages until auto-prune triggers`);
          }

          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: null,
          };
        },
      },
      { name: "context_stats" },
    );

    api.registerTool(
      {
        name: "context_prune",
        label: "Prune Context (Dry Run)",
        description: "Analyze what would be pruned from context. Reports removable messages by importance score. Actual pruning happens automatically via compaction hooks.",
        parameters: Type.Object({
          aggressiveness: Type.Optional(
            Type.Number({
              description: "How aggressive to prune (0.5 = gentle, 1.0 = normal, 2.0 = aggressive)",
              default: 1.0,
              minimum: 0.5,
              maximum: 3.0,
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const messages = lastState?.messages ?? [];

          if (messages.length === 0) {
            return {
              content: [{ type: "text" as const, text: "no message data available. stats populate after the first compaction or agent start event." }],
              details: null,
            };
          }

          const aggressiveness = (params.aggressiveness as number) ?? 1.0;
          const result = pruneMessages(messages, cfg, aggressiveness);

          if (result.removedCount === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `nothing to prune. ${messages.length} messages, all within threshold.`,
                },
              ],
              details: null,
            };
          }

          const tokensBefore = estimateTokens(messages);
          const tokensAfter = estimateTokens(result.kept);

          const lines = [
            `would prune ${result.removedCount} of ${result.originalCount} messages`,
            `would keep: ${result.kept.length}`,
            `token estimate: ${formatTokens(tokensBefore)} -> ${formatTokens(tokensAfter)} (would save ~${formatTokens(tokensBefore - tokensAfter)})`,
            `removed score range: ${result.removedScores.min.toFixed(2)} - ${result.removedScores.max.toFixed(2)} (avg ${result.removedScores.avg.toFixed(2)})`,
            "",
            "note: actual pruning happens automatically during compaction via prependContext injection.",
          ];

          api.logger.info(`context-pruner: dry-run would remove ${result.removedCount} messages (${formatTokens(tokensBefore - tokensAfter)} tokens)`);

          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: null,
          };
        },
      },
      { name: "context_prune" },
    );

    // ── Hooks ─────────────────────────────────────────────────────────

    // before_agent_start: analyze messages and inject a prependContext summary
    // if context is bloated, guiding the agent to request compaction.
    api.on("before_agent_start", async (event) => {
      try {
        const messages = (event.messages ?? []) as Message[];

        // Cache for tools/commands
        lastState = { messages, timestamp: Date.now() };

        if (!cfg.autoPrune) return;
        if (messages.length <= cfg.maxMessages) return;

        // We can't mutate messages directly. Instead, inject a prependContext
        // that summarizes the situation and tells the agent context is heavy.
        const result = pruneMessages(messages, cfg);
        const tokensBefore = estimateTokens(messages);
        const tokensAfter = estimateTokens(result.kept);

        const summary = [
          `[context-pruner] context is at ${messages.length} messages (~${formatTokens(tokensBefore)} tokens), above threshold of ${cfg.maxMessages}.`,
          `${result.removedCount} low-importance messages identified (score range: ${result.removedScores.min.toFixed(2)}-${result.removedScores.max.toFixed(2)}).`,
          `potential savings: ~${formatTokens(tokensBefore - tokensAfter)} tokens.`,
          `compaction recommended.`,
        ].join(" ");

        api.logger.info(`context-pruner: injecting prependContext (${messages.length} msgs over threshold)`);

        return { prependContext: summary };
      } catch (e: any) {
        api.logger.warn(`context-pruner: before_agent_start failed: ${e.message}`);
      }
    });

    // before_compaction: read-only analysis, cache state for tools
    api.on("before_compaction", async (event) => {
      try {
        const messages = getMessages(event.messages, event.sessionFile);
        lastState = {
          messages,
          sessionFile: event.sessionFile,
          timestamp: Date.now(),
        };

        if (messages.length > 0) {
          const dist = importanceDistribution(messages);
          api.logger.info(
            `context-pruner: pre-compaction snapshot — ${messages.length} msgs, ` +
            `${dist.low} low / ${dist.medium} med / ${dist.high} high / ${dist.critical} critical`,
          );
        }
      } catch (e: any) {
        api.logger.warn(`context-pruner: before_compaction failed: ${e.message}`);
      }
    });

    // tool_result_persist: slim down tool results before they're written to the session
    api.on("tool_result_persist", async (event) => {
      try {
        // Trim excessively large tool outputs to save context space
        const msg = event.message as any;
        if (msg?.content && Array.isArray(msg.content)) {
          let modified = false;
          for (const part of msg.content) {
            if (part.type === "text" && typeof part.text === "string" && part.text.length > 5000) {
              const text = part.text;
              const head = text.slice(0, 2000);
              const tail = text.slice(-1000);
              part.text = `${head}\n\n... [context-pruner: truncated ${formatTokens(Math.ceil((text.length - 3000) / 4))} tokens] ...\n\n${tail}`;
              modified = true;
            }
          }
          if (modified) return { message: msg };
        }
      } catch (e: any) {
        api.logger.warn(`context-pruner: tool_result_persist failed: ${e.message}`);
      }
    });

    // ── Slash Commands ────────────────────────────────────────────────

    api.registerCommand({
      name: "prune",
      description: "Quick context analysis — shows what would be pruned",
      acceptsArgs: true,
      handler: async (ctx: { args?: string; channel: any; config: any; senderId?: string; isAuthorizedSender: boolean; commandBody: string }) => {
        const messages = lastState?.messages ?? [];

        if (messages.length === 0) {
          return { text: "no message data yet. stats populate after first agent start or compaction." };
        }

        const aggressiveness = ctx.args ? parseFloat(ctx.args) || 1.0 : 1.0;
        const result = pruneMessages(messages, cfg, aggressiveness);

        if (result.removedCount === 0) {
          return {
            text: `nothing to prune. ${messages.length} messages, all within threshold.`,
          };
        }

        const tokensBefore = estimateTokens(messages);
        const tokensAfter = estimateTokens(result.kept);

        return {
          text: `would prune ${result.removedCount} messages. ${result.kept.length} would remain. potential savings: ~${formatTokens(tokensBefore - tokensAfter)} tokens.`,
        };
      },
    });

    // ── CLI ────────────────────────────────────────────────────────────

    api.registerCli(
      ({ program }: any) => {
        const ctx = program.command("context").description("Context pruning commands");

        ctx
          .command("stats")
          .description("Show context stats from a session file")
          .argument("[session-file]", "Path to JSONL session file")
          .action((sessionFile: string | undefined) => {
            const messages = sessionFile ? readSessionMessages(sessionFile) : (lastState?.messages ?? []);
            const count = messages.length;
            const tokens = estimateTokens(messages);
            const dist = importanceDistribution(messages);

            console.log(`Messages: ${count}`);
            console.log(`Estimated tokens: ${formatTokens(tokens)}`);
            console.log(`Threshold: ${cfg.maxMessages} (target: ${cfg.targetMessages})`);
            console.log(`\nImportance distribution:`);
            console.log(`  Critical: ${dist.critical}`);
            console.log(`  High:     ${dist.high}`);
            console.log(`  Medium:   ${dist.medium}`);
            console.log(`  Low:      ${dist.low}`);

            if (count > cfg.maxMessages) {
              console.log(`\nOver threshold by ${count - cfg.maxMessages} messages`);
            }
          });

        ctx
          .command("prune")
          .description("Dry-run prune analysis on a session file")
          .argument("[session-file]", "Path to JSONL session file")
          .option("--aggressive <n>", "Aggressiveness (0.5-3.0)", "1.0")
          .action((sessionFile: string | undefined, opts: any) => {
            const messages = sessionFile ? readSessionMessages(sessionFile) : (lastState?.messages ?? []);

            if (messages.length === 0) {
              console.log("No messages.");
              return;
            }

            const aggressiveness = parseFloat(opts.aggressive);
            const result = pruneMessages(messages, cfg, aggressiveness);

            if (result.removedCount === 0) {
              console.log(`Nothing to prune. ${messages.length} messages within threshold.`);
              return;
            }

            console.log(`Would remove ${result.removedCount} of ${result.originalCount} messages`);
            console.log(`Score range: ${result.removedScores.min.toFixed(2)} - ${result.removedScores.max.toFixed(2)}`);

            const tokensBefore = estimateTokens(messages);
            const tokensAfter = estimateTokens(result.kept);
            console.log(`Tokens: ${formatTokens(tokensBefore)} -> ${formatTokens(tokensAfter)}`);
          });

        ctx
          .command("score")
          .description("Score a specific message by index from a session file")
          .argument("<index>", "Message index")
          .argument("[session-file]", "Path to JSONL session file")
          .action((index: string, sessionFile: string | undefined) => {
            const messages = sessionFile ? readSessionMessages(sessionFile) : (lastState?.messages ?? []);
            const i = parseInt(index);

            if (messages.length === 0) {
              console.log("No messages available.");
              return;
            }

            if (i < 0 || i >= messages.length) {
              console.log(`Invalid index. Messages: 0-${messages.length - 1}`);
              return;
            }

            const msg = messages[i];
            const score = scoreMessage(msg);
            console.log(`Message ${i} (${msg.role}): score ${score.toFixed(3)}`);
          });
      },
      { commands: ["context"] },
    );

    // ── Service ───────────────────────────────────────────────────────

    api.registerService({
      id: "context-pruner",
      start: async () => {
        api.logger.info("context-pruner: service started");
      },
      stop: async () => {
        api.logger.info("context-pruner: stopped");
      },
    });
  },
};

export default plugin;
