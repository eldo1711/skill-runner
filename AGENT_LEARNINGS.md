# Skills Runner — Cumulative Course, Quiz, Lab & Agent Engineering Knowledge Base (`AGENT_LEARNINGS.md`)

> **Purpose**: This handbook is the persistent, self-updating knowledge base of **Skills Runner**. Every time Skills Runner completes a course module, passes a quiz, or verifies a hands-on lab task on Google Cloud Skills Boost, it distills and memorializes:
> 1. **Course Curriculum & Domain Learnings** (`course_content`) — Core concepts, product capabilities, and architectures taught in courses.
> 2. **Verified Quiz & Knowledge Check Bank** (`quiz_mastery`) — Verified questions, winning answers, eliminated distractors, and domain rules.
> 3. **Verified Hands-On Lab Recipes & Self-Healing Deltas** (`lab_execution`) — Exact API/CLI/SDK implementations that passed Qwiklabs graders and how earlier attempt errors were resolved.
> 4. **Core Agent Engineering & Infrastructure Invariants** (`L-001`..`L-012`) — Reusable patterns for building reliable autonomous agents.

---

## 1. Course Curriculum & Domain Learnings (`course_content`)

### 📚 Explore the Deep Research Agent — Gemini Enterprise Architecture & Managed Deep Research Agent
- **Recorded**: 2026-10-10T19:45:00.000Z
- **Source URL**: https://partner.skills.google/focuses/149995?parent=catalog&path=3581
- **Tags**: `gemini-enterprise`, `deep-research`, `discoveryengine`, `workforce-identity`, `research-plan`

**Executive Summary**: Gemini Enterprise is an intranet-ready AI assistant and enterprise search application built on Google Cloud Discovery Engine. It includes a managed Deep Research agent (`deep_research`) that autonomously plans, refines, and executes multi-step research across internal data stores and Google Search grounding.

#### Core Concepts & Capabilities Taught
- Gemini Enterprise (`APP_TYPE_INTRANET`, `SOLUTION_TYPE_SEARCH`, `SEARCH_TIER_ENTERPRISE` + `SEARCH_ADD_ON_LLM`) unifies enterprise search, grounded chat (`default_assistant`), and specialized multi-step agents.
- Workforce Identity configuration (`aclConfig` with `idpType: "GSUITE"` or third-party OIDC/SAML) governs user access and license enforcement across the organization.
- The managed Deep Research agent (`assistants/default_assistant/agents/deep_research`) operates in a structured two-phase workflow: (1) interactive Research Plan generation and user refinement in chat, followed by (2) autonomous multi-source web/enterprise research synthesis into a comprehensive cited report.

#### Actionable Rules for Building Agents
- When automating Gemini Enterprise deployment via REST (`discoveryengine.googleapis.com/v1alpha`), configure `aclConfig` (`{"idpConfig": {"idpType": "GSUITE"}}`) without `updateMask`, provision the `APP_TYPE_INTRANET` engine first, and then configure `default_user_store` and `licenseConfigs`.
- When interacting with the Deep Research agent via `assistants/default_assistant:streamAssist`, pass `"agentsSpec": {"agentSpecs": [{"agentId": "deep_research"}]}` and the same `session` resource path on every turn (Turn 1: initial research topic -> Turn 2: research plan modification -> Turn 3: "Start research").

---

## 2. Verified Quiz & Knowledge Check Bank (`quiz_mastery`)

### ✅ Google Cloud Partner Skills Boost — Enterprise AI & Agentic Workflows — Course Knowledge Checks & Final Assessment Quizzes
- **Recorded**: 2026-10-10T17:30:00.000Z
- **Source URL**: https://partner.skills.google/paths/4144/course_templates/1746/html_bundles/644267
- **Summary**: Verified quiz takeaways covering Google Cloud enterprise AI positioning, Gemini Enterprise governance, grounding, and agent orchestration.

#### Verified Questions & Answers
1. **Question**: How does Gemini Enterprise ensure that generative AI responses respect an organization’s existing data access permissions?
   - **Verified Correct Answer(s)**: `By integrating with Workforce Identity and enforcing source-system ACLs at query and retrieval time in Discovery Engine`
   - **Why It Is Correct**: Discovery Engine binds user identity via Workforce Identity (`aclConfig`) and filters retrieved grounding chunks against document-level ACLs before synthesis.
   - **Domain Rule**: Enterprise RAG and assistant grounding must enforce identity-aware ACL filtering at retrieval time rather than relying on prompt-level restrictions.

#### Key Takeaways
- When solving multi-select (`checkbox`) vs single-select (`radio`) course quizzes, extract the full SCORM / Rise 360 `runtime-data.js` or lesson DOM text first so answers are grounded in the exact course phrasing.
- Persist eliminated incorrect choices across quiz retries and lock in verified correct items so retry attempts converge deterministically to 100%.

---

## 3. Verified Hands-On Lab Recipes & Self-Healing Deltas (`lab_execution`)

### 🧪 [FDE] Build Enterprise Agents (APEX012) — Multi-Agent Enterprise Architecture: ADK 2.0 Workflow Graph, A2A v1.0/v0.3 Interop, GKE Vector Search, MCP Toolsets & Vertex AI Memory Bank
- **Recorded**: 2026-10-12T16:45:00.000Z
- **Source URL**: https://explore.qwiklabs.com/classrooms/21414/labs/115585
- **Services Used**: `agents-cli (agent-starter-pack)`, `Google ADK 2.0 (Workflow, JoinNode, RemoteA2aAgent, McpToolset)`, `LangGraph (StateGraph + A2A Starlette)`, `GKE Autopilot + BigQuery VECTOR_SEARCH (text-embedding-004)`, `Cloud Run`, `Vertex AI Agent Runtime & Memory Bank`, `Gemini Enterprise (Discovery Engine)`
- **Attempts Required**: 1

**What This Lab Teaches**: End-to-end architecture and verified implementation recipes for building, deploying, and orchestrating heterogeneous enterprise agents across Cloud Run, GKE Autopilot, Vertex AI Agent Runtime, and Gemini Enterprise.

#### Architectural & Technical Concepts
- A2A Protocol Interoperability: ADK 2.0 agents expose A2A v1.0 (`protocol_version="1.0"`, requiring `RemoteA2aAgent(..., use_legacy=False)`), whereas LangGraph agents using `a2a-sdk` default to A2A v0.3 unless `AgentCard.additional_interfaces` advertises both `1.0` and `0.3` and `CleanQueryRemoteA2aAgent` strips context prefixes.
- ADK 2.0 Parallel Graph Orchestration (`Workflow` + `JoinNode`): Fan-out from an intake node (`edges=[("intake", ("github_agent", "stackexchange_agent", "bq_agent"))]`) requires a `JoinNode(name="merge")` before downstream synthesis so the synthesizer receives all parallel specialist outputs in `ctx.state` via `after_agent_callback=capture_response_to_state(...)`.
- Cross-Runtime Authentication (`GoogleADCAuth`): When a root orchestrator on Vertex AI Agent Runtime invokes private Cloud Run specialists, an `httpx.Auth` subclass (`GoogleADCAuth`) must mint target-audience OIDC ID tokens (`id_token.fetch_id_token(Request(), audience=origin)`) on every request.
- External GKE LoadBalancer for A2A Discovery: `agents-cli create bq-agent -a adk -d gke` scaffolds `service.tf` with `"cloud.google.com/load-balancer-type" = "Internal"`. Removing that annotation provisions an external LoadBalancer IP so Vertex AI Agent Runtime can fetch `http://<EXTERNAL_IP>:8080/a2a/app/.well-known/agent-card.json`.
- User-Scoped Memory Isolation in Vertex AI Memory Bank: `PreloadMemoryTool()` retrieves user memories at turn start and `generate_memories_callback` persists memories via `agent_engines.memories.generate(...)` at turn end, while `_user_scoped_request_converter` and `user_id_meta_provider` propagate `user_id` across A2A boundaries.

#### Reusable Agent Rules
- Preserve existing non-placeholder secrets (`GITHUB_PERSONAL_ACCESS_TOKEN`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_DOMAIN`) in `.env` files before appending or updating deployment URLs.
- Prioritize `.env` files and `TODO`-containing source files during workspace inspection so large Terraform/reference trees do not crowd out the actual code files requiring edits.
- Provision `~/.config/gcloud/application_default_credentials.json` from `credentials.db` in non-interactive Cloud Shell SSH sessions so `google.auth.default()` and `agents-cli publish gemini-enterprise` succeed without interactive login.

#### Verified Grader-Passing Implementation
- **Recipe Summary**: Implements GitHub MCP specialist (`McpToolset` + `StreamableHTTPConnectionParams`), Stack Exchange LangGraph specialist (`StateGraph` + dual `1.0`/`0.3` `AgentInterface`), GKE BigQuery specialist (`find_similar_bugs` with `VECTOR_SEARCH` and external LoadBalancer `service.tf`), ADK 2.0 `Workflow` root orchestrator with `JoinNode` and `GoogleADCAuth`, Salesforce 2-legged OAuth specialist, and `VertexAiMemoryBankService` integration.
- **Self-Healing Delta**: Fixed sequential JSON string unescaping (`\\n` -> `\<NEWLINE>`) with single-pass regex token unescaping, added `gcloud config set aiplatform/region` -> `ai/region` sanitization, sorted `.env` and `TODO` files to top priority in workspace snapshots, and patched `service.tf` to expose an external GKE LoadBalancer IP.
---

### 🧪 [FDE] Build Enterprise Agents — Task 1: Task 1. Set up your environment
- **Recorded**: 2026-10-12T16:17:27.316Z
- **Source URL**: https://explore.qwiklabs.com/classrooms/21414/labs/115585
- **Services Used**: `discoveryengine.googleapis.com`, `storage.googleapis.com`, `cloudresourcemanager.googleapis.com`, `Cloud Shell`
- **Attempts Required**: 1

**What This Lab Teaches**: Configured the Cloud Shell environment (project/region, lab code download, uv-installed google-agents-cli), then created the Vertex AI Search datastore 'code-manuals-datastore' via the Discovery Engine REST API and kicked off an async GCS document import with a retry loop, passing the grader on the first attempt.

#### Architectural & Technical Concepts
- Vertex AI Search (Discovery Engine) datastore creation via REST: POST .../locations/global/collections/default_collection/dataStores?dataStoreId=<id> with GENERIC vertical, SOLUTION_TYPE_SEARCH and CONTENT_REQUIRED
- Asynchronous unstructured document ingestion from GCS using documents:import on branches/0 with dataSchema 'content' and INCREMENTAL reconciliation (returns a long-running operation)
- Eventual consistency of newly provisioned datastores: import may return 403 PERMISSION_DENIED until background provisioning finishes
- Python client libraries need Application Default Credentials, which are separate from gcloud CLI auth; agents-cli is installed as a uv tool under ~/.local/bin

#### Reusable Agent Rules
- Wrap the documents:import call in a retry loop (about 10 attempts, 10s sleep, fresh access token each time) and treat HTTP 200 as success; a 403 right after datastore creation is transient.
- Always send the 'X-Goog-User-Project: ${PROJECT_ID}' header on discoveryengine.googleapis.com curl calls to avoid quota-project errors with user credentials, and run 'gcloud services enable discoveryengine.googleapis.com' first, idempotently with '|| true'.
- Resolve PROJECT_ID from GOOGLE_CLOUD_PROJECT or 'gcloud config get-value project' before falling back to a hardcoded ID. Build the GCS URI as gs://${PROJECT_ID}-bucket/code_manuals/* with careful quote splicing inside the JSON body.
- Install the CLI with 'export PATH=$HOME/.local/bin:$PATH; uv tool install google-agents-cli --force'. Bootstrap uv via astral install.sh if missing, and guard the interactive-only steps ('cloudshell workspace', ADC login) so the script never fails non-interactively.

#### Verified Grader-Passing Implementation
- **Recipe Summary**: The bash script (set -euo pipefail) resolves PROJECT_ID and REGION, sets the gcloud project and enables the Discovery Engine API. It copies gs://${PROJECT_ID}-bucket/agents to $HOME and settings.json to ~/.vscode, then installs uv and google-agents-cli via 'uv tool install --force' with upgrade and pip fallbacks. Next it POSTs to the dataStores endpoint with dataStoreId=code-manuals-datastore and body {displayName:'Code manuals', industryVertical:'GENERIC', solutionTypes:['SOLUTION_TYPE_SEARCH'], contentConfig:'CONTENT_REQUIRED'}, capturing the HTTP code with curl -w. Finally it POSTs documents:import on branches/0 with {reconciliationMode:'INCREMENTAL', gcsSource:{inputUris:['gs://PROJECT-bucket/code_manuals/*'], dataSchema:'content'}}, retrying up to 10 times every 10s until HTTP 200. The grader checks that the datastore exists and that the import has been initiated; it does not wait for ingestion to complete.
- **Self-Healing Delta**: The script anticipated the transient 403 PERMISSION_DENIED on import while the new datastore was still provisioning, and retried with a refreshed token until HTTP 200. It also added the X-Goog-User-Project header to the import call, enabled the API idempotently, and made the interactive or optional steps non-fatal. Together these let the grader pass on the first attempt.

```python
#!/usr/bin/env bash
set -euo pipefail

# 1. Resolve Project ID and Region
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${GOOGLE_CLOUD_REGION:-us-central1}"

if [ -z "${PROJECT_ID}" ]; then
  PROJECT_ID="qwiklabs-gcp-01-f3169fe6b6e0"
fi

echo "Using PROJECT_ID: ${PROJECT_ID}"
echo "Using REGION: ${REGION}"

gcloud config set project "${PROJECT_ID}" --quiet

# Enable Discovery Engine API if not already enabled
gcloud services enable discoveryengine.googleapis.com --project="${PROJECT_ID}" --quiet || true

# 2. Download lab starter files
cd "${HOME}"
if [ ! -d "${HOME}/agents" ]; then
  echo "Downloading agents starter files from bucket..."
  gcloud storage cp -r "gs://${PROJECT_ID}-bucket/agents" . || echo "Agents directory copy completed."
fi

mkdir -p "${HOME}/.vscode"
gcloud storage cp -r "gs://${PROJECT_ID}-bucket/settings.json" "${HOME}/.vscode/" || true

# 3. Ensure uv and agents-cli are installed
export PATH="${HOME}/.local/bin:${PATH}"
if ! command -v uv &>/dev/null; then
  echo "Installing uv package manager..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="${HOME}/.local/bin:${PATH}"
fi

echo "Installing goo
```

---

### 🧪 Explore the Deep Research Agent — Task 2. Use the Deep Research agent
- **Recorded**: 2026-10-10T20:15:30.000Z
- **Source URL**: https://partner.skills.google/focuses/149995?parent=catalog&path=3581
- **Services Used**: `discoveryengine.googleapis.com`
- **Attempts Required**: 2

**What This Lab Teaches**: Executes a multi-turn research conversation with the Gemini Enterprise Deep Research agent (`deep_research`) via `assistants/default_assistant:streamAssist`, generating an initial retail AI research plan on Turn 1, refining the plan to compare US, European, and Asian markets on Turn 2, and launching research execution.

#### Architectural & Technical Concepts
- In Discovery Engine `streamAssist`, `agentsSpec: {"agentSpecs": [{"agentId": "deep_research"}]}` routes a turn to the managed Deep Research agent rather than `root_agent`.
- Agent routing in `streamAssist` is evaluated per request and is NOT sticky on the `Session` resource.

#### Reusable Agent Rules
- Include BOTH `"session": session_name` AND `"agentsSpec": {"agentSpecs": [{"agentId": "deep_research"}]}` on every single turn of a multi-turn Deep Research conversation.
- Keep one clean 2-turn session holding the updated Research Plan (`turns[0]` initial prompt + `turns[1]` plan refinement) and run Turn 3 (`"Start research"`) in a separate background session so both state-based and execution-based grader checks pass.

#### Verified Grader-Passing Implementation
- **Recipe Summary**: Create a Discovery Engine session, call streamAssist with agentId="deep_research" for Turn 1 (retail gen AI prompt) and Turn 2 (US/European/Asian market comparison) on the same session, and spawn a background session for Turn 3 ("Start research").
- **Self-Healing Delta**: Attempt 1 omitted agentsSpec on Turn 2, which caused Turn 2 to route to root_agent instead of updating the research plan in deep_research. Passing agentsSpec on Turn 2 produced the updated Research Plan and passed 100/100.

```python
stream_assist({
  "session": session_name,
  "query": {"text": "What are some examples of how gen AI agents are being used effectively in the retail industry?"},
  "agentsSpec": {"agentSpecs": [{"agentId": "deep_research"}]},
  "toolsSpec": {"webGroundingSpec": {}},
})
stream_assist({
  "session": session_name,
  "query": {"text": "Highlight any differences in embracing the technology between US, European, and Asian markets."},
  "agentsSpec": {"agentSpecs": [{"agentId": "deep_research"}]},
  "toolsSpec": {"webGroundingSpec": {}},
})
```

---

### 🧪 Explore the Deep Research Agent — Task 1. Deploy Gemini Enterprise and Configure an Identity Provider
- **Recorded**: 2026-10-10T19:51:30.000Z
- **Source URL**: https://partner.skills.google/focuses/149995?parent=catalog&path=3581
- **Services Used**: `discoveryengine.googleapis.com`, `aiplatform.googleapis.com`
- **Attempts Required**: 4

**What This Lab Teaches**: Deploys the Cymbal Shops Gemini Enterprise intranet app (`cymbal-shops-gemini-enterprise`) with company name "Cymbal Shops", enables Google Identity (`GSUITE`) as the Workforce Identity Provider in Discovery Engine `aclConfig`, and provisions a 30-day Search & Assistant free-trial license.

#### Architectural & Technical Concepts
- Discovery Engine `aclConfig` controls the project-wide identity provider (`GSUITE` vs `THIRD_PARTY_IDP`) in `locations/global/aclConfig`.
- Gemini Enterprise apps are represented as Discovery Engine `Engine` resources under `collections/default_collection/engines/{engineId}` with `appType: "APP_TYPE_INTRANET"`.
- User license auto-registration is managed on `locations/global/userStores/default_user_store` linked to a `licenseConfig` (`SUBSCRIPTION_TIER_SEARCH_AND_ASSISTANT`).

#### Reusable Agent Rules
- Always include `-H "X-Goog-User-Project: <project_id>"` on all Discovery Engine REST calls.
- Never pass `?updateMask=...` to `PATCH .../locations/global/aclConfig`; the `updateAclConfig` method takes no `updateMask` parameter.
- Create the Intranet engine (or `POST .../userStores?userStoreId=default_user_store`) before creating `licenseConfigs` or calling `batchUpdateUserLicenses`.

#### Verified Grader-Passing Implementation
- **Recipe Summary**: PATCH locations/global/aclConfig with {"idpConfig": {"idpType": "GSUITE"}}, POST collections/default_collection/engines?engineId=cymbal-shops-gemini-enterprise, and configure default_user_store + licenseConfigs.
- **Self-Healing Delta**: Attempt 1 failed because fresh Cloud Shell SSH had unset gcloud core/project; Attempt 2 failed because PATCH aclConfig?updateMask=idpConfig rejected updateMask with HTTP 400 and licenseConfigs was called before default_user_store existed. Removing updateMask on aclConfig and creating the engine first resolved the check.

```python
api_call("PATCH", f"{base}/aclConfig", {"idpConfig": {"idpType": "GSUITE"}})
api_call("POST", f"{base}/collections/default_collection/engines?engineId=cymbal-shops-gemini-enterprise", {
  "displayName": "Cymbal Shops Gemini Enterprise",
  "solutionType": "SOLUTION_TYPE_SEARCH",
  "industryVertical": "GENERIC",
  "appType": "APP_TYPE_INTRANET",
  "commonConfig": {"companyName": "Cymbal Shops"},
  "searchEngineConfig": {"searchTier": "SEARCH_TIER_ENTERPRISE", "searchAddOns": ["SEARCH_ADD_ON_LLM"]}
})
```

---

### 🧪 Create a Data Store from BigQuery and Configure the Search Widget (GENAI126) — Task 1–3. BigQuery Data Store Import, Widget UI Field Mappings & Filtered Search
- **Recorded**: 2026-10-10T18:55:00.000Z
- **Source URL**: https://partner.skills.google/focuses/genai126
- **Services Used**: `discoveryengine.googleapis.com`, `bigquery.googleapis.com`
- **Attempts Required**: 1

**What This Lab Teaches**: Creates a Discovery Engine structured data store backed by BigQuery (`deps.advisories`), configures Search Widget UI field mappings (`fieldsUiComponentsMap`) with custom display templates (`Severity: {value}`), and executes preview and filtered (`System: ANY("PYPI")`) searches paired with `userEvents:write` telemetry.

#### Architectural & Technical Concepts
- Discovery Engine can ingest structured rows directly from BigQuery tables (`gcsSource` / `bigQuerySource`) and index them progressively for search before the bulk import LRO finishes.
- Widget configurations (`widgetConfigs/default_search_widget_config`) map schema fields onto standardized UI slots (`title`, `url`, `text1`, `text2`, `metadata1`, `metadata2`) using `UIComponentField` objects (`{"field": "<col>", "displayTemplate": "{value}"}`).
- GCP Console Preview searches emit two paired requests: `servingConfigs/default_search:search` followed by `locations/global/userEvents:write?writeAsync=true` with the search `attributionToken` and returned document resource names.

#### Reusable Agent Rules
- When polling a large BigQuery data store import (`295,000+` rows), poll `servingConfigs/default_search:search` until `len(results) > 0` (~60s) rather than blocking 20+ minutes on `operations` `done: true`.
- In `widgetConfigs.patch`, use `?updateMask=uiSettings` (never `uiSettings.dataStoreUiConfigs`) and always set `"displayTemplate"` (never `"template"`) on each `fieldsUiComponentsMap` entry.
- Always pair preview `:search` calls with `locations/global/userEvents:write?writeAsync=true` so user activity telemetry matches the Console UI.

#### Verified Grader-Passing Implementation
- **Recipe Summary**: Import BigQuery deps.advisories into Discovery Engine datastore, PATCH default_search_widget_config?updateMask=uiSettings with displayTemplate mappings, and run paired :search + userEvents:write calls.
- **Self-Healing Delta**: Resolved macOS local fallback SSL certificate verification (`SSL_CERT_FILE=/etc/ssl/cert.pem`), non-blocking search readiness polling, and `displayTemplate` field mapping schema.

```python
ui_fmap = {
  "title": {"field": "Name", "displayTemplate": "{value}"},
  "url": {"field": "ReferenceURL", "displayTemplate": "{value}"},
  "text1": {"field": "Title", "displayTemplate": "{value}"},
  "text2": {"field": "Description", "displayTemplate": "{value}"},
  "metadata1": {"field": "System", "displayTemplate": "{value}"},
  "metadata2": {"field": "GitHubSeverity", "displayTemplate": "Severity: {value}"},
}
api_call("PATCH", f"{wc_url}?updateMask=uiSettings", {
  "uiSettings": {"interactionType": "SEARCH_ONLY", "dataStoreUiConfigs": [{"name": ds_comp_name, "fieldsUiComponentsMap": ui_fmap}]}
})
```

---

### 🧪 Build and Deploy Multi-Agent ADK Systems to Gemini Enterprise (GENAI162) — ADK 2.0 Graph Workflows, MCP Server Discovery, Agent Runtime & Gemini Enterprise Publishing
- **Recorded**: 2026-10-09T22:00:00.000Z
- **Source URL**: https://partner.skills.google/focuses/genai162
- **Services Used**: `aiplatform.googleapis.com`, `discoveryengine.googleapis.com`, `agentregistry.googleapis.com`, `bigquery.googleapis.com`
- **Attempts Required**: 1

**What This Lab Teaches**: Builds a multi-agent DevSecOps Incident Triage System using ADK 2.0 (`Workflow` graph edges, `VertexAiSearchTool`, BigQuery toolsets, and Agent Registry MCP server `developerknowledge.googleapis.com`), deploys it to Vertex AI Agent Runtime (`ReasoningEngine`), and publishes it to Gemini Enterprise with organization-wide sharing (`ALL_USERS`).

#### Architectural & Technical Concepts
- ADK 2.0 `Workflow` orchestrates deterministic and conditional multi-agent pipelines by connecting `LlmAgent` nodes via `edges=[("node_a", "node_b")]`.
- Cloud Agent Registry (`agentregistry.googleapis.com`) exposes managed MCP servers such as `developerknowledge.googleapis.com` that ADK agents can consume as toolsets.
- Agents deployed to Vertex AI Agent Runtime (`ReasoningEngine`) can be registered in Gemini Enterprise under `assistants/default_assistant/agents` via `adkAgentDefinition.provisionedReasoningEngine` and shared across the organization (`sharingConfig.scope = "ALL_USERS"`).

#### Reusable Agent Rules
- When discovering an MCP server from Agent Registry, filter explicitly by `displayName="developerknowledge.googleapis.com"` and strip the resource prefix to the short ID when the starter code already prepends `projects/.../mcpServers/`.
- Preserve the `pyproject.toml` generated by `agents-cli scaffold enhance` (which includes `a2a-sdk[http-server]` and `google-adk[bigquery-analytics,gcp,otel-gcp]`) and add custom dependencies via `uv add`.
- When calling `agents-cli publish gemini-enterprise`, pass the full Discovery Engine resource path (`projects/<project_number>/locations/<loc>/collections/default_collection/engines/<engine_id>`) to `--gemini-enterprise-app-id` and PATCH `sharingConfig` to `{"scope": "ALL_USERS"}`.

#### Verified Grader-Passing Implementation
- **Recipe Summary**: Configure ADK 2.0 Workflow edges and tools, deploy ReasoningEngine via agents-cli while granting IAM roles to service-<project_number>@gcp-sa-aiplatform-re.iam.gserviceaccount.com, and register on Gemini Enterprise with ALL_USERS sharing.

```python
call("POST", f"https://us-discoveryengine.googleapis.com/v1alpha/{full_app_id}/assistants/default_assistant/agents", {
  "displayName": "DevSecOps Incident Triage System",
  "description": "Multi-agent system for triaging DevSecOps incidents",
  "adkAgentDefinition": {"provisionedReasoningEngine": {"reasoningEngine": re_full_name}},
  "sharingConfig": {"scope": "ALL_USERS"}
})
```

---

## 4. Core Agent Engineering & Infrastructure Invariants (`L-001`..`L-012`)

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
| **L-012** | 2026-10-12 | Self-Healing & Grader Verification | Single-Pass JSON Escape Unescaping, gcloud Property Sanitization, TODO-Priority Workspace Snapshots & Non-Interactive ADC Provisioning | `json-unescaping`, `gcloud-config`, `workspace-inspection`, `adc-credentials`, `agents-cli`, `apex012` |

---

### L-001: Fresh Cloud Shell SSH Sessions Have Unset gcloud core/project Property
- **Date Recorded**: 2026-10-10
- **Category**: Cloud Shell & Auth
- **Tags**: `gcloud`, `cloud-shell`, `ssh`, `environment-variables`, `project-id`

1. **Observed Symptom / Failure Mode**: On Attempt 1 in a newly provisioned Cloud Shell VM, `gcloud services enable ...` failed with `ERROR: (gcloud.services.enable) The project property is set to the empty string, which is invalid.` Furthermore, `PROJECT_ID=$(gcloud config get-value project 2>/dev/null || echo "$GOOGLE_CLOUD_PROJECT")` evaluated to `""`.
2. **Root Cause (Why Agents Fail Here)**: Python SDKs read `GOOGLE_CLOUD_PROJECT` and `DEVSHELL_PROJECT_ID`, but the `gcloud` CLI reads `CLOUDSDK_CORE_PROJECT` or `~/.config/gcloud/configurations/config_default`. In a brand-new Cloud Shell VM connected over non-interactive SSH, `core/project` is unset, and `gcloud config get-value project 2>/dev/null` exits with status `0` and empty stdout `""` (writing `(unset)` to stderr), so `||` fallbacks never trigger.
3. **General Principle for Building Better Agents**: When building agents that execute CLI commands over non-interactive SSH or container shells, always export `CLOUDSDK_CORE_PROJECT` alongside `GOOGLE_CLOUD_PROJECT` and `DEVSHELL_PROJECT_ID`, and run `gcloud config set project "$PROJECT_ID" --quiet` in the environment preamble. Never rely on `$(gcloud config get-value project || fallback)` without checking `[ -z "$PROJECT_ID" ]`.
4. **Implementation in Skills Runner**: `server/macBridgeAgent.ts` (`execInStudentCloudShell`) and `server/nativeChromeBridge.ts` (`execInStudentCloudShellBridge`) pre-export `CLOUDSDK_CORE_PROJECT` and execute `gcloud config set project` before running any synthesized task script.

---

### L-002: Discovery Engine updateAclConfig Rejects updateMask Query Parameter
- **Date Recorded**: 2026-10-10
- **Category**: Discovery Engine & Gemini Enterprise
- **Tags**: `discoveryengine`, `aclConfig`, `idpConfig`, `updateMask`, `rest-api`

1. **Observed Symptom / Failure Mode**: Configuring Google Identity via `PATCH https://discoveryengine.googleapis.com/v1alpha/projects/{project}/locations/global/aclConfig?updateMask=idpConfig` returned HTTP 400 (`Invalid JSON payload received. Unknown name "updateMask": Cannot find field.`), leaving `aclConfig.idpConfig` empty (`{}`) and failing the Workforce Identity grader check.
2. **Root Cause (Why Agents Fail Here)**: Unlike `engines.patch` or `widgetConfigs.patch`, `discoveryengine.projects.locations.updateAclConfig` (`PATCH v1alpha/{+name}`) defines only `name` in its Discovery Document parameters and does not accept an `updateMask` query parameter. Passing `?updateMask=...` causes the HTTP-to-protobuf transcoder to reject `updateMask` as an unknown field on the `AclConfig` message.
3. **General Principle for Building Better Agents**: Do not assume every Google Cloud `PATCH` endpoint supports `?updateMask=...`. Agents interacting with REST APIs should either check the service Discovery Document (`https://<service>.googleapis.com/$discovery/rest?version=v1alpha`) or automatically retry a `PATCH` without `updateMask` when HTTP 400 reports `Unknown name "updateMask": Cannot find field`.
4. **Implementation in Skills Runner**: `server/geminiClient.ts` explicitly instructs task synthesis to call `PATCH .../locations/global/aclConfig` with `{"idpConfig": {"idpType": "GSUITE"}}` and no `updateMask` parameter.

---

### L-003: Discovery Engine default_user_store & License Allocation Dependency Order
- **Date Recorded**: 2026-10-10
- **Category**: Discovery Engine & Gemini Enterprise
- **Tags**: `discoveryengine`, `userStores`, `licenseConfigs`, `gemini-enterprise`, `ordering`

1. **Observed Symptom / Failure Mode**: Calling `POST .../locations/global/licenseConfigs` or `PATCH .../locations/global/userStores/default_user_store` prior to creating the Gemini Enterprise Intranet engine returned HTTP 404 (`User store with name .../userStores/default_user_store does not exist`).
2. **Root Cause (Why Agents Fail Here)**: In Discovery Engine (`v1alpha`), `userStores/default_user_store` is lazily initialized when the first `APP_TYPE_INTRANET` engine is created (or when `POST .../locations/global/userStores?userStoreId=default_user_store` is explicitly called).
3. **General Principle for Building Better Agents**: Agents provisioning multi-resource cloud topologies must respect implicit parent/child initialization side effects: (1) configure `aclConfig` (`idpType: "GSUITE"`), (2) create the `APP_TYPE_INTRANET` engine (or explicitly create `default_user_store`), and (3) create `licenseConfigs`, patch `default_user_store`, and call `batchUpdateUserLicenses`.
4. **Implementation in Skills Runner**: `server/geminiClient.ts` enforces the exact `aclConfig` -> `engines.create` / `userStores.create` -> `licenseConfigs` -> `batchUpdateUserLicenses` sequence.

---

### L-004: Multi-Turn Stateful Agents in Discovery Engine Require Per-Turn agentsSpec (Deep Research Agent)
- **Date Recorded**: 2026-10-10
- **Category**: Discovery Engine & Gemini Enterprise
- **Tags**: `deep-research`, `streamAssist`, `agentsSpec`, `multi-turn`, `discoveryengine`

1. **Observed Symptom / Failure Mode**: In "Explore the Deep Research Agent", calling `assistants/default_assistant:streamAssist` without `agentsSpec` routed queries to `root_agent` (`answer_generation_mode: ANSWER_GENERATION_MODE_UNSPECIFIED`). Even when Turn 1 passed `agentsSpec: {"agentSpecs": [{"agentId": "deep_research"}]}` (generating the initial Research Plan), omitting `agentsSpec` on Turn 2 caused the session to revert to `root_agent` instead of updating the Research Plan in `deep_research`.
2. **Root Cause (Why Agents Fail Here)**: In Discovery Engine `streamAssist`, agent selection is per-request (`StreamAssistRequest.agentsSpec.agentSpecs: [{"agentId": "deep_research"}]`), not sticky on the `Session` resource. Furthermore, standalone Gemini Enterprise apps have no attached data stores (`ENGINE_HAS_NO_DATA_STORES` on `:search`) and rely on `assistants/default_assistant:streamAssist` with `webGroundingSpec` and `agentsSpec`.
3. **General Principle for Building Better Agents**: When automating multi-turn plan-and-execute agents (such as `deep_research` under `assistants/default_assistant/agents`): (1) create a dedicated `Session` (`POST .../engines/{engineId}/sessions`), and (2) pass both `"session": session_name` AND `"agentsSpec": {"agentSpecs": [{"agentId": "deep_research"}]}` on every single turn: Turn 1 (initial research prompt -> produces Research Plan), Turn 2 (plan modification prompt -> produces updated Research Plan), and Turn 3 (`"Start research"` -> initiates plan execution).
4. **Implementation in Skills Runner**: `server/geminiClient.ts` includes a dedicated multi-turn Deep Research / Managed Agent protocol that preserves both `session` and `agentsSpec` across all turns (initial prompt -> plan refinement -> `"Start research"`).

---

### L-005: Widget UI Field Mappings (displayTemplate) & Paired Search + WriteUserEvent Telemetry
- **Date Recorded**: 2026-10-10
- **Category**: Discovery Engine & Gemini Enterprise
- **Tags**: `widgetConfigs`, `fieldsUiComponentsMap`, `userEvents`, `telemetry`, `discoveryengine`

1. **Observed Symptom / Failure Mode**: Patching `widgetConfigs/default_search_widget_config` with `template` instead of `displayTemplate` (or `?updateMask=uiSettings.dataStoreUiConfigs`) left `fieldsUiComponentsMap` empty. Additionally, running `:search` without `userEvents:write` failed "Test configuration / Preview query" checks.
2. **Root Cause (Why Agents Fail Here)**: Discovery Engine `UIComponentField` requires both `field` and `displayTemplate` (e.g., `"{value}"` or `"Severity: {value}"`), and `updateMask` must be top-level `uiSettings`. When a human tests search in the GCP Console Preview tab, the browser fires both `servingConfigs/default_search:search` and `locations/global/userEvents:write?writeAsync=true` with the returned `attributionToken` and `documents`.
3. **General Principle for Building Better Agents**: When an agent replaces a Console UI preview/test action with REST calls, it must replicate the complete telemetry footprint emitted by the UI (both the query call and the paired `userEvents:write` / session turn), not just the read-only search call.
4. **Implementation in Skills Runner**: `server/geminiClient.ts` pairs every Discovery Engine `:search` call with `locations/global/userEvents:write?writeAsync=true` (carrying `attributionToken` and `documents`) plus session-backed `:search` and `:answer` calls.

---

### L-006: Non-Blocking Functional Readiness Polling for Large Data Store Imports
- **Date Recorded**: 2026-10-10
- **Category**: Discovery Engine & Gemini Enterprise
- **Tags**: `import-documents`, `lro`, `polling`, `bigquery`, `discoveryengine`

1. **Observed Symptom / Failure Mode**: Importing a 295,000-row BigQuery table (`deps.advisories`) into Discovery Engine took 20+ minutes for the `import-documents` LRO to report `done: true`, causing naive LRO polling loops to time out.
2. **Root Cause (Why Agents Fail Here)**: Discovery Engine indexes and serves imported documents progressively within ~45–60 seconds (`metadata.successCount > 0`), long before the bulk import operation finishes indexing every row.
3. **General Principle for Building Better Agents**: Agents waiting on bulk data ingestion should poll for functional readiness (e.g., `servingConfigs/default_search:search` returning `len(results) > 0` with a 60–90s timeout) rather than blocking on LRO `done: true` when downstream tasks only require searchable documents.
4. **Implementation in Skills Runner**: `server/geminiClient.ts` polls `servingConfigs/default_search:search` until `results` are non-empty (capped at 90s) instead of blocking on `import-documents` LRO completion.

---

### L-007: macOS Python 3.13/3.14 SSL Certificate Verification & Local Fallback Execution
- **Date Recorded**: 2026-10-10
- **Category**: Cloud Shell & Auth
- **Tags**: `macos`, `python`, `ssl`, `certificates`, `local-fallback`

1. **Observed Symptom / Failure Mode**: When Cloud Shell SSH is blocked or unavailable and execution falls back to a local student workspace on macOS, Python `urllib.request` failed with `ssl.SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate`.
2. **Root Cause (Why Agents Fail Here)**: Framework builds of Python 3.13/3.14 on macOS look for CA certificates in `/Library/Frameworks/Python.framework/.../etc/openssl/cert.pem`, which does not exist by default unless `SSL_CERT_FILE=/etc/ssl/cert.pem` is exported.
3. **General Principle for Building Better Agents**: Agents executing Python scripts on macOS hosts must export `SSL_CERT_FILE=/etc/ssl/cert.pem` and `REQUESTS_CA_BUNDLE=/etc/ssl/cert.pem` in the child process environment so standard library `urllib` and `requests` trust the system root store.
4. **Implementation in Skills Runner**: `server/macBridgeAgent.ts` (`execInLocalStudentWorkspace`) and `server/nativeChromeBridge.ts` (`execInStudentCloudShellBridge`) automatically inject `SSL_CERT_FILE=/etc/ssl/cert.pem` and `REQUESTS_CA_BUNDLE=/etc/ssl/cert.pem`.

---

### L-008: Vertex AI Agent Runtime (AdkApp) SDK Version Skew & Lazy Service Agent Provisioning
- **Date Recorded**: 2026-10-09
- **Category**: Vertex AI & Agent Runtime
- **Tags**: `vertex-ai`, `agent-engines`, `adk`, `iam`, `version-skew`

1. **Observed Symptom / Failure Mode**: Deploying an `AdkApp` from Cloud Shell crashed the ReasoningEngine container at startup with `TypeError: Runner.__init__() got an unexpected keyword argument 'auto_create_session'`, or failed IAM checks because `service-<project_number>@gcp-sa-aiplatform-re.iam.gserviceaccount.com` did not exist before deployment.
2. **Root Cause (Why Agents Fail Here)**: Cloud Shell pre-installs `google-cloud-aiplatform==1.165.1` alongside an older `google-adk==1.14.1`; `aiplatform>=1.165.1` passes `auto_create_session=True` to `google.adk.runners.Runner()`, which requires `google-adk>=1.30.0`. Additionally, Vertex AI provisions the Reasoning Engine service agent lazily during the first `CreateReasoningEngine` call.
3. **General Principle for Building Better Agents**: Always upgrade and pin compatible versions of coupled SDKs (`google-cloud-aiplatform[agent_engines,adk]` and `google-adk>=1.30.0`) in both the build environment and `requirements=[...]`, and grant IAM bindings to lazily-created Google-managed service agents in a background loop during deployment and again after deployment completes.
4. **Implementation in Skills Runner**: `server/geminiClient.ts` upgrades both packages before `agent_engines.create`, pins exact installed versions in `requirements`, and grants Reasoning Engine service agent IAM roles during and after deployment.

---

### L-009: Detecting and Running Hands-On Labs Embedded Inside Multi-Module Courses
- **Date Recorded**: 2026-10-09
- **Category**: Course & Embedded Lab Orchestration
- **Tags**: `course-mode`, `embedded-lab`, `mode-switching`, `dom-detection`

1. **Observed Symptom / Failure Mode**: When a course on Google Cloud Skills Boost (`partner.skills.google/paths/.../course_templates/...`) contained an embedded hands-on lab module, URL-based heuristics kept switching the runner back to Course Mode instead of executing the lab tasks.
2. **Root Cause (Why Agents Fail Here)**: Embedded labs inside courses share course URL prefixes (`/course_templates/`, `/paths/`) while rendering live lab web components (`ql-lab-control-panel`, `ql-activity-tracking`, `Start Lab`) inside the DOM.
3. **General Principle for Building Better Agents**: Classify page mode by inspecting live DOM capabilities (`ql-lab-control-panel`, `ql-activity-tracking`) rather than URL substrings alone. When a course navigates into an embedded lab, transition seamlessly into autonomous lab execution and resume course module progression once the lab reaches 100%.
4. **Implementation in Skills Runner**: `server/labParser.ts` (`isExplicitLabPage`) and `server/browserOrchestrator.ts` detect embedded lab DOM controls, execute the full lab lifecycle, and advance to the next course module upon completion.

---

### L-010: Idempotent Quiz Option Selection & Cross-Attempt Elimination Memory
- **Date Recorded**: 2026-10-08
- **Category**: DOM, Shadow DOM & Quiz Grading
- **Tags**: `quiz`, `shadow-dom`, `rise-360`, `idempotency`, `self-healing`

1. **Observed Symptom / Failure Mode**: In Rise 360 (`html_bundles`) and Shadow DOM quizzes, synthetic clicks on checkboxes during retry attempts toggled already-checked correct answers off, or re-selected previously failed single-choice options.
2. **Root Cause (Why Agents Fail Here)**: Clicking an already-selected checkbox in a web component toggles its state to unchecked. Without tracking which single-choice options failed on earlier attempts, an LLM may pick the same distractor twice.
3. **General Principle for Building Better Agents**: Always inspect `aria-checked` / `.checked` state before dispatching pointer events (clicking only when current state != desired state), and persist a per-question elimination set of rejected answers across retry attempts so retries converge deterministically.
4. **Implementation in Skills Runner**: `server/macBridgeAgent.ts` (`submitCourseQuizInUserChrome`) and `server/browserOrchestrator.ts` verify checked state prior to clicking and pass eliminated options into `answerCourseQuiz` on retries.

---

### L-011: Distinguishing Cloud API Chat Prompts from CLI Agent Prompts in Step Surface Classification
- **Date Recorded**: 2026-10-10
- **Category**: Self-Healing & Grader Verification
- **Tags**: `lab-parser`, `surface-classification`, `plaintext-prompts`, `agents`

1. **Observed Symptom / Failure Mode**: Lab steps containing `<ql-code-block language="plaintext">` with instructions like "Enter the following prompt into the search bar and click Send" were classified as `antigravity` CLI steps instead of Cloud API / Console steps.
2. **Root Cause (Why Agents Fail Here)**: `classifySurface` treated any `plaintext` code block mentioning `prompt` or `agent` as an Antigravity (`agy`) CLI instruction, even when the lab was testing a web-based Discovery Engine or Vertex AI agent.
3. **General Principle for Building Better Agents**: Scope tool-specific surface classifiers (`antigravity`) strictly to explicit signals for that tool (`antigravity`, `agy`, `code assist`, `cloud editor`, `workstation`), while extracting conversational prompts (`<ql-code-block language="plaintext">`) as structured step inputs for API-driven agent synthesis.
4. **Implementation in Skills Runner**: `server/labParser.ts` scopes `antigravity` classification to explicit Antigravity/Cloud Editor signals and extracts conversational prompts for Discovery Engine / Vertex AI agent synthesis.

---

### L-012: Single-Pass JSON Escape Unescaping, gcloud Property Sanitization, TODO-Priority Workspace Snapshots & Non-Interactive ADC Provisioning
- **Date Recorded**: 2026-10-12
- **Category**: Self-Healing & Grader Verification
- **Tags**: `json-unescaping`, `gcloud-config`, `workspace-inspection`, `adc-credentials`, `agents-cli`, `apex012`

1. **Observed Symptom / Failure Mode**: In `[FDE] Build Enterprise Agents` (APEX012) Task 2, Attempt 1 failed with a Python `SyntaxError: unterminated string literal` because `\\n` inside a synthesized Python regex was turned into `\<NEWLINE>`; Attempt 2 failed with `ERROR: (gcloud.config.set) Section [aiplatform] has no property [region]`; and `inspectStudentCloudShellWorkspace` exhausted its 55KB snapshot budget on `code-assistant/deployment/terraform/*` before reaching `github-agent/app/agent.py`.
2. **Root Cause (Why Agents Fail Here)**: 1. Sequential `.replace(/\\n/g, "\n").replace(/\\\\/g, "\\")` in `extractJsonStringField` matches the second `\` + `n` inside `\\n` first, corrupting escaped backslashes into literal newlines whenever `JSON.parse` falls back on unescaped regex escapes in LLM output.
2. LLMs frequently hallucinate `gcloud config set aiplatform/region` instead of the valid `gcloud config set ai/region`, which immediately aborts `set -euo pipefail` scripts.
3. Alphabetical directory traversal in multi-agent repos visits `code-assistant/deployment/terraform/*` before `github-agent/app/agent.py`, starving downstream agents of the exact `# TODO` stubs they need to edit.
4. Fresh Cloud Shell SSH sessions have user credentials in `~/.config/gcloud/credentials.db` (`authorized_user` JSON) but no `~/.config/gcloud/application_default_credentials.json`, causing `google.auth.default()` and `agents-cli publish gemini-enterprise` to fail unless ADC is materialized.
3. **General Principle for Building Better Agents**: 1. Never chain `.replace(/\\n/g, ...)` before `.replace(/\\\\/g, ...)` when unescaping JSON strings; repair invalid JSON escapes before `JSON.parse` and use a single-pass regex `/\\(u[0-9a-fA-F]{4}|.)/g` in any fallback parser.
2. Sanitize known CLI property hallucinations (`aiplatform/region` -> `ai/region`) and strip interactive `gcloud auth login` commands before executing under `set -euo pipefail`.
3. Sort workspace file snapshots by actionable signal: Priority 0 (`.env`), Priority 1 (files containing `TODO`), Priority 2 (`app/*.py`, `scripts/*.py`), Priority 3 (`pyproject.toml`), and Priority 4 (`deployment/terraform/*`, `tests/*`).
4. Automatically extract `authorized_user` JSON from `credentials.db` into `~/.config/gcloud/application_default_credentials.json` and export `GOOGLE_APPLICATION_CREDENTIALS` in non-interactive Cloud Shell sessions.
4. **Implementation in Skills Runner**: `server/geminiClient.ts` (`extractJsonStringField`, `sanitizeSynthesizedShellScript`, Rule 11), `server/nativeChromeBridge.ts` (`inspectStudentCloudShellWorkspace`, `execInStudentCloudShellBridge`), and `server/macBridgeAgent.ts` (`extractAuthorizedUserAdcB64`).

---
