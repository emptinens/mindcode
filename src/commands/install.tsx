import { c as _c } from "react/compiler-runtime";
import { copyFile, mkdir, rename, stat, unlink, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from 'src/commands.js';
import { logEvent } from 'src/services/analytics/index.js';
import { StatusIcon } from '../components/design-system/StatusIcon.js';
import { Box, render, Text } from '../ink.js';
import { logForDebugging } from '../utils/debug.js';
import { env } from '../utils/env.js';
import { errorMessage } from '../utils/errors.js';
import { checkInstall, cleanupNpmInstallations, cleanupShellAliases, ensureBinDirOnPath } from '../utils/nativeInstaller/index.js';
import { getInitialSettings, updateSettingsForSource } from '../utils/settings/settings.js';
interface InstallProps {
  onDone: (result: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  force?: boolean;
  target?: string; // 'latest', 'stable', or version like '1.0.34'
}
type InstallState = {
  type: 'checking';
} | {
  type: 'cleaning-npm';
} | {
  type: 'installing';
  version: string;
} | {
  type: 'setting-up';
} | {
  type: 'set-up';
  messages: string[];
} | {
  type: 'success';
  version: string;
  setupMessages?: string[];
} | {
  type: 'error';
  message: string;
  warnings?: string[];
};
function getInstallationPath(): string {
  const isWindows = env.platform === 'win32';
  const homeDir = homedir();
  if (isWindows) {
    // Convert to Windows-style path
    const windowsPath = join(homeDir, '.local', 'bin', 'mindcode.exe');
    // Replace forward slashes with backslashes for Windows display
    return windowsPath.replace(/\//g, '\\');
  }
  return '~/.local/bin/mindcode';
}
function SetupNotes(t0) {
  const $ = _c(5);
  const {
    messages
  } = t0;
  if (messages.length === 0) {
    return null;
  }
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <Box><Text color="warning"><StatusIcon status="warning" withSpace={true} />Setup notes:</Text></Box>;
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  let t2;
  if ($[1] !== messages) {
    t2 = messages.map(_temp);
    $[1] = messages;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  let t3;
  if ($[3] !== t2) {
    t3 = <Box flexDirection="column" gap={0} marginBottom={1}>{t1}{t2}</Box>;
    $[3] = t2;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  return t3;
}
function _temp(message, index) {
  return <Box key={index} marginLeft={2}><Text dimColor={true}>• {message}</Text></Box>;
}
function Install({
  onDone,
  force,
  target
}: InstallProps): React.ReactNode {
  const [state, setState] = useState<InstallState>({
    type: 'checking'
  });
  useEffect(() => {
    async function run() {
      try {
        logForDebugging(`Install: Starting self-installation (force=${force})`);

        // Self-install: copy the currently-running executable to ~/.local/bin/
        const srcExe = process.execPath;
        const isWindows = env.platform === 'win32';
        const binDir = join(homedir(), '.local', 'bin');
        const destExe = join(binDir, isWindows ? 'mindcode.exe' : 'mindcode');

        setState({
          type: 'installing',
          version: MACRO.VERSION
        });

        // Ensure bin directory exists
        await mkdir(binDir, { recursive: true });

        // Check if already installed and same file
        let needsCopy = true;
        if (!force) {
          try {
            const srcStats = await stat(srcExe);
            const destStats = await stat(destExe);
            if (srcStats.size === destStats.size) {
              needsCopy = false;
              logForDebugging('Install: Already installed (same size), skipping copy');
            }
          } catch {
            // dest doesn't exist, needs copy
          }
        }

        if (needsCopy) {
          if (isWindows) {
            // On Windows, rename the old exe first (handles file locking)
            try {
              await stat(destExe);
              const oldFile = `${destExe}.old.${Date.now()}`;
              await rename(destExe, oldFile);
              try { await unlink(oldFile); } catch { /* still running, ignore */ }
            } catch {
              // dest doesn't exist yet
            }
          }
          await copyFile(srcExe, destExe);
          if (!isWindows) {
            await chmod(destExe, 0o755);
          }
          logForDebugging(`Install: Copied ${srcExe} -> ${destExe}`);
        }

        // Set up shell integration (PATH setup)
        setState({
          type: 'setting-up'
        });
        // Write the persisted PATH before checking it, so checkInstall reports
        // on the fixed state rather than the state we just repaired.
        const pathMessages = await ensureBinDirOnPath(binDir);
        const setupMessages = [...pathMessages, ...(await checkInstall(true))];
        logForDebugging(`Install: Setup completed with ${setupMessages.length} messages`);

        // Clean up old npm installations
        const {
          removed,
          errors,
          warnings
        } = await cleanupNpmInstallations();
        if (removed > 0) {
          logForDebugging(`Cleaned up ${removed} npm installation(s)`);
        }
        if (errors.length > 0) {
          logForDebugging(`Cleanup errors: ${errors.join(', ')}`);
        }

        // Clean up old shell aliases
        const aliasMessages = await cleanupShellAliases();

        // Combine all warning/info messages
        const allWarnings = [...warnings, ...aliasMessages.map(m_0 => m_0.message)];

        // Check if there were any setup errors or notes
        if (setupMessages.length > 0) {
          setState({
            type: 'set-up',
            messages: setupMessages.map(m_1 => m_1.message)
          });
          // Still mark as success but show both setup messages and cleanup warnings
          setTimeout(setState, 2000, {
            type: 'success' as const,
            version: MACRO.VERSION,
            setupMessages: [...setupMessages.map(m_2 => m_2.message), ...allWarnings]
          });
        } else {
          // No setup messages, go straight to success (but still show cleanup warnings if any)
          logForDebugging('Install: Shell PATH already configured');
          setState({
            type: 'success',
            version: MACRO.VERSION,
            setupMessages: allWarnings.length > 0 ? allWarnings : undefined
          });
        }
      } catch (error) {
        logForDebugging(`Install command failed: ${error}`, {
          level: 'error'
        });
        setState({
          type: 'error',
          message: errorMessage(error)
        });
      }
    }
    void run();
  }, [force, target]);
  useEffect(() => {
    if (state.type === 'success') {
      // Give success message time to render before exiting
      setTimeout(onDone, 2000, 'MindCode installation completed successfully', {
        display: 'system' as const
      });
    } else if (state.type === 'error') {
      // Give error message time to render before exiting
      setTimeout(onDone, 3000, 'MindCode installation failed', {
        display: 'system' as const
      });
    }
  }, [state, onDone]);
  return <Box flexDirection="column" marginTop={1}>
      {state.type === 'checking' && <Text color="success">Checking installation status...</Text>}

      {state.type === 'cleaning-npm' && <Text color="warning">Cleaning up old npm installations...</Text>}

      {state.type === 'installing' && <Text color="success">
          Installing MindCode native build {state.version}...
        </Text>}

      {state.type === 'setting-up' && <Text color="success">Setting up launcher and shell integration...</Text>}

      {state.type === 'set-up' && <SetupNotes messages={state.messages} />}

      {state.type === 'success' && <Box flexDirection="column" gap={1}>
          <Box>
            <StatusIcon status="success" withSpace />
            <Text color="success" bold>
              MindCode successfully installed!
            </Text>
          </Box>
          <Box marginLeft={2} flexDirection="column" gap={1}>
            {state.version !== 'current' && <Box>
                <Text dimColor>Version: </Text>
                <Text color="success">{state.version}</Text>
              </Box>}
            <Box>
              <Text dimColor>Location: </Text>
              <Text color="text">{getInstallationPath()}</Text>
            </Box>
          </Box>
          <Box marginLeft={2} flexDirection="column" gap={1}>
            <Box marginTop={1}>
              <Text dimColor>Next: Run </Text>
              <Text color="success" bold>
                mindcode --help
              </Text>
              <Text dimColor> to get started</Text>
            </Box>
          </Box>
          {state.setupMessages && <SetupNotes messages={state.setupMessages} />}
        </Box>}

      {state.type === 'error' && <Box flexDirection="column" gap={1}>
          <Box>
            <StatusIcon status="error" withSpace />
            <Text color="error">Installation failed</Text>
          </Box>
          <Text color="error">{state.message}</Text>
          <Box marginTop={1}>
            <Text dimColor>Try running with --force to override checks</Text>
          </Box>
        </Box>}
    </Box>;
}

// This is only used from cli.tsx, not as a slash command
export const install = {
  type: 'local-jsx' as const,
  name: 'install',
  description: 'Install MindCode native build',
  argumentHint: '[options]',
  async call(onDone: (result: string, options?: {
    display?: CommandResultDisplay;
  }) => void, _context: unknown, args: string[]) {
    // Parse arguments
    const force = args.includes('--force');
    const nonFlagArgs = args.filter(arg => !arg.startsWith('--'));
    const target = nonFlagArgs[0]; // 'latest', 'stable', or version like '1.0.34'

    const {
      unmount
    } = await render(<Install onDone={(result, options) => {
      unmount();
      onDone(result, options);
    }} force={force} target={target} />);
  }
};
