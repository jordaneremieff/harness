import AppKit

@MainActor
final class CodeCaretOverlay: NSView {
    private var carets: [NSView] = []
    private var timer: Timer?
    private var keyObserver: NSObjectProtocol?
    private var resignObserver: NSObjectProtocol?
    private var epoch = ProcessInfo.processInfo.systemUptime
    private weak var editor: CodeTextView?
    private var synchronizing = false

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func observe(_ editor: CodeTextView) {
        self.editor = editor
        wantsLayer = true
        clipsToBounds = true
        setAccessibilityElement(false)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        let center = NotificationCenter.default
        if let keyObserver { center.removeObserver(keyObserver) }
        if let resignObserver { center.removeObserver(resignObserver) }
        keyObserver = nil
        resignObserver = nil
        if let window {
            keyObserver = center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window, queue: nil) { [weak self] _ in
                MainActor.assumeIsolated { self?.synchronize(restart: true) }
            }
            resignObserver = center.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: nil) { [weak self] _ in
                MainActor.assumeIsolated { self?.synchronize(restart: false) }
            }
        }
        synchronize(restart: true)
    }

    func synchronize(restart: Bool) {
        guard !synchronizing else { return }
        synchronizing = true
        defer { synchronizing = false }
        guard let editor, let window, window.isKeyWindow, window.firstResponder === editor, editor.isEditable else {
            for caret in carets { caret.isHidden = true }
            timer?.invalidate()
            timer = nil
            return
        }
        let settings = editor.sourceSettings
        let selections = editor.selections.filter { $0.anchor == $0.head }
        let clip = editor.visibleRect
        var count = 0
        if !selections.isEmpty, let span = editor.visibleCharacterSpan(in: clip) {
            for selection in selections where selection.head >= span.location && selection.head <= NSMaxRange(span) {
                guard var body = editor.caretRect(at: selection.head), body.intersects(clip) else { continue }
                body.size.width = settings.blockCaret ? min(max(editor.spaceWidth, 1), max(body.width, 1)) : settings.caretWidth
                body.origin.x = floor(body.minX)
                let frame = convert(body, from: editor).intersection(bounds)
                guard !frame.isEmpty else { continue }
                let caret: NSView
                if count < carets.count { caret = carets[count] }
                else {
                    caret = NSView()
                    caret.wantsLayer = true
                    addSubview(caret)
                    carets.append(caret)
                }
                if caret.frame != frame { caret.frame = frame }
                let color = editor.sourceTheme.caret.withAlphaComponent(settings.blockCaret ? 0.48 : 1).cgColor
                if caret.layer?.backgroundColor != color { caret.layer?.backgroundColor = color }
                caret.isHidden = false
                count += 1
            }
        }
        while carets.count > count { carets.removeLast().removeFromSuperview() }
        if restart { epoch = ProcessInfo.processInfo.systemUptime }
        updateOpacity()
        if count == 0 || !settings.animations || settings.caretStyle == "solid" {
            timer?.invalidate()
            timer = nil
        } else if timer == nil {
            let timer = Timer(timeInterval: 1.0 / 24, repeats: true) { [weak self] timer in
                guard let self else { timer.invalidate(); return }
                MainActor.assumeIsolated { self.updateOpacity() }
            }
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
        }
    }

    func updateOpacity(now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        guard let editor, !carets.isEmpty else { return }
        let settings = editor.sourceSettings
        let elapsed = now - epoch
        let cycle = (elapsed - 0.52).truncatingRemainder(dividingBy: 1.04)
        let opacity: CGFloat
        if !settings.animations || elapsed <= 0.52 { opacity = 1 }
        else {
            switch settings.caretStyle {
            case "smooth": opacity = (1 + cos(cycle * .pi * 2 / 1.04)) / 2
            case "phase": opacity = cycle >= 0.52 ? 1 : exp(-7 * cycle / 0.52)
            case "blink": opacity = cycle >= 0.52 ? 1 : 0
            default: opacity = 1
            }
        }
        if alphaValue != opacity { alphaValue = opacity }
    }
}
