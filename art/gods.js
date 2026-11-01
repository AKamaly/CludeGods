/* CludeGods cast: "the gods". Deterministic, code-drawn characters built from the Workers pane
   orb (glossy sphere, white highlight to c to c2, three blurred bands turning inside, soft halo).
   Every pixel is a function of t: no CSS animations, no timers, no Math.random.

   window.Gods.make(parent, name, size) -> el   (box is 1.6*size square, el._w/_h set)
   el._set(t, cx, cy, { s, o, b, r, state, look, halo, shadow, loop })
     (cx, cy) is the centre of the body sphere. size is the sphere's diameter in px.
     state: 'idle' | 'talk' | 'listen' | 'work' | 'happy', or a weight map such as
            { idle: 0.3, talk: 0.7 } to cross-fade between states.
     look: [x, y] in -1..1.  halo: 0..1 ring opacity.  shadow: 0..1 floor shadow (default 1).
     loop: seconds (optional). Makes the motion repeat exactly every `loop` seconds, for
           sprites and other seamless loops: each periodic motion is snapped to a whole
           number of cycles per loop (a motion slower than one cycle keeps its speed by
           trading amplitude) and the blink happens once per loop. Without it the motion
           is the free-running original. The drawing is the same either way. */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const CAST = {
    colleague: { c: "#b9c6ff", c2: "#3d4aa0", acc: "headphones", ring: -76 },
    research: { c: "#a78bfa", c2: "#6d28d9", acc: "glasses", ring: -66 },
    scribe: { c: "#60a5fa", c2: "#2563eb", acc: "quill", ring: -66 },
    scout: { c: "#a3e635", c2: "#65a30d", acc: "wings", ring: -66 },
    sales: { c: "#fb923c", c2: "#ea580c", acc: "plane", ring: -66 },
    herald: { c: "#facc15", c2: "#ca8a04", acc: "trumpet", ring: -66 },
  };
  const STATES = ["idle", "talk", "listen", "work", "happy"];
  const TAU = Math.PI * 2;
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const f2 = v => (Math.abs(v) < 1e-4 ? 0 : +v.toFixed(3));

  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function prng(seed) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mix(a, b, k) { const A = hex(a), B = hex(b); return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, "0")).join(""); }

  /* Blinks: a seeded schedule, 2.6 to 4.3 s apart, sometimes doubled. Repeats every 600 s. */
  function blinkTable(name) {
    const r = prng(hash(name) ^ 0x9e3779b9), out = [];
    let tt = 0.4 + r() * 2.2;
    while (tt < 600) { out.push(tt); if (r() < 0.16) out.push(tt + 0.3); tt += 2.6 + r() * 1.7; }
    return out;
  }
  function blinkAt(table, t) {
    t = ((t % 600) + 600) % 600;
    let closed = 0;
    for (let i = 0; i < table.length; i++) {
      const d = t - table[i];
      if (d < -0.2) break;
      if (d < -0.07 || d > 0.13) continue;
      closed = Math.max(closed, d < 0 ? 1 + d / 0.07 : 1 - d / 0.13);
    }
    return closed; // 0 open, 1 shut
  }
  /* Speech: two syllable rates under a phrase envelope with real pauses. */
  function talkOpen(t, ph, S) {
    const a = 0.5 + 0.5 * S(TAU * 3.3, t, ph), b = 0.5 + 0.5 * S(TAU * 5.2, t, ph * 1.7);
    const env = clamp01(0.45 + 0.8 * S(TAU * 0.42, t, ph * 0.31));
    return clamp01(Math.pow(a * 0.68 + b * 0.32, 1.4) * env * 1.25);
  }
  function weights(state) {
    const w = { idle: 0, talk: 0, listen: 0, work: 0, happy: 0 };
    if (typeof state === "string") { w[state in w ? state : "idle"] = 1; return w; }
    let sum = 0;
    for (const k of STATES) { w[k] = Math.max(0, +(state && state[k]) || 0); sum += w[k]; }
    if (sum <= 0) { w.idle = 1; return w; }
    for (const k of STATES) w[k] /= sum;
    return w;
  }
  const blend = (w, P) => STATES.reduce((s, k) => s + w[k] * P[k], 0);

  /* ---------- accessories (body-local units: sphere radius 50, centre 0,0) ---------- */
  function accBack(acc, id, c, c2, lod) {
    if (acc === "quill") {
      const vane = mix("#ffffff", c, 0.18);
      return `<g data-k="quill"><g transform="translate(30 -14)">
        <path d="M0 6 L0 -78" stroke="${mix(c2, "#ffffff", 0.35)}" stroke-width="2.2" stroke-linecap="round"/>
        <path d="M0 -84 C16 -70 20 -40 7 -14 L1 -8 C-12 -26 -14 -60 0 -84 Z" fill="url(#qv-${id})" stroke="${c2}" stroke-opacity=".85" stroke-width="${lod ? 1.3 : 2}" stroke-linejoin="round"/>
        ${lod ? `<path d="M0 -76 L0 -12" stroke="${mix(c, c2, 0.5)}" stroke-width="1.3" stroke-linecap="round" opacity=".7"/>
        <path d="M1 -58 L10 -61 M1 -46 L12 -49 M1 -34 L11 -36 M0 -52 L-9 -56 M0 -40 L-10 -43 M0 -28 L-8 -30" stroke="${mix(c, c2, 0.3)}" stroke-width="1.1" stroke-linecap="round" opacity=".55"/>
        <path d="M11 -40 l5 -2 M-11 -46 l-4 -3" stroke="${vane}" stroke-width="2" stroke-linecap="round"/>` : ""}
      </g></g>`;
    }
    if (acc === "wings") {
      const wing = `<path d="M0 0 C-4 -18 -22 -32 -44 -31 C-53 -30 -56 -21 -48 -17 C-55 -13 -53 -4 -44 -5 C-49 1 -44 8 -35 5 C-36 12 -27 14 -20 9 C-12 10 -5 6 0 0 Z" fill="url(#wg-${id})" stroke="${mix(c, c2, 0.25)}" stroke-opacity=".75" stroke-width="1.3" stroke-linejoin="round"/>
        ${lod ? `<path d="M-8 -6 C-20 -16 -32 -21 -44 -20 M-8 -2 C-18 -6 -28 -7 -38 -4 M-8 1 C-14 3 -20 4 -26 4" stroke="${mix(c, c2, 0.2)}" stroke-width="1.1" fill="none" opacity=".5" stroke-linecap="round"/>
        <path d="M-12 -18 C-22 -26 -32 -28 -40 -27" stroke="#ffffff" stroke-width="2" fill="none" stroke-linecap="round" opacity=".9"/>` : ""}`;
      return `<g data-k="wingL" transform="translate(-38 -8)"><g transform="scale(.82)">${wing}</g></g><g data-k="wingR" transform="translate(38 -8) scale(-1 1)"><g transform="scale(.82)">${wing}</g></g>`;
    }
    return "";
  }
  function accFront(acc, id, c, c2, lod) {
    if (acc === "headphones") {
      const cream = "#fbf7ef", shade = "#d9cdb8";
      const cup = x => `<g transform="translate(${x} -4)">
          <rect x="-8.5" y="-17" width="17" height="34" rx="8.5" fill="url(#hp-${id})" stroke="${shade}" stroke-width="1"/>
          <rect x="${x < 0 ? 3 : -8}" y="-13" width="5" height="26" rx="2.5" fill="${mix(c2, "#000000", 0.15)}" opacity=".8"/>
          ${lod ? `<ellipse cx="${x < 0 ? -2.5 : 2.5}" cy="-7" rx="2.6" ry="5" fill="#ffffff" opacity=".85"/>` : ""}
          <circle cx="${x < 0 ? -1 : 1}" cy="6" r="2.6" fill="${c}" opacity=".9"/>
        </g>`;
      return `<g data-k="phones">
        <path d="M-50.5 -20 A56 56 0 0 1 50.5 -20" fill="none" stroke="${shade}" stroke-width="9.5" stroke-linecap="round"/>
        <path d="M-50.5 -20 A56 56 0 0 1 50.5 -20" fill="none" stroke="${cream}" stroke-width="7" stroke-linecap="round"/>
        ${lod ? `<path d="M-33 -41 A54 54 0 0 1 8 -51.5" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" opacity=".95"/>` : ""}
        <path d="M-47 14 C-45 30 -34 37 -20 34" fill="none" stroke="${shade}" stroke-width="${lod ? 3.2 : 4.2}" stroke-linecap="round"/>
        <path d="M-47 14 C-45 30 -34 37 -20 34" fill="none" stroke="${cream}" stroke-width="${lod ? 1.8 : 2.6}" stroke-linecap="round"/>
        <circle cx="-18" cy="33.6" r="${lod ? 3.6 : 4.4}" fill="${mix(c2, "#000000", 0.25)}"/>
        ${lod ? `<circle cx="-19" cy="32.4" r="1.2" fill="#ffffff" opacity=".6"/>` : ""}
        ${cup(-50)}${cup(50)}
      </g>`;
    }
    if (acc === "trumpet") {
      return `<g data-k="trumpet"><g transform="translate(-6 0) scale(1.15)">
        <path d="M6 3 L24 3 L24 17 L15 12.5 L6 17 Z" fill="#e11d48" stroke="#9f1239" stroke-width=".9" stroke-linejoin="round"/>
        <path d="M15 6.5 l1.1 2.2 2.4 .3 -1.8 1.6 .5 2.4 -2.2 -1.2 -2.2 1.2 .5 -2.4 -1.8 -1.6 2.4 -.3 Z" fill="#ffe08a"/>
        <rect x="0" y="-2.6" width="30" height="5.2" rx="2.6" fill="url(#tr-${id})" stroke="#6f7a90" stroke-width="1"/>
        <path d="M27 -2.6 L44 -11 Q48 0 44 11 L27 2.6 Z" fill="url(#tr-${id})" stroke="#6f7a90" stroke-width="1" stroke-linejoin="round"/>
        <ellipse cx="44.5" cy="0" rx="2.6" ry="10.8" fill="#8f99ad"/>
        <circle cx="-1" cy="0" r="3.2" fill="url(#tr-${id})" stroke="#6f7a90" stroke-width="1"/>
      </g>
      <g data-k="notes" fill="none" stroke="${c2}" stroke-linecap="round" stroke-width="2.4">
        <path data-k="n1" d="M48 -7 Q51 0 48 7"/><path data-k="n2" d="M53 -11 Q57 0 53 11"/><path data-k="n3" d="M58 -15 Q63 0 58 15"/>
      </g></g>`;
    }
    return "";
  }
  function accFace(acc, id, c, c2, lod) {
    if (acc !== "glasses") return "";
    const fr = "#e4b24a", fd = "#a8761a";
    const lens = x => `<circle cx="${x}" cy="3" r="12.6" fill="#ffffff" fill-opacity=".14" stroke="${fd}" stroke-width="${lod ? 3.4 : 4}"/>
      <circle cx="${x}" cy="3" r="12.6" fill="none" stroke="${fr}" stroke-width="${lod ? 2 : 2.6}"/>
      ${lod ? `<path d="M${x - 7} ${-4} L${x - 2} ${-9}" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" opacity=".75"/>` : ""}`;
    return `<g data-k="glasses">
      <path d="M-27.6 1 L-44 -5 M27.6 1 L44 -5" stroke="${fd}" stroke-width="2.4" stroke-linecap="round"/>
      ${lens(-15)}${lens(15)}
      <path d="M-3 0 Q0 -3.4 3 0" fill="none" stroke="${fr}" stroke-width="2.4" stroke-linecap="round"/>
    </g>`;
  }
  function accFree(acc, id, c, c2, lod) {
    if (acc !== "plane") return "";
    return `<g data-k="planeTrail" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="0.1 5" opacity=".9"><path data-k="trail" d=""/></g>
      <g data-k="plane">
        <g filter="url(#sh-${id})" opacity=".35"><path d="M16 2 L-13 -8 L-5 3 L-9 11 Z" fill="${c2}"/></g>
        <path d="M15 0 L-13 -10 L-5 1 Z" fill="#ffffff" stroke="${c2}" stroke-width="1" stroke-linejoin="round"/>
        <path d="M15 0 L-5 1 L-9 9 Z" fill="${mix("#ffffff", c, 0.35)}" stroke="${c2}" stroke-width="1" stroke-linejoin="round"/>
        <path d="M15 0 L-5 1 L-2 4.5 Z" fill="${mix(c, c2, 0.3)}" stroke="${c2}" stroke-width=".8" stroke-linejoin="round"/>
      </g>`;
  }

  let UID = 0;
  function make(parent, name, size) {
    const def = CAST[name] || CAST.colleague, { c, c2, acc } = def, id = "g" + ++UID + name;
    const lod = size < 60 ? 0 : 1; // 0: small UI cards, fewer details and heavier strokes
    const W = Math.round(size * 1.6), dark = "#17142b", eyeHi = mix(dark, c2, 0.35);
    const k = 1.6; // 160 units / 100 units of sphere
    const el = document.createElement("div");
    el.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${W}px;transform-origin:50% 50%;pointer-events:none;will-change:transform`;
    el._w = W; el._h = W; el.dataset.god = name;
    const eye = x => `<g data-k="eye${x < 0 ? "L" : "R"}"><g data-k="eye${x < 0 ? "L" : "R"}s">
        <ellipse rx="5.7" ry="7.6" fill="url(#ey-${id})"/>
        <circle cx="-1.9" cy="-3.2" r="${lod ? 2.1 : 2.5}" fill="#ffffff"/>
        ${lod ? `<circle cx="2" cy="2.8" r="1" fill="#ffffff" opacity=".8"/>` : ""}
      </g></g>`;
    const arc = x => `<path data-k="hap${x < 0 ? "L" : "R"}" d="M-5.8 2 Q0 -6.5 5.8 2" fill="none" stroke="${dark}" stroke-width="${lod ? 3.1 : 3.6}" stroke-linecap="round" opacity="0"/>`;
    const arm = s => `<ellipse data-k="arm${s < 0 ? "L" : "R"}" rx="9" ry="13" fill="url(#am-${id})"/>`;
    el.innerHTML = `<svg viewBox="0 0 160 160" width="${W}" height="${W}" style="overflow:visible;display:block" xmlns="${NS}">
  <defs>
    <radialGradient id="au-${id}" cx="50%" cy="50%" r="50%"><stop offset="50%" stop-color="${c}" stop-opacity=".9"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient>
    <radialGradient id="bd-${id}" cx="40%" cy="33%" r="72%"><stop offset="0%" stop-color="#fff" stop-opacity=".95"/><stop offset="34%" stop-color="${c}"/><stop offset="100%" stop-color="${c2}"/></radialGradient>
    <linearGradient id="am-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${c}"/><stop offset="100%" stop-color="${c2}"/></linearGradient>
    <radialGradient id="ey-${id}" cx="45%" cy="30%" r="75%"><stop offset="0%" stop-color="${eyeHi}"/><stop offset="70%" stop-color="${dark}"/></radialGradient>
    <linearGradient id="rg-${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#c0840a"/><stop offset="30%" stop-color="#f7cf5c"/><stop offset="48%" stop-color="#fff6d2"/><stop offset="66%" stop-color="#f3c24a"/><stop offset="100%" stop-color="#b47a08"/></linearGradient>
    <linearGradient id="hp-${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#e8dfcf"/></linearGradient>
    <linearGradient id="tr-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffffff"/><stop offset="55%" stop-color="#dfe5ef"/><stop offset="100%" stop-color="#aab3c4"/></linearGradient>
    <linearGradient id="qv-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffffff"/><stop offset="65%" stop-color="${mix("#ffffff", c, 0.25)}"/><stop offset="100%" stop-color="${c}"/></linearGradient>
    <linearGradient id="wg-${id}" x1="1" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="${mix("#ffffff", c, 0.5)}"/><stop offset="45%" stop-color="#ffffff"/><stop offset="100%" stop-color="#fbfdf5"/></linearGradient>
    <filter id="sw-${id}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6.5"/></filter>
    <filter id="bl-${id}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.6"/></filter>
    <filter id="rgl-${id}" x="-30%" y="-150%" width="160%" height="400%"><feGaussianBlur stdDeviation="2.8"/></filter>
    <filter id="sh-${id}" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="3"/></filter>
    <clipPath id="ck-${id}"><circle r="50"/></clipPath>
    <clipPath id="mk-${id}"><path data-k="mclip" d=""/></clipPath>
  </defs>
  <ellipse data-k="shadow" cx="80" cy="146" rx="30" ry="4.5" fill="${c2}" filter="url(#sh-${id})"/>
  <circle data-k="aura" cx="80" cy="80" r="70" fill="url(#au-${id})"/>
  <g data-k="body">
    ${accBack(acc, id, c, c2, lod)}
    ${arm(-1)}${arm(1)}
    <circle r="50" fill="url(#bd-${id})"/>
    <g clip-path="url(#ck-${id})"><g filter="url(#sw-${id})" opacity=".85"><g data-k="swirl">
      <ellipse cx="-18" cy="-12" rx="32" ry="17" fill="#fff" opacity=".42"/>
      <ellipse cx="20" cy="15" rx="26" ry="14.5" fill="${c2}" opacity=".9"/>
      <ellipse cx="-6" cy="24" rx="23" ry="11.5" fill="${c}" opacity=".9"/>
    </g></g>
    <ellipse cx="0" cy="58" rx="40" ry="16" fill="${mix(c, "#ffffff", 0.35)}" opacity=".45" filter="url(#bl-${id})"/></g>
    <ellipse cx="-15" cy="-27" rx="20" ry="9.4" fill="#fff" opacity=".38" transform="rotate(-18 -15 -27)"/>
    ${lod ? `<ellipse cx="-24" cy="-30" rx="5" ry="2.6" fill="#fff" opacity=".9" transform="rotate(-38 -24 -30)"/>` : ""}
    <circle r="49.5" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="1"/>
    <g data-k="face">
      ${lod ? `<ellipse data-k="blushL" cx="-25" cy="15" rx="6.5" ry="3.6" fill="#ff6f9c" opacity=".38" filter="url(#bl-${id})"/>
      <ellipse data-k="blushR" cx="25" cy="15" rx="6.5" ry="3.6" fill="#ff6f9c" opacity=".38" filter="url(#bl-${id})"/>` : ""}
      ${eye(-1)}${eye(1)}${arc(-1)}${arc(1)}
      <path data-k="mouth" d="" fill="${dark}" stroke="${dark}" stroke-width="${lod ? 1.8 : 2.6}" stroke-linejoin="round" stroke-linecap="round"/>
      <ellipse data-k="tongue" cx="0" cy="0" rx="4" ry="3" fill="#ff7d9b" clip-path="url(#mk-${id})"/>
      ${accFace(acc, id, c, c2, lod)}
    </g>
    ${accFront(acc, id, c, c2, lod)}
  </g>
  <g data-k="ring">
    <ellipse data-k="ringGlow" rx="27" ry="6.8" fill="none" stroke="#ffcf4d" stroke-width="7" filter="url(#rgl-${id})"/>
    <ellipse rx="27" ry="6.8" fill="none" stroke="#a87208" stroke-opacity=".55" stroke-width="${lod ? 5.4 : 4.4}"/>
    <ellipse rx="27" ry="6.8" fill="none" stroke="url(#rg-${id})" stroke-width="${lod ? 4 : 3.2}"/>
    ${lod ? `<path d="M-19 4.9 Q0 8.4 19 4.9" fill="none" stroke="#fffbe8" stroke-width="1.2" stroke-linecap="round" opacity=".9"/>` : ""}
    <g data-k="dots" fill="#fff3c2"><circle data-k="d0" r="1.8"/><circle data-k="d1" r="1.5"/><circle data-k="d2" r="1.2"/></g>
  </g>
  ${accFree(acc, id, c, c2, lod)}
</svg>`;
    parent.appendChild(el);
    const R = {}; el.querySelectorAll("[data-k]").forEach(n => (R[n.dataset.k] = n));
    const blinks = blinkTable(name), h = hash(name), ph = (h % 1000) / 1000 * TAU, ph2 = ((h >>> 10) % 1000) / 1000 * TAU;
    const set = (n, a, v) => n && n.setAttribute(a, v);

    el._set = function (t, cx, cy, o = {}) {
      const s = o.s ?? 1, op = o.o ?? 1, b = o.b ?? 0, r = o.r ?? 0, haloO = o.halo ?? 1, shO = o.shadow ?? 1;
      const look = o.look || [0, 0], lx = Math.max(-1, Math.min(1, look[0] || 0)), ly = Math.max(-1, Math.min(1, look[1] || 0));
      const w = weights(o.state || "idle");
      /* periodic motion: S(k, u, p) is sin(u * k + p) for k in rad/s, snapped when o.loop is set */
      const L = o.loop > 0 ? +o.loop : 0;
      const sn = k => { if (!L) return [k, 1]; const raw = k * L / TAU, n = Math.max(1, Math.round(raw)); return [n * TAU / L, raw < 1 ? raw : 1]; };
      const S = (k, u, p) => { const q = sn(k); return q[1] * Math.sin(u * q[0] + p); };
      const Cs = (k, u, p) => { const q = sn(k); return q[1] * Math.cos(u * q[0] + p); };
      el.style.transform = `translate(${(cx - W / 2).toFixed(2)}px,${(cy - W / 2).toFixed(2)}px)` + (r ? ` rotate(${r.toFixed(2)}deg)` : "") + (s !== 1 ? ` scale(${s.toFixed(4)})` : "");
      el.style.opacity = op; el.style.visibility = op <= 0.003 ? "hidden" : "visible";
      el.style.filter = b > 0.05 ? `blur(${b.toFixed(2)}px)` : "none";
      if (op <= 0.003) return;

      /* motion */
      const bobA = blend(w, { idle: 2.2, talk: 1.4, listen: 1.1, work: 1.6, happy: 1 });
      const bobF = blend(w, { idle: 0.42, talk: 0.5, listen: 0.36, work: 0.7, happy: 0.5 });
      const bob = -S(TAU * bobF, t, ph) * bobA;
      const hop = Math.abs(S(Math.PI * 2.1, t, ph));
      const land = Math.pow(1 - hop, 6) * w.happy;
      const m = talkOpen(t, ph, S) * w.talk;
      const lift = -bob + 8 * hop * w.happy;
      const lean = (lx >= 0 ? 1 : -1) * 7 * w.listen + 1.6 * S(2.7, t, ph) * w.talk;
      const sx = 1 + 0.03 * m + 0.07 * land + 0.012 * S(TAU * 1.4, t, 0) * w.work;
      const sy = 1 - 0.035 * m - 0.07 * land - 0.012 * S(TAU * 1.4, t, 0) * w.work;
      const bx = 80 + 3.5 * lx * w.listen, by = 80 - lift + 50 * (1 - sy);
      set(R.body, "transform", `translate(${f2(bx)} ${f2(by)}) rotate(${f2(lean)}) scale(${f2(sx)} ${f2(sy)})`);
      set(R.shadow, "rx", f2(30 * (1 - lift * 0.012)));
      set(R.shadow, "opacity", f2(0.2 * shO * (1 - lift * 0.02)));

      /* aura and swirl */
      const breathe = 0.5 + 0.5 * S(TAU * 0.8, t, ph);
      const aura = blend(w, { idle: 0.26, talk: 0.36, listen: 0.52, work: 0.24 + 0.22 * breathe, happy: 0.42 });
      set(R.aura, "opacity", f2(aura));
      set(R.aura, "r", f2(68 + 5 * w.listen + 4 * breathe * w.work));
      set(R.aura, "cy", f2(by));
      set(R.aura, "cx", f2(bx));
      const rate = blend(w, { idle: 24, talk: 45, listen: 30, work: 290, happy: 70 }), turns = rate * L / 360;
      const spin = !L ? t * rate + ph * 57
        : turns < 0.5 ? ph * 57 + rate * L / TAU * Math.sin(TAU * t / L) // too slow for a whole turn: sway at the same speed
        : t * Math.round(turns) * 360 / L + ph * 57;
      set(R.swirl, "transform", `rotate(${f2(spin % 360)})`);

      /* face: look shifts the whole face, the eyes travel a little further */
      const idleLook = w.idle * 0.18;
      const glx = lx + idleLook * S(0.37, t, ph2), gly = ly + idleLook * 0.6 * S(0.29, t, ph);
      set(R.face, "transform", `translate(${f2(glx * 7)} ${f2(gly * 5)})`);
      const blink = L ? blinkAt([0.45 + (ph / TAU % 1) * Math.max(0, L - 0.9)], ((t % L) + L) % L) : blinkAt(blinks, t + 0); // 0 open, 1 shut
      const eyeS = (lod ? 1 : 1.14) * (1 + 0.14 * w.listen - 0.04 * w.work);
      const eyeY = (1 - 0.26 * w.work) * (1 - 0.9 * blink) * (1 - 0.85 * w.happy);
      for (const [n, x] of [["L", -15], ["R", 15]]) {
        set(R["eye" + n], "transform", `translate(${f2(x + glx * 2.6)} ${f2(3 + gly * 2.4 + 1.2 * w.work)})`);
        set(R["eye" + n + "s"], "transform", `scale(${f2(eyeS)} ${f2(Math.max(0.06, eyeS * eyeY))})`);
        set(R["eye" + n + "s"], "opacity", f2(1 - w.happy));
        set(R["hap" + n], "transform", `translate(${x} 3) scale(${f2(eyeS)})`);
        set(R["hap" + n], "opacity", f2(w.happy));
      }
      if (R.blushL) { const bo = f2((acc === "wings" ? 0.6 : 1) * (0.34 + 0.22 * w.happy + 0.08 * w.listen)); set(R.blushL, "opacity", bo); set(R.blushR, "opacity", bo); }

      /* mouth: a crescent that opens; happy is a wide open grin */
      const open = Math.max(m, 0.42 * w.happy);
      const mw = 5.4 + 1.6 * open + 1.6 * w.happy - 0.8 * w.work, top = 1.2 - 0.8 * open, bot = 2.8 + 13 * open;
      const my = 16.5, cy0 = my - 0.8 - 0.6 * w.happy;
      const d = `M${f2(-mw)} ${f2(cy0)} Q0 ${f2(my + top)} ${f2(mw)} ${f2(cy0)} Q0 ${f2(my + bot)} ${f2(-mw)} ${f2(cy0)} Z`;
      set(R.mouth, "d", d); set(R.mclip, "d", d);
      set(R.tongue, "cx", 0); set(R.tongue, "cy", f2(my + bot / 2 - 0.2));
      set(R.tongue, "rx", f2(mw * 0.62)); set(R.tongue, "ry", f2(1 + 3.4 * open));
      set(R.tongue, "opacity", f2(clamp01(open * 3)));

      /* arms */
      const sway = 5 * S(1.3, t, ph), gest = 13 * S(4.1, t, ph) * w.talk;
      const up = 52 * w.happy * (0.6 + 0.4 * hop) + 10 * w.listen;
      set(R.armL, "transform", `translate(-44 22) rotate(${f2(38 + sway + gest + up)})`);
      set(R.armR, "transform", `translate(44 22) rotate(${f2(-38 - sway + gest * 0.6 - up + (acc === "trumpet" ? 26 : 0))})`);

      /* halo ring: trails the body a little, breathes while working, brightens while listening */
      const lagBob = -S(TAU * bobF, t - 0.22, ph) * bobA;
      const ringY = 80 + def.ring + lagBob - 9 * Math.abs(S(Math.PI * 2.1, t - 0.08, ph)) * w.happy - 2.5 * S(1.1, t, ph2);
      const ringX = bx + Math.sin(lean * Math.PI / 180) * def.ring * -1 + 1.2 * S(0.9, t, ph);
      const ringS = 1 + 0.05 * breathe * w.work + 0.04 * w.listen;
      const ringTilt = 4 * S(0.8, t, ph2) + lean * 0.5;
      set(R.ring, "transform", `translate(${f2(ringX)} ${f2(ringY)}) rotate(${f2(ringTilt)}) scale(${f2(ringS)})`);
      const bright = blend(w, { idle: 0.75, talk: 0.85, listen: 1, work: 0.55 + 0.45 * breathe, happy: 1 });
      set(R.ring, "opacity", f2(haloO));
      set(R.ringGlow, "opacity", f2(clamp01(bright)));
      set(R.ringGlow, "stroke-width", f2(6 + 4 * w.listen + 3 * breathe * w.work));
      set(R.dots, "opacity", f2(w.work));
      for (let i = 0; i < 3; i++) {
        const a = t * sn(4.2)[0] - i * 0.42;
        set(R["d" + i], "cx", f2(27 * Math.cos(a))); set(R["d" + i], "cy", f2(6.8 * Math.sin(a)));
      }

      /* accessories */
      const flapF = blend(w, { idle: 1.1, talk: 1.6, listen: 0.8, work: 4.6, happy: 3 });
      const flapA = blend(w, { idle: 9, talk: 11, listen: 6, work: 20, happy: 18 });
      if (R.wingL) {
        const fl = S(TAU * flapF, t, ph) * flapA;
        set(R.wingL, "transform", `translate(-38 -8) rotate(${f2(fl)})`);
        set(R.wingR, "transform", `translate(38 -8) scale(-1 1) rotate(${f2(fl)})`);
      }
      if (R.quill) set(R.quill, "transform", `rotate(${f2(3 * S(1.1, t, ph) + 6 * S(17, t, 0) * w.work + 4 * w.happy * hop)} 30 -14) rotate(26 30 -14)`);
      if (R.trumpet) {
        set(R.trumpet, "transform", `translate(34 26) rotate(${f2(-34 + 3 * S(1.2, t, ph) - 6 * w.talk + 2.5 * m - 8 * w.happy * hop)})`);
        const blast = Math.max(w.talk, w.happy * 0.8);
        for (let i = 1; i <= 3; i++) {
          const p = ((t * (L ? Math.max(1, Math.round(1.6 * L)) / L : 1.6) + i / 3) % 1);
          set(R["n" + i], "opacity", f2(blast * Math.sin(Math.PI * p)));
          set(R["n" + i], "transform", `translate(${f2(p * 5)} 0)`);
        }
      }
      if (R.plane) {
        const sp = blend(w, { idle: 1.1, talk: 1.6, listen: 0.9, work: 3.2, happy: 2.4 });
        const pos = u => [bx + 60 + 9 * S(sp, u, ph) + 4 * w.work * Cs(sp * 2, u, 0), by - 42 + 6 * S(sp * 2, u, ph) - 6 * w.happy * hop];
        const [px, py] = pos(t), [qx, qy] = pos(t - 0.05);
        const head = Math.atan2(py - qy, Math.abs(px - qx) + 0.4) * 180 / Math.PI;
        const ang = Math.max(-30, Math.min(30, head)) * 0.6 - 8;
        set(R.plane, "transform", `translate(${f2(px)} ${f2(py)}) rotate(${f2(ang)}) scale(${lod ? 1.15 : 1})`);
        if (lod) {
          let tr = "";
          for (let i = 1; i <= 14; i++) { const [ax, ay] = pos(t - i * 0.07); tr += (i === 1 ? "M" : "L") + f2(ax - 12) + " " + f2(ay + 2) + " "; }
          set(R.trail, "d", tr);
        } else set(R.planeTrail, "opacity", 0);
      }
      if (R.notes && !lod) set(R.notes, "opacity", 0);
    };
    el._set(0, 0, 0, { o: 0 });
    return el;
  }

  window.Gods = { names: Object.keys(CAST), cast: CAST, make };
})();
