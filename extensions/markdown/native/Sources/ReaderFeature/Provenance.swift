import Foundation
import MarkdownCore

/// Compact and detailed descriptions of where a document came from and what it contains.
public enum Provenance {
    /// The title a reader shows. A response's stored title only labels its provenance, so the
    /// content supplies the title; published documents and file snapshots keep their stored title.
    public static func displayTitle(_ snapshot: DocumentSnapshot, rendered: RenderedDocument?) -> String {
        if snapshot.document?.kind == .response, let title = rendered?.contentTitle { return title }
        return snapshot.title
    }

    public static func kindLabel(_ snapshot: DocumentSnapshot) -> String {
        switch snapshot.document?.kind {
        case .response: "Response"
        case .published: "Published"
        case .file: "File snapshot"
        case nil: "Local file"
        }
    }

    public static func completenessText(_ completeness: Completeness) -> String {
        if completeness.state == .complete {
            return completeness.reason == "tool-use" ? "Text written before tool calls" : "Complete response"
        }
        switch completeness.reason {
        case "length": return "Partial response: it stopped at the model's length limit."
        case "aborted": return "Partial response: it was stopped before it finished."
        case "error": return "Partial response: it ended with an error."
        default:
            return "Partial response" + (completeness.note.map { ": \($0)" } ?? ".")
        }
    }

    static func shortDate(_ iso: String?) -> String? {
        guard let iso else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    public struct ImageCounts: Equatable {
        public var retained: Int
        public var embedded: Int
        public var external: Int
        public var unavailable: Int
    }

    public static func images(_ rendered: RenderedDocument) -> ImageCounts {
        ImageCounts(
            retained: rendered.assets.count,
            embedded: rendered.embeddedImages,
            external: rendered.externalImages.count,
            unavailable: rendered.unavailableImages.count
        )
    }

    /// One line: kind, model, date, revision, size, completeness and contents. `latestRevision` is
    /// the newest revision the window knows.
    public static func summary(_ snapshot: DocumentSnapshot, rendered: RenderedDocument?, latestRevision: Int?) -> String {
        // A response's stored title is its provenance label; it replaces the kind label.
        var parts = [snapshot.document?.kind == .response ? snapshot.title : kindLabel(snapshot)]
        if let model = snapshot.record?.contentOrigin?.model { parts.append(model) }
        // A response's label already carries its time; the capture time stays in the details.
        if snapshot.document?.kind != .response, let date = shortDate(snapshot.record?.contentOrigin?.capturedAt ?? snapshot.record?.createdAt) {
            parts.append(date)
        }
        if let revision = snapshot.revision, let latest = latestRevision, latest > 1 {
            parts.append("revision \(revision) of \(latest)")
        }
        parts.append(size(snapshot.bytes))
        if snapshot.completeness.state == .partial {
            parts.append("partial (\(snapshot.completeness.reason ?? "incomplete"))")
        } else if snapshot.completeness.reason == "tool-use" {
            parts.append("text written before tool calls")
        }
        if let rendered {
            let counts = images(rendered)
            let total = counts.retained + counts.embedded + counts.external + counts.unavailable
            if total > 0 {
                var described: [String] = []
                if counts.retained + counts.embedded > 0 { described.append("\(counts.retained + counts.embedded) shown") }
                if counts.external > 0 { described.append("\(counts.external) external") }
                if counts.unavailable > 0 { described.append("\(counts.unavailable) unavailable") }
                parts.append("\(total) image\(total == 1 ? "" : "s"): " + described.joined(separator: ", "))
            }
            parts.append(rendered.selfContained ? "self-contained" : "has outside references")
        }
        return parts.joined(separator: " · ")
    }

    /// Every identifier and fact, for the details view and Copy Details.
    public static func details(_ snapshot: DocumentSnapshot?, rendered: RenderedDocument?, latestRevision: Int?, origin: LaunchOrigin?) -> [(String, String)] {
        guard let snapshot else { return [] }
        var rows: [(String, String)] = []
        func add(_ label: String, _ value: String?) {
            if let value, !value.isEmpty { rows.append((label, value)) }
        }
        add("Title", displayTitle(snapshot, rendered: rendered))
        add("Stored title", snapshot.title)
        add("Kind", kindLabel(snapshot))
        switch snapshot.reference {
        case .stored(let root, let storeId, let id):
            add("Document", id)
            add("Store", storeId)
            add("Store folder", root)
        case .file(let path):
            add("File", path)
        }
        if let revision = snapshot.revision {
            add("Revision", "\(revision) of \(latestRevision ?? revision)")
        }
        add("Digest", snapshot.digest)
        add("Size", "\(size(snapshot.bytes)) (\(snapshot.bytes) bytes)")
        add("Created", shortDate(snapshot.document?.createdAt))
        add("Updated", shortDate(snapshot.document?.updatedAt))
        add("Completeness", completenessText(snapshot.completeness))
        if let origin = snapshot.record?.contentOrigin {
            add("Source", origin.kind)
            add("Model", origin.model)
            add("Host", origin.host)
            add("Session", origin.session)
            add("Conversation", origin.conversation)
            add("Entry", origin.entry)
            add("Path", origin.path)
            add("Working directory", origin.cwd)
            add("Captured", shortDate(origin.capturedAt))
            if let parts = origin.parts, !parts.isEmpty {
                add("Text parts", parts.map { "\($0.chars) characters" }.joined(separator: ", "))
            }
        }
        if let rendered {
            let counts = images(rendered)
            add("Images", "\(counts.retained) retained, \(counts.embedded) embedded, \(counts.external) external (not loaded), \(counts.unavailable) unavailable")
            for item in rendered.unavailableImages.prefix(20) {
                add("Unavailable image", "\(item.reference) (\(MarkdownRenderer.reasonLabel(item.reason)))")
            }
            for url in rendered.externalImages.prefix(20) {
                add("External image", url.absoluteString)
            }
            add("Local-only links", rendered.localOnlyLinks > 0 ? "\(rendered.localOnlyLinks)" : nil)
            add("Self-contained", rendered.selfContained ? "yes" : "no")
            add("Raw HTML shown as text", rendered.rawHTMLFragments > 0 ? "\(rendered.rawHTMLFragments) fragments" : nil)
            add("Headings", "\(rendered.outline.count)")
            add("Code blocks", "\(rendered.codeBlocks.count)")
        }
        if let inventory = snapshot.record?.references {
            var text = inventory.state.rawValue
            if inventory.truncated == true || (inventory.omitted ?? 0) > 0 { text += ", inventory incomplete" }
            add("Reference inventory", text)
        }
        if let origin {
            add("Opened from", origin.terminal + (origin.exact == nil ? " (application only)" : " (pane recorded)"))
        } else {
            add("Opened from", "no terminal recorded")
        }
        return rows
    }
}
