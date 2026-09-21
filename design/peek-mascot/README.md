# Handoff: Claude Peek Mascot

## Overview
A small pixel-art Claude mascot that peeks around the right edge of the screen whenever the app needs user input. It replaces a notification/toast. One mascot per pending input, max 3, stacked on top of each other with distinct poses and entrance animations. Clicking a mascot triggers a random reaction (laugh or wave).

## About the Design Files
`Claude Peek Mascot.dc.html` is a **design reference built in HTML** (a prototype format with a small template runtime — `support.js` is that runtime and is not needed in the app). It shows intended look and behavior; it is not production code to copy directly. Recreate the design in the target codebase's existing environment (React, Vue, Svelte, etc.) using its patterns. The SVG pixel art, keyframes and timings below can be transferred verbatim.

## Fidelity
**High-fidelity.** Colors, pixel grid, sizes, positions, timings and easing are final. Recreate 1:1.

## Component: `<PeekMascots count={0..3} />`

### Container
- `position: fixed; right: 0; top: 50%; transform: translateY(-50%)`
- `width: 220px; height: 340px; pointer-events: none` (children re-enable pointer events)
- The **screen edge is the wall**: mascots are placed with negative `right` so part of the body is clipped by the viewport. Root/body must have `overflow: hidden` on the x-axis.

### Each mascot (3 nested layers)
1. **Position layer** — `position:absolute; width:100px; height:120px; right/bottom/z-index per pose; animation: <enter animation>; transition: bottom .7s cubic-bezier(.3,1.4,.5,1), right .7s ease; pointer-events:auto`
2. **Tilt layer** — `transform: rotate(<tilt>); transform-origin: 80% 100%`
3. **Reaction layer** — `onClick; cursor:pointer; user-select:none; animation: <idle/reaction animation>; transform-origin: center bottom`, contains the SVG.

### Poses (index = slot, 0-based)
| slot | right | bottom | z | tilt | left arm | enter animation |
|---|---|---|---|---|---|---|
| 0 (bottom, peeks around edge) | -50px | 14px | 3 | rotate(-22deg) | down | `slideIn 1.4s cubic-bezier(.25,.8,.3,1) both` — when count is 3 also `, shove .4s ease-in-out 0.4s 5` |
| 1 (climbs on top of #0) | -40px | 58px (count 2) / 110px (count 3) | 1 | rotate(-8deg) | up | `climb 1.6s cubic-bezier(.4,.1,.4,1) both` — when count is 3 also `, shove .4s ease-in-out 0.5s 5` |
| 2 (squeezes in between) | -16px | 52px | 2 | rotate(6deg) | down | `squeeze 2.6s ease-in-out both` |

Slot 1's `bottom` transitions upward when slot 2 appears (pushed up). z-order: #0 in front, #2 middle, #1 behind.

### SVG pixel art
`<svg width="100" height="120" viewBox="0 0 15 18" shape-rendering="crispEdges" style="overflow:visible">`. Grid unit = 1. Draw order matters.

Colors: body `#d97757`, shade `#c96442`, highlight `#eb9878`, outline/eyes `#2d2b26`, sweat drop `#9cc7e8`.

1. **Outline silhouette** (dark, drawn first; `fill` and `stroke` `#2d2b26`, `stroke-width 1`, `stroke-linejoin miter` — gives a 0.5-unit rim):
   - arm down: `M4 5 H13 V6 H14 V8 H15 V12 H14 V13 H13 V14 H12 V17 H10 V14 H7 V17 H5 V14 H4 V13 H3 V13 H1 V8 H3 V6 H4 Z`
   - arm up: `M4 5 H13 V6 H14 V8 H15 V12 H14 V13 H13 V14 H12 V17 H10 V14 H7 V17 H5 V14 H4 V13 H3 V9 H1 V2 H3 V6 H4 Z`
   - waving (arm drawn separately): `M4 5 H13 V6 H14 V8 H15 V12 H14 V13 H13 V14 H12 V17 H10 V14 H7 V17 H5 V14 H4 V13 H3 V6 H4 Z`
2. **Body**: rect (4,5,9×1) `#d97757`; rect (3,6,11×7) `#d97757`; rect (4,13,9×1) `#c96442`; highlight rects (4,6,2×1) and (4,7,1×1) `#eb9878`; shade rect (12,7,1×6) `#c96442`.
3. **Left arm** (one of):
   - down: rect (1,8,2×4) `#d97757`, hand (1,12,2×1) `#eb9878`
   - up: rect (1,3,2×6) `#d97757`, hand (1,2,2×1) `#eb9878`
   - waving: `<g style="transform-origin:2px 9px; animation: wave 1.3s ease-in-out 1">` with rect (0.5,2.5,2.5×7) `#2d2b26`, rect (1,4,2×5) `#d97757`, rect (1,3,2×1) `#eb9878`
4. **Right arm**: rect (14,8,1×4) `#c96442`
5. **Feet**: rects (5,14,2×2) and (10,14,2×2) `#d97757`; soles (5,16,2×1) and (10,16,2×1) `#c96442`
6. **Face** (one of):
   - normal: `<g style="transform-origin:8.5px 9px; animation: blink 4s infinite">` rects (6,8,1×2), (10,8,1×2); mouth (8,11,1×1)
   - happy (laugh): (5,8),(6,7),(7,8),(9,8),(10,7),(11,8) 1×1 each; smile (6,11,5×1),(5,10,1×1),(11,10,1×1)
   - strain: (5,8,1×1),(6,9,2×1),(11,8,1×1),(9,9,2×1); mouth (6,11,5×1); teeth (7,12,1×1),(9,12,1×1); sweat (12,6,1×1) `#9cc7e8`

## Interactions & Behavior
- **Idle**: `bob 3s ease-in-out infinite` on the reaction layer; eyes blink.
- **Click**: if mascot is idle, pick randomly from `laugh` or `wave`; revert to idle after the duration. Ignore clicks while reacting.
  - laugh: reaction layer `laugh 1.4s ease-in-out 1`, happy face, 1400 ms
  - wave: reaction layer `waveBody 1.3s ease-in-out 1`, waving arm variant, normal face, 1300 ms
- **Count goes to 3**: slot 0 enters a "straining" state for 3400 ms: animation `strain 1.1s ease-in-out infinite` and strain face; then back to idle. Slots 0 and 1 also get the `shove` animation appended (see poses).
- **Count decreases**: simply unmount the highest slot; slot 1's `bottom` transitions back down.
- Never more than 3 mascots.

## Keyframes (copy verbatim)
```css
@keyframes blink { 0%, 92%, 100% { transform: scaleY(1); } 96% { transform: scaleY(0.1); } }
@keyframes bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes slideIn { from { transform: translateX(130%); } to { transform: translateX(0); } }
@keyframes climb { 0% { transform: translate(60px, 150px) rotate(20deg); } 35% { transform: translate(30px, 110px) rotate(10deg); } 55% { transform: translate(28px, 60px) rotate(-6deg); } 75% { transform: translate(8px, 20px) rotate(8deg); } 88% { transform: translate(0, -8px) rotate(0); } 100% { transform: translate(0,0) rotate(0); } }
@keyframes squeeze { 0% { transform: translateX(130%) scale(.55, 1.45); } 25% { transform: translateX(40px) scale(.55, 1.45) rotate(-4deg); } 35% { transform: translateX(44px) scale(.5, 1.5) rotate(3deg); } 45% { transform: translateX(28px) scale(.55, 1.45) rotate(-5deg); } 55% { transform: translateX(32px) scale(.5, 1.5) rotate(4deg); } 65% { transform: translateX(14px) scale(.6, 1.4) rotate(-3deg); } 75% { transform: translateX(16px) scale(.55, 1.45) rotate(2deg); } 86% { transform: translateX(0) scale(1.2, .8) rotate(0); } 93% { transform: translateX(0) scale(.92, 1.1); } 100% { transform: translateX(0) scale(1); } }
@keyframes strain { 0%,100% { transform: translate(0,0) scale(1.04,.94) rotate(-1deg); } 20% { transform: translate(1px,1px) scale(1.05,.93) rotate(1deg); } 40% { transform: translate(-1px,0) scale(1.04,.94) rotate(-1deg); } 60% { transform: translate(1px,1px) scale(1.06,.92) rotate(.5deg); } 80% { transform: translate(-1px,1px) scale(1.04,.94) rotate(-.5deg); } }
@keyframes shove { 0%,100% { transform: translate(0,0); } 30% { transform: translate(3px,-2px); } 50% { transform: translate(-2px,1px); } 70% { transform: translate(3px,-3px); } 85% { transform: translate(-1px,0); } }
@keyframes laugh { 0% { transform: translateY(0) scale(1) rotate(0); } 12% { transform: translateY(-6px) scale(1.06,.94) rotate(-3deg); } 24% { transform: translateY(0) scale(.97,1.04) rotate(2deg); } 36% { transform: translateY(-5px) scale(1.06,.94) rotate(-2deg); } 48% { transform: translateY(0) scale(.98,1.03) rotate(2deg); } 60% { transform: translateY(-4px) scale(1.05,.95) rotate(-2deg); } 72% { transform: translateY(0) scale(.98,1.02) rotate(1deg); } 84% { transform: translateY(-2px) scale(1.02,.98) rotate(-1deg); } 100% { transform: translateY(0) scale(1) rotate(0); } }
@keyframes wave { 0% { transform: rotate(0); } 15% { transform: rotate(-50deg); } 30% { transform: rotate(-20deg); } 45% { transform: rotate(-55deg); } 60% { transform: rotate(-20deg); } 75% { transform: rotate(-50deg); } 100% { transform: rotate(0); } }
@keyframes waveBody { 0%,100% { transform: rotate(0); } 30% { transform: rotate(3deg) translateX(-2px); } 70% { transform: rotate(3deg) translateX(-2px); } }
```

## State Management
- `count: 0..3` — driven by the app (number of pending inputs). Clamp to 3.
- `moods: ('idle'|'laugh'|'wave')[3]` — per slot, with a timeout per slot to return to idle.
- `straining: boolean` — set true when count transitions to 3; cleared after 3400 ms.
- Clear all timeouts on unmount.

## Design Tokens
- Page background used in prototype: `#faf9f5` (use the app's own background).
- Mascot: `#d97757` body, `#c96442` shade, `#eb9878` highlight, `#2d2b26` outline/eyes, `#9cc7e8` sweat.
- Mascot size: 100×120 px (15×18 grid units, 6.67 px per unit).

## Assets
None external; all artwork is inline SVG rects/paths described above.

## Files
- `Claude Peek Mascot.dc.html` — the prototype (template + logic class at the bottom). The demo controls ("+ input" / "− opgelost") in the top-left are for testing only and should not be shipped.
