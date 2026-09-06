import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import type { ReminderView } from "../../../core/models";
import { ReminderComposerService } from "../reminder-composer/reminder-composer.service";
import { RemindersStore } from "../reminders.store";
import { anchoredTo, reminderRow, type ReminderRowVm } from "../reminder-row";

/**
 * The note's own reminder drawer: create a follow-up anchored to this note, and
 * see the ones already attached to it.
 *
 * WHY THIS IS A CLIENT-SIDE FILTER AND NOT A NEW COMMAND. There is no
 * "reminders for source X" command — `list_reminders` takes no arguments and
 * returns the whole snapshot. Filtering it here is nonetheless the correct
 * gate rather than a way around one: `reminder_view` builds every row through
 * `visible_source_views`, which DROPS an anchor whose source this session may
 * not see. A reminder attached to a locked note therefore arrives with that
 * anchor already gone and can never match. The drawer is additionally not
 * rendered at all for a locked note (see the editor template), so the masked
 * case has two independent reasons to show nothing.
 *
 * The cost is honest and worth naming: this reads the full snapshot to show a
 * handful of rows. It is the same read the Reminders page already performs, the
 * store caches it across mounts, and a per-source command would be the right
 * fix if the inbox ever grows big enough for that to matter.
 *
 * NOT a suggestions surface — that is `app-smart-reminder-card`, which stages
 * local suggestions and never creates anything. This one shows what exists.
 */
@Component({
  selector: "app-note-reminders-panel",
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./note-reminders-panel.component.html",
  styleUrl: "./note-reminders-panel.component.scss",
})
export class NoteRemindersPanelComponent {
  readonly store = inject(RemindersStore);
  private readonly composer = inject(ReminderComposerService);

  readonly noteId = input.required<string>();
  /** Emitted by the drawer's own close control; the editor owns the toggle. */
  readonly closed = output<void>();

  /** Which reminder the delete confirmation is currently armed for. */
  readonly confirmingDelete = signal<string | null>(null);

  private readonly mine = (reminder: ReminderView): boolean =>
    anchoredTo(reminder, "note", this.noteId());

  /** Due now — an unread occurrence exists. Never also in `upcoming`: the
   * snapshot builder puts an active reminder in one list or the other. */
  readonly due = computed<ReminderRowVm[]>(() =>
    this.store
      .inbox()
      .filter((item) => this.mine(item.reminder))
      .map((item) => reminderRow(item.reminder, item)),
  );

  readonly upcoming = computed<ReminderRowVm[]>(() =>
    this.store
      .upcoming()
      .filter((reminder) => this.mine(reminder))
      .map((reminder) => reminderRow(reminder)),
  );

  readonly completed = computed<ReminderRowVm[]>(() =>
    this.store
      .completed()
      .filter((reminder) => this.mine(reminder))
      .map((reminder) => reminderRow(reminder)),
  );

  /** The three sections, in the order they read: what is overdue, what is
   * coming, what is done. Derived rather than assembled in the template — an
   * inline array literal there would be a fresh object on every pass. */
  readonly groups = computed<
    { id: "due" | "upcoming" | "completed"; label: string; rows: ReminderRowVm[] }[]
  >(() => [
    { id: "due", label: "Due", rows: this.due() },
    { id: "upcoming", label: "Upcoming", rows: this.upcoming() },
    { id: "completed", label: "Completed", rows: this.completed() },
  ]);

  readonly total = computed(
    () => this.due().length + this.upcoming().length + this.completed().length,
  );

  /** First paint only. A reload must never blank rows we can already show —
   * the store outlives this component, so a re-open renders instantly and
   * refreshes underneath (the list-view rule in angular-zoneless.md §8). */
  readonly showSpinner = computed(
    () => this.total() === 0 && this.store.loading(),
  );

  /** Refetch when the drawer mounts and whenever it is pointed at another note. */
  private readonly _load = effect(() => {
    this.noteId();
    void this.store.refresh();
  });

  /** Create, anchored to this note.
   *
   * The note's title is deliberately NOT sent. The composer's submit re-gates
   * the anchor server-side and the canonical list resolves a visible title from
   * it, so passing one here would be this component asserting a title it has no
   * authority over — the same reasoning as `smart-reminder-card`'s comment. */
  newReminder(): void {
    this.composer.openCreate({
      source: { kind: "note", id: this.noteId(), title: "" },
    });
  }

  edit(reminder: ReminderView): void {
    this.composer.openEdit(reminder);
  }

  async complete(row: ReminderRowVm): Promise<void> {
    await this.store.complete(row.reminder.id, row.expectedDueAt).catch(() => {
      // The store surfaces the failure through its own error signal.
    });
  }

  async dismiss(row: ReminderRowVm): Promise<void> {
    if (!row.occurrenceId) {
      return;
    }
    await this.store.dismissOccurrence(row.occurrenceId).catch(() => {
      // Reported by the store.
    });
  }

  askDelete(reminderId: string): void {
    this.confirmingDelete.set(reminderId);
  }

  cancelDelete(): void {
    this.confirmingDelete.set(null);
  }

  async confirmDelete(reminderId: string): Promise<void> {
    await this.store.delete(reminderId).catch(() => {
      // Reported by the store.
    });
    this.confirmingDelete.set(null);
  }
}
