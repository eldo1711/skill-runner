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

const CLOUD_RUN_WS_URL =
  process.env.CLOUD_RUN_WS_URL ||
  (cliUrlArg ? (cliUrlArg.endsWith('/ws-bridge') ? cliUrlArg : `${cliUrlArg}/ws-bridge`) : '') ||
  'wss://skills-runner-621653283297.us-central1.run.app/ws-bridge';

const SNAPSHOT_DIR = path.join(os.homedir(), '.cloud-skills-lab-runner');
const SNAPSHOT_HTML_PATH = path.join(SNAPSHOT_DIR, 'live_lab_snapshot.html');
const SNAPSHOT_FILES_DIR = path.join(SNAPSHOT_DIR, 'live_lab_snapshot_files');

async function runAppleScript(script, timeoutMs = 35000) {
  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
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
      fs.rmSync(SNAPSHOT_FILES_DIR, { recursive: true, force: true });
    }
  } catch {
    // Ignore
  }
  if (!fs.existsSync(SNAPSHOT_HTML_PATH)) return null;
  return { htmlPath: SNAPSHOT_HTML_PATH, url: url || '', title: title || '' };
}

async function snapshotUserChromeLabTab(preferredUrl, preferredTarget) {
  if (preferredTarget?.windowId && preferredTarget?.tabIndex) {
    const byTarget = await snapshotUserChromeTabByTarget(
      Number(preferredTarget.windowId),
      Number(preferredTarget.tabIndex)
    );
    if (byTarget) return byTarget;
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
      set idx to 0
      repeat with el in allElems
        set idx to idx + 1
        if idx > 350 then exit repeat
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
      set idx to 0
      repeat with fel in followElems
        set idx to idx + 1
        if idx > 350 then exit repeat
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
      set idx to 0
      repeat with el in allElems
        set idx to idx + 1
        if idx > 350 then exit repeat
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

/**
 * Isolated student gcloud configuration & direct Cloud Shell SSH execution
 */
const activeGcloudLogins = new Map();

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

async function startStudentGcloudAuth(username, projectId) {
  const existing = await checkStudentGcloudAuth(username, projectId);
  if (existing.authenticated) {
    return { alreadyAuthenticated: true, configDir: existing.configDir };
  }

  const configDir = existing.configDir;
  return new Promise((resolve, reject) => {
    const args = ['auth', 'login', '--enable-gdrive-access', '--quiet'];
    if (projectId) args.push(`--project=${projectId}`);

    const proc = spawn('gcloud', args, {
      env: { ...process.env, CLOUDSDK_CONFIG: configDir, BROWSER: '/usr/bin/true' },
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
  try {
    await fetch(callbackUrl);
  } catch {
    // Ignore
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

async function execInStudentCloudShell(username, projectId, command, timeoutMs = 180000) {
  const authStatus = await checkStudentGcloudAuth(username, projectId);
  if (!authStatus.authenticated) {
    return {
      ok: false,
      exitCode: -1,
      stdout: '',
      stderr: `Student account ${username} is not yet authenticated in gcloud.`,
    };
  }

  try {
    const driveExport = authStatus.accessToken
      ? `export DRIVE_ACCESS_TOKEN="${authStatus.accessToken}"; `
      : '';
    const envPrefix = `export CLOUDSDK_CORE_DISABLE_PROMPTS=1; ${driveExport}`;
    const { stdout, stderr } = await execFileAsync(
      'gcloud',
      [
        'cloud-shell',
        'ssh',
        '--authorize-session',
        `--command=${envPrefix}${command}`,
        '--quiet',
      ],
      {
        env: {
          ...process.env,
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

async function connectBridge() {
  if (shuttingDown) return;
  console.log(`🔗 Connecting On-Demand Mac Chrome Bridge to ${CLOUD_RUN_WS_URL}...`);
  console.log(
    `ℹ️  Passive Mode: Zero background polling (only runs when you click an action in the Skills Runner UI).`
  );
  console.log(`ℹ️  Press Ctrl+C anytime (or click "Stop Mac Bridge" in the web UI) to exit.\n`);

  const WSImpl =
    globalThis.WebSocket || (await import('ws').then((m) => m.default || m.WebSocket));
  ws = new WSImpl(CLOUD_RUN_WS_URL);

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
