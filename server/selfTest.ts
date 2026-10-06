import { chromium } from 'playwright';
import { parseLabPageDom } from './labParser.js';
import {
  formatAutonomousAntigravityPrompt,
  getModelGardenEntries,
  interpolateLabVariables,
  resolveLatestGeminiModel,
  synthesizeTaskShellScript,
  transformAgyLaunchCommand,
} from './geminiClient.js';
import {
  autoAcceptAntigravityPrompts,
  inspectInteractiveElements,
  sendPromptToAntigravity,
} from './pageInspector.js';

async function runVerificationTests() {
  console.log('🧪 Running Skills Runner Verification Suite...');

  const latestModel = await resolveLatestGeminiModel();
  console.log(`✓ Resolved latest available Gemini model: ${latestModel}`);
  if (!latestModel.startsWith('gemini-') && !latestModel.startsWith('claude-')) {
    throw new Error(`Expected latest model to start with gemini- or claude-, got: ${latestModel}`);
  }

  const gardenEntries = getModelGardenEntries();
  const gardenIds = gardenEntries.map((m) => m.id);
  if (
    !gardenIds.includes('gemini-3.8-flash') ||
    !gardenIds.includes('gemini-3.1-pro-preview') ||
    !gardenIds.includes('claude-opus-5-5')
  ) {
    throw new Error(`Unexpected Model Garden entries: ${JSON.stringify(gardenIds)}`);
  }
  console.log(`✓ Model Garden entries verified: ${gardenIds.join(', ')}`);

  // 0. Unit-test `transformAgyLaunchCommand` (--dangerously-skip-permissions + fallback + preserve Python indentation)
  const multilinePythonHeredoc = [
    "python3 - << 'EOF'",
    'import wb_helper',
    'if True:',
    '    wb_helper.update_and_run_notebook(',
    '        path="evaluation.ipynb",',
    '        cell_patches={},',
    '        run_through_cell=18,',
    '    )',
    'EOF',
  ].join('\n');

  const cases: Array<[string, string]> = [
    ['agy', 'agy --dangerously-skip-permissions || agy'],
    ['agy .', 'agy --dangerously-skip-permissions . || agy .'],
    [
      'cd my-app && agy .',
      'cd my-app && (agy --dangerously-skip-permissions . || agy .)',
    ],
    [
      'antigravity --workspace /home/student',
      'antigravity --dangerously-skip-permissions --workspace /home/student || antigravity --workspace /home/student',
    ],
    [
      'gcloud services enable aiplatform.googleapis.com',
      'gcloud services enable aiplatform.googleapis.com',
    ],
    [multilinePythonHeredoc, multilinePythonHeredoc],
  ];

  for (const [input, expected] of cases) {
    const actual = transformAgyLaunchCommand(input);
    if (actual !== expected) {
      throw new Error(
        `transformAgyLaunchCommand("${input}") expected "${expected}", got "${actual}"`
      );
    }
  }
  console.log(
    '✓ transformAgyLaunchCommand verified (--dangerously-skip-permissions with fallback & Python indentation preserved)'
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // 1. Test Shadow-DOM Qwiklabs Parser on a realistic mock lab DOM (including agy launch steps)
  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <head><title>Build an AI Agent with Antigravity on Google Cloud</title></head>
      <body>
        <h1 class="lab-preamble__title">Build an AI Agent with Antigravity on Google Cloud</h1>
        <div class="js-timer">01:14:52</div>
        <button>End Lab</button>

        <div class="control-panel">
          <input label="Username" value="student-04-8f92a1b3c4d5@qwiklabs.net" />
          <input label="Password" value="kP9#mQ2$vL5" />
          <input label="GCP Project ID" value="qwiklabs-gcp-04-a1b2c3d4e5" />
          <a href="https://console.cloud.google.com/?project=qwiklabs-gcp-04-a1b2c3d4e5">Open Google Console</a>
        </div>

        <div class="js-lab-content-body">
          <h2>Overview</h2>
          <p>In this lab you will configure Vertex AI and use Antigravity in the Cloud Console.</p>
          <p>Set your default region to us-central1 and zone to us-central1-a.</p>

          <h2>Task 1. Enable APIs and Launch Antigravity</h2>
          <ol>
            <li>
              Activate Cloud Shell and enable the Vertex AI API:
              <pre>gcloud services enable aiplatform.googleapis.com --project=[PROJECT_ID]</pre>
            </li>
            <li>
              In the Cloud Shell terminal, launch Antigravity in the project directory:
              <pre>agy .</pre>
            </li>
            <li>
              Open the <a href="https://console.cloud.google.com/vertex-ai?project=[PROJECT_ID]">Vertex AI Console</a> in your incognito window.
            </li>
          </ol>
          <button>Check my progress</button>

          <h2>Task 2. Build the Service with Antigravity in the Cloud Console</h2>
          <ol>
            <li>
              In the Antigravity panel in the Cloud Console, enter the following prompt to scaffold the Cloud Run service:
              <pre>Create a FastAPI service in main.py that queries Gemini 3.5 Flash in project [PROJECT_ID] and region [REGION].</pre>
            </li>
          </ol>
          <button>Check my progress</button>
        </div>

        <!-- Simulated Antigravity IDE Chat Input & Permission Confirmation Button -->
        <div id="antigravity-panel" style="margin-top: 20px;">
          <textarea
            id="antigravity-chat-box"
            placeholder="Ask Antigravity to build or debug..."
            style="width: 400px; height: 80px;"
          ></textarea>
          <button
            id="agy-accept-btn"
            onclick="window.__agyAccepted = true; this.style.display = 'none';"
          >
            Accept All
          </button>
        </div>
      </body>
    </html>
  `);

  const parsed = await parseLabPageDom(page);

  console.log('✓ Lab Title:', parsed.labTitle);
  console.log('✓ Extracted Credentials:', parsed.credentials);
  console.log('✓ Extracted Tasks:', parsed.tasks.length);

  if (parsed.credentials.username !== 'student-04-8f92a1b3c4d5@qwiklabs.net') {
    throw new Error(`Unexpected username: ${parsed.credentials.username}`);
  }
  if (parsed.credentials.projectId !== 'qwiklabs-gcp-04-a1b2c3d4e5') {
    throw new Error(`Unexpected projectId: ${parsed.credentials.projectId}`);
  }
  if (parsed.credentials.region !== 'us-central1') {
    throw new Error(`Unexpected region: ${parsed.credentials.region}`);
  }
  if (parsed.tasks.length !== 2) {
    throw new Error(`Expected 2 actionable tasks, got ${parsed.tasks.length}`);
  }

  // 2. Verify variable interpolation & agy launch transformation in parsed tasks
  const rawCmd = parsed.tasks[0].steps[0].commands[0];
  const interpolatedCmd = interpolateLabVariables(rawCmd, parsed.credentials);
  console.log('✓ Interpolated Command:', interpolatedCmd);
  if (
    interpolatedCmd !==
    'gcloud services enable aiplatform.googleapis.com --project=qwiklabs-gcp-04-a1b2c3d4e5'
  ) {
    throw new Error(`Variable interpolation failed: ${interpolatedCmd}`);
  }

  const agyLaunchStep = parsed.tasks[0].steps[1];
  console.log('✓ Parsed Agy Launch Step Command:', agyLaunchStep.commands[0]);
  if (agyLaunchStep.commands[0] !== 'agy --dangerously-skip-permissions . || agy .') {
    throw new Error(
      `Expected agy launch step to be wrapped with fallback, got: ${agyLaunchStep.commands[0]}`
    );
  }
  if (agyLaunchStep.targetSurface !== 'cloud_shell') {
    throw new Error(
      `Expected agy CLI launch step surface 'cloud_shell', got '${agyLaunchStep.targetSurface}'`
    );
  }

  // 3. Verify surface classification for Antigravity prompt step
  const antigravityStep = parsed.tasks[1].steps[0];
  console.log('✓ Task 2 Step 1 Surface:', antigravityStep.targetSurface);
  if (antigravityStep.targetSurface !== 'antigravity') {
    throw new Error(`Expected surface 'antigravity', got '${antigravityStep.targetSurface}'`);
  }

  // 4. Verify Set-of-Marks (SoM) Interactive Element Inspector
  const elements = await inspectInteractiveElements(page);
  console.log(`✓ Set-of-Marks Inspector found ${elements.length} interactive elements.`);
  if (elements.length < 4) {
    throw new Error('Expected at least 4 interactive elements on test page.');
  }

  // 5. Verify Zero-Touch Antigravity Prompt Dispatcher & Auto-Approval of Permission Buttons
  const promptText = interpolateLabVariables(
    antigravityStep.commands[0],
    parsed.credentials
  );
  await sendPromptToAntigravity(page, promptText, (msg) =>
    console.log('  [Antigravity Log]', msg)
  );
  const chatVal = await page.locator('#antigravity-chat-box').inputValue();
  console.log('✓ Antigravity Chat Box Value:', chatVal.replace(/\n+/g, ' '));
  if (
    !chatVal.includes('qwiklabs-gcp-04-a1b2c3d4e5') ||
    !chatVal.includes('us-central1') ||
    !chatVal.includes('[Autonomous Execution Mode')
  ) {
    throw new Error(`Zero-touch Antigravity prompt injection failed: ${chatVal}`);
  }

  const agyAccepted = await page.evaluate(() => Boolean((window as any).__agyAccepted));
  console.log('✓ Auto-Approved Antigravity Confirmation Button:', agyAccepted);
  if (!agyAccepted) {
    throw new Error('Expected autoAcceptAntigravityPrompts to click "Accept All" button.');
  }

  // 6. Verify modern partner.skills.google <ql-lab-header> + Declarative Shadow DOM parsing
  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <body>
        <ql-lab-header
          labtitle="Accelerate Development with Antigravity: Challenge Lab"
          labcontrolbutton='{"disabled":false,"pending":false,"running":true}'
          labtimer='{"ticking":true,"secondsRemaining":5400,"totalDurationSeconds":5510}'
          labdetails='[{"property":"console_url","href":"https://partner.skills.google/google_sso?relay=https%3A%2F%2Fconsole.cloud.google.com"},{"property":"username","value":"student-03-e308b0eed25e@qwiklabs.net"},{"property":"password","value":"lsYV1hgQ61Nz"},{"property":"project_id","value":"qwiklabs-gcp-02-44b374896675"}]'
        ></ql-lab-header>
        <div class="js-lab-content-body">
          <h2>Task 1. Configure MCP Server</h2>
          <ol>
            <li>
              Launch the Antigravity CLI:
              <ql-code-block language="bash" templated="">
                <template shadowrootmode="open"><pre class="bash">agy --dangerously-skip-permissions</pre></template>
                agy --dangerously-skip-permissions
              </ql-code-block>
            </li>
            <li>
              Prompt the agent to create the Python MCP server:
              <ql-code-block language="plaintext" templated="">
                <template shadowrootmode="open"><pre class="plaintext">Create a Python script using python3 and Upload to gs://qwiklabs-gcp-02-44b374896675-grading/</pre></template>
                Create a Python script using python3 and Upload to gs://{{{project_0.project_id}}}-grading/
              </ql-code-block>
            </li>
          </ol>
        </div>
      </body>
    </html>
  `);

  const modernParsed = await parseLabPageDom(page);
  console.log('✓ Modern <ql-lab-header> Title:', modernParsed.labTitle);
  console.log('✓ Modern <ql-lab-header> Credentials:', modernParsed.credentials);
  if (
    modernParsed.credentials.username !== 'student-03-e308b0eed25e@qwiklabs.net' ||
    modernParsed.credentials.projectId !== 'qwiklabs-gcp-02-44b374896675' ||
    !modernParsed.isLabStarted ||
    modernParsed.needsLogin
  ) {
    throw new Error('Failed to parse <ql-lab-header> attributes properly.');
  }
  if (
    modernParsed.tasks[0].steps[0].commands[0] !==
      'agy --dangerously-skip-permissions || agy' ||
    modernParsed.tasks[0].steps[0].targetSurface !== 'cloud_shell'
  ) {
    throw new Error(
      `Unexpected step 1 in modern parser: ${JSON.stringify(modernParsed.tasks[0].steps[0])}`
    );
  }
  if (
    !modernParsed.tasks[0].steps[1].commands[0].includes('qwiklabs-gcp-02-44b374896675-grading') ||
    modernParsed.tasks[0].steps[1].targetSurface !== 'antigravity'
  ) {
    throw new Error(
      `Expected interpolated shadow <pre> and 'antigravity' surface for step 2, got: ${JSON.stringify(modernParsed.tasks[0].steps[1])}`
    );
  }

  // 7. Verify {{{ var | default }}} template interpolation and task-level script synthesis
  const pipedTemplate =
    'gcloud storage cp -r gs://{{{ project_0.project_id | "your-gcp-project-id" }}}-bucket/adk_eval_challenge_lab ~/';
  const interpolatedPiped = interpolateLabVariables(pipedTemplate, modernParsed.credentials);
  if (
    interpolatedPiped !==
    'gcloud storage cp -r gs://qwiklabs-gcp-02-44b374896675-bucket/adk_eval_challenge_lab ~/'
  ) {
    throw new Error(`Piped template interpolation failed: ${interpolatedPiped}`);
  }

  const synthTask2 = await synthesizeTaskShellScript({
    labTitle: 'Evaluate and Improve Agent Development Kit Agents: Challenge Lab',
    task: {
      number: 2,
      title: 'Task 2. Build and run the eval set',
      hasCheckProgress: true,
      checkProgressStepNumber: 1,
      rawSectionText:
        'Add valid_transitions rubric to eval_config.json and run adk eval bigquery_agent ledger | tee eval_results.txt',
      steps: [],
    },
    credentials: modernParsed.credentials,
  });
  if (
    !synthTask2?.script.includes('eval_results.txt') ||
    synthTask2.script.includes('improved_eval_results.txt')
  ) {
    throw new Error('Task 2 synthesis did not produce expected Task 2 eval script.');
  }

  const synthTask3 = await synthesizeTaskShellScript({
    labTitle: 'Evaluate and Improve Agent Development Kit Agents: Challenge Lab',
    task: {
      number: 3,
      title: 'Task 3. Improve the agent to fix evaluation issues',
      hasCheckProgress: true,
      checkProgressStepNumber: 2,
      rawSectionText:
        'Implement perform_consistent_transaction and check_transaction to fix valid_transitions in eval_config.json and tee improved_eval_results.txt',
      steps: [],
    },
    credentials: modernParsed.credentials,
  });
  if (
    !synthTask3?.script.includes('improved_eval_results.txt') ||
    !synthTask3.script.includes('def perform_consistent_transaction')
  ) {
    throw new Error('Task 3 synthesis did not produce expected Task 3 agent improvement script.');
  }
  // 8. Verify Add Agents to Gemini Enterprise: Challenge Lab (GENAI149) fast-paths
  const genai149Task2 = await synthesizeTaskShellScript({
    labTitle: 'Add Agents to Gemini Enterprise: Challenge Lab',
    task: {
      number: 2,
      title: 'Task 2. Create a No-Code ADK Agent and Deploy it to Agent Runtime',
      hasCheckProgress: true,
      checkProgressStepNumber: 1,
      rawSectionText:
        'Create a template folder for an agent named brand_voice and run adk deploy agent_engine --display_name "Cymbal Pools Brand Voice"',
      steps: [],
    },
    credentials: modernParsed.credentials,
  });
  if (
    !genai149Task2?.script.includes('Cymbal Pools Brand Voice') ||
    !genai149Task2.script.includes('root_agent.yaml')
  ) {
    throw new Error('GENAI149 Task 2 synthesis failed.');
  }

  const genai149Task5 = await synthesizeTaskShellScript({
    labTitle: 'Add Agents to Gemini Enterprise: Challenge Lab',
    task: {
      number: 5,
      title: 'Task 5. Add a No-Code Agent with Agent Designer',
      hasCheckProgress: true,
      checkProgressStepNumber: 4,
      rawSectionText:
        'Create Pool Robot Innovations agent with Agent Designer in cymbal-pools-ge',
      steps: [],
    },
    credentials: modernParsed.credentials,
  });
  if (
    !genai149Task5?.script.includes('lowCodeAgentDefinition') ||
    !genai149Task5.script.includes('Pool Robot Innovations')
  ) {
    throw new Error('GENAI149 Task 5 synthesis failed.');
  }

  const genai149Task6 = await synthesizeTaskShellScript({
    labTitle: 'Add Agents to Gemini Enterprise: Challenge Lab',
    task: {
      number: 6,
      title: 'Task 6. Add the ADK Agent Deployed to Agent Runtime to Gemini Enterprise',
      hasCheckProgress: true,
      checkProgressStepNumber: 5,
      rawSectionText:
        'Run construct_auth_uri.py, create Brand Voice Auth authorization, and register Brand Voice Agent',
      steps: [],
    },
    credentials: modernParsed.credentials,
  });
  if (
    !genai149Task6?.script.includes('adkAgentDefinition') ||
    !genai149Task6.script.includes('brand-voice-auth')
  ) {
    throw new Error('GENAI149 Task 6 synthesis failed.');
  }
  console.log('✓ Task-level script synthesis & piped variable interpolation verified.');

  // 9. Verify macBridgeAgent.ts is valid pure ESM JavaScript (node --check) and exposes standalone RPC methods
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const cpMod = await import('node:child_process');
  const utilMod = await import('node:util');
  const execFileAsync = utilMod.promisify(cpMod.execFile);
  const agentPath = pathMod.resolve(process.cwd(), 'server', 'macBridgeAgent.ts');
  const agentCode = fsMod.readFileSync(agentPath, 'utf8');
  if (
    !agentCode.includes("method === 'spawn_incognito_session'") ||
    !agentCode.includes("method === 'ensure_gcloud_auth'")
  ) {
    throw new Error(
      'macBridgeAgent.ts is missing spawn_incognito_session or ensure_gcloud_auth RPC handlers.'
    );
  }
  const tmpMjs = pathMod.join('/tmp', `macBridgeAgent-check-${Date.now()}.mjs`);
  fsMod.writeFileSync(tmpMjs, agentCode, 'utf8');
  try {
    await execFileAsync(process.execPath, ['--check', tmpMjs]);
  } finally {
    try {
      fsMod.unlinkSync(tmpMjs);
    } catch {}
  }
  console.log(
    '✓ macBridgeAgent.ts pure-ESM syntax & standalone Incognito/OAuth RPC handlers verified.'
  );

  // 10. Verify primary_project.* template interpolation and Challenge lab overview filtering
  const primaryInterpolated = interpolateLabVariables(
    'PROJECT_ID={{{ primary_project.project_id | "your-gcp-project-id" }}} MODEL={{{ primary_project.startup_script.gemini_flash_model_id | "gemini-model-id" }}}',
    modernParsed.credentials
  );
  if (
    primaryInterpolated !==
    'PROJECT_ID=qwiklabs-gcp-02-44b374896675 MODEL=gemini-3.5-flash'
  ) {
    throw new Error(`primary_project interpolation failed: ${primaryInterpolated}`);
  }

  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <body>
        <div class="js-lab-content-body">
          <h2>Challenge lab overview</h2>
          <p>Scenario description with no tasks.</p>
          <h2>Task 1. Evaluate model responses</h2>
          <ol><li>Run the evaluation in evaluation.ipynb</li></ol>
          <ql-activity-tracking step="1">Check my progress</ql-activity-tracking>
        </div>
      </body>
    </html>
  `);
  const overviewFiltered = await parseLabPageDom(page);
  if (
    overviewFiltered.tasks.length !== 1 ||
    !overviewFiltered.tasks[0].title.includes('Task 1')
  ) {
    throw new Error(
      `Expected 'Challenge lab overview' to be skipped, got tasks: ${JSON.stringify(
        overviewFiltered.tasks.map((t) => t.title)
      )}`
    );
  }
  console.log('✓ Challenge lab overview filtering & primary_project.* interpolation verified.');

  // 11. Verify WB_HELPER_PY_B64 in nativeChromeBridge.ts compiles cleanly in Python and auto-repairs notebook TODO cells, numpy<2, and ComplexWarning
  const { WB_HELPER_PY_B64 } = await import('./nativeChromeBridge.js');
  const decodedWbPy = Buffer.from(WB_HELPER_PY_B64, 'base64').toString('utf8');
  const tmpWbPy = pathMod.join('/tmp', `wb_helper_test_${Date.now()}.py`);
  fsMod.writeFileSync(tmpWbPy, decodedWbPy, 'utf8');
  try {
    await execFileAsync('python3', [
      '-c',
      `import ast, sys; sys.path.insert(0, '/tmp'); mod_name = '${pathMod.basename(tmpWbPy, '.py')}'; wb = __import__(mod_name); assert hasattr(wb, '_delegate_to_vm') and hasattr(wb, '_run_cells_via_kernel_manager'); pip_fixed = wb._auto_repair_cell_source(3, '%pip install --upgrade --user --quiet google-cloud-aiplatform[evaluation]\\n', []); assert 'scikit-learn>=1.5' in pip_fixed and 'numpy<2' not in pip_fixed, pip_fixed; imp_fixed = wb._auto_repair_cell_source(7, 'from vertexai.evaluation import EvalTask\\n', []); assert 'ComplexWarning' in imp_fixed and 'np.int_' in imp_fixed, imp_fixed; ast.parse(imp_fixed); cells = [{'cell_type': 'code', 'source': 'rouge_eval_task = EvalTask(\\n    #[ TODO - Insert your code ]\\n    dataset=\\n    metrics=\\n)\\nrouge_result = rouge_eval_task.evaluate(\\n    #[ TODO - Insert your code ]\\n    model=\\n    prompt_template="# System_prompt\\\\n{system_prompt} # Question\\\\n{question}",\\n)'}, {'cell_type': 'code', 'source': 'pointwise_result = EvalTask(\\n    #[ TODO - Insert your code ]\\n    dataset=\\n    metrics=\\n).evaluate(\\n    model=\\n    prompt_template="# System_prompt\\\\n{system_prompt} # Question\\\\n{question}",\\n)'}, {'cell_type': 'code', 'source': 'summarization_helpfulness_metric = PointwiseMetric(\\n    metric="summarization_helpfulness",\\n    metric_prompt_template=PointwiseMetricPromptTemplate(\\n        criteria={\\n            #[ TODO - Insert your code - Add the Conciseness. ]\\n            "Key Information": "info"\\n        },\\n        rating_rubric={\\n            #[ TODO - Insert your code ]\\n            "4": "Good"\\n        },\\n        input_variables=["prompt", "reference"],\\n    ),\\n)'}, {'cell_type': 'code', 'source': 'pointwise_result = EvalTask(\\n    #[ TODO - Insert your code ]\\n    dataset=\\n    metrics=\\n).evaluate(\\n    model=\\n    prompt_template="# System_prompt\\\\n{system_prompt} # Question\\\\n{question}",\\n)'}];\nfor idx, c in enumerate(cells):\n    fixed = wb._auto_repair_cell_source(idx, c['source'], cells)\n    assert 'TODO' not in fixed, f'Residual TODO in cell {idx}: {fixed}'\n    ast.parse(fixed)\nassert 'summarization_helpfulness_metric' in wb._auto_repair_cell_source(3, cells[3]['source'], cells)\n`,
    ]);
  } finally {
    try {
      fsMod.unlinkSync(tmpWbPy);
    } catch {}
  }
  console.log('✓ wb_helper.py Python syntax, ComplexWarning/np.long shims, VM SSH delegation, and notebook TODO auto-repair verified.');

  // 12. Verify CEPF L300 evaluation.ipynb fast-path synthesis & indentation preservation
  const cepfTask2 = await synthesizeTaskShellScript({
    labTitle: '[CEPF L300]: Evaluate Single LLM Outputs with Gemini Enterprise Agent Platform Evals',
    task: {
      number: 2,
      title: 'Task 2. Evaluate model responses with a computation-based metric',
      hasCheckProgress: true,
      checkProgressStepNumber: 2,
      rawSectionText: 'Complete the ROUGE evaluation task in evaluation.ipynb and run the cell.',
      steps: [],
    },
    credentials: modernParsed.credentials,
  });
  if (
    !cepfTask2 ||
    !cepfTask2.script.includes('wb_helper.update_and_run_notebook') ||
    transformAgyLaunchCommand(cepfTask2.script) !== cepfTask2.script
  ) {
    throw new Error('CEPF L300 Task 2 fast-path synthesis or indentation check failed.');
  }
  console.log('✓ CEPF L300 evaluation.ipynb fast-path synthesis & indentation verified.');

  // 13. Verify CEPF L300 RAG Application using ADK fast-path synthesis across retry attempts
  const ragTask3 = await synthesizeTaskShellScript({
    labTitle: '[CEPF L300]: Build and Deploy a RAG Application using ADK',
    task: {
      number: 3,
      title: 'Task 3. Deploy the ADK agent to Vertex AI Agent Engine',
      hasCheckProgress: true,
      checkProgressStepNumber: 3,
      rawSectionText: 'Deploy the ADK agent to Vertex AI Agent Engine using deploy.py.',
      steps: [],
    },
    credentials: modernParsed.credentials,
    attemptNumber: 2,
    previousFailureReason: 'Progress check did not pass.',
  });
  if (
    !ragTask3 ||
    !ragTask3.script.includes('google-adk') ||
    !ragTask3.script.includes('agent_engines.create')
  ) {
    throw new Error('CEPF L300 RAG ADK Task 3 fast-path synthesis failed.');
  }
  console.log('✓ CEPF L300 RAG Application using ADK fast-path synthesis verified.');

  await browser.close();
  console.log('✅ All verification tests passed!');
}

runVerificationTests().catch((err) => {
  console.error('❌ Verification test failed:', err);
  process.exit(1);
});
