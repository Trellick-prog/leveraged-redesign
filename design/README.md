# Design tokens – colour & type

Open `palette.html` in a browser to compare the blue options side by side and to see every scale with its WCAG contrast.

| File | What it is |
|---|---|
| `colors.css` | Colour scales (blue, orange, grey, status) and semantic role tokens as CSS custom properties |
| `typography.css` | Font stacks, fluid type scale, base heading/body/eyebrow/legal styles |
| `tokens.json` | The same values as JSON, for Figma Tokens or Style Dictionary |
| `palette.html` | Visual reference: blue comparison, scales, role mapping, type specimen |

## Why the blue changed

The current `#0B3B5C` is about `oklch(0.34 0.076 244°)`. Its hue leans teal and its chroma is low, so it reads as grey slate or petrol rather than navy. The blues used alongside it (`#134A70`, `#23445C`, `#5C84A1`, `#08283F`) each have different saturation, so they don't match.

All new scales are built in OKLCH with a fixed hue and even lightness steps, so the blues match at every step.

| Option | Brand (800) | Hue / chroma | Character |
|---|---|---|---|
| **A · Harbour** (default) | `#003F72` | 250.6° / 0.10 (official brand blue) | True navy that looks clear and trustworthy. Gives the strongest contrast with the orange |
| B · Ink | `#1D3976` | 263° / 0.11 | Deeper and slightly violet. Feels premium |
| C · Refined | `#014167` | 244° / 0.09 | Today's hue with the greyness removed. The smallest change |

To switch the whole site, set `<html data-blue="ink">` or `<html data-blue="refined">`.

## Orange fix

White text on `#E5602B` is only 3.48:1, which fails WCAG AA for 16–17px button text. Buttons now use `--orange-600` `#C94502` (4.84:1). The original `#E5602B` stays as `--orange-500` for large or decorative use (step numbers, icons).

## Fonts

- **Source Serif 4** (display): h1, h2 and the logo wordmark
- **Manrope** (UI/body): everything else, including h3, buttons, nav and rates. Use `.rate` / `.figure` for tabular numerals.

## Mapping from the current `index.html`

| Old | New token |
|---|---|
| `#0B3B5C` (hero, top bar, contact) | `--blue-900` for backgrounds, `--blue-800` for brand text, borders and logo |
| `#134A70` | `--blue-800` |
| `#08283F` (footer) | `--blue-950` |
| `#23445C`, `#5C84A1` | `--blue-700`, `--blue-500` |
| `#D9E4EC` / `#C3D1DC` | `--blue-200` / `--grey-300` |
| `#E5602B` buttons | `--orange-600` (hover `--orange-700`) |
| `#B54418` | `--orange-700` |
| `#F4B393` | `--orange-300` |
| `#12212E` / `#4A5A66` | `--grey-950` / `--grey-600` |
| `#F6F7F5` / `#E2E5E1` | `--grey-50` / `--grey-200` |
