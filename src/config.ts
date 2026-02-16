export interface ContextPrunerConfig {
  maxMessages: number;
  targetMessages: number;
  minImportance: number;
  preserveRecent: number;
  preserveFirst: number;
  autoPrune: boolean;
}

const DEFAULTS: ContextPrunerConfig = {
  maxMessages: 100,
  targetMessages: 60,
  minImportance: 0.3,
  preserveRecent: 10,
  preserveFirst: 3,
  autoPrune: true,
};

export function resolveConfig(
  raw: Record<string, unknown> | undefined,
): ContextPrunerConfig {
  const cfg: ContextPrunerConfig = { ...DEFAULTS };

  if (!raw) return cfg;

  if (typeof raw.maxMessages === "number" && raw.maxMessages >= 20)
    cfg.maxMessages = raw.maxMessages;
  if (typeof raw.targetMessages === "number" && raw.targetMessages >= 10)
    cfg.targetMessages = raw.targetMessages;
  if (typeof raw.minImportance === "number" && raw.minImportance >= 0 && raw.minImportance <= 1)
    cfg.minImportance = raw.minImportance;
  if (typeof raw.preserveRecent === "number" && raw.preserveRecent >= 1)
    cfg.preserveRecent = raw.preserveRecent;
  if (typeof raw.preserveFirst === "number" && raw.preserveFirst >= 1)
    cfg.preserveFirst = raw.preserveFirst;
  if (typeof raw.autoPrune === "boolean")
    cfg.autoPrune = raw.autoPrune;

  // Validate constraints
  if (cfg.maxMessages <= cfg.targetMessages) {
    cfg.maxMessages = cfg.targetMessages + 40;
  }
  if (cfg.preserveRecent >= cfg.targetMessages) {
    cfg.preserveRecent = Math.max(1, cfg.targetMessages - 5);
  }
  if (cfg.preserveFirst + cfg.preserveRecent >= cfg.targetMessages) {
    cfg.preserveFirst = Math.max(1, cfg.targetMessages - cfg.preserveRecent - 5);
  }

  return cfg;
}
