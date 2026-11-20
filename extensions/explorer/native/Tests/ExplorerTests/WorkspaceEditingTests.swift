import Darwin
import Foundation
import Testing
@testable import Explorer

struct WorkspaceEditingTests {
    private func fixture(_ test: (Workspace, URL) throws -> Void) throws {
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("explorer-edit-\(UUID().uuidString)")
        let root = scratch.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }
        try test(Workspace(root.path), scratch)
    }

    @Test func savesWithExpectedDigestAndPreservesPermissionsAndBytes() throws {
        try fixture { workspace, _ in
            let path = "file.txt", url = workspace.root.appendingPathComponent(path)
            let original = Data("\u{FEFF}one\r\ntwo\r\n".utf8)
            try original.write(to: url)
            #expect(chmod(url.path, 0o751) == 0)
            let base = try #require(try workspace.readFile(path)["editBase"] as? String)
            #expect(base == contentDigest(original))
            let source = try #require(try workspace.readFile(path)["text"] as? String)
            #expect(Data(source.utf8) == original)
            let edit = source.replacingOccurrences(of: "two", with: "three")
            var before = stat(), after = stat()
            #expect(stat(url.path, &before) == 0)
            try workspace.writeFile(path, text: edit, base: base)
            #expect(try Data(contentsOf: url) == Data(edit.utf8))
            #expect(stat(url.path, &after) == 0)
            #expect(after.st_mode & 0o777 == 0o751)
            #expect(after.st_ino != before.st_ino)
            #expect(throws: ExplorerError.self) { try workspace.writeFile(path, text: "stale", base: base) }
            do {
                try workspace.writeFile(path, text: "stale", base: base)
            } catch let error as ExplorerError {
                #expect(error.code == "conflict")
            }
            #expect(try Data(contentsOf: url) == Data(edit.utf8))
            #expect(try FileManager.default.contentsOfDirectory(atPath: workspace.root.path) == [path])
        }
    }

    @Test func creationIsExclusiveAndMakesContainedParents() throws {
        try fixture { workspace, _ in
            let path = "notes/today/todo.md"
            try workspace.createFile(path)
            let base = contentDigest(Data())
            #expect(try workspace.readFile(path)["editBase"] as? String == base)
            try workspace.writeFile(path, text: "# Tasks\n", base: base)
            #expect(throws: ExplorerError.self) { try workspace.createFile(path) }
            #expect(try workspace.readFile(path)["text"] as? String == "# Tasks\n")
            for target in ["../escaped", "/absolute", ".git/config", "nested/.GiT/hooks/hook", "avatar.PNG"] {
                #expect(throws: ExplorerError.self) { try workspace.createFile(target) }
                #expect(throws: ExplorerError.self) { try workspace.writeFile(target, text: "must not write", base: base) }
            }
            #expect(!FileManager.default.fileExists(atPath: workspace.root.appendingPathComponent("nested").path))
        }
    }

    @Test func refusesSymbolicLinksAndNonEditableFiles() throws {
        try fixture { workspace, scratch in
            let root = workspace.root
            try Data("outside".utf8).write(to: scratch.appendingPathComponent("external"))
            try Data("inside".utf8).write(to: root.appendingPathComponent("internal"))
            for (link, target) in [("escape", ".."), ("link", "../external"), ("alias", "internal")] {
                try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent(link).path, withDestinationPath: target)
                #expect(throws: ExplorerError.self) { try workspace.createFile(link) }
                #expect(throws: ExplorerError.self) { try workspace.writeFile(link, text: "bad", base: contentDigest(Data("outside".utf8))) }
            }
            #expect(throws: ExplorerError.self) { try workspace.createFile("escape/parents/new") }
            #expect(throws: ExplorerError.self) { try workspace.writeFile("escape/external", text: "bad", base: contentDigest(Data("outside".utf8))) }
            #expect(!FileManager.default.fileExists(atPath: scratch.appendingPathComponent("parents").path))
            #expect(try workspace.readFile("alias")["editBase"] == nil)
            for (path, content) in [("binary", Data([0])), ("wide", Data(repeating: 65, count: editFileLimit + 1)), ("tall", Data(repeating: 10, count: editLineLimit))] {
                try content.write(to: root.appendingPathComponent(path))
                #expect(try workspace.readFile(path)["editBase"] == nil)
                #expect(throws: ExplorerError.self) { try workspace.writeFile(path, text: "bad", base: contentDigest(content)) }
            }
        }
    }

    @Test func privateDraftsAreScopedByRootAndPathAndClearIndependently() throws {
        try fixture { workspace, scratch in
            let store = scratch.appendingPathComponent("state")
            let state = ExplorerState(store: store)
            let reopened = ExplorerState(store: store)
            let draft: [String: Any] = ["text": "private\n", "ending": "crlf", "base": contentDigest(Data())]
            let root = workspace.root
            try state.save(root: root, fields: ["path": "active.md", "line": 17])
            _ = try state.editDraft(root: root, path: "notes/todo.md", value: draft)
            #expect(try reopened.editedPaths(root: root) == ["notes/todo.md"])
            #expect(try reopened.editDraft(root: root, path: "notes/todo.md", value: nil)?["text"] as? String == "private\n")
            #expect(try reopened.editDraft(root: root, path: "another.md", value: nil) == nil)
            #expect(try reopened.editedPaths(root: scratch).isEmpty)
            #expect(reopened.restore(root: root, launch: [:])["path"] as? String == "active.md")
            _ = try reopened.editDraft(root: root, path: "notes/todo.md", value: NSNull())
            #expect(try state.editedPaths(root: root).isEmpty)
            #expect(try state.editDraft(root: root, path: "notes/todo.md", value: nil) == nil)
        }
    }
}
