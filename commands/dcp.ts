import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import type { DCPConfig, DCPSessionState } from '../types'
import { buildDetailsMarkdown, buildStatusMessage } from '../observability'

export function handleDcpCommand(
  args: string,
  ctx: ExtensionCommandContext,
  config: DCPConfig,
  state: DCPSessionState
) {
  const parts = args.trim().split(/\s+/)
  const subcommand = parts[0]?.toLowerCase() || 'status'

  switch (subcommand) {
    case 'status':
    case 'stats':
      if (!config.enabled) {
        ctx.ui.notify('DCP is currently disabled.', 'warning')
        return
      }

      ctx.ui.notify(buildStatusMessage(config, state), 'info')
      break

    case 'detail':
    case 'details':
      if (!config.enabled) {
        ctx.ui.notify('DCP is currently disabled.', 'warning')
        return
      }

      ctx.ui.editor('DCP Details', buildDetailsMarkdown(config, state))
      break

    case 'manual':
      const action = parts[1]?.toLowerCase()
      if (action === 'on') {
        config.enabled = true
        ctx.ui.notify('DCP enabled manually.', 'info')
      } else if (action === 'off') {
        config.enabled = false
        ctx.ui.notify('DCP disabled manually.', 'warning')
      } else {
        ctx.ui.notify('Usage: /dcp manual <on|off>', 'error')
      }
      break

    default:
      ctx.ui.notify(
        'Usage: /dcp <status|stats|detail|details|manual on|off>',
        'error'
      )
      break
  }
}
