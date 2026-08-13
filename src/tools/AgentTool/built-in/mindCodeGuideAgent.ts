import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from 'src/tools/SendMessageTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../loadAgentsDir.js'

const VEXZY_MODELS_URL = 'https://api.echogate.one/v1/models'

export const MINDCODE_GUIDE_AGENT_TYPE = 'mindcode-guide'

function getMindCodeGuideBasePrompt(): string {
  // Embedded builds alias find/grep and remove the dedicated Glob/Grep tools.
  const localSearchHint = hasEmbeddedSearchTools()
    ? `${FILE_READ_TOOL_NAME}, \`find\`, and \`grep\``
    : `${FILE_READ_TOOL_NAME}, ${GLOB_TOOL_NAME}, and ${GREP_TOOL_NAME}`

  return `You are the MindCode guide agent. Your primary responsibility is helping users understand and use MindCode and the VEXZY API effectively.

**Your expertise spans two domains:**

1. **MindCode** (the CLI tool): Installation, configuration, hooks, skills, MCP servers, keyboard shortcuts, IDE integrations, settings, and workflows.

2. **VEXZY API**: The OpenAI-compatible API at https://api.echogate.one/v1 for model discovery, chat completions, streaming, tool use, and integrations.

**Documentation sources:**

- **Local MindCode documentation**: Read the repository's MINDCODE.md, local command help, and project configuration for questions about the MindCode CLI tool, including:
  - Installation, setup, and getting started
  - Hooks (pre/post command execution)
  - Custom skills
  - MCP server configuration
  - IDE integrations (VS Code, JetBrains)
  - Settings files and configuration
  - Keyboard shortcuts and hotkeys
  - Subagents and plugins
  - Sandboxing and security

- **VEXZY endpoint contract** (${VEXZY_MODELS_URL}): Use this live catalog for the available model IDs, capabilities, and status. Use the \`/v1/chat/completions\` endpoint under the same base URL for API examples. Authenticate with the \`VEXZY_API_KEY\` environment variable. If no confirmed VEXZY documentation index is available, state that the answer is based on local documentation and the endpoint contract rather than inventing a documentation URL.

**Approach:**
1. Determine which domain the user's question falls into
2. Read local documentation first for MindCode questions
3. Use ${WEB_FETCH_TOOL_NAME} to fetch ${VEXZY_MODELS_URL} for the live VEXZY model catalog
4. Fetch only confirmed VEXZY endpoint documentation or pages supplied by the user
5. Provide clear, actionable guidance based on the local documentation and endpoint contract
6. Use ${WEB_SEARCH_TOOL_NAME} only when a confirmed source is available and relevant
7. Reference local project files (MINDCODE.md, .mindcode/ directory) using ${localSearchHint}

**Guidelines:**
- Always prioritize official documentation over assumptions
- Keep responses concise and actionable
- Include specific examples or code snippets when helpful
- Reference exact local files or confirmed VEXZY endpoint URLs in your responses
- Help users discover features by proactively suggesting related commands, shortcuts, or capabilities

Complete the user's request by providing accurate, documentation-based guidance.`
}

function getFeedbackGuideline(): string {
  return "- When you cannot find an answer or the feature doesn't exist, direct the user to use /feedback to report a feature request or bug"
}

export const MINDCODE_GUIDE_AGENT: BuiltInAgentDefinition = {
  agentType: MINDCODE_GUIDE_AGENT_TYPE,
  whenToUse: `Use this agent when the user asks questions ("Can MindCode...", "Does MindCode...", "How do I...") about MindCode features, hooks, slash commands, MCP servers, settings, IDE integrations, keyboard shortcuts, or the VEXZY API and its models. **IMPORTANT:** Before spawning a new agent, check if there is already a running or recently completed mindcode-guide agent that you can continue via ${SEND_MESSAGE_TOOL_NAME}.`,
  // Embedded builds: Glob/Grep tools are removed; use Bash for local search.
  tools: hasEmbeddedSearchTools()
    ? [
        BASH_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ]
    : [
        GLOB_TOOL_NAME,
        GREP_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ],
  source: 'built-in',
  baseDir: 'built-in',
  model: 'haiku',
  permissionMode: 'dontAsk',
  getSystemPrompt({ toolUseContext }) {
    const commands = toolUseContext.options.commands

    // Build context sections
    const contextSections: string[] = []

    // 1. Custom skills
    const customCommands = commands.filter(cmd => cmd.type === 'prompt')
    if (customCommands.length > 0) {
      const commandList = customCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(
        `**Available custom skills in this project:**\n${commandList}`,
      )
    }

    // 2. Custom agents from .mindcode/agents/
    const customAgents =
      toolUseContext.options.agentDefinitions.activeAgents.filter(
        (a: AgentDefinition) => a.source !== 'built-in',
      )
    if (customAgents.length > 0) {
      const agentList = customAgents
        .map((a: AgentDefinition) => `- ${a.agentType}: ${a.whenToUse}`)
        .join('\n')
      contextSections.push(
        `**Available custom agents configured:**\n${agentList}`,
      )
    }

    // 3. MCP servers
    const mcpClients = toolUseContext.options.mcpClients
    if (mcpClients && mcpClients.length > 0) {
      const mcpList = mcpClients
        .map((client: { name: string }) => `- ${client.name}`)
        .join('\n')
      contextSections.push(`**Configured MCP servers:**\n${mcpList}`)
    }

    // 4. Plugin commands
    const pluginCommands = commands.filter(
      cmd => cmd.type === 'prompt' && cmd.source === 'plugin',
    )
    if (pluginCommands.length > 0) {
      const pluginList = pluginCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(`**Available plugin skills:**\n${pluginList}`)
    }

    // 5. User settings
    const settings = getSettings_DEPRECATED()
    if (Object.keys(settings).length > 0) {
      // eslint-disable-next-line no-restricted-syntax -- human-facing UI, not tool_result
      const settingsJson = jsonStringify(settings, null, 2)
      contextSections.push(
        `**User's settings.json:**\n\`\`\`json\n${settingsJson}\n\`\`\``,
      )
    }

    // Add the feedback guideline.
    const feedbackGuideline = getFeedbackGuideline()
    const basePromptWithFeedback = `${getMindCodeGuideBasePrompt()}
${feedbackGuideline}`

    // If we have any context to add, append it to the base system prompt
    if (contextSections.length > 0) {
      return `${basePromptWithFeedback}

---

# User's Current Configuration

The user has the following custom setup in their environment:

${contextSections.join('\n\n')}

When answering questions, consider these configured features and proactively suggest them when relevant.`
    }

    // Return the base prompt if no context to add
    return basePromptWithFeedback
  },
}
