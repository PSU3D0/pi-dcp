import type { AgentMessage } from "@mariozechner/pi-coding-agent";
import type { DCPConfig, DCPSessionState } from "../types";
import { estimateTokens } from "../utils";

export function applySupersedeWrites(
  messages: AgentMessage[],
  config: DCPConfig,
  state: DCPSessionState,
  toolArgsIndex: Map<string, any>
): void {
  if (!config.strategies.supersedeWrites.enabled) return;

  const readFiles = new Set<string>();

  // Iterate backwards. If we see a 'read', record the path.
  // If we see a 'write' (or 'edit') for that path OLDER than the read, we can prune the massive write argument!
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.role === "toolResult") {
      const args = toolArgsIndex.get(msg.toolCallId);
      if (!args) continue;

      if (msg.toolName === "read" && args.path) {
        readFiles.add(args.path);
      }
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "toolCall" && (block.name === "write" || block.name === "edit")) {
          const path = block.arguments.path || block.arguments.file;
          if (path && readFiles.has(path)) {
            // This write/edit was superseded by a later read.
            // We can replace the huge content/text arguments with a placeholder.
            let saved = 0;
            if (typeof block.arguments.content === "string") {
              saved += Math.floor(block.arguments.content.length / 4);
              block.arguments.content = "[DCP: Content superseded by later read]";
            }
            if (typeof block.arguments.text === "string") {
              saved += Math.floor(block.arguments.text.length / 4);
              block.arguments.text = "[DCP: Content superseded by later read]";
            }
            if (typeof block.arguments.oldText === "string") {
              saved += Math.floor(block.arguments.oldText.length / 4);
              block.arguments.oldText = "[DCP: Content superseded by later read]";
            }
            if (typeof block.arguments.newText === "string") {
              saved += Math.floor(block.arguments.newText.length / 4);
              block.arguments.newText = "[DCP: Content superseded by later read]";
            }

            if (saved > 0) {
              state.stats.tokensSavedEstimate += saved;
              state.stats.prunedItemsCount.supersedeWrites++;

              state.details.push({
                strategy: "supersedeWrites",
                toolName: block.name,
                turnAge: -1, // We don't track turn age perfectly for assistant blocks here, just rough estimate
                tokensSaved: saved,
                argsSummary: `Path: ${path}`
              });
            }
          }
        }
      }
    }
  }
}
