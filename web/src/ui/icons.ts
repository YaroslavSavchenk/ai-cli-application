/**
 * Inline SVG glyphs. Nocturne's design source draws its icons from Phosphor,
 * and the app takes no icon PACKAGE (open decision #5 in
 * `.claude/plans/PLAN-NOCTURNE.md`, settled by the user at B12: inline subset,
 * licences committed) — so the handful of glyphs the chrome needs are
 * transcribed here as path data (copied verbatim from
 * `design/session-manager/session-manager-v3.html`) and built with
 * createElementNS. No dependency, no build step, no innerHTML. File-type
 * icons live in `./icons-files.ts`, tool marks in `./icons-tools.ts`.
 *
 * Every icon is decorative: the control around it carries the accessible name.
 *
 * Phosphor Icons (https://phosphoricons.com), MIT — licence text committed at
 * ../assets/icons/LICENSE-Phosphor.txt. Paths are copied from the v3 handoff —
 * except INFO_PATH, which the handoff does not have and is drawn here, and
 * X_PATH, which the handoff does not have either and is copied from Phosphor's
 * own published "x" (regular) instead.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Phosphor "gear" (regular), 256x256 viewBox — the Settings button. */
const GEAR_PATH =
  'M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z';

/**
 * Phosphor "folder" (fill), 256x256 viewBox — the Files panel's tree rows.
 * Filled rather than outlined on purpose: at 16px a folder row has to read as
 * one mark from the corner of the eye, and its FILL is the row's state
 * (neutral when closed, lighter when open, amber while something below it is
 * being edited).
 */
const FOLDER_PATH =
  'M216,72H130.67L102.93,51.2a16.12,16.12,0,0,0-9.6-3.2H40A16,16,0,0,0,24,64V200a16,16,0,0,0,16,16H216.89A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72Z';

/**
 * "Info" — a ring with an i, for the launch dialog's one info button (Nocturne
 * A4). NOT a Phosphor path: the v3 handoff draws no info glyph, so this one is
 * built here from plain circles and a bar on the same 256 grid and 16-unit
 * line weight as the Phosphor regular set, and filled even-odd so the ring
 * stays hollow.
 */
const INFO_PATH =
  'M128,24a104,104,0,1,1,0,208a104,104,0,1,1,0-208Z' +
  'M128,40a88,88,0,1,0,0,176a88,88,0,1,0,0-176Z' +
  'M128,70a13,13,0,1,1,0,26a13,13,0,1,1,0-26Z' +
  'M120,112h16v72h-16Z';

/**
 * "Caret left" — the back chevron on the commit view's two back controls
 * (Nocturne A6). NOT a Phosphor path: the v3 handoff draws its chevron as the
 * TEXT character `\u2039`, and a glyph inside a sentence is exactly what the
 * copy rules ban — so the mark is drawn here on the same 256 grid and 16-unit
 * line weight as the Phosphor regular set, and the button keeps a plain label.
 */
const CARET_LEFT_PATH = 'M152.7,41.4L164,52.7L88.7,128L164,203.3L152.7,214.6L66.1,128Z';

/**
 * Phosphor "x" (regular), 256x256 viewBox — the End session button in a
 * session pane's header (Nocturne B8). The handoff draws its closes as the
 * text character `\u00d7`; the pane button is an icon with a spoken name, so
 * it takes the real glyph, copied verbatim from Phosphor (same MIT licence).
 */
const X_PATH =
  'M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z';

/**
 * One transcribed glyph: its path data, the grid it was drawn on (Phosphor
 * draws on 256, Simple Icons and LobeHub on 24) and whether it must be filled
 * even-odd (LobeHub's marks are; its holes are sub-paths, not cut-outs).
 * The file-type set lives in `./icons-files.ts`, the tool marks in
 * `./icons-tools.ts` (part B12); this module keeps the chrome's own glyphs.
 */
export interface IconPath {
  readonly d: string;
  readonly vb: 24 | 256;
  readonly evenodd?: true;
}

/**
 * Build one decorative SVG from path data. `currentColor` fill, so the colour
 * is the element's own `color` — a token set by CSS, never by the icon.
 */
export function pathIcon(p: IconPath, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  // A 24-grid logo is drawn edge to edge; a Phosphor glyph keeps a ~10%
  // inset on its 256 grid. Two units of air round the 24 grid (24/28 of the
  // box) give the logos the same optical size as the glyphs beside them.
  svg.setAttribute('viewBox', p.vb === 24 ? '-2 -2 28 28' : '0 0 256 256');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', p.d);
  if (p.evenodd === true) path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);
  return svg;
}

function icon(d: string, size: number, fillRule: 'nonzero' | 'evenodd' = 'nonzero'): SVGSVGElement {
  return pathIcon(fillRule === 'evenodd' ? { d, vb: 256, evenodd: true } : { d, vb: 256 }, size);
}

/** The Settings gear at the v3 size (15px inside a 30px control). */
export function gearIcon(): SVGSVGElement {
  return icon(GEAR_PATH, 15);
}

/** The folder glyph: 16px (the v3 size) in a tree row, 13px on a folder tab (B12). Colour comes from CSS. */
export function folderIcon(size = 16): SVGSVGElement {
  return icon(FOLDER_PATH, size);
}

/** The back chevron at 12px, inside the commit view's back controls (A6). */
export function caretLeftIcon(): SVGSVGElement {
  return icon(CARET_LEFT_PATH, 12);
}

/** The info glyph at 14px, inside the launch dialog's 20px info button. */
export function infoIcon(): SVGSVGElement {
  return icon(INFO_PATH, 14, 'evenodd');
}

/** The X glyph at 14px, inside a pane header's 24px End session button (B8). */
export function xIcon(): SVGSVGElement {
  return icon(X_PATH, 14);
}
