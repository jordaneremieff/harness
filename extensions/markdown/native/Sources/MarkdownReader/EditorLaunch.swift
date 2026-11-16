import EditorFeature
import MarkdownCore

struct EditorLaunch: Sendable {
    enum Surface: String, Sendable { case pane, window }
    enum Intent: String, Sendable { case scratchpad, file, edit, copy }
    let surface: Surface
    let store: String
    let intent: Intent
    let input: String?
    let origin: LaunchOrigin?

    static let usage = "--editor --surface pane|window --store <absolute directory> --intent scratchpad|file|edit|copy [--origin <JSON>] [absolute input path]"

    static func parse(_ arguments: [String]) throws -> EditorLaunch {
        guard arguments.count <= 12 else { throw FileSaveError.invalid(usage) }
        var values: [String: String] = [:], positional: [String] = []
        var index = 0
        while index < arguments.count {
            let word = arguments[index]
            if word.hasPrefix("--") {
                guard ["--surface", "--store", "--intent", "--origin"].contains(word),
                      values[word] == nil, index + 1 < arguments.count else { throw FileSaveError.invalid(usage) }
                values[word] = arguments[index + 1]; index += 2
            } else { positional.append(word); index += 1 }
        }
        guard let surface = values["--surface"].flatMap(Surface.init),
              let intent = values["--intent"].flatMap(Intent.init),
              let store = values["--store"], validPath(store),
              positional.count == (intent == .scratchpad ? 0 : 1),
              positional.allSatisfy(validPath) else { throw FileSaveError.invalid(usage) }
        var origin: LaunchOrigin?
        if let json = values["--origin"] {
            guard intent == .scratchpad || intent == .file, json.utf8.count <= 16384,
                  let decoded = try? JSONDecoder().decode(LaunchOrigin.self, from: Data(json.utf8)), decoded.isUsable else {
                throw FileSaveError.invalid("The editor launch origin is invalid.")
            }
            origin = decoded
        }
        return EditorLaunch(surface: surface, store: store, intent: intent, input: positional.first, origin: origin)
    }

    private static func validPath(_ path: String) -> Bool {
        path.hasPrefix("/") && path.utf8.count <= 4096 && !path.utf8.contains(0)
    }

    /// Loads the requested base without changing it. Only a validated open request is consumed.
    func load() throws -> (DraftRecord, LaunchOrigin?) {
        switch intent {
        case .scratchpad:
            return (DraftRecord(), origin)
        case .file:
            guard let input else { throw FileSaveError.invalid(Self.usage) }
            let url = URL(fileURLWithPath: input)
            let opened = try LocalFileSave.open(url)
            return (DraftRecord(title: url.lastPathComponent, source: opened.source, destination: .file(opened.base), savedSource: opened.source), origin)
        case .edit, .copy:
            guard let input, case .stored(let directory, let request, let file) = try OpenIntake.classify(URL(fileURLWithPath: input)),
                  FileAccess.canonicalPath(directory.root.path) == FileAccess.canonicalPath(store) else {
                throw FileSaveError.invalid("The edit request does not belong to the selected store.")
            }
            let checked = try directory.loadRevision(request.document, revision: request.revision)
            guard intent == .copy || checked.document.kind == .published else {
                throw FileSaveError.invalid("Captured files and responses are read-only. Choose Edit Copy.")
            }
            let loaded = try OpenIntake.accept(directory, request, requestFile: file)
            let base = StoredEditBase(root: FileAccess.canonicalPath(store), storeId: directory.storeId, document: request.document, revision: request.revision, digest: request.digest)
            let destination: EditDestination = intent == .copy ? .copy(base) : .published(base)
            return (DraftRecord(title: loaded.record.title, source: loaded.source, destination: destination, savedSource: intent == .edit ? loaded.source : nil), request.launchOrigin)
        }
    }
}
