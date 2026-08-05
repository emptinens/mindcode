import { c as _c } from "react/compiler-runtime";
import React, { useMemo, useState } from 'react';
import type { CommandResultDisplay, LocalJSXCommandContext } from '../../commands.js';
import { type OptionWithDescription, Select } from '../../components/CustomSelect/select.js';
import { Dialog } from '../../components/design-system/Dialog.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { logEvent } from '../../services/analytics/index.js';
import { useClaudeAiLimits } from '../../services/claudeAiLimitsHook.js';
import type { ToolUseContext } from '../../Tool.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { getOauthAccountInfo, getSubscriptionType } from '../../utils/auth.js';
import { hasClaudeAiBillingAccess } from '../../utils/billing.js';
import { call as accountCall } from '../account/account.js';
import { call as extraUsageCall } from '../extra-usage/extra-usage.js';
import { extraUsage } from '../extra-usage/index.js';
type RateLimitOptionsMenuOptionType = 'switch-accounts' | 'extra-usage' | 'cancel';
type RateLimitOptionsMenuProps = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay | undefined;
  } | undefined) => void;
  context: ToolUseContext & LocalJSXCommandContext;
};
function RateLimitOptionsMenu(t0) {
  const $ = _c(25);
  const {
    onDone,
    context
  } = t0;
  const [subCommandJSX, setSubCommandJSX] = useState(null);
  const claudeAiLimits = useClaudeAiLimits();
  const hasExtraUsageEnabled = getOauthAccountInfo()?.hasExtraUsageEnabled === true;
  const subscriptionType = getSubscriptionType();
  const isTeamOrEnterprise = subscriptionType === "team" || subscriptionType === "enterprise";
  const buyFirst = getFeatureValue_CACHED_MAY_BE_STALE("tengu_jade_anvil_4", false);
  let t3;
  bb0: {
    let actionOptions;
    if ($[2] !== claudeAiLimits.overageDisabledReason || $[3] !== claudeAiLimits.overageStatus) {
      actionOptions = [];
      if (extraUsage.isEnabled()) {
        const hasBillingAccess = hasClaudeAiBillingAccess();
        const needsToRequestFromAdmin = isTeamOrEnterprise && !hasBillingAccess;
        const isOrgSpendCapDepleted = claudeAiLimits.overageDisabledReason === "out_of_credits" || claudeAiLimits.overageDisabledReason === "org_level_disabled_until" || claudeAiLimits.overageDisabledReason === "org_service_zero_credit_limit";
        if (needsToRequestFromAdmin && isOrgSpendCapDepleted) {} else {
          const isOverageState = claudeAiLimits.overageStatus === "rejected" || claudeAiLimits.overageStatus === "allowed_warning";
          let label;
          if (needsToRequestFromAdmin) {
            label = isOverageState ? "Request more" : "Request extra usage";
          } else {
            label = hasExtraUsageEnabled ? "Add funds to continue with extra usage" : "Switch to extra usage";
          }
          let t4;
          if ($[5] !== label) {
            t4 = {
              label,
              value: "extra-usage"
            };
            $[5] = label;
            $[6] = t4;
          } else {
            t4 = $[6];
          }
          actionOptions.push(t4);
        }
      }
      $[2] = claudeAiLimits.overageDisabledReason;
      $[3] = claudeAiLimits.overageStatus;
      $[4] = actionOptions;
    } else {
      actionOptions = $[4];
    }
    let t4;
    if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
      t4 = {
        label: "Switch Accounts",
        value: "switch-accounts"
      };
      $[7] = t4;
    } else {
      t4 = $[7];
    }
    const switchAccountsOption = t4;
    let t5;
    if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
      t5 = {
        label: "Stop and wait for limit to reset",
        value: "cancel"
      };
      $[8] = t5;
    } else {
      t5 = $[8];
    }
    const cancelOption = t5;
    if (buyFirst) {
      let t6;
      if ($[9] !== actionOptions) {
        t6 = [switchAccountsOption, ...actionOptions, cancelOption];
        $[9] = actionOptions;
        $[10] = t6;
      } else {
        t6 = $[10];
      }
      t3 = t6;
      break bb0;
    }
    let t6;
    if ($[11] !== actionOptions) {
      t6 = [switchAccountsOption, cancelOption, ...actionOptions];
      $[11] = actionOptions;
      $[12] = t6;
    } else {
      t6 = $[12];
    }
    t3 = t6;
  }
  const options = t3;
  let t4;
  if ($[13] !== onDone) {
    t4 = function handleCancel() {
      logEvent("tengu_rate_limit_options_menu_cancel", {});
      onDone(undefined, {
        display: "skip"
      });
    };
    $[13] = onDone;
    $[14] = t4;
  } else {
    t4 = $[14];
  }
  const handleCancel = t4;
  let t5;
  if ($[15] !== context || $[16] !== handleCancel || $[17] !== onDone) {
    t5 = function handleSelect(value) {
      if (value === "switch-accounts") {
        logEvent("tengu_rate_limit_options_menu_select_switch_accounts", {});
        accountCall(onDone, context).then(jsx => {
          if (jsx) {
            setSubCommandJSX(jsx);
          }
        });
      } else {
        if (value === "extra-usage") {
          logEvent("tengu_rate_limit_options_menu_select_extra_usage", {});
          extraUsageCall(onDone, context).then(jsx_0 => {
            if (jsx_0) {
              setSubCommandJSX(jsx_0);
            }
          });
        } else {
          if (value === "cancel") {
            handleCancel();
          }
        }
      }
    };
    $[15] = context;
    $[16] = handleCancel;
    $[17] = onDone;
    $[18] = t5;
  } else {
    t5 = $[18];
  }
  const handleSelect = t5;
  if (subCommandJSX) {
    return subCommandJSX;
  }
  let t6;
  if ($[19] !== handleSelect || $[20] !== options) {
    t6 = <Select options={options} onChange={handleSelect} visibleOptionCount={options.length} />;
    $[19] = handleSelect;
    $[20] = options;
    $[21] = t6;
  } else {
    t6 = $[21];
  }
  let t7;
  if ($[22] !== handleCancel || $[23] !== t6) {
    t7 = <Dialog title="What do you want to do?" onCancel={handleCancel} color="suggestion">{t6}</Dialog>;
    $[22] = handleCancel;
    $[23] = t6;
    $[24] = t7;
  } else {
    t7 = $[24];
  }
  return t7;
}
export async function call(onDone: LocalJSXCommandOnDone, context: ToolUseContext & LocalJSXCommandContext): Promise<React.ReactNode> {
  return <RateLimitOptionsMenu onDone={onDone} context={context} />;
}
