import 'dotenv/config';
import { spawn } from 'child_process';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  getSessionBridgeHub,
  getSessionOrchestrator,
  inferTargetTypeFromUrl,
  listActiveSessions,
  sanitizeSessionId,
} from './browserOrchestrator.js';
import { ExecutionMode } from './types.js';
import { routeIncomingBridgeSocket } from './macBridgeHub.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const wssBridge = new WebSocketServer({ noServer: true });

function extractSessionIdFromUpgradeReq(req: http.IncomingMessage): string {
  try {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const fromQuery = parsedUrl.searchParams.get('session') || parsedUrl.searchParams.get('sessionId');
    if (fromQuery) return sanitizeSessionId(fromQuery);
  } catch {
    // Ignore URL parse error
  }
  const fromHeader = req.headers['x-session-id'];
  if (typeof fromHeader === 'string' && fromHeader.trim()) {
    return sanitizeSessionId(fromHeader);
  }
  return 'default';
}

function resolveSessionId(req: express.Request): string {
  const headerVal = req.headers['x-session-id'];
  if (typeof headerVal === 'string' && headerVal.trim()) {
    return sanitizeSessionId(headerVal);
  }
  const queryVal = req.query.session || req.query.sessionId;
  if (typeof queryVal === 'string' && queryVal.trim()) {
    return sanitizeSessionId(queryVal);
  }
  const bodyVal = req.body?.sessionId || req.body?.session;
  if (typeof bodyVal === 'string' && bodyVal.trim()) {
    return sanitizeSessionId(bodyVal);
  }
  return 'default';
}

function getReqOrchestrator(req: express.Request) {
  const sessionId = resolveSessionId(req);
  return getSessionOrchestrator(sessionId);
}

server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '').split('?')[0];
  if (pathname === '/ws-bridge') {
    wssBridge.handleUpgrade(req, socket, head, (ws) => {
      wssBridge.emit('connection', ws, req);
    });
  } else if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const sessionId = extractSessionIdFromUpgradeReq(req);
  const sessionOrch = getSessionOrchestrator(sessionId);
  const unsubscribe = sessionOrch.subscribe((state) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'state', data: state }));
    }
  });

  ws.on('close', () => {
    unsubscribe();
  });
});

wssBridge.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  let requestedSession: string | null = null;
  try {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    requestedSession =
      parsedUrl.searchParams.get('session') || parsedUrl.searchParams.get('sessionId');
  } catch {
    // Ignore
  }
  routeIncomingBridgeSocket(requestedSession, ws, (sid) => getSessionBridgeHub(sid));
});

// Health endpoint
app.get('/api/health', (req, res) => {
  const orch = getReqOrchestrator(req);
  res.json({
    ok: true,
    service: 'skills-runner',
    sessionId: orch.sessionId,
    activeSessions: listActiveSessions().length,
    model: orch.getState().activeModel || process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    macBridgeConnected: orch.getState().macBridgeConnected,
    status: orch.getState().status,
  });
});

// Get current runner state for this browser session
app.get('/api/state', (req, res) => {
  const orch = getReqOrchestrator(req);
  res.json(orch.getState());
});

// Save current runner state to disk / Mac Bridge
app.post('/api/state/save', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const result = await orch.saveStateManual(false);
    res.json({ ...result, state: orch.getState() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 1. Open Lab or Course URL in Main Lab Chrome Window
app.post('/api/lab/open', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const { url, targetType } = req.body || {};
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'A valid Lab or Course URL is required.' });
      return;
    }
    const effectiveTargetType = inferTargetTypeFromUrl(url) || targetType;
    if (effectiveTargetType === 'course' || effectiveTargetType === 'lab') {
      orch.setTargetType(effectiveTargetType);
    }
    // Launch asynchronously and return immediately while streaming via WS
    orch.openLabUrl(url).catch((err) => {
      orch.addLog('error', 'lab_window', `Failed to open URL: ${err.message}`);
    });
    res.json({ ok: true, message: 'Launching Chrome window...' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 2. Parse Lab / Course Instructions (after login or refresh)
app.post('/api/lab/parse', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    await orch.parseLabInstructions();
    res.json({ ok: true, state: orch.getState() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 3. Click "Start Lab", extract student credentials, open Incognito window, and sign into GCP Console
app.post('/api/lab/start-and-signin', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    orch.startLabAndLaunchIncognito().catch((err) => {
      orch.addLog(
        'error',
        'incognito_console',
        `Start Lab / Console Sign-In error: ${err.message}`
      );
    });
    res.json({ ok: true, message: 'Starting lab and launching Incognito Console sign-in...' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 3b. Unified One-Click "Start & Run Lab / Course"
app.post('/api/lab/start-and-run', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const { url, labTabKey, targetType } = req.body || {};
    const inferredTargetType = inferTargetTypeFromUrl(typeof url === 'string' ? url : '');
    const effectiveTargetType = inferredTargetType || targetType;
    if (effectiveTargetType === 'course' || effectiveTargetType === 'lab') {
      orch.setTargetType(effectiveTargetType);
    }
    orch
      .startAndRunLab({
        url: typeof url === 'string' ? url : undefined,
        labTabKey: labTabKey !== undefined ? labTabKey : undefined,
      })
      .catch((err) => {
        orch.addLog(
          'error',
          'system',
          `Start & Run error: ${err?.message || String(err)}`
        );
      });
    res.json({
      ok: true,
      message:
        'Starting session and launching autonomous execution...',
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 4. Start or Resume Execution Loop (Autonomous or Single-Step)
app.post('/api/lab/run', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const { singleStep } = req.body || {};
    orch.startExecutionLoop(Boolean(singleStep)).catch((err) => {
      orch.addLog('error', 'system', `Execution error: ${err.message}`);
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 5. Pause Execution
app.post('/api/lab/pause', (req, res) => {
  const orch = getReqOrchestrator(req);
  orch.pauseExecution();
  res.json({ ok: true });
});

// 6. Skip Current Step
app.post('/api/lab/skip-step', (req, res) => {
  const orch = getReqOrchestrator(req);
  orch.skipCurrentStep();
  res.json({ ok: true });
});

// 6b. End Current Lab Session
app.post('/api/lab/end', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const result = await orch.endCurrentLab();
    res.json({ ok: true, ...result, state: orch.getState() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 6c. Switch / Run a Different Skill Course or Lab
app.post('/api/lab/switch-course', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const { url, labTabKey, endCurrentFirst, autoRun, targetType } = req.body || {};
    const effectiveTargetType =
      inferTargetTypeFromUrl(typeof url === 'string' ? url : '') || targetType;
    if (effectiveTargetType === 'course' || effectiveTargetType === 'lab') {
      orch.setTargetType(effectiveTargetType);
    }
    await orch.switchSkillCourse({
      url: typeof url === 'string' ? url : undefined,
      labTabKey: labTabKey !== undefined ? labTabKey : undefined,
      endCurrentFirst: Boolean(endCurrentFirst),
      autoRun: Boolean(autoRun),
    });
    res.json({ ok: true, state: orch.getState() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 6d. Reset for a New Lab (closes Incognito windows, ends active lab if requested, resets screen to initial state)
app.post('/api/lab/reset', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const { endLabInChrome = true, closeIncognito = true } = req.body || {};
    const result = await orch.resetForNewLab({
      endLabInChrome: Boolean(endLabInChrome),
      closeIncognito: Boolean(closeIncognito),
    });
    res.json({ ok: true, ...result, state: orch.getState() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 7. Toggle Execution Mode (autonomous vs step_by_step)
app.post('/api/lab/mode', (req, res) => {
  const orch = getReqOrchestrator(req);
  const mode: ExecutionMode =
    req.body?.mode === 'step_by_step' ? 'step_by_step' : 'autonomous';
  orch.setExecutionMode(mode);
  res.json({ ok: true, mode });
});

// 7b. Toggle Target Type (lab vs course)
app.post('/api/lab/target-type', (req, res) => {
  const orch = getReqOrchestrator(req);
  const targetType = orch.setTargetType(req.body?.targetType === 'course' ? 'course' : 'lab');
  res.json({ ok: true, targetType, state: orch.getState() });
});

// 8. Queue Live Operator Override Instruction for Gemini
app.post('/api/lab/override', (req, res) => {
  const orch = getReqOrchestrator(req);
  const { instruction } = req.body || {};
  orch.setOverrideInstruction(instruction || '');
  res.json({ ok: true });
});

// 9. Update Lab Credentials / Region / Zone manually
app.post('/api/lab/credentials', (req, res) => {
  const orch = getReqOrchestrator(req);
  orch.updateManualCredentials(req.body || {});
  res.json({ ok: true, credentials: orch.getState().credentials });
});

// 10. Open an active link from Lab Instructions directly in Incognito window
app.post('/api/lab/open-incognito-link', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const { url } = req.body || {};
    if (!url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    await orch.openUrlInIncognito(url);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 11. Trigger "Check my progress" for a specific task
app.post('/api/lab/check-progress', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const taskNumber = Number(req.body?.taskNumber || 1);
    await orch.checkTaskProgressManual(taskNumber);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 11b. Trigger "Check my progress" across all graded tasks
app.post('/api/lab/check-all-progress', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    await orch.checkAllTasksProgress();
    res.json({ ok: true, state: orch.getState() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 12. Send a direct prompt to Antigravity in the Cloud Console Incognito window
app.post('/api/lab/antigravity-prompt', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const { prompt } = req.body || {};
    if (!prompt) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    await orch.directAntigravityPrompt(prompt);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 13. Run a direct command in Cloud Shell inside the Incognito window
app.post('/api/lab/cloud-shell-cmd', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const { command } = req.body || {};
    if (!command) {
      res.status(400).json({ error: 'command is required' });
      return;
    }
    await orch.directCloudShellCommand(command);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 14. Scan all open user Chrome windows and tabs (Normal + Incognito)
app.post('/api/chrome/scan', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const tabs = await orch.scanOpenChromeWindows(false);
    res.json({ ok: true, tabs, state: orch.getState() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 15. Bind selected user Chrome windows/tabs for Lab (@google.com), Console (Incognito), and Cloud Shell / Antigravity
app.post('/api/chrome/bind', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const { labTabKey, consoleTabKey, cloudShellTabKey } = req.body || {};
    await orch.bindChromeTargets({
      labTabKey,
      consoleTabKey,
      cloudShellTabKey,
    });
    res.json({ ok: true, state: orch.getState() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 16. Bring a specific user Chrome window/tab to the front
app.post('/api/chrome/focus', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const { key } = req.body || {};
    if (!key) {
      res.status(400).json({ error: 'key is required' });
      return;
    }
    await orch.focusChromeTarget(key);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 16b. Model Garden Checker & Selector (Gemini 3.8 Flash, Gemini 3.1 Pro, Opus 5.5)
app.get('/api/models/garden', (req, res) => {
  const orch = getReqOrchestrator(req);
  const st = orch.getState();
  res.json({
    ok: true,
    activeModel: st.activeModel || 'gemini-3.8-flash',
    modelGarden: st.modelGarden || [],
  });
});

app.post('/api/models/check', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const modelGarden = await orch.checkModels();
    const st = orch.getState();
    res.json({
      ok: true,
      activeModel: st.activeModel || 'gemini-3.8-flash',
      modelGarden,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/models/select', (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const model = req.body?.model || req.body?.modelId;
    if (!model || typeof model !== 'string') {
      res.status(400).json({ error: 'model is required' });
      return;
    }
    const activeModel = orch.selectModel(model);
    const st = orch.getState();
    res.json({
      ok: true,
      activeModel,
      modelGarden: st.modelGarden || [],
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 17. Mac Bridge Status, Download & Stop Endpoints
function resolvePublicBaseUrls(req: express.Request, sessionId?: string) {
  const protoHeader = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const isHttps = protoHeader.includes('https') || (req.headers.host || '').includes('.run.app');
  const httpProto = isHttps ? 'https' : 'http';
  const wsProto = isHttps ? 'wss' : 'ws';
  const host = req.headers.host || 'skills-runner-621653283297.us-central1.run.app';
  const cleanSession = sessionId && sessionId !== 'default' ? `?session=${encodeURIComponent(sessionId)}` : '';
  return {
    httpBase: `${httpProto}://${host}`,
    wsUrl: `${wsProto}://${host}/ws-bridge${cleanSession}`,
  };
}

app.get('/api/bridge/status', (req, res) => {
  const orch = getReqOrchestrator(req);
  const { httpBase, wsUrl } = resolvePublicBaseUrls(req, orch.sessionId);
  res.json({
    ok: true,
    sessionId: orch.sessionId,
    connected: Boolean(orch.getState().macBridgeConnected),
    canStartLocally: process.platform === 'darwin',
    wsUrl,
    httpBase,
  });
});

app.post('/api/bridge/start', async (req, res) => {
  try {
    const orch = getReqOrchestrator(req);
    const hub = orch.getBridgeHub();
    if (hub.isConnected()) {
      await orch.scanOpenChromeWindows(false);
      res.json({ ok: true, started: true, state: orch.getState() });
      return;
    }

    if (process.platform !== 'darwin') {
      res.status(400).json({
        ok: false,
        started: false,
        error:
          'Server is running remotely on Cloud Run. Run the 1-line terminal command or Start-Mac-Chrome-Bridge.command on your Mac.',
      });
      return;
    }

    const { wsUrl } = resolvePublicBaseUrls(req, orch.sessionId);
    const agentPath = path.resolve(__dirname, 'macBridgeAgent.ts');
    const child = spawn(process.execPath, [agentPath, `--session=${orch.sessionId}`], {
      env: {
        ...process.env,
        CLOUD_RUN_WS_URL: wsUrl,
        SKILLS_RUNNER_SESSION_ID: orch.sessionId,
      },
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    for (let i = 0; i < 20; i++) {
      if (hub.isConnected()) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    if (hub.isConnected()) {
      await orch.scanOpenChromeWindows(false);
    }

    res.json({
      ok: true,
      started: hub.isConnected(),
      state: orch.getState(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/bridge/stop', (req, res) => {
  const orch = getReqOrchestrator(req);
  const stopped = orch.getBridgeHub().shutdownClient();
  orch.addLog(
    'info',
    'system',
    stopped
      ? 'Stopped local Mac Chrome Bridge agent for this session.'
      : 'Mac Chrome Bridge is already stopped.'
  );
  res.json({ ok: true, stopped, state: orch.getState() });
});

app.get(['/api/bridge/macBridgeAgent.ts', '/api/bridge/macBridgeAgent.mjs'], (req, res) => {
  try {
    const sessionId = resolveSessionId(req);
    const { wsUrl } = resolvePublicBaseUrls(req, sessionId);
    const agentPath = path.resolve(__dirname, 'macBridgeAgent.ts');
    let code = fs.readFileSync(agentPath, 'utf8');
    code = code.replace(
      /'wss:\/\/[^']+\/ws-bridge'/,
      `'${wsUrl}'`
    );
    const isMjs = req.path.endsWith('.mjs');
    const filename = isMjs ? 'macBridgeAgent.mjs' : 'macBridgeAgent.ts';
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }
    res.send(code);
  } catch (err: any) {
    res.status(500).send(`// Failed to load macBridgeAgent.ts: ${err?.message || String(err)}`);
  }
});

app.get(['/api/bridge/start.sh', '/api/bridge/Start-Mac-Chrome-Bridge.command'], (req, res) => {
  const sessionId = resolveSessionId(req);
  const { httpBase, wsUrl } = resolvePublicBaseUrls(req, sessionId);
  const isCommandFile = req.path.endsWith('.command');
  const sessionQuery =
    sessionId && sessionId !== 'default' ? `?session=${encodeURIComponent(sessionId)}` : '';
  const script = `#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/opt/homebrew/share/google-cloud-sdk/bin:/usr/local/bin:/usr/local/sbin:/usr/local/share/google-cloud-sdk/bin:/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin:$HOME/google-cloud-sdk/bin:$HOME/.volta/bin:$HOME/.asdf/shims:$PATH"
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM_NODE="$(ls -1d "$HOME/.nvm/versions/node/"* 2>/dev/null | tail -n 1 || true)"
  if [ -n "$LATEST_NVM_NODE" ] && [ -d "$LATEST_NVM_NODE/bin" ]; then
    export PATH="$LATEST_NVM_NODE/bin:$PATH"
  fi
fi

BRIDGE_DIR="$HOME/Downloads/skill-runner"
mkdir -p "$BRIDGE_DIR" "$HOME/.cloud-skills-lab-runner"
AGENT_MJS="$BRIDGE_DIR/macBridgeAgent.mjs"
AGENT_TS="$BRIDGE_DIR/macBridgeAgent.ts"
PKG_FILE="$BRIDGE_DIR/package.json"

if [ ! -f "$PKG_FILE" ]; then
  echo '{"name":"skills-runner-bridge","private":true,"type":"module"}' > "$PKG_FILE"
fi

if [ -n "${sessionId !== 'default' ? sessionId : ''}" ]; then
  echo "${sessionId !== 'default' ? sessionId : ''}" > "$HOME/.cloud-skills-lab-runner/session_id"
fi

echo "⬇️  Saving latest On-Demand Mac Chrome Bridge to $BRIDGE_DIR..."
curl -fsSL "${httpBase}/api/bridge/macBridgeAgent.mjs${sessionQuery}" -o "$AGENT_MJS" || true
cp -f "$AGENT_MJS" "$AGENT_TS" 2>/dev/null || true
chmod +x "$AGENT_MJS" "$AGENT_TS" 2>/dev/null || true

echo "🚀 Starting Mac Chrome Bridge (Session: ${sessionId})..."
export CLOUD_RUN_WS_URL="${wsUrl}"
export SKILLS_RUNNER_SESSION_ID="${sessionId}"
exec node "$AGENT_MJS" --session="${sessionId}"
`;
  res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
  if (isCommandFile || req.query.download === '1') {
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="Start-Mac-Chrome-Bridge.command"'
    );
  }
  res.send(script);
});

// Serve built frontend in production mode
const distDir = path.resolve(__dirname, '../dist');
app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) res.status(200).send('Frontend dev server runs on http://localhost:5173');
  });
});

const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Skills Runner API & WS Server listening on http://0.0.0.0:${PORT}`);
});
