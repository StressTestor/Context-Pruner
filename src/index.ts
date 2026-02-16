import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { resolveConfig, type ContextPrunerConfig } from "./config.js";
import { pruneMessages, estimateTokens, importanceDistribution } from "./pruner.js";
import { scoreMessage, type Message } from "./scorer.js";

let cfg: ContextPrunerConfig;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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
          const messages: Message[] = api.getMessages?.() ?? [];
          const count = messages.length;
          const tokens = estimateTokens(messages);
          const dist = importanceDistribution(messages);

          const lines = [
            `messages: ${count}`,
            `estimated tokens: ${formatTokens(tokens)}`,
            `threshold: ${cfg.maxMessages} (prune to ${cfg.targetMessages})`,
            `auto-prune: ${cfg.autoPrune ? "on" : "off"}`,
            "",
            "importance distribution:",
            `  critical (0.75-1.0): ${dist.critical}`,
            `  high     (0.55-0.74): ${dist.high}`,
            `  medium   (0.3-0.54): ${dist.medium}`,
            `  low      (0-0.29): ${dist.low}`,
          ];

          if (count > cfg.maxMessages) {
            lines.push("", `status: over threshold by ${count - cfg.maxMessages} messages`);
          } else {
            lines.push("", `status: ${cfg.maxMessages - count} messages until auto-prune triggers`);
          }

          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
          };
        },
      },
      { name: "context_stats" },
    );

    api.registerTool(
      {
        name: "context_prune",
        label: "Prune Context",
        description: "Manually trigger context pruning. Removes low-importance messages while preserving decisions, code, and recent context.",
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
          const messages: Message[] = api.getMessages?.() ?? [];

          if (messages.length === 0) {
            return {
              content: [{ type: "text" as const, text: "no messages to prune." }],
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
            };
          }

          // Apply the pruned messages
          api.setMessages?.(result.kept);

          const tokensBefore = estimateTokens(messages);
          const tokensAfter = estimateTokens(result.kept);

          const lines = [
            `pruned ${result.removedCount} of ${result.originalCount} messages`,
            `kept: ${result.kept.length}`,
            `tokens: ${formatTokens(tokensBefore)} -> ${formatTokens(tokensAfter)} (saved ~${formatTokens(tokensBefore - tokensAfter)})`,
            `removed score range: ${result.removedScores.min.toFixed(2)} - ${result.removedScores.max.toFixed(2)} (avg ${result.removedScores.avg.toFixed(2)})`,
          ];

          api.logger.info(`context-pruner: removed ${result.removedCount} messages (${formatTokens(tokensBefore - tokensAfter)} tokens saved)`);

          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
          };
        },
      },
      { name: "context_prune" },
    );

    // ── Hooks ─────────────────────────────────────────────────────────

    api.on("before_agent_start", async (_event: any) => {
      try {
        if (!cfg.autoPrune) return;

        const messages: Message[] = api.getMessages?.() ?? [];
        if (messages.length <= cfg.maxMessages) return;

        const result = pruneMessages(messages, cfg);

        if (result.removedCount > 0) {
          api.setMessages?.(result.kept);
          api.logger.info(
            `context-pruner: auto-pruned ${result.removedCount} messages (${messages.length} -> ${result.kept.length})`,
          );
        }
      } catch (e: any) {
        api.logger.warn(`context-pruner: auto-prune failed: ${e.message}`);
      }
    });

    // ── Slash Commands ────────────────────────────────────────────────

    api.registerCommand({
      name: "prune",
      description: "Quick manual context prune",
      acceptsArgs: true,
      handler: async (args?: string) => {
        const messages: Message[] = api.getMessages?.() ?? [];

        if (messages.length === 0) {
          return { text: "no messages to prune." };
        }

        const aggressiveness = args ? parseFloat(args) || 1.0 : 1.0;
        const result = pruneMessages(messages, cfg, aggressiveness);

        if (result.removedCount === 0) {
          return {
            text: `nothing to prune. ${messages.length} messages, all within threshold.`,
          };
        }

        api.setMessages?.(result.kept);

        const tokensBefore = estimateTokens(messages);
        const tokensAfter = estimateTokens(result.kept);

        return {
          text: `pruned ${result.removedCount} messages. ${result.kept.length} remaining. saved ~${formatTokens(tokensBefore - tokensAfter)} tokens.`,
        };
      },
    });

    // ── CLI ────────────────────────────────────────────────────────────

    api.registerCli(
      ({ program }: any) => {
        const ctx = program.command("context").description("Context pruning commands");

        ctx
          .command("stats")
          .description("Show context stats for the active session")
          .action(() => {
            const messages: Message[] = api.getMessages?.() ?? [];
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
          .description("Manually prune context")
          .option("--aggressive <n>", "Aggressiveness (0.5-3.0)", "1.0")
          .option("--dry-run", "Show what would be pruned without pruning")
          .action((opts: any) => {
            const messages: Message[] = api.getMessages?.() ?? [];

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

            if (opts.dryRun) {
              console.log(`Would remove ${result.removedCount} of ${result.originalCount} messages`);
              console.log(`Score range: ${result.removedScores.min.toFixed(2)} - ${result.removedScores.max.toFixed(2)}`);
              return;
            }

            api.setMessages?.(result.kept);
            const tokensBefore = estimateTokens(messages);
            const tokensAfter = estimateTokens(result.kept);
            console.log(`Pruned ${result.removedCount} messages. ${result.kept.length} remaining.`);
            console.log(`Tokens: ${formatTokens(tokensBefore)} -> ${formatTokens(tokensAfter)}`);
          });

        ctx
          .command("score")
          .description("Score a specific message by index")
          .argument("<index>", "Message index")
          .action((index: string) => {
            const messages: Message[] = api.getMessages?.() ?? [];
            const i = parseInt(index);

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
