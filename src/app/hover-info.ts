/**
 * Whether the box of figures beside the pointer is drawn (the Hover info box setting, `AppState.hoverInfo`; the person, 2026-11-20:
 * "this info thing that's beside the mouse … it's just annoying"). One switch for every box, the canvas's (infobox.ts `paintInfoBox`,
 * mirror.ts) and the page's (hovercard.ts), so that no pane, script or overlay keeps one of its own.
 *
 * Off, a mouse or a pen gets no box: the crosshair, the price and time on the axes and the legend say where it is. A finger keeps its
 * box: a held crosshair is how a phone reads a cell, there being no other way to (and a TPO box is also what a tap opens the menu from).
 * A pinned card (the Stats pane's pinned candles) is something chosen, not a hover, and stays either way.
 */
let wanted = false;
let touch = false;

/** Follow the setting (main.ts, from the store). */
export function setHoverInfo(on: boolean): void { wanted = on; }

/** Whether the setting is on. */
export function hoverInfoWanted(): boolean { return wanted; }

/** What pointer last moved or pressed: `touch` keeps the box with the setting off. */
export function noteHoverPointer(pointerType: string): void { touch = pointerType === 'touch'; }

/** Whether a hover's box is drawn now. */
export function hoverInfoShown(): boolean { return wanted || touch; }

let watching = false;
/** Note every pointer on the page, before any pane hears of it (capture), so a box drawn for that move knows what made it. */
export function watchHoverPointers(target: Pick<Window, 'addEventListener'> = window): void {
  if (watching) return; watching = true;
  const note = (e: Event): void => { const type = (e as PointerEvent).pointerType; if (type) noteHoverPointer(type); };
  for (const type of ['pointerdown', 'pointermove'] as const) target.addEventListener(type, note, { capture: true, passive: true });
}
