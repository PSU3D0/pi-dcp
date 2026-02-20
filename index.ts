import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config";
import { createSessionState } from "./state";
import { handleContextTransform } from "./hooks/context-transform";
import { handleDcpCommand } from "./commands/dcp";

export default function (pi: ExtensionAPI) {
  // Load config globally for this extension runtime
  // (In a real setup we might re-load per session_start if project-local config changes)
  const cwd = process.cwd(); 
  const config = loadConfig(cwd);
  const state = createSessionState();

  pi.on("session_start", (_event, ctx) => {
    // Optionally update cwd logic if `ctx.cwd` differs from process.cwd()
    const sessionConfig = loadConfig(ctx.cwd);
    Object.assign(config, sessionConfig);
    
    if (config.debug) {
      ctx.ui.notify("DCP Extension Loaded", "info");
    }
  });

  // The core integration hook
  pi.on("context", async (event, ctx) => {
    // event.messages is a deep copy, perfectly safe to mutate for the LLM request
    const { messages } = handleContextTransform(event.messages, config, state, ctx);
    return { messages };
  });

  pi.registerCommand("dcp", {
    description: "Manage Dynamic Context Pruning (DCP)",
    handler: async (args, ctx) => {
      handleDcpCommand(args, ctx, config, state);
    },
  });
}
