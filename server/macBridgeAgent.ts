#!/usr/bin/env node
/**
 * Skills Runner — On-Demand Mac Chrome Bridge Agent (macBridgeAgent.ts)
 *
 * - Zero local listening ports (outbound WebSocket connection to Cloud Run only)
 * - Zero background polling (only queries Google Chrome when explicitly requested by you in the UI,
 *   so it never interferes with SSO logins, password typing, or Passkey/TouchID prompts)
 * - Supports live Qwiklabs "Check my progress" grading (/assessments/run_step.json) and direct
 *   Cloud Shell SSH execution with full stdout/stderr telemetry
 * - Can be stopped anytime via Ctrl+C in terminal or clicking "Stop Mac Bridge" in the Cloud Run web UI
 *
 * Usage:
 *   node macBridgeAgent.ts
 *   # or:
 *   npx tsx macBridgeAgent.ts
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const cliUrlArg = process.argv
  .find((a) => a.startsWith('--url='))
  ?.slice('--url='.length)
  .replace(/^http/i, 'ws')
  .replace(/\/$/, '');

const cliSessionArg = process.argv
  .find((a) => a.startsWith('--session='))
  ?.slice('--session='.length)
  .trim();

const CLOUD_RUN_WS_URL =
  process.env.CLOUD_RUN_WS_URL ||
  (cliUrlArg ? (cliUrlArg.endsWith('/ws-bridge') ? cliUrlArg : `${cliUrlArg}/ws-bridge`) : '') ||
  'wss://skills-runner-621653283297.us-central1.run.app/ws-bridge';

const SNAPSHOT_DIR = path.join(os.homedir(), '.cloud-skills-lab-runner');
const SNAPSHOT_HTML_PATH = path.join(SNAPSHOT_DIR, 'live_lab_snapshot.html');
const SNAPSHOT_FILES_DIR = path.join(SNAPSHOT_DIR, 'live_lab_snapshot_files');
const STATE_FILE_PATH = path.join(SNAPSHOT_DIR, 'runner_state.json');
const SESSION_ID_FILE = path.join(SNAPSHOT_DIR, 'session_id');

const SSH_BIN_DIR = path.join(SNAPSHOT_DIR, 'ssh-bin');

function ensureCleanSshWrapperDir() {
  try {
    fs.mkdirSync(SSH_BIN_DIR, { recursive: true });
    const sshWrapperPath = path.join(SSH_BIN_DIR, 'ssh');
    const scpWrapperPath = path.join(SSH_BIN_DIR, 'scp');
    const sshScript = `#!/bin/sh\nexec /usr/bin/ssh -F /dev/null -o ProxyCommand=none -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 "$@"\n`;
    const scpScript = `#!/bin/sh\nexec /usr/bin/scp -F /dev/null -o ProxyCommand=none -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 "$@"\n`;
    fs.writeFileSync(sshWrapperPath, sshScript, { mode: 0o755 });
    fs.writeFileSync(scpWrapperPath, scpScript, { mode: 0o755 });
    fs.chmodSync(sshWrapperPath, 0o755);
    fs.chmodSync(scpWrapperPath, 0o755);
  } catch {
    // Ignore
  }
}

ensureCleanSshWrapperDir();

const EXTRA_MAC_PATHS = [
  SSH_BIN_DIR,
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/opt/homebrew/share/google-cloud-sdk/bin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/local/share/google-cloud-sdk/bin',
  '/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin',
  path.join(os.homedir(), 'google-cloud-sdk', 'bin'),
  path.join(os.homedir(), 'Downloads', 'google-cloud-sdk', 'bin'),
  '/Users/Shared/google-cloud-sdk/bin',
];
for (const p of EXTRA_MAC_PATHS) {
  if (fs.existsSync(p) && !(process.env.PATH || '').split(':').includes(p)) {
    process.env.PATH = `${p}:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`;
  }
}
if (!(process.env.PATH || '').startsWith(`${SSH_BIN_DIR}:`)) {
  process.env.PATH = `${SSH_BIN_DIR}:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`;
}

async function runAppleScript(script, timeoutMs = 35000) {
  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

let attemptedEnableAppleEventsJs = false;

async function tryEnableChromeAppleEventsJs() {
  if (attemptedEnableAppleEventsJs) return;
  attemptedEnableAppleEventsJs = true;
  const menuScript = `
tell application "Google Chrome" to activate
delay 0.2
tell application "System Events"
  tell process "Google Chrome"
    try
      set devMenu to menu 1 of menu item "Developer" of menu 1 of menu bar item "View" of menu bar 1
      set jsItem to menu item "Allow JavaScript from Apple Events" of devMenu
      set markChar to (value of attribute "AXMenuItemMarkChar" of jsItem)
      if markChar is missing value or markChar is "" then
        click jsItem
        delay 0.3
        key code 36
      end if
    end try
  end tell
end tell
`;
  await runAppleScript(menuScript, 5000).catch(() => '');
}

async function executeJsInUserChromeTab(windowId, tabIndex, jsCode, timeoutMs = 15000) {
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
  let out = await runAppleScript(script, timeoutMs).catch((e) => `ERR:${e?.message || e}`);
  if (out.startsWith('OK:')) {
    return { ok: true, value: out.slice(3) };
  }
  const errStr = out.slice(4);
  if (!attemptedEnableAppleEventsJs && /turned off|Allow JavaScript from Apple Events/i.test(errStr)) {
    await tryEnableChromeAppleEventsJs();
    out = await runAppleScript(script, timeoutMs).catch((e) => `ERR:${e?.message || e}`);
    if (out.startsWith('OK:')) {
      return { ok: true, value: out.slice(3) };
    }
  }
  return { ok: false, error: out.slice(4) };
}

async function listUserChromeTabs() {
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
  if (!raw) return [];

  const tabs = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [wIdStr, wIdxStr, modeStr, actIdxStr, tIdxStr, title, url] = line.split('|||');
    const windowId = parseInt(wIdStr, 10);
    const windowIndex = parseInt(wIdxStr, 10) || 1;
    const tabIndex = parseInt(tIdxStr, 10) || 1;
    const activeIdx = parseInt(actIdxStr, 10) || 1;
    if (!Number.isFinite(windowId) || !url) continue;

    const lowerUrl = url.toLowerCase();
    let suggestedRole = 'other';
    let contentKind = undefined;
    const isSkillsDomain =
      (lowerUrl.includes('skills.google') ||
        lowerUrl.includes('cloudskillsboost.google') ||
        lowerUrl.includes('qwiklabs.com')) &&
      !lowerUrl.includes('accounts.google.com') &&
      !lowerUrl.includes('login.corp.google.com') &&
      !lowerUrl.includes('google_sso');

    if (
      isSkillsDomain &&
      (lowerUrl.includes('/focuses/') ||
        lowerUrl.includes('/labs/') ||
        lowerUrl.includes('/catalog_lab/'))
    ) {
      suggestedRole = 'lab';
      contentKind = 'lab';
    } else if (
      isSkillsDomain &&
      (lowerUrl.includes('/course_templates/') ||
        lowerUrl.includes('/course_sessions/') ||
        lowerUrl.includes('/paths/') ||
        lowerUrl.includes('/quests/') ||
        lowerUrl.includes('/documents/') ||
        lowerUrl.includes('/quizzes/') ||
        lowerUrl.includes('/videos/'))
    ) {
      suggestedRole = 'lab';
      contentKind = 'course';
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
      ...(contentKind ? { contentKind } : {}),
    });
  }

  const rolePriority = {
    lab: 0,
    console: 1,
    cloud_shell: 2,
    other: 3,
  };

  tabs.sort((a, b) => {
    const rDiff = (rolePriority[a.suggestedRole] ?? 3) - (rolePriority[b.suggestedRole] ?? 3);
    if (rDiff !== 0) return rDiff;
    if (a.windowMode !== b.windowMode) {
      return a.windowMode === 'incognito' ? -1 : 1;
    }
    if (a.windowIndex !== b.windowIndex) return a.windowIndex - b.windowIndex;
    return a.tabIndex - b.tabIndex;
  });

  return tabs;
}

async function focusUserChromeTab(windowId, tabIndex) {
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

async function openOrFocusLabInUserChrome(requestedUrl) {
  let pathKey = '';
  try {
    const parsed = new URL(requestedUrl);
    if (parsed.pathname && parsed.pathname !== '/' && parsed.pathname !== '/focuses/') {
      pathKey = parsed.pathname;
    }
  } catch {
    // Ignore
  }

  const escapedUrl = requestedUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedPathKey = pathKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const script = `
tell application "Google Chrome"
  activate
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

async function snapshotUserChromeTabByTarget(windowId, tabIndex) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  try {
    if (fs.existsSync(SNAPSHOT_HTML_PATH)) fs.unlinkSync(SNAPSHOT_HTML_PATH);
    if (fs.existsSync(SNAPSHOT_FILES_DIR)) {
      fs.rmSync(SNAPSHOT_FILES_DIR, { recursive: true, force: true });
    }
  } catch {
    // Ignore
  }

  const escapedSnapshotPath = SNAPSHOT_HTML_PATH.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const inMemoryJs = `(function(){try{function s(r){var h='';var c=r.childNodes;for(var i=0;i<c.length;i++){var n=c[i];if(n.nodeType===1){var t=n.tagName.toLowerCase();h+='<'+t;for(var a=0;a<n.attributes.length;a++){var at=n.attributes[a];h+=' '+at.name+'="'+at.value.replace(/"/g,'&quot;')+'"';}h+='>';if(n.shadowRoot){h+='<template shadowrootmode="open">'+s(n.shadowRoot)+'</template>';}h+=s(n)+'</'+t+'>';}else if(n.nodeType===3){h+=n.nodeValue;}}return h;}return document.documentElement.outerHTML.length>500 && (document.querySelector('ql-lab-header') || document.querySelector('ql-contents-menu') || document.querySelector('ql-quiz')) ? '<!DOCTYPE html><html>'+s(document.documentElement)+'</html>' : '';}catch(e){return '';}})()`;
  const escapedInMemoryJs = inMemoryJs.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const script = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${windowId}" then
      set t to missing value
      if ${tabIndex} <= (count of tabs of w) then
        set candT to tab ${tabIndex} of w
        set candU to URL of candT
        if (candU contains "skills.google" or candU contains "cloudskillsboost.google" or candU contains "qwiklabs.com") and not (candU contains "accounts.google.com" or candU contains "login.corp.google.com" or candU contains "google_sso") then
          set t to candT
        end if
      end if
      if t is missing value then
        repeat with cIdx from 1 to count of tabs of w
          set candT to tab cIdx of w
          set candU to URL of candT
          if (candU contains "skills.google" or candU contains "cloudskillsboost.google" or candU contains "qwiklabs.com") and not (candU contains "accounts.google.com" or candU contains "login.corp.google.com" or candU contains "google_sso") then
            set t to candT
            exit repeat
          end if
        end repeat
      end if
      if t is not missing value then
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
    return { htmlPath: SNAPSHOT_HTML_PATH, url, title };
  }

  let lastSize = 0;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (fs.existsSync(SNAPSHOT_HTML_PATH)) {
      const stat = fs.statSync(SNAPSHOT_HTML_PATH);
      if (stat.size > 2000 && stat.size === lastSize) break;
      lastSize = stat.size;
    }
  }
  try {
    if (fs.existsSync(SNAPSHOT_FILES_DIR)) {
      const rtDataPath = path.join(SNAPSHOT_FILES_DIR, 'runtime-data.js');
      if (fs.existsSync(rtDataPath)) {
        fs.copyFileSync(rtDataPath, path.join(SNAPSHOT_DIR, 'runtime-data.js'));
      }
      fs.rmSync(SNAPSHOT_FILES_DIR, { recursive: true, force: true });
    }
  } catch {
    // Ignore
  }
  if (!fs.existsSync(SNAPSHOT_HTML_PATH)) return null;
  return { htmlPath: SNAPSHOT_HTML_PATH, url: url || '', title: title || '' };
}

function isLabPageUrl(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return false;
  if (
    u.includes('accounts.google.com') ||
    u.includes('login.corp.google.com') ||
    u.includes('google_sso')
  ) {
    return false;
  }
  return (
    u.includes('skills.google') ||
    u.includes('cloudskillsboost.google') ||
    u.includes('qwiklabs.com')
  );
}

async function snapshotUserChromeLabTab(preferredUrl, preferredTarget) {
  if (preferredTarget?.windowId && preferredTarget?.tabIndex) {
    const byTarget = await snapshotUserChromeTabByTarget(
      Number(preferredTarget.windowId),
      Number(preferredTarget.tabIndex)
    );
    if (byTarget && isLabPageUrl(byTarget.url)) return byTarget;
  }

  const tabs = await listUserChromeTabs();
  const labTab = tabs.find((t) => t.suggestedRole === 'lab');
  if (labTab) {
    return snapshotUserChromeTabByTarget(labTab.windowId, labTab.tabIndex);
  }
  return null;
}

/**
 * Triggers Qwiklabs' live assessment grader (`/assessments/run_step.json?id=${labInstanceId}&step=${stepNumber}`)
 * inside the user's authenticated Chrome session without requiring "Allow JavaScript from Apple Events".
 */
async function checkProgressInUserChrome(
  stepNumber,
  labUrl,
  labInstanceId,
  windowId,
  tabIndex
) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const stepNo = Math.max(1, Number(stepNumber) || 1);

  let targetWindowId = Number(windowId) || 0;
  let targetTabIndex = Number(tabIndex) || 0;
  let resolvedLabUrl = String(labUrl || '');

  if (!targetWindowId || !resolvedLabUrl) {
    const tabs = await listUserChromeTabs();
    const labTab = tabs.find((t) => t.suggestedRole === 'lab');
    if (labTab) {
      if (!targetWindowId) targetWindowId = labTab.windowId;
      if (!targetTabIndex) targetTabIndex = labTab.tabIndex;
      if (!resolvedLabUrl) resolvedLabUrl = labTab.url;
    }
  }

  let resolvedInstanceId = String(labInstanceId || '').trim();
  if (!resolvedInstanceId && targetWindowId && targetTabIndex) {
    const snap = await snapshotUserChromeTabByTarget(targetWindowId, targetTabIndex);
    if (snap && snap.htmlPath && fs.existsSync(snap.htmlPath)) {
      const html = fs.readFileSync(snap.htmlPath, 'utf8');
      const m = html.match(/labinstanceid="(\d+)"/i);
      if (m) resolvedInstanceId = m[1];
    }
  } else if (!resolvedInstanceId && fs.existsSync(SNAPSHOT_HTML_PATH)) {
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

  const fetchAssessmentStepRaw = async (instId) => {
    const checkUrl = `${origin}/assessments/run_step.json?id=${encodeURIComponent(
      instId
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
    if (!fs.existsSync(checkFilePath)) return null;
    const rawHtml = fs.readFileSync(checkFilePath, 'utf8');
    const preMatch = rawHtml.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    return (preMatch ? preMatch[1] : rawHtml).trim();
  };

  let jsonCandidate = await fetchAssessmentStepRaw(resolvedInstanceId);
  if (jsonCandidate === null) {
    return {
      verified: false,
      message: `Triggered Check my progress for Step #${stepNo}, but could not read grader response.`,
    };
  }

  let data = null;
  try {
    data = JSON.parse(jsonCandidate);
  } catch {
    // If the user restarted the lab without reloading the page, the HTML attribute labinstanceid="..."
    // still holds the ended lab's ID (causing /assessments/run_step.json to redirect to Dashboard HTML).
    // Reload the Lab tab once to hydrate the new labinstanceid attribute and retry.
    if (targetWindowId && targetTabIndex) {
      const reloadScript = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${targetWindowId}" then
      if ${targetTabIndex} <= (count of tabs of w) then
        set t to tab ${targetTabIndex} of w
        set URL of t to (URL of t)
        delay 1.0
        repeat 40 times
          if (loading of t) is false then exit repeat
          delay 0.25
        end repeat
        delay 0.8
        return "reloaded"
      end if
    end if
  end repeat
  return "not_found"
end tell
`;
      await runAppleScript(reloadScript).catch(() => '');
      const freshSnap = await snapshotUserChromeTabByTarget(targetWindowId, targetTabIndex);
      if (freshSnap && freshSnap.htmlPath && fs.existsSync(freshSnap.htmlPath)) {
        const freshHtml = fs.readFileSync(freshSnap.htmlPath, 'utf8');
        const m = freshHtml.match(/labinstanceid="(\d+)"/i);
        if (m && m[1]) {
          resolvedInstanceId = m[1];
          const retryRaw = await fetchAssessmentStepRaw(resolvedInstanceId);
          if (retryRaw) {
            try {
              data = JSON.parse(retryRaw);
            } catch {
              // Fall through
            }
          }
        }
      }
    }
  }

  if (!data) {
    return {
      verified: false,
      message: `Unable to parse Qwiklabs assessment JSON for Step #${stepNo}.`,
    };
  }

  try {
    const idx = stepNo - 1;
    const stepCompleteList = Array.isArray(data.step_complete)
      ? data.step_complete.map(Boolean)
      : [];
    const stepScoresList = Array.isArray(data.step_scores)
      ? data.step_scores.map((v) => Number(v) || 0)
      : [];
    const stepPointsList = Array.isArray(data.step_points)
      ? data.step_points.map((v) => Number(v) || 0)
      : [];
    const studentMessagesList = Array.isArray(data.student_messages)
      ? data.student_messages.map((v) => String(v || '').trim())
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

    // When a step passes, trigger a fast reload of the Lab tab in Chrome so the visual Qwiklabs score pill and checkmarks update immediately
    if (verified && targetWindowId && targetTabIndex) {
      const refreshLabTabScript = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${targetWindowId}" then
      if ${targetTabIndex} <= (count of tabs of w) then
        set t to tab ${targetTabIndex} of w
        set URL of t to (URL of t)
      end if
      exit repeat
    end if
  end repeat
end tell
`;
      runAppleScript(refreshLabTabScript).catch(() => {});
    }

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

async function navigateOrOpenInUserChromeWindow(
  windowId,
  tabIndex,
  url,
  openInNewTab = false
) {
  const escapedUrl = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const mustBeIncognito =
    url.includes('console.cloud.google.com') ||
    url.includes('shell.cloud.google.com') ||
    url.includes('accounts.google.com');
  const modeCond = mustBeIncognito ? ' and (mode of w) is "incognito"' : '';
  const script = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${windowId}"${modeCond} then
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

async function setClipboardText(text) {
  return new Promise((resolve, reject) => {
    const proc = spawn('pbcopy');
    proc.on('error', reject);
    proc.on('close', () => resolve());
    proc.stdin.write(text, 'utf8');
    proc.stdin.end();
  });
}

async function getClipboardText() {
  try {
    const { stdout } = await execFileAsync('pbpaste', [], { timeout: 3000 });
    return stdout;
  } catch {
    return '';
  }
}

async function sendTextToUserChromeTab(windowId, tabIndex, text, pressEnter = true) {
  const focused = await focusUserChromeTab(windowId, tabIndex);
  if (!focused) return false;

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
  } catch {
    await setClipboardText(prevClip);
    return false;
  }
}

async function clickStartLabInUserChrome(preferredUrl, preferredTarget) {
  let target = preferredTarget || null;
  if (!target?.windowId || !target?.tabIndex) {
    const tabs = await listUserChromeTabs();
    const labTab = tabs.find((t) => t.suggestedRole === 'lab');
    if (labTab) {
      target = { windowId: labTab.windowId, tabIndex: labTab.tabIndex };
    }
  }
  if (target?.windowId && target?.tabIndex) {
    await focusUserChromeTab(Number(target.windowId), Number(target.tabIndex));
    const startJs = `(function(){
      function findDeep(root, pred) {
        var out = [];
        var walker = function(node) {
          if (!node) return;
          if (node.nodeType === 1) {
            if (pred(node)) out.push(node);
            if (node.shadowRoot) walker(node.shadowRoot);
          }
          var children = node.childNodes || [];
          for (var i = 0; i < children.length; i++) walker(children[i]);
        };
        walker(root);
        return out;
      }
      var btns = findDeep(document.documentElement, function(el) {
        var tag = (el.tagName || '').toLowerCase();
        if (tag !== 'button' && tag !== 'ql-button' && el.getAttribute('role') !== 'button') return false;
        var txt = (el.innerText || el.textContent || el.getAttribute('label') || '').trim();
        return /^start lab/i.test(txt) || txt.toLowerCase() === 'start';
      });
      if (btns.length > 0) {
        btns[0].click();
        return 'clicked';
      }
      return 'not_found';
    })()`;
    const jsRes = await executeJsInUserChromeTab(
      Number(target.windowId),
      Number(target.tabIndex),
      startJs
    );
    if (jsRes.ok && jsRes.value === 'clicked') {
      await new Promise((r) => setTimeout(r, 1200));
      const confirmJs = `(function(){
        function findDeep(root, pred) {
          var out = [];
          var walker = function(node) {
            if (!node) return;
            if (node.nodeType === 1) {
              if (pred(node)) out.push(node);
              if (node.shadowRoot) walker(node.shadowRoot);
            }
            var children = node.childNodes || [];
            for (var i = 0; i < children.length; i++) walker(children[i]);
          };
          walker(root);
          return out;
        }
        var btns = findDeep(document.documentElement, function(el) {
          var tag = (el.tagName || '').toLowerCase();
          if (tag !== 'button' && tag !== 'ql-button' && el.getAttribute('role') !== 'button') return false;
          var txt = (el.innerText || el.textContent || el.getAttribute('label') || '').trim();
          return /^launch with/i.test(txt) || /^confirm$/i.test(txt) || /^use 1 credit/i.test(txt);
        });
        if (btns.length > 0) {
          btns[0].click();
          return 'confirmed';
        }
        return 'done';
      })()`;
      await executeJsInUserChromeTab(
        Number(target.windowId),
        Number(target.tabIndex),
        confirmJs
      );
      return true;
    }
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
    if (count of windows) > 0 then
      set w to front window
      set allElems to entire contents of w
      repeat with el in allElems
        try
          if (role of el) is "AXButton" then
            set nm to (name of el) as string
            if nm starts with "Start Lab" or nm is "Start" then
              click el
              return "clicked"
            end if
          end if
        end try
      end repeat
    end if
  end tell
end tell
return "not_found"
`;
  const axRes = await runAppleScript(axScript).catch(() => '');
  if (axRes === 'clicked') {
    await new Promise((r) => setTimeout(r, 1200));
    const followScript = `
tell application "System Events"
  tell process "Google Chrome"
    if (count of windows) > 0 then
      set w to front window
      set followElems to entire contents of w
      repeat with fel in followElems
        try
          if (role of fel) is "AXButton" then
            set fnm to (name of fel) as string
            if fnm is "Confirm" or fnm starts with "Launch with" then
              click fel
              return "confirmed"
            end if
          end if
        end try
      end repeat
    end if
  end tell
end tell
return "done"
`;
    await runAppleScript(followScript).catch(() => '');
    return true;
  }
  return false;
}

async function clickEndLabInUserChrome(preferredUrl, preferredTarget) {
  let target = preferredTarget || null;
  if (!target?.windowId || !target?.tabIndex) {
    const tabs = await listUserChromeTabs();
    const labTab = tabs.find((t) => t.suggestedRole === 'lab');
    if (labTab) {
      target = { windowId: labTab.windowId, tabIndex: labTab.tabIndex };
    }
  }
  if (target?.windowId && target?.tabIndex) {
    await focusUserChromeTab(Number(target.windowId), Number(target.tabIndex));
    const endJs = `(function(){
      try {
        if (window.ql && window.ql.labRun && typeof window.ql.labRun.stopLab === 'function') {
          window.ql.labRun.stopLab();
          return 'stopped_via_api';
        }
      } catch(e) {}
      function findDeep(root, pred) {
        var out = [];
        var walker = function(node) {
          if (!node) return;
          if (node.nodeType === 1) {
            if (pred(node)) out.push(node);
            if (node.shadowRoot) walker(node.shadowRoot);
          }
          var children = node.childNodes || [];
          for (var i = 0; i < children.length; i++) walker(children[i]);
        };
        walker(root);
        return out;
      }
      var endBtns = findDeep(document.documentElement, function(el) {
        var tag = (el.tagName || '').toLowerCase();
        if (tag !== 'button' && tag !== 'ql-button' && el.getAttribute('role') !== 'button') return false;
        var txt = (el.innerText || el.textContent || el.getAttribute('label') || '').trim();
        return /^end lab/i.test(txt);
      });
      if (endBtns.length > 0) {
        endBtns[0].click();
        return 'clicked_primary';
      }
      var startBtns = findDeep(document.documentElement, function(el) {
        var tag = (el.tagName || '').toLowerCase();
        if (tag !== 'button' && tag !== 'ql-button' && el.getAttribute('role') !== 'button') return false;
        var txt = (el.innerText || el.textContent || el.getAttribute('label') || '').trim();
        return /^start lab/i.test(txt);
      });
      if (startBtns.length > 0) return 'already_ended';
      return 'not_found';
    })()`;
    const jsRes = await executeJsInUserChromeTab(
      Number(target.windowId),
      Number(target.tabIndex),
      endJs
    );
    if (jsRes.ok && jsRes.value === 'already_ended') {
      return { ended: true, message: 'Lab is already ended in Google Chrome.' };
    }
    if (jsRes.ok && (jsRes.value === 'stopped_via_api' || jsRes.value === 'clicked_primary')) {
      await new Promise((r) => setTimeout(r, 900));
      const confirmJs = `(function(){
        function findDeep(root, pred) {
          var out = [];
          var walker = function(node) {
            if (!node) return;
            if (node.nodeType === 1) {
              if (pred(node)) out.push(node);
              if (node.shadowRoot) walker(node.shadowRoot);
            }
            var children = node.childNodes || [];
            for (var i = 0; i < children.length; i++) walker(children[i]);
          };
          walker(root);
          return out;
        }
        var btns = findDeep(document.documentElement, function(el) {
          var tag = (el.tagName || '').toLowerCase();
          if (tag !== 'button' && tag !== 'ql-button' && el.getAttribute('role') !== 'button') return false;
          var txt = (el.innerText || el.textContent || el.getAttribute('label') || '').trim();
          return /^submit$/i.test(txt) || /^confirm$/i.test(txt) || /^end lab$/i.test(txt);
        });
        if (btns.length > 0) {
          btns[btns.length - 1].click();
          return 'confirmed';
        }
        return 'no_confirm';
      })()`;
      await executeJsInUserChromeTab(
        Number(target.windowId),
        Number(target.tabIndex),
        confirmJs
      );
      return {
        ended: true,
        message: 'Clicked "End Lab" and confirmed termination in Google Chrome.',
      };
    }
  }

  const primaryScript = `
tell application "Google Chrome" to activate
delay 0.3
tell application "System Events"
  tell process "Google Chrome"
    try
      set value of attribute "AXEnhancedUserInterface" to true
    end try
    delay 0.3
    if (count of windows) > 0 then
      set w to front window
      set allElems to entire contents of w
      repeat with el in allElems
        try
          if (role of el) is "AXButton" then
            set nm to (name of el) as string
            if nm is "End Lab" or nm is "End" or nm starts with "End Lab" then
              click el
              return "clicked_primary"
            end if
            if nm starts with "Start Lab" or nm is "Start" then
              return "already_ended"
            end if
          end if
        end try
      end repeat
    end if
  end tell
end tell
return "not_found"
`;
  const primaryRes = await runAppleScript(primaryScript).catch(() => '');
  if (primaryRes === 'already_ended') {
    return {
      ended: true,
      message: 'Lab is already ended in Google Chrome.',
    };
  }
  if (primaryRes === 'clicked_primary') {
    await new Promise((r) => setTimeout(r, 900));
    const confirmScript = `
tell application "System Events"
  tell process "Google Chrome"
    if (count of windows) > 0 then
      set w to front window
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
        return "confirmed"
      end if
    end if
  end tell
end tell
return "no_confirm"
`;
    await runAppleScript(confirmScript).catch(() => '');
    await new Promise((r) => setTimeout(r, 700));
    const dismissReviewScript = `
tell application "System Events"
  tell process "Google Chrome"
    if (count of windows) > 0 then
      set w to front window
      set revElems to entire contents of w
      repeat with rel in revElems
        try
          if (role of rel) is "AXButton" then
            set rnm to (name of rel) as string
            if rnm is "Cancel" or rnm is "close" then
              click rel
              exit repeat
            end if
          end if
        end try
      end repeat
    end if
  end tell
end tell
return "done"
`;
    await runAppleScript(dismissReviewScript).catch(() => '');
    return {
      ended: true,
      message: 'Clicked "End Lab" and confirmed termination in Google Chrome.',
    };
  }
  return {
    ended: false,
    message: 'Could not locate an active "End Lab" button in the selected Chrome tab.',
  };
}

async function completeCourseActivityInUserChrome(
  windowId,
  tabIndex,
  activityUrl,
  activityType = 'link'
) {
  let targetWindowId = Number(windowId) || 0;
  let targetTabIndex = Number(tabIndex) || 1;
  if (!targetWindowId) {
    const tabs = await listUserChromeTabs();
    const labTab = tabs.find((t) => t.suggestedRole === 'lab');
    if (labTab) {
      targetWindowId = labTab.windowId;
      targetTabIndex = labTab.tabIndex;
    }
  }
  if (!targetWindowId) {
    return { ok: false, message: 'No Course tab found in Google Chrome.' };
  }

  if (activityUrl) {
    const escapedUrl = String(activityUrl).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const navScript = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${targetWindowId}" then
      if ${targetTabIndex} <= (count of tabs of w) then
        set t to tab ${targetTabIndex} of w
        if (URL of t) is not "${escapedUrl}" then
          set URL of t to "${escapedUrl}"
        end if
        set active tab index of w to ${targetTabIndex}
        set index of w to 1
        activate
        delay 0.8
        repeat 40 times
          if (loading of t) is false then exit repeat
          delay 0.25
        end repeat
        delay 1.5
        return "ok"
      end if
    end if
  end repeat
  return "not_found"
end tell
`;
    await runAppleScript(navScript).catch(() => '');
  }

  const completeJs = `(function(){
    try {
      var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
      if (csrf && (location.pathname.includes('/videos/') || location.pathname.includes('/documents/'))) {
        fetch(location.pathname + '/complete', {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrf },
          credentials: 'include'
        }).catch(function(){});
      }
      var yt = document.querySelector('ql-youtube-video');
      if (yt && yt.shadowRoot) {
        var links = yt.shadowRoot.querySelectorAll('a.timecode');
        if (links && links.length > 0) {
          links[links.length - 1].click();
        }
      }
      return 'ok';
    } catch(e) {
      return 'err';
    }
  })()`;
  const jsRes = await executeJsInUserChromeTab(targetWindowId, targetTabIndex, completeJs);

  if (!jsRes.ok && activityType === 'video') {
    const videoAxScript = `
tell application "Google Chrome" to activate
delay 0.3
tell application "System Events"
  tell process "Google Chrome"
    try
      set value of attribute "AXEnhancedUserInterface" to true
    end try
    delay 0.4
    if (count of windows) > 0 then
      set w to front window
      set allElems to entire contents of w
      set lastTimeLink to missing value
      repeat with el in allElems
        try
          if (role of el) is "AXLink" then
            set nm to (name of el) as string
            if nm contains ":" then
              set lastTimeLink to el
            end if
          end if
        end try
      end repeat
      if lastTimeLink is not missing value then
        click lastTimeLink
        return "clicked_timecode"
      end if
    end if
  end tell
end tell
return "done"
`;
    await runAppleScript(videoAxScript).catch(() => '');
    await new Promise((r) => setTimeout(r, 3500));
  } else {
    await new Promise((r) => setTimeout(r, 1200));
  }

  const snap = await snapshotUserChromeTabByTarget(targetWindowId, targetTabIndex);
  const htmlContent =
    snap && snap.htmlPath && fs.existsSync(snap.htmlPath)
      ? fs.readFileSync(snap.htmlPath, 'utf8')
      : '';
  return {
    ok: Boolean(htmlContent),
    url: snap?.url || activityUrl || '',
    title: snap?.title || '',
    htmlContent,
  };
}

async function submitCourseQuizInUserChrome(
  windowId,
  tabIndex,
  quizUrl,
  answers = [],
  needsRetakeFirst = false
) {
  let targetWindowId = Number(windowId) || 0;
  let targetTabIndex = Number(tabIndex) || 1;
  if (!targetWindowId) {
    const tabs = await listUserChromeTabs();
    const labTab = tabs.find((t) => t.suggestedRole === 'lab');
    if (labTab) {
      targetWindowId = labTab.windowId;
      targetTabIndex = labTab.tabIndex;
    }
  }
  if (!targetWindowId) {
    return { ok: false, message: 'No Course tab found in Google Chrome.' };
  }

  if (quizUrl) {
    const escapedUrl = String(quizUrl).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const navScript = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${targetWindowId}" then
      if ${targetTabIndex} <= (count of tabs of w) then
        set t to tab ${targetTabIndex} of w
        if (URL of t) is not "${escapedUrl}" then
          set URL of t to "${escapedUrl}"
        end if
        set active tab index of w to ${targetTabIndex}
        set index of w to 1
        activate
        delay 0.8
        repeat 40 times
          if (loading of t) is false then exit repeat
          delay 0.25
        end repeat
        delay 1.5
        return "ok"
      end if
    end if
  end repeat
  return "not_found"
end tell
`;
    await runAppleScript(navScript).catch(() => '');
  } else {
    await focusUserChromeTab(targetWindowId, targetTabIndex);
  }

  // First try direct JS execution if enabled in Chrome
  const answersJson = JSON.stringify(answers || []);
  const quizJs = `(function(ansList, doRetake){
    try {
      var q = document.querySelector('ql-quiz');
      if (!q || !q.shadowRoot) return 'no_quiz';
      function findDeep(root, pred) {
        var out = [];
        var walker = function(n) {
          if (!n) return;
          if (n.nodeType === 1) {
            if (pred(n)) out.push(n);
            if (n.shadowRoot) walker(n.shadowRoot);
          }
          var ch = n.childNodes || [];
          for (var i = 0; i < ch.length; i++) walker(ch[i]);
        };
        walker(root);
        return out;
      }
      if (doRetake) {
        var retakeBtns = findDeep(q.shadowRoot, function(el) {
          return el.classList && el.classList.contains('retake-button');
        });
        if (retakeBtns.length > 0) {
          retakeBtns[0].click();
          return 'retake_clicked';
        }
      }
      for (var i = 0; i < ansList.length; i++) {
        var a = ansList[i];
        if (a.choiceId) {
          var radios = findDeep(q.shadowRoot, function(el) {
            return el.id === 'radio-' + a.choiceId;
          });
          if (radios.length > 0) radios[0].click();
        }
      }
      setTimeout(function() {
        var subBtns = findDeep(q.shadowRoot, function(el) {
          return el.classList && el.classList.contains('submit-button');
        });
        if (subBtns.length > 0) subBtns[0].click();
        else if (typeof q.submit === 'function') q.submit();
      }, 600);
      return 'submitted_via_js';
    } catch(e) {
      return 'err:' + e.message;
    }
  })(${answersJson}, ${needsRetakeFirst ? 'true' : 'false'})`;

  const jsRes = await executeJsInUserChromeTab(targetWindowId, targetTabIndex, quizJs);
  if (jsRes.ok && jsRes.value === 'retake_clicked') {
    await new Promise((r) => setTimeout(r, 2200));
    await executeJsInUserChromeTab(
      targetWindowId,
      targetTabIndex,
      quizJs.replace(/,\s*true\)$/, ', false)')
    );
  }

  if (!jsRes.ok) {
    // Accessibility / System Events path when "Allow JavaScript from Apple Events" is off
    if (needsRetakeFirst) {
      const retakeAxScript = `
tell application "Google Chrome" to activate
delay 0.3
tell application "System Events"
  tell process "Google Chrome"
    try
      set value of attribute "AXEnhancedUserInterface" to true
    end try
    delay 0.5
    if (count of windows) > 0 then
      set w to front window
      set allElems to entire contents of w
      repeat with el in allElems
        try
          if (role of el) is "AXButton" then
            set nm to ""
            try
              set nm to (name of el) as string
            end try
            if nm is "" then
              try
                set nm to (description of el) as string
              end try
            end if
            if nm is "Retake" or nm starts with "Retake" then
              click el
              return "retake_clicked"
            end if
          end if
        end try
      end repeat
    end if
  end tell
end tell
return "no_retake"
`;
      const rOut = await runAppleScript(retakeAxScript).catch(() => '');
      if (rOut === 'retake_clicked') {
        await new Promise((r) => setTimeout(r, 2500));
        const reloadAfterRetake = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${targetWindowId}" then
      if ${targetTabIndex} <= (count of tabs of w) then
        set t to tab ${targetTabIndex} of w
        set URL of t to (URL of t)
        delay 0.8
        repeat 40 times
          if (loading of t) is false then exit repeat
          delay 0.25
        end repeat
        delay 1.2
      end if
      exit repeat
    end if
  end repeat
end tell
`;
        await runAppleScript(reloadAfterRetake).catch(() => '');
      }
    }

    // Read fresh snapshot to compute exact 1-based AXRadioButton ordinals across quizItems
    const preSnap = await snapshotUserChromeTabByTarget(targetWindowId, targetTabIndex);
    const targetRadioOrdinals = [];
    const targetCheckboxOrdinals = [];
    if (preSnap && preSnap.htmlPath && fs.existsSync(preSnap.htmlPath)) {
      try {
        const html = fs.readFileSync(preSnap.htmlPath, 'utf8');
        const qvMatch = html.match(/quizversion="([^"]+)"/i);
        if (qvMatch && qvMatch[1]) {
          const unescaped = qvMatch[1]
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#39;/g, "'");
          const qv = JSON.parse(unescaped);
          const quizItems = Array.isArray(qv.quizItems) ? qv.quizItems : [];
          let radioOffset = 0;
          let checkboxOffset = 0;
          for (let qIdx = 0; qIdx < quizItems.length; qIdx++) {
            const item = quizItems[qIdx];
            const opts = Array.isArray(item.options) ? item.options : [];
            const ans =
              (answers || []).find((a) => String(a.quizItemId) === String(item.id)) ||
              (answers || [])[qIdx];
            if (item.itemType === 'multiple-select') {
              const chosenIds = new Set(
                Array.isArray(ans?.choiceIds) ? ans.choiceIds.map(String) : []
              );
              for (let oIdx = 0; oIdx < opts.length; oIdx++) {
                if (chosenIds.has(String(opts[oIdx].id))) {
                  targetCheckboxOrdinals.push(checkboxOffset + oIdx + 1);
                }
              }
              checkboxOffset += opts.length;
            } else {
              const numOpts = item.itemType === 'true-false' ? 2 : opts.length;
              let chosenOptIdx =
                typeof ans?.optionIndex === 'number' && ans.optionIndex >= 0
                  ? ans.optionIndex
                  : 0;
              if (ans?.choiceId && opts.length > 0) {
                const foundIdx = opts.findIndex((o) => String(o.id) === String(ans.choiceId));
                if (foundIdx >= 0) chosenOptIdx = foundIdx;
              }
              targetRadioOrdinals.push(radioOffset + chosenOptIdx + 1);
              radioOffset += numOpts;
            }
          }
        }
      } catch {
        // Fallback below
      }
    }

    const radioIndicesAppleList = `{${targetRadioOrdinals.join(', ')}}`;
    const checkboxIndicesAppleList = `{${targetCheckboxOrdinals.join(', ')}}`;

    const selectAndSubmitAxScript = `
tell application "Google Chrome" to activate
delay 0.4
tell application "System Events"
  tell process "Google Chrome"
    try
      set value of attribute "AXEnhancedUserInterface" to true
    end try
    delay 0.6
    if (count of windows) > 0 then
      set w to front window
      set radioList to {}
      set checkList to {}
      set submitBtn to missing value
      repeat 3 times
        set radioList to {}
        set checkList to {}
        set submitBtn to missing value
        set allElems to entire contents of w
        repeat with el in allElems
          try
            set r to (role of el) as string
            if r is "AXRadioButton" then
              set end of radioList to el
            else if r is "AXCheckBox" then
              set end of checkList to el
            else if r is "AXButton" then
              set nm to ""
              try
                set nm to (name of el) as string
              end try
              if nm is "" then
                try
                  set nm to (description of el) as string
                end try
              end if
              if nm is "Submit" then
                set submitBtn to el
              end if
            end if
          end try
        end repeat
        if (count of radioList) > 0 or (count of checkList) > 0 then
          exit repeat
        end if
        delay 0.8
      end repeat

      set targetRadios to ${radioIndicesAppleList}
      repeat with idx in targetRadios
        set iVal to idx as integer
        if iVal >= 1 and iVal <= (count of radioList) then
          set rEl to item iVal of radioList
          try
            click rEl
          end try
          delay 0.25
          try
            set vStr to (value of rEl) as string
            if vStr is not "1" and vStr is not "true" then
              set focused of rEl to true
              delay 0.15
              keystroke space
              delay 0.2
            end if
          end try
          delay 0.35
        end if
      end repeat

      set targetChecks to ${checkboxIndicesAppleList}
      repeat with cIdx in targetChecks
        set cVal to cIdx as integer
        if cVal >= 1 and cVal <= (count of checkList) then
          set cEl to item cVal of checkList
          try
            click cEl
          end try
          delay 0.35
        end if
      end repeat

      delay 0.9
      if submitBtn is not missing value then
        try
          click submitBtn
        end try
        delay 0.3
        try
          set focused of submitBtn to true
          delay 0.15
          key code 36
        end try
        return "ax_submitted:" & (count of radioList)
      end if
      return "ax_no_submit_btn:" & (count of radioList)
    end if
  end tell
end tell
return "ax_no_window"
`;
    await runAppleScript(selectAndSubmitAxScript, 60000).catch(() => '');
  }

  await new Promise((r) => setTimeout(r, 2500));

  // Reload the quiz tab so the server-rendered quizresponse and contents-menu update
  const reloadScript = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${targetWindowId}" then
      if ${targetTabIndex} <= (count of tabs of w) then
        set t to tab ${targetTabIndex} of w
        set URL of t to (URL of t)
        delay 0.8
        repeat 40 times
          if (loading of t) is false then exit repeat
          delay 0.25
        end repeat
        delay 1.2
      end if
      exit repeat
    end if
  end repeat
end tell
`;
  await runAppleScript(reloadScript).catch(() => '');

  const postSnap = await snapshotUserChromeTabByTarget(targetWindowId, targetTabIndex);
  const htmlContent =
    postSnap && postSnap.htmlPath && fs.existsSync(postSnap.htmlPath)
      ? fs.readFileSync(postSnap.htmlPath, 'utf8')
      : '';
  return {
    ok: Boolean(htmlContent),
    url: postSnap?.url || quizUrl || '',
    title: postSnap?.title || '',
    htmlContent,
  };
}


function buildGoogleSignInStepJs(username, password) {
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

async function getChromeTabUrl(windowId, tabIndex) {
  const script = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${windowId}" then
      if ${tabIndex} <= (count of tabs of w) then
        return URL of tab ${tabIndex} of w
      end if
    end if
  end repeat
  return ""
end tell
`;
  return runAppleScript(script).catch(() => '');
}

/**
 * Spawns or reuses an Incognito window in the user's Mac Chrome, signs in as the temporary
 * lab student account, accepts Workspace & GCP Console ToS prompts, and opens both the
 * GCP Console tab and Cloud Shell tab.
 */
async function spawnIncognitoSessionInUserChrome({
  username,
  password,
  projectId,
  consoleUrl,
}) {
  const cleanUser = String(username || '').trim();
  const cleanPass = String(password || '').trim();
  const cleanProject = String(projectId || '').trim();
  const targetConsoleUrl = cleanProject
    ? `https://console.cloud.google.com/?project=${encodeURIComponent(cleanProject)}`
    : String(consoleUrl || 'https://console.cloud.google.com/');
  const targetCloudShellUrl = cleanProject
    ? `https://shell.cloud.google.com/?project=${encodeURIComponent(cleanProject)}&show=terminal`
    : 'https://shell.cloud.google.com/?show=terminal';

  // 1. Check if an existing Incognito window is already open (the user launches the initial Incognito window for Console & Cloud Shell)
  const existingTabs = await listUserChromeTabs();
  const existingIncognitoTabs = existingTabs.filter((t) => t.windowMode === 'incognito');
  if (existingIncognitoTabs.length > 0) {
    const matchingConsole =
      existingIncognitoTabs.find(
        (t) =>
          t.url.includes('console.cloud.google.com') &&
          !t.url.includes('accounts.google.com') &&
          (!cleanProject || t.url.includes(cleanProject))
      ) ||
      existingIncognitoTabs.find((t) => t.url.includes('console.cloud.google.com')) ||
      existingIncognitoTabs[0];
    if (matchingConsole) {
      const winId = matchingConsole.windowId;
      const shellTab = existingIncognitoTabs.find(
        (t) => t.windowId === winId && t.url.includes('shell.cloud.google.com')
      );
      return {
        ok: true,
        reused: true,
        windowId: winId,
        consoleTabKey: matchingConsole.key,
        cloudShellTabKey: shellTab ? shellTab.key : matchingConsole.key,
        tabs: existingTabs,
      };
    }
  }

  // 2. Only create an Incognito window if none is open yet
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
  const winIdStr = await runAppleScript(createIncognitoScript);
  const windowId = parseInt(winIdStr, 10);
  if (!Number.isFinite(windowId)) {
    throw new Error('Failed to create Incognito window in Google Chrome on macOS.');
  }

  // 4. Automate student sign-in + Workspace consent + GCP Console ToS
  if (cleanUser && cleanPass) {
    const signInJs = buildGoogleSignInStepJs(cleanUser, cleanPass);
    let pastedEmailViaAx = false;
    let pastedPassViaAx = false;
    let handledSpeedbumpViaAx = false;
    let consoleReadyCount = 0;

    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise((r) => setTimeout(r, 900));
      const jsStep = await executeJsInUserChromeTab(windowId, 1, signInJs);
      if (jsStep.ok) {
        if (jsStep.value === 'console_ready' || jsStep.value === 'console_tos_accepted') {
          consoleReadyCount++;
          if (consoleReadyCount >= 2) break;
        }
        continue;
      }

      // Fast non-JS fallback when Chrome's "Allow JavaScript from Apple Events" is turned off (never call `entire contents of w`):
      const currentUrl = await getChromeTabUrl(windowId, 1);
      if (
        currentUrl.includes('console.cloud.google.com') &&
        !currentUrl.includes('accounts.google.com')
      ) {
        break;
      }
      if (
        (currentUrl.includes('/identifier') ||
          currentUrl.includes('/ServiceLogin') ||
          currentUrl.includes('/AccountChooser')) &&
        !currentUrl.includes('/challenge/pwd') &&
        !pastedEmailViaAx
      ) {
        await sendTextToUserChromeTab(windowId, 1, cleanUser, true);
        pastedEmailViaAx = true;
      } else if (currentUrl.includes('/challenge/pwd') && !pastedPassViaAx) {
        await new Promise((r) => setTimeout(r, 500));
        await sendTextToUserChromeTab(windowId, 1, cleanPass, true);
        pastedPassViaAx = true;
      } else if (
        (currentUrl.includes('/speedbump/') || currentUrl.includes('/consent')) &&
        !handledSpeedbumpViaAx
      ) {
        handledSpeedbumpViaAx = true;
        const fastSpeedbumpKeys = `
tell application "Google Chrome" to activate
delay 0.2
tell application "System Events"
  tell process "Google Chrome"
    key code 121
    delay 0.2
    key code 48
    delay 0.15
    key code 36
  end tell
end tell
`;
        await runAppleScript(fastSpeedbumpKeys, 4000).catch(() => '');
        await new Promise((r) => setTimeout(r, 1200));
        const afterUrl = await getChromeTabUrl(windowId, 1);
        if (afterUrl.includes('accounts.google.com')) {
          await navigateOrOpenInUserChromeWindow(windowId, 1, targetConsoleUrl, false);
        }
        break;
      } else if (attempt >= 10) {
        break;
      }
    }
  }

  // 5. Open Cloud Shell in Tab 2 of the same Incognito window and keep Console in Tab 1
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
 * Isolated student gcloud configuration & direct Cloud Shell SSH execution
 */
const activeGcloudLogins = new Map();
const cloudShellFallbackProjects = new Set();

function getStudentGcloudConfigDir(username) {
  const safeUser = String(username || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const dir = path.join(SNAPSHOT_DIR, `gcloud-${safeUser}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function checkStudentGcloudAuth(username, projectId) {
  const configDir = getStudentGcloudConfigDir(username);
  // Also check if /tmp/ql_student_gcloud is already authenticated for this user
  for (const candidateDir of [configDir, '/tmp/ql_student_gcloud']) {
    if (!fs.existsSync(candidateDir)) continue;
    try {
      const { stdout } = await execFileAsync(
        'gcloud',
        ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
        {
          env: {
            ...process.env,
            CLOUDSDK_CONFIG: candidateDir,
            CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
          },
          timeout: 8000,
        }
      );
      const activeAccount = stdout.trim();
      if (activeAccount && activeAccount.toLowerCase() === String(username).toLowerCase()) {
        const { stdout: tokenOut } = await execFileAsync(
          'gcloud',
          ['auth', 'print-access-token', '--quiet'],
          {
            env: {
              ...process.env,
              CLOUDSDK_CONFIG: candidateDir,
              CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
            },
            timeout: 8000,
          }
        );
        if (tokenOut.trim().length > 10) {
          if (projectId) {
            await execFileAsync('gcloud', ['config', 'set', 'project', projectId, '--quiet'], {
              env: {
                ...process.env,
                CLOUDSDK_CONFIG: candidateDir,
                CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
              },
              timeout: 8000,
            }).catch(() => {});
          }
          return {
            authenticated: true,
            configDir: candidateDir,
            account: activeAccount,
            accessToken: tokenOut.trim(),
          };
        }
      }
    } catch {
      // Ignore expired or invalid config dir
    }
  }
  return { authenticated: false, configDir };
}

function ensureNoopBrowserBinDir() {
  const dir = path.join(SNAPSHOT_DIR, 'noop-browser-bin');
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const binName of ['noop-browser', 'open', 'osascript', 'xdg-open']) {
      const p = path.join(dir, binName);
      fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.chmodSync(p, 0o755);
    }
  } catch {
    // Ignore
  }
  return dir;
}

async function startStudentGcloudAuth(username, projectId, enableGdrive = false) {
  const existing = await checkStudentGcloudAuth(username, projectId);
  if (existing.authenticated) {
    return { alreadyAuthenticated: true, configDir: existing.configDir };
  }

  const prevEntry = activeGcloudLogins.get(username);
  if (prevEntry?.proc) {
    try {
      prevEntry.proc.kill();
    } catch {}
    activeGcloudLogins.delete(username);
  }

  const configDir = existing.configDir;
  const noopBinDir = ensureNoopBrowserBinDir();
  return new Promise((resolve, reject) => {
    const args = ['auth', 'login', '--quiet'];
    if (username) args.push(String(username).trim());
    if (enableGdrive) args.push('--enable-gdrive-access');
    if (projectId) args.push(`--project=${projectId}`);

    const proc = spawn('gcloud', args, {
      env: {
        ...process.env,
        CLOUDSDK_CONFIG: configDir,
        CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
        BROWSER: path.join(noopBinDir, 'noop-browser'),
        PATH: `${noopBinDir}:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`,
      },
    });

    let output = '';
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          proc.kill();
        } catch {}
        reject(new Error('Timed out waiting for gcloud auth login OAuth URL'));
      }
    }, 12000);

    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s"]+/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        activeGcloudLogins.set(username, { proc, configDir });
        resolve({ alreadyAuthenticated: false, oauthUrl: match[0], configDir });
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

async function finishStudentGcloudAuth(username, callbackUrl) {
  const entry = activeGcloudLogins.get(username);
  if (callbackUrl) {
    try {
      await fetch(callbackUrl);
    } catch {
      // Ignore
    }
  }
  if (entry?.proc) {
    await new Promise((r) => {
      const t = setTimeout(r, 5000);
      entry.proc.on('close', () => {
        clearTimeout(t);
        r();
      });
    });
    activeGcloudLogins.delete(username);
  }
  return checkStudentGcloudAuth(username);
}

/**
 * Completes the student `gcloud auth login` OAuth flow directly on the user's Mac
 * using the user's already-launched student Incognito Chrome window (where localhost callback hits local gcloud directly).
 */
async function ensureStudentGcloudAuth(username, password, projectId, preferredWindowId) {
  const initialCheck = await checkStudentGcloudAuth(username, projectId);
  if (initialCheck.authenticated) return initialCheck;

  const tabs = await listUserChromeTabs();
  let incWinId = Number(preferredWindowId) || 0;
  if (incWinId) {
    const isActuallyIncognito = tabs.some(
      (t) => t.windowId === incWinId && t.windowMode === 'incognito'
    );
    if (!isActuallyIncognito) incWinId = 0;
  }
  if (!incWinId) {
    const incTab =
      tabs.find((t) => t.windowMode === 'incognito' && t.suggestedRole === 'console') ||
      tabs.find((t) => t.windowMode === 'incognito' && t.suggestedRole === 'cloud_shell') ||
      tabs.find((t) => t.windowMode === 'incognito');
    if (incTab) incWinId = incTab.windowId;
  }
  if (!incWinId) {
    return checkStudentGcloudAuth(username, projectId);
  }

  for (const enableGdrive of [false, true]) {
    try {
      const started = await startStudentGcloudAuth(username, projectId, enableGdrive);
      if (started.alreadyAuthenticated) {
        return checkStudentGcloudAuth(username, projectId);
      }
      const oauthUrl = started.oauthUrl;
      if (!oauthUrl) continue;

      const escapedOauthUrl = oauthUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const openOauthTabScript = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${incWinId}" and (mode of w) is "incognito" then
      set newTab to make new tab at end of tabs of w with properties {URL:"${escapedOauthUrl}"}
      set tIdx to count of tabs of w
      set active tab index of w to tIdx
      set index of w to 1
      activate
      return tIdx as string
    end if
  end repeat
  return "0"
end tell
`;
      const tabIdxStr = await runAppleScript(openOauthTabScript).catch(() => '0');
      const oauthTabIdx = parseInt(tabIdxStr, 10) || 0;
      if (!oauthTabIdx) continue;

      const stepJs = buildGoogleSignInStepJs(username, password);
      let jsDisabled = false;
      for (let i = 0; i < 35; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const status = await checkStudentGcloudAuth(username, projectId);
        if (status.authenticated) {
          break;
        }
        if (!jsDisabled) {
          const jsOut = await executeJsInUserChromeTab(incWinId, oauthTabIdx, stepJs);
          if (jsOut.ok && jsOut.value && jsOut.value.startsWith('oauth_redirected:')) {
            const redirectedUrl = jsOut.value.slice('oauth_redirected:'.length);
            if (redirectedUrl.startsWith('http://localhost:')) {
              await fetch(redirectedUrl).catch(() => {});
            }
            await new Promise((r) => setTimeout(r, 1000));
            break;
          }
          if (!jsOut.ok && /turned off|Allow JavaScript/i.test(String(jsOut.error || ''))) {
            jsDisabled = true;
          }
        }
      }

      // Close the temporary OAuth tab in the Incognito window once done
      const closeOauthTabScript = `
tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as string) is "${incWinId}" and (mode of w) is "incognito" then
      if ${oauthTabIdx} <= (count of tabs of w) then
        close tab ${oauthTabIdx} of w
      end if
      set active tab index of w to 1
      exit repeat
    end if
  end repeat
end tell
`;
      await runAppleScript(closeOauthTabScript).catch(() => '');

      const finalStatus = await checkStudentGcloudAuth(username, projectId);
      if (finalStatus.authenticated) {
        return finalStatus;
      }
      if (jsDisabled) {
        break;
      }
    } catch {
      // Try next mode
    }
  }

  return checkStudentGcloudAuth(username, projectId);
}

async function execInLocalStudentWorkspace(authStatus, projectId, command, timeoutMs = 180000) {
  const safeProj = String(projectId || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const workspaceDir = path.join(SNAPSHOT_DIR, 'workspaces', safeProj);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const env = {
    ...process.env,
    HOME: workspaceDir,
    CLOUDSDK_CONFIG: authStatus.configDir,
    CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
    PYTHONUNBUFFERED: '1',
    GOOGLE_CLOUD_PROJECT: projectId || '',
    DEVSHELL_PROJECT_ID: projectId || '',
    CLOUDSDK_CORE_PROJECT: projectId || '',
    DRIVE_ACCESS_TOKEN: authStatus.accessToken || '',
    PATH: `${SSH_BIN_DIR}:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`,
  };

  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
      cwd: workspaceDir,
      env,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 15 * 1024 * 1024,
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (err) {
    return {
      ok: false,
      exitCode: err?.code || 1,
      stdout: String(err?.stdout || '').trim(),
      stderr: String(err?.stderr || err?.message || err).trim(),
    };
  }
}

async function execInStudentCloudShell(username, projectId, command, timeoutMs = 180000) {
  ensureCleanSshWrapperDir();
  const authStatus = await checkStudentGcloudAuth(username, projectId);
  if (!authStatus.authenticated) {
    return {
      ok: false,
      exitCode: -1,
      stdout: '',
      stderr: `Student account ${username} is not yet authenticated in gcloud.`,
    };
  }

  if (projectId && cloudShellFallbackProjects.has(projectId)) {
    return execInLocalStudentWorkspace(authStatus, projectId, command, timeoutMs);
  }

  try {
    const driveExport = authStatus.accessToken
      ? `export DRIVE_ACCESS_TOKEN="${authStatus.accessToken}"; `
      : '';
    const projExport = projectId
      ? `export GOOGLE_CLOUD_PROJECT="${projectId}"; export DEVSHELL_PROJECT_ID="${projectId}"; `
      : '';
    const envPrefix = `export CLOUDSDK_CORE_DISABLE_PROMPTS=1; export PYTHONUNBUFFERED=1; ${projExport}${driveExport}`;
    const fullScript = `${envPrefix}\n${command}`;
    const b64Script = Buffer.from(fullScript, 'utf8').toString('base64');
    const remoteCmd = `echo ${b64Script} | base64 -d > /tmp/ql_cmd_$$.sh && bash /tmp/ql_cmd_$$.sh < /dev/null; _ec=$?; rm -f /tmp/ql_cmd_$$.sh; exit $_ec`;
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
        env: {
          ...process.env,
          PATH: `${SSH_BIN_DIR}:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`,
          CLOUDSDK_CONFIG: authStatus.configDir,
          CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
        },
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 15 * 1024 * 1024,
      }
    );
    return {
      ok: true,
      exitCode: 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (err) {
    const errText = `${err?.stderr || ''} ${err?.message || ''}`;
    const isSshConnectionFailure =
      err?.code === 255 ||
      /exited with return code \[255\]|403 Forbidden|helper\.go|Failed to initialize session|Connection closed by UNKNOWN|Connection refused|Operation timed out|Cloud Shell is disabled/i.test(
        errText
      );
    if (isSshConnectionFailure) {
      if (projectId) cloudShellFallbackProjects.add(projectId);
      console.log(
        `ℹ️  Cloud Shell SSH unavailable (${errText.slice(0, 120).trim()}); executing in isolated local student workspace...`
      );
      return execInLocalStudentWorkspace(authStatus, projectId, command, timeoutMs);
    }
    return {
      ok: false,
      exitCode: err?.code || 1,
      stdout: String(err?.stdout || '').trim(),
      stderr: String(err?.stderr || err?.message || err).trim(),
    };
  }
}

let ws = null;
let shuttingDown = false;
let pingTimer = null;

async function pushTabsOnce() {
  if (!ws || ws.readyState !== 1) return;
  try {
    const tabs = await listUserChromeTabs();
    ws.send(JSON.stringify({ type: 'tabs_push', tabs }));
    console.log(`📋 Synced ${tabs.length} open Chrome tabs with Skills Runner.`);
  } catch {
    // Ignore
  }
}

function resolveEffectiveBridgeUrl() {
  let savedSession = '';
  try {
    if (fs.existsSync(SESSION_ID_FILE)) {
      savedSession = fs.readFileSync(SESSION_ID_FILE, 'utf8').trim();
    }
  } catch {}
  const activeSession = (
    cliSessionArg ||
    process.env.SKILLS_RUNNER_SESSION_ID ||
    savedSession ||
    ''
  ).trim();
  if (activeSession && !CLOUD_RUN_WS_URL.includes('session=')) {
    const sep = CLOUD_RUN_WS_URL.includes('?') ? '&' : '?';
    return `${CLOUD_RUN_WS_URL}${sep}session=${encodeURIComponent(activeSession)}`;
  }
  return CLOUD_RUN_WS_URL;
}

async function connectBridge() {
  if (shuttingDown) return;
  const targetWsUrl = resolveEffectiveBridgeUrl();
  console.log(`🔗 Connecting On-Demand Mac Chrome Bridge to ${targetWsUrl}...`);
  console.log(
    `ℹ️  Passive Mode: Zero background polling (only runs when you click an action in the Skills Runner UI).`
  );
  console.log(`ℹ️  Press Ctrl+C anytime (or click "Stop Mac Bridge" in the web UI) to exit.\n`);

  const WSImpl =
    globalThis.WebSocket || (await import('ws').then((m) => m.default || m.WebSocket));
  ws = new WSImpl(targetWsUrl);

  const onOpen = async () => {
    console.log('✅ Mac Chrome Bridge connected to Cloud Run!');
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // Ignore
        }
      }
    }, 20000);
    await pushTabsOnce();
  };

  const onMessage = async (rawEvent) => {
    try {
      const rawStr =
        typeof rawEvent?.data === 'string'
          ? rawEvent.data
          : rawEvent?.data
          ? Buffer.from(rawEvent.data).toString('utf8')
          : rawEvent.toString();
      const msg = JSON.parse(rawStr);

      if (msg.type === 'ping') {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
        return;
      }
      if (msg.type === 'pong') {
        return;
      }
      if (msg.type === 'assign_session' && msg.sessionId) {
        try {
          fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
          fs.writeFileSync(SESSION_ID_FILE, String(msg.sessionId).trim(), 'utf8');
        } catch {}
        return;
      }

      if (msg.type === 'shutdown' || msg.type === 'superseded') {
        console.log(
          msg.type === 'superseded'
            ? '🛑 Another Mac Bridge instance connected to Cloud Run. Exiting this duplicate instance cleanly...'
            : '🛑 Received stop signal from Skills Runner UI. Exiting cleanly...'
        );
        shuttingDown = true;
        if (pingTimer) clearInterval(pingTimer);
        try {
          ws.close();
        } catch {
          // Ignore
        }
        process.exit(0);
      }

      if (msg.type !== 'rpc_request' || !msg.id) return;

      const { id, method, params = {} } = msg;
      console.log(`⚡ Executing UI request: ${method}`);
      try {
        let result = null;

        if (method === 'list_tabs') {
          result = await listUserChromeTabs();
        } else if (method === 'focus_tab') {
          result = await focusUserChromeTab(Number(params.windowId), Number(params.tabIndex));
        } else if (method === 'open_or_focus_lab') {
          result = await openOrFocusLabInUserChrome(String(params.requestedUrl || ''));
        } else if (method === 'spawn_incognito_session') {
          result = await spawnIncognitoSessionInUserChrome({
            username: params.username,
            password: params.password,
            projectId: params.projectId,
            consoleUrl: params.consoleUrl,
          });
          await pushTabsOnce();
        } else if (method === 'snapshot_tab_by_target') {
          const snap = await snapshotUserChromeTabByTarget(
            Number(params.windowId),
            Number(params.tabIndex)
          );
          if (snap && snap.htmlPath && fs.existsSync(snap.htmlPath)) {
            result = {
              htmlContent: fs.readFileSync(snap.htmlPath, 'utf8'),
              url: snap.url,
              title: snap.title,
            };
          }
        } else if (method === 'snapshot_lab_tab') {
          const snap = await snapshotUserChromeLabTab(
            params.preferredUrl,
            params.preferredTarget
          );
          if (snap && snap.htmlPath && fs.existsSync(snap.htmlPath)) {
            result = {
              htmlContent: fs.readFileSync(snap.htmlPath, 'utf8'),
              url: snap.url,
              title: snap.title,
            };
          }
        } else if (method === 'check_progress') {
          result = await checkProgressInUserChrome(
            params.stepNumber,
            params.labUrl,
            params.labInstanceId,
            params.windowId,
            params.tabIndex
          );
        } else if (method === 'check_gcloud_auth') {
          result = await checkStudentGcloudAuth(params.username, params.projectId);
        } else if (method === 'ensure_gcloud_auth') {
          result = await ensureStudentGcloudAuth(
            params.username,
            params.password,
            params.projectId,
            params.windowId
          );
        } else if (method === 'start_gcloud_auth') {
          result = await startStudentGcloudAuth(params.username, params.projectId);
        } else if (method === 'finish_gcloud_auth') {
          result = await finishStudentGcloudAuth(params.username, params.callbackUrl);
        } else if (method === 'exec_cloud_shell') {
          result = await execInStudentCloudShell(
            params.username,
            params.projectId,
            params.command,
            params.timeoutMs || 180000
          );
        } else if (method === 'navigate_tab') {
          result = await navigateOrOpenInUserChromeWindow(
            Number(params.windowId),
            params.tabIndex !== null && params.tabIndex !== undefined
              ? Number(params.tabIndex)
              : null,
            String(params.url || ''),
            Boolean(params.openInNewTab)
          );
        } else if (method === 'send_text') {
          result = await sendTextToUserChromeTab(
            Number(params.windowId),
            Number(params.tabIndex),
            String(params.text || ''),
            params.pressEnter !== false
          );
        } else if (method === 'start_lab') {
          result = await clickStartLabInUserChrome(
            params.preferredUrl,
            params.preferredTarget
          );
        } else if (method === 'end_lab') {
          result = await clickEndLabInUserChrome(
            params.preferredUrl,
            params.preferredTarget
          );
        } else if (method === 'complete_course_activity') {
          result = await completeCourseActivityInUserChrome(
            params.windowId,
            params.tabIndex,
            params.activityUrl,
            params.activityType
          );
        } else if (method === 'submit_course_quiz') {
          result = await submitCourseQuizInUserChrome(
            params.windowId,
            params.tabIndex,
            params.quizUrl,
            params.answers,
            Boolean(params.needsRetakeFirst)
          );
        } else if (method === 'save_state') {
          fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
          const payload = {
            savedAt: new Date().toISOString(),
            state: params.state || {},
          };
          fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(payload, null, 2), 'utf8');
          result = { ok: true, savedAt: payload.savedAt, path: STATE_FILE_PATH };
        } else if (method === 'load_state') {
          if (fs.existsSync(STATE_FILE_PATH)) {
            const raw = fs.readFileSync(STATE_FILE_PATH, 'utf8');
            result = JSON.parse(raw);
          } else {
            result = null;
          }
        } else if (method === 'clear_state') {
          try {
            if (fs.existsSync(STATE_FILE_PATH)) {
              fs.unlinkSync(STATE_FILE_PATH);
            }
          } catch {}
          result = { ok: true };
        } else if (method === 'close_incognito_windows') {
          const closeScript = `
tell application "Google Chrome"
  set closedCount to 0
  set winList to every window
  repeat with w in winList
    try
      if (mode of w) is "incognito" then
        close w
        set closedCount to closedCount + 1
      end if
    end try
  end repeat
  return closedCount as string
end tell
`;
          const closedStr = await runAppleScript(closeScript).catch(() => '0');
          try {
            if (fs.existsSync(STATE_FILE_PATH)) {
              fs.unlinkSync(STATE_FILE_PATH);
            }
          } catch {}
          result = { ok: true, closedWindows: parseInt(closedStr, 10) || 0 };
        } else if (method === 'shutdown') {
          shuttingDown = true;
          if (pingTimer) clearInterval(pingTimer);
          ws.send(JSON.stringify({ type: 'rpc_response', id, result: true }));
          process.exit(0);
        } else {
          throw new Error(`Unknown RPC method: ${method}`);
        }

        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'rpc_response', id, result }));
        }
      } catch (err) {
        if (ws && ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: 'rpc_response',
              id,
              error: err?.message || String(err),
            })
          );
        }
      }
    } catch {
      // Ignore malformed frame
    }
  };

  const onClose = (closeEvent) => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (shuttingDown) return;
    const code = typeof closeEvent === 'number' ? closeEvent : closeEvent?.code;
    if (code === 4001) {
      console.log('🛑 Superseded by a newer Mac Bridge connection. Exiting cleanly...');
      shuttingDown = true;
      process.exit(0);
    }
    console.log('⚠️ Connection to Cloud Run closed. Reconnecting in 3s...');
    setTimeout(connectBridge, 3000);
  };

  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', () => {});
  } else if (typeof ws.on === 'function') {
    ws.on('open', onOpen);
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', () => {});
  }
}

connectBridge();
