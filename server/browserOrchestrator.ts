import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Browser, BrowserContext, chromium, Page } from 'playwright';
import {
  ChromeTabDescriptor,
  ExecutionMode,
  LabCredentials,
  LabStep,
  LabTask,
  LogEntry,
  ModelGardenEntry,
  RunnerState,
  RunnerStatus,
  TargetType,
} from './types.js';
import {
  clickCheckMyProgress,
  parseLabPageDom,
  triggerStartLabAndExtractCredentials,
} from './labParser.js';
import {
  clearSavedStateOnMacBridge,
  clickEndLabInUserChrome,
  closeIncognitoWindowsInUserChrome,
  completeCourseActivityInUserChrome,
  execInStudentCloudShellBridge,
  focusUserChromeTab,
  inspectStudentCloudShellWorkspace,
  listUserChromeTabs,
  navigateOrOpenInUserChromeWindow,
  openOrFocusLabInUserChrome,
  parseTabKey,
  sendTextToUserChromeTab,
  snapshotUserChromeLabTab,
  spawnIncognitoSessionInUserChrome,
  submitCourseQuizInUserChrome,
} from './nativeChromeBridge.js';
import {
  dismissGcpConsoleTermsModal,
  signInToCloudConsoleIncognito,
} from './consoleSignIn.js';
import {
  autoAcceptAntigravityPrompts,
  clickElementByMark,
  clickTextAcrossFrames,
  executeCommandInCloudShell,
  fillElementByMark,
  inspectInteractiveElements,
  openCloudShellInConsole,
  sendPromptToAntigravity,
} from './pageInspector.js';
import {
  checkModelGardenAvailability,
  decideNextStepAction,
  fetchCourseKnowledgeFromIframeSrc,
  formatAutonomousAntigravityPrompt,
  getActiveGeminiModel,
  getModelGardenEntries,
  interpolateLabVariables,
  refineParsedTasksWithGemini,
  resolveLatestGeminiModel,
  setActiveGeminiModel,
  solveCourseQuizQuestions,
  synthesizeTaskShellScript,
  transformAgyLaunchCommand,
} from './geminiClient.js';
import {
  MacBridgeHub,
  SessionExecutionContext,
  macBridgeHub,
  sessionAsyncStorage,
  tryClaimUnclaimedBridge,
} from './macBridgeHub.js';

const LOCAL_STATE_DIR = path.join(os.homedir(), '.cloud-skills-lab-runner');
const LOCAL_STATE_FILE = path.join(LOCAL_STATE_DIR, 'runner_state.json');

export function inferTargetTypeFromUrl(url?: string | null): TargetType | null {
  const u = String(url || '').trim().toLowerCase();
  if (!u) return null;
  if (
    /\/(?:html_bundles|quizzes|documents|videos|links)\/\d+/.test(u) ||
    ((u.includes('/course_templates/') || u.includes('/course_sessions/')) &&
      !u.includes('/labs/') &&
      !u.includes('/focuses/'))
  ) {
    return 'course';
  }
  if (u.includes('/labs/') || u.includes('/focuses/')) {
    return 'lab';
  }
  return null;
}

export class LabBrowserOrchestrator {
  public readonly sessionId: string;
  private readonly hub: MacBridgeHub;
  private readonly sessionContext: SessionExecutionContext;
  private sessionModel: string = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

  private labPreviewBrowser: Browser | null = null;
  private labContext: BrowserContext | null = null;
  private labPage: Page | null = null;

  private incognitoBrowser: Browser | null = null;
  private incognitoContext: BrowserContext | null = null;
  private consolePage: Page | null = null;

  private state: RunnerState;
  private listeners: Set<(state: RunnerState) => void> = new Set();
  private screenshotTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private isLoopRunning = false;
  private pauseRequested = false;
  private pendingOverrideInstruction: string = '';
  private manualTargetTypeOverride: TargetType | null = null;

  constructor(sessionId = 'default') {
    this.sessionId = sessionId || 'default';
    this.hub = new MacBridgeHub(this.sessionId);
    this.sessionContext = {
      sessionId: this.sessionId,
      hub: this.hub,
      getActiveModel: () => this.sessionModel,
      setActiveModel: (modelId: string) => {
        const validIds = ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'claude-opus-5-5'];
        const normalized = String(modelId || '').trim();
        if (validIds.includes(normalized)) {
          this.sessionModel = normalized;
        }
        return this.sessionModel;
      },
    };

    this.state = {
      sessionId: this.sessionId,
      targetType: 'lab',
      status: 'idle',
      executionMode: 'autonomous',
      labUrl: '',
      labTitle: '',
      labTimer: '00:00:00',
      isLabStarted: false,
      isConsoleSignedIn: false,
      labInstanceId: '',
      courseOverviewUrl: '',
      courseStartHref: '',
      totalScore: 0,
      maxScore: 0,
      credentials: {
        username: '',
        password: '',
        projectId: '',
        consoleUrl: '',
        region: '',
        zone: '',
        extraVars: {},
      },
      tasks: [],
      activeTaskId: null,
      activeStepId: null,
      labScreenshot: null,
      consoleScreenshot: null,
      labCurrentUrl: '',
      consoleCurrentUrl: '',
      logs: [],
      lastThought: '',
      availableChromeTabs: [],
      selectedLabTabKey: null,
      selectedConsoleTabKey: null,
      selectedCloudShellTabKey: null,
      activeModel: this.sessionModel,
      modelGarden: getModelGardenEntries(),
      macBridgeConnected: this.hub.isConnected(),
    };

    // Always start on the clean initial screen (do not auto-restore stale runner_state.json)
    try {
      const stateFilePath = this.getLocalStateFilePath();
      if (fs.existsSync(stateFilePath)) {
        fs.unlinkSync(stateFilePath);
      }
    } catch {
      // Ignore cleanup error
    }

    this.hub.onConnectionChange((connected) => {
      this.runInContext(() => {
        this.state.macBridgeConnected = connected;
        if (connected) {
          if (this.state.status === 'idle' && this.state.tasks.length === 0) {
            clearSavedStateOnMacBridge().catch(() => {});
          }
          this.scanOpenChromeWindows(false).catch(() => {});
        } else {
          this.state.availableChromeTabs = [];
          this.emitState();
        }
      });
    });

    this.hub.onTabsPush((tabs) => {
      this.runInContext(() => {
        if (Array.isArray(tabs)) {
          this.applyScannedTabs(tabs);
          this.emitState();
        }
      });
    });

    tryClaimUnclaimedBridge(this.sessionId, this.hub);

    // Resolve the latest available model and probe Model Garden on startup
    this.runInContext(() => {
      resolveLatestGeminiModel()
        .then((model) => {
          this.sessionModel = model;
          this.state.activeModel = model;
          this.emitState();
        })
        .catch(() => {});
      this.checkModels().catch(() => {});
    });
  }

  public getBridgeHub(): MacBridgeHub {
    return this.hub;
  }

  public runInContext<T>(fn: () => T): T {
    if (sessionAsyncStorage.getStore()?.sessionId === this.sessionId) {
      return fn();
    }
    return sessionAsyncStorage.run(this.sessionContext, fn);
  }

  private getLocalStateFilePath(): string {
    const safeId = this.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const suffix = safeId && safeId !== 'default' ? `_${safeId}` : '';
    return path.join(LOCAL_STATE_DIR, `runner_state${suffix}.json`);
  }

  public async checkModels(): Promise<ModelGardenEntry[]> {
    const entries = await checkModelGardenAvailability();
    this.state.modelGarden = entries;
    this.state.activeModel = getActiveGeminiModel();
    this.emitState();
    return entries;
  }

  public selectModel(modelId: string): string {
    const updated = setActiveGeminiModel(modelId);
    this.state.activeModel = updated;
    const entry = (this.state.modelGarden || []).find((m) => m.id === updated);
    this.addLog(
      'info',
      'gemini',
      `Selected Model Garden model: ${entry ? `${entry.label} (${entry.id})` : updated}`
    );
    this.emitState();
    return updated;
  }

  public setTargetType(targetType: TargetType): TargetType {
    const normalized: TargetType = targetType === 'course' ? 'course' : 'lab';
    this.manualTargetTypeOverride = normalized;
    this.state.targetType = normalized;
    this.addLog(
      'info',
      'system',
      `Switched target mode to: ${normalized === 'course' ? 'Course (Multimedia & Quiz Progression)' : 'Hands-on Lab'}`
    );

    if (
      normalized === 'lab' &&
      !this.isLoopRunning &&
      this.state.tasks.some((t) => Boolean(t.activityType))
    ) {
      const hasEmbeddedLab = this.state.tasks.some(
        (t) => t.activityType === 'lab' && Boolean(t.activityHref)
      );
      this.state.tasks = [];
      if (hasEmbeddedLab && (this.state.selectedLabTabKey || this.state.labUrl)) {
        this.runInContext(() => {
          this.parseLabInstructions().catch((err) => {
            this.addLog(
              'warn',
              'lab_window',
              `Could not auto-load embedded lab from course: ${err?.message || String(err)}`
            );
          });
        });
      }
    }

    this.emitState();
    return normalized;
  }

  private isUserChromeBridgeAvailable(): boolean {
    return this.hub.isConnected();
  }

  private getSerializableState(): Partial<RunnerState> {
    return {
      sessionId: this.sessionId,
      targetType: this.state.targetType || 'lab',
      status: this.state.status === 'running_autonomous' ? 'paused' : this.state.status,
      executionMode: this.state.executionMode,
      labUrl: this.state.labUrl,
      labTitle: this.state.labTitle,
      labTimer: this.state.labTimer,
      isLabStarted: this.state.isLabStarted,
      isConsoleSignedIn: this.state.isConsoleSignedIn,
      labInstanceId: this.state.labInstanceId,
      courseOverviewUrl: this.state.courseOverviewUrl,
      courseStartHref: this.state.courseStartHref,
      totalScore: this.state.totalScore,
      maxScore: this.state.maxScore,
      credentials: this.state.credentials,
      tasks: this.state.tasks,
      activeTaskId: this.state.activeTaskId,
      activeStepId: this.state.activeStepId,
      labCurrentUrl: this.state.labCurrentUrl,
      consoleCurrentUrl: this.state.consoleCurrentUrl,
      logs: (this.state.logs || []).slice(0, 120),
      lastThought: this.state.lastThought,
      selectedLabTabKey: this.state.selectedLabTabKey,
      selectedConsoleTabKey: this.state.selectedConsoleTabKey,
      selectedCloudShellTabKey: this.state.selectedCloudShellTabKey,
      activeModel: this.state.activeModel,
    };
  }

  private scheduleStateSave() {
    if (!this.state.labUrl && this.state.tasks.length === 0) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.runInContext(() => {
        this.saveStateManual(true).catch(() => {});
      });
    }, 1200);
  }

  public async saveStateManual(silent = false): Promise<{
    ok: boolean;
    savedAt: string;
    path: string;
  }> {
    const savedAt = new Date().toISOString();
    const serializable = this.getSerializableState();
    let targetPath = this.getLocalStateFilePath();

    try {
      fs.mkdirSync(LOCAL_STATE_DIR, { recursive: true });
      fs.writeFileSync(
        targetPath,
        JSON.stringify({ savedAt, state: serializable }, null, 2),
        'utf8'
      );
    } catch {
      // Ignore local write error in read-only environments
    }

    if (this.hub.isConnected()) {
      try {
        const res = await this.hub.invoke<any>(
          'save_state',
          { state: serializable },
          10000
        );
        if (res?.path) targetPath = res.path;
      } catch {
        // Ignore bridge save timeout
      }
    }

    if (!silent) {
      this.addLog(
        'success',
        'system',
        `Saved Skills Runner state (${this.state.labTitle || 'Active Session'} — ${this.state.totalScore ?? 0}/${this.state.maxScore ?? 100} pts) to ${targetPath}.`
      );
    }

    return { ok: true, savedAt, path: targetPath };
  }

  private async restoreSavedState(): Promise<boolean> {
    if (this.state.tasks.length > 0 && this.state.labTitle) {
      return false;
    }

    let loadedPayload: any = null;
    if (this.hub.isConnected()) {
      try {
        loadedPayload = await this.hub.invoke<any>('load_state', {}, 8000);
      } catch {
        // Fall through to local file
      }
    }

    const stateFilePath = this.getLocalStateFilePath();
    if (!loadedPayload && fs.existsSync(stateFilePath)) {
      try {
        loadedPayload = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      } catch {
        // Ignore corrupt state file
      }
    }

    const saved = loadedPayload?.state;
    if (!saved || (!saved.labUrl && (!Array.isArray(saved.tasks) || saved.tasks.length === 0))) {
      return false;
    }

    const connected = this.hub.isConnected();
    this.state = {
      ...this.state,
      ...saved,
      sessionId: this.sessionId,
      availableChromeTabs: connected ? this.state.availableChromeTabs : [],
      activeModel: getActiveGeminiModel(),
      macBridgeConnected: connected,
    };
    this.emitState();
    return true;
  }

  public subscribe(listener: (state: RunnerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  public getState(): RunnerState {
    return this.state;
  }

  private emitState() {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // Ignore broken socket listener
      }
    }
    this.scheduleStateSave();
  }

  public addLog(
    level: LogEntry['level'],
    surface: LogEntry['surface'],
    message: string,
    detail?: string
  ) {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toLocaleTimeString(),
      level,
      surface,
      message,
      detail,
    };
    this.state.logs = [entry, ...this.state.logs.slice(0, 199)];
    this.emitState();
  }

  private setStatus(status: RunnerStatus) {
    this.state.status = status;
    this.emitState();
  }

  public setExecutionMode(mode: ExecutionMode) {
    this.state.executionMode = mode;
    this.addLog(
      'info',
      'system',
      `Execution mode switched to: ${mode === 'autonomous' ? 'Autonomous End-to-End' : 'Step-by-Step Confirmation'}`
    );
    this.emitState();
  }

  public setOverrideInstruction(instruction: string) {
    this.pendingOverrideInstruction = instruction.trim();
    if (this.pendingOverrideInstruction) {
      this.addLog(
        'ai',
        'gemini',
        `Queued live operator override instruction: "${this.pendingOverrideInstruction}"`
      );
    }
  }

  public updateManualCredentials(partial: Partial<LabCredentials>) {
    this.state.credentials = {
      ...this.state.credentials,
      ...partial,
    };
    this.reinterpolateAllTaskCommands();
    this.addLog('info', 'system', 'Updated lab credentials / environment variables.');
    this.emitState();
  }

  /**
   * Re-applies variable interpolation and `agy --dangerously-skip-permissions` wrapping across all tasks
   * whenever the active Project ID or Region is updated from the selected Console window.
   */
  private reinterpolateAllTaskCommands() {
    if (!this.state.tasks || this.state.tasks.length === 0) return;
    for (const task of this.state.tasks) {
      for (const step of task.steps) {
        step.instruction = interpolateLabVariables(step.instruction, this.state.credentials);
        step.commands = (step.commands || []).map((cmd) =>
          transformAgyLaunchCommand(interpolateLabVariables(cmd, this.state.credentials))
        );
      }
    }
  }

  private applyScannedTabs(tabs: ChromeTabDescriptor[], autoSelectLab = false) {
    const connected = macBridgeHub.isConnected();
    this.state.macBridgeConnected = connected;
    if (!connected) {
      this.state.availableChromeTabs = [];
      return;
    }
    this.state.availableChromeTabs = tabs;

    const findByKey = (k?: string | null) => tabs.find((t) => t.key === k);
    const hasActiveLabSession = Boolean(
      this.state.selectedLabTabKey ||
        this.state.labUrl ||
        this.state.isLabStarted ||
        this.state.tasks.length > 0 ||
        autoSelectLab
    );

    if (this.state.selectedLabTabKey) {
      const currentLabTab = findByKey(this.state.selectedLabTabKey);
      const isStillValidLabTab = Boolean(
        currentLabTab &&
          (currentLabTab.suggestedRole === 'lab' ||
            (this.state.labUrl && currentLabTab.url === this.state.labUrl) ||
            (this.state.labCurrentUrl && currentLabTab.url === this.state.labCurrentUrl))
      );
      if (!isStillValidLabTab) {
        const movedLabTab =
          (this.state.labCurrentUrl &&
            tabs.find((t) => t.url === this.state.labCurrentUrl && t.suggestedRole === 'lab')) ||
          (this.state.labUrl &&
            tabs.find((t) => t.url === this.state.labUrl && t.suggestedRole === 'lab')) ||
          tabs.find((t) => t.suggestedRole === 'lab');
        if (movedLabTab) {
          this.state.selectedLabTabKey = movedLabTab.key;
        } else if (!currentLabTab) {
          this.state.selectedLabTabKey = null;
        }
      }
    } else if (autoSelectLab) {
      const labTab = tabs.find((t) => t.suggestedRole === 'lab');
      if (labTab) {
        this.state.selectedLabTabKey = labTab.key;
        this.state.labUrl = labTab.url;
        this.state.labCurrentUrl = labTab.url;
      }
    }

    if (hasActiveLabSession) {
      const currentConsoleTab = findByKey(this.state.selectedConsoleTabKey);
      if (!currentConsoleTab || currentConsoleTab.windowMode !== 'incognito') {
        const consoleTab = tabs.find(
          (t) => t.suggestedRole === 'console' && t.windowMode === 'incognito'
        );
        this.state.selectedConsoleTabKey = consoleTab ? consoleTab.key : null;
      }

      const currentShellTab = findByKey(this.state.selectedCloudShellTabKey);
      if (!currentShellTab || currentShellTab.windowMode !== 'incognito') {
        const shellTab =
          tabs.find((t) => t.suggestedRole === 'cloud_shell' && t.windowMode === 'incognito') ||
          findByKey(this.state.selectedConsoleTabKey);
        this.state.selectedCloudShellTabKey =
          shellTab && shellTab.windowMode === 'incognito' ? shellTab.key : null;
      }

      this.syncMetadataFromSelectedTabs();
    } else {
      this.state.selectedConsoleTabKey = null;
      this.state.selectedCloudShellTabKey = null;
      this.state.isConsoleSignedIn = false;
    }
  }

  /**
   * Scans all open windows and tabs in the user's Google Chrome (`Google Chrome.app`).
   * Never triggers `save tab` automatically so in-progress navigations or SSO logins are never interrupted.
   */
  public async scanOpenChromeWindows(autoBindOnStartup = false): Promise<ChromeTabDescriptor[]> {
    if (!macBridgeHub.isConnected()) {
      this.state.macBridgeConnected = false;
      this.state.availableChromeTabs = [];
      this.emitState();
      return [];
    }
    const tabs = await listUserChromeTabs();
    this.applyScannedTabs(tabs, autoBindOnStartup);
    this.emitState();
    return tabs;
  }

  /**
   * Extracts active URL and GCP Project ID from the user's selected Console / Cloud Shell tabs.
   */
  private syncMetadataFromSelectedTabs() {
    const tabs = this.state.availableChromeTabs || [];
    const labTab = tabs.find((t) => t.key === this.state.selectedLabTabKey);
    const consoleTab = tabs.find((t) => t.key === this.state.selectedConsoleTabKey);
    const shellTab = tabs.find((t) => t.key === this.state.selectedCloudShellTabKey);

    if (labTab && labTab.suggestedRole === 'lab') {
      this.state.labUrl = labTab.url;
      this.state.labCurrentUrl = labTab.url;
      const inferred = inferTargetTypeFromUrl(labTab.url);
      if (inferred === 'lab' || labTab.contentKind === 'lab') {
        this.state.targetType = 'lab';
        this.manualTargetTypeOverride = null;
      } else if (this.manualTargetTypeOverride !== 'lab') {
        if (inferred) {
          this.state.targetType = inferred;
        } else if (labTab.contentKind === 'course') {
          this.state.targetType = 'course';
        }
      }
    }

    const activeTarget = consoleTab || shellTab;
    if (activeTarget) {
      this.state.consoleCurrentUrl = activeTarget.url;
      this.state.isConsoleSignedIn = true;
    }

    if (!this.state.credentials.projectId && consoleTab && consoleTab.url) {
      try {
        const u = new URL(consoleTab.url);
        const projFromUrl = u.searchParams.get('project');
        if (projFromUrl && projFromUrl.trim()) {
          this.state.credentials.projectId = projFromUrl.trim();
          this.reinterpolateAllTaskCommands();
        }
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Binds the user-selected Chrome windows/tabs for:
   * 1. Lab Instructions (authenticated as user's google.com identity)
   * 2. Cloud Console (authenticated as temporary lab student account)
   * 3. Cloud Shell / Antigravity (`agy`) terminal tab
   * Then parses the selected Lab tab and interpolates all steps with the active Console Project ID.
   */
  public async bindChromeTargets(params: {
    labTabKey?: string | null;
    consoleTabKey?: string | null;
    cloudShellTabKey?: string | null;
  }): Promise<void> {
    if (params.labTabKey === null || params.labTabKey === '') {
      await this.resetForNewLab({ endLabInChrome: false, closeIncognito: false });
      return;
    }

    const isSwitchingFromLoadedLab = Boolean(
      params.labTabKey &&
        this.state.selectedLabTabKey &&
        params.labTabKey !== this.state.selectedLabTabKey &&
        (this.state.tasks.length > 0 || this.state.isLabStarted)
    );
    if (isSwitchingFromLoadedLab) {
      await this.resetForNewLab({ endLabInChrome: false, closeIncognito: true });
    }

    await this.scanOpenChromeWindows(false);

    if (params.labTabKey !== undefined) {
      this.state.selectedLabTabKey = params.labTabKey;
    }
    if (params.consoleTabKey !== undefined) {
      this.state.selectedConsoleTabKey = params.consoleTabKey;
    }
    if (params.cloudShellTabKey !== undefined) {
      this.state.selectedCloudShellTabKey = params.cloudShellTabKey;
    }

    this.syncMetadataFromSelectedTabs();

    const tabs = this.state.availableChromeTabs || [];
    const labTab = tabs.find((t) => t.key === this.state.selectedLabTabKey);
    const consoleTab = tabs.find((t) => t.key === this.state.selectedConsoleTabKey);
    const shellTab = tabs.find((t) => t.key === this.state.selectedCloudShellTabKey);

    if (labTab) {
      this.addLog(
        'success',
        'lab_window',
        `Bound Lab Window/Tab: [Window #${labTab.windowIndex} ${labTab.windowMode.toUpperCase()} • Tab #${labTab.tabIndex}] "${labTab.title}"`
      );
    }
    if (consoleTab) {
      this.addLog(
        'success',
        'incognito_console',
        `Bound Cloud Console Window/Tab: [Window #${consoleTab.windowIndex} ${consoleTab.windowMode.toUpperCase()} • Tab #${consoleTab.tabIndex}] "${consoleTab.title}" (Project: ${this.state.credentials.projectId || 'active'})`
      );
    }
    if (shellTab) {
      this.addLog(
        'success',
        'cloud_shell',
        `Bound Cloud Shell / Antigravity Tab: [Window #${shellTab.windowIndex} ${shellTab.windowMode.toUpperCase()} • Tab #${shellTab.tabIndex}] "${shellTab.title}"`
      );
    }

    this.emitState();
    await this.parseLabInstructions();
  }

  public async focusChromeTarget(key: string): Promise<boolean> {
    const parsed = parseTabKey(key);
    if (!parsed) return false;
    return focusUserChromeTab(parsed.windowId, parsed.tabIndex);
  }

  private startScreenshotTelemetry() {
    if (this.screenshotTimer) return;
    this.screenshotTimer = setInterval(async () => {
      await this.refreshScreenshots();
    }, 2200);
  }

  public async refreshScreenshots() {
    try {
      if (this.labPage && !this.labPage.isClosed()) {
        if (!this.state.labCurrentUrl) {
          this.state.labCurrentUrl = this.state.labUrl || this.labPage.url();
        }
        const buf = await this.labPage.screenshot({ type: 'jpeg', quality: 55 });
        this.state.labScreenshot = buf.toString('base64');
      }
    } catch {
      // Ignore transient navigation screenshot error
    }

    try {
      if (this.consolePage && !this.consolePage.isClosed()) {
        this.state.consoleCurrentUrl = this.consolePage.url();
        const buf = await this.consolePage.screenshot({ type: 'jpeg', quality: 60 });
        this.state.consoleScreenshot = buf.toString('base64');
      }
    } catch {
      // Ignore transient navigation screenshot error
    }

    this.emitState();
  }

  /**
   * Ensures an internal headless Chromium page exists to render and parse the DOM snapshot
   * captured from the user's native `jtongarm@google.com` Google Chrome window.
   */
  private async ensureLabPreviewPage(): Promise<Page> {
    if (this.labPage && !this.labPage.isClosed()) {
      return this.labPage;
    }
    if (!this.labPreviewBrowser) {
      this.labPreviewBrowser = await chromium.launch({
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
        ],
      });
    }
    this.labContext = await this.labPreviewBrowser.newContext({
      viewport: { width: 1280, height: 840 },
    });
    this.labPage = await this.labContext.newPage();
    return this.labPage;
  }

  /**
   * Captures the live DOM + Declarative Shadow DOM from the user's authenticated Google Chrome (`google.com`)
   * lab tab and loads it into `this.labPage` for parsing and UI preview.
   */
  public async syncLabPageFromUserChrome(): Promise<void> {
    const page = await this.ensureLabPreviewPage();
    const preferredTarget = parseTabKey(this.state.selectedLabTabKey);
    const snap = await snapshotUserChromeLabTab(this.state.labUrl, preferredTarget);
    if (snap && snap.htmlPath) {
      this.state.labCurrentUrl = snap.url || this.state.labUrl;
      await page.goto(`file://${snap.htmlPath}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(300);
    } else if (this.state.labUrl) {
      this.state.labCurrentUrl = this.state.labUrl;
      await page.goto(this.state.labUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await page.waitForTimeout(1000);
    }
  }

  /**
   * Step 1: Opens or focuses the Lab URL inside the user's primary Google Chrome (`jtongarm@google.com` session)
   * so corporate SSO / google.com authentication is preserved automatically, then snapshots and parses the lab.
   */
  public async openLabUrl(labUrl: string): Promise<void> {
    const trimmedUrl = labUrl.trim();
    const inferredTarget = inferTargetTypeFromUrl(trimmedUrl);
    if (inferredTarget === 'lab') {
      this.manualTargetTypeOverride = null;
      this.state.targetType = 'lab';
    } else if (inferredTarget && this.manualTargetTypeOverride !== 'lab') {
      this.state.targetType = inferredTarget;
    }
    if (
      (this.state.tasks.length > 0 || this.state.isLabStarted) &&
      this.state.labUrl &&
      this.state.labUrl !== trimmedUrl
    ) {
      const savedOverride = this.manualTargetTypeOverride;
      await this.resetForNewLab({ endLabInChrome: false, closeIncognito: true });
      this.manualTargetTypeOverride = savedOverride;
      if (inferredTarget === 'lab') {
        this.state.targetType = 'lab';
      } else if (inferredTarget && savedOverride !== 'lab') {
        this.state.targetType = inferredTarget;
      }
    }
    this.state.labUrl = trimmedUrl;
    this.setStatus('launching_lab');

    try {
      const tabInfo = await openOrFocusLabInUserChrome(this.state.labUrl, (msg) =>
        this.addLog('info', 'lab_window', msg)
      );
      this.state.labCurrentUrl = tabInfo.url || this.state.labUrl;
      if (tabInfo.windowId) {
        this.state.selectedLabTabKey = `${tabInfo.windowId}:${tabInfo.tabIndex}`;
      }
      this.addLog(
        'success',
        'lab_window',
        `Connected to your Google Chrome (google.com identity) tab: "${tabInfo.title}" (${this.state.labCurrentUrl})`
      );
    } catch (err: any) {
      this.addLog(
        'warn',
        'lab_window',
        `AppleScript Chrome bridge warning: ${err?.message || String(err)}`
      );
    }

    await new Promise((r) => setTimeout(r, 1000));
    await this.scanOpenChromeWindows(false);
    await this.syncLabPageFromUserChrome();

    this.startScreenshotTelemetry();
    await this.refreshScreenshots();

    // Inspect initial state
    const parsed = await parseLabPageDom(this.labPage!);
    this.state.labTitle = parsed.labTitle;
    this.state.labTimer = parsed.labTimer;
    this.state.isLabStarted = parsed.isLabStarted;
    if (parsed.isCourse && this.manualTargetTypeOverride !== 'lab') {
      this.state.targetType = 'course';
    }

    if (parsed.needsLogin) {
      this.setStatus('awaiting_login');
      this.addLog(
        'warn',
        'lab_window',
        'Please complete your initial login in your Google Chrome window, then click "Re-Parse DOM".'
      );
    } else {
      this.setStatus('ready_to_parse');
      const kindLabel = parsed.isCourse ? 'course' : 'lab';
      this.addLog(
        'success',
        'lab_window',
        `Loaded authenticated ${kindLabel}: "${parsed.labTitle}" (Started: ${parsed.isLabStarted ? 'Yes' : 'No'}). Parsing activities and tasks...`
      );
      await this.parseLabInstructions();
    }
  }

  /**
   * Step 2: Syncs the latest DOM from the user's Google Chrome lab/course tab, parses instructions, tasks,
   * course activities, quizzes, code blocks, active links, and student credentials.
   */
  public async parseLabInstructions(): Promise<void> {
    await this.syncLabPageFromUserChrome();
    if (!this.labPage || this.labPage.isClosed()) {
      throw new Error('Lab/Course window is not open. Launch a URL first.');
    }

    this.addLog('info', 'lab_window', 'Scanning DOM (piercing Shadow DOM components)...');
    let parsed = await parseLabPageDom(this.labPage);

    // If the page is a Course that contains an embedded Hands-on Lab, and either:
    // 1. The operator explicitly selected "Lab" mode, OR
    // 2. All non-lab course activities (lessons, videos, quizzes) are already completed while the embedded lab is still pending,
    // automatically navigate the Chrome tab into the embedded lab and parse its lab tasks!
    if (parsed.isCourse) {
      const embeddedLabTask =
        parsed.tasks.find(
          (t) => t.activityType === 'lab' && !t.progressVerified && Boolean(t.activityHref)
        ) || parsed.tasks.find((t) => t.activityType === 'lab' && Boolean(t.activityHref));
      const hasPendingEmbeddedLab = parsed.tasks.some(
        (t) => t.activityType === 'lab' && !t.progressVerified && Boolean(t.activityHref)
      );
      const allNonLabActivitiesDone =
        hasPendingEmbeddedLab &&
        parsed.tasks.every((t) => t.activityType === 'lab' || t.progressVerified);

      if (
        embeddedLabTask?.activityHref &&
        (this.manualTargetTypeOverride === 'lab' ||
          (!this.isLoopRunning &&
            allNonLabActivitiesDone &&
            this.manualTargetTypeOverride !== 'course'))
      ) {
        let origin = 'https://partner.skills.google';
        try {
          origin = new URL(this.state.labCurrentUrl || this.state.labUrl || origin).origin;
        } catch {
          // Default origin
        }
        const labFullUrl = new URL(embeddedLabTask.activityHref, origin).toString();
        const labTarget = parseTabKey(this.state.selectedLabTabKey);
        this.addLog(
          'action',
          'lab_window',
          `Course contains embedded Hands-on Lab "${embeddedLabTask.title}" — navigating Chrome tab to ${labFullUrl} and switching to Lab Mode...`
        );
        this.manualTargetTypeOverride = 'lab';
        this.state.targetType = 'lab';
        this.state.labUrl = labFullUrl;
        this.state.labCurrentUrl = labFullUrl;
        if (parsed.courseOverviewUrl) {
          this.state.courseOverviewUrl = parsed.courseOverviewUrl;
        }
        const navRes = await completeCourseActivityInUserChrome({
          windowId: labTarget?.windowId,
          tabIndex: labTarget?.tabIndex,
          activityUrl: labFullUrl,
          activityType: 'document',
        });
        if (navRes.htmlContent && navRes.htmlContent.trim().length > 200) {
          const tmpFile = path.join(
            os.tmpdir(),
            `skills_embedded_lab_${this.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.html`
          );
          fs.writeFileSync(tmpFile, navRes.htmlContent, 'utf8');
          await this.labPage.goto(`file://${tmpFile}`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          await this.labPage.waitForTimeout(250);
        } else {
          await this.syncLabPageFromUserChrome();
        }
        parsed = await parseLabPageDom(this.labPage);
      }
    }

    this.state.labTitle = parsed.labTitle;
    this.state.labTimer = parsed.labTimer;
    this.state.isLabStarted = parsed.isLabStarted;
    if (parsed.labInstanceId) {
      this.state.labInstanceId = parsed.labInstanceId;
    }
    if (parsed.totalScore !== undefined) {
      this.state.totalScore = parsed.totalScore;
    }
    if (parsed.maxScore !== undefined) {
      this.state.maxScore = parsed.maxScore;
    }

    if (parsed.isCourse) {
      this.state.targetType = 'course';
      if (parsed.courseOverviewUrl) {
        this.state.courseOverviewUrl = parsed.courseOverviewUrl;
      }
      if (parsed.courseStartHref) {
        this.state.courseStartHref = parsed.courseStartHref;
      }
      const previousTasks = this.state.tasks;
      const isSameCourseList =
        this.isLoopRunning &&
        previousTasks.length === parsed.tasks.length &&
        previousTasks.every((prev, idx) => prev.title === parsed.tasks[idx]?.title);

      if (!isSameCourseList) {
        this.state.tasks = parsed.tasks;
      } else {
        for (let i = 0; i < this.state.tasks.length; i++) {
          const updated = parsed.tasks[i];
          if (!updated) continue;
          if (updated.activityHref) {
            this.state.tasks[i].activityHref = updated.activityHref;
          }
          if (updated.activityType === 'quiz') {
            this.state.tasks[i].activityType = 'quiz';
          }
          if (updated.progressVerified) {
            this.state.tasks[i].progressVerified = true;
            this.state.tasks[i].status = 'completed';
            this.state.tasks[i].stepScore = 1;
            this.state.tasks[i].progressMessage = 'Activity completed';
            for (const s of this.state.tasks[i].steps) s.status = 'completed';
          }
        }
      }

      if (!this.isLoopRunning && this.state.tasks.length > 0) {
        const currentUrl = this.state.labCurrentUrl || this.state.labUrl || '';
        const urlIdMatch = currentUrl.match(/\/(html_bundles|quizzes|documents|videos|links)\/(\d+)/i);
        const matchedByCurrentUrl = urlIdMatch
          ? this.state.tasks.find(
              (t) =>
                t.status !== 'completed' &&
                Boolean(t.activityHref && t.activityHref.includes(`/${urlIdMatch[1]}/${urlIdMatch[2]}`))
            )
          : undefined;
        const nextPendingTask =
          matchedByCurrentUrl ||
          this.state.tasks.find((t) => t.status !== 'completed') ||
          this.state.tasks[0];
        this.state.activeTaskId = nextPendingTask.id;
        this.state.activeStepId = nextPendingTask.steps[0]?.id || null;
      }
      if (!this.isLoopRunning) {
        this.setStatus('lab_parsed');
      } else {
        this.emitState();
      }
      this.addLog(
        'success',
        'lab_window',
        `Course "${this.state.labTitle}" structured into ${this.state.tasks.length} activities (${this.state.totalScore || 0}/${this.state.maxScore || this.state.tasks.length} completed).`
      );
      this.startScreenshotTelemetry();
      await this.refreshScreenshots();
      return;
    }

    if (parsed.courseOverviewUrl) {
      this.state.courseOverviewUrl = parsed.courseOverviewUrl;
    }
    if (parsed.tasks.length > 0) {
      this.state.targetType = 'lab';
    }

    // Check if the user's selected Console tab URL has a live `project=` parameter (which takes precedence over cached HTML attributes)
    let liveConsoleProjectId = '';
    const consoleTab = (this.state.availableChromeTabs || []).find(
      (t) => t.key === this.state.selectedConsoleTabKey
    );
    if (consoleTab?.url) {
      try {
        const u = new URL(consoleTab.url);
        liveConsoleProjectId = (u.searchParams.get('project') || '').trim();
      } catch {
        // Ignore
      }
    }

    if (!parsed.isLabStarted) {
      this.state.credentials = parsed.credentials;
      this.state.totalScore = 0;
    } else {
      // Merge extracted credentials without overwriting non-empty manual overrides
      this.state.credentials = {
        username: parsed.credentials.username || this.state.credentials.username,
        password: parsed.credentials.password || this.state.credentials.password,
        projectId:
          parsed.credentials.projectId ||
          liveConsoleProjectId ||
          this.state.credentials.projectId,
        consoleUrl: parsed.credentials.consoleUrl || this.state.credentials.consoleUrl,
        region: parsed.credentials.region || this.state.credentials.region,
        zone: parsed.credentials.zone || this.state.credentials.zone,
        extraVars: {
          ...this.state.credentials.extraVars,
          ...parsed.credentials.extraVars,
        },
      };
    }

    if (this.state.credentials.username || this.state.credentials.projectId) {
      this.addLog(
        'success',
        'lab_window',
        `Active Lab Credentials: ${this.state.credentials.username} | Project: ${this.state.credentials.projectId} | Region: ${this.state.credentials.region || 'auto'}`
      );
    }

    // Immediately populate deterministic DOM-parsed tasks and interpolate with the live Project ID
    const previousTasks = this.state.tasks;
    const isSameTaskList =
      this.isLoopRunning &&
      previousTasks.length === parsed.tasks.length &&
      previousTasks.every((prev, idx) => prev.title === parsed.tasks[idx]?.title);

    if (!isSameTaskList) {
      this.state.tasks = parsed.tasks;
    }
    this.reinterpolateAllTaskCommands();

    // If the lab is active and has an assessment instance ID, query the live Qwiklabs assessment status immediately
    const firstGradableTask = this.state.tasks.find(
      (t) => t.hasCheckProgress && (t.checkProgressStepNumber || (t.checkProgressStepNumbers && t.checkProgressStepNumbers.length > 0))
    );
    if (this.state.isLabStarted && firstGradableTask && this.labPage && !this.labPage.isClosed()) {
      try {
        await this.verifyTaskProgress(firstGradableTask);
      } catch {
        // Ignore initial status poll errors
      }
    }

    if (!this.isLoopRunning && this.state.tasks.length > 0) {
      const nextPendingTask =
        this.state.tasks.find((t) => t.status !== 'completed') || this.state.tasks[0];
      this.state.activeTaskId = nextPendingTask.id;
      this.state.activeStepId = nextPendingTask.steps[0]?.id || null;
    }
    const rawStepCount = this.state.tasks.reduce((acc, t) => acc + t.steps.length, 0);
    if (!this.isLoopRunning) {
      this.setStatus('lab_parsed');
    } else {
      this.emitState();
    }
    this.addLog(
      'success',
      'lab_window',
      `Lab structured into ${this.state.tasks.length} tasks (${rawStepCount} executable steps). Score: ${this.state.totalScore || 0}/${this.state.maxScore || 100}.`
    );
    this.startScreenshotTelemetry();
    await this.refreshScreenshots();
  }

  private getTaskStepNumbers(task: LabTask): number[] {
    if (Array.isArray(task.checkProgressStepNumbers) && task.checkProgressStepNumbers.length > 0) {
      return task.checkProgressStepNumbers;
    }
    if (task.checkProgressStepNumber) {
      return [task.checkProgressStepNumber];
    }
    return [task.number];
  }

  private getCheckProgressOptions(task: LabTask, stepNumberOverride?: number) {
    const labTarget = parseTabKey(this.state.selectedLabTabKey);
    return {
      checkProgressStepNumber: stepNumberOverride || task.checkProgressStepNumber || task.number,
      labInstanceId: task.labInstanceId || this.state.labInstanceId,
      windowId: labTarget?.windowId,
      tabIndex: labTarget?.tabIndex,
    };
  }

  private async verifyTaskProgress(
    task: LabTask
  ): Promise<Awaited<ReturnType<typeof clickCheckMyProgress>>> {
    await this.ensureLabPreviewPage();
    const stepNumbers = this.getTaskStepNumbers(task);
    let lastRes: Awaited<ReturnType<typeof clickCheckMyProgress>> = {
      clicked: false,
      verified: false,
      message: 'No progress check executed.',
    };
    const messages: string[] = [];
    let allVerified = true;

    for (const stepNum of stepNumbers) {
      const res = await clickCheckMyProgress(
        this.labPage!,
        task.number,
        this.state.labCurrentUrl || this.state.labUrl,
        this.getCheckProgressOptions(task, stepNum)
      );
      lastRes = res;
      this.applyCheckResultToState(task, res);
      if (!res.verified) {
        allVerified = false;
      }
      if (res.message) {
        messages.push(
          stepNumbers.length > 1 ? `[Step ${stepNum}] ${res.message}` : res.message
        );
      }
    }

    const combinedMessage =
      messages.length > 0 ? messages.join(' | ') : lastRes.message;
    task.progressVerified = allVerified;
    task.progressMessage = combinedMessage;
    if (allVerified) {
      task.status = 'completed';
      for (const s of task.steps) s.status = 'completed';
    }
    this.emitState();

    return {
      ...lastRes,
      verified: allVerified,
      message: combinedMessage,
      stepScore: task.stepScore,
      stepMaxScore: task.stepMaxScore,
    };
  }

  private applyCheckResultToState(
    task: LabTask,
    res: Awaited<ReturnType<typeof clickCheckMyProgress>>
  ) {
    task.progressVerified = res.verified;
    task.progressMessage = res.message;
    if (res.stepScore !== undefined) task.stepScore = res.stepScore;
    if (res.stepMaxScore !== undefined) task.stepMaxScore = res.stepMaxScore;
    if (res.totalScore !== undefined) this.state.totalScore = res.totalScore;
    if (res.maxScore !== undefined) this.state.maxScore = res.maxScore;
    if (res.verified) {
      task.status = 'completed';
      for (const s of task.steps) s.status = 'completed';
    }

    if (Array.isArray(res.stepCompleteList) && res.stepCompleteList.length > 0) {
      for (const t of this.state.tasks) {
        if (!t.hasCheckProgress) continue;
        const stepNums = this.getTaskStepNumbers(t).filter(
          (sn) => sn - 1 >= 0 && sn - 1 < res.stepCompleteList!.length
        );
        if (stepNums.length === 0) continue;

        let sumScore = 0;
        let hasScore = false;
        let sumMax = 0;
        let hasMax = false;
        const stepMsgs: string[] = [];

        for (const sn of stepNums) {
          const stepIdx = sn - 1;
          if (Array.isArray(res.stepScoresList) && res.stepScoresList[stepIdx] !== undefined) {
            sumScore += Number(res.stepScoresList[stepIdx]);
            hasScore = true;
          }
          if (Array.isArray(res.stepPointsList) && res.stepPointsList[stepIdx] !== undefined) {
            sumMax += Number(res.stepPointsList[stepIdx]);
            hasMax = true;
          }
          if (
            Array.isArray(res.studentMessagesList) &&
            res.studentMessagesList[stepIdx]
          ) {
            const msg = String(res.studentMessagesList[stepIdx]);
            stepMsgs.push(stepNums.length > 1 ? `[Step ${sn}] ${msg}` : msg);
          }
        }

        if (hasScore) t.stepScore = sumScore;
        if (hasMax) t.stepMaxScore = sumMax;
        if (stepMsgs.length > 0) {
          t.progressMessage = stepMsgs.join(' | ');
        }

        const isAllDone = stepNums.every((sn) => Boolean(res.stepCompleteList![sn - 1]));
        if (isAllDone) {
          t.progressVerified = true;
          t.status = 'completed';
          for (const s of t.steps) s.status = 'completed';
          if (!t.progressMessage) {
            t.progressMessage = 'Assessment Completed!';
          }
        } else if (t.id === task.id) {
          t.progressVerified = false;
        }
      }
      // Also mark non-Check-Progress setup tasks as completed if a subsequent graded task is completed
      for (let i = 0; i < this.state.tasks.length; i++) {
        const curr = this.state.tasks[i];
        if (!curr.hasCheckProgress && !/\boptional\b/i.test(curr.title)) {
          const anyLaterCompleted = this.state.tasks
            .slice(i + 1)
            .some((later) => later.progressVerified || later.status === 'completed');
          if (anyLaterCompleted) {
            curr.status = 'completed';
            for (const s of curr.steps) s.status = 'completed';
          }
        }
      }
    }
    this.emitState();
  }

  private isCourseSession(): boolean {
    if (this.manualTargetTypeOverride === 'lab') return false;
    if (this.manualTargetTypeOverride === 'course') return true;
    const inferred = inferTargetTypeFromUrl(this.state.labCurrentUrl || this.state.labUrl);
    if (inferred === 'lab') return false;
    if (inferred === 'course') return true;
    return (
      this.state.targetType === 'course' ||
      this.state.tasks.some((t) => Boolean(t.activityType))
    );
  }

  /**
   * Step 3: Starts the lab (if not already started), extracts temporary student credentials,
   * and spawns (or attaches to) the student Incognito Console & Cloud Shell window on the user's Mac.
   * When in Course mode, enrolls/starts the course session if needed without launching Incognito GCP Console.
   */
  public async startLabAndLaunchIncognito(): Promise<void> {
    await this.ensureLabPreviewPage();

    if (this.isCourseSession()) {
      if (!this.state.isLabStarted && this.state.courseStartHref) {
        let origin = 'https://partner.skills.google';
        try {
          origin = new URL(this.state.labCurrentUrl || this.state.labUrl || origin).origin;
        } catch {
          // Default origin
        }
        const startUrl = new URL(this.state.courseStartHref, origin).toString();
        const labTarget = parseTabKey(this.state.selectedLabTabKey);
        this.addLog('action', 'lab_window', `Enrolling / starting course session: ${startUrl}`);
        await completeCourseActivityInUserChrome({
          windowId: labTarget?.windowId,
          tabIndex: labTarget?.tabIndex,
          activityUrl: startUrl,
          activityType: 'document',
        });
        await this.parseLabInstructions();
      }
      this.setStatus('lab_parsed');
      await this.refreshScreenshots();
      return;
    }

    const wasAlreadyStarted = this.state.isLabStarted && Boolean(this.state.labInstanceId);
    this.setStatus('starting_lab');
    const creds = await triggerStartLabAndExtractCredentials(
      this.labPage!,
      (msg) => this.addLog('action', 'lab_window', msg),
      () => this.syncLabPageFromUserChrome(),
      this.state.labCurrentUrl || this.state.labUrl,
      parseTabKey(this.state.selectedLabTabKey)
    );

    this.state.credentials = {
      ...this.state.credentials,
      username: creds.username || this.state.credentials.username,
      password: creds.password || this.state.credentials.password,
      projectId: creds.projectId || this.state.credentials.projectId,
      consoleUrl: creds.consoleUrl || this.state.credentials.consoleUrl,
      region: creds.region || this.state.credentials.region,
      zone: creds.zone || this.state.credentials.zone,
      extraVars: { ...this.state.credentials.extraVars, ...creds.extraVars },
    };
    this.state.isLabStarted = Boolean(
      this.state.credentials.username || this.state.credentials.projectId
    );
    this.emitState();

    // Always re-parse after starting the lab so labInstanceId and interpolated code blocks are populated
    if (this.state.tasks.length === 0 || !wasAlreadyStarted || !this.state.labInstanceId) {
      await this.parseLabInstructions();
    }

    // Scan open Chrome windows to detect the user's manually launched Incognito Console & Cloud Shell tabs
    await this.scanOpenChromeWindows(false);
    const tabs = this.state.availableChromeTabs || [];
    const incConsoleTab =
      tabs.find((t) => t.windowMode === 'incognito' && t.suggestedRole === 'console') ||
      tabs.find((t) => t.key === this.state.selectedConsoleTabKey);
    const incShellTab =
      tabs.find((t) => t.windowMode === 'incognito' && t.suggestedRole === 'cloud_shell') ||
      tabs.find((t) => t.key === this.state.selectedCloudShellTabKey);

    if (incConsoleTab) {
      this.state.selectedConsoleTabKey = incConsoleTab.key;
      this.state.consoleCurrentUrl = incConsoleTab.url;
    }
    if (incShellTab) {
      this.state.selectedCloudShellTabKey = incShellTab.key;
    }

    if (incConsoleTab || incShellTab) {
      this.state.isConsoleSignedIn = true;
      this.addLog(
        'success',
        'incognito_console',
        `Connected to your Incognito Console & Cloud Shell session for ${this.state.credentials.username || 'student'} (Project: ${this.state.credentials.projectId || 'active'})!`
      );
    } else {
      this.state.isConsoleSignedIn = false;
      this.addLog(
        'warn',
        'incognito_console',
        `Lab started (${this.state.credentials.username} | ${this.state.credentials.projectId}). Please launch your initial Incognito Chrome window for Cloud Console and Cloud Shell using the tile above.`
      );
    }

    this.setStatus('lab_parsed');
    await this.refreshScreenshots();
  }

  /**
   * Unified end-to-end entry point:
   * 1. Points at the user's self-signed-in Lab/Course tab (or opens the provided URL in Chrome).
   * 2. For Labs: starts the lab, extracts student credentials, and attaches to Incognito Console + Cloud Shell.
   *    For Courses: navigates through all course modules, interactive lessons, videos, and quizzes to completion.
   */
  public async startAndRunLab(params?: {
    url?: string;
    labTabKey?: string | null;
  }): Promise<void> {
    if (this.isLoopRunning) {
      this.pauseRequested = false;
      this.setStatus('running_autonomous');
      return;
    }

    const requestedTabKey = params?.labTabKey?.trim() || null;
    const requestedUrl = params?.url?.trim() || '';

    if (requestedUrl) {
      const inferredFromUrl = inferTargetTypeFromUrl(requestedUrl);
      if (inferredFromUrl === 'lab') {
        this.manualTargetTypeOverride = null;
        this.state.targetType = 'lab';
      } else if (inferredFromUrl && this.manualTargetTypeOverride !== 'lab') {
        this.state.targetType = inferredFromUrl;
      }
    }

    if (requestedTabKey) {
      await this.scanOpenChromeWindows(false);
      const liveTab = (this.state.availableChromeTabs || []).find((t) => t.key === requestedTabKey);
      const liveTabUrlChanged = Boolean(
        liveTab?.url &&
          liveTab.url !== this.state.labUrl &&
          liveTab.url !== this.state.labCurrentUrl
      );
      const liveTabTargetType = inferTargetTypeFromUrl(liveTab?.url) || liveTab?.contentKind;
      const targetTypeMismatch = Boolean(
        this.manualTargetTypeOverride !== 'lab' &&
          (liveTabTargetType === 'course' || liveTabTargetType === 'lab') &&
          liveTabTargetType !== this.state.targetType
      );
      if (
        requestedTabKey !== this.state.selectedLabTabKey ||
        this.state.tasks.length === 0 ||
        liveTabUrlChanged ||
        targetTypeMismatch
      ) {
        await this.bindChromeTargets({
          labTabKey: requestedTabKey,
          consoleTabKey: this.state.selectedConsoleTabKey,
          cloudShellTabKey: this.state.selectedCloudShellTabKey,
        });
      }
    } else if (requestedUrl) {
      if (
        this.state.tasks.length === 0 ||
        (this.state.labUrl !== requestedUrl && this.state.labCurrentUrl !== requestedUrl)
      ) {
        await this.openLabUrl(requestedUrl);
      }
    } else if (this.state.tasks.length === 0) {
      await this.scanOpenChromeWindows(true);
      if (this.state.selectedLabTabKey) {
        await this.syncLabPageFromUserChrome();
        await this.parseLabInstructions();
      }
    }

    if (!this.isCourseSession()) {
      await this.startLabAndLaunchIncognito();
    }
    this.setExecutionMode('autonomous');
    this.startExecutionLoop(false).catch((err) => {
      this.addLog(
        'error',
        'system',
        `Autonomous execution error: ${err?.message || String(err)}`
      );
    });
  }

  /**
   * Closes out of all open student Incognito Chrome windows, optionally ends the active lab in Chrome,
   * clears persisted state on disk/Mac Bridge, and resets the UI back to the clean Screenshot-329.png screen.
   */
  public async resetForNewLab(options?: {
    endLabInChrome?: boolean;
    closeIncognito?: boolean;
  }): Promise<{ ended: boolean; closedIncognitoCount: number }> {
    this.pauseRequested = true;
    this.isLoopRunning = false;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    let ended = false;
    if (
      options?.endLabInChrome !== false &&
      !this.isCourseSession() &&
      (this.state.isLabStarted || this.state.labCurrentUrl || this.state.labUrl || this.state.selectedLabTabKey)
    ) {
      try {
        const endRes = await clickEndLabInUserChrome(
          this.state.labCurrentUrl || this.state.labUrl,
          parseTabKey(this.state.selectedLabTabKey)
        );
        ended = endRes.ended;
      } catch {
        // Ignore end lab errors during reset
      }
    }

    let closedIncognitoCount = 0;
    if (options?.closeIncognito !== false) {
      try {
        const incRes = await closeIncognitoWindowsInUserChrome();
        closedIncognitoCount = incRes.closedCount || 0;
      } catch {
        // Ignore incognito close errors
      }
      try {
        if (this.consolePage && !this.consolePage.isClosed()) {
          await this.consolePage.close();
        }
        if (this.incognitoContext) {
          await this.incognitoContext.close();
        }
      } catch {
        // Ignore Playwright context close errors
      }
      this.consolePage = null;
      this.incognitoContext = null;
    }

    try {
      const stateFilePath = this.getLocalStateFilePath();
      if (fs.existsSync(stateFilePath)) {
        fs.unlinkSync(stateFilePath);
      }
      if (fs.existsSync(LOCAL_STATE_FILE) && this.sessionId === 'default') {
        fs.unlinkSync(LOCAL_STATE_FILE);
      }
    } catch {
      // Ignore file removal error
    }
    await clearSavedStateOnMacBridge().catch(() => {});

    this.manualTargetTypeOverride = null;
    this.state = {
      ...this.state,
      sessionId: this.sessionId,
      targetType: this.state.targetType || 'lab',
      status: 'idle',
      labUrl: '',
      labTitle: '',
      labTimer: '00:00:00',
      isLabStarted: false,
      isConsoleSignedIn: false,
      labInstanceId: '',
      courseOverviewUrl: '',
      courseStartHref: '',
      totalScore: 0,
      maxScore: 0,
      credentials: {
        username: '',
        password: '',
        projectId: '',
        consoleUrl: '',
        region: '',
        zone: '',
        extraVars: {},
      },
      tasks: [],
      activeTaskId: null,
      activeStepId: null,
      labScreenshot: null,
      consoleScreenshot: null,
      labCurrentUrl: '',
      consoleCurrentUrl: '',
      logs: [],
      lastThought: '',
      selectedLabTabKey: null,
      selectedConsoleTabKey: null,
      selectedCloudShellTabKey: null,
    };

    await this.scanOpenChromeWindows(false);
    this.emitState();
    return { ended, closedIncognitoCount };
  }

  /**
   * Stops any active execution loop, clicks "End Lab" + confirms termination in the user's Chrome Lab tab,
   * closes all student Incognito Chrome windows, and resets the screen to the clean initial view.
   */
  public async endCurrentLab(): Promise<{ ended: boolean; message: string }> {
    const res = await this.resetForNewLab({ endLabInChrome: true, closeIncognito: true });
    return {
      ended: res.ended,
      message: res.ended
        ? 'Lab ended, Incognito windows closed, and screen reset.'
        : 'Closed Incognito windows and reset screen for new lab.',
    };
  }

  /**
   * Ends the current lab (if requested), closes out of all student Incognito windows,
   * resets all lab state/credentials/tasks cleanly to the initial screen, and optionally loads a new lab.
   */
  public async switchSkillCourse(params: {
    url?: string;
    labTabKey?: string | null;
    endCurrentFirst?: boolean;
    autoRun?: boolean;
  }): Promise<void> {
    await this.resetForNewLab({
      endLabInChrome: Boolean(params.endCurrentFirst && this.state.isLabStarted),
      closeIncognito: true,
    });

    if (params.labTabKey) {
      await this.bindChromeTargets({
        labTabKey: params.labTabKey,
        consoleTabKey: null,
        cloudShellTabKey: null,
      });
    } else if (params.url && params.url.trim()) {
      const cleanUrl = params.url.trim();
      await this.openLabUrl(cleanUrl);
    }

    if (params.autoRun && this.state.tasks.length > 0) {
      this.setExecutionMode('autonomous');
      this.startExecutionLoop(false).catch((err) => {
        this.addLog('error', 'system', `Autonomous execution error: ${err?.message || String(err)}`);
      });
    }
  }

  /**
   * Ensures a clean, isolated Incognito browser context and window are open (used only if the user
   * has not selected an existing native Chrome Console window).
   */
  public async ensureIncognitoConsoleWindow(): Promise<Page> {
    if (this.consolePage && !this.consolePage.isClosed()) {
      return this.consolePage;
    }

    this.addLog(
      'info',
      'incognito_console',
      'Launching isolated Incognito Chromium window for Google Cloud Console & Antigravity...'
    );

    if (!this.incognitoBrowser) {
      this.incognitoBrowser = await chromium.launch({
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
        headless: process.platform !== 'darwin' || process.env.HEADLESS === 'true',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--incognito',
          '--disable-blink-features=AutomationControlled',
          '--window-position=620,40',
        ],
      });
    }

    this.incognitoContext = await this.incognitoBrowser.newContext({
      viewport: { width: 1280, height: 840 },
    });

    this.incognitoContext.on('page', async (newPage) => {
      try {
        await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 });
        this.addLog(
          'info',
          'incognito_console',
          `Switched active Incognito tab to newly opened window: ${newPage.url()}`
        );
        this.consolePage = newPage;
        await this.refreshScreenshots();
      } catch {
        this.consolePage = newPage;
      }
    });

    this.consolePage = await this.incognitoContext.newPage();
    return this.consolePage;
  }

  /**
   * Opens any active link from the lab instructions directly inside the user's selected Incognito Console window
   * (or the Playwright Incognito window if no native Chrome Console window is selected).
   */
  public async openUrlInIncognito(url: string): Promise<void> {
    const interpolatedUrl = interpolateLabVariables(url, this.state.credentials);
    const selectedKey = this.state.selectedConsoleTabKey || this.state.selectedCloudShellTabKey;
    const selectedTab = (this.state.availableChromeTabs || []).find((t) => t.key === selectedKey);
    const nativeConsoleTarget =
      selectedTab && selectedTab.windowMode === 'incognito' ? parseTabKey(selectedKey) : null;

    if (nativeConsoleTarget) {
      this.addLog(
        'action',
        'incognito_console',
        `Opening URL in your selected Incognito Chrome Console window: ${interpolatedUrl}`
      );
      await navigateOrOpenInUserChromeWindow(
        nativeConsoleTarget.windowId,
        nativeConsoleTarget.tabIndex,
        interpolatedUrl,
        true
      );
      this.state.consoleCurrentUrl = interpolatedUrl;
      this.emitState();
      return;
    }

    const page = await this.ensureIncognitoConsoleWindow();
    this.addLog('action', 'incognito_console', `Navigating Incognito window to: ${interpolatedUrl}`);
    await page.goto(interpolatedUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await this.refreshScreenshots();
  }

  /**
   * Executes a Google Cloud Skills Course from start to finish:
   * - Enrolls / starts the course session if not yet started
   * - Navigates through every interactive lesson (`link` / `document` / `html_bundle`) and `video` activity, recording completion
   * - Extracts Articulate Rise 360 (`runtime-data.js`) or Skills Studio (`html_bundle`) course material automatically
   * - Solves and submits every `<ql-quiz>` and `<gss-knowledge-check>` assessment until passing grade is verified
   */
  private async executeCourseLoop(singleStepOnly = false): Promise<void> {
    this.pauseRequested = false;
    this.isLoopRunning = true;
    this.setStatus(singleStepOnly ? 'running_step' : 'running_autonomous');

    try {
      if (this.state.tasks.length === 0) {
        await this.parseLabInstructions();
      }

      let origin = 'https://partner.skills.google';
      try {
        origin = new URL(this.state.labCurrentUrl || this.state.labUrl || origin).origin;
      } catch {
        // Default origin
      }

      const loadHtmlIntoPreviewPage = async (html?: string, currentUrl?: string) => {
        if (currentUrl) {
          this.state.labCurrentUrl = currentUrl;
        }
        if (html && html.trim().length > 200) {
          const page = await this.ensureLabPreviewPage();
          const tmpFile = path.join(
            os.tmpdir(),
            `skills_course_${this.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.html`
          );
          fs.writeFileSync(tmpFile, html, 'utf8');
          await page.goto(`file://${tmpFile}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(250);
          await this.refreshScreenshots();
        } else {
          await this.syncLabPageFromUserChrome();
          await this.refreshScreenshots();
        }
      };

      const labTarget = parseTabKey(this.state.selectedLabTabKey);

      if (!this.state.isLabStarted && this.state.courseStartHref) {
        const startUrl = new URL(this.state.courseStartHref, origin).toString();
        this.addLog('action', 'lab_window', `Enrolling / starting course session: ${startUrl}`);
        const startRes = await completeCourseActivityInUserChrome({
          windowId: labTarget?.windowId,
          tabIndex: labTarget?.tabIndex,
          activityUrl: startUrl,
          activityType: 'document',
        });
        await loadHtmlIntoPreviewPage(startRes.htmlContent, startRes.url || startUrl);
        await this.parseLabInstructions();
      }

      let courseKnowledgeBase = '';

      // If the user opened a specific activity URL (e.g. a specific quiz /html_bundles/644267),
      // prioritize that pending task first so it executes immediately before cycling through remaining tasks.
      const currentOpenUrl = this.state.labCurrentUrl || this.state.labUrl || '';
      const openUrlMatch = currentOpenUrl.match(
        /\/(html_bundles|quizzes|documents|videos|links)\/(\d+)/i
      );
      const prioritizedTaskIdx = openUrlMatch
        ? this.state.tasks.findIndex(
            (t) =>
              !(t.status === 'completed' && t.progressVerified) &&
              Boolean(
                t.activityHref &&
                  t.activityHref.includes(`/${openUrlMatch[1]}/${openUrlMatch[2]}`)
              )
          )
        : -1;

      const orderedTaskIndices: number[] = [];
      if (prioritizedTaskIdx >= 0) {
        orderedTaskIndices.push(prioritizedTaskIdx);
      }
      // Run all non-lab course activities (documents, links, videos, html_bundles, quizzes) first
      for (let idx = 0; idx < this.state.tasks.length; idx++) {
        if (idx !== prioritizedTaskIdx && this.state.tasks[idx]?.activityType !== 'lab') {
          orderedTaskIndices.push(idx);
        }
      }
      // Then transition into any embedded hands-on labs
      for (let idx = 0; idx < this.state.tasks.length; idx++) {
        if (idx !== prioritizedTaskIdx && this.state.tasks[idx]?.activityType === 'lab') {
          orderedTaskIndices.push(idx);
        }
      }

      let transitionToEmbeddedLabUrl: string | null = null;
      for (const taskIdx of orderedTaskIndices) {
        if (this.pauseRequested) {
          this.setStatus('paused');
          this.addLog('warn', 'system', 'Course progression paused by operator.');
          return;
        }

        const task = this.state.tasks[taskIdx];
        if (!task || (task.status === 'completed' && task.progressVerified)) {
          continue;
        }

        this.state.activeTaskId = task.id;
        this.state.activeStepId = task.steps[0]?.id || null;
        task.status = 'running';
        if (task.steps[0]) task.steps[0].status = 'running';
        this.emitState();

        let actType = task.activityType || 'link';
        const actHref = task.activityHref || task.steps[0]?.links?.[0]?.href || '';
        if (!actHref) {
          task.status = 'completed';
          task.progressVerified = true;
          task.stepScore = 1;
          for (const s of task.steps) s.status = 'completed';
          this.emitState();
          continue;
        }

        const actUrl = new URL(actHref, origin).toString();
        let preloadedQuizParsed: Awaited<ReturnType<typeof parseLabPageDom>> | null = null;

        if (
          actType === 'link' ||
          actType === 'document' ||
          actType === 'video' ||
          actType === 'html_bundle'
        ) {
          this.addLog(
            'action',
            'lab_window',
            `Completing ${actType} activity #${task.number}: "${task.title}" (${actUrl})...`
          );
          const navRes = await completeCourseActivityInUserChrome({
            windowId: labTarget?.windowId,
            tabIndex: labTarget?.tabIndex,
            activityUrl: actUrl,
            activityType: actType,
          });
          await loadHtmlIntoPreviewPage(navRes.htmlContent, navRes.url || actUrl);

          const snapParsed = await parseLabPageDom(this.labPage!);
          if (snapParsed.courseOverviewUrl) {
            this.state.courseOverviewUrl = snapParsed.courseOverviewUrl;
          }
          if (snapParsed.tasks.length === this.state.tasks.length) {
            for (let i = 0; i < this.state.tasks.length; i++) {
              const st = snapParsed.tasks[i];
              if (st?.activityHref) {
                this.state.tasks[i].activityHref = st.activityHref;
              }
              if (st?.activityType === 'quiz') {
                this.state.tasks[i].activityType = 'quiz';
              }
              if (st?.progressVerified) {
                this.state.tasks[i].progressVerified = true;
                this.state.tasks[i].status = 'completed';
                this.state.tasks[i].stepScore = 1;
                for (const s of this.state.tasks[i].steps) s.status = 'completed';
              }
            }
          }

          if (snapParsed.currentIframeSrc && !courseKnowledgeBase) {
            this.addLog(
              'info',
              'gemini',
              `Extracting course material from ${snapParsed.currentIframeSrc}...`
            );
            courseKnowledgeBase = await fetchCourseKnowledgeFromIframeSrc(
              snapParsed.currentIframeSrc
            );
            if (courseKnowledgeBase) {
              this.addLog(
                'success',
                'gemini',
                `Indexed ${courseKnowledgeBase.length.toLocaleString()} chars of course material for quiz solving.`
              );
            }
          }

          if (
            snapParsed.currentQuiz &&
            snapParsed.currentQuiz.items.length > 0 &&
            !snapParsed.currentQuiz.isPassing
          ) {
            actType = 'quiz';
            task.activityType = 'quiz';
            preloadedQuizParsed = snapParsed;
          } else {
            task.status = 'completed';
            task.progressVerified = true;
            task.stepScore = 1;
            task.progressMessage = 'Activity completed';
            for (const s of task.steps) s.status = 'completed';
            this.state.totalScore = this.state.tasks.filter((t) => t.progressVerified).length;
            this.state.maxScore = this.state.tasks.length || 1;
            this.state.labTimer = `${this.state.totalScore}/${this.state.maxScore} done`;
            this.emitState();

            this.addLog(
              'success',
              'lab_window',
              `Completed activity #${task.number}: "${task.title}" (${this.state.totalScore}/${this.state.maxScore} done).`
            );
          }
        }

        if (actType === 'quiz') {
          // If we haven't extracted course knowledge yet and this is not a self-contained html_bundle quiz,
          // inspect the first link module to grab runtime-data.js
          if (!courseKnowledgeBase && !actHref.includes('/html_bundles/')) {
            const linkTask = this.state.tasks.find(
              (t) => t.activityType === 'link' && Boolean(t.activityHref)
            );
            if (linkTask?.activityHref) {
              const linkUrl = new URL(linkTask.activityHref, origin).toString();
              this.addLog(
                'info',
                'gemini',
                `Pre-fetching course lesson material from "${linkTask.title}" before solving quiz...`
              );
              const preRes = await completeCourseActivityInUserChrome({
                windowId: labTarget?.windowId,
                tabIndex: labTarget?.tabIndex,
                activityUrl: linkUrl,
                activityType: 'link',
              });
              await loadHtmlIntoPreviewPage(preRes.htmlContent, preRes.url || linkUrl);
              const preParsed = await parseLabPageDom(this.labPage!);
              if (preParsed.currentIframeSrc) {
                courseKnowledgeBase = await fetchCourseKnowledgeFromIframeSrc(
                  preParsed.currentIframeSrc
                );
                if (courseKnowledgeBase) {
                  this.addLog(
                    'success',
                    'gemini',
                    `Indexed ${courseKnowledgeBase.length.toLocaleString()} chars of course material from "${linkTask.title}".`
                  );
                }
              }
            }
          }

          let quizParsed: Awaited<ReturnType<typeof parseLabPageDom>>;
          if (preloadedQuizParsed) {
            quizParsed = preloadedQuizParsed;
          } else {
            this.addLog(
              'action',
              'lab_window',
              `Opening Quiz #${task.number}: "${task.title}" (${actUrl})...`
            );
            const quizNav = await completeCourseActivityInUserChrome({
              windowId: labTarget?.windowId,
              tabIndex: labTarget?.tabIndex,
              activityUrl: actUrl,
              activityType: 'quiz',
            });
            await loadHtmlIntoPreviewPage(quizNav.htmlContent, quizNav.url || actUrl);
            quizParsed = await parseLabPageDom(this.labPage!);
          }

          if (quizParsed.currentQuiz?.isPassing) {
            const grade = quizParsed.currentQuiz.percentageGrade ?? 100;
            task.status = 'completed';
            task.progressVerified = true;
            task.stepScore = 1;
            task.progressMessage = `Quiz Passed (${grade}%)`;
            for (const s of task.steps) s.status = 'completed';
            this.state.totalScore = this.state.tasks.filter((t) => t.progressVerified).length;
            this.state.labTimer = `${this.state.totalScore}/${this.state.maxScore} done`;
            this.emitState();
            this.addLog(
              'success',
              'lab_window',
              `Quiz "${task.title}" is already passed (${grade}%).`
            );
          } else if (quizParsed.currentQuiz && quizParsed.currentQuiz.items.length > 0) {
            const excludedChoicesByItemId: Record<string, string[]> = {};
            const lockedChoicesByItemId: Record<string, string | string[]> = {};
            const maxQuizAttempts = 3;

            for (let attempt = 1; attempt <= maxQuizAttempts; attempt++) {
              if (this.pauseRequested) {
                this.setStatus('paused');
                return;
              }

              const cq = quizParsed.currentQuiz!;
              for (const ir of cq.itemResponses || []) {
                if (ir.isSubmitted && ir.choiceId) {
                  if (ir.isCorrect === true) {
                    lockedChoicesByItemId[ir.quizItemId] = ir.choiceId;
                  } else if (ir.isCorrect === false) {
                    const arr = excludedChoicesByItemId[ir.quizItemId] || [];
                    if (!arr.includes(ir.choiceId)) arr.push(ir.choiceId);
                    excludedChoicesByItemId[ir.quizItemId] = arr;
                  }
                } else if (
                  ir.isSubmitted &&
                  ir.isCorrect === true &&
                  Array.isArray(ir.choiceIds) &&
                  ir.choiceIds.length > 0
                ) {
                  lockedChoicesByItemId[ir.quizItemId] = ir.choiceIds;
                }
              }

              this.addLog(
                'ai',
                'gemini',
                `Solving ${cq.items.length} quiz questions for "${task.title}" (Attempt ${attempt}/${maxQuizAttempts})...`
              );
              const answers = await solveCourseQuizQuestions(
                this.state.labTitle,
                courseKnowledgeBase,
                cq.items,
                excludedChoicesByItemId,
                lockedChoicesByItemId
              );

              for (let idx = 0; idx < answers.length; idx++) {
                const ans = answers[idx];
                if (ans.itemType === 'multiple-select' && Array.isArray(ans.optionTitles)) {
                  const nums = (ans.optionIndices || []).map((i) => `#${i + 1}`).join(', ');
                  this.addLog(
                    'ai',
                    'gemini',
                    `Q${idx + 1}: Selected Options ${nums} ("${ans.optionTitles.join(' + ')}") — ${ans.reason || ''}`
                  );
                } else {
                  this.addLog(
                    'ai',
                    'gemini',
                    `Q${idx + 1}: Selected Option #${(ans.optionIndex ?? 0) + 1} ("${ans.optionTitle || ''}") — ${ans.reason || ''}`
                  );
                }
              }

              const needsRetakeFirst = Boolean(cq.isSubmitted && !cq.isPassing);
              this.addLog(
                'action',
                'lab_window',
                `Selecting ${answers.length} answers and submitting Quiz "${task.title}" in Chrome...`
              );
              const submitRes = await submitCourseQuizInUserChrome({
                windowId: labTarget?.windowId,
                tabIndex: labTarget?.tabIndex,
                quizUrl: actUrl,
                answers,
                needsRetakeFirst,
              });

              await loadHtmlIntoPreviewPage(submitRes.htmlContent, submitRes.url || actUrl);
              quizParsed = await parseLabPageDom(this.labPage!);

              const menuQuizTask = quizParsed.tasks.find(
                (t) =>
                  (task.activityId && t.activityId === task.activityId) ||
                  (t.number === task.number && t.title === task.title)
              );
              const isPassed = Boolean(
                quizParsed.currentQuiz?.isPassing || menuQuizTask?.progressVerified
              );
              const grade = quizParsed.currentQuiz?.percentageGrade;

              if (isPassed) {
                task.status = 'completed';
                task.progressVerified = true;
                task.stepScore = 1;
                task.progressMessage = `Quiz Passed (${grade ?? 100}%)`;
                for (const s of task.steps) s.status = 'completed';
                this.state.totalScore = this.state.tasks.filter((t) => t.progressVerified).length;
                this.state.labTimer = `${this.state.totalScore}/${this.state.maxScore} done`;
                this.emitState();
                this.addLog(
                  'success',
                  'lab_window',
                  `Quiz "${task.title}" PASSED with score ${grade ?? 100}%!`
                );
                break;
              } else {
                this.addLog(
                  'warn',
                  'lab_window',
                  `Quiz attempt ${attempt}/${maxQuizAttempts} scored ${grade ?? 0}% (passing: ${cq.passingPercentage}%). Adjusting answers and retrying...`
                );
                if (attempt === maxQuizAttempts) {
                  task.status = 'failed';
                  task.progressMessage = `Score: ${grade ?? 0}%`;
                  this.emitState();
                }
              }
            }
          }
        } else if (actType === 'lab') {
          this.addLog(
            'action',
            'lab_window',
            `Transitioning from Course into embedded Hands-on Lab #${task.number}: "${task.title}" (${actUrl})...`
          );
          const labNavRes = await completeCourseActivityInUserChrome({
            windowId: labTarget?.windowId,
            tabIndex: labTarget?.tabIndex,
            activityUrl: actUrl,
            activityType: 'document',
          });
          await loadHtmlIntoPreviewPage(labNavRes.htmlContent, labNavRes.url || actUrl);
          transitionToEmbeddedLabUrl = labNavRes.url || actUrl;
          this.manualTargetTypeOverride = 'lab';
          this.state.targetType = 'lab';
          this.state.labUrl = transitionToEmbeddedLabUrl;
          this.state.labCurrentUrl = transitionToEmbeddedLabUrl;
          this.state.tasks = [];
          this.emitState();
          break;
        }

        if (singleStepOnly) {
          this.setStatus('paused');
          this.addLog('info', 'system', `Completed single course activity: "${task.title}".`);
          return;
        }
      }

      if (transitionToEmbeddedLabUrl) {
        this.isLoopRunning = false;
        await this.parseLabInstructions();
        if (!this.pauseRequested) {
          await this.startLabAndLaunchIncognito();
          await this.startExecutionLoop(singleStepOnly);
        }
        return;
      }

      const allDone =
        this.state.tasks.length > 0 &&
        this.state.tasks.every((t) => t.status === 'completed' || t.progressVerified);
      if (allDone) {
        if (this.state.courseOverviewUrl) {
          try {
            const overviewFullUrl = new URL(this.state.courseOverviewUrl, origin).toString();
            this.addLog(
              'action',
              'lab_window',
              `Returning to Course Overview page to display 100% completion: ${overviewFullUrl}`
            );
            const finalNav = await completeCourseActivityInUserChrome({
              windowId: labTarget?.windowId,
              tabIndex: labTarget?.tabIndex,
              activityUrl: overviewFullUrl,
              activityType: 'document',
            });
            await loadHtmlIntoPreviewPage(finalNav.htmlContent, finalNav.url || overviewFullUrl);
          } catch {
            // Ignore final overview navigation errors
          }
        }
        this.setStatus('completed');
        this.addLog(
          'success',
          'system',
          `Course "${this.state.labTitle}" 100% completed (${this.state.totalScore}/${this.state.maxScore} activities)!`
        );
      } else {
        this.setStatus('paused');
      }
    } finally {
      this.isLoopRunning = false;
      this.emitState();
    }
  }

  /**
   * Starts or resumes the Lab or Course Execution Loop (either Autonomous or Single-Step).
   */
  public async startExecutionLoop(singleStepOnly = false): Promise<void> {
    if (this.isLoopRunning) {
      this.pauseRequested = false;
      this.setStatus(singleStepOnly ? 'running_step' : 'running_autonomous');
      return;
    }

    if (this.isCourseSession()) {
      await this.executeCourseLoop(singleStepOnly);
      return;
    }

    if (this.state.tasks.length === 0 || !this.state.isLabStarted || !this.state.credentials.password) {
      await this.parseLabInstructions();
    }

    if (this.isCourseSession()) {
      await this.executeCourseLoop(singleStepOnly);
      return;
    }

    const hasNativeTarget = Boolean(
      parseTabKey(this.state.selectedConsoleTabKey || this.state.selectedCloudShellTabKey)
    );

    if (
      !this.state.isLabStarted ||
      !this.state.credentials.username ||
      !this.state.credentials.password ||
      (!hasNativeTarget && (!this.consolePage || this.consolePage.isClosed()))
    ) {
      await this.startLabAndLaunchIncognito();
    }

    this.pauseRequested = false;
    this.isLoopRunning = true;
    this.setStatus(singleStepOnly ? 'running_step' : 'running_autonomous');

    try {
      const allTasksSummary = this.state.tasks
        .map(
          (t) =>
            `Task #${t.number}: ${t.title}\n${(t.rawSectionText || '')
              .slice(0, 600)
              .trim()}`
        )
        .join('\n\n');

        for (let taskIdx = 0; taskIdx < this.state.tasks.length; taskIdx++) {
        const task = this.state.tasks[taskIdx];
        if (!task || task.status === 'completed' || task.status === 'skipped') continue;

        const hasAnyCommand = task.steps.some((s) => (s.commands || []).length > 0);
        const isInformationalOrOptional =
          !task.hasCheckProgress &&
          ((!hasAnyCommand &&
            /\b(overview|introduction|scenario|objectives?)\b/i.test(task.title)) ||
            /\boptional\b/i.test(task.title));
        if (isInformationalOrOptional) {
          task.status = 'completed';
          for (const s of task.steps) s.status = 'completed';
          this.addLog('info', 'system', `Skipped non-graded section: ${task.title}`);
          this.emitState();
          continue;
        }

        // Pre-task live score & completion check: if this task is already verified on Qwiklabs, mark it completed and advance immediately
        if (task.hasCheckProgress && this.state.isLabStarted) {
          try {
            const preCheck = await this.verifyTaskProgress(task);
            if (preCheck.verified) {
              this.addLog(
                'success',
                'lab_window',
                `Task #${task.number} is already verified on Qwiklabs (${task.stepScore ?? 0}/${task.stepMaxScore ?? 0} pts | Total: ${this.state.totalScore ?? 0}/${this.state.maxScore ?? 100}). Advancing...`
              );
              continue;
            }
          } catch {
            // Ignore pre-task check error and proceed with task execution
          }
        }

        this.state.activeTaskId = task.id;
        task.status = 'running';
        this.addLog('info', 'system', `Starting Task #${task.number}: ${task.title}`);

        // In Autonomous mode with student credentials, execute a unified stateful task script
        // with live Cloud Shell workspace introspection and self-healing grader verification.
        const useUnifiedTaskExecution =
          !singleStepOnly &&
          this.state.executionMode === 'autonomous' &&
          Boolean(this.state.credentials.username && this.state.credentials.password);

        if (useUnifiedTaskExecution) {
          for (const s of task.steps) {
            if (s.status !== 'completed' && s.status !== 'skipped') {
              s.status = 'running';
              this.state.activeStepId = s.id;
            }
          }
          this.emitState();

          const maxAttempts = task.hasCheckProgress ? 4 : 2;
          let previousErrorMessage: string | undefined;
          let previousScriptOutput: string | undefined;

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (this.pauseRequested || !this.state.isLabStarted) {
              this.setStatus('paused');
              this.addLog('warn', 'system', 'Execution paused by operator.');
              this.isLoopRunning = false;
              return;
            }

            this.addLog(
              'info',
              'cloud_shell',
              `[Task #${task.number} | Attempt ${attempt}/${maxAttempts}] Inspecting live student Cloud Shell workspace...`
            );
            const workspaceSnapshot = await inspectStudentCloudShellWorkspace({
              username: this.state.credentials.username,
              password: this.state.credentials.password,
              projectId: this.state.credentials.projectId,
            });

            if (this.pauseRequested || !this.state.isLabStarted) {
              this.setStatus('paused');
              this.addLog('warn', 'system', 'Execution paused by operator.');
              this.isLoopRunning = false;
              return;
            }

            const synth = await synthesizeTaskShellScript({
              labTitle: this.state.labTitle,
              task,
              credentials: this.state.credentials,
              allTasksSummary,
              workspaceSnapshot,
              previousErrorMessage,
              previousScriptOutput,
            });

            if (this.pauseRequested || !this.state.isLabStarted) {
              this.setStatus('paused');
              this.addLog('warn', 'system', 'Execution paused by operator.');
              this.isLoopRunning = false;
              return;
            }

            let lastSshOk = true;
            if (synth && synth.script.trim()) {
              this.addLog(
                'action',
                'cloud_shell',
                `[Task #${task.number} | Attempt ${attempt}/${maxAttempts}] Executing synthesized task script in Cloud Shell: ${synth.summary}`
              );
              const sshRes = await execInStudentCloudShellBridge({
                command: synth.script,
                username: this.state.credentials.username,
                password: this.state.credentials.password,
                projectId: this.state.credentials.projectId,
                onProgress: (m) => this.addLog('info', 'cloud_shell', m),
                timeoutMs: 600000,
              });
              lastSshOk = sshRes.ok;
              previousScriptOutput = `${sshRes.stdout}\n${sshRes.stderr}`.trim();
              if (sshRes.stdout) {
                this.addLog(
                  'info',
                  'cloud_shell',
                  `Task #${task.number} Cloud Shell stdout: ${sshRes.stdout.slice(-400)}`
                );
              }
              if (sshRes.stderr) {
                this.addLog(
                  sshRes.ok ? 'info' : 'warn',
                  'cloud_shell',
                  `Task #${task.number} Cloud Shell stderr: ${sshRes.stderr.slice(-400)}`
                );
              }
            }

            if (this.pauseRequested || !this.state.isLabStarted) {
              this.setStatus('paused');
              this.addLog('warn', 'system', 'Execution paused by operator.');
              this.isLoopRunning = false;
              return;
            }

            if (task.hasCheckProgress) {
              await this.ensureLabPreviewPage();
              this.addLog(
                'action',
                'lab_window',
                `[Task #${task.number} | Attempt ${attempt}/${maxAttempts}] Verifying via "Check my progress"...`
              );
              const checkRes = await this.verifyTaskProgress(task);
              this.addLog(
                checkRes.verified ? 'success' : 'warn',
                'lab_window',
                `Task #${task.number} Progress Check (Attempt ${attempt}/${maxAttempts}): ${checkRes.message} (${task.stepScore ?? 0}/${task.stepMaxScore ?? 0} pts | Total: ${this.state.totalScore ?? 0}/${this.state.maxScore ?? 100})`
              );

              if (checkRes.verified) {
                await this.syncLabPageFromUserChrome().catch(() => {});
                await this.refreshScreenshots().catch(() => {});
                break;
              }
              previousErrorMessage = checkRes.message;
            } else {
              if (lastSshOk) {
                task.status = 'completed';
                for (const s of task.steps) s.status = 'completed';
                // Poll the first gradable task after setup tasks so totalScore stays synced continuously
                const firstGradable = this.state.tasks.find(
                  (t) => t.hasCheckProgress && (t.checkProgressStepNumber || (t.checkProgressStepNumbers && t.checkProgressStepNumbers.length > 0))
                );
                if (firstGradable && this.state.isLabStarted) {
                  try {
                    await this.verifyTaskProgress(firstGradable);
                    this.addLog(
                      'info',
                      'lab_window',
                      `Task #${task.number} setup complete — Live Lab Score: ${this.state.totalScore ?? 0}/${this.state.maxScore ?? 100} pts`
                    );
                  } catch {
                    // Ignore status poll error
                  }
                }
                break;
              }
              previousErrorMessage = previousScriptOutput || 'Non-zero exit code in Cloud Shell setup script';
            }
          }

          if (task.status !== 'completed') {
            if (task.hasCheckProgress && !task.progressVerified) {
              task.status = 'failed';
              for (const s of task.steps) {
                if (s.status === 'running') s.status = 'failed';
              }
            } else {
              for (const s of task.steps) {
                if (s.status === 'running') s.status = 'completed';
              }
              if (!task.hasCheckProgress) {
                task.status = 'completed';
              }
            }
          }
          this.emitState();
          continue;
        }

        // Step-by-Step mode (or when student credentials are not available)
        for (const step of task.steps) {
          if (step.status === 'completed' || step.status === 'skipped') continue;

          if (this.pauseRequested) {
            this.setStatus('paused');
            this.addLog('warn', 'system', 'Execution paused by operator.');
            this.isLoopRunning = false;
            return;
          }

          this.state.activeStepId = step.id;
          step.status = 'running';
          this.emitState();

          const success = await this.executeSingleLabStep(task, step);
          step.status = success ? 'completed' : 'failed';
          this.emitState();

          if (!success) {
            this.addLog(
              'warn',
              'system',
              `Step #${step.index} encountered an issue. Pausing so you can inspect, retry, or skip.`
            );
            this.setStatus('paused');
            this.isLoopRunning = false;
            return;
          }

          // If in Step-by-Step mode or singleStepOnly was requested, pause after completing this step
          if (singleStepOnly || this.state.executionMode === 'step_by_step') {
            this.setStatus('paused');
            this.addLog(
              'info',
              'system',
              `Completed Step #${step.index}. Waiting for operator to click "Next Step" or switch to Autonomous mode.`
            );
            this.isLoopRunning = false;
            return;
          }
        }

        // All steps in this task are done! If the task has a "Check my progress" button, click it in the Lab window
        if (task.hasCheckProgress) {
          this.addLog(
            'action',
            'lab_window',
            `Verifying Task #${task.number} via "Check my progress" in Lab window...`
          );
          const checkRes = await this.verifyTaskProgress(task);
          this.addLog(
            checkRes.verified ? 'success' : 'warn',
            'lab_window',
            `Task #${task.number} Progress Check: ${checkRes.message} (${task.stepScore ?? 0}/${task.stepMaxScore ?? 0} pts | Total: ${this.state.totalScore ?? 0}/${this.state.maxScore ?? 100})`
          );
        } else {
          task.status = 'completed';
        }
        this.emitState();
      }

      const unverifiedGradable = this.state.tasks.filter(
        (t) => t.hasCheckProgress && !t.progressVerified
      );
      if (unverifiedGradable.length > 0) {
        this.setStatus('paused');
        this.addLog(
          'warn',
          'system',
          `Execution pass finished with ${unverifiedGradable.length} unverified progress check(s) (Score: ${this.state.totalScore ?? 0}/${this.state.maxScore ?? 100}). Click "Start & Run Lab" to retry remaining tasks.`
        );
      } else {
        this.setStatus('completed');
        this.addLog('success', 'system', 'All lab tasks and steps have been completed!');
      }
    } catch (err: any) {
      this.setStatus('error');
      this.addLog('error', 'system', `Execution loop error: ${err?.message || String(err)}`);
    } finally {
      this.isLoopRunning = false;
      await this.refreshScreenshots();
    }
  }

  /**
   * Executes a single LabStep inside either the user's bound native Chrome Console/Cloud Shell tabs
   * or the Playwright Incognito window.
   */
  private async executeSingleLabStep(task: LabTask, step: LabStep): Promise<boolean> {
    const interpolatedInstruction = interpolateLabVariables(
      step.instruction,
      this.state.credentials
    );
    const interpolatedCommands = (step.commands || []).map((c) =>
      transformAgyLaunchCommand(interpolateLabVariables(c, this.state.credentials))
    );

    this.addLog(
      'action',
      step.targetSurface === 'antigravity'
        ? 'antigravity'
        : step.targetSurface === 'cloud_shell'
        ? 'cloud_shell'
        : 'incognito_console',
      `Step ${task.number}.${step.index} [${step.targetSurface}]: ${interpolatedInstruction}`
    );

    // 1. If the step has active links and instructs opening a link, open it in the target Console window
    for (const link of step.links) {
      if (
        link.href.includes('console.cloud.google.com') ||
        step.targetSurface === 'browser_link'
      ) {
        await this.openUrlInIncognito(link.href);
      }
    }

    const nativeShellTarget = parseTabKey(
      this.state.selectedCloudShellTabKey || this.state.selectedConsoleTabKey
    );
    const nativeConsoleTarget = parseTabKey(
      this.state.selectedConsoleTabKey || this.state.selectedCloudShellTabKey
    );

    // Direct Cloud Shell SSH execution when student credentials are known
    if (
      step.targetSurface === 'cloud_shell' &&
      interpolatedCommands.length > 0 &&
      this.state.credentials.username &&
      this.state.credentials.password
    ) {
      const combinedCmd = interpolatedCommands.join('\n');
      this.addLog(
        'action',
        'cloud_shell',
        `Executing in student Cloud Shell via SSH: ${combinedCmd.slice(0, 160)}`
      );
      const sshRes = await execInStudentCloudShellBridge({
        command: combinedCmd,
        username: this.state.credentials.username,
        password: this.state.credentials.password,
        projectId: this.state.credentials.projectId,
        onProgress: (m) => this.addLog('info', 'cloud_shell', m),
      });
      if (sshRes.ok) {
        return true;
      }
      this.addLog(
        'warn',
        'cloud_shell',
        `Direct Cloud Shell SSH returned non-zero (${sshRes.stderr.slice(0, 200)}); falling back to browser tab paste...`
      );
    }

    // Native Chrome Window Execution Path (when user selected their authenticated Chrome tabs)
    if (nativeShellTarget || nativeConsoleTarget) {
      if (step.targetSurface === 'cloud_shell' && interpolatedCommands.length > 0 && nativeShellTarget) {
        for (const cmd of interpolatedCommands) {
          this.addLog(
            'action',
            'cloud_shell',
            `Executing in selected Cloud Shell tab: ${cmd}`
          );
          await sendTextToUserChromeTab(
            nativeShellTarget.windowId,
            nativeShellTarget.tabIndex,
            cmd,
            true,
            (m) => this.addLog('warn', 'cloud_shell', m)
          );
          await new Promise((r) => setTimeout(r, 2500));
        }
        return true;
      }

      if (step.targetSurface === 'antigravity' && interpolatedCommands.length > 0 && nativeShellTarget) {
        for (const promptText of interpolatedCommands) {
          const autonomousPrompt = formatAutonomousAntigravityPrompt(promptText);
          this.addLog(
            'action',
            'antigravity',
            `Sending zero-touch prompt to selected Antigravity / Cloud Shell tab: "${promptText.slice(0, 120)}..."`
          );
          await sendTextToUserChromeTab(
            nativeShellTarget.windowId,
            nativeShellTarget.tabIndex,
            autonomousPrompt,
            true,
            (m) => this.addLog('warn', 'antigravity', m)
          );
          await new Promise((r) => setTimeout(r, 4000));
        }
        return true;
      }

      // For general or UI steps when attached to native Chrome windows, focus the relevant tab
      const focusTarget =
        step.targetSurface === 'cloud_shell' || step.targetSurface === 'antigravity'
          ? nativeShellTarget
          : nativeConsoleTarget;
      if (focusTarget) {
        await focusUserChromeTab(focusTarget.windowId, focusTarget.tabIndex);
      }
      await new Promise((r) => setTimeout(r, 1000));
      return true;
    }

    // Playwright Incognito Window Execution Path (fallback if no native Chrome Console tab is selected)
    const page = await this.ensureIncognitoConsoleWindow();

    // 2. Fast-path: If targetSurface is 'cloud_shell' and we have explicit bash/gcloud/agy commands, run them directly in Cloud Shell!
    if (step.targetSurface === 'cloud_shell' && interpolatedCommands.length > 0) {
      for (const cmd of interpolatedCommands) {
        await executeCommandInCloudShell(page, cmd, (msg) =>
          this.addLog('action', 'cloud_shell', msg)
        );
        await this.refreshScreenshots();
      }
      return true;
    }

    // 3. Fast-path: If targetSurface is 'antigravity' and we have explicit prompt blocks in commands, send them to Antigravity!
    if (step.targetSurface === 'antigravity' && interpolatedCommands.length > 0) {
      for (const promptText of interpolatedCommands) {
        await sendPromptToAntigravity(page, promptText, (msg) =>
          this.addLog('action', 'antigravity', msg)
        );
        await page.waitForTimeout(3500);
        await autoAcceptAntigravityPrompts(page, (msg) =>
          this.addLog('action', 'antigravity', msg)
        );
        await this.refreshScreenshots();
      }
      return true;
    }

    // 4. Multi-turn Gemini 3.5 Flash Vision + Set-of-Marks (SoM) loop for Console UI & complex interactions
    const actionHistory: string[] = [];
    const maxSubActions = 6;

    for (let turn = 1; turn <= maxSubActions; turn++) {
      if (this.pauseRequested) return false;

      await dismissGcpConsoleTermsModal(page, (msg) =>
        this.addLog('info', 'incognito_console', msg)
      );
      await autoAcceptAntigravityPrompts(page, (msg) =>
        this.addLog('action', 'antigravity', msg)
      );

      const elements = await inspectInteractiveElements(page);
      await this.refreshScreenshots();

      const override = this.pendingOverrideInstruction;
      this.pendingOverrideInstruction = '';

      const decision = await decideNextStepAction({
        labTitle: this.state.labTitle,
        task,
        step,
        credentials: this.state.credentials,
        currentUrl: page.url(),
        pageTitle: await page.title().catch(() => ''),
        interactiveElements: elements,
        screenshotBase64: this.state.consoleScreenshot,
        actionHistory,
        userOverrideInstruction: override || undefined,
      });

      this.state.lastThought = decision.thought;
      this.addLog(
        'ai',
        'gemini',
        `[Turn ${turn}/${maxSubActions}] ${decision.summary}`,
        decision.thought
      );

      if (decision.action === 'step_complete') {
        return true;
      }

      if (decision.action === 'check_task_progress') {
        if (this.labPage && !this.labPage.isClosed()) {
          const res = await clickCheckMyProgress(
            this.labPage,
            task.number,
            this.state.labCurrentUrl || this.state.labUrl,
            this.getCheckProgressOptions(task)
          );
          this.applyCheckResultToState(task, res);
        }
        return true;
      }

      await this.performAgentDecision(page, decision, elements);
      actionHistory.push(`${decision.action}: ${decision.summary}`);
      await page.waitForTimeout(1800);
      await autoAcceptAntigravityPrompts(page, (msg) =>
        this.addLog('action', 'antigravity', msg)
      );
      await this.refreshScreenshots();
    }

    return true;
  }

  private async performAgentDecision(
    page: Page,
    decision: Awaited<ReturnType<typeof decideNextStepAction>>,
    elements: Awaited<ReturnType<typeof inspectInteractiveElements>>
  ): Promise<void> {
    switch (decision.action) {
      case 'navigate_incognito': {
        if (decision.url) {
          await this.openUrlInIncognito(decision.url);
        }
        break;
      }

      case 'click_mark': {
        if (decision.markId !== undefined) {
          await clickElementByMark(page, decision.markId, elements);
        } else if (decision.targetText) {
          await clickTextAcrossFrames(page, decision.targetText, (m) =>
            this.addLog('action', 'incognito_console', m)
          );
        }
        break;
      }

      case 'fill_mark': {
        const textToFill = transformAgyLaunchCommand(
          interpolateLabVariables(decision.inputText || '', this.state.credentials)
        );
        if (decision.markId !== undefined) {
          await fillElementByMark(page, decision.markId, textToFill, elements);
        } else {
          await page.keyboard.insertText(textToFill);
        }
        if (decision.key) {
          await page.keyboard.press(decision.key);
        }
        break;
      }

      case 'click_text':
      case 'click_antigravity_action': {
        if (decision.targetText) {
          await clickTextAcrossFrames(page, decision.targetText, (m) =>
            this.addLog('action', 'antigravity', m)
          );
        }
        break;
      }

      case 'click_coords': {
        if (decision.x !== undefined && decision.y !== undefined) {
          await page.mouse.click(decision.x, decision.y);
        }
        break;
      }

      case 'type_text': {
        const textToType = transformAgyLaunchCommand(
          interpolateLabVariables(decision.inputText || '', this.state.credentials)
        );
        await page.keyboard.insertText(textToType);
        if (decision.key) {
          await page.keyboard.press(decision.key);
        }
        break;
      }

      case 'press_key': {
        if (decision.key) {
          await page.keyboard.press(decision.key);
        }
        break;
      }

      case 'open_cloud_shell': {
        await openCloudShellInConsole(page, (m) =>
          this.addLog('action', 'cloud_shell', m)
        );
        break;
      }

      case 'run_cloud_shell_cmd': {
        if (decision.inputText) {
          const cmd = transformAgyLaunchCommand(
            interpolateLabVariables(decision.inputText, this.state.credentials)
          );
          await executeCommandInCloudShell(page, cmd, (m) =>
            this.addLog('action', 'cloud_shell', m)
          );
        }
        break;
      }

      case 'send_antigravity_prompt': {
        if (decision.inputText) {
          const prompt = interpolateLabVariables(
            decision.inputText,
            this.state.credentials
          );
          await sendPromptToAntigravity(page, prompt, (m) =>
            this.addLog('action', 'antigravity', m)
          );
        }
        break;
      }

      case 'wait': {
        await page.waitForTimeout(Math.min(decision.waitMs || 3000, 10000));
        break;
      }
    }
  }

  public pauseExecution() {
    this.pauseRequested = true;
    this.setStatus('paused');
    this.addLog('warn', 'system', 'Pause requested — stopping after current action.');
  }

  public skipCurrentStep() {
    for (const task of this.state.tasks) {
      for (const step of task.steps) {
        if (step.id === this.state.activeStepId || step.status === 'running' || step.status === 'failed') {
          step.status = 'skipped';
          this.addLog('info', 'system', `Skipped Step ${task.number}.${step.index}.`);
          this.emitState();
          return;
        }
      }
    }
  }

  public async checkTaskProgressManual(taskNumber: number): Promise<void> {
    if (this.isCourseSession()) {
      await this.executeCourseLoop(true);
      return;
    }
    await this.ensureLabPreviewPage();
    if (!this.labPage || this.labPage.isClosed()) {
      throw new Error('Lab window is not open.');
    }
    const task = this.state.tasks.find((t) => t.number === taskNumber);
    this.addLog('action', 'lab_window', `Checking progress for Task #${taskNumber}...`);
    const res = task
      ? await this.verifyTaskProgress(task)
      : await clickCheckMyProgress(
          this.labPage,
          taskNumber,
          this.state.labCurrentUrl || this.state.labUrl
        );
    this.addLog(
      res.verified ? 'success' : 'warn',
      'lab_window',
      `Task #${taskNumber} Check Result: ${res.message} (${res.stepScore ?? task?.stepScore ?? 0}/${res.stepMaxScore ?? task?.stepMaxScore ?? 0} pts | Total: ${this.state.totalScore ?? 0}/${this.state.maxScore ?? 100})`
    );
    await this.refreshScreenshots();
  }

  public async checkAllTasksProgress(): Promise<void> {
    if (this.isCourseSession()) {
      await this.parseLabInstructions();
      if (this.state.tasks.length > 0 && this.state.tasks.every((t) => t.progressVerified)) {
        this.setStatus('completed');
        this.addLog(
          'success',
          'lab_window',
          `All course activities verified (${this.state.totalScore}/${this.state.maxScore})!`
        );
      }
      return;
    }
    await this.ensureLabPreviewPage();
    if (!this.labPage || this.labPage.isClosed()) {
      throw new Error('Lab window is not open.');
    }
    const gradableTasks = this.state.tasks.filter((t) => t.hasCheckProgress);
    if (gradableTasks.length === 0) {
      this.addLog('info', 'lab_window', 'No graded progress checks found in this lab.');
      return;
    }
    this.addLog(
      'action',
      'lab_window',
      `Running "Check my progress" across ${gradableTasks.length} graded task(s)...`
    );
    for (const task of gradableTasks) {
      const res = await this.verifyTaskProgress(task);
      this.addLog(
        res.verified ? 'success' : 'warn',
        'lab_window',
        `Task #${task.number} (${task.title}): ${res.message} (${res.stepScore ?? task.stepScore ?? 0}/${res.stepMaxScore ?? task.stepMaxScore ?? 0} pts)`
      );
    }
    if (
      gradableTasks.every((t) => t.progressVerified) ||
      (this.state.maxScore > 0 && this.state.totalScore >= this.state.maxScore)
    ) {
      this.setStatus('completed');
      this.addLog(
        'success',
        'lab_window',
        `All progress checks verified! Final Score: ${this.state.totalScore}/${this.state.maxScore}.`
      );
    }
    await this.refreshScreenshots();
  }

  public async directAntigravityPrompt(promptText: string): Promise<void> {
    const interpolated = interpolateLabVariables(promptText, this.state.credentials);
    const nativeShellTarget = parseTabKey(
      this.state.selectedCloudShellTabKey || this.state.selectedConsoleTabKey
    );

    if (nativeShellTarget) {
      const autonomousPrompt = formatAutonomousAntigravityPrompt(interpolated);
      this.addLog(
        'action',
        'antigravity',
        `Sending zero-touch prompt to selected Chrome tab (${nativeShellTarget.windowId}:${nativeShellTarget.tabIndex})...`
      );
      await sendTextToUserChromeTab(
        nativeShellTarget.windowId,
        nativeShellTarget.tabIndex,
        autonomousPrompt,
        true,
        (m) => this.addLog('warn', 'antigravity', m)
      );
      return;
    }

    const page = await this.ensureIncognitoConsoleWindow();
    await sendPromptToAntigravity(page, interpolated, (msg) =>
      this.addLog('action', 'antigravity', msg)
    );
    await this.refreshScreenshots();
  }

  public async directCloudShellCommand(command: string): Promise<void> {
    const interpolated = transformAgyLaunchCommand(
      interpolateLabVariables(command, this.state.credentials)
    );
    if (this.state.credentials.username && this.state.credentials.password) {
      this.addLog(
        'action',
        'cloud_shell',
        `Running command in student Cloud Shell via SSH: ${interpolated}`
      );
      const sshRes = await execInStudentCloudShellBridge({
        command: interpolated,
        username: this.state.credentials.username,
        password: this.state.credentials.password,
        projectId: this.state.credentials.projectId,
        onProgress: (m) => this.addLog('info', 'cloud_shell', m),
      });
      if (sshRes.ok) {
        if (sshRes.stdout) {
          this.addLog('info', 'cloud_shell', sshRes.stdout.slice(-400));
        }
        return;
      }
    }

    const nativeShellTarget = parseTabKey(
      this.state.selectedCloudShellTabKey || this.state.selectedConsoleTabKey
    );

    if (nativeShellTarget) {
      this.addLog(
        'action',
        'cloud_shell',
        `Running command in selected Chrome Cloud Shell tab: ${interpolated}`
      );
      await sendTextToUserChromeTab(
        nativeShellTarget.windowId,
        nativeShellTarget.tabIndex,
        interpolated,
        true,
        (m) => this.addLog('warn', 'cloud_shell', m)
      );
      return;
    }

    const page = await this.ensureIncognitoConsoleWindow();
    await executeCommandInCloudShell(page, interpolated, (msg) =>
      this.addLog('action', 'cloud_shell', msg)
    );
    await this.refreshScreenshots();
  }
}

const sessionOrchestrators = new Map<string, LabBrowserOrchestrator>();

function wrapOrchestratorInSessionContext(
  instance: LabBrowserOrchestrator
): LabBrowserOrchestrator {
  return new Proxy(instance, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === 'function') {
        return (...args: any[]) => target.runInContext(() => val.apply(target, args));
      }
      return val;
    },
  });
}

export function sanitizeSessionId(raw?: string | null): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64);
  return cleaned || 'default';
}

export function getSessionOrchestrator(rawSessionId?: string | null): LabBrowserOrchestrator {
  const sessionId = sanitizeSessionId(rawSessionId);
  let orch = sessionOrchestrators.get(sessionId);
  if (!orch) {
    const rawInstance = new LabBrowserOrchestrator(sessionId);
    orch = wrapOrchestratorInSessionContext(rawInstance);
    sessionOrchestrators.set(sessionId, orch);
  } else {
    tryClaimUnclaimedBridge(sessionId, orch.getBridgeHub());
  }
  return orch;
}

export function getSessionBridgeHub(rawSessionId?: string | null): MacBridgeHub {
  return getSessionOrchestrator(rawSessionId).getBridgeHub();
}

export function listActiveSessions(): Array<{
  sessionId: string;
  status: RunnerStatus;
  labTitle: string;
  macBridgeConnected: boolean;
}> {
  const out: Array<{
    sessionId: string;
    status: RunnerStatus;
    labTitle: string;
    macBridgeConnected: boolean;
  }> = [];
  for (const [sessionId, orch] of sessionOrchestrators.entries()) {
    const st = orch.getState();
    out.push({
      sessionId,
      status: st.status,
      labTitle: st.labTitle,
      macBridgeConnected: Boolean(st.macBridgeConnected),
    });
  }
  return out;
}

export const orchestrator = getSessionOrchestrator('default');
