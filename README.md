# Skills Runner — Universal Autonomous GCP & Antigravity Lab Agent

[![Cloud Run Deployed](https://img.shields.io/badge/Cloud_Run-Deployed-4285F4?logo=googlecloud&logoColor=white)](https://skills-runner-621653283297.us-central1.run.app)
[![Gemini 3.5 Flash](https://img.shields.io/badge/AI-Gemini_3.5_Flash-4285F4?logo=google&logoColor=white)](https://cloud.google.com/vertex-ai)
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
- **AI Reasoning & Code Synthesis Engine**:
  - Primary Model: **`gemini-3.8-flash`** (with dynamic model resolution and automatic fallback to `gemini-3.1-pro-preview` / `gemini-2.5-flash`) via the Unified Google Gen AI SDK (`@google/genai`)
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
│   ├── types.ts                   # Shared domain models (Tasks, Steps, Credentials, Bridge RPC)
│   ├── browserOrchestrator.ts     # Stateful task execution loop & 3-attempt self-healing grader
│   ├── geminiClient.ts            # Gemini 3.5 Flash task script synthesizer & multimodal planner
│   ├── labParser.ts               # Deep Shadow-DOM parser for <ql-*> web components & templates
│   ├── nativeChromeBridge.ts      # Hybrid local/remote Chrome tab & Cloud Shell SSH bridge
│   ├── macBridgeHub.ts            # Cloud Run WebSocket RPC hub for connected Mac bridge agents
│   ├── macBridgeAgent.ts          # Downloadable on-demand macOS Chrome & Cloud Shell agent
│   ├── consoleSignIn.ts           # Automated Qwiklabs student sign-in & GCP ToS modal handler
│   ├── pageInspector.ts           # Set-of-Marks (SoM) DOM inspector & zero-touch Antigravity handler
│   └── selfTest.ts                # End-to-end automated verification & regression test suite
└── src/
    ├── main.tsx
    ├── App.tsx                    # Web Control Center UI + Mac Bridge setup modal
    ├── index.css
    └── types.ts
```

---

## 3. Core Capabilities & Key Features

1. **On-Demand Mac Chrome Bridge (Zero Background Polling)**:
   - When starting or parsing a lab from the Cloud Run web app, the UI checks whether the local Mac Chrome Bridge (`macBridgeAgent.ts`) is connected.
   - If not running, operators can download a 1-click launcher (`Start-Mac-Chrome-Bridge.command`) that automatically saves and updates `~/Downloads/skill-runner/macBridgeAgent.ts` and connects over `wss://.../ws-bridge`.
   - Operates in **100% passive on-demand mode**—never touching Chrome or `osascript` in the background unless an action is explicitly triggered in the UI, preventing interference with SSO or Google login prompts.
2. **Deep Shadow-DOM Lab Parser & Template Interpolation**:
   - Pierces modern `<ql-lab-header>`, `<ql-copyable-input>`, `<ql-code-block>`, `<ql-activity-tracking>`, and Declarative Shadow DOM templates.
   - Automatically resolves Qwiklabs template expressions including piped default filters (`{{{ project_0.project_id | "your-gcp-project-id" }}}`, `{{{ project_0.default_region | "us-central1" }}}`) against live student credentials.
3. **Live Student Cloud Shell, GCS Bucket & Qwiklabs Grader Audit Introspection**:
   - Before synthesizing commands for any task, [`inspectStudentCloudShellWorkspace`](server/nativeChromeBridge.ts) connects to the student's isolated Cloud Shell VM via `gcloud cloud-shell ssh` and inspects the directory tree (`~`), starter code (`.py`, `.json`, `.tf`, `.yaml`, `.env`, `requirements.txt`), project GCS buckets (`gs://<project>*`), installed CLI `--help` output (such as `adk eval_set`), and the live **Qwiklabs Grader Audit Trail** (`cloudaudit.googleapis.com` API calls and `ListLogEntries` filters executed by the Qwiklabs grading service account).
   - Automatically verifies student OAuth token freshness via `gcloud auth print-access-token --quiet` so expired tokens from prior labs automatically re-authenticate via headless Playwright OAuth.
4. **Unified Stateful Task Synthesis, 4-Attempt Self-Healing Verification & Persistent State**:
   - Rather than running disconnected single-line snippets that lose working directory or Python virtualenv (`.venv`) state, [`synthesizeTaskShellScript`](server/geminiClient.ts) generates a single idempotent, stateful bash script per task that completes both prose file edits (e.g., implementing `TODO` functions in `agent.py` or adding rubrics to `eval_config.json`) and CLI commands in sequence.
   - Automatically clicks **"Check my progress"** via the Qwiklabs assessment API (`stepCompleteList`, `stepScoresList`, `studentMessagesList`), reloads the Qwiklabs tab when a step passes so the browser score updates immediately, and feeds any grader failure message + grader audit log checks + stdout/stderr back into Gemini for up to 4 self-healing attempts.
   - Automatically persists runner state (`~/.cloud-skills-lab-runner/runner_state.json`) across Cloud Run deployments and container restarts, with manual 1-click **Save State** (`/api/state/save`).
5. **Zero-Touch Antigravity (`agy`) Execution**:
   - Automatically wraps `agy` / `antigravity` CLI invocations with `--dangerously-skip-permissions` and graceful fallback (`agy --dangerously-skip-permissions || agy`).
   - Appends non-interactive execution directives to Antigravity prompts and auto-approves IDE confirmation buttons (`Accept All`, `Allow`, `Run Command`, `Proceed`).

### Operator Workflow: Running Any Lab End-to-End in 3 Steps
1. **Step 1 — Sign In & Connect Mac Bridge**:
   - Sign into your Google Cloud Skills Boost / Partner Skills account in your normal desktop Google Chrome browser.
   - In the Skills Runner UI, click **Start Mac Bridge** and either run the 1-line terminal command (`curl -fsSL .../api/bridge/start.sh | sh`) or double-click `Start-Mac-Chrome-Bridge.command`.
2. **Step 2 — Point at Your Self-Signed-In Lab Page**:
   - Select your open Lab Instructions tab from the **Step 2** dropdown (auto-detected from your normal Chrome window) or paste the Lab URL.
3. **Step 3 — Click "Start & Run Lab"**:
   - Click **Start & Run Lab**. Skills Runner autonomously executes the entire lifecycle without requiring any manual window management:
     1. Clicks **Start Lab** in your signed-in Lab tab (if not already started) and waits for Qwiklabs to provision the temporary student credentials (`username`, `password`, `projectId`).
     2. **Spawns a clean Incognito window in Chrome on your Mac**, signs in as the temporary lab student account (`student-...@qwiklabs.net`), accepts the Google Workspace new-account consent & GCP Console Terms of Service, and opens both the **GCP Console** tab and **Cloud Shell** tab.
     3. Completes student `gcloud` OAuth authentication directly on your Mac inside the student Incognito session and inspects the student's Cloud Shell workspace (`~`), starter code, project GCS buckets, and Qwiklabs grader audit checks.
     4. Synthesizes and executes stateful bash/Python solutions for each task and triggers **"Check my progress"** after every task (with up to 4 self-healing retries) until all progress checks are verified.

---

## 4. API & Interface Reference

| Endpoint | Method | Parameters / Payload | Description |
| :--- | :--- | :--- | :--- |
| `/api/health` | `GET` | — | Service health check, active Gemini model, and Mac Bridge connection status |
| `/api/state` | `GET` | — | Returns complete `RunnerState` (tasks, scores, credentials, Chrome tabs, logs) |
| `/api/state/save` | `POST` | `{}` | Persists current `RunnerState` to `~/.cloud-skills-lab-runner/runner_state.json` on disk and via Mac Bridge |
| `/api/chrome/scan` | `POST` | `{}` | Scans open macOS Google Chrome windows/tabs (Normal + Incognito) and classifies `lab`, `console`, and `cloud_shell` roles |
| `/api/chrome/bind` | `POST` | `{ "labTabKey": "win:tab", "consoleTabKey": "win:tab" }` | Binds selected Chrome tabs and snapshots the Lab DOM |
| `/api/chrome/focus` | `POST` | `{ "key": "win:tab" }` | Brings a specific Chrome window and tab to the foreground |
| `/api/lab/open` | `POST` | `{ "url": "https://..." }` | Opens a Lab URL in Chrome and parses instructions |
| `/api/lab/parse` | `POST` | `{}` | Syncs the bound Lab tab DOM, parses tasks/credentials, and polls live assessment scores |
| `/api/lab/start-and-signin` | `POST` | `{}` | Clicks "Start Lab", extracts student credentials, spawns an Incognito window on the Mac, and signs into GCP Console |
| `/api/lab/start-and-run` | `POST` | `{ "labTabKey": "win:tab", "url": "https://..." }` | Unified 1-click pipeline: binds/opens the lab tab, starts the lab, spawns the student Incognito session, runs all tasks, and verifies progress checks |
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
