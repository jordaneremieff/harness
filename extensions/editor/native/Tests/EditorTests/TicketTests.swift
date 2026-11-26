import Darwin
import Foundation
import Testing
@testable import Editor

struct TicketTests {
    @Test func consumesOnlyThePrivateRequestOnce() throws {
        let manager = FileManager.default
        let dir = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try manager.createDirectory(at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? manager.removeItem(at: dir) }
        let path = dir.appendingPathComponent("request")
        let other = dir.appendingPathComponent("other")
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "port": 13451,
            "token": String(repeating: "a", count: 64), "root": "/project", "file": "front.swift"])
        #expect(manager.createFile(atPath: path.path, contents: data, attributes: [.posixPermissions: 0o600]))
        try manager.createSymbolicLink(at: other, withDestinationURL: path)
        #expect(throws: EditorIssue.self) { try EditorTicket.consume(other.path) }
        try manager.removeItem(at: other)
        try manager.linkItem(at: path, to: other)
        #expect(throws: EditorIssue.self) { try EditorTicket.consume(path.path) }
        try manager.removeItem(at: other)
        #expect(chmod(path.path, 0o644) == 0)
        #expect(throws: EditorIssue.self) { try EditorTicket.consume(path.path) }
        #expect(chmod(path.path, 0o600) == 0)
        let ticket = try EditorTicket.consume(path.path)
        #expect(ticket.file == "front.swift")
        #expect(ticket.port == 13451)
        #expect(!manager.fileExists(atPath: path.path))
        #expect(throws: EditorIssue.self) { try EditorTicket.consume(path.path) }
    }
}
