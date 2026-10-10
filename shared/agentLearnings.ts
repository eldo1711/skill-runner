export interface AgentLearningEntry {
  id: string;
  date: string;
  category:
    | 'Cloud Shell & Auth'
    | 'Discovery Engine & Gemini Enterprise'
    | 'Vertex AI & Agent Runtime'
    | 'Course & Embedded Lab Orchestration'
    | 'DOM, Shadow DOM & Quiz Grading'
    | 'Self-Healing & Grader Verification';
  title: string;
  symptom: string;
  rootCause: string;
  generalPrinciple: string;
  implementationInSkillsRunner: string;
  tags: string[];
}

export const AGENT_LEARNINGS: AgentLearningEntry[] = [
  {
    id: 'L-001',
    date: '2026-10-10',
    category: 'Cloud Shell & Auth',
    title: 'Fresh Cloud Shell SSH Sessions Have Unset gcloud core/project Property',
    symptom:
      'On Attempt 1 in a newly provisioned Cloud Shell VM, `gcloud services enable ...` failed with `ERROR: (gcloud.services.enable) The project property is set to the empty string, which is invalid.` Furthermore, `PROJECT_ID=$(gcloud config get-value project 2>/dev/null || echo "$GOOGLE_CLOUD_PROJECT")` evaluated to `""`.',
    rootCause:
      'Python SDKs read `GOOGLE_CLOUD_PROJECT` and `DEVSHELL_PROJECT_ID`, but the `gcloud` CLI reads `CLOUDSDK_CORE_PROJECT` or `~/.config/gcloud/configurations/config_default`. In a brand-new Cloud Shell VM connected over non-interactive SSH, `core/project` is unset, and `gcloud config get-value project 2>/dev/null` exits with status `0` and empty stdout `""` (writing `(unset)` to stderr), so `||` fallbacks never trigger.',
    generalPrinciple:
      'When building agents that execute CLI commands over non-interactive SSH or container shells, always export `CLOUDSDK_CORE_PROJECT` alongside `GOOGLE_CLOUD_PROJECT` and `DEVSHELL_PROJECT_ID`, and run `gcloud config set project "$PROJECT_ID" --quiet` in the environment preamble. Never rely on `$(gcloud config get-value project || fallback)` without checking `[ -z "$PROJECT_ID" ]`.',
    implementationInSkillsRunner:
      '`server/macBridgeAgent.ts` (`execInStudentCloudShell`) and `server/nativeChromeBridge.ts` (`execInStudentCloudShellBridge`) pre-export `CLOUDSDK_CORE_PROJECT` and execute `gcloud config set project` before running any synthesized task script.',
    tags: ['gcloud', 'cloud-shell', 'ssh', 'environment-variables', 'project-id'],
  },
  {
    id: 'L-002',
    date: '2026-10-10',
    category: 'Discovery Engine & Gemini Enterprise',
    title: 'Discovery Engine updateAclConfig Rejects updateMask Query Parameter',
    symptom:
      'Configuring Google Identity via `PATCH https://discoveryengine.googleapis.com/v1alpha/projects/{project}/locations/global/aclConfig?updateMask=idpConfig` returned HTTP 400 (`Invalid JSON payload received. Unknown name "updateMask": Cannot find field.`), leaving `aclConfig.idpConfig` empty (`{}`) and failing the Workforce Identity grader check.',
    rootCause:
      'Unlike `engines.patch` or `widgetConfigs.patch`, `discoveryengine.projects.locations.updateAclConfig` (`PATCH v1alpha/{+name}`) defines only `name` in its Discovery Document parameters and does not accept an `updateMask` query parameter. Passing `?updateMask=...` causes the HTTP-to-protobuf transcoder to reject `updateMask` as an unknown field on the `AclConfig` message.',
    generalPrinciple:
      'Do not assume every Google Cloud `PATCH` endpoint supports `?updateMask=...`. Agents interacting with REST APIs should either check the service Discovery Document (`https://<service>.googleapis.com/$discovery/rest?version=v1alpha`) or automatically retry a `PATCH` without `updateMask` when HTTP 400 reports `Unknown name "updateMask": Cannot find field`.',
    implementationInSkillsRunner:
      '`server/geminiClient.ts` explicitly instructs task synthesis to call `PATCH .../locations/global/aclConfig` with `{"idpConfig": {"idpType": "GSUITE"}}` and no `updateMask` parameter.',
    tags: ['discoveryengine', 'aclConfig', 'idpConfig', 'updateMask', 'rest-api'],
  },
  {
    id: 'L-003',
    date: '2026-10-10',
    category: 'Discovery Engine & Gemini Enterprise',
    title: 'Discovery Engine default_user_store & License Allocation Dependency Order',
    symptom:
      'Calling `POST .../locations/global/licenseConfigs` or `PATCH .../locations/global/userStores/default_user_store` prior to creating the Gemini Enterprise Intranet engine returned HTTP 404 (`User store with name .../userStores/default_user_store does not exist`).',
    rootCause:
      'In Discovery Engine (`v1alpha`), `userStores/default_user_store` is lazily initialized when the first `APP_TYPE_INTRANET` engine is created (or when `POST .../locations/global/userStores?userStoreId=default_user_store` is explicitly called).',
    generalPrinciple:
      'Agents provisioning multi-resource cloud topologies must respect implicit parent/child initialization side effects: (1) configure `aclConfig` (`idpType: "GSUITE"`), (2) create the `APP_TYPE_INTRANET` engine (or explicitly create `default_user_store`), and (3) create `licenseConfigs`, patch `default_user_store`, and call `batchUpdateUserLicenses`.',
    implementationInSkillsRunner:
      '`server/geminiClient.ts` enforces the exact `aclConfig` -> `engines.create` / `userStores.create` -> `licenseConfigs` -> `batchUpdateUserLicenses` sequence.',
    tags: ['discoveryengine', 'userStores', 'licenseConfigs', 'gemini-enterprise', 'ordering'],
  },
  {
    id: 'L-004',
    date: '2026-10-10',
    category: 'Discovery Engine & Gemini Enterprise',
    title: 'Multi-Turn Stateful Agents in Discovery Engine Require Per-Turn agentsSpec (Deep Research Agent)',
    symptom:
      'In "Explore the Deep Research Agent", calling `assistants/default_assistant:streamAssist` without `agentsSpec` routed queries to `root_agent` (`answer_generation_mode: ANSWER_GENERATION_MODE_UNSPECIFIED`). Even when Turn 1 passed `agentsSpec: {"agentSpecs": [{"agentId": "deep_research"}]}` (generating the initial Research Plan), omitting `agentsSpec` on Turn 2 caused the session to revert to `root_agent` instead of updating the Research Plan in `deep_research`.',
    rootCause:
      'In Discovery Engine `streamAssist`, agent selection is per-request (`StreamAssistRequest.agentsSpec.agentSpecs: [{"agentId": "deep_research"}]`), not sticky on the `Session` resource. Furthermore, standalone Gemini Enterprise apps have no attached data stores (`ENGINE_HAS_NO_DATA_STORES` on `:search`) and rely on `assistants/default_assistant:streamAssist` with `webGroundingSpec` and `agentsSpec`.',
    generalPrinciple:
      'When automating multi-turn plan-and-execute agents (such as `deep_research` under `assistants/default_assistant/agents`): (1) create a dedicated `Session` (`POST .../engines/{engineId}/sessions`), and (2) pass both `"session": session_name` AND `"agentsSpec": {"agentSpecs": [{"agentId": "deep_research"}]}` on every single turn: Turn 1 (initial research prompt -> produces Research Plan), Turn 2 (plan modification prompt -> produces updated Research Plan), and Turn 3 (`"Start research"` -> initiates plan execution).',
    implementationInSkillsRunner:
      '`server/geminiClient.ts` includes a dedicated multi-turn Deep Research / Managed Agent protocol that preserves both `session` and `agentsSpec` across all turns (initial prompt -> plan refinement -> `"Start research"`).',
    tags: ['deep-research', 'streamAssist', 'agentsSpec', 'multi-turn', 'discoveryengine'],
  },
  {
    id: 'L-005',
    date: '2026-10-10',
    category: 'Discovery Engine & Gemini Enterprise',
    title: 'Widget UI Field Mappings (displayTemplate) & Paired Search + WriteUserEvent Telemetry',
    symptom:
      'Patching `widgetConfigs/default_search_widget_config` with `template` instead of `displayTemplate` (or `?updateMask=uiSettings.dataStoreUiConfigs`) left `fieldsUiComponentsMap` empty. Additionally, running `:search` without `userEvents:write` failed "Test configuration / Preview query" checks.',
    rootCause:
      'Discovery Engine `UIComponentField` requires both `field` and `displayTemplate` (e.g., `"{value}"` or `"Severity: {value}"`), and `updateMask` must be top-level `uiSettings`. When a human tests search in the GCP Console Preview tab, the browser fires both `servingConfigs/default_search:search` and `locations/global/userEvents:write?writeAsync=true` with the returned `attributionToken` and `documents`.',
    generalPrinciple:
      'When an agent replaces a Console UI preview/test action with REST calls, it must replicate the complete telemetry footprint emitted by the UI (both the query call and the paired `userEvents:write` / session turn), not just the read-only search call.',
    implementationInSkillsRunner:
      '`server/geminiClient.ts` pairs every Discovery Engine `:search` call with `locations/global/userEvents:write?writeAsync=true` (carrying `attributionToken` and `documents`) plus session-backed `:search` and `:answer` calls.',
    tags: ['widgetConfigs', 'fieldsUiComponentsMap', 'userEvents', 'telemetry', 'discoveryengine'],
  },
  {
    id: 'L-006',
    date: '2026-10-10',
    category: 'Discovery Engine & Gemini Enterprise',
    title: 'Non-Blocking Functional Readiness Polling for Large Data Store Imports',
    symptom:
      'Importing a 295,000-row BigQuery table (`deps.advisories`) into Discovery Engine took 20+ minutes for the `import-documents` LRO to report `done: true`, causing naive LRO polling loops to time out.',
    rootCause:
      'Discovery Engine indexes and serves imported documents progressively within ~45–60 seconds (`metadata.successCount > 0`), long before the bulk import operation finishes indexing every row.',
    generalPrinciple:
      'Agents waiting on bulk data ingestion should poll for functional readiness (e.g., `servingConfigs/default_search:search` returning `len(results) > 0` with a 60–90s timeout) rather than blocking on LRO `done: true` when downstream tasks only require searchable documents.',
    implementationInSkillsRunner:
      '`server/geminiClient.ts` polls `servingConfigs/default_search:search` until `results` are non-empty (capped at 90s) instead of blocking on `import-documents` LRO completion.',
    tags: ['import-documents', 'lro', 'polling', 'bigquery', 'discoveryengine'],
  },
  {
    id: 'L-007',
    date: '2026-10-10',
    category: 'Cloud Shell & Auth',
    title: 'macOS Python 3.13/3.14 SSL Certificate Verification & Local Fallback Execution',
    symptom:
      'When Cloud Shell SSH is blocked or unavailable and execution falls back to a local student workspace on macOS, Python `urllib.request` failed with `ssl.SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate`.',
    rootCause:
      'Framework builds of Python 3.13/3.14 on macOS look for CA certificates in `/Library/Frameworks/Python.framework/.../etc/openssl/cert.pem`, which does not exist by default unless `SSL_CERT_FILE=/etc/ssl/cert.pem` is exported.',
    generalPrinciple:
      'Agents executing Python scripts on macOS hosts must export `SSL_CERT_FILE=/etc/ssl/cert.pem` and `REQUESTS_CA_BUNDLE=/etc/ssl/cert.pem` in the child process environment so standard library `urllib` and `requests` trust the system root store.',
    implementationInSkillsRunner:
      '`server/macBridgeAgent.ts` (`execInLocalStudentWorkspace`) and `server/nativeChromeBridge.ts` (`execInStudentCloudShellBridge`) automatically inject `SSL_CERT_FILE=/etc/ssl/cert.pem` and `REQUESTS_CA_BUNDLE=/etc/ssl/cert.pem`.',
    tags: ['macos', 'python', 'ssl', 'certificates', 'local-fallback'],
  },
  {
    id: 'L-008',
    date: '2026-10-09',
    category: 'Vertex AI & Agent Runtime',
    title: 'Vertex AI Agent Runtime (AdkApp) SDK Version Skew & Lazy Service Agent Provisioning',
    symptom:
      'Deploying an `AdkApp` from Cloud Shell crashed the ReasoningEngine container at startup with `TypeError: Runner.__init__() got an unexpected keyword argument \'auto_create_session\'`, or failed IAM checks because `service-<project_number>@gcp-sa-aiplatform-re.iam.gserviceaccount.com` did not exist before deployment.',
    rootCause:
      'Cloud Shell pre-installs `google-cloud-aiplatform==1.165.1` alongside an older `google-adk==1.14.1`; `aiplatform>=1.165.1` passes `auto_create_session=True` to `google.adk.runners.Runner()`, which requires `google-adk>=1.30.0`. Additionally, Vertex AI provisions the Reasoning Engine service agent lazily during the first `CreateReasoningEngine` call.',
    generalPrinciple:
      'Always upgrade and pin compatible versions of coupled SDKs (`google-cloud-aiplatform[agent_engines,adk]` and `google-adk>=1.30.0`) in both the build environment and `requirements=[...]`, and grant IAM bindings to lazily-created Google-managed service agents in a background loop during deployment and again after deployment completes.',
    implementationInSkillsRunner:
      '`server/geminiClient.ts` upgrades both packages before `agent_engines.create`, pins exact installed versions in `requirements`, and grants Reasoning Engine service agent IAM roles during and after deployment.',
    tags: ['vertex-ai', 'agent-engines', 'adk', 'iam', 'version-skew'],
  },
  {
    id: 'L-009',
    date: '2026-10-09',
    category: 'Course & Embedded Lab Orchestration',
    title: 'Detecting and Running Hands-On Labs Embedded Inside Multi-Module Courses',
    symptom:
      'When a course on Google Cloud Skills Boost (`partner.skills.google/paths/.../course_templates/...`) contained an embedded hands-on lab module, URL-based heuristics kept switching the runner back to Course Mode instead of executing the lab tasks.',
    rootCause:
      'Embedded labs inside courses share course URL prefixes (`/course_templates/`, `/paths/`) while rendering live lab web components (`ql-lab-control-panel`, `ql-activity-tracking`, `Start Lab`) inside the DOM.',
    generalPrinciple:
      'Classify page mode by inspecting live DOM capabilities (`ql-lab-control-panel`, `ql-activity-tracking`) rather than URL substrings alone. When a course navigates into an embedded lab, transition seamlessly into autonomous lab execution and resume course module progression once the lab reaches 100%.',
    implementationInSkillsRunner:
      '`server/labParser.ts` (`isExplicitLabPage`) and `server/browserOrchestrator.ts` detect embedded lab DOM controls, execute the full lab lifecycle, and advance to the next course module upon completion.',
    tags: ['course-mode', 'embedded-lab', 'mode-switching', 'dom-detection'],
  },
  {
    id: 'L-010',
    date: '2026-10-08',
    category: 'DOM, Shadow DOM & Quiz Grading',
    title: 'Idempotent Quiz Option Selection & Cross-Attempt Elimination Memory',
    symptom:
      'In Rise 360 (`html_bundles`) and Shadow DOM quizzes, synthetic clicks on checkboxes during retry attempts toggled already-checked correct answers off, or re-selected previously failed single-choice options.',
    rootCause:
      'Clicking an already-selected checkbox in a web component toggles its state to unchecked. Without tracking which single-choice options failed on earlier attempts, an LLM may pick the same distractor twice.',
    generalPrinciple:
      'Always inspect `aria-checked` / `.checked` state before dispatching pointer events (clicking only when current state != desired state), and persist a per-question elimination set of rejected answers across retry attempts so retries converge deterministically.',
    implementationInSkillsRunner:
      '`server/macBridgeAgent.ts` (`submitCourseQuizInUserChrome`) and `server/browserOrchestrator.ts` verify checked state prior to clicking and pass eliminated options into `answerCourseQuiz` on retries.',
    tags: ['quiz', 'shadow-dom', 'rise-360', 'idempotency', 'self-healing'],
  },
  {
    id: 'L-011',
    date: '2026-10-10',
    category: 'Self-Healing & Grader Verification',
    title: 'Distinguishing Cloud API Chat Prompts from CLI Agent Prompts in Step Surface Classification',
    symptom:
      'Lab steps containing `<ql-code-block language="plaintext">` with instructions like "Enter the following prompt into the search bar and click Send" were classified as `antigravity` CLI steps instead of Cloud API / Console steps.',
    rootCause:
      '`classifySurface` treated any `plaintext` code block mentioning `prompt` or `agent` as an Antigravity (`agy`) CLI instruction, even when the lab was testing a web-based Discovery Engine or Vertex AI agent.',
    generalPrinciple:
      'Scope tool-specific surface classifiers (`antigravity`) strictly to explicit signals for that tool (`antigravity`, `agy`, `code assist`, `cloud editor`, `workstation`), while extracting conversational prompts (`<ql-code-block language="plaintext">`) as structured step inputs for API-driven agent synthesis.',
    implementationInSkillsRunner:
      '`server/labParser.ts` scopes `antigravity` classification to explicit Antigravity/Cloud Editor signals and extracts conversational prompts for Discovery Engine / Vertex AI agent synthesis.',
    tags: ['lab-parser', 'surface-classification', 'plaintext-prompts', 'agents'],
  },
];

export function renderAgentLearningsMarkdown(): string {
  const lines: string[] = [
    '# Skills Runner — Cumulative Agent Engineering Learnings (`AGENT_LEARNINGS.md`)',
    '',
    '> **Purpose**: This document is the persistent institutional memory of **Skills Runner**. It records every non-obvious failure mode, API schema quirk, cloud timing behavior, and self-healing pattern discovered while autonomously executing Google Cloud Skills Boost hands-on labs and courses. Use these principles when designing, prompting, and hardening autonomous agents.',
    '',
    '---',
    '',
    '## Summary Table',
    '',
    '| ID | Date | Category | Title | Key Tags |',
    '| :--- | :--- | :--- | :--- | :--- |',
  ];

  for (const item of AGENT_LEARNINGS) {
    lines.push(
      `| **${item.id}** | ${item.date} | ${item.category} | ${item.title} | \`${item.tags.join('`, `')}\` |`
    );
  }

  lines.push('', '---', '');

  for (const item of AGENT_LEARNINGS) {
    lines.push(
      `## ${item.id}: ${item.title}`,
      `- **Date Recorded**: ${item.date}`,
      `- **Category**: ${item.category}`,
      `- **Tags**: \`${item.tags.join('`, `')}\``,
      '',
      '### 1. Observed Symptom / Failure Mode',
      item.symptom,
      '',
      '### 2. Root Cause (Why Agents Fail Here)',
      item.rootCause,
      '',
      '### 3. General Principle for Building Better Agents',
      item.generalPrinciple,
      '',
      '### 4. Implementation in Skills Runner',
      item.implementationInSkillsRunner,
      '',
      '---',
      ''
    );
  }

  return lines.join('\n');
}
