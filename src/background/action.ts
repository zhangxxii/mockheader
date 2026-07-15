import { loadConfig, profileShortName, type AppConfig, type Profile } from "../shared";

const ACTION_ICON_SIZES = [16, 32] as const;
const ENABLED_BADGE_BACKGROUND = "#126A5A";
const ENABLED_BADGE_TEXT = "#F4FFFC";

const ICON_COLORS = {
  enabled: {
    dark: "#1b1f21",
    accent: "#20c997",
    text: "#e7ecea",
  },
  disabled: {
    dark: "#272b2d",
    accent: "#697276",
    text: "#aeb5b8",
  },
} as const;

const actionIconCache = new Map<boolean, Record<string, ImageData>>();

function createActionIcon(size: number, disabled: boolean): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建工具栏图标画布");

  const colors = disabled ? ICON_COLORS.disabled : ICON_COLORS.enabled;
  const scale = size / 128;
  context.scale(scale, scale);
  context.clearRect(0, 0, 128, 128);

  context.fillStyle = colors.accent;
  context.beginPath();
  context.roundRect(5, 5, 118, 118, 25);
  context.fill();

  context.fillStyle = colors.dark;
  context.beginPath();
  context.roundRect(15, 15, 98, 98, 17);
  context.fill();

  context.strokeStyle = colors.text;
  context.lineCap = "round";
  context.lineWidth = 11;
  context.beginPath();
  context.moveTo(34, 37);
  context.lineTo(34, 91);
  context.moveTo(94, 37);
  context.lineTo(94, 91);
  context.moveTo(34, 64);
  context.lineTo(94, 64);
  context.stroke();

  context.fillStyle = colors.accent;
  context.beginPath();
  context.arc(34, 37, 7, 0, Math.PI * 2);
  context.arc(94, 91, 7, 0, Math.PI * 2);
  context.fill();

  return context.getImageData(0, 0, size, size);
}

function iconImageData(disabled: boolean): Record<string, ImageData> {
  const cached = actionIconCache.get(disabled);
  if (cached) return cached;

  const generated = Object.fromEntries(
    ACTION_ICON_SIZES.map((size) => [
      String(size),
      createActionIcon(size, disabled),
    ]),
  );
  actionIconCache.set(disabled, generated);
  return generated;
}

function activeProfile(config: AppConfig): Profile | null {
  if (!config.enabled || config.activeProfileId === null) {
    return null;
  }
  return config.profiles.find(({ id }) => id === config.activeProfileId) ?? null;
}

async function applyOptionalAction(operation: () => void | Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    // Badge colors and hover titles are cosmetic. Some Chromium derivatives
    // expose these methods but reject them at runtime; icon state and badge
    // text must continue to work in that case.
  }
}

async function applyDisabledAction(): Promise<void> {
  await Promise.all([
    chrome.action.setIcon({ imageData: iconImageData(true) }),
    chrome.action.setBadgeText({ text: "" }),
  ]);
  await applyOptionalAction(() =>
    chrome.action.setTitle({ title: "Mock Header · 已关闭" }),
  );
}

async function applyEnabledAction(profile: Profile): Promise<void> {
  await Promise.all([
    chrome.action.setIcon({ imageData: iconImageData(false) }),
    chrome.action.setBadgeText({ text: profileShortName(profile.name) }),
  ]);
  await Promise.all([
    applyOptionalAction(() =>
      chrome.action.setBadgeBackgroundColor({ color: ENABLED_BADGE_BACKGROUND }),
    ),
    applyOptionalAction(() => {
      if (typeof chrome.action.setBadgeTextColor !== "function") return;
      return chrome.action.setBadgeTextColor({ color: ENABLED_BADGE_TEXT });
    }),
    applyOptionalAction(() =>
      chrome.action.setTitle({ title: `Mock Header · ${profile.name}` }),
    ),
  ]);
}

/** Synchronizes the toolbar action from the authoritative stored config. */
export async function syncToolbarAction(): Promise<void> {
  const config = await loadConfig();
  const profile = activeProfile(config);
  if (!profile) {
    await applyDisabledAction();
    return;
  }
  await applyEnabledAction(profile);
}

/** Toolbar diagnostics must never change the result of a DNR rebuild. */
export async function syncToolbarActionBestEffort(): Promise<void> {
  try {
    await syncToolbarAction();
  } catch (error) {
    console.error("[Mock Header] 同步工具栏 action 状态失败", error);
    try {
      await applyDisabledAction();
    } catch (fallbackError) {
      console.error("[Mock Header] 回退工具栏 action 到关闭状态失败", fallbackError);
    }
  }
}
