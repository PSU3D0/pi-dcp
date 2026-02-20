import type { AgentMessage } from "@mariozechner/pi-coding-agent";
import type { DCPConfig, DCPSessionState } from "../types";
import { estimateTokens } from "../utils";

export function applyPurgeErrors(
  messages: AgentMessage[],
  config: DCPConfig,
  state: DCPSessionState,
  turnAges: number[]
): void {
  if (!config.strategies.purgeErrors.enabled) return;

  const minTurnAge = config.strategies.purgeErrors.minTurnAge;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const turnAge = turnAges[i];

    if (msg.role === "toolResult" && msg.isError) {
      if (turnAge < minTurnAge) continue;
      if (config.protectedTools.includes(msg.toolName)) {
        state.stats.protectedSkipCount++;
        continue;
      }

      // Check if it's already a DCP placeholder
      if (msg.content.length === 1 && msg.content[0].type === "text" && msg.content[0].text.startsWith("[DCP:")) {
        continue;
      }

      const tokensSaved = estimateTokens(msg.content);
      state.stats.tokensSavedEstimate += tokensSaved;
      state.stats.prunedItemsCount.purgeErrors++;

      // We preserve the first line or up to 200 chars to keep the error identity
      let summary = "";
      for (const block of msg.content) {
        if (block.type === "text") {
          summary += block.text;
          if (summary.length > 200) break;
        }
      }

      const firstLine = summary.split("\n")[0].slice(0, 150);

      state.details.push({
        strategy: "purgeErrors",
        toolName: msg.toolName,
        turnAge,
        tokensSaved,
        argsSummary: firstLine
      });

      msg.content = [
        {
          type: "text",
          text: `[DCP: Stale error payload minimized.]\n${firstLine}...`
        }
      ];
    }
  }
}
