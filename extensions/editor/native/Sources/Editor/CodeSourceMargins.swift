import AppKit

struct CodeMapRow: Sendable {
    struct Run: Sendable {
        let column: Int
        let length: Int
        let role: SyntaxRole
    }
    let line: Int
    let runs: [Run]

    static func overview(_ snapshot: String, language: String, tabWidth: Int) -> [Self] {
        let lines = snapshot.split(separator: "\n", omittingEmptySubsequences: false)
        let stride = max(1, (lines.count + 479) / 480)
        let profile = SyntaxLexicon.profile(language)
        var state = SyntaxState()
        var rows: [Self] = []
        for line in Swift.stride(from: 0, to: lines.count, by: stride) {
            if Task.isCancelled { return [] }
            let preview = String(lines[line].prefix(144))
            let next = line + 1 < lines.count && language == "markdown" ? String(lines[line + 1].prefix(144)) : nil
            let tokens: [SyntaxToken]
            if language == "plain" { tokens = [] }
            else if language == "markdown" {
                (state, tokens) = SyntaxMarkdown.scan(preview, offset: 0, nextLine: next, state: state, emit: true)
            } else {
                var lexer = SyntaxLexer(preview, offset: 0, profile: profile, state: state, emit: true)
                (state, tokens) = lexer.run()
            }
            if stride > 1 { state = SyntaxState() }
            var runs: [Run] = []
            var column = 0, token = 0
            for (offset, unit) in preview.utf16.enumerated() {
                if unit == 32 { column += 1; continue }
                if unit == 9 { column += tabWidth - column % tabWidth; continue }
                if column >= 140 { break }
                while token < tokens.count, NSMaxRange(tokens[token].range) <= offset { token += 1 }
                let role = token < tokens.count && NSLocationInRange(offset, tokens[token].range) ? tokens[token].role : .plain
                if let last = runs.last, last.role == role, last.column + last.length == column {
                    runs[runs.count - 1] = Run(column: last.column, length: last.length + 1, role: role)
                } else { runs.append(Run(column: column, length: 1, role: role)) }
                column += 1
            }
            rows.append(Self(line: line, runs: runs))
        }
        return rows
    }
}

@MainActor
final class CodeGutterView: NSView {
    weak var editor: CodeTextView?
    var changes: [Int: CodeChangeKind] = [:]
    override var isFlipped: Bool { true }

    func invalidateActiveLine(from old: Int, to next: Int) {
        guard !isHidden, let editor else { return }
        for row in editor.visibleRows(in: editor.visibleRect) where row.line == old || row.line == next {
            let rect = convert(row.rect, from: editor)
            setNeedsDisplay(NSRect(x: 0, y: rect.minY, width: bounds.width, height: rect.height).intersection(bounds))
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let editor else { return }
        let theme = editor.sourceTheme
        let appearance = editor.sourceSettings
        theme.gutter.setFill()
        dirtyRect.intersection(bounds).fill()
        let visible = editor.visibleRows(in: editor.visibleRect)
        let active = editor.line(at: editor.selections.last?.head ?? 0)
        var last = -1
        for cell in visible {
            let row = cell.line
            guard row != last else { continue }
            last = row
            let rect = convert(cell.rect, from: editor)
            guard rect.minY < dirtyRect.maxY, rect.maxY > dirtyRect.minY else { continue }
            let isActive = appearance.highlightLine && row == active
            if isActive {
                theme.currentLine.setFill()
                NSRect(x: 0, y: rect.minY, width: bounds.width, height: rect.height).fill()
            }
            if appearance.lineNumbers {
                let font = NSFont.monospacedDigitSystemFont(ofSize: max(9, min(14, appearance.fontSize * 0.78)), weight: isActive ? .semibold : .regular)
                let style: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: isActive ? theme.activeLineNumber : theme.lineNumber]
                let number = "\(row + 1)" as NSString
                let size = number.size(withAttributes: style)
                number.draw(at: NSPoint(x: bounds.maxX - size.width - (appearance.foldButtons ? 19 : 7),
                                        y: floor(rect.midY - size.height / 2)), withAttributes: style)
            }
            if appearance.gitGutter, let kind = changes[row] {
                theme.change(kind).setFill()
                let h = kind == .deleted ? 3 : max(4, rect.height - 4)
                NSBezierPath(roundedRect: NSRect(x: 4, y: kind == .deleted ? rect.minY : rect.midY - h / 2, width: 3, height: h),
                             xRadius: 1.5, yRadius: 1.5).fill()
            }
            let folded = editor.isFolded(line: row)
            if appearance.foldButtons, folded || editor.canFold(line: row) {
                (folded ? theme.activeLineNumber : theme.foldMark).setStroke()
                let x = bounds.maxX - 9, y = rect.midY
                let chevron = NSBezierPath()
                if folded {
                    chevron.move(to: NSPoint(x: x - 2, y: y - 3))
                    chevron.line(to: NSPoint(x: x + 1, y: y))
                    chevron.line(to: NSPoint(x: x - 2, y: y + 3))
                } else {
                    chevron.move(to: NSPoint(x: x - 3, y: y - 1))
                    chevron.line(to: NSPoint(x: x, y: y + 2))
                    chevron.line(to: NSPoint(x: x + 3, y: y - 1))
                }
                chevron.lineWidth = 1.35
                chevron.lineCapStyle = .round
                chevron.lineJoinStyle = .round
                chevron.stroke()
            }
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard let editor else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard let row = editor.visibleRows(in: editor.visibleRect).first(where: {
            let rect = convert($0.rect, from: editor)
            return point.y >= rect.minY && point.y < rect.maxY
        })?.line else { return }
        if editor.sourceSettings.foldButtons, point.x >= bounds.maxX - 17,
           editor.isFolded(line: row) || editor.canFold(line: row) { editor.toggleFold(line: row) }
        else if editor.sourceSettings.lineNumbers {
            editor.window?.makeFirstResponder(editor)
            editor.select([editor.lineRange(row)])
        }
    }
}

@MainActor
final class CodeMinimapView: NSView {
    weak var editor: CodeTextView?
    var rows: [CodeMapRow] = []
    var changes: [Int: CodeChangeKind] = [:]
    var onScroll: ((Int) -> Void)?
    override var isFlipped: Bool { true }

    private var chart: NSRect {
        let height = min(max(0, bounds.height - 16), CGFloat(editor?.lineCount ?? 1) * 3)
        return NSRect(x: 6, y: 8, width: max(0, bounds.width - 12), height: height)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let editor else { return }
        let theme = editor.sourceTheme
        theme.editor.setFill()
        dirtyRect.intersection(bounds).fill()
        theme.ruler.setFill()
        NSRect(x: 0, y: 0, width: 1, height: bounds.height).fill()
        let map = chart
        guard map.height > 0, map.width > 0 else { return }
        let lineCount = CGFloat(max(editor.lineCount, 1))
        let scale = map.height / lineCount
        let left = map.minX + 3
        let right = map.maxX - 4
        let dx = (right - left) / 104
        var colors: [SyntaxRole: NSColor] = [:]
        var lastY: CGFloat = -1
        for row in rows {
            let y = floor(map.minY + CGFloat(row.line) * scale)
            if y == lastY || y >= map.maxY { continue }
            lastY = y
            let height = min(2, max(1, scale * 0.55))
            for run in row.runs where run.column < 104 {
                if let color = colors[run.role] { color.setFill() }
                else {
                    let color = (theme.syntax("\(run.role)") ?? theme.secondaryText).withAlphaComponent(run.role == .plain ? 0.45 : 0.68)
                    colors[run.role] = color
                    color.setFill()
                }
                NSRect(x: left + CGFloat(run.column) * dx, y: y, width: CGFloat(min(104 - run.column, run.length)) * dx, height: height).fill()
            }
        }
        if editor.sourceSettings.gitGutter {
            var marked: Set<Int> = []
            for (row, state) in changes {
                let y = Int(floor(map.minY + CGFloat(row) * scale))
                guard marked.insert(y).inserted else { continue }
                theme.change(state).setFill()
                NSRect(x: map.maxX - 2, y: CGFloat(y), width: 3, height: max(1, min(scale, 3))).fill()
            }
        }
        theme.findCurrent.setFill()
        for line in editor.mapFindLines {
            let y = floor(map.minY + CGFloat(line) * scale)
            NSRect(x: map.minX, y: y, width: 3, height: max(1, min(scale, 3))).fill()
        }
        let visibleRows = editor.visibleRows(in: editor.visibleRect)
        if let top = visibleRows.first?.line, let bottom = visibleRows.last?.line {
            let minY = map.minY + CGFloat(top) * scale
            let high = map.minY + CGFloat(bottom + 1) * scale
            let height = min(map.height, max(7, high - minY))
            let viewport = NSRect(x: map.minX, y: min(minY, map.maxY - height), width: map.width, height: height)
            theme.minimapViewport.setFill()
            NSBezierPath(roundedRect: viewport, xRadius: 3, yRadius: 3).fill()
            theme.activeIndentGuide.setStroke()
            let edge = NSBezierPath(roundedRect: viewport.insetBy(dx: 0.5, dy: 0.5), xRadius: 3, yRadius: 3)
            edge.lineWidth = 0.7
            edge.stroke()
        }
    }

    override func mouseDown(with event: NSEvent) { scroll(with: event) }
    override func mouseDragged(with event: NSEvent) { scroll(with: event) }

    private func scroll(with event: NSEvent) {
        guard let editor, chart.height > 0 else { return }
        let point = convert(event.locationInWindow, from: nil)
        let ratio = min(1, max(0, (point.y - chart.minY) / chart.height))
        onScroll?(min(editor.lineCount - 1, Int(ratio * CGFloat(editor.lineCount))))
    }
}

private extension EditorTheme {
    func change(_ kind: CodeChangeKind) -> NSColor {
        switch kind {
        case .added: added
        case .modified: modified
        case .deleted: deleted
        }
    }
}
