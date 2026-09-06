import { Injectable, signal } from "@angular/core";

/** The user-selectable accent palettes (Settings → Appearance). `purple` is
 * the base :root ramp in colors.css; the others live in accents.css. */
export type AccentId =
  | "purple"
  | "blue"
  | "teal"
  | "green"
  | "orange"
  | "pink";

/** The user-selectable THEME SKINS (Settings → Appearance → Theme). `studio` is
 * the base ramp shipped in colors/layout/glass.css; `paper` is the quiet
 * document skin in skin-paper.css. Orthogonal to light/dark — a skin says what
 * the app is MADE OF, `data-theme` says how bright it is. */
export type SkinId = "studio" | "paper";

const ACCENT_KEY = "murmur-accent";
const SKIN_KEY = "murmur-skin";
const VALID_SKINS: readonly SkinId[] = ["studio", "paper"];
const VALID_ACCENTS: readonly AccentId[] = [
  "purple",
  "blue",
  "teal",
  "green",
  "orange",
  "pink",
];

/**
 * Owns visual chrome preferences (Settings → Appearance). Persisted in
 * localStorage like ThemeService — pure webview chrome state, no IPC needed.
 */
@Injectable({ providedIn: "root" })
export class ChromeService {
  private readonly _accent = signal<AccentId>(this.readAccent());
  /** The user's chosen accent palette (default `purple`). */
  readonly accent = this._accent.asReadonly();

  private readonly _skin = signal<SkinId>(this.readSkin());
  /** The user's chosen theme skin (default `studio`). */
  readonly skin = this._skin.asReadonly();

  constructor() {
    // Applied at first injection (AppComponent, before the window is revealed)
    // so a non-default accent never flashes purple — same timing as ThemeService.
    this.applyAccent(this._accent());
    this.applySkin(this._skin());
  }

  /** Set and persist the accent palette; applies immediately (auto-saved). */
  setAccent(accent: AccentId): void {
    this._accent.set(accent);
    try {
      localStorage.setItem(ACCENT_KEY, accent);
    } catch {
      // localStorage unavailable — the in-memory signal still works.
    }
    this.applyAccent(accent);
  }

  private readAccent(): AccentId {
    try {
      const v = localStorage.getItem(ACCENT_KEY);
      if (v && VALID_ACCENTS.includes(v as AccentId)) return v as AccentId;
    } catch {
      // ignore — fall through to the default
    }
    return "purple";
  }

  /** Default purple = NO attribute (the base :root ramp); others stamp it. */
  private applyAccent(accent: AccentId): void {
    if (accent === "purple") {
      document.documentElement.removeAttribute("data-accent");
    } else {
      document.documentElement.setAttribute("data-accent", accent);
    }
  }

  /** Set and persist the theme skin; applies immediately (auto-saved). */
  setSkin(skin: SkinId): void {
    this._skin.set(skin);
    try {
      localStorage.setItem(SKIN_KEY, skin);
    } catch {
      // localStorage unavailable — the in-memory signal still works.
    }
    this.applySkin(skin);
  }

  private readSkin(): SkinId {
    try {
      const v = localStorage.getItem(SKIN_KEY);
      if (v && VALID_SKINS.includes(v as SkinId)) return v as SkinId;
    } catch {
      // ignore — fall through to the default
    }
    return "studio";
  }

  /** Default studio = NO attribute (the base :root ramp); a skin stamps it —
   * the same convention as the accent above, which is what lets skin-paper.css
   * express "no skin chosen" as plain absence rather than a third state. */
  private applySkin(skin: SkinId): void {
    if (skin === "studio") {
      document.documentElement.removeAttribute("data-skin");
    } else {
      document.documentElement.setAttribute("data-skin", skin);
    }
  }
}
