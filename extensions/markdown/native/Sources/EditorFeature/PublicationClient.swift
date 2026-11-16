import Darwin
import MarkdownCore

public struct PublicationBase: Codable, Sendable {
    public var document: String
    public var revision: Int
    public var digest: String
    public init(_ base: StoredEditBase) { document = base.document; revision = base.revision; digest = base.digest }
}

public struct StagedImage: Codable, Equatable, Sendable {
    public var reference: String
    public var relativePath: String
    public var digest: String
    public var bytes: Int
}

public struct PublicationRequest: Codable, Sendable {
    public var version = 1
    public var operation = "save"
    public var storeRoot: String
    public var storeId: String
    public var invocationId: String
    public var generation: UInt64
    public var title: String
    public var source: String
    public var base: PublicationBase?
    public var derivation: PublicationBase?
    public var assetRoot: String?
    public var stagedAssets: [StagedImage]?

    public init(record: DraftRecord, root: String, storeId: String) {
        storeRoot = root; self.storeId = storeId; invocationId = UUID().uuidString
        generation = record.generation; title = record.displayTitle; source = record.source
        switch record.destination {
        case .published(let previous): base = PublicationBase(previous)
        case .copy(let previous): derivation = PublicationBase(previous)
        default: break
        }
    }
}

public struct PublicationOutcome: Decodable, Sendable {
    public struct Failure: Decodable, Sendable {
        public var code: String
        public var message: String
        public var currentRevision: Int?
        public var currentDigest: String?
    }
    public var version: Int
    public var ok: Bool
    public var status: String?
    public var invocationId: String?
    public var generation: UInt64?
    public var storeId: String?
    public var document: String?
    public var revision: Int?
    public var digest: String?
    public var outcome: String?
    public var error: Failure?
}

/// The bundled writer is fixed application code. Requests never select an executable or helper.
public struct PublicationClient: Sendable {
    public let node: URL
    public let helper: URL
    public var timeout: TimeInterval = 20
    public init(node: URL, helper: URL) { self.node = node; self.helper = helper }

    public static func fromBundle(_ bundle: Bundle = .main) -> PublicationClient? {
        guard let resources = bundle.resourceURL,
              let data = try? FileAccess.readRegularFile(resources.appendingPathComponent("build.json"), limit: Limits.recordBytes, missing: .notFound("build.json")),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let writer = json["editorWriter"] as? [String: Any], writer["version"] as? Int == 1,
              let node = writer["node"] as? String, node.hasPrefix("/"),
              writer["helper"] as? String == "editor-writer/editor-helper.mjs" else { return nil }
        let helper = resources.appendingPathComponent("editor-writer/editor-helper.mjs")
        guard FileManager.default.isExecutableFile(atPath: node), FileManager.default.fileExists(atPath: helper.path) else { return nil }
        return PublicationClient(node: URL(fileURLWithPath: node), helper: helper)
    }

    public func identity(root: String) async throws -> String {
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "operation": "identity", "storeRoot": root])
        let outcome = try await execute(data)
        guard outcome.ok, outcome.status == "identity", let id = outcome.storeId, Identifiers.isStoreId(id) else {
            throw FileSaveError.invalid(outcome.error?.message ?? "The writer returned no store identity.")
        }
        return id
    }

    public func send(_ request: PublicationRequest) async throws -> PublicationOutcome {
        let result = try await execute(JSONEncoder().encode(request))
        guard result.invocationId == request.invocationId, result.generation == request.generation, result.storeId == request.storeId else {
            throw FileSaveError.invalid("The writer receipt does not match this save. Keep the draft and reconcile this invocation.")
        }
        if result.ok, result.status == "saved" {
            guard let document = result.document, Identifiers.isDocumentId(document), let revision = result.revision, revision > 0,
                  result.digest == Digest.sha256(Data(request.source.utf8)) else {
                throw FileSaveError.invalid("The saved receipt has an invalid source identity.")
            }
        }
        return result
    }

    private func execute(_ input: Data) async throws -> PublicationOutcome {
        guard input.count <= Limits.sourceBytes * 6 + Limits.recordBytes else { throw FileSaveError.invalid("The save request is too large.") }
        let output = try await Task.detached { try run(input) }.value
        let result = try JSONDecoder().decode(PublicationOutcome.self, from: output)
        guard result.version == 1 else { throw FileSaveError.invalid("Unsupported editor writer response version.") }
        return result
    }

    private static let ignoreBrokenPipe: Void = { signal(SIGPIPE, SIG_IGN) }()

    private func run(_ input: Data) throws -> Data {
        _ = Self.ignoreBrokenPipe
        let process = Process(), stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.executableURL = node; process.arguments = [helper.path]
        process.environment = ["PATH": "/usr/bin:/bin"]
        process.standardInput = stdin; process.standardOutput = stdout; process.standardError = stderr
        try process.run()
        let inputFD = stdin.fileHandleForWriting.fileDescriptor
        let outputFD = stdout.fileHandleForReading.fileDescriptor
        let errorFD = stderr.fileHandleForReading.fileDescriptor
        for fd in [inputFD, outputFD, errorFD] { _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) }
        defer {
            try? stdin.fileHandleForWriting.close(); try? stdout.fileHandleForReading.close(); try? stderr.fileHandleForReading.close()
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var sent = 0, inputClosed = false, outputClosed = false, errorClosed = false
        var output = Data(), errors = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        while !(outputClosed && errorClosed && !process.isRunning) {
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw FileSaveError.invalid("The save response timed out. Its outcome is unknown; reconcile before another save.") }
            var descriptors = [pollfd(fd: inputClosed ? -1 : inputFD, events: Int16(POLLOUT), revents: 0), pollfd(fd: outputClosed ? -1 : outputFD, events: Int16(POLLIN), revents: 0), pollfd(fd: errorClosed ? -1 : errorFD, events: Int16(POLLIN), revents: 0)]
            _ = poll(&descriptors, nfds_t(descriptors.count), 50)
            if !inputClosed, descriptors[0].revents != 0 {
                let count = input.withUnsafeBytes { bytes in Darwin.write(inputFD, bytes.baseAddress!.advanced(by: sent), input.count - sent) }
                if count > 0 { sent += count }
                if sent == input.count || (count < 0 && errno != EAGAIN && errno != EINTR) {
                    try? stdin.fileHandleForWriting.close(); inputClosed = true
                }
            }
            if !outputClosed, descriptors[1].revents != 0 {
                let count = Darwin.read(outputFD, &buffer, buffer.count)
                if count > 0 { output.append(contentsOf: buffer.prefix(count)) }
                if count == 0 { outputClosed = true }
                if output.count > Limits.recordBytes { throw FileSaveError.invalid("The writer response exceeded its limit; save outcome is unknown.") }
            }
            if !errorClosed, descriptors[2].revents != 0 {
                let count = Darwin.read(errorFD, &buffer, buffer.count)
                if count > 0, errors.count < 4096 { errors.append(contentsOf: buffer.prefix(min(count, 4096 - errors.count))) }
                if count == 0 { errorClosed = true }
            }
        }
        guard process.terminationStatus == 0 else { throw FileSaveError.invalid("The writer exited without a confirmed save (status \(process.terminationStatus)). Keep the draft and reconcile.") }
        return output
    }
}
