/**
 * Maps UI routes to help documentation slugs.
 * Slugs correspond to files in /docs/help/{slug}.md (and /public/help/{slug}.md).
 */
export const helpMapping: Record<string, string> = {
  '/': 'getting-started',
  '/project/[slug]': 'project-details',
  '/manual-steps': 'manual-steps',
  '/stats': 'stats',
  '/sessions': 'sessions',
  '/sessions/[sessionId]': 'sessions',
  '/insights': 'insights',
  '/agents': 'agents',
  '/skills': 'skills',
  '/usage': 'usage',
  '/status': 'status',
  '/templates': 'templates',
  '/templates/[slug]': 'templates',
  '/config': 'config',
  '/setup': 'setup',
  '/settings': 'settings',
}

/**
 * Maps detail-page tab values to contextual help slugs.
 * Used by ProjectDetail to open the right doc when ? is clicked on a tab.
 */
export const tabHelpMapping: Record<string, string> = {
  overview: 'project-details',
  context: 'claude-md-audit',
  todos: 'project-details',
  sessions: 'sessions',
  'manual-steps': 'manual-steps',
  insights: 'insights',
  agents: 'agents',
  skills: 'skills',
  memory: 'memory',
  efficiency: 'project-details',
  'hot-files': 'project-details',
  patterns: 'project-details',
  handoff: 'sessions',
  'config-history': 'config-history',
}

/** All available help doc slugs. */
export const helpSlugs = [
  'getting-started',
  'search-and-filter',
  'project-details',
  'dev-servers',
  'ports',
  'project-status',
  'tech-stack',
  'quick-actions',
  'manual-steps',
  'stats',
  'sessions',
  'insights',
  'agents',
  'skills',
  'usage',
  'status',
  'memory',
  'claude-md-audit',
  'config',
  'config-history',
  'setup',
  'settings',
  'templates',
] as const

export type HelpSlug = (typeof helpSlugs)[number]
