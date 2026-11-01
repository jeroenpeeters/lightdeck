# Lightdeck: Console redesign (design handoff)

The design for the new Lightdeck UI: the "Console" direction.
Build target: plain HTML, CSS and JavaScript. No framework, no build step, fonts self-hosted.

## What is in this folder

| Path | What |
|---|---|
| `tokens/lightdeck.css` | **The design system as real CSS**: tokens as custom properties plus every component class (`.key`, `.look`, `.chip`, `.part`, `.fader`, `.gtab`, `.bo`, `.armkey`…). Use it as the starting stylesheet. |
| `mockups/*.html` | Static mockups, one per screen, using only `lightdeck.css` plus a little inline layout. Open them in a browser. |
| `screenshots/*.png` | The same screens as images, at real size (1280×800, portrait 800×1280). |
| `index.html` | Overview with links to every mockup. |
| `00-design-system`, `00-navigation-model`, `00-directions` | Rules, states and the navigation model. Read these first. |

## Rules that must hold (from the brief)

1. **Colour has one meaning each.** Amber `--on` = the lights do this now. Striped amber with a dashed outline = **Varied** (on, but changed by hand since). White = where you are, and Next. Red `--danger` = blackout, laser, link lost **only**. Blue `--edit` = Program mode only. Green `--ok` = link lamps only.
2. **No large amber fills.** An "on" key is a dark slab with a 4 px amber bar on top and an amber outline (`.key.is-on`).
3. **Keys never move.** State changes swap classes only: no change in size, padding or border width. Notices (`.notice`) are `position:absolute` and lie over the content.
4. **Touch targets ≥ 48 px** (`--k-s`), live keys 64, looks 104.
5. **Always on screen** (`.top`): menu key with link dots, BPM + tempo source + beat lamps, Tap, master fader, master speed, Blackout (same place on every page).
6. **Live page layout:** top bar · group rail (Spider/Laser/Room/Video wall, each showing live mini output) | moods + looks + lane strip | tray (Vary) · parts bar (The night/Begin/Midden/Techno + Next/Hold).
7. **Laser:** red frame around its area; hold the arm key for 1 s; laser looks are disabled until armed; nothing but a hand press opens it; blackout closes and disarms it. (The 10-minute auto-disarm is a proposal.)
8. **Setup pages:** the top-left key reads "Live" and goes back in one press. Tempo source (By hand/Rekordbox/Idle in breakdown) moves into the menu.

## New behaviour to implement (JS)

- Hold-to-arm: pointerdown starts a 1 s fill, pointerup/cancel before 1 s aborts.
- Range slider with two handles (swing limit) plus an inner window (zone): `.range` / `.lim` in the movement mockup.
- Part progress: one segment per bar of the current step (`.part .bars i.done/.now`), plus "Now … → next … in N bars".
- Group rail mini output: lens colours, laser state, rail levels and current clip, fed from the same state as the simulator.
- Varied: pressing a tray chip that differs from the look's own sets `.is-varied` on the look; **All** restores the stored look.

## Fonts

IBM Plex Sans Condensed (400/500/600/700) and IBM Plex Mono (500/600), both under the OFL. The mockups load them from Google Fonts. For the party, download the woff2 files, put them in the app, add `@font-face` rules and remove the Google Fonts `<link>`.

## Placeholders, not real data

The video library tiles (except "The Alchemist Shadows"), the bar 2 zone of 30–60, and palette hex values (approximated from screenshots: use the real ones from show.yaml).
