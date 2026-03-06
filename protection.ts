import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type {
  DCPConfig,
  DCPMessageProtection,
  DCPProtectionPolicy,
} from './types'
import { buildProtectionIndex } from './frontier'
import { buildAgeModel, buildToolCallIndex } from './utils'

export function createProtectionPolicy(
  messages: AgentMessage[],
  config: DCPConfig,
  ageModel = buildAgeModel(messages),
  toolArgsIndex = buildToolCallIndex(messages),
  cwd = process.cwd()
): DCPProtectionPolicy {
  const stepProtectionActive =
    config.stepProtection.enabled && config.stepProtection.steps > 0
  const turnProtectionActive =
    config.turnProtection.enabled && config.turnProtection.turns > 0
  const currentTurnStepCount = ageModel.steps.reduce(
    (count, step) =>
      (ageModel.turnAges[step.start] ?? -1) === 0 ? count + 1 : count,
    0
  )
  const stepProtectionEngagedForCurrentTurn =
    stepProtectionActive &&
    (!turnProtectionActive ||
      currentTurnStepCount > config.turnProtection.turns)
  const protectionIndex = buildProtectionIndex(
    messages,
    config,
    ageModel,
    toolArgsIndex,
    cwd
  )

  return {
    turnAges: ageModel.turnAges,
    stepAges: ageModel.stepAges,
    steps: ageModel.steps,
    frontierPinReasons: protectionIndex.frontierPinReasons,
    listPinnedItems() {
      return protectionIndex.pinnedItems.map((item) => ({
        ...item,
        reasons: [...item.reasons],
      }))
    },
    get(index, options) {
      const message = messages[index]
      const turnAge = ageModel.turnAges[index] ?? -1
      const stepAge = ageModel.stepAges[index] ?? -1
      const currentTurnExecution = turnAge === 0 && stepAge >= 0
      const usesStepWindowForCurrentTurnExecution =
        stepProtectionEngagedForCurrentTurn && currentTurnExecution

      const viaTurnWindow =
        turnProtectionActive &&
        turnAge >= 0 &&
        turnAge < config.turnProtection.turns &&
        !usesStepWindowForCurrentTurnExecution
      const viaStepWindow =
        stepProtectionActive &&
        currentTurnExecution &&
        stepAge >= 0 &&
        stepAge < config.stepProtection.steps &&
        usesStepWindowForCurrentTurnExecution

      const subjectKey = resolveSubjectKey(message, options)
      const subjectProtection =
        subjectKey !== null ? protectionIndex.get(subjectKey) : undefined

      return {
        protected:
          viaTurnWindow ||
          viaStepWindow ||
          Boolean(
            subjectProtection?.viaToolProtection ||
            subjectProtection?.viaFileProtection ||
            subjectProtection?.viaFrontierPin
          ),
        viaTurnWindow,
        viaStepWindow,
        viaToolProtection: subjectProtection?.viaToolProtection ?? false,
        viaFileProtection: subjectProtection?.viaFileProtection ?? false,
        viaFrontierPin: subjectProtection?.viaFrontierPin ?? false,
        pinReasons: [...(subjectProtection?.reasons ?? [])],
        turnAge,
        stepAge,
        currentTurnExecution,
      } satisfies DCPMessageProtection
    },
  }
}

function resolveSubjectKey(
  message: AgentMessage | undefined,
  options?: { toolName?: string; toolCallId?: string; toolArgs?: any }
): string | null {
  if (typeof options?.toolCallId === 'string') {
    return message?.role === 'toolResult'
      ? `toolResult:${options.toolCallId}`
      : `toolCall:${options.toolCallId}`
  }

  if (!message) {
    return null
  }

  if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
    return `toolResult:${message.toolCallId}`
  }

  if (message.role !== 'assistant') {
    return null
  }

  const matchingBlocks = message.content.filter(
    (
      block
    ): block is Extract<
      (typeof message.content)[number],
      { type: 'toolCall' }
    > => block.type === 'toolCall' && typeof block.id === 'string'
  )

  if (matchingBlocks.length === 1) {
    return `toolCall:${matchingBlocks[0].id}`
  }

  if (typeof options?.toolName === 'string') {
    const matchingBlock = matchingBlocks.find(
      (block) => block.type === 'toolCall' && block.name === options.toolName
    )
    if (matchingBlock?.type === 'toolCall') {
      return `toolCall:${matchingBlock.id}`
    }
  }

  return null
}
