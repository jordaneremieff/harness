import Foundation
import MarkdownCore
import WebKit

extension ReaderModel {
    public var canExportPDF: Bool {
        snapshot != nil && phase == .ready && (pageState?.overlay == nil || pageState?.overlay == "source")
    }

    public func exportRevision(_ form: RevisionExportForm) async {
        guard let snapshot, snapshot.record != nil else { return }
        do {
            if let url = try await platform.exportRevision(snapshot, form) {
                post("Revision \(snapshot.revision ?? 0) exported to \(url.lastPathComponent).", kind: .info)
            }
        } catch { post("The revision was not exported: \(error.localizedDescription)", kind: .warning) }
    }

    public func exportCurrentPagePDF() async {
        guard let snapshot, canExportPDF else { return }
        let nonce = rendered?.nonce
        let sourceMode = showingSource
        do {
            let data = try await page.exported(as: .pdf())
            guard self.snapshot?.digest == snapshot.digest, rendered?.nonce == nonce, showingSource == sourceMode else {
                post("The page changed during PDF export. Export the current page again.", kind: .warning)
                return
            }
            guard data.count <= 64 * 1024 * 1024 else { throw RevisionExportErrorForPage.tooLarge }
            let identity = snapshot.document?.id ?? "document"
            let revision = snapshot.revision.map { "-r\($0)" } ?? ""
            let mode = sourceMode ? "-source" : ""
            if let url = try await platform.savePDF(data, "\(identity)\(revision)\(mode).pdf") {
                post("The current page was exported to \(url.lastPathComponent).", kind: .info)
            }
        } catch { post("The PDF was not exported: \(error.localizedDescription)", kind: .warning) }
    }
}

private enum RevisionExportErrorForPage: LocalizedError {
    case tooLarge
    var errorDescription: String? { "The PDF exceeds the export byte bound." }
}
