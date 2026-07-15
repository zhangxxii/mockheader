import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';

import {
  CONFIG_SCHEMA_VERSION,
  CONFIG_STORAGE_KEY,
  DEFAULT_CONFIG,
  DEFAULT_RULE_SYNC_STATE,
  RULE_SYNC_STATE_KEY,
  createEmptyProfile,
  loadConfig,
  loadRuleSyncState,
  notifyBackgroundSync,
  profileShortName,
  saveConfig,
  validateAndNormalizeConfig,
  validateAndNormalizeProfile,
  type AppConfig,
  type HeaderCandidate,
  type MatchMode,
  type Profile,
  type RuleSyncState,
} from '../shared';

type ToastKind = 'success' | 'error' | 'info';

interface ToastState {
  id: number;
  kind: ToastKind;
  message: string;
}

interface DraftProfile {
  profile: Profile;
  isNew: boolean;
}

interface PopupDraftSnapshot {
  schemaVersion: 1;
  draft: DraftProfile;
  baselineProfile: Profile | null;
}

type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

interface AutosaveState {
  status: AutosaveStatus;
  error: string | null;
}

interface ProfileDropTarget {
  profileId: string;
  position: 'before' | 'after';
}

interface CurrentTabState {
  hostname: string;
  supported: boolean;
}

type IconName =
  | 'add'
  | 'clipboard'
  | 'copy'
  | 'download'
  | 'refresh'
  | 'trash'
  | 'upload';

const EMPTY_TAB: CurrentTabState = {
  hostname: '正在读取当前页面…',
  supported: false,
};

const MATCH_MODE_OPTIONS: Array<{ value: MatchMode; label: string }> = [
  { value: 'page', label: '页面域名' },
  { value: 'request', label: '请求 URL' },
  { value: 'page_and_request', label: '页面域名 + 请求 URL' },
];

const POPUP_DRAFT_STORAGE_KEY = 'mockHeaderPopupDraft';
const AUTOSAVE_DELAY_MS = 320;
const PROFILE_DRAG_DATA_TYPE = 'application/x-mock-header-profile';

const iconPaths: Record<IconName, ReactNode> = {
  add: <path d="M8 2.5v11M2.5 8h11" />,
  clipboard: (
    <>
      <rect x="3" y="3.5" width="10" height="11" rx="1.5" />
      <path d="M6 3.5V2h4v1.5M5.5 7h5M5.5 10h5" />
    </>
  ),
  copy: (
    <>
      <path d="M5.25 4.25v-1A1.25 1.25 0 0 1 6.5 2h6.25A1.25 1.25 0 0 1 14 3.25V9.5a1.25 1.25 0 0 1-1.25 1.25h-1" />
      <rect x="2" y="5.25" width="8.75" height="8.75" rx="1.25" />
    </>
  ),
  download: <path d="M8 2v8m0 0 3-3m-3 3L5 7M2.5 13.5h11" />,
  refresh: (
    <>
      <path d="M13.25 4.5V1.75m0 2.75H10.5" />
      <path d="M12.55 4.1A5.75 5.75 0 1 0 13.4 9" />
    </>
  ),
  trash: <path d="M2.5 4.5h11M6 2.5h4M5 6.5v5M8 6.5v5M11 6.5v5M4 4.5l.7 9h6.6l.7-9" />,
  upload: <path d="M8 10V2m0 0 3 3M8 2 5 5M2.5 13.5h11" />,
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.25"
      >
        {iconPaths[name]}
      </g>
    </svg>
  );
}

function makeId(prefix: string): string {
  const suffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function cloneProfile(profile: Profile): Profile {
  return {
    ...profile,
    pageDomains: [...profile.pageDomains],
    requestUrlPatterns: [...profile.requestUrlPatterns],
    headers: profile.headers.map((header) => ({ ...header })),
  };
}

function sameProfile(left: Profile, right: Profile | undefined): boolean {
  return Boolean(right && JSON.stringify(left) === JSON.stringify(right));
}

function configFingerprint(config: AppConfig): string {
  return JSON.stringify(config);
}

function normalizeHeaderName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listToText(entries: string[]): string {
  return entries.join('\n');
}

function textToList(value: string): string[] {
  return value.split(/\r?\n/);
}

function prepareProfileForValidation(profile: Profile): Profile {
  return {
    ...profile,
    pageDomains: profile.pageDomains.filter((entry) => entry.trim()),
    requestUrlPatterns: profile.requestUrlPatterns.filter((entry) => entry.trim()),
  };
}

function nextProfileName(profiles: Profile[]): string {
  const names = new Set(profiles.map(({ name }) => name.trim()));
  if (!names.has('新 Profile')) return '新 Profile';
  let index = 2;
  while (names.has(`新 Profile ${index}`)) index += 1;
  return `新 Profile ${index}`;
}

function newHeader(): HeaderCandidate {
  return {
    id: makeId('header'),
    enabled: false,
    name: '',
    value: '',
    comment: '',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDraftProfileValue(value: unknown): value is Profile {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !MATCH_MODE_OPTIONS.some(({ value: mode }) => mode === value.matchMode) ||
    !Array.isArray(value.pageDomains) ||
    !value.pageDomains.every((entry) => typeof entry === 'string') ||
    !Array.isArray(value.requestUrlPatterns) ||
    !value.requestUrlPatterns.every((entry) => typeof entry === 'string') ||
    !Array.isArray(value.headers)
  ) {
    return false;
  }

  return value.headers.every(
    (header) =>
      isRecord(header) &&
      typeof header.id === 'string' &&
      typeof header.enabled === 'boolean' &&
      typeof header.name === 'string' &&
      typeof header.value === 'string' &&
      typeof header.comment === 'string',
  );
}

function parsePopupDraftSnapshot(value: unknown): PopupDraftSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.draft)) {
    return null;
  }
  if (
    typeof value.draft.isNew !== 'boolean' ||
    !isDraftProfileValue(value.draft.profile) ||
    (value.baselineProfile !== null && !isDraftProfileValue(value.baselineProfile))
  ) {
    return null;
  }
  return value as unknown as PopupDraftSnapshot;
}

async function loadPopupDraftSnapshot(): Promise<PopupDraftSnapshot | null> {
  const stored = await chrome.storage.session.get(POPUP_DRAFT_STORAGE_KEY);
  return parsePopupDraftSnapshot(stored[POPUP_DRAFT_STORAGE_KEY]);
}

function normalizeDomainForPreview(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/^\*\./, '').replace(/^\./, '').replace(/\.$/, '');
}

function matchesPageDomain(hostname: string, configuredDomains: string[]): boolean {
  const currentHostname = hostname.trim().toLocaleLowerCase().replace(/\.$/, '');
  return configuredDomains.some((entry) => {
    const domain = normalizeDomainForPreview(entry);
    return Boolean(domain && (currentHostname === domain || currentHostname.endsWith(`.${domain}`)));
  });
}

function getProfileDropPosition(
  element: HTMLElement,
  clientY: number,
): ProfileDropTarget['position'] {
  const bounds = element.getBoundingClientRect();
  return clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [ruleSyncState, setRuleSyncState] = useState<RuleSyncState>(() => ({
    ...DEFAULT_RULE_SYNC_STATE,
  }));
  const [draft, setDraft] = useState<DraftProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [externalChangePending, setExternalChangePending] = useState(false);
  const [tab, setTab] = useState<CurrentTabState>(EMPTY_TAB);
  const [tabReady, setTabReady] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [autosaveState, setAutosaveState] = useState<AutosaveState>({
    status: 'idle',
    error: null,
  });
  const [draggedProfileId, setDraggedProfileId] = useState<string | null>(null);
  const [profileDropTarget, setProfileDropTarget] = useState<ProfileDropTarget | null>(null);

  const importInputRef = useRef<HTMLInputElement>(null);
  const profileListRef = useRef<HTMLDivElement>(null);
  const toastIdRef = useRef(0);
  const draftRef = useRef<DraftProfile | null>(null);
  const baselineProfileRef = useRef<Profile | null>(null);
  const dirtyRef = useRef(false);
  const draftStorageTailRef = useRef<Promise<void>>(Promise.resolve());
  const configOperationTailRef = useRef<Promise<void>>(Promise.resolve());
  const autosaveTimerRef = useRef<number | null>(null);
  const draftRevisionRef = useRef(0);
  const busyRef = useRef(false);
  const suppressProfileClickRef = useRef(false);
  const ownWriteFingerprintsRef = useRef(new Set<string>());
  const pendingExternalConfigRef = useRef<AppConfig | null>(null);

  const baselineProfile = baselineProfileRef.current;
  const originalProfile =
    baselineProfile && draft && baselineProfile.id === draft.profile.id
      ? baselineProfile
      : undefined;
  const dirty = Boolean(draft && (draft.isNew || !sameProfile(draft.profile, originalProfile)));
  draftRef.current = draft;
  dirtyRef.current = dirty;

  const visibleProfiles = useMemo(() => {
    if (!config) return [];
    if (!draft) return config.profiles;
    if (draft.isNew) return [...config.profiles, draft.profile];
    return config.profiles.map((profile) =>
      profile.id === draft.profile.id ? draft.profile : profile,
    );
  }, [config, draft]);

  const showToast = useCallback((message: string, kind: ToastKind = 'success') => {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, kind, message });
  }, []);

  const replaceDraft = useCallback((nextDraft: DraftProfile | null) => {
    draftRevisionRef.current += 1;
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }, []);

  const selectInitialDraft = useCallback((nextConfig: AppConfig, preferredId?: string) => {
    const selected =
      nextConfig.profiles.find(({ id }) => id === preferredId) ??
      nextConfig.profiles.find(({ id }) => id === nextConfig.activeProfileId);
    baselineProfileRef.current = selected ? cloneProfile(selected) : null;
    replaceDraft(selected ? { profile: cloneProfile(selected), isNew: false } : null);
  }, [replaceDraft]);

  const rememberOwnWrite = useCallback((nextConfig: AppConfig) => {
    const fingerprint = configFingerprint(nextConfig);
    ownWriteFingerprintsRef.current.add(fingerprint);
    window.setTimeout(() => ownWriteFingerprintsRef.current.delete(fingerprint), 3_000);
  }, []);

  const enqueueDraftStorageOperation = useCallback((operation: () => Promise<void>) => {
    const task = draftStorageTailRef.current.catch(() => undefined).then(operation);
    draftStorageTailRef.current = task;
    return task;
  }, []);

  const enqueueConfigOperation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const task = configOperationTailRef.current.catch(() => undefined).then(operation);
    configOperationTailRef.current = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }, []);

  const cancelAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  const beginBusyOperation = useCallback(() => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  }, []);

  const endBusyOperation = useCallback(() => {
    busyRef.current = false;
    setBusy(false);
  }, []);

  const clearStoredDraft = useCallback(async () => {
    try {
      await enqueueDraftStorageOperation(() =>
        chrome.storage.session.remove(POPUP_DRAFT_STORAGE_KEY),
      );
    } catch (error) {
      console.error('[Mock Header] 清理 Popup 草稿失败', error);
    }
  }, [enqueueDraftStorageOperation]);

  const loadInitialState = useCallback(async () => {
    setLoading(true);
    try {
      const [nextConfig, nextRuleState, savedDraft] = await Promise.all([
        loadConfig(),
        loadRuleSyncState(),
        loadPopupDraftSnapshot().catch((error: unknown) => {
          showToast(`临时草稿读取失败：${errorMessage(error)}`, 'error');
          return null;
        }),
      ]);
      setConfig(nextConfig);
      setRuleSyncState(nextRuleState);

      let restoredDraft = false;
      if (savedDraft) {
        const savedProfile = savedDraft.draft.profile;
        const currentProfile = nextConfig.profiles.find(({ id }) => id === savedProfile.id);
        const baseline = savedDraft.baselineProfile;
        // The Popup may close after a new Profile reaches storage but before
        // React flips its in-memory `isNew` flag. Treat that snapshot as an
        // edit of the just-created Profile instead of dropping newer keystrokes.
        const restoredIsNew = savedDraft.draft.isNew && currentProfile === undefined;
        const restoredBaseline =
          savedDraft.draft.isNew && currentProfile ? currentProfile : baseline;
        const canRestore = restoredIsNew
          ? true
          : Boolean(currentProfile && restoredBaseline?.id === savedProfile.id);
        const snapshotIsDirty = restoredIsNew || !sameProfile(
          savedProfile,
          restoredBaseline ?? undefined,
        );
        const draftAlreadySaved = Boolean(
          currentProfile && sameProfile(currentProfile, savedProfile),
        );

        if (canRestore && snapshotIsDirty && !draftAlreadySaved) {
          baselineProfileRef.current = restoredBaseline ? cloneProfile(restoredBaseline) : null;
          replaceDraft({
            isNew: restoredIsNew,
            profile: cloneProfile(savedProfile),
          });
          if (
            currentProfile &&
            restoredBaseline &&
            !sameProfile(currentProfile, restoredBaseline)
          ) {
            pendingExternalConfigRef.current = nextConfig;
            setExternalChangePending(true);
          } else {
            pendingExternalConfigRef.current = null;
            setExternalChangePending(false);
          }
          restoredDraft = true;
          showToast('已恢复未保存的 Popup 草稿', 'info');
        } else if (!canRestore && snapshotIsDirty) {
          // The original Profile may have been deleted while the Popup was
          // closed. Preserve the user's last session as a new recovery copy
          // instead of silently clearing it.
          const recoveredProfile = cloneProfile(savedProfile);
          recoveredProfile.id = makeId('profile');
          recoveredProfile.name = `${savedProfile.name.trim() || '未命名 Profile'} 恢复`;
          baselineProfileRef.current = null;
          replaceDraft({ isNew: true, profile: recoveredProfile });
          pendingExternalConfigRef.current = nextConfig;
          setExternalChangePending(true);
          restoredDraft = true;
          showToast('原 Profile 已不存在，未保存内容已恢复为新副本', 'error');
        }
      }

      if (!restoredDraft) {
        pendingExternalConfigRef.current = null;
        setExternalChangePending(false);
        selectInitialDraft(nextConfig);
        void clearStoredDraft();
      }
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [clearStoredDraft, replaceDraft, selectInitialDraft, showToast]);

  useEffect(() => {
    void loadInitialState();
  }, [loadInitialState]);

  useEffect(() => {
    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;

      if (RULE_SYNC_STATE_KEY in changes) {
        void loadRuleSyncState()
          .then(setRuleSyncState)
          .catch((error: unknown) =>
            showToast(`规则状态读取失败：${errorMessage(error)}`, 'error'),
          );
      }

      if (!(CONFIG_STORAGE_KEY in changes)) return;
      const storedValue = changes[CONFIG_STORAGE_KEY]?.newValue as unknown;
      if (storedValue === undefined) return;

      let externalConfig: AppConfig;
      try {
        externalConfig = validateAndNormalizeConfig(storedValue);
      } catch (error) {
        showToast(`检测到无效配置：${errorMessage(error)}`, 'error');
        return;
      }

      setRuleSyncState((current) =>
        current.status === 'error' ? current : { ...DEFAULT_RULE_SYNC_STATE },
      );
      if (ownWriteFingerprintsRef.current.delete(configFingerprint(externalConfig))) return;

      if (dirtyRef.current) {
        pendingExternalConfigRef.current = externalConfig;
        setExternalChangePending(true);
        showToast('配置已在其他窗口更新；自动保存会保留其他 Profile 与全局状态', 'info');
        return;
      }

      pendingExternalConfigRef.current = null;
      setExternalChangePending(false);
      setConfig(externalConfig);
      selectInitialDraft(externalConfig);
    };

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, [selectInitialDraft, showToast]);

  useEffect(() => {
    let mounted = true;
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([activeTab]) => {
        const rawUrl = activeTab?.url ?? activeTab?.pendingUrl;
        if (!rawUrl) throw new Error('当前页面地址不可用');
        const url = new URL(rawUrl);
        if (!mounted) return;
        setTab({
          hostname: url.hostname || rawUrl,
          supported: url.protocol === 'http:' || url.protocol === 'https:',
        });
      })
      .catch(() => {
        if (mounted) setTab({ hostname: '无法读取当前页面', supported: false });
      })
      .finally(() => {
        if (mounted) setTabReady(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(null), toast.kind === 'error' ? 4_800 : 2_600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (loading || loadError || !config) return;

    const persistDraft = async () => {
      if (!dirty || !draft) {
        await chrome.storage.session.remove(POPUP_DRAFT_STORAGE_KEY);
        return;
      }

      const snapshot: PopupDraftSnapshot = {
        schemaVersion: 1,
        draft: {
          isNew: draft.isNew,
          profile: cloneProfile(draft.profile),
        },
        baselineProfile: originalProfile ? cloneProfile(originalProfile) : null,
      };
      await chrome.storage.session.set({ [POPUP_DRAFT_STORAGE_KEY]: snapshot });
    };

    void enqueueDraftStorageOperation(persistDraft).catch((error: unknown) => {
      showToast(`临时草稿备份失败：${errorMessage(error)}`, 'error');
    });
  }, [config, dirty, draft, enqueueDraftStorageOperation, loadError, loading, originalProfile, showToast]);

  useEffect(() => {
    const persistLatestDraftOnClose = () => {
      const currentDraft = draftRef.current;
      const baseline = baselineProfileRef.current;
      if (!currentDraft) return;
      const needsBackup =
        currentDraft.isNew ||
        !sameProfile(
          currentDraft.profile,
          baseline?.id === currentDraft.profile.id ? baseline : undefined,
        );
      if (!needsBackup) return;

      const snapshot: PopupDraftSnapshot = {
        schemaVersion: 1,
        draft: {
          isNew: currentDraft.isNew,
          profile: cloneProfile(currentDraft.profile),
        },
        baselineProfile: baseline ? cloneProfile(baseline) : null,
      };
      // Dispatch the session write while the Popup is still alive. The queued
      // order prevents an older cleanup from deleting this final snapshot.
      void enqueueDraftStorageOperation(() =>
        chrome.storage.session.set({ [POPUP_DRAFT_STORAGE_KEY]: snapshot }),
      ).catch((error: unknown) => {
        console.error('[Mock Header] Popup 关闭前备份草稿失败', error);
      });
    };

    window.addEventListener('pagehide', persistLatestDraftOnClose);
    return () => window.removeEventListener('pagehide', persistLatestDraftOnClose);
  }, [enqueueDraftStorageOperation]);

  const updateDraft = useCallback((updater: (profile: Profile) => Profile) => {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, profile: updater(current.profile) };
      draftRevisionRef.current += 1;
      draftRef.current = next;
      return next;
    });
  }, []);

  const syncAfterSave = useCallback(
    async (successMessage?: string) => {
      try {
        await notifyBackgroundSync();
        if (successMessage) showToast(successMessage);
      } catch (error) {
        setRuleSyncState({
          status: 'error',
          ruleCount: 0,
          error: errorMessage(error),
          updatedAt: Date.now(),
        });
        showToast(`配置已保存，但规则同步失败：${errorMessage(error)}`, 'error');
      }
    },
    [showToast],
  );

  const persistWholeConfig = useCallback(
    async (
      nextConfig: AppConfig,
      successMessage: string,
      preferredId?: string,
      preserveDraft = false,
    ) => {
      return enqueueConfigOperation(async () => {
        const normalized = validateAndNormalizeConfig(nextConfig);
        rememberOwnWrite(normalized);
        setRuleSyncState((current) =>
          current.status === 'error' ? current : { ...DEFAULT_RULE_SYNC_STATE },
        );
        await saveConfig(normalized);
        pendingExternalConfigRef.current = null;
        setExternalChangePending(false);
        setConfig(normalized);
        if (!preserveDraft) selectInitialDraft(normalized, preferredId);
        if (!preserveDraft) await clearStoredDraft();
        await syncAfterSave(successMessage);
        return normalized;
      });
    },
    [clearStoredDraft, enqueueConfigOperation, rememberOwnWrite, selectInitialDraft, syncAfterSave],
  );

  const performAutosave = useCallback(
    async (snapshot: DraftProfile, revision: number, surfaceValidationError: boolean) => {
      const baselineAtSave =
        baselineProfileRef.current?.id === snapshot.profile.id
          ? cloneProfile(baselineProfileRef.current)
          : null;
      let normalizedProfile: Profile;
      try {
        normalizedProfile = validateAndNormalizeProfile(
          prepareProfileForValidation(snapshot.profile),
        );
      } catch (error) {
        const message = errorMessage(error);
        setAutosaveState({ status: 'error', error: message });
        if (surfaceValidationError) showToast(`暂时无法自动保存：${message}`, 'error');
        return false;
      }

      setAutosaveState({ status: 'saving', error: null });
      try {
        await enqueueConfigOperation(async () => {
          const latest = await loadConfig();
          let profiles: Profile[];
          let activeProfileId = latest.activeProfileId;

          if (snapshot.isNew) {
            const existing = latest.profiles.find(({ id }) => id === normalizedProfile.id);
            if (existing) {
              // A previous autosave may have committed the new Profile while a
              // newer edit was already queued. From here on it is an update.
              profiles = latest.profiles.map((profile) =>
                profile.id === normalizedProfile.id ? normalizedProfile : profile,
              );
            } else {
              profiles = [...latest.profiles, normalizedProfile];
            }
            activeProfileId = normalizedProfile.id;
          } else {
            const latestProfile = latest.profiles.find(
              ({ id }) => id === normalizedProfile.id,
            );
            if (!latestProfile) {
              throw new Error('这个 Profile 已在其他窗口删除，当前修改已保留在临时草稿中');
            }
            if (
              (!baselineAtSave || !sameProfile(latestProfile, baselineAtSave)) &&
              !sameProfile(latestProfile, normalizedProfile) &&
              !window.confirm(
                '这个 Profile 已在其他窗口更新。是否用当前 Popup 的内容覆盖外部版本？',
              )
            ) {
              throw new Error('检测到外部更新；当前修改仍保留在临时草稿中');
            }
            // Start from the latest snapshot and replace only the edited
            // Profile, preserving global state and every other Profile.
            profiles = latest.profiles.map((profile) =>
              profile.id === normalizedProfile.id ? normalizedProfile : profile,
            );
          }

          const normalizedConfig = validateAndNormalizeConfig({
            ...latest,
            profiles,
            activeProfileId,
          });
          rememberOwnWrite(normalizedConfig);
          setRuleSyncState((current) =>
            current.status === 'error' ? current : { ...DEFAULT_RULE_SYNC_STATE },
          );
          await saveConfig(normalizedConfig);

          const currentDraft = draftRef.current;
          const stillEditingProfile = currentDraft?.profile.id === normalizedProfile.id;
          const hasNewerEdit = stillEditingProfile && draftRevisionRef.current !== revision;

          setConfig(normalizedConfig);
          pendingExternalConfigRef.current = null;
          setExternalChangePending(false);
          if (stillEditingProfile) {
            baselineProfileRef.current = cloneProfile(normalizedProfile);
            if (hasNewerEdit && currentDraft) {
              const nextDraft = { ...currentDraft, isNew: false };
              draftRef.current = nextDraft;
              setDraft(nextDraft);
            } else {
              const nextDraft = {
                isNew: false,
                profile: cloneProfile(normalizedProfile),
              };
              draftRef.current = nextDraft;
              setDraft(nextDraft);
              await clearStoredDraft();
            }
          }

          await syncAfterSave();
          setAutosaveState(
            hasNewerEdit
              ? { status: 'pending', error: null }
              : { status: 'saved', error: null },
          );
        });
        return true;
      } catch (error) {
        const message = errorMessage(error);
        setAutosaveState({ status: 'error', error: message });
        showToast(`自动保存失败：${message}`, 'error');
        return false;
      }
    },
    [clearStoredDraft, enqueueConfigOperation, rememberOwnWrite, showToast, syncAfterSave],
  );

  const flushAutosave = useCallback(
    async (surfaceValidationError = true) => {
      cancelAutosaveTimer();
      // Wait for a debounce-triggered write that may already be running, then
      // re-read the live draft so a newer edit is never skipped.
      await configOperationTailRef.current;
      while (true) {
        const currentDraft = draftRef.current;
        if (!currentDraft) return true;
        const baseline = baselineProfileRef.current;
        const needsSave =
          currentDraft.isNew ||
          !sameProfile(
            currentDraft.profile,
            baseline?.id === currentDraft.profile.id ? baseline : undefined,
          );
        if (!needsSave) return true;
        const saved = await performAutosave(
          {
            isNew: currentDraft.isNew,
            profile: cloneProfile(currentDraft.profile),
          },
          draftRevisionRef.current,
          surfaceValidationError,
        );
        if (!saved) return false;
        // A background debounce need not chase edits that occurred during its
        // write; the effect will schedule their own save. Structural actions
        // request a full flush and keep looping until the live draft is clean.
        if (!surfaceValidationError) return true;
      }
    },
    [cancelAutosaveTimer, performAutosave],
  );

  useEffect(() => {
    cancelAutosaveTimer();
    if (loading || loadError || !config || busy || !dirty || !draft) {
      if (!dirty && !loading) setAutosaveState({ status: 'saved', error: null });
      return undefined;
    }

    setAutosaveState({ status: 'pending', error: null });
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void flushAutosave(false);
    }, AUTOSAVE_DELAY_MS);

    return cancelAutosaveTimer;
  }, [busy, cancelAutosaveTimer, config, dirty, draft, flushAutosave, loadError, loading]);

  const handleGlobalToggle = async () => {
    if (!config || !beginBusyOperation()) return;
    const targetEnabled = !config.enabled;
    try {
      // The global switch must remain usable while the current form is in a
      // temporarily invalid editing state. A valid draft is flushed first;
      // otherwise the session backup remains available and only the persisted
      // global flag changes.
      const flushed = await flushAutosave(targetEnabled);
      if (targetEnabled && !flushed) return;
      const latest = await loadConfig();
      await persistWholeConfig(
        { ...latest, enabled: targetEnabled },
        targetEnabled ? '插件已开启' : '插件已关闭',
        draft?.isNew ? undefined : draft?.profile.id,
        true,
      );
    } catch (error) {
      showToast(`切换失败：${errorMessage(error)}`, 'error');
    } finally {
      endBusyOperation();
    }
  };

  const handleSelectProfile = async (profileId: string) => {
    if (
      !config ||
      busyRef.current ||
      (draft?.profile.id === profileId && config.activeProfileId === profileId)
    ) {
      return;
    }
    if (!beginBusyOperation()) return;
    try {
      if (!(await flushAutosave())) return;
      const latest = await loadConfig();
      if (!latest.profiles.some(({ id }) => id === profileId)) {
        throw new Error('目标 Profile 已不存在');
      }
      await persistWholeConfig(
        { ...latest, activeProfileId: profileId },
        '当前 Profile 已切换',
        profileId,
      );
    } catch (error) {
      showToast(`切换失败：${errorMessage(error)}`, 'error');
    } finally {
      endBusyOperation();
    }
  };

  const handleProfileItemClick = (profileId: string) => {
    if (suppressProfileClickRef.current) {
      suppressProfileClickRef.current = false;
      return;
    }
    void handleSelectProfile(profileId);
  };

  const handleProfileDragStart = (
    event: DragEvent<HTMLButtonElement>,
    profileId: string,
  ) => {
    if (
      busyRef.current ||
      draftRef.current?.isNew ||
      (config?.profiles.length ?? 0) < 2
    ) {
      event.preventDefault();
      return;
    }

    suppressProfileClickRef.current = true;
    setDraggedProfileId(profileId);
    setProfileDropTarget(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(PROFILE_DRAG_DATA_TYPE, profileId);
    event.dataTransfer.setData('text/plain', profileId);
  };

  const handleProfileDragOver = (
    event: DragEvent<HTMLButtonElement>,
    targetProfileId: string,
  ) => {
    if (!draggedProfileId || busyRef.current || draftRef.current?.isNew) return;

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';

    const list = profileListRef.current;
    if (list) {
      const bounds = list.getBoundingClientRect();
      const scrollThreshold = 24;
      if (event.clientY < bounds.top + scrollThreshold) list.scrollTop -= 8;
      if (event.clientY > bounds.bottom - scrollThreshold) list.scrollTop += 8;
    }

    if (targetProfileId === draggedProfileId) {
      setProfileDropTarget(null);
      return;
    }

    const position = getProfileDropPosition(event.currentTarget, event.clientY);
    setProfileDropTarget((current) =>
      current?.profileId === targetProfileId && current.position === position
        ? current
        : { profileId: targetProfileId, position },
    );
  };

  const handleProfileDragEnd = () => {
    setDraggedProfileId(null);
    setProfileDropTarget(null);
    window.setTimeout(() => {
      suppressProfileClickRef.current = false;
    }, 150);
  };

  const handleProfileDrop = async (
    event: DragEvent<HTMLButtonElement>,
    targetProfileId: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const sourceProfileId =
      event.dataTransfer.getData(PROFILE_DRAG_DATA_TYPE) ||
      event.dataTransfer.getData('text/plain') ||
      draggedProfileId;
    const position = getProfileDropPosition(event.currentTarget, event.clientY);
    setDraggedProfileId(null);
    setProfileDropTarget(null);

    if (
      !sourceProfileId ||
      sourceProfileId === targetProfileId ||
      busyRef.current ||
      draftRef.current?.isNew
    ) {
      return;
    }
    if (!beginBusyOperation()) return;

    try {
      if (!(await flushAutosave())) return;
      const latest = await loadConfig();
      const sourceProfile = latest.profiles.find(({ id }) => id === sourceProfileId);
      const targetProfile = latest.profiles.find(({ id }) => id === targetProfileId);
      if (!sourceProfile || !targetProfile) {
        throw new Error('Profile 列表已发生变化，请重试');
      }

      const profiles = latest.profiles.filter(({ id }) => id !== sourceProfileId);
      const targetIndex = profiles.findIndex(({ id }) => id === targetProfileId);
      profiles.splice(targetIndex + (position === 'after' ? 1 : 0), 0, sourceProfile);
      if (profiles.every(({ id }, index) => id === latest.profiles[index]?.id)) return;

      const selectedProfileId = draftRef.current?.profile.id;
      await persistWholeConfig(
        { ...latest, profiles },
        'Profile 顺序已更新',
        selectedProfileId,
      );
    } catch (error) {
      showToast(`排序失败：${errorMessage(error)}`, 'error');
    } finally {
      endBusyOperation();
    }
  };

  const handleCreateProfile = async () => {
    if (!config || !beginBusyOperation()) return;
    try {
      if (!(await flushAutosave())) return;
      const latest = await loadConfig();
      pendingExternalConfigRef.current = null;
      setExternalChangePending(false);
      setConfig(latest);
      const empty = createEmptyProfile();
      baselineProfileRef.current = null;
      replaceDraft({
        isNew: true,
        profile: {
          ...empty,
          id: makeId('profile'),
          name: nextProfileName(latest.profiles),
        },
      });
      showToast('已新建 Profile，请补全匹配范围', 'info');
    } catch (error) {
      showToast(`新建失败：${errorMessage(error)}`, 'error');
    } finally {
      endBusyOperation();
    }
  };

  const handleCopyProfile = async () => {
    if (!config || !draft || !beginBusyOperation()) return;
    try {
      if (!(await flushAutosave())) return;
      const source = draftRef.current;
      if (!source) return;
      baselineProfileRef.current = null;
      replaceDraft({
        isNew: true,
        profile: {
          ...cloneProfile(source.profile),
          id: makeId('profile'),
          name: `${source.profile.name.trim() || '未命名 Profile'} 副本`,
          headers: source.profile.headers.map((header) => ({
            ...header,
            id: makeId('header'),
          })),
        },
      });
      showToast('Profile 副本将自动保存', 'info');
    } catch (error) {
      showToast(`复制失败：${errorMessage(error)}`, 'error');
    } finally {
      endBusyOperation();
    }
  };

  const handleDeleteProfile = async () => {
    if (!config || !draft || busyRef.current) return;
    if (!window.confirm(`确定删除「${draft.profile.name}」吗？此操作无法撤销。`)) {
      return;
    }

    const deletingProfileId = draft.profile.id;
    if (!beginBusyOperation()) return;
    try {
      cancelAutosaveTimer();
      // A delete supersedes the draft. Wait for a write already in flight so
      // it cannot recreate the Profile after deletion.
      await configOperationTailRef.current;
      const latest = await loadConfig();
      const profiles = latest.profiles.filter(({ id }) => id !== deletingProfileId);
      if (profiles.length === latest.profiles.length) {
        pendingExternalConfigRef.current = null;
        setExternalChangePending(false);
        setConfig(latest);
        selectInitialDraft(latest);
        await clearStoredDraft();
        setAutosaveState({ status: 'saved', error: null });
        return;
      }
      const deletingActive = latest.activeProfileId === deletingProfileId;
      const nextActiveId = deletingActive ? (profiles[0]?.id ?? null) : latest.activeProfileId;
      await persistWholeConfig(
        {
          ...latest,
          profiles,
          activeProfileId: nextActiveId,
          enabled: latest.enabled && nextActiveId !== null,
        },
        nextActiveId ? 'Profile 已删除，已切换到下一项' : 'Profile 已删除，插件已关闭',
        nextActiveId ?? undefined,
      );
    } catch (error) {
      showToast(`删除失败：${errorMessage(error)}`, 'error');
    } finally {
      endBusyOperation();
    }
  };

  const updateHeader = (headerId: string, patch: Partial<HeaderCandidate>) => {
    updateDraft((profile) => {
      const headers = profile.headers.map((header) =>
        header.id === headerId ? { ...header, ...patch } : header,
      );
      const changed = headers.find(({ id }) => id === headerId);
      const changedName = changed ? normalizeHeaderName(changed.name) : '';
      if (!changed?.enabled || !changedName) return { ...profile, headers };

      return {
        ...profile,
        headers: headers.map((header) =>
          header.id !== headerId &&
          header.enabled &&
          normalizeHeaderName(header.name) === changedName
            ? { ...header, enabled: false }
            : header,
        ),
      };
    });
  };

  const handleAddHeader = () => {
    updateDraft((profile) => ({ ...profile, headers: [...profile.headers, newHeader()] }));
  };

  const handleCopyHeader = (headerId: string) => {
    updateDraft((profile) => {
      const source = profile.headers.find(({ id }) => id === headerId);
      if (!source) return profile;
      const copy: HeaderCandidate = {
        ...source,
        id: makeId('header'),
        enabled: false,
        comment: source.comment ? `${source.comment} 副本` : '',
      };
      const index = profile.headers.findIndex(({ id }) => id === headerId);
      const headers = [...profile.headers];
      headers.splice(index + 1, 0, copy);
      return { ...profile, headers };
    });
  };

  const handleCopyValue = async (header: HeaderCandidate) => {
    try {
      await navigator.clipboard.writeText(header.value);
      showToast('Value 已复制');
    } catch {
      showToast('复制失败，请手动复制', 'error');
    }
  };

  const handleDeleteHeader = (headerId: string) => {
    updateDraft((profile) => ({
      ...profile,
      headers: profile.headers.filter(({ id }) => id !== headerId),
    }));
  };

  const handleExport = async () => {
    if (!config || busyRef.current) return;
    if (
      !window.confirm('导出文件包含完整 Header Value，可能含身份 ID 或 Token。继续吗？')
    ) {
      return;
    }
    if (!beginBusyOperation()) return;
    try {
      if (!(await flushAutosave())) return;
      const latest = validateAndNormalizeConfig(await loadConfig());
      const blob = new Blob([`${JSON.stringify(latest, null, 2)}\n`], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `mock-header-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      showToast('配置已导出');
    } catch (error) {
      showToast(`导出失败：${errorMessage(error)}`, 'error');
    } finally {
      endBusyOperation();
    }
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file || busyRef.current) return;
    let acquiredBusy = false;
    try {
      const imported = validateAndNormalizeConfig(JSON.parse(await file.text()) as unknown);
      if (
        !window.confirm(
          `将导入 ${imported.profiles.length} 个 Profile，并覆盖全部本地配置。若文件中的总开关为开启，Header 会立即生效。确定继续吗？`,
        )
      ) {
        return;
      }
      if (!beginBusyOperation()) return;
      acquiredBusy = true;
      cancelAutosaveTimer();
      // Import is an explicit full replacement. Let an already-started
      // autosave finish first, then atomically overwrite it with the import.
      await configOperationTailRef.current;
      await persistWholeConfig(
        { ...imported, schemaVersion: CONFIG_SCHEMA_VERSION },
        '配置导入完成',
        imported.activeProfileId ?? undefined,
      );
    } catch (error) {
      showToast(`导入失败：${errorMessage(error)}`, 'error');
    } finally {
      if (acquiredBusy) endBusyOperation();
    }
  };

  const handleRefresh = async () => {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id === undefined) throw new Error('当前标签页不可用');
      await chrome.tabs.reload(activeTab.id);
      showToast('已刷新当前页面');
    } catch {
      showToast('刷新失败', 'error');
    }
  };

  const handleResetConfig = async () => {
    if (
      busyRef.current ||
      !window.confirm('确定清空无法读取的本地配置并恢复初始状态吗？') ||
      !beginBusyOperation()
    ) {
      return;
    }
    try {
      const resetConfig: AppConfig = { ...DEFAULT_CONFIG, profiles: [] };
      await saveConfig(resetConfig);
      await clearStoredDraft();
      try {
        await notifyBackgroundSync();
      } catch {
        // The recovered config is still authoritative. Persistent sync status
        // will surface a background failure after the Popup reloads.
      }
      await loadInitialState();
      showToast('本地配置已重置');
    } catch (error) {
      setLoadError(`重置失败：${errorMessage(error)}`);
    } finally {
      endBusyOperation();
    }
  };

  const runningStatus = useMemo(() => {
    if (busy) return { className: '', label: '处理中…', title: undefined };
    if (ruleSyncState.status === 'error') {
      return {
        className: 'is-error',
        label: '规则同步失败',
        title: ruleSyncState.error ?? '后台规则同步失败',
      };
    }
    if (!config?.enabled) {
      return ruleSyncState.status === 'idle'
        ? { className: '', label: '等待停用同步', title: undefined }
        : { className: '', label: '规则已停用', title: undefined };
    }
    if (ruleSyncState.status === 'idle') {
      return { className: '', label: '等待规则同步', title: undefined };
    }
    if (ruleSyncState.ruleCount === 0) {
      return { className: 'is-empty', label: '暂无生效规则', title: undefined };
    }
    return {
      className: 'is-on',
      label: `${ruleSyncState.ruleCount} 条规则已启用`,
      title: undefined,
    };
  }, [busy, config?.enabled, ruleSyncState]);

  const pageStatus = useMemo(() => {
    if (!draft) return { className: 'neutral', label: '无 Profile' };
    if (!tabReady) return { className: 'neutral', label: '正在检查' };
    if (!tab.supported) return { className: 'warning', label: '不支持此页面' };
    if (draft.profile.matchMode === 'request') {
      return { className: 'neutral', label: '不限页面' };
    }
    return matchesPageDomain(tab.hostname, draft.profile.pageDomains)
      ? { className: 'success', label: '页面匹配' }
      : { className: 'warning', label: '页面不匹配' };
  }, [draft, tab, tabReady]);

  const autosavePresentation = useMemo(() => {
    if (busy) return { className: 'is-saving', label: '正在处理…', title: undefined };
    if (autosaveState.status === 'error') {
      const message = autosaveState.error ?? '未知错误';
      return {
        className: 'is-error',
        label: `暂未自动保存：${message}`,
        title: message,
      };
    }
    if (autosaveState.status === 'saving') {
      return { className: 'is-saving', label: '正在自动保存…', title: undefined };
    }
    if (autosaveState.status === 'pending' || dirty) {
      return { className: 'is-pending', label: '等待自动保存…', title: undefined };
    }
    return { className: 'is-saved', label: '已自动保存', title: undefined };
  }, [autosaveState, busy, dirty]);

  if (loading) {
    return (
      <div className="app app-loading" aria-busy="true">
        <div className="loading-spinner" />
        <span>正在加载配置…</span>
      </div>
    );
  }

  if (loadError || !config) {
    return (
      <div className="app app-error">
        <div className="fatal-state">
          <span className="fatal-state-mark">!</span>
          <strong>配置加载失败</strong>
          <p>{loadError ?? '未知错误'}</p>
          <div className="fatal-actions">
            <button className="button button-primary" type="button" onClick={() => void loadInitialState()}>
              重试
            </button>
            <button className="button" disabled={busy} type="button" onClick={() => void handleResetConfig()}>
              重置本地配置
            </button>
          </div>
        </div>
      </div>
    );
  }

  const profile = draft?.profile ?? null;
  const usesPage = profile?.matchMode === 'page' || profile?.matchMode === 'page_and_request';
  const usesRequest =
    profile?.matchMode === 'request' || profile?.matchMode === 'page_and_request';
  const activeHeaderCount = profile?.headers.filter(({ enabled }) => enabled).length ?? 0;
  const persistedActiveProfile = config.profiles.find(({ id }) => id === config.activeProfileId);
  const profileReorderDisabled = busy || Boolean(draft?.isNew) || config.profiles.length < 2;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">MH</span>
          <div>
            <h1>Mock Header</h1>
            <span className={`running-state ${runningStatus.className}`} title={runningStatus.title}>
              {runningStatus.label}
            </span>
          </div>
        </div>
        <div className="global-toggle-wrap">
          <span>{config.enabled ? '开启' : '关闭'}</span>
          <button
            aria-checked={config.enabled}
            aria-label={config.enabled ? '关闭 Mock Header' : '开启 Mock Header'}
            className={`switch ${config.enabled ? 'is-on' : ''}`}
            disabled={busy || !persistedActiveProfile}
            role="switch"
            type="button"
            onClick={() => void handleGlobalToggle()}
          >
            <span />
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="profile-sidebar" aria-label="Profile 列表">
          <div className="profile-sidebar-list" ref={profileListRef}>
            {visibleProfiles.length === 0 ? (
              <span className="profile-sidebar-empty">暂无</span>
            ) : (
              visibleProfiles.map((item) => {
                const fullName = item.name.trim() || '未命名 Profile';
                const selected = profile?.id === item.id;
                const persistedActive = config.activeProfileId === item.id;
                const dropPosition =
                  profileDropTarget?.profileId === item.id
                    ? profileDropTarget.position
                    : null;
                return (
                  <button
                    aria-label={`切换到 ${fullName}`}
                    aria-pressed={selected}
                    className={[
                      'profile-sidebar-item',
                      selected ? 'is-selected' : '',
                      !profileReorderDisabled ? 'is-sortable' : '',
                      draggedProfileId === item.id ? 'is-dragging' : '',
                      dropPosition ? `is-drop-${dropPosition}` : '',
                    ].filter(Boolean).join(' ')}
                    disabled={busy}
                    draggable={!profileReorderDisabled}
                    key={item.id}
                    title={fullName}
                    type="button"
                    onClick={() => handleProfileItemClick(item.id)}
                    onDragEnd={handleProfileDragEnd}
                    onDragOver={(event) => handleProfileDragOver(event, item.id)}
                    onDragStart={(event) => handleProfileDragStart(event, item.id)}
                    onDrop={(event) => void handleProfileDrop(event, item.id)}
                  >
                    <span className="profile-short-name">{profileShortName(item.name)}</span>
                    {persistedActive ? (
                      <span className="profile-active-dot" title="当前 Profile" />
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
          <button
            aria-label="新建 Profile"
            className="profile-sidebar-add"
            disabled={busy}
            title="新建 Profile"
            type="button"
            onClick={handleCreateProfile}
          >
            <Icon name="add" />
          </button>
        </aside>

        <div className="editor-pane">
          <section className="profile-bar" aria-label="Profile 编辑">
            <input
              aria-label="Profile 名称"
              className="profile-name-input"
              disabled={!profile || busy}
              placeholder="Profile 名称"
              type="text"
              value={profile?.name ?? ''}
              onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))}
            />
            <div className="profile-actions">
              <button className="icon-button" disabled={!profile || busy} title="复制 Profile" type="button" onClick={handleCopyProfile}>
                <Icon name="copy" />
              </button>
              <button className="icon-button danger-button" disabled={!profile || busy} title="删除 Profile" type="button" onClick={() => void handleDeleteProfile()}>
                <Icon name="trash" />
              </button>
            </div>
          </section>

      {profile ? (
        <section className="scope-panel" aria-label="匹配范围">
          <div className={`scope-primary-row ${usesPage ? 'has-page-domain' : ''}`}>
            <label className="match-mode-field">
              <span>匹配方式</span>
              <select
                disabled={busy}
                value={profile.matchMode}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    matchMode: event.target.value as MatchMode,
                  }))
                }
              >
                {MATCH_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            {usesPage ? (
              <label className="scope-field scope-page-field">
                <span>页面域名 <small>每行一个，自动包含子域名</small></span>
                <textarea
                  disabled={busy}
                  placeholder="example.com"
                  rows={2}
                  value={listToText(profile.pageDomains)}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      pageDomains: textToList(event.target.value),
                    }))
                  }
                />
              </label>
            ) : null}
          </div>
          {usesRequest ? (
            <label className="scope-field scope-request-field">
              <span>请求 URL <small>每行一个，支持 *</small></span>
              <textarea
                disabled={busy}
                placeholder="*://*.example.com/*"
                rows={2}
                value={listToText(profile.requestUrlPatterns)}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    requestUrlPatterns: textToList(event.target.value),
                  }))
                }
              />
            </label>
          ) : null}
          <div className="current-page" title={tab.hostname}>
            <span>当前页面</span>
            <code>{tab.hostname}</code>
            <span className={`status-pill ${pageStatus.className}`}>
              <i />{pageStatus.label}
            </span>
          </div>
        </section>
      ) : null}

      <main className="content">
        <div className="section-heading">
          <div>
            <h2>请求 Headers</h2>
            <span>{profile ? `${activeHeaderCount}/${profile.headers.length} 项启用` : '暂无 Profile'}</span>
          </div>
          <button className="compact-button" disabled={!profile || busy} type="button" onClick={handleAddHeader}>
            <Icon name="add" /> 新增 Header
          </button>
        </div>

        {!profile ? (
          <div className="empty-state">
            <div className="empty-state-icon" aria-hidden="true">{'</>'}</div>
            <strong>{config.profiles.length ? '请选择 Profile' : '还没有 Profile'}</strong>
            <p>
              {config.profiles.length
                ? '从左侧列表选择一个 Profile，并将其设为当前。'
                : '直接在 Popup 中创建并编辑完整配置。'}
            </p>
            {config.profiles.length === 0 ? (
              <button className="button button-primary" type="button" onClick={handleCreateProfile}>新建 Profile</button>
            ) : null}
          </div>
        ) : profile.headers.length === 0 ? (
          <div className="empty-state compact-empty">
            <strong>暂无 Header</strong>
            <p>新增一行后，可直接编辑 Header 名、注释和 Value。</p>
            <button className="text-button" type="button" onClick={handleAddHeader}>+ 新增 Header</button>
          </div>
        ) : (
          <div className="header-list" role="table" aria-label="Header 候选项">
            <div className="header-list-head" role="row">
              <span role="columnheader">启用</span>
              <span role="columnheader">Header</span>
              <span role="columnheader">Value</span>
              <span role="columnheader">注释</span>
              <span className="visually-hidden" role="columnheader">操作</span>
            </div>
            <div role="rowgroup">
              {profile.headers.map((header) => (
                <div className={`candidate-row ${header.enabled ? 'is-active' : ''}`} key={header.id} role="row">
                  <div className="candidate-toggle-cell" role="cell">
                    <button
                      aria-checked={header.enabled}
                      aria-label={`${header.enabled ? '停用' : '启用'} ${header.name || 'Header'}`}
                      className={`row-toggle ${header.enabled ? 'is-on' : ''}`}
                      disabled={busy}
                      role="switch"
                      type="button"
                      onClick={() => updateHeader(header.id, { enabled: !header.enabled })}
                    ><span /></button>
                  </div>
                  <input
                    aria-label="Header 名"
                    className="cell-input mono"
                    disabled={busy}
                    placeholder="x-header-name"
                    type="text"
                    value={header.name}
                    onChange={(event) => updateHeader(header.id, { name: event.target.value })}
                  />
                  <input
                    aria-label="Header Value"
                    className="cell-input mono"
                    disabled={busy}
                    placeholder="Header Value"
                    type="text"
                    value={header.value}
                    onChange={(event) => updateHeader(header.id, { value: event.target.value })}
                  />
                  <input
                    aria-label="Header 注释"
                    className="cell-input"
                    disabled={busy}
                    type="text"
                    value={header.comment}
                    onChange={(event) => updateHeader(header.id, { comment: event.target.value })}
                  />
                  <div className="candidate-actions" role="cell">
                    <button className="row-action" disabled={busy} title="复制 Value" type="button" onClick={() => void handleCopyValue(header)}><Icon name="clipboard" /></button>
                    <button className="row-action" disabled={busy} title="复制此行" type="button" onClick={() => handleCopyHeader(header.id)}><Icon name="copy" /></button>
                    <button className="row-action is-danger" disabled={busy} title="删除此行" type="button" onClick={() => handleDeleteHeader(header.id)}><Icon name="trash" /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
        </div>
      </div>

      <footer className="footer">
        <div className="footer-group">
          <button className="footer-button" type="button" onClick={() => void handleRefresh()}><Icon name="refresh" />刷新页面</button>
          <button className="footer-button" disabled={busy} type="button" onClick={() => importInputRef.current?.click()}><Icon name="upload" />导入</button>
          <button className="footer-button" disabled={busy} type="button" onClick={() => void handleExport()}><Icon name="download" />导出</button>
        </div>
        <div
          className={`draft-state ${autosavePresentation.className}`}
          title={autosavePresentation.title}
        >
          {externalChangePending ? '有外部更新 · ' : ''}{autosavePresentation.label}
        </div>
      </footer>

      <input
        ref={importInputRef}
        accept="application/json,.json"
        className="visually-hidden"
        tabIndex={-1}
        type="file"
        onChange={(event) => void handleImport(event)}
      />

      {toast ? (
        <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
          <span>{toast.kind === 'success' ? '✓' : toast.kind === 'error' ? '!' : 'i'}</span>
          <p>{toast.message}</p>
        </div>
      ) : null}
    </div>
  );
}
