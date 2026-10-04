import { Frame, Page } from 'playwright';
import { InteractiveElement } from './types.js';
import {
  formatAutonomousAntigravityPrompt,
  transformAgyLaunchCommand,
} from './geminiClient.js';

/**
 * Collects interactive elements across the page (piercing open Shadow DOMs)
 * and assigns sequential Mark IDs with bounding-box center coordinates.
 */
export async function inspectInteractiveElements(
  page: Page
): Promise<InteractiveElement[]> {
  try {
    await page.evaluate('window.__name = (fn) => fn;');
    const elements = await page.evaluate(() => {
      const collected: Array<{
        markId: number;
        tag: string;
        role: string;
        text: string;
        ariaLabel: string;
        placeholder: string;
        href: string;
        inputType?: string;
        x: number;
        y: number;
        width: number;
        height: number;
        inShadowDom: boolean;
      }> = [];

      let counter = 1;

      function walk(root: Document | ShadowRoot | Element, inShadow: boolean) {
        const children = Array.from(root.children || []);
        for (const el of children) {
          const htmlEl = el as HTMLElement;
          if (htmlEl.shadowRoot) {
            walk(htmlEl.shadowRoot, true);
          }

          const tag = el.tagName.toLowerCase();
          const role = (el.getAttribute('role') || '').toLowerCase();
          const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('mattooltip') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const href = (el as HTMLAnchorElement).href || el.getAttribute('href') || '';
          const isInteractive =
            tag === 'button' ||
            tag === 'a' ||
            tag === 'input' ||
            tag === 'textarea' ||
            tag === 'select' ||
            tag.startsWith('ql-button') ||
            role === 'button' ||
            role === 'link' ||
            role === 'menuitem' ||
            role === 'tab' ||
            role === 'checkbox' ||
            role === 'combobox' ||
            role === 'textbox' ||
            el.getAttribute('contenteditable') === 'true';

          if (isInteractive && counter <= 150) {
            const rect = htmlEl.getBoundingClientRect();
            const style = window.getComputedStyle(htmlEl);
            if (
              rect.width > 6 &&
              rect.height > 6 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < window.innerHeight &&
              rect.left < window.innerWidth &&
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              style.opacity !== '0'
            ) {
              const rawText = (htmlEl.innerText || htmlEl.textContent || '')
                .replace(/\s+/g, ' ')
                .trim();
              if (rawText || ariaLabel || placeholder || tag === 'input' || tag === 'textarea') {
                const markId = counter++;
                htmlEl.setAttribute('data-lab-runner-mark', String(markId));
                collected.push({
                  markId,
                  tag,
                  role,
                  text: rawText.slice(0, 100),
                  ariaLabel: ariaLabel.slice(0, 80),
                  placeholder: placeholder.slice(0, 60),
                  href: href.slice(0, 120),
                  inputType: el.getAttribute('type') || undefined,
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2,
                  width: rect.width,
                  height: rect.height,
                  inShadowDom: inShadow,
                });
              }
            }
          }

          walk(el, inShadow);
        }
      }

      walk(document, false);
      return collected;
    });

    return elements;
  } catch {
    return [];
  }
}

/**
 * Clicks an element by its Mark ID (falling back to its center coordinates).
 */
export async function clickElementByMark(
  page: Page,
  markId: number,
  elements: InteractiveElement[]
): Promise<boolean> {
  const target = elements.find((e) => e.markId === markId);
  const loc = page.locator(`[data-lab-runner-mark="${markId}"]`).first();
  try {
    if ((await loc.count()) > 0 && (await loc.isVisible())) {
      await loc.click({ timeout: 5000 });
      return true;
    }
  } catch {
    // Fallback to coordinate click below
  }

  if (target) {
    await page.mouse.click(target.x, target.y);
    return true;
  }
  return false;
}

/**
 * Fills an input/textarea by its Mark ID (falling back to coordinate click + keyboard type).
 */
export async function fillElementByMark(
  page: Page,
  markId: number,
  text: string,
  elements: InteractiveElement[]
): Promise<boolean> {
  const target = elements.find((e) => e.markId === markId);
  const loc = page.locator(`[data-lab-runner-mark="${markId}"]`).first();
  try {
    if ((await loc.count()) > 0 && (await loc.isVisible())) {
      await loc.click({ timeout: 4000 });
      await loc.fill(text);
      return true;
    }
  } catch {
    // Fallback to coordinate click + select-all + type
  }

  if (target) {
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(300);
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(text, { delay: 10 });
    return true;
  }
  return false;
}

/**
 * Opens Google Cloud Shell inside the active GCP Console Incognito window if not already open.
 */
export async function openCloudShellInConsole(
  page: Page,
  onLog: (msg: string) => void
): Promise<boolean> {
  onLog('Ensuring Google Cloud Shell is active in the Console...');

  // Check if Cloud Shell terminal is already present in any frame
  const existingTerminal = await findCloudShellTerminalFrame(page);
  if (existingTerminal) {
    onLog('Cloud Shell terminal is already open and ready.');
    return true;
  }

  // Click Activate Cloud Shell button in the top bar
  const activateSelectors = [
    'button[aria-label*="Activate Cloud Shell" i]',
    '[mattooltip*="Activate Cloud Shell" i]',
    'button#cloud-shell-toggle-button',
    'button:has-text("Activate Cloud Shell")',
  ];

  for (const sel of activateSelectors) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0 && (await btn.isVisible())) {
      onLog(`Clicking Activate Cloud Shell button (${sel})...`);
      await btn.click();
      break;
    }
  }

  // Poll up to 35s for Cloud Shell iframe + terminal or "Continue" button
  for (let i = 0; i < 18; i++) {
    await page.waitForTimeout(2000);

    // Check if there's a "Continue" prompt on first Cloud Shell launch across any frame
    for (const frame of page.frames()) {
      try {
        const continueBtn = frame.locator('button:has-text("Continue")').first();
        if ((await continueBtn.count()) > 0 && (await continueBtn.isVisible())) {
          onLog('Clicking "Continue" on Cloud Shell initialization dialog...');
          await continueBtn.click();
        }
      } catch {
        // Ignore cross-frame race
      }
    }

    const termFrame = await findCloudShellTerminalFrame(page);
    if (termFrame) {
      onLog('Cloud Shell terminal initialized and connected.');
      return true;
    }
  }

  onLog('Cloud Shell is still provisioning or waiting for focus.');
  return false;
}

async function findCloudShellTerminalFrame(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    try {
      const termLoc = frame.locator(
        '.xterm-helper-textarea, .xterm-screen, textarea[aria-label*="Terminal" i], .terminal.xterm'
      );
      if ((await termLoc.count()) > 0) {
        return frame;
      }
    } catch {
      // Ignore detached frames
    }
  }
  return null;
}

/**
 * Executes a bash / gcloud / agy command inside the Google Cloud Shell terminal in the Incognito Console.
 * Automatically wraps any `agy` or `antigravity` launch command with `--dangerously-skip-permissions`
 * and a graceful fallback to normal launch (`agy --dangerously-skip-permissions ... || agy ...`).
 */
export async function executeCommandInCloudShell(
  page: Page,
  command: string,
  onLog: (msg: string) => void
): Promise<boolean> {
  const effectiveCommand = transformAgyLaunchCommand(command);
  if (effectiveCommand !== command.trim()) {
    onLog(
      `[Zero-Touch Agy] Wrapped launch command with --dangerously-skip-permissions & fallback: ${effectiveCommand}`
    );
  }

  await openCloudShellInConsole(page, onLog);

  const termFrame = await findCloudShellTerminalFrame(page);
  if (termFrame) {
    try {
      const screen = termFrame.locator('.xterm-screen, .terminal.xterm').first();
      if ((await screen.count()) > 0 && (await screen.isVisible())) {
        await screen.click({ force: true });
      }
      const helper = termFrame.locator('.xterm-helper-textarea').first();
      if ((await helper.count()) > 0) {
        await helper.focus();
      }
      await page.waitForTimeout(400);

      // Handle Cloud Shell "Authorize" modal if it pops up during a previous command
      await dismissCloudShellAuthorizePrompt(page, onLog);

      onLog(`Sending command to Cloud Shell: ${effectiveCommand}`);
      await page.keyboard.insertText(effectiveCommand);
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2500);

      // Check if "Authorize Cloud Shell" dialog or an agy confirmation prompt appeared after pressing Enter
      await dismissCloudShellAuthorizePrompt(page, onLog);
      await autoAcceptAntigravityPrompts(page, onLog);
      return true;
    } catch (err: any) {
      onLog(`Cloud Shell terminal input warning: ${err?.message || String(err)}`);
    }
  }

  // Fallback: click bottom center where Cloud Shell terminal docks and type
  onLog('Focusing bottom terminal area and typing command...');
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  await page.mouse.click(vp.width / 2, vp.height - 120);
  await page.waitForTimeout(300);
  await page.keyboard.insertText(effectiveCommand);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  await dismissCloudShellAuthorizePrompt(page, onLog);
  await autoAcceptAntigravityPrompts(page, onLog);
  return true;
}

async function dismissCloudShellAuthorizePrompt(
  page: Page,
  onLog: (msg: string) => void
): Promise<void> {
  for (const frame of page.frames()) {
    try {
      const authBtn = frame.locator('button:has-text("Authorize")').first();
      if ((await authBtn.count()) > 0 && (await authBtn.isVisible())) {
        onLog('Clicking "Authorize" on Cloud Shell GCP credentials prompt...');
        await authBtn.click();
        await page.waitForTimeout(1500);
      }
    } catch {
      // Ignore
    }
  }
}

/**
 * Automatically detects and approves any pending Antigravity (`agy`) permission dialogs,
 * file-change confirmation buttons, command-execution approvals, or terminal `[Y/n]` prompts
 * so `agy` runs with as little manual interaction as possible.
 */
export async function autoAcceptAntigravityPrompts(
  page: Page,
  onLog: (msg: string) => void
): Promise<number> {
  let approvedCount = 0;
  const frames = [page.mainFrame(), ...page.frames()];

  const approvalButtonLabels = [
    'Accept All',
    'Accept Changes',
    'Accept',
    'Always Allow',
    'Allow',
    'Approve',
    'Run Command',
    'Apply Changes',
    'Apply',
    'Trust Workspace',
    'Trust',
    'Proceed',
  ];

  for (const frame of frames) {
    for (const label of approvalButtonLabels) {
      try {
        const candidates = frame.locator(
          `button:has-text("${label}"), [role="button"]:has-text("${label}")`
        );
        const count = await candidates.count();
        for (let i = 0; i < count; i++) {
          const btn = candidates.nth(i);
          if (!(await btn.isVisible())) continue;

          const text = ((await btn.innerText().catch(() => '')) || '').trim();
          // Ensure we only click concise confirmation buttons and not unrelated long navigation links
          if (!text || text.length > 28) continue;

          onLog(`[Zero-Touch Agy] Auto-approving confirmation button: "${text}"`);
          await btn.click({ timeout: 3000 });
          approvedCount++;
          await page.waitForTimeout(600);
        }
      } catch {
        // Ignore transient frame/element detachment
      }
    }

    // Also check if a terminal / xterm buffer in this frame is waiting on a (y/n) or [Y/n] prompt from agy CLI
    try {
      const termScreen = frame.locator('.xterm-rows, .xterm-screen').first();
      if ((await termScreen.count()) > 0 && (await termScreen.isVisible())) {
        const termText = ((await termScreen.innerText().catch(() => '')) || '')
          .slice(-400)
          .trim();
        if (
          /(\[y\/n\]|\(y\/n\)|allow\s+execution\?|do\s+you\s+want\s+to\s+proceed\?|approve\s+this\s+action\?)/i.test(
            termText
          )
        ) {
          onLog('[Zero-Touch Agy] Detected terminal confirmation prompt ([y/n]); sending "y" + Enter...');
          await termScreen.click({ force: true });
          await page.keyboard.type('y');
          await page.keyboard.press('Enter');
          approvedCount++;
          await page.waitForTimeout(600);
        }
      }
    } catch {
      // Ignore
    }
  }

  return approvedCount;
}

/**
 * Interacts directly with Antigravity (or Cloud Editor / Gemini Code Assist / Workstation Agent)
 * across the main Console page and any nested IDE iframes.
 * Automatically augments prompts for zero-interaction execution and auto-approves confirmation buttons.
 */
export async function sendPromptToAntigravity(
  page: Page,
  promptText: string,
  onLog: (msg: string) => void
): Promise<boolean> {
  // If the "prompt" is actually a CLI command to launch `agy`, execute it in Cloud Shell with --dangerously-skip-permissions fallback!
  const trimmed = promptText.trim();
  if (
    /^(?:cd\s+[^&;]+&&\s*)?(?:sudo\s+)?(?:agy|antigravity)(?:\s+.*)?$/i.test(trimmed) &&
    trimmed.split(/\s+/).length <= 12
  ) {
    onLog(
      `Detected CLI launch command for Antigravity ("${trimmed}"); routing to terminal with --dangerously-skip-permissions fallback...`
    );
    return await executeCommandInCloudShell(page, trimmed, onLog);
  }

  const autonomousPrompt = formatAutonomousAntigravityPrompt(promptText);
  onLog(`Locating Antigravity / AI Agent chat input in Cloud Console...`);

  const chatSelectors = [
    'textarea[placeholder*="Antigravity" i]',
    'textarea[placeholder*="Ask" i]',
    'textarea[placeholder*="prompt" i]',
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="agent" i]',
    'textarea[placeholder*="Type" i]',
    '[contenteditable="true"][role="textbox"]',
    '.interactive-input-part textarea',
    '.chat-input-container textarea',
    'textarea[aria-label*="chat" i]',
    'textarea[aria-label*="prompt" i]',
    'textarea',
  ];

  // Search across all frames (Antigravity / Cloud Editor often runs inside an iframe)
  const frames = [page.mainFrame(), ...page.frames()];

  for (const frame of frames) {
    for (const sel of chatSelectors) {
      try {
        const loc = frame.locator(sel);
        const count = await loc.count();
        for (let i = 0; i < count; i++) {
          const candidate = loc.nth(i);
          if (await candidate.isVisible()) {
            // Skip tiny hidden Monaco helper textareas (1px by 1px)
            const box = await candidate.boundingBox();
            if (!box || box.width < 60 || box.height < 16) continue;

            onLog(
              `Found Antigravity input (${sel} at ${Math.round(box.x)},${Math.round(box.y)}). Sending zero-touch autonomous prompt...`
            );
            await candidate.click({ force: true });
            await page.waitForTimeout(300);
            await candidate.fill(autonomousPrompt);
            await page.waitForTimeout(300);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(1500);
            await autoAcceptAntigravityPrompts(page, onLog);
            return true;
          }
        }
      } catch {
        // Continue scanning next selector/frame
      }
    }
  }

  onLog('Could not find a standard textarea; typing autonomous prompt into focused Antigravity element...');
  await page.keyboard.insertText(autonomousPrompt);
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  await autoAcceptAntigravityPrompts(page, onLog);
  return true;
}

/**
 * Clicks an action button inside Antigravity / Cloud Console (such as "Accept", "Apply", "Run", "Proceed")
 * across the main frame and any nested IDE iframes.
 */
export async function clickTextAcrossFrames(
  page: Page,
  targetText: string,
  onLog: (msg: string) => void
): Promise<boolean> {
  const frames = [page.mainFrame(), ...page.frames()];
  for (const frame of frames) {
    try {
      const btnLoc = frame
        .locator(
          `button:has-text("${targetText}"), a:has-text("${targetText}"), [role="button"]:has-text("${targetText}")`
        )
        .first();
      if ((await btnLoc.count()) > 0 && (await btnLoc.isVisible())) {
        onLog(`Clicking "${targetText}"...`);
        await btnLoc.click({ timeout: 5000 });
        return true;
      }
    } catch {
      // Try next frame
    }
  }
  return false;
}
