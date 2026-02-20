import type { AgentMessage } from "@mariozechner/pi-coding-agent";
import type { DCPConfig, DCPSessionState } from "../types";
import { getToolSignature, estimateTokens } from "../utils";

export function applyDeduplicate(
  messages: AgentMessage[],
  config: DCPConfig,
  state: DCPSessionState,
  toolArgsIndex: Map<string, any>,
  turnAges: number[]
): void {
  if (!config.strategies.deduplicate.enabled) return;

  const seenSignatures = new Set<string>();

  // Iterate backwards (from newest to oldest) to keep the LATEST exact duplicate
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const turnAge = turnAges[i];

    if (msg.role === "toolResult") {
      const args = toolArgsIndex.get(msg.toolCallId);
      if (!args) continue; // Safe fallback if args missing
      
      const sig = getToolSignature(msg.toolName, args, msg.toolCallId);

      // We still register protected tools / recent tools into seenSignatures
      // so we can prune OLDER unprotected duplicates of them.
      
      const isProtected = config.protectedTools.includes(msg.toolName);
      const isRecent = config.turnProtection.enabled && turnAge < config.turnProtection.turns;

      if (isProtected || isRecent) {
        if (isProtected) {
          state.stats.protectedSkipCount++;
        }
        seenSignatures.add(sig);
        continue;
      }

      if (seenSignatures.has(sig)) {
        // This is an older exact duplicate. Prune it.
        const tokensSaved = estimateTokens(msg.content);
        state.stats.tokensSavedEstimate += tokensSaved;
        state.stats.prunedItemsCount.deduplicate++;

        msg.content = [
          {
            type: "text",
            text: `[DCP: Exact duplicate of a later tool call. Pruned to save tokens.]`
          }
        ];
        
        // Keep details intact so other extensions / session logic don't break
      } else {
        seenSignatures.add(sig);
      }
    }
  }
}
