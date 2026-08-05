import { isVexzyModelAllowed } from './modelAllowlist.js'
import {
  getDefaultVexzyModelCatalog,
  type VexzyModelCatalog,
} from '../../services/api/vexzy/modelCatalog.js'
import {
  VexzyConfigurationError,
  VexzyError,
} from '../../services/api/vexzy/errors.js'
import { VexzyModelClientError } from '../../services/api/vexzy/modelClient.js'
import { isVexzyApiKey } from '../../services/api/vexzy/config.js'

/**
 * Validates a model by attempting an actual API call.
 */
export async function validateModel(
  model: string,
): Promise<{ valid: boolean; error?: string }> {
  if (!isVexzyApiKey(process.env.VEXZY_API_KEY)) {
    return {
      valid: false,
      error: 'Vexzy authentication configuration is invalid',
    }
  }

  return validateVexzyModel(model)
}

export async function validateVexzyModel(
  model: string,
  catalog?: VexzyModelCatalog,
): Promise<{ valid: boolean; error?: string }> {
  const normalizedModel = model.trim()

  if (!normalizedModel) {
    return { valid: false, error: 'Vexzy model name cannot be empty' }
  }

  try {
    if (!isVexzyModelAllowed(normalizedModel)) {
      return {
        valid: false,
        error: `Vexzy model '${normalizedModel}' is not allowed by availableModels`,
      }
    }

    const registry = await (catalog ?? getDefaultVexzyModelCatalog()).load()
    const catalogModel = registry.get(normalizedModel)

    if (catalogModel === undefined) {
      return {
        valid: false,
        error: `Vexzy model '${normalizedModel}' is not in the dynamic catalog`,
      }
    }

    if (!catalogModel.available) {
      return {
        valid: false,
        error: `Vexzy model '${normalizedModel}' is unavailable`,
      }
    }

    return { valid: true }
  } catch (error) {
    return { valid: false, error: getSafeVexzyValidationError(error) }
  }
}

export function isCatalogModelAvailable(
  catalog: VexzyModelCatalog,
  model: string,
): boolean {
  return catalog.getModelById(model)?.available === true
}

function getSafeVexzyValidationError(error: unknown): string {
  if (error instanceof VexzyConfigurationError) {
    return 'Vexzy authentication configuration is invalid'
  }

  if (error instanceof VexzyError) {
    switch (error.kind) {
      case 'auth':
        return 'Vexzy authentication failed while loading the model catalog'
      case 'credits':
        return 'Vexzy model catalog access is unavailable because credits are exhausted'
      case 'rate_limit':
        return 'Vexzy model catalog request was rate limited'
      case 'service_unavailable':
        return 'Vexzy model catalog service is unavailable'
      case 'http':
        return 'Vexzy model catalog request failed'
    }
  }

  if (error instanceof VexzyModelClientError) {
    switch (error.code) {
      case 'invalid_response':
        return 'Vexzy model catalog response was invalid'
      case 'aborted':
      case 'timeout':
      case 'network':
        return 'Vexzy model catalog request failed'
    }
  }

  return 'Vexzy model catalog could not be loaded'
}
