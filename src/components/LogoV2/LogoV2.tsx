import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text, color } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import {
  calculateLayoutDimensions,
  calculateOptimalLeftWidth,
  formatWelcomeMessage,
  getLayoutMode,
  getLogoDisplayData,
  getRecentActivitySync,
  getRecentReleaseNotesSync,
  truncatePath,
} from '../../utils/logoV2Utils.js'
import { truncate } from '../../utils/format.js'
import { AnimatedSakura } from './AnimatedSakura.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { FeedColumn } from './FeedColumn.js'
import {
  createProjectOnboardingFeed,
  createRecentActivityFeed,
  createWhatsNewFeed,
} from './feedConfigs.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { resolveThemeSetting } from '../../utils/systemTheme.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { isDebugMode, isDebugToStdErr, getDebugLogPath } from '../../utils/debug.js'
import {
  getSteps,
  incrementProjectOnboardingSeenCount,
  shouldShowProjectOnboarding,
} from '../../projectOnboardingState.js'
import { OffscreenFreeze } from '../OffscreenFreeze.js'
import { checkForReleaseNotesSync } from '../../utils/releaseNotes.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { EmergencyTip } from './EmergencyTip.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { useAppState } from '../../state/AppState.js'
import { getEffortSuffix } from '../../utils/effort.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { renderModelSetting } from '../../utils/model/model.js'

const LEFT_PANEL_MAX_WIDTH = 50
const ACCENT = 'suggestion' as const

type RuntimeIndicatorsProps = {
  sandboxed: boolean
}

function RuntimeIndicators({ sandboxed }: RuntimeIndicatorsProps): React.ReactNode {
  const debug = isDebugMode()
  const tmuxSession = process.env.MINDCODE_TMUX_SESSION
  const tmuxPrefix = process.env.MINDCODE_TMUX_PREFIX
  const tmuxHelp = process.env.MINDCODE_TMUX_PREFIX_CONFLICTS
    ? 'Detach: ' + tmuxPrefix + ' ' + tmuxPrefix + ' d (press prefix twice - MindCode uses ' + tmuxPrefix + ')'
    : 'Detach: ' + tmuxPrefix + ' d'

  return (
    <>
      {sandboxed && (
        <Box paddingLeft={2} flexDirection="column">
          <Text color="warning">Your bash commands will be sandboxed. Disable with /sandbox.</Text>
        </Box>
      )}
      {debug && (
        <Box paddingLeft={2} flexDirection="column">
          <Text color="warning">Debug mode enabled</Text>
          <Text dimColor>Logging to: {isDebugToStdErr() ? 'stderr' : getDebugLogPath()}</Text>
        </Box>
      )}
      {tmuxSession && (
        <Box paddingLeft={2} flexDirection="column">
          <Text dimColor>tmux session: {tmuxSession}</Text>
          <Text dimColor>{tmuxHelp}</Text>
        </Box>
      )}
      <EmergencyTip />
    </>
  )
}

export function LogoV2(): React.ReactNode {
  const activities = getRecentActivitySync()
  const username = null
  const { columns } = useTerminalSize()
  const showOnboarding = shouldShowProjectOnboarding()
  const showSandboxStatus = SandboxManager.isSandboxingEnabled()
  const agent = useAppState(state => state.agent)
  const effortValue = useAppState(state => state.effortValue)
  const config = getGlobalConfig()
  const [announcement] = useState(() => {
    const announcements = getInitialSettings().companyAnnouncements
    if (!announcements || announcements.length === 0) return undefined
    return config.numStartups === 1
      ? announcements[0]
      : announcements[Math.floor(Math.random() * announcements.length)]
  })
  const { version, cwd, agentName: configuredAgent } = getLogoDisplayData()
  const agentName = agent ?? configuredAgent
  const model = useMainLoopModel()
  const modelDisplayName = truncate(
    renderModelSetting(model) + getEffortSuffix(model, effortValue),
    LEFT_PANEL_MAX_WIDTH - 20,
  )
  const { hasReleaseNotes } = checkForReleaseNotesSync(config.lastReleaseNotesSeen)
  const isCondensedMode =
    !hasReleaseNotes &&
    !showOnboarding &&
    !isEnvTruthy(process.env.MINDCODE_FORCE_FULL_LOGO)

  useEffect(() => {
    const currentConfig = getGlobalConfig()
    if (currentConfig.lastReleaseNotesSeen !== MACRO.VERSION) {
      saveGlobalConfig(current => ({
        ...current,
        lastReleaseNotesSeen: MACRO.VERSION,
      }))
      if (showOnboarding) incrementProjectOnboardingSeenCount()
    }
  }, [showOnboarding])

  if (isCondensedMode) {
    const layoutMode = getLayoutMode(columns)
    const welcome = formatWelcomeMessage(username)
    const compactWelcome =
      stringWidth(welcome) > columns - 4 ? formatWelcomeMessage(null) : welcome
    const availableCwd = agentName
      ? columns - 4 - 1 - stringWidth(agentName) - 3
      : columns - 4
    const displayedCwd = truncatePath(cwd, Math.max(availableCwd, 10))
    const borderText = {
      content: color(ACCENT, resolveThemeSetting(config.theme))(' MindCode '),
      position: 'top' as const,
      align: 'start' as const,
      offset: 1,
    }

    return (
      <>
        <OffscreenFreeze>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={ACCENT}
            borderText={borderText}
            paddingX={1}
            paddingY={1}
            alignItems="center"
            width={columns}
          >
            <Text bold>{compactWelcome}</Text>
            <Box marginY={1}>
              <AnimatedSakura
                compact={layoutMode === 'compact'}
                interactive={isFullscreenEnvEnabled()}
              />
            </Box>
            <Text dimColor>{modelDisplayName}</Text>
            <Text dimColor>
              {agentName ? '@' + agentName + ' · ' + displayedCwd : displayedCwd}
            </Text>
          </Box>
        </OffscreenFreeze>
        <RuntimeIndicators sandboxed={showSandboxStatus} />
      </>
    )
  }

  const welcome = formatWelcomeMessage(username)
  const cwdWidth = agentName
    ? LEFT_PANEL_MAX_WIDTH - 1 - stringWidth(agentName) - 3
    : LEFT_PANEL_MAX_WIDTH
  const displayedCwd = truncatePath(cwd, Math.max(cwdWidth, 10))
  const cwdLine = agentName ? '@' + agentName + ' · ' + displayedCwd : displayedCwd
  const layoutMode = getLayoutMode(columns)
  const optimalLeftWidth = calculateOptimalLeftWidth(welcome, cwdLine, modelDisplayName)
  const { leftWidth, rightWidth } = calculateLayoutDimensions(
    columns,
    layoutMode,
    optimalLeftWidth,
  )
  const theme = resolveThemeSetting(config.theme)
  const borderText = {
    content: ' ' + color(ACCENT, theme)('MindCode') + ' ' + color('inactive', theme)('v' + version) + ' ',
    position: 'top' as const,
    align: 'start' as const,
    offset: 3,
  }
  const feeds = showOnboarding
    ? [createProjectOnboardingFeed(getSteps()), createRecentActivityFeed(activities)]
    : [createRecentActivityFeed(activities), createWhatsNewFeed(getRecentReleaseNotesSync(3))]

  return (
    <>
      <OffscreenFreeze>
        <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} borderText={borderText}>
          <Box flexDirection={layoutMode === 'horizontal' ? 'row' : 'column'} paddingX={1} gap={1}>
            <Box
              flexDirection="column"
              width={leftWidth}
              justifyContent="space-between"
              alignItems="center"
              minHeight={9}
            >
              <Box marginTop={1}><Text bold>{welcome}</Text></Box>
              <AnimatedSakura
                compact={layoutMode === 'compact'}
                interactive={isFullscreenEnvEnabled()}
              />
              <Box flexDirection="column" alignItems="center">
                <Text dimColor>{modelDisplayName}</Text>
                <Text dimColor>{cwdLine}</Text>
              </Box>
            </Box>
            {layoutMode === 'horizontal' && (
              <Box
                height="100%"
                borderStyle="single"
                borderColor={ACCENT}
                borderDimColor
                borderTop={false}
                borderBottom={false}
                borderLeft={false}
              />
            )}
            {layoutMode === 'horizontal' && <FeedColumn feeds={feeds} maxWidth={rightWidth} />}
          </Box>
        </Box>
      </OffscreenFreeze>
      {announcement && (
        <Box paddingLeft={2} flexDirection="column"><Text>{announcement}</Text></Box>
      )}
      <RuntimeIndicators sandboxed={showSandboxStatus} />
    </>
  )
}
