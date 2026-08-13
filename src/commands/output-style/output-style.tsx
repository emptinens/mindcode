import type { LocalJSXCommandOnDone } from '../../types/command.js';
export async function call(onDone: LocalJSXCommandOnDone): Promise<undefined> {
  onDone('/output-style has been deprecated. Set your output style in your settings file. Changes take effect on the next session.', {
    display: 'system'
  });
}