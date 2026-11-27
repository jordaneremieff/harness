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
        let data = try JSONSerialization.data(withJSONObject: Self.fields)
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
        #expect(ticket.node == "/bin/node")
        #expect(ticket.program == "/app/pane-program.ts")
        #expect(ticket.paneId == "42626b21-08f8-4f47-95ca-a815a8f5c465")
        #expect(ticket.root == "/project")
        #expect(ticket.agentDir == "/agent")
        #expect(ticket.participant.kind == .ordinary)
        #expect(ticket.participant.id == "test-session")
        #expect(ticket.layout == "/editor/layout.json")
        #expect(!manager.fileExists(atPath: path.path))
        #expect(throws: EditorIssue.self) { try EditorTicket.consume(path.path) }
    }

    @Test func rejectsInvalidTicketsWithoutConsumingThem() throws {
        let manager = FileManager.default
        let dir = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try manager.createDirectory(at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? manager.removeItem(at: dir) }
        let invalid: [(String, Any)] = [
            ("version", 1), ("node", "node"), ("program", "pane-program.ts"),
            ("paneId", "not-a-uuid"), ("root", "/project\0"), ("agentDir", "agent"),
            ("participant", ["id": "test-session", "label": "Session", "kind": "invalid"]),
            ("participant", ["id": "", "label": "Session", "kind": "durable"]),
        ]
        for (index, field) in invalid.enumerated() {
            let path = dir.appendingPathComponent("request-\(index)")
            var fields = Self.fields
            fields[field.0] = field.1
            let data = try JSONSerialization.data(withJSONObject: fields)
            #expect(manager.createFile(atPath: path.path, contents: data, attributes: [.posixPermissions: 0o600]))
            #expect(throws: EditorIssue.self) { try EditorTicket.consume(path.path) }
            #expect(manager.fileExists(atPath: path.path))
        }
    }

    private static var fields: Fields {
        ["version": 2, "node": "/bin/node", "program": "/app/pane-program.ts", "root": "/project",
         "agentDir": "/agent", "paneId": "42626b21-08f8-4f47-95ca-a815a8f5c465", "file": "front.swift",
         "settings": "/editor/settings.json", "layout": "/editor/layout.json",
         "participant": ["id": "test-session", "label": "Session", "kind": "ordinary"]]
    }
}
