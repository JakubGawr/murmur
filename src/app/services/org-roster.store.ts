import { Injectable, computed, signal } from "@angular/core";
import type { OrgStatus } from "../core/models";

/**
 * Root-persisted backing signals for Settings → Organizations.
 *
 * The section lives inside a `@switch` on the settings tab, so it is destroyed and recreated every
 * time the user leaves the Organization tab and comes back — and its roster used to be a
 * component-local `signal<OrgStatus[]>([])`, wiped to empty on each remount. Its template then read
 * a single `loaded` flag: "Loading organizations…" until the fetch settled, and, if that fetch
 * FAILED, the empty branch — "You're not in any organization yet — create one, or ask a teammate to
 * invite you by email." A refresh that could not reach the relay therefore told a member of three
 * orgs that they belonged to none, and the only way back was to close the section and reopen it,
 * hoping for a better attempt. That is the shape `angular-zoneless.md` §8 exists to prevent.
 *
 * A root instance outlives the component, so a return visit renders the LAST-KNOWN rows instantly
 * while the section's own (unchanged, still unconditional) reload replaces them underneath.
 *
 * Deliberately a thin signal HOLDER with no load()/CRUD of its own — the section keeps every bit of
 * its orchestration (server discovery, consent, invite, leave, sync) and simply reads and writes
 * these signals instead of component-local ones. Same sanctioned shape as {@link MeetingsListStore}.
 *
 * This is the UNFILTERED roster on purpose: {@link OrgBrainService} narrows to
 * `contextEnabled` orgs because those are the ones that contribute content, while Settings must
 * keep every joined org reachable so its per-device toggle can be turned back on.
 */
@Injectable({ providedIn: "root" })
export class OrgRosterStore {
  /** Every org this user belongs to — created OR invited-into, enabled or not. */
  readonly orgs = signal<OrgStatus[]>([]);
  /** True once a roster read has settled at least once in this app session. */
  readonly loaded = signal(false);
  /**
   * The LAST roster read could not be completed.
   *
   * Kept separate from {@link orgs} on purpose: the rows stay on screen while this is true, so a
   * failed refresh degrades to "possibly stale" instead of blanking what the user was reading — and
   * the template can tell "we could not find out" apart from "you are in no organization".
   */
  readonly loadFailed = signal(false);

  /** True while at least one org is known. */
  readonly hasOrgs = computed(() => this.orgs().length > 0);

  /**
   * The load token, held HERE rather than in the section, because the signals it guards live here.
   *
   * The section is destroyed and recreated on every tab switch, and its stale-result guard used to
   * be a component field. Once the roster moved into this shared store, that guard stopped guarding
   * anything across instances: a destroyed section's in-flight `orgListStatuses()` still matched its
   * OWN token, so it wrote its result over the roster a NEWER instance had already rendered. Before
   * the move the write landed on a dead component-local signal and was invisible; afterwards it
   * silently replaced live data with older data — reproduced in a browser, with no user action in
   * between, by making the first read slow and switching tabs while it was in flight.
   *
   * One token per store means "latest wins" spans instances, which is what "latest" has to mean when
   * the destination is shared.
   */
  private _loadSeq = 0;

  /** Claim the next load token. The caller writes only while {@link isCurrentLoad} holds for it. */
  beginLoad(): number {
    return ++this._loadSeq;
  }

  /** Whether `seq` is still the newest load — across every instance of the section. */
  isCurrentLoad(seq: number): boolean {
    return seq === this._loadSeq;
  }
}
