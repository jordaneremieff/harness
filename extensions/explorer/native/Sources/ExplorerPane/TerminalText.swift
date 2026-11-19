/// Plain text for a terminal screen. Text from a document, such as its title, passes through
/// `printable` before it reaches a terminal, so it cannot move the cursor, change the title,
/// write the clipboard or reorder the displayed text.
public enum TerminalText {
    /// Removes control, format and separator characters, including escape, C1 controls and
    /// bidirectional overrides.
    public static func printable(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.filter { scalar in
            switch scalar.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator: false
            default: true
            }
        }))
    }

    /// One line for a terminal's error output: the printable characters of `text`, shortened to
    /// `limit` characters, and a newline.
    public static func line(_ text: String, limit: Int = 400) -> String {
        fit(printable(text), limit) + "\n"
    }

    /// Shortens text to `width` characters, ending with an ellipsis when it was longer.
    public static func fit(_ text: String, _ width: Int) -> String {
        text.count <= width ? text : String(text.prefix(max(1, width - 1))) + "…"
    }

    /// Breaks text at spaces into lines of at most `width` characters; a longer word is shortened.
    public static func wrap(_ text: String, _ width: Int) -> [String] {
        var lines: [String] = []
        var line = ""
        for word in text.split(separator: " ") {
            if !line.isEmpty, line.count + 1 + word.count > width {
                lines.append(line)
                line = ""
            }
            line += (line.isEmpty ? "" : " ") + word
        }
        if !line.isEmpty { lines.append(line) }
        return lines.map { fit($0, width) }
    }
}
