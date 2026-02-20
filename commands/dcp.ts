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
