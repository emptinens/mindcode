import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { type EffortLevel, type EffortValue, getDisplayedEffortLevel, getEffortEnvOverride, getEffortValueDescription, getSupportedEffortLevels, isEffortLevel, modelSupportsXhighEffort, toPersistableEffort } from '../../utils/effort.js';
import { EffortSlider } from '../../components/EffortSlider.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
const COMMON_HELP_ARGS = ['help', '-h', '--help'];
type EffortCommandResult = {
  message: string;
  effortUpdate?: {
    value: EffortValue | undefined;
  };
  // Session ultracode flag to apply to appState (true to enable, false to clear).
  ultracode?: boolean;
};
function setEffortValue(effortValue: EffortValue, model?: string): EffortCommandResult {
  const supported = model === undefined ? [] : getSupportedEffortLevels(model);
  if (model !== undefined && (typeof effortValue !== 'string' || !supported.includes(effortValue))) {
    return { message: `Effort level ${effortValue} is not advertised for ${model}. Valid options: ${supported.join(', ') || 'none'}` };
  }
  const persistable = toPersistableEffort(effortValue);
  if (persistable !== undefined) {
    const result = updateSettingsForSource('userSettings', {
      effortLevel: persistable
    });
    if (result.error) {
      return {
        message: `Failed to set effort level: ${result.error.message}`
      };
    }
  }
  logEvent('tengu_effort_command', {
    effort: effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });

  // Env var wins at resolveAppliedEffort time. Only flag it when it actually
  // conflicts — if env matches what the user just asked for, the outcome is
  // the same, so "Set effort to X" is true and the note is noise.
  const envOverride = getEffortEnvOverride();
  if (envOverride !== undefined && envOverride !== effortValue) {
    const envRaw = process.env.MINDCODE_EFFORT_LEVEL;
    if (persistable === undefined) {
      return {
        message: `Not applied: MINDCODE_EFFORT_LEVEL=${envRaw} overrides effort this session, and ${effortValue} is session-only (nothing saved)`,
        effortUpdate: {
          value: effortValue
        }
      };
    }
    return {
      message: `MINDCODE_EFFORT_LEVEL=${envRaw} overrides this session — clear it and ${effortValue} takes over`,
      effortUpdate: {
        value: effortValue
      }
    };
  }
  const description = getEffortValueDescription(effortValue);
  const suffix = persistable !== undefined
    ? ' (saved as your default for new sessions)'
    : ' (this session only)';
  return {
    message: `Set effort level to ${effortValue}${suffix}: ${description}`,
    effortUpdate: {
      value: effortValue
    }
  };
}
export function showCurrentEffort(appStateEffort: EffortValue | undefined, model: string, ultracode = false): EffortCommandResult {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const workflowGate = require('../../tools/WorkflowTool/gate.js') as typeof import('../../tools/WorkflowTool/gate.js');
  /* eslint-enable @typescript-eslint/no-require-imports */
  // Ultracode is a session mode (xhigh + standing orchestration); surface it by
  // name rather than the bare 'xhigh' it resolves to.
  if (ultracode && workflowGate.isWorkflowsEnabled() && getDisplayedEffortLevel(model, appStateEffort) === 'xhigh') {
    return {
      message: 'Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)'
    };
  }
  const envOverride = getEffortEnvOverride();
  const effectiveValue = envOverride === null ? undefined : envOverride ?? appStateEffort;
  if (effectiveValue === undefined) {
    const level = getDisplayedEffortLevel(model, appStateEffort);
    return {
      message: `Effort level: default (currently ${level})`
    };
  }
  const description = getEffortValueDescription(effectiveValue);
  return {
    message: `Current effort level: ${effectiveValue} (${description})`
  };
}
function unsetEffortLevel(): EffortCommandResult {
  const result = updateSettingsForSource('userSettings', {
    effortLevel: undefined
  });
  if (result.error) {
    return {
      message: `Failed to set effort level: ${result.error.message}`
    };
  }
  logEvent('tengu_effort_command', {
    effort: 'unset' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  return {
    message: 'Effort override cleared; using the model default',
    effortUpdate: {
      value: undefined
    }
  };
}
export function executeEffort(args: string, model?: string): EffortCommandResult {
  const normalized = args.toLowerCase();
  /* eslint-disable @typescript-eslint/no-require-imports */
  const workflowGate = require('../../tools/WorkflowTool/gate.js') as typeof import('../../tools/WorkflowTool/gate.js');
  /* eslint-enable @typescript-eslint/no-require-imports */
  // "ultracode" is a session mode (xhigh effort + standing orchestration), not
  // a real reasoning tier — it resolves to xhigh and never reaches the API.
  // Mirrors x_A / the upstream gating exactly.
  if (normalized === 'ultracode') {
    if (!workflowGate.isWorkflowsEnabled()) {
      return {
        message:
          'Ultracode needs dynamic workflows enabled (see /config). Valid options are: none, minimal, low, medium, high, xhigh, max, auto'
      };
    }
    if (model && !modelSupportsXhighEffort(model)) {
      return {
        message: `Ultracode requires advertised xhigh effort for ${model}`
      };
    }
    workflowGate.setUltracodeSessionEnabled(true);
    const xhigh = setEffortValue('xhigh', model);
    return {
      message:
        'Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration',
      effortUpdate: xhigh.effortUpdate,
      ultracode: true
    };
  }
  // Any other effort selection exits ultracode mode.
  workflowGate.setUltracodeSessionEnabled(false);
  if (normalized === 'unset' || normalized === 'default') {
    return { ...unsetEffortLevel(), ultracode: false };
  }
  if (!isEffortLevel(normalized)) {
    return {
      message: `Invalid argument: ${args}. Valid options are: none, minimal, low, medium, high, xhigh, max, auto, unset, default`
    };
  }
  return { ...setEffortValue(normalized, model), ultracode: false };
}
function ShowCurrentEffort(t0) {
  const {
    onDone
  } = t0;
  const effortValue = useAppState(_temp);
  const ultracode = useAppState(s => s.ultracode);
  const model = useMainLoopModel();
  const {
    message
  } = showCurrentEffort(effortValue, model, ultracode);
  onDone(`${message}\n\nLeader effort only: /effort controls the current Leader model. Worker effort is assigned per task by the Leader and never inherits this value.`);
  return null;
}
function _temp(s) {
  return s.effortValue;
}
function EffortSliderStep(t0) {
  const {
    onDone
  } = t0;
  const effortValue = useAppState(_temp);
  const ultracode = useAppState(s => s.ultracode);
  const setAppState = useSetAppState();
  const model = useMainLoopModel();
  // Route every slider pick (including 'ultracode') through executeEffort so the
  // session ultracode flag, effort value, and exact gating all stay consistent.
  const handleSelect = (level: EffortLevel | 'ultracode') => {
    const result = executeEffort(level, model);
    setAppState(prev => ({
      ...prev,
      ...(result.effortUpdate ? { effortValue: result.effortUpdate.value } : {}),
      ...(result.ultracode !== undefined ? { ultracode: result.ultracode } : {})
    }));
    onDone(result.message);
  };
  const handleCancel = () => {
    const {
      message
    } = showCurrentEffort(effortValue, model, ultracode);
    onDone(`${message}\n\nLeader effort only: /effort controls the current Leader model. Worker effort is assigned per task by the Leader and never inherits this value.`);
  };
  return <EffortSlider model={model} currentEffort={effortValue} ultracode={ultracode} onSelect={handleSelect} onCancel={handleCancel} />;
}
function ApplyEffortAndClose({
  result,
  onDone
}: {
  result: EffortCommandResult;
  onDone: (message: string) => void;
}): React.ReactNode {
  const setAppState = useSetAppState();
  const { effortUpdate, message, ultracode } = result;
  React.useEffect(() => {
    setAppState(prev => ({
      ...prev,
      ...(effortUpdate ? { effortValue: effortUpdate.value } : {}),
      ...(ultracode !== undefined ? { ultracode } : {})
    }));
    onDone(`${message}\n\nLeader effort only: /effort controls the current Leader model. Worker effort is assigned per task by the Leader and never inherits this value.`);
  }, [setAppState, effortUpdate, message, ultracode, onDone]);
  return null;
}
export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args?: string): Promise<React.ReactNode> {
  const commandArgs = args?.trim() || '';
  if (COMMON_HELP_ARGS.includes(commandArgs)) {
    onDone('Usage: /effort [none|minimal|low|medium|high|xhigh|max|auto|unset|default|ultracode]\n\nLeader effort only: this command controls the current Leader model. Worker effort is assigned per task by the Leader and never inherits this value.\n\nEffort levels:\n- low: Quick, straightforward implementation\n- medium: Balanced approach with standard testing\n- high: Comprehensive implementation with extensive testing\n- minimal: Minimal reasoning\n- xhigh: Very deep reasoning\n- max: Maximum reasoning\n- ultracode: xhigh effort plus standing dynamic-workflow orchestration (uses the Workflow tool on every substantive task)\n- auto: Use the provider\'s automatic reasoning value\n- unset/default: Clear the override');
    return;
  }
  if (!commandArgs) {
    return <EffortSliderStep onDone={onDone} />;
  }
  if (commandArgs === 'current' || commandArgs === 'status') {
    return <ShowCurrentEffort onDone={onDone} />;
  }
  const model = (_context as { options?: { mainLoopModel?: string } })?.options
    ?.mainLoopModel;
  const result = executeEffort(commandArgs, model);
  return <ApplyEffortAndClose result={result} onDone={onDone} />;
}
