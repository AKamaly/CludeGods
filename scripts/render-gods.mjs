#!/usr/bin/env node
// render-gods.mjs: render the gods (art/gods.js) into sprite strips for the native call pill.
//
//   node scripts/render-gods.mjs [--out DIR] [--kinds a,b] [--states x,y] [--frame 256]
//                                [--frames 24] [--fps 12] [--box 2.048] [--lossless]
//
// For each kind and state it writes <kind>-<state>.png, a horizontal strip of `frames` square
// frames of `frame` px (a seamless loop of frames/fps seconds, transparent background, the
// sphere centred, the frame `box` times the sphere's diameter), plus index.json describing them.
// box 2.048 (a 125 px sphere in a 256 px frame) is the smallest centred frame that holds every
// god whole through its loop: the colleague's halo glow rises a full diameter above the centre
// when happy, the herald's notes reach 0.96 to the right. At 1.6 the colleague's halo and the
// paper plane are cut off. The script reports any frame where the art touches the edge.
// Default --out is skills/colleague/bin/gods in this repo; the live copy the pill reads is
// ~/.claude/skills/colleague/bin/gods.
//
// Needs puppeteer-core and a Chrome. Chrome: $CHROME_PATH or $PUPPETEER_EXECUTABLE_PATH, else the
// newest chrome-headless-shell under ~/.cache/puppeteer (`npx @puppeteer/browsers install
// chrome-headless-shell@stable --path ~/.cache/puppeteer`). puppeteer-core: resolved from this repo, the current folder,
// or $PUPPETEER_CORE_PATH (a node_modules folder that contains it).
// Size: strips are quantised to 256-colour PNGs (about 200 KB each, against about 1 MB lossless)
// by the small built-in quantiser below, with no extra dependencies. It is deterministic and
// uses ordered dithering, which stays still between frames; pngquant's default error diffusion
// would shimmer across the loop. --lossless keeps full RGBA.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const GODS_JS = path.join(ROOT, 'art', 'gods.js')
const KINDS = ['colleague', 'research', 'scribe', 'scout', 'sales', 'herald']
const STATES = ['idle', 'talk', 'listen', 'work', 'happy']
const DITHER = 0.5 // see quantise()

function args() {
  const a = process.argv.slice(2)
  const o = { out: path.join(ROOT, 'skills', 'colleague', 'bin', 'gods'), kinds: KINDS, states: STATES, frame: 256, frames: 24, fps: 12, box: 2.048 }
  for (let i = 0; i < a.length; i++) {
    const k = a[i]
    const v = a[i + 1]
    if (k === '--out') (o.out = v.replace(/^~(?=\/|$)/, os.homedir())), i++
    else if (k === '--kinds') (o.kinds = v.split(',')), i++
    else if (k === '--states') (o.states = v.split(',')), i++
    else if (['--frame', '--frames', '--fps', '--box'].includes(k)) (o[k.slice(2)] = +v), i++
    else if (k === '--lossless') o.lossless = true
    else if (k === '-h' || k === '--help') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0])
      process.exit(0)
    } else throw new Error(`unknown argument ${k}`)
  }
  for (const k of o.kinds) if (!KINDS.includes(k)) throw new Error(`unknown kind ${k}`)
  for (const s of o.states) if (!STATES.includes(s)) throw new Error(`unknown state ${s}`)
  return o
}

function loadPuppeteer() {
  const req = createRequire(import.meta.url)
  const bases = [process.env.PUPPETEER_CORE_PATH, ROOT, process.cwd()].filter(Boolean)
  for (const b of bases) {
    try {
      return req(req.resolve('puppeteer-core', { paths: [b] }))
    } catch {}
  }
  throw new Error('puppeteer-core not found: npm i --no-save puppeteer-core in this repo, or set PUPPETEER_CORE_PATH to a node_modules folder that has it')
}

function findChrome() {
  const env = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH
  if (env) return env
  const cache = path.join(os.homedir(), '.cache', 'puppeteer')
  const newest = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).sort((x, y) => x.localeCompare(y, 'en', { numeric: true })).reverse() : [])
  for (const v of newest(path.join(cache, 'chrome-headless-shell'))) {
    const d = path.join(cache, 'chrome-headless-shell', v)
    for (const sub of fs.readdirSync(d)) {
      const exe = path.join(d, sub, 'chrome-headless-shell')
      if (fs.existsSync(exe)) return exe
    }
  }
  for (const v of newest(path.join(cache, 'chrome'))) {
    const d = path.join(cache, 'chrome', v)
    for (const sub of fs.readdirSync(d)) {
      for (const exe of [
        path.join(d, sub, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(d, sub, 'chrome'),
      ])
        if (fs.existsSync(exe)) return exe
    }
  }
  throw new Error('no Chrome found: set CHROME_PATH, or run npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer')
}

/* ---------- PNG in and out (8-bit, non-interlaced) ---------- */

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

// Decodes Chrome's screenshot PNG to { w, h, px: RGBA Uint8Array }.
function decodePng(buf) {
  let p = 8
  let w = 0
  let h = 0
  let ct = 0
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG (need 8-bit, non-interlaced)')
      ct = data[9]
    } else if (type === 'IDAT') idat.push(data)
    p += 12 + len
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0
  if (!bpp) throw new Error(`unsupported PNG colour type ${ct}`)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const out = new Uint8Array(w * h * bpp)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0
      const b = y ? out[dst - stride + x] : 0
      const c = y && x >= bpp ? out[dst - stride + x - bpp] : 0
      let v = raw[src + x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[dst + x] = v & 255
    }
  }
  if (bpp === 4) return { w, h, px: out }
  const px = new Uint8Array(w * h * 4)
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) (px[j] = out[i]), (px[j + 1] = out[i + 1]), (px[j + 2] = out[i + 2]), (px[j + 3] = 255)
  return { w, h, px }
}
function ihdr(w, h, colourType) {
  const b = Buffer.alloc(13)
  b.writeUInt32BE(w, 0)
  b.writeUInt32BE(h, 4)
  b[8] = 8
  b[9] = colourType
  return chunk('IHDR', b)
}
function encodeIndexed(w, h, idx, pal) {
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) raw.set(idx.subarray(y * w, y * w + w), y * (w + 1) + 1)
  const plte = Buffer.alloc(pal.length * 3)
  pal.forEach((c, i) => plte.set([c[0], c[1], c[2]], i * 3))
  let n = pal.length
  while (n > 0 && pal[n - 1][3] === 255) n--
  const trns = Buffer.from(pal.slice(0, n).map(c => c[3]))
  return Buffer.concat([
    SIG,
    ihdr(w, h, 3),
    chunk('PLTE', plte),
    chunk('tRNS', trns),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9, memLevel: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---------- built-in quantiser: median cut + k-means in premultiplied RGBA ---------- */

// Reduces RGBA pixels (w wide) to a 256-colour palette with index 0 fully transparent. Colours
// are compared premultiplied, so faint glow pixels do not crowd out the sphere's shading.
// `dither` (0..1) is ordered (Bayer) dithering: it hides banding on the glossy gradients and,
// unlike error diffusion, stays still from frame to frame wherever the art does.
const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21]
function quantise(px, w, { colours = 256, dither = 0, iterations = 6 } = {}) {
  const n = px.length / 4
  // histogram on 6 bits per channel, keeping exact sums for the means
  const map = new Map()
  for (let i = 0; i < n; i++) {
    const a = px[i * 4 + 3]
    if (a < 3) continue
    const r = (px[i * 4] * a) / 255
    const g = (px[i * 4 + 1] * a) / 255
    const b = (px[i * 4 + 2] * a) / 255
    const key = ((r >> 2) << 18) | ((g >> 2) << 12) | ((b >> 2) << 6) | (a >> 2)
    let e = map.get(key)
    if (!e) map.set(key, (e = [0, 0, 0, 0, 0]))
    e[0] += r
    e[1] += g
    e[2] += b
    e[3] += a
    e[4]++
  }
  const B = [...map.values()].map(e => [e[0] / e[4], e[1] / e[4], e[2] / e[4], e[3] / e[4], e[4]])
  const want = Math.min(colours - 1, B.length) // index 0 is fully transparent
  const stats = box => {
    let c = 0
    const s = [0, 0, 0, 0]
    const q = [0, 0, 0, 0]
    for (const e of box) {
      c += e[4]
      for (let k = 0; k < 4; k++) (s[k] += e[k] * e[4]), (q[k] += e[k] * e[k] * e[4])
    }
    const v = s.map((x, k) => q[k] - (x * x) / c)
    return { c, mean: s.map(x => x / c), v, err: v[0] + v[1] + v[2] + v[3] }
  }
  const boxes = [{ items: B, ...stats(B) }]
  while (boxes.length < want) {
    let bi = -1
    for (let i = 0; i < boxes.length; i++) if (boxes[i].items.length > 1 && (bi < 0 || boxes[i].err > boxes[bi].err)) bi = i
    if (bi < 0) break
    const bx = boxes[bi]
    const ch = bx.v.indexOf(Math.max(...bx.v))
    const items = bx.items.sort((x, y) => x[ch] - y[ch])
    let cut = 1
    for (let acc = 0; cut < items.length - 1; cut++) if ((acc += items[cut - 1][4]) >= bx.c / 2) break
    const L = items.slice(0, cut)
    const R = items.slice(cut)
    boxes.splice(bi, 1, { items: L, ...stats(L) }, { items: R, ...stats(R) })
  }
  let pal = boxes.map(b => b.mean)
  const near = (r, g, b, a, P) => {
    let best = 0
    let bd = Infinity
    for (let j = 0; j < P.length; j++) {
      const p = P[j]
      const d = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2 + (a - p[3]) ** 2
      if (d < bd) (bd = d), (best = j)
    }
    return best
  }
  for (let it = 0; it < iterations; it++) {
    const acc = pal.map(() => [0, 0, 0, 0, 0])
    for (const e of B) {
      const s = acc[near(e[0], e[1], e[2], e[3], pal)]
      for (let k = 0; k < 4; k++) s[k] += e[k] * e[4]
      s[4] += e[4]
    }
    pal = acc.map((s, j) => (s[4] ? [s[0] / s[4], s[1] / s[4], s[2] / s[4], s[3] / s[4]] : pal[j]))
  }
  // straight-alpha palette, index 0 transparent
  const out = [[0, 0, 0, 0]].concat(
    pal.map(p => {
      const a = Math.max(1, Math.min(255, Math.round(p[3])))
      return [Math.min(255, Math.round((p[0] * 255) / a)), Math.min(255, Math.round((p[1] * 255) / a)), Math.min(255, Math.round((p[2] * 255) / a)), a]
    }),
  )
  const prem = out.map(c => [(c[0] * c[3]) / 255, (c[1] * c[3]) / 255, (c[2] * c[3]) / 255, c[3]])
  // ordered-dither amplitude per pixel: the typical gap between neighbouring palette colours
  let gap = 0
  if (dither > 0) {
    let sum = 0
    for (let j = 1; j < prem.length; j++) {
      let bd = Infinity
      for (let k = 1; k < prem.length; k++) {
        if (k === j) continue
        const d = (prem[j][0] - prem[k][0]) ** 2 + (prem[j][1] - prem[k][1]) ** 2 + (prem[j][2] - prem[k][2]) ** 2 + (prem[j][3] - prem[k][3]) ** 2
        if (d < bd) bd = d
      }
      sum += Math.sqrt(bd)
    }
    gap = (sum / Math.max(1, prem.length - 1)) * dither
  }
  const idx = new Uint8Array(n)
  const cache = new Map()
  for (let i = 0; i < n; i++) {
    const a = px[i * 4 + 3]
    if (a < 3) continue
    const o = gap ? (BAYER[((((i / w) | 0) & 7) << 3) | ((i % w) & 7)] / 64 - 0.5) * gap : 0
    const r = Math.round((px[i * 4] * a) / 255 + o)
    const g = Math.round((px[i * 4 + 1] * a) / 255 + o)
    const b = Math.round((px[i * 4 + 2] * a) / 255 + o)
    const key = ((r & 1023) * 1024 + (g & 1023)) * 1048576 + (b & 1023) * 1024 + a
    let j = cache.get(key)
    if (j === undefined) cache.set(key, (j = near(r, g, b, a, prem)))
    idx[i] = j
  }
  return { idx, pal: out }
}

/* ---------- checks ---------- */

// Mean absolute RGBA difference between two frames of a strip.
function frameDiff(px, W, F, i, j) {
  let s = 0
  for (let y = 0; y < F; y++)
    for (let x = 0; x < F; x++) {
      const a = (y * W + i * F + x) * 4
      const b = (y * W + j * F + x) * 4
      for (let k = 0; k < 4; k++) s += Math.abs(px[a + k] - px[b + k])
    }
  return s / (F * F * 4)
}
// Visible pixels (alpha > 24) in the outer 2 px of any frame: the art touching the edge.
function edgeHits(px, W, F, frames) {
  let hits = 0
  for (let f = 0; f < frames; f++)
    for (let y = 0; y < F; y++)
      for (let x = 0; x < F; x++) {
        if (x > 1 && x < F - 2 && y > 1 && y < F - 2) continue
        if (px[(y * W + f * F + x) * 4 + 3] > 24) hits++
      }
  return hits
}

/* ---------- render ---------- */

async function main() {
  const o = args()
  const puppeteer = loadPuppeteer()
  const chrome = findChrome()
  if (!fs.existsSync(GODS_JS)) throw new Error(`missing ${GODS_JS}`)
  fs.mkdirSync(o.out, { recursive: true })
  const F = o.frame
  const N = o.frames
  const loop = N / o.fps
  const sphere = F / o.box
  const W = F * (N + 1) // one extra frame at t = loop, to prove the seam
  const quant = o.lossless ? 'none (lossless RGBA)' : `built-in, ordered dither ${DITHER}`
  console.log(`chrome ${chrome}\nframe ${F}px x ${N} at ${o.fps} fps (${loop}s loop), sphere ${sphere}px, quantiser ${quant}`)

  const browser = await puppeteer.launch({ executablePath: chrome, args: ['--hide-scrollbars', '--font-render-hinting=none'] })
  const page = await browser.newPage()
  await page.setViewport({ width: W, height: F, deviceScaleFactor: 1 })
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}
    .cell{position:absolute;top:0;overflow:hidden}</style></head><body></body></html>`)
  await page.addScriptTag({ path: GODS_JS })

  const report = []
  for (const kind of o.kinds)
    for (const state of o.states) {
      await page.evaluate(
        (kind, state, F, N, loop, sphere) => {
          document.body.innerHTML = ''
          for (let i = 0; i <= N; i++) {
            const cell = document.createElement('div')
            cell.className = 'cell'
            cell.style.cssText = `left:${i * F}px;width:${F}px;height:${F}px`
            document.body.appendChild(cell)
            const el = window.Gods.make(cell, kind, sphere)
            el._set((i * loop) / N, F / 2, F / 2, { state, shadow: 0, loop })
          }
        },
        kind,
        state,
        F,
        N,
        loop,
        sphere,
      )
      const shot = Buffer.from(await page.screenshot({ omitBackground: true, type: 'png', clip: { x: 0, y: 0, width: W, height: F } }))
      const img = decodePng(shot)
      // seam: frame N (t = loop) must equal frame 0; frame N-1 -> 0 must look like any other step
      const exact = frameDiff(img.px, W, F, N, 0)
      const steps = []
      for (let i = 0; i < N - 1; i++) steps.push(frameDiff(img.px, W, F, i, i + 1))
      const seam = frameDiff(img.px, W, F, N - 1, 0)
      steps.sort((a, b) => a - b)
      const med = steps[steps.length >> 1] || 1e-9
      const max = steps[steps.length - 1] || 1e-9
      const edge = edgeHits(img.px, W, F, N)
      // crop to N frames
      const strip = new Uint8Array(F * N * F * 4)
      for (let y = 0; y < F; y++) strip.set(img.px.subarray(y * W * 4, (y * W + F * N) * 4), y * F * N * 4)
      const file = path.join(o.out, `${kind}-${state}.png`)
      if (o.lossless) fs.writeFileSync(file, encodeRgba(F * N, F, strip))
      else {
        const { idx, pal } = quantise(strip, F * N, { dither: DITHER })
        fs.writeFileSync(file, encodeIndexed(F * N, F, idx, pal))
      }
      const kb = Math.round(fs.statSync(file).size / 1024)
      report.push({ kind, state, kb, exact, seam, med, max, edge })
      console.log(
        `${(kind + '-' + state).padEnd(17)} ${String(kb).padStart(4)} KB  t=${loop}s vs t=0 ${exact.toFixed(3)}  seam step ${seam.toFixed(2)} (other steps ${steps[0].toFixed(2)}..${max.toFixed(2)})  edge ${edge ? edge + ' px' : 'clear'}`,
      )
    }
  await browser.close()
  fs.writeFileSync(path.join(o.out, 'index.json'), JSON.stringify({ frame: F, frames: N, fps: o.fps, box: o.box }) + '\n')
  const worst = report.reduce((m, r) => Math.max(m, r.seam / r.max), 0)
  const edges = report.filter(r => r.edge).map(r => `${r.kind}-${r.state}`)
  console.log(
    `wrote ${report.length} strips + index.json to ${o.out}; largest ${Math.max(...report.map(r => r.kb))} KB, ` +
      `worst seam ${worst.toFixed(2)}x the largest other step, ${edges.length ? 'art touches the edge in ' + edges.join(' ') : 'no art at the edges'}`,
  )
}

// Full RGBA PNG, each row with the Sub filter (good for smooth gradients).
function encodeRgba(w, h, px) {
  const s = w * 4
  const raw = Buffer.alloc((s + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (s + 1)] = 1
    for (let x = 0; x < s; x++) raw[y * (s + 1) + 1 + x] = (px[y * s + x] - (x >= 4 ? px[y * s + x - 4] : 0)) & 255
  }
  return Buffer.concat([SIG, ihdr(w, h, 6), chunk('IDAT', zlib.deflateSync(raw, { level: 9, memLevel: 9 })), chunk('IEND', Buffer.alloc(0))])
}

export { decodePng, encodeIndexed, encodeRgba, quantise }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(e => {
    console.error(e.message || e)
    process.exit(1)
  })
