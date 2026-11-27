import Foundation
import Testing
@testable import Editor

struct WorkspaceSaveTargetTests {
    @Test func saveTargetRejectsPathsOutsideTheWorkspaceAndThroughLinks() throws {
        let fs = FileManager.default
        let sandbox = fs.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let root = sandbox.appendingPathComponent("project", isDirectory: true)
        let sibling = sandbox.appendingPathComponent("project-other", isDirectory: true)
        try fs.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fs.removeItem(at: sandbox) }
        try fs.createDirectory(at: sibling, withIntermediateDirectories: false)
        let workspace = root.resolvingSymlinksInPath()
        let local = workspace.appendingPathComponent("inside.txt")
        #expect(try WorkspaceSaveTarget.resolve(local, in: workspace) == .init(path: "inside.txt", replacement: nil))
        try Data("original".utf8).write(to: local)
        let first = try WorkspaceSaveTarget.resolve(local, in: workspace)
        #expect(first.path == "inside.txt")
        #expect(first.replacement != nil)
        try Data("changed bytes".utf8).write(to: local)
        #expect(try WorkspaceSaveTarget.resolve(local, in: workspace) != first)
        let siblingFile = sibling.appendingPathComponent("outside.txt")
        #expect(throws: EditorIssue.self) { try WorkspaceSaveTarget.resolve(siblingFile, in: workspace) }
        let link = workspace.appendingPathComponent("link")
        try fs.createSymbolicLink(at: link, withDestinationURL: sibling)
        #expect(throws: EditorIssue.self) { try WorkspaceSaveTarget.resolve(link.appendingPathComponent("outside.txt"), in: workspace) }
        #expect(throws: EditorIssue.self) { try WorkspaceSaveTarget.resolve(link, in: workspace) }
    }
}
