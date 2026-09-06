import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { MurIconComponent } from "../../../design-system/icon/icon.component";
import type { ReminderSourceView } from "../../../core/models";
import { ReminderComposerService } from "../reminder-composer/reminder-composer.service";
import { RemindersStore } from "../reminders.store";
import type { ReminderRowVm } from "../reminder-row";

/**
 * ONE reminder, in the shape Apple Reminders uses: a completion circle beside
 * the text, and icon actions that surface on hover.
 *
 * Shared by the note's drawer and the Reminders page, which is the point. The
 * page used to draw its own card — a full-width bar of three text buttons under
 * every row, four lines of chrome for one line of content — and the drawer drew
 * this. "Make them look the same" is only true for as long as nobody edits one
 * of two copies, so there is one.
 *
 * It owns its ACTIONS rather than emitting them, because every call site wants
 * exactly the same ones and routing four outputs through two parents would be
 * ceremony around identical code. The one thing that genuinely differs is what
 * a source chip means: on the page it navigates, in the drawer every row is
 * anchored to the note you are already looking at, so the chips are noise. That
 * is the input and the output below.
 */
@Component({
  selector: "app-reminder-row",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MurIconComponent],
  templateUrl: "./reminder-row.component.html",
  styleUrl: "./reminder-row.component.scss",
})
export class ReminderRowComponent {
  readonly store = inject(RemindersStore);
  private readonly composer = inject(ReminderComposerService);

  readonly row = input.required<ReminderRowVm>();
  /** Show the anchors this reminder came from, and make them navigable. */
  readonly showSources = input(false);
  readonly openSource = output<ReminderSourceView>();

  /** Derived, not a template getter: a getter re-runs on every change-detection
   * pass, a computed is cached and dependency-tracked (angular-zoneless.md §2). */
  readonly reminder = computed(() => this.row().reminder);
  readonly done = computed(() => this.reminder().state === "completed");
  readonly confirmingDelete = signal(false);

  /** The circle, both ways: a finished reminder goes back to open at the same
   * due time, an open one is completed. The direction is read from the
   * reminder's own state, never from the group it was rendered in, so the two
   * can never disagree. */
  async toggle(): Promise<void> {
    const row = this.row();
    const action = this.done()
      ? this.store.reopen(row.reminder.id, row.expectedDueAt)
      : this.store.complete(row.reminder.id, row.expectedDueAt);
    await action.catch(() => {
      // The store surfaces the failure through its own error signal.
    });
  }

  edit(): void {
    this.composer.openEdit(this.row().reminder);
  }

  async dismiss(): Promise<void> {
    const occurrenceId = this.row().occurrenceId;
    if (!occurrenceId) {
      return;
    }
    await this.store.dismissOccurrence(occurrenceId).catch(() => {
      // Reported by the store.
    });
  }

  askDelete(): void {
    this.confirmingDelete.set(true);
  }

  cancelDelete(): void {
    this.confirmingDelete.set(false);
  }

  async confirmDelete(): Promise<void> {
    await this.store.delete(this.row().reminder.id).catch(() => {
      // Reported by the store.
    });
    this.confirmingDelete.set(false);
  }

}
