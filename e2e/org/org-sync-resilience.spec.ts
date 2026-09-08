import { test, expect } from "@playwright/test";
import { mockTauri } from "../settings-ai/mock-invoke";

/**
 * Settings › Organizations — the panel must not LIE about org state.
 *
 * Two reported failures, both of which the section reported as good news:
 *
 *  1. "sometimes I can't see the organizations and the background is empty, I have to open Settings
 *     again". The roster lived in a component-local signal inside a `@switch`, so it was wiped on
 *     every remount, and a read that FAILED fell through to the same branch as a read that found
 *     nothing: "You're not in any organization yet — create one, or ask a teammate to invite you by
 *     email." A member of two orgs was told they belonged to none, and the only recovery was to
 *     leave the section and come back hoping for a luckier attempt.
 *
 *  2. "Sync now never finishes / it works with a delay". A manual sync takes bounded feed pages, and
 *     a drain that stopped on its own cap used to be indistinguishable from one that caught up — the
 *     panel said "Synced — up to date." about an org that was still behind.
 *
 * Driven with a mocked Tauri IPC (no Rust core): render + honesty, not end-to-end sync.
 * Overrides run PAGE-SIDE (serialized to strings), so they must be self-contained.
 */

const ACCOUNT_STATUS = () => ({
  loggedIn: true,
  email: "you@example.com",
  unlockedForSharing: true,
  shareConsented: true,
  serverConfigured: true,
  biometricUnlockAvailable: true,
});

const EMPTY_STATE_COPY =
  "You're not in any organization yet — create one, or ask a teammate to invite you by email.";

async function openOrgSection(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.getByRole("button", { name: "Organization" }).first().click();
  await expect(page.locator("app-settings-organization-section")).toBeVisible({
    timeout: 10_000,
  });
}

test.describe("Settings › Organizations — honest state (mocked IPC)", () => {
  test("a FAILED roster read keeps the known orgs and never claims the user is in none", async ({
    page,
  }) => {
    // Succeeds once (the first open), then fails forever — the shape of a relay that goes away
    // mid-session, which is when the user hit this.
    await mockTauri(page, {
      account_status: ACCOUNT_STATUS,
      org_refresh: () => null,
      org_list_statuses: () => {
        const w = window as unknown as { __orgReads?: number };
        w.__orgReads = (w.__orgReads ?? 0) + 1;
        if (w.__orgReads > 1) {
          throw new Error("relay unreachable");
        }
        return [
          {
            orgId: "org-owned",
            name: "Acme Inc.",
            role: "owner",
            memberCount: 3,
            consented: true,
            lastSeq: 42,
            itemCount: 12,
            receivedCount: 12,
            pendingShares: 0,
            contextEnabled: true,
          },
        ];
      },
      org_status: () => null,
    });

    await page.goto("/settings");
    await openOrgSection(page);
    await expect(page.locator(".org-card", { hasText: "Acme Inc." })).toBeVisible();

    // Leave the section and come back: the component is destroyed and recreated, and its reload
    // now fails. RED before the fix: the card disappears and the empty-state copy appears.
    await page.getByRole("button", { name: "Account" }).first().click();
    await openOrgSection(page);

    await expect(
      page.locator(".org-card", { hasText: "Acme Inc." }),
    ).toBeVisible();
    await expect(page.getByText(EMPTY_STATE_COPY)).toHaveCount(0);
    await expect(
      page.getByText("Couldn't refresh your organizations just now"),
    ).toBeVisible();
  });

  test("a destroyed section's late response cannot overwrite the live roster", async ({
    page,
  }) => {
    // Call #1 — the instance the user is about to leave — resolves slowly with STALE. Every later
    // call resolves at once with FRESH. Moving the roster into a root store made this matter: the
    // stale-result guard was a COMPONENT field, so a destroyed instance's response still matched
    // its own token and wrote over data a newer instance had already rendered. Before the move the
    // write landed on a dead component-local signal and was invisible.
    await mockTauri(page, {
      account_status: ACCOUNT_STATUS,
      org_refresh: () => null,
      org_status: () => null,
      org_list_statuses: () => {
        const w = window as unknown as { __rosterReads?: number };
        w.__rosterReads = (w.__rosterReads ?? 0) + 1;
        const row = (name: string) => [
          {
            orgId: "org-owned",
            name,
            role: "owner",
            memberCount: 3,
            consented: true,
            lastSeq: 42,
            itemCount: 12,
            receivedCount: 12,
            pendingShares: 0,
            contextEnabled: true,
          },
        ];
        if (w.__rosterReads === 1) {
          return new Promise((resolve) =>
            setTimeout(() => resolve(row("STALE ORG")), 3000),
          );
        }
        return row("FRESH ORG");
      },
    });

    await page.goto("/settings");
    // Do not wait for the first (slow) read: leave while it is still in flight.
    await page.getByRole("button", { name: "Organization" }).first().click();
    await page.getByRole("button", { name: "Account" }).first().click();
    await openOrgSection(page);
    await expect(
      page.locator(".org-card", { hasText: "FRESH ORG" }),
    ).toBeVisible();

    // Let the abandoned instance's response land. RED before the shared load token: it replaces
    // FRESH with STALE, with no user action in between.
    await page.waitForTimeout(4000);
    await expect(
      page.locator(".org-card", { hasText: "FRESH ORG" }),
    ).toBeVisible();
    await expect(page.locator(".org-card", { hasText: "STALE ORG" })).toHaveCount(
      0,
    );
  });

  test("a CAPPED sync says more is still coming instead of 'up to date'", async ({
    page,
  }) => {
    await mockTauri(page, {
      account_status: ACCOUNT_STATUS,
      org_refresh: () => null,
      org_list_statuses: () => [
        {
          orgId: "org-owned",
          name: "Acme Inc.",
          role: "owner",
          memberCount: 3,
          consented: true,
          lastSeq: 42,
          itemCount: 12,
          receivedCount: 12,
          pendingShares: 0,
          contextEnabled: true,
        },
      ],
      org_status: () => null,
      org_sync_now: () => ({
        pulled: 160,
        ingested: 40,
        tombstoned: 0,
        lastSeq: 202,
        ftsOnly: false,
        errors: [],
        morePending: true,
      }),
    });

    await page.goto("/settings");
    await openOrgSection(page);
    const card = page.locator(".org-card", { hasText: "Acme Inc." });
    await card.getByRole("button", { name: "Sync now" }).click();

    const toast = page.locator(".toast.is-success .toast-msg");
    await expect(toast).toContainText("40 new items");
    // RED before the fix: the toast stopped at the item count, so a press that ran into its own
    // page cap read exactly like a completed sync.
    await expect(toast).toContainText("More is still arriving in the background.");
    // And the button comes back — a sync that ends must never leave the control parked.
    await expect(card.getByRole("button", { name: "Sync now" })).toBeEnabled();
  });

  test("the Sync now button reports the live stage while the sync runs", async ({
    page,
  }) => {
    // `org_sync_now` parks until the test releases it, so the press is observably in flight while
    // progress events land — the situation a user reported as "it keeps syncing and you don't know
    // the status".
    await mockTauri(page, {
      account_status: ACCOUNT_STATUS,
      org_refresh: () => null,
      org_list_statuses: () => [
        {
          orgId: "org-owned",
          name: "Acme Inc.",
          role: "owner",
          memberCount: 3,
          consented: true,
          lastSeq: 42,
          itemCount: 12,
          receivedCount: 12,
          pendingShares: 0,
          contextEnabled: true,
        },
      ],
      org_status: () => null,
      org_sync_now: () =>
        new Promise((resolve) => {
          (
            window as unknown as { __releaseSync: () => void }
          ).__releaseSync = () =>
            resolve({
              pulled: 12,
              ingested: 12,
              tombstoned: 0,
              lastSeq: 54,
              ftsOnly: false,
              errors: [],
              morePending: false,
            });
        }),
    });

    await page.goto("/settings");
    await openOrgSection(page);
    const card = page.locator(".org-card", { hasText: "Acme Inc." });
    const button = card.getByRole("button", { name: /Sync/ });
    await button.click();
    await expect(button).toHaveText("Syncing…");

    // RED before the fix: no progress event exists, so the label never moves off "Syncing…".
    await page.evaluate(() =>
      (
        window as unknown as {
          __demoEmit: (event: string, payload: unknown) => void;
        }
      ).__demoEmit("murmur://org-sync-progress", {
        orgId: "org-owned",
        stage: "feed",
        pulled: 8,
        ingested: 8,
      }),
    );
    await expect(button).toHaveText("Syncing… 8");

    await page.evaluate(() =>
      (
        window as unknown as {
          __demoEmit: (event: string, payload: unknown) => void;
        }
      ).__demoEmit("murmur://org-sync-progress", {
        orgId: "org-owned",
        stage: "containers",
        pulled: 12,
        ingested: 12,
      }),
    );
    await expect(button).toHaveText("Syncing folders…");

    await page.evaluate(() =>
      (window as unknown as { __releaseSync: () => void }).__releaseSync(),
    );
    await expect(page.locator(".toast.is-success .toast-msg")).toContainText(
      "12 new items",
    );
    await expect(button).toHaveText("Sync now");
  });

  test("a progress event outside a press cannot make the button claim it is syncing", async ({
    page,
  }) => {
    // The progress listener is guarded by "is THIS org syncing", and that guard is documented as
    // having one bound: a trailing event from a finished press, arriving during the next press on
    // the same org, is accepted. Correlating presses needs an id echoed through the command, which
    // the symptom — one page's worth of stale count — does not earn. What CAN be pinned cheaply is
    // the half that matters: a progress event with no press in flight must change nothing. Without
    // it, a later change that makes the label sticky or reuses the progress signal across presses
    // reintroduces the whole class silently.
    await mockTauri(page, {
      account_status: ACCOUNT_STATUS,
      org_refresh: () => null,
      org_status: () => null,
      org_list_statuses: () => [
        {
          orgId: "org-owned",
          name: "Acme Inc.",
          role: "owner",
          memberCount: 3,
          consented: true,
          lastSeq: 42,
          itemCount: 12,
          receivedCount: 12,
          pendingShares: 0,
          contextEnabled: true,
        },
      ],
    });

    await page.goto("/settings");
    await openOrgSection(page);
    const button = page
      .locator(".org-card", { hasText: "Acme Inc." })
      .getByRole("button", { name: /Sync/ });
    await expect(button).toHaveText("Sync now");

    await page.evaluate(() =>
      (
        window as unknown as {
          __demoEmit: (event: string, payload: unknown) => void;
        }
      ).__demoEmit("murmur://org-sync-progress", {
        orgId: "org-owned",
        stage: "feed",
        pulled: 99,
        ingested: 99,
      }),
    );

    await expect(button).toHaveText("Sync now");
    await expect(button).toBeEnabled();
  });

  // CONTROL, not coverage: this one passes against the pre-fix components too. It is here so the
  // three assertions above cannot be satisfied by a change that simply stops saying "up to date".
  test("a sync that finds nothing new still says up to date", async ({
    page,
  }) => {
    await mockTauri(page, {
      account_status: ACCOUNT_STATUS,
      org_refresh: () => null,
      org_list_statuses: () => [
        {
          orgId: "org-owned",
          name: "Acme Inc.",
          role: "owner",
          memberCount: 3,
          consented: true,
          lastSeq: 42,
          itemCount: 12,
          receivedCount: 12,
          pendingShares: 0,
          contextEnabled: true,
        },
      ],
      org_status: () => null,
      org_sync_now: () => ({
        pulled: 0,
        ingested: 0,
        tombstoned: 0,
        lastSeq: 42,
        ftsOnly: false,
        errors: [],
        morePending: false,
      }),
    });

    await page.goto("/settings");
    await openOrgSection(page);
    await page
      .locator(".org-card", { hasText: "Acme Inc." })
      .getByRole("button", { name: "Sync now" })
      .click();

    await expect(page.locator(".toast.is-success .toast-msg")).toContainText(
      "Synced — up to date.",
    );
  });
});
