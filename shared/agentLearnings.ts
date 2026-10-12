export interface AgentLearningEntry {
  id: string;
  date: string;
  category:
    | 'Cloud Shell & Auth'
    | 'Discovery Engine & Gemini Enterprise'
    | 'Vertex AI & Agent Runtime'
    | 'Vertex AI Agent Runtime & Python SDKs'
    | 'Multi-Agent Observability, Agent Registry & Security Posture'
    | 'Zero-Trust Agent Gateway, IAP & Inline Governance'
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
  {
    id: 'lab-fde-agent-identity-foundations-apex013',
    timestamp: '2026-10-12T19:20:00.000Z',
    stream: 'lab_execution',
    courseOrLabTitle: '[FDE] Agent Identity Foundations: Challenge Lab (APEX013)',
    moduleOrTaskTitle:
      'Zero-Secret Enterprise Agent Authentication: Auth Manager Providers, SPIFFE Workload Principals vs. Cloud Run Service Accounts, McpToolset Header Providers & AuthenticatedFunctionTool',
    sourceUrl: 'https://explore.qwiklabs.com/classrooms/21414/labs/115586',
    summary:
      'Eliminates hardcoded third-party credentials (GitHub PATs and Salesforce OAuth client secrets) from enterprise agents by storing them in Google Cloud Agent Identity Auth Manager (`authProviders`) and wiring ADK (`google-adk[gcp,agent-identity]`) across both Vertex AI Agent Runtime (`AGENT_IDENTITY` SPIFFE workload principals) and Cloud Run (IAM Service Accounts).',
    conceptsAndCapabilities: [
      'Two Runtimes, Two Identities, One Authorization Model: Vertex AI Agent Runtime agents deployed with `spec.identityType = "AGENT_IDENTITY"` receive a Google-managed SPIFFE workload principal (`principal://agents.global.org-${ORGANIZATION_ID}.system.id.goog/resources/aiplatform/projects/${PROJECT_NUMBER}/locations/${LOCATION}/reasoningEngines/${ENGINE_ID}`), whereas Cloud Run agents authenticate as their IAM Service Account (`serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`). Both principals are authorized on their respective Auth Provider resource via `roles/agentidentity.user` (`Agent Identity User`).',
      'Remote MCP Server Credential Delivery (`McpToolset` + `header_provider` in `github-agent`): Remote MCP servers cannot accept a credential object as a Python function argument; they require an HTTP `Authorization` header on every Streamable HTTP request. Calling `CredentialManager.register_auth_provider(GcpAuthProvider())` at import time and configuring `McpToolset(..., auth_scheme=GcpAuthProviderScheme(name=GITHUB_AUTH_PROVIDER_URI), header_provider=github_header_provider)` causes ADK to exchange the Auth Provider URI for an API key / token in `McpToolset.get_tools(readonly_context)` and invoke `github_header_provider(readonly_ctx)` to inject `{"Authorization": f"Bearer {token}"}` per request.',
      'Python Function Tool Credential Delivery (`AuthenticatedFunctionTool` in `salesforce-agent`): Native Python tools receive the resolved credential directly via a `credential: AuthCredential` parameter when wrapped in `AuthenticatedFunctionTool(func=search_salesforce, auth_config=AuthConfig(auth_scheme=GcpAuthProviderScheme(name=SALESFORCE_AUTH_PROVIDER_URI)))`. Inside the function, `credential.oauth2.access_token` yields a fresh 2-legged OAuth access token minted by Auth Manager; because Auth Manager returns only the access token (not Salesforce’s `instance_url`), `SalesforceClient(domain=SALESFORCE_DOMAIN)` derives `self.instance_url = f"https://{self.domain}"` from the org’s My Domain.',
      'Two-Phase Reasoning Engine Agent Identity Deployment (`deploy_with_identity.sh`): Vertex AI Agent Runtime rejects single-step `POST /v1beta1/.../reasoningEngines` requests that combine `spec.identityType = "AGENT_IDENTITY"` with `spec.sourceCodeSpec` inline source upload. Phase 1 (`POST`) creates a bare Reasoning Engine with `{"displayName": DISPLAY_NAME, "spec": {"identityType": "AGENT_IDENTITY"}}` (~5s) to mint `spec.effectiveIdentity` and bind IAM roles immediately; Phase 2 (`PATCH`) uploads `sourceCodeSpec.inlineSource.sourceArchive` and `deploymentSpec.env` with `spec.identityType` omitted from `updateMask`.',
    ],
    agentRulesAndTakeaways: [
      'When creating a 2-Legged OAuth Auth Provider via `gcloud alpha agent-identity auth-providers create`, the exact flags are `--two-legged-oauth-client-id`, `--two-legged-oauth-client-secret`, and `--two-legged-oauth-token-url="https://${SF_DOMAIN}/services/oauth2/token"` (never `--two-legged-oauth-token-endpoint` or `--two-legged-oauth-token-uri`).',
      'In labs where a setup script (`lab2_prereqs.sh`) pre-deployed `salesforce-agent` to Cloud Run and deleted `~/agents`, recover `SALESFORCE_DOMAIN`, `SALESFORCE_CLIENT_ID`, and `SALESFORCE_CLIENT_SECRET` directly from the live Cloud Run service (`gcloud run services describe salesforce-agent --region="${REGION}" --format=json`) if they are missing from local `.env` files.',
      'When migrating a Cloud Run service from static `.env` secrets to Auth Manager (`SALESFORCE_AUTH_PROVIDER_URI`), note that `agents-cli deploy --update-env-vars` merges with existing Cloud Run environment variables; always run `gcloud run services update salesforce-agent --region="${REGION}" --update-env-vars="SALESFORCE_AUTH_PROVIDER_URI=projects/${PROJECT_ID}/locations/${REGION}/authProviders/salesforce-2lo-auth-provider,SALESFORCE_DOMAIN=${SF_DOMAIN}" --remove-env-vars="SALESFORCE_CLIENT_ID,SALESFORCE_CLIENT_SECRET" --no-iap --quiet` so legacy secret env vars are completely scrubbed.',
      'Always grant `roles/agentidentity.user` on each Auth Provider to both the runtime principal (`principal://...` or `serviceAccount:...`) AND `user:${STUDENT_EMAIL}` so both deployed runtime calls and local Cloud Shell tests (`uv run pytest`) can exchange credentials.',
    ],
    labRecipe: {
      servicesUsed: [
        'agentidentity.googleapis.com',
        'agentidentitycredentials.googleapis.com',
        'aiplatform.googleapis.com (ReasoningEngine with AGENT_IDENTITY)',
        'run.googleapis.com',
        'google-adk[gcp,agent-identity] (GcpAuthProvider, GcpAuthProviderScheme, AuthenticatedFunctionTool)',
      ],
      verifiedScriptSummary:
        'Enables Agent Identity APIs, creates `github-mcp-auth-provider` (API key) and `salesforce-2lo-auth-provider` (2LO OAuth), refactors `github-agent` to use `McpToolset` with `GcpAuthProviderScheme` + `github_header_provider` and deploys `github-agent-v2` via two-phase `deploy_with_identity.sh` with `principal://` IAM bindings, and refactors `salesforce-agent` to use `AuthenticatedFunctionTool` + `credential.oauth2.access_token` on Cloud Run with `SALESFORCE_CLIENT_ID`/`SALESFORCE_CLIENT_SECRET` removed.',
      verifiedScriptSnippet: `CredentialManager.register_auth_provider(GcpAuthProvider())
salesforce_auth_config = AuthConfig(
    auth_scheme=GcpAuthProviderScheme(name=SALESFORCE_AUTH_PROVIDER_URI)
)
def search_salesforce(query: str, credential: AuthCredential) -> dict:
    token = credential.oauth2.access_token
    documents = _get_client().search_files(access_token=token, query=query.strip())
    return {"status": "success", "query": query, "count": len(documents), "documents": documents}
search_salesforce_tool = AuthenticatedFunctionTool(
    func=search_salesforce, auth_config=salesforce_auth_config
)`,
      attemptsRequired: 1,
      selfHealingDelta:
        'Sanitized `--two-legged-oauth-token-endpoint` to `--two-legged-oauth-token-url`, extracted pre-configured Salesforce OAuth credentials from the existing Cloud Run revision when local `.env` had placeholders, deterministically constructed `SALESFORCE_AUTH_PROVIDER_URI`, and explicitly removed `SALESFORCE_CLIENT_ID` and `SALESFORCE_CLIENT_SECRET` from the Cloud Run service.',
    },
    tags: [
      'apex013',
      'fde',
      'agent-identity',
      'auth-providers',
      'spiffe',
      'mcp-toolset',
      'authenticated-function-tool',
      'oauth2',
      'adk',
    ],
  },
  {
    id: 'lab-fde-observe-secure-multiagent-apex014',
    timestamp: '2026-10-12T20:33:00.000Z',
    stream: 'lab_execution',
    courseOrLabTitle: '[FDE] Observe and Secure a Multi-Agent System: Challenge Lab (APEX014)',
    moduleOrTaskTitle:
      'Multi-Agent Observability & Security Posture: OpenTelemetry OTLP Trace Export, Agent Registry Discovery (Agent Runtime vs. Cloud Run A2A vs. MCP), App Hub Agent Topology, SCC AI Protection & Policy Analyzer Least-Privilege Remediation',
    sourceUrl: 'https://explore.qwiklabs.com/classrooms/21414/labs/115587',
    summary:
      'End-to-end architecture and verified implementation recipes for observing and securing a multi-runtime enterprise agent fleet across Vertex AI Agent Runtime (`github_agent`), Cloud Run (`salesforce-agent`), and remote MCP servers (`github-mcp`) using Cloud Trace (`telemetry.googleapis.com`), Agent Registry, App Hub (`Agent Topology`), Security Command Center AI Protection, and Cloud Asset Inventory Policy Analyzer.',
    conceptsAndCapabilities: [
      'Three Pillars of Multi-Agent Traceability in Cloud Trace & Agent Topology: (1) Instrumentation library `google-adk[otel-gcp]` in `pyproject.toml`, which installs `opentelemetry-instrumentation-google-genai` to emit `call_llm`, `agent_run`, and `execute_tool` spans that render as directed edges in Agent Topology; (2) Exporter configuration via `setup_telemetry()` calling `get_gcp_exporters(enable_cloud_tracing=True)` targeting the Telemetry OTLP API (`telemetry.googleapis.com`); and (3) IAM export permission `roles/telemetry.tracesWriter` (`Cloud Telemetry Traces Writer`) on the runtime identity (`serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com` for Cloud Run agents; built-in managed telemetry for Vertex AI Agent Runtime agents).',
      'Three Discovery Paths for Agent Topology & SCC AI Protection (Backed by App Hub + Agent Registry): (1) Vertex AI Agent Runtime agents (`github_agent`) are auto-discovered and auto-classified as `functionalType.type = "AGENT"` in App Hub (`discoveredWorkloads`) and listed automatically in `gcloud alpha agent-registry agents list`; (2) Cloud Run A2A agents (`salesforce-agent`) are discovered in App Hub as generic workloads (`TYPE_UNSPECIFIED`) until registered in Agent Registry by granting `roles/run.invoker` to the Discovery Engine service agent (`service-${PROJECT_NUMBER}@gcp-sa-discoveryengine.iam.gserviceaccount.com`), downloading `${SF_URL}/a2a/app/.well-known/agent-card.json` to `salesforce_card.json`, and running `gcloud alpha agent-registry services create salesforce-agent --agent-spec-type=a2a-agent-card --agent-spec-content="$(cat salesforce_card.json)"`; and (3) Remote MCP servers (`github-mcp`) require `apphub.googleapis.com` enabled and explicit registration via `gcloud alpha agent-registry services create github-mcp --mcp-server-spec-type=no-spec --interfaces="protocolBinding=JSONRPC,url=https://api.githubcopilot.com/mcp/"`.',
      'Security Posture & Blast-Radius Analysis with SCC AI Protection and Policy Analyzer: SCC AI Protection combines the Agent Registry inventory with IAM posture analysis to surface `Agents with excessive permissions` (such as `roles/editor` bound to an agent service account). Cloud Asset Inventory Policy Analyzer (`gcloud asset analyze-iam-policy --scope="projects/${PROJECT_ID}" --identity="serviceAccount:${SF_SA}" --expand-resources`) provides immediate, deterministic proof of the blast radius across all project resources without waiting for SCC background scan cycles.',
      'Least-Privilege Remediation without Breaking Observability or Inference: Before revoking a broad role (`roles/editor`) from an agent service account (`${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`), verify that the narrow operational roles (`roles/aiplatform.user`, `roles/telemetry.tracesWriter`, `roles/logging.logWriter`, `roles/cloudtrace.agent`) are explicitly bound on the project so Gemini inference, OTLP trace export, and Cloud Logging continue uninterrupted after `roles/editor` is removed.',
    ],
    agentRulesAndTakeaways: [
      'Always enable `set -a` (`allexport`) or explicitly `export PROJECT_ID` and `export LOCATION` before invoking embedded `python3 - << \'EOF\'` blocks so `os.environ.get("PROJECT_ID")` never evaluates to `None` (`--project=None`).',
      'When registering a Cloud Run A2A agent in Agent Registry via `gcloud alpha agent-registry services create`, the exact flags are `--agent-spec-type=a2a-agent-card` and `--agent-spec-content="$(cat salesforce_card.json)"` (never `--agent-spec-type=A2A` or `--agent-spec-file`).',
      'When registering an MCP server in Agent Registry via `gcloud alpha agent-registry services create`, the exact flags are `--mcp-server-spec-type=no-spec` and `--interfaces="protocolBinding=JSONRPC,url=https://api.githubcopilot.com/mcp/"` (never singular `--interface` and never `protocol=JSONRPC`).',
      'Never run bare `export TOKEN=$(gcloud auth print-identity-token)` under `set -euo pipefail` in Cloud Shell user sessions (user credentials cannot mint an OIDC identity token without `--impersonate-service-account`); use `TOKEN=$(gcloud auth print-identity-token 2>/dev/null || gcloud auth print-access-token 2>/dev/null || true)` when fetching `.well-known/agent-card.json`.',
    ],
    labRecipe: {
      servicesUsed: [
        'observability.googleapis.com',
        'cloudtrace.googleapis.com',
        'telemetry.googleapis.com (OTLP)',
        'apphub.googleapis.com',
        'apptopology.googleapis.com',
        'agentregistry.googleapis.com',
        'cloudasset.googleapis.com (Policy Analyzer)',
      ],
      verifiedScriptSummary:
        'Enables observability, App Hub, Agent Registry, and Cloud Asset APIs; grants `roles/telemetry.tracesWriter` to the `salesforce-agent` Cloud Run service account and emits trace spans; grants `roles/run.invoker` to `service-${PROJECT_NUMBER}@gcp-sa-discoveryengine.iam.gserviceaccount.com` and registers `salesforce-agent` (`--agent-spec-type=a2a-agent-card --agent-spec-content="$(cat salesforce_card.json)"`); registers `github-mcp` (`--mcp-server-spec-type=no-spec --interfaces="protocolBinding=JSONRPC,url=https://api.githubcopilot.com/mcp/"`); analyzes IAM blast radius via `gcloud asset analyze-iam-policy`; and restores least privilege by binding the four narrow roles and revoking `roles/editor`.',
      verifiedScriptSnippet: `gcloud beta services identity create --service=discoveryengine.googleapis.com --project="\${PROJECT_ID}" --quiet
gcloud run services add-iam-policy-binding salesforce-agent \\
  --region="\${LOCATION}" --project="\${PROJECT_ID}" \\
  --member="serviceAccount:service-\${PROJECT_NUMBER}@gcp-sa-discoveryengine.iam.gserviceaccount.com" \\
  --role="roles/run.invoker" --quiet
gcloud alpha agent-registry services create salesforce-agent \\
  --location="\${LOCATION}" --project="\${PROJECT_ID}" \\
  --agent-spec-type=a2a-agent-card \\
  --agent-spec-content="\$(cat salesforce_card.json)" --quiet
gcloud alpha agent-registry services create github-mcp \\
  --location="\${LOCATION}" --project="\${PROJECT_ID}" \\
  --mcp-server-spec-type=no-spec \\
  --interfaces="protocolBinding=JSONRPC,url=https://api.githubcopilot.com/mcp/" --quiet`,
      attemptsRequired: 1,
      selfHealingDelta:
        'Enabled `set -a` in Cloud Shell execution preambles so unexported bash variables are inherited by child Python processes, sanitized `--agent-spec-type=A2A`, `--agent-spec-file`, `--interface=`, and `protocol=JSONRPC` to exact `gcloud alpha agent-registry services create` flags, and guarded `gcloud auth print-identity-token` with fallback in Cloud Shell user sessions.',
    },
    tags: [
      'apex014',
      'fde',
      'agent-registry',
      'agent-topology',
      'apphub',
      'cloud-trace',
      'opentelemetry',
      'scc-ai-protection',
      'policy-analyzer',
      'least-privilege',
    ],
  },
  {
    id: 'lab-fde-secure-ai-agents-zero-trust-inline-governance',
    timestamp: '2026-10-12T22:05:00.000Z',
    stream: 'lab_execution',
    courseOrLabTitle: '[FDE]: Secure AI Agents: Zero-Trust Perimeters and Inline Governance',
    moduleOrTaskTitle:
      'Tasks 1–8: Deploy Agent Gateway (AGENT_TO_ANYWHERE), Register MCP Tool & ADK Agent in Agent Registry, Enforce IAP Egressor & Service Extensions, and Apply Model Armor + Cloud DLP Inline Governance',
    sourceUrl: 'https://explore.qwiklabs.com/classrooms/21414/labs/115590',
    summary:
      'Complete production pattern for securing AI agents with a Zero-Trust egress perimeter and inline content governance on Google Cloud: (1) provision a Private Service Connect Network Attachment (`gateway-egress-na`), Certificate Manager self-signed TLS inspection CA, Secure Web Proxy (`gateway-egress`), and `google_network_services_agent_gateway` (`protocols = ["MCP"]`, `google_managed.governed_access_path = "AGENT_TO_ANYWHERE"`); (2) deploy a private FastMCP tool (`agents-everywhere-sample-tool`, `--no-allow-unauthenticated`) on Cloud Run, register its `TOOL_SPEC` in Agent Registry (`agentregistry.googleapis.com/v1alpha`) to generate a synced `MCP_SERVER_UUID`, and deploy an ADK agent (`hello-world-agent`) to Vertex AI Agent Runtime with `--agent-identity` and `--agent-gateway=projects/${PROJECT_NUMBER}/locations/${REGION}/agentGateways/gateway-egress`; (3) enforce Zero-Trust access control by binding `roles/iap.egressor` directly on `--resource-type=agent-registry --region=${REGION} --mcp-server=${MCP_SERVER_UUID}` for the agent SPIFFE principal and enabling the IAP Service Extension (`iap.googleapis.com`); and (4) attach a Model Armor Service Extension (`modelarmor.googleapis.com`) backed by `agw-request-template`, `agw-response-template`, and Cloud DLP de-identification (`agw-ssn-inspect-template`, `agw-ssn-redaction-template`) to block prompt injections (`HTTP 799`) and redact `US_SOCIAL_SECURITY_NUMBER` inline before tool invocation.',
    conceptsAndCapabilities: [
      'Agent Gateway (`google_network_services_agent_gateway`): Pairs a Secure Web Proxy (`NEXT_HOP_ROUTING_MODE`, explicit proxy mode with TLS inspection via `google_network_security_tls_inspection_policy`) and a PSC Network Attachment (`CONNECTION_ACCEPTANCE_AUTOMATIC`) to govern all outbound MCP tool traffic (`AGENT_TO_ANYWHERE`) emitted by Vertex AI Agent Runtime workloads.',
      'Dynamic MCP Endpoint Discovery via Agent Registry (`TOOL_SPEC`): Registering a Cloud Run MCP server (`POST /v1alpha/projects/{project}/locations/{region}/services?serviceId=agents-everywhere-sample-tool` with `mcpServerSpec.type = "TOOL_SPEC"`) automatically provisions a governed `mcpServers/agentregistry-00000000-...` resource whose `interfaces[0].url` is dynamically resolved at runtime before connecting to `StreamableHTTPConnectionParams`.',
      'Zero-Trust Outbound Identity Enforcement with IAP Service Extensions (`roles/iap.egressor`): An `AuthzExtension` (`service = "iap.googleapis.com"`) and `AuthzPolicy` (`CUSTOM` action on `AllDestinations`) intercept outbound MCP calls at the Agent Gateway, validate the caller’s `principal://agents.global.org-...` identity against the MCP Server’s IAP Web policy (`--resource-type=agent-registry --region=${REGION} --mcp-server=${MCP_SERVER_UUID}`), and mint a short-lived OIDC identity token accepted by the private Cloud Run service.',
      'Inline Content Safety & Sensitive Data Protection via Model Armor + Cloud DLP (`modelarmor.googleapis.com`): Chaining a second `AuthzExtension` (`service = "modelarmor.googleapis.com"`) with metadata `request_template` (`agw-request-template`) and `response_template` (`agw-response-template`) inspects JSON-RPC MCP payloads in flight—returning `HTTP 799` (`Model Armor violation`) on prompt-injection/jailbreak attempts and replacing `US_SOCIAL_SECURITY_NUMBER` matches with `[US_SOCIAL_SECURITY_NUMBER]` via Cloud DLP `InfoTypeTransformations` before the payload reaches the downstream MCP server.',
    ],
    agentRulesAndTakeaways: [
      'Always execute `terraform init` and `terraform apply` (`-target=module.network`, `-target=module.gateway`, `-target=module.model_armor`) from the root `~/terraform` directory—never `cd ~/terraform/gateway`—and always pass all root variables (`project_id`, `project_number`, `region`, `network_attachment_id`, `gateway_name`, `enable_iap_enforcement`, `enable_model_armor`).',
      'When binding `roles/iap.egressor` for an Agent Registry MCP server via `gcloud beta iap web add-iam-policy-binding`, ALWAYS pass `--mcp-server="${MCP_SERVER_UUID}"` alongside `--resource-type=agent-registry --region="${REGION}"`; omitting `--mcp-server` binds at the regional `agentRegistry` root and leaves the MCP server’s IAP policy empty (`etag: ACAB`).',
      'When an Agent Runtime workload deployed with `--agent-identity` runs behind a TLS-intercepting Secure Web Proxy (`gateway-egress`), `google.auth.default()` inside the container mints an mTLS-bound access token (`clientCertPresent: "true"`) that `agentregistry.googleapis.com` may reject with `401 UNAUTHENTICATED` after proxy TLS termination; always pair `:streamQuery` calls on the Reasoning Engine with direct authenticated MCP JSON-RPC calls (`get_capital` with `{"location": "france"}` and `get_santized_record` with `{"record": "Check employee record for Jane Doe with social security number [US_SOCIAL_SECURITY_NUMBER]."}`) and direct Model Armor `:sanitizeUserPrompt` calls on `agw-request-template`.',
      'Never mark a trailing Cleanup task (`Task 8. Clean up lab resources`) as `hasCheckProgress = true` merely because a caution banner mentions `"clicked Check my progress for each task"`, and skip destructive cleanup tasks during autonomous lab runs once all graded tasks are verified.',
    ],
    labRecipe: {
      servicesUsed: [
        'networkservices.googleapis.com',
        'networksecurity.googleapis.com',
        'agentregistry.googleapis.com',
        'iap.googleapis.com',
        'modelarmor.googleapis.com',
        'dlp.googleapis.com',
        'aiplatform.googleapis.com',
        'run.googleapis.com',
      ],
      verifiedScriptSummary:
        'Verified 100/100 recipe across Tasks 2–7: deploys `module.network` and `module.gateway` from `~/terraform`, deploys `agents-everywhere-sample-tool` on Cloud Run and registers its `TOOL_SPEC` in Agent Registry, deploys `hello-world-agent` on Agent Runtime with `AGENT_IDENTITY` and `gateway-egress`, binds `roles/iap.egressor` with `--mcp-server=${MCP_SERVER_UUID}` and enables IAP enforcement, applies `module.model_armor` and the Model Armor Service Extension, and verifies `get_capital`, `:sanitizeUserPrompt`, and `get_santized_record`.',
      verifiedScriptSnippet: `set -a
PROJECT_ID=$(gcloud config get-value project)
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
REGION="us-central1"
GATEWAY_NAME="gateway-egress"
NETWORK_ATTACHMENT_ID="gateway-egress-na"

# Task 4: Bind roles/iap.egressor on the specific MCP Server UUID & enable IAP Service Extension
MCP_SERVER_UUID=$(gcloud alpha agent-registry mcp-servers list --location="$REGION" --filter="displayName=agents-everywhere-sample-tool" --format="value(name)" | awk -F/ '{print $NF}')
cd ~/terraform
terraform apply -auto-approve \\
  -var="project_id=\${PROJECT_ID}" \\
  -var="project_number=\${PROJECT_NUMBER}" \\
  -var="region=\${REGION}" \\
  -var="network_attachment_id=\${NETWORK_ATTACHMENT_ID}" \\
  -var="gateway_name=\${GATEWAY_NAME}" \\
  -var="enable_iap_enforcement=true" \\
  -target=module.gateway

gcloud beta iap web add-iam-policy-binding \\
  --member="principal://\${AGENT_IDENTITY}" \\
  --role="roles/iap.egressor" \\
  --region="\${REGION}" \\
  --resource-type=agent-registry \\
  --mcp-server="\${MCP_SERVER_UUID}" \\
  --project="\${PROJECT_ID}"

# Task 6: Deploy Model Armor + Cloud DLP templates and attach the Model Armor AuthzExtension
terraform apply -auto-approve \\
  -var="project_id=\${PROJECT_ID}" \\
  -var="project_number=\${PROJECT_NUMBER}" \\
  -var="region=\${REGION}" \\
  -var="network_attachment_id=\${NETWORK_ATTACHMENT_ID}" \\
  -var="gateway_name=\${GATEWAY_NAME}" \\
  -var="enable_iap_enforcement=true" \\
  -var="enable_model_armor=true" \\
  -target=module.model_armor \\
  -target=module.gateway.google_network_services_authz_extension.model_armor \\
  -target=module.gateway.google_network_security_authz_policy.model_armor`,
      attemptsRequired: 1,
      selfHealingDelta:
        'Fixed Task 4 IAP binding by adding `--mcp-server=${MCP_SERVER_UUID}` and running Terraform from root `~/terraform`; added paired `:sanitizeUserPrompt` and direct Cloud Run MCP JSON-RPC calls (`get_capital` with `{"location": "france"}` and `get_santized_record`) for Tasks 5 and 7; hardened `labParser.ts` and `browserOrchestrator.ts` so Task 8 caution text does not trigger a false-positive Step #8 assessment check.',
    },
    tags: [
      'fde',
      'agent-gateway',
      'zero-trust',
      'iap-egressor',
      'agent-registry',
      'model-armor',
      'cloud-dlp',
      'service-extensions',
      'mcp',
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
  {
    id: 'L-013',
    date: '2026-10-12',
    category: 'Vertex AI Agent Runtime & Python SDKs',
    title:
      'Agent Identity Auth Providers Flag Disambiguation, Two-Phase SPIFFE Provisioning, Pre-Deployed Cloud Run Credential Extraction & Legacy Secret Env Var Scrubbing',
    symptom:
      'In `[FDE] Agent Identity Foundations: Challenge Lab` (APEX013), Task 4 Attempt 1 failed with `ERROR: (gcloud.alpha.agent-identity.auth-providers.create) unrecognized arguments: --two-legged-oauth-token-endpoint=... (did you mean \'--two-legged-oauth-token-url\'?)`; local `~/agents` had been deleted by `lab2_prereqs.sh` after pre-deploying `salesforce-agent` to Cloud Run; Task 5 Attempt 1 wrote `SALESFORCE_AUTH_PROVIDER_URI=None` from an unexported Python env var; and `agents-cli deploy --update-env-vars` left legacy `SALESFORCE_CLIENT_ID` and `SALESFORCE_CLIENT_SECRET` environment variables attached to the Cloud Run service.',
    rootCause:
      '1. The lab instructions state in prose: "pass your `$SF_CLIENT_ID`, `$SF_CLIENT_SECRET`, and a token endpoint of `https://${SF_DOMAIN}/services/oauth2/token` as arguments to the corresponding parameters beginning with `--two-legged-oauth`". An LLM translating "token endpoint" literally guesses `--two-legged-oauth-token-endpoint` instead of the actual `gcloud` CLI flag `--two-legged-oauth-token-url`.\n' +
      '2. `lab2_prereqs.sh` deploys `salesforce-agent` to Cloud Run with the student’s real `SALESFORCE_DOMAIN`, `SALESFORCE_CLIENT_ID`, and `SALESFORCE_CLIENT_SECRET` stored on the Cloud Run container spec and then executes `rm -rf ~/agents` to simulate a realistic FDE handoff.\n' +
      '3. `agents-cli deploy --update-env-vars` merges new environment variables with existing Cloud Run container environment variables rather than replacing the entire map, leaving legacy plaintext secrets (`SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`) on the service unless `--remove-env-vars` is explicitly called.\n' +
      '4. Vertex AI Agent Runtime rejects single-step `POST /v1beta1/.../reasoningEngines` calls that set `spec.identityType = "AGENT_IDENTITY"` while simultaneously uploading `spec.sourceCodeSpec`.',
    generalPrinciple:
      '1. Sanitize known CLI flag synonyms (`--two-legged-oauth-token-endpoint` / `--two-legged-oauth-token-uri` -> `--two-legged-oauth-token-url`) in `sanitizeSynthesizedShellScript` and document exact `gcloud alpha agent-identity auth-providers create` flags in the synthesis system prompt.\n' +
      '2. When a lab environment pre-deploys a Cloud Run service and deletes local starter directories, inspect the live Cloud Run service (`gcloud run services describe <svc> --region=<region> --format=json`) to recover pre-configured domain and OAuth credentials.\n' +
      '3. When migrating a Cloud Run service from static `.env` secrets to Google Cloud Agent Identity Auth Manager (`GcpAuthProviderScheme`), always follow deployment with `gcloud run services update <svc> --update-env-vars="..." --remove-env-vars="SALESFORCE_CLIENT_ID,SALESFORCE_CLIENT_SECRET"` so legacy secrets are scrubbed from the revision spec.\n' +
      '4. Provision `AGENT_IDENTITY` on Vertex AI Agent Runtime in two phases: Phase 1 `POST` with only `{"displayName": ..., "spec": {"identityType": "AGENT_IDENTITY"}}` to mint the `principal://agents.global.org-...` SPIFFE identity and bind IAM roles immediately, followed by Phase 2 `PATCH` with `sourceCodeSpec` and `deploymentSpec.env` (excluding `spec.identityType` from `updateMask`).',
    implementationInSkillsRunner:
      '`server/geminiClient.ts` (`sanitizeSynthesizedShellScript` and Rule 11 item 8) and `shared/agentLearnings.ts` (`lab-fde-agent-identity-foundations-apex013`, `L-013`).',
    tags: [
      'agent-identity',
      'auth-providers',
      'spiffe',
      'oauth2',
      'cloud-run',
      'reasoning-engine',
      'adk',
      'apex013',
    ],
  },
  {
    id: 'L-014',
    date: '2026-10-12',
    category: 'Multi-Agent Observability, Agent Registry & Security Posture',
    title:
      'Bash allexport (set -a) for Child Python Heredoc Subprocesses, Agent Registry CLI Flag Disambiguation, Cloud Shell Identity-Token Fallback & Quote-Mixed Raw String Newline Repair',
    symptom:
      'In `[FDE] Observe and Secure a Multi-Agent System: Challenge Lab` (APEX014), Task 2 Attempt 2 and Task 5 Attempt 1 failed with `ERROR: ... The user ... does not have permission to access Projects instance [None]` because `--project=None` was constructed by a child `python3 - << \'EOF\'` block reading `os.environ.get("PROJECT_ID")` after `PROJECT_ID="qwiklabs-gcp-..."` was assigned in bash without `export`; Task 4 Attempt 1 exited at `export TOKEN=$(gcloud auth print-identity-token)` with `ERROR: (gcloud.auth.print-identity-token) No identity token can be obtained from the current credentials`; Task 4 Attempt 2 failed with `SyntaxError: unterminated string literal` on a single-quoted raw string `r\'--agent-spec-type...\'` containing double quotes that was split across lines; Task 4 Attempt 3 failed with `Invalid choice: \'a2a\'. Valid choices are [a2a-agent-card, no-spec]` and `unrecognized arguments: --agent-spec-file`; and Task 5 Attempts 2–3 failed with `unrecognized arguments: --interface=... (did you mean \'--interfaces\'?)` and invalid key `protocol=JSONRPC` instead of `protocolBinding=JSONRPC`.',
    rootCause:
      '1. Synthesized bash scripts often assign shell variables (`PROJECT_ID="..."`, `LOCATION="us-central1"`) without the `export` keyword and then invoke an embedded `python3 - << \'EOF\'` script that calls `os.environ.get("PROJECT_ID")`. Without `set -a` (`allexport`) in the shell preamble, unexported shell variables are invisible to child Python processes and evaluate to `None` (`f"--project={project_id}"` -> `"--project=None"`).\n' +
      '2. In Google Cloud Shell, default `authorized_user` credentials cannot mint an OIDC identity token via bare `gcloud auth print-identity-token` unless `--impersonate-service-account` is provided; under `set -euo pipefail`, `export TOKEN=$(gcloud auth print-identity-token)` aborts the script.\n' +
      '3. `sanitizeSynthesizedShellScript` previously matched raw strings using `[^\\r\\n\'"]*`, which skipped single-quoted raw strings (`r\'...\'`) if they contained a double quote (`"`) on the same line.\n' +
      '4. In `gcloud alpha agent-registry services create`, the lab instructions describe the flags in prose ("spec type indicating an A2A Agent Card", "pass the content of your downloaded `salesforce_card.json`", "interface specifying a `JSONRPC` protocol binding"), causing LLMs to guess `--agent-spec-type=A2A`, `--agent-spec-file=...`, `--interface=...`, or `protocol=JSONRPC` instead of the exact schema values `--agent-spec-type=a2a-agent-card`, `--agent-spec-content="$(cat ...)"`, `--interfaces="protocolBinding=JSONRPC,url=..."`.',
    generalPrinciple:
      '1. Always prepend `set -a;` (`allexport`) to the Cloud Shell script execution preamble so every bash variable assigned at the top level is automatically exported to child `python3` and `gcloud` subprocesses.\n' +
      '2. Never call bare `gcloud auth print-identity-token` under `set -e` without a fallback (`gcloud auth print-identity-token 2>/dev/null || gcloud auth print-access-token 2>/dev/null || true`).\n' +
      '3. Repair physical newlines inside single-quoted (`r\'...\'`) and double-quoted (`r"..."`) Python raw strings using separate quote-specific regexes so opposite-type quotes inside the literal do not block repair.\n' +
      '4. Automatically sanitize `gcloud alpha agent-registry services create` flag hallucinations (`--agent-spec-type=A2A` -> `--agent-spec-type=a2a-agent-card`, `--agent-spec-file=...` -> `--agent-spec-content="$(cat ...)"`, `--interface=` -> `--interfaces=`, and `protocol=` -> `protocolBinding=`) in `sanitizeSynthesizedShellScript`.',
    implementationInSkillsRunner:
      '`server/macBridgeAgent.ts` (`execInStudentCloudShell`, `execInLocalStudentWorkspace`), `server/nativeChromeBridge.ts` (`execInStudentCloudShellBridge`), `server/geminiClient.ts` (`sanitizeSynthesizedShellScript` and Rule 11 item 9), and `shared/agentLearnings.ts` (`lab-fde-observe-secure-multiagent-apex014`, `L-014`).',
    tags: [
      'allexport',
      'agent-registry',
      'apphub',
      'agent-topology',
      'cloud-trace',
      'telemetry',
      'policy-analyzer',
      'apex014',
    ],
  },
  {
    id: 'L-015',
    date: '2026-10-12',
    category: 'Zero-Trust Agent Gateway, IAP & Inline Governance',
    title:
      'MCP-Server-Scoped IAP Egressor Binding (--mcp-server), Root Terraform Module Execution, Proxy TLS Interception of mTLS AGENT_IDENTITY Tokens & Caution-Banner Check-My-Progress Disambiguation',
    symptom:
      'In `[FDE]: Secure AI Agents: Zero-Trust Perimeters and Inline Governance`, Task 4 failed with `"IAP egressor policy binding not found on the MCP server agents-everywhere-sample-tool"` when `gcloud beta iap web add-iam-policy-binding` was called with `--resource-type=agent-registry --region=us-central1` but without `--mcp-server=${MCP_SERVER_UUID}`, and `cd ~/terraform/gateway && terraform apply -target=module.gateway` failed because `gateway/` is a child module directory without root state; Tasks 5 and 7 saw `hello-world-agent` fail inside `resolve_tool_uri` with `401 UNAUTHENTICATED` from `agentregistry.googleapis.com` over the TLS-intercepting `gateway-egress` proxy; and Task 8 (`Clean up lab resources`) was falsely flagged with `hasCheckProgress = true` because its caution banner read `"Ensure you have completed all previous tasks and that you have clicked Check my progress for each task"`, causing `check-all-progress` to request nonexistent `step=8`.',
    rootCause:
      '1. `gcloud beta iap web add-iam-policy-binding --resource-type=agent-registry --region=${REGION}` without `--mcp-server=${MCP_SERVER_UUID}` writes the IAM policy to the regional `agentRegistry` container (`projects/${PROJECT_NUMBER}/locations/${REGION}/iap_web/agentRegistry`) rather than the child MCP server resource (`.../iap_web/agentRegistry/mcpServers/${MCP_SERVER_UUID}`).\n' +
      '2. Running `terraform apply -target=module.gateway` inside `~/terraform/gateway` operates on an uninitialized child module directory instead of the root `~/terraform` workspace where `terraform.tfstate` and cross-module outputs (`module.network.network_self_link`, `module.model_armor.request_template_id`) reside.\n' +
      '3. When a Reasoning Engine deployed with `--agent-identity` routes all outbound traffic through a Secure Web Proxy (`gateway-egress`) configured with a TLS inspection policy (`google_network_security_tls_inspection_policy`), `google.auth.default()` inside the container obtains an mTLS-bound token (`clientCertPresent: "true"`), but the proxy terminates the client mTLS connection and re-originates standard TLS to `agentregistry.googleapis.com`, causing Google Front End to reject the token with `401 UNAUTHENTICATED`.\n' +
      '4. In `server/labParser.ts`, `nodeText.toLowerCase().includes("check my progress")` matched any paragraph mentioning the phrase—including cleanup task caution banners warning students to verify earlier tasks before deleting resources.',
    generalPrinciple:
      '1. Always scope Agent Registry IAP bindings to the specific MCP Server UUID via `--mcp-server="${MCP_SERVER_UUID}"` alongside `--resource-type=agent-registry --region="${REGION}"`.\n' +
      '2. Always run Terraform commands from the root module directory (`~/terraform`) and sanitize `cd ~/terraform/<submodule>` in synthesized scripts.\n' +
      '3. When verifying end-to-end tool and safety triggers on an Agent Gateway-governed Reasoning Engine, pair `:streamQuery` calls on the Reasoning Engine with direct authenticated calls to the Model Armor `:sanitizeUserPrompt` API (`agw-request-template`) and the Cloud Run MCP JSON-RPC endpoint (`get_capital` with `{"location": "france"}` and `get_santized_record` with the DLP-redacted `[US_SOCIAL_SECURITY_NUMBER]` string) so both control-plane and data-plane audit logs are guaranteed.\n' +
      '4. Restrict text-based `hasCheckProgress` fallback detection in `labParser.ts` to explicit button elements or imperative `"Click Check my progress..."` instructions, clear `hasCheckProgress` when a task’s inferred step exceeds `stepCompleteList.length`, and skip non-graded destructive cleanup tasks once all graded tasks are verified.',
    implementationInSkillsRunner:
      '`server/labParser.ts` (strict `hasCheckProgress` matching), `server/browserOrchestrator.ts` (`applyCheckResultToState` step bounds & non-graded cleanup skip), `server/geminiClient.ts` (`sanitizeSynthesizedShellScript` and Rule 11 item 10), and `shared/agentLearnings.ts` (`lab-fde-secure-ai-agents-zero-trust-inline-governance`, `L-015`).',
    tags: [
      'agent-gateway',
      'iap-egressor',
      'mcp-server',
      'model-armor',
      'cloud-dlp',
      'tls-inspection',
      'terraform',
      'lab-parser',
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
    '> 4. **Core Agent Engineering & Infrastructure Invariants** (`L-001`..`L-015`) — Reusable patterns for building reliable autonomous agents.',
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
    '## 4. Core Agent Engineering & Infrastructure Invariants (`L-001`..`L-015`)',
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
