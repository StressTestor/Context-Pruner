/**
 * Message importance scoring.
 *
 * Each message gets a 0-1 score. Higher = more important = keep.
 * All scoring is local — regex and heuristics only, no API calls.
 */

export interface Message {
  role: string;
  content?: string | Array<{ type: string; text?: string }>;
  tool_call_id?: string;
  tool_calls?: unknown[];
  name?: string;
}

// Low-value patterns — short acks, greetings
const LOW_VALUE_PATTERNS = [
  /^(ok|okay|k|sure|thanks|thank you|got it|sounds good|yep|yes|no|nope|alright|cool|nice|great|perfect|understood|ack|ty|thx|np|mhm|yup|ya|right)\.?$/i,
  /^(hi|hello|hey|good morning|good afternoon|good evening|howdy|yo|sup)\.?$/i,
];

// High-value: decisions and preferences
const DECISION_PATTERNS = [
  /\b(always|never|prefer|must|should not|don't ever|do not|use .+ instead)\b/i,
  /\b(decision|decided|let's go with|going with|settled on|the plan is)\b/i,
  /\b(requirement|constraint|rule|convention|standard)\b/i,
];

// High-value: code
const CODE_BLOCK = /```[\s\S]*?```/;
const INLINE_CODE_HEAVY = /`[^`]+`/g;

// Medium-high: errors
const ERROR_PATTERNS = [
  /\b(error|exception|traceback|stack trace|failed|failure|crash|panic|segfault)\b/i,
  /at .+:\d+:\d+/,  // stack trace lines
  /^\s*(at|in|from) .+\.(ts|js|py|go|rs|java|rb|c|cpp|h):\d+/m,
];

// Medium: references
const REFERENCE_PATTERNS = [
  /https?:\/\/\S+/,
  /(?:\/[\w.-]+){2,}/,  // file paths like /foo/bar/baz
];

function extractText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join("\n");
  }
  return "";
}

export function scoreMessage(msg: Message): number {
  const text = extractText(msg);

  // Non-text content (images, etc.) — score as medium, don't crash
  if (!text && msg.content) return 0.5;

  // Empty message
  if (!text) return 0.1;

  // Tool results — check for repetitiveness later in pruner,
  // base score is medium
  if (msg.role === "tool") return 0.45;

  // Tool calls — keep them (they pair with results)
  if (msg.tool_calls && msg.tool_calls.length > 0) return 0.5;

  let score = 0.4; // baseline

  // Check low-value patterns first
  const trimmed = text.trim();
  for (const pat of LOW_VALUE_PATTERNS) {
    if (pat.test(trimmed)) return 0.1;
  }

  // Short messages without substance
  if (trimmed.length < 20 && !CODE_BLOCK.test(trimmed)) {
    score = Math.max(score - 0.15, 0.15);
  }

  // Code blocks — high value
  if (CODE_BLOCK.test(text)) {
    score = Math.max(score, 0.8);
  }

  // Heavy inline code usage (3+ inline code spans)
  const inlineMatches = text.match(INLINE_CODE_HEAVY);
  if (inlineMatches && inlineMatches.length >= 3) {
    score = Math.max(score, 0.65);
  }

  // Decisions and preferences
  for (const pat of DECISION_PATTERNS) {
    if (pat.test(text)) {
      score = Math.max(score, 0.75);
      break;
    }
  }

  // Errors and stack traces
  for (const pat of ERROR_PATTERNS) {
    if (pat.test(text)) {
      score = Math.max(score, 0.65);
      break;
    }
  }

  // URLs and file paths
  for (const pat of REFERENCE_PATTERNS) {
    if (pat.test(text)) {
      score = Math.max(score, 0.55);
      break;
    }
  }

  // Long messages tend to have more substance
  if (text.length > 500) {
    score = Math.max(score, 0.55);
  }
  if (text.length > 2000) {
    score = Math.max(score, 0.65);
  }

  // System messages — contextual, scored by recency in pruner
  if (msg.role === "system") {
    score = Math.max(score, 0.5);
  }

  // User messages get a slight boost — they represent intent
  if (msg.role === "user") {
    score = Math.min(score + 0.1, 1.0);
  }

  return Math.min(score, 1.0);
}

/**
 * Detect repetitive consecutive tool outputs.
 * Returns indices of messages that are near-duplicates of their predecessor.
 */
export function findRepetitiveToolOutputs(messages: Message[]): Set<number> {
  const repetitive = new Set<number>();

  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role !== "tool" || messages[i - 1].role !== "tool") continue;

    const a = extractText(messages[i - 1]);
    const b = extractText(messages[i]);

    if (!a || !b) continue;

    // Simple similarity: if messages share >80% of their first 200 chars
    const aSlice = a.slice(0, 200);
    const bSlice = b.slice(0, 200);

    if (aSlice === bSlice) {
      repetitive.add(i);
      continue;
    }

    // Check structural similarity — same keys/shape
    const aLines = new Set(a.split("\n").slice(0, 5).map((l) => l.replace(/[\d.]+/g, "N")));
    const bLines = new Set(b.split("\n").slice(0, 5).map((l) => l.replace(/[\d.]+/g, "N")));

    let overlap = 0;
    for (const line of aLines) {
      if (bLines.has(line)) overlap++;
    }

    if (aLines.size > 0 && overlap / aLines.size > 0.8) {
      repetitive.add(i);
    }
  }

  return repetitive;
}

export { extractText };
