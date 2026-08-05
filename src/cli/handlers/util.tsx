import { c as _c } from "react/compiler-runtime";
/**
 * Miscellaneous subcommand handlers — extracted from main.tsx for lazy loading.
 * VEXZY setup, doctor, install
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handlers intentionally exit */

import { cwd } from 'process';
import React from 'react';
import { useManagePlugins } from '../../hooks/useManagePlugins.js';
import type { Root } from '../../ink.js';
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js';
import { logEvent } from '../../services/analytics/index.js';
import { MCPConnectionManager } from '../../services/mcp/MCPConnectionManager.js';
import { AppStateProvider } from '../../state/AppState.js';
import { onChangeAppState } from '../../state/onChangeAppState.js';
export async function setupTokenHandler(root: Root): Promise<void> {
  logEvent('tengu_setup_token_command', {});
  root.unmount();
  process.stdout.write(
    'VEXZY authentication uses VEXZY_API_KEY.\n\n' +
      'Set it in your shell:\n' +
      '  export VEXZY_API_KEY="forge-…"\n\n' +
      'The legacy OAuth setup flow is not used by MindCode.\n',
  );
  process.exit(0);
}

// DoctorWithPlugins wrapper + doctor handler
const DoctorLazy = React.lazy(() => import('../../screens/Doctor.js').then(m => ({
  default: m.Doctor
})));
function DoctorWithPlugins(t0) {
  const $ = _c(2);
  const {
    onDone
  } = t0;
  useManagePlugins();
  let t1;
  if ($[0] !== onDone) {
    t1 = <React.Suspense fallback={null}><DoctorLazy onDone={onDone} /></React.Suspense>;
    $[0] = onDone;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  return t1;
}
export async function doctorHandler(root: Root): Promise<void> {
  logEvent('tengu_doctor_command', {});
  await new Promise<void>(resolve => {
    root.render(<AppStateProvider>
        <KeybindingSetup>
          <MCPConnectionManager dynamicMcpConfig={undefined} isStrictMcpConfig={false}>
            <DoctorWithPlugins onDone={() => {
            void resolve();
          }} />
          </MCPConnectionManager>
        </KeybindingSetup>
      </AppStateProvider>);
  });
  root.unmount();
  process.exit(0);
}

// install handler
export async function installHandler(target: string | undefined, options: {
  force?: boolean;
}): Promise<void> {
  const {
    setup
  } = await import('../../setup.js');
  await setup(cwd(), 'default', false, false, undefined, false);
  const {
    install
  } = await import('../../commands/install.js');
  await new Promise<void>(resolve => {
    const args: string[] = [];
    if (target) args.push(target);
    if (options.force) args.push('--force');
    void install.call(result => {
      void resolve();
      process.exit(result.includes('failed') ? 1 : 0);
    }, {}, args);
  });
}
