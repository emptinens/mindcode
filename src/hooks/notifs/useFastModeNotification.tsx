import { c as _c } from "react/compiler-runtime";
import { useEffect } from 'react';
import { useNotifications } from 'src/context/notifications.js';
import { useAppState, useSetAppState } from 'src/state/AppState.js';
import { type CooldownReason, isFastModeEnabled, onCooldownExpired, onCooldownTriggered, onOrgFastModeChanged } from 'src/utils/fastMode.js';
import { formatDuration } from 'src/utils/format.js';
import { getIsRemoteMode } from '../../bootstrap/state.js';
const COOLDOWN_STARTED_KEY = 'fast-mode-cooldown-started';
const COOLDOWN_EXPIRED_KEY = 'fast-mode-cooldown-expired';
const ORG_CHANGED_KEY = 'fast-mode-org-changed';
export function useFastModeNotification() {
  const $ = _c(13);
  const {
    addNotification
  } = useNotifications();
  const isFastMode = useAppState(_temp);
  const setAppState = useSetAppState();
  let t0;
  let t1;
  if ($[0] !== addNotification || $[1] !== isFastMode || $[2] !== setAppState) {
    t0 = () => {
      if (getIsRemoteMode()) {
        return;
      }
      if (!isFastModeEnabled()) {
        return;
      }
      return onOrgFastModeChanged(orgEnabled => {
        if (orgEnabled) {
          addNotification({
            key: ORG_CHANGED_KEY,
            color: "fastMode",
            priority: "immediate",
            text: "Fast mode is now available \xB7 /fast to turn on"
          });
        } else {
          if (isFastMode) {
            setAppState(_temp2);
            addNotification({
              key: ORG_CHANGED_KEY,
              color: "warning",
              priority: "immediate",
              text: "Fast mode has been disabled by your organization"
            });
          }
        }
      });
    };
    t1 = [addNotification, isFastMode, setAppState];
    $[0] = addNotification;
    $[1] = isFastMode;
    $[2] = setAppState;
    $[3] = t0;
    $[4] = t1;
  } else {
    t0 = $[3];
    t1 = $[4];
  }
  useEffect(t0, t1);
  let t4;
  let t5;
  if ($[5] !== addNotification || $[6] !== isFastMode) {
    t4 = () => {
      if (getIsRemoteMode()) {
        return;
      }
      if (!isFastMode) {
        return;
      }
      const unsubTriggered = onCooldownTriggered((resetAt, reason) => {
        const resetIn = formatDuration(resetAt - Date.now(), {
          hideTrailingZeros: true
        });
        const message_0 = getCooldownMessage(reason, resetIn);
        addNotification({
          key: COOLDOWN_STARTED_KEY,
          invalidates: [COOLDOWN_EXPIRED_KEY],
          text: message_0,
          color: "warning",
          priority: "immediate"
        });
      });
      const unsubExpired = onCooldownExpired(() => {
        addNotification({
          key: COOLDOWN_EXPIRED_KEY,
          invalidates: [COOLDOWN_STARTED_KEY],
          color: "fastMode",
          text: "Fast limit reset \xB7 now using fast mode",
          priority: "immediate"
        });
      });
      return () => {
        unsubTriggered();
        unsubExpired();
      };
    };
    t5 = [addNotification, isFastMode];
    $[5] = addNotification;
    $[6] = isFastMode;
    $[7] = t4;
    $[8] = t5;
  } else {
    t4 = $[7];
    t5 = $[8];
  }
  useEffect(t4, t5);
}
function _temp2(prev) {
  return {
    ...prev,
    fastMode: false
  };
}
function _temp(s) {
  return s.fastMode;
}
function getCooldownMessage(reason: CooldownReason, resetIn: string): string {
  switch (reason) {
    case 'overloaded':
      return `Fast mode overloaded and is temporarily unavailable · resets in ${resetIn}`;
    case 'rate_limit':
      return `Fast limit reached and temporarily disabled · resets in ${resetIn}`;
  }
}
