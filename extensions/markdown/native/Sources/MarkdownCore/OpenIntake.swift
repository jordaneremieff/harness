import Foundation

/// An open request file as it was read: its canonical location and the identity of the regular
/// file that held the request.
public struct RequestFile: Sendable, Equatable {
    public let url: URL
    let identity: FileIdentity
}

/// What the reader was asked to open.
public enum OpenTarget: Sendable {
    /// A stored document named by an open request inside a store.
    case stored(store: DirectoryStore, request: OpenRequest, requestFile: RequestFile)
    /// A plain Markdown file opened in place. It is not saved and carries no launch origin.
    case plainFile(URL)
}

public enum OpenIntakeError: Error, Equatable, Sendable, CustomStringConvertible {
    case notAnOpenRequest
    case unsupportedFile(String)
    case invalidRequest(String)
    /// The request path no longer names the regular file that the reader read.
    case requestReplaced
    case requestNotRemoved(String)
    case store(StoreError)

    public var description: String {
        switch self {
        case .notAnOpenRequest: "The file is not an open request inside a Markdown store."
        case .unsupportedFile(let name): "The reader opens Markdown files and open requests, not \(name)."
        case .invalidRequest(let reason): "The open request is invalid: \(reason)"
        case .requestReplaced: "The open request file was replaced after the reader read it. The reader left it in place and opened nothing."
        case .requestNotRemoved(let reason): "The reader could not remove the open request (\(reason)) and opened nothing."
        case .store(let error): error.description
        }
    }
}

public enum OpenIntake {
    public static let markdownExtensions: Set<String> = ["md", "markdown", "mdown", "mkd", "txt"]

    /// Classifies a file handed to the reader by the operating system.
    /// An open request is considered only as `<root>/opens/<name>.json` of a directory whose
    /// store.json carries the request's store ID; the store root is that directory and nothing in
    /// the request can name another location.
    public static func classify(_ url: URL) throws -> OpenTarget {
        let ext = url.pathExtension.lowercased()
        if ext == "json" {
            let path = FileAccess.canonicalPath(url.path)
            let file = URL(fileURLWithPath: path)
            let opens = file.deletingLastPathComponent()
            guard opens.lastPathComponent == StoreFormat.opensDirectory else { throw OpenIntakeError.notAnOpenRequest }
            let root = opens.deletingLastPathComponent()
            let store: DirectoryStore
            do {
                store = try DirectoryStore(root: root)
            } catch let error as StoreError {
                throw error == .notAStore ? OpenIntakeError.notAnOpenRequest : OpenIntakeError.store(error)
            }
            let (request, identity) = try readRequest(file)
            guard request.storeId == store.storeId else {
                throw OpenIntakeError.invalidRequest("it names store \(request.storeId), but the folder holds store \(store.storeId)")
            }
            return .stored(store: store, request: request, requestFile: RequestFile(url: file, identity: identity))
        }
        guard markdownExtensions.contains(ext) else { throw OpenIntakeError.unsupportedFile(url.lastPathComponent) }
        // The chosen file can be a symbolic link; the reader reads and watches the file it names.
        return .plainFile(URL(fileURLWithPath: FileAccess.canonicalPath(url.standardizedFileURL.path)))
    }

    static func readRequest(_ url: URL) throws -> (OpenRequest, FileIdentity) {
        let data: Data
        let identity: FileIdentity
        do {
            (data, identity) = try FileAccess.readRegularFileWithIdentity(url, limit: Limits.recordBytes, missing: .notFound(url.lastPathComponent))
        } catch let error as StoreError {
            throw OpenIntakeError.store(error)
        }
        var request: OpenRequest
        do {
            request = try JSONDecoder().decode(OpenRequest.self, from: data)
        } catch {
            throw OpenIntakeError.invalidRequest(error.localizedDescription)
        }
        guard request.version == StoreFormat.version else { throw OpenIntakeError.invalidRequest("version \(request.version)") }
        guard Identifiers.isDocumentId(request.document) else { throw OpenIntakeError.invalidRequest("document \(request.document)") }
        guard request.revision >= 1 else { throw OpenIntakeError.invalidRequest("revision \(request.revision)") }
        guard Identifiers.isStoreId(request.storeId) else { throw OpenIntakeError.invalidRequest("store \(request.storeId)") }
        if let origin = request.launchOrigin, !origin.isUsable { request.launchOrigin = nil }
        return (request, identity)
    }

    /// Accepts a classified open request: the pinned revision must exist with the requested
    /// digest. On success the request file is removed, which tells the opener that the reader
    /// took it; a request that fails stays in place. The removal unlinks only the regular file
    /// that was read; anything that replaced it stays and the acceptance fails.
    public static func accept(_ store: DirectoryStore, _ request: OpenRequest, requestFile: RequestFile) throws -> LoadedRevision {
        let loaded: LoadedRevision
        do {
            loaded = try store.loadRevision(request.document, revision: request.revision)
        } catch let error as StoreError {
            throw OpenIntakeError.store(error)
        }
        guard loaded.record.digest == request.digest else {
            throw OpenIntakeError.invalidRequest("revision \(request.revision) of \(request.document) has another digest than the request")
        }
        try remove(requestFile)
        return loaded
    }

    /// Unlinks the request relative to its directory when the name still holds the same regular
    /// file. `unlinkat` without `AT_REMOVEDIR` never removes a directory.
    static func remove(_ file: RequestFile) throws {
        let directory = open(file.url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw OpenIntakeError.requestReplaced }
        defer { close(directory) }
        let name = file.url.lastPathComponent
        var info = stat()
        guard fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) == 0,
              (info.st_mode & S_IFMT) == S_IFREG,
              FileIdentity(info) == file.identity
        else { throw OpenIntakeError.requestReplaced }
        guard unlinkat(directory, name, 0) == 0 else {
            throw OpenIntakeError.requestNotRemoved(String(cString: strerror(errno)))
        }
    }
}
