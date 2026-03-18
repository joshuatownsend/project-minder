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
}

/**
 * Maps detail-page tab values to contextual help slugs.
 * Used by ProjectDetail to open the right doc when ? is clicked on a tab.
 */
export const tabHelpMapping: Record<string, string> = {
  overview: 'project-details',
  context: 'project-details',
  todos: 'project-details',
  claude: 'project-details',
  'manual-steps': 'manual-steps',
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
] as const

export type HelpSlug = (typeof helpSlugs)[number]
