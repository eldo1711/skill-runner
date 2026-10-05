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
  SlidersHorizontal,
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
  activeModel: 'gemini-3.5-flash',
  macBridgeConnected: false,
};

export default function App() {
  const [state, setState] = useState<RunnerState>(INITIAL_STATE);
  const [urlInput, setUrlInput] = useState<string>('');
  const [sourceMode, setSourceMode] = useState<'tab' | 'url'>('tab');
  const [overrideInput, setOverrideInput] = useState<string>('');
  const [antigravityInput, setAntigravityInput] = useState<string>('');
  const [shellInput, setShellInput] = useState<string>('');
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [expandedTasks, setExpandedTasks] = useState<Record<string, boolean>>({});
  const [editingCreds, setEditingCreds] = useState<boolean>(false);
  const [credDraft, setCredDraft] = useState<LabCredentials>(INITIAL_STATE.credentials);
  const [scanningWindows, setScanningWindows] = useState<boolean>(false);
  const [syncingLab, setSyncingLab] = useState<boolean>(false);
  const [startingAndRunning, setStartingAndRunning] = useState<boolean>(false);
  const [checkingAllProgress, setCheckingAllProgress] = useState<boolean>(false);
  const [endingLab, setEndingLab] = useState<boolean>(false);
  const [showSwitchCourseModal, setShowSwitchCourseModal] = useState<boolean>(false);
  const [switchingCourse, setSwitchingCourse] = useState<boolean>(false);
  const [newCourseUrl, setNewCourseUrl] = useState<string>('');
  const [newCourseTabKey, setNewCourseTabKey] = useState<string>('');
  const [endCurrentBeforeSwitch, setEndCurrentBeforeSwitch] = useState<boolean>(true);
  const [showBridgeModal, setShowBridgeModal] = useState<boolean>(false);
  const [canStartLocally, setCanStartLocally] = useState<boolean>(false);
  const [startingBridge, setStartingBridge] = useState<boolean>(false);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [pendingActionLabel, setPendingActionLabel] = useState<string | null>(null);
  const pendingActionRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    fetch('/api/state')
      .then((r) => r.json())
      .then((data: RunnerState) => {
        setState(data);
        if (data.labUrl) setUrlInput(data.labUrl);
      })
      .catch(() => {});

    fetch('/api/bridge/status')
      .then((r) => r.json())
      .then((data) => {
        if (data && typeof data.canStartLocally === 'boolean') {
          setCanStartLocally(data.canStartLocally);
        }
      })
      .catch(() => {});

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
        if (data && typeof data.canStartLocally === 'boolean') {
          setCanStartLocally(data.canStartLocally);
        }
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
      return data;
    } catch {
      return null;
    }
  };

  /**
   * Verifies that the Mac Chrome Bridge is connected before executing an action that interacts with desktop Chrome.
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
      if (data && typeof data.canStartLocally === 'boolean') {
        setCanStartLocally(data.canStartLocally);
      }
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

  const handleStartMacBridge = async () => {
    if (!canStartLocally) {
      setShowBridgeModal(true);
      return;
    }
    setStartingBridge(true);
    try {
      const data = await apiPost('/api/bridge/start');
      if (!data?.started && !data?.state?.macBridgeConnected) {
        setShowBridgeModal(true);
      }
    } catch {
      setShowBridgeModal(true);
    } finally {
      setStartingBridge(false);
    }
  };

  const handleStopMacBridge = async () => {
    await apiPost('/api/bridge/stop');
  };

  const handleScanChromeWindows = async () => {
    await ensureMacBridgeConnected('Refresh Open Chrome Tabs', async () => {
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
    await ensureMacBridgeConnected('Select Lab Instructions Tab', async () => {
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

  const handleOpenLabUrl = async (e: React.FormEvent) => {
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
    await ensureMacBridgeConnected('Sync & Parse Lab Instructions', async () => {
      setSyncingLab(true);
      try {
        await apiPost('/api/lab/parse');
      } finally {
        setSyncingLab(false);
      }
    });
  };

  /**
   * Primary 1-Click Workflow:
   * Points at the selected Lab tab (or URL), starts the lab, spawns the student Incognito window,
   * signs in as the lab student account, runs all tasks, and verifies all progress checks.
   */
  const handleStartAndRunLab = async () => {
    await ensureMacBridgeConnected('Start & Run Lab', async () => {
      setStartingAndRunning(true);
      try {
        await apiPost('/api/lab/start-and-run', {
          labTabKey: sourceMode === 'tab' ? state.selectedLabTabKey : undefined,
          url: sourceMode === 'url' && urlInput.trim() ? urlInput.trim() : undefined,
        });
      } finally {
        setStartingAndRunning(false);
      }
    });
  };

  const handleCheckAllProgress = async () => {
    await ensureMacBridgeConnected('Check All Progress', async () => {
      setCheckingAllProgress(true);
      try {
        await apiPost('/api/lab/check-all-progress');
      } finally {
        setCheckingAllProgress(false);
      }
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
    await ensureMacBridgeConnected('Switch Lab', async () => {
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
            <Bot className="w-3 h-3" /> Antigravity
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
            <ExternalLink className="w-3 h-3" /> Console Link
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
    state.status === 'running_autonomous' ||
    state.status === 'running_step' ||
    state.status === 'starting_lab' ||
    state.status === 'signing_in_console';

  const completedTasksCount = state.tasks.filter(
    (t) => t.status === 'completed' || t.progressVerified
  ).length;
  const totalTasksCount = state.tasks.length;

  const chromeTabs = state.availableChromeTabs || [];
  // Normal (non-incognito) tabs prioritized for picking the self-signed-in Lab Instructions page
  const labCandidateTabs = chromeTabs.filter((t) => t.windowMode !== 'incognito');
  const allLabSelectTabs = labCandidateTabs.length > 0 ? labCandidateTabs : chromeTabs;

  const selectedLabTab = chromeTabs.find((t) => t.key === state.selectedLabTabKey);
  const selectedConsoleTab = chromeTabs.find((t) => t.key === state.selectedConsoleTabKey);
  const selectedShellTab = chromeTabs.find((t) => t.key === state.selectedCloudShellTabKey);

  const formatTabLabel = (t: (typeof chromeTabs)[number]) => {
    const roleTag =
      t.suggestedRole === 'lab'
        ? '★ LAB • '
        : t.suggestedRole === 'console'
        ? 'CONSOLE • '
        : t.suggestedRole === 'cloud_shell'
        ? 'CLOUD SHELL • '
        : '';
    const modeTag = t.windowMode === 'incognito' ? ' (Incognito)' : '';
    const shortTitle = t.title.length > 58 ? `${t.title.slice(0, 58)}…` : t.title;
    return `${roleTag}${shortTitle}${modeTag}`;
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Clean Top Header */}
      <header className="border-b border-slate-800 bg-slate-900/95 backdrop-blur sticky top-0 z-30 px-6 py-3">
        <div className="max-w-[1600px] mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-600/20">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-base font-bold tracking-tight text-white">
                  Skills Runner
                </h1>
                <span className="px-2 py-0.5 text-[11px] font-semibold font-mono rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/30">
                  {state.activeModel || 'gemini-3.5-flash'}
                </span>
                <span
                  className={`px-2.5 py-0.5 text-[11px] font-mono font-semibold rounded-full border ${
                    state.status === 'completed'
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : isRunning
                      ? 'bg-blue-500/20 text-blue-300 border-blue-500/40 animate-pulse'
                      : state.status === 'error'
                      ? 'bg-red-500/20 text-red-300 border-red-500/40'
                      : 'bg-slate-800 text-slate-300 border-slate-700'
                  }`}
                >
                  {state.status.replace(/_/g, ' ').toUpperCase()}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Autonomous Google Cloud Skills Boost Lab Runner & Progress Grader
              </p>
            </div>
          </div>

          {/* Live Telemetry Pills */}
          <div className="flex items-center gap-3 flex-wrap">
            {state.labTimer && state.labTimer !== '00:00:00' && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/90 border border-slate-700 text-xs font-mono text-amber-300">
                <Clock className="w-3.5 h-3.5" />
                <span>{state.labTimer}</span>
              </div>
            )}

            {(state.maxScore ?? 0) > 0 && (
              <div
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono ${
                  (state.totalScore ?? 0) >= (state.maxScore ?? 100)
                    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                    : 'bg-slate-800/90 border-slate-700 text-cyan-300'
                }`}
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span className="font-semibold">
                  Score: {state.totalScore ?? 0} / {state.maxScore ?? 100}
                </span>
              </div>
            )}

            {totalTasksCount > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/90 border border-slate-700 text-xs">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span className="font-medium text-slate-200">
                  {completedTasksCount} / {totalTasksCount} Tasks Verified
                </span>
              </div>
            )}

            {state.tasks.length > 0 && (
              <button
                type="button"
                onClick={handleOpenSwitchCourseModal}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium flex items-center gap-1.5 cursor-pointer transition"
              >
                <Layers className="w-3.5 h-3.5 text-indigo-400" />
                Switch Lab
              </button>
            )}
          </div>
        </div>

        {/* Streamlined 3-Step Guided Workflow Bar */}
        <div className="max-w-[1600px] mx-auto mt-3 grid grid-cols-1 lg:grid-cols-12 gap-3">
          {/* STEP 1: Connect Mac Bridge */}
          <div
            className={`lg:col-span-3 rounded-xl p-3 border flex flex-col justify-between gap-2 transition ${
              state.macBridgeConnected
                ? 'bg-emerald-950/20 border-emerald-500/30'
                : 'bg-amber-950/20 border-amber-500/40'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={`w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center ${
                    state.macBridgeConnected
                      ? 'bg-emerald-500 text-slate-950'
                      : 'bg-amber-500 text-slate-950'
                  }`}
                >
                  {state.macBridgeConnected ? '✓' : '1'}
                </span>
                <span className="text-xs font-bold text-white">
                  Mac Chrome Bridge
                </span>
              </div>
              {state.macBridgeConnected ? (
                <span className="px-2 py-0.5 text-[10px] font-mono rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Connected
                </span>
              ) : (
                <span className="px-2 py-0.5 text-[10px] font-mono rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  Not Connected
                </span>
              )}
            </div>

            <p className="text-[11px] text-slate-300 leading-snug">
              {state.macBridgeConnected
                ? 'Signed-in Chrome tabs detected. Ready to spawn student Incognito sessions.'
                : 'Sign into Skills Boost in Chrome, then start the Mac Bridge.'}
            </p>

            <div className="flex items-center gap-2">
              {state.macBridgeConnected ? (
                <>
                  <button
                    type="button"
                    onClick={handleScanChromeWindows}
                    disabled={scanningWindows}
                    className="flex-1 px-2.5 py-1.5 rounded-lg bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer transition"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 text-cyan-400 ${
                        scanningWindows ? 'animate-spin' : ''
                      }`}
                    />
                    {scanningWindows ? 'Scanning...' : `Refresh Tabs (${chromeTabs.length})`}
                  </button>
                  <button
                    type="button"
                    onClick={handleStopMacBridge}
                    className="px-2.5 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 text-xs font-medium flex items-center gap-1 cursor-pointer transition"
                    title="Stop the local Mac Chrome Bridge process"
                  >
                    <Power className="w-3.5 h-3.5" />
                    <span>Stop</span>
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleStartMacBridge}
                    disabled={startingBridge}
                    className="flex-1 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition shadow-sm disabled:opacity-60"
                  >
                    {startingBridge ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Starting Bridge...
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-current" />
                        Start Mac Bridge
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowBridgeModal(true)}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium flex items-center gap-1 cursor-pointer transition"
                    title="View terminal command & downloadable Mac Bridge launcher"
                  >
                    <Download className="w-3.5 h-3.5 text-cyan-400" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* STEP 2: Point at Your Self-Signed-In Lab Page */}
          <div className="lg:col-span-5 rounded-xl bg-slate-900/90 border border-slate-800 p-3 flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={`w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center ${
                    state.tasks.length > 0
                      ? 'bg-emerald-500 text-slate-950'
                      : 'bg-cyan-500 text-slate-950'
                  }`}
                >
                  {state.tasks.length > 0 ? '✓' : '2'}
                </span>
                <span className="text-xs font-bold text-white">
                  Point at Your Lab Instructions Page
                </span>
              </div>

              <div className="inline-flex rounded-md bg-slate-950 p-0.5 border border-slate-800 text-[11px]">
                <button
                  type="button"
                  onClick={() => setSourceMode('tab')}
                  className={`px-2 py-0.5 rounded cursor-pointer transition ${
                    sourceMode === 'tab'
                      ? 'bg-cyan-600 text-white font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Open Chrome Tab
                </button>
                <button
                  type="button"
                  onClick={() => setSourceMode('url')}
                  className={`px-2 py-0.5 rounded cursor-pointer transition ${
                    sourceMode === 'url'
                      ? 'bg-cyan-600 text-white font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Paste Lab URL
                </button>
              </div>
            </div>

            {sourceMode === 'tab' ? (
              <div className="flex items-center gap-2">
                <select
                  value={state.selectedLabTabKey || ''}
                  onChange={(e) =>
                    handleBindChromeTargets({
                      labTabKey: e.target.value || null,
                    })
                  }
                  className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                >
                  <option value="">
                    -- Select Your Open Self-Signed-In Lab Tab --
                  </option>
                  {allLabSelectTabs.map((t) => (
                    <option key={t.key} value={t.key}>
                      {formatTabLabel(t)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleParseLab}
                  disabled={syncingLab}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition shrink-0 disabled:opacity-60"
                  title="Sync and parse instructions from the selected Chrome tab"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${syncingLab ? 'animate-spin' : ''}`}
                  />
                  {syncingLab ? 'Syncing...' : 'Sync'}
                </button>
              </div>
            ) : (
              <form onSubmit={handleOpenLabUrl} className="flex items-center gap-2">
                <input
                  type="url"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="https://www.cloudskillsboost.google/focuses/... or https://partner.skills.google/..."
                  className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 font-mono focus:outline-none focus:border-cyan-500"
                />
                <button
                  type="submit"
                  disabled={syncingLab}
                  className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition shrink-0 disabled:opacity-60"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open & Sync
                </button>
              </form>
            )}

            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span className="truncate">
                {state.labTitle
                  ? `Loaded: ${state.labTitle}`
                  : 'Select your signed-in lab tab or paste a lab URL.'}
              </span>
              {selectedLabTab && (
                <button
                  type="button"
                  onClick={() => handleFocusChromeTarget(selectedLabTab.key)}
                  className="text-cyan-400 hover:text-cyan-300 font-medium shrink-0 ml-2 cursor-pointer"
                >
                  Focus Lab Tab
                </button>
              )}
            </div>
          </div>

          {/* STEP 3: Start & Run Lab Autonomously */}
          <div className="lg:col-span-4 rounded-xl bg-gradient-to-br from-slate-900 to-indigo-950/40 border border-indigo-500/30 p-3 flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-emerald-500 text-slate-950 text-[11px] font-bold flex items-center justify-center">
                  3
                </span>
                <span className="text-xs font-bold text-white">
                  Run Lab & Verify Progress Checks
                </span>
              </div>
              {state.isConsoleSignedIn && (
                <span className="px-2 py-0.5 text-[10px] font-mono rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  Incognito Ready
                </span>
              )}
            </div>

            <p className="text-[11px] text-slate-300 leading-snug">
              Starts the lab, spawns Incognito as the student account, runs all tasks, and clicks "Check my progress".
            </p>

            <div className="flex items-center gap-2">
              {!isRunning ? (
                <button
                  type="button"
                  onClick={handleStartAndRunLab}
                  disabled={startingAndRunning}
                  className="flex-1 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition shadow-md shadow-emerald-600/20 disabled:opacity-60"
                >
                  {startingAndRunning ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Launching...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-current" />
                      Start & Run Lab
                    </>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handlePause}
                  className="flex-1 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition"
                >
                  <Pause className="w-4 h-4 fill-current" />
                  Pause Execution
                </button>
              )}

              {state.tasks.some((t) => t.hasCheckProgress) && (
                <button
                  type="button"
                  onClick={handleCheckAllProgress}
                  disabled={checkingAllProgress}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-500/30 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition shrink-0 disabled:opacity-60"
                  title="Run Check my progress across all graded tasks"
                >
                  <CheckCircle2
                    className={`w-3.5 h-3.5 ${checkingAllProgress ? 'animate-spin' : ''}`}
                  />
                  Check Progress
                </button>
              )}

              {state.isLabStarted && (
                <button
                  type="button"
                  onClick={handleEndLab}
                  disabled={endingLab}
                  className="px-3 py-2 rounded-lg bg-red-600/20 hover:bg-red-600/35 text-red-200 border border-red-500/40 text-xs font-semibold flex items-center gap-1 cursor-pointer transition shrink-0 disabled:opacity-60"
                  title="Click End Lab in Chrome and clean up credentials"
                >
                  <Power className="w-3.5 h-3.5 text-red-400" />
                  {endingLab ? 'Ending...' : 'End Lab'}
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Login Notice Banner if awaiting user login */}
      {state.status === 'awaiting_login' && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-6 py-2.5">
          <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 text-amber-200 text-xs">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                <strong>Sign-In Needed in Chrome:</strong> Please sign into your Google Cloud Skills Boost account in the opened Chrome tab, then click{' '}
                <strong>"Start & Run Lab"</strong>.
              </span>
            </div>
            <button
              type="button"
              onClick={handleStartAndRunLab}
              className="px-3 py-1 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs cursor-pointer shrink-0"
            >
              I'm Signed In — Start & Run Lab
            </button>
          </div>
        </div>
      )}

      {/* Main Content Grid */}
      <main className="flex-1 max-w-[1600px] w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column (5 cols): Auto-Provisioned Student Account + Tasks & Progress Checklist */}
        <div className="lg:col-span-5 flex flex-col gap-5">
          {/* Student Credentials & Incognito Session Card */}
          <section className="rounded-xl bg-slate-900 border border-slate-800 p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3 gap-2">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-indigo-400" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  Lab Student Account (Auto-Spawned Incognito)
                </h2>
              </div>
              <div className="flex items-center gap-2">
                {selectedConsoleTab && (
                  <button
                    type="button"
                    onClick={() => handleFocusChromeTarget(selectedConsoleTab.key)}
                    className="px-2.5 py-1 rounded bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 text-[11px] font-medium flex items-center gap-1 cursor-pointer"
                  >
                    <ExternalLink className="w-3 h-3" /> Focus Incognito Console
                  </button>
                )}
                {selectedShellTab && (
                  <button
                    type="button"
                    onClick={() => handleFocusChromeTarget(selectedShellTab.key)}
                    className="px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 text-[11px] font-medium flex items-center gap-1 cursor-pointer"
                  >
                    <Terminal className="w-3 h-3" /> Focus Cloud Shell
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-slate-950/90 border border-slate-800/90 rounded-lg p-2.5 flex items-center justify-between">
                <div className="truncate pr-2">
                  <span className="text-[10px] uppercase text-slate-500 block">
                    Student Username
                  </span>
                  <span className="font-mono text-slate-200">
                    {state.credentials.username || 'Provisioned on Start'}
                  </span>
                </div>
                {state.credentials.username && (
                  <button
                    type="button"
                    onClick={() => copyToClipboard('user', state.credentials.username)}
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
                    {state.credentials.password || 'Provisioned on Start'}
                  </span>
                </div>
                {state.credentials.password && (
                  <button
                    type="button"
                    onClick={() => copyToClipboard('pass', state.credentials.password)}
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
                    onClick={() => copyToClipboard('proj', state.credentials.projectId)}
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
          </section>

          {/* Structured Lab Tasks & Progress Checks */}
          <section className="rounded-xl bg-slate-900 border border-slate-800 flex-1 flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Layers className="w-4 h-4 text-blue-400 shrink-0" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300 truncate">
                  {state.labTitle || 'Lab Tasks & Progress Checks'}
                </h2>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {state.tasks.some((t) => t.hasCheckProgress) && (
                  <button
                    type="button"
                    onClick={handleCheckAllProgress}
                    disabled={checkingAllProgress}
                    className="px-2.5 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-[11px] font-semibold cursor-pointer transition disabled:opacity-60"
                  >
                    {checkingAllProgress ? 'Checking...' : '✓ Check All Progress'}
                  </button>
                )}
                <span className="text-xs text-slate-400">
                  {state.tasks.length} Tasks
                </span>
              </div>
            </div>

            <div className="p-4 overflow-y-auto max-h-[680px] space-y-3">
              {state.tasks.length === 0 ? (
                <div className="text-center py-12 px-4 text-slate-400 text-xs space-y-2">
                  <FileSearch className="w-8 h-8 mx-auto text-slate-600 stroke-1" />
                  <p className="text-slate-200 font-semibold">
                    Ready to load your lab
                  </p>
                  <p className="text-slate-400 max-w-sm mx-auto leading-relaxed">
                    Select your open lab tab in <strong>Step 2</strong> above (or paste the lab URL) and click{' '}
                    <strong className="text-emerald-300">Start & Run Lab</strong>.
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

                                {step.commands.map((cmd, cIdx) => (
                                  <div
                                    key={cIdx}
                                    className="rounded bg-slate-950 border border-slate-800 p-2 font-mono text-[11px] text-slate-200 overflow-x-auto"
                                  >
                                    <div className="flex items-center justify-between mb-1 pb-1 border-b border-slate-800/80">
                                      <span className="text-[10px] text-slate-500">
                                        {step.targetSurface === 'antigravity'
                                          ? 'ANTIGRAVITY PROMPT'
                                          : 'COMMAND'}
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
                                          ▶ Run
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            copyToClipboard(`${step.id}-${cIdx}`, cmd)
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

        {/* Right Column (7 cols): Live Execution Stream + Connected Chrome Sessions + Collapsible Advanced Controls */}
        <div className="lg:col-span-7 flex flex-col gap-5">
          {/* Real-Time Execution & Progress Stream */}
          <section className="rounded-xl bg-slate-900 border border-slate-800 flex-1 flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-400" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  Live Lab Execution & Progress Check Log
                </h2>
              </div>
              <span className="text-[11px] text-slate-500 font-mono">
                {state.logs.length} events
              </span>
            </div>

            {state.lastThought && (
              <div className="mx-3 mt-3 rounded-lg bg-blue-950/40 border border-blue-500/30 px-3 py-2 text-xs text-blue-200 flex items-start gap-2">
                <Bot className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-blue-300">AI Reasoning: </span>
                  {state.lastThought}
                </div>
              </div>
            )}

            <div className="p-3 overflow-y-auto max-h-[460px] space-y-1.5 font-mono text-xs">
              {state.logs.length === 0 ? (
                <div className="text-slate-500 text-center py-12">
                  Connect the Mac Bridge, select your open Lab tab, and click "Start & Run Lab".
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

          {/* Active Chrome Windows Summary Card */}
          <section className="rounded-xl bg-slate-900 border border-slate-800 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-cyan-400" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  Active Chrome Sessions on Your Mac
                </h2>
              </div>
              <span className="text-[11px] text-slate-400">
                Incognito pages are spawned automatically when the lab starts
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              {/* Self-Signed-In Lab Page */}
              <div className="rounded-lg bg-slate-950 border border-slate-800 p-3 flex flex-col justify-between gap-2">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-cyan-300">
                      1. Your Signed-In Lab Page
                    </span>
                    {selectedLabTab && (
                      <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 text-[10px] font-mono">
                        Win #{selectedLabTab.windowIndex} • Tab #{selectedLabTab.tabIndex}
                      </span>
                    )}
                  </div>
                  <p className="text-slate-200 font-medium truncate">
                    {selectedLabTab?.title || state.labTitle || 'No Lab tab selected yet'}
                  </p>
                  <p className="text-[11px] font-mono text-slate-500 truncate">
                    {selectedLabTab?.url || state.labCurrentUrl || 'Select in Step 2 above'}
                  </p>
                </div>
                {selectedLabTab && (
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => handleFocusChromeTarget(selectedLabTab.key)}
                      className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 text-[11px] font-medium cursor-pointer"
                    >
                      Focus Lab Window
                    </button>
                  </div>
                )}
              </div>

              {/* Auto-Spawned Student Incognito Window */}
              <div className="rounded-lg bg-slate-950 border border-indigo-500/30 p-3 flex flex-col justify-between gap-2">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-indigo-300">
                      2. Lab Student Incognito Session
                    </span>
                    {selectedConsoleTab && (
                      <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 text-[10px] font-mono">
                        Incognito Win #{selectedConsoleTab.windowIndex}
                      </span>
                    )}
                  </div>
                  <p className="text-slate-200 font-medium truncate">
                    {selectedConsoleTab
                      ? `Signed in: ${state.credentials.username || selectedConsoleTab.title}`
                      : 'Spawns automatically when you click Start & Run Lab'}
                  </p>
                  <p className="text-[11px] font-mono text-slate-500 truncate">
                    {selectedConsoleTab?.url ||
                      state.consoleCurrentUrl ||
                      'GCP Console + Cloud Shell'}
                  </p>
                </div>
                {(selectedConsoleTab || selectedShellTab) && (
                  <div className="flex items-center gap-2 pt-1">
                    {selectedConsoleTab && (
                      <button
                        type="button"
                        onClick={() => handleFocusChromeTarget(selectedConsoleTab.key)}
                        className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-slate-700 text-[11px] font-medium cursor-pointer"
                      >
                        Focus Console
                      </button>
                    )}
                    {selectedShellTab && (
                      <button
                        type="button"
                        onClick={() => handleFocusChromeTarget(selectedShellTab.key)}
                        className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 text-[11px] font-medium cursor-pointer"
                      >
                        Focus Cloud Shell
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Collapsible Advanced & Manual Controls */}
          <section className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full px-4 py-3 flex items-center justify-between text-xs font-semibold text-slate-300 hover:bg-slate-800/50 cursor-pointer transition"
            >
              <span className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-slate-400" />
                Advanced & Manual Controls (Step-by-Step Mode, Custom Commands, Manual Overrides)
              </span>
              {showAdvanced ? (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              ) : (
                <ChevronRight className="w-4 h-4 text-slate-400" />
              )}
            </button>

            {showAdvanced && (
              <div className="p-4 border-t border-slate-800 space-y-4 text-xs">
                {/* Step Controls & Mode Switch */}
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-800">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400 font-medium">Execution Mode:</span>
                    <div className="inline-flex rounded-lg bg-slate-950 p-0.5 border border-slate-800">
                      <button
                        type="button"
                        onClick={() => handleModeChange('autonomous')}
                        className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${
                          state.executionMode === 'autonomous'
                            ? 'bg-blue-600 text-white'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Autonomous
                      </button>
                      <button
                        type="button"
                        onClick={() => handleModeChange('step_by_step')}
                        className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${
                          state.executionMode === 'step_by_step'
                            ? 'bg-blue-600 text-white'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Step-by-Step
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleRunSingleStep}
                      className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold flex items-center gap-1.5 cursor-pointer"
                    >
                      <Zap className="w-3.5 h-3.5" />
                      Execute Next Step
                    </button>
                    <button
                      type="button"
                      onClick={handleSkipStep}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-medium flex items-center gap-1 cursor-pointer"
                    >
                      <SkipForward className="w-3.5 h-3.5" />
                      Skip Step
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingCreds(!editingCreds)}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-medium cursor-pointer"
                    >
                      {editingCreds ? 'Close Credential Editor' : 'Edit Credentials'}
                    </button>
                  </div>
                </div>

                {/* Manual Credential Editor */}
                {editingCreds && (
                  <div className="grid grid-cols-2 gap-2.5 p-3 rounded-lg bg-slate-950 border border-slate-800">
                    <div className="col-span-2">
                      <label className="block text-slate-400 mb-1">Student Username</label>
                      <input
                        type="text"
                        value={credDraft.username}
                        onChange={(e) =>
                          setCredDraft({ ...credDraft, username: e.target.value })
                        }
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 font-mono text-slate-100"
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
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 font-mono text-slate-100"
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
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 font-mono text-slate-100"
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
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 font-mono text-slate-100"
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
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 font-mono text-slate-100"
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
                )}

                {/* Manual Incognito Tab Binding Overrides */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-indigo-300 mb-1">
                      Override Incognito Console Tab (Auto-Managed)
                    </label>
                    <select
                      value={state.selectedConsoleTabKey || ''}
                      onChange={(e) =>
                        handleBindChromeTargets({
                          consoleTabKey: e.target.value || null,
                        })
                      }
                      className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono"
                    >
                      <option value="">-- Auto-Spawned by Skills Runner --</option>
                      {chromeTabs.map((t) => (
                        <option key={t.key} value={t.key}>
                          {formatTabLabel(t)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-emerald-300 mb-1">
                      Override Cloud Shell Tab (Auto-Managed)
                    </label>
                    <select
                      value={state.selectedCloudShellTabKey || ''}
                      onChange={(e) =>
                        handleBindChromeTargets({
                          cloudShellTabKey: e.target.value || null,
                        })
                      }
                      className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono"
                    >
                      <option value="">-- Auto-Spawned by Skills Runner --</option>
                      {chromeTabs.map((t) => (
                        <option key={t.key} value={t.key}>
                          {formatTabLabel(t)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Direct Command & Prompt Dispatch */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-slate-800">
                  <form onSubmit={handleSendOverride} className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-semibold text-blue-300 flex items-center gap-1">
                      <Sparkles className="w-3.5 h-3.5" /> Guide AI on Current Step
                    </label>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={overrideInput}
                        onChange={(e) => setOverrideInput(e.target.value)}
                        placeholder="e.g. Use us-east1..."
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

                  <form
                    onSubmit={handleSendAntigravityPrompt}
                    className="flex flex-col gap-1.5"
                  >
                    <label className="text-[11px] font-semibold text-purple-300 flex items-center gap-1">
                      <Bot className="w-3.5 h-3.5" /> Send Antigravity Prompt
                    </label>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={antigravityInput}
                        onChange={(e) => setAntigravityInput(e.target.value)}
                        placeholder="Prompt agy in Cloud Shell..."
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

                  <form onSubmit={handleSendShellCommand} className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-semibold text-emerald-300 flex items-center gap-1">
                      <Terminal className="w-3.5 h-3.5" /> Run Cloud Shell Command
                    </label>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={shellInput}
                        onChange={(e) => setShellInput(e.target.value)}
                        placeholder="gcloud config list..."
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
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      {/* Mac Chrome Bridge Setup Modal */}
      {showBridgeModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-xl w-full shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center">
                  <Monitor className="w-5 h-5 text-cyan-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Step 1: Start the Mac Chrome Bridge
                  </h3>
                  <p className="text-xs text-slate-400">
                    {pendingActionLabel
                      ? `Will automatically continue "${pendingActionLabel}" as soon as connected`
                      : 'Connects Skills Runner to your desktop Chrome and spawns student Incognito sessions'}
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
              {canStartLocally && (
                <div className="rounded-xl bg-emerald-950/30 border border-emerald-500/30 p-3.5 flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold text-emerald-300">
                      Local macOS Server Detected
                    </div>
                    <p className="text-[11px] text-slate-300 mt-0.5">
                      Start the Mac Chrome Bridge process directly with one click:
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleStartMacBridge}
                    disabled={startingBridge}
                    className="px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center gap-1.5 cursor-pointer shrink-0 disabled:opacity-60"
                  >
                    {startingBridge ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Starting...
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-current" />
                        Start Bridge Now
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* Option 1: 1-Line Terminal Command */}
              <div className="space-y-2">
                <div className="font-semibold text-slate-100 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 flex items-center justify-center text-[11px] font-bold">
                    A
                  </span>
                  Run This 1-Line Command in macOS Terminal (Recommended)
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
                    className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold flex items-center gap-1.5 cursor-pointer shrink-0"
                  >
                    {copiedField === 'bridge-oneliner' ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copy Command
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Option 2: Download Launcher */}
              <div className="space-y-2">
                <div className="font-semibold text-slate-100 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 flex items-center justify-center text-[11px] font-bold">
                    B
                  </span>
                  Or Download the macOS Launcher
                </div>
                <div className="flex flex-wrap gap-2.5 pl-7 pt-1">
                  <a
                    href="/api/bridge/Start-Mac-Chrome-Bridge.command?download=1"
                    download="Start-Mac-Chrome-Bridge.command"
                    className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 font-semibold flex items-center gap-2 transition"
                  >
                    <Download className="w-4 h-4 text-cyan-400" />
                    Download Start-Mac-Chrome-Bridge.command
                  </a>
                </div>
              </div>

              <div className="rounded-xl bg-slate-950 border border-slate-800 p-3 text-[11px] text-slate-400 leading-relaxed">
                <strong className="text-slate-200">Tip for fastest Chrome automation:</strong> In Google Chrome's top menu bar, enable{' '}
                <code className="text-cyan-300">View → Developer → Allow JavaScript from Apple Events</code> so Skills Runner can sign into student Incognito windows silently.
              </div>
            </div>

            <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950/70 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-amber-300 font-mono">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-400" />
                Waiting for Mac Bridge connection...
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

      {/* Switch Lab Modal */}
      {showSwitchCourseModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-xl w-full rounded-2xl bg-slate-900 border border-slate-700/80 shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center">
                  <Layers className="w-4 h-4 text-indigo-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Switch to Another Lab</h3>
                  <p className="text-[11px] text-slate-400">
                    End the current lab and point at a new Google Cloud Skills Boost lab
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
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="font-semibold text-slate-200">
                    Select an Open Lab Tab in Chrome
                  </label>
                  <button
                    type="button"
                    onClick={handleScanChromeWindows}
                    disabled={scanningWindows}
                    className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1 cursor-pointer"
                  >
                    <RefreshCw className={`w-3 h-3 ${scanningWindows ? 'animate-spin' : ''}`} />
                    Refresh Tabs
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
                  {allLabSelectTabs.map((t) => (
                    <option key={t.key} value={t.key}>
                      {formatTabLabel(t)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="font-semibold text-slate-200 block">
                  Or Paste a Lab URL
                </label>
                <input
                  type="url"
                  value={newCourseUrl}
                  onChange={(e) => {
                    setNewCourseUrl(e.target.value);
                    if (e.target.value) setNewCourseTabKey('');
                  }}
                  placeholder="https://www.cloudskillsboost.google/focuses/... or https://partner.skills.google/..."
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-xs text-slate-100 placeholder-slate-500 font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>

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
                    Clicks "End Lab" and confirms termination so your next lab can start immediately.
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
                <FileSearch className="w-3.5 h-3.5" />
                Switch & Load Instructions
              </button>
              <button
                type="button"
                onClick={() => handleConfirmSwitchCourse(true)}
                disabled={switchingCourse}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition shadow-sm disabled:opacity-60"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                Switch, Start & Run Lab
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
