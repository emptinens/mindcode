import { writeToStdout } from 'src/utils/process.js'

/**
 * VEXZY-only distributions are updated from the local MindCode checkout.
 *
 * The old package/native installer paths are intentionally not part of the
 * production runtime: they could select a non-VEXZY registry, credentials, or
 * transport. Keep `/update` as an explicit, side-effect-free status command
 * until a VEXZY distribution endpoint is defined.
 */
export async function update(): Promise<void> {
  writeToStdout(`Current version: ${MACRO.VERSION}\n`)
  writeToStdout(
    'MindCode uses the local Git checkout for updates; no remote updater is configured.\n',
  )
  writeToStdout(
    'Apply changes in the local MindCode repository, then rebuild the local bundle.\n',
  )
}
