// pill: CallPill, the floating call card for the voice call (CludeGods v0.2).
//
// The launch film's call card, native: a white rounded card (the dark card in Dark Mode) with
// an orange dot and the speaker's name, the god in the middle, one caption line under it, and
// two round buttons, mic and stop. Permission requests grow a card to its LEFT. Always on top,
// on every Space, draggable; `call start` launches it, `call stop` quits it.
//
// The god:   sprite strips from bin/gods/<kind>-<state>.png + index.json (rendered from the
//            film's gods.js; each a horizontal strip of square frames). Animated by stepping the
//            CALayer contentsRect at the strip's fps: no Metal, no drawing per frame.
//            listening -> idle, you talking -> listen, thinking -> work, Claude talking -> talk,
//            a reply just finished -> happy (one loop). Kind is `colleague`, unless
//            ~/.voicemode/call/focus names a worker: then that worker's "god" (and "name" for the
//            title) from workers.json; no "god": derived from its "avatar" colour. Missing strips
//            leave the space empty and are retried every 2 s (no stand-in character is drawn).
// State:     the VoiceMode heard log (~/.voicemode/logs/conversations/heard_*.jsonl): mouth
//            `saying` (its text is the caption) and `said`, mic `partial`/`turn` (You), ears
//            `listen-started`/`listen-stopped` (Mic off). Thinking follows bin/listen.py's verdicts
//            (~/.voicemode/call/accepted), not raw mic turns: on speakers most raw turns are echo.
//            ~/.voicemode/call/muted present = Muted (red mic-slash on the mic button).
// Buttons:   mic = `call mute` / `call unmute`; stop = `call stopwork`. Always visible.
// Compact:   the arrows button (top-right, on hover) folds the card to just the god + mic/stop,
//            and back. Kept in UserDefaults.
// Resize:    scroll or pinch over the card, 0.6x...1.75x, top-right anchored, kept in UserDefaults.
// Timer:     off (the call runs all day). CALLPILL_TIMER=on shows it top-right, mono.
// Waiting:   a chevron (header, on hover; stays up in amber while anything waits) opens a list
//            under the card of sessions waiting on a decision or an answer, read from
//            ~/.voicemode/call/pending/*.json (written by an optional Notification hook; see README). Each
//            row has Open, which opens that session's claude:// link and nothing else. The list
//            NEVER answers a prompt. CALLPILL_PENDING_DIR overrides the directory.
// Permits:   bin/permit (the PermissionRequest hook) writes ~/.voicemode/call/permit/<id>.json and
//            waits for <id>.answer. While any exist, a card grows LEFT of the call card (the call
//            card does not move): "Claude wants to run", the command in a mono box (other tools:
//            the tool name and its main argument), Deny and Allow. Oldest first, "+N more". A mouse
//            click on a button is the ONLY writer of <id>.answer (atomic); no keyboard path, no
//            voice path, and clicks are ignored for 0.6 s after a request appears. Then
//            "Allowed" / "Denied" for a moment and the card leaves. Requests whose hook process has
//            exited are dropped. CALLPILL_PERMIT_DIR overrides the directory.
// Theme:     follows the system appearance; CALLPILL_APPEARANCE=light|dark forces one.
//
// Build:     swiftc -O pill.swift -o pill        (AppKit, QuartzCore, ImageIO; nothing else)
// Bundle:    scripts/build-pill.sh does the rest: copy into CallPill.app/Contents/MacOS/CallPill
//            and ad-hoc sign with a fixed identifier and designated requirement, so macOS keeps the
//            app's grants across rebuilds.
// Snapshot:  ./pill --snapshot out.png   (every state, light and dark, into one PNG; no window)
// Demo:      CALLPILL_DEMO=<listening|you|thinking|claude|muted|off|happy> ./pill   (a fixed state for
//            screenshots: never reads the logs, never runs `call`, saves nothing). Extras:
//            CALLPILL_DEMO_LINE (caption), CALLPILL_DEMO_EXPAND=1 (list open), CALLPILL_DEMO_HOVER=1,
//            CALLPILL_DEMO_COMPACT=1, CALLPILL_DEMO_AT=right,top (inset from the screen's top-right),
//            CALLPILL_CALL_DIR (read focus, workers.json, muted, pending/ and permit/ from there).
// Tests:     CALLPILL_CALL_DIR and CALLPILL_LOG_DIR (the heard_*.jsonl directory) also work outside
//            demo mode, to drive every state from fake files.
// Debug:     open -g CallPill.app --args --log /path/state.log   (10 Hz state trace)

import AppKit
import QuartzCore
import ImageIO

// MARK: - Paths and environment

let env = ProcessInfo.processInfo.environment
let home = FileManager.default.homeDirectoryForCurrentUser

func expand(_ p: String) -> URL { URL(fileURLWithPath: (p as NSString).expandingTildeInPath) }

/// ~/.voicemode/call, or CALLPILL_CALL_DIR (demo and tests).
let callDir: URL = env["CALLPILL_CALL_DIR"].map(expand) ?? home.appendingPathComponent(".voicemode/call")

// MARK: - Palette (SPEC §1, the film's claude-ui.js values)

func rgb(_ v: UInt32, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
            blue: CGFloat(v & 0xFF) / 255, alpha: a)
}

struct Theme {
    let isDark: Bool
    let cardTop: NSColor, cardBottom: NSColor, border: NSColor, border2: NSColor
    let text: NSColor, sub: NSColor, faint: NSColor, side: NSColor
    let accent: NSColor, accentSoft: NSColor, green: NSColor, amber: NSColor, red: NSColor
    let micFill: NSColor, micStroke: NSColor, mutedFill: NSColor, mutedStroke: NSColor
    let stopFill: NSColor, stopStroke: NSColor, stopIcon: NSColor
    let buttonFill: NSColor, glassFill: NSColor, glassStroke: NSColor, pressed: NSColor

    static let light = Theme(
        isDark: false,
        cardTop: .white, cardBottom: .white, border: rgb(0xe8e6dc), border2: rgb(0xdedcd1),
        text: rgb(0x1f1e1d), sub: rgb(0x73726c), faint: rgb(0x9a988f), side: rgb(0xf5f4ef),
        accent: rgb(0xc96442), accentSoft: rgb(0xfbe9e5), green: rgb(0x2f8f5b), amber: rgb(0xb7791f), red: rgb(0xc2412d),
        micFill: .white, micStroke: rgb(0xdedcd1), mutedFill: rgb(0xfbe9e5), mutedStroke: rgb(0xf1cfc6),
        stopFill: rgb(0xfbe9e5), stopStroke: rgb(0xf1cfc6), stopIcon: rgb(0xc2412d),
        buttonFill: .white, glassFill: rgb(0xf5f4ef), glassStroke: rgb(0xe8e6dc), pressed: NSColor(white: 0, alpha: 0.07))

    static let dark = Theme(
        isDark: true,
        cardTop: rgb(0x1b1b24), cardBottom: rgb(0x121219), border: NSColor(white: 1, alpha: 0.10),
        border2: NSColor(white: 1, alpha: 0.16),
        text: rgb(0xf4f3ef), sub: rgb(0xebebf5, 0.62), faint: rgb(0xebebf5, 0.40), side: NSColor(white: 1, alpha: 0.06),
        accent: rgb(0xc96442), accentSoft: rgb(0xc96442, 0.24), green: rgb(0x4cb782), amber: rgb(0xe0a43a), red: rgb(0xef5a4c),
        micFill: NSColor(white: 1, alpha: 0.08), micStroke: NSColor(white: 1, alpha: 0.14),
        mutedFill: rgb(0xef5a4c, 0.18), mutedStroke: rgb(0xef5a4c, 0.40),
        stopFill: rgb(0xe5484d), stopStroke: rgb(0xe5484d), stopIcon: .white,
        buttonFill: NSColor(white: 1, alpha: 0.06), glassFill: NSColor(white: 1, alpha: 0.08),
        glassStroke: NSColor(white: 1, alpha: 0.12), pressed: NSColor(white: 1, alpha: 0.12))

    static func of(_ a: NSAppearance) -> Theme {
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? .dark : .light
    }
}

// MARK: - Drawing helpers (every view is flipped: y grows down, like the film's CSS)

func attr(_ s: String, _ font: NSFont, _ c: NSColor, align: NSTextAlignment = .left,
          wrap: NSLineBreakMode = .byTruncatingTail) -> NSAttributedString {
    let ps = NSMutableParagraphStyle()
    ps.alignment = align
    ps.lineBreakMode = wrap
    return NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: c, .paragraphStyle: ps])
}

/// One line of text, vertically centred on `midY`, clipped to `width`.
func drawLine(_ s: NSAttributedString, x: CGFloat, midY: CGFloat, width: CGFloat) {
    let h = ceil(s.size().height)
    s.draw(with: NSRect(x: x, y: midY - h / 2, width: max(0, width), height: h),
           options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
}

func drawSymbol(_ name: String, size: CGFloat, weight: NSFont.Weight, color: NSColor, center: NSPoint) {
    let cfg = NSImage.SymbolConfiguration(pointSize: size, weight: weight)
        .applying(NSImage.SymbolConfiguration(paletteColors: [color]))
    guard let img = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(cfg) else { return }
    let s = img.size
    img.draw(in: NSRect(x: center.x - s.width / 2, y: center.y - s.height / 2, width: s.width, height: s.height),
             from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
}

/// The card body: white, 1 px border (dark: the film's dark gradient, top to bottom).
func paintCardBody(_ b: NSRect, radius: CGFloat, theme t: Theme) {
    let p = NSBezierPath(roundedRect: b.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
    if t.isDark {
        NSGradient(starting: t.cardTop, ending: t.cardBottom)?.draw(in: p, angle: 90)   // flipped: 90 = top -> bottom
    } else {
        t.cardTop.setFill(); p.fill()
    }
    t.border.setStroke()
    p.lineWidth = 1
    p.stroke()
}

/// A small outlined or filled text button (Deny / Allow / Open), the film's .cui-btn.
func paintTextButton(_ r: NSRect, _ label: String, primary: Bool, pressed: Bool, theme t: Theme, k: CGFloat) {
    let p = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), xRadius: 7 * k, yRadius: 7 * k)
    if primary {
        (pressed ? (t.accent.blended(withFraction: 0.18, of: .black) ?? t.accent) : t.accent).setFill()
        p.fill()
    } else {
        t.buttonFill.setFill(); p.fill()
        if pressed { t.pressed.setFill(); p.fill() }
        t.border2.setStroke(); p.lineWidth = 1; p.stroke()
    }
    let s = attr(label, .systemFont(ofSize: 12.5 * k, weight: .medium), primary ? .white : t.text, align: .center)
    drawLine(s, x: r.minX, midY: r.midY, width: r.width)
}

// MARK: - Gods (sprite strips rendered by track A from the film's gods.js)

enum GodState: String, CaseIterable { case idle, talk, listen, work, happy }
let godKinds: Set<String> = ["colleague", "research", "scribe", "scout", "sales", "herald"]

final class Sprites {
    static let shared = Sprites()
    private(set) var fps: Double = 12
    /// index.json `box`: the frame is `box` x the sphere's diameter, sphere centred.
    private(set) var box: CGFloat = 1.6
    private var metaLoaded = false
    private var cache: [String: CGImage] = [:]

    /// CALLPILL_GODS_DIR, else `gods/` next to the app (bin/CallPill.app -> bin/gods) or next to
    /// the bare binary, else the installed skill's bin/gods.
    var dir: URL {
        if let e = env["CALLPILL_GODS_DIR"] { return expand(e) }
        let b = Bundle.main.bundleURL
        let beside = (b.pathExtension == "app" ? b.deletingLastPathComponent() : b).appendingPathComponent("gods")
        if FileManager.default.fileExists(atPath: beside.path) { return beside }
        return home.appendingPathComponent(".claude/skills/gods/bin/gods")
    }

    private func loadMeta() {
        guard let d = try? Data(contentsOf: dir.appendingPathComponent("index.json")),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return }
        if let f = (o["fps"] as? NSNumber)?.doubleValue, f >= 1, f <= 60 { fps = f }
        if let b = (o["box"] as? NSNumber)?.doubleValue, b >= 1, b <= 4 { box = CGFloat(b) }
        metaLoaded = true
    }

    /// The strip for `kind`/`state`, or nil while it is not on disk. Only one kind's strips stay
    /// in memory (a strip is a few MB decoded).
    func strip(_ kind: String, _ state: GodState) -> CGImage? {
        let key = "\(kind)-\(state.rawValue)"
        if let c = cache[key] { return c }
        let url = dir.appendingPathComponent(key + ".png")
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
              img.height > 0, img.width >= img.height else { return nil }
        if !metaLoaded { loadMeta() }
        for k in cache.keys where !k.hasPrefix(kind + "-") { cache[k] = nil }
        cache[key] = img
        return img
    }

    static func frameCount(_ img: CGImage) -> Int { max(1, img.width / img.height) }

    static func frame(_ img: CGImage, _ i: Int) -> CGImage? {
        let h = img.height
        return img.cropping(to: CGRect(x: (i % frameCount(img)) * h, y: 0, width: h, height: h))
    }
}

/// The god: one CALayer showing one frame of a strip; a timer steps contentsRect at the strip's fps.
/// The view's bounds are the SPHERE; the sprite layer is `box` times that, centred on it, and
/// overhangs the view (halo, accessories).
final class GodView: NSView {
    private let sprite = CALayer()
    private(set) var image: CGImage?
    private var frames = 1
    private(set) var index = 0
    private var timer: Timer?
    private var lastTry = Date.distantPast

    var kind = "colleague" { didSet { if kind != oldValue { load(fade: true) } } }
    var state: GodState = .idle { didSet { if state != oldValue { load(fade: true) } } }
    var dim = false { didSet { if dim != oldValue { sprite.opacity = dim ? 0.5 : 1 } } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        sprite.contentsGravity = .resizeAspect
        sprite.magnificationFilter = .linear
        sprite.minificationFilter = .linear
        sprite.actions = ["contents": NSNull(), "contentsRect": NSNull(), "bounds": NSNull(),
                          "position": NSNull(), "frame": NSNull(), "opacity": NSNull()]
        layer?.addSublayer(sprite)
        load(fade: false)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override func hitTest(_ p: NSPoint) -> NSView? { nil }   // clicks fall through: the card drags
    override func layout() {
        super.layout()
        sprite.frame = spriteRect
    }
    override func setFrameSize(_ s: NSSize) {
        super.setFrameSize(s)
        sprite.frame = spriteRect
    }

    /// The strip frame's rect in this view's coordinates.
    var spriteRect: NSRect {
        let o = (Sprites.shared.box - 1) / 2
        return bounds.insetBy(dx: -bounds.width * o, dy: -bounds.height * o)
    }

    func start() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: 1.0 / Sprites.shared.fps, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func load(fade: Bool) {
        lastTry = Date()
        let img = Sprites.shared.strip(kind, state)
        if fade, img != nil, image != nil {
            let t = CATransition()
            t.type = .fade
            t.duration = 0.18
            sprite.add(t, forKey: "swap")
        }
        image = img
        frames = img.map(Sprites.frameCount) ?? 1
        index = 0
        sprite.contents = img
        sprite.frame = spriteRect           // index.json (and its box) may have just arrived
        applyFrame()
        if img != nil, timer != nil, abs(timer!.timeInterval - 1.0 / Sprites.shared.fps) > 0.001 {
            timer?.invalidate(); timer = nil; start()   // index.json arrived with another fps
        }
    }

    private func tick() {
        guard image != nil else {
            if Date().timeIntervalSince(lastTry) > 2 { load(fade: false) }   // strips not rendered yet
            return
        }
        index = (index + 1) % frames
        applyFrame()
    }

    private func applyFrame() {
        let w = 1 / CGFloat(frames)
        sprite.contentsRect = CGRect(x: CGFloat(index) * w, y: 0, width: w, height: 1)
    }
}

// MARK: - Call states

enum Phase: CaseIterable {
    case listening, you, thinking, claude, off, muted

    var label: String {
        switch self {
        case .listening: return "Listening"
        case .you: return "You"
        case .thinking: return "Thinking"
        case .claude: return "Speaking"
        case .off: return "Mic off"
        case .muted: return "Muted"
        }
    }

    var god: GodState {
        switch self {
        case .listening, .off, .muted: return .idle
        case .you: return .listen
        case .thinking: return .work
        case .claude: return .talk
        }
    }

    static func named(_ s: String) -> Phase? {
        switch s.lowercased() {
        case "listening", "idle", "happy": return .listening
        case "you", "listen": return .you
        case "thinking", "work": return .thinking
        case "claude", "talk", "speaking": return .claude
        case "off": return .off
        case "muted": return .muted
        default: return nil
        }
    }
}

// MARK: - Card geometry (base units, y from the top; everything is drawn at base x `k`)

struct CardGeo {
    let compact: Bool
    static let full = NSSize(width: 220, height: 250)
    static let small = NSSize(width: 124, height: 148)
    static let radius: CGFloat = 16

    var size: NSSize { compact ? CardGeo.small : CardGeo.full }
    /// The sphere. Its diameter is 0.36 x the card width, as in the film's call card
    /// (claude-ui.js: avatarSize = 0.36 x min(w, h) on a 300 x 340 card); the sprite frame around
    /// it is `box` x this, so the halo sits just under the header.
    var god: NSRect { compact ? NSRect(x: 33, y: 31, width: 58, height: 58) : NSRect(x: 70, y: 60, width: 80, height: 80) }
    var caption: NSRect { NSRect(x: 14, y: 156, width: 192, height: 40) }
    var mic: NSRect { compact ? NSRect(x: 27, y: 106, width: 30, height: 30) : NSRect(x: 68, y: 200, width: 36, height: 36) }
    var stop: NSRect { compact ? NSRect(x: 67, y: 106, width: 30, height: 30) : NSRect(x: 116, y: 200, width: 36, height: 36) }
    var chevron: NSRect { compact ? NSRect(x: 7, y: 7, width: 20, height: 20) : NSRect(x: 164, y: 9, width: 20, height: 20) }
    var toggle: NSRect { compact ? NSRect(x: 97, y: 7, width: 20, height: 20) : NSRect(x: 188, y: 9, width: 20, height: 20) }
    var headerMidY: CGFloat { 19 }
}

// MARK: - Buttons

/// The two round buttons: mic (white, thin border; muted: red mic-slash) and stop (soft red
/// circle, red square). One paint routine for the live view and the snapshot.
final class RoundButton: NSView {
    enum Kind { case mic, stop }
    let kind: Kind
    var muted = false { didSet { if muted != oldValue { needsDisplay = true } } }
    var theme = Theme.light { didSet { needsDisplay = true } }
    var action: (() -> Void)?
    private var pressed = false { didSet { if pressed != oldValue { needsDisplay = true } } }

    init(kind: Kind, tip: String) {
        self.kind = kind
        super.init(frame: .zero)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        toolTip = tip
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func setFrameSize(_ s: NSSize) { super.setFrameSize(s); needsDisplay = true }
    override func hitTest(_ p: NSPoint) -> NSView? {
        guard let sv = superview else { return nil }
        let q = convert(p, from: sv)
        let r = min(bounds.width, bounds.height) / 2
        return hypot(q.x - bounds.midX, q.y - bounds.midY) <= r ? self : nil
    }
    override func mouseDown(with e: NSEvent) { pressed = true }
    override func mouseDragged(with e: NSEvent) { pressed = bounds.contains(convert(e.locationInWindow, from: nil)) }
    override func mouseUp(with e: NSEvent) {
        let inside = bounds.contains(convert(e.locationInWindow, from: nil))
        pressed = false
        if inside { action?() }
    }
    override func draw(_ dirty: NSRect) {
        RoundButton.paint(in: bounds, kind: kind, muted: muted, theme: theme, pressed: pressed)
    }

    static func paint(in b: NSRect, kind: Kind, muted: Bool, theme t: Theme, pressed: Bool) {
        let d = min(b.width, b.height)
        let c = NSRect(x: b.midX - d / 2, y: b.midY - d / 2, width: d, height: d).insetBy(dx: 0.5, dy: 0.5)
        let p = NSBezierPath(ovalIn: c)
        p.lineWidth = 1
        switch kind {
        case .mic:
            (muted ? t.mutedFill : t.micFill).setFill(); p.fill()
            (muted ? t.mutedStroke : t.micStroke).setStroke(); p.stroke()
            drawSymbol(muted ? "mic.slash" : "mic", size: d * 0.38, weight: .regular,
                       color: muted ? t.red : t.text, center: NSPoint(x: b.midX, y: b.midY))
        case .stop:
            t.stopFill.setFill(); p.fill()
            t.stopStroke.setStroke(); p.stroke()
            let s = (d * 0.27).rounded()
            let sq = NSRect(x: b.midX - s / 2, y: b.midY - s / 2, width: s, height: s)
            t.stopIcon.setFill()
            NSBezierPath(roundedRect: sq, xRadius: s * 0.2, yRadius: s * 0.2).fill()
        }
        if pressed { t.pressed.setFill(); p.fill() }
    }
}

/// Small round header buttons (waiting-list chevron, compact toggle). Shown on hover.
final class HeadButton: NSView {
    var symbol: String { didSet { if symbol != oldValue { needsDisplay = true } } }
    var tint: NSColor? { didSet { needsDisplay = true } }
    var theme = Theme.light { didSet { needsDisplay = true } }
    var action: (() -> Void)?
    private(set) var shown = false
    private var pressed = false { didSet { if pressed != oldValue { needsDisplay = true } } }

    init(symbol: String, tip: String?) {
        self.symbol = symbol
        super.init(frame: .zero)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        toolTip = tip
        alphaValue = 0
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func hitTest(_ p: NSPoint) -> NSView? { shown ? super.hitTest(p) : nil }
    override func setFrameSize(_ s: NSSize) { super.setFrameSize(s); needsDisplay = true }
    override func mouseDown(with e: NSEvent) { pressed = true }
    override func mouseDragged(with e: NSEvent) { pressed = bounds.contains(convert(e.locationInWindow, from: nil)) }
    override func mouseUp(with e: NSEvent) {
        let inside = bounds.contains(convert(e.locationInWindow, from: nil))
        pressed = false
        if inside { action?() }
    }

    func show(_ on: Bool, animated: Bool) {
        guard on != shown else { return }
        shown = on
        if !animated { alphaValue = on ? 1 : 0; isHidden = !on; return }
        if on { isHidden = false }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.18
            self.animator().alphaValue = on ? 1 : 0
        }, completionHandler: { [weak self] in
            guard let self = self else { return }
            if !self.shown { self.isHidden = true }
        })
    }

    override func draw(_ dirty: NSRect) {
        HeadButton.paint(in: bounds, symbol: symbol, theme: theme, tint: tint, pressed: pressed)
    }

    static func paint(in b: NSRect, symbol: String, theme t: Theme, tint: NSColor?, pressed: Bool) {
        let d = min(b.width, b.height)
        let p = NSBezierPath(ovalIn: NSRect(x: b.midX - d / 2, y: b.midY - d / 2, width: d, height: d).insetBy(dx: 0.5, dy: 0.5))
        t.glassFill.setFill(); p.fill()
        if pressed { t.pressed.setFill(); p.fill() }
        t.glassStroke.setStroke(); p.lineWidth = 1; p.stroke()
        drawSymbol(symbol, size: d * 0.42, weight: .semibold, color: tint ?? t.sub, center: NSPoint(x: b.midX, y: b.midY))
    }
}

// MARK: - Caption (one line under the god: what is being said, else the state)

final class CaptionView: NSView {
    private(set) var text = ""
    private(set) var spoken = false
    var theme = Theme.light { didSet { needsDisplay = true } }
    var k: CGFloat = 1 { didSet { needsDisplay = true } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func hitTest(_ p: NSPoint) -> NSView? { nil }

    func set(_ t: String, spoken s: Bool, animated: Bool) {
        guard t != text || s != spoken else { return }
        if animated, let l = layer {
            let tr = CATransition()
            tr.type = .fade
            tr.duration = 0.2
            l.add(tr, forKey: "caption")
        }
        text = t
        spoken = s
        needsDisplay = true
    }

    override func draw(_ dirty: NSRect) { CaptionView.paint(in: bounds, text: text, spoken: spoken, theme: theme, k: k) }

    /// Spoken lines in the text colour, state words in sub; up to two lines, centred.
    static func paint(in b: NSRect, text: String, spoken: Bool, theme t: Theme, k: CGFloat) {
        let font = NSFont.systemFont(ofSize: 13 * k, weight: spoken ? .regular : .medium)
        let ps = NSMutableParagraphStyle()
        ps.alignment = .center
        ps.lineBreakMode = .byWordWrapping
        let s = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: spoken ? t.text : t.sub,
                                                               .paragraphStyle: ps])
        let opts: NSString.DrawingOptions = [.usesLineFragmentOrigin, .truncatesLastVisibleLine]
        let lh = ceil(NSLayoutManager().defaultLineHeight(for: font))
        let need = ceil(s.boundingRect(with: NSSize(width: b.width, height: 10_000), options: opts).height)
        let h = min(need, lh * 2, b.height)
        s.draw(with: NSRect(x: b.minX, y: b.midY - h / 2, width: b.width, height: h), options: opts)
    }
}

// MARK: - The call card

final class CardView: NSView {
    private(set) var geo = CardGeo(compact: false)
    private(set) var k: CGFloat = 1
    private(set) var theme = Theme.light
    let god = GodView(frame: .zero)
    let caption = CaptionView(frame: .zero)
    let mic = RoundButton(kind: .mic, tip: "Mute")
    let stop = RoundButton(kind: .stop, tip: "Stop")
    let chevron = HeadButton(symbol: "chevron.down", tip: "Waiting sessions")
    let toggle = HeadButton(symbol: "arrow.down.right.and.arrow.up.left", tip: "Smaller")
    private var tracking: NSTrackingArea?

    var name = "Claude" { didSet { if name != oldValue { needsDisplay = true } } }
    var timerText: String? { didSet { if timerText != oldValue { needsDisplay = true } } }
    var muted = false {
        didSet { if muted != oldValue { mic.muted = muted; mic.toolTip = muted ? "Unmute" : "Mute" } }
    }
    var pendingCount = 0 { didSet { if pendingCount != oldValue { updateControls(animated: true) } } }
    var expanded = false { didSet { if expanded != oldValue { updateControls(animated: true) } } }
    var forceHover = false { didSet { updateControls(animated: false) } }
    private(set) var hovered = false { didSet { if hovered != oldValue { updateControls(animated: true) } } }

    var onMute: ((Bool) -> Void)?       // the state to switch to (true = mute)
    var onStop: (() -> Void)?
    var onZoom: ((CGFloat) -> Void)?    // additive change to the target scale
    var onExpand: (() -> Void)?         // toggle the waiting list
    var onCompact: (() -> Void)?        // toggle the compact card

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        for v in [god, caption, mic, stop, chevron, toggle] as [NSView] { addSubview(v) }
        mic.action = { [weak self] in guard let self = self else { return }; self.onMute?(!self.muted) }
        stop.action = { [weak self] in self?.onStop?() }
        chevron.action = { [weak self] in self?.onExpand?() }
        toggle.action = { [weak self] in self?.onCompact?() }
        applyTheme()
        configure(k: 1, compact: false)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { true }

    func sc(_ r: NSRect) -> NSRect { NSRect(x: r.minX * k, y: r.minY * k, width: r.width * k, height: r.height * k) }

    /// Lay the card out at scale `k` inside the current bounds (the panel's pixel-rounded size).
    func configure(k: CGFloat, compact: Bool) {
        self.k = k
        geo = CardGeo(compact: compact)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        god.frame = sc(geo.god)
        caption.frame = sc(geo.caption)
        caption.isHidden = compact
        caption.k = k
        mic.frame = sc(geo.mic)
        stop.frame = sc(geo.stop)
        chevron.frame = sc(geo.chevron)
        toggle.frame = sc(geo.toggle)
        CATransaction.commit()
        toggle.symbol = compact ? "arrow.up.left.and.arrow.down.right" : "arrow.down.right.and.arrow.up.left"
        toggle.toolTip = compact ? "Bigger" : "Smaller"
        needsDisplay = true
        updateControls(animated: false)
    }

    func applyTheme() {
        theme = Theme.of(effectiveAppearance)
        mic.theme = theme; stop.theme = theme; chevron.theme = theme; toggle.theme = theme; caption.theme = theme
        updateControls(animated: false)
        needsDisplay = true
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyTheme()
    }

    // hover: the header buttons fade in
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = tracking { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(t)
        tracking = t
    }
    override func mouseEntered(with e: NSEvent) { hovered = true }
    override func mouseExited(with e: NSEvent) { hovered = false }
    func refreshHover() {
        guard let w = window else { return }
        hovered = bounds.contains(convert(w.mouseLocationOutsideOfEventStream, from: nil))
    }

    func updateControls(animated: Bool) {
        let show = hovered || forceHover
        chevron.symbol = expanded ? "chevron.up" : "chevron.down"
        chevron.tint = pendingCount > 0 ? theme.amber : nil
        chevron.toolTip = pendingCount == 0 ? "Nothing waiting" : pendingCount == 1 ? "1 session waiting" : "\(pendingCount) sessions waiting"
        chevron.show(show || pendingCount > 0 || expanded, animated: animated)
        toggle.show(show, animated: animated)
        needsDisplay = true   // the timer gives way to the header buttons
    }

    // resize with the mouse
    override func scrollWheel(with e: NSEvent) {
        guard e.momentumPhase.isEmpty else { return }   // finger on the glass only, no coasting
        let dy = e.isDirectionInvertedFromDevice ? -e.scrollingDeltaY : e.scrollingDeltaY
        guard dy != 0 else { return }
        onZoom?(e.hasPreciseScrollingDeltas ? dy * 0.005 : max(-0.15, min(0.15, dy * 0.05)))
    }
    override func magnify(with e: NSEvent) { onZoom?(e.magnification * k) }

    override func draw(_ dirty: NSRect) {
        let headerBusy = hovered || forceHover || pendingCount > 0 || expanded
        CardView.paint(in: bounds, geo: geo, theme: theme, k: k, name: name, timer: headerBusy ? nil : timerText)
    }

    /// Body, then (full card only) the header: orange dot + name, timer right when enabled.
    static func paint(in b: NSRect, geo: CardGeo, theme t: Theme, k: CGFloat, name: String, timer: String?) {
        paintCardBody(b, radius: CardGeo.radius * k, theme: t)
        guard !geo.compact else { return }
        let mid = geo.headerMidY * k
        let d = 7 * k
        t.accent.setFill()
        NSBezierPath(ovalIn: NSRect(x: 15 * k, y: mid - d / 2, width: d, height: d)).fill()
        var right = b.width - 14 * k
        if let tm = timer {
            let s = attr(tm, .monospacedDigitSystemFont(ofSize: 11.5 * k, weight: .regular), t.sub, align: .right)
            let w = ceil(s.size().width)
            drawLine(s, x: right - w, midY: mid, width: w + 1)
            right -= w + 8 * k
        }
        let n = attr(name, .systemFont(ofSize: 12.5 * k, weight: .medium), t.text)
        drawLine(n, x: 28 * k, midY: mid, width: right - 28 * k)
    }
}

// MARK: - Waiting sessions (records written by an optional Notification hook; see README)

struct PendingItem: Equatable {
    let sessionId: String
    let title: String
    let message: String
    let link: String
    let at: Date

    static var dir: URL { env["CALLPILL_PENDING_DIR"].map(expand) ?? callDir.appendingPathComponent("pending") }

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
    /// (its transcript was written after the record: Allow was pressed, or it was answered).
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

/// The list under the card. Rows: the session, the waiting message, Open. There is
/// deliberately no Allow here: Open takes you to the session, you decide there.
final class PendingListView: NSView {
    static let width: CGFloat = 264, header: CGFloat = 32, rowH: CGFloat = 58, foot: CGFloat = 8, more: CGFloat = 20
    static let maxRows = 6, radius: CGFloat = 14
    static let openSize = NSSize(width: 52, height: 24)

    var items: [PendingItem] = [] { didSet { needsDisplay = true } }
    var theme = Theme.light { didSet { needsDisplay = true } }
    var k: CGFloat = 1 { didSet { needsDisplay = true } }
    var onOpen: ((PendingItem) -> Void)?
    private var pressed: Int? { didSet { if pressed != oldValue { needsDisplay = true } } }

    static func height(for n: Int) -> CGFloat {
        header + CGFloat(max(1, min(n, maxRows))) * rowH + (n > maxRows ? more : 0) + foot
    }
    static func size(for n: Int, k: CGFloat) -> NSSize { NSSize(width: width * k, height: height(for: n) * k) }

    static func openRect(_ i: Int, in b: NSRect, k: CGFloat) -> NSRect {
        let top = b.minY + (header + CGFloat(i) * rowH) * k
        return NSRect(x: b.maxX - (12 + openSize.width) * k, y: top + (rowH - openSize.height) / 2 * k,
                      width: openSize.width * k, height: openSize.height * k)
    }

    override var isFlipped: Bool { true }
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

    static func paint(in b: NSRect, items: [PendingItem], theme t: Theme, k: CGFloat, pressed: Int?, now: Date) {
        paintCardBody(b, radius: radius * k, theme: t)
        let pad = 14 * k
        let hMid = b.minY + header * k / 2
        drawLine(attr("Waiting on you", .systemFont(ofSize: 11.5 * k, weight: .semibold), t.sub), x: b.minX + pad, midY: hMid, width: 160 * k)
        if !items.isEmpty {
            drawLine(attr("\(items.count)", .systemFont(ofSize: 11.5 * k, weight: .semibold), t.amber, align: .right),
                     x: b.maxX - pad - 40 * k, midY: hMid, width: 40 * k)
        }
        if items.isEmpty {
            drawLine(attr("Nothing waiting", .systemFont(ofSize: 12 * k, weight: .medium), t.faint, align: .center),
                     x: b.minX, midY: b.minY + (header + rowH / 2) * k, width: b.width)
            return
        }
        for (i, it) in items.prefix(maxRows).enumerated() {
            let top = b.minY + (header + CGFloat(i) * rowH) * k
            t.border.setFill()
            NSRect(x: b.minX + pad, y: top - 0.5, width: b.width - 2 * pad, height: 1).fill()
            let open = openRect(i, in: b, k: k)
            let textW = open.minX - 10 * k - (b.minX + pad)
            let age = attr(it.age(now), .systemFont(ofSize: 10.5 * k, weight: .regular), t.faint, align: .right)
            let ageW = ceil(age.size().width)
            let tl = attr(it.title, .systemFont(ofSize: 12.5 * k, weight: .semibold), t.text)
            let tMid = top + 17 * k
            drawLine(tl, x: b.minX + pad, midY: tMid, width: textW - ageW - 6 * k)
            drawLine(age, x: b.minX + pad + textW - ageW, midY: tMid, width: ageW + 1)
            let msg = attr(it.message, .systemFont(ofSize: 11 * k, weight: .regular), t.sub, wrap: .byWordWrapping)
            msg.draw(with: NSRect(x: b.minX + pad, y: top + 26 * k, width: textW, height: 28 * k),
                     options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
            paintTextButton(open, it.openURL == nil ? "No link" : "Open", primary: false, pressed: pressed == i, theme: t, k: k * 0.92)
        }
        if items.count > maxRows {
            drawLine(attr("+\(items.count - maxRows) more", .systemFont(ofSize: 11 * k, weight: .medium), t.sub, align: .center),
                     x: b.minX, midY: b.minY + (header + CGFloat(maxRows) * rowH + more / 2) * k, width: b.width)
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
    let short: String
    let summary: String
    let mono: Bool
    let pid: Int32
    let created: Date

    static var dir: URL { env["CALLPILL_PERMIT_DIR"].map(expand) ?? callDir.appendingPathComponent("permit") }

    var heading: String {
        if !title.isEmpty { return title }
        if !cwd.isEmpty { return (cwd as NSString).lastPathComponent }
        return "Claude Code"
    }

    static func tilde(_ s: String) -> String {
        let h = home.path
        return s.replacingOccurrences(of: h + "/", with: "~/")
    }

    /// What the card shows: the title, an optional faint comment line, the box text, and whether
    /// the box gets a "$ " prompt. Bash: "Claude wants to run" + the command (its description as
    /// a `# ...` line). Other tools: "Claude wants to use <tool>" + the main argument.
    var display: (title: String, comment: String?, body: String, prompt: Bool) {
        if tool == "Bash" {
            if !short.isEmpty, summary.hasPrefix(short + "\n") {
                return ("Claude wants to run", short, String(summary.dropFirst(short.count + 1)), true)
            }
            return ("Claude wants to run", nil, summary.isEmpty ? short : summary, true)
        }
        if tool.hasPrefix("mcp__") {
            let parts = tool.components(separatedBy: "__")
            let fn = parts.count >= 3 ? parts[2...].joined(separator: "__") : tool
            let server = parts.count >= 3 ? parts[1] : ""
            var lines = summary.components(separatedBy: "\n")
            if let first = lines.first, first.hasPrefix(fn) { lines.removeFirst() }   // "name (server)" is the title now
            let body = lines.joined(separator: "\n")
            return ("Claude wants to use \(fn)", server.isEmpty ? nil : server, body.isEmpty ? "(no arguments)" : body, false)
        }
        let body = PermitItem.tilde(summary.isEmpty ? short : summary)
        return ("Claude wants to use \(tool)", nil, body.isEmpty ? tool : body, false)
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
                                  tool: (o["tool_name"] as? String) ?? "Tool", short: (o["short"] as? String) ?? "",
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

/// The permission card (the film's .cui-perm): terminal tile + "Claude wants to run", the mono
/// command box, the session on the left of the footer, Deny (outlined) and Allow (accent) on the
/// right; after a click "Allowed" (green) or "Denied" (sub). Clicks count only once the request
/// has been on screen for `armDelay`, so a new request sliding in under the pointer cannot catch
/// a click meant for the previous one.
final class PermitView: NSView {
    static let width: CGFloat = 300, pad: CGFloat = 14, tile: CGFloat = 26, gap1: CGFloat = 10
    static let boxPadX: CGFloat = 10, boxPadY: CGFloat = 8, gap2: CGFloat = 12, buttonH: CGFloat = 28, maxLines = 6
    static let radius: CGFloat = 14
    static let armDelay: TimeInterval = 0.6

    var item: PermitItem? {
        didSet {
            if item?.id != oldValue?.id { armedAt = Date().addingTimeInterval(PermitView.armDelay); result = nil }
            needsDisplay = true
        }
    }
    var more = 0 { didSet { needsDisplay = true } }
    var result: Bool? { didSet { needsDisplay = true } }   // set after a click: true Allowed, false Denied
    var theme = Theme.light { didSet { needsDisplay = true } }
    var k: CGFloat = 1 { didSet { needsDisplay = true } }
    var onAnswer: ((PermitItem, Bool) -> Void)?   // true = allow
    private var armedAt = Date.distantPast
    private var pressed: Bool? { didSet { if pressed != oldValue { needsDisplay = true } } }   // true = Allow held

    static func monoFont(_ k: CGFloat) -> NSFont { .monospacedSystemFont(ofSize: 11.5 * k, weight: .regular) }
    static func lineH(_ k: CGFloat) -> CGFloat { ceil(NSLayoutManager().defaultLineHeight(for: monoFont(k)) * 1.12) }

    static func boxText(_ it: PermitItem, _ t: Theme, _ k: CGFloat) -> NSAttributedString {
        let d = it.display
        let ps = NSMutableParagraphStyle()
        ps.lineBreakMode = .byCharWrapping
        ps.minimumLineHeight = lineH(k)
        ps.maximumLineHeight = lineH(k)
        let f = monoFont(k)
        let s = NSMutableAttributedString()
        func add(_ str: String, _ c: NSColor) {
            s.append(NSAttributedString(string: str, attributes: [.font: f, .foregroundColor: c, .paragraphStyle: ps]))
        }
        if let c = d.comment, !c.isEmpty { add("# " + c + "\n", t.faint) }
        if d.prompt { add("$ ", t.faint) }
        add(d.body, t.text)
        return s
    }

    static func textW(_ k: CGFloat) -> CGFloat { (width - 2 * pad - 2 * boxPadX) * k }

    /// Box text height: measured, capped at maxLines.
    static func textH(_ it: PermitItem, k: CGFloat) -> CGFloat {
        let r = boxText(it, .light, k).boundingRect(with: NSSize(width: textW(k), height: 10_000), options: [.usesLineFragmentOrigin])
        let lh = lineH(k)
        return min(max(lh, ceil(r.height)), lh * CGFloat(maxLines))
    }
    static func size(for it: PermitItem, k: CGFloat) -> NSSize {
        NSSize(width: width * k, height: (pad + tile + gap1 + 2 * boxPadY + gap2 + buttonH + pad) * k + textH(it, k: k))
    }
    static func buttonRect(allow: Bool, in b: NSRect, k: CGFloat) -> NSRect {
        let w: CGFloat = 62 * k, h = buttonH * k
        let y = b.maxY - (pad + buttonH) * k
        let allowX = b.maxX - pad * k - w
        return NSRect(x: allow ? allowX : allowX - 8 * k - w, y: y, width: w, height: h)
    }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var acceptsFirstResponder: Bool { false }   // no keyboard path to Allow
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); theme = Theme.of(effectiveAppearance) }

    private func button(at e: NSEvent) -> Bool? {
        guard result == nil else { return nil }
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
        guard let it = item, let p = pressed, hit == p, Date() >= armedAt, result == nil else { return }
        onAnswer?(it, p)
    }

    override func draw(_ dirty: NSRect) {
        guard let it = item else { return }
        PermitView.paint(in: bounds, item: it, more: more, result: result, theme: theme, k: k, pressed: pressed)
    }

    static func paint(in b: NSRect, item it: PermitItem, more: Int, result: Bool?, theme t: Theme, k: CGFloat, pressed: Bool?) {
        paintCardBody(b, radius: radius * k, theme: t)
        let p = pad * k
        let d = it.display
        // header: terminal tile + title, "+N more" right
        let tileR = NSRect(x: b.minX + p, y: b.minY + p, width: tile * k, height: tile * k)
        t.accentSoft.setFill()
        NSBezierPath(roundedRect: tileR, xRadius: 7 * k, yRadius: 7 * k).fill()
        drawSymbol(it.tool == "Bash" ? "apple.terminal" : "wrench.and.screwdriver", size: 12.5 * k, weight: .regular,
                   color: t.accent, center: NSPoint(x: tileR.midX, y: tileR.midY))
        var right = b.maxX - p
        if more > 0 {
            let m = attr("+\(more) more", .systemFont(ofSize: 11 * k, weight: .semibold), t.amber, align: .right)
            let w = ceil(m.size().width)
            drawLine(m, x: right - w, midY: tileR.midY, width: w + 1)
            right -= w + 8 * k
        }
        let title = attr(d.title, .systemFont(ofSize: 13.5 * k, weight: .semibold), t.text)
        drawLine(title, x: tileR.maxX + 9 * k, midY: tileR.midY, width: right - tileR.maxX - 9 * k)
        // command box
        let th = textH(it, k: k)
        let box = NSRect(x: b.minX + p, y: tileR.maxY + gap1 * k, width: b.width - 2 * p, height: th + 2 * boxPadY * k)
        let bp = NSBezierPath(roundedRect: box.insetBy(dx: 0.5, dy: 0.5), xRadius: 8 * k, yRadius: 8 * k)
        t.side.setFill(); bp.fill()
        t.border2.setStroke(); bp.lineWidth = 1; bp.stroke()
        boxText(it, t, k).draw(with: NSRect(x: box.minX + boxPadX * k, y: box.minY + boxPadY * k, width: textW(k), height: th),
                               options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        // footer
        let deny = buttonRect(allow: false, in: b, k: k), allow = buttonRect(allow: true, in: b, k: k)
        if let r = result {
            let c = r ? t.green : t.sub
            let x = b.minX + p
            drawSymbol(r ? "checkmark" : "xmark", size: 11.5 * k, weight: .semibold, color: c, center: NSPoint(x: x + 7 * k, y: allow.midY))
            drawLine(attr(r ? "Allowed" : "Denied", .systemFont(ofSize: 13 * k, weight: .medium), c), x: x + 19 * k, midY: allow.midY, width: 160 * k)
        } else {
            drawLine(attr(it.heading, .systemFont(ofSize: 11 * k, weight: .regular), t.faint),
                     x: b.minX + p, midY: allow.midY, width: deny.minX - 10 * k - (b.minX + p))
            paintTextButton(deny, "Deny", primary: false, pressed: pressed == false, theme: t, k: k)
            paintTextButton(allow, "Allow", primary: true, pressed: pressed == true, theme: t, k: k)
        }
    }
}

// MARK: - Demo mode (fixed state, for screenshots)

struct Demo {
    let phase: Phase
    let happy: Bool
    let line: String?
    let expand: Bool
    let hover: Bool
    let compact: Bool?
    let at: NSPoint?   // inset of the card's top-right corner from the screen's visible top-right

    static let current: Demo? = {
        guard let p = env["CALLPILL_DEMO"], !p.isEmpty else { return nil }
        let at = env["CALLPILL_DEMO_AT"].flatMap { s -> NSPoint? in
            let v = s.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            return v.count == 2 ? NSPoint(x: v[0], y: v[1]) : nil
        }
        return Demo(phase: Phase.named(p) ?? .listening, happy: p.lowercased() == "happy",
                    line: env["CALLPILL_DEMO_LINE"], expand: env["CALLPILL_DEMO_EXPAND"] == "1",
                    hover: env["CALLPILL_DEMO_HOVER"] == "1",
                    compact: env["CALLPILL_DEMO_COMPACT"].map { $0 == "1" }, at: at)
    }()
}

// MARK: - App: log reader + panels

final class Pill: NSObject, NSApplicationDelegate {
    let panel = NSPanel(contentRect: NSRect(origin: .zero, size: CardGeo.full),
                        styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    var view: CardView!
    let demo = Demo.current
    let logDir = env["CALLPILL_LOG_DIR"].map(expand) ?? home.appendingPathComponent(".voicemode/logs/conversations")
    var trace: FileHandle?
    let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()

    var path: URL?
    var offset: UInt64 = 0
    var buffer = ""
    var lastPartial = Date.distantPast
    var speaking = false
    var line = ""                               // the line being spoken (mouth `saying` text)
    var thinking = false
    // Thinking follows the listener's verdicts (bin/listen.py touches ~/.voicemode/call/accepted
    // for each turn it passes on), not raw mic turns: on speakers most raw turns are my own echo.
    var sayingAt = Date()                       // launch counts as a reply, so old verdicts are ignored
    var thinkingSince = Date.distantPast
    var saidAt = Date.distantPast
    var happyFor = Date.distantPast             // the `said` that last earned a happy beat
    var happyUntil = Date.distantPast
    let acceptedURL = callDir.appendingPathComponent("accepted")
    let deviceURL = callDir.appendingPathComponent("device")
    let focusURL = callDir.appendingPathComponent("focus")
    let workersURL = callDir.appendingPathComponent("workers.json")
    var micOff = false
    var callStart = Date()
    // `call mute` / `call unmute` own this flag file; the pill only reads it (and shows the
    // click's result right away for 2 s, until the file catches up).
    let mutedURL = callDir.appendingPathComponent("muted")
    var muteClick: (state: Bool, at: Date)?
    var demoMuted = false
    // Card scale and compact flag, anchored top-right, persisted (new keys: the card is new).
    var scale: CGFloat = 1, scaleTarget: CGFloat = 1
    var compact = false
    var zoomTimer: Timer?
    static let scaleKey = "callCardScale", compactKey = "callCardCompact"
    static let minScale: CGFloat = 0.6, maxScale: CGFloat = 1.75
    // Waiting list: a child panel under the card, so it follows the card when dragged.
    var pending: [PendingItem] = []
    var listPanel: NSPanel?
    var listView: PendingListView?
    // Permission requests: a child panel LEFT of the card (the card never moves).
    var permits: [PermitItem] = []
    var answered: Set<String> = []
    var permitPanel: NSPanel?
    var permitView: PermitView?
    var holding = false                         // "Allowed" / "Denied" is on screen for a moment

    func applicationDidFinishLaunching(_ note: Notification) {
        if let a = env["CALLPILL_APPEARANCE"]?.lowercased(), a == "dark" || a == "light" {
            NSApp.appearance = NSAppearance(named: a == "dark" ? .darkAqua : .aqua)
        }
        view = CardView(frame: NSRect(origin: .zero, size: CardGeo.full))

        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.contentView = view

        view.onMute = { [weak self] on in self?.setMuted(on) }
        view.onStop = { [weak self] in self?.runCall("stopwork") }
        view.onZoom = { [weak self] d in self?.zoom(by: d) }
        view.onExpand = { [weak self] in self?.setExpanded(!(self?.view.expanded ?? false)) }
        view.onCompact = { [weak self] in guard let self = self else { return }; self.setCompact(!self.compact) }

        if demo == nil {
            let saved = UserDefaults.standard.double(forKey: Pill.scaleKey)
            scale = saved > 0 ? max(Pill.minScale, min(Pill.maxScale, CGFloat(saved))) : 1
            compact = UserDefaults.standard.bool(forKey: Pill.compactKey)
        } else {
            compact = demo?.compact ?? false
        }
        scaleTarget = scale
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            let S = scaledSize(scale, backing: screen.backingScaleFactor)
            panel.setContentSize(S)
            applyScale()
            let inset = demo?.at ?? NSPoint(x: 16, y: 16)   // top-right, 16 pt in from both edges
            panel.setFrameOrigin(NSPoint(x: f.maxX - S.width - inset.x, y: f.maxY - S.height - inset.y))
        }
        panel.orderFrontRegardless()
        panel.invalidateShadow()
        view.god.start()

        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--log"), i + 1 < args.count {
            FileManager.default.createFile(atPath: args[i + 1], contents: nil)
            trace = FileHandle(forWritingAtPath: args[i + 1])
        }

        if demo == nil {
            if let t = lastListenStarted() { callStart = t }
            openNewest(fromEnd: true)
        } else {
            view.forceHover = demo?.hover ?? false
        }
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refreshPending(); self?.refreshFocus() }
        refreshFocus()
        refreshPending()
        render()
        if demo?.expand == true { setExpanded(true) }
    }

    // MARK: who is on the call (focus file + workers.json)

    /// The worker's god kind: its "god", else derived from its "avatar" colour (SPEC §3). The same
    /// table, in the same order, as bin/listen.py's god_of, so the face and the voice agree.
    static let avatarGod: [(String, String)] = [("purple", "research"), ("violet", "research"), ("blue", "scribe"),
                                                ("green", "scout"), ("orange", "sales"), ("red", "sales"), ("yellow", "herald")]
    static func godKind(_ w: [String: Any]) -> String {
        if let g = w["god"] as? String, godKinds.contains(g) { return g }
        let a = ((w["avatar"] as? String) ?? "").lowercased()
        return avatarGod.first { a.contains($0.0) }?.1 ?? "colleague"
    }

    func refreshFocus() {
        let key = ((try? String(contentsOf: focusURL, encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var kind = "colleague", name = "Claude"
        if !key.isEmpty {
            name = key.prefix(1).uppercased() + key.dropFirst()
            if let d = try? Data(contentsOf: workersURL),
               let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
               let ws = o["workers"] as? [[String: Any]],
               let w = ws.first(where: { ($0["key"] as? String) == key }) {
                if let n = w["name"] as? String, !n.isEmpty { name = n }
                kind = Pill.godKind(w)
            }
        }
        view.name = name
        view.god.kind = kind
    }

    // MARK: the heard log

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
        if demo == nil {
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
        }
        refreshPermits()
        render()
        if PillTimer.on {
            let s = max(0, Int(Date().timeIntervalSince(demo == nil ? callStart : Date().addingTimeInterval(-187))))
            view.timerText = s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
                                       : String(format: "%d:%02d", s / 60, s % 60)
        }
        if let t = trace {
            let l = String(format: "%.2f caption=%@ god=%@-%@ muted=%d permits=%d pending=%d\n", Date().timeIntervalSince1970,
                           view.caption.text, view.god.kind, view.god.state.rawValue, view.muted ? 1 : 0, permits.count, pending.count)
            t.write(Data(l.utf8))
        }
    }

    func handle(_ raw: String) {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
              let kind = obj["kind"] as? String else { return }
        let source = obj["source"] as? String
        switch (kind, source) {
        case ("saying", "mouth"):
            speaking = true; thinking = false; sayingAt = Date()
            line = ((obj["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        case ("said", "mouth"): speaking = false; saidAt = Date()
        case ("partial", "mic"):
            // on speakers the mic hears my tail for a few seconds after I stop: not him
            if !speaking && (onHeadphones() || Date().timeIntervalSince(saidAt) > 3.5) { lastPartial = Date() }
        case ("turn", "mic"): lastPartial = .distantPast
        case ("event", _):
            let ev = obj["event"] as? String
            if ev == "listen-started" {
                micOff = false
                if let ts = obj["ts"] as? String, let d = iso.date(from: ts) { callStart = d }
            }
            if ev == "listen-stopped" { micOff = true; speaking = false; thinking = false }
        default: break
        }
    }

    func onHeadphones() -> Bool {
        let name = (try? String(contentsOf: deviceURL, encoding: .utf8)) ?? ""
        return name.range(of: "airpods|headphone|headset|buds|beats", options: [.regularExpression, .caseInsensitive]) != nil
    }

    // MARK: buttons

    /// `call <arg>` through a login shell (PATH), off the main thread, output discarded.
    /// Never in demo mode.
    func runCall(_ arg: String) {
        guard demo == nil else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = ["-lc", "\"$HOME/.claude/skills/gods/bin/call\" \(arg)"]
            p.standardInput = FileHandle.nullDevice
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            do { try p.run(); p.waitUntilExit() }
            catch { FileHandle.standardError.write(Data("call \(arg): \(error)\n".utf8)) }
        }
    }

    func setMuted(_ on: Bool) {
        if demo != nil { demoMuted = on; render(); return }
        muteClick = (on, Date())
        runCall(on ? "mute" : "unmute")
        render()
    }

    var isMuted: Bool {
        if demo != nil { return demoMuted || demo?.phase == .muted }
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

    func makeChildPanel(_ v: NSView) -> NSPanel {
        let p = NSPanel(contentRect: .zero, styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        p.level = .statusBar
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.becomesKeyOnlyIfNeeded = true
        v.wantsLayer = true
        p.contentView = v
        return p
    }

    func setExpanded(_ on: Bool) {
        view.expanded = on
        if on {
            if listPanel == nil {
                let lv = PendingListView(frame: .zero)
                lv.onOpen = { [weak self] it in self?.open(it) }
                listPanel = makeChildPanel(lv)
                listView = lv
            }
            guard let lp = listPanel, let lv = listView else { return }
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
        guard let lp = listPanel, let lv = listView else { return }
        let S = PendingListView.size(for: pending.count, k: scale)
        let f = panel.frame
        let vis = (panel.screen ?? NSScreen.main)?.visibleFrame ?? f
        var x = f.maxX - S.width
        x = max(vis.minX + 8, min(vis.maxX - S.width - 8, x))
        // below the card, and below the permission card too while one is up
        var bottom = f.minY
        if let pp = permitPanel, pp.isVisible, !permits.isEmpty { bottom = min(bottom, pp.frame.minY) }
        var y = bottom - 8 - S.height
        if y < vis.minY + 8 { y = f.maxY + 8 }
        lp.setFrame(NSRect(x: x, y: y, width: S.width, height: S.height), display: true)
        lv.k = scale
        lp.invalidateShadow()
    }

    // MARK: permission requests (answered only by a click on Allow / Deny)

    func refreshPermits() {
        guard !holding else { return }        // "Allowed" / "Denied" stays up for its moment
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
    }

    func showPermit(_ it: PermitItem, more: Int) {
        if permitPanel == nil {
            let pv = PermitView(frame: .zero)
            pv.onAnswer = { [weak self] it, allow in self?.answerPermit(it, allow: allow) }
            permitPanel = makeChildPanel(pv)
            permitView = pv
        }
        guard let pp = permitPanel, let pv = permitView else { return }
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
        guard let pp = permitPanel, let pv = permitView, let it = pv.item else { return }
        let S = PermitView.size(for: it, k: scale)
        let f = panel.frame
        let vis = (panel.screen ?? NSScreen.main)?.visibleFrame ?? f
        var x = f.minX - 10 - S.width
        if x < vis.minX + 8 { x = f.maxX + 10 }
        var y = f.maxY - S.height
        y = max(vis.minY + 8, y)
        pp.setFrame(NSRect(x: x, y: y, width: S.width, height: S.height), display: true)
        pv.k = scale
        pp.invalidateShadow()
    }

    func answerPermit(_ it: PermitItem, allow: Bool) {
        guard !holding, it.answer(allow) else { return }
        answered.insert(it.id)
        holding = true
        permitView?.result = allow
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            guard let self = self else { return }
            self.holding = false
            self.refreshPermits()        // the answered id is filtered out: next request, or the card leaves
        }
    }

    func open(_ it: PendingItem) {
        guard demo == nil, let url = it.openURL else { return }
        NSWorkspace.shared.open(url)
        setExpanded(false)
    }

    // MARK: size: scale and compact

    func scaledSize(_ k: CGFloat, backing bs: CGFloat) -> NSSize {
        let S = CardGeo(compact: compact).size
        return NSSize(width: (S.width * k * bs).rounded() / bs, height: (S.height * k * bs).rounded() / bs)
    }

    func zoom(by d: CGFloat) {
        scaleTarget = max(Pill.minScale, min(Pill.maxScale, scaleTarget + d))
        if demo == nil { UserDefaults.standard.set(Double(scaleTarget), forKey: Pill.scaleKey) }
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
        resizeAnchored()
        if zoomTimer == nil { view.refreshHover() }
    }

    func setCompact(_ on: Bool) {
        compact = on
        if demo == nil { UserDefaults.standard.set(on, forKey: Pill.compactKey) }
        resizeAnchored()
        view.refreshHover()
    }

    /// New size, same top-right corner; children follow.
    func resizeAnchored() {
        let f = panel.frame
        let S = scaledSize(scale, backing: panel.backingScaleFactor)
        panel.setFrame(NSRect(x: f.maxX - S.width, y: f.maxY - S.height, width: S.width, height: S.height), display: false)
        applyScale()
        if !permits.isEmpty { positionPermit() }
        if view.expanded { positionList() }
    }

    func applyScale() {
        view.frame = NSRect(origin: .zero, size: panel.frame.size)
        view.configure(k: scale, compact: compact)
        panel.invalidateShadow()
    }

    // MARK: state -> card

    func render() {
        let now = Date()
        let next: Phase
        if let d = demo {
            next = isMuted ? .muted : d.phase
        } else {
            if let a = (try? FileManager.default.attributesOfItem(atPath: acceptedURL.path))?[.modificationDate] as? Date,
               a > sayingAt, !thinking {
                thinking = true; thinkingSince = a
            }
            // a reply that only went to the chat never produces 'saying'; do not stay stuck
            if thinking && now.timeIntervalSince(thinkingSince) > 45 { thinking = false; sayingAt = now }
            if isMuted { next = .muted }          // `call mute` also stops the ears: Muted wins over Mic off
            else if micOff { next = .off }
            else if speaking { next = .claude }
            else if now.timeIntervalSince(lastPartial) < 1.5 { next = .you }
            else if thinking || !permits.isEmpty { next = .thinking }   // a permission request waits
            else { next = .listening }
        }
        view.muted = next == .muted
        // happy: one loop when a reply has ended and the call has gone quiet again
        if demo == nil, next == .listening, saidAt > happyFor,
           now.timeIntervalSince(saidAt) >= 0.5, now.timeIntervalSince(saidAt) < 3 {
            happyFor = saidAt
            happyUntil = now.addingTimeInterval(24.0 / Sprites.shared.fps)
        }
        var gs = next.god
        if next == .listening && (now < happyUntil || demo?.happy == true) { gs = .happy }
        view.god.state = gs
        view.god.dim = next == .off
        let text: String, spoken: Bool
        if let l = demo?.line, !l.isEmpty { text = l; spoken = true }
        else if next == .claude, !line.isEmpty { text = line; spoken = true }
        else { text = next.label; spoken = false }
        view.caption.set(text, spoken: spoken, animated: true)
    }
}

enum PillTimer {
    /// The call timer is off by default: the call runs all day. CALLPILL_TIMER=on shows it.
    static let on = env["CALLPILL_TIMER"] == "on"
}

// MARK: - Snapshot mode: every state, light and dark, into one PNG (no window)

func snapshot(to out: String) {
    let px: CGFloat = 2, pad: CGFloat = 28, gap: CGFloat = 22
    struct Placed { let view: NSView; let x: CGFloat; let y: CGFloat; let god: (GodView, Int)? }   // y from the top
    var placed: [Placed] = []
    var bands: [(y: CGFloat, h: CGFloat, dark: Bool)] = []

    func card(_ dark: Bool, _ phase: Phase, line: String? = nil, compact: Bool = false, hover: Bool = false,
              pending: Int = 0, expanded: Bool = false, god: GodState? = nil, kind: String = "colleague",
              name: String = "Claude") -> CardView {
        let v = CardView(frame: NSRect(origin: .zero, size: CardGeo(compact: compact).size))
        v.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        v.applyTheme()
        v.configure(k: 1, compact: compact)
        v.name = name
        v.muted = phase == .muted
        v.pendingCount = pending
        v.expanded = expanded
        v.forceHover = hover
        v.timerText = PillTimer.on ? "3:07" : nil
        v.caption.set(line ?? phase.label, spoken: line != nil, animated: false)
        v.god.kind = kind
        v.god.state = god ?? phase.god
        v.god.dim = phase == .off
        return v
    }
    func themed<V: NSView>(_ v: V, _ dark: Bool) -> V { v.appearance = NSAppearance(named: dark ? .darkAqua : .aqua); return v }

    let now = Date()
    let bash = PermitItem(id: "a1", sessionId: "s1", title: "Fix the failing CI build", cwd: "~/code/app", tool: "Bash",
                          short: "Push the release branch", summary: "Push the release branch\ngit push origin release/v0.4",
                          mono: true, pid: 0, created: now)
    let edit = PermitItem(id: "a2", sessionId: "s2", title: "Release notes", cwd: "~/code/app", tool: "Edit", short: "edit CHANGELOG.md",
                          summary: home.path + "/code/app/CHANGELOG.md", mono: true, pid: 0, created: now)
    let mcp = PermitItem(id: "b1", sessionId: "s4", title: "Weekly posts", cwd: "", tool: "mcp__social__schedule_draft",
                         short: "schedule draft", summary: "schedule_draft (social)\ndraft_id: 8f2c1a\nscheduled_at: 2026-11-02T12:00:00Z",
                         mono: false, pid: 0, created: now)
    var items = PendingItem.load()
    if items.isEmpty {
        items = [PendingItem(sessionId: "p1", title: "Fix the failing CI build", message: "Claude needs your permission to use Bash",
                             link: "claude://claude.ai/epitaxy/local_0000", at: now.addingTimeInterval(-120)),
                 PendingItem(sessionId: "p2", title: "Release notes v2.3", message: "Claude is waiting for your input",
                             link: "claude://claude.ai/epitaxy/local_0001", at: now.addingTimeInterval(-900))]
    }

    var y = pad
    var maxW: CGFloat = 0
    for dark in [false, true] {
        let bandTop = y - pad / 2
        // row 1: the states
        var x = pad
        var rowH: CGFloat = 0
        let row: [CardView] = [
            card(dark, .listening), card(dark, .claude, line: "Hmm, let me look. Reading the CI log."),
            card(dark, .you), card(dark, .thinking), card(dark, .muted), card(dark, .listening, god: .happy),
            card(dark, .listening, compact: true), card(dark, .thinking, compact: true, hover: true, pending: 2),
        ]
        for v in row {
            placed.append(Placed(view: v, x: x, y: y, god: (v.god, 5)))
            x += v.frame.width + gap
            rowH = max(rowH, v.frame.height)
        }
        maxW = max(maxW, x)
        y += rowH + gap
        // row 2: permission cards left of the card, then the waiting list under a hovered card
        x = pad
        rowH = 0
        for (it, more, result) in [(bash, 2, nil), (dark ? mcp : edit, 0, dark ? false : true)] as [(PermitItem, Int, Bool?)] {
            let pv = themed(PermitView(frame: NSRect(origin: .zero, size: PermitView.size(for: it, k: 1))), dark)
            pv.theme = dark ? .dark : .light
            pv.item = it; pv.more = more; pv.result = result
            placed.append(Placed(view: pv, x: x, y: y, god: nil))
            let c = card(dark, .thinking, name: it.tool == "Bash" ? "Claude" : "Scribe")
            if it.tool != "Bash" { c.god.kind = "scribe" }
            placed.append(Placed(view: c, x: x + pv.frame.width + 10, y: y, god: (c.god, 9)))
            x += pv.frame.width + 10 + c.frame.width + gap
            rowH = max(rowH, pv.frame.height, c.frame.height)
        }
        let c = card(dark, .listening, hover: true, pending: items.count, expanded: true)
        let lv = themed(PendingListView(frame: NSRect(origin: .zero, size: PendingListView.size(for: items.count, k: 1))), dark)
        lv.theme = dark ? .dark : .light
        lv.items = items
        let lx = x, cx = lx + lv.frame.width - c.frame.width
        placed.append(Placed(view: c, x: cx, y: y, god: (c.god, 2)))
        placed.append(Placed(view: lv, x: lx, y: y + c.frame.height + 8, god: nil))
        x += lv.frame.width + gap
        rowH = max(rowH, c.frame.height + 8 + lv.frame.height)
        maxW = max(maxW, x)
        y += rowH + pad
        bands.append((bandTop, y - bandTop - pad / 2, dark))
    }
    let W = maxW + pad - gap, H = y
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W * px), pixelsHigh: Int(H * px),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: W, height: H)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    // the film's soft background, light band then dark band
    for (i, b) in bands.enumerated() {
        let top = i == 0 ? 0 : b.y, bottom = i == bands.count - 1 ? H : b.y + b.h
        let r = NSRect(x: 0, y: H - bottom, width: W, height: bottom - top)
        (b.dark ? rgb(0x2a2b35) : rgb(0xeceef7)).setFill()
        r.fill()
    }
    for p in placed {
        let v = p.view
        let rr = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(v.frame.width * px), pixelsHigh: Int(v.frame.height * px),
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        rr.size = v.bounds.size
        v.cacheDisplay(in: v.bounds, to: rr)
        let dst = CGRect(x: p.x, y: H - p.y - v.frame.height, width: v.frame.width, height: v.frame.height)
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 30, color: NSColor(white: 0, alpha: 0.16).cgColor)
        if let img = rr.cgImage { ctx.draw(img, in: dst) }
        ctx.restoreGState()
        if let (g, i) = p.god, let strip = g.image, let f = Sprites.frame(strip, i) {
            let sr = g.spriteRect
            let gr = NSRect(x: g.frame.minX + sr.minX, y: g.frame.minY + sr.minY, width: sr.width, height: sr.height)
            ctx.saveGState()
            ctx.setAlpha(g.dim ? 0.5 : 1)
            ctx.interpolationQuality = .high
            ctx.draw(f, in: CGRect(x: p.x + gr.minX, y: H - p.y - gr.maxY, width: gr.width, height: gr.height))
            ctx.restoreGState()
        }
    }
    NSGraphicsContext.restoreGraphicsState()
    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: out))
}

let args = CommandLine.arguments
if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
    _ = NSApplication.shared
    snapshot(to: args[i + 1])
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Pill()
app.delegate = delegate
app.run()
