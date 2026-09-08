import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
} from "@angular/core";
import { RouterLink } from "@angular/router";
import { IpcService } from "../../../../core/ipc.service";
import { ToastService } from "../../../../services/toast.service";
import type {
  OrgItemHeader,
  OrgMember,
  OrgStatus,
  OrgSyncProgress,
} from "../../../../core/models";
import { ErrorCopyService } from "../../../../core/copy/error-copy.service";
import { DateFormatService } from "../../../../core/date-format.service";
import { OrgRosterStore } from "../../../../services/org-roster.store";

/**
 * Settings → Organization section (Shared Brain v1, MULTI-ORG).
 *
 * A user can belong to SEVERAL orgs — the ones they created AND the ones they
 * were invited into. The old single-org surface only ever showed the FIRST
 * locally-created org, so an invited-into org was invisible and never synced
 * (root cause: `org_status_inner`/`org_sync_now_inner` took `…next()` and local
 * `org_state` was only populated by create). This section now lists EVERY org
 * the user actively belongs to.
 *
 * On open it refreshes membership from the server (`orgRefresh` = server
 * discovery, so an invited-into org appears) then loads the full list
 * (`orgListStatuses`) into `orgs`. Both run inside ONE tracked effect keyed on a
 * `_reloadTick` trigger with a STALE-RESULT guard (a late response from a
 * superseded reload is dropped — project failure mode #4).
 *
 * Each org renders as a card: name, a distinct OWNER/MEMBER role badge, member +
 * item counts, and per-org actions — Invite (owner only; expands a member
 * manager), Sync now, Leave. The CREATE-org form stays; creating refreshes the
 * list. Consent is ONE GLOBAL control ("Share my notes into my organizations")
 * bound to the existing global org-egress flag — NOT per-org (a follow-up).
 *
 * Everything talks to the Rust core through {@link IpcService}. The consent
 * command pair (`consentToOrgEgress` / `revokeOrgEgress`) is PRESERVE-ONLY
 * config, never part of a config save — mirrors the share-egress consent.
 */
@Component({
  selector: "app-settings-organization-section",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: "./settings-organization-section.component.html",
  styleUrl: "./settings-organization-section.component.scss",
})
export class SettingsOrganizationSectionComponent {
  private readonly dates = inject(DateFormatService);

  private readonly ipc = inject(IpcService);
  private readonly toast = inject(ToastService);
  private readonly errorCopy = inject(ErrorCopyService);

  /**
   * Every org the user belongs to (created OR invited-into), held in a ROOT store so the rows
   * survive this section's destroy+recreate and a failed refresh never blanks them
   * ({@link OrgRosterStore} carries the full rationale).
   */
  private readonly roster = inject(OrgRosterStore);
  private readonly _orgs = this.roster.orgs;
  readonly orgs = this._orgs.asReadonly();

  /** True once a roster read has settled at least once (avoids an empty-state flash). */
  private readonly _loaded = this.roster.loaded;
  readonly loaded = this._loaded.asReadonly();

  /**
   * The last roster read failed. The list keeps its last-known rows; the template says so instead
   * of rendering the "you're not in any organization yet" copy at somebody who is.
   */
  private readonly _loadFailed = this.roster.loadFailed;
  readonly loadFailed = this._loadFailed.asReadonly();

  /** A general org error (list load / mutate failure). */
  private readonly _error = signal<string | null>(null);
  readonly error = this._error.asReadonly();

  /** True during any org-level mutation (Leave) — debounces those buttons. */
  private readonly _busyOrgId = signal<string | null>(null);
  readonly busyOrgId = this._busyOrgId.asReadonly();

  /** The org id currently flipping its per-instance context toggle — locks that row's control. */
  private readonly _contextTogglingOrgId = signal<string | null>(null);
  readonly contextTogglingOrgId = this._contextTogglingOrgId.asReadonly();

  /** The signed-in account email (header context); `null` until loaded / logged out. */
  private readonly _email = signal<string | null>(null);
  readonly email = this._email.asReadonly();

  /** True while at least one org is present. */
  readonly hasOrgs = this.roster.hasOrgs;

  /** True while the global org-egress consent is granted (any org's flag ⇒ global grant). */
  private readonly _consented = signal(false);
  readonly consented = this._consented.asReadonly();
  readonly consentBusy = signal(false);

  // ── Reload trigger + stale-result guard ─────────────────────────────────────
  //
  // The load TOKEN lives in the root store, not here: the signals it guards are shared, so a
  // per-instance token stops guarding anything the moment a destroyed section's response lands on
  // a live one's data. See {@link OrgRosterStore.beginLoad}.
  /** Bump to re-run the load effect (open, after create/leave/invite). */
  private readonly _reloadTick = signal(0);
  /**
   * COALESCE live-refresh bursts. A reload here is a real network round trip per org
   * (`org_refresh`, then `org_status` + `org_list_members` for each), and `org-feed-updated` now
   * arrives every few seconds while the background loop is catching a backlog up rather than once a
   * minute. Without this, each ping would start another overlapping fan-out on top of the one still
   * in flight. At most ONE follow-up is queued: the reason to reload is "something changed", and one
   * reload after the current one observes every change that landed while it ran.
   *
   * The flag is released by the NEWEST run's `finally` (a superseded run deliberately does not touch
   * it, or a slow stale response would free a slot its successor owns). That makes an unsettled
   * newest request the one way to stall live refresh — bounded, because every command on this path
   * is bounded backend-side, and a user action calls {@link reload} directly regardless.
   */
  private _reloadInFlight = false;
  private _reloadQueued = false;

  // ── Create form ─────────────────────────────────────────────────────────────
  readonly createName = signal("");
  readonly creating = signal(false);

  // ── Per-org member management (owner only) ──────────────────────────────────
  /** The org id whose member manager is expanded (only one at a time). */
  private readonly _expandedOrgId = signal<string | null>(null);
  readonly expandedOrgId = this._expandedOrgId.asReadonly();
  /** Members of the currently-expanded org (owner surface). */
  private readonly _members = signal<OrgMember[]>([]);
  readonly members = this._members.asReadonly();
  private readonly _membersError = signal<string | null>(null);
  readonly membersError = this._membersError.asReadonly();
  private readonly _membersLoading = signal(false);
  readonly membersLoading = this._membersLoading.asReadonly();
  /** The invite-by-email draft + in-flight flag. */
  readonly inviteEmail = signal("");
  readonly inviting = signal(false);
  /** The user id currently being removed (locks that row). */
  private readonly _removingId = signal<string | null>(null);
  readonly removingId = this._removingId.asReadonly();

  /** Active members render first; removed (historical) ones fall to the bottom. */
  readonly sortedMembers = computed(() =>
    [...this._members()].sort((a, b) => Number(a.removed) - Number(b.removed)),
  );

  // ── Sync (per-org) ──────────────────────────────────────────────────────────
  /** The org id currently syncing (locks its Sync now button). */
  private readonly _syncingOrgId = signal<string | null>(null);
  readonly syncingOrgId = this._syncingOrgId.asReadonly();
  /**
   * What the sync in flight has done so far, straight off `murmur://org-sync-progress`.
   *
   * A manual sync is several bounded feed pages and then a container reconcile — sequential network
   * round trips that can take a while on a real backlog. A label that never changes is
   * indistinguishable from a wedge, which is how this was reported: "it keeps syncing and you don't
   * know the status". `null` between presses.
   */
  private readonly _syncProgress = signal<OrgSyncProgress | null>(null);

  /**
   * The live label for the ONE org that can be syncing at a time. Derived, not recomputed per row:
   * the template picks it only for the row whose id matches {@link syncingOrgId}.
   */
  readonly syncLabel = computed<string>(() => {
    const progress = this._syncProgress();
    if (!progress || progress.orgId !== this._syncingOrgId()) {
      return "Syncing…";
    }
    return progress.stage === "containers"
      ? "Syncing folders…"
      : `Syncing… ${progress.pulled}`;
  });

  // ── Browse the shared brain (fix A) — per-org item list ──────────────────────
  /** The org id whose "Shared brain" browse list is expanded (one at a time). */
  private readonly _browseOrgId = signal<string | null>(null);
  readonly browseOrgId = this._browseOrgId.asReadonly();
  /** The expanded org's browsable items (`listOrgItems`). */
  private readonly _orgItems = signal<OrgItemHeader[]>([]);
  readonly orgItems = this._orgItems.asReadonly();
  private readonly _itemsError = signal<string | null>(null);
  readonly itemsError = this._itemsError.asReadonly();
  private readonly _itemsLoading = signal(false);
  readonly itemsLoading = this._itemsLoading.asReadonly();
  /** Monotonic browse token — a resolved list writes only if it's still the latest. */
  private _browseSeq = 0;

  // ── Live refresh (org-feed-updated) ─────────────────────────────────────────
  private readonly destroyRef = inject(DestroyRef);
  /** Released on destroy to detach the org-feed-updated live-refresh listener. */
  private orgFeedUnlisten: (() => void) | null = null;
  /** Released on destroy to detach the org-sync-progress listener. */
  private syncProgressUnlisten: (() => void) | null = null;
  /** True once destroyed — so a `listen()` that resolves AFTER teardown releases immediately
   * (distinct from `orgFeedUnlisten === null`, which also means "not yet resolved"). */
  private orgFeedDestroyed = false;

  constructor() {
    // On open: refresh membership from the server (so an invited-into org is
    // discovered) then load every org. Keyed on `_reloadTick` so create/leave/
    // invite can re-run it; a stale-result guard drops a superseded response.
    effect(() => {
      this._reloadTick(); // dependency: any bump re-runs the load
      const seq = this.roster.beginLoad();
      this._error.set(null);
      this._reloadInFlight = true;
      void (async () => {
        // Account email (best-effort — a logged-out user still sees the section).
        try {
          const acct = await this.ipc.accountStatus();
          if (this.roster.isCurrentLoad(seq)) {
            this._email.set(acct.email);
          }
        } catch {
          // Non-fatal — the header just omits the email line.
        }
        // Server membership discovery is best-effort; a failure must not hide
        // the locally-known orgs, so swallow it and still load the list.
        try {
          await this.ipc.orgRefresh();
        } catch {
          // Offline / no server → fall through to the local replica.
        }
        try {
          const list = await this.ipc.orgListStatuses();
          if (!this.roster.isCurrentLoad(seq)) {
            return; // a newer reload superseded this one — drop the result
          }
          this._loadFailed.set(false);
          this._orgs.set(list);
          this._consented.set(list.some((o) => o.consented));
          this.reconcileExpanded(list);
        } catch (e) {
          if (this.roster.isCurrentLoad(seq)) {
            // Record the failure; do NOT clear the rows. A read that could not reach the relay
            // rendered as "You're not in any organization yet" — the app telling a member of three
            // orgs that they belong to none, with no retry but closing and reopening the section.
            this._loadFailed.set(true);
            this._error.set(this.errorCopy.humanize(e));
          }
        } finally {
          if (this.roster.isCurrentLoad(seq)) {
            this._loaded.set(true);
            this._reloadInFlight = false;
            if (this._reloadQueued) {
              this._reloadQueued = false;
              this.reload();
            }
          }
        }
      })();
    });

    // Live-refresh: the background org-sync loop AND the share/edit commands fire `org-feed-updated`
    // whenever the org replica changes. Subscribe ONCE (push straight into a reload — never
    // subscribe-into-a-field) so the counts + shared-brain browse list stay live WITHOUT a manual
    // "Sync now"; released on destroy (never leak the subscription past teardown).
    this.destroyRef.onDestroy(() => {
      this.orgFeedDestroyed = true;
      this.orgFeedUnlisten?.();
      this.orgFeedUnlisten = null;
      this.syncProgressUnlisten?.();
      this.syncProgressUnlisten = null;
    });
    void this.ipc
      .onOrgSyncProgress((progress) => {
        // Drop an event from a press that is already over, or from another org's press.
        //
        // KNOWN BOUND: a trailing event from press N, delivered after press N+1 has started on the
        // SAME org, is accepted and shows press N's counts until press N+1's first event replaces
        // them. Distinguishing them needs a correlation id echoed through the command, and the
        // symptom — a count that reads high for one page before correcting — is not worth widening
        // the IPC surface for. The window is small because the backend emits every progress event
        // before the command it belongs to resolves, and the button stays disabled until it does.
        if (this._syncingOrgId() === progress.orgId) {
          this._syncProgress.set(progress);
        }
      })
      .then((un) => {
        if (this.orgFeedDestroyed) {
          un();
        } else {
          this.syncProgressUnlisten = un;
        }
      })
      .catch(() => {
        /* best-effort: no Tauri host (e.g. plain browser) → no live progress */
      });
    void this.ipc
      .onOrgFeedUpdated(() => {
        this.requestReload();
        // Keep an open browse list fresh too (the reload only refreshes the org cards/counts).
        const open = this._browseOrgId();
        if (open !== null) {
          void this.loadOrgItems(open);
        }
      })
      .then((un) => {
        // If the view was torn down before the listener resolved, release it immediately.
        if (this.orgFeedDestroyed) {
          un();
        } else {
          this.orgFeedUnlisten = un;
        }
      })
      .catch(() => {
        /* best-effort: no Tauri host (e.g. plain browser) → no live refresh */
      });
  }

  /** Re-run the load effect (server discovery + list). */
  private reload(): void {
    this._reloadTick.update((n) => n + 1);
  }

  /**
   * Reload for a LIVE-REFRESH ping, coalescing a burst into at most one follow-up. A user action
   * (create / leave / invite / sync) still calls {@link reload} directly — that one must not be
   * folded into somebody else's in-flight fetch.
   */
  private requestReload(): void {
    if (this._reloadInFlight) {
      this._reloadQueued = true;
      return;
    }
    this.reload();
  }

  /** Drop the expanded member manager / browse list if their org is gone. */
  private reconcileExpanded(list: OrgStatus[]): void {
    const open = this._expandedOrgId();
    if (open && !list.some((o) => o.orgId === open)) {
      this._expandedOrgId.set(null);
      this._members.set([]);
    }
    const browse = this._browseOrgId();
    if (browse && !list.some((o) => o.orgId === browse)) {
      this._browseOrgId.set(null);
      this._orgItems.set([]);
      this._itemsError.set(null);
    }
  }

  // ── Create ───────────────────────────────────────────────────────────────────

  onCreateNameInput(event: Event): void {
    this.createName.set((event.target as HTMLInputElement).value);
  }

  /** Create the org (this user becomes owner), then reload the full list. */
  async createOrg(): Promise<void> {
    const name = this.createName().trim();
    if (!name || this.creating()) {
      return;
    }
    this._error.set(null);
    this.creating.set(true);
    try {
      await this.ipc.orgCreate(name);
      this.createName.set("");
      this.reload();
    } catch (e) {
      this._error.set(this.errorCopy.humanize(e));
    } finally {
      this.creating.set(false);
    }
  }

  // ── Consent (ONE global control) ──────────────────────────────────────────────

  /** Toggle the one global org-egress consent (dedicated command, preserve-only config). */
  async toggleConsent(): Promise<void> {
    if (this.consentBusy()) {
      return;
    }
    this.consentBusy.set(true);
    this._error.set(null);
    const grant = !this._consented();
    try {
      if (grant) {
        await this.ipc.consentToOrgEgress();
      } else {
        await this.ipc.revokeOrgEgress();
      }
      // Reflect locally without a full reload; mirror it onto every org row.
      this._consented.set(grant);
      this._orgs.update((list) =>
        list.map((o) => ({ ...o, consented: grant })),
      );
    } catch (e) {
      this._error.set(this.errorCopy.humanize(e));
    } finally {
      this.consentBusy.set(false);
    }
  }

  // ── Per-org: expand member manager (owner) ────────────────────────────────────

  /** Toggle the member manager for an org (owner only); loads its members. */
  async toggleMembers(org: OrgStatus): Promise<void> {
    if (org.role !== "owner") {
      return;
    }
    if (this._expandedOrgId() === org.orgId) {
      this._expandedOrgId.set(null);
      this._members.set([]);
      return;
    }
    this._expandedOrgId.set(org.orgId);
    this.inviteEmail.set("");
    await this.loadMembers(org.orgId);
  }

  private async loadMembers(orgId: string): Promise<void> {
    this._membersError.set(null);
    this._membersLoading.set(true);
    this._members.set([]);
    try {
      const members = await this.ipc.orgListMembers(orgId);
      // Guard against a stale expand switch mid-flight.
      if (this._expandedOrgId() === orgId) {
        this._members.set(members);
      }
    } catch (e) {
      if (this._expandedOrgId() === orgId) {
        this._membersError.set(this.errorCopy.humanize(e));
      }
    } finally {
      if (this._expandedOrgId() === orgId) {
        this._membersLoading.set(false);
      }
    }
  }

  onInviteEmailInput(event: Event): void {
    this.inviteEmail.set((event.target as HTMLInputElement).value);
  }

  /** Invite a member by email into the expanded org (owner), then refresh. */
  async invite(orgId: string): Promise<void> {
    const email = this.inviteEmail().trim();
    if (!email || this.inviting()) {
      return;
    }
    this._membersError.set(null);
    this.inviting.set(true);
    try {
      await this.ipc.orgInviteMember(orgId, email);
      this.inviteEmail.set("");
      await this.loadMembers(orgId);
      this.reload();
    } catch (e) {
      this._membersError.set(this.errorCopy.humanize(e));
    } finally {
      this.inviting.set(false);
    }
  }

  /**
   * Remove a member from the expanded org (owner). The backend also rotates the org key, and those
   * two halves can land separately: `org-rotation-pending` means the person IS gone and only the
   * key rotation is still outstanding.
   *
   * So the roster is reloaded on BOTH paths. Reloading only on success left the removed member
   * listed underneath a message saying they had been removed, and a second click then re-ran the
   * whole removal against a relay that answers 404-as-success — a redundant rotation driven by a
   * screen that had not caught up with its own backend.
   */
  async removeMember(orgId: string, member: OrgMember): Promise<void> {
    if (this._removingId() !== null) {
      return;
    }
    this._removingId.set(member.userId);
    this._membersError.set(null);
    try {
      await this.ipc.orgRemoveMember(orgId, member.userId);
      this._membersError.set(null);
    } catch (e) {
      this._membersError.set(this.errorCopy.humanize(e));
    } finally {
      await this.loadMembers(orgId).catch(() => undefined);
      this.reload();
      this._removingId.set(null);
    }
  }

  // ── Per-org: leave ─────────────────────────────────────────────────────────────

  /** Leave one org (self-removal). Reloads the list (the row drops out). */
  async leave(org: OrgStatus): Promise<void> {
    if (this._busyOrgId() !== null) {
      return;
    }
    this._busyOrgId.set(org.orgId);
    this._error.set(null);
    try {
      await this.ipc.orgLeave(org.orgId);
      if (this._expandedOrgId() === org.orgId) {
        this._expandedOrgId.set(null);
        this._members.set([]);
      }
      this.reload();
    } catch (e) {
      this._error.set(this.errorCopy.humanize(e));
    } finally {
      this._busyOrgId.set(null);
    }
  }

  // ── Per-org: active on this device (per-instance context toggle) ───────────────

  /**
   * Flip whether this org contributes content — browsing + brain/assistant
   * context — on THIS Murmur install. Optimistic local flip (mirrors {@link
   * toggleConsent}) with rollback on failure; purely local, no egress. Disabling
   * never deletes the synced replica, so re-enabling is instant.
   */
  async toggleContextEnabled(org: OrgStatus): Promise<void> {
    if (this._contextTogglingOrgId() !== null) {
      return;
    }
    const next = !org.contextEnabled;
    this._contextTogglingOrgId.set(org.orgId);
    this._error.set(null);
    this._orgs.update((list) =>
      list.map((o) => (o.orgId === org.orgId ? { ...o, contextEnabled: next } : o)),
    );
    try {
      await this.ipc.orgSetContextEnabled(org.orgId, next);
    } catch (e) {
      // Roll back the optimistic flip on failure.
      this._orgs.update((list) =>
        list.map((o) => (o.orgId === org.orgId ? { ...o, contextEnabled: !next } : o)),
      );
      this._error.set(this.errorCopy.humanize(e));
    } finally {
      this._contextTogglingOrgId.set(null);
    }
  }

  // ── Per-org: sync ──────────────────────────────────────────────────────────────

  /**
   * Pull + ingest one org's feed now, inspect the report (fix E), then reload the
   * counts. The report drives an honest toast: a partial/failed sync (errors, or
   * pulled-but-nothing-ingested — the sync-stall symptom where a key isn't
   * granted yet) shows a danger toast with the counts; a clean sync shows success.
   * If the browse list for this org is open, refresh it too.
   */
  async syncNow(org: OrgStatus): Promise<void> {
    if (this._syncingOrgId() !== null) {
      return;
    }
    this._syncingOrgId.set(org.orgId);
    this._syncProgress.set(null);
    this._error.set(null);
    try {
      const report = await this.ipc.orgSyncNow(org.orgId);
      const stalled = report.pulled > 0 && report.ingested === 0;
      // A drain that stopped on its OWN bound (page cap / deadline / a busy lock) has NOT caught
      // up. Saying "up to date" there is the same lie the single-page sync used to tell.
      const tail = report.morePending
        ? " More is still arriving in the background."
        : "";
      if (report.errors.length > 0 || stalled) {
        // Name the FIRST real error rather than always guessing "a key may not be granted yet".
        // The report now also carries shared-folder publish failures, which that guess describes
        // wrongly — and a wrong explanation is what kept the org-sharing outage invisible.
        const detail = report.errors[0] ?? "a key may not be granted yet";
        this.toast.danger(
          `${report.pulled} pulled, ${report.ingested} ingested, ` +
            `${report.errors.length} error${report.errors.length === 1 ? "" : "s"} — ` +
            `${detail}.${tail}`,
        );
      } else if (report.ingested > 0) {
        this.toast.success(
          `Synced — ${report.ingested} new item${report.ingested === 1 ? "" : "s"}.${tail}`,
        );
      } else if (report.morePending) {
        this.toast.success("Synced — still catching up in the background.");
      } else {
        this.toast.success("Synced — up to date.");
      }
      this.reload();
      // Keep an open browse list fresh after a sync brings in new items.
      if (this._browseOrgId() === org.orgId) {
        void this.loadOrgItems(org.orgId);
      }
    } catch (e) {
      this._error.set(this.errorCopy.humanize(e));
      this.toast.danger(this.errorCopy.because("Sync failed", e));
    } finally {
      this._syncingOrgId.set(null);
      this._syncProgress.set(null);
    }
  }

  // ── Browse the shared brain (fix A) ─────────────────────────────────────────

  /** Toggle the "Shared brain" browse list for an org; loads its items lazily. */
  async toggleBrowse(org: OrgStatus): Promise<void> {
    if (this._browseOrgId() === org.orgId) {
      this._browseOrgId.set(null);
      this._orgItems.set([]);
      this._itemsError.set(null);
      return;
    }
    this._browseOrgId.set(org.orgId);
    await this.loadOrgItems(org.orgId);
  }

  /** Load one org's browsable items (`listOrgItems`), stale-guarded on a token. */
  private async loadOrgItems(orgId: string): Promise<void> {
    const seq = ++this._browseSeq;
    this._itemsError.set(null);
    this._itemsLoading.set(true);
    this._orgItems.set([]);
    try {
      const items = await this.ipc.listOrgItems(orgId);
      if (seq !== this._browseSeq) {
        return; // a newer browse/toggle superseded this one — drop the result
      }
      this._orgItems.set(items);
    } catch (e) {
      if (seq === this._browseSeq) {
        this._itemsError.set(this.errorCopy.humanize(e));
      }
    } finally {
      if (seq === this._browseSeq) {
        this._itemsLoading.set(false);
      }
    }
  }

  /** Presentational: an ISO timestamp → a friendly local date. */
  /** Formatted through {@link DateFormatService} — the one place a date becomes user-visible text. */
  formatDate(iso: string): string {
    return this.dates.day(iso);
  }
}
