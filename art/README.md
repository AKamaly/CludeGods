# The gods

Six characters, one per kind of worker. Each is a glossy sphere with a face, a gold halo and one
accessory. `gods.js` is the source of truth: every pixel is a function of time, with no timers,
CSS animations or randomness, so any frame can be redrawn exactly.

| kind | colours (c / c2) | accessory | default role |
|---|---|---|---|
| colleague | `#b9c6ff` / `#3d4aa0` | headphones with mic | the voice call itself |
| research | `#a78bfa` / `#6d28d9` | round gold glasses | research |
| scribe | `#60a5fa` / `#2563eb` | quill | drafting |
| scout | `#a3e635` / `#65a30d` | wings | watching things |
| sales | `#fb923c` / `#ea580c` | paper plane | follow-ups |
| herald | `#facc15` / `#ca8a04` | trumpet with a red banner | announcements |

States: `idle` (slow bob, look-around, blink), `talk` (mouth moves in syllables), `listen`
(leans in, eyes wider, halo brighter), `work` (bands spin fast, halo sparkles orbit), `happy`
(closed-eye smile, hops with arms up).

## Files

- `gods.js`: the characters. `Gods.make(parent, kind, size)` returns an element (a box 1.6 times
  the sphere diameter, art may overflow it); `el._set(t, cx, cy, { state, look, halo, shadow, loop })`
  draws time `t` with the sphere centred on `(cx, cy)`. `loop: 2` makes the motion repeat
  exactly every 2 s: each motion is snapped to whole cycles per loop and the blink happens once
  per loop. The drawing is the same with or without it.
- `gods.html`: the cast sheet. Open it in a browser. `?t=2` freezes at 2 s, `?loop=2` previews
  the sprite loop.

## Two outputs

**SVG, for mod panes.** `hooks/gods.ts` in the Workers pane mod (copied verbatim into every mod
that draws gods) is a port of `gods.js` to plain string building, since a mod has no DOM:

```ts
godSvg(kind, { size: 40, state: 'work', animated: true, halo: true }) // a whole <svg>
```

`size` is the svg's width and height in CSS px. The sphere is about 55% of it, a little below
centre, so the halo and accessories never get clipped. `animated` adds SMIL only: a 2 s loop
sampled from the same motion as `gods.js`, plus a glint along the halo. Below about 109 px it
draws the lighter detail level that `gods.js` uses for small sizes.

**Sprite strips, for the native call pill.** `scripts/render-gods.mjs` renders `gods.js` itself,
so the pill matches the art pixel for pixel. It writes `<kind>-<state>.png` (30 strips) and
`index.json`:

```json
{ "frame": 256, "frames": 24, "fps": 12, "box": 2.048 }
```

Each strip is 24 square frames of 256 px side by side, a seamless 2 s loop at 12 fps, on a
transparent background. The sphere is centred and 125 px wide (`frame / box`); 2.048 is the
smallest centred frame that keeps every halo, wing, plane and trumpet note inside through the
whole loop. Strips are 256-colour PNGs with light ordered dithering, about 150 to 225 KB each.

## Re-render

```sh
npm i --no-save puppeteer-core                     # once, in the repo
npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer   # once, if you have no Chrome
node scripts/render-gods.mjs --out ~/.claude/skills/colleague/bin/gods
```

Options: `--kinds colleague,scout`, `--states talk,idle`, `--frame`, `--frames`, `--fps`,
`--box`, `--lossless` (full RGBA, about 1 MB a strip). Set `CHROME_PATH` to use another Chrome.
For each strip it prints the size, proves the loop (the frame at 2 s equals the frame at 0 s),
compares the last-to-first step with the other steps, and reports any art touching the edge.

If you change the look in `gods.js`, port the same change to `gods.ts` and re-render the strips.
