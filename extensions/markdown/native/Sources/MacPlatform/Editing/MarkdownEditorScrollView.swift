import AppKit

/// Wrapped text tracks the logical viewport, including native pinch magnification.
@MainActor final class MarkdownEditorScrollView: NSScrollView {
    private var sizingDocument = false

    override func tile() {
        super.tile()
        fitWrappedDocument()
    }

    override func setMagnification(_ magnification: CGFloat, centeredAt point: NSPoint) {
        super.setMagnification(magnification, centeredAt: point)
        fitWrappedDocument()
    }

    override func magnify(with event: NSEvent) {
        super.magnify(with: event)
        fitWrappedDocument()
    }

    private func fitWrappedDocument() {
        guard !sizingDocument, let view = documentView as? NSTextView, !view.isHorizontallyResizable else { return }
        let width = max(1, contentView.bounds.width)
        guard abs(view.frame.width - width) > 0.5 else { return }
        sizingDocument = true
        view.setFrameSize(NSSize(width: width, height: view.frame.height))
        sizingDocument = false
    }
}
