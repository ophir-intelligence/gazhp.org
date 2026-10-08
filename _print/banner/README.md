# GAZHP roll-up banner (85 × 200 cm)

Print source for the event banner. This folder starts with `_`, so GitHub Pages does not publish it.

- `banner.html` — redesign (one website QR, homepage photo, large type).
- `banner-original-revised.html` — the organisation's original banner style (flag ribbons, red headings) with the board feedback applied: fewer sections, larger text, website QR, photo.
- `banner-v1.html`, `banner-a.html`, `banner-b.html`, `banner-c.html` — earlier version and the three design options it was chosen from.
- `assets/` — logo, photos and QR codes (`qr-site.svg` → https://gazhphealth.org/, plus join/donate codes).

## Build

```bash
python3 build.py banner.html
```

This writes `banner-print.pdf` (860 × 2010 mm = 850 × 2000 mm trim + 5 mm bleed) and `banner-preview.png`. It also decodes every QR code from the render and prints the URLs, so check that the output shows `https://gazhphealth.org/`. It needs Google Chrome and `zbarimg` (`brew install zbar`).

## Before printing

- **Logo:** `assets/logo.png` is upscaled from the 94 px website logo, so it prints soft. Replace it with the original artwork (SVG, PDF or a PNG ≥ 2000 px, transparent background) using the same filename, then rebuild. The logo is cropped in `banner.html` (`.logo-crop`), so check its position after swapping.
- **Printer:** ask whether they need CMYK or a different size (80 × 200 and 100 × 200 cm are common). The PDF is RGB with fonts embedded.
