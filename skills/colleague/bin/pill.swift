// pill: a small floating status pill for the voice call, with the voice orb from
// design/orb.html (the approved prototype). The orb is the prototype's WebGL fragment
// shader ported 1:1 to Metal and drawn in an MTKView at display rate.
//
// Reads the VoiceMode heard log (~/.voicemode/logs/conversations/heard_*.jsonl) and shows
// one of: Listening, You (he is talking), Thinking, Claude (speaking), Mic off.
// While the call is live it also reads the Mac's own mic (AVAudioEngine tap, RMS per buffer)
// so the orb moves with his voice. If the mic cannot be read (no permission, no device), it
// falls back to the prototype's simulated voice envelope.
// The timer counts from the ears' last `listen-started` event.
// Layout: a 96 x 116 vertical card (orb, label) at the top-right by default; the call timer
// is off (all-day sessions), CALLPILL_TIMER=on adds it back as a third row (96 x 132);
// CALLPILL_LAYOUT=horizontal brings back the 180 x 48 pill at the top centre.
// Always on top, on every Space, draggable. `call start` launches it, `call stop` quits it.
//
// Build:     scripts/build-pill.sh (from the repo root) does all of this:
//            swiftc -O pill.swift -o pill -framework Metal -framework MetalKit
// Bundle:    cp pill CallPill.app/Contents/MacOS/CallPill   (plus an Info.plist with NSMicrophoneUsageDescription)
//            codesign -f -s - -i dev.cludegods.callpill -r='designated => identifier "dev.cludegods.callpill"' CallPill.app
//            (ad-hoc, but with a fixed designated requirement, so TCC keeps the mic grant across rebuilds)
// Snapshot:  ./pill --snapshot out.png        (renders every phase to a PNG, no mic, no window;
//            bottom row: hovered, muted, muted+hovered, hovered at 1.75x, muted at 0.75x)
// Hover:     Mute (`call mute`/`call unmute`) and Stop (`call stopwork`) fade in over the label.
//            ~/.voicemode/call/muted present = label Muted, Mic off orb, red mic-slash badge.
// Waiting:   a chevron (top-left corner, on hover; stays up in amber while anything waits) opens a
//            list under the card of sessions waiting on a permission decision or an answer, read
//            from ~/.voicemode/call/pending/*.json (written by an optional Notification hook; see README).
//            Each row has Open, which opens that session's claude:// link and nothing else. The
//            pill NEVER answers a prompt: Allow stays a click in the Claude app, and no voice
//            command reaches this list. Snapshot reads CALLPILL_PENDING_DIR (default: the real dir).
// Permits:   bin/permit (the PermissionRequest hook) writes ~/.voicemode/call/permit/<id>.json and
//            waits for <id>.answer. While any exist, a panel grows LEFT of the card (the card does
//            not move): session, tool, summary, Deny and Allow (accent orange). Oldest first,
//            "+N more". A mouse click on a button is the ONLY writer of <id>.answer (atomic); no
//            keyboard path, no voice path, and clicks are ignored for 0.6 s after a request
//            appears. The orb shows Thinking while one waits. Requests whose hook process has
//            exited are dropped. Snapshot reads CALLPILL_PERMIT_DIR, else built-in fakes.
// Resize:    scroll or pinch over the card, 0.75x...1.75x, top-right anchored, kept in UserDefaults.
// Debug:     open -g CallPill.app --args --log /path/level.log   (10 Hz mic level trace)

import AppKit
import AVFoundation
import CoreAudio
import AudioToolbox
import Metal
import MetalKit
import simd

// MARK: - Shader (ported from the WebGL reference in design/orb.html)

let orbShaderSource = """
#include <metal_stdlib>
using namespace metal;

struct U {
  float2 res;
  float radius, phase, breathPhase, breath, level, swirl, glow, halo, haloGain, silk, core, life, light, pad;
  float4 c[4];
};
struct VOut { float4 pos [[position]]; };

vertex VOut orb_vs(uint vid [[vertex_id]]) {
  float2 p[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
  VOut o; o.pos = float4(p[vid], 0.0, 1.0); return o;
}

// GLSL mod() is floor-based; keep it that way for negative lattice coordinates.
static float2 mod289(float2 x) { return x - floor(x / 289.0) * 289.0; }
static float3 mod289(float3 x) { return x - floor(x / 289.0) * 289.0; }
static float3 permute(float3 x) { return mod289(((x * 34.0) + 1.0) * x); }
static float snoise(float2 v) {
  const float4 C = float4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  float2 i = floor(v + dot(v, C.yy));
  float2 x0 = v - i + dot(i, C.xx);
  float2 i1 = (x0.x > x0.y) ? float2(1.0, 0.0) : float2(0.0, 1.0);
  float4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
  i = mod289(i);
  float3 p = permute(permute(i.y + float3(0.0, i1.y, 1.0)) + i.x + float3(0.0, i1.x, 1.0));
  float3 m = max(0.5 - float3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  float3 x = 2.0 * fract(p * C.www) - 1.0;
  float3 h = abs(x) - 0.5;
  float3 ox = floor(x + 0.5);
  float3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  float3 g; g.x = a0.x * x0.x + h.x * x0.y; g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
static float max3(float3 c) { return max(max(c.r, c.g), c.b); }

fragment float4 orb_fs(VOut in [[stage_in]], constant U& u [[buffer(0)]]) {
  // GL convention: origin bottom-left, y up.
  float2 uv = float2(in.pos.x / u.res.x, 1.0 - in.pos.y / u.res.y);
  float2 p = uv * 2.0 - 1.0;
  float ph = u.phase;
  float3 C0 = u.c[0].rgb, C1 = u.c[1].rgb, C2 = u.c[2].rgb, C3 = u.c[3].rgb;
  float R = u.radius * (1.0 + u.breath * sin(u.breathPhase) + 0.09 * u.level);
  float r = length(p);
  float2 q = p / R;
  float d = length(q);

  float sw = u.swirl * 1.4 * (1.0 - smoothstep(0.0, 1.2, d));
  float cs = cos(sw), sn = sin(sw);
  float2 qs = float2(cs * q.x - sn * q.y, sn * q.x + cs * q.y);

  float2 warp = float2(snoise(qs * 1.3 + float2(ph * 0.21, -ph * 0.17)),
                       snoise(qs * 1.3 + float2(4.7 - ph * 0.19, 2.1 + ph * 0.23)));
  float2 w = qs + warp * (0.18 + 0.22 * u.level + 0.10 * u.swirl);

  float3 acc = float3(0.0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float dirn = (fmod(fi, 2.0) < 0.5) ? 1.0 : -0.8;
    float t = ph * (0.55 + 0.17 * fi) * dirn + fi * 1.7;
    float rad = 0.40 + 0.16 * sin(ph * 0.43 + fi * 2.3) + 0.10 * u.level;
    float2 c = rad * float2(cos(t), sin(t * 1.07 + fi * 0.6));
    float s = 0.42 + 0.08 * sin(ph * 0.61 + fi * 1.9) + 0.14 * u.level;
    float2 dv = w - c;
    acc += u.c[i].rgb * exp(-dot(dv, dv) / (s * s));
  }
  float ang = ph * 0.12;
  float sf = snoise(w * 0.8 + float2(ph * 0.07, -ph * 0.05)) + 0.45 * dot(w, float2(cos(ang), sin(ang)));
  float silk = 0.5 + 0.5 * sin(5.0 * sf + ph * 0.6);
  float silkF = silk * silk;
  acc *= mix(1.0, 0.55 + 1.1 * silkF, u.silk);
  acc += 0.25 * (C0 + C1 + C2 + C3) * 0.22 * exp(-d * d * 1.2);
  acc += mix(float3(1.0), 0.5 * (C0 + C1), 0.5) * exp(-d * d * 3.5) * u.level * u.core;
  acc *= mix(1.0, 0.8, smoothstep(0.55, 1.0, d));

  float3 glow = 1.0 - exp(-acc * u.glow);
  float lum = dot(glow, float3(0.299, 0.587, 0.114));
  glow = clamp(mix(float3(lum), glow, 1.3), 0.0, 1.0);
  float gA = max3(glow);

  float3 base = mix(float3(0.035, 0.04, 0.065), float3(0.975, 0.975, 0.985), u.light);
  float bA = mix(0.82, 0.60, u.light);
  float3 orbP = glow + base * bA * (1.0 - gA);
  float orbA = gA + bA * (1.0 - gA);

  float2 hp = q - float2(-0.32, 0.42);
  float spec = exp(-dot(hp, hp) * 5.0) * 0.20;
  float rim = smoothstep(0.78, 1.0, d) * 0.22;
  float3 rimC = mix(float3(1.0), 0.5 * (C1 + C2), 0.5);
  float3 add = (float3(spec) + rimC * rim) * mix(1.0, 0.6, u.light) * u.life;
  orbP += add; orbA = clamp(orbA + max3(add), 0.0, 1.0);

  float aa = 1.8 / (R * u.res.y * 0.5);
  float disc = 1.0 - smoothstep(1.0 - aa - 0.015, 1.0 + aa, d);
  orbP *= disc; orbA *= disc;

  float3 hc = 0.25 * (C0 + C1 + C2 + C3);
  hc = hc / max(max3(hc), 1e-3);
  float hw = R * (0.28 + 0.35 * u.level);
  float hd = max(r - R * 0.92, 0.0);
  float hI = (u.halo + u.haloGain * u.level) * exp(-powr(hd / hw, 1.3));
  hI *= 1.0 - smoothstep(0.82, 1.0, r);
  hI = min(hI * mix(1.0, 0.85, u.light), 0.9);
  float sh = u.light * 0.10 * exp(-max(r - R, 0.0) / (0.12 * R)) * (1.0 - smoothstep(0.82, 1.0, r));
  float3 haloP = hc * hI;
  float haloA = clamp(hI + sh * (1.0 - hI), 0.0, 1.0);

  float3 outP = orbP + haloP * (1.0 - orbA);
  float outA = orbA + haloA * (1.0 - orbA);

  float n = fract(sin(dot(in.pos.xy, float2(12.9898, 78.233))) * 43758.5453) - 0.5;
  outP += n / 255.0; outA = clamp(outA + n / 255.0, 0.0, 1.0);
  return float4(clamp(outP, 0.0, outA), outA);
}
"""

// MARK: - States (the prototype's STATES table, values verbatim)

func hex(_ s: String) -> SIMD3<Float> {
    let v = UInt32(s.dropFirst(), radix: 16) ?? 0
    return SIMD3(Float((v >> 16) & 0xFF) / 255, Float((v >> 8) & 0xFF) / 255, Float(v & 0xFF) / 255)
}

/// Every eased scalar of the orb, in the prototype's KEYS order.
struct Params {
    var speed, levelSpeed, swirl, glow, halo, haloGain, breath, breathRate, silk, core, life: Float
    var you, amb, tts, pulse: Float
    var c: [SIMD3<Float>]

    mutating func ease(to t: Params, _ a: Float) {
        speed += (t.speed - speed) * a; levelSpeed += (t.levelSpeed - levelSpeed) * a
        swirl += (t.swirl - swirl) * a; glow += (t.glow - glow) * a
        halo += (t.halo - halo) * a; haloGain += (t.haloGain - haloGain) * a
        breath += (t.breath - breath) * a; breathRate += (t.breathRate - breathRate) * a
        silk += (t.silk - silk) * a; core += (t.core - core) * a; life += (t.life - life) * a
        you += (t.you - you) * a; amb += (t.amb - amb) * a; tts += (t.tts - tts) * a; pulse += (t.pulse - pulse) * a
        for i in 0..<4 { c[i] += (t.c[i] - c[i]) * a }
    }
}

enum Phase: CaseIterable {
    case listening, you, thinking, claude, off, muted

    var label: String {
        switch self {
        case .listening: return "Listening"
        case .you: return "You"
        case .thinking: return "Thinking"
        case .claude: return "Claude"
        case .off: return "Mic off"
        case .muted: return "Muted"
        }
    }

    var params: Params {
        switch self {
        case .listening:
            return Params(speed: 0.45, levelSpeed: 0.6, swirl: 0.35, glow: 1.35, halo: 0.14, haloGain: 0.25,
                          breath: 0.035, breathRate: 1.15, silk: 0.6, core: 0.15, life: 1.0,
                          you: 0, amb: 0.35, tts: 0, pulse: 0,
                          c: ["#4FB3FF", "#6E6BFF", "#5BE1FF", "#B58CFF"].map(hex))
        case .you:
            return Params(speed: 0.75, levelSpeed: 2.4, swirl: 0.55, glow: 1.6, halo: 0.16, haloGain: 0.45,
                          breath: 0.02, breathRate: 1.6, silk: 0.8, core: 0.45, life: 1.0,
                          you: 1, amb: 0, tts: 0, pulse: 0,
                          c: ["#2EE6A6", "#18C7D9", "#7CF29A", "#3FA9FF"].map(hex))
        case .thinking:
            return Params(speed: 0.42, levelSpeed: 0.5, swirl: 1.6, glow: 1.45, halo: 0.16, haloGain: 0.20,
                          breath: 0.03, breathRate: 1.9, silk: 1.0, core: 0.10, life: 1.0,
                          you: 0, amb: 0, tts: 0, pulse: 0.35,
                          c: ["#FFB020", "#FF8A1F", "#FFD45A", "#FF6A4D"].map(hex))
        case .claude:
            return Params(speed: 0.65, levelSpeed: 2.0, swirl: 0.5, glow: 1.6, halo: 0.16, haloGain: 0.40,
                          breath: 0.02, breathRate: 1.4, silk: 0.8, core: 0.40, life: 1.0,
                          you: 0, amb: 0, tts: 1, pulse: 0,
                          c: ["#FF7A1A", "#FF4E3A", "#FFB547", "#FF5E8A"].map(hex))
        case .off:
            return Params(speed: 0.06, levelSpeed: 0.0, swirl: 0.2, glow: 0.6, halo: 0.06, haloGain: 0.0,
                          breath: 0.008, breathRate: 0.6, silk: 0.3, core: 0.0, life: 0.35,
                          you: 0, amb: 0, tts: 0, pulse: 0,
                          c: ["#FF3B30", "#7A1424", "#FF6B5E", "#4A1020"].map(hex))
        case .muted:   // `call mute`: the Mic off look, verbatim
            return Phase.off.params
        }
    }
}

// MARK: - Simulated voice envelopes (the prototype's speechGen, used when no real signal)

final class SpeechGen {
    struct Opts { var talk, pause, syl, amp: ClosedRange<Float>; var emph, floor: Float }
    let o: Opts
    var t: Float = 0, segEnd: Float, speaking = false, sylStart: Float = 0, sylEnd: Float = 0, amp: Float = 0
    init(_ o: Opts) { self.o = o; segEnd = Float.random(in: 0.2...0.6) }

    func next(_ dt: Float) -> Float {
        t += dt
        if t > segEnd {
            speaking.toggle()
            segEnd = t + Float.random(in: speaking ? o.talk : o.pause)
            sylEnd = t
        }
        if !speaking { return o.floor * (0.6 + 0.4 * Float.random(in: 0...1)) }
        if t >= sylEnd {
            sylStart = t; sylEnd = t + Float.random(in: o.syl)
            amp = Float.random(in: o.amp) * (Float.random(in: 0...1) < o.emph ? 1.25 : 1)
        }
        let x = (t - sylStart) / (sylEnd - sylStart)
        return min(1, amp * pow(sin(.pi * min(1, x)), 0.6))
    }
}

// MARK: - Orb model: the prototype's frame() loop, minus the drawing

final class OrbModel {
    var target: Phase = .listening
    var lightTarget: Float = 0
    private(set) var cur = Phase.listening.params
    private(set) var light: Float = 0
    private(set) var phase: Float = 0, breathPhase: Float = 0, level: Float = 0
    private var clockT: Float = 0, ambT: Float = 0
    private let userSim = SpeechGen(.init(talk: 1.2...3.6, pause: 0.35...1.3, syl: 0.09...0.26, amp: 0.3...0.95, emph: 0.15, floor: 0.03))
    private let ttsSim = SpeechGen(.init(talk: 2.4...5.0, pause: 0.22...0.55, syl: 0.15...0.21, amp: 0.55...0.82, emph: 0.08, floor: 0.02))

    static let tauState: Float = 0.35, attack: Float = 0.045, release: Float = 0.20

    func snapTo(_ p: Phase, light l: Float) { target = p; cur = p.params; light = l; lightTarget = l }

    /// `mic` is the live, mapped mic level (0...1), or nil when the meter is not delivering.
    func advance(_ dtIn: Float, mic: Float?) {
        let dt = min(0.05, dtIn)
        let a = 1 - exp(-dt / OrbModel.tauState)
        cur.ease(to: target.params, a)
        light += (lightTarget - light) * a

        clockT += dt
        let user = mic ?? userSim.next(dt)
        let amb: Float
        if let m = mic { amb = m } else { ambT += dt; amb = 0.06 + 0.04 * sin(ambT * 1.7) + 0.03 * sin(ambT * 4.1 + 1.3) }
        let tts = ttsSim.next(dt)
        let pulse = 0.5 + 0.5 * sin(clockT * 2.4)
        let raw = min(1, cur.you * user + cur.amb * amb + cur.tts * tts + cur.pulse * pulse)
        let tau = raw > level ? OrbModel.attack : OrbModel.release
        level += (raw - level) * (1 - exp(-dt / tau))

        phase += dt * (cur.speed + cur.levelSpeed * level)
        breathPhase += dt * cur.breathRate
    }

    /// Uniform block, laid out to match `struct U` in the shader (128 bytes).
    func uniforms(res: SIMD2<Float>, radius: Float) -> [Float] {
        var u: [Float] = [res.x, res.y, radius, phase, breathPhase, cur.breath, level, cur.swirl, cur.glow,
                          cur.halo, cur.haloGain, cur.silk, cur.core, cur.life, light, 0]
        for c in cur.c { u += [c.x, c.y, c.z, 0] }
        return u
    }
}

// MARK: - Metal renderer

final class OrbRenderer {
    let device: MTLDevice
    let queue: MTLCommandQueue
    let pipeline: MTLRenderPipelineState

    init?() {
        guard let dev = MTLCreateSystemDefaultDevice(), let q = dev.makeCommandQueue() else { return nil }
        do {
            let lib = try dev.makeLibrary(source: orbShaderSource, options: nil)
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = lib.makeFunction(name: "orb_vs")
            d.fragmentFunction = lib.makeFunction(name: "orb_fs")
            d.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipeline = try dev.makeRenderPipelineState(descriptor: d)
        } catch {
            FileHandle.standardError.write(Data("orb shader: \(error)\n".utf8)); return nil
        }
        device = dev; queue = q
    }

    func encode(_ cb: MTLCommandBuffer, _ pass: MTLRenderPassDescriptor, _ u: [Float]) {
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        pass.colorAttachments[0].storeAction = .store
        guard let enc = cb.makeRenderCommandEncoder(descriptor: pass) else { return }
        enc.setRenderPipelineState(pipeline)
        u.withUnsafeBytes { enc.setFragmentBytes($0.baseAddress!, length: $0.count, index: 0) }
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
    }
}

// MARK: - The orb view (MTKView, display rate)

final class OrbView: MTKView, MTKViewDelegate {
    let model = OrbModel()
    let renderer: OrbRenderer
    var micLevel: () -> Float? = { nil }
    static let radius: Float = 0.64        // sphere = 0.64 x glow box (54 pt in 84 vertical, 28 in 44 horizontal)
    private var last: CFTimeInterval = 0

    init(frame: NSRect, renderer: OrbRenderer) {
        self.renderer = renderer
        super.init(frame: frame, device: renderer.device)
        colorPixelFormat = .bgra8Unorm
        colorspace = CGColorSpace(name: CGColorSpace.sRGB)   // hex used directly, no linearisation
        clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        framebufferOnly = true
        preferredFramesPerSecond = 60
        layer?.isOpaque = false
        delegate = self
    }
    required init(coder: NSCoder) { fatalError() }

    override var mouseDownCanMoveWindow: Bool { true }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        let now = CACurrentMediaTime()
        let dt = last == 0 ? 1.0 / 60 : now - last
        last = now
        model.advance(Float(dt), mic: micLevel())
        guard let pass = currentRenderPassDescriptor, let drawable = currentDrawable,
              let cb = renderer.queue.makeCommandBuffer() else { return }
        let ds = drawableSize
        renderer.encode(cb, pass, model.uniforms(res: SIMD2(Float(ds.width), Float(ds.height)), radius: OrbView.radius))
        cb.present(drawable)
        cb.commit()
    }
}

// MARK: - The pill (vertical card by default, horizontal pill behind CALLPILL_LAYOUT)

struct Theme {
    let fg: NSColor, fg2: NSColor, border: NSColor, light: Float
    static let dark = Theme(fg: NSColor(srgbRed: 0xf5 / 255.0, green: 0xf5 / 255.0, blue: 0xf7 / 255.0, alpha: 1),
                            fg2: NSColor(srgbRed: 235 / 255.0, green: 235 / 255.0, blue: 245 / 255.0, alpha: 0.55),
                            border: NSColor(white: 1, alpha: 0.14), light: 0)
    static let light = Theme(fg: NSColor(srgbRed: 0x1d / 255.0, green: 0x1d / 255.0, blue: 0x1f / 255.0, alpha: 1),
                             fg2: NSColor(srgbRed: 60 / 255.0, green: 60 / 255.0, blue: 67 / 255.0, alpha: 0.6),
                             border: NSColor(white: 0, alpha: 0.08), light: 1)
    static func of(_ a: NSAppearance) -> Theme {
        a.bestMatch(from: [.darkAqua, .vibrantDark, .aqua, .vibrantLight]).map { $0 == .darkAqua || $0 == .vibrantDark } ?? true
            ? .dark : .light
    }
}

/// Two layouts, same orb. Vertical (the default) is a small tall card: orb on top, label,
/// then the call timer. Horizontal is the original 180 x 48 pill. `CALLPILL_LAYOUT=horizontal`
/// switches back. Geometry mirrors `.pill` / `.pill.vert` in design/orb.html (y measured from
/// the top there, from the bottom here).
enum PillLayout {
    case horizontal, vertical

    static let current: PillLayout =
        ProcessInfo.processInfo.environment["CALLPILL_LAYOUT"]?.lowercased() == "horizontal" ? .horizontal : .vertical

    /// The call timer is off by default: the call runs all day. CALLPILL_TIMER=on shows it.
    static let showTimer = ProcessInfo.processInfo.environment["CALLPILL_TIMER"] == "on"
    /// Card height: 132 with the timer row, 116 without it.
    var H: CGFloat { self == .vertical ? (PillLayout.showTimer ? 132 : 116) : 48 }
    var size: NSSize { self == .vertical ? NSSize(width: 96, height: H) : NSSize(width: 180, height: 48) }
    var cornerRadius: CGFloat { 24 }
    /// The orb's glow box. Shader radius stays 0.64 in both, so the sphere is 0.64 x the box.
    var orbRect: NSRect {
        self == .vertical ? NSRect(x: 6, y: H - 6 - 84, width: 84, height: 84) : NSRect(x: 2, y: 2, width: 44, height: 44)
    }
    /// Label column: x, width, and the vertical centre of the active label.
    var labelX: CGFloat { self == .vertical ? 6 : 52 }
    var labelWidth: CGFloat { self == .vertical ? 84 : 180 - 52 - 54 }
    var labelMidY: CGFloat { self == .vertical ? H - (81 + 9.5) : 24 }
    var labelAlign: CATextLayerAlignmentMode { self == .vertical ? .center : .left }
    var timerFontSize: CGFloat { self == .vertical ? 11 : 11.5 }
    var timerMidY: CGFloat { self == .vertical ? H - (101 + 8) : 24 }
    var timerX: CGFloat { self == .vertical ? 0 : 180 - 16 - 60 }
    var timerWidth: CGFloat { self == .vertical ? 96 : 60 }
    var timerAlign: CATextLayerAlignmentMode { self == .vertical ? .center : .right }
    /// Hover controls. Vertical: two 26 pt buttons over the label row, clear of the sphere.
    /// Horizontal: on the right, over the timer.
    var muteRect: NSRect {
        self == .vertical ? NSRect(x: 48 - 16 - 13, y: labelMidY - 13, width: 26, height: 26)
                          : NSRect(x: 180 - 12 - 28 - 6 - 28, y: 10, width: 28, height: 28)
    }
    var stopRect: NSRect {
        self == .vertical ? NSRect(x: 48 + 16 - 13, y: labelMidY - 13, width: 26, height: 26)
                          : NSRect(x: 180 - 12 - 28, y: 10, width: 28, height: 28)
    }
    /// Muted badge: top-right corner, outside the sphere, inside the rounded corner.
    var badgeRect: NSRect {
        self == .vertical ? NSRect(x: 96 - 20 - 9, y: H - 20 - 9, width: 18, height: 18)
                          : NSRect(x: 34, y: 30, width: 14, height: 14)
    }
    /// Waiting-list chevron: the badge's mirror, top-left corner, clear of the sphere.
    var expandRect: NSRect {
        self == .vertical ? NSRect(x: 9, y: H - 20 - 9, width: 20, height: 20)
                          : NSRect(x: 34, y: 4, width: 14, height: 14)
    }
}

// MARK: - Waiting sessions (records written by an optional Notification hook; see README)

struct PendingItem: Equatable {
    let sessionId: String
    let title: String
    let message: String
    let link: String
    let at: Date

    static let defaultDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".voicemode/call/pending")
    static var dir: URL {
        ProcessInfo.processInfo.environment["CALLPILL_PENDING_DIR"].map { URL(fileURLWithPath: $0) } ?? defaultDir
    }

    /// The only thing the pill ever does with a record: open the session in the Claude app.
    /// Anything that is not a plain claude:// session link is refused.
    var openURL: URL? {
        let prefix = "claude://claude.ai/epitaxy/local_"
        guard link.hasPrefix(prefix) else { return nil }
        let id = link.dropFirst(prefix.count)
        guard !id.isEmpty, id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else { return nil }
        return URL(string: link)
    }

    func age(_ now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(at)))
        return s < 60 ? "now" : s < 3600 ? "\(s / 60)m" : "\(s / 3600)h"
    }

    /// Records newest first. Skipped: older than a day, or the session already moved on
    /// (its transcript was written after the record: Allow was pressed, or the user answered).
    static func load(from dir: URL = PendingItem.dir, now: Date = Date()) -> [PendingItem] {
        let fm = FileManager.default
        let files = ((try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }
        var out: [PendingItem] = []
        for f in files {
            guard let data = try? Data(contentsOf: f),
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let sid = o["session_id"] as? String, let ts = o["at"] as? Double else { continue }
            let at = Date(timeIntervalSince1970: ts)
            if now.timeIntervalSince(at) > 86400 { continue }
            if let tp = o["transcript_path"] as? String, !tp.isEmpty,
               let m = (try? fm.attributesOfItem(atPath: tp))?[.modificationDate] as? Date,
               m.timeIntervalSince(at) > 2 { continue }
            var title = (o["title"] as? String) ?? ""
            if title.isEmpty, let cwd = o["cwd"] as? String, !cwd.isEmpty { title = (cwd as NSString).lastPathComponent }
            if title.isEmpty { title = String(sid.prefix(8)) }
            var msg = (o["message"] as? String) ?? ""
            if msg.isEmpty { msg = (o["notification_title"] as? String) ?? "" }
            if msg.isEmpty { msg = "Waiting for you" }
            out.append(PendingItem(sessionId: sid, title: title, message: msg, link: (o["link"] as? String) ?? "", at: at))
        }
        return out.sorted { $0.at > $1.at }
    }
}

/// The expanded list under the card. Like GlassButton, one paint routine shared by the live
/// view and the snapshot. Rows show the session, the waiting message and an Open button.
/// There is deliberately no Allow: Open takes the user to the session; they decide there.
final class PendingListView: NSView {
    static let width: CGFloat = 264, header: CGFloat = 30, rowH: CGFloat = 60, foot: CGFloat = 8, more: CGFloat = 20
    static let maxRows = 6
    static let openSize = NSSize(width: 52, height: 24)

    var items: [PendingItem] = [] { didSet { needsDisplay = true } }
    var theme = Theme.dark { didSet { needsDisplay = true } }
    var k: CGFloat = 1 { didSet { needsDisplay = true } }
    var onOpen: ((PendingItem) -> Void)?
    private var pressed: Int? { didSet { if pressed != oldValue { needsDisplay = true } } }

    static func height(for n: Int) -> CGFloat {
        header + CGFloat(max(1, min(n, maxRows))) * rowH + (n > maxRows ? more : 0) + foot
    }
    static func size(for n: Int, k: CGFloat) -> NSSize { NSSize(width: width * k, height: height(for: n) * k) }

    static func openRect(_ i: Int, in b: NSRect, k: CGFloat) -> NSRect {
        let top = b.maxY - (header + CGFloat(i) * rowH) * k
        return NSRect(x: b.maxX - (12 + openSize.width) * k, y: top - (rowH / 2 + openSize.height / 2) * k,
                      width: openSize.width * k, height: openSize.height * k)
    }

    override var isFlipped: Bool { false }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); theme = Theme.of(effectiveAppearance) }

    private func row(at e: NSEvent) -> Int? {
        let p = convert(e.locationInWindow, from: nil)
        return (0..<min(items.count, PendingListView.maxRows)).first { PendingListView.openRect($0, in: bounds, k: k).contains(p) }
    }
    override func mouseDown(with e: NSEvent) { pressed = row(at: e) }
    override func mouseDragged(with e: NSEvent) { if let p = pressed, row(at: e) != p { pressed = nil } }
    override func mouseUp(with e: NSEvent) {
        let hit = row(at: e)
        defer { pressed = nil }
        if let i = hit, i == pressed, i < items.count { onOpen?(items[i]) }
    }

    override func draw(_ dirty: NSRect) {
        PendingListView.paint(in: bounds, items: items, theme: theme, k: k, pressed: pressed, now: Date())
    }

    static func paint(in b: NSRect, items: [PendingItem], theme: Theme, k: CGFloat, pressed: Int?, now: Date) {
        let dark = theme.light < 0.5
        let pad = 14 * k
        func text(_ s: String, _ size: CGFloat, _ w: NSFont.Weight, _ c: NSColor, wrap: Bool = false, align: NSTextAlignment = .left) -> NSAttributedString {
            let ps = NSMutableParagraphStyle()
            ps.lineBreakMode = wrap ? .byWordWrapping : .byTruncatingTail
            ps.alignment = align
            return NSAttributedString(string: s, attributes: [.font: NSFont.systemFont(ofSize: size * k, weight: w),
                                                              .foregroundColor: c, .paragraphStyle: ps])
        }
        // header
        let hTop = b.maxY - header * k
        let head = text("Waiting on you", 11, .semibold, theme.fg2)
        head.draw(in: NSRect(x: b.minX + pad, y: hTop + (header * k - head.size().height) / 2 - 1 * k, width: 160 * k, height: head.size().height))
        if !items.isEmpty {
            let n = text("\(items.count)", 11, .semibold, GlassButton.amber, align: .right)
            n.draw(in: NSRect(x: b.maxX - pad - 40 * k, y: hTop + (header * k - n.size().height) / 2 - 1 * k, width: 40 * k, height: n.size().height))
        }
        if items.isEmpty {
            let e = text("Nothing waiting", 12, .medium, theme.fg2, align: .center)
            e.draw(in: NSRect(x: b.minX, y: hTop - (rowH * k + e.size().height) / 2, width: b.width, height: e.size().height))
            return
        }
        let sep = dark ? NSColor(white: 1, alpha: 0.08) : NSColor(white: 0, alpha: 0.07)
        for (i, it) in items.prefix(maxRows).enumerated() {
            let top = b.maxY - (header + CGFloat(i) * rowH) * k
            sep.setFill()
            NSRect(x: b.minX + pad, y: top - 0.5, width: b.width - 2 * pad, height: 0.5).fill()
            let open = openRect(i, in: b, k: k)
            let textW = open.minX - 10 * k - (b.minX + pad)
            // title + age on one line, message (two lines) under it
            let age = text(it.age(now), 10.5, .medium, theme.fg2, align: .right)
            let ageW = ceil(age.size().width)
            let tl = text(it.title, 12.5, .semibold, theme.fg)
            let th = ceil(tl.size().height)
            let tY = top - 9 * k - th
            tl.draw(in: NSRect(x: b.minX + pad, y: tY, width: textW - ageW - 6 * k, height: th))
            age.draw(in: NSRect(x: b.minX + pad + textW - ageW, y: tY + 1 * k, width: ageW, height: th))
            let msg = text(it.message, 11, .regular, theme.fg2, wrap: true)
            let mH = 29 * k
            msg.draw(with: NSRect(x: b.minX + pad, y: tY - 2 * k - mH, width: textW, height: mH),
                     options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
            // Open: glass capsule, same fill as the hover buttons
            let cap = NSBezierPath(roundedRect: open.insetBy(dx: 0.5, dy: 0.5), xRadius: open.height / 2, yRadius: open.height / 2)
            let down = pressed == i
            (dark ? NSColor(white: 1, alpha: down ? 0.30 : 0.17) : NSColor(white: 0, alpha: down ? 0.16 : 0.07)).setFill()
            cap.fill()
            (dark ? NSColor(white: 1, alpha: 0.22) : NSColor(white: 0, alpha: 0.12)).setStroke()
            cap.lineWidth = 0.5
            cap.stroke()
            let o = text(it.openURL == nil ? "No link" : "Open", 11.5, .semibold, it.openURL == nil ? theme.fg2 : theme.fg, align: .center)
            o.draw(in: NSRect(x: open.minX, y: open.midY - o.size().height / 2, width: open.width, height: o.size().height))
        }
        if items.count > maxRows {
            let m = text("+\(items.count - maxRows) more", 11, .medium, theme.fg2, align: .center)
            m.draw(in: NSRect(x: b.minX, y: b.maxY - (header + CGFloat(maxRows) * rowH + more) * k + 3 * k, width: b.width, height: m.size().height))
        }
    }
}

// MARK: - Permission requests (records written by bin/permit, the PermissionRequest hook)

/// One pending permission prompt. bin/permit writes <id>.json and polls for <id>.answer;
/// the pill writes that answer only from a mouse click on Allow or Deny. Nothing else in
/// the pill (and nothing voice-driven) ever writes an answer.
struct PermitItem: Equatable {
    let id: String
    let sessionId: String
    let title: String
    let cwd: String
    let tool: String
    let summary: String
    let mono: Bool
    let pid: Int32
    let created: Date

    static let defaultDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".voicemode/call/permit")
    static var dir: URL {
        ProcessInfo.processInfo.environment["CALLPILL_PERMIT_DIR"].map { URL(fileURLWithPath: $0) } ?? defaultDir
    }
    static let orange = NSColor(srgbRed: 0xf2 / 255.0, green: 0x6a / 255.0, blue: 0x1b / 255.0, alpha: 1)   // accent #f26a1b

    var heading: String {
        if !title.isEmpty { return title }
        if !cwd.isEmpty { return (cwd as NSString).lastPathComponent }
        return "Claude Code"
    }

    /// Requests oldest first. A request whose hook process is gone (answered in the app,
    /// cancelled, timed out) is dropped and its file removed.
    static func load(from dir: URL = PermitItem.dir, now: Date = Date()) -> [PermitItem] {
        let fm = FileManager.default
        let files = ((try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }
        var out: [PermitItem] = []
        for f in files {
            let stem = f.deletingPathExtension().lastPathComponent
            guard !stem.isEmpty, stem.count <= 64, stem.allSatisfy({ $0.isHexDigit }),
                  let data = try? Data(contentsOf: f),
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (o["id"] as? String) == stem, let ts = o["created"] as? Double else { continue }
            let created = Date(timeIntervalSince1970: ts)
            let pid = Int32((o["pid"] as? Int) ?? 0)
            let alive = pid > 0 ? (kill(pid, 0) == 0 || errno == EPERM) : now.timeIntervalSince(created) < 60
            if !alive || now.timeIntervalSince(created) > 600 {
                try? fm.removeItem(at: f)
                continue
            }
            out.append(PermitItem(id: stem, sessionId: (o["session_id"] as? String) ?? "",
                                  title: (o["title"] as? String) ?? "", cwd: (o["cwd"] as? String) ?? "",
                                  tool: (o["tool_name"] as? String) ?? "Tool",
                                  summary: (o["summary"] as? String) ?? "", mono: (o["mono"] as? Bool) ?? true,
                                  pid: pid, created: created))
        }
        return out.sorted { $0.created < $1.created }
    }

    /// The click's verdict, written atomically (temp file + rename) to <id>.answer.
    func answer(_ allow: Bool, in dir: URL = PermitItem.dir) -> Bool {
        let url = dir.appendingPathComponent(id + ".answer")
        return (try? Data((allow ? "allow" : "deny").utf8).write(to: url, options: .atomic)) != nil
    }
}

/// The permission panel, left of the card: session, tool, the summary (up to 4 lines, mono
/// for commands), Deny and Allow. One paint routine shared by the live view and the snapshot.
/// Clicks only count once the request has been on screen for `armDelay`, so a new request
/// sliding in under the pointer cannot catch a click meant for the previous one.
final class PermitView: NSView {
    static let width: CGFloat = 300, pad: CGFloat = 14, header: CGFloat = 32, toolRow: CGFloat = 16
    static let boxPad: CGFloat = 8, gap: CGFloat = 12, buttonH: CGFloat = 28, foot: CGFloat = 14, maxLines = 4
    static let armDelay: TimeInterval = 0.6

    var item: PermitItem? { didSet { if item?.id != oldValue?.id { armedAt = Date().addingTimeInterval(PermitView.armDelay) }; needsDisplay = true } }
    var more = 0 { didSet { needsDisplay = true } }
    var theme = Theme.dark { didSet { needsDisplay = true } }
    var k: CGFloat = 1 { didSet { needsDisplay = true } }
    var onAnswer: ((PermitItem, Bool) -> Void)?   // true = allow
    private var armedAt = Date.distantPast
    private var pressed: Bool? { didSet { if pressed != oldValue { needsDisplay = true } } }   // true = Allow held

    static func summaryFont(_ mono: Bool, _ k: CGFloat) -> NSFont {
        mono ? NSFont.monospacedSystemFont(ofSize: 11 * k, weight: .regular) : NSFont.systemFont(ofSize: 11.5 * k, weight: .regular)
    }
    static func summaryText(_ it: PermitItem, _ c: NSColor, _ k: CGFloat) -> NSAttributedString {
        let ps = NSMutableParagraphStyle()
        ps.lineBreakMode = it.mono ? .byCharWrapping : .byWordWrapping
        return NSAttributedString(string: it.summary.isEmpty ? it.tool : it.summary,
                                  attributes: [.font: summaryFont(it.mono, k), .foregroundColor: c, .paragraphStyle: ps])
    }
    static func lineH(_ mono: Bool, _ k: CGFloat) -> CGFloat {
        let f = summaryFont(mono, k)
        return ceil(NSLayoutManager().defaultLineHeight(for: f))
    }
    /// Summary text height: measured, capped at maxLines.
    static func summaryH(_ it: PermitItem, k: CGFloat) -> CGFloat {
        let w = (width - 2 * pad - 2 * boxPad) * k
        let r = summaryText(it, .white, k).boundingRect(with: NSSize(width: w, height: 10_000), options: [.usesLineFragmentOrigin])
        let lh = lineH(it.mono, k)
        return min(max(lh, ceil(r.height)), lh * CGFloat(maxLines))
    }
    static func size(for it: PermitItem, k: CGFloat) -> NSSize {
        NSSize(width: width * k, height: (header + toolRow + 4 + 2 * boxPad + gap + buttonH + foot) * k + summaryH(it, k: k))
    }
    static func buttonRect(allow: Bool, in b: NSRect, k: CGFloat) -> NSRect {
        let w = (b.width - 2 * pad * k - 8 * k) / 2
        let x = allow ? b.maxX - pad * k - w : b.minX + pad * k
        return NSRect(x: x, y: b.minY + foot * k, width: w, height: buttonH * k)
    }

    override var isFlipped: Bool { false }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var acceptsFirstResponder: Bool { false }   // no keyboard path to Allow
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); theme = Theme.of(effectiveAppearance) }

    private func button(at e: NSEvent) -> Bool? {
        let p = convert(e.locationInWindow, from: nil)
        if PermitView.buttonRect(allow: true, in: bounds, k: k).contains(p) { return true }
        if PermitView.buttonRect(allow: false, in: bounds, k: k).contains(p) { return false }
        return nil
    }
    override func mouseDown(with e: NSEvent) { pressed = Date() >= armedAt ? button(at: e) : nil }
    override func mouseDragged(with e: NSEvent) { if let p = pressed, button(at: e) != p { pressed = nil } }
    override func mouseUp(with e: NSEvent) {
        let hit = button(at: e)
        defer { pressed = nil }
        guard let it = item, let p = pressed, hit == p, Date() >= armedAt else { return }
        onAnswer?(it, p)
    }

    override func draw(_ dirty: NSRect) {
        guard let it = item else { return }
        PermitView.paint(in: bounds, item: it, more: more, theme: theme, k: k, pressed: pressed)
    }

    static func paint(in b: NSRect, item it: PermitItem, more: Int, theme: Theme, k: CGFloat, pressed: Bool?) {
        let dark = theme.light < 0.5
        let p = pad * k
        func text(_ s: String, _ size: CGFloat, _ w: NSFont.Weight, _ c: NSColor, align: NSTextAlignment = .left) -> NSAttributedString {
            let ps = NSMutableParagraphStyle()
            ps.lineBreakMode = .byTruncatingTail
            ps.alignment = align
            return NSAttributedString(string: s, attributes: [.font: NSFont.systemFont(ofSize: size * k, weight: w),
                                                              .foregroundColor: c, .paragraphStyle: ps])
        }
        // header: session title, "+N more" on the right
        let hTop = b.maxY - header * k
        var moreW: CGFloat = 0
        if more > 0 {
            let m = text("+\(more) more", 11, .semibold, GlassButton.amber, align: .right)
            moreW = ceil(m.size().width)
            m.draw(in: NSRect(x: b.maxX - p - moreW, y: hTop + (header * k - m.size().height) / 2 - 1 * k, width: moreW, height: m.size().height))
        }
        let t = text(it.heading, 12.5, .semibold, theme.fg)
        t.draw(in: NSRect(x: b.minX + p, y: hTop + (header * k - t.size().height) / 2 - 1 * k,
                          width: b.width - 2 * p - (moreW > 0 ? moreW + 8 * k : 0), height: t.size().height))
        let sep = dark ? NSColor(white: 1, alpha: 0.08) : NSColor(white: 0, alpha: 0.07)
        sep.setFill()
        NSRect(x: b.minX + p, y: hTop - 0.5, width: b.width - 2 * p, height: 0.5).fill()
        // tool row
        let tool = text("Permission \u{00B7} \(it.tool)", 11, .semibold, theme.fg2)
        let toolY = hTop - 6 * k - toolRow * k
        tool.draw(in: NSRect(x: b.minX + p, y: toolY + (toolRow * k - tool.size().height) / 2, width: b.width - 2 * p, height: tool.size().height))
        // summary box
        let sh = summaryH(it, k: k)
        let boxTop = toolY - 4 * k + 2 * k
        let box = NSRect(x: b.minX + p, y: boxTop - sh - 2 * boxPad * k, width: b.width - 2 * p, height: sh + 2 * boxPad * k)
        let bp = NSBezierPath(roundedRect: box, xRadius: 8 * k, yRadius: 8 * k)
        (dark ? NSColor(white: 1, alpha: 0.06) : NSColor(white: 0, alpha: 0.04)).setFill()
        bp.fill()
        // the text rect reaches 4 pt into the bottom padding so the last line is never clipped away
        let tr = box.insetBy(dx: boxPad * k, dy: boxPad * k)
        summaryText(it, theme.fg, k).draw(with: NSRect(x: tr.minX, y: tr.minY - 4 * k, width: tr.width, height: tr.height + 4 * k),
                                          options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        // Deny (glass) and Allow (accent orange)
        let deny = buttonRect(allow: false, in: b, k: k), allow = buttonRect(allow: true, in: b, k: k)
        let r = deny.height / 2
        let dp = NSBezierPath(roundedRect: deny.insetBy(dx: 0.5, dy: 0.5), xRadius: r, yRadius: r)
        (dark ? NSColor(white: 1, alpha: pressed == false ? 0.30 : 0.14) : NSColor(white: 0, alpha: pressed == false ? 0.16 : 0.06)).setFill()
        dp.fill()
        (dark ? NSColor(white: 1, alpha: 0.22) : NSColor(white: 0, alpha: 0.12)).setStroke()
        dp.lineWidth = 0.5
        dp.stroke()
        let dl = text("Deny", 12.5, .semibold, theme.fg, align: .center)
        dl.draw(in: NSRect(x: deny.minX, y: deny.midY - dl.size().height / 2, width: deny.width, height: dl.size().height))
        let ap = NSBezierPath(roundedRect: allow, xRadius: r, yRadius: r)
        (pressed == true ? PermitItem.orange.blended(withFraction: 0.2, of: .black) ?? PermitItem.orange : PermitItem.orange).setFill()
        ap.fill()
        let al = text("Allow", 12.5, .semibold, .white, align: .center)
        al.draw(in: NSRect(x: allow.minX, y: allow.midY - al.size().height / 2, width: allow.width, height: al.size().height))
    }
}

/// The hover controls and the muted badge. One drawing routine, shared by the live view and
/// the snapshot, so the PNG shows exactly what the card draws. Drawn as vectors at the
/// current size (SF Symbols at a computed point size), so they stay crisp at every scale.
final class GlassButton: NSView {
    static let red = NSColor(srgbRed: 1, green: 0x45 / 255.0, blue: 0x3a / 255.0, alpha: 1)   // systemRed, dark
    static let amber = NSColor(srgbRed: 1, green: 0xB0 / 255.0, blue: 0x20 / 255.0, alpha: 1)  // Thinking's #FFB020

    var symbol: String { didSet { if symbol != oldValue { needsDisplay = true } } }
    var tint: NSColor? { didSet { needsDisplay = true } }
    var theme = Theme.dark { didSet { needsDisplay = true } }
    var action: (() -> Void)?
    /// The badge is only a sign: it never takes a click, so the card under it still drags.
    var interactive = true
    private var pressed = false { didSet { if pressed != oldValue { needsDisplay = true } } }

    init(symbol: String, tip: String?) {
        self.symbol = symbol
        super.init(frame: .zero)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        toolTip = tip
        alphaValue = 0
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { false }
    override var mouseDownCanMoveWindow: Bool { false }          // a click here never drags the card
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func hitTest(_ p: NSPoint) -> NSView? { interactive && alphaValue > 0.01 ? super.hitTest(p) : nil }
    override func setFrameSize(_ s: NSSize) { super.setFrameSize(s); needsDisplay = true }

    override func mouseDown(with e: NSEvent) { pressed = true }
    override func mouseDragged(with e: NSEvent) { pressed = bounds.contains(convert(e.locationInWindow, from: nil)) }
    override func mouseUp(with e: NSEvent) {
        let inside = bounds.contains(convert(e.locationInWindow, from: nil))
        pressed = false
        if inside { action?() }
    }

    override func draw(_ dirty: NSRect) {
        GlassButton.paint(in: bounds, symbol: symbol, theme: theme, tint: tint, pressed: pressed)
    }

    static func paint(in b: NSRect, symbol: String, theme: Theme, tint: NSColor?, pressed: Bool) {
        let d = min(b.width, b.height)
        let circle = NSRect(x: b.midX - d / 2, y: b.midY - d / 2, width: d, height: d).insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(ovalIn: circle)
        let dark = theme.light < 0.5
        (dark ? NSColor(white: 1, alpha: pressed ? 0.30 : 0.17) : NSColor(white: 0, alpha: pressed ? 0.16 : 0.07)).setFill()
        path.fill()
        (dark ? NSColor(white: 1, alpha: 0.22) : NSColor(white: 0, alpha: 0.12)).setStroke()
        path.lineWidth = 0.5
        path.stroke()
        let cfg = NSImage.SymbolConfiguration(pointSize: d * 0.42, weight: .semibold)
            .applying(NSImage.SymbolConfiguration(paletteColors: [tint ?? theme.fg]))
        guard let img = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(cfg)
        else { return }
        let s = img.size
        img.draw(in: NSRect(x: b.midX - s.width / 2, y: b.midY - s.height / 2, width: s.width, height: s.height))
    }
}

final class PillView: NSView {
    static let layout = PillLayout.current
    static let size = layout.size
    static let minScale: CGFloat = 0.75, maxScale: CGFloat = 1.75
    let orb: OrbView
    let muteButton = GlassButton(symbol: "mic.fill", tip: "Mute")
    let stopButton = GlassButton(symbol: "stop.fill", tip: "Stop")
    let badge = GlassButton(symbol: "mic.slash.fill", tip: nil)
    let expandButton = GlassButton(symbol: "chevron.down", tip: "Waiting sessions")
    private var labels: [Phase: CATextLayer] = [:]
    private let labelBox = CALayer()
    private let timer = CATextLayer()
    private var theme = Theme.dark
    /// Everything is laid out at base size x `k`, fonts and symbols included, so nothing is
    /// ever a bitmap stretched to fit.
    private(set) var k: CGFloat = 1
    private var labelFont = NSFont.systemFont(ofSize: 13, weight: .semibold)
    private var timerFont = NSFont.monospacedDigitSystemFont(ofSize: PillView.layout.timerFontSize, weight: .medium)
    private var timerText = "0:00"
    private var tracking: NSTrackingArea?

    var onMute: ((Bool) -> Void)?       // argument: the state to switch to (true = mute)
    var onStop: (() -> Void)?
    var onZoom: ((CGFloat) -> Void)?    // additive change to the target scale
    var onExpand: (() -> Void)?         // toggle the waiting list

    /// Sessions waiting on the user. Above zero, the chevron stays up in amber even unhovered.
    var pendingCount = 0 {
        didSet { if pendingCount != oldValue { updateControls(animated: true) } }
    }
    var expanded = false {
        didSet { if expanded != oldValue { updateControls(animated: true) } }
    }

    var phase: Phase = .listening {
        didSet { if phase != oldValue { orb.model.target = phase; layoutLabels(animated: true) } }
    }
    var muted = false {
        didSet { if muted != oldValue { updateControls(animated: true) } }
    }
    private(set) var hovered = false {
        didSet { if hovered != oldValue { updateControls(animated: true) } }
    }

    init(renderer: OrbRenderer) {
        let L = PillView.layout
        orb = OrbView(frame: L.orbRect, renderer: renderer)
        super.init(frame: NSRect(origin: .zero, size: PillView.size))
        wantsLayer = true
        layer?.cornerRadius = L.cornerRadius
        layer?.borderWidth = 0.5
        addSubview(orb)
        labelBox.frame = bounds
        layer?.addSublayer(labelBox)
        for p in Phase.allCases {
            let t = CATextLayer()
            t.alignmentMode = L.labelAlign
            t.truncationMode = .none
            t.opacity = 0
            labels[p] = t
            labelBox.addSublayer(t)
        }
        timer.alignmentMode = L.timerAlign
        timer.isHidden = !PillLayout.showTimer
        layer?.addSublayer(timer)
        badge.interactive = false
        badge.tint = GlassButton.red
        for b in [badge, muteButton, stopButton, expandButton] { addSubview(b) }
        expandButton.action = { [weak self] in self?.onExpand?() }
        muteButton.action = { [weak self] in guard let self = self else { return }; self.onMute?(!self.muted) }
        stopButton.action = { [weak self] in self?.onStop?() }
        applyTheme(animated: false)
        orb.model.snapTo(.listening, light: theme.light)
        layoutLabels(animated: false)
        layoutControls()
        updateControls(animated: false)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var mouseDownCanMoveWindow: Bool { true }
    override var isFlipped: Bool { false }

    // MARK: hover

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = tracking { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                               owner: self, userInfo: nil)
        addTrackingArea(t)
        tracking = t
    }
    override func mouseEntered(with e: NSEvent) { hovered = true }
    override func mouseExited(with e: NSEvent) { hovered = false }
    /// After a resize or a move the pointer may be inside without an `entered` event.
    func refreshHover() {
        guard let w = window else { return }
        hovered = bounds.contains(convert(w.mouseLocationOutsideOfEventStream, from: nil))
    }

    // MARK: resize with the mouse

    override func scrollWheel(with e: NSEvent) {
        guard e.momentumPhase.isEmpty else { return }   // finger on the glass only, no coasting
        let dy = e.isDirectionInvertedFromDevice ? -e.scrollingDeltaY : e.scrollingDeltaY   // + = swipe up / wheel up
        guard dy != 0 else { return }
        onZoom?(e.hasPreciseScrollingDeltas ? dy * 0.005 : max(-0.15, min(0.15, dy * 0.05)))
    }
    override func magnify(with e: NSEvent) { onZoom?(e.magnification * k) }

    // MARK: layout

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyTheme(animated: true)
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        let s = window?.backingScaleFactor ?? 2
        CATransaction.begin(); CATransaction.setDisableActions(true)
        labels.values.forEach { $0.contentsScale = s }
        timer.contentsScale = s
        CATransaction.commit()
    }

    /// Re-lay the card at scale `k` inside `size` (the panel's pixel-rounded content size).
    func setScale(_ k: CGFloat, size: NSSize) {
        self.k = k
        let L = PillView.layout
        labelFont = NSFont.systemFont(ofSize: 13 * k, weight: .semibold)
        timerFont = NSFont.monospacedDigitSystemFont(ofSize: L.timerFontSize * k, weight: .medium)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        frame = NSRect(origin: .zero, size: size)
        layer?.cornerRadius = L.cornerRadius * k
        labelBox.frame = bounds
        orb.frame = sc(L.orbRect)
        CATransaction.commit()
        applyTheme(animated: false)
        layoutLabels(animated: false)
        layoutControls()
    }

    private func sc(_ r: NSRect) -> NSRect {
        NSRect(x: r.minX * k, y: r.minY * k, width: r.width * k, height: r.height * k)
    }

    private func layoutControls() {
        let L = PillView.layout
        muteButton.frame = sc(L.muteRect)
        stopButton.frame = sc(L.stopRect)
        badge.frame = sc(L.badgeRect)
        expandButton.frame = sc(L.expandRect)
    }

    /// Hover: the buttons fade in over the label row (.2 s), the label fades out. Muted and
    /// not hovered: a small red mic-slash badge in the top-right corner stays up.
    private func updateControls(animated: Bool) {
        muteButton.symbol = muted ? "mic.slash.fill" : "mic.fill"
        muteButton.tint = muted ? GlassButton.red : nil
        muteButton.toolTip = muted ? "Unmute" : "Mute"
        expandButton.symbol = expanded ? "chevron.up" : "chevron.down"
        expandButton.tint = pendingCount > 0 ? GlassButton.amber : nil
        expandButton.toolTip = pendingCount == 0 ? "Nothing waiting" : pendingCount == 1 ? "1 session waiting" : "\(pendingCount) sessions waiting"
        let show = hovered
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = animated ? 0.2 : 0
            ctx.allowsImplicitAnimation = true
            muteButton.animator().alphaValue = show ? 1 : 0
            stopButton.animator().alphaValue = show ? 1 : 0
            badge.animator().alphaValue = muted && !show ? 1 : 0
            expandButton.animator().alphaValue = show || pendingCount > 0 || expanded ? 1 : 0
        }
        CATransaction.begin()
        CATransaction.setDisableActions(!animated)
        CATransaction.setAnimationDuration(0.2)
        labelBox.opacity = show ? 0 : 1
        timer.opacity = show ? 0 : 1
        CATransaction.commit()
    }

    func setTimer(_ s: String) {
        guard s != timerText else { return }
        timerText = s
        CATransaction.begin(); CATransaction.setDisableActions(true)
        timer.string = attributed(s, font: timerFont, color: theme.fg2, kern: 0)
        CATransaction.commit()
    }

    private func attributed(_ s: String, font: NSFont, color: NSColor, kern: CGFloat) -> NSAttributedString {
        NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: color, .kern: kern])
    }

    private func applyTheme(animated: Bool) {
        theme = Theme.of(effectiveAppearance)
        orb.model.lightTarget = theme.light
        CATransaction.begin(); CATransaction.setDisableActions(!animated); CATransaction.setAnimationDuration(0.35)
        layer?.borderColor = theme.border.cgColor
        for (p, t) in labels {
            t.string = attributed(p.label, font: labelFont, color: theme.fg, kern: -0.13 * k)   // -0.01em
        }
        timer.string = attributed(timerText, font: timerFont, color: theme.fg2, kern: 0)
        CATransaction.commit()
        for b in [muteButton, stopButton, badge, expandButton] { b.theme = theme }
    }

    /// CSS: the active label centred in its box, the others 15% of their line box lower
    /// (translateY -35% vs -50%) and transparent; opacity and transform ease .35 s.
    private func layoutLabels(animated: Bool) {
        let L = PillView.layout
        let mid = L.labelMidY * k
        let line = ceil(labelFont.ascender - labelFont.descender)
        let drop: CGFloat = 0.15 * 13 * k * 1.45
        CATransaction.begin()
        CATransaction.setDisableActions(!animated)
        CATransaction.setAnimationDuration(0.35)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .default))   // CSS `ease`
        for (p, t) in labels {
            let on = p == phase
            t.frame = NSRect(x: L.labelX * k, y: mid - line / 2 - (on ? 0 : drop), width: L.labelWidth * k, height: line)
            t.opacity = on ? 1 : 0
        }
        let tl = ceil(timerFont.ascender - timerFont.descender)
        timer.frame = NSRect(x: L.timerX * k, y: L.timerMidY * k - tl / 2, width: L.timerWidth * k, height: tl)
        CATransaction.commit()
    }
}

// MARK: - Mic level meter

/// Taps the Mac's built-in mic (never the AirPods: opening their mic drops them to call
/// quality). A second tap on a device the ears already hold is fine on macOS.
final class MicMeter {
    private var engine: AVAudioEngine?
    private var observer: NSObjectProtocol?
    private let lock = NSLock()
    private var _level: Float = 0
    private var _lastBuffer: CFTimeInterval = 0
    private(set) var deviceName: String?
    private var wantName: String?
    private(set) var status = "idle"
    var running: Bool { engine != nil }

    /// Latest normalised level 0...1, or nil if no buffer arrived in the last second.
    var level: Float? {
        lock.lock(); defer { lock.unlock() }
        return CACurrentMediaTime() - _lastBuffer < 1.0 ? _level : nil
    }

    func start(preferring name: String?) {
        wantName = name
        guard !running else { return }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: begin()
        case .notDetermined:
            status = "asking"
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                DispatchQueue.main.async { if ok { self.begin() } else { self.status = "denied" } }
            }
        default: status = "denied"; return   // denied: the orb falls back to the simulated envelope
        }
    }

    func stop() {
        if let o = observer { NotificationCenter.default.removeObserver(o); observer = nil }
        guard let e = engine else { return }
        e.inputNode.removeTap(onBus: 0)
        e.stop()
        engine = nil
        deviceName = nil
    }

    /// A fresh engine per start: reusing one after a device or config change leaves a stale
    /// tap format, and installTap then throws an Objective-C exception Swift cannot catch.
    private func begin() {
        guard !running else { return }
        guard let dev = MicMeter.pickDevice(preferring: wantName) else { status = "no-device"; return }
        let e = AVAudioEngine()
        let input = e.inputNode
        guard let au = input.audioUnit else { return }
        var id = dev.id
        let st = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                      &id, UInt32(MemoryLayout<AudioDeviceID>.size))
        guard st == noErr else { status = "set-device \(st)"; return }
        let hw = input.inputFormat(forBus: 0)
        guard hw.sampleRate > 0, hw.channelCount > 0 else { status = "no-format"; return }
        input.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buf, _ in
            guard let self = self, let ch = buf.floatChannelData?[0] else { return }
            let n = Int(buf.frameLength)
            guard n > 0 else { return }
            var sum: Float = 0
            for i in 0..<n { sum += ch[i] * ch[i] }
            let rms = (sum / Float(n)).squareRoot()
            let db = 20 * log10(rms + 1e-9)
            let norm = max(0, min(1, (db + 55) / 40))   // prototype: -55 dBFS -> 0, -15 dBFS -> 1
            self.lock.lock()
            self._level = norm
            self._lastBuffer = CACurrentMediaTime()
            self.lock.unlock()
        }
        e.prepare()
        do { try e.start() } catch { input.removeTap(onBus: 0); status = "start: \(error.localizedDescription)"; return }
        status = "running \(Int(hw.sampleRate))Hz"
        engine = e
        deviceName = dev.name
        // Switching the device fires a config change by itself; only rebuild if buffers stopped.
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: e,
                                                          queue: .main) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                guard let self = self, self.running, self.level == nil else { return }
                self.stop(); self.start(preferring: self.wantName)
            }
        }
    }

    // Core Audio device lookup: the ears' device by name, else the built-in mic. Never Bluetooth.
    static func pickDevice(preferring name: String?) -> (id: AudioDeviceID, name: String)? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
                                              mScope: kAudioObjectPropertyScopeGlobal,
                                              mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        let sys = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(sys, &addr, 0, nil, &size) == noErr else { return nil }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(sys, &addr, 0, nil, &size, &ids) == noErr else { return nil }
        let inputs = ids.filter(hasInput).map { (id: $0, name: deviceName($0), transport: transport($0)) }
        let bt: Set<UInt32> = [kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE]
        if let name = name, let d = inputs.first(where: { $0.name == name && !bt.contains($0.transport) }) {
            return (d.id, d.name)
        }
        if let d = inputs.first(where: { $0.transport == kAudioDeviceTransportTypeBuiltIn }) { return (d.id, d.name) }
        return nil
    }

    private static func hasInput(_ id: AudioDeviceID) -> Bool {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams,
                                              mScope: kAudioDevicePropertyScopeInput,
                                              mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr && size > 0
    }

    private static func deviceName(_ id: AudioDeviceID) -> String {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName,
                                              mScope: kAudioObjectPropertyScopeGlobal,
                                              mElement: kAudioObjectPropertyElementMain)
        var name: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &name) == noErr,
              let cf = name?.takeRetainedValue() else { return "" }
        return cf as String
    }

    private static func transport(_ id: AudioDeviceID) -> UInt32 {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType,
                                              mScope: kAudioObjectPropertyScopeGlobal,
                                              mElement: kAudioObjectPropertyElementMain)
        var t: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &t)
        return t
    }
}

// MARK: - App: log reader + panel

final class Pill: NSObject, NSApplicationDelegate {
    let panel = NSPanel(contentRect: NSRect(origin: .zero, size: PillView.size),
                        styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    var view: PillView!
    let meter = MicMeter()
    let logDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".voicemode/logs/conversations")
    var trace: FileHandle?
    let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()

    var path: URL?
    var offset: UInt64 = 0
    var buffer = ""
    var lastPartial = Date.distantPast
    var speaking = false
    var thinking = false
    // Thinking follows the listener's verdicts (bin/listen.py touches ~/.voicemode/call/accepted
    // for each turn it passes on), not raw mic turns: on speakers most raw turns are my own echo.
    var sayingAt = Date()                       // launch counts as a reply, so old verdicts are ignored
    var thinkingSince = Date.distantPast
    var saidAt = Date.distantPast
    let acceptedURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".voicemode/call/accepted")
    let deviceURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".voicemode/call/device")
    var micOff = false
    var micDevice: String?
    var callStart = Date()
    // `call mute` / `call unmute` own this flag file; the pill only reads it (and shows the
    // click's result right away for 2 s, until the file catches up).
    let mutedURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".voicemode/call/muted")
    var muteClick: (state: Bool, at: Date)?
    // Card scale, 0.75...1.75, anchored top-right, persisted.
    var bg: NSVisualEffectView!
    var scale: CGFloat = 1, scaleTarget: CGFloat = 1
    var zoomTimer: Timer?
    static let scaleKey = "cardScale"
    // Waiting list: a child panel under the card, so it follows the card when dragged.
    var pending: [PendingItem] = []
    var listPanel: NSPanel?
    var listView: PendingListView?
    // Permission requests: a child panel LEFT of the card (the card never moves).
    var permits: [PermitItem] = []
    var answered: Set<String> = []
    var permitPanel: NSPanel?
    var permitView: PermitView?

    func applicationDidFinishLaunching(_ note: Notification) {
        guard let renderer = OrbRenderer() else { NSApp.terminate(nil); return }
        view = PillView(renderer: renderer)

        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true

        // Frosted vibrancy background (CSS: blur 30, saturate 180%, tinted, 0.5 px border).
        let bg = NSVisualEffectView(frame: NSRect(origin: .zero, size: PillView.size))
        bg.material = .hudWindow
        bg.blendingMode = .behindWindow
        bg.state = .active
        bg.wantsLayer = true
        bg.layer?.cornerRadius = PillView.layout.cornerRadius
        bg.layer?.masksToBounds = true
        panel.contentView = bg
        self.bg = bg
        bg.addSubview(view)
        view.orb.micLevel = { [weak self] in self?.meter.level }
        view.onMute = { [weak self] on in self?.setMuted(on) }
        view.onStop = { Pill.runCall("stopwork") }
        view.onZoom = { [weak self] d in self?.zoom(by: d) }
        view.onExpand = { [weak self] in self?.setExpanded(!(self?.view.expanded ?? false)) }

        let saved = UserDefaults.standard.double(forKey: Pill.scaleKey)
        scale = saved > 0 ? max(PillView.minScale, min(PillView.maxScale, CGFloat(saved))) : 1
        scaleTarget = scale
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            let S = scaledSize(scale, backing: screen.backingScaleFactor)
            panel.setContentSize(S)
            applyScale()
            switch PillView.layout {
            case .vertical:     // top-right, 16 pt in from both edges
                panel.setFrameOrigin(NSPoint(x: f.maxX - S.width - 16, y: f.maxY - S.height - 16))
            case .horizontal:   // top centre, as before
                panel.setFrameOrigin(NSPoint(x: f.midX - S.width / 2, y: f.maxY - S.height - 12))
            }
        }
        panel.orderFrontRegardless()
        panel.invalidateShadow()

        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--log"), i + 1 < args.count {
            FileManager.default.createFile(atPath: args[i + 1], contents: nil)
            trace = FileHandle(forWritingAtPath: args[i + 1])
        }

        micDevice = recentMicDevice()
        if let t = lastListenStarted() { callStart = t }
        openNewest(fromEnd: true)
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in self.tick() }
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in self.keepMeter() }
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in self.refreshPending() }
        refreshPending()
        render()
        keepMeter()
    }

    /// Run the meter only while the call's mic is live; restart it if it went quiet.
    func keepMeter() {
        if micOff { meter.stop(); return }
        if meter.running && meter.level == nil { meter.stop() }
        meter.start(preferring: micDevice)
    }

    /// The device the ears are using, from the newest mic line in the last 64 KB of the log.
    func recentMicDevice() -> String? {
        guard let newest = newestLog(), let fh = try? FileHandle(forReadingFrom: newest) else { return nil }
        defer { try? fh.close() }
        let size = (try? fh.seekToEnd()) ?? 0
        try? fh.seek(toOffset: size > 65536 ? size - 65536 : 0)
        let text = String(decoding: fh.readDataToEndOfFile(), as: UTF8.self)
        for line in text.split(separator: "\n").reversed() {
            if let o = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
               o["source"] as? String == "mic", let d = o["device"] as? String { return d }
        }
        return nil
    }

    /// Call start: the ears' last `listen-started` event, newest log first.
    func lastListenStarted() -> Date? {
        let logs = ((try? FileManager.default.contentsOfDirectory(at: logDir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasPrefix("heard_") && $0.pathExtension == "jsonl" }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }
        for url in logs.prefix(2) {
            guard let data = try? Data(contentsOf: url) else { continue }
            for line in String(decoding: data, as: UTF8.self).split(separator: "\n").reversed()
            where line.contains("\"listen-started\"") {
                if let o = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                   o["event"] as? String == "listen-started", let ts = o["ts"] as? String, let d = iso.date(from: ts) {
                    return d
                }
            }
        }
        return nil
    }

    func newestLog() -> URL? {
        (try? FileManager.default.contentsOfDirectory(at: logDir, includingPropertiesForKeys: nil))?
            .filter { $0.lastPathComponent.hasPrefix("heard_") && $0.pathExtension == "jsonl" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }.last
    }

    func openNewest(fromEnd: Bool) {
        guard let newest = newestLog(), newest != path else { return }
        path = newest
        let size = (try? FileManager.default.attributesOfItem(atPath: newest.path)[.size] as? UInt64) ?? 0
        offset = fromEnd ? size : 0
        buffer = ""
    }

    func tick() {
        openNewest(fromEnd: false)
        if let path = path, let fh = try? FileHandle(forReadingFrom: path) {
            try? fh.seek(toOffset: offset)
            let data = fh.readDataToEndOfFile()
            try? fh.close()
            offset += UInt64(data.count)
            buffer += String(decoding: data, as: UTF8.self)
            while let nl = buffer.firstIndex(of: "\n") {
                let line = String(buffer[..<nl])
                buffer.removeSubrange(...nl)
                handle(line)
            }
        }
        refreshPermits()
        render()
        let s = max(0, Int(Date().timeIntervalSince(callStart)))
        view.setTimer(String(format: "%d:%02d", s / 60, s % 60))
        if let t = trace {
            let lv = meter.level.map { String(format: "%.3f", $0) } ?? "nil"
            let line = String(format: "%.2f level=%@ orb=%.3f phase=%@ dev=%@ st=%@\n", Date().timeIntervalSince1970,
                              lv, view.orb.model.level, view.phase.label, meter.deviceName ?? "-", meter.status)
            t.write(Data(line.utf8))
        }
    }

    func handle(_ line: String) {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let kind = obj["kind"] as? String else { return }
        let source = obj["source"] as? String
        if source == "mic", let d = obj["device"] as? String, d != micDevice {
            micDevice = d; meter.stop(); keepMeter()
        }
        switch (kind, source) {
        case ("saying", "mouth"): speaking = true; thinking = false; sayingAt = Date()
        case ("said", "mouth"): speaking = false; saidAt = Date()
        case ("partial", "mic"):
            // on speakers the mic hears my tail for a few seconds after I stop: not him
            if !speaking && (onHeadphones() || Date().timeIntervalSince(saidAt) > 3.5) { lastPartial = Date() }
        case ("turn", "mic"): lastPartial = .distantPast
        case ("event", _):
            let ev = obj["event"] as? String
            if ev == "listen-started" {
                micOff = false; keepMeter()
                if let ts = obj["ts"] as? String, let d = iso.date(from: ts) { callStart = d }
            }
            if ev == "listen-stopped" { micOff = true; speaking = false; thinking = false; keepMeter() }
        default: break
        }
    }

    func onHeadphones() -> Bool {
        let name = (try? String(contentsOf: deviceURL, encoding: .utf8)) ?? ""
        return name.range(of: "airpods|headphone|headset|buds|beats", options: [.regularExpression, .caseInsensitive]) != nil
    }

    // MARK: hover controls

    /// `call <arg>` through a login shell (PATH), off the main thread, output discarded.
    static func runCall(_ arg: String) {
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = ["-lc", "\"$HOME/.claude/skills/colleague/bin/call\" \(arg)"]
            p.standardInput = FileHandle.nullDevice
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            do { try p.run(); p.waitUntilExit() }
            catch { FileHandle.standardError.write(Data("call \(arg): \(error)\n".utf8)) }
        }
    }

    func setMuted(_ on: Bool) {
        muteClick = (on, Date())
        Pill.runCall(on ? "mute" : "unmute")
        render()
    }

    var isMuted: Bool {
        if let c = muteClick, Date().timeIntervalSince(c.at) < 2 { return c.state }
        return FileManager.default.fileExists(atPath: mutedURL.path)
    }

    // MARK: waiting list (open only: the pill never answers a prompt)

    func refreshPending() {
        // a session whose permission prompt is on the pill is not listed twice
        let asking = Set(permits.map { $0.sessionId })
        let items = PendingItem.load().filter { !asking.contains($0.sessionId) }
        if items != pending { pending = items; view.pendingCount = items.count }
        if let lv = listView, view.expanded {
            if lv.items != items { lv.items = items; positionList() } else { lv.needsDisplay = true }   // ages tick
        }
    }

    func setExpanded(_ on: Bool) {
        view.expanded = on
        if on {
            let lv = listView ?? PendingListView(frame: .zero)
            lv.onOpen = { [weak self] it in self?.open(it) }
            let lp = listPanel ?? NSPanel(contentRect: .zero, styleMask: [.nonactivatingPanel, .borderless],
                                          backing: .buffered, defer: false)
            if listPanel == nil {
                lp.level = .statusBar
                lp.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
                lp.isOpaque = false
                lp.backgroundColor = .clear
                lp.hasShadow = true
                lp.becomesKeyOnlyIfNeeded = true
                let fx = NSVisualEffectView()
                fx.material = .hudWindow
                fx.blendingMode = .behindWindow
                fx.state = .active
                fx.wantsLayer = true
                fx.layer?.masksToBounds = true
                fx.layer?.borderWidth = 0.5
                fx.addSubview(lv)
                lp.contentView = fx
                listPanel = lp; listView = lv
            }
            lv.items = pending
            lv.theme = Theme.of(lv.effectiveAppearance)
            positionList()
            lp.orderFrontRegardless()
            panel.addChildWindow(lp, ordered: .above)
        } else if let lp = listPanel {
            panel.removeChildWindow(lp)
            lp.orderOut(nil)
        }
    }

    /// Under the card, right edges aligned (the card lives top-right); above it when there is
    /// no room below; always inside the screen.
    func positionList() {
        guard let lp = listPanel, let lv = listView, let fx = lp.contentView else { return }
        let S = PendingListView.size(for: pending.count, k: scale)
        let f = panel.frame
        let vis = (panel.screen ?? NSScreen.main)?.visibleFrame ?? f
        var x = f.maxX - S.width
        x = max(vis.minX + 8, min(vis.maxX - S.width - 8, x))
        // below the card, and below the permission panel too while one is up
        var bottom = f.minY
        if let pp = permitPanel, pp.isVisible, !permits.isEmpty { bottom = min(bottom, pp.frame.minY) }
        var y = bottom - 8 - S.height
        if y < vis.minY + 8 { y = f.maxY + 8 }
        lp.setFrame(NSRect(x: x, y: y, width: S.width, height: S.height), display: true)
        fx.frame = NSRect(origin: .zero, size: S)
        fx.layer?.cornerRadius = 16 * scale
        fx.layer?.borderColor = Theme.of(fx.effectiveAppearance).border.cgColor
        lv.frame = fx.bounds
        lv.k = scale
        lp.invalidateShadow()
    }

    // MARK: permission requests (answered only by a click on Allow / Deny)

    func refreshPermits() {
        let all = PermitItem.load()
        answered.formIntersection(all.map { $0.id })        // forget ids whose hook has finished
        let items = all.filter { !answered.contains($0.id) }
        guard items != permits else { return }
        let hadAny = !permits.isEmpty
        permits = items
        if let first = items.first {
            showPermit(first, more: items.count - 1)
        } else if let pp = permitPanel {
            panel.removeChildWindow(pp)
            pp.orderOut(nil)
            permitView?.item = nil
        }
        if hadAny != !items.isEmpty { refreshPending() }
        if view.expanded { positionList() }
        render()
    }

    func showPermit(_ it: PermitItem, more: Int) {
        let pv = permitView ?? PermitView(frame: .zero)
        let pp = permitPanel ?? NSPanel(contentRect: .zero, styleMask: [.nonactivatingPanel, .borderless],
                                        backing: .buffered, defer: false)
        if permitPanel == nil {
            pp.level = .statusBar
            pp.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            pp.isOpaque = false
            pp.backgroundColor = .clear
            pp.hasShadow = true
            pp.becomesKeyOnlyIfNeeded = true
            let fx = NSVisualEffectView()
            fx.material = .hudWindow
            fx.blendingMode = .behindWindow
            fx.state = .active
            fx.wantsLayer = true
            fx.layer?.masksToBounds = true
            fx.layer?.borderWidth = 0.5
            fx.addSubview(pv)
            pp.contentView = fx
            pv.onAnswer = { [weak self] it, allow in self?.answerPermit(it, allow: allow) }
            permitPanel = pp; permitView = pv
        }
        pv.item = it
        pv.more = more
        pv.theme = Theme.of(pv.effectiveAppearance)
        positionPermit()
        if pp.parent == nil {
            pp.orderFrontRegardless()
            panel.addChildWindow(pp, ordered: .above)
        }
    }

    /// Left of the card, tops aligned; on the right only when the card sits at the left edge.
    func positionPermit() {
        guard let pp = permitPanel, let pv = permitView, let it = pv.item, let fx = pp.contentView else { return }
        let S = PermitView.size(for: it, k: scale)
        let f = panel.frame
        let vis = (panel.screen ?? NSScreen.main)?.visibleFrame ?? f
        var x = f.minX - 8 - S.width
        if x < vis.minX + 8 { x = f.maxX + 8 }
        var y = f.maxY - S.height
        y = max(vis.minY + 8, y)
        pp.setFrame(NSRect(x: x, y: y, width: S.width, height: S.height), display: true)
        fx.frame = NSRect(origin: .zero, size: S)
        fx.layer?.cornerRadius = 16 * scale
        fx.layer?.borderColor = Theme.of(fx.effectiveAppearance).border.cgColor
        pv.frame = fx.bounds
        pv.k = scale
        pp.invalidateShadow()
    }

    func answerPermit(_ it: PermitItem, allow: Bool) {
        guard it.answer(allow) else { return }
        answered.insert(it.id)
        refreshPermits()        // the answered id is filtered out: next request, or collapse
    }

    func open(_ it: PendingItem) {
        guard let url = it.openURL else { return }
        NSWorkspace.shared.open(url)
        setExpanded(false)
    }

    // MARK: resize

    func scaledSize(_ k: CGFloat, backing bs: CGFloat) -> NSSize {
        let S = PillView.size
        return NSSize(width: (S.width * k * bs).rounded() / bs, height: (S.height * k * bs).rounded() / bs)
    }

    func zoom(by d: CGFloat) {
        scaleTarget = max(PillView.minScale, min(PillView.maxScale, scaleTarget + d))
        UserDefaults.standard.set(Double(scaleTarget), forKey: Pill.scaleKey)
        guard zoomTimer == nil else { return }
        let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.zoomStep() }
        RunLoop.main.add(t, forMode: .common)
        zoomTimer = t
    }

    /// Ease toward the target (~90 ms time constant), re-laying the card each frame.
    func zoomStep() {
        scale += (scaleTarget - scale) * 0.17
        if abs(scaleTarget - scale) < 0.002 {
            scale = scaleTarget
            zoomTimer?.invalidate(); zoomTimer = nil
        }
        let f = panel.frame
        let S = scaledSize(scale, backing: panel.backingScaleFactor)
        panel.setFrame(NSRect(x: f.maxX - S.width, y: f.maxY - S.height, width: S.width, height: S.height), display: false)
        applyScale()
        if !permits.isEmpty { positionPermit() }
        if view.expanded { positionList() }
        if zoomTimer == nil { view.refreshHover() }
    }

    func applyScale() {
        bg.layer?.cornerRadius = PillView.layout.cornerRadius * scale
        view.setScale(scale, size: bg.bounds.size)
        panel.invalidateShadow()
    }

    func render() {
        if let a = (try? FileManager.default.attributesOfItem(atPath: acceptedURL.path))?[.modificationDate] as? Date,
           a > sayingAt, !thinking {
            thinking = true; thinkingSince = a
        }
        // a reply that only went to the chat never produces 'saying'; do not stay stuck
        if thinking && Date().timeIntervalSince(thinkingSince) > 45 { thinking = false; sayingAt = Date() }
        let muted = isMuted
        view.muted = muted
        let next: Phase
        if muted { next = .muted }          // `call mute` also stops the ears: Muted wins over Mic off
        else if micOff { next = .off }
        else if speaking { next = .claude }
        else if Date().timeIntervalSince(lastPartial) < 1.5 { next = .you }
        else if thinking || !permits.isEmpty { next = .thinking }   // a permission request waits
        else { next = .listening }
        view.phase = next
    }
}

// MARK: - Snapshot mode: every phase through the real Metal shader, into one PNG

func renderOrb(_ r: OrbRenderer, _ m: OrbModel, px: Int, radius: Float) -> CGImage? {
    let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: px, height: px, mipmapped: false)
    d.usage = [.renderTarget, .shaderRead]
    d.storageMode = .shared
    guard let tex = r.device.makeTexture(descriptor: d), let cb = r.queue.makeCommandBuffer() else { return nil }
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = tex
    r.encode(cb, pass, m.uniforms(res: SIMD2(Float(px), Float(px)), radius: radius))
    cb.commit(); cb.waitUntilCompleted()
    var bytes = [UInt8](repeating: 0, count: px * px * 4)
    tex.getBytes(&bytes, bytesPerRow: px * 4, from: MTLRegionMake2D(0, 0, px, px), mipmapLevel: 0)
    guard let ctx = CGContext(data: &bytes, width: px, height: px, bitsPerComponent: 8, bytesPerRow: px * 4,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    return ctx.makeImage()
}

/// One card, drawn the way PillView lays it out at scale `k`: frosted body, orb through the
/// real shader, label (or the hover buttons), and the muted badge.
func drawCard(_ ctx: CGContext, _ r: OrbRenderer, _ m: OrbModel, at o: NSPoint, k: CGFloat, px: CGFloat,
              label: String, hovered: Bool, muted: Bool, pending: Int = 0, expanded: Bool = false) {
    let L = PillView.layout, S = L.size
    func sc(_ q: NSRect) -> NSRect { NSRect(x: o.x + q.minX * k, y: o.y + q.minY * k, width: q.width * k, height: q.height * k) }
    let card = NSBezierPath(roundedRect: NSRect(x: o.x, y: o.y, width: S.width * k, height: S.height * k),
                            xRadius: L.cornerRadius * k, yRadius: L.cornerRadius * k)
    NSColor(srgbRed: 30 / 255.0, green: 30 / 255.0, blue: 36 / 255.0, alpha: 0.9).setFill(); card.fill()
    NSColor(white: 1, alpha: 0.14).setStroke(); card.lineWidth = 0.5; card.stroke()
    let orb = sc(L.orbRect)
    if let img = renderOrb(r, m, px: Int(orb.width * px), radius: OrbView.radius) { ctx.draw(img, in: orb) }
    if hovered {
        GlassButton.paint(in: sc(L.muteRect), symbol: muted ? "mic.slash.fill" : "mic.fill", theme: .dark,
                          tint: muted ? GlassButton.red : nil, pressed: false)
        GlassButton.paint(in: sc(L.stopRect), symbol: "stop.fill", theme: .dark, tint: nil, pressed: false)
    } else {
        let f = NSFont.systemFont(ofSize: 13 * k, weight: .semibold)
        let s = NSAttributedString(string: label, attributes: [.font: f, .foregroundColor: Theme.dark.fg, .kern: -0.13 * k])
        let sx = L.labelAlign == .center ? L.labelX * k + (L.labelWidth * k - s.size().width) / 2 : L.labelX * k
        s.draw(at: NSPoint(x: o.x + sx, y: o.y + L.labelMidY * k - s.size().height / 2))
        if PillLayout.showTimer {
            let t = NSAttributedString(string: "3:07", attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: L.timerFontSize * k, weight: .medium),
                                                                   .foregroundColor: Theme.dark.fg2])
            let tx = L.timerAlign == .center ? L.timerX * k + (L.timerWidth * k - t.size().width) / 2
                                             : L.timerX * k + L.timerWidth * k - t.size().width
            t.draw(at: NSPoint(x: o.x + tx, y: o.y + L.timerMidY * k - t.size().height / 2))
        }
        if muted { GlassButton.paint(in: sc(L.badgeRect), symbol: "mic.slash.fill", theme: .dark, tint: GlassButton.red, pressed: false) }
    }
    if hovered || pending > 0 || expanded {
        GlassButton.paint(in: sc(L.expandRect), symbol: expanded ? "chevron.up" : "chevron.down", theme: .dark,
                          tint: pending > 0 ? GlassButton.amber : nil, pressed: false)
    }
}

func snapshot(to out: String) {
    guard let r = OrbRenderer() else { print("no Metal"); return }
    let scale: CGFloat = 3, pad: CGFloat = 16, big: CGFloat = 120
    let S = PillView.layout.size
    let cases: [(Phase, Float?)] = [(.listening, 0.1), (.you, 0.8), (.thinking, nil), (.claude, nil), (.off, nil)]
    // Extra row: hovered, muted, muted + hovered at 1x, then hovered at max and muted at min scale.
    let extras: [(Phase, Bool, Bool, CGFloat)] = [(.listening, true, false, 1), (.muted, false, true, 1), (.muted, true, true, 1),
                                                  (.claude, true, false, PillView.maxScale), (.muted, false, true, PillView.minScale)]
    let rowH = max(S.height, big) + pad
    let extraW = extras.reduce(pad) { $0 + S.width * $1.3 + pad }
    let extraH = S.height * PillView.maxScale + pad
    // Waiting row: card with the amber chevron, card hovered + expanded, and the list itself.
    let items = PendingItem.load()
    let LS = PendingListView.size(for: items.count, k: 1)
    let waitH = max(S.height, S.height + 8 + LS.height) + pad
    let waitW = pad + S.width + pad + max(S.width, LS.width) + pad
    // Permission row (bottom): the card in Thinking with the permission panel grown to its left,
    // once for a Bash command with two more queued, once for an MCP call. Reads
    // CALLPILL_PERMIT_DIR when it holds requests, otherwise uses built-in fakes.
    let now = Date()
    var permits = PermitItem.load(from: PermitItem.dir, now: now)
    if permits.isEmpty {
        permits = [
            PermitItem(id: "a1", sessionId: "s1", title: "Call pill: answer permission prompts", cwd: "~/.claude",
                       tool: "Bash", summary: "Rebuild the pill and relaunch it\nswiftc -O pill.swift -o pill -framework Metal -framework MetalKit && cp pill CallPill.app/Contents/MacOS/CallPill && codesign -f -s - -i dev.cludegods.callpill CallPill.app",
                       mono: true, pid: 0, created: now),
            PermitItem(id: "a2", sessionId: "s2", title: "", cwd: "~/Projects/example", tool: "Edit",
                       summary: "~/Projects/example/README.md", mono: true, pid: 0, created: now),
            PermitItem(id: "a3", sessionId: "s3", title: "", cwd: "/tmp", tool: "Write", summary: "/tmp/x", mono: true, pid: 0, created: now),
        ]
    }
    let mcp = PermitItem(id: "b1", sessionId: "s4", title: "Weekly newsletter", cwd: "", tool: "mcp__example__schedule_post",
                         summary: "schedule_post (example)\npost_id: 8f2c1a\nscheduled_at: 2026-11-02T12:00:00Z", mono: false, pid: 0, created: now)
    let P1 = PermitView.size(for: permits[0], k: 1), P2 = PermitView.size(for: mcp, k: 1)
    let permitH = max(P1.height, P2.height, S.height) + pad
    let permitW = pad + P1.width + 8 + S.width + pad + P2.width + 8 + S.width + pad
    let H0 = rowH * CGFloat(cases.count) + pad + extraH + waitH
    let W = max(pad + S.width + pad + big + pad, extraW, waitW, permitW), H = H0 + permitH
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W * scale), pixelsHigh: Int(H * scale),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: W, height: H)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    NSColor(srgbRed: 0x0c / 255.0, green: 0x0f / 255.0, blue: 0x1e / 255.0, alpha: 1).setFill()   // prototype wall base
    NSRect(x: 0, y: 0, width: W, height: H).fill()
    var px0 = pad
    for (it, more, PS) in [(permits[0], permits.count - 1, P1), (mcp, 0, P2)] {
        let top = permitH - pad
        let pr = NSRect(x: px0, y: top - PS.height, width: PS.width, height: PS.height)
        let body = NSBezierPath(roundedRect: pr, xRadius: 16, yRadius: 16)
        NSColor(srgbRed: 30 / 255.0, green: 30 / 255.0, blue: 36 / 255.0, alpha: 0.9).setFill(); body.fill()
        NSColor(white: 1, alpha: 0.14).setStroke(); body.lineWidth = 0.5; body.stroke()
        PermitView.paint(in: pr, item: it, more: more, theme: .dark, k: 1, pressed: nil)
        let m = OrbModel(); m.snapTo(.thinking, light: 0); for _ in 0..<240 { m.advance(1.0 / 60, mic: nil) }
        drawCard(ctx, r, m, at: NSPoint(x: px0 + PS.width + 8, y: top - S.height), k: 1, px: scale,
                 label: Phase.thinking.label, hovered: false, muted: false)
        px0 += PS.width + 8 + S.width + pad
    }
    ctx.saveGState()
    ctx.translateBy(x: 0, y: permitH)
    func model(_ p: Phase, _ mic: Float?) -> OrbModel {
        let m = OrbModel()
        m.snapTo(p, light: 0)
        for _ in 0..<240 { m.advance(1.0 / 60, mic: mic) }
        return m
    }
    for (i, cfg) in cases.enumerated() {
        let m = model(cfg.0, cfg.1)
        let y0 = H0 - pad - rowH * CGFloat(i + 1) + pad
        let py = y0 + (big - S.height) / 2
        drawCard(ctx, r, m, at: NSPoint(x: pad, y: py), k: 1, px: scale, label: cfg.0.label, hovered: false, muted: false)
        if let img = renderOrb(r, m, px: Int(big * scale), radius: 0.58) {
            ctx.draw(img, in: CGRect(x: pad + S.width + pad, y: y0, width: big, height: big))
        }
    }
    var x = pad
    for e in extras {
        drawCard(ctx, r, model(e.0, nil), at: NSPoint(x: x, y: waitH + extraH - S.height * e.3), k: e.3, px: scale,
                 label: e.0.label, hovered: e.1, muted: e.2)
        x += S.width * e.3 + pad
    }
    let wTop = waitH - pad
    drawCard(ctx, r, model(.listening, 0.1), at: NSPoint(x: pad, y: wTop - S.height), k: 1, px: scale,
             label: Phase.listening.label, hovered: false, muted: false, pending: items.count)
    let x2 = pad + S.width + pad
    let lx = x2 + S.width - LS.width   // right edges aligned, as live
    let cardX = max(x2, x2 + LS.width - S.width)
    drawCard(ctx, r, model(.listening, 0.1), at: NSPoint(x: cardX, y: wTop - S.height), k: 1, px: scale,
             label: Phase.listening.label, hovered: true, muted: false, pending: items.count, expanded: true)
    let lr = NSRect(x: max(x2, lx), y: wTop - S.height - 8 - LS.height, width: LS.width, height: LS.height)
    let body = NSBezierPath(roundedRect: lr, xRadius: 16, yRadius: 16)
    NSColor(srgbRed: 30 / 255.0, green: 30 / 255.0, blue: 36 / 255.0, alpha: 0.9).setFill(); body.fill()
    NSColor(white: 1, alpha: 0.14).setStroke(); body.lineWidth = 0.5; body.stroke()
    PendingListView.paint(in: lr, items: items, theme: .dark, k: 1, pressed: nil, now: Date())
    ctx.restoreGState()
    NSGraphicsContext.restoreGraphicsState()
    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: out))
}

let args = CommandLine.arguments
if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
    snapshot(to: args[i + 1])
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Pill()
app.delegate = delegate
app.run()
