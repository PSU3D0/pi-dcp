import type { AgentMessage } from "@mariozechner/pi-coding-agent";
import type { DCPConfig, DCPSessionState } from "../types";
import { estimateTokens } from "../utils";

export function applyOutputBodyReplace(
  messages: AgentMessage[],
  config: DCPConfig,
  state: DCPSessionState,
  toolArgsIndex: Map<string, any>,
  turnAges: number[]
): void {
  if (!config.strategies.outputBodyReplace.enabled) return;

  const minChars = config.strategies.outputBodyReplace.minChars;
  const turns = config.turnProtection.enabled ? config.turnProtection.turns : 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const turnAge = turnAges[i];

    if (msg.role === "toolResult" && !msg.isError) {
      // Recent tools are protected
      if (turnAge < turns) continue;

      if (config.protectedTools.includes(msg.toolName)) {
        // We already incremented protectedSkipCount in other strategies if applicable,
        // but it's safe to count here too, or we can just continue.
        continue;
      }

      // Check if it's already a DCP placeholder
      if (msg.content.length === 1 && msg.content[0].type === "text" && msg.content[0].text.startsWith("[DCP:")) {
        continue;
      }

      let totalChars = 0;
      for (const block of msg.content) {
        if (block.type === "text") totalChars += block.text.length;
        // if image, it's also massive, we can treat images as exceeding minChars
        if (block.type === "image") totalChars += minChars + 1; 
      }

      if (totalChars >= minChars) {
        const tokensSaved = estimateTokens(msg.content);
        state.stats.tokensSavedEstimate += tokensSaved;
        state.stats.prunedItemsCount.outputBodyReplace++;

        const args = toolArgsIndex.get(msg.toolCallId);
        const argsSummary = args ? JSON.stringify(args).slice(0, 100) : "unknown args";

        msg.content = [
          {
            type: "text",
            text: `[DCP: Large output from ${msg.toolName}(${argsSummary}...) pruned due to age (Turn ${turnAge}). If you need this data again, re-run the tool.]`
          }
        ];
      }
    }
  }
}
