import AppKit
import MarkdownCore
import UniformTypeIdentifiers

@MainActor
enum ExportPanel {
    static func revision(_ snapshot: DocumentSnapshot, form: RevisionExportForm) async throws -> URL? {
        guard let record = snapshot.record else { return nil }
        let panel = NSSavePanel()
        panel.title = form == .archive ? "Export Revision Archive" : "Export Sharing Copy"
        panel.prompt = "Export"
        panel.message = form == .archive
            ? "Create a new folder with exact source, original records and retained assets. Original records include private provenance."
            : "Create a new folder with derived Markdown and retained images. Store provenance is excluded; source content is not sanitised."
        panel.nameFieldStringValue = "\(record.document)-r\(record.revision)-\(form.rawValue)"
        panel.canCreateDirectories = true
        guard await response(panel) == .OK, let url = panel.url else { return nil }
        try await Task.detached(priority: .userInitiated) { try RevisionExporter.export(snapshot, to: url, form: form) }.value
        return url
    }

    static func pdf(_ data: Data, name: String) async throws -> URL? {
        let panel = NSSavePanel()
        panel.title = "Export Current Page PDF"
        panel.nameFieldStringValue = name
        panel.allowedContentTypes = [.pdf]
        panel.canCreateDirectories = true
        guard await response(panel) == .OK, let url = panel.url else { return nil }
        try await Task.detached(priority: .userInitiated) { try data.write(to: url, options: .atomic) }.value
        return url
    }

    private static func response(_ panel: NSSavePanel) async -> NSApplication.ModalResponse {
        await withCheckedContinuation { continuation in
            if let window = NSApp.keyWindow {
                panel.beginSheetModal(for: window) { continuation.resume(returning: $0) }
            } else { panel.begin { continuation.resume(returning: $0) } }
        }
    }
}
