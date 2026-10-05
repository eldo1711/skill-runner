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
} from './types.js';
import {
  clickCheckMyProgress,
  parseLabPageDom,
  triggerStartLabAndExtractCredentials,
} from './labParser.js';
import {
  clickEndLabInUserChrome,
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
  formatAutonomousAntigravityPrompt,
  getActiveGeminiModel,
  getModelGardenEntries,
  interpolateLabVariables,
  refineParsedTasksWithGemini,
  resolveLatestGeminiModel,
  setActiveGeminiModel,
  synthesizeTaskShellScript,
  transformAgyLaunchCommand,
} from './geminiClient.js';
import { macBridgeHub } from './macBridgeHub.js';

const LOCAL_STATE_DIR = path.join(os.homedir(), '.cloud-skills-lab-runner');
const LOCAL_STATE_FILE = path.join(LOCAL_STATE_DIR, 'runner_state.json');

export class LabBrowserOrchestrator {
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

  constructor() {
    this.state = {
      status: 'idle',
      executionMode: 'autonomous',
      labUrl: '',
      labTitle: '',
      labTimer: '00:00:00',
      isLabStarted: false,
      isConsoleSignedIn: false,
      labInstanceId: '',
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
      activeModel: getActiveGeminiModel(),
      modelGarden: getModelGardenEntries(),
      macBridgeConnected: macBridgeHub.isConnected(),
    };

    // Restore persisted state from disk on startup if available
    this.restoreSavedState().catch(() => {});

    macBridgeHub.onConnectionChange((connected) => {
      this.state.macBridgeConnected = connected;
      if (connected) {
        this.addLog(
          'success',
          'system',
          'Live Mac Chrome Bridge connected (Passive Mode) — open Chrome tabs synced.'
        );
        this.restoreSavedState()
          .catch(() => {})
          .finally(() => {
            this.scanOpenChromeWindows(false).catch(() => {});
          });
      } else {
        this.state.availableChromeTabs = [];
        this.addLog('info', 'system', 'Mac Chrome Bridge disconnected.');
        this.emitState();
      }
    });

    macBridgeHub.onTabsPush((tabs) => {
      if (Array.isArray(tabs)) {
        this.applyScannedTabs(tabs);
        this.emitState();
      }
    });

    // Resolve the latest available model and probe Model Garden on startup
    resolveLatestGeminiModel()
      .then((model) => {
        this.state.activeModel = model;
        this.emitState();
      })
      .catch(() => {});
    this.checkModels().catch(() => {});
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

  private isUserChromeBridgeAvailable(): boolean {
    return macBridgeHub.isConnected();
  }

  private getSerializableState(): Partial<RunnerState> {
    return {
      status: this.state.status === 'running_autonomous' ? 'paused' : this.state.status,
      executionMode: this.state.executionMode,
      labUrl: this.state.labUrl,
      labTitle: this.state.labTitle,
      labTimer: this.state.labTimer,
      isLabStarted: this.state.isLabStarted,
      isConsoleSignedIn: this.state.isConsoleSignedIn,
      labInstanceId: this.state.labInstanceId,
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
      this.saveStateManual(true).catch(() => {});
    }, 1200);
  }

  public async saveStateManual(silent = false): Promise<{
    ok: boolean;
    savedAt: string;
    path: string;
  }> {
    const savedAt = new Date().toISOString();
    const serializable = this.getSerializableState();
    let targetPath = LOCAL_STATE_FILE;

    try {
      fs.mkdirSync(LOCAL_STATE_DIR, { recursive: true });
      fs.writeFileSync(
        LOCAL_STATE_FILE,
        JSON.stringify({ savedAt, state: serializable }, null, 2),
        'utf8'
      );
    } catch {
      // Ignore local write error in read-only environments
    }

    if (macBridgeHub.isConnected()) {
      try {
        const res = await macBridgeHub.invoke<any>(
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
    if (macBridgeHub.isConnected()) {
      try {
        loadedPayload = await macBridgeHub.invoke<any>('load_state', {}, 8000);
      } catch {
        // Fall through to local file
      }
    }

    if (!loadedPayload && fs.existsSync(LOCAL_STATE_FILE)) {
      try {
        loadedPayload = JSON.parse(fs.readFileSync(LOCAL_STATE_FILE, 'utf8'));
      } catch {
        // Ignore corrupt state file
      }
    }

    const saved = loadedPayload?.state;
    if (!saved || (!saved.labUrl && (!Array.isArray(saved.tasks) || saved.tasks.length === 0))) {
      return false;
    }

    const connected = macBridgeHub.isConnected();
    this.state = {
      ...this.state,
      ...saved,
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

  private applyScannedTabs(tabs: ChromeTabDescriptor[]) {
    const connected = macBridgeHub.isConnected();
    this.state.macBridgeConnected = connected;
    if (!connected) {
      this.state.availableChromeTabs = [];
      return;
    }
    this.state.availableChromeTabs = tabs;

    const findByKey = (k?: string | null) => tabs.find((t) => t.key === k);

    const currentLabTab = findByKey(this.state.selectedLabTabKey);
    if (!currentLabTab || currentLabTab.suggestedRole !== 'lab') {
      const labTab = tabs.find((t) => t.suggestedRole === 'lab');
      if (labTab) {
        this.state.selectedLabTabKey = labTab.key;
        this.state.labUrl = labTab.url;
        this.state.labCurrentUrl = labTab.url;
      }
    }

    const currentConsoleTab = findByKey(this.state.selectedConsoleTabKey);
    if (!currentConsoleTab) {
      const consoleTab =
        tabs.find((t) => t.suggestedRole === 'console' && t.windowMode === 'incognito') ||
        tabs.find((t) => t.suggestedRole === 'console');
      if (consoleTab) {
        this.state.selectedConsoleTabKey = consoleTab.key;
      }
    }

    const currentShellTab = findByKey(this.state.selectedCloudShellTabKey);
    if (!currentShellTab) {
      const shellTab =
        tabs.find((t) => t.suggestedRole === 'cloud_shell' && t.windowMode === 'incognito') ||
        tabs.find((t) => t.suggestedRole === 'cloud_shell') ||
        findByKey(this.state.selectedConsoleTabKey);
      if (shellTab) {
        this.state.selectedCloudShellTabKey = shellTab.key;
      }
    }

    this.syncMetadataFromSelectedTabs();
  }

  /**
   * Scans all open windows and tabs in the user's Google Chrome (`Google Chrome.app`),
   * auto-selecting the best Lab, Cloud Console, and Cloud Shell tabs if not yet chosen.
   * Never triggers `save tab` automatically so in-progress navigations or SSO logins are never interrupted.
   */
  public async scanOpenChromeWindows(_autoBindOnStartup = false): Promise<ChromeTabDescriptor[]> {
    if (!macBridgeHub.isConnected()) {
      this.state.macBridgeConnected = false;
      this.state.availableChromeTabs = [];
      this.emitState();
      return [];
    }
    const tabs = await listUserChromeTabs();
    this.applyScannedTabs(tabs);
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

    if (labTab) {
      this.state.labUrl = labTab.url;
      this.state.labCurrentUrl = labTab.url;
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
    this.state.labUrl = labUrl.trim();
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

    if (parsed.needsLogin) {
      this.setStatus('awaiting_login');
      this.addLog(
        'warn',
        'lab_window',
        'Please complete your initial login in your Google Chrome window, then click "Re-Parse DOM".'
      );
    } else {
      this.setStatus('ready_to_parse');
      this.addLog(
        'success',
        'lab_window',
        `Loaded authenticated lab: "${parsed.labTitle}" (Started: ${parsed.isLabStarted ? 'Yes' : 'No'}). Parsing instructions and tasks...`
      );
      await this.parseLabInstructions();
    }
  }

  /**
   * Step 2: Syncs the latest DOM from the user's Google Chrome lab tab, parses instructions, tasks,
   * code blocks, active links, and student credentials, then refines the plan with Gemini 3.5 Flash.
   */
  public async parseLabInstructions(): Promise<void> {
    await this.syncLabPageFromUserChrome();
    if (!this.labPage || this.labPage.isClosed()) {
      throw new Error('Lab window is not open. Launch a Lab URL first.');
    }

    this.addLog('info', 'lab_window', 'Scanning Lab DOM (piercing Shadow DOM components)...');
    const parsed = await parseLabPageDom(this.labPage);

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
      (t) => t.hasCheckProgress && t.checkProgressStepNumber
    );
    if (this.state.isLabStarted && firstGradableTask && this.labPage && !this.labPage.isClosed()) {
      try {
        const initialCheck = await clickCheckMyProgress(
          this.labPage,
          firstGradableTask.number,
          this.state.labCurrentUrl || this.state.labUrl,
          this.getCheckProgressOptions(firstGradableTask)
        );
        this.applyCheckResultToState(firstGradableTask, initialCheck);
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

  private getCheckProgressOptions(task: LabTask) {
    const labTarget = parseTabKey(this.state.selectedLabTabKey);
    return {
      checkProgressStepNumber: task.checkProgressStepNumber || task.number,
      labInstanceId: task.labInstanceId || this.state.labInstanceId,
      windowId: labTarget?.windowId,
      tabIndex: labTarget?.tabIndex,
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
        if (!t.hasCheckProgress || !t.checkProgressStepNumber) continue;
        const stepIdx = t.checkProgressStepNumber - 1;
        if (stepIdx >= 0 && stepIdx < res.stepCompleteList.length) {
          const isDone = Boolean(res.stepCompleteList[stepIdx]);
          if (Array.isArray(res.stepScoresList) && res.stepScoresList[stepIdx] !== undefined) {
            t.stepScore = Number(res.stepScoresList[stepIdx]);
          }
          if (Array.isArray(res.stepPointsList) && res.stepPointsList[stepIdx] !== undefined) {
            t.stepMaxScore = Number(res.stepPointsList[stepIdx]);
          }
          if (
            Array.isArray(res.studentMessagesList) &&
            res.studentMessagesList[stepIdx]
          ) {
            t.progressMessage = String(res.studentMessagesList[stepIdx]);
          }
          if (isDone) {
            t.progressVerified = true;
            t.status = 'completed';
            for (const s of t.steps) s.status = 'completed';
            if (!t.progressMessage) {
              t.progressMessage = 'Assessment Completed!';
            }
          }
        }
      }
      // Also mark non-Check-Progress setup tasks as completed if a subsequent graded task is completed
      for (let i = 0; i < this.state.tasks.length; i++) {
        const curr = this.state.tasks[i];
        if (!curr.hasCheckProgress) {
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

  /**
   * Step 3: Starts the lab (if not already started), extracts temporary student credentials,
   * and spawns (or attaches to) the student Incognito Console & Cloud Shell window on the user's Mac.
   */
  public async startLabAndLaunchIncognito(): Promise<void> {
    await this.ensureLabPreviewPage();

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
   * 1. Points at the user's self-signed-in Lab Instructions tab (or opens the provided Lab URL in Chrome).
   * 2. Starts the lab (if not yet started) and extracts temporary student credentials.
   * 3. Spawns the Incognito window on the user's Mac signed in as the lab student account (Console + Cloud Shell).
   * 4. Runs all tasks autonomously and completes every "Check my progress" assessment check.
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

    if (requestedTabKey) {
      if (
        requestedTabKey !== this.state.selectedLabTabKey ||
        this.state.tasks.length === 0
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

    await this.startLabAndLaunchIncognito();
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
   * Stops any active execution loop, clicks "End Lab" + confirms termination in the user's Chrome Lab tab,
   * and clears expired student credentials.
   */
  public async endCurrentLab(): Promise<{ ended: boolean; message: string }> {
    this.pauseRequested = true;
    this.isLoopRunning = false;

    this.addLog('action', 'lab_window', 'Ending active lab session in Google Chrome...');
    const res = await clickEndLabInUserChrome(
      this.state.labCurrentUrl || this.state.labUrl,
      parseTabKey(this.state.selectedLabTabKey)
    );

    this.state.isLabStarted = false;
    this.state.isConsoleSignedIn = false;
    this.state.labTimer = '00:00:00';
    this.state.labInstanceId = '';
    this.state.credentials = {
      username: '',
      password: '',
      projectId: '',
      consoleUrl: '',
      region: '',
      zone: '',
      extraVars: {},
    };
    this.setStatus('idle');

    if (res.ended) {
      this.addLog('success', 'lab_window', res.message);
    } else {
      this.addLog('warn', 'lab_window', res.message);
    }

    try {
      await this.syncLabPageFromUserChrome();
      await this.refreshScreenshots();
    } catch {
      // Ignore snapshot refresh errors after ending
    }
    this.emitState();
    return res;
  }

  /**
   * Ends the current lab (if requested), resets all lab state/credentials/tasks cleanly,
   * switches to a different Skill Course / Lab URL or open Chrome tab, and optionally starts autonomous execution.
   */
  public async switchSkillCourse(params: {
    url?: string;
    labTabKey?: string | null;
    endCurrentFirst?: boolean;
    autoRun?: boolean;
  }): Promise<void> {
    this.pauseRequested = true;
    this.isLoopRunning = false;

    if (params.endCurrentFirst && this.state.isLabStarted) {
      await this.endCurrentLab();
    }

    this.state.isLabStarted = false;
    this.state.isConsoleSignedIn = false;
    this.state.labTitle = '';
    this.state.labTimer = '00:00:00';
    this.state.labInstanceId = '';
    this.state.totalScore = 0;
    this.state.maxScore = 0;
    this.state.tasks = [];
    this.state.activeTaskId = null;
    this.state.activeStepId = null;
    this.state.selectedConsoleTabKey = null;
    this.state.selectedCloudShellTabKey = null;
    this.state.credentials = {
      username: '',
      password: '',
      projectId: '',
      consoleUrl: '',
      region: '',
      zone: '',
      extraVars: {},
    };
    this.setStatus('idle');
    this.emitState();

    if (params.labTabKey) {
      this.addLog(
        'info',
        'lab_window',
        `Switching to selected Chrome Lab tab (${params.labTabKey})...`
      );
      await this.bindChromeTargets({
        labTabKey: params.labTabKey,
        consoleTabKey: null,
        cloudShellTabKey: null,
      });
    } else if (params.url && params.url.trim()) {
      const cleanUrl = params.url.trim();
      this.addLog('info', 'lab_window', `Opening new Skill Course / Lab URL: ${cleanUrl}...`);
      await this.openLabUrl(cleanUrl);
    } else {
      await this.scanOpenChromeWindows(false);
      this.addLog(
        'info',
        'system',
        'Cleared previous lab session. Select an open Chrome tab or paste a new Skill Course URL to begin.'
      );
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
    const nativeConsoleTarget = parseTabKey(
      this.state.selectedConsoleTabKey || this.state.selectedCloudShellTabKey
    );

    if (nativeConsoleTarget) {
      this.addLog(
        'action',
        'incognito_console',
        `Opening URL in your selected Chrome Console window: ${interpolatedUrl}`
      );
      await navigateOrOpenInUserChromeWindow(
        nativeConsoleTarget.windowId,
        nativeConsoleTarget.tabIndex,
        interpolatedUrl,
        false
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
   * Starts or resumes the Lab Execution Loop (either Autonomous or Single-Step).
   */
  public async startExecutionLoop(singleStepOnly = false): Promise<void> {
    if (this.isLoopRunning) {
      this.pauseRequested = false;
      this.setStatus(singleStepOnly ? 'running_step' : 'running_autonomous');
      return;
    }

    if (this.state.tasks.length === 0 || !this.state.isLabStarted || !this.state.credentials.password) {
      await this.parseLabInstructions();
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
        const isInformationalOverview =
          !task.hasCheckProgress &&
          !hasAnyCommand &&
          /\b(overview|introduction|scenario|objectives?)\b/i.test(task.title);
        if (isInformationalOverview) {
          task.status = 'completed';
          for (const s of task.steps) s.status = 'completed';
          this.addLog('info', 'system', `Skipped informational section: ${task.title}`);
          this.emitState();
          continue;
        }

        // Pre-task live score & completion check: if this task is already verified on Qwiklabs, mark it completed and advance immediately
        if (task.hasCheckProgress && this.state.isLabStarted) {
          try {
            await this.ensureLabPreviewPage();
            const preCheck = await clickCheckMyProgress(
              this.labPage!,
              task.number,
              this.state.labCurrentUrl || this.state.labUrl,
              this.getCheckProgressOptions(task)
            );
            this.applyCheckResultToState(task, preCheck);
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

          // Open any explicit browser_link or console URLs referenced in the task
          for (const step of task.steps) {
            for (const link of step.links) {
              if (
                link.href.includes('console.cloud.google.com') ||
                step.targetSurface === 'browser_link'
              ) {
                await this.openUrlInIncognito(link.href);
              }
            }
          }

          const maxAttempts = task.hasCheckProgress ? 4 : 2;
          let previousErrorMessage: string | undefined;
          let previousScriptOutput: string | undefined;

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (this.pauseRequested) {
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

            const synth = await synthesizeTaskShellScript({
              labTitle: this.state.labTitle,
              task,
              credentials: this.state.credentials,
              allTasksSummary,
              workspaceSnapshot,
              previousErrorMessage,
              previousScriptOutput,
            });

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
                timeoutMs: 420000,
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

            if (task.hasCheckProgress) {
              await this.ensureLabPreviewPage();
              this.addLog(
                'action',
                'lab_window',
                `[Task #${task.number} | Attempt ${attempt}/${maxAttempts}] Verifying via "Check my progress"...`
              );
              const checkRes = await clickCheckMyProgress(
                this.labPage!,
                task.number,
                this.state.labCurrentUrl || this.state.labUrl,
                this.getCheckProgressOptions(task)
              );
              this.applyCheckResultToState(task, checkRes);
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
                  (t) => t.hasCheckProgress && t.checkProgressStepNumber
                );
                if (firstGradable && this.state.isLabStarted) {
                  try {
                    await this.ensureLabPreviewPage();
                    const pollRes = await clickCheckMyProgress(
                      this.labPage!,
                      firstGradable.number,
                      this.state.labCurrentUrl || this.state.labUrl,
                      this.getCheckProgressOptions(firstGradable)
                    );
                    this.applyCheckResultToState(firstGradable, pollRes);
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
          await this.ensureLabPreviewPage();
          this.addLog(
            'action',
            'lab_window',
            `Verifying Task #${task.number} via "Check my progress" in Lab window...`
          );
          const checkRes = await clickCheckMyProgress(
            this.labPage!,
            task.number,
            this.state.labCurrentUrl || this.state.labUrl,
            this.getCheckProgressOptions(task)
          );
          this.applyCheckResultToState(task, checkRes);
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
    await this.ensureLabPreviewPage();
    if (!this.labPage || this.labPage.isClosed()) {
      throw new Error('Lab window is not open.');
    }
    const task = this.state.tasks.find((t) => t.number === taskNumber);
    this.addLog('action', 'lab_window', `Checking progress for Task #${taskNumber}...`);
    const res = await clickCheckMyProgress(
      this.labPage,
      taskNumber,
      this.state.labCurrentUrl || this.state.labUrl,
      task ? this.getCheckProgressOptions(task) : undefined
    );
    if (task) {
      this.applyCheckResultToState(task, res);
    }
    this.addLog(
      res.verified ? 'success' : 'warn',
      'lab_window',
      `Task #${taskNumber} Check Result: ${res.message} (${res.stepScore ?? task?.stepScore ?? 0}/${res.stepMaxScore ?? task?.stepMaxScore ?? 0} pts | Total: ${this.state.totalScore ?? 0}/${this.state.maxScore ?? 100})`
    );
    await this.refreshScreenshots();
  }

  public async checkAllTasksProgress(): Promise<void> {
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
      const res = await clickCheckMyProgress(
        this.labPage,
        task.number,
        this.state.labCurrentUrl || this.state.labUrl,
        this.getCheckProgressOptions(task)
      );
      this.applyCheckResultToState(task, res);
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

export const orchestrator = new LabBrowserOrchestrator();

