import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { orchestrator } from './browserOrchestrator.js';
import { ExecutionMode } from './types.js';

import { macBridgeHub } from './macBridgeHub.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const wssBridge = new WebSocketServer({ noServer: true });

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

wss.on('connection', (ws: WebSocket) => {
  const unsubscribe = orchestrator.subscribe((state) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'state', data: state }));
    }
  });

  ws.on('close', () => {
    unsubscribe();
  });
});

wssBridge.on('connection', (ws: WebSocket) => {
  macBridgeHub.registerClient(ws);
});

// Health endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'skills-runner',
    model: orchestrator.getState().activeModel || process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    macBridgeConnected: orchestrator.getState().macBridgeConnected,
    status: orchestrator.getState().status,
  });
});

// Get current runner state
app.get('/api/state', (_req, res) => {
  res.json(orchestrator.getState());
});

// 1. Open Lab URL in Main Lab Chrome Window
app.post('/api/lab/open', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'A valid Lab URL is required.' });
      return;
    }
    // Launch asynchronously and return immediately while streaming via WS
    orchestrator.openLabUrl(url).catch((err) => {
      orchestrator.addLog('error', 'lab_window', `Failed to open Lab URL: ${err.message}`);
    });
    res.json({ ok: true, message: 'Launching Lab Chrome window...' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 2. Parse Lab Instructions (after login or refresh)
app.post('/api/lab/parse', async (_req, res) => {
  try {
    await orchestrator.parseLabInstructions();
    res.json({ ok: true, state: orchestrator.getState() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 3. Click "Start Lab", extract student credentials, open Incognito window, and sign into GCP Console
app.post('/api/lab/start-and-signin', async (_req, res) => {
  try {
    orchestrator.startLabAndLaunchIncognito().catch((err) => {
      orchestrator.addLog(
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

// 4. Start or Resume Execution Loop (Autonomous or Single-Step)
app.post('/api/lab/run', async (req, res) => {
  try {
    const { singleStep } = req.body || {};
    orchestrator.startExecutionLoop(Boolean(singleStep)).catch((err) => {
      orchestrator.addLog('error', 'system', `Execution error: ${err.message}`);
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 5. Pause Execution
app.post('/api/lab/pause', (_req, res) => {
  orchestrator.pauseExecution();
  res.json({ ok: true });
});

// 6. Skip Current Step
app.post('/api/lab/skip-step', (_req, res) => {
  orchestrator.skipCurrentStep();
  res.json({ ok: true });
});

// 7. Toggle Execution Mode (autonomous vs step_by_step)
app.post('/api/lab/mode', (req, res) => {
  const mode: ExecutionMode =
    req.body?.mode === 'step_by_step' ? 'step_by_step' : 'autonomous';
  orchestrator.setExecutionMode(mode);
  res.json({ ok: true, mode });
});

// 8. Queue Live Operator Override Instruction for Gemini
app.post('/api/lab/override', (req, res) => {
  const { instruction } = req.body || {};
  orchestrator.setOverrideInstruction(instruction || '');
  res.json({ ok: true });
});

// 9. Update Lab Credentials / Region / Zone manually
app.post('/api/lab/credentials', (req, res) => {
  orchestrator.updateManualCredentials(req.body || {});
  res.json({ ok: true, credentials: orchestrator.getState().credentials });
});

// 10. Open an active link from Lab Instructions directly in Incognito window
app.post('/api/lab/open-incognito-link', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    await orchestrator.openUrlInIncognito(url);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 11. Trigger "Check my progress" for a specific task
app.post('/api/lab/check-progress', async (req, res) => {
  try {
    const taskNumber = Number(req.body?.taskNumber || 1);
    await orchestrator.checkTaskProgressManual(taskNumber);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 12. Send a direct prompt to Antigravity in the Cloud Console Incognito window
app.post('/api/lab/antigravity-prompt', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    await orchestrator.directAntigravityPrompt(prompt);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 13. Run a direct command in Cloud Shell inside the Incognito window
app.post('/api/lab/cloud-shell-cmd', async (req, res) => {
  try {
    const { command } = req.body || {};
    if (!command) {
      res.status(400).json({ error: 'command is required' });
      return;
    }
    await orchestrator.directCloudShellCommand(command);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 14. Scan all open user Chrome windows and tabs (Normal + Incognito)
app.post('/api/chrome/scan', async (_req, res) => {
  try {
    const tabs = await orchestrator.scanOpenChromeWindows(false);
    res.json({ ok: true, tabs, state: orchestrator.getState() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 15. Bind selected user Chrome windows/tabs for Lab (@google.com), Console (Incognito), and Cloud Shell / Antigravity
app.post('/api/chrome/bind', async (req, res) => {
  try {
    const { labTabKey, consoleTabKey, cloudShellTabKey } = req.body || {};
    await orchestrator.bindChromeTargets({
      labTabKey,
      consoleTabKey,
      cloudShellTabKey,
    });
    res.json({ ok: true, state: orchestrator.getState() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 16. Bring a specific user Chrome window/tab to the front
app.post('/api/chrome/focus', async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key) {
      res.status(400).json({ error: 'key is required' });
      return;
    }
    await orchestrator.focusChromeTarget(key);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 17. Mac Bridge Status, Download & Stop Endpoints
function resolvePublicBaseUrls(req: express.Request) {
  const protoHeader = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const isHttps = protoHeader.includes('https') || (req.headers.host || '').includes('.run.app');
  const httpProto = isHttps ? 'https' : 'http';
  const wsProto = isHttps ? 'wss' : 'ws';
  const host = req.headers.host || 'skills-runner-621653283297.us-central1.run.app';
  return {
    httpBase: `${httpProto}://${host}`,
    wsUrl: `${wsProto}://${host}/ws-bridge`,
  };
}

app.get('/api/bridge/status', (req, res) => {
  const { httpBase, wsUrl } = resolvePublicBaseUrls(req);
  res.json({
    ok: true,
    connected: Boolean(orchestrator.getState().macBridgeConnected),
    wsUrl,
    httpBase,
  });
});

app.post('/api/bridge/stop', (_req, res) => {
  const stopped = macBridgeHub.shutdownClient();
  orchestrator.addLog(
    'info',
    'system',
    stopped
      ? 'Stopped local Mac Chrome Bridge agent.'
      : 'Mac Chrome Bridge is already stopped.'
  );
  res.json({ ok: true, stopped, state: orchestrator.getState() });
});

app.get(['/api/bridge/macBridgeAgent.ts', '/api/bridge/macBridgeAgent.mjs'], (req, res) => {
  try {
    const { wsUrl } = resolvePublicBaseUrls(req);
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
  const { httpBase, wsUrl } = resolvePublicBaseUrls(req);
  const isCommandFile = req.path.endsWith('.command');
  const script = `#!/usr/bin/env bash
set -euo pipefail

BRIDGE_DIR="$HOME/Downloads/skill-runner"
mkdir -p "$BRIDGE_DIR"
AGENT_FILE="$BRIDGE_DIR/macBridgeAgent.ts"
PKG_FILE="$BRIDGE_DIR/package.json"

if [ ! -f "$PKG_FILE" ]; then
  echo '{"name":"skills-runner-bridge","private":true,"type":"module"}' > "$PKG_FILE"
fi

echo "⬇️  Saving latest On-Demand Mac Chrome Bridge to $AGENT_FILE..."
curl -fsSL "${httpBase}/api/bridge/macBridgeAgent.ts" -o "$AGENT_FILE" || true
chmod +x "$AGENT_FILE"

echo "🚀 Starting Mac Chrome Bridge from $AGENT_FILE (Passive Mode — zero background polling)..."
export CLOUD_RUN_WS_URL="${wsUrl}"
exec node "$AGENT_FILE"
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
