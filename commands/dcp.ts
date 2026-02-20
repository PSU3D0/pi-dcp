import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { DCPConfig, DCPSessionState } from "../types";

export function handleDcpCommand(
  args: string,
  ctx: ExtensionCommandContext,
  config: DCPConfig,
  state: DCPSessionState
) {
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() || "status";

  switch (subcommand) {
    case "status":
    case "stats":
      if (!config.enabled) {
        ctx.ui.notify("DCP is currently disabled.", "warning");
        return;
      }
      
      let message = `**DCP Status**: Enabled (${config.mode} mode)\n`;
      message += `- Tokens Saved: ~${state.stats.tokensSavedEstimate}\n`;
      message += `- Items Pruned: ${JSON.stringify(state.stats.prunedItemsCount, null, 2)}\n`;
      message += `- Protected Skips: ${state.stats.protectedSkipCount}\n`;
      message += `- Turn Protection: ${config.turnProtection.enabled ? config.turnProtection.turns + " turns" : "disabled"}\n`;
      
      ctx.ui.notify(message, "info");
      break;

    case "detail":
    case "details":
      if (!config.enabled) {
        ctx.ui.notify("DCP is currently disabled.", "warning");
        return;
      }
      if (state.details.length === 0) {
        ctx.ui.notify("No items have been pruned yet.", "info");
        return;
      }

      let detailMd = `# DCP Pruned Items (~${state.stats.tokensSavedEstimate} tokens saved)\n\n`;

      const grouped = state.details.reduce((acc, item) => {
        if (!acc[item.strategy]) acc[item.strategy] = [];
        acc[item.strategy].push(item);
        return acc;
      }, {} as Record<string, typeof state.details>);

      for (const [strategy, items] of Object.entries(grouped)) {
        detailMd += `## ${strategy} (${items.length})\n`;
        for (const item of items) {
          const turnStr = item.turnAge >= 0 ? `Turn ${item.turnAge}` : "Assistant Action";
          detailMd += `- **${item.toolName}** [${turnStr}] (~${item.tokensSaved} tokens): \`${item.argsSummary}\`\n`;
        }
        detailMd += "\n";
      }

      ctx.ui.editor("DCP Details", detailMd);
      break;

    case "manual":
      const action = parts[1]?.toLowerCase();
      if (action === "on") {
        config.enabled = true;
        ctx.ui.notify("DCP enabled manually.", "success");
      } else if (action === "off") {
        config.enabled = false;
        ctx.ui.notify("DCP disabled manually.", "warning");
      } else {
        ctx.ui.notify("Usage: /dcp manual <on|off>", "error");
      }
      break;

    default:
      ctx.ui.notify("Usage: /dcp <status|stats|manual on|off>", "error");
      break;
  }
}
