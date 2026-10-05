# Skills Runner — Universal Autonomous GCP & Antigravity Lab Agent

[![Cloud Run Deployed](https://img.shields.io/badge/Cloud_Run-Deployed-4285F4?logo=googlecloud&logoColor=white)](https://skills-runner-621653283297.us-central1.run.app)
[![Model Garden](https://img.shields.io/badge/Model_Garden-Gemini_3.8_Flash_%7C_3.1_Pro_%7C_Opus_5.5-4285F4?logo=google&logoColor=white)](https://cloud.google.com/vertex-ai)
[![Playwright](https://img.shields.io/badge/Automation-Playwright_%2B_Mac_Bridge-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev/)
[![Node.js 22+](https://img.shields.io/badge/Runtime-Node.js_22+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript_5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

## 1. Title & Executive Overview

**Skills Runner** (`skills-runner`) is a cloud-hosted web control center and hybrid browser/SSH automation agent that autonomously executes and verifies structured **Google Cloud Skills Boost (Qwiklabs)** and **Google Skills for Partners** hands-on labs and Challenge Labs.

### Business Rationale, Public Sector Impact & Strategic Intent
Public sector cloud engineers, state and local government technical architects, and delivery partners regularly complete complex hands-on Google Cloud labs spanning **Vertex AI**, **Agent Development Kit (ADK)**, **Discovery Engine**, **BigQuery**, **Terraform**, **Cloud Run**, and **Antigravity (`agy`)**. Manual execution of multi-step labs—especially when debugging grader rubrics, configuring isolated student environments, and reconciling multi-turn agent evaluations—consumes hours of engineering time.

**Skills Runner** pairs a stateless **Google Cloud Run** orchestration dashboard with a lightweight, on-demand **Mac Chrome Bridge** (`macBridgeAgent.ts`) that connects only when a lab is actively running. It introspects live student Cloud Shell workspaces, synthesizes stateful end-to-end bash and Python solutions powered by **`gemini-3.8-flash`**, executes them directly in the student's Cloud Shell VM or Incognito GCP Console, and closes the loop with a **3-attempt self-healing grader verification cycle** against Qwiklabs' **"Check my progress"** assessment API.

---

## 2. Architecture & Technology Stack

- **Runtime & Backend**: Node.js 22+, Express 4, dual WebSocket servers (`ws` for real-time UI state streaming on `/ws` and on-demand Mac Chrome Bridge RPC on `/ws-bridge`), TypeScript (`tsx`)
- **Frontend UI**: React 19, Vite 6, Tailwind CSS v4, Lucide Icons
- **AI Reasoning & Code Synthesis Engine (Vertex AI Model Garden)**:
  - Built-in **Model Garden Checker & Selector** probing live enablement and latency across:
    - **`gemini-3.8-flash`** (Google — Default Fast Multimodal Synthesis)
    - **`gemini-3.1-pro-preview`** (Google — Advanced Reasoning)
    - **`claude-opus-5-5`** (Anthropic on Vertex AI Model Garden `rawPredict`)
  - Dual Authentication: Supports Vertex AI Application Default Credentials (`GOOGLE_GENAI_USE_VERTEXAI=true`), `GEMINI_API_KEY`, and automatic Vertex AI REST fallback using the active Qwiklabs student's GCP project token
- **Cloud Infrastructure & Containerization**:
  - Hosted on **Google Cloud Run** (`us-central1`) using `mcr.microsoft.com/playwright:v1.58.2-noble`
  - Local on-demand bridge (`~/Downloads/skill-runner/macBridgeAgent.ts` & `Start-Mac-Chrome-Bridge.command`) for zero-polling AppleScript tab binding and isolated `CLOUDSDK_CONFIG` Cloud Shell SSH execution

### Repository Directory Tree
```text
skills-runner/
├── Dockerfile                     # Production Playwright + Node 22 container image for Cloud Run
├── .dockerignore
├── .gitignore
├── deploy.sh                      # Automated Cloud Run deployment script
├── index.html
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── README.md
├── server/
│   ├── index.ts                   # Express HTTP API + /ws UI & /ws-bridge RPC servers
│   ├── types.ts                   # Shared domain models (Tasks, Steps, Credentials, Model Garden, Bridge RPC)
│   ├── browserOrchestrator.ts     # Stateful task execution loop & self-healing grader
│   ├── geminiClient.ts            # Model Garden checker + Gemini 3.8 Flash / 3.1 Pro / Opus 5.5 synthesizer
│   ├── labParser.ts               # Deep Shadow-DOM parser for <ql-*> web components & templates
│   ├── nativeChromeBridge.ts      # Hybrid local/remote Chrome tab & Cloud Shell SSH + Vertex Workbench bridge
│   ├── macBridgeHub.ts            # Cloud Run WebSocket RPC hub for connected Mac bridge agents
│   ├── macBridgeAgent.ts          # Downloadable on-demand macOS Chrome & Cloud Shell agent
│   ├── consoleSignIn.ts           # Automated Qwiklabs student sign-in & GCP ToS modal handler
│   ├── pageInspector.ts           # Set-of-Marks (SoM) DOM inspector & zero-touch Antigravity handler
│   └── selfTest.ts                # End-to-end automated verification & regression test suite
└── src/
    ├── main.tsx
    ├── App.tsx                    # Web Control Center UI + 4-Tile Workflow + Model Garden Selector
    ├── index.css
    └── types.ts
```

---

## 3. Core Capabilities & Key Features

1. **Vertex AI Model Garden Checker & Selector**:
   - Live status checker (`POST /api/models/check`) and model switcher (`POST /api/models/select`) for **`gemini-3.8-flash`**, **`gemini-3.1-pro-preview`**, and **`claude-opus-5-5`** in `ice-cream-cone-452722` (`locations/global`).
   - Displays real-time availability badges and round-trip latency (`ms`) in the UI header and Model Garden card.
2. **Dedicated "Launch Incognito Console & Cloud Shell" Workflow Tile**:
   - Assumes the operator launches the initial Incognito Chrome window signed in as the student account (`student-...@qwiklabs.net`) for **Cloud Console** and **Cloud Shell**, and never closes or resets the user's open Incognito windows.
   - Provides 1-click copy chips for the Student Username, Password, Project ID, Console URL, and Cloud Shell URL, plus live tab detection badges (`✓ Console Tab Open`, `✓ Cloud Shell Open`) and a `Verify Tabs` button.
3. **On-Demand Mac Chrome Bridge (Zero Background Polling)**:
   - When starting or parsing a lab from the Cloud Run web app, the UI checks whether the local Mac Chrome Bridge (`macBridgeAgent.ts`) is connected.
   - If not running, operators can download a 1-click launcher (`Start-Mac-Chrome-Bridge.command`) that automatically saves and updates `~/Downloads/skill-runner/macBridgeAgent.ts` and connects over `wss://.../ws-bridge`.
4. **Deep Shadow-DOM Lab Parser & Template Interpolation**:
   - Pierces modern `<ql-lab-header>`, `<ql-copyable-input>`, `<ql-code-block>`, `<ql-activity-tracking>`, and Declarative Shadow DOM templates.
   - Automatically resolves Qwiklabs template expressions including piped default filters (`{{{ project_0.project_id | "your-gcp-project-id" }}}`, `{{{ primary_project.project_id | "your-gcp-project-id" }}}`) against live student credentials.
5. **Live Student Cloud Shell, Vertex AI Workbench (`wb_helper`) & Grader Audit Introspection**:
   - Connects to the student's isolated Cloud Shell VM via `gcloud cloud-shell ssh` and inspects the directory tree (`~`), starter code, project GCS buckets, Vertex AI Workbench instances (`wb_helper.py` auto-repair and execution for Jupyter `.ipynb` labs such as `evaluation.ipynb`), and the live **Qwiklabs Grader Audit Trail**.
6. **Unified Stateful Task Synthesis & 4-Attempt Self-Healing Grader Verification**:
   - Synthesizes idempotent bash and Python scripts per task, preserves Python indentation across heredocs, clicks **"Check my progress"** via the Qwiklabs assessment API, and self-heals up to 4 attempts per task until all progress checks pass.

### Operator Workflow: 4-Tile Guided Execution
1. **Tile 1 — Connect Mac Bridge**:
   - Sign into your Google Cloud Skills Boost / Partner Skills account in your normal desktop Google Chrome browser and connect the Mac Bridge.
2. **Tile 2 — Point at Lab Tab**:
   - Select your open Lab Instructions tab from the dropdown (or paste the Lab URL) and click **Start Lab & Get Creds** to extract the student `username`, `password`, and `projectId`.
3. **Tile 3 — Launch Incognito Console & Cloud Shell**:
   - Open an Incognito Chrome window (`⌘+Shift+N`), sign in with the copied Student Username & Password, open **Cloud Console** and activate **Cloud Shell**, then click **Verify Tabs**.
4. **Tile 4 — Run Lab & Pass Progress Checks**:
   - Choose your preferred Model Garden model (**Gemini 3.8 Flash**, **Gemini 3.1 Pro**, or **Opus 5.5**) and click **Run Lab & Pass Checks**.

---

## 4. API & Interface Reference

| Endpoint | Method | Parameters / Payload | Description |
| :--- | :--- | :--- | :--- |
| `/api/health` | `GET` | — | Service health check, active Model Garden model, and Mac Bridge connection status |
| `/api/state` | `GET` | — | Returns complete `RunnerState` (tasks, scores, credentials, Model Garden status, Chrome tabs, logs) |
| `/api/state/save` | `POST` | `{}` | Persists current `RunnerState` to `~/.cloud-skills-lab-runner/runner_state.json` on disk and via Mac Bridge |
| `/api/models/garden` | `GET` | — | Returns active model and cached Model Garden entries (`gemini-3.8-flash`, `gemini-3.1-pro-preview`, `claude-opus-5-5`) |
| `/api/models/check` | `POST` | `{}` | Probes live enablement and latency (`ms`) for `gemini-3.8-flash`, `gemini-3.1-pro-preview`, and `claude-opus-5-5` in Model Garden |
| `/api/models/select` | `POST` | `{ "model": "gemini-3.8-flash" \| "gemini-3.1-pro-preview" \| "claude-opus-5-5" }` | Switches the active model used for task synthesis and planning |
| `/api/chrome/scan` | `POST` | `{}` | Scans open macOS Google Chrome windows/tabs (Normal + Incognito) and classifies `lab`, `console`, and `cloud_shell` roles |
| `/api/chrome/bind` | `POST` | `{ "labTabKey": "win:tab", "consoleTabKey": "win:tab" }` | Binds selected Chrome tabs and snapshots the Lab DOM |
| `/api/chrome/focus` | `POST` | `{ "key": "win:tab" }` | Brings a specific Chrome window and tab to the foreground |
| `/api/lab/open` | `POST` | `{ "url": "https://..." }` | Opens a Lab URL in Chrome and parses instructions |
| `/api/lab/parse` | `POST` | `{}` | Syncs the bound Lab tab DOM, parses tasks/credentials, and polls live assessment scores |
| `/api/lab/start-and-signin` | `POST` | `{}` | Clicks "Start Lab", extracts student credentials, and scans for the user's open Incognito Console & Cloud Shell tabs |
| `/api/lab/start-and-run` | `POST` | `{ "labTabKey": "win:tab", "url": "https://..." }` | Unified pipeline: binds/opens the lab tab, starts the lab, attaches to the user's Incognito Console & Cloud Shell tabs, runs all tasks, and verifies progress checks |
| `/api/lab/run` | `POST` | `{ "singleStep": false }` | Starts or resumes the autonomous task execution & verification loop |
| `/api/lab/pause` | `POST` | `{}` | Pauses the active execution loop |
| `/api/lab/skip-step` | `POST` | `{}` | Skips the currently active step |
| `/api/lab/end` | `POST` | `{}` | Stops execution, clicks "End Lab" + confirms termination in Google Chrome, and clears expired credentials |
| `/api/lab/switch-course` | `POST` | `{ "url": "...", "labTabKey": "win:tab", "endCurrentFirst": true, "autoRun": true }` | Ends the active lab (optional), resets state, switches to a new Skill Course URL or Chrome tab, and optionally starts autonomous execution |
| `/api/lab/mode` | `POST` | `{ "mode": "autonomous" \| "step_by_step" }` | Switches between Autonomous and Step-by-Step execution modes |
| `/api/lab/override` | `POST` | `{ "instruction": "..." }` | Queues a live operator override instruction for the next synthesis turn |
| `/api/lab/credentials` | `POST` | `{ "projectId": "...", "region": "..." }` | Manually updates or overrides extracted lab credentials and re-interpolates commands |
| `/api/lab/check-progress` | `POST` | `{ "taskNumber": 1 }` | Triggers "Check my progress" for a specific task and updates task/total scores |
| `/api/lab/check-all-progress` | `POST` | `{}` | Triggers "Check my progress" across all graded tasks in the lab |
| `/api/lab/cloud-shell-cmd` | `POST` | `{ "command": "..." }` | Executes a command directly in the student's Cloud Shell environment |
| `/api/lab/antigravity-prompt` | `POST` | `{ "prompt": "..." }` | Injects a prompt into Antigravity in the Cloud Console |
| `/api/bridge/status` | `GET` | — | Returns `{ connected, canStartLocally, wsUrl, httpBase }` for the local Mac Chrome Bridge |
| `/api/bridge/start` | `POST` | `{}` | Launches `macBridgeAgent` directly when the server is running locally on macOS |
| `/api/bridge/stop` | `POST` | `{}` | Cleanly terminates the connected local `macBridgeAgent` process |
| `/api/bridge/macBridgeAgent.mjs` | `GET` | — | Serves the latest `macBridgeAgent` (`.mjs` / `.ts`) pre-configured with the server's `ws://` or `wss://` endpoint |
| `/api/bridge/Start-Mac-Chrome-Bridge.command` | `GET` | — | Downloads the 1-click macOS launcher (`Start-Mac-Chrome-Bridge.command`) that syncs into `~/Downloads/skill-runner/` |

---

## 5. Local Setup & Development Runbook

### Prerequisites
- macOS with **Google Chrome** (`/Applications/Google Chrome.app`) and **Google Cloud SDK** (`gcloud`) installed
- Node.js `v22+` and `npm`
- Google Cloud authentication (`gcloud auth login` / `gcloud auth application-default login`) or `GEMINI_API_KEY`

### Environment Variables
```bash
export GOOGLE_GENAI_USE_VERTEXAI="true"
export GOOGLE_CLOUD_PROJECT="ice-cream-cone-452722"
export GOOGLE_CLOUD_LOCATION="global"
export GEMINI_MODEL="gemini-3.8-flash"
# Optional if using Gemini Developer API instead of Vertex AI ADC:
# export GEMINI_API_KEY="$(gcloud secrets versions access latest --secret=gemini-api-key)"
```

### Step-by-Step Local Development Commands
```bash
# 1. Clone the repository and install dependencies
git clone https://github.com/eldo1711/skill-runner.git
cd skills-runner
npm install

# 2. Run the automated verification test suite
npm test

# 3. Build the production frontend bundle
npm run build

# 4. Start the local server on http://localhost:8080 (or hot-reload dev mode)
npm start
# Or for hot-reload development:
npm run dev
```

---

## 6. Cloud Deployment Guide

### Automated Deployment via `deploy.sh`
The repository includes [`deploy.sh`](deploy.sh) for repeatable one-command deployments to Google Cloud Run (`us-central1`):

```bash
./deploy.sh
```

### Direct `gcloud run deploy` Command
```bash
gcloud run deploy skills-runner \
  --source . \
  --project ice-cream-cone-452722 \
  --region us-central1 \
  --allow-unauthenticated \
  --max-instances 1 \
  --memory 2Gi \
  --cpu 2 \
  --timeout 3600 \
  --set-env-vars="NODE_ENV=production,HEADLESS=true,GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=ice-cream-cone-452722,GOOGLE_CLOUD_LOCATION=global" \
  --quiet
```

### Traffic Rollback Command
```bash
gcloud run services update-traffic skills-runner \
  --region us-central1 \
  --to-revisions <REVISION_NAME>=100
```

---

## 7. Security, Governance & Data Boundaries

- **Strict Credential & Profile Isolation**: Temporary Qwiklabs student credentials (`student-xx@qwiklabs.net`) are isolated inside dedicated per-student `CLOUDSDK_CONFIG` directories and `--incognito` browser windows, preventing any cross-contamination with corporate or agency Google accounts.
- **Zero Hardcoded Secrets**: No API keys, OAuth tokens, or service account keys are stored in source code or container images. Authentication relies on Cloud Run Workload Identity / ADC or runtime environment variables.
- **Compliance & Public Sector Data Boundaries**: Designed strictly for ephemeral training and sandbox lab environments (`qwiklabs-gcp-*`). No regulated state agency records or protected workloads (HIPAA, FERPA, CJIS) are processed or persisted. The web interface meets modern accessibility contrast and keyboard navigation standards (ADA).
- **On-Demand Local Bridge Governance**: The local Mac bridge (`macBridgeAgent.ts`) executes only when explicitly started by the user, performs zero background polling, and can be terminated immediately from the web UI (`Stop Mac Bridge`) or terminal (`Ctrl+C`).
