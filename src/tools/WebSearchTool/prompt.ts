import { getLocalMonthYear } from 'src/constants/common.js'
import { isGrokReady } from '../../utils/grokAuth.js'

export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export function getWebSearchPrompt(): string {
  const currentMonthYear = getLocalMonthYear()
  // When the user is signed in to Grok, GrokSearch is the preferred web-research
  // tool. Steer the model toward it and reserve WebSearch for the cases only it
  // can serve. This prefix only appears while Grok is ready, so when GrokSearch
  // is hidden the prompt is unchanged (and never references a tool the model
  // can't see).
  const grokPreference = isGrokReady()
    ? 'IMPORTANT: The GrokSearch tool is available and is the PREFERRED tool for web research. Prefer GrokSearch for general web lookups and multi-source research. Use WebSearch only when you specifically need its capabilities — domain allow/blocklist filtering — or when GrokSearch has already failed for this query.\n\n'
    : ''
  return `${grokPreference}
- Allows Claude to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond Claude's knowledge cutoff
- Searches are performed automatically within a single API call

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
  - Domain filtering is supported to include or block specific websites
  - Web search is only available in the US

IMPORTANT - Use the correct year in search queries:
  - The current month is ${currentMonthYear}. You MUST use this year when searching for recent information, documentation, or current events.
  - Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year
`
}
