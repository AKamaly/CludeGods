// The CludeGods cast as SVG strings: a port of art/gods.js (the film's characters) to
// static markup. Pure string building: no DOM, no Node, safe inside any mod module.
//
//   godSvg(kind, { size, state, animated, halo }) -> a whole <svg>, transparent background
//
// `size` is the CSS width and height of the returned svg. The sphere is about 55% of it,
// centred across and a little below centre, so the halo and every accessory fit inside. `animated`
// adds SMIL only (a 2 s seamless loop sampled from the same motion as the film: bob,
// blink, halo glint, talk mouth, work spin, listen lean, happy bounce); without it the
// result is one still frame. This file is copied verbatim into every mod that draws gods.

export type GodKind = 'colleague' | 'research' | 'scribe' | 'scout' | 'sales' | 'herald'
export type GodState = 'idle' | 'talk' | 'listen' | 'work' | 'happy'
export const GOD_KINDS: readonly GodKind[] = ['colleague', 'research', 'scribe', 'scout', 'sales', 'herald']

type Acc = 'headphones' | 'glasses' | 'quill' | 'wings' | 'plane' | 'trumpet'
const CAST: Record<GodKind, { c: string; c2: string; acc: Acc; ring: number }> = {
  colleague: { c: '#b9c6ff', c2: '#3d4aa0', acc: 'headphones', ring: -76 },
  research: { c: '#a78bfa', c2: '#6d28d9', acc: 'glasses', ring: -66 },
  scribe: { c: '#60a5fa', c2: '#2563eb', acc: 'quill', ring: -66 },
  scout: { c: '#a3e635', c2: '#65a30d', acc: 'wings', ring: -66 },
  sales: { c: '#fb923c', c2: '#ea580c', acc: 'plane', ring: -66 },
  herald: { c: '#facc15', c2: '#ca8a04', acc: 'trumpet', ring: -66 },
}
const STATES: readonly GodState[] = ['idle', 'talk', 'listen', 'work', 'happy']

const TAU = Math.PI * 2
const LOOP = 2 // seconds, one seamless loop
const STEPS = 48 // samples per loop for the SMIL keyframes
// The art is drawn in the film's 160-unit box (sphere radius 50 at 80,80). The svg shows
// a larger square, raised to make room for the halo, so nothing pokes out of an
// image-drawn svg through the whole loop (measured, not guessed).
const VB_X = -11
const VB_Y = -21
const VB_SIZE = 182

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const n2 = (v: number) => String(Math.round(v * 100) / 100)
const n3 = (v: number) => String(Math.round(v * 1000) / 1000)

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function rgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function mix(a: string, b: string, k: number): string {
  const A = rgb(a)
  const B = rgb(b)
  return '#' + A.map((v, i) => Math.round(v + ((B[i] ?? 0) - v) * k).toString(16).padStart(2, '0')).join('')
}

type W = Record<GodState, number>
const blend = (w: W, P: Record<GodState, number>) => STATES.reduce((s, k) => s + w[k] * P[k], 0)

interface Ctx {
  w: W
  acc: Acc
  ring: number
  ph: number
  ph2: number
  lod: 0 | 1
}
type Rec = Record<string, string>

// Every periodic motion is snapped to a whole number of cycles per loop. A motion slower
// than one cycle per loop keeps its speed by trading amplitude, so nothing races.
function snap(k: number): [number, number] {
  const raw = (k * LOOP) / TAU
  const n = Math.max(1, Math.round(raw))
  return [(n * TAU) / LOOP, raw < 1 ? raw : 1]
}
const S = (k: number, t: number, p: number) => {
  const [k2, a] = snap(k)
  return a * Math.sin(t * k2 + p)
}
const C = (k: number, t: number, p: number) => {
  const [k2, a] = snap(k)
  return a * Math.cos(t * k2 + p)
}

// One frame of the film's el._set(t, ...) for a single state, as attribute strings.
function pose(K: Ctx, t: number, still: boolean): Rec {
  const { w, acc, ring, ph, ph2, lod } = K
  const R: Rec = {}
  const bobA = blend(w, { idle: 2.2, talk: 1.4, listen: 1.1, work: 1.6, happy: 1 })
  const bobF = blend(w, { idle: 0.42, talk: 0.5, listen: 0.36, work: 0.7, happy: 0.5 })
  const bob = -S(TAU * bobF, t, ph) * bobA
  const hop = Math.abs(S(Math.PI * 2.1, t, ph))
  const land = Math.pow(1 - hop, 6) * w.happy
  const ta = 0.5 + 0.5 * S(TAU * 3.3, t, ph)
  const tb = 0.5 + 0.5 * S(TAU * 5.2, t, ph * 1.7)
  const env = clamp01(0.45 + 0.8 * S(TAU * 0.42, t, ph * 0.31))
  const m = clamp01(Math.pow(ta * 0.68 + tb * 0.32, 1.4) * env * 1.25) * w.talk
  const lift = -bob + 8 * hop * w.happy
  const lean = 7 * w.listen + 1.6 * S(2.7, t, ph) * w.talk
  const wob = 0.012 * S(TAU * 1.4, t, 0) * w.work
  const sx = 1 + 0.03 * m + 0.07 * land + wob
  const sy = 1 - 0.035 * m - 0.07 * land - wob
  const bx = 80
  const by = 80 - lift + 50 * (1 - sy)
  R.bodyT = `${n2(bx)} ${n2(by)}`
  R.bodyR = n2(lean)
  R.bodyS = `${n3(sx)} ${n3(sy)}`

  const breathe = 0.5 + 0.5 * S(TAU * 0.8, t, ph)
  R.auraO = n2(blend(w, { idle: 0.26, talk: 0.36, listen: 0.52, work: 0.24 + 0.22 * breathe, happy: 0.42 }))
  R.auraR = n2(68 + 5 * w.listen + 4 * breathe * w.work)
  const rate = blend(w, { idle: 24, talk: 45, listen: 30, work: 290, happy: 70 })
  const raw = (rate * LOOP) / 360
  let spin =
    raw < 0.5 ? ph * 57 + ((rate * LOOP) / TAU) * Math.sin((TAU * t) / LOOP) : (t * Math.round(raw) * 360) / LOOP + ph * 57
  if (still) spin %= 360
  R.swirl = n2(spin)

  const idleLook = w.idle * 0.18
  const glx = idleLook * S(0.37, t, ph2)
  const gly = idleLook * 0.6 * S(0.29, t, ph)
  R.face = `${n2(glx * 7)} ${n2(gly * 5)}`
  const eyeS = (lod ? 1 : 1.14) * (1 + 0.14 * w.listen - 0.04 * w.work)
  const eyeY = (1 - 0.26 * w.work) * (1 - 0.85 * w.happy)
  for (const [n, x] of [['L', -15], ['R', 15]] as const) {
    R['eye' + n] = `${n2(x + glx * 2.6)} ${n2(3 + gly * 2.4 + 1.2 * w.work)}`
  }
  R.eyeS = `${n3(eyeS)} ${n3(Math.max(0.06, eyeS * eyeY))}`
  R.hapS = n3(eyeS)
  R.blush = n2((acc === 'wings' ? 0.6 : 1) * (0.34 + 0.22 * w.happy + 0.08 * w.listen))

  const open = Math.max(m, 0.42 * w.happy)
  const mw = 5.4 + 1.6 * open + 1.6 * w.happy - 0.8 * w.work
  const top = 1.2 - 0.8 * open
  const bot = 2.8 + 13 * open
  const my = 16.5
  const cy0 = my - 0.8 - 0.6 * w.happy
  R.mouth = `M${n2(-mw)} ${n2(cy0)}Q0 ${n2(my + top)} ${n2(mw)} ${n2(cy0)}Q0 ${n2(my + bot)} ${n2(-mw)} ${n2(cy0)}Z`
  R.tongueCy = n2(my + bot / 2 - 0.2)
  R.tongueRx = n2(mw * 0.62)
  R.tongueRy = n2(1 + 3.4 * open)
  R.tongueO = n2(clamp01(open * 3))
  R.open = n2(open)

  const sway = 5 * S(1.3, t, ph)
  const gest = 13 * S(4.1, t, ph) * w.talk
  const up = 52 * w.happy * (0.6 + 0.4 * hop) + 10 * w.listen
  R.armL = n2(38 + sway + gest + up)
  R.armR = n2(-38 - sway + gest * 0.6 - up + (acc === 'trumpet' ? 26 : 0))

  const lagBob = -S(TAU * bobF, t - 0.22, ph) * bobA
  const ringY =
    80 + ring + lagBob - 9 * Math.abs(S(Math.PI * 2.1, t - 0.08, ph)) * w.happy - 2.5 * S(1.1, t, ph2)
  const ringX = bx + Math.sin((lean * Math.PI) / 180) * ring * -1 + 1.2 * S(0.9, t, ph)
  const ringS = 1 + 0.05 * breathe * w.work + 0.04 * w.listen
  const ringTilt = 4 * S(0.8, t, ph2) + lean * 0.5
  R.ringT = `${n2(ringX)} ${n2(ringY)}`
  R.ringR = n2(ringTilt)
  R.ringS = n3(ringS)
  const bright = blend(w, { idle: 0.75, talk: 0.85, listen: 1, work: 0.55 + 0.45 * breathe, happy: 1 })
  R.glowO = n2(clamp01(bright))
  R.glowW = n2(6 + 4 * w.listen + 3 * breathe * w.work)
  const [dk] = snap(4.2)
  for (let i = 0; i < 3; i++) {
    const a = t * dk - i * 0.42
    R['dx' + i] = n2(27 * Math.cos(a))
    R['dy' + i] = n2(6.8 * Math.sin(a))
  }

  if (acc === 'wings') {
    const flapF = blend(w, { idle: 1.1, talk: 1.6, listen: 0.8, work: 4.6, happy: 3 })
    const flapA = blend(w, { idle: 9, talk: 11, listen: 6, work: 20, happy: 18 })
    R.flap = n2(S(TAU * flapF, t, ph) * flapA)
  }
  if (acc === 'quill') R.quill = `${n2(3 * S(1.1, t, ph) + 6 * S(17, t, 0) * w.work + 4 * w.happy * hop)} 30 -14`
  if (acc === 'trumpet') {
    R.trumpet = n2(-34 + 3 * S(1.2, t, ph) - 6 * w.talk + 2.5 * m - 8 * w.happy * hop)
    const blast = Math.max(w.talk, w.happy * 0.8)
    const nr = Math.max(1, Math.round(1.6 * LOOP)) / LOOP
    for (let i = 1; i <= 3; i++) {
      const p = (t * nr + i / 3) % 1
      R['nO' + i] = n2(blast * Math.sin(Math.PI * p))
      R['nX' + i] = `${n2(p * 2)} 0` // the film travels 5; shorter here to stay in the box
    }
  }
  if (acc === 'plane') {
    const sp = blend(w, { idle: 1.1, talk: 1.6, listen: 0.9, work: 3.2, happy: 2.4 })
    // The film flies the plane at bx+60; here it flies a little closer so it stays in the box.
    const pos = (u: number): [number, number] => [
      bx + 54 + 9 * S(sp, u, ph) + 4 * w.work * C(sp * 2, u, 0),
      by - 42 + 6 * S(sp * 2, u, ph) - 6 * w.happy * hop,
    ]
    const [px, py] = pos(t)
    const [qx, qy] = pos(t - 0.05)
    const head = (Math.atan2(py - qy, Math.abs(px - qx) + 0.4) * 180) / Math.PI
    const ang = Math.max(-30, Math.min(30, head)) * 0.6 - 8
    R.planeT = `${n2(px)} ${n2(py)}`
    R.planeR = n2(ang)
    let tr = ''
    for (let i = 1; i <= 14; i++) {
      const [ax, ay] = pos(t - i * 0.07)
      tr += (i === 1 ? 'M' : 'L') + n2(ax - 12) + ' ' + n2(ay + 2)
    }
    R.trail = tr
  }
  return R
}

/* ---------- markup ---------- */

const REP = `dur="${LOOP}s" repeatCount="indefinite"`

// A static attribute plus, when the value moves across the loop, its SMIL keyframes.
function att(F: Rec[], key: string, attr: string): [string, string] {
  const v = F.map(f => f[key] ?? '')
  const st = ` ${attr}="${v[0] ?? ''}"`
  if (v.every(x => x === v[0])) return [st, '']
  return [st, `<animate attributeName="${attr}" values="${v.join(';')}" ${REP}/>`]
}
function tf(F: Rec[], key: string, type: string): [string, string] {
  const v = F.map(f => f[key] ?? '')
  const st = ` transform="${type}(${v[0] ?? ''})"`
  if (v.every(x => x === v[0])) return [st, '']
  return [st, `<animateTransform attributeName="transform" type="${type}" values="${v.join(';')}" ${REP}/>`]
}
// <tag a>{anim}{inner}</tag> for a transform key
function g(F: Rec[], key: string, type: string, inner: string): string {
  const [a, k] = tf(F, key, type)
  return `<g${a}>${k}${inner}</g>`
}

function accBack(acc: Acc, id: string, c: string, c2: string, lod: number, F: Rec[]): string {
  if (acc === 'quill') {
    const vane = mix('#ffffff', c, 0.18)
    const body = `<g transform="translate(30 -14)">
<path d="M0 6L0-78" stroke="${mix(c2, '#ffffff', 0.35)}" stroke-width="${lod ? 2.2 : 3}" stroke-linecap="round"/>
<path d="M0-84C16-70 20-40 7-14L1-8C-12-26-14-60 0-84Z" fill="url(#qv-${id})" stroke="${c2}" stroke-opacity=".85" stroke-width="${lod ? 1.3 : 2.4}" stroke-linejoin="round"/>
${lod ? `<path d="M0-76L0-12" stroke="${mix(c, c2, 0.5)}" stroke-width="1.3" stroke-linecap="round" opacity=".7"/>
<path d="M1-58L10-61M1-46L12-49M1-34L11-36M0-52L-9-56M0-40L-10-43M0-28L-8-30" stroke="${mix(c, c2, 0.3)}" stroke-width="1.1" stroke-linecap="round" opacity=".55"/>
<path d="M11-40l5-2M-11-46l-4-3" stroke="${vane}" stroke-width="2" stroke-linecap="round"/>` : `<path d="M0-74L0-16" stroke="${mix(c, c2, 0.4)}" stroke-width="2" stroke-linecap="round" opacity=".6"/>`}
</g>`
    // The film tilts the quill 26 degrees; 30 keeps its tip inside the box.
    return g(F, 'quill', 'rotate', `<g transform="rotate(30 30 -14)">${body}</g>`)
  }
  if (acc === 'wings') {
    const wing = `<path d="M0 0C-4-18-22-32-44-31C-53-30-56-21-48-17C-55-13-53-4-44-5C-49 1-44 8-35 5C-36 12-27 14-20 9C-12 10-5 6 0 0Z" fill="url(#wg-${id})" stroke="${mix(c, c2, 0.25)}" stroke-opacity=".75" stroke-width="${lod ? 1.3 : 2}" stroke-linejoin="round"/>${
      lod
        ? `<path d="M-8-6C-20-16-32-21-44-20M-8-2C-18-6-28-7-38-4M-8 1C-14 3-20 4-26 4" stroke="${mix(c, c2, 0.2)}" stroke-width="1.1" fill="none" opacity=".5" stroke-linecap="round"/><path d="M-12-18C-22-26-32-28-40-27" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" opacity=".9"/>`
        : ''
    }`
    const def = `<g id="wn-${id}" transform="scale(.82)">${wing}</g>`
    return `<g transform="translate(-38 -8)">${g(F, 'flap', 'rotate', def)}</g><g transform="translate(38 -8) scale(-1 1)">${g(F, 'flap', 'rotate', `<use href="#wn-${id}"/>`)}</g>`
  }
  return ''
}

function accFront(acc: Acc, id: string, c: string, c2: string, lod: number, F: Rec[]): string {
  if (acc === 'headphones') {
    const cream = '#fbf7ef'
    const shade = '#d9cdb8'
    const cup = (x: number) => `<g transform="translate(${x} -4)">
<rect x="-8.5" y="-17" width="17" height="34" rx="8.5" fill="url(#hp-${id})" stroke="${shade}" stroke-width="${lod ? 1 : 1.4}"/>
<rect x="${x < 0 ? 3 : -8}" y="-13" width="5" height="26" rx="2.5" fill="${mix(c2, '#000000', 0.15)}" opacity=".8"/>
${lod ? `<ellipse cx="${x < 0 ? -2.5 : 2.5}" cy="-7" rx="2.6" ry="5" fill="#fff" opacity=".85"/>` : ''}
<circle cx="${x < 0 ? -1 : 1}" cy="6" r="2.6" fill="${c}" opacity=".9"/></g>`
    return `<g>
<path d="M-50.5-20A56 56 0 0 1 50.5-20" fill="none" stroke="${shade}" stroke-width="${lod ? 9.5 : 11}" stroke-linecap="round"/>
<path d="M-50.5-20A56 56 0 0 1 50.5-20" fill="none" stroke="${cream}" stroke-width="${lod ? 7 : 8}" stroke-linecap="round"/>
${lod ? `<path d="M-33-41A54 54 0 0 1 8-51.5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" opacity=".95"/>` : ''}
<path d="M-47 14C-45 30-34 37-20 34" fill="none" stroke="${shade}" stroke-width="${lod ? 3.2 : 4.2}" stroke-linecap="round"/>
<path d="M-47 14C-45 30-34 37-20 34" fill="none" stroke="${cream}" stroke-width="${lod ? 1.8 : 2.6}" stroke-linecap="round"/>
<circle cx="-18" cy="33.6" r="${lod ? 3.6 : 4.4}" fill="${mix(c2, '#000000', 0.25)}"/>
${lod ? `<circle cx="-19" cy="32.4" r="1.2" fill="#fff" opacity=".6"/>` : ''}
${cup(-50)}${cup(50)}</g>`
  }
  if (acc === 'trumpet') {
    const horn = `<g transform="translate(-6 0) scale(1.15)">
<path d="M6 3L24 3L24 17L15 12.5L6 17Z" fill="#e11d48" stroke="#9f1239" stroke-width=".9" stroke-linejoin="round"/>
<path d="M15 6.5l1.1 2.2 2.4.3-1.8 1.6.5 2.4-2.2-1.2-2.2 1.2.5-2.4-1.8-1.6 2.4-.3Z" fill="#ffe08a"/>
<rect x="0" y="-2.6" width="30" height="5.2" rx="2.6" fill="url(#tr-${id})" stroke="#6f7a90" stroke-width="1"/>
<path d="M27-2.6L44-11Q48 0 44 11L27 2.6Z" fill="url(#tr-${id})" stroke="#6f7a90" stroke-width="1" stroke-linejoin="round"/>
<ellipse cx="44.5" cy="0" rx="2.6" ry="10.8" fill="#8f99ad"/>
<circle cx="-1" cy="0" r="3.2" fill="url(#tr-${id})" stroke="#6f7a90" stroke-width="1"/></g>`
    let notes = ''
    if (lod) {
      const NP = ['M48-7Q51 0 48 7', 'M53-11Q57 0 53 11', 'M58-15Q63 0 58 15']
      for (let i = 1; i <= 3; i++) {
        const [o, ok] = att(F, 'nO' + i, 'opacity')
        const [x, xk] = tf(F, 'nX' + i, 'translate')
        notes += `<path d="${NP[i - 1]}"${o}${x}>${ok}${xk}</path>`
      }
      // 6 units nearer the bell than the film, so the sound arcs stay in the box
      notes = `<g transform="translate(-6 0)" fill="none" stroke="${c2}" stroke-linecap="round" stroke-width="2.4">${notes}</g>`
    }
    return `<g transform="translate(34 26)">${g(F, 'trumpet', 'rotate', horn + notes)}</g>`
  }
  return ''
}

function accFace(acc: Acc, lod: number): string {
  if (acc !== 'glasses') return ''
  const fr = '#e4b24a'
  const fd = '#a8761a'
  const lens = (x: number) => `<circle cx="${x}" cy="3" r="12.6" fill="#fff" fill-opacity=".14" stroke="${fd}" stroke-width="${lod ? 3.4 : 4.4}"/>
<circle cx="${x}" cy="3" r="12.6" fill="none" stroke="${fr}" stroke-width="${lod ? 2 : 2.8}"/>
${lod ? `<path d="M${x - 7}-4L${x - 2}-9" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".75"/>` : ''}`
  return `<g><path d="M-27.6 1L-44-5M27.6 1L44-5" stroke="${fd}" stroke-width="${lod ? 2.4 : 3}" stroke-linecap="round"/>
${lens(-15)}${lens(15)}<path d="M-3 0Q0-3.4 3 0" fill="none" stroke="${fr}" stroke-width="2.4" stroke-linecap="round"/></g>`
}

function accFree(acc: Acc, id: string, c: string, c2: string, lod: number, F: Rec[]): string {
  if (acc !== 'plane') return ''
  let trail = ''
  if (lod) {
    const [d, dk] = att(F, 'trail', 'd')
    trail = `<path fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="0.1 5" opacity=".9"${d}>${dk}</path>`
  }
  const plane = `<g transform="scale(${lod ? 1.15 : 1.3})">
<g filter="url(#sh-${id})" opacity=".35"><path d="M16 2L-13-8L-5 3L-9 11Z" fill="${c2}"/></g>
<path d="M15 0L-13-10L-5 1Z" fill="#fff" stroke="${c2}" stroke-width="${lod ? 1 : 1.5}" stroke-linejoin="round"/>
<path d="M15 0L-5 1L-9 9Z" fill="${mix('#ffffff', c, 0.35)}" stroke="${c2}" stroke-width="${lod ? 1 : 1.5}" stroke-linejoin="round"/>
<path d="M15 0L-5 1L-2 4.5Z" fill="${mix(c, c2, 0.3)}" stroke="${c2}" stroke-width=".8" stroke-linejoin="round"/></g>`
  return trail + g(F, 'planeT', 'translate', g(F, 'planeR', 'rotate', plane))
}

function blinkAnim(ph: number): string {
  // One blink per loop at a seeded moment: 70 ms to shut, 130 ms to open, like the film.
  const tb = 0.45 + ((ph / TAU) % 1) * (LOOP - 0.9)
  const k = (v: number) => n3(v / LOOP)
  return `<animateTransform attributeName="transform" type="scale" values="1 1;1 1;1 .1;1 1;1 1" keyTimes="0;${k(tb - 0.07)};${k(tb)};${k(tb + 0.13)};1" ${REP}/>`
}

export function godSvg(
  kind: GodKind,
  opts: { size?: number; state?: GodState; animated?: boolean; halo?: boolean } = {},
): string {
  const def = CAST[kind] ?? CAST.colleague
  const { c, c2, acc } = def
  const size = Math.max(8, Math.round(opts.size ?? 40))
  const state: GodState = opts.state && STATES.includes(opts.state) ? opts.state : 'idle'
  const animated = !!opts.animated
  const halo = opts.halo !== false
  const sphere = (size * 100) / VB_SIZE
  const lod: 0 | 1 = sphere < 60 ? 0 : 1
  const id = `cg-${kind}-${state}-${lod}${animated ? 'a' : 's'}${halo ? 'h' : ''}`
  const dark = '#17142b'
  const eyeHi = mix(dark, c2, 0.35)

  const w = { idle: 0, talk: 0, listen: 0, work: 0, happy: 0 }
  w[state] = 1
  const h = hash(kind)
  const ph = ((h % 1000) / 1000) * TAU
  const ph2 = (((h >>> 10) % 1000) / 1000) * TAU
  const K: Ctx = { w, acc, ring: acc === 'headphones' ? -73 : def.ring, ph, ph2, lod }

  // Frames: the whole loop when animated, else one representative still.
  let F: Rec[]
  if (animated) {
    F = []
    for (let i = 0; i <= STEPS; i++) F.push(pose(K, (i * LOOP) / STEPS, false))
  } else {
    const pick = { idle: 0.1, talk: 0, listen: 0.6, work: 0.35, happy: 0 }[state]
    let t = pick
    if (state === 'talk' || state === 'happy') {
      // a frame with the mouth well open / mid-hop, chosen from the loop
      let best = 0
      let bestD = 9
      for (let i = 0; i < STEPS; i++) {
        const tt = (i * LOOP) / STEPS
        const P = pose(K, tt, true)
        const d = state === 'talk' ? Math.abs(+(P.open ?? 0) - 0.62) : Math.abs(+(P.armL ?? 0) - 120)
        if (d < bestD) {
          bestD = d
          best = tt
        }
      }
      t = best
    }
    F = [pose(K, t, true)]
  }

  const arm = (s: 'L' | 'R') =>
    `<g transform="translate(${s === 'L' ? -44 : 44} 22)">${g(F, 'arm' + s, 'rotate', `<ellipse rx="9" ry="13" fill="url(#am-${id})"/>`)}</g>`

  // eyes, or the closed happy arcs
  let eyes = ''
  if (state === 'happy') {
    for (const x of [-15, 15]) {
      eyes += `<path transform="translate(${x} 3) scale(${F[0]?.hapS ?? 1})" d="M-5.8 2Q0-6.5 5.8 2" fill="none" stroke="${dark}" stroke-width="${lod ? 3.1 : 3.8}" stroke-linecap="round"/>`
    }
  } else {
    const eye = `<ellipse rx="5.7" ry="7.6" fill="url(#ey-${id})"/><circle cx="-1.9" cy="-3.2" r="${lod ? 2.1 : 2.5}" fill="#fff"/>${lod ? `<circle cx="2" cy="2.8" r="1" fill="#fff" opacity=".8"/>` : ''}`
    const [es] = tf(F, 'eyeS', 'scale')
    const blink = animated ? blinkAnim(ph) : ''
    for (const n of ['L', 'R']) {
      eyes += g(F, 'eye' + n, 'translate', `<g${es}><g>${blink}${n === 'L' ? `<g id="ee-${id}">${eye}</g>` : `<use href="#ee-${id}"/>`}</g></g>`)
    }
  }

  const [mouthD, mouthK] = att(F, 'mouth', 'd')
  const tongue = (() => {
    const parts = [att(F, 'tongueCy', 'cy'), att(F, 'tongueRx', 'rx'), att(F, 'tongueRy', 'ry'), att(F, 'tongueO', 'opacity')]
    if (F.every(f => f.tongueO === '0')) return ''
    return `<ellipse cx="0" fill="#ff7d9b" clip-path="url(#mk-${id})"${parts.map(p => p[0]).join('')}>${parts.map(p => p[1]).join('')}</ellipse>`
  })()
  const [blushO] = att(F, 'blush', 'opacity')
  const face = `${
    lod
      ? `<ellipse cx="-25" cy="15" rx="6.5" ry="3.6" fill="#ff6f9c" filter="url(#bl-${id})"${blushO}/><ellipse cx="25" cy="15" rx="6.5" ry="3.6" fill="#ff6f9c" filter="url(#bl-${id})"${blushO}/>`
      : `<g opacity="${n2(+(F[0]?.blush ?? 0.34) * 0.7)}"><ellipse cx="-27" cy="14" rx="7" ry="4" fill="#ff6f9c"/><ellipse cx="27" cy="14" rx="7" ry="4" fill="#ff6f9c"/></g>`
  }${eyes}<path fill="${dark}" stroke="${dark}" stroke-width="${lod ? 1.8 : 2.6}" stroke-linejoin="round" stroke-linecap="round"${mouthD}>${mouthK}</path>${tongue}${accFace(acc, lod)}`

  const [auraO, auraOk] = att(F, 'auraO', 'opacity')
  const [auraR, auraRk] = att(F, 'auraR', 'r')
  const body = `${accBack(acc, id, c, c2, lod, F)}${arm('L')}${arm('R')}
<circle r="50" fill="url(#bd-${id})"/>
<g clip-path="url(#ck-${id})"><g filter="url(#sw-${id})" opacity=".85">${g(
    F,
    'swirl',
    'rotate',
    `<ellipse cx="-18" cy="-12" rx="32" ry="17" fill="#fff" opacity=".42"/><ellipse cx="20" cy="15" rx="26" ry="14.5" fill="${c2}" opacity=".9"/><ellipse cx="-6" cy="24" rx="23" ry="11.5" fill="${c}" opacity=".9"/>`,
  )}</g>
<ellipse cx="0" cy="58" rx="40" ry="16" fill="${mix(c, '#ffffff', 0.35)}" opacity=".45" filter="url(#bl-${id})"/></g>
<ellipse cx="-15" cy="-27" rx="20" ry="9.4" fill="#fff" opacity=".38" transform="rotate(-18 -15 -27)"/>
${lod ? `<ellipse cx="-24" cy="-30" rx="5" ry="2.6" fill="#fff" opacity=".9" transform="rotate(-38 -24 -30)"/>` : `<ellipse cx="-24" cy="-30" rx="6" ry="3.2" fill="#fff" opacity=".75" transform="rotate(-38 -24 -30)"/>`}
<circle r="49.5" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="1"/>
${g(F, 'face', 'translate', face)}
${accFront(acc, id, c, c2, lod, F)}`

  let ringM = ''
  if (halo) {
    const [gO, gOk] = att(F, 'glowO', 'opacity')
    const [gW, gWk] = att(F, 'glowW', 'stroke-width')
    let dots = ''
    if (state === 'work') {
      for (let i = 0; i < 3; i++) {
        const [x, xk] = att(F, 'dx' + i, 'cx')
        const [y, yk] = att(F, 'dy' + i, 'cy')
        dots += `<circle r="${[1.8, 1.5, 1.2][i]}"${x}${y}>${xk}${yk}</circle>`
      }
      dots = `<g fill="#fff3c2">${dots}</g>`
    }
    const glint = animated
      ? `<path d="M-27 0A27 6.8 0 0 0 27 0" pathLength="100" fill="none" stroke="#fffdf0" stroke-width="${lod ? 1.7 : 2.4}" stroke-linecap="round" stroke-dasharray="16 200" stroke-dashoffset="16" opacity="0"><animate attributeName="stroke-dashoffset" values="16;-100;-100" keyTimes="0;.42;1" ${REP}/><animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;.06;.34;.42;1" ${REP}/></path>`
      : ''
    const inner = `<ellipse rx="27" ry="6.8" fill="none" stroke="#ffcf4d" filter="url(#rgl-${id})"${gO}${gW}>${gOk}${gWk}</ellipse>
<ellipse rx="27" ry="6.8" fill="none" stroke="#a87208" stroke-opacity=".55" stroke-width="${lod ? 4.4 : 6}"/>
<ellipse rx="27" ry="6.8" fill="none" stroke="url(#rg-${id})" stroke-width="${lod ? 3.2 : 4.6}"/>
${lod ? `<path d="M-19 4.9Q0 8.4 19 4.9" fill="none" stroke="#fffbe8" stroke-width="1.2" stroke-linecap="round" opacity=".9"/>` : ''}${glint}${dots}`
    ringM = g(F, 'ringT', 'translate', g(F, 'ringR', 'rotate', g(F, 'ringS', 'scale', inner)))
  }

  const defs = `<defs>
<radialGradient id="au-${id}" cx="50%" cy="50%" r="50%"><stop offset="50%" stop-color="${c}" stop-opacity=".9"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient>
<radialGradient id="bd-${id}" cx="40%" cy="33%" r="72%"><stop offset="0%" stop-color="#fff" stop-opacity=".95"/><stop offset="34%" stop-color="${c}"/><stop offset="100%" stop-color="${c2}"/></radialGradient>
<linearGradient id="am-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${c}"/><stop offset="100%" stop-color="${c2}"/></linearGradient>
<radialGradient id="ey-${id}" cx="45%" cy="30%" r="75%"><stop offset="0%" stop-color="${eyeHi}"/><stop offset="70%" stop-color="${dark}"/></radialGradient>
<linearGradient id="rg-${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#c0840a"/><stop offset="30%" stop-color="#f7cf5c"/><stop offset="48%" stop-color="#fff6d2"/><stop offset="66%" stop-color="#f3c24a"/><stop offset="100%" stop-color="#b47a08"/></linearGradient>
${acc === 'headphones' ? `<linearGradient id="hp-${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#fff"/><stop offset="100%" stop-color="#e8dfcf"/></linearGradient>` : ''}
${acc === 'trumpet' ? `<linearGradient id="tr-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#fff"/><stop offset="55%" stop-color="#dfe5ef"/><stop offset="100%" stop-color="#aab3c4"/></linearGradient>` : ''}
${acc === 'quill' ? `<linearGradient id="qv-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#fff"/><stop offset="65%" stop-color="${mix('#ffffff', c, 0.25)}"/><stop offset="100%" stop-color="${c}"/></linearGradient>` : ''}
${acc === 'wings' ? `<linearGradient id="wg-${id}" x1="1" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="${mix('#ffffff', c, 0.5)}"/><stop offset="45%" stop-color="#fff"/><stop offset="100%" stop-color="#fbfdf5"/></linearGradient>` : ''}
<filter id="sw-${id}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6.5"/></filter>
<filter id="bl-${id}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.6"/></filter>
<filter id="rgl-${id}" x="-30%" y="-150%" width="160%" height="400%"><feGaussianBlur stdDeviation="2.8"/></filter>
${acc === 'plane' ? `<filter id="sh-${id}" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="3"/></filter>` : ''}
<clipPath id="ck-${id}"><circle r="50"/></clipPath>
<clipPath id="mk-${id}"><path${mouthD}>${mouthK}</path></clipPath>
</defs>`

  const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB_X} ${VB_Y} ${VB_SIZE} ${VB_SIZE}" width="${size}" height="${size}">
${defs}
${g(F, 'bodyT', 'translate', `<circle fill="url(#au-${id})"${auraR}${auraO}>${auraRk}${auraOk}</circle>${g(F, 'bodyR', 'rotate', g(F, 'bodyS', 'scale', body))}`)}
${ringM}
${accFree(acc, id, c, c2, lod, F)}
</svg>`
  return out.replace(/\n\s*\n/g, '\n')
}
