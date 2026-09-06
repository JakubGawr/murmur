import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import {
  MurSegmentedComponent,
  type SegmentOption,
} from "../../../../design-system/segmented/segmented.component";
import { MurSliderComponent } from "../../../../design-system/slider/slider.component";
import {
  ChromeService,
  type AccentId,
  type SkinId,
} from "../../../../services/chrome.service";
import { GlassService } from "../../../../services/glass.service";
import { ThemeService, type ThemeMode } from "../../../../services/theme.service";

/**
 * Settings → appearance section: the theme SKIN (what the app is made of),
 * the light/dark choice (mur-segmented), the accent, and the Liquid Glass
 * transparency slider (mur-slider). State/actions live in the root-provided
 * Theme/Chrome/Glass services so section switches never drop them.
 */
@Component({
  selector: "app-settings-appearance-section",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MurSegmentedComponent, MurSliderComponent],
  templateUrl: "./settings-appearance-section.component.html",
  styleUrl: "./settings-appearance-section.component.scss",
})
export class SettingsAppearanceSectionComponent {
  private readonly theme = inject(ThemeService);
  private readonly glass = inject(GlassService);
  private readonly chrome = inject(ChromeService);

  /** The three theme choices, rendered by <mur-segmented>. */
  readonly themeOptions: readonly SegmentOption[] = [
    { value: "light", label: "Light", icon: "sun" },
    { value: "dark", label: "Dark", icon: "moon" },
    { value: "system", label: "System", icon: "display" },
  ];

  /** Current theme choice (Light / Dark / System) — drives the Appearance control. */
  readonly themeMode = this.theme.mode;

  /** Liquid Glass transparency 0–100 — drives the slider position + label. */
  readonly glassLevel = this.glass.level;

  /** Apply a theme immediately (persisted in the service; no save() needed). */
  setTheme(mode: string): void {
    this.theme.setMode(mode as ThemeMode);
  }

  /** Apply + persist the glass level live as the slider moves (auto-saved). */
  setGlass(value: number): void {
    this.glass.setLevel(value);
  }

  /** The theme skins. Studio is the shipped glass look; Paper is the quiet
   * document skin. Both are token layers — see src/design-tokens/skin-paper.css. */
  readonly skinOptions: readonly {
    id: SkinId;
    name: string;
    description: string;
  }[] = [
    {
      id: "studio",
      name: "Studio",
      description: "Frosted glass over a soft light field. Murmur's own look.",
    },
    {
      id: "paper",
      name: "Paper",
      description:
        "A quiet document. Flat surfaces, the Mac's own type, and a serif for writing.",
    },
  ];

  /** Current skin — drives the tile selection and hides the glass slider. */
  readonly skin = this.chrome.skin;

  /** Apply a skin immediately (persisted in the service; no save() needed). */
  setSkin(skin: SkinId): void {
    this.chrome.setSkin(skin);
  }

  /** The accent swatches; each maps to an `--accent-option-*` token class. */
  readonly accentOptions: readonly { id: AccentId; label: string }[] = [
    { id: "purple", label: "Purple" },
    { id: "blue", label: "Blue" },
    { id: "teal", label: "Teal" },
    { id: "green", label: "Green" },
    { id: "orange", label: "Orange" },
    { id: "pink", label: "Pink" },
  ];

  /** Current accent palette — drives the swatch selection ring. */
  readonly accent = this.chrome.accent;

  /** Apply an accent immediately (persisted in the service). */
  setAccent(accent: AccentId): void {
    this.chrome.setAccent(accent);
  }
}
