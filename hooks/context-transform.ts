import type { ExtensionContext, AgentMessage } from "@mariozechner/pi-coding-agent";
import type { DCPConfig, DCPSessionState } from "../types";
import { computeTurnAges, buildToolCallIndex } from "../utils";
import { applyDeduplicate } from "../strategies/deduplicate";
import { applyPurgeErrors } from "../strategies/purge-errors";
import { applySupersedeWrites } from "../strategies/supersede-writes";
import { applyOutputBodyReplace } from "../strategies/output-replace";
import { resetSessionState } from "../state";

export function handleContextTransform(
  messages: AgentMessage[],
  config: DCPConfig,
  state: DCPSessionState,
  ctx: ExtensionContext
) {
  if (!config.enabled) return { messages };

  resetSessionState(state);

  const turnAges = computeTurnAges(messages);
  const toolArgsIndex = buildToolCallIndex(messages);

  if (config.strategies.deduplicate.enabled) {
    applyDeduplicate(messages, config, state, toolArgsIndex, turnAges);
  }

  if (config.strategies.purgeErrors.enabled) {
    applyPurgeErrors(messages, config, state, turnAges);
  }

  if (config.strategies.supersedeWrites.enabled) {
    applySupersedeWrites(messages, config, state, toolArgsIndex);
  }

  if (config.strategies.outputBodyReplace.enabled) {
    applyOutputBodyReplace(messages, config, state, toolArgsIndex, turnAges);
  }

  if (state.stats.tokensSavedEstimate > 0) {
    ctx.ui.setStatus("dcp", `✂️ DCP: ~${state.stats.tokensSavedEstimate} tokens saved`);
  } else if (config.debug) {
    ctx.ui.setStatus("dcp", `DCP: 0 tokens saved`);
  } else {
    // Clear status if no tokens saved and not debugging
    ctx.ui.setStatus("dcp", undefined);
  }

  return { messages };
}
