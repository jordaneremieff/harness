import Testing
@testable import MarkdownCore
@testable import ReaderFeature

@Suite struct FrameProtocolValidation {
    private static let digest = "sha256:" + String(repeating: "a", count: 64)

    private static var open: [String: Any] {
        ["id": 1, "op": "open", "root": "/store", "document": "md-0123456789abcdef0123", "revision": 1,
         "digest": digest, "width": 800, "height": 600, "scale": 2, "appearance": "dark", "textSize": PageSettings.defaultTextSize]
    }

    private static func decode(_ value: [String: Any]) throws -> FrameRequest {
        try FrameRequest.decode(JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
    }

    @Test func acceptsEveryOperation() throws {
        let open = try Self.decode(Self.open)
        #expect(open.op == .open)
        #expect(open.viewport?.textSize == 4)
        #expect(open.viewport?.width == 800)
        var viewport = Self.open
        viewport["op"] = "viewport"
        viewport["background"] = "#Aabb09"
        #expect(try Self.decode(viewport).viewport?.background == "#Aabb09")
        for scroll: [String: Any] in [["to": 0], ["by": -10.5], ["edge": "start"], ["edge": "end"]] {
            let command = scroll.merging(["id": 2, "op": "scroll"]) { a, _ in a }
            #expect(try Self.decode(command).op == .scroll)
        }
        #expect(try Self.decode(["id": 3, "op": "revision", "revision": 2, "digest": Self.digest]).revision == 2)
        #expect(try Self.decode(["id": 4, "op": "frame"]).op == .frame)
    }

    @Test func rejectsMissingAndInvalidOpenFields() {
        for key in ["id", "op", "root", "document", "revision", "digest", "width", "height", "scale", "appearance", "textSize"] {
            var value = Self.open
            value.removeValue(forKey: key)
            #expect(throws: (any Error).self) { try Self.decode(value) }
        }
        let invalid: [(String, Any)] = [
            ("id", 0), ("id", -1), ("id", true), ("id", 1.5), ("id", FrameRequest.maximumID + 1),
            ("op", "unknown"), ("root", "relative"), ("root", "/a\0b"),
            ("document", "012345"), ("document", "../md-0123456789abcdef0123"),
            ("revision", 0), ("revision", 1.5), ("digest", "bad"), ("digest", "sha256:" + String(repeating: "A", count: 64)),
            ("appearance", "auto"), ("textSize", -1), ("textSize", PageSettings.textSizes.count),
            ("background", "red"), ("background", "#12345"), ("background", "#ffffff;")
        ]
        for (key, invalidValue) in invalid {
            var value = Self.open
            value[key] = invalidValue
            #expect(throws: (any Error).self) { try Self.decode(value) }
        }
    }

    @Test func enforcesViewportBounds() throws {
        for (key, invalidValue): (String, Any) in [("width", 0), ("height", -1), ("width", 8193), ("height", 8193), ("width", 1.5), ("scale", 0.99), ("scale", 4.01)] {
            var value = Self.open
            value[key] = invalidValue
            #expect(throws: (any Error).self) { try Self.decode(value) }
        }
        var value = Self.open
        value["width"] = 8192
        value["height"] = 2048
        value["scale"] = 4
        #expect(try Self.decode(value).viewport?.height == 2048)
        value["height"] = 2049
        #expect(throws: (any Error).self) { try Self.decode(value) }
        value["width"] = 1
        value["height"] = 1
        value["scale"] = 1
        #expect(try Self.decode(value).viewport?.width == 1)
    }

    @Test func rejectsAmbiguousOrInvalidScroll() {
        for fields: [String: Any] in [[:], ["to": 0, "by": 1], ["edge": "end", "to": 10], ["edge": "middle"], ["by": 1e20], ["to": "10"]] {
            let command = fields.merging(["id": 1, "op": "scroll"]) { a, _ in a }
            #expect(throws: (any Error).self) { try Self.decode(command) }
        }
    }

    @Test func boundsInputAndRecoversErrorID() throws {
        let valid = try JSONSerialization.data(withJSONObject: Self.open)
        var padded = valid
        padded.append(Data(repeating: 32, count: FrameRequest.inputLimit - valid.count))
        #expect(try FrameRequest.decode(padded).id == 1)
        padded.append(32)
        #expect(throws: (any Error).self) { try FrameRequest.decode(padded) }
        #expect(FrameRequest.errorID(padded) == 0)
        #expect(FrameRequest.errorID(Data("{\"id\":7,\"op\":\"invalid\"}".utf8)) == 7)
        #expect(FrameRequest.errorID(Data("{\"id\":true}".utf8)) == 0)
        #expect(FrameRequest.errorID(Data("garbage".utf8)) == 0)
        #expect(throws: (any Error).self) { try FrameRequest.decode(Data("[]".utf8)) }
    }

    @Test func lineReaderReturnsBeforeTheWriterCloses() async throws {
        let pipe = Pipe()
        let reader = FrameLineReader(input: pipe.fileHandleForReading)
        try pipe.fileHandleForWriting.write(contentsOf: Data("{\"id\":9,\"op\":\"frame\"}\n".utf8))
        let receivedWhileOpen = await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                guard case .data(let data)? = try? reader.next() else { return false }
                return FrameRequest.errorID(data) == 9
            }
            group.addTask {
                defer { try? pipe.fileHandleForWriting.close() }
                do { try await Task.sleep(for: .seconds(2)) } catch { return false }
                return false
            }
            let result = await group.next() ?? false
            group.cancelAll()
            return result
        }
        #expect(receivedWhileOpen)
        try pipe.fileHandleForReading.close()
    }

    @Test func lineReaderDiscardsOversizedLineAndResumes() async throws {
        let pipe = Pipe()
        let reader = FrameLineReader(input: pipe.fileHandleForReading)
        let writer = Task.detached {
            var bytes = Data(repeating: 32, count: FrameRequest.inputLimit + 100)
            bytes.append(Data("\n{\"id\":8,\"op\":\"frame\"}\nlast".utf8))
            try pipe.fileHandleForWriting.write(contentsOf: bytes)
            try pipe.fileHandleForWriting.close()
        }
        if case .oversized? = try reader.next() {} else { Issue.record("oversized line accepted") }
        if case .data(let data)? = try reader.next() { #expect(try FrameRequest.decode(data).id == 8) }
        else { Issue.record("next line lost") }
        if case .data(let data)? = try reader.next() { #expect(data == Data("last".utf8)) }
        else { Issue.record("final unterminated line lost") }
        #expect(try reader.next() == nil)
        try await writer.value
        try pipe.fileHandleForReading.close()
    }
}
