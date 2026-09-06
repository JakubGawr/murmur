import type { ReminderInboxItem, ReminderView } from "../../core/models";

/**
 * The view-model one reminder row renders from, shared by the Reminders page
 * and the note editor's per-note panel.
 *
 * Extracted rather than copied on purpose. The two surfaces must agree on what
 * `complete()` is optimistic about: `expectedDueAt` is the OCCURRENCE's due
 * time when the row came from the inbox and the reminder's own otherwise, and
 * the store passes it back to the backend as a concurrency check. A second,
 * hand-rolled copy of that rule is a race waiting to happen.
 */
export interface ReminderRowVm {
  key: string;
  occurrenceId: string | null;
  expectedDueAt: number;
  reminder: ReminderView;
  dueLabel: string;
  recurrenceLabel: string | null;
}

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function recurrenceLabel(reminder: ReminderView): string | null {
  if (!reminder.repeatEvery || !reminder.repeatUnit) {
    return null;
  }
  const singular = reminder.repeatUnit.slice(0, -1);
  return reminder.repeatEvery === 1
    ? `Every ${singular}`
    : `Every ${reminder.repeatEvery} ${reminder.repeatUnit}`;
}

export function reminderRow(
  reminder: ReminderView,
  occurrence?: ReminderInboxItem,
): ReminderRowVm {
  const expectedDueAt = occurrence?.dueAt ?? reminder.dueAt;
  return {
    key: occurrence?.occurrenceId ?? reminder.id,
    occurrenceId: occurrence?.occurrenceId ?? null,
    expectedDueAt,
    reminder,
    dueLabel: DATE_TIME.format(new Date(expectedDueAt)),
    recurrenceLabel: recurrenceLabel(reminder),
  };
}

/** Does this reminder still carry an anchor to that source?
 *
 * The backend strips anchors the session may not see (`visible_source_views` in
 * commands/reminders.rs drops a locked note's anchor rather than masking it), so
 * filtering on the delivered `sources` is the gate, not a shortcut around one:
 * a reminder attached to a note this session cannot open simply has no anchor
 * left to match. */
export function anchoredTo(
  reminder: ReminderView,
  kind: "note" | "meeting",
  id: string,
): boolean {
  return reminder.sources.some(
    (source) => source.kind === kind && source.id === id,
  );
}
