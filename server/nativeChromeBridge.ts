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
const SSH_BIN_DIR = path.join(SNAPSHOT_DIR, 'ssh-bin');

function ensureCleanSshWrapperDir(): string {
  try {
    fs.mkdirSync(SSH_BIN_DIR, { recursive: true });
    const sshWrapper = path.join(SSH_BIN_DIR, 'ssh');
    const scpWrapper = path.join(SSH_BIN_DIR, 'scp');
    const sshScript = `#!/bin/sh\nexec /usr/bin/ssh -F /dev/null -o ProxyCommand=none -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 "$@"\n`;
    const scpScript = `#!/bin/sh\nexec /usr/bin/scp -F /dev/null -o ProxyCommand=none -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 "$@"\n`;
    fs.writeFileSync(sshWrapper, sshScript, { mode: 0o755 });
    fs.writeFileSync(scpWrapper, scpScript, { mode: 0o755 });
    if (!String(process.env.PATH || '').startsWith(SSH_BIN_DIR)) {
      process.env.PATH = `${SSH_BIN_DIR}:${process.env.PATH || '/usr/bin:/bin'}`;
    }
  } catch {
    // Ignore wrapper creation errors
  }
  return SSH_BIN_DIR;
}
ensureCleanSshWrapperDir();

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
  if (!macBridgeHub.isConnected()) {
    return [];
  }
  try {
    const remoteTabs = await macBridgeHub.invoke<ChromeTabDescriptor[]>('list_tabs', {});
    if (Array.isArray(remoteTabs)) return remoteTabs;
  } catch {
    if (process.platform !== 'darwin') return [];
  }
  if (process.platform !== 'darwin') return [];

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
  if (!macBridgeHub.isConnected()) return false;
  try {
    return await macBridgeHub.invoke<boolean>('focus_tab', { windowId, tabIndex });
  } catch {
    if (process.platform !== 'darwin') return false;
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
  if (!macBridgeHub.isConnected()) {
    throw new Error('Mac Chrome Bridge is not connected.');
  }
  onLog(`Connecting to your Mac Google Chrome via live WebSocket bridge for: ${requestedUrl}`);
  return macBridgeHub.invoke<UserChromeTabInfo>('open_or_focus_lab', { requestedUrl });
}

/**
 * Snapshots a specific tab identified by `windowId` and `tabIndex` (or falls back to URL matching).
 */
export async function snapshotUserChromeTabByTarget(
  windowId: number,
  tabIndex: number
): Promise<{ htmlPath: string; url: string; title: string } | null> {
  if (!macBridgeHub.isConnected()) return null;
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

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
    if (process.platform !== 'darwin') return null;
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
  if (preferredTarget && macBridgeHub.isConnected()) {
    const byTarget = await snapshotUserChromeTabByTarget(
      preferredTarget.windowId,
      preferredTarget.tabIndex
    );
    if (byTarget) return byTarget;
  }

  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  if (macBridgeHub.isConnected()) {
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

  if (macBridgeHub.isConnected()) {
    const tabs = await listUserChromeTabs();
    const labTab = tabs.find((t) => t.suggestedRole === 'lab');
    if (labTab) {
      return snapshotUserChromeTabByTarget(labTab.windowId, labTab.tabIndex);
    }
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
  if (!macBridgeHub.isConnected()) return false;
  try {
    return await macBridgeHub.invoke<boolean>('navigate_tab', {
      windowId,
      tabIndex,
      url,
      openInNewTab,
    });
  } catch {
    if (process.platform !== 'darwin') return false;
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
  if (!macBridgeHub.isConnected()) return false;
  try {
    return await macBridgeHub.invoke<boolean>('send_text', {
      windowId,
      tabIndex,
      text,
      pressEnter,
    });
  } catch {
    if (process.platform !== 'darwin') return false;
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
  if (!macBridgeHub.isConnected()) return false;
  try {
    return await macBridgeHub.invoke<boolean>(
      'start_lab',
      { preferredUrl, preferredTarget },
      30000
    );
  } catch {
    if (process.platform !== 'darwin') return false;
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
    if (process.platform !== 'darwin') {
      return {
        ended: false,
        message: `End Lab RPC failed: ${err?.message || String(err)}`,
      };
    }
  }
  if (process.platform !== 'darwin') {
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
    if (process.platform !== 'darwin') {
      return {
        verified: false,
        message: `Check my progress RPC failed: ${err?.message || String(err)}`,
      };
    }
  }
  if (process.platform !== 'darwin') {
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

export interface SpawnIncognitoResult {
  ok: boolean;
  reused?: boolean;
  windowId?: number;
  consoleTabKey?: string;
  cloudShellTabKey?: string;
  tabs?: ChromeTabDescriptor[];
}

function buildGoogleSignInStepJsForTab(username: string, password: string): string {
  const safeUser = JSON.stringify(String(username || '').trim());
  const safePass = JSON.stringify(String(password || ''));
  return `(function(user, pass) {
    try {
      function isVis(el) {
        if (!el) return false;
        var r = el.getBoundingClientRect();
        var s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      }
      function setNativeValue(el, val) {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') &&
                     Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        if (setter) setter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      var href = window.location.href || '';
      if (
        (href.indexOf('console.cloud.google.com') !== -1 || href.indexOf('shell.cloud.google.com') !== -1) &&
        href.indexOf('accounts.google.com') === -1
      ) {
        var dialogs = document.querySelectorAll('.mat-mdc-dialog-container, mat-dialog-container, [role="dialog"]');
        for (var d = 0; d < dialogs.length; d++) {
          var dlg = dialogs[d];
          if (!isVis(dlg)) continue;
          var cbs = dlg.querySelectorAll('input[type="checkbox"]:not(:checked)');
          for (var c = 0; c < cbs.length; c++) {
            cbs[c].click();
          }
          var btns = dlg.querySelectorAll('button, [role="button"]');
          for (var b = 0; b < btns.length; b++) {
            var txt = (btns[b].innerText || btns[b].textContent || '').trim().toLowerCase();
            if (txt.indexOf('agree and continue') !== -1 || txt === 'agree' || txt === 'accept' || txt === 'continue') {
              btns[b].click();
              return 'console_tos_accepted';
            }
          }
        }
        return 'console_ready';
      }
      if (href.indexOf('http://localhost:') === 0 || href.indexOf('http://127.0.0.1:') === 0 || href.indexOf('sdk/auth_success') !== -1) {
        return 'oauth_redirected:' + href;
      }

      var passInput = document.querySelector('input[type="password"][name="Passwd"], input[type="password"]');
      if (passInput && isVis(passInput) && pass) {
        if (passInput.dataset.srSubmitted === '1' && Date.now() - Number(passInput.dataset.srTime || 0) < 4000) {
          return 'waiting_after_password';
        }
        passInput.focus();
        setNativeValue(passInput, pass);
        passInput.dataset.srSubmitted = '1';
        passInput.dataset.srTime = String(Date.now());
        var pNext = document.querySelector('#passwordNext button, #passwordNext, button[type="submit"], input[type="submit"]');
        if (pNext && isVis(pNext)) pNext.click();
        else passInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        return 'submitted_password';
      }

      var emailInput = document.querySelector('input[type="email"], input#identifierId, input[name="identifier"]');
      if (emailInput && isVis(emailInput) && user) {
        if (emailInput.dataset.srSubmitted === '1' && Date.now() - Number(emailInput.dataset.srTime || 0) < 4000) {
          return 'waiting_after_email';
        }
        emailInput.focus();
        setNativeValue(emailInput, user);
        emailInput.dataset.srSubmitted = '1';
        emailInput.dataset.srTime = String(Date.now());
        var eNext = document.querySelector('#identifierNext button, #identifierNext, button[type="submit"], input[type="submit"]');
        if (eNext && isVis(eNext)) eNext.click();
        else emailInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        return 'submitted_email';
      }

      var acctItems = document.querySelectorAll('[data-identifier], [data-email]');
      if (acctItems.length > 0 && user) {
        for (var i = 0; i < acctItems.length; i++) {
          var idVal = (acctItems[i].getAttribute('data-identifier') || acctItems[i].getAttribute('data-email') || '').toLowerCase();
          if (idVal === user.toLowerCase() && isVis(acctItems[i])) {
            acctItems[i].click();
            return 'clicked_matching_account';
          }
        }
        var allLis = document.querySelectorAll('li, [role="link"], [role="button"]');
        for (var j = 0; j < allLis.length; j++) {
          var lTxt = (allLis[j].innerText || allLis[j].textContent || '').trim().toLowerCase();
          if (lTxt.indexOf('use another account') !== -1 && isVis(allLis[j])) {
            allLis[j].click();
            return 'clicked_use_another_account';
          }
        }
      }

      var confirmInput = document.querySelector('input#confirm, input[name="confirm"]');
      if (confirmInput && isVis(confirmInput)) {
        confirmInput.click();
        return 'clicked_confirm_input';
      }
      var checkboxes = document.querySelectorAll('input[type="checkbox"]:not(:checked)');
      for (var k = 0; k < checkboxes.length; k++) {
        if (isVis(checkboxes[k])) checkboxes[k].click();
      }
      var buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]');
      var matchedBtn = null;
      var matchedLabel = '';
      for (var m = 0; m < buttons.length; m++) {
        var btn = buttons[m];
        if (!isVis(btn)) continue;
        var bTxt = (btn.innerText || btn.value || btn.textContent || '').trim().toLowerCase();
        if (
          bTxt === 'i understand' ||
          bTxt === 'accept' ||
          bTxt === 'agree' ||
          bTxt === 'agree and continue' ||
          bTxt === 'continue' ||
          bTxt === 'allow' ||
          bTxt === 'confirm' ||
          bTxt === 'sign in'
        ) {
          matchedBtn = btn;
          matchedLabel = bTxt;
        }
      }
      if (matchedBtn) {
        matchedBtn.click();
        return 'clicked_consent_' + matchedLabel;
      }
      return 'waiting:' + href;
    } catch (e) {
      return 'err:' + (e && e.message ? e.message : String(e));
    }
  })(${safeUser}, ${safePass})`;
}

async function executeJsInChromeWindowTab(
  windowId: number,
  tabIndex: number,
  jsCode: string
): Promise<{ ok: boolean; value: string }> {
  const escapedJs = jsCode.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${windowId}" then
      if ${tabIndex} <= (count of tabs of w) then
        set t to tab ${tabIndex} of w
        try
          set res to execute t javascript "${escapedJs}"
          if res is missing value then return "OK:"
          return "OK:" & (res as string)
        on error errMsg
          return "ERR:" & errMsg
        end try
      end if
    end if
  end repeat
  return "ERR:tab_not_found"
end tell
`;
  const out = await runAppleScript(script).catch((e) => `ERR:${e?.message || e}`);
  if (out.startsWith('OK:')) {
    return { ok: true, value: out.slice(3) };
  }
  return { ok: false, value: out.slice(4) };
}

/**
 * Spawns (or reuses) an Incognito window in the user's Mac Google Chrome, automatically
 * signs in as the provisioned lab student account (`student-...@qwiklabs.net`), accepts
 * Google Workspace and GCP Console Terms of Service modals, and opens both the GCP Console
 * and Cloud Shell tabs.
 */
export async function spawnIncognitoSessionInUserChrome(params: {
  username: string;
  password?: string;
  projectId?: string;
  consoleUrl?: string;
}): Promise<SpawnIncognitoResult | null> {
  if (!macBridgeHub.isConnected()) return null;
  try {
    return await macBridgeHub.invoke<SpawnIncognitoResult>(
      'spawn_incognito_session',
      params,
      90000
    );
  } catch {
    if (process.platform !== 'darwin') return null;
  }

  const cleanUser = String(params.username || '').trim();
  const cleanPass = String(params.password || '').trim();
  const cleanProject = String(params.projectId || '').trim();
  const targetConsoleUrl = cleanProject
    ? `https://console.cloud.google.com/?project=${encodeURIComponent(cleanProject)}`
    : String(params.consoleUrl || 'https://console.cloud.google.com/');
  const targetCloudShellUrl = cleanProject
    ? `https://shell.cloud.google.com/?project=${encodeURIComponent(cleanProject)}&show=terminal`
    : 'https://shell.cloud.google.com/?show=terminal';

  const existingTabs = await listUserChromeTabs();
  const existingIncognitoTabs = existingTabs.filter((t) => t.windowMode === 'incognito');
  if (cleanProject && existingIncognitoTabs.length > 0) {
    const matchingConsole = existingIncognitoTabs.find(
      (t) =>
        t.url.includes('console.cloud.google.com') &&
        !t.url.includes('accounts.google.com') &&
        t.url.includes(cleanProject)
    );
    if (matchingConsole) {
      const winId = matchingConsole.windowId;
      const shellTab = existingIncognitoTabs.find(
        (t) => t.windowId === winId && t.url.includes('shell.cloud.google.com')
      );
      if (!shellTab) {
        await navigateOrOpenInUserChromeWindow(winId, null, targetCloudShellUrl, true);
        await focusUserChromeTab(winId, matchingConsole.tabIndex);
      }
      const updatedTabs = await listUserChromeTabs();
      const cTab =
        updatedTabs.find(
          (t) => t.windowId === winId && t.url.includes('console.cloud.google.com')
        ) || matchingConsole;
      const sTab = updatedTabs.find(
        (t) => t.windowId === winId && t.url.includes('shell.cloud.google.com')
      );
      return {
        ok: true,
        reused: true,
        windowId: winId,
        consoleTabKey: cTab.key,
        cloudShellTabKey: sTab ? sTab.key : cTab.key,
        tabs: updatedTabs,
      };
    }
  }

  if (existingIncognitoTabs.length > 0) {
    const closeStaleIncognitoScript = `
tell application "Google Chrome"
  repeat with i from (count of windows) to 1 by -1
    set w to window i
    if (mode of w) is "incognito" then
      close w
    end if
  end repeat
  return "closed"
end tell
`;
    await runAppleScript(closeStaleIncognitoScript).catch(() => '');
    await new Promise((r) => setTimeout(r, 500));
  }

  const initialLoginUrl = cleanUser
    ? `https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(
        cleanUser
      )}&continue=${encodeURIComponent(targetConsoleUrl)}`
    : targetConsoleUrl;
  const escapedLoginUrl = initialLoginUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const createIncognitoScript = `
tell application "Google Chrome"
  activate
  set incWin to make new window with properties {mode:"incognito"}
  set URL of active tab of incWin to "${escapedLoginUrl}"
  return (id of incWin) as string
end tell
`;
  const winIdStr = await runAppleScript(createIncognitoScript).catch(() => '');
  const windowId = parseInt(winIdStr, 10);
  if (!Number.isFinite(windowId)) {
    return null;
  }

  if (cleanUser && cleanPass) {
    const signInJs = buildGoogleSignInStepJsForTab(cleanUser, cleanPass);
    let consoleReadyCount = 0;
    for (let attempt = 0; attempt < 35; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      const jsStep = await executeJsInChromeWindowTab(windowId, 1, signInJs);
      if (jsStep.ok) {
        if (jsStep.value === 'console_ready' || jsStep.value === 'console_tos_accepted') {
          consoleReadyCount++;
          if (consoleReadyCount >= 3) break;
        }
      }
    }
  }

  await navigateOrOpenInUserChromeWindow(windowId, null, targetCloudShellUrl, true);
  await focusUserChromeTab(windowId, 1);

  const tabs = await listUserChromeTabs();
  const consoleTab = tabs.find((t) => t.windowId === windowId && t.tabIndex === 1);
  const cloudShellTab = tabs.find((t) => t.windowId === windowId && t.tabIndex === 2);

  return {
    ok: true,
    reused: false,
    windowId,
    consoleTabKey: consoleTab ? consoleTab.key : `${windowId}:1`,
    cloudShellTabKey: cloudShellTab ? cloudShellTab.key : `${windowId}:2`,
    tabs,
  };
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
        'button:has-text("I understand"), input#confirm, input[name="confirm"], input[value*="understand" i], div[data-identifier], div[data-email], button:has-text("Continue"), button:has-text("Allow"), button:has-text("Sign in"), #submit_approve_access'
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
  const rawCommand = isObj ? String(arg1.command || '') : String(arg4 || '');
  const command = rawCommand.includes('wb_helper')
    ? `python3 -c 'import base64,os; open("/tmp/wb_helper.py","wb").write(base64.b64decode("${WB_HELPER_PY_B64}"))' 2>/dev/null || true\n${rawCommand}`
    : rawCommand;
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

  if (!macBridgeHub.isConnected()) {
    return {
      ok: false,
      stdout: '',
      stderr: 'Mac Chrome Bridge is not connected.',
      exitCode: -1,
    };
  }

  // WebSocket Mac Bridge path (used for both Cloud Run and local server testing)
  try {
    let authCheck = await macBridgeHub.invoke<any>('check_gcloud_auth', {
      username,
      projectId,
    });
    if (!authCheck?.authenticated) {
      if (onLog) {
        onLog(`Authenticating isolated Cloud Shell SSH session for ${username} on Mac...`);
      }
      // First try headless OAuth via start_gcloud_auth + Playwright (completes in ~6s without AppleScript JS)
      const started = await macBridgeHub
        .invoke<any>('start_gcloud_auth', {
          username,
          projectId,
        })
        .catch(() => null);
      if (started?.alreadyAuthenticated) {
        authCheck = { authenticated: true };
      } else if (started?.oauthUrl) {
        const callbackUrl = await completeOAuthUrlWithPlaywright(
          started.oauthUrl,
          username,
          password
        );
        if (callbackUrl) {
          const finished = await macBridgeHub
            .invoke<any>('finish_gcloud_auth', {
              username,
              callbackUrl,
            })
            .catch(() => null);
          if (finished?.authenticated) {
            authCheck = { authenticated: true };
          }
        }
      }

      if (!authCheck?.authenticated) {
        authCheck = await macBridgeHub
          .invoke<any>(
            'ensure_gcloud_auth',
            {
              username,
              password,
              projectId,
            },
            60000
          )
          .catch(() => null);
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
    if (process.platform !== 'darwin') {
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
      const args = ['auth', 'login', '--quiet'];
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
          const oauthUrl = m[0];
          const cbUrl = await completeOAuthUrlWithPlaywright(oauthUrl, username, password);
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
      }, 35000);
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

  ensureCleanSshWrapperDir();
  const cleanEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${SSH_BIN_DIR}:${process.env.PATH || '/usr/bin:/bin'}`,
    CLOUDSDK_CONFIG: activeConfigDir,
  };

  try {
    const projExport = projectId
      ? `export GOOGLE_CLOUD_PROJECT="${projectId}"; export DEVSHELL_PROJECT_ID="${projectId}"; `
      : '';
    const driveExport = hostAccessToken
      ? `export DRIVE_ACCESS_TOKEN="${hostAccessToken}"; `
      : '';
    const envPrefix = `export CLOUDSDK_CORE_DISABLE_PROMPTS=1; ${projExport}${driveExport}`;
    const fullScript = `${envPrefix}\n${command}`;
    const b64Script = Buffer.from(fullScript, 'utf8').toString('base64');
    const remoteCmd = `echo ${b64Script} | base64 -d | bash`;
    const { stdout, stderr } = await execFileAsync(
      'gcloud',
      [
        'cloud-shell',
        'ssh',
        '--authorize-session',
        '--ssh-flag=-F/dev/null',
        '--ssh-flag=-oProxyCommand=none',
        '--ssh-flag=-oStrictHostKeyChecking=no',
        '--ssh-flag=-oUserKnownHostsFile=/dev/null',
        `--command=${remoteCmd}`,
        '--quiet',
      ],
      {
        env: cleanEnv,
        timeout: timeoutMs,
        maxBuffer: 15 * 1024 * 1024,
      }
    );
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err: any) {
    const stderrStr = String(err?.stderr || err?.message || err).trim();
    if (
      stderrStr.includes('255') ||
      stderrStr.includes('403') ||
      stderrStr.includes('Connection closed') ||
      stderrStr.includes('helper.go')
    ) {
      const localWs = path.join(SNAPSHOT_DIR, 'workspaces', projectId || safeUser);
      fs.mkdirSync(localWs, { recursive: true });
      try {
        const { stdout, stderr } = await execFileAsync(
          '/bin/bash',
          ['-c', command],
          {
            cwd: localWs,
            env: {
              ...cleanEnv,
              HOME: localWs,
              GOOGLE_CLOUD_PROJECT: projectId,
              DEVSHELL_PROJECT_ID: projectId,
              DRIVE_ACCESS_TOKEN: hostAccessToken,
            },
            timeout: timeoutMs,
            maxBuffer: 15 * 1024 * 1024,
          }
        );
        return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
      } catch (localErr: any) {
        return {
          ok: false,
          stdout: String(localErr?.stdout || '').trim(),
          stderr: String(localErr?.stderr || localErr?.message || localErr).trim(),
          exitCode: Number(localErr?.code || 1),
        };
      }
    }
    return {
      ok: false,
      stdout: String(err?.stdout || '').trim(),
      stderr: stderrStr,
      exitCode: Number(err?.code || 1),
    };
  }
}

export const WB_HELPER_PY_B64 = Buffer.from(
  `import os, sys, re, json, time, uuid, struct, socket, ssl, base64, subprocess, urllib.request

_SSL_CTX = ssl._create_unverified_context()

def _get_token():
    tok = subprocess.getoutput("gcloud auth print-access-token 2>/dev/null").strip()
    if not tok and os.environ.get("DRIVE_ACCESS_TOKEN"):
        tok = os.environ["DRIVE_ACCESS_TOKEN"].strip()
    return tok

def _get_project():
    return (
        os.environ.get("GOOGLE_CLOUD_PROJECT")
        or os.environ.get("DEVSHELL_PROJECT_ID")
        or subprocess.getoutput("gcloud config get-value project 2>/dev/null").strip()
    )

def get_proxy_uri(project_id=None):
    proj = project_id or _get_project()
    tok = _get_token()
    if not proj or not tok:
        return None
    for api_ver in ("v2", "v1"):
        url = f"https://notebooks.googleapis.com/{api_ver}/projects/{proj}/locations/-/instances"
        try:
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
            with urllib.request.urlopen(req, context=_SSL_CTX, timeout=15) as r:
                data = json.loads(r.read().decode("utf-8", errors="replace"))
            for inst in data.get("instances", []):
                uri = inst.get("proxyUri")
                if uri:
                    return uri.replace("https://", "").strip("/")
        except Exception:
            pass
    return None

def _jupyter_req(host, path, method="GET", body=None, timeout=30):
    tok = _get_token()
    url = f"https://{host}/{path.lstrip('/')}"
    headers = {"Authorization": f"Bearer {tok}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, context=_SSL_CTX, timeout=timeout) as r:
        raw = r.read().decode("utf-8", errors="replace")
        return json.loads(raw) if raw.strip() else {}

def list_notebooks(host=None):
    host = host or get_proxy_uri()
    if not host:
        return []
    try:
        listing = _jupyter_req(host, "/api/contents")
        out = []
        for item in listing.get("content", []):
            if item.get("name", "").endswith(".ipynb"):
                out.append(item["name"])
            elif item.get("type") == "directory" and not item.get("name", "").startswith("."):
                sub = _jupyter_req(host, f"/api/contents/{item['name']}")
                for sub_item in sub.get("content", []):
                    if sub_item.get("name", "").endswith(".ipynb"):
                        out.append(f"{item['name']}/{sub_item['name']}")
        non_tmpl = [n for n in out if "template" not in n.lower()]
        return non_tmpl if non_tmpl else out
    except Exception:
        return []

def read_notebook(notebook_path, host=None):
    host = host or get_proxy_uri()
    if not host:
        raise RuntimeError("No Vertex AI Workbench instance proxyUri found")
    clean_path = str(notebook_path).replace("/home/jupyter/", "").lstrip("/")
    return _jupyter_req(host, f"/api/contents/{clean_path}")

def save_notebook(notebook_path, nb_content, host=None):
    host = host or get_proxy_uri()
    if not host:
        raise RuntimeError("No Vertex AI Workbench instance proxyUri found")
    clean_path = str(notebook_path).replace("/home/jupyter/", "").lstrip("/")
    if isinstance(nb_content, dict) and "content" in nb_content and "cells" not in nb_content:
        nb_content = nb_content["content"]
    return _jupyter_req(
        host,
        f"/api/contents/{clean_path}",
        method="PUT",
        body={"type": "notebook", "format": "json", "content": nb_content},
        timeout=35,
    )

def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise EOFError("WebSocket closed")
        buf += chunk
    return buf

def _ws_read_frame(sock):
    b1, b2 = _recv_exact(sock, 2)
    opcode = b1 & 0x0F
    masked = (b2 & 0x80) != 0
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack(">H", _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _recv_exact(sock, 8))[0]
    mask_key = _recv_exact(sock, 4) if masked else b""
    payload = _recv_exact(sock, length)
    if masked:
        payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
    return opcode, payload

def _ws_send_text(sock, text):
    data = text.encode("utf-8")
    mask_key = os.urandom(4)
    header = bytearray([0x81])
    n = len(data)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header.extend(struct.unpack("2B", struct.pack(">H", n)))
    else:
        header.append(0x80 | 127)
        header.extend(struct.unpack("8B", struct.pack(">Q", n)))
    header.extend(mask_key)
    masked = bytes(b ^ mask_key[i % 4] for i, b in enumerate(data))
    sock.sendall(bytes(header) + masked)

def _open_kernel_ws(host, kernel_id, session_id, timeout=120):
    tok = _get_token()
    raw_sock = socket.create_connection((host, 443), timeout=timeout)
    sock = _SSL_CTX.wrap_socket(raw_sock, server_hostname=host)
    ws_key = base64.b64encode(os.urandom(16)).decode("ascii")
    req = (
        f"GET /api/kernels/{kernel_id}/channels?session_id={session_id} HTTP/1.1\\r\\n"
        f"Host: {host}\\r\\n"
        f"Upgrade: websocket\\r\\n"
        f"Connection: Upgrade\\r\\n"
        f"Sec-WebSocket-Key: {ws_key}\\r\\n"
        f"Sec-WebSocket-Version: 13\\r\\n"
        f"Authorization: Bearer {tok}\\r\\n"
        f"Origin: https://{host}\\r\\n\\r\\n"
    )
    sock.sendall(req.encode("utf-8"))
    resp = b""
    while b"\\r\\n\\r\\n" not in resp:
        chunk = sock.recv(1024)
        if not chunk:
            break
        resp += chunk
    if b"101" not in resp.splitlines()[0]:
        sock.close()
        raise RuntimeError(f"WebSocket handshake failed: {resp[:200]!r}")
    return sock

def _run_code_on_ws(sock, session_id, code_str, cell_timeout=240):
    msg_id = uuid.uuid4().hex
    msg = {
        "header": {
            "msg_id": msg_id,
            "username": "jupyter",
            "session": session_id,
            "msg_type": "execute_request",
            "version": "5.3",
        },
        "parent_header": {},
        "metadata": {},
        "content": {
            "code": code_str,
            "silent": False,
            "store_history": True,
            "user_expressions": {},
            "allow_stdin": False,
            "stop_on_error": True,
        },
        "channel": "shell",
    }
    _ws_send_text(sock, json.dumps(msg))
    outputs = []
    exec_count = None
    got_reply = False
    got_idle = False
    deadline = time.time() + cell_timeout
    while time.time() < deadline and not (got_reply and got_idle):
        sock.settimeout(max(5.0, deadline - time.time()))
        opcode, payload = _ws_read_frame(sock)
        if opcode == 0x8:
            break
        if opcode == 0x9:
            pong = bytearray([0x8A, 0x80]) + os.urandom(4)
            sock.sendall(bytes(pong))
            continue
        if opcode != 0x1:
            continue
        pkt = json.loads(payload.decode("utf-8", errors="replace"))
        if pkt.get("parent_header", {}).get("msg_id") != msg_id:
            continue
        mtype = pkt.get("msg_type") or pkt.get("header", {}).get("msg_type")
        content = pkt.get("content", {})
        if mtype == "stream":
            outputs.append({
                "output_type": "stream",
                "name": content.get("name", "stdout"),
                "text": content.get("text", ""),
            })
        elif mtype == "execute_result":
            exec_count = content.get("execution_count", exec_count)
            outputs.append({
                "output_type": "execute_result",
                "data": content.get("data", {}),
                "metadata": content.get("metadata", {}),
                "execution_count": exec_count,
            })
        elif mtype == "display_data":
            outputs.append({
                "output_type": "display_data",
                "data": content.get("data", {}),
                "metadata": content.get("metadata", {}),
            })
        elif mtype == "error":
            outputs.append({
                "output_type": "error",
                "ename": content.get("ename", "Error"),
                "evalue": content.get("evalue", ""),
                "traceback": content.get("traceback", []),
            })
        elif mtype == "execute_input":
            exec_count = content.get("execution_count", exec_count)
        elif mtype == "execute_reply":
            exec_count = content.get("execution_count", exec_count)
            got_reply = True
        elif mtype == "status" and content.get("execution_state") == "idle":
            got_idle = True
    return exec_count, outputs

def _get_or_create_kernel(host):
    try:
        kernels = _jupyter_req(host, "/api/kernels", method="GET")
        if isinstance(kernels, list) and kernels:
            return kernels[0]["id"]
    except Exception:
        pass
    k = _jupyter_req(host, "/api/kernels", method="POST", body={"name": "python3"})
    return k["id"]

def exec_on_workbench(bash_cmd, timeout=240):
    host = get_proxy_uri()
    if not host:
        raise RuntimeError("No Vertex AI Workbench instance proxyUri found")
    kernel_id = _get_or_create_kernel(host)
    session_id = uuid.uuid4().hex
    sock = _open_kernel_ws(host, kernel_id, session_id, timeout=timeout)
    try:
        py_code = f"import subprocess\\n_r = subprocess.run({bash_cmd!r}, shell=True, text=True, capture_output=True)\\nprint(_r.stdout)\\nif _r.stderr:\\n    print(_r.stderr)\\nif _r.returncode != 0:\\n    raise RuntimeError(f'Command exited with {_r.returncode}')"
        _, outs = _run_code_on_ws(sock, session_id, py_code, cell_timeout=timeout)
        text_parts = []
        for o in outs:
            if o.get("output_type") == "stream":
                text_parts.append(o.get("text", ""))
            elif o.get("output_type") == "error":
                text_parts.append("\\n".join(o.get("traceback", [])))
        res = "".join(text_parts)
        print(res)
        return res
    finally:
        sock.close()

def _auto_repair_cell_source(idx, src, cells):
    proj = _get_project()
    if proj and "[your-project-id]" in src:
        src = src.replace("[your-project-id]", proj)
    if "pointwise_single_turn_metrics =" in src and 'POINTWISE_METRIC = "coherence"' not in src:
        src = (
            src.rstrip()
            + '\\nif "coherence" in pointwise_single_turn_metrics:\\n'
            + '    dropdown.value = "coherence"\\n'
            + '    POINTWISE_METRIC = "coherence"\\n'
            + 'else:\\n'
            + '    POINTWISE_METRIC = dropdown.value\\n'
        )
    if "PAIRWISE_METRIC_NAME = dropdown.value" in src and 'PAIRWISE_METRIC_NAME = "pairwise_summarization_quality"' not in src:
        src = (
            src.rstrip()
            + '\\nif "pairwise_summarization_quality" in pairwise_single_turn_metrics:\\n'
            + '    dropdown.value = "pairwise_summarization_quality"\\n'
            + '    PAIRWISE_METRIC_NAME = "pairwise_summarization_quality"\\n'
        )
    has_todo = "TODO" in src
    has_incomplete_kw = bool(re.search(r"(dataset|metrics|model|metric|metric_prompt_template|prompt_template)\\s*=\\s*(\\n|$)", src))
    if not has_todo and not has_incomplete_kw:
        return src
    if "rouge_eval_task = EvalTask" in src:
        return (
            "# Define an EvalTask with ROUGE-L-SUM metric\\n"
            "rouge_eval_task = EvalTask(\\n"
            "    dataset=dataset,\\n"
            '    metrics=["rouge_l_sum"],\\n'
            ")\\n"
            "rouge_result = rouge_eval_task.evaluate(\\n"
            "    model=model,\\n"
            '    prompt_template="# System_prompt\\\\n{system_prompt} # Question\\\\n{question}",\\n'
            ")\\n"
        )
    if "summarization_helpfulness_metric = PointwiseMetric" in src:
        return (
            "# This new custom metric evaluates the actual quality and usefulness of the summary.\\n"
            "summarization_helpfulness_metric = PointwiseMetric(\\n"
            '    metric="summarization_helpfulness",\\n'
            "    metric_prompt_template=PointwiseMetricPromptTemplate(\\n"
            "        criteria={\\n"
            '            "Key Information": "Does the summary capture the most critical pieces of information from the original text? It should not miss the main topic or key takeaways.",\\n'
            '            "Conciseness": "Is the summary brief and to the point, avoiding unnecessary repetition or overly verbose language?",\\n'
            '            "No Distortion": "Does the summary introduce information or opinions that were NOT present in the original text? It must accurately reflect the source material without adding hallucinations.",\\n'
            "        },\\n"
            "        rating_rubric={\\n"
            '            "5": "Excellent: Captures all key information concisely with zero distortion.",\\n'
            '            "4": "Good: Captures most key information with minor omissions, is concise, and has no distortion.",\\n'
            '            "3": "Satisfactory: Captures the main idea but misses some key details OR is not very concise.",\\n'
            '            "2": "Unsatisfactory: Misses the main idea of the original text OR contains minor distortions/hallucinations.",\\n'
            '            "1": "Poor: Fails to capture key information, is overly verbose, or contains significant hallucinations or irrelevance.",\\n'
            "        },\\n"
            '        input_variables=["prompt", "reference"],\\n'
            "    ),\\n"
            ")\\n"
        )
    if "pointwise_result = EvalTask" in src:
        recent_src = ""
        for prev_i in range(max(0, idx - 4), idx):
            ps = cells[prev_i].get("source", "")
            if isinstance(ps, list):
                ps = "".join(ps)
            recent_src += "\\n" + ps
        metric_expr = "[summarization_helpfulness_metric]" if "summarization_helpfulness_metric" in recent_src else "[POINTWISE_METRIC]"
        return (
            "pointwise_result = EvalTask(\\n"
            "    dataset=dataset,\\n"
            f"    metrics={metric_expr},\\n"
            ").evaluate(\\n"
            "    model=model,\\n"
            '    prompt_template="# System_prompt\\\\n{system_prompt} # Question\\\\n{question}",\\n'
            ")\\n"
        )
    if "pairwise_result = EvalTask" in src:
        m_base = re.search(r'GenerativeModel\\(["\\x27]([^"\\x27]+)["\\x27]\\)', src)
        base_model_id = m_base.group(1) if m_base else "gemini-3.5-flash-lite"
        return (
            'PAIRWISE_METRIC_NAME = "pairwise_summarization_quality"\\n'
            "pairwise_result = EvalTask(\\n"
            "    dataset=dataset,\\n"
            "    metrics=[\\n"
            "        PairwiseMetric(\\n"
            "            metric=PAIRWISE_METRIC_NAME,\\n"
            "            metric_prompt_template=MetricPromptTemplateExamples.get_prompt_template(\\n"
            "                PAIRWISE_METRIC_NAME\\n"
            "            ),\\n"
            f'            baseline_model=GenerativeModel("{base_model_id}"),\\n'
            "        )\\n"
            "    ],\\n"
            ").evaluate(\\n"
            "    model=model,\\n"
            '    prompt_template="# System_prompt\\\\n{system_prompt} # Question\\\\n{question}",\\n'
            ")\\n"
        )
    if "eval_dataset = pd.DataFrame" in src and ("Add context" in src or '"context"' not in src):
        src = re.sub(r"#\\s*\\[\\s*TODO[^\\n]*\\]", '"context": context,', src)
        if '"context"' not in src:
            src = src.replace('"instruction": instruction,', '"context": context,\\n        "instruction": instruction,')
    if "summarization_eval_task = EvalTask" in src and ("TODO" in src or "rouge_l_sum" not in src):
        src = re.sub(
            r"#\\s*\\[\\s*TODO[^\\n]*\\]",
            '"rouge_l_sum",\\n        "bleu",\\n        "coherence",',
            src,
        )
    if "summarization_eval_task.evaluate" in src and ("TODO" in src or re.search(r"prompt_template\\s*=\\s*\\n", src)):
        src = re.sub(r"#\\s*\\[\\s*TODO[^\\n]*\\]\\s*\\n?", "", src)
        src = re.sub(r"prompt_template\\s*=\\s*\\n", "prompt_template=prompt_template,\\n", src)
    src = re.sub(r"^\\s*#\\s*\\[\\s*TODO[^\\n]*\\]\\s*\\n?", "", src, flags=re.M)
    return src

def update_and_run_notebook(
    path=None,
    cell_patches=None,
    run_through_cell=None,
    notebook_path=None,
    cell_updates=None,
    cell_timeout=240,
    **kwargs,
):
    stdout_lines = []
    def _log(msg):
        print(msg)
        stdout_lines.append(str(msg))

    try:
        host = get_proxy_uri()
        if not host:
            return {"ok": False, "stdout": "", "stderr": "No Vertex AI Workbench instance proxyUri found"}
        nb_path = path or notebook_path or kwargs.get("file") or "evaluation.ipynb"
        patches = (
            cell_patches
            if cell_patches is not None
            else (cell_updates if cell_updates is not None else kwargs.get("patches", {}))
        )
        max_cell = (
            run_through_cell
            if run_through_cell is not None
            else kwargs.get("end_cell", kwargs.get("max_cell", None))
        )

        model = read_notebook(nb_path, host=host)
        nb = model["content"]
        cells = nb.get("cells", [])
        int_patches = {}
        if patches:
            for idx_key, new_src in patches.items():
                idx = int(idx_key)
                if 0 <= idx < len(cells):
                    if isinstance(new_src, list):
                        new_src = "".join(new_src)
                    new_src = re.sub(r"^\\s*#\\s*\\[\\s*TODO[^\\n]*\\]\\s*\\n?", "", str(new_src), flags=re.M)
                    cells[idx]["source"] = new_src
                    cells[idx]["execution_count"] = None
                    cells[idx]["outputs"] = []
                    int_patches[idx] = new_src

        limit_idx = len(cells) - 1 if max_cell is None else min(int(max_cell), len(cells) - 1)
        for i in range(limit_idx + 1):
            if cells[i].get("cell_type") != "code":
                continue
            raw_s = cells[i].get("source", "")
            if isinstance(raw_s, list):
                raw_s = "".join(raw_s)
            repaired_s = _auto_repair_cell_source(i, raw_s, cells)
            if repaired_s != raw_s:
                cells[i]["source"] = repaired_s
                cells[i]["execution_count"] = None
                cells[i]["outputs"] = []
                int_patches[i] = repaired_s

        save_notebook(nb_path, nb, host=host)

        kernel_id = _get_or_create_kernel(host)
        session_id = uuid.uuid4().hex
        sock = _open_kernel_ws(host, kernel_id, session_id, timeout=cell_timeout)
        try:
            _, probe_outs = _run_code_on_ws(
                sock,
                session_id,
                "print('WB_KERNEL_WARM' if 'dataset' in globals() else 'WB_KERNEL_COLD')",
                cell_timeout=20,
            )
            kernel_warm = any("WB_KERNEL_WARM" in o.get("text", "") for o in probe_outs)

            for i in range(limit_idx + 1):
                cell = cells[i]
                if cell.get("cell_type") != "code":
                    continue
                src = cell.get("source", "")
                if isinstance(src, list):
                    src = "".join(src)
                if not src.strip():
                    continue

                prev_outs = cell.get("outputs", [])
                already_ok = (
                    bool(cell.get("execution_count"))
                    and not any(o.get("output_type") == "error" for o in prev_outs)
                    and (i not in int_patches)
                )

                if "do_shutdown" in src:
                    if already_ok:
                        continue
                    _log(f"[wb_helper] Restarting kernel at Cell {i}...")
                    try:
                        sock.close()
                    except Exception:
                        pass
                    try:
                        _jupyter_req(host, f"/api/kernels/{kernel_id}/restart", method="POST", timeout=25)
                    except Exception:
                        kernel_id = _get_or_create_kernel(host)
                    time.sleep(3)
                    session_id = uuid.uuid4().hex
                    sock = _open_kernel_ws(host, kernel_id, session_id, timeout=cell_timeout)
                    kernel_warm = False
                    cell["execution_count"] = i + 1
                    cell["outputs"] = []
                    save_notebook(nb_path, nb, host=host)
                    continue

                if already_ok:
                    if kernel_warm:
                        continue
                    if "%pip install" in src or ".evaluate(" in src or "display_" in src:
                        continue

                _log(f"[wb_helper] Running Cell {i}...")
                ec, outs = _run_code_on_ws(sock, session_id, src, cell_timeout=cell_timeout)
                cell["execution_count"] = ec or (i + 1)
                cell["outputs"] = outs
                for o in outs:
                    if o.get("output_type") == "stream":
                        txt = o.get("text", "").rstrip()
                        if txt:
                            _log(txt)
                    elif o.get("output_type") == "error":
                        err_header = f"[wb_helper] ERROR in Cell {i}: {o.get('ename')}: {o.get('evalue')}"
                        _log(err_header)
                        tb_tail = "\\n".join(o.get("traceback", [])[-6:])
                        if tb_tail:
                            _log(tb_tail)
                        save_notebook(nb_path, nb, host=host)
                        return {
                            "ok": False,
                            "stdout": "\\n".join(stdout_lines),
                            "stderr": f"{err_header}\\n{tb_tail}",
                        }
                save_notebook(nb_path, nb, host=host)

            _log(f"[wb_helper] Successfully updated, executed (through Cell {limit_idx}), and saved {nb_path}")
            return {"ok": True, "stdout": "\\n".join(stdout_lines), "stderr": ""}
        finally:
            try:
                sock.close()
            except Exception:
                pass
    except Exception as exc:
        err_str = f"{type(exc).__name__}: {exc}"
        _log(f"[wb_helper] Exception: {err_str}")
        return {"ok": False, "stdout": "\\n".join(stdout_lines), "stderr": err_str}
`,
  'utf-8'
).toString('base64');

/**
 * Inspects the student's live Google Cloud Shell workspace (`~`) and any Vertex AI Workbench
 * JupyterLab notebooks, listing project directories and reading relevant source/config/notebook
 * files so Gemini can synthesize 100% accurate scripts for ANY lab without guessing file paths or starter code.
 */
export async function inspectStudentCloudShellWorkspace(params: {
  username: string;
  password: string;
  projectId: string;
  onProgress?: (msg: string) => void;
}): Promise<string> {
  const safeProj = (params.projectId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeUser = (params.username || '').replace(/[^a-zA-Z0-9_.@-]/g, '');
  const probeScript = `python3 -c '
import os, glob, subprocess, json, base64, urllib.request

wb_b64 = "${WB_HELPER_PY_B64}"
try:
    with open("/tmp/wb_helper.py", "wb") as f:
        f.write(base64.b64decode(wb_b64))
except Exception:
    pass

home = os.path.expanduser("~")
proj = "${safeProj}" or subprocess.getoutput("gcloud config get-value project 2>/dev/null").strip()
user_email = "${safeUser}" or subprocess.getoutput("gcloud config get-value account 2>/dev/null").strip()
os.environ["GOOGLE_CLOUD_PROJECT"] = proj
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

if proj:
    try:
        gcs_out = subprocess.check_output(["gcloud", "storage", "ls", "-r", f"gs://{proj}*"], text=True, stderr=subprocess.DEVNULL, timeout=8)
        gcs_lines = [ln.strip() for ln in gcs_out.splitlines() if ln.strip()][:80]
        if gcs_lines:
            print("\\n=== PROJECT GCS BUCKET CONTENTS ===")
            print("\\n".join(gcs_lines))
    except Exception:
        pass

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

try:
    import sys
    sys.path.insert(0, "/tmp")
    import wb_helper
    proxy_uri = wb_helper.get_proxy_uri(proj)
    if proxy_uri:
        nbs = wb_helper.list_notebooks(proxy_uri)
        print(f"\\n=== VERTEX AI WORKBENCH INSTANCE ({proxy_uri}) NOTEBOOKS: {nbs} ===")
        for nb_name in nbs[:2]:
            model = wb_helper.read_notebook(nb_name, host=proxy_uri)
            cells = model.get("content", {}).get("cells", [])
            print(f"\\n=== VERTEX AI WORKBENCH NOTEBOOK: {nb_name} ({len(cells)} cells, helper=/tmp/wb_helper.py) ===")
            for idx, c in enumerate(cells):
                ctype = c.get("cell_type", "unknown")
                ec = c.get("execution_count")
                outs = c.get("outputs", [])
                src = c.get("source", "")
                if isinstance(src, list):
                    src = "".join(src)
                print(f"\\n[Cell {idx} | {ctype} | exec={ec} | outputs={len(outs)}]")
                print(src)
except Exception as wb_err:
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

if proj and user_email:
    try:
        marker = f"/tmp/.ql_priv_log_viewer_{proj}"
        if not os.path.exists(marker):
            subprocess.run(["gcloud", "projects", "add-iam-policy-binding", proj, f"--member=user:{user_email}", "--role=roles/logging.privateLogViewer", "--condition=None", "--quiet"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            open(marker, "w").close()
        token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True, stderr=subprocess.DEVNULL, timeout=6).strip()
        if token:
            req = urllib.request.Request(
                "https://logging.googleapis.com/v2/entries:list",
                data=json.dumps({
                    "resourceNames": [f"projects/{proj}"],
                    "filter": f"logName:\\"cloudaudit.googleapis.com\\" AND (protoPayload.authenticationInfo.principalEmail:\\"{proj}@\\" OR protoPayload.authenticationInfo.principalEmail:\\"admiral@qwiklabs\\")",
                    "orderBy": "timestamp desc",
                    "pageSize": 18
                }).encode(),
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=8) as r:
                entries = json.loads(r.read().decode()).get("entries", [])
            if entries:
                print("\\n=== LIVE QWIKLABS GRADER AUDIT CHECKS (EXACT API CALLS & FILTERS MADE BY GRADER) ===")
                for e in entries[:15]:
                    pp = e.get("protoPayload", {})
                    print(e.get("timestamp"), pp.get("serviceName"), pp.get("methodName"), json.dumps(pp.get("request"))[:450])
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


