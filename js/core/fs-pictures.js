/**
 * fs-pictures.js — the sample images seeded into ~/Pictures.
 *
 * These are SVG rather than PNG on purpose. The virtual filesystem stores file
 * content as a string and persists the whole tree into localStorage on every
 * change, so a raster wallpaper would mean base64 — roughly 100 KB per image —
 * re-serialised on every write. SVG markup costs a couple of hundred bytes,
 * survives the round trip as plain text, and the Image Viewer decodes it
 * natively (see js/apps/imageviewer/gallery.js, which accepts either a
 * `data:image/…` URL or raw SVG markup in a `.svg` file).
 *
 * The point is that a fresh install has something real to open: before this,
 * ~/Pictures held a single zero-byte stub and the viewer could only greet a
 * first-time user with its "cannot decode" page.
 *
 * Every gradient here is drawn from the Yaru palette in css/base/tokens.css.
 */

/** The default desktop background, in the Ubuntu aubergine-to-orange ramp. */
export const WALLPAPER_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2c001e"/>
      <stop offset="55%" stop-color="#772953"/>
      <stop offset="100%" stop-color="#e95420"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.72" cy="0.28" r="0.55">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#sky)"/>
  <rect width="1920" height="1080" fill="url(#glow)"/>
  <g fill="none" stroke="#ffffff" stroke-opacity="0.10" stroke-width="2">
    <circle cx="1380" cy="300" r="150"/>
    <circle cx="1380" cy="300" r="250"/>
    <circle cx="1380" cy="300" r="360"/>
  </g>
</svg>
`;

/**
 * The Circle of Friends mark, drawn to the real Ubuntu geometry: three dots at
 * 90°, 210° and 330° joined by an arc that breaks at each dot.
 */
export const LOGO_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" fill="#2c001e"/>
  <g transform="translate(128 128)">
    <g fill="none" stroke="#e95420" stroke-width="17" stroke-linecap="butt">
      <path d="M 62 0 A 62 62 0 0 1 -31 53.7"/>
      <path d="M -31 -53.7 A 62 62 0 0 1 31 -53.7" transform="rotate(180)"/>
      <path d="M -31 53.7 A 62 62 0 0 1 -31 -53.7"/>
    </g>
    <g fill="#e95420">
      <circle cx="62" cy="0" r="22"/>
      <circle cx="-31" cy="53.7" r="22"/>
      <circle cx="-31" cy="-53.7" r="22"/>
    </g>
  </g>
</svg>
`;

/** A flat Yaru-accent swatch sheet, useful for testing zoom and panning. */
export const PALETTE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 300" width="1000" height="300">
  <rect width="1000" height="300" fill="#1e1e1e"/>
  <g>
    <rect x="0"   y="0" width="100" height="240" fill="#787859"/>
    <rect x="100" y="0" width="100" height="240" fill="#657b69"/>
    <rect x="200" y="0" width="100" height="240" fill="#4b8501"/>
    <rect x="300" y="0" width="100" height="240" fill="#03875b"/>
    <rect x="400" y="0" width="100" height="240" fill="#308280"/>
    <rect x="500" y="0" width="100" height="240" fill="#0073e5"/>
    <rect x="600" y="0" width="100" height="240" fill="#7764d8"/>
    <rect x="700" y="0" width="100" height="240" fill="#b34cb3"/>
    <rect x="800" y="0" width="100" height="240" fill="#da3450"/>
    <rect x="900" y="0" width="100" height="240" fill="#e95420"/>
  </g>
  <text x="500" y="278" fill="#d0cfcc" font-family="Ubuntu, sans-serif"
        font-size="26" text-anchor="middle">Yaru accent colours</text>
</svg>
`;

/**
 * Files seeded into ~/Pictures, as [relative name, content] pairs.
 * @type {Array<[string, string]>}
 */
export const PICTURES = [
  ['ubuntu-wallpaper.svg', WALLPAPER_SVG],
  ['ubuntu-logo.svg', LOGO_SVG],
  ['yaru-palette.svg', PALETTE_SVG],
];
