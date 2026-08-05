import { loadVexzyModelCatalog } from './vexzy/modelCatalog.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'

type VexzyCatalogLoader = () => Promise<unknown>

/**
 * Preload the Vexzy model catalog without making startup dependent on it.
 * The catalog owns request deduplication and caching.
 */
export async function fetchBootstrapData(
  loadCatalog: VexzyCatalogLoader = loadVexzyModelCatalog,
): Promise<void> {
  try {
    await loadCatalog()
    logForDebugging('[Bootstrap] Vexzy catalog ready')
  } catch (error) {
    logError(error)
  }
}

export const preloadVexzyCatalog = fetchBootstrapData
