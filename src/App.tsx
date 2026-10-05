import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  SkipForward,
  Sparkles,
  Terminal,
  ExternalLink,
  CheckCircle2,
  Clock,
  KeyRound,
  ShieldAlert,
  FileSearch,
  Bot,
  Copy,
  Check,
  RefreshCw,
  Layers,
  Send,
  Monitor,
  ChevronDown,
  ChevronRight,
  Compass,
  Zap,
  Download,
  Power,
  X,
} from 'lucide-react';
import { ExecutionMode, LabCredentials, RunnerState, TargetSurface } from './types';

const INITIAL_STATE: RunnerState = {
  status: 'idle',
  executionMode: 'autonomous',
  labUrl: '',
  labTitle: '',
  labTimer: '00:00:00',
  isLabStarted: false,
  isConsoleSignedIn: false,
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
  activeModel: 'gemini-3.8-flash',
  macBridgeConnected: false,
};

export default function App() {
  const [state, setState] = useState<RunnerState>(INITIAL_STATE);
  const [urlInput, setUrlInput] = useState<string>(
    'https://partner.skills.google/focuses/130021?parent=catalog'
  );
  const [overrideInput, setOverrideInput] = useState<string>('');
  const [antigravityInput, setAntigravityInput] = useState<string>('');
  const [shellInput, setShellInput] = useState<string>('');
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [expandedTasks, setExpandedTasks] = useState<Record<string, boolean>>({});
  const [viewportTab, setViewportTab] = useState<'split' | 'console' | 'lab'>('split');
  const [editingCreds, setEditingCreds] = useState<boolean>(false);
  const [credDraft, setCredDraft] = useState<LabCredentials>(INITIAL_STATE.credentials);
  const [scanningWindows, setScanningWindows] = useState<boolean>(false);
  const [syncingLab, setSyncingLab] = useState<boolean>(false);
  const [endingLab, setEndingLab] = useState<boolean>(false);
  const [showSwitchCourseModal, setShowSwitchCourseModal] = useState<boolean>(false);
  const [switchingCourse, setSwitchingCourse] = useState<boolean>(false);
  const [newCourseUrl, setNewCourseUrl] = useState<string>('');
  const [newCourseTabKey, setNewCourseTabKey] = useState<string>('');
  const [endCurrentBeforeSwitch, setEndCurrentBeforeSwitch] = useState<boolean>(true);
  const [showBridgeModal, setShowBridgeModal] = useState<boolean>(false);
  const [pendingActionLabel, setPendingActionLabel] = useState<string | null>(null);
  const pendingActionRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    // Initial fetch
    fetch('/api/state')
      .then((r) => r.json())
      .then((data: RunnerState) => {
        setState(data);
        if (data.labUrl) setUrlInput(data.labUrl);
      })
      .catch(() => {});

    // Connect WebSocket for live telemetry
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let reconnectTimer: any = null;

    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'state' && payload.data) {
            setState(payload.data);
          }
        } catch {
          // Ignore malformed frame
        }
      };
      ws.onclose = () => {
        reconnectTimer = setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, []);

  // Poll bridge status while the setup modal is open and auto-run any pending action once connected
  useEffect(() => {
    if (!showBridgeModal) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/bridge/status');
        const data = await res.json();
        if (data?.connected) {
          setState((prev) => ({ ...prev, macBridgeConnected: true }));
        }
      } catch {
        // Ignore
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [showBridgeModal]);

  useEffect(() => {
    if (state.macBridgeConnected && showBridgeModal) {
      setShowBridgeModal(false);
      const action = pendingActionRef.current;
      pendingActionRef.current = null;
      setPendingActionLabel(null);
      if (action) {
        action().catch(() => {});
      }
    }
  }, [state.macBridgeConnected, showBridgeModal]);

  useEffect(() => {
    if (!editingCreds) {
      setCredDraft(state.credentials);
    }
  }, [state.credentials, editingCreds]);

  // Auto-expand active task
  useEffect(() => {
    if (state.activeTaskId) {
      setExpandedTasks((prev) => ({ ...prev, [state.activeTaskId!]: true }));
    } else if (state.tasks.length > 0 && Object.keys(expandedTasks).length === 0) {
      const initial: Record<string, boolean> = {};
      state.tasks.forEach((t) => {
        initial[t.id] = true;
      });
      setExpandedTasks(initial);
    }
  }, [state.activeTaskId, state.tasks.length]);

  const apiPost = async (path: string, body?: Record<string, any>) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    try {
      const data = await res.json();
      if (data?.state) {
        setState(data.state);
        if (data.state.labUrl) {
          setUrlInput(data.state.labUrl);
        }
      }
    } catch {
      // Ignore non-JSON responses
    }
  };

  /**
   * Verifies that `macBridgeAgent.ts` is connected before executing an action that interacts with desktop Chrome.
   * If not running, opens the Download & Launch modal and queues the action to run automatically once connected.
   */
  const ensureMacBridgeConnected = async (
    actionLabel: string,
    action: () => Promise<void>
  ) => {
    if (state.macBridgeConnected) {
      await action();
      return;
    }
    try {
      const res = await fetch('/api/bridge/status');
      const data = await res.json();
      if (data?.connected) {
        setState((prev) => ({ ...prev, macBridgeConnected: true }));
        await action();
        return;
      }
    } catch {
      // Fall through to modal
    }
    pendingActionRef.current = action;
    setPendingActionLabel(actionLabel);
    setShowBridgeModal(true);
  };

  const handleStopMacBridge = async () => {
    await apiPost('/api/bridge/stop');
  };

  const handleScanChromeWindows = async () => {
    await ensureMacBridgeConnected('Scan Open Chrome Windows', async () => {
      setScanningWindows(true);
      try {
        await apiPost('/api/chrome/scan');
      } finally {
        setScanningWindows(false);
      }
    });
  };

  const handleBindChromeTargets = async (partial?: {
    labTabKey?: string | null;
    consoleTabKey?: string | null;
    cloudShellTabKey?: string | null;
  }) => {
    await ensureMacBridgeConnected('Bind Selected Windows & Sync Lab', async () => {
      setSyncingLab(true);
      try {
        await apiPost('/api/chrome/bind', {
          labTabKey:
            partial?.labTabKey !== undefined ? partial.labTabKey : state.selectedLabTabKey,
          consoleTabKey:
            partial?.consoleTabKey !== undefined
              ? partial.consoleTabKey
              : state.selectedConsoleTabKey,
          cloudShellTabKey:
            partial?.cloudShellTabKey !== undefined
              ? partial.cloudShellTabKey
              : state.selectedCloudShellTabKey,
        });
      } finally {
        setSyncingLab(false);
      }
    });
  };

  const handleFocusChromeTarget = async (key: string | null) => {
    if (!key) return;
    await ensureMacBridgeConnected('Focus Chrome Window', async () => {
      await apiPost('/api/chrome/focus', { key });
    });
  };

  const handleOpenLab = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim()) return;
    const targetUrl = urlInput.trim();
    await ensureMacBridgeConnected('Open Lab URL in Chrome', async () => {
      setSyncingLab(true);
      try {
        await apiPost('/api/lab/open', { url: targetUrl });
      } finally {
        setSyncingLab(false);
      }
    });
  };

  const handleParseLab = async () => {
    await ensureMacBridgeConnected('Re-Parse Selected Lab', async () => {
      setSyncingLab(true);
      try {
        await apiPost('/api/lab/parse');
      } finally {
        setSyncingLab(false);
      }
    });
  };

  const handleStartAndSignIn = async () => {
    await ensureMacBridgeConnected('Start Lab & Sign Into Incognito', async () => {
      await apiPost('/api/lab/start-and-signin');
    });
  };

  const handleRunAutonomous = async () => {
    await ensureMacBridgeConnected('Run Lab Autonomously', async () => {
      await apiPost('/api/lab/mode', { mode: 'autonomous' });
      await apiPost('/api/lab/run', { singleStep: false });
    });
  };

  const handleRunSingleStep = async () => {
    await ensureMacBridgeConnected('Execute Next Lab Step', async () => {
      await apiPost('/api/lab/run', { singleStep: true });
    });
  };

  const handlePause = async () => {
    await apiPost('/api/lab/pause');
  };

  const handleSkipStep = async () => {
    await apiPost('/api/lab/skip-step');
  };

  const handleEndLab = async () => {
    await ensureMacBridgeConnected('End Current Lab', async () => {
      setEndingLab(true);
      try {
        await apiPost('/api/lab/end');
      } finally {
        setEndingLab(false);
      }
    });
  };

  const handleOpenSwitchCourseModal = async () => {
    setEndCurrentBeforeSwitch(Boolean(state.isLabStarted));
    setNewCourseUrl('');
    setNewCourseTabKey('');
    setShowSwitchCourseModal(true);
    if (state.macBridgeConnected) {
      apiPost('/api/chrome/scan').catch(() => {});
    }
  };

  const handleConfirmSwitchCourse = async (autoRun: boolean) => {
    await ensureMacBridgeConnected('Run a Different Skill Course', async () => {
      setSwitchingCourse(true);
      try {
        await apiPost('/api/lab/switch-course', {
          url: newCourseUrl.trim() || undefined,
          labTabKey: newCourseTabKey || undefined,
          endCurrentFirst: endCurrentBeforeSwitch,
          autoRun,
        });
        if (newCourseUrl.trim()) {
          setUrlInput(newCourseUrl.trim());
        }
        setShowSwitchCourseModal(false);
      } finally {
        setSwitchingCourse(false);
      }
    });
  };

  const handleModeChange = async (mode: ExecutionMode) => {
    await apiPost('/api/lab/mode', { mode });
  };

  const handleSendOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!overrideInput.trim()) return;
    await apiPost('/api/lab/override', { instruction: overrideInput.trim() });
    setOverrideInput('');
  };

  const handleSendAntigravityPrompt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!antigravityInput.trim()) return;
    await apiPost('/api/lab/antigravity-prompt', { prompt: antigravityInput.trim() });
    setAntigravityInput('');
  };

  const handleSendShellCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shellInput.trim()) return;
    await apiPost('/api/lab/cloud-shell-cmd', { command: shellInput.trim() });
    setShellInput('');
  };

  const handleSaveCredentials = async () => {
    await apiPost('/api/lab/credentials', credDraft);
    setEditingCreds(false);
  };

  const copyToClipboard = (key: string, val: string) => {
    if (!val) return;
    navigator.clipboard.writeText(val);
    setCopiedField(key);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const renderSurfaceBadge = (surface: TargetSurface) => {
    switch (surface) {
      case 'antigravity':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-purple-500/20 text-purple-300 border border-purple-500/30">
            <Bot className="w-3 h-3" /> Antigravity IDE
          </span>
        );
      case 'cloud_shell':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            <Terminal className="w-3 h-3" /> Cloud Shell
          </span>
        );
      case 'browser_link':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
            <ExternalLink className="w-3 h-3" /> Active Link
          </span>
        );
      case 'console_ui':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-500/20 text-blue-300 border border-blue-500/30">
            <Compass className="w-3 h-3" /> Console UI
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-700/60 text-slate-300 border border-slate-600/50">
            Step
          </span>
        );
    }
  };

  const isRunning =
    state.status === 'running_autonomous' || state.status === 'running_step';

  const completedStepsCount = state.tasks.reduce(
    (acc, t) => acc + t.steps.filter((s) => s.status === 'completed').length,
    0
  );
  const totalStepsCount = state.tasks.reduce((acc, t) => acc + t.steps.length, 0);

  const chromeTabs = state.availableChromeTabs || [];
  const selectedLabTab = chromeTabs.find((t) => t.key === state.selectedLabTabKey);
  const selectedConsoleTab = chromeTabs.find((t) => t.key === state.selectedConsoleTabKey);
  const selectedShellTab = chromeTabs.find((t) => t.key === state.selectedCloudShellTabKey);

  const formatTabLabel = (t: (typeof chromeTabs)[number]) => {
    const modeTag = t.windowMode === 'incognito' ? '🕶️ INCOGNITO' : '👤 NORMAL';
    const roleTag =
      t.suggestedRole === 'lab'
        ? ' [LAB]'
        : t.suggestedRole === 'console'
        ? ' [GCP CONSOLE]'
        : t.suggestedRole === 'cloud_shell'
        ? ' [CLOUD SHELL]'
        : '';
    const shortTitle = t.title.length > 48 ? `${t.title.slice(0, 48)}…` : t.title;
    return `[Win #${t.windowIndex} ${modeTag} • Tab #${t.tabIndex}]${roleTag} ${shortTitle}`;
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Header & Workflow Bar */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-30 px-6 py-3.5">
        <div className="max-w-[1800px] mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-600/20">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-base font-bold tracking-tight text-white">
                  Skills Runner
                </h1>
                <span className="px-2 py-0.5 text-[11px] font-semibold font-mono rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/30">
                  {state.activeModel || 'gemini-3.8-flash'}
                </span>
                <span
                  className="px-2 py-0.5 text-[11px] font-mono rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30"
                  title="All agy launches automatically attempt --dangerously-skip-permissions first and fall back to normal launch if unsupported; all confirmation prompts are auto-accepted."
                >
                  agy --dangerously-skip-permissions || agy (Zero-Touch)
                </span>
                <span className="px-2 py-0.5 text-[11px] font-mono rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                  Status: {state.status.replace(/_/g, ' ').toUpperCase()}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Attach Directly to Your Authenticated Chrome Windows • Window 1: @google.com Lab Session + Window 2: Incognito Lab Account & Zero-Touch Antigravity
              </p>
            </div>
          </div>

          {/* Lab Timer & Progress Summary */}
          <div className="flex items-center gap-4">
            {state.labTimer && state.labTimer !== '00:00:00' && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-xs font-mono text-amber-300">
                <Clock className="w-3.5 h-3.5" />
                <span>{state.labTimer}</span>
              </div>
            )}

            {(state.maxScore ?? 0) > 0 && (
              <div
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-mono ${
                  (state.totalScore ?? 0) >= (state.maxScore ?? 100)
                    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                    : 'bg-slate-800/80 border-slate-700 text-cyan-300'
                }`}
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span className="font-semibold">
                  Lab Score: {state.totalScore ?? 0} / {state.maxScore ?? 100} pts
                </span>
              </div>
            )}

            {totalStepsCount > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-xs">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span className="font-medium text-slate-200">
                  {completedStepsCount} / {totalStepsCount} Steps
                </span>
              </div>
            )}

            {/* Save State Button */}
            <button
              type="button"
              onClick={async () => {
                await apiPost('/api/state/save');
                setCopiedField('save_state');
                setTimeout(() => setCopiedField(null), 2000);
              }}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium flex items-center gap-1.5 cursor-pointer transition"
              title="Save current lab state, tasks, scores, and Chrome bindings to disk"
            >
              {copiedField === 'save_state' ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-300">State Saved</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Save State</span>
                </>
              )}
            </button>

            {/* Execution Mode Switch */}
            <div className="inline-flex rounded-lg bg-slate-950 p-1 border border-slate-800">
              <button
                type="button"
                onClick={() => handleModeChange('autonomous')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                  state.executionMode === 'autonomous'
                    ? 'bg-blue-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Autonomous Mode
              </button>
              <button
                type="button"
                onClick={() => handleModeChange('step_by_step')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                  state.executionMode === 'step_by_step'
                    ? 'bg-blue-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Step-by-Step Mode
              </button>
            </div>
          </div>
        </div>

        {/* Authenticated Chrome Window & Tab Selector Bar */}
        <div className="max-w-[1800px] mx-auto mt-3 pt-3 border-t border-slate-800/90 bg-slate-950/60 rounded-xl p-3 border border-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
            <div className="flex items-center gap-2 flex-wrap">
              <Monitor className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
                Select Your Authenticated Chrome Windows & Tabs
              </span>
              <span className="text-[11px] text-slate-400">
                ({chromeTabs.length} open Chrome tabs detected across Normal & Incognito windows)
              </span>
              {state.macBridgeConnected ? (
                <div className="inline-flex items-center gap-1.5">
                  <span className="px-2 py-0.5 text-[10px] font-mono rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Mac Chrome Bridge: LIVE (Passive Mode)
                  </span>
                  <button
                    type="button"
                    onClick={handleStopMacBridge}
                    className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 flex items-center gap-1 cursor-pointer transition"
                    title="Stop the local macBridgeAgent.ts process on your Mac"
                  >
                    <Power className="w-2.5 h-2.5" />
                    Stop Bridge
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowBridgeModal(true)}
                  className="px-2.5 py-0.5 text-[10px] font-semibold rounded-full bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 flex items-center gap-1 cursor-pointer transition"
                >
                  <Download className="w-3 h-3" />
                  Mac Chrome Bridge: Offline — Click to Download & Start
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleScanChromeWindows}
                disabled={scanningWindows}
                className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium flex items-center gap-1.5 cursor-pointer transition disabled:opacity-60"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 text-cyan-400 ${
                    scanningWindows ? 'animate-spin' : ''
                  }`}
                />
                {scanningWindows ? 'Scanning Chrome...' : 'Scan Open Chrome Windows'}
              </button>
              <button
                type="button"
                onClick={() => handleBindChromeTargets()}
                disabled={syncingLab}
                className="px-3.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition shadow-sm disabled:opacity-60"
              >
                {syncingLab ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Syncing Lab & Windows...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Bind Selected Windows & Sync Lab
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* 1. Lab Instructions Window (@google.com) */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-semibold text-cyan-300 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-cyan-400" />
                  1. Lab Instructions Tab (Your @google.com Login)
                </label>
                {state.selectedLabTabKey && (
                  <button
                    type="button"
                    onClick={() => handleFocusChromeTarget(state.selectedLabTabKey)}
                    className="text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 cursor-pointer"
                    title="Bring this Chrome window and tab to the front"
                  >
                    Focus Window
                  </button>
                )}
              </div>
              <select
                value={state.selectedLabTabKey || ''}
                onChange={(e) =>
                  handleBindChromeTargets({
                    labTabKey: e.target.value || null,
                  })
                }
                className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
              >
                <option value="">-- Select Open Lab Instructions Tab --</option>
                {chromeTabs.map((t) => (
                  <option key={t.key} value={t.key}>
                    {formatTabLabel(t)}
                  </option>
                ))}
              </select>
            </div>

            {/* 2. Cloud Console Window (Incognito Student Account) */}
            <div className="bg-slate-900/90 border border-indigo-500/30 rounded-lg p-2.5 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-semibold text-indigo-300 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-indigo-400" />
                  2. Cloud Console Tab (Incognito Lab Student Login)
                </label>
                {state.selectedConsoleTabKey && (
                  <button
                    type="button"
                    onClick={() => handleFocusChromeTarget(state.selectedConsoleTabKey)}
                    className="text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-slate-700 cursor-pointer"
                    title="Bring this Chrome window and tab to the front"
                  >
                    Focus Window
                  </button>
                )}
              </div>
              <select
                value={state.selectedConsoleTabKey || ''}
                onChange={(e) =>
                  handleBindChromeTargets({
                    consoleTabKey: e.target.value || null,
                  })
                }
                className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-indigo-500"
              >
                <option value="">-- Select Open GCP Console Tab --</option>
                {chromeTabs.map((t) => (
                  <option key={t.key} value={t.key}>
                    {formatTabLabel(t)}
                  </option>
                ))}
              </select>
            </div>

            {/* 3. Cloud Shell / Antigravity Terminal Tab */}
            <div className="bg-slate-900/90 border border-emerald-500/30 rounded-lg p-2.5 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-semibold text-emerald-300 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  3. Cloud Shell / Antigravity (agy) Terminal Tab
                </label>
                {state.selectedCloudShellTabKey && (
                  <button
                    type="button"
                    onClick={() => handleFocusChromeTarget(state.selectedCloudShellTabKey)}
                    className="text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 cursor-pointer"
                    title="Bring this Chrome window and tab to the front"
                  >
                    Focus Window
                  </button>
                )}
              </div>
              <select
                value={state.selectedCloudShellTabKey || ''}
                onChange={(e) =>
                  handleBindChromeTargets({
                    cloudShellTabKey: e.target.value || null,
                  })
                }
                className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-emerald-500"
              >
                <option value="">-- Select Open Cloud Shell / Antigravity Tab --</option>
                {chromeTabs.map((t) => (
                  <option key={t.key} value={t.key}>
                    {formatTabLabel(t)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Lab URL & Execution Controls */}
        <div className="max-w-[1800px] mx-auto mt-3 pt-3 border-t border-slate-800/80 flex flex-wrap items-center gap-2.5">
          <form onSubmit={handleOpenLab} className="flex-1 min-w-[340px] flex gap-2">
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="Paste Google Cloud Skills Boost Lab URL (or select your open tab above)"
              className="flex-1 bg-slate-950 border border-slate-700/80 rounded-lg px-3.5 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-600 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition"
            >
              <ExternalLink className="w-3.5 h-3.5 text-blue-400" />
              Open URL
            </button>
          </form>

          <button
            type="button"
            onClick={handleParseLab}
            disabled={syncingLab}
            className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition disabled:opacity-60"
          >
            {syncingLab ? (
              <RefreshCw className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
            ) : (
              <FileSearch className="w-3.5 h-3.5 text-cyan-400" />
            )}
            {syncingLab ? 'Syncing Lab DOM...' : 'Re-Parse Selected Lab'}
          </button>

          <div className="h-6 w-px bg-slate-800 mx-1" />

          {!isRunning ? (
            <>
              <button
                type="button"
                onClick={handleRunAutonomous}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition shadow-sm"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                Run Autonomous in Selected Windows
              </button>
              <button
                type="button"
                onClick={handleRunSingleStep}
                className="px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition"
              >
                <Zap className="w-3.5 h-3.5" />
                Execute Next Step
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handlePause}
              className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition"
            >
              <Pause className="w-3.5 h-3.5 fill-current" />
              Pause Agent
            </button>
          )}

          <button
            type="button"
            onClick={handleSkipStep}
            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-medium flex items-center gap-1 cursor-pointer transition"
            title="Skip current step"
          >
            <SkipForward className="w-3.5 h-3.5" />
            Skip Step
          </button>

          <button
            type="button"
            onClick={handleEndLab}
            disabled={endingLab}
            className="px-3.5 py-2 rounded-lg bg-red-600/20 hover:bg-red-600/35 text-red-200 border border-red-500/40 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition disabled:opacity-60"
            title="Stop execution, click End Lab in Chrome, and clear temporary credentials"
          >
            {endingLab ? (
              <RefreshCw className="w-3.5 h-3.5 text-red-400 animate-spin" />
            ) : (
              <Power className="w-3.5 h-3.5 text-red-400" />
            )}
            {endingLab ? 'Ending Lab...' : 'End Lab'}
          </button>

          <button
            type="button"
            onClick={handleOpenSwitchCourseModal}
            disabled={switchingCourse}
            className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition shadow-sm disabled:opacity-60"
            title="End or clear the current lab and switch to a different Skill Course or open Chrome tab"
          >
            <Layers className="w-3.5 h-3.5" />
            Run a Different Skill Course
          </button>
        </div>
      </header>

      {/* Login Notice Banner if awaiting user login */}
      {state.status === 'awaiting_login' && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-6 py-2.5">
          <div className="max-w-[1800px] mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2.5 text-amber-200 text-xs">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                <strong>Action Required in Desktop Chrome:</strong> Complete your initial Cloud Skills Boost login in the opened Chrome window. Once the lab page is visible, click{' '}
                <strong>"2. Parse Instructions"</strong> followed by{' '}
                <strong>"3. Start Lab & Sign Into Incognito"</strong>.
              </span>
            </div>
            <button
              type="button"
              onClick={handleParseLab}
              className="px-3 py-1 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs cursor-pointer"
            >
              I'm Logged In — Parse Lab Now
            </button>
          </div>
        </div>
      )}

      {/* Main Content Grid */}
      <main className="flex-1 max-w-[1800px] w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column (5 cols): Credentials Vault + Structured Tasks & Steps Checklist */}
        <div className="lg:col-span-5 flex flex-col gap-5">
          {/* Credentials & Environment Card */}
          <section className="rounded-xl bg-slate-900 border border-slate-800 p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-indigo-400" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  Lab Credentials & Incognito Target
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditingCreds(!editingCreds)}
                  className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
                >
                  {editingCreds ? 'Cancel' : 'Edit / Override'}
                </button>
                {state.credentials.consoleUrl && (
                  <button
                    type="button"
                    onClick={() =>
                      apiPost('/api/lab/open-incognito-link', {
                        url: state.credentials.consoleUrl,
                      })
                    }
                    className="px-2.5 py-1 rounded bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 text-[11px] font-medium flex items-center gap-1 cursor-pointer"
                  >
                    <ExternalLink className="w-3 h-3" /> Open Console in Incognito
                  </button>
                )}
              </div>
            </div>

            {editingCreds ? (
              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div className="col-span-2">
                  <label className="block text-slate-400 mb-1">Student Username</label>
                  <input
                    type="text"
                    value={credDraft.username}
                    onChange={(e) =>
                      setCredDraft({ ...credDraft, username: e.target.value })
                    }
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Password</label>
                  <input
                    type="text"
                    value={credDraft.password}
                    onChange={(e) =>
                      setCredDraft({ ...credDraft, password: e.target.value })
                    }
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">GCP Project ID</label>
                  <input
                    type="text"
                    value={credDraft.projectId}
                    onChange={(e) =>
                      setCredDraft({ ...credDraft, projectId: e.target.value })
                    }
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Default Region</label>
                  <input
                    type="text"
                    value={credDraft.region}
                    onChange={(e) =>
                      setCredDraft({ ...credDraft, region: e.target.value })
                    }
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Default Zone</label>
                  <input
                    type="text"
                    value={credDraft.zone}
                    onChange={(e) =>
                      setCredDraft({ ...credDraft, zone: e.target.value })
                    }
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </div>
                <div className="col-span-2 flex justify-end mt-1">
                  <button
                    type="button"
                    onClick={handleSaveCredentials}
                    className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-semibold cursor-pointer"
                  >
                    Save Credentials
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-slate-950/90 border border-slate-800/90 rounded-lg p-2.5 flex items-center justify-between">
                  <div className="truncate pr-2">
                    <span className="text-[10px] uppercase text-slate-500 block">
                      Username
                    </span>
                    <span className="font-mono text-slate-200">
                      {state.credentials.username || 'Not started'}
                    </span>
                  </div>
                  {state.credentials.username && (
                    <button
                      type="button"
                      onClick={() =>
                        copyToClipboard('user', state.credentials.username)
                      }
                      className="text-slate-400 hover:text-white cursor-pointer"
                    >
                      {copiedField === 'user' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>

                <div className="bg-slate-950/90 border border-slate-800/90 rounded-lg p-2.5 flex items-center justify-between">
                  <div className="truncate pr-2">
                    <span className="text-[10px] uppercase text-slate-500 block">
                      Password
                    </span>
                    <span className="font-mono text-slate-200">
                      {state.credentials.password || 'Not started'}
                    </span>
                  </div>
                  {state.credentials.password && (
                    <button
                      type="button"
                      onClick={() =>
                        copyToClipboard('pass', state.credentials.password)
                      }
                      className="text-slate-400 hover:text-white cursor-pointer"
                    >
                      {copiedField === 'pass' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>

                <div className="bg-slate-950/90 border border-slate-800/90 rounded-lg p-2.5 flex items-center justify-between">
                  <div className="truncate pr-2">
                    <span className="text-[10px] uppercase text-slate-500 block">
                      GCP Project ID
                    </span>
                    <span className="font-mono text-emerald-300">
                      {state.credentials.projectId || 'Pending'}
                    </span>
                  </div>
                  {state.credentials.projectId && (
                    <button
                      type="button"
                      onClick={() =>
                        copyToClipboard('proj', state.credentials.projectId)
                      }
                      className="text-slate-400 hover:text-white cursor-pointer"
                    >
                      {copiedField === 'proj' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>

                <div className="bg-slate-950/90 border border-slate-800/90 rounded-lg p-2.5 flex items-center justify-between">
                  <div className="truncate">
                    <span className="text-[10px] uppercase text-slate-500 block">
                      Region / Zone
                    </span>
                    <span className="font-mono text-blue-300">
                      {state.credentials.region || 'auto'}{' '}
                      {state.credentials.zone ? `/ ${state.credentials.zone}` : ''}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Structured Lab Tasks & Steps List */}
          <section className="rounded-xl bg-slate-900 border border-slate-800 flex-1 flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Layers className="w-4 h-4 text-blue-400 shrink-0" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300 truncate">
                  {state.labTitle || 'Parsed Lab Tasks & Steps'}
                </h2>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {state.tasks.some((t) => t.hasCheckProgress) && (
                  <button
                    type="button"
                    onClick={() => {
                      const gradable =
                        state.tasks.find((t) => t.hasCheckProgress && !t.progressVerified) ||
                        state.tasks.find((t) => t.hasCheckProgress);
                      if (gradable) {
                        apiPost('/api/lab/check-progress', {
                          taskNumber: gradable.number,
                        });
                      }
                    }}
                    className="px-2.5 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-[11px] font-semibold cursor-pointer transition"
                    title="Trigger Qwiklabs status check and sync all task scores"
                  >
                    ✓ Check Lab Status
                  </button>
                )}
                <span className="text-xs text-slate-400">
                  {state.tasks.length} Tasks
                </span>
              </div>
            </div>

            <div className="p-4 overflow-y-auto max-h-[680px] space-y-3">
              {state.tasks.length === 0 ? (
                <div className="text-center py-12 px-4 text-slate-500 text-xs space-y-2">
                  <FileSearch className="w-8 h-8 mx-auto text-slate-600 stroke-1" />
                  <p className="text-slate-300 font-medium">
                    No lab tasks loaded yet.
                  </p>
                  <p>
                    Enter a Google Cloud Skills Boost Lab URL above and click{' '}
                    <strong>"1. Open Lab & Login"</strong>, then{' '}
                    <strong>"2. Parse Instructions"</strong>.
                  </p>
                </div>
              ) : (
                state.tasks.map((task) => {
                  const isExpanded = Boolean(expandedTasks[task.id]);
                  const isCurrentTask = state.activeTaskId === task.id;

                  return (
                    <div
                      key={task.id}
                      className={`rounded-lg border transition ${
                        isCurrentTask
                          ? 'border-blue-500/60 bg-slate-950/90'
                          : 'border-slate-800 bg-slate-950/50'
                      }`}
                    >
                      <div
                        onClick={() =>
                          setExpandedTasks((prev) => ({
                            ...prev,
                            [task.id]: !isExpanded,
                          }))
                        }
                        className="p-3 flex items-center justify-between cursor-pointer select-none hover:bg-slate-900/60 rounded-t-lg"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                          )}
                          <span className="px-2 py-0.5 text-[11px] font-bold rounded bg-slate-800 text-slate-200">
                            Task {task.number}
                          </span>
                          <h3 className="text-xs font-semibold text-slate-100 truncate">
                            {task.title}
                          </h3>
                        </div>

                        <div
                          className="flex items-center gap-2 shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {task.stepMaxScore !== undefined && task.stepMaxScore > 0 && (
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                                task.progressVerified
                                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                  : 'bg-slate-800 text-slate-300 border border-slate-700'
                              }`}
                            >
                              {task.stepScore ?? (task.progressVerified ? task.stepMaxScore : 0)}/
                              {task.stepMaxScore} pts
                            </span>
                          )}
                          {task.hasCheckProgress && (
                            <button
                              type="button"
                              onClick={() =>
                                apiPost('/api/lab/check-progress', {
                                  taskNumber: task.number,
                                })
                              }
                              className={`px-2 py-0.5 rounded text-[11px] font-medium border cursor-pointer transition ${
                                task.progressVerified
                                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                                  : 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border-amber-500/30'
                              }`}
                            >
                              {task.progressVerified
                                ? '✓ Verified'
                                : 'Check Progress'}
                            </button>
                          )}
                        </div>
                      </div>

                      {task.progressMessage && (
                        <div
                          className={`mx-3 mb-2 px-2.5 py-1.5 rounded text-[11px] border ${
                            task.progressVerified
                              ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-300'
                              : 'bg-amber-950/30 border-amber-500/30 text-amber-200'
                          }`}
                        >
                          {task.progressVerified ? '✓ ' : '⚠ '}
                          {task.progressMessage}
                        </div>
                      )}

                      {isExpanded && (
                        <div className="px-3 pb-3 pt-1 border-t border-slate-800/60 space-y-2">
                          {task.steps.map((step) => {
                            const isActiveStep = state.activeStepId === step.id;
                            return (
                              <div
                                key={step.id}
                                className={`p-2.5 rounded-lg border text-xs space-y-2 ${
                                  isActiveStep
                                    ? 'border-blue-500/60 bg-blue-950/20'
                                    : step.status === 'completed'
                                    ? 'border-emerald-500/30 bg-emerald-950/10 opacity-85'
                                    : 'border-slate-800/80 bg-slate-900/50'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="font-mono text-[11px] text-slate-400">
                                      #{task.number}.{step.index}
                                    </span>
                                    {renderSurfaceBadge(step.targetSurface)}
                                  </div>
                                  <span
                                    className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
                                      step.status === 'completed'
                                        ? 'bg-emerald-500/20 text-emerald-300'
                                        : step.status === 'running'
                                        ? 'bg-blue-500/20 text-blue-300 animate-pulse'
                                        : step.status === 'failed'
                                        ? 'bg-red-500/20 text-red-300'
                                        : 'bg-slate-800 text-slate-400'
                                    }`}
                                  >
                                    {step.status}
                                  </span>
                                </div>

                                <p className="text-slate-200 leading-relaxed">
                                  {step.instruction}
                                </p>

                                {/* Active Links inside the step that open in Incognito */}
                                {step.links.length > 0 && (
                                  <div className="flex flex-wrap gap-1.5 pt-1">
                                    {step.links.map((link, lIdx) => (
                                      <button
                                        key={lIdx}
                                        type="button"
                                        onClick={() =>
                                          apiPost('/api/lab/open-incognito-link', {
                                            url: link.href,
                                          })
                                        }
                                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 text-[11px] cursor-pointer transition"
                                      >
                                        <ExternalLink className="w-3 h-3" />
                                        Open in Incognito: {link.text.slice(0, 40)}
                                      </button>
                                    ))}
                                  </div>
                                )}

                                {/* Copyable Command / Antigravity Prompt Blocks */}
                                {step.commands.map((cmd, cIdx) => (
                                  <div
                                    key={cIdx}
                                    className="rounded bg-slate-950 border border-slate-800 p-2 font-mono text-[11px] text-slate-200 overflow-x-auto"
                                  >
                                    <div className="flex items-center justify-between mb-1 pb-1 border-b border-slate-800/80">
                                      <span className="text-[10px] text-slate-500">
                                        {step.targetSurface === 'antigravity'
                                          ? 'ANTIGRAVITY PROMPT'
                                          : 'COMMAND BLOCK'}
                                      </span>
                                      <div className="flex items-center gap-2">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            apiPost(
                                              step.targetSurface === 'antigravity'
                                                ? '/api/lab/antigravity-prompt'
                                                : '/api/lab/cloud-shell-cmd',
                                              step.targetSurface === 'antigravity'
                                                ? { prompt: cmd }
                                                : { command: cmd }
                                            )
                                          }
                                          className="text-[10px] text-emerald-400 hover:text-emerald-300 font-sans font-semibold cursor-pointer"
                                        >
                                          ▶ Execute Now
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            copyToClipboard(
                                              `${step.id}-${cIdx}`,
                                              cmd
                                            )
                                          }
                                          className="text-slate-400 hover:text-white cursor-pointer"
                                        >
                                          {copiedField === `${step.id}-${cIdx}` ? (
                                            <Check className="w-3 h-3 text-emerald-400" />
                                          ) : (
                                            <Copy className="w-3 h-3" />
                                          )}
                                        </button>
                                      </div>
                                    </div>
                                    <pre className="whitespace-pre-wrap break-all">
                                      {cmd}
                                    </pre>
                                  </div>
                                ))}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>

        {/* Right Column (7 cols): Live Dual Viewports + Antigravity/Cloud Shell Dispatch + Logs */}
        <div className="lg:col-span-7 flex flex-col gap-5">
          {/* Live Browser Viewports Card */}
          <section className="rounded-xl bg-slate-900 border border-slate-800 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-emerald-400" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  Live Browser Telemetry (Desktop Chrome Windows)
                </h2>
              </div>

              <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
                <button
                  type="button"
                  onClick={() => setViewportTab('split')}
                  className={`px-2.5 py-1 rounded ${
                    viewportTab === 'split'
                      ? 'bg-slate-800 text-white font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Side-by-Side
                </button>
                <button
                  type="button"
                  onClick={() => setViewportTab('console')}
                  className={`px-2.5 py-1 rounded ${
                    viewportTab === 'console'
                      ? 'bg-slate-800 text-white font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Incognito Console & Antigravity
                </button>
                <button
                  type="button"
                  onClick={() => setViewportTab('lab')}
                  className={`px-2.5 py-1 rounded ${
                    viewportTab === 'lab'
                      ? 'bg-slate-800 text-white font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Main Lab Window
                </button>
              </div>
            </div>

            {/* Gemini Current Visual Reasoning Banner */}
            {state.lastThought && (
              <div className="rounded-lg bg-blue-950/40 border border-blue-500/30 px-3 py-2 text-xs text-blue-200 flex items-start gap-2">
                <Bot className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-blue-300">
                    {state.activeModel || 'gemini-3.8-flash'} Visual Reasoning:{' '}
                  </span>
                  {state.lastThought}
                </div>
              </div>
            )}

            <div
              className={`grid gap-3 ${
                viewportTab === 'split' ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'
              }`}
            >
              {/* Main Lab Window Preview */}
              {(viewportTab === 'split' || viewportTab === 'lab') && (
                <div className="rounded-lg bg-slate-950 border border-slate-800 overflow-hidden flex flex-col">
                  <div className="px-3 py-1.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-[11px]">
                    <span className="font-semibold text-slate-300">
                      Window 1: Main Lab (@google.com Identity)
                    </span>
                    <span className="font-mono text-slate-500 truncate max-w-[220px]">
                      {state.labCurrentUrl || 'Idle'}
                    </span>
                  </div>
                  <div className="aspect-video bg-slate-950 flex items-center justify-center overflow-hidden">
                    {state.labScreenshot ? (
                      <img
                        src={`data:image/jpeg;base64,${state.labScreenshot}`}
                        alt="Main Lab Window"
                        className="w-full h-full object-contain"
                      />
                    ) : selectedLabTab ? (
                      <div className="p-4 w-full h-full flex flex-col justify-between text-xs bg-gradient-to-br from-slate-950 to-slate-900/90">
                        <div className="space-y-1.5">
                          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 text-[10px] font-mono">
                            <CheckCircle2 className="w-3 h-3" /> Attached to Native Chrome Window #
                            {selectedLabTab.windowIndex} ({selectedLabTab.windowMode.toUpperCase()}) • Tab #
                            {selectedLabTab.tabIndex}
                          </div>
                          <p className="font-semibold text-slate-100 line-clamp-2">
                            {selectedLabTab.title}
                          </p>
                          <p className="font-mono text-[11px] text-slate-400 break-all line-clamp-2">
                            {selectedLabTab.url}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 pt-2 border-t border-slate-800/80">
                          <button
                            type="button"
                            onClick={() => handleFocusChromeTarget(selectedLabTab.key)}
                            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 text-[11px] font-medium cursor-pointer"
                          >
                            Focus Lab Window in Chrome
                          </button>
                          <button
                            type="button"
                            onClick={handleParseLab}
                            className="px-2.5 py-1 rounded bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-200 border border-cyan-500/30 text-[11px] font-medium cursor-pointer"
                          >
                            Re-Sync Instructions
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-600 text-center p-4">
                        Select your authenticated Lab Instructions tab in the selector bar above.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Incognito Console & Antigravity Window Preview */}
              {(viewportTab === 'split' || viewportTab === 'console') && (
                <div className="rounded-lg bg-slate-950 border border-indigo-500/40 overflow-hidden flex flex-col">
                  <div className="px-3 py-1.5 bg-indigo-950/40 border-b border-indigo-500/30 flex items-center justify-between text-[11px]">
                    <span className="font-semibold text-indigo-300">
                      Window 2: Incognito GCP Console & Antigravity
                    </span>
                    <span className="font-mono text-indigo-300/70 truncate max-w-[220px]">
                      {state.consoleCurrentUrl || 'Waiting for Lab Start'}
                    </span>
                  </div>
                  <div className="aspect-video bg-slate-950 flex items-center justify-center overflow-hidden">
                    {state.consoleScreenshot ? (
                      <img
                        src={`data:image/jpeg;base64,${state.consoleScreenshot}`}
                        alt="Incognito Console Window"
                        className="w-full h-full object-contain"
                      />
                    ) : selectedConsoleTab || selectedShellTab ? (
                      <div className="p-4 w-full h-full flex flex-col justify-between text-xs bg-gradient-to-br from-slate-950 to-indigo-950/25">
                        <div className="space-y-2">
                          {selectedConsoleTab && (
                            <div className="space-y-0.5">
                              <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[10px] font-mono">
                                <CheckCircle2 className="w-3 h-3" /> Console: Win #
                                {selectedConsoleTab.windowIndex} (
                                {selectedConsoleTab.windowMode.toUpperCase()}) • Tab #
                                {selectedConsoleTab.tabIndex}
                              </div>
                              <p className="text-slate-200 font-medium truncate">
                                {selectedConsoleTab.title}
                              </p>
                            </div>
                          )}
                          {selectedShellTab && (
                            <div className="space-y-0.5">
                              <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-mono">
                                <Terminal className="w-3 h-3" /> Cloud Shell / agy: Win #
                                {selectedShellTab.windowIndex} (
                                {selectedShellTab.windowMode.toUpperCase()}) • Tab #
                                {selectedShellTab.tabIndex}
                              </div>
                              <p className="text-slate-200 font-medium truncate">
                                {selectedShellTab.title}
                              </p>
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800/80">
                          {selectedConsoleTab && (
                            <button
                              type="button"
                              onClick={() => handleFocusChromeTarget(selectedConsoleTab.key)}
                              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-slate-700 text-[11px] font-medium cursor-pointer"
                            >
                              Focus Console Tab
                            </button>
                          )}
                          {selectedShellTab && (
                            <button
                              type="button"
                              onClick={() => handleFocusChromeTarget(selectedShellTab.key)}
                              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 text-[11px] font-medium cursor-pointer"
                            >
                              Focus Cloud Shell Tab
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-600 text-center p-4">
                        Select your Incognito Cloud Console & Cloud Shell tabs in the selector bar above.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Direct Co-Pilot Dispatch: Override, Antigravity Prompt, and Cloud Shell */}
          <section className="rounded-xl bg-slate-900 border border-slate-800 p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Live Gemini Override */}
            <form onSubmit={handleSendOverride} className="flex flex-col gap-1.5">
              <label className="text-[11px] font-semibold text-blue-300 flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5" /> Guide Gemini on Current Step
              </label>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={overrideInput}
                  onChange={(e) => setOverrideInput(e.target.value)}
                  placeholder="e.g. Click the Create button at top"
                  className="flex-1 bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100"
                />
                <button
                  type="submit"
                  className="px-2.5 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </form>

            {/* Direct Antigravity Prompt Injector */}
            <form
              onSubmit={handleSendAntigravityPrompt}
              className="flex flex-col gap-1.5"
            >
              <label className="text-[11px] font-semibold text-purple-300 flex items-center justify-between gap-1">
                <span className="flex items-center gap-1">
                  <Bot className="w-3.5 h-3.5" /> Zero-Touch Antigravity Prompt
                </span>
                <button
                  type="button"
                  onClick={() =>
                    apiPost('/api/lab/cloud-shell-cmd', {
                      command: 'agy',
                    })
                  }
                  className="px-1.5 py-0.5 rounded bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 border border-purple-500/30 text-[10px] font-mono cursor-pointer transition"
                  title="Launches agy --dangerously-skip-permissions || agy in Cloud Shell"
                >
                  ⚡ Launch agy
                </button>
              </label>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={antigravityInput}
                  onChange={(e) => setAntigravityInput(e.target.value)}
                  placeholder="Prompt Antigravity (auto-approves)..."
                  className="flex-1 bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100"
                />
                <button
                  type="submit"
                  className="px-2.5 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white text-xs cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </form>

            {/* Direct Cloud Shell Command Injector */}
            <form onSubmit={handleSendShellCommand} className="flex flex-col gap-1.5">
              <label className="text-[11px] font-semibold text-emerald-300 flex items-center gap-1">
                <Terminal className="w-3.5 h-3.5" /> Run Command in Cloud Shell
              </label>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={shellInput}
                  onChange={(e) => setShellInput(e.target.value)}
                  placeholder="agy . or gcloud config list..."
                  className="flex-1 bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100"
                />
                <button
                  type="submit"
                  className="px-2.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </form>
          </section>

          {/* Real-Time Execution & AI Reasoning Stream */}
          <section className="rounded-xl bg-slate-900 border border-slate-800 flex-1 flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RefreshCw className="w-3.5 h-3.5 text-blue-400" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  Real-Time Execution & Agent Log
                </h2>
              </div>
              <span className="text-[11px] text-slate-500 font-mono">
                {state.logs.length} events
              </span>
            </div>

            <div className="p-3 overflow-y-auto max-h-[300px] space-y-1.5 font-mono text-xs">
              {state.logs.length === 0 ? (
                <div className="text-slate-500 text-center py-8">
                  Ready. Paste a Google Cloud Skills Boost lab URL above to begin.
                </div>
              ) : (
                state.logs.map((log) => (
                  <div
                    key={log.id}
                    className={`px-2.5 py-1.5 rounded border flex items-start gap-2 ${
                      log.level === 'error'
                        ? 'bg-red-950/30 border-red-500/30 text-red-200'
                        : log.level === 'warn'
                        ? 'bg-amber-950/30 border-amber-500/30 text-amber-200'
                        : log.level === 'success'
                        ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200'
                        : log.level === 'ai'
                        ? 'bg-blue-950/30 border-blue-500/30 text-blue-200'
                        : 'bg-slate-950/70 border-slate-800/80 text-slate-300'
                    }`}
                  >
                    <span className="text-[10px] text-slate-500 shrink-0 mt-0.5">
                      {log.timestamp}
                    </span>
                    <span className="text-[10px] uppercase px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 shrink-0">
                      {log.surface}
                    </span>
                    <div className="flex-1 break-words">
                      <span>{log.message}</span>
                      {log.detail && (
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          {log.detail}
                        </p>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </main>

      {/* Mac Chrome Bridge Download & On-Demand Launch Modal */}
      {showBridgeModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center">
                  <Monitor className="w-5 h-5 text-cyan-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Start On-Demand Mac Chrome Bridge (macBridgeAgent.ts)
                  </h3>
                  <p className="text-xs text-slate-400">
                    {pendingActionLabel
                      ? `Required to execute: "${pendingActionLabel}" — will auto-continue as soon as connected`
                      : 'Connects Cloud Run to your desktop Google Chrome windows on demand'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowBridgeModal(false);
                  pendingActionRef.current = null;
                  setPendingActionLabel(null);
                }}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-5 text-xs text-slate-300">
              <div className="rounded-xl bg-emerald-950/25 border border-emerald-500/30 p-3.5 text-emerald-200 leading-relaxed">
                <strong className="text-emerald-300">Passive On-Demand Mode (Zero Login Interference):</strong>{' '}
                The updated <code className="font-mono text-emerald-300">macBridgeAgent.ts</code> has{' '}
                <strong>zero background polling</strong> and never touches Chrome while you are logging in. It only runs when you click an action in this UI, and you can stop it with one click using the{' '}
                <strong>Stop Bridge</strong> button in the header.
              </div>

              {/* Option 1: Run from Local ~/Downloads/skill-runner Directory */}
              <div className="space-y-2">
                <div className="font-semibold text-slate-100 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 flex items-center justify-center text-[11px] font-bold">
                    1
                  </span>
                  Run from Your Local <code className="font-mono text-cyan-300">~/Downloads/skill-runner</code> Folder
                </div>
                <div className="pl-7 flex items-center gap-2">
                  <code className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 font-mono text-[11px] text-emerald-300 overflow-x-auto">
                    node ~/Downloads/skill-runner/macBridgeAgent.ts
                  </code>
                  <button
                    type="button"
                    onClick={() =>
                      copyToClipboard(
                        'bridge-local',
                        'node ~/Downloads/skill-runner/macBridgeAgent.ts'
                      )
                    }
                    className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-medium flex items-center gap-1.5 cursor-pointer shrink-0"
                  >
                    {copiedField === 'bridge-local' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-emerald-400" />
                        Copy Local Command
                      </>
                    )}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2.5 pl-7 pt-1">
                  <a
                    href="/api/bridge/macBridgeAgent.ts?download=1"
                    download="macBridgeAgent.ts"
                    className="px-3.5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold flex items-center gap-2 shadow-sm transition"
                  >
                    <Download className="w-4 h-4" />
                    Download macBridgeAgent.ts
                  </a>
                  <a
                    href="/api/bridge/Start-Mac-Chrome-Bridge.command?download=1"
                    download="Start-Mac-Chrome-Bridge.command"
                    className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 font-semibold flex items-center gap-2 transition"
                  >
                    <Download className="w-4 h-4 text-cyan-400" />
                    Download macOS Launcher (.command)
                  </a>
                </div>
              </div>

              {/* Option 2: Instant 1-Line Terminal Command */}
              <div className="space-y-2">
                <div className="font-semibold text-slate-100 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 flex items-center justify-center text-[11px] font-bold">
                    2
                  </span>
                  Or Update & Start in <code className="font-mono text-indigo-300">~/Downloads/skill-runner</code> Automatically
                </div>
                <div className="pl-7 flex items-center gap-2">
                  <code className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 font-mono text-[11px] text-cyan-300 overflow-x-auto">
                    {`curl -fsSL ${window.location.origin}/api/bridge/start.sh | sh`}
                  </code>
                  <button
                    type="button"
                    onClick={() =>
                      copyToClipboard(
                        'bridge-oneliner',
                        `curl -fsSL ${window.location.origin}/api/bridge/start.sh | sh`
                      )
                    }
                    className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-medium flex items-center gap-1.5 cursor-pointer shrink-0"
                  >
                    {copiedField === 'bridge-oneliner' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-cyan-400" />
                        Copy Command
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950/70 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-amber-300 font-mono">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-400" />
                Waiting for macBridgeAgent.ts connection (auto-detecting every 2s)...
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowBridgeModal(false);
                  pendingActionRef.current = null;
                  setPendingActionLabel(null);
                }}
                className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Run a Different Skill Course Modal */}
      {showSwitchCourseModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-xl w-full rounded-2xl bg-slate-900 border border-slate-700/80 shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center">
                  <Layers className="w-4 h-4 text-indigo-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Run a Different Skill Course
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    End or reset the current lab session and switch to another Google Cloud Skills Boost lab
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSwitchCourseModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-4 text-xs text-slate-300">
              {/* Option A: Select an Open Chrome Tab */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="font-semibold text-slate-200">
                    Option 1: Select an Open Chrome Lab Tab
                  </label>
                  <button
                    type="button"
                    onClick={handleScanChromeWindows}
                    disabled={scanningWindows}
                    className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1 cursor-pointer"
                  >
                    <RefreshCw className={`w-3 h-3 ${scanningWindows ? 'animate-spin' : ''}`} />
                    Refresh Open Tabs
                  </button>
                </div>
                <select
                  value={newCourseTabKey}
                  onChange={(e) => {
                    setNewCourseTabKey(e.target.value);
                    if (e.target.value) setNewCourseUrl('');
                  }}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-indigo-500"
                >
                  <option value="">-- Choose an Open Chrome Tab (or paste a URL below) --</option>
                  {chromeTabs.map((t) => (
                    <option key={t.key} value={t.key}>
                      {formatTabLabel(t)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Option B: Paste a New Skill Course / Lab URL */}
              <div className="space-y-1.5">
                <label className="font-semibold text-slate-200 block">
                  Option 2: Or Paste a New Skill Course / Lab URL
                </label>
                <input
                  type="url"
                  value={newCourseUrl}
                  onChange={(e) => {
                    setNewCourseUrl(e.target.value);
                    if (e.target.value) setNewCourseTabKey('');
                  }}
                  placeholder="https://partner.skills.google/paths/... or https://partner.skills.google/focuses/..."
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-xs text-slate-100 placeholder-slate-500 font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Checkbox to End Current Active Lab First */}
              <label className="flex items-center gap-2.5 p-3 rounded-xl bg-slate-950/90 border border-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={endCurrentBeforeSwitch}
                  onChange={(e) => setEndCurrentBeforeSwitch(e.target.checked)}
                  className="rounded border-slate-600 bg-slate-900 text-indigo-600 focus:ring-indigo-500"
                />
                <div>
                  <span className="font-semibold text-slate-200 block">
                    End current active lab in Google Chrome before switching
                  </span>
                  <span className="text-[11px] text-slate-400">
                    Automatically clicks "End Lab" and confirms the dialog so Qwiklabs allows starting your next lab immediately.
                  </span>
                </div>
              </label>
            </div>

            <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950/70 flex flex-wrap items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setShowSwitchCourseModal(false)}
                className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleConfirmSwitchCourse(false)}
                disabled={switchingCourse}
                className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/30 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition disabled:opacity-60"
              >
                {switchingCourse ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <FileSearch className="w-3.5 h-3.5" />
                )}
                Switch & Load Course
              </button>
              <button
                type="button"
                onClick={() => handleConfirmSwitchCourse(true)}
                disabled={switchingCourse}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition shadow-sm disabled:opacity-60"
              >
                {switchingCourse ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-current" />
                )}
                Switch & Run Autonomous
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
