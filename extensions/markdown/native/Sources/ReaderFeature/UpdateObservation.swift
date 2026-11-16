import Foundation
import MarkdownCore
import Observation
import SwiftUI

/// Whether the window can tell that a newer revision exists.
public enum UpdateObservation: Equatable, Sendable {
    /// No marker read has finished yet.
    case unconfirmed
    /// The watcher runs and the last marker read succeeded.
    case observed
    /// The watcher could not start or the last marker read failed. The shown revision stays
    /// readable, and a refresh checks again.
    case failed(String)
}

/// Watches the location whose change signals a new revision of one document and reads its
/// marker: the pointer's revision of a stored document, or the digest of a plain file. Setup
/// and read failures become a visible state instead of silence.
@MainActor @Observable
public final class UpdateObserver {
    public private(set) var state: UpdateObservation = .unconfirmed
    @ObservationIgnored private var watcher: DirectoryWatcher?
    @ObservationIgnored private var setupFailure: String?
    @ObservationIgnored private var reference: DocumentReference?
    @ObservationIgnored private var onChange: (@MainActor () async -> Void)?

    static let reasonLimit = 240

    public init() {}

    /// Starts watching unless a watcher runs. A failed setup is tried again at the next start.
    public func start(_ reference: DocumentReference, onChange: @escaping @MainActor () async -> Void) {
        guard watcher == nil else { return }
        self.reference = reference
        self.onChange = onChange
        do {
            let directory = try Self.watchedDirectory(reference)
            watcher = try DirectoryWatcher(directory: directory) { [weak self] lost in
                Task { @MainActor in await self?.changed(lost: lost) }
            }
            setupFailure = nil
        } catch {
            setupFailure = "the watcher could not start: \(Self.describe(error))"
            set(.failed(setupFailure!))
        }
    }

    public func stop() {
        watcher = nil
        onChange = nil
    }

    /// Reads the current marker off the main thread. Returns nil and records the reason when the
    /// read fails.
    public func readMarker(_ reference: DocumentReference) async -> String? {
        let outcome = await Task.detached { Result { try Self.marker(reference) } }.value
        switch outcome {
        case .success(let marker):
            set(setupFailure.map(UpdateObservation.failed) ?? .observed)
            return marker
        case .failure(let error):
            set(.failed("the current revision could not be read: \(Self.describe(error))"))
            return nil
        }
    }

    /// A removed or renamed directory leaves the descriptor watching nothing: start again on the
    /// path, which fails visibly while the directory is absent.
    private func changed(lost: Bool) async {
        if lost, let reference, let onChange {
            watcher = nil
            start(reference, onChange: onChange)
        }
        await onChange?()
    }

    private func set(_ next: UpdateObservation) {
        guard next != state else { return }
        state = next
        if case .failed(let reason) = next {
            readerLog.notice("updates not observed: \(reason, privacy: .public)")
        }
    }

    static func describe(_ error: any Error) -> String {
        let text = String(describing: error)
        return text.count > reasonLimit ? String(text.prefix(reasonLimit)) + "…" : text
    }

    static func watchedDirectory(_ reference: DocumentReference) throws -> URL {
        switch reference {
        case .stored(let root, _, let id):
            let store = try DirectoryStore(root: URL(fileURLWithPath: root))
            guard let location = store.pointerLocation(id) else { throw StoreError.notFound(id) }
            return location
        case .file(let path):
            return URL(fileURLWithPath: path).deletingLastPathComponent()
        }
    }

    nonisolated static func marker(_ reference: DocumentReference) throws -> String {
        switch reference {
        case .stored(let root, _, let id):
            return String(try DirectoryStore(root: URL(fileURLWithPath: root)).document(id).revision)
        case .file(let path):
            return Digest.sha256(try FileAccess.readRegularFile(URL(fileURLWithPath: path), limit: Limits.sourceBytes, missing: .notFound(path)))
        }
    }
}

/// Calls back on the main queue when a directory's entries change. `lost` is true when the
/// directory itself was removed or renamed.
final class DirectoryWatcher {
    struct SetupError: Error, CustomStringConvertible {
        var description: String
    }

    private let source: any DispatchSourceFileSystemObject

    init(directory: URL, onChange: @escaping @Sendable (_ lost: Bool) -> Void) throws {
        let descriptor = open(directory.path, O_EVTONLY)
        guard descriptor >= 0 else { throw SetupError(description: String(cString: strerror(errno))) }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .rename, .delete, .extend, .attrib], queue: .main)
        source.setEventHandler { [weak source] in
            let events = source?.data ?? []
            onChange(!events.isDisjoint(with: [.delete, .rename]))
        }
        source.setCancelHandler { close(descriptor) }
        source.resume()
        self.source = source
    }

    deinit {
        source.cancel()
    }
}

/// Says that the window cannot tell whether a newer revision exists, while the shown revision
/// stays readable, and offers the refresh that checks again.
struct UpdateObservationBanner: View {
    let model: ReaderModel

    var body: some View {
        if case .failed(let reason) = model.updates.state {
            Banner(systemImage: "eye.slash", tint: .orange) {
                Text("Updates not observed: \(reason). Refresh to check.")
            } action: {
                Button("Refresh") { Task { await model.refresh() } }
            }
        }
    }
}
