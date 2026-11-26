import AppKit

struct WorkspaceFileIcon {
    let symbol: String
    let role: String?

    @MainActor var colour: NSColor {
        role.flatMap { WorkspaceStyle.theme.role($0) } ?? WorkspaceStyle.theme.secondaryText
    }

    static func forPath(_ path: String) -> Self {
        let name = (path as NSString).lastPathComponent.lowercased()
        switch name {
        case ".gitignore", ".gitattributes", ".gitmodules": return .init(symbol: "arrow.triangle.branch", role: "peach")
        case "dockerfile", "containerfile": return .init(symbol: "shippingbox", role: "blue")
        case "makefile", "gemfile", "justfile", ".env", ".editorconfig": return .init(symbol: "slider.horizontal.3", role: "flamingo")
        default: break
        }
        switch (name as NSString).pathExtension {
        case "swift": return .init(symbol: "swift", role: "peach")
        case "ts", "tsx", "mts", "cts": return .init(symbol: "chevron.left.forwardslash.chevron.right", role: "blue")
        case "js", "jsx", "mjs", "cjs": return .init(symbol: "chevron.left.forwardslash.chevron.right", role: "yellow")
        case "py", "pyi", "ipynb": return .init(symbol: "chevron.left.forwardslash.chevron.right", role: "sky")
        case "rs", "rb": return .init(symbol: "chevron.left.forwardslash.chevron.right", role: "maroon")
        case "go", "c", "h", "cpp", "hpp", "java", "kt", "cs": return .init(symbol: "chevron.left.forwardslash.chevron.right", role: "sapphire")
        case "html", "xml", "svg": return .init(symbol: "chevron.left.forwardslash.chevron.right", role: "peach")
        case "css", "scss", "less": return .init(symbol: "paintbrush.pointed", role: "mauve")
        case "md", "markdown", "rst": return .init(symbol: "text.alignleft", role: "lavender")
        case "json", "json5", "jsonc": return .init(symbol: "curlybraces", role: "yellow")
        case "toml", "ini", "cfg", "yaml", "yml", "plist": return .init(symbol: "slider.horizontal.3", role: "flamingo")
        case "sh", "bash", "zsh", "fish": return .init(symbol: "terminal", role: "green")
        case "sql", "sqlite", "db", "csv", "tsv": return .init(symbol: "tablecells", role: "teal")
        case "png", "jpg", "jpeg", "gif", "heic", "webp", "ico": return .init(symbol: "photo", role: "pink")
        case "pdf": return .init(symbol: "doc.richtext", role: "red")
        case "zip", "tar", "gz", "xz", "bz2", "7z": return .init(symbol: "archivebox", role: "yellow")
        case "lock": return .init(symbol: "lock", role: nil)
        default: return .init(symbol: "doc.text", role: nil)
        }
    }
}
