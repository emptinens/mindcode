import figures from 'figures'
import { homedir } from 'os'
import type { Step } from '../../projectOnboardingState.js'
import type { LogOption } from '../../types/logs.js'
import { getCwd } from '../../utils/cwd.js'
import { formatRelativeTimeAgo } from '../../utils/format.js'
import type { FeedConfig, FeedLine } from './Feed.js'

export function createRecentActivityFeed(activities: LogOption[]): FeedConfig {
  const lines: FeedLine[] = activities.map(log => {
    const time = formatRelativeTimeAgo(log.modified)
    const description = log.summary && log.summary !== 'No prompt' ? log.summary : log.firstPrompt
    return { text: description || '', timestamp: time }
  })

  return {
    title: 'Recent activity',
    lines,
    footer: lines.length > 0 ? '/resume for more' : undefined,
    emptyMessage: 'No recent activity',
  }
}

export function createWhatsNewFeed(releaseNotes: string[]): FeedConfig {
  return {
    title: "What's new",
    lines: releaseNotes.map(text => ({ text })),
    footer: releaseNotes.length > 0 ? '/release-notes for more' : undefined,
    emptyMessage: 'Check the MindCode changelog for updates',
  }
}

const sanitizeWelcomeText = (text: string): string =>
  text.replace(/\bClaude\b/gi, 'MindCode')

export function createProjectOnboardingFeed(steps: Step[]): FeedConfig {
  const enabledSteps = steps
    .filter(({ isEnabled }) => isEnabled)
    .sort((a, b) => Number(a.isComplete) - Number(b.isComplete))
  const lines: FeedLine[] = enabledSteps.map(({ text, isComplete }) => ({
    text: sanitizeWelcomeText((isComplete ? figures.tick + ' ' : '') + text),
  }))
  if (getCwd() === homedir()) {
    lines.push({
      text: sanitizeWelcomeText('Note: You have launched MindCode in your home directory. For the best experience, launch it in a project directory instead.'),
    })
  }
  return { title: 'Tips for getting started', lines }
}
