import { expect, test, type Page } from "@playwright/test";

import { mockTauri } from "../settings-ai/mock-invoke";

/**
 * Settings → Appearance → Theme: the SKIN axis.
 *
 * A skin is a pure token layer (src/design-tokens/skin-paper.css) stamped on
 * <html> as `data-skin`, orthogonal to `data-theme`. That makes it unusually
 * easy to assert honestly — every claim below reads a COMPUTED value off the
 * live document rather than trusting that a class was added. In particular the
 * contrast checks recompute WCAG luminance from what the browser actually
 * resolved, so a token that silently fails to load (a bad import order, a
 * typo'd selector, a skin block that never wins the cascade) fails the test
 * instead of quietly shipping unreadable text.
 *
 * NOT covered here: how the skin LOOKS. No assertion in this file can tell you
 * Paper is attractive; they only pin that it is applied, legible, persistent,
 * and that it never overrides an accent the user picked themselves.
 */

/** Read a resolved custom property off <html>. */
function token(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (n) =>
      getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

/**
 * WCAG 2.x contrast between two token colors, computed from what the browser
 * actually resolved.
 *
 * LIMIT, stated because the number is otherwise easy to misread: alpha is
 * IGNORED. A translucent token (the base skin's `--surface-raised` is
 * rgba(255,255,255,0.045)) is measured as if it were opaque, which understates
 * the real ratio against whatever sits behind it. Every pair asserted below is
 * a Paper pair, and Paper's surfaces are opaque hex on purpose — so the figures
 * are exact HERE. Do not lift this helper to audit a skin with glass in it
 * without first teaching it to composite.
 */
function contrast(page: Page, fg: string, bg: string): Promise<number> {
  return page.evaluate(
    ([fgProp, bgProp]) => {
      const resolve = (prop: string) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${prop})`;
        document.body.appendChild(probe);
        const rgb = getComputedStyle(probe).color;
        probe.remove();
        const m = rgb.match(/[\d.]+/g);
        if (!m) throw new Error(`could not resolve ${prop} (got ${rgb})`);
        return m.slice(0, 3).map((v) => Number(v) / 255);
      };
      const lum = (c: number[]) =>
        c
          .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
      const [a, b] = [lum(resolve(fgProp)), lum(resolve(bgProp))].sort(
        (p, q) => q - p,
      );
      return (a + 0.05) / (b + 0.05);
    },
    [fg, bg],
  );
}

async function openAppearance(page: Page) {
  await mockTauri(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
}

const paperTile = (page: Page) =>
  page.getByRole("radio", { name: /Paper/ });
const studioTile = (page: Page) =>
  page.getByRole("radio", { name: /Studio/ });

test("Studio is the default skin and stamps no attribute", async ({ page }) => {
  await openAppearance(page);

  // Absence, not `data-skin="studio"` — the base ramp IS the no-attribute case,
  // the same convention `data-accent` uses for purple.
  await expect(page.locator("html")).not.toHaveAttribute("data-skin", /.*/);
  await expect(studioTile(page)).toHaveAttribute("aria-checked", "true");
  await expect(paperTile(page)).toHaveAttribute("aria-checked", "false");

  // The shipped identity: the bundled grotesque, and glass that is really on.
  expect(await token(page, "--font-sans")).toContain("Hanken Grotesk");
  expect(await token(page, "--glass-blur")).not.toBe("0px");
});

test("picking Paper swaps the material and the type, and survives a reload", async ({
  page,
}) => {
  await openAppearance(page);

  // A CONTROL for the assertions below: prove these values are not already what
  // Paper would set, or the test could pass without the skin doing anything.
  const studioFont = await token(page, "--font-sans");
  const studioBase = await token(page, "--surface-base");

  await paperTile(page).click();

  await expect(page.locator("html")).toHaveAttribute("data-skin", "paper");
  const paperFont = await token(page, "--font-sans");
  expect(paperFont).not.toBe(studioFont);
  expect(paperFont).not.toContain("Hanken Grotesk");
  expect(await token(page, "--surface-base")).not.toBe(studioBase);

  // Glass genuinely off — not merely a different blur radius.
  expect(await token(page, "--glass-blur")).toBe("0px");
  expect(await token(page, "--shell-glass-blur")).toBe("0px");
  expect(await token(page, "--aurora-opacity")).toBe("0");

  // The document face is the skin's serif, and it reaches the note document's
  // own token rather than only the root (the base skin aliases the two, so this
  // is the assertion that would catch --font-reading being left behind).
  expect(await token(page, "--font-reading")).toMatch(/serif/);

  // Persisted, not just in-memory.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-skin", "paper");
});

test("Paper is legible in dark AND light, and the two are really different", async ({
  page,
}) => {
  await openAppearance(page);
  await paperTile(page).click();

  const readings: Record<string, { base: string; body: number; small: number }> =
    {};
  for (const mode of ["Dark", "Light"] as const) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    readings[mode] = {
      base: await token(page, "--surface-base"),
      body: await contrast(page, "--text-primary", "--surface-base"),
      small: await contrast(page, "--text-tertiary", "--surface-raised"),
    };
  }

  // The light block really activates — without this, a skin whose light
  // override never won the cascade would still pass the contrast checks by
  // silently staying dark in both.
  expect(readings["Light"].base).not.toBe(readings["Dark"].base);

  for (const mode of ["Dark", "Light"] as const) {
    // Body text and the ≤12px tier both clear AA. `--text-tertiary` exists in
    // this codebase precisely because `--text-muted` did not (3.62:1), so it is
    // the one that must be held to 4.5:1.
    expect(readings[mode].body, `${mode}: body text on the page ground`)
      .toBeGreaterThanOrEqual(4.5);
    expect(readings[mode].small, `${mode}: the ≤12px tier on a card`)
      .toBeGreaterThanOrEqual(4.5);
  }

  // Links and filled buttons, the two pairs the base ramp does NOT clear.
  for (const mode of ["Dark", "Light"] as const) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    expect(
      await contrast(page, "--accent-text", "--surface-base"),
      `${mode}: link text`,
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      await contrast(page, "--text-on-accent", "--accent"),
      `${mode}: label on a filled button`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});

test("a chosen accent still beats the skin's default accent", async ({
  page,
}) => {
  await openAppearance(page);
  await paperTile(page).click();
  const skinAccent = await token(page, "--accent");

  await page.getByRole("radio", { name: "Teal" }).click();

  // `:not([data-accent])` on the skin's accent block is what makes this hold
  // regardless of stylesheet import order — the regression it prevents is a
  // skin quietly eating the accent picker sitting right below it.
  await expect(page.locator("html")).toHaveAttribute("data-accent", "teal");
  const chosen = await token(page, "--accent");
  expect(chosen).not.toBe(skinAccent);
  expect(await token(page, "--accent-option-teal")).toBe(chosen);
});

test("the Liquid Glass slider is shown only for the skin that has glass", async ({
  page,
}) => {
  await openAppearance(page);
  const slider = page.getByRole("slider", {
    name: "Liquid Glass transparency",
  });
  await expect(slider).toBeVisible();

  await paperTile(page).click();
  // Paper sets --glass-blur to 0 and an opaque veil, so the control would have
  // nothing left to fade; it is removed rather than left there doing nothing.
  await expect(slider).toHaveCount(0);

  await studioTile(page).click();
  await expect(slider).toBeVisible();
});
