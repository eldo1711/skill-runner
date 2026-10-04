import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ChromeTabDescriptor } from './types.js';
import { macBridgeHub } from './macBridgeHub.js';

const execFileAsync = promisify(execFile);

export interface UserChromeTabInfo {
  windowId?: number;
  windowIndex: number;
  tabIndex: number;
  url: string;
  title: string;
}

const SNAPSHOT_DIR = path.join(os.homedir(), '.cloud-skills-lab-runner');
const SNAPSHOT_HTML_PATH = path.join(SNAPSHOT_DIR, 'live_lab_snapshot.html');
const SNAPSHOT_FILES_DIR = path.join(SNAPSHOT_DIR, 'live_lab_snapshot_files');

async function runAppleScript(script: string): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    timeout: 15000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export function parseTabKey(
  key?: string | null
): { windowId: number; tabIndex: number } | null {
  if (!key) return null;
  const [wStr, tStr] = key.split(':');
  const windowId = parseInt(wStr, 10);
  const tabIndex = parseInt(tStr, 10);
  if (!Number.isFinite(windowId) || !Number.isFinite(tabIndex)) return null;
  return { windowId, tabIndex };
}

/**
 * Lists all currently open windows and tabs in the user's Google Chrome (`Google Chrome.app`),
 * tagging each tab with its window mode (`normal` vs `incognito`) and `suggestedRole`
 * (`lab`, `console`, `cloud_shell`, or `other`).
 */
export async function listUserChromeTabs(): Promise<ChromeTabDescriptor[]> {
  if (process.platform !== 'darwin') {
    if (!macBridgeHub.isConnected()) {
      return [];
    }
    try {
      const remoteTabs = await macBridgeHub.invoke<ChromeTabDescriptor[]>('list_tabs', {});
      return Array.isArray(remoteTabs) ? remoteTabs : [];
    } catch {
      return [];
    }
  }

  const script = `
tell application "Google Chrome"
  set out to ""
  repeat with wIdx from 1 to count of windows
    set w to window wIdx
    set wId to id of w
    set wMode to mode of w
    set actIdx to active tab index of w
    repeat with tIdx from 1 to count of tabs of w
      set t to tab tIdx of w
      set u to URL of t
      set ttl to title of t
      set out to out & (wId as string) & "|||" & (wIdx as string) & "|||" & (wMode as string) & "|||" & (actIdx as string) & "|||" & (tIdx as string) & "|||" & ttl & "|||" & u & linefeed
    end repeat
  end repeat
  return out
end tell
`;
  const raw = await runAppleScript(script).catch(() => '');
  if (!raw) {
    return [];
  }

  const tabs: ChromeTabDescriptor[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [wIdStr, wIdxStr, modeStr, actIdxStr, tIdxStr, title, url] = line.split('|||');
    const windowId = parseInt(wIdStr, 10);
    const windowIndex = parseInt(wIdxStr, 10) || 1;
    const tabIndex = parseInt(tIdxStr, 10) || 1;
    const activeIdx = parseInt(actIdxStr, 10) || 1;
    if (!Number.isFinite(windowId) || !url) continue;

    const lowerUrl = url.toLowerCase();
    let suggestedRole: ChromeTabDescriptor['suggestedRole'] = 'other';
    if (
      !lowerUrl.includes('accounts.google.com') &&
      !lowerUrl.includes('login.corp.google.com') &&
      !lowerUrl.includes('google_sso') &&
      (lowerUrl.includes('skills.google/focuses/') ||
        lowerUrl.includes('/labs/') ||
        lowerUrl.includes('cloudskillsboost.google/focuses/') ||
        lowerUrl.includes('skills.google/catalog_lab/') ||
        lowerUrl.includes('qwiklabs.com/focuses/'))
    ) {
      suggestedRole = 'lab';
    } else if (lowerUrl.includes('shell.cloud.google.com')) {
      suggestedRole = 'cloud_shell';
    } else if (lowerUrl.includes('console.cloud.google.com')) {
      suggestedRole = 'console';
    }

    tabs.push({
      key: `${windowId}:${tabIndex}`,
      windowId,
      windowIndex,
      windowMode: modeStr?.toLowerCase().includes('incognito') ? 'incognito' : 'normal',
      tabIndex,
      title: (title || url).trim(),
      url: url.trim(),
      isActiveTab: tabIndex === activeIdx,
      suggestedRole,
    });
  }

  // Sort so relevant Lab, Console, Cloud Shell, and Incognito tabs appear at the top of the selector
  const rolePriority: Record<ChromeTabDescriptor['suggestedRole'], number> = {
    lab: 0,
    console: 1,
    cloud_shell: 2,
    other: 3,
  };

  tabs.sort((a, b) => {
    const rDiff = rolePriority[a.suggestedRole] - rolePriority[b.suggestedRole];
    if (rDiff !== 0) return rDiff;
    if (a.windowMode !== b.windowMode) {
      return a.windowMode === 'incognito' ? -1 : 1;
    }
    if (a.windowIndex !== b.windowIndex) return a.windowIndex - b.windowIndex;
    return a.tabIndex - b.tabIndex;
  });

  return tabs;
}

/**
 * Brings a specific Google Chrome window and tab to the foreground.
 */
export async function focusUserChromeTab(
  windowId: number,
  tabIndex: number
): Promise<boolean> {
  if (process.platform !== 'darwin' && macBridgeHub.isConnected()) {
    return macBridgeHub.invoke<boolean>('focus_tab', { windowId, tabIndex }).catch(() => false);
  }

  const script = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${windowId}" then
      if ${tabIndex} <= (count of tabs of w) then
        set active tab index of w to ${tabIndex}
      end if
      set index of w to 1
      activate
      return "ok"
    end if
  end repeat
  return "not_found"
end tell
`;
  const res = await runAppleScript(script).catch(() => '');
  return res === 'ok';
}

/**
 * Finds or opens the target Google Cloud Skills Boost / Partner Skills lab URL inside the user's
 * primary Google Chrome window (where they are logged in with their `@google.com` corporate identity).
 */
export async function openOrFocusLabInUserChrome(
  requestedUrl: string,
  onLog: (msg: string) => void
): Promise<UserChromeTabInfo> {
  if (process.platform !== 'darwin' && macBridgeHub.isConnected()) {
    onLog(`Connecting to your Mac Google Chrome via live WebSocket bridge for: ${requestedUrl}`);
    return macBridgeHub.invoke<UserChromeTabInfo>('open_or_focus_lab', { requestedUrl });
  }

  let pathKey = '';
  try {
    const parsed = new URL(requestedUrl);
    if (
      parsed.pathname &&
      parsed.pathname !== '/' &&
      parsed.pathname !== '/focuses/'
    ) {
      pathKey = parsed.pathname;
    }
  } catch {
    // Ignore URL parse error
  }

  const escapedUrl = requestedUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedPathKey = pathKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const script = `
tell application "Google Chrome"
  activate
  -- 1. First look for an existing tab matching the requested lab path
  if "${escapedPathKey}" is not "" then
    repeat with wIdx from 1 to count of windows
      set w to window wIdx
      repeat with tIdx from 1 to count of tabs of w
        set t to tab tIdx of w
        set u to URL of t
        if u contains "${escapedPathKey}" then
          set active tab index of w to tIdx
          set index of w to 1
          return ((id of w) as string) & "|||" & (wIdx as string) & "|||" & (tIdx as string) & "|||" & u & "|||" & (title of t)
        end if
      end repeat
    end repeat
  end if

  -- 2. Next look for any open Skills Boost / Partner Skills lab focus tab
  repeat with wIdx from 1 to count of windows
    set w to window wIdx
    repeat with tIdx from 1 to count of tabs of w
      set t to tab tIdx of w
      set u to URL of t
      if (u contains "skills.google/focuses/" or u contains "skills.google/course_templates/" or u contains "skills.google/labs/" or u contains "cloudskillsboost.google/focuses/" or u contains "skills.google/catalog_lab/" or u contains "qwiklabs.com/focuses/") then
        if "${escapedPathKey}" is "" then
          set active tab index of w to tIdx
          set index of w to 1
          return ((id of w) as string) & "|||" & (wIdx as string) & "|||" & (tIdx as string) & "|||" & u & "|||" & (title of t)
        end if
      end if
    end repeat
  end repeat

  -- 3. Otherwise, open the requested URL in the user's google.com Chrome window
  set targetWinIdx to 1
  repeat with wIdx from 1 to count of windows
    set w to window wIdx
    if (mode of w) is not "incognito" then
      repeat with tIdx from 1 to count of tabs of w
        set u to URL of tab tIdx of w
        if (u contains "partner.skills.google" or u contains "skills.google" or u contains "mail.google.com" or u contains "corp.google.com") then
          set targetWinIdx to wIdx
          exit repeat
        end if
      end repeat
    end if
    if targetWinIdx is not 1 then exit repeat
  end repeat

  if (count of windows) is 0 then
    make new window
    set targetWinIdx to 1
  end if

  set targetWin to window targetWinIdx
  set newTab to make new tab at end of tabs of targetWin with properties {URL:"${escapedUrl}"}
  set index of targetWin to 1
  set newTabIdx to count of tabs of targetWin
  return ((id of targetWin) as string) & "|||1|||" & (newTabIdx as string) & "|||" & (URL of newTab) & "|||" & (title of newTab)
end tell
`;

  onLog(
    `Connecting to your active Google Chrome (google.com session) for Lab URL: ${requestedUrl}`
  );
  const raw = await runAppleScript(script);
  const [wIdStr, wStr, tStr, url, title] = raw.split('|||');
  return {
    windowId: parseInt(wIdStr, 10) || undefined,
    windowIndex: parseInt(wStr, 10) || 1,
    tabIndex: parseInt(tStr, 10) || 1,
    url: url || requestedUrl,
    title: title || 'Google Cloud Skills Lab',
  };
}

/**
 * Snapshots a specific tab identified by `windowId` and `tabIndex` (or falls back to URL matching).
 */
export async function snapshotUserChromeTabByTarget(
  windowId: number,
  tabIndex: number
): Promise<{ htmlPath: string; url: string; title: string } | null> {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  if (process.platform !== 'darwin' && macBridgeHub.isConnected()) {
    try {
      const remoteSnap = await macBridgeHub.invoke<{
        htmlContent: string;
        url: string;
        title: string;
      } | null>('snapshot_tab_by_target', { windowId, tabIndex }, 30000);
      if (remoteSnap && remoteSnap.htmlContent) {
        fs.writeFileSync(SNAPSHOT_HTML_PATH, remoteSnap.htmlContent, 'utf8');
        return {
          htmlPath: SNAPSHOT_HTML_PATH,
          url: remoteSnap.url,
          title: remoteSnap.title,
        };
      }
    } catch {
      // Fall through
    }
  }

  try {
    if (fs.existsSync(SNAPSHOT_HTML_PATH)) {
      fs.unlinkSync(SNAPSHOT_HTML_PATH);
    }
    if (fs.existsSync(SNAPSHOT_FILES_DIR)) {
      fs.rmSync(SNAPSHOT_FILES_DIR, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }

  const escapedSnapshotPath = SNAPSHOT_HTML_PATH.replace(/\\/g, '\\\\').replace(
    /"/g,
    '\\"'
  );

  // First try in-memory DOM + Declarative Shadow DOM serialization via JS (does not trigger Chrome Downloads bar)
  const inMemoryJs = `(function(){try{function s(r){var h='';var c=r.childNodes;for(var i=0;i<c.length;i++){var n=c[i];if(n.nodeType===1){var t=n.tagName.toLowerCase();h+='<'+t;for(var a=0;a<n.attributes.length;a++){var at=n.attributes[a];h+=' '+at.name+'="'+at.value.replace(/"/g,'&quot;')+'"';}h+='>';if(n.shadowRoot){h+='<template shadowrootmode="open">'+s(n.shadowRoot)+'</template>';}h+=s(n)+'</'+t+'>';}else if(n.nodeType===3){h+=n.nodeValue;}}return h;}return document.documentElement.outerHTML.length>500 && document.querySelector('ql-lab-header') ? '<!DOCTYPE html><html>'+s(document.documentElement)+'</html>' : '';}catch(e){return '';}})()`;
  const escapedInMemoryJs = inMemoryJs.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const script = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${windowId}" then
      if ${tabIndex} <= (count of tabs of w) then
        set t to tab ${tabIndex} of w
        if (loading of t) is true then
          return ""
        end if
        set u to URL of t
        if (u contains "accounts.google.com" or u contains "login.corp.google.com" or u contains "google_sso") then
          return ""
        end if
        try
          set domHtml to execute t javascript "${escapedInMemoryJs}"
          if domHtml is not "" then
            return u & "|||" & (title of t) & "|||" & domHtml
          end if
        end try
        save t in POSIX file "${escapedSnapshotPath}"
        return u & "|||" & (title of t)
      end if
    end if
  end repeat
  return ""
end tell
`;

  const out = await runAppleScript(script).catch(() => '');
  if (!out) return null;

  const parts = out.split('|||');
  const url = parts[0] || '';
  const title = parts[1] || '';
  const inlineHtml = parts.slice(2).join('|||');

  if (inlineHtml && inlineHtml.length > 500) {
    fs.writeFileSync(SNAPSHOT_HTML_PATH, inlineHtml, 'utf8');
    return {
      htmlPath: SNAPSHOT_HTML_PATH,
      url,
      title,
    };
  }

  let lastSize = 0;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (fs.existsSync(SNAPSHOT_HTML_PATH)) {
      const stat = fs.statSync(SNAPSHOT_HTML_PATH);
      if (stat.size > 2000 && stat.size === lastSize) {
        break;
      }
      lastSize = stat.size;
    }
  }

  try {
    if (fs.existsSync(SNAPSHOT_FILES_DIR)) {
      fs.rmSync(SNAPSHOT_FILES_DIR, { recursive: true, force: true });
    }
  } catch {
    // Ignore
  }

  if (!fs.existsSync(SNAPSHOT_HTML_PATH)) {
    return null;
  }

  return {
    htmlPath: SNAPSHOT_HTML_PATH,
    url: url || '',
    title: title || '',
  };
}

/**
 * Exports a complete DOM + Declarative Shadow DOM (`<template shadowrootmode="open">`) snapshot
 * of the active lab tab from the user's logged-in Google Chrome window.
 */
export async function snapshotUserChromeLabTab(
  preferredUrl?: string,
  preferredTarget?: { windowId: number; tabIndex: number } | null
): Promise<{ htmlPath: string; url: string; title: string } | null> {
  if (preferredTarget) {
    const byTarget = await snapshotUserChromeTabByTarget(
      preferredTarget.windowId,
      preferredTarget.tabIndex
    );
    if (byTarget) return byTarget;
  }

  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  if (process.platform !== 'darwin' && macBridgeHub.isConnected()) {
    try {
      const remoteSnap = await macBridgeHub.invoke<{
        htmlContent: string;
        url: string;
        title: string;
      } | null>('snapshot_lab_tab', { preferredUrl, preferredTarget }, 30000);
      if (remoteSnap && remoteSnap.htmlContent) {
        fs.writeFileSync(SNAPSHOT_HTML_PATH, remoteSnap.htmlContent, 'utf8');
        return {
          htmlPath: SNAPSHOT_HTML_PATH,
          url: remoteSnap.url,
          title: remoteSnap.title,
        };
      }
    } catch {
      // Fall through
    }
  }

  const tabs = await listUserChromeTabs();
  const labTab = tabs.find((t) => t.suggestedRole === 'lab');
  if (labTab) {
    return snapshotUserChromeTabByTarget(labTab.windowId, labTab.tabIndex);
  }

  const seedSnapshotPath = path.resolve(process.cwd(), 'server/seed_lab_snapshot.html');
  if (fs.existsSync(seedSnapshotPath)) {
    return {
      htmlPath: seedSnapshotPath,
      url: preferredUrl || 'https://partner.skills.google/focuses/130021?parent=catalog',
      title: 'Deploy an Agent with Agent Development Kit (ADK): Challenge Lab | Google Skills for Partners',
    };
  }
  return null;
}

/**
 * Navigates an existing tab (or opens a new tab) inside a user's selected Chrome window (e.g. Incognito Console window).
 */
export async function navigateOrOpenInUserChromeWindow(
  windowId: number,
  tabIndex: number | null,
  url: string,
  openInNewTab = false
): Promise<boolean> {
  if (process.platform !== 'darwin' && macBridgeHub.isConnected()) {
    return macBridgeHub
      .invoke<boolean>('navigate_tab', { windowId, tabIndex, url, openInNewTab })
      .catch(() => false);
  }

  const escapedUrl = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${windowId}" then
      if ${openInNewTab ? 'true' : 'false'} or ${tabIndex === null ? 'true' : 'false'} then
        make new tab at end of tabs of w with properties {URL:"${escapedUrl}"}
        set active tab index of w to (count of tabs of w)
      else
        if ${tabIndex || 1} <= (count of tabs of w) then
          set URL of tab ${tabIndex || 1} of w to "${escapedUrl}"
          set active tab index of w to ${tabIndex || 1}
        end if
      end if
      set index of w to 1
      activate
      return "ok"
    end if
  end repeat
  return "not_found"
end tell
`;
  const res = await runAppleScript(script).catch(() => '');
  return res === 'ok';
}

async function setClipboardText(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('pbcopy');
    proc.on('error', reject);
    proc.on('close', () => resolve());
    proc.stdin.write(text, 'utf8');
    proc.stdin.end();
  });
}

async function getClipboardText(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('pbpaste', [], { timeout: 3000 });
    return stdout;
  } catch {
    return '';
  }
}

/**
 * Sends a command or Antigravity prompt directly into the user's selected Google Chrome tab
 * (e.g., Cloud Shell or Antigravity CLI inside their authenticated Incognito window).
 * Focuses the selected window/tab, pastes the text cleanly via macOS clipboard + System Events,
 * presses Return if requested, and restores the user's previous clipboard.
 */
export async function sendTextToUserChromeTab(
  windowId: number,
  tabIndex: number,
  text: string,
  pressEnter = true,
  onLog?: (msg: string) => void
): Promise<boolean> {
  if (process.platform !== 'darwin' && macBridgeHub.isConnected()) {
    return macBridgeHub
      .invoke<boolean>('send_text', { windowId, tabIndex, text, pressEnter })
      .catch(() => false);
  }

  const focused = await focusUserChromeTab(windowId, tabIndex);
  if (!focused) {
    if (onLog) {
      onLog(`Could not locate selected Chrome window (${windowId}:${tabIndex}).`);
    }
    return false;
  }

  const prevClip = await getClipboardText();
  await setClipboardText(text);

  await new Promise((r) => setTimeout(r, 350));

  const keystrokeScript = `
tell application "Google Chrome" to activate
delay 0.2
tell application "System Events"
  tell process "Google Chrome"
    keystroke "v" using {command down}
    ${pressEnter ? 'delay 0.25\n    key code 36' : ''}
  end tell
end tell
`;

  try {
    await runAppleScript(keystrokeScript);
    await new Promise((r) => setTimeout(r, 350));
    await setClipboardText(prevClip);
    return true;
  } catch (err: any) {
    await setClipboardText(prevClip);
    if (onLog) {
      onLog(`Native Chrome paste warning: ${err?.message || String(err)}`);
    }
    return false;
  }
}

/**
 * Executes JavaScript in the user's Google Chrome lab tab if `View > Developer > Allow JavaScript from Apple Events`
 * is enabled. Returns `{ ok: false }` gracefully if disabled.
 */
export async function executeJsInUserChromeLabTab(
  jsCode: string,
  preferredUrl?: string
): Promise<{ ok: boolean; result?: string; error?: string }> {
  let pathKey = '';
  if (preferredUrl) {
    try {
      const u = new URL(preferredUrl);
      if (u.pathname && u.pathname !== '/') pathKey = u.pathname;
    } catch {
      // Ignore
    }
  }
  const escapedPathKey = pathKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedJs = jsCode.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const script = `
tell application "Google Chrome"
  repeat with wIdx from 1 to count of windows
    set w to window wIdx
    repeat with tIdx from 1 to count of tabs of w
      set t to tab tIdx of w
      set u to URL of t
      if ("${escapedPathKey}" is not "" and u contains "${escapedPathKey}") or ("${escapedPathKey}" is "" and (u contains "skills.google" or u contains "cloudskillsboost.google" or u contains "qwiklabs.com")) then
        set res to execute t javascript "${escapedJs}"
        return res as string
      end if
    end repeat
  end repeat
  return ""
end tell
`;

  try {
    const result = await runAppleScript(script);
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Clicks "Start Lab" in the user's Google Chrome tab via AppleScript JS execution or macOS System Events Accessibility.
 */
export async function clickStartLabInUserChrome(
  preferredUrl?: string,
  preferredTarget?: { windowId: number; tabIndex: number } | null
): Promise<boolean> {
  if (process.platform !== 'darwin') {
    if (!macBridgeHub.isConnected()) return false;
    return macBridgeHub
      .invoke<boolean>('start_lab', { preferredUrl, preferredTarget }, 30000)
      .catch(() => false);
  }

  let target = preferredTarget || null;
  if (!target) {
    const tabs = await listUserChromeTabs();
    const labTab = tabs.find((t) => t.suggestedRole === 'lab');
    if (labTab) {
      target = { windowId: labTab.windowId, tabIndex: labTab.tabIndex };
    }
  }
  if (target) {
    await focusUserChromeTab(target.windowId, target.tabIndex);
  }

  const js = `
    (() => {
      const hdr = document.querySelector('ql-lab-header');
      const btn = hdr?.shadowRoot?.querySelector('ql-lab-control-button') || document.querySelector('ql-lab-control-button');
      const inner = btn?.shadowRoot?.querySelector('ql-button') || btn;
      const nativeBtn = inner?.shadowRoot?.querySelector('md-filled-button, button') || inner;
      if (nativeBtn) { nativeBtn.click(); return 'clicked'; }
      return 'not_found';
    })()
  `;
  const res = await executeJsInUserChromeLabTab(js, preferredUrl);
  if (res.ok && res.result === 'clicked') {
    return true;
  }

  const axScript = `
tell application "Google Chrome" to activate
delay 0.3
tell application "System Events"
  tell process "Google Chrome"
    try
      set value of attribute "AXEnhancedUserInterface" to true
    end try
    delay 0.3
    repeat with w in windows
      if (name of w) contains "Google Chrome" then
        set allElems to entire contents of w
        repeat with el in allElems
          try
            if (role of el) is "AXButton" then
              set nm to (name of el) as string
              if nm starts with "Start Lab" or nm is "Start" then
                click el
                delay 1.2
                -- Check if a secondary confirmation or credit launch button appeared
                set followElems to entire contents of w
                repeat with fel in followElems
                  try
                    if (role of fel) is "AXButton" then
                      set fnm to (name of fel) as string
                      if fnm is "Confirm" or fnm starts with "Launch with" then
                        click fel
                        exit repeat
                      end if
                    end if
                  end try
                end repeat
                return "clicked"
              end if
            end if
          end try
        end repeat
      end if
    end repeat
  end tell
end tell
return "not_found"
`;
  const axRes = await runAppleScript(axScript).catch(() => '');
  return axRes === 'clicked';
}

/**
 * Clicks "End Lab" and confirms the "Are you sure?" dialog in the user's Google Chrome Lab tab
 * via AppleScript JS execution or macOS System Events Accessibility.
 */
export async function clickEndLabInUserChrome(
  preferredUrl?: string,
  preferredTarget?: { windowId: number; tabIndex: number } | null
): Promise<{ ended: boolean; message: string }> {
  if (process.platform !== 'darwin') {
    if (!macBridgeHub.isConnected()) {
      return {
        ended: false,
        message: 'Mac Chrome Bridge is not connected — cannot click End Lab in Chrome.',
      };
    }
    try {
      const res = await macBridgeHub.invoke<{ ended: boolean; message: string }>(
        'end_lab',
        { preferredUrl, preferredTarget },
        30000
      );
      if (res && typeof res.ended === 'boolean') {
        return res;
      }
    } catch (err: any) {
      return {
        ended: false,
        message: `End Lab RPC failed: ${err?.message || String(err)}`,
      };
    }
    return { ended: false, message: 'End Lab did not return a status.' };
  }

  let target = preferredTarget || null;
  if (!target) {
    const tabs = await listUserChromeTabs();
    const labTab = tabs.find((t) => t.suggestedRole === 'lab');
    if (labTab) {
      target = { windowId: labTab.windowId, tabIndex: labTab.tabIndex };
    }
  }
  if (target) {
    await focusUserChromeTab(target.windowId, target.tabIndex);
  }

  const js = `
    (() => {
      if (window.ql && window.ql.labRun && typeof window.ql.labRun.stopLab === 'function') {
        window.ql.labRun.stopLab();
        return 'ended_via_ql';
      }
      const hdr = document.querySelector('ql-lab-header');
      const btn = hdr?.shadowRoot?.querySelector('ql-lab-control-button') || document.querySelector('ql-lab-control-button');
      const inner = btn?.shadowRoot?.querySelector('ql-button') || btn;
      const nativeBtn = inner?.shadowRoot?.querySelector('md-filled-button, button') || inner;
      if (nativeBtn) {
        nativeBtn.click();
        setTimeout(() => {
          const confirmBtn = document.querySelector('#js-are-you-sure-button');
          const confirmNative = confirmBtn?.shadowRoot?.querySelector('md-text-button, button') || confirmBtn;
          if (confirmNative) confirmNative.click();
        }, 400);
        return 'clicked_end';
      }
      return 'not_found';
    })()
  `;
  const jsRes = await executeJsInUserChromeLabTab(js, preferredUrl);
  if (jsRes.ok && (jsRes.result === 'ended_via_ql' || jsRes.result === 'clicked_end')) {
    await new Promise((r) => setTimeout(r, 1200));
    return { ended: true, message: 'Lab ended in Google Chrome.' };
  }

  const axScript = `
tell application "Google Chrome" to activate
delay 0.3
tell application "System Events"
  tell process "Google Chrome"
    try
      set value of attribute "AXEnhancedUserInterface" to true
    end try
    delay 0.3
    repeat with w in windows
      if (name of w) contains "Google Chrome" then
        set allElems to entire contents of w
        set clickedPrimary to false
        repeat with el in allElems
          try
            if (role of el) is "AXButton" then
              set nm to (name of el) as string
              if nm is "End Lab" then
                click el
                set clickedPrimary to true
                exit repeat
              end if
            end if
          end try
        end repeat
        if clickedPrimary is true then
          delay 0.9
          set dialogElems to entire contents of w
          set lastEndBtn to missing value
          repeat with del in dialogElems
            try
              if (role of del) is "AXButton" then
                set dnm to (name of del) as string
                if dnm is "End Lab" or dnm is "Confirm" or dnm is "Submit" then
                  set lastEndBtn to del
                end if
              end if
            end try
          end repeat
          if lastEndBtn is not missing value then
            click lastEndBtn
            delay 0.8
          end if
          -- Dismiss optional review dialog if opened
          try
            set revElems to entire contents of w
            repeat with rel in revElems
              try
                if (role of rel) is "AXButton" then
                  set rnm to (name of rel) as string
                  if rnm is "Cancel" then
                    click rel
                    exit repeat
                  end if
                end if
              end try
            end repeat
          end try
          return "ended"
        else
          repeat with el in allElems
            try
              if (role of el) is "AXButton" then
                set nm to (name of el) as string
                if nm starts with "Start Lab" or nm is "Start" then
                  return "already_ended"
                end if
              end if
            end try
          end repeat
        end if
      end if
    end repeat
  end tell
end tell
return "not_found"
`;
  const axRes = await runAppleScript(axScript).catch(() => '');
  if (axRes === 'ended' || axRes === 'already_ended') {
    return {
      ended: true,
      message:
        axRes === 'already_ended'
          ? 'Lab is already ended in Google Chrome.'
          : 'Clicked "End Lab" and confirmed termination in Google Chrome.',
    };
  }
  return {
    ended: false,
    message: 'Could not locate an active "End Lab" button in the selected Chrome tab.',
  };
}

/**
 * Triggers Qwiklabs' live assessment grader (`/assessments/run_step.json?id=${labInstanceId}&step=${stepNumber}`)
 * in the user's Google Chrome Lab tab and returns the real score and verification message.
 */
export async function clickCheckProgressInUserChrome(
  stepNumber: number,
  preferredUrl?: string,
  options?: {
    labInstanceId?: string;
    windowId?: number;
    tabIndex?: number;
  }
): Promise<{
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
}> {
  const stepNo = Math.max(1, Number(stepNumber) || 1);

  if (process.platform !== 'darwin') {
    if (!macBridgeHub.isConnected()) {
      return {
        verified: false,
        message: 'Mac Chrome Bridge is not connected — cannot trigger Check my progress.',
      };
    }
    try {
      const res = await macBridgeHub.invoke<any>(
        'check_progress',
        {
          stepNumber: stepNo,
          labUrl: preferredUrl,
          labInstanceId: options?.labInstanceId,
          windowId: options?.windowId,
          tabIndex: options?.tabIndex,
        },
        30000
      );
      if (res && typeof res.verified === 'boolean') {
        return res;
      }
    } catch (err: any) {
      return {
        verified: false,
        message: `Check my progress RPC failed: ${err?.message || String(err)}`,
      };
    }
    return {
      verified: false,
      message: 'Check my progress did not return a valid status.',
    };
  }

  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  let targetWindowId = Number(options?.windowId) || 0;
  let targetTabIndex = Number(options?.tabIndex) || 0;
  let resolvedLabUrl = String(preferredUrl || '');

  if (!targetWindowId || !resolvedLabUrl) {
    const tabs = await listUserChromeTabs();
    const labTab = tabs.find((t) => t.suggestedRole === 'lab');
    if (labTab) {
      if (!targetWindowId) targetWindowId = labTab.windowId;
      if (!targetTabIndex) targetTabIndex = labTab.tabIndex;
      if (!resolvedLabUrl) resolvedLabUrl = labTab.url;
    }
  }

  let resolvedInstanceId = String(options?.labInstanceId || '').trim();
  if (!resolvedInstanceId && fs.existsSync(SNAPSHOT_HTML_PATH)) {
    const html = fs.readFileSync(SNAPSHOT_HTML_PATH, 'utf8');
    const m = html.match(/labinstanceid="(\d+)"/i);
    if (m) resolvedInstanceId = m[1];
  }

  if (!resolvedInstanceId || !targetWindowId) {
    return {
      verified: false,
      message: 'Could not determine active Qwiklabs labinstanceid — ensure the Lab is started.',
    };
  }

  let origin = 'https://partner.skills.google';
  try {
    if (resolvedLabUrl) {
      origin = new URL(resolvedLabUrl).origin;
    }
  } catch {
    // Keep default origin
  }

  const checkUrl = `${origin}/assessments/run_step.json?id=${encodeURIComponent(
    resolvedInstanceId
  )}&step=${stepNo}`;
  const checkFilePath = path.join(SNAPSHOT_DIR, `ql_check_step_${stepNo}.html`);
  try {
    if (fs.existsSync(checkFilePath)) fs.unlinkSync(checkFilePath);
  } catch {
    // Ignore
  }

  const escapedCheckUrl = checkUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedCheckPath = checkFilePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const script = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${targetWindowId}" then
      set prevIdx to active tab index of w
      set checkTab to make new tab at end of tabs of w with properties {URL:"${escapedCheckUrl}"}
      delay 0.8
      repeat 40 times
        if (loading of checkTab) is false then exit repeat
        delay 0.25
      end repeat
      delay 0.4
      save checkTab in POSIX file "${escapedCheckPath}"
      delay 0.6
      close checkTab
      if prevIdx <= (count of tabs of w) then
        set active tab index of w to prevIdx
      end if
      return "ok"
    end if
  end repeat
  return "not_found"
end tell
`;
  await runAppleScript(script).catch(() => '');

  if (!fs.existsSync(checkFilePath)) {
    return {
      verified: false,
      message: `Triggered Check my progress for Step #${stepNo}, but could not read grader response.`,
    };
  }

  const rawHtml = fs.readFileSync(checkFilePath, 'utf8');
  const preMatch = rawHtml.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const jsonCandidate = (preMatch ? preMatch[1] : rawHtml).trim();

  try {
    const data = JSON.parse(jsonCandidate);
    const idx = stepNo - 1;
    const stepCompleteList = Array.isArray(data.step_complete)
      ? data.step_complete.map(Boolean)
      : [];
    const stepScoresList = Array.isArray(data.step_scores)
      ? data.step_scores.map((v: any) => Number(v) || 0)
      : [];
    const stepPointsList = Array.isArray(data.step_points)
      ? data.step_points.map((v: any) => Number(v) || 0)
      : [];
    const studentMessagesList = Array.isArray(data.student_messages)
      ? data.student_messages.map((v: any) => String(v || '').trim())
      : [];

    const verified = Boolean(
      stepCompleteList[idx] === true ||
        data.step_done?.[idx] === true ||
        data.step_completion?.[idx]?.passed === true ||
        (stepPointsList[idx] > 0 && stepScoresList[idx] >= stepPointsList[idx])
    );
    const stepScore = stepScoresList[idx] ?? 0;
    const stepMaxScore = stepPointsList[idx] ?? 0;
    const totalScore = Number(data.total_score ?? 0);
    const maxScore = Number(data.perfect_score ?? 100);
    const rawMsg =
      studentMessagesList[idx] ||
      data.messages?.[idx] ||
      data.step_completion?.[idx]?.message ||
      '';
    const message =
      rawMsg ||
      (verified
        ? `Assessment Completed! (${stepScore}/${stepMaxScore} pts — Total: ${totalScore}/${maxScore})`
        : `Assessment incomplete (${stepScore}/${stepMaxScore} pts).`);

    return {
      verified,
      message,
      stepScore,
      stepMaxScore,
      totalScore,
      maxScore,
      stepCompleteList,
      stepScoresList,
      stepPointsList,
      studentMessagesList,
    };
  } catch {
    return {
      verified: false,
      message: `Unable to parse Qwiklabs assessment JSON for Step #${stepNo}.`,
    };
  }
}

/**
 * Completes a Google OAuth2 login flow (`gcloud auth login`) headlessly using Playwright Chromium
 * with `--disable-blink-features=AutomationControlled` and returns the `http://localhost:<port>/?code=...`
 * redirect URL so the Mac Bridge's isolated `gcloud` CLI can finish authentication without opening any windows.
 */
async function completeOAuthUrlWithPlaywright(
  oauthUrl: string,
  username: string,
  password: string
): Promise<string | null> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    let capturedLocalhostUrl: string | null = null;

    page.on('request', (req) => {
      const u = req.url();
      if (u.startsWith('http://localhost:') || u.startsWith('http://127.0.0.1:')) {
        capturedLocalhostUrl = u;
      }
    });

    await page.goto(oauthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const emailSel = '#identifierId, input[name="identifier"], input[type="email"]';
    await page.waitForSelector(emailSel, { timeout: 15000 });
    await page.fill(emailSel, username);
    await page.keyboard.press('Enter');

    const passSel = 'input[name="Passwd"]:visible, input[type="password"]:visible';
    await page.waitForSelector(passSel, { timeout: 15000 });
    await page.fill(passSel, password);
    await page.keyboard.press('Enter');

    for (let i = 0; i < 14; i++) {
      if (capturedLocalhostUrl) return capturedLocalhostUrl;
      await page.waitForTimeout(1400);
      if (capturedLocalhostUrl) return capturedLocalhostUrl;
      const curUrl = page.url();
      if (curUrl.startsWith('http://localhost:') || curUrl.startsWith('http://127.0.0.1:')) {
        return curUrl;
      }

      const btns = page.locator(
        'button:has-text("I understand"), input#confirm, button:has-text("Continue"), button:has-text("Allow"), #submit_approve_access'
      );
      const count = await btns.count();
      for (let b = count - 1; b >= 0; b--) {
        const el = btns.nth(b);
        if (await el.isVisible().catch(() => false)) {
          await el.click().catch(() => {});
          break;
        }
      }
    }
    return capturedLocalhostUrl;
  } catch {
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

export interface CloudShellExecOptions {
  command: string;
  username: string;
  password: string;
  projectId: string;
  onProgress?: (msg: string) => void;
  timeoutMs?: number;
}

/**
 * Executes a shell command or multi-line script directly inside the student's Google Cloud Shell VM
 * over SSH (`gcloud cloud-shell ssh --authorize-session --command=...`), automatically authenticating
 * an isolated `CLOUDSDK_CONFIG` for the student if needed.
 *
 * Accepts either a `CloudShellExecOptions` object or positional `(username, password, projectId, command, onLog, timeoutMs)` parameters.
 */
export async function execInStudentCloudShellBridge(
  arg1: string | CloudShellExecOptions,
  arg2?: string,
  arg3?: string,
  arg4?: string,
  arg5?: (msg: string) => void,
  arg6 = 240000
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const isObj = typeof arg1 === 'object' && arg1 !== null;
  const username = isObj ? String(arg1.username || '') : String(arg1 || '');
  const password = isObj ? String(arg1.password || '') : String(arg2 || '');
  const projectId = isObj ? String(arg1.projectId || '') : String(arg3 || '');
  const command = isObj ? String(arg1.command || '') : String(arg4 || '');
  const onLog = isObj ? arg1.onProgress : arg5;
  const timeoutMs = isObj ? Number(arg1.timeoutMs || 240000) : arg6;

  if (!username || !password) {
    return {
      ok: false,
      stdout: '',
      stderr: 'Missing student username or password for Cloud Shell SSH.',
      exitCode: -1,
    };
  }

  // Remote Cloud Run -> Mac Bridge path
  if (process.platform !== 'darwin') {
    if (!macBridgeHub.isConnected()) {
      return {
        ok: false,
        stdout: '',
        stderr: 'Mac Chrome Bridge is not connected.',
        exitCode: -1,
      };
    }

    try {
      const authCheck = await macBridgeHub.invoke<any>('check_gcloud_auth', {
        username,
        projectId,
      });
      if (!authCheck?.authenticated) {
        if (onLog) {
          onLog(`Authenticating isolated Cloud Shell SSH session for ${username}...`);
        }
        const started = await macBridgeHub.invoke<any>('start_gcloud_auth', {
          username,
          projectId,
        });
        if (!started?.alreadyAuthenticated && started?.oauthUrl) {
          const callbackUrl = await completeOAuthUrlWithPlaywright(
            started.oauthUrl,
            username,
            password
          );
          if (callbackUrl) {
            await macBridgeHub.invoke('finish_gcloud_auth', {
              username,
              callbackUrl,
            });
          }
        }
      }

      const execRes = await macBridgeHub.invoke<any>(
        'exec_cloud_shell',
        {
          username,
          projectId,
          command,
          timeoutMs,
        },
        timeoutMs + 15000
      );
      return {
        ok: Boolean(execRes?.ok),
        stdout: String(execRes?.stdout || ''),
        stderr: String(execRes?.stderr || ''),
        exitCode: Number(execRes?.exitCode ?? (execRes?.ok ? 0 : 1)),
      };
    } catch (err: any) {
      return {
        ok: false,
        stdout: '',
        stderr: err?.message || String(err),
        exitCode: 1,
      };
    }
  }

  // Local macOS path
  const safeUser = username.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const candidateDirs = [
    path.join(SNAPSHOT_DIR, `gcloud-${safeUser}`),
    '/tmp/ql_student_gcloud',
  ];
  let activeConfigDir = candidateDirs[0];
  fs.mkdirSync(activeConfigDir, { recursive: true });

  let isAuthed = false;
  let hostAccessToken = '';
  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const { stdout } = await execFileAsync(
        'gcloud',
        ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
        { env: { ...process.env, CLOUDSDK_CONFIG: dir }, timeout: 8000 }
      );
      if (stdout.trim().toLowerCase() === username.toLowerCase()) {
        const { stdout: tokenOut } = await execFileAsync(
          'gcloud',
          ['auth', 'print-access-token', '--quiet'],
          { env: { ...process.env, CLOUDSDK_CONFIG: dir }, timeout: 8000 }
        );
        if (tokenOut.trim().length > 10) {
          activeConfigDir = dir;
          isAuthed = true;
          hostAccessToken = tokenOut.trim();
          break;
        }
      }
    } catch {
      // Ignore expired or invalid config dir
    }
  }

  if (!isAuthed) {
    if (onLog) {
      onLog(`Authenticating isolated Cloud Shell SSH session for ${username}...`);
    }
    await new Promise<void>((resolve) => {
      const args = ['auth', 'login', '--enable-gdrive-access', '--quiet'];
      if (projectId) args.push(`--project=${projectId}`);
      const proc = spawn('gcloud', args, {
        env: { ...process.env, CLOUDSDK_CONFIG: activeConfigDir, BROWSER: '/usr/bin/true' },
      });
      let out = '';
      let handled = false;
      const onData = async (chunk: Buffer) => {
        out += chunk.toString();
        const m = out.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s"]+/);
        if (m && !handled) {
          handled = true;
          const cbUrl = await completeOAuthUrlWithPlaywright(m[0], username, password);
          if (cbUrl) {
            await fetch(cbUrl).catch(() => {});
          }
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('close', () => resolve());
      setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        resolve();
      }, 30000);
    });
    try {
      const { stdout: tokenOut } = await execFileAsync(
        'gcloud',
        ['auth', 'print-access-token', '--quiet'],
        { env: { ...process.env, CLOUDSDK_CONFIG: activeConfigDir }, timeout: 8000 }
      );
      hostAccessToken = tokenOut.trim();
    } catch {}
  }

  if (projectId) {
    await execFileAsync('gcloud', ['config', 'set', 'project', projectId, '--quiet'], {
      env: { ...process.env, CLOUDSDK_CONFIG: activeConfigDir },
      timeout: 8000,
    }).catch(() => {});
  }

  try {
    const envPrefix = hostAccessToken
      ? `export DRIVE_ACCESS_TOKEN="${hostAccessToken}"; `
      : '';
    const { stdout, stderr } = await execFileAsync(
      'gcloud',
      ['cloud-shell', 'ssh', '--authorize-session', `--command=${envPrefix}${command}`, '--quiet'],
      {
        env: { ...process.env, CLOUDSDK_CONFIG: activeConfigDir },
        timeout: timeoutMs,
        maxBuffer: 15 * 1024 * 1024,
      }
    );
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err: any) {
    return {
      ok: false,
      stdout: String(err?.stdout || '').trim(),
      stderr: String(err?.stderr || err?.message || err).trim(),
      exitCode: Number(err?.code || 1),
    };
  }
}

/**
 * Inspects the student's live Google Cloud Shell workspace (`~`), listing project directories
 * and reading relevant source/config files (`.py`, `.json`, `.yaml`, `.tf`, `.env`, `requirements.txt`, etc.)
 * so Gemini can synthesize 100% accurate scripts for ANY lab without guessing file paths or starter code.
 */
export async function inspectStudentCloudShellWorkspace(params: {
  username: string;
  password: string;
  projectId: string;
  onProgress?: (msg: string) => void;
}): Promise<string> {
  const probeScript = `python3 -c '
import os, glob, subprocess

home = os.path.expanduser("~")
ignore_dirs = {"venv", "node_modules", "__pycache__", "google-cloud-sdk"}

files_found = []
for root, dirs, files in os.walk(home):
    dirs[:] = sorted([d for d in dirs if d not in ignore_dirs and not d.startswith(".")])
    rel_root = os.path.relpath(root, home)
    depth = 0 if rel_root == "." else rel_root.count(os.sep) + 1
    if depth > 4:
        dirs[:] = []
        continue
    for f in sorted(files):
        if f.startswith(".") and f not in {".env", ".customize_environment"}:
            continue
        full_p = os.path.join(root, f)
        rel_p = os.path.relpath(full_p, home)
        files_found.append(rel_p)

print("=== HOME DIRECTORY FILE TREE ===")
for p in files_found[:120]:
    print("~/" + p)

exts = (".py", ".json", ".yaml", ".yml", ".tf", ".tfvars", ".sh", ".sql", ".env", ".md", "requirements.txt", "Dockerfile", "Makefile", "pyproject.toml")
total_bytes = 0
print("\\n=== KEY WORKSPACE FILE CONTENTS ===")
for rel_p in files_found:
    if rel_p in {"package-lock.json", "uv.lock", "poetry.lock", "README-cloudshell.txt"} or rel_p.endswith(".tfstate") or rel_p.endswith(".tfstate.backup"):
        continue
    if any(rel_p.endswith(ext) for ext in exts):
        full_p = os.path.join(home, rel_p)
        try:
            sz = os.path.getsize(full_p)
            if sz > 0 and sz <= 24000 and total_bytes < 55000:
                with open(full_p, "r", errors="replace") as fh:
                    content = fh.read()
                print(f"\\n--- FILE: ~/{rel_p} ({sz} bytes) ---")
                print(content)
                total_bytes += len(content)
        except Exception:
            pass

adk_bins = glob.glob(os.path.join(home, "*", ".venv", "bin", "adk")) + glob.glob(os.path.join(home, ".local", "bin", "adk"))
if adk_bins:
    adk_bin = adk_bins[0]
    print(f"\\n=== ADK CLI HELP ({adk_bin}) ===")
    for sub in [["--help"], ["eval", "--help"], ["eval_set", "create", "--help"], ["eval_set", "add_eval_case", "--help"]]:
        try:
            cmd_str = " ".join(sub)
            out = subprocess.check_output([adk_bin] + sub, text=True, stderr=subprocess.STDOUT, timeout=8)
            print(f"$ adk {cmd_str}\\n{out.strip()}")
        except Exception:
            pass
'`;

  const res = await execInStudentCloudShellBridge({
    command: probeScript,
    username: params.username,
    password: params.password,
    projectId: params.projectId,
    onProgress: params.onProgress,
    timeoutMs: 45000,
  });

  if (res.stdout) {
    return res.stdout;
  }
  return res.stderr ? `Workspace probe warning: ${res.stderr}` : '';
}


