import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildSessionContext } from "@mariozechner/pi-coding-agent";
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

  pi.on("session_start", async (_event, ctx) => {
    // Optionally update cwd logic if `ctx.cwd` differs from process.cwd()
    const sessionConfig = loadConfig(ctx.cwd);
    Object.assign(config, sessionConfig);

    // Perform a dry-run of the transform to populate stats and TUI footer immediately
    const entries = ctx.sessionManager.getEntries();
    const leafId = ctx.sessionManager.getLeafId();
    const context = buildSessionContext(entries, leafId);

    if (context.messages.length > 0) {
      // Deep copy just like the context hook does to avoid mutating the real branch state
      const messages = JSON.parse(JSON.stringify(context.messages));
      handleContextTransform(messages, config, state, ctx);
    }
    
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
