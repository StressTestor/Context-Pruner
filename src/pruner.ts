/**
 * Context pruning logic.
 *
 * Takes a conversation, scores every message, and removes the least
 * important ones while respecting constraints (preserve first/last N,
 * keep tool call/result pairs together, never orphan messages).
 */

import type { ContextPrunerConfig } from "./config.js";
import { scoreMessage, findRepetitiveToolOutputs, type Message } from "./scorer.js";

export interface PruneResult {
  /** Messages to keep, in original order */
  kept: Message[];
  /** Number of messages removed */
  removedCount: number;
  /** Total messages before pruning */
  originalCount: number;
  /** Score distribution of removed messages */
  removedScores: { min: number; max: number; avg: number };
}

interface ScoredMessage {
  index: number;
  message: Message;
  score: number;
  protected: boolean;
}

/**
 * Build a set of indices that are "paired" — tool calls and their results
 * must be kept or removed together.
 */
/**
 * Build a map of paired indices. An assistant message with multiple tool_calls
 * maps to a Set of all its tool result indices, and each result maps back to
 * a Set containing the assistant index. This avoids the old bug where a single
 * Map<number, number> would overwrite earlier pairings.
 */
function buildToolPairs(messages: Message[]): Map<number, Set<number>> {
  const pairs = new Map<number, Set<number>>();

  function link(a: number, b: number) {
    if (!pairs.has(a)) pairs.set(a, new Set());
    if (!pairs.has(b)) pairs.set(b, new Set());
    pairs.get(a)!.add(b);
    pairs.get(b)!.add(a);
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // If this is a tool result, find its call
    if (msg.role === "tool" && msg.tool_call_id) {
      for (let j = i - 1; j >= 0; j--) {
        const candidate = messages[j];
        if (
          candidate.tool_calls &&
          Array.isArray(candidate.tool_calls) &&
          candidate.tool_calls.some(
            (tc: any) => tc.id === msg.tool_call_id,
          )
        ) {
          link(i, j);
          break;
        }
      }
    }
  }

  return pairs;
}

export function pruneMessages(
  messages: Message[],
  config: ContextPrunerConfig,
  aggressiveness: number = 1.0,
): PruneResult {
  const total = messages.length;

  // Nothing to do
  if (total === 0) {
    return {
      kept: [],
      removedCount: 0,
      originalCount: 0,
      removedScores: { min: 0, max: 0, avg: 0 },
    };
  }

  // Adjust target based on aggressiveness (0.5 = gentle, 2.0 = aggressive)
  const effectiveTarget = Math.max(
    config.preserveFirst + config.preserveRecent + 1,
    Math.round(config.targetMessages / aggressiveness),
  );

  // If we're already under target, nothing to do
  if (total <= effectiveTarget) {
    return {
      kept: [...messages],
      removedCount: 0,
      originalCount: total,
      removedScores: { min: 0, max: 0, avg: 0 },
    };
  }

  const toolPairs = buildToolPairs(messages);
  const repetitive = findRepetitiveToolOutputs(messages);

  // Score and tag every message
  const scored: ScoredMessage[] = messages.map((msg, i) => {
    let score = scoreMessage(msg);

    // Penalize repetitive tool outputs
    if (repetitive.has(i)) {
      score = Math.min(score, 0.2);
    }

    // Protected: first N, last N, and the very last message (current user msg)
    const isFirst = i < config.preserveFirst;
    const isRecent = i >= total - config.preserveRecent;
    const isLast = i === total - 1;

    return {
      index: i,
      message: msg,
      score,
      protected: isFirst || isRecent || isLast,
    };
  });

  // Collect prunable messages sorted by score (lowest first).
  // Messages below minImportance are sorted to the front so they get pruned first.
  const prunable = scored
    .filter((s) => !s.protected)
    .sort((a, b) => {
      const aBelowMin = a.score < config.minImportance ? 0 : 1;
      const bBelowMin = b.score < config.minImportance ? 0 : 1;
      if (aBelowMin !== bBelowMin) return aBelowMin - bBelowMin;
      return a.score - b.score;
    });

  const toRemove = new Set<number>();
  const needToRemove = total - effectiveTarget;

  for (const candidate of prunable) {
    if (toRemove.size >= needToRemove) break;

    // Skip if already marked
    if (toRemove.has(candidate.index)) continue;

    // If this message is part of a tool pair, remove all paired indices or skip
    const pairedIndices = toolPairs.get(candidate.index);
    if (pairedIndices !== undefined && pairedIndices.size > 0) {
      // Don't remove if any paired message is protected
      const anyProtected = [...pairedIndices].some((idx) => scored[idx].protected);
      if (anyProtected) continue;

      toRemove.add(candidate.index);
      for (const idx of pairedIndices) {
        toRemove.add(idx);
        // Also remove anything paired to the paired index (transitive closure)
        const transitive = toolPairs.get(idx);
        if (transitive) {
          for (const t of transitive) {
            if (!scored[t].protected) toRemove.add(t);
          }
        }
      }
      // Pair removal may overshoot needToRemove by a few messages — that's
      // acceptable since orphaned tool calls/results would be worse.
      if (toRemove.size >= needToRemove) break;
    } else {
      toRemove.add(candidate.index);
    }
  }

  // Build result
  const kept: Message[] = [];
  const removedScoresArr: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (toRemove.has(i)) {
      removedScoresArr.push(scored[i].score);
    } else {
      kept.push(messages[i]);
    }
  }

  let removedScores = { min: 0, max: 0, avg: 0 };
  if (removedScoresArr.length > 0) {
    let min = removedScoresArr[0];
    let max = removedScoresArr[0];
    let sum = 0;
    for (const s of removedScoresArr) {
      if (s < min) min = s;
      if (s > max) max = s;
      sum += s;
    }
    removedScores = { min, max, avg: sum / removedScoresArr.length };
  }

  return {
    kept,
    removedCount: toRemove.size,
    originalCount: total,
    removedScores,
  };
}

/**
 * Estimate token count from messages. Rough heuristic — ~4 chars per token.
 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) chars += part.text.length;
        if (part.type === "image_url" || part.type === "image") chars += 1000; // rough estimate
      }
    }
    chars += 10; // role/metadata overhead
  }
  return Math.ceil(chars / 4);
}

/**
 * Get importance distribution for stats display.
 */
export function importanceDistribution(
  messages: Message[],
): { low: number; medium: number; high: number; critical: number } {
  const dist = { low: 0, medium: 0, high: 0, critical: 0 };

  for (const msg of messages) {
    const score = scoreMessage(msg);
    if (score < 0.3) dist.low++;
    else if (score < 0.55) dist.medium++;
    else if (score < 0.75) dist.high++;
    else dist.critical++;
  }

  return dist;
}
