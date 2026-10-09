import { Page } from 'playwright';
import {
  CourseActivityType,
  LabCredentials,
  LabLink,
  LabStep,
  LabTask,
  TargetSurface,
} from './types.js';
import { transformAgyLaunchCommand } from './geminiClient.js';
import {
  clickCheckProgressInUserChrome,
  clickStartLabInUserChrome,
} from './nativeChromeBridge.js';

export interface CourseQuizOption {
  id: string;
  title: string;
  rawTitle: string;
  isAnswer?: boolean;
  rationale?: string;
}

export interface CourseQuizItem {
  id: string;
  itemType: string;
  stem: string;
  options: CourseQuizOption[];
}

export interface CourseQuizItemResponse {
  id: string;
  quizItemId: string;
  isSubmitted: boolean;
  isCorrect?: boolean;
  itemType: string;
  choiceId?: string | null;
  choiceIds?: string[] | null;
  choice?: boolean | null;
}

export interface CourseQuizData {
  quizResponseId: string;
  quizVersionId: string;
  passingPercentage: number;
  isSubmitted: boolean;
  isPassing: boolean;
  percentageGrade: number | null;
  retakeUnallowedReason?: string | null;
  items: CourseQuizItem[];
  itemResponses: CourseQuizItemResponse[];
}

const htmlBundleContentCache = new Map<string, string>();

function decodeHtmlEntitiesAndStripTags(raw: string): string {
  return String(raw || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlAttributeEntities(raw: string): string {
  return String(raw || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/**
 * Parses Google Skills Studio `<gss-knowledge-check serialized-config="...">` elements
 * embedded inside `/html_bundles/...` lesson and quiz iframes.
 */
export function parseGssKnowledgeCheckHtml(
  html: string,
  isAlreadyCompleted = false
): CourseQuizData | undefined {
  if (!html || !html.includes('gss-knowledge-check')) return undefined;
  const regex = /<gss-knowledge-check[^>]*\bserialized-config="([^"]+)"/gi;
  const items: CourseQuizItem[] = [];
  let quizId = '';
  let passingPercentage = 66;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    try {
      const jsonStr = decodeHtmlAttributeEntities(match[1]);
      const parsed = JSON.parse(jsonStr);
      const kc = Array.isArray(parsed?.[0]) ? parsed[0] : parsed;
      if (!Array.isArray(kc)) continue;

      if (!quizId && kc[0]) {
        quizId = String(kc[0]);
      }
      if (typeof kc[3] === 'number') {
        passingPercentage = kc[3];
      } else if (typeof kc[2] === 'number') {
        passingPercentage = kc[2];
      }

      const rawQuestions = Array.isArray(kc[2])
        ? kc[2]
        : Array.isArray(kc[1])
          ? kc[1]
          : [];
      for (let qIdx = 0; qIdx < rawQuestions.length; qIdx++) {
        const q = rawQuestions[qIdx];
        if (!Array.isArray(q)) continue;
        const qId = String(q[0] || `kc-q-${items.length + 1}`);
        const qBody =
          (Array.isArray(q[1]) && typeof q[1][0] === 'string' && Array.isArray(q[1][1])
            ? q[1]
            : null) ||
          q.find(
            (el: any) =>
              Array.isArray(el) && typeof el[0] === 'string' && Array.isArray(el[1])
          ) ||
          [];
        const stem = decodeHtmlEntitiesAndStripTags(String(qBody[0] || ''));
        const rawOpts = Array.isArray(qBody[1]) ? qBody[1] : [];
        const options: CourseQuizOption[] = rawOpts
          .filter(Array.isArray)
          .map((opt: any[], oIdx: number) => ({
            id: String(opt[3] || `${qId}-opt-${oIdx + 1}`),
            title: decodeHtmlEntitiesAndStripTags(String(opt[0] || '')),
            rawTitle: String(opt[0] || ''),
            rationale: decodeHtmlEntitiesAndStripTags(String(opt[1] || '')),
            isAnswer: Boolean(opt[2] === 1 || opt[2] === true),
          }));

        if (!stem || options.length === 0) continue;
        const correctCount = options.filter((o) => o.isAnswer).length;
        const itemType = correctCount >= 2 ? 'multiple-select' : 'multiple-choice';
        items.push({
          id: qId,
          itemType,
          stem,
          options,
        });
      }
    } catch {
      // Ignore malformed serialized-config block
    }
  }

  if (items.length === 0) return undefined;

  return {
    quizResponseId: quizId || 'gss-kc',
    quizVersionId: quizId || 'gss-kc',
    passingPercentage,
    isSubmitted: isAlreadyCompleted,
    isPassing: isAlreadyCompleted,
    percentageGrade: isAlreadyCompleted ? 100 : null,
    retakeUnallowedReason: null,
    items,
    itemResponses: [],
  };
}

export interface ParsedLabPage {
  isCourse?: boolean;
  courseOverviewUrl?: string;
  courseStartHref?: string;
  currentIframeSrc?: string;
  currentVideoId?: string;
  currentWatchTimePath?: string;
  currentQuiz?: CourseQuizData;
  labTitle: string;
  labTimer: string;
  isLabStarted: boolean;
  needsLogin: boolean;
  labInstanceId?: string;
  totalScore?: number;
  maxScore?: number;
  credentials: LabCredentials;
  tasks: LabTask[];
}


/**
 * Extracts credentials, lab timer, and structured tasks/steps from a Google Cloud Skills Boost
 * (Qwiklabs / partner.skills.google) page, piercing both live Shadow DOMs and Declarative Shadow DOMs.
 */
export async function parseLabPageDom(page: Page): Promise<ParsedLabPage> {
  await page.evaluate('window.__name = (fn) => fn;');
  const rawParsed = await page.evaluate(() => {
    // Recursive helper to collect all elements across open Shadow DOMs and Declarative Shadow DOM <template>s
    function queryAllDeep(root: Document | ShadowRoot | DocumentFragment | Element): Element[] {
      const results: Element[] = [];
      const visited = new Set<Node>();
      const walker = (node: Document | ShadowRoot | DocumentFragment | Element) => {
        if (!node || visited.has(node)) return;
        visited.add(node);
        if ((node as HTMLElement).shadowRoot) {
          walker((node as HTMLElement).shadowRoot!);
        }
        const children = Array.from(node.children || []);
        for (const el of children) {
          results.push(el);
          if (el.tagName === 'TEMPLATE' && (el as HTMLTemplateElement).content) {
            walker((el as HTMLTemplateElement).content);
          }
          walker(el);
        }
      };
      walker(root);
      return results;
    }

    function getDeepText(el: Element | null): string {
      if (!el) return '';
      let text = '';
      const visited = new Set<Node>();
      const walkText = (node: Node) => {
        if (!node || visited.has(node)) return;
        visited.add(node);
        if (node.nodeType === 3) {
          text += (node.nodeValue || '') + ' ';
          return;
        }
        if ((node as HTMLElement).shadowRoot) {
          walkText((node as HTMLElement).shadowRoot!);
        }
        if (
          (node as Element).tagName === 'TEMPLATE' &&
          (node as HTMLTemplateElement).content
        ) {
          walkText((node as HTMLTemplateElement).content);
        }
        const childNodes = Array.from(node.childNodes || []);
        for (const c of childNodes) {
          walkText(c);
        }
      };
      walkText(el);
      return text.replace(/\s+/g, ' ').trim();
    }

    const allElements = queryAllDeep(document);

    // 1. Inspect <ql-lab-header> (modern partner.skills.google / Cloud Skills Boost header component)
    const labHeader = document.querySelector('ql-lab-header');
    let headerTitle = '';
    let headerTimer = '';
    let headerRunning = false;
    let liveShadowState: 'running' | 'stopped' | null = null;
    let username = '';
    let password = '';
    let projectId = '';
    let consoleUrl = '';
    let region = '';
    let zone = '';
    const extraVars: Record<string, string> = {};

    const isPlaceholderVal = (v: string): boolean => {
      const t = v.trim();
      if (!t) return true;
      return /^(_+|region|zone|project_id|your-gcp-project-id|username|model name|model id|<filled in.*)$/i.test(
        t
      );
    };

    if (labHeader) {
      headerTitle = (labHeader.getAttribute('labtitle') || '').trim();

      // Check live Shadow DOM inside <ql-lab-header> first, because LitElement updates its Shadow DOM
      // when a lab starts or ends without mutating the initial server-rendered HTML attributes.
      const headerDeepEls = queryAllDeep(labHeader);
      const headerCtrlBtn = headerDeepEls.find(
        (el) => el.tagName.toLowerCase() === 'ql-lab-control-button'
      );
      if (headerCtrlBtn) {
        const ctrlSubEls = [headerCtrlBtn, ...queryAllDeep(headerCtrlBtn)];
        const hasRunningMarker = ctrlSubEls.some((el) => {
          const aria = (
            el.getAttribute('data-aria-label') ||
            el.getAttribute('aria-label') ||
            ''
          ).toLowerCase();
          return (
            el.hasAttribute('running') ||
            el.classList?.contains('running') ||
            aria === 'end' ||
            aria.startsWith('end lab')
          );
        });
        const btnDeepText = getDeepText(headerCtrlBtn).toLowerCase();
        if (hasRunningMarker || /\bend\b/.test(btnDeepText)) {
          liveShadowState = 'running';
        } else if (/\bstart\b/.test(btnDeepText)) {
          liveShadowState = 'stopped';
        }
      }

      if (liveShadowState !== 'stopped') {
        const timerAttr = labHeader.getAttribute('labtimer');
        if (timerAttr) {
          try {
            const parsedTimer = JSON.parse(timerAttr);
            if (typeof parsedTimer.secondsRemaining === 'number') {
              const totalSecs = Math.max(0, Math.floor(parsedTimer.secondsRemaining));
              const hrs = String(Math.floor(totalSecs / 3600)).padStart(2, '0');
              const mins = String(Math.floor((totalSecs % 3600) / 60)).padStart(2, '0');
              const secs = String(totalSecs % 60).padStart(2, '0');
              headerTimer = `${hrs}:${mins}:${secs}`;
            }
          } catch {
            // Ignore malformed JSON
          }
        }

        const controlAttr = labHeader.getAttribute('labcontrolbutton');
        if (controlAttr) {
          try {
            const parsedCtrl = JSON.parse(controlAttr);
            if (parsedCtrl.running === true) {
              headerRunning = true;
            }
          } catch {
            // Ignore
          }
        }
        if (liveShadowState === 'running') {
          headerRunning = true;
        }

        const detailsAttr = labHeader.getAttribute('labdetails');
        if (detailsAttr) {
          try {
            const detailsList = JSON.parse(detailsAttr);
            if (Array.isArray(detailsList)) {
              for (const item of detailsList) {
                const prop = String(item.property || item.label || '').toLowerCase();
                const val = String(item.value || '').trim();
                const href = String(item.href || '').trim();
                if (prop === 'username' || prop.includes('username')) {
                  if (val && !isPlaceholderVal(val)) username = val;
                } else if (prop === 'password' || prop.includes('password')) {
                  if (val && !isPlaceholderVal(val)) password = val;
                } else if (prop === 'project_id' || prop.includes('project')) {
                  if (val && !isPlaceholderVal(val)) projectId = val;
                } else if (prop === 'console_url' || prop.includes('console')) {
                  if (href || val) consoleUrl = href || val;
                } else if (prop.includes('region')) {
                  if (val && !isPlaceholderVal(val)) region = val;
                } else if (prop.includes('zone')) {
                  if (val && !isPlaceholderVal(val)) zone = val;
                } else if (prop && val && !isPlaceholderVal(val)) {
                  extraVars[prop] = val;
                }
              }
            }
          } catch {
            // Ignore
          }
        }
      }
    }

    // 2. Lab Title
    const h1 =
      document.querySelector('h1.lab-preamble__title') ||
      document.querySelector('ql-lab-preamble h1') ||
      document.querySelector('h1');
    let labTitle =
      headerTitle ||
      getDeepText(h1) ||
      document.title.replace(/\s*\|\s*Google.*$/i, '').trim() ||
      'Google Cloud Skills Lab';

    // 3. Timer & Lab Started state
    let liveHhMmSsTimer = '';
    for (const el of allElements) {
      if (el.tagName.toLowerCase() === 'ql-timer' || el.classList?.contains('js-timer')) {
        const tText = getDeepText(el);
        const m = tText.match(/\b(\d{2}:\d{2}:\d{2})\b/);
        if (m) {
          liveHhMmSsTimer = m[1];
          break;
        }
      }
    }
    let labTimer =
      liveShadowState === 'stopped'
        ? '00:00:00'
        : liveHhMmSsTimer || headerTimer || '00:00:00';

    const hasEndLabButton =
      liveShadowState === 'stopped'
        ? false
        : liveShadowState === 'running'
          ? true
          : labHeader?.hasAttribute('labcontrolbutton')
            ? headerRunning
            : Boolean(document.querySelector('ql-lab-control-button[running]')) ||
              allElements.some((el) => {
                const t = getDeepText(el).toLowerCase();
                return (
                  (el.tagName === 'BUTTON' || el.tagName.toLowerCase().includes('button')) &&
                  t.includes('end lab')
                );
              });

    // 4. Scan <ql-copyable-input> Shadow DOMs and control-panel inputs (populates live credentials even when started without page reload)
    if (liveShadowState !== 'stopped') {
      for (const el of allElements) {
        let label = (
          el.getAttribute('label') ||
          el.getAttribute('aria-label') ||
          el.getAttribute('name') ||
          ''
        ).toLowerCase();
        let val =
          (el as HTMLInputElement).value ||
          el.getAttribute('value') ||
          el.getAttribute('text') ||
          '';

        if (el.tagName.toLowerCase() === 'ql-copyable-input') {
          const subEls = queryAllDeep(el);
          const lblEl = subEls.find((c) => c.tagName === 'LABEL');
          const inpEl = subEls.find((c) => c.tagName === 'INPUT') as
            | HTMLInputElement
            | undefined;
          if (!label && lblEl) {
            label = (lblEl.textContent || '').trim().toLowerCase();
          }
          if (!val && inpEl) {
            val = (inpEl.value || inpEl.getAttribute('value') || '').trim();
          }
        }

        const isLiveCopyableInput = el.tagName.toLowerCase() === 'ql-copyable-input';
        if (label && val && !isPlaceholderVal(val)) {
          if (
            (isLiveCopyableInput || !username) &&
            (label.includes('username') ||
              label.includes('user name') ||
              label.includes('student'))
          ) {
            username = val.trim();
          } else if ((isLiveCopyableInput || !password) && label.includes('password')) {
            password = val.trim();
          } else if (
            (isLiveCopyableInput || !projectId) &&
            (label.includes('project') || label.includes('gcp project id'))
          ) {
            projectId = val.trim();
          } else if ((isLiveCopyableInput || !region) && label.includes('region')) {
            region = val.trim();
          } else if ((isLiveCopyableInput || !zone) && label.includes('zone')) {
            zone = val.trim();
          } else if (
            !extraVars[label] &&
            val.trim().length <= 120 &&
            !label.includes('recaptcha') &&
            !label.includes('authenticity_token') &&
            !label.includes('_method') &&
            !label.includes('lab_review') &&
            !label.includes('share link') &&
            label !== 'copy'
          ) {
            extraVars[label] = val.trim();
          }
        }

        if (el.tagName === 'A' || el.tagName.toLowerCase() === 'ql-button') {
          const text = getDeepText(el).toLowerCase();
          const href = el.getAttribute('href') || '';
          if (
            href &&
            (href.includes('/google_sso?') ||
              text.includes('open google console') ||
              text.includes('open google cloud console') ||
              text.includes('open console'))
          ) {
            if (!consoleUrl || el.classList?.contains('open-console-button')) {
              consoleUrl = href;
            }
          }
        }
      }
    }

    // Extract any <ql-variable> values present in the page and hydrate their light-DOM textContent
    // so subsequent cloneNode(true) and textContent reads preserve the resolved variable values.
    const qlVars = Array.from(document.querySelectorAll('ql-variable'));
    for (const qv of qlVars) {
      const key = (qv.getAttribute('key') || '').trim();
      const tmpl = qv.querySelector('template') as HTMLTemplateElement | null;
      const val = (
        (qv as HTMLElement).shadowRoot?.textContent ||
        tmpl?.content?.textContent ||
        qv.textContent ||
        ''
      ).trim();
      if (val && !isPlaceholderVal(val)) {
        qv.textContent = val;
      }
      if (key && val && !isPlaceholderVal(val)) {
        extraVars[key] = val;
        if (key.includes('region')) region = val;
        if (key.includes('zone')) zone = val;
      }
    }

    const bodyText = (document.body?.innerText || '') + '\n' + (document.body?.textContent || '');
    const fullDeepText =
      allElements
        .filter(
          (el) =>
            el.tagName.toLowerCase().includes('control-panel') ||
            el.className?.toString().includes('panel') ||
            el.tagName.toLowerCase() === 'ql-code-block'
        )
        .map((el) => getDeepText(el))
        .join('\n') +
      '\n' +
      bodyText;

    if (liveShadowState !== 'stopped') {
      if (!username) {
        const userMatch = fullDeepText.match(/student-[a-z0-9-]+@[a-z0-9.-]+\.[a-z]+/i);
        if (userMatch) username = userMatch[0];
      }

      if (!projectId) {
        const projMatch = fullDeepText.match(/qwiklabs-gcp-(?:xx|\d+)-[a-z0-9]{6,16}\b/i);
        if (projMatch) projectId = projMatch[0];
      }
    }

    if (!region) {
      const regionMatch = fullDeepText.match(
        /\b(us-central1|us-east1|us-east4|us-west1|us-west2|us-west4|europe-west1|europe-west4|asia-east1|asia-northeast1)\b/
      );
      if (regionMatch) region = regionMatch[1];
    }
    if (!zone) {
      const zoneMatch = fullDeepText.match(
        /\b(us-central1-[abcf]|us-east1-[bcd]|us-east4-[abc]|us-west1-[abc]|europe-west1-[bcd])\b/
      );
      if (zoneMatch) zone = zoneMatch[1];
    }

    const engineIdMatch = fullDeepText.match(/[?&]engineId=([a-zA-Z0-9_-]{4,80})\b/);
    if (
      engineIdMatch &&
      !isPlaceholderVal(engineIdMatch[1]) &&
      !extraVars['project_0.startup_script.engine_id']
    ) {
      extraVars['project_0.startup_script.engine_id'] = engineIdMatch[1];
    }
    const dataStoreIdMatch = fullDeepText.match(/[?&]dataStoreId=([a-zA-Z0-9_-]{4,80})\b/);
    if (
      dataStoreIdMatch &&
      !isPlaceholderVal(dataStoreIdMatch[1]) &&
      !extraVars['project_0.startup_script.datastore_id']
    ) {
      extraVars['project_0.startup_script.datastore_id'] = dataStoreIdMatch[1];
    }
    const modelEnvMatch = fullDeepText.match(/^MODEL=(gemini-[a-z0-9.-]+)\s*$/m);
    if (
      modelEnvMatch &&
      !isPlaceholderVal(modelEnvMatch[1]) &&
      !extraVars['project_0.startup_script.gemini_flash_model_id']
    ) {
      extraVars['project_0.startup_script.gemini_flash_model_id'] = modelEnvMatch[1];
    }

    if (!consoleUrl) {
      consoleUrl = projectId
        ? `https://console.cloud.google.com/?project=${projectId}`
        : 'https://console.cloud.google.com/';
    }

    let isLabStarted =
      liveShadowState === 'stopped'
        ? false
        : Boolean(username || projectId || hasEndLabButton);

    // Check if user is on a Sign-In gate
    const currentUrl = window.location.href;
    const hasLabContent = Boolean(
      labHeader ||
        isLabStarted ||
        document.querySelector(
          '.js-lab-content-body, .lab-content__inner, ql-contents-menu, ql-quiz, ql-iframe, ql-youtube-video'
        )
    );
    const hasSignInLink = allElements.some((el) => {
      const t = (el.textContent || '').trim().toLowerCase();
      return (
        (el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName.startsWith('QL-')) &&
        (t === 'sign in' || t === 'log in')
      );
    });
    const isSignInPage =
      !hasLabContent &&
      (currentUrl.includes('/users/sign_in') ||
        currentUrl.includes('accounts.google.com') ||
        (hasSignInLink &&
          !bodyText.toLowerCase().includes('start lab') &&
          !bodyText.toLowerCase().includes('end lab')));

    // 5. Extract Structured Tasks and Steps from Lab Content
    const contentRoot =
      document.querySelector('.js-lab-content-body') ||
      document.querySelector('.lab-content__inner') ||
      document.querySelector('#lab-content') ||
      document.querySelector('ql-drawer-content') ||
      document.querySelector('main') ||
      document.body;

    const headings = Array.from(contentRoot.querySelectorAll('h2'));
    const tasks: LabTask[] = [];

    const isAgyCliLaunchCommand = (cmd: string): boolean => {
      const t = cmd.trim();
      return (
        /^(?:\(?)(?:cd\s+[^&;]+&&\s*)?(?:sudo\s+)?(?:agy|antigravity)(?:\s+.*)?$/i.test(t) &&
        t.split(/\s+/).length <= 14
      );
    };

    const isLikelyShellCommand = (cmd: string, lang: string): boolean => {
      if (isAgyCliLaunchCommand(cmd)) return true;
      if (lang === 'bash' || lang === 'sh' || lang === 'shell') return true;
      if (lang === 'plaintext' || lang === 'markdown') return false;
      return /^(?:\$\s*)?(?:sudo\s+)?(?:gcloud|kubectl|gsutil|bq|terraform|docker|python3?|pip3?|npm|npx|git|curl|wget|apt|apt-get|mkdir|cd|cat|ls|cp|mv|rm|chmod|export|source|uv|uvx|agents-cli)\b/m.test(
        cmd.trim()
      );
    };

    const classifySurface = (
      text: string,
      commands: string[],
      links: LabLink[],
      codeLanguages: string[]
    ): TargetSurface => {
      const lowerText = text.toLowerCase();
      const lowerAll = (text + ' ' + commands.join(' ')).toLowerCase();

      // If any command is an `agy` CLI launch command, always execute in Cloud Shell
      if (commands.some((c) => isAgyCliLaunchCommand(c))) {
        return 'cloud_shell';
      }

      // If the prose explicitly instructs prompting/asking the agent or the code block is plaintext for the agent
      const isAgentPromptInstruction =
        /\b(?:ask|prompt)\s+the\s+(?:agent|cli)\b/i.test(text) ||
        /\bin\s+the\s+(?:terminal\s+tab\s+running\s+)?`?agy`?\s*(?:session)?\b/i.test(text) ||
        (codeLanguages.includes('plaintext') &&
          (lowerText.includes('agent') ||
            lowerText.includes('agy') ||
            lowerText.includes('prompt') ||
            lowerText.includes('ask')));

      if (isAgentPromptInstruction) {
        return 'antigravity';
      }

      // Check if any command is a bash/shell command
      if (
        commands.some((c, idx) =>
          isLikelyShellCommand(c, (codeLanguages[idx] || '').toLowerCase())
        )
      ) {
        return 'cloud_shell';
      }

      if (
        lowerAll.includes('antigravity') ||
        /\bagy\b/.test(lowerAll) ||
        lowerAll.includes('code assist') ||
        lowerAll.includes('cloud editor') ||
        lowerAll.includes('workstation') ||
        lowerAll.includes('agent chat') ||
        lowerAll.includes('prompt the agent')
      ) {
        return 'antigravity';
      }
      if (
        lowerAll.includes('cloud shell') ||
        lowerAll.includes('run the following command') ||
        lowerAll.includes('in the terminal')
      ) {
        return 'cloud_shell';
      }
      if (
        links.length > 0 &&
        (lowerText.includes('click') ||
          lowerText.includes('open') ||
          lowerText.includes('navigate to'))
      ) {
        return 'browser_link';
      }
      if (
        lowerText.includes('navigation menu') ||
        lowerText.includes('cloud console') ||
        lowerText.includes('click create') ||
        lowerText.includes('select') ||
        lowerText.includes('in the console') ||
        lowerText.includes('playground')
      ) {
        return 'console_ui';
      }
      return 'general';
    };

    const getCleanInstructionText = (el: Element): string => {
      const clone = el.cloneNode(true) as Element;
      // Replace <ql-variable> with its resolved text if light-DOM text is empty
      for (const qv of Array.from(clone.querySelectorAll('ql-variable'))) {
        const tmpl = qv.querySelector('template') as HTMLTemplateElement | null;
        const resolved = (
          (qv as HTMLElement).shadowRoot?.textContent ||
          tmpl?.content?.textContent ||
          qv.textContent ||
          ''
        ).trim();
        qv.textContent = resolved;
      }
      // Preserve external HTTP(S) links inline so asset URLs (e.g., branding logos) are retained in prose
      for (const a of Array.from(clone.querySelectorAll('a[href]'))) {
        const href = (a.getAttribute('href') || '').trim();
        const text = (a.textContent || '').trim();
        if (href && /^https?:\/\//i.test(href) && !text.includes(href)) {
          a.textContent = text ? `${text} (${href})` : href;
        }
      }
      // Convert HTML tables into structured key: value text so configuration tables are preserved
      for (const tbl of Array.from(clone.querySelectorAll('table'))) {
        const rows = Array.from(tbl.querySelectorAll('tr'))
          .map((tr) =>
            Array.from(tr.querySelectorAll('th, td'))
              .map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
              .join(': ')
          )
          .filter(Boolean);
        if (rows.length > 0) {
          const replacement = document.createTextNode(` [Table: ${rows.join(' | ')}] `);
          tbl.replaceWith(replacement);
        }
      }
      // Remove code blocks, templates, styles, scripts, hints, quizzes, and activity trackers so instruction prose is clean
      for (const noisy of Array.from(
        clone.querySelectorAll(
          'ql-code-block, pre, template, style, script, ql-activity-tracking, ql-hint, ql-quiz'
        )
      )) {
        noisy.remove();
      }
      return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    };

    const firstTracker =
      document.querySelector('ql-activity-tracking[labinstanceid]') ||
      allElements.find(
        (el) =>
          el.tagName.toLowerCase() === 'ql-activity-tracking' &&
          el.getAttribute('labinstanceid')
      );
    const pageLabInstanceId = (
      firstTracker?.getAttribute('labinstanceid') ||
      document.documentElement?.innerHTML?.match(/labinstanceid="(\d+)"/i)?.[1] ||
      ''
    ).trim();
    const headerCurrPts = parseInt(labHeader?.getAttribute('currentpoints') || '', 10);
    const headerMaxPts = parseInt(labHeader?.getAttribute('totalpoints') || '', 10);
    let totalScore = Number.isFinite(headerCurrPts) ? headerCurrPts : 0;
    let maxScore = Number.isFinite(headerMaxPts) ? headerMaxPts : 100;

    let taskCounter = 0;
    const taskOneIndex = headings.findIndex((h) =>
      /^task\s+1\b/i.test((h.textContent || '').replace(/\s+/g, ' ').trim())
    );

    headings.forEach((h2, hIdx) => {
      const title = (h2.textContent || '').replace(/\s+/g, ' ').trim();
      const lowerTitle = title.toLowerCase();

      // Skip boilerplate non-action sections & lab ID headers (e.g., GENAI129, GSP123)
      if (
        !title ||
        /^[a-z]{2,8}\d{2,5}$/i.test(title) ||
        lowerTitle.includes('overview') ||
        lowerTitle.includes('introduction') ||
        lowerTitle === 'objective' ||
        lowerTitle === 'objectives' ||
        lowerTitle === 'setup' ||
        lowerTitle.includes('setup and requirements') ||
        lowerTitle.includes('before you click') ||
        lowerTitle.includes('challenge scenario') ||
        lowerTitle.includes('scenario') ||
        lowerTitle.includes('your challenge') ||
        lowerTitle.includes('related learning') ||
        lowerTitle.includes('congratulations') ||
        lowerTitle.includes('end your lab') ||
        lowerTitle.includes('next steps') ||
        lowerTitle.includes('recertify')
      ) {
        return;
      }

      // Collect all sibling elements until the next h2
      const sectionNodes: Element[] = [];
      let curr = h2.nextElementSibling;
      while (curr && curr.tagName !== 'H2') {
        sectionNodes.push(curr);
        curr = curr.nextElementSibling;
      }

      const steps: LabStep[] = [];
      let hasCheckProgress = false;
      let checkProgressStepNumber: number | undefined;
      const checkProgressStepNumbers: number[] = [];
      let allTrackersVerified = true;
      let taskLabInstanceId: string | undefined = pageLabInstanceId || undefined;
      let progressVerified = false;
      let progressMessage: string | undefined;
      let stepScore: number | undefined;
      let stepMaxScore: number | undefined;
      let stepIdx = 0;

      const sectionProseParts: string[] = [title];

      const extractAllCodeBlocksTextFromNode = (node: Element): string[] => {
        const blocks: string[] = [];
        const codeBlocks = [
          ...(node.matches('ql-code-block, pre') ? [node] : []),
          ...Array.from(node.querySelectorAll('ql-code-block, pre')),
        ];
        for (const cb of codeBlocks) {
          if (cb.tagName === 'PRE' && cb.closest('ql-code-block')) continue;
          const tmpl = cb.querySelector('template') as HTMLTemplateElement | null;
          const shadowPreText = (cb as HTMLElement).shadowRoot?.querySelector('pre, code')?.textContent;
          const templatePreText = tmpl?.content?.querySelector('pre, code')?.textContent;
          const codeText =
            shadowPreText ||
            templatePreText ||
            cb.getAttribute('value') ||
            cb.getAttribute('code') ||
            cb.querySelector('code')?.textContent ||
            cb.textContent ||
            '';
          const cleaned = codeText
            .replace(/^content_copy\s*/i, '')
            .replace(/\s*content_copy$/i, '')
            .trim();
          if (cleaned) {
            blocks.push(cleaned);
          }
        }
        return blocks;
      };

      const extractCommandsAndLanguagesFromNode = (
        node: Element
      ): { commands: string[]; languages: string[] } => {
        const cmds: string[] = [];
        const langs: string[] = [];
        const rawNodeText = getCleanInstructionText(node);
        const isPromptStep =
          /\b(?:ask|prompt)\s+the\s+(?:agent|cli)\b/i.test(rawNodeText) ||
          /\bin\s+the\s+(?:terminal\s+tab\s+running\s+)?`?agy`?\s*(?:session)?\b/i.test(rawNodeText);

        const codeBlocks = [
          ...(node.matches('ql-code-block, pre') ? [node] : []),
          ...Array.from(node.querySelectorAll('ql-code-block, pre')),
        ];
        for (const cb of codeBlocks) {
          // Skip <pre> if it is nested inside a <ql-code-block> we already matched
          if (cb.tagName === 'PRE' && cb.closest('ql-code-block')) continue;
          // Skip expected-output blocks (<ql-code-block output="">)
          if (cb.hasAttribute('output') || cb.classList.contains('output')) continue;

          const lang = (cb.getAttribute('language') || '').toLowerCase();
          const tmpl = cb.querySelector('template') as HTMLTemplateElement | null;
          // Prefer <pre> inside Shadow DOM / Declarative Shadow DOM <template> because Qwiklabs
          // renders already-interpolated variables there while light DOM holds uninterpolated {{{...}}}
          const shadowPreText = (cb as HTMLElement).shadowRoot?.querySelector('pre, code')?.textContent;
          const templatePreText = tmpl?.content?.querySelector('pre, code')?.textContent;

          const codeText =
            shadowPreText ||
            templatePreText ||
            cb.getAttribute('value') ||
            cb.getAttribute('code') ||
            cb.querySelector('code')?.textContent ||
            cb.textContent ||
            '';

          const cleaned = codeText
            .replace(/^content_copy\s*/i, '')
            .replace(/\s*content_copy$/i, '')
            .trim();
          if (!cleaned) continue;

          // Skip traceback / output blocks or single-word interactive chat replies or non-shell JSON/markdown snippets
          if (
            cleaned.includes('Traceback (most recent call last)') ||
            cleaned.includes('google.genai.errors.ClientError') ||
            cleaned.includes('Your app is available at http://localhost') ||
            /^(?:hello|yes|no|exit|quit)$/i.test(cleaned) ||
            /^agent\s*=\s*client\.agent_engines\.get\(/i.test(cleaned) ||
            (!isPromptStep &&
              (lang === 'json' ||
                lang === 'yaml' ||
                lang === 'sql' ||
                lang === 'python' ||
                /^[\[{][\s\S]*[\]}]$/.test(cleaned) ||
                /^-\s+"[^"]+"\s*->/m.test(cleaned) ||
                /^The tables you have available are:/i.test(cleaned)))
          ) {
            continue;
          }

          cmds.push(cleaned);
          langs.push(lang);
        }

        // If no <pre> or <ql-code-block> was found, check if the instruction explicitly calls to launch `agy` or run an inline CLI command
        if (cmds.length === 0) {
          const isLaunchAgyInstruction =
            /\b(?:launch|run|start|execute|invoke)\s+(?:the\s+)?(?:antigravity\s+cli|agy\s+cli|`?agy`?)\b/i.test(
              rawNodeText
            );
          const inlineCodes = Array.from(node.querySelectorAll('code'));
          for (const ic of inlineCodes) {
            const icText = (ic.textContent || '').trim();
            if (
              (isLaunchAgyInstruction &&
                /^(?:sudo\s+)?(?:agy|antigravity)(?:\s+.*)?$/i.test(icText)) ||
              /^(?:sudo\s+)?(?:agy|antigravity)\s+\S+/i.test(icText) ||
              /^(?:gcloud|kubectl|gsutil|bq|terraform|git|npm|pip|python3?|adk)\s+.+/i.test(icText)
            ) {
              cmds.push(icText);
              langs.push('bash');
            }
          }
          if (cmds.length === 0 && isLaunchAgyInstruction) {
            cmds.push('agy');
            langs.push('bash');
          }
        }

        return { commands: cmds, languages: langs };
      };

      const extractLinksFromNode = (node: Element): LabLink[] => {
        const foundLinks: LabLink[] = [];
        const anchors = [
          ...(node.matches('a[href]') ? [node] : []),
          ...Array.from(node.querySelectorAll('a[href]')),
        ];
        for (const a of anchors) {
          const href = (a as HTMLAnchorElement).href || a.getAttribute('href') || '';
          const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
          if (
            href &&
            !href.startsWith('javascript:') &&
            !href.includes('#') &&
            text.toLowerCase() !== 'learn more'
          ) {
            foundLinks.push({ text: text || href, href });
          }
        }
        return foundLinks;
      };

      for (const node of sectionNodes) {
        const nodeText = getDeepText(node);
        const cleanSectionPart = getCleanInstructionText(node);
        if (cleanSectionPart) {
          sectionProseParts.push(cleanSectionPart);
        }
        const nodeCodeBlocks = extractAllCodeBlocksTextFromNode(node);
        for (const cbText of nodeCodeBlocks) {
          sectionProseParts.push(`\`\`\`\n${cbText}\n\`\`\``);
        }

        const trackerEls = [
          ...(node.matches('ql-activity-tracking') ? [node] : []),
          ...Array.from(node.querySelectorAll('ql-activity-tracking')),
        ];
        if (trackerEls.length > 0) {
          hasCheckProgress = true;
          for (const trackerEl of trackerEls) {
            const stepAttr = parseInt(trackerEl.getAttribute('step') || '', 10);
            let thisStepScore: number | undefined;
            let thisStepMaxScore: number | undefined;
            const isNewStep =
              Number.isFinite(stepAttr) &&
              stepAttr > 0 &&
              !checkProgressStepNumbers.includes(stepAttr);
            if (Number.isFinite(stepAttr) && stepAttr > 0) {
              if (checkProgressStepNumber === undefined) {
                checkProgressStepNumber = stepAttr;
              }
              if (isNewStep) {
                checkProgressStepNumbers.push(stepAttr);
              }
              const scoreSpan = document.querySelector(`.js-assessment-step-score-${stepAttr}`);
              if (scoreSpan) {
                const sc = parseInt((scoreSpan.textContent || '').trim(), 10);
                if (Number.isFinite(sc)) {
                  thisStepScore = sc;
                  if (isNewStep) stepScore = (stepScore ?? 0) + sc;
                }
                const parentText = (scoreSpan.parentElement?.textContent || '').trim();
                const maxMatch = parentText.match(/\/\s*(\d+)/);
                if (maxMatch) {
                  const mx = parseInt(maxMatch[1], 10);
                  thisStepMaxScore = mx;
                  if (isNewStep) stepMaxScore = (stepMaxScore ?? 0) + mx;
                }
              }
            }
            const instAttr = (trackerEl.getAttribute('labinstanceid') || '').trim();
            if (instAttr) {
              taskLabInstanceId = instAttr;
            }

            // Inspect tracker status and message in DOM / Declarative Shadow DOM
            const trackerDeep = queryAllDeep(trackerEl);
            const statusDiv = trackerDeep.find((el) => el.classList?.contains('status'));
            const statusVal = (statusDiv?.getAttribute('status') || '').toLowerCase();
            const ariaVal = statusDiv?.getAttribute('aria-valuenow') || '';
            const msgSpan = trackerDeep.find((el) => el.classList?.contains('message'));
            const msgTxt = (msgSpan?.textContent || '').replace(/\s+/g, ' ').trim();

            const thisVerified =
              statusVal === 'complete' ||
              statusVal === 'completed' ||
              ariaVal === '100' ||
              Boolean(
                thisStepMaxScore &&
                  thisStepScore !== undefined &&
                  thisStepScore >= thisStepMaxScore
              );
            if (!thisVerified) {
              allTrackersVerified = false;
              if (msgTxt) progressMessage = msgTxt;
            } else if (!progressMessage) {
              progressMessage = msgTxt || 'Assessment Completed!';
            }
          }
          progressVerified = allTrackersVerified;
        } else if (
          node.tagName.toLowerCase().includes('activity-tracking') ||
          nodeText.toLowerCase().includes('check my progress')
        ) {
          hasCheckProgress = true;
        }

        // If it's an ordered or unordered list of instructions (<ol> or <ul>)
        if (node.tagName === 'OL' || node.tagName === 'UL') {
          const listItems = Array.from(node.children).filter((c) => c.tagName === 'LI');
          for (const li of listItems) {
            const { commands, languages } = extractCommandsAndLanguagesFromNode(li);
            const links = extractLinksFromNode(li);
            let liText = getCleanInstructionText(li);
            if (!liText && commands.length > 0) {
              liText = `Execute: ${commands[0].slice(0, 120)}`;
            }
            if (!liText) continue;
            // Skip pure "Click Check my progress to verify the objective" list item shells if they have no commands
            if (
              commands.length === 0 &&
              /^click check my progress to verify the objective\.?$/i.test(liText)
            ) {
              continue;
            }
            stepIdx++;
            steps.push({
              id: `task-${taskCounter + 1}-step-${stepIdx}`,
              index: stepIdx,
              instruction: liText.slice(0, 900),
              commands,
              links,
              targetSurface: classifySurface(liText, commands, links, languages),
              status: progressVerified ? 'completed' : 'pending',
            });
          }
        } else if (
          node.matches('ql-code-block, pre') ||
          node.querySelector('ql-code-block, pre')
        ) {
          // Standalone code block outside of a list item; attach to previous step if possible, or create a step
          const { commands, languages } = extractCommandsAndLanguagesFromNode(node);
          if (commands.length > 0) {
            if (steps.length > 0 && steps[steps.length - 1].commands.length === 0) {
              steps[steps.length - 1].commands.push(...commands);
              steps[steps.length - 1].targetSurface = classifySurface(
                steps[steps.length - 1].instruction,
                steps[steps.length - 1].commands,
                steps[steps.length - 1].links,
                languages
              );
            } else {
              stepIdx++;
              steps.push({
                id: `task-${taskCounter + 1}-step-${stepIdx}`,
                index: stepIdx,
                instruction: `Execute command block: ${commands[0].slice(0, 120)}`,
                commands,
                links: [],
                targetSurface: classifySurface('', commands, [], languages),
                status: progressVerified ? 'completed' : 'pending',
              });
            }
          }
        }
      }

      if (steps.length === 0 && hasCheckProgress && sectionProseParts.length > 1) {
        const fallbackInstruction = sectionProseParts.slice(1).join(' ').slice(0, 900).trim();
        if (fallbackInstruction) {
          steps.push({
            id: `task-${taskCounter + 1}-step-1`,
            index: 1,
            instruction: fallbackInstruction,
            commands: [],
            links: [],
            targetSurface: classifySurface(fallbackInstruction, [], [], []),
            status: progressVerified ? 'completed' : 'pending',
          });
        }
      }

      // Skip pre-Task-1 conceptual overview sections (e.g., "ADK 2.0 Graph Workflows and Orchestration")
      // when the lab contains an explicit "Task 1" heading and this section has no activity tracker.
      if (taskOneIndex > 0 && hIdx < taskOneIndex && !hasCheckProgress) {
        return;
      }

      if (steps.length > 0) {
        taskCounter++;
        tasks.push({
          id: `task-${taskCounter}`,
          number: taskCounter,
          title,
          description: `Task ${taskCounter}: ${title}`,
          steps,
          hasCheckProgress,
          checkProgressIndex: hIdx,
          checkProgressStepNumber,
          checkProgressStepNumbers:
            checkProgressStepNumbers.length > 0 ? checkProgressStepNumbers : undefined,
          labInstanceId: taskLabInstanceId,
          stepScore,
          stepMaxScore,
          rawSectionText: sectionProseParts.join('\n'),
          progressVerified,
          progressMessage,
          status: progressVerified ? 'completed' : 'pending',
        });
      }
    });

    const contentsMenu = document.querySelector('ql-contents-menu');
    const savedUrlMatch = (document.documentElement.outerHTML.slice(0, 1200) || '').match(
      /saved from url=\(\d+\)(https?:\/\/[^\s>"'-]+)/i
    );
    const effectiveUrl = (savedUrlMatch ? savedUrlMatch[1] : window.location.href || '').toLowerCase();
    const isCourseUrlPattern =
      !effectiveUrl.includes('/focuses/') &&
      !effectiveUrl.includes('/labs/') &&
      !effectiveUrl.includes('/catalog_lab/') &&
      (effectiveUrl.includes('/html_bundles/') ||
        effectiveUrl.includes('/quizzes/') ||
        effectiveUrl.includes('/documents/') ||
        effectiveUrl.includes('/videos/') ||
        effectiveUrl.includes('/course_templates/') ||
        effectiveUrl.includes('/course_sessions/'));

    const isCoursePage = Boolean(
      !labHeader &&
        !pageLabInstanceId &&
        (contentsMenu ||
          document.querySelector('ql-quiz') ||
          document.querySelector('ql-iframe.document-iframe') ||
          document.querySelector('ql-iframe.html-bundle-iframe') ||
          document.querySelector('ql-youtube-video') ||
          document.querySelector('gss-knowledge-check') ||
          document.querySelector('gss-lesson-completion') ||
          isCourseUrlPattern)
    );

    let courseOverviewUrl = '';
    let courseStartHref = '';
    let currentIframeSrc = '';
    let currentVideoId = '';
    let currentWatchTimePath = '';
    let currentQuiz: CourseQuizData | undefined;

    if (isCoursePage) {
      const stripHtml = (s: string) => {
        const div = document.createElement('div');
        div.innerHTML = s || '';
        return (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim();
      };

      const bannerBtn = document.querySelector(
        'ql-button[data-analytics-position="course-banner"], ql-button[data-content-type="course"]'
      );
      const bannerCourseTitle = (bannerBtn?.getAttribute('data-content-name') || '').trim();
      const breadcrumbCourseLink = document.querySelector(
        '.breadcrumb-item a[href*="/course_templates/"], .breadcrumb-item a[href*="/paths/"]'
      ) as HTMLAnchorElement | null;
      const allBreadcrumbCourseLinks = Array.from(
        document.querySelectorAll('.breadcrumb-item a[href*="/course_templates/"]')
      ) as HTMLAnchorElement[];
      const primaryCourseLink = allBreadcrumbCourseLinks[0] || breadcrumbCourseLink;

      if (primaryCourseLink) {
        courseOverviewUrl = (primaryCourseLink.getAttribute('href') || '').trim();
      }
      if (!courseOverviewUrl) {
        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
        if (canonical.includes('/course_templates/')) {
          courseOverviewUrl = canonical.trim();
        }
      }

      if (bannerBtn) {
        courseStartHref = (bannerBtn.getAttribute('href') || '').trim();
      }

      const derivedCourseTitle =
        bannerCourseTitle ||
        (allBreadcrumbCourseLinks[0]?.textContent || '').replace(/\s+/g, ' ').trim() ||
        (document.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim() ||
        labTitle;
      if (derivedCourseTitle) {
        labTitle = derivedCourseTitle;
      }

      const docIframe = document.querySelector(
        'ql-iframe.document-iframe, ql-iframe.html-bundle-iframe, ql-iframe[src]'
      );
      if (docIframe) {
        currentIframeSrc = (docIframe.getAttribute('src') || '').trim();
      }

      const ytVideo = document.querySelector('ql-youtube-video');
      if (ytVideo) {
        currentVideoId = (ytVideo.getAttribute('videoid') || '').trim();
        currentWatchTimePath = (ytVideo.getAttribute('watchtimepath') || '').trim();
      }

      const quizEl = document.querySelector('ql-quiz');
      if (quizEl) {
        try {
          const qvRaw = quizEl.getAttribute('quizversion') || '{}';
          const qrRaw = quizEl.getAttribute('quizresponse') || '{}';
          const qv = JSON.parse(qvRaw);
          const qr = JSON.parse(qrRaw);
          const quizDeepText = getDeepText(quizEl);
          const shadowScoreContainer = queryAllDeep(quizEl).find((el) =>
            el.classList?.contains('score-container')
          );
          const shadowPassing = Boolean(shadowScoreContainer?.classList?.contains('passing'));
          const shadowGradeText = shadowScoreContainer?.textContent || '';
          const shadowGradeMatch = shadowGradeText.match(/Your score:\s*(\d+(?:\.\d+)?)%/i);
          const gradeMatch = shadowGradeMatch || quizDeepText.match(/(\d+(?:\.\d+)?)%/);

          const items: CourseQuizItem[] = Array.isArray(qv.quizItems)
            ? qv.quizItems.map((it: any) => ({
                id: String(it.id || ''),
                itemType: String(it.itemType || 'multiple-choice'),
                stem: stripHtml(String(it.stem || '')),
                options: Array.isArray(it.options)
                  ? it.options.map((opt: any) => ({
                      id: String(opt.id || ''),
                      title: stripHtml(String(opt.title || '')),
                      rawTitle: String(opt.title || ''),
                      isAnswer: typeof opt.isAnswer === 'boolean' ? opt.isAnswer : undefined,
                    }))
                  : [],
              }))
            : [];

          const itemResponses: CourseQuizItemResponse[] = Array.isArray(qr.itemResponses)
            ? qr.itemResponses.map((ir: any) => ({
                id: String(ir.id || ''),
                quizItemId: String(ir.quizItemId || ''),
                isSubmitted: Boolean(ir.isSubmitted),
                isCorrect: typeof ir.isCorrect === 'boolean' ? ir.isCorrect : undefined,
                itemType: String(ir.itemType || 'multiple-choice'),
                choiceId: ir.choiceId != null ? String(ir.choiceId) : null,
                choiceIds: Array.isArray(ir.choiceIds) ? ir.choiceIds.map(String) : null,
                choice: typeof ir.choice === 'boolean' ? ir.choice : null,
              }))
            : [];

          const isPassing = Boolean(qr.isPassing === true || shadowPassing);
          const isSubmitted = Boolean(qr.isSubmitted === true || shadowPassing);
          const percentageGrade =
            shadowPassing && gradeMatch
              ? parseFloat(gradeMatch[1])
              : typeof qr.percentageGrade === 'number'
                ? qr.percentageGrade
                : null;

          currentQuiz = {
            quizResponseId: String(qr.id || ''),
            quizVersionId: String(qv.id || ''),
            passingPercentage: typeof qv.passingPercentage === 'number' ? qv.passingPercentage : 80,
            isSubmitted,
            isPassing,
            percentageGrade,
            retakeUnallowedReason: qr.retakeUnallowedReason || null,
            items,
            itemResponses,
          };
        } catch {
          // Ignore malformed quiz JSON
        }
      }

      if (contentsMenu) {
        try {
          const modulesRaw =
            contentsMenu.getAttribute('modules') ||
            contentsMenu.getAttribute('sections') ||
            '[]';
          const modules = JSON.parse(modulesRaw);
          if (Array.isArray(modules)) {
            tasks.length = 0;
            let actIdx = 0;
            for (const mod of modules) {
              const modTitle = stripHtml(String(mod?.title || ''));
              const modSteps = Array.isArray(mod?.steps)
                ? mod.steps
                : Array.isArray(mod?.activities)
                  ? [{ activities: mod.activities }]
                  : [];
              for (const st of modSteps) {
                const activities = Array.isArray(st?.activities) ? st.activities : [];
                for (const act of activities) {
                  const rawActType = String(act?.type || 'link').toLowerCase();
                  if (rawActType === 'credential' || rawActType === 'survey') {
                    continue;
                  }
                  actIdx++;
                  const actTitle = stripHtml(String(act?.title || `Activity ${actIdx}`));
                  const isQuizBundle =
                    rawActType === 'html_bundle' &&
                    /\b(?:quiz|knowledge\s+check|assessment)\b/i.test(actTitle);
                  const actType = (isQuizBundle ? 'quiz' : rawActType) as CourseActivityType;
                  const actHref = String(act?.href || '').trim();
                  const actComplete = Boolean(
                    act?.isComplete === true || act?.completed === true
                  );
                  const typeLabel =
                    actType === 'quiz'
                      ? 'Quiz / Assessment'
                      : actType === 'video'
                        ? 'Video Lesson'
                        : actType === 'lab'
                          ? 'Hands-on Lab'
                          : 'Interactive Lesson / Multimedia';
                  const stepInstruction =
                    actType === 'quiz'
                      ? `Complete quiz "${actTitle}" by analyzing all questions against the course material, selecting the answers, and submitting.`
                      : actType === 'video'
                        ? `Navigate to video lesson "${actTitle}" and complete playback.`
                        : `Navigate to interactive module "${actTitle}", process multimedia content, and record activity completion.`;

                  tasks.push({
                    id: `course-act-${act?.id || actIdx}`,
                    number: actIdx,
                    title: actTitle,
                    description: `${modTitle ? modTitle + ' • ' : ''}${typeLabel}`,
                    steps: [
                      {
                        id: `step-${actIdx}-1`,
                        index: 1,
                        instruction: stepInstruction,
                        commands: [],
                        links: actHref ? [{ text: actTitle, href: actHref }] : [],
                        targetSurface: 'general',
                        status: actComplete ? 'completed' : 'pending',
                      },
                    ],
                    hasCheckProgress: true,
                    stepScore: actComplete ? 1 : 0,
                    stepMaxScore: 1,
                    progressVerified: actComplete,
                    progressMessage: actComplete
                      ? 'Activity completed'
                      : act?.inProgress
                        ? 'In progress'
                        : 'Pending completion',
                    status: actComplete ? 'completed' : 'pending',
                    activityId: String(act?.id || actIdx),
                    activityType: actType,
                    activityHref: actHref,
                    moduleTitle: modTitle,
                  });
                }
              }
            }
          }
        } catch {
          // Ignore malformed modules JSON
        }
      }

      totalScore = tasks.filter((t) => t.progressVerified).length;
      maxScore = tasks.length || 1;
      isLabStarted = tasks.some((t) => Boolean(t.activityHref && t.activityHref.includes('/course_sessions/')));
      labTimer = `${totalScore}/${maxScore} done`;
    } else {
      const computedScore = tasks.reduce((sum, t) => sum + (t.stepScore || 0), 0);
      if (computedScore > totalScore) {
        totalScore = computedScore;
      }
    }

    return {
      isCourse: isCoursePage,
      courseOverviewUrl: courseOverviewUrl || undefined,
      courseStartHref: courseStartHref || undefined,
      currentIframeSrc: currentIframeSrc || undefined,
      currentVideoId: currentVideoId || undefined,
      currentWatchTimePath: currentWatchTimePath || undefined,
      currentQuiz,
      labTitle,
      labTimer,
      isLabStarted,
      needsLogin: isSignInPage,
      labInstanceId: pageLabInstanceId || undefined,
      totalScore,
      maxScore,
      credentials: {
        username,
        password,
        projectId,
        consoleUrl,
        region,
        zone,
        extraVars,
      },
      tasks,
    };
  });

  if (rawParsed.isCourse && !rawParsed.currentQuiz) {
    try {
      const fullPageHtml = await page.content().catch(() => '');
      const savedUrlMatch = fullPageHtml.match(
        /saved from url=\(\d+\)(https?:\/\/[^\s>"'-]+)/i
      );
      const effectivePageUrl = savedUrlMatch ? savedUrlMatch[1] : page.url();
      const matchedTask = rawParsed.tasks.find(
        (t) =>
          (t.activityId &&
            (effectivePageUrl.endsWith(`/${t.activityId}`) ||
              effectivePageUrl.includes(`/${t.activityId}?`))) ||
          (t.activityHref && effectivePageUrl.includes(t.activityHref))
      );
      const isAlreadyCompleted = Boolean(matchedTask?.progressVerified);

      let gssQuiz = parseGssKnowledgeCheckHtml(fullPageHtml, isAlreadyCompleted);
      if (!gssQuiz && rawParsed.currentIframeSrc && /^https?:\/\//i.test(rawParsed.currentIframeSrc)) {
        const srcUrl = rawParsed.currentIframeSrc;
        let iframeHtml = htmlBundleContentCache.get(srcUrl) || '';
        if (!iframeHtml) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          try {
            const resp = await fetch(srcUrl, { signal: controller.signal });
            if (resp.ok) {
              iframeHtml = await resp.text();
              if (iframeHtml) {
                htmlBundleContentCache.set(srcUrl, iframeHtml);
              }
            }
          } finally {
            clearTimeout(timer);
          }
        }
        if (iframeHtml) {
          gssQuiz = parseGssKnowledgeCheckHtml(iframeHtml, isAlreadyCompleted);
        }
      }

      if (gssQuiz) {
        rawParsed.currentQuiz = gssQuiz;
        if (matchedTask && matchedTask.activityType === 'html_bundle') {
          matchedTask.activityType = 'quiz';
        }
      }
    } catch {
      // Ignore iframe fetch error
    }
  }

  // Ensure every `agy` / `antigravity` launch command uses `--dangerously-skip-permissions` with fallback to normal launch
  rawParsed.tasks = rawParsed.tasks.map((task) => ({
    ...task,
    steps: task.steps.map((step) => ({
      ...step,
      commands: step.commands.map((cmd) => transformAgyLaunchCommand(cmd)),
    })),
  }));

  return rawParsed;
}

/**
 * Clicks the "Start Lab" button on the Qwiklabs page (or in the user's native Chrome tab)
 * and waits for temporary student credentials and Project ID to populate.
 */
export async function triggerStartLabAndExtractCredentials(
  page: Page,
  onLog: (msg: string) => void,
  syncFromUserChrome?: () => Promise<void>,
  labUrl?: string,
  preferredTarget?: { windowId: number; tabIndex: number } | null
): Promise<LabCredentials> {
  onLog('Checking if lab is already active or needs "Start Lab" clicked...');

  if (syncFromUserChrome) {
    await syncFromUserChrome();
  }

  let parsed = await parseLabPageDom(page);
  if (parsed.isLabStarted && parsed.credentials.username && parsed.credentials.password) {
    onLog(
      `Lab is already running! Extracted Project ID: ${parsed.credentials.projectId}, Username: ${parsed.credentials.username}`
    );
    return parsed.credentials;
  }

  let clicked = false;
  if (labUrl || preferredTarget) {
    clicked = await clickStartLabInUserChrome(labUrl, preferredTarget);
    if (clicked) {
      onLog('Clicked "Start Lab" in your Google Chrome window...');
    }
  }

  if (!clicked) {
    // Try clicking "Start Lab" via Playwright locator
    const startSelectors = [
      'button:has-text("Start Lab")',
      'ql-button:has-text("Start Lab")',
      '#start-lab-button',
      '[aria-label*="Start Lab"]',
    ];

    for (const sel of startSelectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        onLog(`Clicking "Start Lab" button (${sel})...`);
        await loc.click();
        clicked = true;
        break;
      }
    }
  }

  if (!clicked) {
    onLog(
      'Please click "Start Lab" in your Google Chrome window if it is not yet running. Waiting up to 60s for lab credentials to appear...'
    );
  } else {
    onLog('Waiting for Google Cloud lab resources and student credentials to provision...');
  }

  // Poll up to 120 seconds for username / projectId to populate (some labs provision GKE/Vertex resources on start)
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(3000);
    if (syncFromUserChrome) {
      await syncFromUserChrome();
    }
    parsed = await parseLabPageDom(page);
    if (parsed.credentials.username && parsed.credentials.password) {
      onLog(
        `Credentials provisioned: ${parsed.credentials.username} | Project: ${parsed.credentials.projectId}`
      );
      return parsed.credentials;
    }
    if (i > 0 && i % 5 === 0) {
      onLog(
        `Still waiting for lab environment provisioning to complete (${i * 3}s elapsed)...`
      );
    }
  }

  return parsed.credentials;
}

export interface CheckProgressResult {
  verified: boolean;
  message: string;
  stepScore?: number;
  stepMaxScore?: number;
  totalScore?: number;
  maxScore?: number;
  stepCompleteList?: boolean[];
  stepScoresList?: number[];
  stepPointsList?: number[];
  studentMessagesList?: string[];
}

/**
 * Triggers "Check my progress" for a specific task in the Main Lab Window (via Qwiklabs' live
 * `/assessments/run_step.json` endpoint in the user's Chrome session) and returns the real grader verification status.
 */
export async function clickCheckMyProgress(
  page: Page,
  taskNumber: number,
  labUrl?: string,
  options?: {
    checkProgressStepNumber?: number;
    labInstanceId?: string;
    windowId?: number;
    tabIndex?: number;
  }
): Promise<CheckProgressResult> {
  try {
    const stepNo = options?.checkProgressStepNumber || taskNumber;
    if (labUrl || options?.labInstanceId) {
      return await clickCheckProgressInUserChrome(stepNo, labUrl, {
        labInstanceId: options?.labInstanceId,
        windowId: options?.windowId,
        tabIndex: options?.tabIndex,
      });
    }

    const checkButtons = page.locator(
      'button:has-text("Check my progress"), ql-button:has-text("Check my progress")'
    );
    const count = await checkButtons.count();

    if (count === 0) {
      return {
        verified: true,
        message: 'No "Check my progress" button required for this task.',
      };
    }

    const targetIndex = Math.min(Math.max(0, stepNo - 1), count - 1);
    const btn = checkButtons.nth(targetIndex);

    await btn.scrollIntoViewIfNeeded();
    await btn.click();

    await page.waitForTimeout(4500);

    const feedback = await page.evaluate((idx) => {
      const trackers = Array.from(
        document.querySelectorAll('ql-activity-tracking, .js-activity-tracker')
      );
      const tracker = trackers[idx] || trackers[0];
      if (!tracker) return { ok: false, text: 'Progress tracker not found.' };
      const shadowText = (tracker as HTMLElement).shadowRoot?.textContent || '';
      const fullText = (shadowText + ' ' + (tracker.textContent || ''))
        .replace(/\s+/g, ' ')
        .trim();
      const lower = fullText.toLowerCase();
      const passed =
        lower.includes('assessment completed') ||
        tracker.hasAttribute('completed') ||
        tracker.getAttribute('status') === 'completed' ||
        tracker.getAttribute('status') === 'complete';
      return { ok: passed, text: fullText || 'Check triggered.' };
    }, targetIndex);

    return {
      verified: feedback.ok,
      message: feedback.text,
    };
  } catch (err: any) {
    return {
      verified: false,
      message: `Error clicking Check my progress: ${err?.message || String(err)}`,
    };
  }
}


