import type { AgentMessage } from "@mariozechner/pi-coding-agent";

export interface DCPConfig {
  enabled: boolean;
  mode: "safe" | "advanced";
  debug: boolean;
  turnProtection: {
    enabled: boolean;
    turns: number;
  };
  thresholds: {
    nudge: number;
    autoPrune: number;
    forceCompact: number;
  };
  protectedTools: string[];
  protectedFilePatterns: string[];
  strategies: {
    deduplicate: { enabled: boolean };
    purgeErrors: { enabled: boolean; minTurnAge: number };
    outputBodyReplace: { enabled: boolean; minChars: number };
    supersedeWrites: { enabled: boolean };
  };
  advanced: {
    distillTool: { enabled: boolean };
    compressTool: { enabled: boolean };
    llmAutonomy: boolean;
  };
}

export interface DCPSessionState {
  stats: {
    tokensSavedEstimate: number;
    prunedItemsCount: Record<string, number>;
    protectedSkipCount: number;
  };
}
