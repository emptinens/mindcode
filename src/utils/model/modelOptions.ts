import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import { getModelStrings } from './modelStrings.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getCanonicalName,
  getMarketingNameForModel,
  getUserSpecifiedModelSetting,
  type ModelSetting,
} from './model.js'
import { getGlobalConfig } from '../config.js'

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

function getDefaultOptionForUser(_fastMode = false): ModelOption {
  return {
    value: null,
    label: 'Default (recommended)',
    description: 'Sonnet 5 · Best for everyday tasks',
    descriptionForModel: 'Default model - Sonnet 5 with 1M context window',
  }
}

function getSonnet5Option(): ModelOption {
  return {
    value: 'sonnet5[1m]',
    label: 'Sonnet 5 (1M context)',
    description: 'Sonnet 5 · 1M context · Best for everyday tasks',
    descriptionForModel:
      'Sonnet 5 with 1M context - best for everyday tasks. Generally recommended for most coding tasks',
  }
}

function getSonnet5200kOption(): ModelOption {
  return {
    value: 'sonnet5',
    label: 'Sonnet 5 (200k context)',
    description: 'Sonnet 5 · 200k context · Best for everyday tasks',
    descriptionForModel:
      'Sonnet 5 with 200k context - best for everyday tasks.',
  }
}

function getOpus46Option(_fastMode = false): ModelOption {
  return {
    value: getModelStrings().opus46 + '[1m]',
    label: 'Opus 4.6',
    description: 'Opus 4.6 · released on 2/5/2026',
    descriptionForModel: 'Opus 4.6 with 1M context - released on 2/5/2026',
  }
}

function getOpus5Option(): ModelOption {
  return {
    value: getModelStrings().opus5 + '[1m]',
    label: 'Opus 5',
    description: 'Opus 5 · newest and most capable opus',
    descriptionForModel:
      'Opus 5 with 1M context - newest and most capable opus, a tier stronger than Opus 4.8',
  }
}

function getOpus48Option(): ModelOption {
  return {
    value: getModelStrings().opus48 + '[1m]',
    label: 'Opus 4.8',
    description: 'Opus 4.8 · released on 5/28/2026',
    descriptionForModel: 'Opus 4.8 with 1M context - released on 5/28/2026',
  }
}

function getOpus47Option(): ModelOption {
  return {
    value: getModelStrings().opus47 + '[1m]',
    label: 'Opus 4.7',
    description: 'Opus 4.7 · released on 4/16/2026',
    descriptionForModel: 'Opus 4.7 with 1M context - released on 4/16/2026',
  }
}

function getHaiku45Option(): ModelOption {
  return {
    value: 'haiku',
    label: 'Haiku',
    description: 'Haiku 4.5 · small, fast model',
    descriptionForModel:
      'Haiku 4.5 - small, fast model. Lower cost but less capable than Sonnet 5.',
  }
}

function getOpusPlanOption(): ModelOption {
  return {
    value: 'opusplan',
    label: 'Opus Plan Mode',
    description: 'Use Opus 4.8 in plan mode, Sonnet 5 otherwise',
  }
}

const VEXZY_MODEL_OPTIONS: ModelOption[] = [
  {
    value: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    description: 'VEXZY API · gpt-5.6-luna',
  },
  {
    value: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    description: 'VEXZY API · gpt-5.6-sol',
  },
  {
    value: 'claude-opus-5',
    label: 'Claude Opus 5',
    description: 'VEXZY API · claude-opus-5',
  },
  {
    value: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    description: 'VEXZY API · claude-sonnet-5',
  },
]

function getModelOptionsBase(fastMode = false): ModelOption[] {
  return [
    getDefaultOptionForUser(fastMode),
    getSonnet5Option(),
    getSonnet5200kOption(),
    getOpus5Option(),
    getOpus48Option(),
    getOpus47Option(),
    getOpus46Option(fastMode),
    getHaiku45Option(),
    ...VEXZY_MODEL_OPTIONS,
  ]
}

// @[MODEL LAUNCH]: Add the new model ID to the appropriate family pattern below
// so the "newer version available" hint works correctly.
/**
 * Map a full model name to its family alias and the marketing name of the
 * version the alias currently resolves to. Used to detect when a user has
 * a specific older version pinned and a newer one is available.
 */
function getModelFamilyInfo(
  model: string,
): { alias: string; currentVersionName: string } | null {
  const canonical = getCanonicalName(model)

  // Sonnet family
  if (
    canonical.includes('claude-sonnet-5') ||
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-sonnet-4-') ||
    canonical.includes('claude-3-7-sonnet') ||
    canonical.includes('claude-3-5-sonnet')
  ) {
    const currentName = getMarketingNameForModel(getModelStrings().sonnet5)
    if (currentName) {
      return { alias: 'Sonnet', currentVersionName: currentName }
    }
  }

  // Opus family
  if (canonical.includes('claude-opus-4')) {
    const currentName = getMarketingNameForModel(getModelStrings().opus48)
    if (currentName) {
      return { alias: 'Opus', currentVersionName: currentName }
    }
  }

  // Haiku family
  if (
    canonical.includes('claude-haiku') ||
    canonical.includes('claude-3-5-haiku')
  ) {
    const currentName = getMarketingNameForModel(getModelStrings().haiku45)
    if (currentName) {
      return { alias: 'Haiku', currentVersionName: currentName }
    }
  }

  return null
}

/**
 * Returns a ModelOption for a known Anthropic model with a human-readable
 * label, and an upgrade hint if a newer version is available via the alias.
 * Returns null if the model is not recognized.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model)
  if (!marketingName) return null

  const familyInfo = getModelFamilyInfo(model)
  if (!familyInfo) {
    return {
      value: model,
      label: marketingName,
      description: model,
    }
  }

  // Check if the alias currently resolves to a different (newer) version
  if (marketingName !== familyInfo.currentVersionName) {
    return {
      value: model,
      label: marketingName,
      description: `Newer version available · select ${familyInfo.alias} for ${familyInfo.currentVersionName}`,
    }
  }

  // Same version as the alias — just show the friendly name
  return {
    value: model,
    label: marketingName,
    description: model,
  }
}

export function getModelOptions(fastMode = false): ModelOption[] {
  const options = getModelOptionsBase(fastMode)

  // Add the custom model from the ANTHROPIC_CUSTOM_MODEL_OPTION env var
  const envCustomModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (
    envCustomModel &&
    !options.some(existing => existing.value === envCustomModel)
  ) {
    options.push({
      value: envCustomModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description:
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ??
        `Custom model (${envCustomModel})`,
    })
  }

  // Append additional model options fetched during bootstrap
  for (const opt of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some(existing => existing.value === opt.value)) {
      options.push(opt)
    }
  }

  // Add custom model from either the current model value or the initial one
  // if it is not already in the options.
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }
  if (customModel === null || options.some(opt => opt.value === customModel)) {
    return filterModelOptionsByAllowlist(options)
  } else if (customModel === 'opusplan') {
    return filterModelOptionsByAllowlist([...options, getOpusPlanOption()])
  } else {
    // Try to show a human-readable label for known Anthropic models, with an
    // upgrade hint if the alias now resolves to a newer version.
    const knownOption = getKnownModelOption(customModel)
    if (knownOption) {
      options.push(knownOption)
    } else {
      options.push({
        value: customModel,
        label: customModel,
        description: 'Custom model',
      })
    }
    return filterModelOptionsByAllowlist(options)
  }
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {}
  if (!settings.availableModels) {
    return options // No restrictions
  }
  return options.filter(
    opt =>
      opt.value === null || (opt.value !== null && isModelAllowed(opt.value)),
  )
}
