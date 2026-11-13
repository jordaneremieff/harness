import Darwin
import Foundation
import MarkdownCore

/// The pipe service accepts only bounded JSON lines and device-pixel viewports.
public struct FrameRequest: Sendable {
    public static let inputLimit = 16 * 1024
    public static let dimensionLimit = 8192
    public static let areaLimit = 16_777_216
    public static let maximumID = 9_007_199_254_740_991

    public enum Operation: String, Decodable, Sendable { case open, viewport, scroll, revision, frame }
    public struct Viewport: Sendable {
        public let width: Int
        public let height: Int
        public let scale: Double
        public let appearance: String
        public let textSize: Int
        public let background: String?
    }
    public let id: Int
    public let op: Operation
    public let root: String?
    public let document: String?
    public let revision: Int?
    public let digest: String?
    public let viewport: Viewport?
    public let to: Double?
    public let by: Double?
    public let edge: String?

    private struct Wire: Decodable {
        let id: Int
        let op: Operation
        let root: String?
        let document: String?
        let revision: Int?
        let digest: String?
        let width: Int?
        let height: Int?
        let scale: Double?
        let appearance: String?
        let textSize: Int?
        let background: String?
        let to: Double?
        let by: Double?
        let edge: String?
    }

    public static func decode(_ data: Data) throws -> FrameRequest {
        guard data.count <= inputLimit else { throw FrameProtocolError("input exceeds 16384 bytes") }
        let wire: Wire
        do { wire = try JSONDecoder().decode(Wire.self, from: data) }
        catch { throw FrameProtocolError("invalid request: \(error.localizedDescription)") }
        guard (1...maximumID).contains(wire.id) else { throw FrameProtocolError("id must be a positive safe integer") }
        var viewport: Viewport?
        if wire.op == .open || wire.op == .viewport {
            guard let width = wire.width, let height = wire.height,
                  (1...dimensionLimit).contains(width), (1...dimensionLimit).contains(height),
                  width * height <= areaLimit else { throw FrameProtocolError("invalid viewport dimensions") }
            guard let scale = wire.scale, scale.isFinite, (1...4).contains(scale) else { throw FrameProtocolError("scale must be between 1 and 4") }
            guard let appearance = wire.appearance, ["light", "dark"].contains(appearance) else { throw FrameProtocolError("appearance must be light or dark") }
            guard let textSize = wire.textSize, PageSettings.textSizes.indices.contains(textSize) else { throw FrameProtocolError("invalid textSize index") }
            if let background = wire.background {
                guard background.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil else { throw FrameProtocolError("background must be #rrggbb") }
            }
            viewport = Viewport(width: width, height: height, scale: scale, appearance: appearance, textSize: textSize, background: wire.background)
        }
        if wire.op == .open {
            guard let root = wire.root, root.hasPrefix("/"), !root.utf8.contains(0) else { throw FrameProtocolError("root must be an absolute store path") }
            guard let document = wire.document, Identifiers.isDocumentId(document) else { throw FrameProtocolError("invalid full document id") }
        }
        if wire.op == .open || wire.op == .revision {
            guard let revision = wire.revision, (1...maximumID).contains(revision) else { throw FrameProtocolError("revision must be a positive safe integer") }
            guard let digest = wire.digest, digest.range(of: "^sha256:[0-9a-f]{64}$", options: .regularExpression) != nil else { throw FrameProtocolError("invalid sha256 digest") }
        }
        if wire.op == .scroll {
            guard [wire.to != nil, wire.by != nil, wire.edge != nil].filter({ $0 }).count == 1 else { throw FrameProtocolError("scroll needs exactly one of to, by or edge") }
            if let value = wire.to, !value.isFinite || abs(value) > Double(maximumID) { throw FrameProtocolError("invalid scroll coordinate") }
            if let value = wire.by, !value.isFinite || abs(value) > Double(maximumID) { throw FrameProtocolError("invalid scroll distance") }
            if let edge = wire.edge, !["start", "end"].contains(edge) { throw FrameProtocolError("edge must be start or end") }
        }
        return FrameRequest(id: wire.id, op: wire.op, root: wire.root, document: wire.document, revision: wire.revision, digest: wire.digest, viewport: viewport, to: wire.to, by: wire.by, edge: wire.edge)
    }

    /// Malformed input has no usable correlation ID; zero is reserved for that error.
    public static func errorID(_ data: Data) -> Int {
        struct Identity: Decodable { let id: Int }
        guard data.count <= inputLimit, let value = try? JSONDecoder().decode(Identity.self, from: data), (1...maximumID).contains(value.id) else { return 0 }
        return value.id
    }
}

public struct FrameProtocolError: Error, CustomStringConvertible, Sendable {
    public let description: String
    public init(_ description: String) { self.description = description }
}

/// Reads one line at a time with bounded storage, discarding an oversized line through its LF.
/// The caller owns the handle and serialises calls to next().
public final class FrameLineReader: @unchecked Sendable {
    public enum Line: Sendable { case data(Data), oversized }
    private let input: FileHandle
    private var chunk = Data()
    private var index = 0
    private var ended = false

    public init(input: FileHandle) { self.input = input }

    public func next() throws -> Line? {
        var line = Data()
        var oversized = false
        while true {
            if index == chunk.count {
                guard !ended else { return oversized ? .oversized : (line.isEmpty ? nil : .data(line)) }
                var bytes = [UInt8](repeating: 0, count: 4096)
                let count = Darwin.read(input.fileDescriptor, &bytes, bytes.count)
                if count < 0 {
                    if errno == EINTR { continue }
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                }
                chunk = Data(bytes.prefix(count))
                index = 0
                if count == 0 { ended = true; continue }
            }
            let byte = chunk[index]
            index += 1
            if byte == 10 { return oversized ? .oversized : .data(line) }
            if !oversized {
                if line.count == FrameRequest.inputLimit { oversized = true; line.removeAll(keepingCapacity: false) }
                else { line.append(byte) }
            }
        }
    }
}
