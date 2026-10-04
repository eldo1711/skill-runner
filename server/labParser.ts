import { Page } from 'playwright';
import { LabCredentials, LabLink, LabStep, LabTask, TargetSurface } from './types.js';
import { transformAgyLaunchCommand } from './geminiClient.js';
import {
  clickCheckProgressInUserChrome,
  clickStartLabInUserChrome,
} from './nativeChromeBridge.js';

export interface ParsedLabPage {
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
      const walker = (node: Document | ShadowRoot | DocumentFragment | Element) => {
        const children = Array.from(node.children || []);
        for (const el of children) {
          results.push(el);
          if ((el as HTMLElement).shadowRoot) {
            walker((el as HTMLElement).shadowRoot!);
          }
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
      if ((el as HTMLElement).shadowRoot) {
        text += ((el as HTMLElement).shadowRoot!.textContent || '') + ' ';
      }
      const tmpl = el.querySelector('template') as HTMLTemplateElement | null;
      if (tmpl && tmpl.content) {
        text += (tmpl.content.textContent || '') + ' ';
      }
      text += el.textContent || '';
      return text.replace(/\s+/g, ' ').trim();
    }

    const allElements = queryAllDeep(document);

    // 1. Inspect <ql-lab-header> (modern partner.skills.google / Cloud Skills Boost header component)
    const labHeader = document.querySelector('ql-lab-header');
    let headerTitle = '';
    let headerTimer = '';
    let headerRunning = false;
    let username = '';
    let password = '';
    let projectId = '';
    let consoleUrl = '';
    let region = '';
    let zone = '';
    const extraVars: Record<string, string> = {};

    if (labHeader) {
      headerTitle = (labHeader.getAttribute('labtitle') || '').trim();

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
                if (val) username = val;
              } else if (prop === 'password' || prop.includes('password')) {
                if (val) password = val;
              } else if (prop === 'project_id' || prop.includes('project')) {
                if (val) projectId = val;
              } else if (prop === 'console_url' || prop.includes('console')) {
                if (href || val) consoleUrl = href || val;
              } else if (prop.includes('region')) {
                if (val) region = val;
              } else if (prop.includes('zone')) {
                if (val) zone = val;
              } else if (prop && val) {
                extraVars[prop] = val;
              }
            }
          }
        } catch {
          // Ignore
        }
      }
    }

    // 2. Lab Title
    const h1 =
      document.querySelector('h1.lab-preamble__title') ||
      document.querySelector('ql-lab-preamble h1') ||
      document.querySelector('h1');
    const labTitle =
      headerTitle ||
      getDeepText(h1) ||
      document.title.replace(/\s*\|\s*Google.*$/i, '').trim() ||
      'Google Cloud Skills Lab';

    // 3. Timer & Lab Started state
    const timerEl = allElements.find(
      (el) =>
        el.tagName.toLowerCase() === 'ql-timer' ||
        el.classList?.contains('js-timer') ||
        /^\d{2}:\d{2}:\d{2}$/.test((el.textContent || '').trim())
    );
    const labTimer = headerTimer || (timerEl ? getDeepText(timerEl) : '00:00:00');

    const hasEndLabButton = labHeader?.hasAttribute('labcontrolbutton')
      ? headerRunning
      : Boolean(document.querySelector('ql-lab-control-button[running]')) ||
        allElements.some((el) => {
          const t = getDeepText(el).toLowerCase();
          return (
            (el.tagName === 'BUTTON' || el.tagName.toLowerCase().includes('button')) &&
            t.includes('end lab')
          );
        });

    // 4. Also scan <ql-lab-control-panel> or input/text-box elements if not populated from <ql-lab-header>
    for (const el of allElements) {
      const label = (
        el.getAttribute('label') ||
        el.getAttribute('aria-label') ||
        el.getAttribute('name') ||
        ''
      ).toLowerCase();
      const val =
        (el as HTMLInputElement).value ||
        el.getAttribute('value') ||
        el.getAttribute('text') ||
        '';

      if (label && val) {
        if (
          !username &&
          (label.includes('username') || label.includes('user name') || label.includes('student'))
        ) {
          username = val.trim();
        } else if (!password && label.includes('password')) {
          password = val.trim();
        } else if (
          !projectId &&
          (label.includes('project') || label.includes('gcp project id'))
        ) {
          projectId = val.trim();
        } else if (!region && label.includes('region')) {
          region = val.trim();
        } else if (!zone && label.includes('zone')) {
          zone = val.trim();
        } else if (
          !extraVars[label] &&
          val.trim().length <= 120 &&
          !label.includes('recaptcha') &&
          !label.includes('authenticity_token') &&
          !label.includes('_method') &&
          !label.includes('lab_review') &&
          !label.includes('share link')
        ) {
          extraVars[label] = val.trim();
        }
      }

      if (!consoleUrl && (el.tagName === 'A' || el.tagName.toLowerCase() === 'ql-button')) {
        const text = getDeepText(el).toLowerCase();
        const href = el.getAttribute('href') || '';
        if (
          (text.includes('open google console') ||
            text.includes('open google cloud console') ||
            text.includes('open console')) &&
          href
        ) {
          consoleUrl = href;
        }
      }
    }

    // Extract any <ql-variable> values present in the page
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
      if (key && val && !val.includes('<filled in at lab start>') && val !== 'Model Name' && val !== 'Model ID') {
        extraVars[key] = val;
        if (!region && key.includes('region')) region = val;
        if (!zone && key.includes('zone')) zone = val;
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

    if (!username) {
      const userMatch = fullDeepText.match(/student-[a-z0-9-]+@[a-z0-9.-]+\.[a-z]+/i);
      if (userMatch) username = userMatch[0];
    }

    if (!projectId) {
      const projMatch = fullDeepText.match(/qwiklabs-gcp-(?:xx|\d+)-[a-z0-9]{6,16}\b/i);
      if (projMatch) projectId = projMatch[0];
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

    if (!consoleUrl) {
      consoleUrl = projectId
        ? `https://console.cloud.google.com/?project=${projectId}`
        : 'https://console.cloud.google.com/';
    }

    const isLabStarted = Boolean(username || projectId || hasEndLabButton);

    // Check if user is on a Sign-In gate
    const currentUrl = window.location.href;
    const hasLabContent = Boolean(
      labHeader ||
        isLabStarted ||
        document.querySelector('.js-lab-content-body, .lab-content__inner')
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

    headings.forEach((h2, hIdx) => {
      const title = (h2.textContent || '').replace(/\s+/g, ' ').trim();
      const lowerTitle = title.toLowerCase();

      // Skip boilerplate non-action sections & lab ID headers (e.g., GENAI129, GSP123)
      if (
        !title ||
        /^[a-z]{2,8}\d{2,5}$/i.test(title) ||
        lowerTitle === 'overview' ||
        lowerTitle === 'objective' ||
        lowerTitle === 'objectives' ||
        lowerTitle === 'setup' ||
        lowerTitle.includes('setup and requirements') ||
        lowerTitle.includes('before you click') ||
        lowerTitle.includes('challenge scenario') ||
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
          if (cb.hasAttribute('output') || cb.classList.contains('output')) continue;
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

        const trackerEl = node.matches('ql-activity-tracking')
          ? node
          : node.querySelector('ql-activity-tracking');
        if (trackerEl) {
          hasCheckProgress = true;
          const stepAttr = parseInt(trackerEl.getAttribute('step') || '', 10);
          if (Number.isFinite(stepAttr) && stepAttr > 0) {
            checkProgressStepNumber = stepAttr;
            const scoreSpan = document.querySelector(`.js-assessment-step-score-${stepAttr}`);
            if (scoreSpan) {
              const sc = parseInt((scoreSpan.textContent || '').trim(), 10);
              if (Number.isFinite(sc)) stepScore = sc;
              const parentText = (scoreSpan.parentElement?.textContent || '').trim();
              const maxMatch = parentText.match(/\/\s*(\d+)/);
              if (maxMatch) {
                stepMaxScore = parseInt(maxMatch[1], 10);
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

          if (
            statusVal === 'complete' ||
            statusVal === 'completed' ||
            ariaVal === '100' ||
            (stepMaxScore && stepScore !== undefined && stepScore >= stepMaxScore)
          ) {
            progressVerified = true;
            progressMessage = msgTxt || 'Assessment Completed!';
          } else if (msgTxt) {
            progressMessage = msgTxt;
          }
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

    const computedScore = tasks.reduce((sum, t) => sum + (t.stepScore || 0), 0);
    if (computedScore > totalScore) {
      totalScore = computedScore;
    }

    return {
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
  labUrl?: string
): Promise<LabCredentials> {
  onLog('Checking if lab is already active or needs "Start Lab" clicked...');

  if (syncFromUserChrome) {
    await syncFromUserChrome();
  }

  let parsed = await parseLabPageDom(page);
  if (parsed.isLabStarted && (parsed.credentials.username || parsed.credentials.projectId)) {
    onLog(
      `Lab is already running! Extracted Project ID: ${parsed.credentials.projectId}, Username: ${parsed.credentials.username}`
    );
    return parsed.credentials;
  }

  let clicked = false;
  if (labUrl) {
    clicked = await clickStartLabInUserChrome(labUrl);
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

  // Poll up to 60 seconds for username / projectId to populate
  for (let i = 0; i < 20; i++) {
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


