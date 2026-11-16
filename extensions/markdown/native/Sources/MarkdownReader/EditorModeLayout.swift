import AppKit
import ReaderFeature
import SwiftUI

/// One mounted owner for the native source view. Modes change layout, never the source view's
/// parent: outgoing SwiftUI branches must not reclaim the editor from an incoming branch.
struct EditorModeLayout: NSViewRepresentable {
    let document: WorkingDocument

    func makeNSView(context: NSViewRepresentableContext<Self>) -> EditorModeSplitView {
        EditorModeSplitView(source: document.text.scrollView, preview: EditorDraftPreview(document: document), mode: document.mode)
    }

    func updateNSView(_ view: EditorModeSplitView, context: NSViewRepresentableContext<Self>) {
        view.setMode(document.mode)
    }
}

struct EditorDraftPreview: View {
    @Bindable var document: WorkingDocument
    var body: some View {
        VStack(spacing: 0) {
            if document.preview.draftGeneration != document.session.record.generation {
                HStack {
                    Text("Preview update pending").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }.padding(6)
            }
            ReaderView(model: document.preview, chrome: .preview)
        }
    }
}

final class EditorModeSplitView: NSSplitView, NSSplitViewDelegate {
    let source: NSScrollView
    let preview: NSHostingView<EditorDraftPreview>
    private(set) var mode: EditorMode
    private var fraction: CGFloat = 0.5
    private var arranging = false

    init(source: NSScrollView, preview: EditorDraftPreview, mode: EditorMode) {
        self.source = source; self.preview = NSHostingView(rootView: preview); self.mode = mode
        super.init(frame: .zero)
        isVertical = true; dividerStyle = .thin; delegate = self
        source.removeFromSuperview()
        addSubview(source); addSubview(self.preview)
        applyVisibility()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }

    func setMode(_ value: EditorMode) {
        guard mode != value else { return }
        mode = value
        applyVisibility()
        adjustSubviews()
    }

    private func applyVisibility() {
        source.isHidden = mode == .rendered
        preview.isHidden = mode == .styled || mode == .raw
        if source.isHidden, let responder = window?.firstResponder as? NSView,
           responder === source || responder.isDescendant(of: source) { window?.makeFirstResponder(nil) }
    }

    override func resizeSubviews(withOldSize oldSize: NSSize) {
        arranging = true
        defer { arranging = false }
        let width = max(0, bounds.width), height = max(0, bounds.height)
        switch mode {
        case .styled, .raw:
            source.frame = NSRect(x: 0, y: 0, width: width, height: height)
            preview.frame = .zero
        case .rendered:
            source.frame = .zero
            preview.frame = NSRect(x: 0, y: 0, width: width, height: height)
        case .split:
            let available = max(0, width - dividerThickness)
            let minimum = min(180, available / 2)
            let left = max(minimum, min(available - minimum, available * fraction))
            source.frame = NSRect(x: 0, y: 0, width: left, height: height)
            preview.frame = NSRect(x: left + dividerThickness, y: 0, width: available - left, height: height)
        }
    }

    func splitViewDidResizeSubviews(_ notification: Notification) {
        guard !arranging, mode == .split, bounds.width > dividerThickness else { return }
        fraction = min(0.8, max(0.2, source.frame.width / (bounds.width - dividerThickness)))
    }

    override func drawDivider(in rect: NSRect) {
        if mode == .split { super.drawDivider(in: rect) }
    }
}
