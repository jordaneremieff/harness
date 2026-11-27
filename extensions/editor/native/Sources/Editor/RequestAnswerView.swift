import AppKit

@MainActor
final class RequestAnswerView: NSTextView {
    private let body: AttributedString
    private let storage = NSTextStorage()

    init(_ text: String) {
        body = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: CGFloat.zero, height: CGFloat.greatestFiniteMagnitude))
        storage.addLayoutManager(layout)
        layout.addTextContainer(container)
        super.init(frame: .zero, textContainer: container)
        container.widthTracksTextView = true
        isHorizontallyResizable = false
        isVerticallyResizable = false
        isEditable = false
        isSelectable = true
        isRichText = true
        importsGraphics = false
        drawsBackground = false
        textContainerInset = .zero
        textContainer?.lineFragmentPadding = 0
        linkTextAttributes = [:]
        applyLook()
    }

    required init?(coder: NSCoder) { nil }

    func applyLook() {
        let theme = WorkspaceStyle.theme
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        let result = NSMutableAttributedString()
        for run in body.runs {
            let intent = run.inlinePresentationIntent ?? []
            let code = intent.contains(.code)
            var font = code ? WorkspaceStyle.settings.sourceFont : WorkspaceStyle.interfaceFont()
            if intent.contains(.stronglyEmphasized) { font = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask) }
            if intent.contains(.emphasized) { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) }
            var attributes: [NSAttributedString.Key: Any] = [
                .font: font, .foregroundColor: code ? theme.syntax("string") ?? theme.text : theme.text,
                .paragraphStyle: paragraph,
            ]
            if let link = run.link, let scheme = link.scheme?.lowercased(), ["https", "http"].contains(scheme) {
                attributes[.link] = link
                attributes[.foregroundColor] = theme.accent
                attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
            }
            result.append(NSAttributedString(string: String(body[run.range].characters), attributes: attributes))
        }
        storage.setAttributedString(result)
    }

    func height(at width: CGFloat) -> CGFloat {
        ceil(attributedString().boundingRect(with: NSSize(width: max(1, width), height: .greatestFiniteMagnitude),
                                              options: [.usesLineFragmentOrigin, .usesFontLeading]).height)
    }
}
