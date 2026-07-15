import {
  CONFIG_STORAGE_KEY,
  isSyncRulesMessage,
  saveRuleSyncState,
  type SyncRulesResponse,
} from "../shared";
import { syncToolbarActionBestEffort } from "./action";
import { rebuildDynamicRules } from "./rules";

let rebuildTail: Promise<void> = Promise.resolve();

/** Serializes rebuilds so rapid UI/storage changes cannot apply out of order. */
export function enqueueRulesRebuild(): Promise<number> {
  const task = rebuildTail.then(async () => {
    try {
      const ruleCount = await rebuildDynamicRules();
      try {
        await saveRuleSyncState({
          status: "success",
          ruleCount,
          error: null,
          updatedAt: Date.now(),
        });
      } catch (stateError) {
        // DNR rules are already correct. A diagnostic persistence failure should
        // not turn a successful rules sync into a false runtime failure.
        console.error("[Mock Header] 保存规则同步成功状态失败", stateError);
      }
      return ruleCount;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await saveRuleSyncState({
          status: "error",
          ruleCount: 0,
          error: message,
          updatedAt: Date.now(),
        });
      } catch (stateError) {
        // Keep the original rebuild error for the runtime response and logs.
        console.error("[Mock Header] 保存规则同步失败状态失败", stateError);
      }
      throw error;
    } finally {
      await syncToolbarActionBestEffort();
    }
  });
  rebuildTail = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

function runInBackground(event: string): void {
  void enqueueRulesRebuild().catch((error: unknown) => {
    console.error(`[Mock Header] ${event} 同步动态规则失败`, error);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  runInBackground("installed");
});

chrome.runtime.onStartup.addListener(() => {
  runInBackground("startup");
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && CONFIG_STORAGE_KEY in changes) {
    runInBackground("storage-change");
  }
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isSyncRulesMessage(message)) {
    return false;
  }

  void enqueueRulesRebuild().then(
    (ruleCount) => {
      const response: SyncRulesResponse = { ok: true, ruleCount };
      sendResponse(response);
    },
    (error: unknown) => {
      const response: SyncRulesResponse = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      console.error("[Mock Header] runtime-message 同步动态规则失败", error);
      sendResponse(response);
    },
  );

  return true;
});

export { buildDynamicRules, rebuildDynamicRules } from "./rules";
