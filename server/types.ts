export interface LabCredentials {
  username: string;
  password: string;
  projectId: string;
  consoleUrl: string;
  region: string;
  zone: string;
  extraVars: Record<string, string>;
}

export interface LabLink {
  text: string;
  href: string;
}

export type TargetSurface =
  | 'console_ui'
  | 'cloud_shell'
  | 'antigravity'
  | 'browser_link'
  | 'general';

export type ItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface LabStep {
  id: string;
  index: number;
  instruction: string;
  commands: string[];
  links: LabLink[];
  targetSurface: TargetSurface;
  status: ItemStatus;
  notes?: string;
}

export interface LabTask {
  id: string;
  number: number;
  title: string;
  description: string;
  steps: LabStep[];
  hasCheckProgress: boolean;
  checkProgressIndex?: number;
  checkProgressStepNumber?: number;
  labInstanceId?: string;
  stepScore?: number;
  stepMaxScore?: number;
  rawSectionText?: string;
  progressVerified: boolean;
  progressMessage?: string;
  status: ItemStatus;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'action' | 'success' | 'warn' | 'error' | 'ai';
  surface:
    | 'system'
    | 'lab_window'
    | 'incognito_console'
    | 'antigravity'
    | 'cloud_shell'
    | 'gemini';
  message: string;
  detail?: string;
}

export interface InteractiveElement {
  markId: number;
  tag: string;
  role: string;
  text: string;
  ariaLabel: string;
  placeholder: string;
  href: string;
  inputType?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  inShadowDom: boolean;
  frameUrl?: string;
}

export interface AgentDecision {
  thought: string;
  surface: 'console_ui' | 'cloud_shell' | 'antigravity' | 'lab_page';
  action:
    | 'click_mark'
    | 'click_coords'
    | 'click_text'
    | 'fill_mark'
    | 'type_text'
    | 'press_key'
    | 'navigate_incognito'
    | 'open_cloud_shell'
    | 'run_cloud_shell_cmd'
    | 'send_antigravity_prompt'
    | 'click_antigravity_action'
    | 'wait'
    | 'step_complete'
    | 'check_task_progress';
  markId?: number;
  x?: number;
  y?: number;
  targetText?: string;
  inputText?: string;
  key?: string;
  url?: string;
  waitMs?: number;
  summary: string;
}

export type RunnerStatus =
  | 'idle'
  | 'launching_lab'
  | 'awaiting_login'
  | 'ready_to_parse'
  | 'lab_parsed'
  | 'starting_lab'
  | 'signing_in_console'
  | 'running_autonomous'
  | 'running_step'
  | 'paused'
  | 'completed'
  | 'error';

export type ExecutionMode = 'autonomous' | 'step_by_step';

export interface ChromeTabDescriptor {
  key: string; // `${windowId}:${tabIndex}`
  windowId: number;
  windowIndex: number;
  windowMode: 'normal' | 'incognito';
  tabIndex: number;
  title: string;
  url: string;
  isActiveTab: boolean;
  suggestedRole: 'lab' | 'console' | 'cloud_shell' | 'other';
}

export interface RunnerState {
  status: RunnerStatus;
  executionMode: ExecutionMode;
  labUrl: string;
  labTitle: string;
  labTimer: string;
  isLabStarted: boolean;
  isConsoleSignedIn: boolean;
  credentials: LabCredentials;
  tasks: LabTask[];
  activeTaskId: string | null;
  activeStepId: string | null;
  labScreenshot: string | null;
  consoleScreenshot: string | null;
  labCurrentUrl: string;
  consoleCurrentUrl: string;
  logs: LogEntry[];
  lastThought: string;
  availableChromeTabs?: ChromeTabDescriptor[];
  selectedLabTabKey?: string | null;
  selectedConsoleTabKey?: string | null;
  selectedCloudShellTabKey?: string | null;
  activeModel?: string;
  macBridgeConnected?: boolean;
  labInstanceId?: string;
  totalScore?: number;
  maxScore?: number;
}

