import { Page } from 'playwright';
import { LabCredentials } from './types.js';

/**
 * Automates the Google Cloud Console sign-in flow inside the isolated Incognito window
 * using the temporary Qwiklabs student credentials, including Workspace speedbumps
 * and the GCP Console first-time Terms of Service modal.
 */
export async function signInToCloudConsoleIncognito(
  page: Page,
  creds: LabCredentials,
  onLog: (msg: string) => void
): Promise<boolean> {
  let targetUrl =
    creds.consoleUrl ||
    (creds.projectId
      ? `https://console.cloud.google.com/?project=${creds.projectId}`
      : 'https://console.cloud.google.com/');

  // If consoleUrl is a Qwiklabs /google_sso wrapper with a `relay` param, extract the direct Console URL
  // so the unauthenticated Incognito window goes straight to Google Cloud Console login for the student account
  if (targetUrl.includes('/google_sso')) {
    try {
      const parsedUrl = new URL(targetUrl);
      const relay = parsedUrl.searchParams.get('relay');
      if (relay && relay.includes('console.cloud.google.com')) {
        targetUrl = relay;
      }
    } catch {
      // Ignore invalid URL
    }
  }

  onLog(`Opening Incognito window and navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);

  // If no username is provided yet, just leave the console open for manual sign-in
  if (!creds.username || !creds.password) {
    onLog(
      'No student username/password extracted yet — Incognito window is open for manual login or after Start Lab.'
    );
    return false;
  }

  try {
    // Step 1: If account chooser is shown, click "Use another account"
    const useAnother = page.locator('text="Use another account"').first();
    if ((await useAnother.count()) > 0 && (await useAnother.isVisible())) {
      onLog('Selecting "Use another account" on Google account chooser...');
      await useAnother.click();
      await page.waitForTimeout(1500);
    }

    // Step 2: Email / Username input
    const emailInput = page
      .locator('input[type="email"], input#identifierId, input[name="identifier"]')
      .first();
    if ((await emailInput.count()) > 0 && (await emailInput.isVisible())) {
      onLog(`Entering student username: ${creds.username}`);
      await emailInput.fill(creds.username);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2500);
    }

    // Step 3: Password input
    const passwordInput = page
      .locator('input[type="password"], input[name="Passwd"]')
      .first();
    try {
      await passwordInput.waitFor({ state: 'visible', timeout: 12000 });
      onLog('Entering temporary lab password...');
      await passwordInput.fill(creds.password);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3500);
    } catch {
      onLog('Password prompt did not appear within 12s (checking if already authenticated or on consent screen)...');
    }

    // Step 4: Handle Google Workspace "Welcome to your new account" / "I understand" speedbump
    const consentSelectors = [
      'input#confirm',
      'button:has-text("I understand")',
      'button:has-text("Accept")',
      'button:has-text("Continue")',
      '#confirm',
    ];
    for (const sel of consentSelectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        onLog(`Accepting Google Workspace new account consent (${sel})...`);
        await btn.click();
        await page.waitForTimeout(3000);
        break;
      }
    }

    // Step 5: Wait for redirect to console.cloud.google.com
    onLog('Waiting for Google Cloud Console workspace to initialize...');
    await page.waitForTimeout(5000);

    // Ensure project ID is selected in the Console URL
    if (
      creds.projectId &&
      page.url().includes('console.cloud.google.com') &&
      !page.url().includes(`project=${creds.projectId}`)
    ) {
      const sep = page.url().includes('?') ? '&' : '?';
      await page.goto(`${page.url()}${sep}project=${creds.projectId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await page.waitForTimeout(3000);
    }

    // Step 6: Dismiss GCP Console first-time Terms of Service modal if present
    await dismissGcpConsoleTermsModal(page, onLog);

    const signedIn = page.url().includes('console.cloud.google.com');
    if (signedIn) {
      onLog(
        `Successfully signed into Google Cloud Console in Incognito window (Project: ${creds.projectId || 'active'})!`
      );
    }
    return signedIn;
  } catch (err: any) {
    onLog(`Console sign-in encountered an interruption: ${err?.message || String(err)}`);
    return page.url().includes('console.cloud.google.com');
  }
}

/**
 * Automatically checks the Terms of Service checkbox and clicks "Agree and continue"
 * when opening a fresh Qwiklabs student account in Google Cloud Console.
 */
export async function dismissGcpConsoleTermsModal(
  page: Page,
  onLog: (msg: string) => void
): Promise<void> {
  try {
    const agreeBtn = page
      .locator(
        'button:has-text("Agree and continue"), button:has-text("AGREE AND CONTINUE")'
      )
      .first();

    if ((await agreeBtn.count()) > 0 || (await page.locator('mat-dialog-container').count()) > 0) {
      // Check any required ToS checkbox inside the dialog
      const checkboxes = page.locator(
        'mat-dialog-container mat-checkbox, mat-dialog-container input[type="checkbox"], [role="dialog"] input[type="checkbox"]'
      );
      const count = await checkboxes.count();
      if (count > 0) {
        onLog('Checking Google Cloud Terms of Service agreement checkbox...');
        await checkboxes.first().click({ force: true });
        await page.waitForTimeout(600);
      }

      if ((await agreeBtn.count()) > 0 && (await agreeBtn.isVisible())) {
        onLog('Clicking "Agree and continue" on GCP Terms modal...');
        await agreeBtn.click({ force: true });
        await page.waitForTimeout(1500);
      }
    }
  } catch {
    // Non-fatal if modal already dismissed
  }
}
