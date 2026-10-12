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

export type KnowledgeStreamType = 'course_content' | 'quiz_mastery' | 'lab_execution';

export interface MemorializedQuizQA {
  question: string;
  verifiedAnswers: string[];
  eliminatedWrongOptions?: string[];
  explanation: string;
  domainRule: string;
}

export interface MemorializedLabRecipe {
  servicesUsed: string[];
  verifiedScriptSummary: string;
  verifiedScriptSnippet: string;
  attemptsRequired: number;
  selfHealingDelta?: string;
}

export interface MemorializedKnowledgeEntry {
  id: string;
  timestamp: string;
  stream: KnowledgeStreamType;
  courseOrLabTitle: string;
  moduleOrTaskTitle: string;
  sourceUrl: string;
  summary: string;
  conceptsAndCapabilities: string[];
  agentRulesAndTakeaways: string[];
  quizQa?: MemorializedQuizQA[];
  labRecipe?: MemorializedLabRecipe;
  tags: string[];
}

export const SEED_MEMORIALIZED_KNOWLEDGE: MemorializedKnowledgeEntry[] = [
  {
    id: 'course-gemini-enterprise-deep-research-overview',
    timestamp: '2026-10-10T19:45:00.000Z',
    stream: 'course_content',
    courseOrLabTitle: 'Explore the Deep Research Agent',
    moduleOrTaskTitle: 'Gemini Enterprise Architecture & Managed Deep Research Agent',
    sourceUrl: 'https://partner.skills.google/focuses/149995?parent=catalog&path=3581',
    summary:
      'Gemini Enterprise is an intranet-ready AI assistant and enterprise search application built on Google Cloud Discovery Engine. It includes a managed Deep Research agent (`deep_research`) that autonomously plans, refines, and executes multi-step research across internal data stores and Google Search grounding.',
    conceptsAndCapabilities: [
      'Gemini Enterprise (`APP_TYPE_INTRANET`, `SOLUTION_TYPE_SEARCH`, `SEARCH_TIER_ENTERPRISE` + `SEARCH_ADD_ON_LLM`) unifies enterprise search, grounded chat (`default_assistant`), and specialized multi-step agents.',
      'Workforce Identity configuration (`aclConfig` with `idpType: "GSUITE"` or third-party OIDC/SAML) governs user access and license enforcement across the organization.',
      'The managed Deep Research agent (`assistants/default_assistant/agents/deep_research`) operates in a structured two-phase workflow: (1) interactive Research Plan generation and user refinement in chat, followed by (2) autonomous multi-source web/enterprise research synthesis into a comprehensive cited report.',
    ],
    agentRulesAndTakeaways: [
      'When automating Gemini Enterprise deployment via REST (`discoveryengine.googleapis.com/v1alpha`), configure `aclConfig` (`{"idpConfig": {"idpType": "GSUITE"}}`) without `updateMask`, provision the `APP_TYPE_INTRANET` engine first, and then configure `default_user_store` and `licenseConfigs`.',
      'When interacting with the Deep Research agent via `assistants/default_assistant:streamAssist`, pass `"agentsSpec": {"agentSpecs": [{"agentId": "deep_research"}]}` and the same `session` resource path on every turn (Turn 1: initial research topic -> Turn 2: research plan modification -> Turn 3: "Start research").',
    ],
    tags: [
      'gemini-enterprise',
      'deep-research',
      'discoveryengine',
      'workforce-identity',
      'research-plan',
    ],
  },
  {
    id: 'lab-explore-deep-research-agent-task-1',
    timestamp: '2026-10-10T19:51:30.000Z',
    stream: 'lab_execution',
    courseOrLabTitle: 'Explore the Deep Research Agent',
    moduleOrTaskTitle: 'Task 1. Deploy Gemini Enterprise and Configure an Identity Provider',
    sourceUrl: 'https://partner.skills.google/focuses/149995?parent=catalog&path=3581',
    summary:
      'Deploys the Cymbal Shops Gemini Enterprise intranet app (`cymbal-shops-gemini-enterprise`) with company name "Cymbal Shops", enables Google Identity (`GSUITE`) as the Workforce Identity Provider in Discovery Engine `aclConfig`, and provisions a 30-day Search & Assistant free-trial license.',
    conceptsAndCapabilities: [
      'Discovery Engine `aclConfig` controls the project-wide identity provider (`GSUITE` vs `THIRD_PARTY_IDP`) in `locations/global/aclConfig`.',
      'Gemini Enterprise apps are represented as Discovery Engine `Engine` resources under `collections/default_collection/engines/{engineId}` with `appType: "APP_TYPE_INTRANET"`.',
      'User license auto-registration is managed on `locations/global/userStores/default_user_store` linked to a `licenseConfig` (`SUBSCRIPTION_TIER_SEARCH_AND_ASSISTANT`).',
    ],
    agentRulesAndTakeaways: [
      'Always include `-H "X-Goog-User-Project: <project_id>"` on all Discovery Engine REST calls.',
      'Never pass `?updateMask=...` to `PATCH .../locations/global/aclConfig`; the `updateAclConfig` method takes no `updateMask` parameter.',
      'Create the Intranet engine (or `POST .../userStores?userStoreId=default_user_store`) before creating `licenseConfigs` or calling `batchUpdateUserLicenses`.',
    ],
    labRecipe: {
      servicesUsed: ['discoveryengine.googleapis.com', 'aiplatform.googleapis.com'],
      verifiedScriptSummary:
        'PATCH locations/global/aclConfig with {"idpConfig": {"idpType": "GSUITE"}}, POST collections/default_collection/engines?engineId=cymbal-shops-gemini-enterprise, and configure default_user_store + licenseConfigs.',
      verifiedScriptSnippet: `api_call("PATCH", f"{base}/aclConfig", {"idpConfig": {"idpType": "GSUITE"}})
api_call("POST", f"{base}/collections/default_collection/engines?engineId=cymbal-shops-gemini-enterprise", {
  "displayName": "Cymbal Shops Gemini Enterprise",
  "solutionType": "SOLUTION_TYPE_SEARCH",
  "industryVertical": "GENERIC",
  "appType": "APP_TYPE_INTRANET",
  "commonConfig": {"companyName": "Cymbal Shops"},
  "searchEngineConfig": {"searchTier": "SEARCH_TIER_ENTERPRISE", "searchAddOns": ["SEARCH_ADD_ON_LLM"]}
})`,
      attemptsRequired: 4,
      selfHealingDelta:
        'Attempt 1 failed because fresh Cloud Shell SSH had unset gcloud core/project; Attempt 2 failed because PATCH aclConfig?updateMask=idpConfig rejected updateMask with HTTP 400 and licenseConfigs was called before default_user_store existed. Removing updateMask on aclConfig and creating the engine first resolved the check.',
    },
    tags: ['gemini-enterprise', 'aclConfig', 'idpConfig', 'discoveryengine', 'lab-recipe'],
  },
  {
    id: 'lab-explore-deep-research-agent-task-2',
    timestamp: '2026-10-10T20:15:30.000Z',
    stream: 'lab_execution',
    courseOrLabTitle: 'Explore the Deep Research Agent',
    moduleOrTaskTitle: 'Task 2. Use the Deep Research agent',
    sourceUrl: 'https://partner.skills.google/focuses/149995?parent=catalog&path=3581',
    summary:
      'Executes a multi-turn research conversation with the Gemini Enterprise Deep Research agent (`deep_research`) via `assistants/default_assistant:streamAssist`, generating an initial retail AI research plan on Turn 1, refining the plan to compare US, European, and Asian markets on Turn 2, and launching research execution.',
    conceptsAndCapabilities: [
      'In Discovery Engine `streamAssist`, `agentsSpec: {"agentSpecs": [{"agentId": "deep_research"}]}` routes a turn to the managed Deep Research agent rather than `root_agent`.',
      'Agent routing in `streamAssist` is evaluated per request and is NOT sticky on the `Session` resource.',
    ],
    agentRulesAndTakeaways: [
      'Include BOTH `"session": session_name` AND `"agentsSpec": {"agentSpecs": [{"agentId": "deep_research"}]}` on every single turn of a multi-turn Deep Research conversation.',
      'Keep one clean 2-turn session holding the updated Research Plan (`turns[0]` initial prompt + `turns[1]` plan refinement) and run Turn 3 (`"Start research"`) in a separate background session so both state-based and execution-based grader checks pass.',
    ],
    labRecipe: {
      servicesUsed: ['discoveryengine.googleapis.com'],
      verifiedScriptSummary:
        'Create a Discovery Engine session, call streamAssist with agentId="deep_research" for Turn 1 (retail gen AI prompt) and Turn 2 (US/European/Asian market comparison) on the same session, and spawn a background session for Turn 3 ("Start research").',
      verifiedScriptSnippet: `stream_assist({
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
})`,
      attemptsRequired: 2,
      selfHealingDelta:
        'Attempt 1 omitted agentsSpec on Turn 2, which caused Turn 2 to route to root_agent instead of updating the research plan in deep_research. Passing agentsSpec on Turn 2 produced the updated Research Plan and passed 100/100.',
    },
    tags: ['deep-research', 'streamAssist', 'agentsSpec', 'multi-turn', 'discoveryengine'],
  },
  {
    id: 'lab-genai126-bigquery-datastore-widget-search',
    timestamp: '2026-10-10T18:55:00.000Z',
    stream: 'lab_execution',
    courseOrLabTitle: 'Create a Data Store from BigQuery and Configure the Search Widget (GENAI126)',
    moduleOrTaskTitle: 'Task 1–3. BigQuery Data Store Import, Widget UI Field Mappings & Filtered Search',
    sourceUrl: 'https://partner.skills.google/focuses/genai126',
    summary:
      'Creates a Discovery Engine structured data store backed by BigQuery (`deps.advisories`), configures Search Widget UI field mappings (`fieldsUiComponentsMap`) with custom display templates (`Severity: {value}`), and executes preview and filtered (`System: ANY("PYPI")`) searches paired with `userEvents:write` telemetry.',
    conceptsAndCapabilities: [
      'Discovery Engine can ingest structured rows directly from BigQuery tables (`gcsSource` / `bigQuerySource`) and index them progressively for search before the bulk import LRO finishes.',
      'Widget configurations (`widgetConfigs/default_search_widget_config`) map schema fields onto standardized UI slots (`title`, `url`, `text1`, `text2`, `metadata1`, `metadata2`) using `UIComponentField` objects (`{"field": "<col>", "displayTemplate": "{value}"}`).',
      'GCP Console Preview searches emit two paired requests: `servingConfigs/default_search:search` followed by `locations/global/userEvents:write?writeAsync=true` with the search `attributionToken` and returned document resource names.',
    ],
    agentRulesAndTakeaways: [
      'When polling a large BigQuery data store import (`295,000+` rows), poll `servingConfigs/default_search:search` until `len(results) > 0` (~60s) rather than blocking 20+ minutes on `operations` `done: true`.',
      'In `widgetConfigs.patch`, use `?updateMask=uiSettings` (never `uiSettings.dataStoreUiConfigs`) and always set `"displayTemplate"` (never `"template"`) on each `fieldsUiComponentsMap` entry.',
      'Always pair preview `:search` calls with `locations/global/userEvents:write?writeAsync=true` so user activity telemetry matches the Console UI.',
    ],
    labRecipe: {
      servicesUsed: ['discoveryengine.googleapis.com', 'bigquery.googleapis.com'],
      verifiedScriptSummary:
        'Import BigQuery deps.advisories into Discovery Engine datastore, PATCH default_search_widget_config?updateMask=uiSettings with displayTemplate mappings, and run paired :search + userEvents:write calls.',
      verifiedScriptSnippet: `ui_fmap = {
  "title": {"field": "Name", "displayTemplate": "{value}"},
  "url": {"field": "ReferenceURL", "displayTemplate": "{value}"},
  "text1": {"field": "Title", "displayTemplate": "{value}"},
  "text2": {"field": "Description", "displayTemplate": "{value}"},
  "metadata1": {"field": "System", "displayTemplate": "{value}"},
  "metadata2": {"field": "GitHubSeverity", "displayTemplate": "Severity: {value}"},
}
api_call("PATCH", f"{wc_url}?updateMask=uiSettings", {
  "uiSettings": {"interactionType": "SEARCH_ONLY", "dataStoreUiConfigs": [{"name": ds_comp_name, "fieldsUiComponentsMap": ui_fmap}]}
})`,
      attemptsRequired: 1,
      selfHealingDelta:
        'Resolved macOS local fallback SSL certificate verification (`SSL_CERT_FILE=/etc/ssl/cert.pem`), non-blocking search readiness polling, and `displayTemplate` field mapping schema.',
    },
    tags: ['discoveryengine', 'bigquery', 'widgetConfigs', 'userEvents', 'genai126'],
  },
  {
    id: 'lab-genai162-multiagent-adk-systems-gemini-enterprise',
    timestamp: '2026-10-09T22:00:00.000Z',
    stream: 'lab_execution',
    courseOrLabTitle: 'Build and Deploy Multi-Agent ADK Systems to Gemini Enterprise (GENAI162)',
    moduleOrTaskTitle: 'ADK 2.0 Graph Workflows, MCP Server Discovery, Agent Runtime & Gemini Enterprise Publishing',
    sourceUrl: 'https://partner.skills.google/focuses/genai162',
    summary:
      'Builds a multi-agent DevSecOps Incident Triage System using ADK 2.0 (`Workflow` graph edges, `VertexAiSearchTool`, BigQuery toolsets, and Agent Registry MCP server `developerknowledge.googleapis.com`), deploys it to Vertex AI Agent Runtime (`ReasoningEngine`), and publishes it to Gemini Enterprise with organization-wide sharing (`ALL_USERS`).',
    conceptsAndCapabilities: [
      'ADK 2.0 `Workflow` orchestrates deterministic and conditional multi-agent pipelines by connecting `LlmAgent` nodes via `edges=[("node_a", "node_b")]`.',
      'Cloud Agent Registry (`agentregistry.googleapis.com`) exposes managed MCP servers such as `developerknowledge.googleapis.com` that ADK agents can consume as toolsets.',
      'Agents deployed to Vertex AI Agent Runtime (`ReasoningEngine`) can be registered in Gemini Enterprise under `assistants/default_assistant/agents` via `adkAgentDefinition.provisionedReasoningEngine` and shared across the organization (`sharingConfig.scope = "ALL_USERS"`).',
    ],
    agentRulesAndTakeaways: [
      'When discovering an MCP server from Agent Registry, filter explicitly by `displayName="developerknowledge.googleapis.com"` and strip the resource prefix to the short ID when the starter code already prepends `projects/.../mcpServers/`.',
      'Preserve the `pyproject.toml` generated by `agents-cli scaffold enhance` (which includes `a2a-sdk[http-server]` and `google-adk[bigquery-analytics,gcp,otel-gcp]`) and add custom dependencies via `uv add`.',
      'When calling `agents-cli publish gemini-enterprise`, pass the full Discovery Engine resource path (`projects/<project_number>/locations/<loc>/collections/default_collection/engines/<engine_id>`) to `--gemini-enterprise-app-id` and PATCH `sharingConfig` to `{"scope": "ALL_USERS"}`.',
    ],
    labRecipe: {
      servicesUsed: [
        'aiplatform.googleapis.com',
        'discoveryengine.googleapis.com',
        'agentregistry.googleapis.com',
        'bigquery.googleapis.com',
      ],
      verifiedScriptSummary:
        'Configure ADK 2.0 Workflow edges and tools, deploy ReasoningEngine via agents-cli while granting IAM roles to service-<project_number>@gcp-sa-aiplatform-re.iam.gserviceaccount.com, and register on Gemini Enterprise with ALL_USERS sharing.',
      verifiedScriptSnippet: `call("POST", f"https://us-discoveryengine.googleapis.com/v1alpha/{full_app_id}/assistants/default_assistant/agents", {
  "displayName": "DevSecOps Incident Triage System",
  "description": "Multi-agent system for triaging DevSecOps incidents",
  "adkAgentDefinition": {"provisionedReasoningEngine": {"reasoningEngine": re_full_name}},
  "sharingConfig": {"scope": "ALL_USERS"}
})`,
      attemptsRequired: 1,
    },
    tags: ['adk', 'multi-agent', 'reasoning-engine', 'mcp', 'gemini-enterprise', 'genai162'],
  },
  {
    id: 'course-google-skills-partner-ai-agents-quiz-mastery',
    timestamp: '2026-10-10T17:30:00.000Z',
    stream: 'quiz_mastery',
    courseOrLabTitle: 'Google Cloud Partner Skills Boost — Enterprise AI & Agentic Workflows',
    moduleOrTaskTitle: 'Course Knowledge Checks & Final Assessment Quizzes',
    sourceUrl: 'https://partner.skills.google/paths/4144/course_templates/1746/html_bundles/644267',
    summary:
      'Verified quiz takeaways covering Google Cloud enterprise AI positioning, Gemini Enterprise governance, grounding, and agent orchestration.',
    conceptsAndCapabilities: [
      'Enterprise AI deployments require grounding in first-party enterprise data (via Vertex AI Search / Discovery Engine connectors) combined with Workforce Identity access controls (`aclConfig`) so responses respect source document ACLs.',
      'Multi-agent architectures separate specialized research, retrieval, and action execution into distinct sub-agents coordinated by a root orchestrator or workflow graph.',
    ],
    agentRulesAndTakeaways: [
      'When solving multi-select (`checkbox`) vs single-select (`radio`) course quizzes, extract the full SCORM / Rise 360 `runtime-data.js` or lesson DOM text first so answers are grounded in the exact course phrasing.',
      'Persist eliminated incorrect choices across quiz retries and lock in verified correct items so retry attempts converge deterministically to 100%.',
    ],
    quizQa: [
      {
        question:
          'How does Gemini Enterprise ensure that generative AI responses respect an organization’s existing data access permissions?',
        verifiedAnswers: [
          'By integrating with Workforce Identity and enforcing source-system ACLs at query and retrieval time in Discovery Engine',
        ],
        explanation:
          'Discovery Engine binds user identity via Workforce Identity (`aclConfig`) and filters retrieved grounding chunks against document-level ACLs before synthesis.',
        domainRule:
          'Enterprise RAG and assistant grounding must enforce identity-aware ACL filtering at retrieval time rather than relying on prompt-level restrictions.',
      },
    ],
    tags: ['quiz-mastery', 'gemini-enterprise', 'grounding', 'security', 'partner-skills'],
  },
  {
    id: 'lab-fde-build-enterprise-agents-apex012',
    timestamp: '2026-10-12T16:45:00.000Z',
    stream: 'lab_execution',
    courseOrLabTitle: '[FDE] Build Enterprise Agents (APEX012)',
    moduleOrTaskTitle:
      'Multi-Agent Enterprise Architecture: ADK 2.0 Workflow Graph, A2A v1.0/v0.3 Interop, GKE Vector Search, MCP Toolsets & Vertex AI Memory Bank',
    sourceUrl: 'https://explore.qwiklabs.com/classrooms/21414/labs/115585',
    summary:
      'End-to-end architecture and verified implementation recipes for building, deploying, and orchestrating heterogeneous enterprise agents across Cloud Run, GKE Autopilot, Vertex AI Agent Runtime, and Gemini Enterprise.',
    conceptsAndCapabilities: [
      'A2A Protocol Interoperability: ADK 2.0 agents expose A2A v1.0 (`protocol_version="1.0"`, requiring `RemoteA2aAgent(..., use_legacy=False)`), whereas LangGraph agents using `a2a-sdk` default to A2A v0.3 unless `AgentCard.supported_interfaces` advertises both `1.0` and `0.3` and `CleanQueryRemoteA2aAgent` strips context prefixes.',
      'ADK 2.0 Parallel Graph Orchestration (`Workflow` + `JoinNode`): Fan-out from an intake node requires passing the actual `BaseNode` / `Agent` object references in `edges=[("START", query_extractor), (query_extractor, (bug_db_agent, manual_search_agent, salesforce_agent, github_agent, stackexchange_agent)), ((bug_db_agent, manual_search_agent, salesforce_agent, github_agent, stackexchange_agent), merge), (merge, synthesizer)]` with `JoinNode(name="merge")` so the synthesizer receives all parallel specialist outputs in `ctx.state` via `after_agent_callback=capture_response_to_state(...)`.',
      'Cross-Runtime Authentication (`GoogleADCAuth`): When a root orchestrator on Vertex AI Agent Runtime invokes a specialist on Agent Runtime (`github_agent`), `GoogleADCAuth._apply` attaches an OAuth2 bearer token via `self._creds.before_request(self._req, request.method, str(request.url), request.headers)`.',
      'External GKE LoadBalancer for A2A Discovery: `agents-cli create bq-agent -a adk -d gke` scaffolds `service.tf` with `"cloud.google.com/load-balancer-type" = "Internal"` and `fast_api_app.py` importing both `root_agent` and `app = App(root_agent=root_agent, name="app")`. Removing the `Internal` annotation provisions an external LoadBalancer IP so Vertex AI Agent Runtime can fetch `http://<EXTERNAL_IP>:8080/a2a/app/.well-known/agent-card.json`.',
      'User-Scoped Memory Isolation in Vertex AI Memory Bank: `PreloadMemoryTool()` retrieves user memories at turn start and `generate_memories_callback` persists the full session via `await callback_context.add_session_to_memory()` at turn end (configured via `MEMORY_BANK_ID` and `MEMORY_BANK_LOCATION="us-central1"`), while `_user_scoped_request_converter` and `user_id_meta_provider` propagate `{"user_id": ctx.user_id}` across A2A boundaries.',
    ],
    agentRulesAndTakeaways: [
      'Preserve existing non-placeholder secrets (`GITHUB_PERSONAL_ACCESS_TOKEN`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_DOMAIN`) in `.env` files before appending or updating deployment URLs.',
      'Always write `.gcloudignore` excluding `.venv/`, `__pycache__/`, `.pytest_cache/`, and `tests/` before running `gcloud builds submit` in Python `uv` projects so Cloud Build uploads a ~500 KB archive (17 files) in 0.2s rather than a 734 MB `.venv` (23,787 files).',
      'Prioritize `.env` files and `TODO`-containing source files during workspace inspection so large Terraform/reference trees do not crowd out the actual code files requiring edits.',
      'Provision `~/.config/gcloud/application_default_credentials.json` from `credentials.db` in non-interactive Cloud Shell SSH sessions so `google.auth.default()` and `agents-cli publish gemini-enterprise --gemini-enterprise-app-id projects/<project_number>/locations/global/collections/default_collection/engines/enterprise-app` succeed without interactive login.',
    ],
    labRecipe: {
      servicesUsed: [
        'agents-cli (agent-starter-pack)',
        'Google ADK 2.0 (Workflow, JoinNode, RemoteA2aAgent, McpToolset, SkillToolset)',
        'LangGraph (StateGraph + A2A Starlette)',
        'GKE Autopilot + BigQuery VECTOR_SEARCH (text-embedding-004)',
        'Cloud Run',
        'Vertex AI Agent Runtime, Skill Registry & Memory Bank',
        'Gemini Enterprise (Discovery Engine)',
      ],
      verifiedScriptSummary:
        'Implements GitHub MCP specialist (`McpToolset` + `StreamableHTTPConnectionParams`), Stack Exchange LangGraph specialist (`graph = StateGraph(State)...compile()` + dual `1.0`/`0.3` `AgentInterface`), GKE BigQuery specialist (`find_similar_bugs` with `VECTOR_SEARCH`, `app = App(root_agent=root_agent, name="app")`, and external LoadBalancer `service.tf`), ADK 2.0 `Workflow` root orchestrator with `JoinNode`, `GoogleADCAuth`, and `scripts/publish_skill.py`, Salesforce 2-legged OAuth specialist (`requests.post`), and `VertexAiMemoryBankService` (`MEMORY_BANK_ID`) integration.',
      selfHealingDelta:
        'Fixed sequential JSON string unescaping (`\\\\n` -> `\\<NEWLINE>`) and single-line Python string/regex newline splits (`"\\n".join(...)` and `r\'...\\n...\'`), added `gcloud config set aiplatform/region` -> `ai/region` sanitization, excluded `.venv/` via `.gcloudignore`, sorted `.env` and `TODO` files to top priority in workspace snapshots, and patched `service.tf` to expose an external GKE LoadBalancer IP.',
      attemptsRequired: 1,
    },
    tags: [
      'apex012',
      'fde',
      'enterprise-agents',
      'adk',
      'a2a',
      'langgraph',
      'gke',
      'bigquery-vector-search',
      'mcp',
      'memory-bank',
      'gemini-enterprise',
    ],
  },
];

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
  {
    id: 'L-012',
    date: '2026-10-12',
    category: 'Self-Healing & Grader Verification',
    title:
      'Single-Pass JSON Escape Unescaping, Single-Line Python String Newline Repair, gcloud Property Sanitization, .gcloudignore .venv Exclusion & TODO-Priority Workspace Snapshots',
    symptom:
      'In `[FDE] Build Enterprise Agents` (APEX012), Task 2 Attempt 1 failed with `SyntaxError: unterminated string literal` because `\\\\n` inside a synthesized Python regex was turned into `\\<NEWLINE>`; Task 5 Attempts 3–4 had `r\'def ...(?=\n\'` and `"\\n".join(...)` split across lines by `JSON.parse`; Task 2 Attempt 2 failed with `ERROR: (gcloud.config.set) Section [aiplatform] has no property [region]`; `gcloud builds submit` archived 23,787 `.venv` files (734 MiB); and `inspectStudentCloudShellWorkspace` exhausted its 55KB snapshot budget on `code-assistant/deployment/terraform/*` before reaching `github-agent/app/agent.py`.',
    rootCause:
      '1. Sequential `.replace(/\\\\n/g, "\\n").replace(/\\\\\\\\/g, "\\\\")` in `extractJsonStringField` matches the second `\\` + `n` inside `\\\\n` first, corrupting escaped backslashes into literal newlines whenever `JSON.parse` falls back on unescaped regex escapes in LLM output. Additionally, even when `JSON.parse` succeeds, if the LLM writes a single backslash `\\n` inside a single-line Python string or regex (`"\\n".join(...)`, `r\'...\\n...\'`, `[^\\n]`), `JSON.parse` decodes it into a physical newline character (`0x0A`), which is always a `SyntaxError` in Python single-line strings.\n' +
      '2. LLMs frequently hallucinate `gcloud config set aiplatform/region` instead of the valid `gcloud config set ai/region`, which immediately aborts `set -euo pipefail` scripts.\n' +
      '3. Running `uv sync` or `uv run pytest` creates a 734 MiB `.venv/` directory inside the agent folder; without `.gcloudignore` excluding `.venv/`, `gcloud builds submit` tars and uploads 23,787 files instead of 17 files (~600 KiB).\n' +
      '4. Alphabetical directory traversal in multi-agent repos visits `code-assistant/deployment/terraform/*` before `github-agent/app/agent.py`, starving downstream agents of the exact `# TODO` stubs they need to edit.\n' +
      '5. Fresh Cloud Shell SSH sessions have user credentials in `~/.config/gcloud/credentials.db` (`authorized_user` JSON) but no `~/.config/gcloud/application_default_credentials.json`, causing `google.auth.default()` and `agents-cli publish gemini-enterprise` to fail unless ADC is materialized.',
    generalPrinciple:
      '1. Never chain `.replace(/\\\\n/g, ...)` before `.replace(/\\\\\\\\/g, ...)` when unescaping JSON strings; use a single-pass regex `/\\\\(u[0-9a-fA-F]{4}|.)/g` in any fallback parser, and post-process decoded scripts in `sanitizeSynthesizedShellScript` to repair physical newlines inside single-line Python raw strings (`r\'...\'`, `r"..."`), character classes (`[^\\n]`), and delimiter strings (`"\\n".join(...)`).\n' +
      '2. Sanitize known CLI property hallucinations (`aiplatform/region` -> `ai/region`) and strip interactive `gcloud auth login` commands before executing under `set -euo pipefail`.\n' +
      '3. Always write `.gcloudignore` excluding `.venv/`, `__pycache__/`, `.pytest_cache/`, and `tests/` before running `gcloud builds submit` in Python `uv` projects.\n' +
      '4. Sort workspace file snapshots by actionable signal: Priority 0 (`.env`), Priority 1 (files containing `TODO`), Priority 2 (`app/*.py`, `scripts/*.py`), Priority 3 (`pyproject.toml`), and Priority 4 (`deployment/terraform/*`, `tests/*`).\n' +
      '5. Automatically extract `authorized_user` JSON from `credentials.db` into `~/.config/gcloud/application_default_credentials.json` and export `GOOGLE_APPLICATION_CREDENTIALS` in non-interactive Cloud Shell sessions.',
    implementationInSkillsRunner:
      '`server/geminiClient.ts` (`extractJsonStringField`, `sanitizeSynthesizedShellScript`, Rule 11), `server/nativeChromeBridge.ts` (`inspectStudentCloudShellWorkspace`, `execInStudentCloudShellBridge`), and `server/macBridgeAgent.ts` (`extractAuthorizedUserAdcB64`).',
    tags: [
      'json-unescaping',
      'python-strings',
      'gcloud-config',
      'gcloudignore',
      'workspace-inspection',
      'adc-credentials',
      'agents-cli',
      'apex012',
    ],
  },
];

export function renderAgentLearningsMarkdown(
  dynamicEntries: MemorializedKnowledgeEntry[] = SEED_MEMORIALIZED_KNOWLEDGE
): string {
  const mergedMap = new Map<string, MemorializedKnowledgeEntry>();
  for (const item of SEED_MEMORIALIZED_KNOWLEDGE) {
    mergedMap.set(item.id, item);
  }
  for (const item of dynamicEntries || []) {
    if (item && item.id) {
      mergedMap.set(item.id, item);
    }
  }
  const allDynamic = Array.from(mergedMap.values()).sort((a, b) =>
    (b.timestamp || '').localeCompare(a.timestamp || '')
  );

  const courseEntries = allDynamic.filter((e) => e.stream === 'course_content');
  const quizEntries = allDynamic.filter((e) => e.stream === 'quiz_mastery');
  const labEntries = allDynamic.filter((e) => e.stream === 'lab_execution');

  const lines: string[] = [
    '# Skills Runner — Cumulative Course, Quiz, Lab & Agent Engineering Knowledge Base (`AGENT_LEARNINGS.md`)',
    '',
    '> **Purpose**: This handbook is the persistent, self-updating knowledge base of **Skills Runner**. Every time Skills Runner completes a course module, passes a quiz, or verifies a hands-on lab task on Google Cloud Skills Boost, it distills and memorializes:',
    '> 1. **Course Curriculum & Domain Learnings** (`course_content`) — Core concepts, product capabilities, and architectures taught in courses.',
    '> 2. **Verified Quiz & Knowledge Check Bank** (`quiz_mastery`) — Verified questions, winning answers, eliminated distractors, and domain rules.',
    '> 3. **Verified Hands-On Lab Recipes & Self-Healing Deltas** (`lab_execution`) — Exact API/CLI/SDK implementations that passed Qwiklabs graders and how earlier attempt errors were resolved.',
    '> 4. **Core Agent Engineering & Infrastructure Invariants** (`L-001`..`L-012`) — Reusable patterns for building reliable autonomous agents.',
    '',
    '---',
    '',
    '## 1. Course Curriculum & Domain Learnings (`course_content`)',
    '',
  ];

  if (courseEntries.length === 0) {
    lines.push('_No course modules memorialized yet._', '');
  } else {
    for (const entry of courseEntries) {
      lines.push(
        `### 📚 ${entry.courseOrLabTitle} — ${entry.moduleOrTaskTitle}`,
        `- **Recorded**: ${entry.timestamp}`,
        `- **Source URL**: ${entry.sourceUrl || 'N/A'}`,
        `- **Tags**: \`${(entry.tags || []).join('`, `')}\``,
        '',
        `**Executive Summary**: ${entry.summary}`,
        ''
      );
      if (entry.conceptsAndCapabilities?.length) {
        lines.push('#### Core Concepts & Capabilities Taught');
        for (const c of entry.conceptsAndCapabilities) {
          lines.push(`- ${c}`);
        }
        lines.push('');
      }
      if (entry.agentRulesAndTakeaways?.length) {
        lines.push('#### Actionable Rules for Building Agents');
        for (const r of entry.agentRulesAndTakeaways) {
          lines.push(`- ${r}`);
        }
        lines.push('');
      }
      lines.push('---', '');
    }
  }

  lines.push('## 2. Verified Quiz & Knowledge Check Bank (`quiz_mastery`)', '');
  if (quizEntries.length === 0) {
    lines.push('_No quizzes memorialized yet._', '');
  } else {
    for (const entry of quizEntries) {
      lines.push(
        `### ✅ ${entry.courseOrLabTitle} — ${entry.moduleOrTaskTitle}`,
        `- **Recorded**: ${entry.timestamp}`,
        `- **Source URL**: ${entry.sourceUrl || 'N/A'}`,
        `- **Summary**: ${entry.summary}`,
        ''
      );
      if (entry.quizQa?.length) {
        lines.push('#### Verified Questions & Answers');
        for (let i = 0; i < entry.quizQa.length; i++) {
          const qa = entry.quizQa[i];
          lines.push(
            `${i + 1}. **Question**: ${qa.question}`,
            `   - **Verified Correct Answer(s)**: ${qa.verifiedAnswers.map((a) => `\`${a}\``).join(' + ')}`
          );
          if (qa.eliminatedWrongOptions && qa.eliminatedWrongOptions.length > 0) {
            lines.push(
              `   - **Eliminated Wrong Option(s)**: ${qa.eliminatedWrongOptions.map((a) => `\`${a}\``).join(', ')}`
            );
          }
          if (qa.explanation) {
            lines.push(`   - **Why It Is Correct**: ${qa.explanation}`);
          }
          if (qa.domainRule) {
            lines.push(`   - **Domain Rule**: ${qa.domainRule}`);
          }
        }
        lines.push('');
      }
      if (entry.agentRulesAndTakeaways?.length) {
        lines.push('#### Key Takeaways');
        for (const r of entry.agentRulesAndTakeaways) {
          lines.push(`- ${r}`);
        }
        lines.push('');
      }
      lines.push('---', '');
    }
  }

  lines.push('## 3. Verified Hands-On Lab Recipes & Self-Healing Deltas (`lab_execution`)', '');
  if (labEntries.length === 0) {
    lines.push('_No lab recipes memorialized yet._', '');
  } else {
    for (const entry of labEntries) {
      lines.push(
        `### 🧪 ${entry.courseOrLabTitle} — ${entry.moduleOrTaskTitle}`,
        `- **Recorded**: ${entry.timestamp}`,
        `- **Source URL**: ${entry.sourceUrl || 'N/A'}`,
        `- **Services Used**: \`${(entry.labRecipe?.servicesUsed || entry.tags || []).join('`, `')}\``,
        `- **Attempts Required**: ${entry.labRecipe?.attemptsRequired ?? 1}`,
        '',
        `**What This Lab Teaches**: ${entry.summary}`,
        ''
      );
      if (entry.conceptsAndCapabilities?.length) {
        lines.push('#### Architectural & Technical Concepts');
        for (const c of entry.conceptsAndCapabilities) {
          lines.push(`- ${c}`);
        }
        lines.push('');
      }
      if (entry.agentRulesAndTakeaways?.length) {
        lines.push('#### Reusable Agent Rules');
        for (const r of entry.agentRulesAndTakeaways) {
          lines.push(`- ${r}`);
        }
        lines.push('');
      }
      if (entry.labRecipe) {
        lines.push(
          '#### Verified Grader-Passing Implementation',
          `- **Recipe Summary**: ${entry.labRecipe.verifiedScriptSummary}`
        );
        if (entry.labRecipe.selfHealingDelta) {
          lines.push(`- **Self-Healing Delta**: ${entry.labRecipe.selfHealingDelta}`);
        }
        if (entry.labRecipe.verifiedScriptSnippet) {
          lines.push('', '```python', entry.labRecipe.verifiedScriptSnippet.trim(), '```', '');
        }
      }
      lines.push('---', '');
    }
  }

  lines.push(
    '## 4. Core Agent Engineering & Infrastructure Invariants (`L-001`..`L-012`)',
    '',
    '| ID | Date | Category | Title | Key Tags |',
    '| :--- | :--- | :--- | :--- | :--- |'
  );

  for (const item of AGENT_LEARNINGS) {
    lines.push(
      `| **${item.id}** | ${item.date} | ${item.category} | ${item.title} | \`${item.tags.join('`, `')}\` |`
    );
  }

  lines.push('', '---', '');

  for (const item of AGENT_LEARNINGS) {
    lines.push(
      `### ${item.id}: ${item.title}`,
      `- **Date Recorded**: ${item.date}`,
      `- **Category**: ${item.category}`,
      `- **Tags**: \`${item.tags.join('`, `')}\``,
      '',
      '1. **Observed Symptom / Failure Mode**: ' + item.symptom,
      '2. **Root Cause (Why Agents Fail Here)**: ' + item.rootCause,
      '3. **General Principle for Building Better Agents**: ' + item.generalPrinciple,
      '4. **Implementation in Skills Runner**: ' + item.implementationInSkillsRunner,
      '',
      '---',
      ''
    );
  }

  return lines.join('\n');
}
