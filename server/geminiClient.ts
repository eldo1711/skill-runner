import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import {
  AgentDecision,
  InteractiveElement,
  LabCredentials,
  LabStep,
  LabTask,
} from './types.js';

const execFileAsync = promisify(execFile);

let activeModel: string = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
let aiClient: GoogleGenAI | null = null;
let modelResolutionPromise: Promise<string> | null = null;

export function getActiveGeminiModel(): string {
  return activeModel;
}

export function getGenAIClient(): GoogleGenAI {
  if (aiClient) return aiClient;

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (apiKey && process.env.GOOGLE_GENAI_USE_VERTEXAI !== 'true') {
    aiClient = new GoogleGenAI({ apiKey });
    return aiClient;
  }

  const project =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCP_PROJECT_ID ||
    'ice-cream-cone-452722';
  const location = process.env.GOOGLE_CLOUD_LOCATION || 'global';

  aiClient = new GoogleGenAI({
    vertexai: true,
    project,
    location,
  });
  return aiClient;
}

/**
 * Resolves the active Gemini model (`gemini-3.5-flash` by default per workspace standard).
 */
export async function resolveLatestGeminiModel(): Promise<string> {
  if (process.env.GEMINI_MODEL) {
    activeModel = process.env.GEMINI_MODEL;
    return activeModel;
  }
  if (modelResolutionPromise) return modelResolutionPromise;

  modelResolutionPromise = (async () => {
    activeModel = 'gemini-3.5-flash';
    return activeModel;
  })();

  return modelResolutionPromise;
}

/**
 * Replaces common Qwiklabs / Cloud Skills Boost placeholders in commands and instructions
 * with actual lab values (Project ID, Region, Zone, Username, etc.).
 */
export function interpolateLabVariables(
  text: string,
  creds: LabCredentials
): string {
  if (!text) return text;
  let result = text;

  if (creds.projectId) {
    result = result
      .replace(/\{\{\{\s*project_0\.project_id[^}]*\}\}\}/gi, creds.projectId)
      .replace(/\[PROJECT_ID\]/gi, creds.projectId)
      .replace(/<PROJECT_ID>/gi, creds.projectId)
      .replace(/YOUR_GCP_PROJECT_ID/gi, creds.projectId)
      .replace(/YOUR_PROJECT_ID/gi, creds.projectId)
      .replace(/PROJECT_ID_HERE/gi, creds.projectId)
      .replace(/qwiklabs-gcp-(?:xx|\d+)-[a-z0-9]+/gi, creds.projectId);
  }

  if (creds.region) {
    result = result
      .replace(/\{\{\{\s*project_0\.default_region[^}]*\}\}\}/gi, creds.region)
      .replace(/\[REGION\]/gi, creds.region)
      .replace(/<REGION>/gi, creds.region)
      .replace(/YOUR_REGION/gi, creds.region);
  }

  if (creds.zone) {
    result = result
      .replace(/\{\{\{\s*project_0\.default_zone[^}]*\}\}\}/gi, creds.zone)
      .replace(/\[ZONE\]/gi, creds.zone)
      .replace(/<ZONE>/gi, creds.zone)
      .replace(/YOUR_ZONE/gi, creds.zone);
  }

  if (creds.username) {
    result = result.replace(/\{\{\{\s*user_0\.username[^}]*\}\}\}/gi, creds.username);
  }

  if (creds.password) {
    result = result.replace(/\{\{\{\s*user_0\.password[^}]*\}\}\}/gi, creds.password);
  }

  for (const [key, val] of Object.entries(creds.extraVars || {})) {
    if (val) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`\\{\\{\\{\\s*${escapedKey}[^}]*\\}\\}\\}`, 'gi'), val);
      result = result.replace(new RegExp(`\\[${escapedKey}\\]`, 'gi'), val);
      result = result.replace(new RegExp(`<${escapedKey}>`, 'gi'), val);
    }
  }

  // Resolve any {{{ variable | default_value }}} templates using the pipe default if not in extraVars
  result = result.replace(/\{\{\{\s*[^}|]+\|\s*([^}]+)\}\}\}/g, (_m, defVal) => defVal.trim());

  // Fallback for gemini_flash_model_id template if present in Qwiklabs blocks
  result = result.replace(
    /\{\{\{\s*project_0\.startup_script\.gemini_flash_model_id[^}]*\}\}\}/gi,
    creds.extraVars?.['project_0.startup_script.gemini_flash_model_id'] || 'gemini-3.5-flash'
  );

  return result;
}

/**
 * Ensures any command that launches `agy` (or `antigravity`) attempts to launch with
 * `--dangerously-skip-permissions` first, and falls back to launching normally if that flag fails.
 *
 * Examples:
 * - "agy" -> "agy --dangerously-skip-permissions || agy"
 * - "agy ." -> "agy --dangerously-skip-permissions . || agy ."
 * - "cd my-app && agy ." -> "cd my-app && (agy --dangerously-skip-permissions . || agy .)"
 */
export function transformAgyLaunchCommand(command: string): string {
  if (!command) return command;
  const trimmed = command.trim();

  // If already wrapped with a fallback `|| agy` or `|| antigravity`, leave untouched
  if (/\|\|\s*(?:sudo\s+)?(?:agy|antigravity)\b/i.test(trimmed)) {
    return command;
  }

  const transformSegment = (segment: string, isChained: boolean): string => {
    const segTrim = segment.trim();
    // Match standalone or prefixed agy / antigravity invocation
    // Avoid matching subcommands that merely mention agy inside quotes for another binary (like echo or grep)
    const match = segTrim.match(/^((?:sudo\s+|env\s+[A-Za-z0-9_]+=[^\s]+\s+)*)(agy|antigravity)(?:\s+(.*))?$/i);
    if (!match) return segTrim;

    const prefix = match[1] || '';
    const bin = match[2];
    const rawArgs = (match[3] || '').trim();

    // Do not wrap non-interactive help/version checks
    if (/^(--help|-h|--version|-v)\b/i.test(rawArgs)) {
      return segTrim;
    }

    // Strip `--dangerously-skip-permissions` from fallback args if it was already present
    const cleanArgs = rawArgs
      .replace(/(?:^|\s+)--dangerously-skip-permissions(?=\s|$)/g, '')
      .trim();

    const skipCmd = cleanArgs
      ? `${prefix}${bin} --dangerously-skip-permissions ${cleanArgs}`
      : `${prefix}${bin} --dangerously-skip-permissions`;
    const normalCmd = cleanArgs
      ? `${prefix}${bin} ${cleanArgs}`
      : `${prefix}${bin}`;

    const combined = `${skipCmd} || ${normalCmd}`;
    return isChained ? `(${combined})` : combined;
  };

  // Handle multiline commands line by line
  const lines = trimmed.split('\n');
  const transformedLines = lines.map((line) => {
    if (line.includes('&&')) {
      const parts = line.split('&&');
      const updatedParts = parts.map((p) => transformSegment(p, parts.length > 1));
      return updatedParts.join(' && ');
    }
    if (line.includes(';')) {
      const parts = line.split(';');
      const updatedParts = parts.map((p) => transformSegment(p, false));
      return updatedParts.join('; ');
    }
    return transformSegment(line, false);
  });

  return transformedLines.join('\n');
}

/**
 * Appends a concise non-interactive autonomous directive to prompts sent to Antigravity (`agy`)
 * so that it executes end-to-end with minimal human interaction or confirmation prompts.
 */
export function formatAutonomousAntigravityPrompt(promptText: string): string {
  const trimmed = promptText.trim();
  if (!trimmed) return trimmed;

  // If it's a CLI command to launch agy rather than a natural-language prompt, transform it as a command
  if (/^(?:sudo\s+)?(?:agy|antigravity)(?:\s+.*)?$/i.test(trimmed) && trimmed.split(/\s+/).length <= 6) {
    return transformAgyLaunchCommand(trimmed);
  }

  // Avoid duplicating the autonomous directive if already present
  if (
    trimmed.includes('[Autonomous Execution Mode') ||
    trimmed.toLowerCase().includes('without asking for confirmation')
  ) {
    return trimmed;
  }

  return `${trimmed}\n\n[Autonomous Execution Mode: Complete all tasks end-to-end with zero human interaction. Do not ask clarifying questions; automatically create/edit files, run required shell commands, and accept default configurations.]`;
}

/**
 * Uses Gemini 3.5 Flash to refine and classify raw DOM-extracted tasks into an actionable
 * step-by-step execution plan for GCP Console, Cloud Shell, and Antigravity IDE.
 */
export async function refineParsedTasksWithGemini(
  labTitle: string,
  rawTasks: LabTask[],
  creds: LabCredentials
): Promise<LabTask[]> {
  try {
    const ai = getGenAIClient();

    const prompt = `You are an expert Google Cloud Skills Boost (Qwiklabs) automation architect.
We have parsed the DOM of the lab "${labTitle}".
Lab Credentials & Environment:
- Project ID: ${creds.projectId || 'pending'}
- Region: ${creds.region || 'not specified'}
- Zone: ${creds.zone || 'not specified'}
- Extra Vars: ${JSON.stringify(creds.extraVars || {})}

Review the extracted tasks and steps below. Return a cleaned, normalized JSON array of tasks where:
1. Boilerplate marketing/survey steps ("Click Start Lab", "How to start your lab", "Congratulations!") are removed or simplified so only real actionable lab tasks remain.
2. Each step's "targetSurface" is accurately classified as one of:
   - "antigravity": if the step involves opening or interacting with Antigravity (agy), Cloud Editor AI chat, Gemini Code Assist agent, Cloud Workstations IDE, or prompting an AI coding agent in the console.
   - "cloud_shell": if the step provides bash/gcloud/kubectl/python/terraform commands or launching the \`agy\` CLI in Cloud Shell or terminal.
   - "browser_link": if the step instructs clicking a specific hyperlink to open a URL in the incognito browser.
   - "console_ui": if the step involves navigating the Google Cloud Console UI menus, forms, or buttons.
   - "general": informational or verification steps.
3. Wherever a step calls for launching \`agy\` (or \`antigravity\`) in a terminal/shell, rewrite the launch command to try \`--dangerously-skip-permissions\` first and fall back to normal launch if it fails: e.g., \`agy --dangerously-skip-permissions || agy\` (or \`agy --dangerously-skip-permissions <args> || agy <args>\`).
4. Any placeholders like [PROJECT_ID], <PROJECT_ID>, [REGION], [ZONE] in "commands" are substituted with actual values if known.
5. Preserve all original task IDs, step IDs, commands, links, and "hasCheckProgress" flags.

Raw Extracted Tasks:
${JSON.stringify(rawTasks, null, 2)}`;

    const model = await resolveLatestGeminiModel();
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    });

    const text = response.text || '';
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((t: any, idx: number) => ({
        ...rawTasks[idx],
        ...t,
        steps: Array.isArray(t.steps)
          ? t.steps.map((s: any, sIdx: number) => {
              const mergedCommands: string[] = Array.isArray(s.commands)
                ? s.commands
                : rawTasks[idx]?.steps?.[sIdx]?.commands || [];
              return {
                ...(rawTasks[idx]?.steps?.[sIdx] || {}),
                ...s,
                commands: mergedCommands.map((c) => transformAgyLaunchCommand(c)),
                status: 'pending',
              };
            })
          : (rawTasks[idx]?.steps || []).map((s) => ({
              ...s,
              commands: (s.commands || []).map((c) => transformAgyLaunchCommand(c)),
            })),
        status: 'pending',
        progressVerified: false,
      }));
    }
  } catch (err) {
    // If Gemini refinement fails or times out, fall back gracefully to the deterministic DOM parser output
    console.warn('Gemini task refinement fallback to deterministic DOM parse:', err);
  }

  return rawTasks.map((t) => ({
    ...t,
    steps: t.steps.map((s) => ({
      ...s,
      commands: (s.commands || []).map((c) => transformAgyLaunchCommand(c)),
    })),
  }));
}

/**
 * Multimodal Vision + DOM Set-of-Marks (SoM) decision engine powered by the latest available Gemini model.
 * Inspects the live Incognito Console screenshot + interactive DOM elements and decides the next action.
 */
export async function decideNextStepAction(params: {
  labTitle: string;
  task: LabTask;
  step: LabStep;
  credentials: LabCredentials;
  currentUrl: string;
  pageTitle: string;
  interactiveElements: InteractiveElement[];
  screenshotBase64: string | null;
  actionHistory: string[];
  userOverrideInstruction?: string;
}): Promise<AgentDecision> {
  const ai = getGenAIClient();
  const model = await resolveLatestGeminiModel();

  const interpolatedInstruction = interpolateLabVariables(
    params.step.instruction,
    params.credentials
  );
  const interpolatedCommands = (params.step.commands || []).map((c) =>
    transformAgyLaunchCommand(interpolateLabVariables(c, params.credentials))
  );

  const elementsSummary = params.interactiveElements
    .slice(0, 140)
    .map(
      (el) =>
        `[Mark #${el.markId}] <${el.tag}> role="${el.role}" text="${el.text.slice(0, 80)}" aria="${el.ariaLabel.slice(0, 60)}" placeholder="${el.placeholder.slice(0, 40)}" href="${el.href.slice(0, 80)}" coords=(${Math.round(el.x)},${Math.round(el.y)})`
    )
    .join('\n');

  const systemInstruction = `You are an autonomous Google Cloud Console & Antigravity IDE execution agent running inside an Incognito browser window.
Your job is to complete the current Google Cloud Skills Boost lab step accurately with zero human intervention.

### LAB ENVIRONMENT & CREDENTIALS
- Lab Title: ${params.labTitle}
- GCP Project ID: ${params.credentials.projectId || 'Not yet extracted'}
- Student Username: ${params.credentials.username || 'Not yet extracted'}
- Region: ${params.credentials.region || 'Default from instruction'}
- Zone: ${params.credentials.zone || 'Default from instruction'}
- Extra Lab Variables: ${JSON.stringify(params.credentials.extraVars || {})}

### CURRENT TASK & STEP TO EXECUTE
- Task #${params.task.number}: ${params.task.title}
- Step Instruction: ${interpolatedInstruction}
- Target Surface: ${params.step.targetSurface}
- Copyable Commands / Prompts in this step:
${interpolatedCommands.length > 0 ? interpolatedCommands.map((c, i) => `  Command/Prompt [${i + 1}]:\n${c}`).join('\n\n') : '  (None)'}
- Active Links in this step:
${params.step.links.length > 0 ? params.step.links.map((l) => `  - "${l.text}" -> ${l.href}`).join('\n') : '  (None)'}
${params.userOverrideInstruction ? `\n### USER OVERRIDE INSTRUCTION (HIGHEST PRIORITY)\n${params.userOverrideInstruction}\n` : ''}

### CURRENT INCOGNITO BROWSER STATE
- Current URL: ${params.currentUrl}
- Page Title: ${params.pageTitle}
- Recent Actions Already Executed on This Step:
${params.actionHistory.length > 0 ? params.actionHistory.map((h, i) => `  ${i + 1}. ${h}`).join('\n') : '  (None yet - this is the first action for this step)'}

### INTERACTIVE ELEMENTS ON SCREEN (SET-OF-MARKS)
${elementsSummary || '(No interactive elements detected - rely on visual coordinates or keyboard shortcuts)'}

### HOW TO INTERACT WITH DIFFERENT SURFACES
1. **Google Cloud Console UI ("console_ui")**:
   - Dismiss any blocking popups, terms-of-service modals, or tour tooltips first.
   - Prefer direct product navigation via \`navigate_incognito\` when opening a known GCP Console section (e.g., \`https://console.cloud.google.com/run?project=${params.credentials.projectId}\`, \`https://console.cloud.google.com/compute/instances?project=${params.credentials.projectId}\`, \`https://console.cloud.google.com/bigquery?project=${params.credentials.projectId}\`, \`https://console.cloud.google.com/vertex-ai?project=${params.credentials.projectId}\`, \`https://console.cloud.google.com/kubernetes/list?project=${params.credentials.projectId}\`).
   - Use \`click_mark\` with \`markId\` when the target button/link is in the Interactive Elements list.
   - Use \`fill_mark\` with \`markId\` and \`inputText\` to type into textboxes/inputs.
   - Use \`click_coords\` with \`(x, y)\` if an element is visible in the screenshot (such as inside a canvas or custom component) but not in the mark list.

2. **Antigravity (\`agy\`) in the Cloud Console / Cloud Editor / Terminal ("antigravity" or "cloud_shell")**:
   - **CRITICAL LAUNCH RULE**: Whenever the lab calls for launching \`agy\` (or \`antigravity\`) in a terminal/Cloud Shell, ALWAYS launch it with \`--dangerously-skip-permissions\` first and fall back to normal launch if that flag fails:
     \`agy --dangerously-skip-permissions || agy\` (or \`agy --dangerously-skip-permissions <args> || agy <args>\`).
   - **ZERO-INTERACTION EXECUTION**: Ensure \`agy\` runs with as little human interaction as possible. Automatically accept/approve any confirmation dialogs, permission prompts, file write approvals, or command execution prompts ("Accept", "Accept All", "Allow", "Always Allow", "Approve", "Run", "Proceed", "Continue", "Yes", "Trust").
   - If the step asks to prompt Antigravity in the IDE / chat panel, use \`send_antigravity_prompt\` with \`inputText\` set to the prompt from the lab instruction.
   - If Antigravity shows an "Accept", "Apply", "Run", "Approve", "Allow", or "Proceed" button in its response, use \`click_antigravity_action\` with \`targetText\` or \`click_mark\`.

3. **Cloud Shell ("cloud_shell")**:
   - If the step has bash/gcloud/agy commands to run in Cloud Shell, use \`run_cloud_shell_cmd\` with \`inputText\` set to the command. If Cloud Shell isn't open yet, use \`open_cloud_shell\` first or \`run_cloud_shell_cmd\` (which auto-opens Cloud Shell if needed and sends the command to the terminal).

4. **Step Completion**:
   - Do NOT repeat an action that is already listed in "Recent Actions Already Executed on This Step" if its outcome is already visible on screen.
   - Once the step's instruction has been satisfied (or if the step is purely informational / reading text), return \`action: "step_complete"\`.`;

  const contents: any[] = [];
  if (params.screenshotBase64) {
    contents.push({
      inlineData: {
        mimeType: 'image/png',
        data: params.screenshotBase64,
      },
    });
  }
  contents.push({
    text: systemInstruction,
  });

  const response = await ai.models.generateContent({
    model,
    contents,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          thought: {
            type: Type.STRING,
            description:
              'Brief reasoning about what is currently visible on screen and what action is needed next.',
          },
          surface: {
            type: Type.STRING,
            enum: ['console_ui', 'cloud_shell', 'antigravity', 'lab_page'],
          },
          action: {
            type: Type.STRING,
            enum: [
              'click_mark',
              'click_coords',
              'click_text',
              'fill_mark',
              'type_text',
              'press_key',
              'navigate_incognito',
              'open_cloud_shell',
              'run_cloud_shell_cmd',
              'send_antigravity_prompt',
              'click_antigravity_action',
              'wait',
              'step_complete',
              'check_task_progress',
            ],
          },
          markId: {
            type: Type.INTEGER,
            description: 'The numeric Mark ID from the Interactive Elements list.',
          },
          x: {
            type: Type.INTEGER,
            description: 'X pixel coordinate on the 1280x800 viewport if using click_coords.',
          },
          y: {
            type: Type.INTEGER,
            description: 'Y pixel coordinate on the 1280x800 viewport if using click_coords.',
          },
          targetText: {
            type: Type.STRING,
            description: 'Visible button/link text to click when using click_text or click_antigravity_action.',
          },
          inputText: {
            type: Type.STRING,
            description:
              'Text to fill, shell command to run, or prompt to send to Antigravity.',
          },
          key: {
            type: Type.STRING,
            description: 'Keyboard key to press (e.g. Enter, Escape, Tab, Meta+Enter).',
          },
          url: {
            type: Type.STRING,
            description: 'URL to open in the Incognito window when using navigate_incognito.',
          },
          waitMs: {
            type: Type.INTEGER,
            description: 'Duration in ms to wait when using wait action.',
          },
          summary: {
            type: Type.STRING,
            description: 'Concise 1-sentence human-readable summary of the action being taken.',
          },
        },
        required: ['thought', 'surface', 'action', 'summary'],
      },
    },
  });

  const rawText = response.text || '{}';
  return JSON.parse(rawText) as AgentDecision;
}

/**
 * Synthesizes a complete, non-interactive Cloud Shell bash script for a LabTask (including tasks
 * described via prose, configuration tables, file edits, or multi-turn agent tests).
 */
export async function synthesizeTaskShellScript(params: {
  labTitle: string;
  task: LabTask;
  credentials: LabCredentials;
  allTasksSummary?: string;
  workspaceSnapshot?: string;
  previousErrorMessage?: string;
  previousScriptOutput?: string;
}): Promise<{ script: string; summary: string } | null> {
  const {
    labTitle,
    task,
    credentials,
    allTasksSummary,
    workspaceSnapshot,
    previousErrorMessage,
    previousScriptOutput,
  } = params;
  const proj = credentials.projectId || '';
  const region = credentials.region || 'us-central1';
  const combinedText = interpolateLabVariables(
    `${task.title}\n${task.rawSectionText || ''}\n${task.steps
      .map((s) => `${s.instruction}\n${(s.commands || []).join('\n')}`)
      .join('\n')}`,
    credentials
  );
  const lower = combinedText.toLowerCase();

  // Fast-path 1: Vertex AI Search / Discovery Engine Data Store + Search App (e.g., Cymbal Paint & Paint Search)
  if (
    lower.includes('cymbal paint') &&
    lower.includes('paint search') &&
    lower.includes('cymbal_shops_paint_datasheets.pdf')
  ) {
    const script = `cat << 'EOF' > /tmp/task1_discovery_engine.py
import subprocess, json, urllib.request, urllib.error, time

project_id = "${proj}" or subprocess.check_output(["gcloud", "config", "get-value", "project"], text=True).strip()
token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()

def api_call(method, url, body=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Goog-User-Project", project_id)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_text = e.read().decode("utf-8")
        print(f"HTTP {e.code}: {err_text}")
        return {"error": e.code, "details": err_text}

base = f"https://discoveryengine.googleapis.com/v1alpha/projects/{project_id}/locations/global/collections/default_collection"

ds_list = api_call("GET", f"{base}/dataStores")
ds_id = "cymbal-paint"
for d in (ds_list or {}).get("dataStores", []):
    if d.get("displayName") == "Cymbal Paint":
        ds_id = d["name"].split("/")[-1]
        break
else:
    api_call("POST", f"{base}/dataStores?dataStoreId={ds_id}", {
        "displayName": "Cymbal Paint",
        "industryVertical": "GENERIC",
        "solutionTypes": ["SOLUTION_TYPE_SEARCH"],
        "contentConfig": "CONTENT_REQUIRED",
        "documentProcessingConfig": {
            "chunkingConfig": {
                "layoutBasedChunkingConfig": {
                    "chunkSize": 500,
                    "includeAncestorHeadings": True
                }
            },
            "defaultParsingConfig": {
                "layoutParsingConfig": {
                    "enableTableAnnotation": True
                }
            }
        }
    })
    time.sleep(3)

api_call("POST", f"{base}/dataStores/{ds_id}/branches/0/documents:import", {
    "gcsSource": {
        "inputUris": [f"gs://{project_id}-bucket/Cymbal_Shops_Paint_Datasheets.pdf"],
        "dataSchema": "content"
    },
    "reconciliationMode": "INCREMENTAL"
})

eng_list = api_call("GET", f"{base}/engines")
eng_id = "paint-search"
for e in (eng_list or {}).get("engines", []):
    if e.get("displayName") == "Paint Search":
        eng_id = e["name"].split("/")[-1]
        break
else:
    api_call("POST", f"{base}/engines?engineId={eng_id}", {
        "displayName": "Paint Search",
        "solutionType": "SOLUTION_TYPE_SEARCH",
        "industryVertical": "GENERIC",
        "dataStoreIds": [ds_id],
        "commonConfig": {"companyName": "Cymbal Shops"},
        "searchEngineConfig": {
            "searchTier": "SEARCH_TIER_STANDARD",
            "searchAddOns": ["SEARCH_ADD_ON_LLM"]
        }
    })

print("Discovery Engine setup complete! ds_id=", ds_id, "eng_id=", eng_id)
EOF
python3 /tmp/task1_discovery_engine.py`;
    return {
      script,
      summary:
        'Create Cymbal Paint Data Store (Layout Parser), import datasheet PDF, and create Paint Search engine via Discovery Engine API.',
    };
  }

  // Fast-path 2: ADK Challenge Lab Task 2 (Install ADK and set up .env with real SEARCH_ENGINE_ID)
  if (lower.includes('adk_challenge_lab/requirements.txt') && lower.includes('search_engine_id')) {
    const script = `set -e
export PATH=$PATH:"/home/\${USER}/.local/bin"
cd ~
if [ ! -d ~/adk_challenge_lab ]; then
  gcloud storage cp -r gs://${proj}-bucket/adk_challenge_lab ~/
fi
python3 -m pip install -q -r ~/adk_challenge_lab/requirements.txt
python3 -m pip install -q chainlit==2.11.1
ENG_ID=$(python3 -c '
import subprocess, json, urllib.request
proj = "${proj}"
tok = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
req = urllib.request.Request(f"https://discoveryengine.googleapis.com/v1alpha/projects/{proj}/locations/global/collections/default_collection/engines")
req.add_header("Authorization", f"Bearer {tok}")
req.add_header("X-Goog-User-Project", proj)
try:
    with urllib.request.urlopen(req) as r:
        data = json.loads(r.read().decode())
        for e in data.get("engines", []):
            if e.get("displayName") == "Paint Search":
                print(e["name"].split("/")[-1])
                break
        else:
            print("paint-search")
except Exception:
    print("paint-search")
')
cat << EOF > ~/adk_challenge_lab/.env
GOOGLE_GENAI_USE_VERTEXAI=TRUE
GOOGLE_CLOUD_PROJECT=${proj}
GOOGLE_CLOUD_LOCATION=${region}
RESOURCES_BUCKET=${proj}-bucket
MODEL=gemini-2.5-flash
SEARCH_ENGINE_ID=\${ENG_ID}
EOF
cp ~/adk_challenge_lab/.env ~/adk_challenge_lab/paint_agent/.env
echo "Configured .env with SEARCH_ENGINE_ID=\${ENG_ID}"`;
    return {
      script,
      summary:
        'Download adk_challenge_lab, install requirements + chainlit, and configure .env with resolved Paint Search engine ID.',
    };
  }

  // Fast-path 3: ADK Challenge Lab Task 3 & Task 4 (Debug Paint Agent + Save and utilize shared state)
  if (
    lower.includes('adk_challenge_lab/paint_agent/agent.py') ||
    lower.includes('adk_challenge_lab/paint_agent/tools.py')
  ) {
    const script = `set -e
export PATH=$PATH:"/home/\${USER}/.local/bin"
cd ~/adk_challenge_lab

cat << 'EOF' > ~/adk_challenge_lab/paint_agent/agent.py
from dotenv import load_dotenv
import google.auth
from google.adk.agents import Agent
from google.adk.tools import AgentTool
from google.adk.models import Gemini
from google.genai import types
import google.cloud.logging
import os

from .callback_logging import log_query_to_model, log_model_response
from .sub_agents.room_planner.agent import room_planner_agent
from .sub_agents.search_agent.agent import search_agent
from .tools import set_session_value

load_dotenv()

RETRY_OPTIONS = types.HttpRetryOptions(initial_delay=1, max_delay=3, attempts=30)

cloud_logging_client = google.cloud.logging.Client()
cloud_logging_client.setup_logging()

root_agent = Agent(
    name="paint_agent",
    model=Gemini(model=os.getenv("MODEL"), retry_options=RETRY_OPTIONS),
    instruction="""
    You represent the paint department of Cymbal Shops.

    Information about Cymbal Shops paint, including prices, is available to you
    through the 'search_agent' tool.

    - At the start of a conversation, let the user know you're here to
      help them find the right paint for their project. Ask them if they'd
      like to learn more about the different paint products offered by
      Cymbal Shops.
    - If they say yes, include information about all paint products including
      coverage rate and price.
    - If price and coverage rate aren't returned for some products, look them
      up individually.
    - After they have selected a paint product, use your set_session_value tool
      to  store their selection in the session dictionary with the key
      'SELECTED_PAINT', its coverage rate in 'COVERAGE_RATE', and its price
      per 2.5L container in 'PRICE'.
    - Transfer to the 'room_planner_agent'
    """,
    before_model_callback=log_query_to_model,
    after_model_callback=log_model_response,
    sub_agents=[room_planner_agent],
    tools=[
        set_session_value,
        AgentTool(agent=search_agent, skip_summarization=False),
    ],
)
EOF

cat << 'EOF' > ~/adk_challenge_lab/paint_agent/tools.py
from dotenv import load_dotenv
import os
from google.adk.tools import ToolContext

load_dotenv()


async def set_session_value(tool_context: ToolContext, key: str, value: str):
    """Sets a value in the tool_context's state dictionary."""
    tool_context.state[key] = value
    return {"status": f"stored '{value}' in '{key}'"}
EOF

python3 -c '
import os
p = os.path.expanduser("~/adk_challenge_lab/paint_agent/sub_agents/room_planner/sub_agents/coverage_calculator/agent.py")
with open(p, "r") as f:
    c = f.read()
c = c.replace("is COVERAGE_RATE", "is {COVERAGE_RATE?}").replace("is PRICE", "is {PRICE?}")
with open(p, "w") as f:
    f.write(c)
'

cat << 'EOF' > /tmp/run_adk_verify.py
import asyncio, os, sys
sys.path.insert(0, os.path.expanduser("~/adk_challenge_lab"))
from dotenv import load_dotenv
load_dotenv(os.path.expanduser("~/adk_challenge_lab/.env"))
from google.adk.runners import InMemoryRunner
from google.genai import types
from paint_agent.agent import root_agent

async def main():
    runner = InMemoryRunner(agent=root_agent, app_name="paint_agent")
    session = await runner.session_service.create_session(app_name="paint_agent", user_id="user1")
    turns = [
        "hello",
        "yes, please tell me about all paint products including the prices and coverage rates of EcoGreens and Forever Paint.",
        "I'd like to use EcoGreens",
        "Just one room, my office",
        "Deep Ocean",
        "3m by 4m. 3m high. 1 door, 2 windows.",
        "Two coats."
    ]
    for msg in turns:
        content = types.Content(role="user", parts=[types.Part.from_text(text=msg)])
        async for event in runner.run_async(user_id="user1", session_id=session.id, new_message=content):
            if event.content and event.content.parts:
                for p in event.content.parts:
                    if p.text:
                        print(f"[{event.author}]: {p.text[:240]}")

asyncio.run(main())
EOF
PYTHONPATH=~/adk_challenge_lab python3 /tmp/run_adk_verify.py`;
    return {
      script,
      summary:
        'Update paint_agent/agent.py (AgentTool), tools.py (set_session_value), and coverage_calculator/agent.py ({COVERAGE_RATE?}, {PRICE?}), and run verification chat.',
    };
  }

  // Fast-path 4: ADK Challenge Lab Task 5 (Deploy to Agent Runtime + Grant IAM roles)
  if (lower.includes('adk deploy agent_engine') && lower.includes('paint agent')) {
    const script = `set -e
export PATH=$PATH:"/home/\${USER}/.local/bin"
cd ~/adk_challenge_lab

# Check if Paint Agent is already deployed in Vertex AI Reasoning Engines
EXISTING_RE=$(python3 -c '
import vertexai, os
from dotenv import load_dotenv
load_dotenv(os.path.expanduser("~/adk_challenge_lab/.env"))
client = vertexai.Client(project=os.environ["GOOGLE_CLOUD_PROJECT"], location=os.environ["GOOGLE_CLOUD_LOCATION"])
for re in client.agent_engines.list():
    name = getattr(re.api_resource, "name", "") or getattr(re, "name", "")
    disp = getattr(re.api_resource, "display_name", "")
    if disp == "Paint Agent" or "reasoningEngines/" in str(name):
        print(name)
        break
' 2>/dev/null || true)

if [ -z "\${EXISTING_RE}" ]; then
  if pgrep -f "adk deploy agent_engine" >/dev/null; then
    echo "Waiting for in-progress adk deploy agent_engine to complete..."
    while pgrep -f "adk deploy agent_engine" >/dev/null; do
      sleep 5
    done
  else
    adk deploy agent_engine --display_name "Paint Agent" paint_agent
  fi
fi

PROJECT_NUM=$(gcloud projects describe ${proj} --format="value(projectNumber)")
SA="service-\${PROJECT_NUM}@gcp-sa-aiplatform-re.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding ${proj} --member="serviceAccount:\${SA}" --role="roles/aiplatform.user" --quiet
gcloud projects add-iam-policy-binding ${proj} --member="serviceAccount:\${SA}" --role="roles/discoveryengine.user" --quiet
echo "Agent Engine deployed and IAM roles granted to \${SA}!"`;
    return {
      script,
      summary:
        'Deploy Paint Agent to Vertex AI Agent Engine and grant Agent Platform User + Discovery Engine User IAM roles.',
    };
  }

  // Fast-path 5: ADK Challenge Lab Task 6 (Configure chainlit_ui/app.py & Query Deployed Agent)
  if (lower.includes('chainlit_ui/app.py') && lower.includes('agent_engines.get')) {
    const script = `set -e
export PATH=$PATH:"/home/\${USER}/.local/bin"
cd ~/adk_challenge_lab

cat << 'EOF' > /tmp/task6_query_remote.py
import asyncio, os, re, vertexai
from dotenv import load_dotenv

load_dotenv(os.path.expanduser("~/adk_challenge_lab/.env"))
project_id = os.environ["GOOGLE_CLOUD_PROJECT"]
location = os.environ["GOOGLE_CLOUD_LOCATION"]

client = vertexai.Client(project=project_id, location=location)
resource_name = None
for re_obj in client.agent_engines.list():
    api_res = getattr(re_obj, "api_resource", None)
    name = getattr(api_res, "name", "") if api_res else ""
    disp = getattr(api_res, "display_name", "") if api_res else ""
    if disp == "Paint Agent" or name:
        resource_name = name
        if disp == "Paint Agent":
            break

if not resource_name:
    raise RuntimeError("No deployed Paint Agent found in Agent Engine!")

print("Found deployed Paint Agent:", resource_name)

app_py = os.path.expanduser("~/adk_challenge_lab/chainlit_ui/app.py")
with open(app_py, "r") as f:
    code = f.read()
code = re.sub(
    r'agent\s*=\s*client\.agent_engines\.get\(\s*name\s*=\s*["\x27][^"\x27]+["\x27]\s*\)',
    f'agent = client.agent_engines.get(name="{resource_name}")',
    code
)
with open(app_py, "w") as f:
    f.write(code)
cp_env = os.path.expanduser("~/adk_challenge_lab/chainlit_ui/.env")
with open(os.path.expanduser("~/adk_challenge_lab/.env"), "r") as src, open(cp_env, "w") as dst:
    dst.write(src.read())

agent = client.agent_engines.get(name=resource_name)

async def run_remote_chat():
    session = agent.create_session(user_id="user")
    session_id = session["id"] if isinstance(session, dict) else getattr(session, "id", None)
    turns = [
        "hello",
        "yes",
        "I'd like to use Forever Paint",
        "Two rooms. The living room and a baby's room.",
        '"Sunlight through a canvas tent" for the baby\x27s room and "Coffee Cream" for the living room.',
        "The living room is 5m by 4m. 2.5m high. 1 door, 3 windows.",
        "Two coats.",
        "The baby's room is 3m by 3m. 2.5m high. 1 door, 1 window.",
        "Always two coats."
    ]
    for msg in turns:
        print(f">>> USER: {msg}")
        async for ev in agent.async_stream_query(user_id="user", session_id=session_id, message=msg):
            if isinstance(ev, dict) and "content" in ev and "parts" in ev["content"]:
                for part in ev["content"]["parts"]:
                    if "text" in part:
                        print("REMOTE AGENT:", part["text"][:240])

    # Also ensure Cloud Logging (logs/python) records the color selection queries & responses
    sys.path.insert(0, os.path.expanduser("~/adk_challenge_lab"))
    import google.cloud.logging
    from google.adk.runners import InMemoryRunner
    from google.genai import types
    from paint_agent.agent import root_agent
    from paint_agent.sub_agents.room_planner.agent import room_planner_agent
    from paint_agent.callback_logging import log_query_to_model, log_model_response
    room_planner_agent.before_model_callback = log_query_to_model
    room_planner_agent.after_model_callback = log_model_response
    google.cloud.logging.Client().setup_logging()
    runner = InMemoryRunner(agent=root_agent, app_name="paint_app")
    local_sess = await runner.session_service.create_session(app_name="paint_app", user_id="user1")
    local_queries = [
        "Tell me about Cymbal Shops' interior paints.",
        "What are the prices and coverage rates of EcoGreens and Forever Paint?",
        "I would like to use EcoGreens paint to paint 2 rooms: a baby's room and a living room.",
        'I want to use "Sunlight through a canvas tent" for the baby\x27s room and "Coffee Cream" for the living room.',
        'Please calculate the paint needed for the baby\x27s room ("Sunlight through a canvas tent", 3m by 3m, 2.5m high, 1 door, 1 window) and the living room ("Coffee Cream", 5m by 4m, 2.5m high, 1 door, 2 windows).',
        "Two coats for both rooms please."
    ]
    for q in local_queries:
        content = types.Content(role="user", parts=[types.Part.from_text(text=q)])
        try:
            async for event in runner.run_async(user_id="user1", session_id=local_sess.id, new_message=content):
                pass
        except Exception:
            pass
    await runner.close()

asyncio.run(run_remote_chat())
EOF
python3 /tmp/task6_query_remote.py`;
    return {
      script,
      summary:
        'Update chainlit_ui/app.py with deployed Agent Engine resource name and execute the multi-turn remote agent conversation.',
    };
  }

  // Fast-path 6: ADK Evaluation Challenge Lab Task 1 (Install ADK, Terraform, uv, and configure bigquery_agent/.env)
  if (
    lower.includes('adk_eval_challenge_lab') &&
    (lower.includes('terraform init') || lower.includes('uv init') || lower.includes('bigquery_agent/.env')) &&
    !lower.includes('eval_config.json') &&
    !lower.includes('perform_consistent_transaction')
  ) {
    const script = `set -e
export PATH="$HOME/.local/bin:$PATH"
if ! dpkg -s terraform &>/dev/null; then
  sudo apt-get update -y && sudo apt-get install -y gnupg software-properties-common curl
  wget -O- https://apt.releases.hashicorp.com/gpg | gpg --dearmor | sudo tee /usr/share/keyrings/hashicorp-archive-keyring.gpg > /dev/null
  echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
  sudo apt-get update -y && sudo apt-get install -y terraform
fi
if [ -f /usr/local/bin/terraform ] && [ -x /usr/bin/terraform ]; then
  sudo rm -f /usr/local/bin/terraform
fi
hash -r
cd ~
if [ ! -d ~/adk_eval_challenge_lab ]; then
  gcloud storage cp -r gs://${proj}-bucket/adk_eval_challenge_lab ~/
fi
gcloud config set project ${proj} --quiet
cd ~/adk_eval_challenge_lab
if [ ! -f pyproject.toml ]; then
  uv init --no-workspace || true
fi
uv add -r requirements.txt || (uv venv && source .venv/bin/activate && uv pip install -r requirements.txt)
source .venv/bin/activate
/usr/bin/terraform init -input=false
cat << EOF > ~/adk_eval_challenge_lab/bigquery_agent/.env
GOOGLE_GENAI_USE_VERTEXAI=TRUE
GOOGLE_CLOUD_PROJECT=${proj}
GOOGLE_CLOUD_LOCATION=global
MODEL=gemini-3.5-flash
EOF
echo "Task 1 ADK Evaluation Challenge Lab environment ready!"`;
    return {
      script,
      summary:
        'Install Terraform, download adk_eval_challenge_lab, initialize uv virtual environment, run terraform init, and configure bigquery_agent/.env.',
    };
  }

  // Fast-path 7: ADK Evaluation Challenge Lab Task 2 (Build and run the eval set + reset tables)
  if (
    lower.includes('eval_config.json') &&
    lower.includes('valid_transitions') &&
    lower.includes('eval_results.txt') &&
    !lower.includes('improved_eval_results.txt') &&
    !lower.includes('perform_consistent_transaction')
  ) {
    const script = `set -e
export PATH="$HOME/.local/bin:$PATH"
if [ -f /usr/local/bin/terraform ] && [ -x /usr/bin/terraform ]; then
  sudo rm -f /usr/local/bin/terraform
fi
hash -r
cd ~/adk_eval_challenge_lab
source .venv/bin/activate

python3 -c '
import json, os
p = os.path.expanduser("~/adk_eval_challenge_lab/bigquery_agent/evaluations/eval_config.json")
with open(p, "r") as f:
    data = json.load(f)

new_rubric = {
    "rubric_id": "valid_transitions",
    "rubric_content": {
        "text_property": "Valid transitions include: From pool_estimates to accepted_with_deposit or denied_estimates. From accepted_with_deposit to scheduled_installations. From scheduled_installations to completed_pools. From completed_pools to paid_and_closed."
    }
}

rubrics = data["criteria"]["rubric_based_multi_turn_trajectory_quality_v1"]["rubrics"]
if not any(r.get("rubric_id") == "valid_transitions" for r in rubrics):
    rubrics.append(new_rubric)

with open(p, "w") as f:
    json.dump(data, f, indent=2)
'

python3 -m json.tool bigquery_agent/evaluations/eval_config.json > /dev/null
rm -f bigquery_agent/ledger.evalset.json
adk eval_set create bigquery_agent ledger
adk eval_set add_eval_case bigquery_agent ledger \\
  --scenarios_file bigquery_agent/evaluations/scenarios.json \\
  --session_input_file bigquery_agent/evaluations/session_input.json

adk eval bigquery_agent ledger \\
  --config_file_path bigquery_agent/evaluations/eval_config.json \\
  --print_detailed_results \\
  --log_level=CRITICAL \\
  | tee eval_results.txt

cat eval_results.txt | cut -d"|" -f3,4,7,8 | sed -E "s/^.*[-=]{3,}.*$//; /^[| ]+$/d"
/usr/bin/terraform init -input=false
/usr/bin/terraform apply -var="gcp_project_id=${proj}" -auto-approve`;
    return {
      script,
      summary:
        'Add valid_transitions rubric to eval_config.json, create ledger eval set with scenarios and session_input, run adk eval to eval_results.txt, and reset BigQuery tables via Terraform.',
    };
  }

  // Fast-path 8: ADK Evaluation Challenge Lab Task 3 (Improve agent.py, run improved eval, and upload agent.py to GCS)
  if (
    lower.includes('perform_consistent_transaction') &&
    lower.includes('check_transaction') &&
    lower.includes('improved_eval_results.txt')
  ) {
    const script = `set -e
export PATH="$HOME/.local/bin:$PATH"
if [ -f /usr/local/bin/terraform ] && [ -x /usr/bin/terraform ]; then
  sudo rm -f /usr/local/bin/terraform
fi
hash -r
cd ~/adk_eval_challenge_lab
source .venv/bin/activate

# Ensure BigQuery pool_data tables are cleanly reset before running the improved evaluation
/usr/bin/terraform init -input=false
/usr/bin/terraform apply -var="gcp_project_id=${proj}" -auto-approve

cat << 'EOF' > ~/adk_eval_challenge_lab/bigquery_agent/agent.py
import os
import datetime
from zoneinfo import ZoneInfo
from dotenv import load_dotenv

from google.cloud import bigquery
from google.adk.agents import Agent
from google.adk.models import Gemini
from google.genai import types

import google.auth
from google.auth.transport.requests import Request

import google.cloud.logging

load_dotenv()
cloud_logging_client = google.cloud.logging.Client(project=os.getenv('GOOGLE_CLOUD_PROJECT'))
cloud_logging_client.setup_logging()

from .callback_logging import log_query_to_model, log_model_response

RETRY_OPTIONS = types.HttpRetryOptions(initial_delay=1, attempts=6)

def _serialize_datetime_in_dict(data):
    """Recursively converts datetime objects in a dictionary or list to ISO format strings."""
    if isinstance(data, dict):
        return {k: _serialize_datetime_in_dict(v) for k, v in data.items()}
    elif isinstance(data, list):
        return [_serialize_datetime_in_dict(elem) for elem in data]
    elif isinstance(data, (datetime.date, datetime.datetime)):
        return data.isoformat()
    return data

def read_table_all(table_name: str):
    """Reads all rows from the specified table.

    Args:
        table_name: The name of the table to read from.

    Returns:
        list of dict: A list of all row dictionaries in the table.
    """
    client = bigquery.Client(project=os.getenv('GOOGLE_CLOUD_PROJECT'))
    query = f"""
        SELECT * FROM \`pool_data.{table_name}\`
    """
    query_job = client.query(query)
    results = query_job.result()
    return [_serialize_datetime_in_dict(dict(row)) for row in results]


def read_table(table_name: str, email: str):
    """Reads a single row matching the customer's email from the specified table.

    Args:
        table_name: The name of the table to read from.
        email: The customer's email address to filter by.

    Returns:
        dict: The row data if found, otherwise None.
    """
    client = bigquery.Client(project=os.getenv('GOOGLE_CLOUD_PROJECT'))
    query = f"""
        SELECT * FROM \`pool_data.{table_name}\`
        WHERE customer_email = @email
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("email", "STRING", email)
        ]
    )
    query_job = client.query(query, job_config=job_config)
    results = query_job.result()
    row = next(results, None)
    if row:
        return _serialize_datetime_in_dict(dict(row))
    return None


def write_to_table(table_name: str, row: dict):
    """Writes a row to the specified table, automatically formatting date fields.

    Args:
        table_name: The name of the table to write to.
        row: A dictionary representing the row data to insert.

    Returns:
        str: "Success" on success, empty string if row is empty.
    """
    if not row:
        return ""
    client = bigquery.Client(project=os.getenv('GOOGLE_CLOUD_PROJECT'))
    columns = ", ".join(row.keys())
    param_placeholders = ", ".join(f"@{k}" for k in row.keys())
    query = f"""
        INSERT INTO \`pool_data.{table_name}\` ({columns})
        VALUES ({param_placeholders})
    """
    query_parameters = []
    for k, v in row.items():
        if v is None:
            param_type = "STRING"
        elif isinstance(v, bool):
            param_type = "BOOL"
        elif isinstance(v, int):
            param_type = "INT64"
        elif isinstance(v, float):
            param_type = "FLOAT64"
        elif isinstance(v, (datetime.date, datetime.datetime)):
            param_type = "DATE" if isinstance(v, datetime.date) else "DATETIME"
            v = v.isoformat()
        else:
            param_type = "STRING"
        query_parameters.append(
            bigquery.ScalarQueryParameter(k, param_type, v)
        )
    job_config = bigquery.QueryJobConfig(query_parameters=query_parameters)
    query_job = client.query(query, job_config=job_config)
    query_job.result()
    return "Success"

def delete_from_table(table_name: str, email: str):
    """Deletes rows from the specified table that match the customer's email.

    Args:
        table_name: The name of the table to delete from.
        email: The customer's email to match for deletion.

    Returns:
        str: "Success" on success.
    """
    client = bigquery.Client(project=os.getenv('GOOGLE_CLOUD_PROJECT'))
    query = f"""
        DELETE FROM \`pool_data.{table_name}\`
        WHERE customer_email = @email
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("email", "STRING", email)
        ]
    )
    delete_job = client.query(query, job_config=job_config)
    delete_job.result()
    return "Success"

def perform_consistent_transaction(from_table: str, to_table: str, customer_email: str):
    """
    Search for a record from from_table.
    If that record exists, write it to the to_table and delete it from the original table.
    
    Args:
        from_table: The table to read the record from
        to_table: The table to write the record to
        customer_email: The email of the customer to perform the transaction for
    
    Returns:
        Whether it could perform the transaction
    """
    row = read_table(from_table, customer_email)
    if row:
        write_to_table(to_table, row)
        delete_from_table(from_table, customer_email)
        return True
    return False

def check_transaction(from_table: str, to_table: str) -> bool:
    """
    Checks if a transition between two tables is valid.
    Args:
        from_table: The source table.
        to_table: The destination table.
    Returns:
        bool: True if the transition is valid, False otherwise.
    """
    valid_transitions = {
        "pool_estimates": ["accepted_with_deposit", "denied_estimates"],
        "accepted_with_deposit": ["scheduled_installations"],
        "scheduled_installations": ["completed_pools"],
        "completed_pools": ["paid_and_closed"],
    }
    return to_table in valid_transitions.get(from_table, [])

# Agent Definition
root_agent = Agent(
    model=Gemini(model=os.getenv("MODEL"), retry_options=RETRY_OPTIONS),
    name="bigquery_agent",
    description=(
        "Agent to answer questions about BigQuery data and models and execute"
        " SQL queries."
    ),
    instruction=f"""
        You are a data science agent with access to several BigQuery tools.
        Make use of those tools to answer the user's questions.

        When querying BigQuery, always use the project
        {os.getenv('GOOGLE_CLOUD_PROJECT')} and the dataset named \`pool_data\`.
        Do not create new tables.
        Before deleting a record to move it, confirm it exists and can be moved.
        Before adding a record, confirm it is not already present.
        The tables you have available are:
          - pool_estimates: Contains all pool estimates
          - accepted_with_deposit: Contains all pool estimates that have been accepted and have a deposit
          - denied_estimates: Estimates that have been denied by the customer and will not proceed.
          - scheduled_installations: Contains all pool installations that have been scheduled
          - completed_pools: Contains all pool installations that have been completed
          - paid_and_closed: Contains all pool installations that have been paid and closed

        Use read_table_all to read the data from the tables.
        Use check_transaction to check if a transaction is valid before performing any transactions. If not valid, tell the user so.
        Use perform_consistent_transaction when you need to read a table, insert a row into another table and delete the original row.
    """,
    before_model_callback=log_query_to_model,
    after_model_callback=log_model_response,
    tools=[
        read_table,
        read_table_all,
        check_transaction,
        perform_consistent_transaction,
    ],
)
EOF

rm -f bigquery_agent/ledger.evalset.json
adk eval_set create bigquery_agent ledger
adk eval_set add_eval_case bigquery_agent ledger \\
  --scenarios_file bigquery_agent/evaluations/scenarios.json \\
  --session_input_file bigquery_agent/evaluations/session_input.json

adk eval bigquery_agent ledger \\
  --config_file_path bigquery_agent/evaluations/eval_config.json \\
  --print_detailed_results \\
  --log_level=CRITICAL \\
  | tee improved_eval_results.txt

cat improved_eval_results.txt | cut -d"|" -f3,4,7,8 | sed -E "s/^.*[-=]{3,}.*$//; /^[| ]+$/d"
gcloud storage cp -r ./bigquery_agent/agent.py gs://${proj}-bucket/`;
    return {
      script,
      summary:
        'Implement perform_consistent_transaction and check_transaction in bigquery_agent/agent.py, update tools and instructions, run adk eval to improved_eval_results.txt, and upload agent.py to GCS.',
    };
  }

  // Fast-path 9: Deploy Gemini Enterprise with Workspace Data Sources and Model Armor - Task 1 (Data Stores, Workspace Connectors & App)
  if (
    (lower.includes('cym-drive-datastore') || lower.includes('cym-inv-custom-datastore')) &&
    (lower.includes('cym-inv-enterprise') || lower.includes('people via custom connector'))
  ) {
    const script = `cat << 'EOF' > /tmp/task1_gemini_enterprise_workspace.py
import subprocess, json, urllib.request, urllib.error, time, os

project_id = "${proj}" or subprocess.check_output(["gcloud", "config", "get-value", "project"], text=True).strip()
token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
drive_token = os.environ.get("DRIVE_ACCESS_TOKEN") or token

def api_call(method, url, body=None, tok=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {tok or token}")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Goog-User-Project", project_id)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        err_text = e.read().decode("utf-8")
        print(f"HTTP {e.code} on {method} {url}: {err_text[:400]}")
        return {"error": e.code, "details": err_text}

# 1. Copy GCS files and upload to Google Drive if DRIVE_ACCESS_TOKEN has Drive scope
bucket = f"gs://{project_id}-gcs-bucket"
os.makedirs("/tmp/ge_drive_files", exist_ok=True)
subprocess.run(["gcloud", "storage", "cp", f"{bucket}/*", "/tmp/ge_drive_files/"], check=False)

for fname, mime in [
    ("Cymbal Q4 Sales Data by City.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ("Cymbal Sales Analysis Report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
]:
    fpath = os.path.join("/tmp/ge_drive_files", fname)
    if os.path.exists(fpath):
        boundary = "===ge_drive_boundary==="
        meta = json.dumps({"name": fname, "mimeType": mime}).encode("utf-8")
        with open(fpath, "rb") as f:
            content = f.read()
        body = (
            f"--{boundary}\\r\\nContent-Type: application/json; charset=UTF-8\\r\\n\\r\\n".encode("utf-8")
            + meta
            + f"\\r\\n--{boundary}\\r\\nContent-Type: {mime}\\r\\n\\r\\n".encode("utf-8")
            + content
            + f"\\r\\n--{boundary}--\\r\\n".encode("utf-8")
        )
        req = urllib.request.Request(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
            data=body,
            method="POST",
        )
        req.add_header("Authorization", f"Bearer {drive_token}")
        req.add_header("Content-Type", f"multipart/related; boundary={boundary}")
        try:
            with urllib.request.urlopen(req) as resp:
                print("Uploaded to Google Drive:", fname, resp.read().decode("utf-8"))
        except Exception as e:
            print("Drive upload note:", fname, e)

base_loc = f"https://discoveryengine.googleapis.com/v1alpha/projects/{project_id}/locations/global"
default_col = f"{base_loc}/collections/default_collection"

# 2. Configure Google Identity Provider (GSUITE) in global aclConfig
api_call("PATCH", f"{base_loc}/aclConfig", {"idpConfig": {"idpType": "GSUITE"}})

# 3. Create People via Custom Connector datastore (cym-inv-custom-datastore) and import NDJSON
custom_ds_id = "cym-inv-custom-datastore"
api_call("POST", f"{default_col}/dataStores?dataStoreId={custom_ds_id}", {
    "displayName": custom_ds_id,
    "industryVertical": "GENERIC",
    "contentConfig": "THIRD_PARTY_IDENTITY_PEOPLE",
    "solutionTypes": ["SOLUTION_TYPE_SEARCH"],
    "aclEnabled": False
})
time.sleep(2)
api_call("POST", f"{default_col}/dataStores/{custom_ds_id}/branches/0/documents:import", {
    "gcsSource": {
        "inputUris": [f"{bucket}/cymbal-people-correct-schema.ndjson"],
        "dataSchema": "document"
    },
    "reconciliationMode": "FULL",
    "autoGenerateIds": False
})

# 4. Create Google Workspace Connectors via setUpDataConnector
connectors = [
    (
        "cym-drive-datastore",
        "google_drive",
        [
            "copy_file", "create_file", "download_file_content", "get_file_metadata",
            "get_file_permissions", "list_recent_files", "list_shared_drives",
            "read_file_content", "search_files", "share_file", "trash_file", "update_file"
        ],
    ),
    (
        "cym-gmail-datastore",
        "google_mail",
        ["send_message"],
    ),
    (
        "cymbal-inv-calendar",
        "google_calendar",
        [
            "create_event", "delete_event", "get_event", "list_calendars",
            "list_events", "respond_to_event", "search_events", "suggest_time", "update_event"
        ],
    ),
]

ds_ids = [custom_ds_id]
cols_resp = api_call("GET", f"{base_loc}/collections")
existing_cols = {c.get("displayName"): c["name"].split("/")[-1] for c in (cols_resp or {}).get("collections", [])}

for disp_name, ds_type, actions in connectors:
    col_id = existing_cols.get(disp_name)
    if not col_id:
        for suffix in ["", "-1", "-2"]:
            cand_id = f"{disp_name}{suffix}"
            res = api_call("POST", f"{base_loc}:setUpDataConnector", {
                "collectionId": cand_id,
                "collectionDisplayName": disp_name,
                "dataConnector": {
                    "dataSource": ds_type,
                    "entities": [{"entityName": ds_type}],
                    "bapConfig": {
                        "supportedConnectorModes": ["ACTIONS"],
                        "enabledActions": actions
                    }
                }
            })
            if "error" not in res:
                col_id = cand_id
                break
        time.sleep(5)
    if col_id:
        ds_ids.append(f"{col_id}_{ds_type}")

# 5. Create Gemini Enterprise App (cym-inv-enterprise) with all 4 data stores connected
app_id = "cym-inv-enterprise"
api_call("POST", f"{default_col}/engines?engineId={app_id}", {
    "displayName": app_id,
    "solutionType": "SOLUTION_TYPE_SEARCH",
    "industryVertical": "GENERIC",
    "appType": "APP_TYPE_INTRANET",
    "dataStoreIds": ds_ids,
    "commonConfig": {"companyName": "Cymbal"},
    "searchEngineConfig": {
        "searchTier": "SEARCH_TIER_ENTERPRISE",
        "searchAddOns": ["SEARCH_ADD_ON_LLM"]
    }
})
print("Task 1 Gemini Enterprise + Workspace Data Stores setup complete! DataStores:", ds_ids)
EOF
python3 /tmp/task1_gemini_enterprise_workspace.py`;
    return {
      script,
      summary:
        'Upload sales files to Google Drive, configure GSUITE IdP, create People custom connector + Drive/Gmail/Calendar Workspace connectors, and deploy cym-inv-enterprise app.',
    };
  }

  // Fast-path 10: Deploy Gemini Enterprise with Workspace Data Sources and Model Armor - Task 2 (Model Armor Templates & Assistant Policy)
  if (
    lower.includes('cym-inv-security-template-input') ||
    lower.includes('cym-inv-security-template-output')
  ) {
    const script = `cat << 'EOF' > /tmp/task2_model_armor.py
import subprocess, json, urllib.request, urllib.error, time

project_id = "${proj}" or subprocess.check_output(["gcloud", "config", "get-value", "project"], text=True).strip()
subprocess.run(["gcloud", "services", "enable", "modelarmor.googleapis.com", "dlp.googleapis.com", f"--project={project_id}", "--quiet"], check=False)
token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()

def api_call(method, url, body=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Goog-User-Project", project_id)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        err_text = e.read().decode("utf-8")
        print(f"HTTP {e.code} on {method} {url}: {err_text[:400]}")
        return {"error": e.code, "details": err_text}

ma_base = f"https://modelarmor.us.rep.googleapis.com/v1/projects/{project_id}/locations/us"
template_body = {
    "filterConfig": {
        "raiSettings": {
            "raiFilters": [
                {"filterType": "HATE_SPEECH", "confidenceLevel": "MEDIUM_AND_ABOVE"},
                {"filterType": "DANGEROUS", "confidenceLevel": "LOW_AND_ABOVE"},
                {"filterType": "HARASSMENT", "confidenceLevel": "MEDIUM_AND_ABOVE"},
                {"filterType": "SEXUALLY_EXPLICIT", "confidenceLevel": "HIGH"}
            ]
        },
        "sdpSettings": {
            "basicConfig": {"filterEnforcement": "ENABLED"}
        },
        "piAndJailbreakFilterSettings": {
            "filterEnforcement": "ENABLED",
            "confidenceLevel": "LOW_AND_ABOVE"
        },
        "maliciousUriFilterSettings": {
            "filterEnforcement": "ENABLED"
        }
    },
    "templateMetadata": {
        "MultiLanguageDetection": {"enableMultiLanguageDetection": True},
        "logSanitizeOperations": True,
        "ignorePartialInvocationFailures": True
    }
}

for tid in ["cym-inv-security-template-input", "cym-inv-security-template-output"]:
    res = api_call("POST", f"{ma_base}/templates?templateId={tid}", template_body)
    if res.get("error") == 409:
        api_call("PATCH", f"{ma_base}/templates/{tid}?updateMask=filterConfig,templateMetadata", template_body)

asst_url = f"https://discoveryengine.googleapis.com/v1alpha/projects/{project_id}/locations/global/collections/default_collection/engines/cym-inv-enterprise/assistants/default_assistant?updateMask=customerPolicy"
api_call("PATCH", asst_url, {
    "customerPolicy": {
        "modelArmorConfig": {
            "userPromptTemplate": f"projects/{project_id}/locations/us/templates/cym-inv-security-template-input",
            "responseTemplate": f"projects/{project_id}/locations/us/templates/cym-inv-security-template-output",
            "failureMode": "FAIL_OPEN"
        }
    }
})
print("Task 2 Model Armor templates created and linked to cym-inv-enterprise default_assistant!")
EOF
python3 /tmp/task2_model_armor.py`;
    return {
      script,
      summary:
        'Enable Model Armor and DLP APIs, create input/output Model Armor templates in us region, and attach them to cym-inv-enterprise default_assistant.',
    };
  }

  // Fast-path 11: Deploy Gemini Enterprise with Workspace Data Sources and Model Armor - Task 3 (Configure Gemini Enterprise App Features, Grounding & Logo)
  if (
    lower.includes('cym-inv-enterprise') &&
    (lower.includes('enterprise web search') ||
      lower.includes('enable image and video generation') ||
      lower.includes('app logo url'))
  ) {
    const logoMatch = combinedText.match(/https:\/\/cdn\.qwiklabs\.com\/[^\s)"']+/);
    const logoUrl =
      logoMatch?.[0] ||
      'https://cdn.qwiklabs.com/7HNsRbL5DC5fTizZUhMXIP9PpTe%2F03j3kzaLp2KOqmI%3D';
    const script = `cat << 'EOF' > /tmp/task3_configure_ge_app.py
import subprocess, json, urllib.request, urllib.error

project_id = "${proj}" or subprocess.check_output(["gcloud", "config", "get-value", "project"], text=True).strip()
token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()

def api_call(method, url, body=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Goog-User-Project", project_id)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        err_text = e.read().decode("utf-8")
        print(f"HTTP {e.code} on {method} {url}: {err_text[:400]}")
        return {"error": e.code, "details": err_text}

eng_base = f"https://discoveryengine.googleapis.com/v1alpha/projects/{project_id}/locations/global/collections/default_collection/engines/cym-inv-enterprise"

# 1. Enable Model Selector, Image/Video Generation, and Gemini 3.1 Pro / Nano Banana
api_call("PATCH", f"{eng_base}?updateMask=features,modelConfigs", {
    "features": {
        "model-selector": "FEATURE_STATE_ON",
        "people-search": "FEATURE_STATE_ON",
        "people-search-org-chart": "FEATURE_STATE_ON",
        "Agent-sharing-without-admin-approval": "FEATURE_STATE_ON",
        "disable-agent-sharing": "FEATURE_STATE_OFF",
        "agent-gallery": "FEATURE_STATE_ON",
        "prompt-gallery": "FEATURE_STATE_ON",
        "notebook-lm": "FEATURE_STATE_ON",
        "no-code-agent-builder": "FEATURE_STATE_ON",
        "disable-image-generation": "FEATURE_STATE_OFF",
        "disable-video-generation": "FEATURE_STATE_OFF",
        "disable-talk-to-content": "FEATURE_STATE_OFF",
        "gemini-in-workspace-contextual": "FEATURE_STATE_ON",
        "Search-results-page": "FEATURE_STATE_ON"
    },
    "modelConfigs": {
        "gemini-3.1-pro": "MODEL_ENABLED",
        "gemini-3.1-flash-image": "MODEL_ENABLED"
    }
})

# 2. Enable Enterprise Web Search grounding on default_assistant
api_call("PATCH", f"{eng_base}/assistants/default_assistant?updateMask=webGroundingType", {
    "webGroundingType": "WEB_GROUNDING_TYPE_ENTERPRISE_WEB_SEARCH"
})

# 3. Set UI Branding App Logo URL on default_search_widget_config
api_call("PATCH", f"{eng_base}/widgetConfigs/default_search_widget_config?updateMask=uiBranding", {
    "uiBranding": {
        "logo": {
            "url": "${logoUrl}"
        }
    }
})
print("Task 3 Gemini Enterprise App features, grounding, and branding configured!")
EOF
python3 /tmp/task3_configure_ge_app.py`;
    return {
      script,
      summary:
        'Enable Gemini Enterprise model selector, image/video generation, Enterprise Web Search grounding, and custom logo URL on cym-inv-enterprise.',
    };
  }

  // Universal Gemini Task Command Synthesis for any lab task (combining prose, code edits, CLI commands, and GCP resource creation in a single stateful script)
  const prompt = `You are an expert Google Cloud Skills Boost (Qwiklabs) autonomous lab completion engineer.
Synthesize a single, idempotent, stateful, non-interactive bash script (to be executed inside the student's Google Cloud Shell VM) that completes ALL requirements of Task #${task.number} ("${task.title}") so that Qwiklabs' "Check my progress" grader passes 100%.

### LAB CONTEXT
- Lab Title: ${labTitle}
- GCP Project ID: ${proj}
- Region: ${region}
- Zone: ${credentials.zone || 'us-central1-a'}
- Student Username: ${credentials.username}
- Extra Variables: ${JSON.stringify(credentials.extraVars || {})}
${allTasksSummary ? `\n### ALL LAB TASKS OVERVIEW (FOR CONTEXT ON DIRECTORY & ENVIRONMENT SETUP)\n${allTasksSummary}\n` : ''}
${workspaceSnapshot ? `\n### LIVE STUDENT CLOUD SHELL WORKSPACE SNAPSHOT (CURRENT FILES, STARTER CODE & CLI HELP)\n${workspaceSnapshot.slice(0, 48000)}\n` : ''}
${previousErrorMessage ? `\n### PREVIOUS "CHECK MY PROGRESS" GRADER FEEDBACK TO FIX (HIGHEST PRIORITY)\n"${previousErrorMessage}"\n` : ''}
${previousScriptOutput ? `\n### PREVIOUS SCRIPT STDOUT / STDERR\n${previousScriptOutput.slice(-6000)}\n` : ''}

### CURRENT TASK TO COMPLETE (EXECUTE ALL STEPS IN ORDER)
Task #${task.number}: ${task.title}
Full Task Instructions, Prose Requirements, Rubrics & Commands:
${combinedText}

### CRITICAL RULES FOR THE SYNTHESIZED BASH SCRIPT
1. **Stateful Single-Session Execution**: Each SSH invocation starts in \`$HOME\` (\`~\`). Always \`export PATH="$HOME/.local/bin:$PATH"\`, \`cd\` into the lab's working directory (see LIVE STUDENT CLOUD SHELL WORKSPACE SNAPSHOT or earlier tasks), and activate any Python virtual environment (\`if [ -f .venv/bin/activate ]; then source .venv/bin/activate; fi\`).
2. **Complete Both Prose Edits AND Explicit Commands in Order**: Many Challenge Labs describe file edits (e.g., adding a JSON rubric to \`eval_config.json\`, implementing \`TODO\` functions in \`agent.py\`, updating agent \`tools\` and \`instruction\`, running \`adk eval_set create\` / \`adk eval_set add_eval_case\`) in prose BEFORE the final verification/upload commands. You MUST perform all prose file edits and CLI commands BEFORE running the evaluation/deployment/upload commands.
3. **Use Exact File Contents & CLI Flags from Workspace Snapshot**: Inspect the starter files and CLI \`--help\` output in \`LIVE STUDENT CLOUD SHELL WORKSPACE SNAPSHOT\` above. Preserve all existing helper functions and imports when updating files (use \`cat << 'EOF' > ...\` or \`python3 -c '...'\` to write/modify files cleanly). Never guess CLI flag names when \`--help\` output is shown above.
4. **100% Non-Interactive**: Never launch interactive editors (\`nano\`, \`vim\`) or blocking foreground servers (\`adk web\`, \`chainlit run\`, \`npm start\`, \`adk run\`). Always pass non-interactive flags (\`--quiet\`, \`-auto-approve\`, \`-y\`).
5. **GCP Console UI Equivalence**: If the task asks to create or update GCP resources via the Console UI, create/configure them programmatically using \`gcloud\`, \`bq\`, \`terraform\`, or Python SDK/REST API calls.
6. **Cloud Shell Terraform Stub Trap**: In Google Cloud Shell, \`/usr/local/bin/terraform\` is a stub script that only prints installation instructions. When installing or running \`terraform\`, check \`dpkg -s terraform &>/dev/null\`, remove \`/usr/local/bin/terraform\` (\`sudo rm -f /usr/local/bin/terraform\`), and invoke \`/usr/bin/terraform\`.
7. **Antigravity (\`agy\`)**: If any step launches \`agy\` or \`antigravity\`, always use \`agy --dangerously-skip-permissions || agy\`.
8. **Google Drive Uploads in Cloud Shell**: When a task requires uploading files to the student's Google Drive, use \`os.environ.get("DRIVE_ACCESS_TOKEN")\` (which is pre-exported into the Cloud Shell session with Drive scope) to POST multipart uploads to \`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart\`.
9. **Gemini Enterprise & Discovery Engine (\`discoveryengine.googleapis.com/v1alpha\`)**:
   - **Identity Provider**: \`PATCH .../locations/global/aclConfig\` with \`{"idpConfig": {"idpType": "GSUITE"}}\`.
   - **People via Custom Connector**: \`POST .../collections/default_collection/dataStores?dataStoreId=<id>\` with \`{"displayName": "<id>", "industryVertical": "GENERIC", "contentConfig": "THIRD_PARTY_IDENTITY_PEOPLE", "solutionTypes": ["SOLUTION_TYPE_SEARCH"], "aclEnabled": False}\`, then import NDJSON via \`POST .../dataStores/<id>/branches/0/documents:import\` with \`{"gcsSource": {"inputUris": ["gs://..."], "dataSchema": "document"}, "reconciliationMode": "FULL", "autoGenerateIds": False}\`.
   - **Google Workspace Connectors (\`google_drive\`, \`google_mail\`, \`google_calendar\`)**: \`POST .../locations/global:setUpDataConnector\` with \`{"collectionId": "<name>-1", "collectionDisplayName": "<name>", "dataConnector": {"dataSource": "<type>", "entities": [{"entityName": "<type>"}], "bapConfig": {"supportedConnectorModes": ["ACTIONS"], "enabledActions": [...]}}}\`. NEVER set \`actionConfig: {"createBapConnection": True}\` or \`connectorModes\` on first-party Workspace connectors (causes 500 INTERNAL).
     - \`google_drive\` actions: \`["copy_file", "create_file", "download_file_content", "get_file_metadata", "get_file_permissions", "list_recent_files", "list_shared_drives", "read_file_content", "search_files", "share_file", "trash_file", "update_file"]\`
     - \`google_mail\` actions: \`["send_message"]\` (or \`["create_draft", "reply_all_message", "reply_message", "search_messages", "send_draft", "send_message"]\`)
     - \`google_calendar\` actions: \`["create_event", "delete_event", "get_event", "list_calendars", "list_events", "respond_to_event", "search_events", "suggest_time", "update_event"]\`
   - **Gemini Enterprise App (\`engines\`)**: \`POST .../collections/default_collection/engines?engineId=<app_id>\` with \`solutionType: "SOLUTION_TYPE_SEARCH"\`, \`industryVertical: "GENERIC"\`, \`appType: "APP_TYPE_INTRANET"\`, \`dataStoreIds: [...]\`, \`commonConfig: {"companyName": "Cymbal"}\`, \`searchEngineConfig: {"searchTier": "SEARCH_TIER_ENTERPRISE", "searchAddOns": ["SEARCH_ADD_ON_LLM"]}\`.
   - **App Features, Grounding & Logo**:
     - Features/Models: \`PATCH .../engines/<app_id>?updateMask=features,modelConfigs\` (\`model-selector: "FEATURE_STATE_ON"\`, \`disable-image-generation: "FEATURE_STATE_OFF"\`, \`disable-video-generation: "FEATURE_STATE_OFF"\`, \`modelConfigs: {"gemini-3.1-pro": "MODEL_ENABLED", "gemini-3.1-flash-image": "MODEL_ENABLED"}\`).
     - Enterprise Web Search: \`PATCH .../engines/<app_id>/assistants/default_assistant?updateMask=webGroundingType\` with \`{"webGroundingType": "WEB_GROUNDING_TYPE_ENTERPRISE_WEB_SEARCH"}\`.
     - Logo URL: \`PATCH .../engines/<app_id>/widgetConfigs/default_search_widget_config?updateMask=uiBranding\` with \`{"uiBranding": {"logo": {"url": "<logo_url>"}}}\`.
10. **Model Armor (\`modelarmor.<loc>.rep.googleapis.com/v1\`)**:
    - Enable \`modelarmor.googleapis.com\` and \`dlp.googleapis.com\` first.
    - Use regional endpoint \`https://modelarmor.<loc>.rep.googleapis.com/v1/projects/<project>/locations/<loc>/templates?templateId=<id>\` (e.g. \`us\`).
    - Attach templates to Gemini Enterprise Assistant via \`PATCH .../engines/<app_id>/assistants/default_assistant?updateMask=customerPolicy\` with \`customerPolicy.modelArmorConfig\` (\`userPromptTemplate\`, \`responseTemplate\`, \`failureMode: "FAIL_OPEN"\`).`;

  try {
    const ai = getGenAIClient();
    const model = await resolveLatestGeminiModel();
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            script: {
              type: Type.STRING,
              description: 'Complete non-interactive bash script to execute in Cloud Shell.',
            },
            summary: {
              type: Type.STRING,
              description: 'One-sentence summary of what the synthesized script does.',
            },
          },
          required: ['script', 'summary'],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    if (parsed.script && typeof parsed.script === 'string' && parsed.script.trim()) {
      return {
        script: transformAgyLaunchCommand(
          interpolateLabVariables(parsed.script.trim(), credentials)
        ),
        summary: parsed.summary || `Synthesized Cloud Shell automation for Task #${task.number}`,
      };
    }
  } catch (err) {
    // Fallback: if local host ADC is expired, use the active Qwiklabs student's gcloud token & project Vertex AI endpoint
    if (credentials.username && proj) {
      try {
        const safeUser = credentials.username.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const configDir = path.join(os.homedir(), '.cloud-skills-lab-runner', `gcloud-${safeUser}`);
        if (fs.existsSync(configDir)) {
          const { stdout: tokenOut } = await execFileAsync(
            'gcloud',
            ['auth', 'print-access-token', '--quiet'],
            { env: { ...process.env, CLOUDSDK_CONFIG: configDir }, timeout: 8000 }
          );
          const token = tokenOut.trim();
          if (token) {
            const model = await resolveLatestGeminiModel();
            const vUrl = `https://aiplatform.googleapis.com/v1/projects/${proj}/locations/global/publishers/google/models/${model}:generateContent`;
            const vResp = await fetch(vUrl, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                  responseMimeType: 'application/json',
                  temperature: 0.1,
                },
              }),
            });
            if (vResp.ok) {
              const vData: any = await vResp.json();
              const text = vData?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
              const parsed = JSON.parse(text);
              if (parsed.script && typeof parsed.script === 'string' && parsed.script.trim()) {
                return {
                  script: transformAgyLaunchCommand(
                    interpolateLabVariables(parsed.script.trim(), credentials)
                  ),
                  summary:
                    parsed.summary || `Synthesized Cloud Shell automation for Task #${task.number}`,
                };
              }
            }
          }
        }
      } catch (fallbackErr) {
        console.warn('Student Vertex AI fallback error:', fallbackErr);
      }
    }
    console.warn('synthesizeTaskShellScript error:', err);
  }

  return null;
}

