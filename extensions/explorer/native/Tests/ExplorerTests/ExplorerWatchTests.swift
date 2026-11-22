import CoreServices
import Foundation
import Testing
@testable import Explorer

struct ExplorerWatchTests {
    @Test func gitIndexEventsMarkOnlyThePathIndexStale() throws {
        try withGitChanges { workspace, changes in
            for index in [".git/index", "nested/.git/index"] {
                _ = workspace.files()
                changes.record(workspace.root.path + "/" + index, FSEventStreamEventFlags(kFSEventStreamEventFlagItemRenamed))
                #expect(changes.hasChanges)
                #expect(changes.flush().map { $0.0 } == ["index.changed"])
                #expect(workspace.indexCache.current() == nil)
                #expect(!changes.hasChanges)
            }
            _ = workspace.files()
            changes.record(workspace.root.path + "/nested/.git/index", 0)
            changes.record(workspace.root.path + "/edited.txt", FSEventStreamEventFlags(kFSEventStreamEventFlagItemModified))
            let events = changes.flush()
            #expect(events.map { $0.0 } == ["index.changed", "files.changed"])
            #expect(events.last?.1["paths"] as? [String] == ["edited.txt"])
            #expect(events.last?.1["structural"] as? [String] == [])
            #expect(workspace.indexCache.current() == nil)
        }
    }

    @Test func nestedHeadEventsRefreshTheRepositoryRowAndExcludeRulesRefreshEverything() throws {
        try withGitChanges { workspace, changes in
            _ = workspace.files()
            changes.record(workspace.root.path + "/nested/.git/HEAD", FSEventStreamEventFlags(kFSEventStreamEventFlagItemModified))
            changes.record(workspace.root.path + "/nested/.git/index", 0)
            let events = changes.flush()
            #expect(events.map { $0.0 } == ["index.changed", "files.changed"])
            #expect(events.last?.1["paths"] as? [String] == ["nested"])
            #expect(events.last?.1["structural"] as? [String] == ["nested"])
            #expect(events.last?.1["head"] == nil)
            #expect(workspace.indexCache.current() == nil)

            _ = workspace.files()
            changes.record(workspace.root.path + "/nested/.git/info/exclude", 0)
            let excluded = changes.flush()
            #expect(excluded.map { $0.0 } == ["files.changed"])
            #expect(excluded.first?.1["paths"] as? [String] == [])
            #expect(excluded.first?.1["structural"] == nil)
            #expect(workspace.indexCache.current() == nil)
        }
    }

    @Test func rootHeadAndRefEventsKeepTheHeadPayload() throws {
        try withGitChanges { workspace, changes in
            for metadata in ["HEAD", "refs/heads/main", "packed-refs"] {
                changes.record(workspace.root.path + "/.git/" + metadata, 0)
                let events = changes.flush()
                #expect(events.map { $0.0 } == ["files.changed"])
                #expect(events.first?.1["paths"] as? [String] == [])
                #expect((events.first?.1["head"] as? [String: Any])?["branch"] as? String == "main")
            }
        }
    }

    private func withGitChanges(_ body: (Workspace, inout ExplorerChangeBatch) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("explorer-watch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let git = try command("/usr/bin/git", ["init", "-q", "--template=", "-b", "main"], cwd: root,
                              environment: ["PATH": "/usr/bin:/bin", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"],
                              limit: 8192, seconds: 2)
        try #require(git.status == 0)
        let workspace = try Workspace(root.path)
        var changes = ExplorerChangeBatch(workspace: workspace, store: workspace.root.path + "/store",
                                          gitRoots: [workspace.root.path + "/.git"])
        try body(workspace, &changes)
    }
}
