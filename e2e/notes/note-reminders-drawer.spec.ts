import { test, expect } from "@playwright/test";
import { mockNotes } from "./mock-invoke";

/**
 * The note's Reminders drawer: a header toggle beside Edit/Preview opens a
 * right-side pane that creates reminders anchored to THIS note and lists the
 * ones already attached to it.
 *
 * The assertion that carries the feature is the FILTER. `list_reminders` has no
 * per-source form — it returns the whole snapshot — so the panel selects rows by
 * their `sources` anchor. A filter that silently degrades to "show everything"
 * would still look correct on a one-reminder fixture, so the fixture below
 * deliberately contains reminders for ANOTHER note and for a meeting, and the
 * spec asserts those are absent by name. Without those negatives the test would
 * pass against a no-op filter.
 */

/** Two of these three must never reach a drawer opened on note `n1`. */
const REMINDERS_FIXTURE = {
  inbox: [],
  upcoming: [
    {
      id: "r-mine",
      title: "Follow up on the migration plan",
      details: null,
      dueAt: 1893499200000,
      repeatEvery: null,
      repeatUnit: null,
      state: "active",
      origin: "manual",
      createdAt: 1893400000000,
      updatedAt: 1893400000000,
      completedAt: null,
      sources: [{ kind: "note", id: "n1", title: "My First Note" }],
    },
    {
      id: "r-other-note",
      title: "Belongs to a different note",
      details: null,
      dueAt: 1893499200000,
      repeatEvery: null,
      repeatUnit: null,
      state: "active",
      origin: "manual",
      createdAt: 1893400000000,
      updatedAt: 1893400000000,
      completedAt: null,
      sources: [{ kind: "note", id: "n2", title: "Another Note" }],
    },
  ],
  completed: [
    {
      id: "r-meeting",
      title: "Belongs to a meeting",
      details: null,
      dueAt: 1893499200000,
      repeatEvery: null,
      repeatUnit: null,
      state: "completed",
      origin: "manual",
      createdAt: 1893400000000,
      updatedAt: 1893400000000,
      completedAt: 1893450000000,
      sources: [{ kind: "meeting", id: "m1", title: "A Meeting" }],
    },
  ],
  dueInboxCount: 0,
};

test("the note's Reminders drawer lists ONLY reminders anchored to this note", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await mockNotes(page, {}, [], { list_reminders: REMINDERS_FIXTURE });
  await page.goto("/notes/n1");
  await expect(page.locator(".note-title-input")).toHaveValue("My First Note");

  // Default COLLAPSED: the toggle exists, the drawer does not.
  const toggle = page.getByRole("button", { name: "Reminders", exact: true });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("app-note-reminders-panel")).toHaveCount(0);

  await toggle.click();
  const panel = page.locator("app-note-reminders-panel");
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // The filter. The positive AND both negatives — see the file header.
  await expect(
    panel.getByText("Follow up on the migration plan"),
  ).toBeVisible();
  await expect(panel.getByText("Belongs to a different note")).toHaveCount(0);
  await expect(panel.getByText("Belongs to a meeting")).toHaveCount(0);
  await expect(panel.locator(".panel-row")).toHaveCount(1);

  expect(consoleErrors).toEqual([]);
});

test("the drawer and Ask Brain are mutually exclusive, and the drawer persists", async ({
  page,
}) => {
  await mockNotes(page, {}, [], { list_reminders: REMINDERS_FIXTURE });
  await page.goto("/notes/n1");
  await expect(page.locator(".note-title-input")).toHaveValue("My First Note");

  const reminders = page.getByRole("button", { name: "Reminders", exact: true });
  const askBrain = page
    .getByRole("button", { name: "Ask Brain" })
    .and(page.locator(".head-chat-btn"));

  await reminders.click();
  await expect(page.locator("app-note-reminders-panel")).toBeVisible();

  // ONE tool column at a time: two ~360px panes would leave the document a
  // sliver on a normal window.
  await askBrain.click();
  await expect(page.locator("app-note-chat")).toBeVisible();
  await expect(page.locator("app-note-reminders-panel")).toHaveCount(0);
  await expect(reminders).toHaveAttribute("aria-expanded", "false");

  await reminders.click();
  await expect(page.locator("app-note-reminders-panel")).toBeVisible();
  await expect(page.locator("app-note-chat")).toHaveCount(0);

  // Persisted, like the chat drawer's own state.
  await page.reload();
  await expect(page.locator("app-note-reminders-panel")).toBeVisible();
});

test("creating from the drawer opens the composer with this note attached", async ({
  page,
}) => {
  await mockNotes(page, {}, [], { list_reminders: REMINDERS_FIXTURE });
  await page.goto("/notes/n1");
  await expect(page.locator(".note-title-input")).toHaveValue("My First Note");

  await page.getByRole("button", { name: "Reminders", exact: true }).click();
  const panel = page.locator("app-note-reminders-panel");
  await panel.getByRole("button", { name: "New reminder" }).click();

  // The anchor is what makes this different from the global "New reminder":
  // the composer opens with the note already in Sources.
  const composer = page.getByRole("dialog");
  await expect(composer).toBeVisible();
  // The chip carries the raw note id, not its title: the panel deliberately
  // sends `title: ""` and lets the backend resolve a visible one on submit, so
  // asserting the id is asserting the anchor rather than a display string.
  await expect(composer.getByText("n1", { exact: true })).toBeVisible();
});

test("a locked note gets neither the toggle nor the drawer", async ({ page }) => {
  // `nlk` is the shared mock's locked note — reuse it rather than hand-rolling a
  // second locked payload that can drift from the one the other specs assert on.
  await mockNotes(page, {}, [], { list_reminders: REMINDERS_FIXTURE });
  await page.goto("/notes/nlk");

  // The panel's own filter would already come up empty — the backend drops an
  // anchor whose source the session cannot see — but a locked note must not
  // render the surface at all rather than depend on that.
  await expect(
    page.getByRole("button", { name: "Reminders", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("app-note-reminders-panel")).toHaveCount(0);
});
