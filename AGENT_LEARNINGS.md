# Skills Runner — Cumulative Agent Engineering Learnings (`AGENT_LEARNINGS.md`)

> **Purpose**: This document is the persistent institutional memory of **Skills Runner**. It records every non-obvious failure mode, API schema quirk, cloud timing behavior, and self-healing pattern discovered while autonomously executing Google Cloud Skills Boost hands-on labs and courses. Use these principles when designing, prompting, and hardening autonomous agents.

---

## Summary Table

| ID | Date | Category | Title | Key Tags |
| :--- | :--- | :--- | :--- | :--- |
| **L-001** | 2026-10-10 | Cloud Shell & Auth | Fresh Cloud Shell SSH Sessions Have Unset gcloud core/project Property | `gcloud`, `cloud-shell`, `ssh`, `environment-variables`, `project-id` |
| **L-002** | 2026-10-10 | Discovery Engine & Gemini Enterprise | Discovery Engine updateAclConfig Rejects updateMask Query Parameter | `discoveryengine`, `aclConfig`, `idpConfig`, `updateMask`, `rest-api` |
| **L-003** | 2026-10-10 | Discovery Engine & Gemini Enterprise | Discovery Engine default_user_store & License Allocation Dependency Order | `discoveryengine`, `userStores`, `licenseConfigs`, `gemini-enterprise`, `ordering` |
| **L-004** | 2026-10-10 | Discovery Engine & Gemini Enterprise | Multi-Turn Stateful Agents in Discovery Engine Require Per-Turn agentsSpec (Deep Research Agent) | `deep-research`, `streamAssist`, `agentsSpec`, `multi-turn`, `discoveryengine` |
| **L-005** | 2026-10-10 | Discovery Engine & Gemini Enterprise | Widget UI Field Mappings (displayTemplate) & Paired Search + WriteUserEvent Telemetry | `widgetConfigs`, `fieldsUiComponentsMap`, `userEvents`, `telemetry`, `discoveryengine` |
| **L-006** | 2026-10-10 | Discovery Engine & Gemini Enterprise | Non-Blocking Functional Readiness Polling for Large Data Store Imports | `import-documents`, `lro`, `polling`, `bigquery`, `discoveryengine` |
| **L-007** | 2026-10-10 | Cloud Shell & Auth | macOS Python 3.13/3.14 SSL Certificate Verification & Local Fallback Execution | `macos`, `python`, `ssl`, `certificates`, `local-fallback` |
| **L-008** | 2026-10-09 | Vertex AI & Agent Runtime | Vertex AI Agent Runtime (AdkApp) SDK Version Skew & Lazy Service Agent Provisioning | `vertex-ai`, `agent-engines`, `adk`, `iam`, `version-skew` |
| **L-009** | 2026-10-09 | Course & Embedded Lab Orchestration | Detecting and Running Hands-On Labs Embedded Inside Multi-Module Courses | `course-mode`, `embedded-lab`, `mode-switching`, `dom-detection` |
| **L-010** | 2026-10-08 | DOM, Shadow DOM & Quiz Grading | Idempotent Quiz Option Selection & Cross-Attempt Elimination Memory | `quiz`, `shadow-dom`, `rise-360`, `idempotency`, `self-healing` |
| **L-011** | 2026-10-10 | Self-Healing & Grader Verification | Distinguishing Cloud API Chat Prompts from CLI Agent Prompts in Step Surface Classification | `lab-parser`, `surface-classification`, `plaintext-prompts`, `agents` |

---

## L-001: Fresh Cloud Shell SSH Sessions Have Unset gcloud core/project Property
- **Date Recorded**: 2026-10-10
- **Category**: Cloud Shell & Auth
- **Tags**: `gcloud`, `cloud-shell`, `ssh`, `environment-variables`, `project-id`

### 1. Observed Symptom / Failure Mode
On Attempt 1 in a newly provisioned Cloud Shell VM, `gcloud services enable ...` failed with `ERROR: (gcloud.services.enable) The project property is set to the empty string, which is invalid.` Furthermore, `PROJECT_ID=$(gcloud config get-value project 2>/dev/null || echo "$GOOGLE_CLOUD_PROJECT")` evaluated to `""`.

### 2. Root Cause (Why Agents Fail Here)
Python SDKs read `GOOGLE_CLOUD_PROJECT` and `DEVSHELL_PROJECT_ID`, but the `gcloud` CLI reads `CLOUDSDK_CORE_PROJECT` or `~/.config/gcloud/configurations/config_default`. In a brand-new Cloud Shell VM connected over non-interactive SSH, `core/project` is unset, and `gcloud config get-value project 2>/dev/null` exits with status `0` and empty stdout `""` (writing `(unset)` to stderr), so `||` fallbacks never trigger.

### 3. General Principle for Building Better Agents
When building agents that execute CLI commands over non-interactive SSH or container shells, always export `CLOUDSDK_CORE_PROJECT` alongside `GOOGLE_CLOUD_PROJECT` and `DEVSHELL_PROJECT_ID`, and run `gcloud config set project "$PROJECT_ID" --quiet` in the environment preamble. Never rely on `$(gcloud config get-value project || fallback)` without checking `[ -z "$PROJECT_ID" ]`.

### 4. Implementation in Skills Runner
`server/macBridgeAgent.ts` (`execInStudentCloudShell`) and `server/nativeChromeBridge.ts` (`execInStudentCloudShellBridge`) pre-export `CLOUDSDK_CORE_PROJECT` and execute `gcloud config set project` before running any synthesized task script.

---

## L-002: Discovery Engine updateAclConfig Rejects updateMask Query Parameter
- **Date Recorded**: 2026-10-10
- **Category**: Discovery Engine & Gemini Enterprise
- **Tags**: `discoveryengine`, `aclConfig`, `idpConfig`, `updateMask`, `rest-api`

### 1. Observed Symptom / Failure Mode
Configuring Google Identity via `PATCH https://discoveryengine.googleapis.com/v1alpha/projects/{project}/locations/global/aclConfig?updateMask=idpConfig` returned HTTP 400 (`Invalid JSON payload received. Unknown name "updateMask": Cannot find field.`), leaving `aclConfig.idpConfig` empty (`{}`) and failing the Workforce Identity grader check.

### 2. Root Cause (Why Agents Fail Here)
Unlike `engines.patch` or `widgetConfigs.patch`, `discoveryengine.projects.locations.updateAclConfig` (`PATCH v1alpha/{+name}`) defines only `name` in its Discovery Document parameters and does not accept an `updateMask` query parameter. Passing `?updateMask=...` causes the HTTP-to-protobuf transcoder to reject `updateMask` as an unknown field on the `AclConfig` message.

### 3. General Principle for Building Better Agents
Do not assume every Google Cloud `PATCH` endpoint supports `?updateMask=...`. Agents interacting with REST APIs should either check the service Discovery Document (`https://<service>.googleapis.com/$discovery/rest?version=v1alpha`) or automatically retry a `PATCH` without `updateMask` when HTTP 400 reports `Unknown name "updateMask": Cannot find field`.

### 4. Implementation in Skills Runner
`server/geminiClient.ts` explicitly instructs task synthesis to call `PATCH .../locations/global/aclConfig` with `{"idpConfig": {"idpType": "GSUITE"}}` and no `updateMask` parameter.

---

## L-003: Discovery Engine default_user_store & License Allocation Dependency Order
- **Date Recorded**: 2026-10-10
- **Category**: Discovery Engine & Gemini Enterprise
- **Tags**: `discoveryengine`, `userStores`, `licenseConfigs`, `gemini-enterprise`, `ordering`

### 1. Observed Symptom / Failure Mode
Calling `POST .../locations/global/licenseConfigs` or `PATCH .../locations/global/userStores/default_user_store` prior to creating the Gemini Enterprise Intranet engine returned HTTP 404 (`User store with name .../userStores/default_user_store does not exist`).

### 2. Root Cause (Why Agents Fail Here)
In Discovery Engine (`v1alpha`), `userStores/default_user_store` is lazily initialized when the first `APP_TYPE_INTRANET` engine is created (or when `POST .../locations/global/userStores?userStoreId=default_user_store` is explicitly called).

### 3. General Principle for Building Better Agents
Agents provisioning multi-resource cloud topologies must respect implicit parent/child initialization side effects: (1) configure `aclConfig` (`idpType: "GSUITE"`), (2) create the `APP_TYPE_INTRANET` engine (or explicitly create `default_user_store`), and (3) create `licenseConfigs`, patch `default_user_store`, and call `batchUpdateUserLicenses`.

### 4. Implementation in Skills Runner
`server/geminiClient.ts` enforces the exact `aclConfig` -> `engines.create` / `userStores.create` -> `licenseConfigs` -> `batchUpdateUserLicenses` sequence.

---

## L-004: Multi-Turn Stateful Agents in Discovery Engine Require Per-Turn agentsSpec (Deep Research Agent)
- **Date Recorded**: 2026-10-10
- **Category**: Discovery Engine & Gemini Enterprise
- **Tags**: `deep-research`, `streamAssist`, `agentsSpec`, `multi-turn`, `discoveryengine`

### 1. Observed Symptom / Failure Mode
In "Explore the Deep Research Agent", calling `assistants/default_assistant:streamAssist` without `agentsSpec` routed queries to `root_agent` (`answer_generation_mode: ANSWER_GENERATION_MODE_UNSPECIFIED`). Even when Turn 1 passed `agentsSpec: {"agentSpecs": [{"agentId": "deep_research"}]}` (generating the initial Research Plan), omitting `agentsSpec` on Turn 2 caused the session to revert to `root_agent` instead of updating the Research Plan in `deep_research`.

### 2. Root Cause (Why Agents Fail Here)
In Discovery Engine `streamAssist`, agent selection is per-request (`StreamAssistRequest.agentsSpec.agentSpecs: [{"agentId": "deep_research"}]`), not sticky on the `Session` resource. Furthermore, standalone Gemini Enterprise apps have no attached data stores (`ENGINE_HAS_NO_DATA_STORES` on `:search`) and rely on `assistants/default_assistant:streamAssist` with `webGroundingSpec` and `agentsSpec`.

### 3. General Principle for Building Better Agents
When automating multi-turn plan-and-execute agents (such as `deep_research` under `assistants/default_assistant/agents`): (1) create a dedicated `Session` (`POST .../engines/{engineId}/sessions`), and (2) pass both `"session": session_name` AND `"agentsSpec": {"agentSpecs": [{"agentId": "deep_research"}]}` on every single turn: Turn 1 (initial research prompt -> produces Research Plan), Turn 2 (plan modification prompt -> produces updated Research Plan), and Turn 3 (`"Start research"` -> initiates plan execution).

### 4. Implementation in Skills Runner
`server/geminiClient.ts` includes a dedicated multi-turn Deep Research / Managed Agent protocol that preserves both `session` and `agentsSpec` across all turns (initial prompt -> plan refinement -> `"Start research"`).

---

## L-005: Widget UI Field Mappings (displayTemplate) & Paired Search + WriteUserEvent Telemetry
- **Date Recorded**: 2026-10-10
- **Category**: Discovery Engine & Gemini Enterprise
- **Tags**: `widgetConfigs`, `fieldsUiComponentsMap`, `userEvents`, `telemetry`, `discoveryengine`

### 1. Observed Symptom / Failure Mode
Patching `widgetConfigs/default_search_widget_config` with `template` instead of `displayTemplate` (or `?updateMask=uiSettings.dataStoreUiConfigs`) left `fieldsUiComponentsMap` empty. Additionally, running `:search` without `userEvents:write` failed "Test configuration / Preview query" checks.

### 2. Root Cause (Why Agents Fail Here)
Discovery Engine `UIComponentField` requires both `field` and `displayTemplate` (e.g., `"{value}"` or `"Severity: {value}"`), and `updateMask` must be top-level `uiSettings`. When a human tests search in the GCP Console Preview tab, the browser fires both `servingConfigs/default_search:search` and `locations/global/userEvents:write?writeAsync=true` with the returned `attributionToken` and `documents`.

### 3. General Principle for Building Better Agents
When an agent replaces a Console UI preview/test action with REST calls, it must replicate the complete telemetry footprint emitted by the UI (both the query call and the paired `userEvents:write` / session turn), not just the read-only search call.

### 4. Implementation in Skills Runner
`server/geminiClient.ts` pairs every Discovery Engine `:search` call with `locations/global/userEvents:write?writeAsync=true` (carrying `attributionToken` and `documents`) plus session-backed `:search` and `:answer` calls.

---

## L-006: Non-Blocking Functional Readiness Polling for Large Data Store Imports
- **Date Recorded**: 2026-10-10
- **Category**: Discovery Engine & Gemini Enterprise
- **Tags**: `import-documents`, `lro`, `polling`, `bigquery`, `discoveryengine`

### 1. Observed Symptom / Failure Mode
Importing a 295,000-row BigQuery table (`deps.advisories`) into Discovery Engine took 20+ minutes for the `import-documents` LRO to report `done: true`, causing naive LRO polling loops to time out.

### 2. Root Cause (Why Agents Fail Here)
Discovery Engine indexes and serves imported documents progressively within ~45–60 seconds (`metadata.successCount > 0`), long before the bulk import operation finishes indexing every row.

### 3. General Principle for Building Better Agents
Agents waiting on bulk data ingestion should poll for functional readiness (e.g., `servingConfigs/default_search:search` returning `len(results) > 0` with a 60–90s timeout) rather than blocking on LRO `done: true` when downstream tasks only require searchable documents.

### 4. Implementation in Skills Runner
`server/geminiClient.ts` polls `servingConfigs/default_search:search` until `results` are non-empty (capped at 90s) instead of blocking on `import-documents` LRO completion.

---

## L-007: macOS Python 3.13/3.14 SSL Certificate Verification & Local Fallback Execution
- **Date Recorded**: 2026-10-10
- **Category**: Cloud Shell & Auth
- **Tags**: `macos`, `python`, `ssl`, `certificates`, `local-fallback`

### 1. Observed Symptom / Failure Mode
When Cloud Shell SSH is blocked or unavailable and execution falls back to a local student workspace on macOS, Python `urllib.request` failed with `ssl.SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate`.

### 2. Root Cause (Why Agents Fail Here)
Framework builds of Python 3.13/3.14 on macOS look for CA certificates in `/Library/Frameworks/Python.framework/.../etc/openssl/cert.pem`, which does not exist by default unless `SSL_CERT_FILE=/etc/ssl/cert.pem` is exported.

### 3. General Principle for Building Better Agents
Agents executing Python scripts on macOS hosts must export `SSL_CERT_FILE=/etc/ssl/cert.pem` and `REQUESTS_CA_BUNDLE=/etc/ssl/cert.pem` in the child process environment so standard library `urllib` and `requests` trust the system root store.

### 4. Implementation in Skills Runner
`server/macBridgeAgent.ts` (`execInLocalStudentWorkspace`) and `server/nativeChromeBridge.ts` (`execInStudentCloudShellBridge`) automatically inject `SSL_CERT_FILE=/etc/ssl/cert.pem` and `REQUESTS_CA_BUNDLE=/etc/ssl/cert.pem`.

---

## L-008: Vertex AI Agent Runtime (AdkApp) SDK Version Skew & Lazy Service Agent Provisioning
- **Date Recorded**: 2026-10-09
- **Category**: Vertex AI & Agent Runtime
- **Tags**: `vertex-ai`, `agent-engines`, `adk`, `iam`, `version-skew`

### 1. Observed Symptom / Failure Mode
Deploying an `AdkApp` from Cloud Shell crashed the ReasoningEngine container at startup with `TypeError: Runner.__init__() got an unexpected keyword argument 'auto_create_session'`, or failed IAM checks because `service-<project_number>@gcp-sa-aiplatform-re.iam.gserviceaccount.com` did not exist before deployment.

### 2. Root Cause (Why Agents Fail Here)
Cloud Shell pre-installs `google-cloud-aiplatform==1.165.1` alongside an older `google-adk==1.14.1`; `aiplatform>=1.165.1` passes `auto_create_session=True` to `google.adk.runners.Runner()`, which requires `google-adk>=1.30.0`. Additionally, Vertex AI provisions the Reasoning Engine service agent lazily during the first `CreateReasoningEngine` call.

### 3. General Principle for Building Better Agents
Always upgrade and pin compatible versions of coupled SDKs (`google-cloud-aiplatform[agent_engines,adk]` and `google-adk>=1.30.0`) in both the build environment and `requirements=[...]`, and grant IAM bindings to lazily-created Google-managed service agents in a background loop during deployment and again after deployment completes.

### 4. Implementation in Skills Runner
`server/geminiClient.ts` upgrades both packages before `agent_engines.create`, pins exact installed versions in `requirements`, and grants Reasoning Engine service agent IAM roles during and after deployment.

---

## L-009: Detecting and Running Hands-On Labs Embedded Inside Multi-Module Courses
- **Date Recorded**: 2026-10-09
- **Category**: Course & Embedded Lab Orchestration
- **Tags**: `course-mode`, `embedded-lab`, `mode-switching`, `dom-detection`

### 1. Observed Symptom / Failure Mode
When a course on Google Cloud Skills Boost (`partner.skills.google/paths/.../course_templates/...`) contained an embedded hands-on lab module, URL-based heuristics kept switching the runner back to Course Mode instead of executing the lab tasks.

### 2. Root Cause (Why Agents Fail Here)
Embedded labs inside courses share course URL prefixes (`/course_templates/`, `/paths/`) while rendering live lab web components (`ql-lab-control-panel`, `ql-activity-tracking`, `Start Lab`) inside the DOM.

### 3. General Principle for Building Better Agents
Classify page mode by inspecting live DOM capabilities (`ql-lab-control-panel`, `ql-activity-tracking`) rather than URL substrings alone. When a course navigates into an embedded lab, transition seamlessly into autonomous lab execution and resume course module progression once the lab reaches 100%.

### 4. Implementation in Skills Runner
`server/labParser.ts` (`isExplicitLabPage`) and `server/browserOrchestrator.ts` detect embedded lab DOM controls, execute the full lab lifecycle, and advance to the next course module upon completion.

---

## L-010: Idempotent Quiz Option Selection & Cross-Attempt Elimination Memory
- **Date Recorded**: 2026-10-08
- **Category**: DOM, Shadow DOM & Quiz Grading
- **Tags**: `quiz`, `shadow-dom`, `rise-360`, `idempotency`, `self-healing`

### 1. Observed Symptom / Failure Mode
In Rise 360 (`html_bundles`) and Shadow DOM quizzes, synthetic clicks on checkboxes during retry attempts toggled already-checked correct answers off, or re-selected previously failed single-choice options.

### 2. Root Cause (Why Agents Fail Here)
Clicking an already-selected checkbox in a web component toggles its state to unchecked. Without tracking which single-choice options failed on earlier attempts, an LLM may pick the same distractor twice.

### 3. General Principle for Building Better Agents
Always inspect `aria-checked` / `.checked` state before dispatching pointer events (clicking only when current state != desired state), and persist a per-question elimination set of rejected answers across retry attempts so retries converge deterministically.

### 4. Implementation in Skills Runner
`server/macBridgeAgent.ts` (`submitCourseQuizInUserChrome`) and `server/browserOrchestrator.ts` verify checked state prior to clicking and pass eliminated options into `answerCourseQuiz` on retries.

---

## L-011: Distinguishing Cloud API Chat Prompts from CLI Agent Prompts in Step Surface Classification
- **Date Recorded**: 2026-10-10
- **Category**: Self-Healing & Grader Verification
- **Tags**: `lab-parser`, `surface-classification`, `plaintext-prompts`, `agents`

### 1. Observed Symptom / Failure Mode
Lab steps containing `<ql-code-block language="plaintext">` with instructions like "Enter the following prompt into the search bar and click Send" were classified as `antigravity` CLI steps instead of Cloud API / Console steps.

### 2. Root Cause (Why Agents Fail Here)
`classifySurface` treated any `plaintext` code block mentioning `prompt` or `agent` as an Antigravity (`agy`) CLI instruction, even when the lab was testing a web-based Discovery Engine or Vertex AI agent.

### 3. General Principle for Building Better Agents
Scope tool-specific surface classifiers (`antigravity`) strictly to explicit signals for that tool (`antigravity`, `agy`, `code assist`, `cloud editor`, `workstation`), while extracting conversational prompts (`<ql-code-block language="plaintext">`) as structured step inputs for API-driven agent synthesis.

### 4. Implementation in Skills Runner
`server/labParser.ts` scopes `antigravity` classification to explicit Antigravity/Cloud Editor signals and extracts conversational prompts for Discovery Engine / Vertex AI agent synthesis.

---
