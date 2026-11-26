import AppKit

enum TextCommand {
    case nextSelection, skipSelection, allSelections, splitSelection, caretAbove, caretBelow
    case lineComment, blockComment, indent, outdent
    case moveUp, moveDown, duplicate, deleteLine, insertBefore, insertAfter, join, selectLine
    case expandBrackets, jumpBracket
    case upper, lower, title, snake, camel, kebab
    case sort, reverse, unique, trimWhitespace, transpose, pasteIndent
    case fold, unfold, foldLevel(Int)
    case nextChange, previousChange
    case setIndentation(Bool, Int), convertIndentation(Bool)
}

extension WorkspaceScreen {
    func registerTextCommands() {
        func add(_ id: String, _ title: String, _ category: String, _ keys: String? = nil, _ command: TextCommand) {
            registry.register(EditorCommand(id, title, category: category, keys: keys,
                isEnabled: { [weak self] in self?.currentEditor != nil }) { [weak self] in
                guard let editor = self?.currentEditor else { return }
                editor.focus()
                editor.run(command)
            })
        }
        add("select.next", "Select Next Occurrence", "Selection", "cmd+D", .nextSelection)
        add("select.skip", "Skip Occurrence", "Selection", "cmd+K cmd+D", .skipSelection)
        add("select.allOccurrences", "Select All Occurrences", "Selection", "control+cmd+G", .allSelections)
        add("select.splitLines", "Split Selection into Lines", "Selection", "cmd+shift+L", .splitSelection)
        add("select.caretAbove", "Add Caret Above", "Selection", "control+shift+up", .caretAbove)
        add("select.caretBelow", "Add Caret Below", "Selection", "control+shift+down", .caretBelow)
        add("text.lineComment", "Toggle Line Comment", "Text", "cmd+/", .lineComment)
        add("text.blockComment", "Toggle Block Comment", "Text", "cmd+option+/", .blockComment)
        add("text.indent", "Indent", "Text", "cmd+]", .indent)
        add("text.outdent", "Outdent", "Text", "cmd+[", .outdent)
        add("line.up", "Move Line Up", "Line", "control+cmd+up", .moveUp)
        add("line.down", "Move Line Down", "Line", "control+cmd+down", .moveDown)
        add("line.duplicate", "Duplicate Line", "Line", "cmd+shift+D", .duplicate)
        add("line.delete", "Delete Line", "Line", "control+shift+K", .deleteLine)
        add("line.insertAfter", "Insert Line After", "Line", "cmd+return", .insertAfter)
        add("line.insertBefore", "Insert Line Before", "Line", "cmd+shift+return", .insertBefore)
        add("line.join", "Join Lines", "Line", "cmd+J", .join)
        add("line.select", "Select Line", "Selection", "cmd+L", .selectLine)
        add("bracket.expand", "Expand to Brackets", "Selection", "control+shift+M", .expandBrackets)
        add("bracket.jump", "Jump to Matching Bracket", "Selection", "control+M", .jumpBracket)
        add("case.upper", "Upper Case", "Convert Case", "cmd+K cmd+U", .upper)
        add("case.lower", "Lower Case", "Convert Case", "cmd+K cmd+L", .lower)
        add("case.title", "Title Case", "Convert Case", nil, .title)
        add("case.snake", "Snake Case", "Convert Case", nil, .snake)
        add("case.camel", "Camel Case", "Convert Case", nil, .camel)
        add("case.kebab", "Kebab Case", "Convert Case", nil, .kebab)
        add("line.sort", "Sort Lines", "Line", "F5", .sort)
        add("line.reverse", "Reverse Lines", "Line", nil, .reverse)
        add("line.unique", "Remove Duplicate Lines", "Line", nil, .unique)
        add("line.trimWhitespace", "Trim Trailing Whitespace", "Line", nil, .trimWhitespace)
        add("text.transpose", "Transpose", "Text", "control+T", .transpose)
        add("text.pasteIndent", "Paste and Indent", "Text", "cmd+shift+V", .pasteIndent)
        add("fold.selection", "Fold", "Code Folding", "cmd+option+[", .fold)
        add("fold.unfold", "Unfold", "Code Folding", "cmd+option+]", .unfold)
        add("fold.unfoldAll", "Unfold All", "Code Folding", "cmd+K cmd+J", .foldLevel(0))
        add("fold.clear", "Unfold All", "Code Folding", "cmd+K cmd+0", .foldLevel(0))
        for level in 1...9 { add("fold.level\(level)", "Fold to Level \(level)", "Code Folding", "cmd+K cmd+\(level)", .foldLevel(level)) }
        add("change.next", "Next Change", "Git", nil, .nextChange)
        add("change.previous", "Previous Change", "Git", nil, .previousChange)
        add("indentation.convertSpaces", "Convert to Spaces", "Indentation", nil, .convertIndentation(true))
        add("indentation.convertTabs", "Convert to Tabs", "Indentation", nil, .convertIndentation(false))
        for width in [2, 4, 8] {
            add("indentation.spaces\(width)", "Spaces: \(width)", "Indentation", nil, .setIndentation(true, width))
            add("indentation.tabs\(width)", "Tabs: \(width)", "Indentation", nil, .setIndentation(false, width))
        }
    }
}

extension CodeEditor {
    func run(_ command: TextCommand) {
        switch command {
        case .nextChange: moveToChange(direction: 1)
        case .previousChange: moveToChange(direction: -1)
        case .setIndentation(let spaces, let width): chooseIndentation(spaces: spaces, width: width)
        case .convertIndentation(let spaces): convertIndentation(spaces: spaces)
        default: textView.run(command)
        }
    }
}

extension CodeTextView {
    func run(_ command: TextCommand) {
        switch command {
        case .nextSelection: selectOccurrence()
        case .skipSelection: selectOccurrence(skip: true)
        case .allSelections: selectOccurrence(all: true)
        case .splitSelection: selectionLines()
        case .caretAbove: addCaret(by: -1)
        case .caretBelow: addCaret(by: 1)
        case .lineComment: toggleComment(block: false)
        case .blockComment: toggleComment(block: true)
        case .indent: indentLines(increase: true)
        case .outdent: indentLines(increase: false)
        case .moveUp: moveLines(direction: -1)
        case .moveDown: moveLines(direction: 1)
        case .duplicate: duplicateLines()
        case .deleteLine: deleteLines()
        case .insertBefore, .insertAfter: insertLines(before: command == .insertBefore)
        case .join: joinLines()
        case .selectLine:
            let ranges = selectedLineBlocks().map(lineBlockRange)
            select(ranges, reveal: ranges.last)
        case .expandBrackets: selectBrackets(jump: false)
        case .jumpBracket: selectBrackets(jump: true)
        case .upper, .lower, .title, .snake, .camel, .kebab: convertCase(command)
        case .sort, .reverse, .unique: rearrangeLines(command)
        case .trimWhitespace: _ = edit(cleanupEdits(trim: true, newline: false), reveal: false)
        case .transpose: transpose()
        case .pasteIndent: paste(from: .general, reindent: true)
        case .fold: foldSelection()
        case .unfold: unfoldSelections()
        case .foldLevel(let level): fold(to: level)
        default: break
        }
    }
}

extension TextCommand: Equatable {}
