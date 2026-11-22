import Foundation
import Testing
@testable import Explorer

struct WorkspaceTests {
    @Test func validatesLaunchAndDecodesTerminalTokens() throws {
        let args = try paneArguments(#"open --root "/a folder" --path "café.ts" --review "{\"kind\":\"uncommitted\"}" --line 4 --end 5"#)
        let launch = try Launch(arguments: args)
        #expect(launch.root == "/a folder")
        #expect(launch.path == "café.ts")
        #expect(launch.fields["line"] as? Int == 4)
        #expect(throws: ExplorerError.self) { try Launch(arguments: ["--root", "/", "--path", "folder/../secret"]) }
        #expect(throws: ExplorerError.self) { try Launch(arguments: ["--root", "/", "--unknown", "1"]) }
        #expect(throws: ExplorerError.self) { try Launch(arguments: ["--root", "/", "--review", #"{"kind":"commit","commit":"main^"}"#]) }
        #expect(throws: ExplorerError.self) { try paneArguments(#"open --root "bad"suffix"#) }
    }

    @Test func ignoredVisibilityIsAPaneOptionNotALocationField() throws {
        #expect(try ignoredOption(nil))
        #expect(try ignoredOption("show"))
        #expect(try !ignoredOption("hide"))
        #expect(throws: ExplorerError.self) { try ignoredOption("false") }
        #expect(throws: ExplorerError.self) { try Launch(arguments: ["--root", "/", "--ignored", "hide"]) }
        #expect(throws: ExplorerError.self) { try Launch(target: ["root": "/", "ignored": "hide"]) }
    }

    @Test func gitListsIgnoredEntriesSeparatelyAndCollapsesWhollyIgnoredFolders() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let git = { (args: [String]) in
            try command("/usr/bin/git", args, cwd: root, environment: ["PATH": "/usr/bin:/bin", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"], limit: 8192, seconds: 2)
        }
        let files = FileManager.default
        try files.createDirectory(at: root.appendingPathComponent("build/child"), withIntermediateDirectories: true)
        try files.createDirectory(at: root.appendingPathComponent("node_modules/child"), withIntermediateDirectories: true)
        try files.createDirectory(at: root.appendingPathComponent("mixed"), withIntermediateDirectories: false)
        try Data("build/\nnode_modules/\nmixed/*\n!mixed/ordinary.txt\n*.log\n".utf8).write(to: root.appendingPathComponent(".gitignore"))
        for name in ["src.ts", "build/tracked", "build/child/local", "node_modules/child/local", "mixed/ignored.txt", "private.log"] {
            try Data().write(to: root.appendingPathComponent(name))
        }
        let plain = try Workspace(root.path)
        #expect(try plain.ignoredFiles().paths.isEmpty)
        #expect(plain.files().paths.contains("node_modules/child/local"))
        #expect(try git(["init", "--quiet", "--template="]).status == 0)
        #expect(try git(["add", "-f", "--", "build/tracked"]).status == 0)
        let workspace = try Workspace(root.path)
        let paths = workspace.files()
        let ignored = try workspace.ignoredFiles()
        #expect(paths.paths == [".gitignore", "build/tracked", "src.ts"])
        #expect(ignored.paths == ["build/child/", "mixed/ignored.txt", "node_modules/", "private.log"])
        #expect(!ignored.truncated)
        #expect(try workspace.ignoredFiles(maxPaths: 1).truncated)
        #expect(try workspace.ignoredFiles(maxPaths: 1).paths.count == 1)
        try Data().write(to: root.appendingPathComponent("mixed/ordinary.txt"))
        #expect(!workspace.files().paths.contains("mixed/ordinary.txt"))
        workspace.indexCache.invalidate()
        #expect(workspace.files().paths.contains("mixed/ordinary.txt"))
        #expect(try workspace.folder("build").entries.filter(\.ignored).map(\.name) == ["child"])
        #expect(try workspace.folder("node_modules").entries.allSatisfy(\.ignored))
        #expect(try workspace.ignoredFiles().paths == ignored.paths)
        // mixed/* ignores the folder's children, not the folder, so its re-included child stays visible.
        #expect(try workspace.folder("").entries.filter(\.ignored).map(\.name) == ["node_modules", "private.log"])
        #expect(try workspace.folder("mixed").entries.map { [$0.name, String($0.ignored)] } == [["ignored.txt", "true"], ["ordinary.txt", "false"]])
        let hidden = ExplorerServices(workspace: workspace, store: root, resources: root, showIgnored: false)
        let listing = try hidden.handle("files.list", [:])
        #expect(listing["paths"] as? [String] == workspace.files().paths)
        #expect((listing["ignored"] as? [String: Any])?["paths"] as? [String] == [])
        #expect(try hidden.handle("file.read", ["path": "private.log"])["kind"] as? String == "text")
    }

    @Test func folderListingIsImmediateBoundedAndContained() throws {
        let scratch = try fixture()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let files = FileManager.default
        let root = scratch.appendingPathComponent("root")
        try files.createDirectory(at: root.appendingPathComponent("cache/child"), withIntermediateDirectories: true)
        try files.createDirectory(at: root.appendingPathComponent("cache/.git"), withIntermediateDirectories: true)
        for path in ["root/cache/a.txt", "root/cache/child/deep.txt", "secret.txt"] {
            try Data().write(to: scratch.appendingPathComponent(path))
        }
        for (name, target) in [("in.txt", "a.txt"), ("out.txt", "../../secret.txt"), ("meta", ".git"), ("escape", "../.."), ("alias", "child")] {
            try files.createSymbolicLink(atPath: root.appendingPathComponent("cache/\(name)").path, withDestinationPath: target)
        }
        let workspace = try Workspace(root.path)
        let result = try workspace.folder("cache")
        #expect(result.entries.map(\.name) == ["alias", "child", "a.txt", "in.txt"])
        #expect(result.entries.map(\.isDirectory) == [true, true, false, false])
        #expect(!result.truncated)
        #expect(try workspace.folder("cache/alias").entries.map(\.name) == ["deep.txt"])
        let bounded = try workspace.folder("cache", maxEntries: 1)
        #expect(bounded.truncated && bounded.entries.count == 1)
        for path in ["cache/escape", "cache/.git", "cache/meta", "cache/a.txt", "../root/cache", "cache/missing"] {
            #expect(throws: ExplorerError.self) { try workspace.folder(path) }
        }
    }

    @Test func nestedRepositoriesUseTheirOwnIgnoreRulesAndSearchPaths() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let fm = FileManager.default
        func create(_ path: String, text: String = "sharedNeedle\n") throws {
            let file = root.appendingPathComponent(path)
            try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: file)
        }
        func git(_ path: String, _ args: [String]) throws -> String {
            let output = try command("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Explorer", "-c", "user.email=explorer@example.invalid"] + args,
                                     cwd: root.appendingPathComponent(path), environment: ["PATH": "/usr/bin:/bin", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"], limit: 8192, seconds: 2)
            try #require(output.status == 0)
            return output.string.trimmingCharacters(in: .newlines)
        }
        for path in ["plain/file2", "plain/file10", "outer/file", "outer/embedded/file"] { try create(path) }
        try create("outer/.gitignore", text: "ignored/\n")
        try create("outer/ignored/cache", text: "hiddenNeedle\n")
        try create("outer/embedded/.gitignore", text: "private/\n")
        try create("outer/embedded/private/cache", text: "hiddenNeedle\n")
        try create("outer/embedded/ignored/visible")
        _ = try git("outer", ["init", "--quiet", "--template=", "-b", "main"])
        _ = try git("outer/embedded", ["init", "--quiet", "--template=", "-b", "dev"])
        _ = try git("outer", ["add", "--", "file"])
        _ = try git("outer", ["commit", "-qm", "File"])
        _ = try git("outer", ["worktree", "add", "-q", "--detach", "../worktree"])
        _ = try git("outer", ["worktree", "add", "-q", "--detach", "sub"])
        let head = try git("outer", ["rev-parse", "HEAD"])
        _ = try git("outer", ["update-index", "--add", "--cacheinfo", "160000,\(head),sub"])
        let workspace = try Workspace(root.path)
        let folders = try workspace.folder("")
        #expect(folders.entries.map(\.name) == ["outer", "plain", "worktree"])
        #expect(folders.entries.first?.repo == RepositoryMarker(branch: "main", head: nil))
        #expect(folders.entries.last?.repo == RepositoryMarker(branch: nil, head: head))
        #expect(try workspace.folder("plain").entries.map(\.name) == ["file2", "file10"])
        let embedded = try workspace.folder("outer/embedded")
        #expect(embedded.entries.filter(\.ignored).map(\.name) == ["private"])
        #expect(try workspace.folder("outer/embedded", showIgnored: false).entries.map(\.name) == ["ignored", ".gitignore", "file"])
        let inside = try Workspace(root.appendingPathComponent("outer/ignored").path)
        #expect(!inside.isGit)
        #expect(try inside.folder("").entries.first?.ignored == true)
        let list = workspace.files()
        #expect(!list.truncated && list.source == "mixed")
        #expect(list.repositories.map(\.path) == ["outer", "worktree", "outer/embedded", "outer/sub"])
        #expect(list.paths.contains("outer/sub/file"))
        #expect(list.paths.contains("outer/embedded/ignored/visible"))
        #expect(!list.paths.contains("outer/ignored/cache"))
        let results = try workspace.search("sharedNeedle", regex: false, caseSensitive: true, limit: 20)
        #expect(Set((results["results"] as? [[String: Any]] ?? []).compactMap { $0["path"] as? String }) ==
                ["plain/file2", "plain/file10", "outer/file", "outer/sub/file", "outer/embedded/file", "outer/embedded/ignored/visible", "worktree/file"])
        #expect(try (workspace.search("hiddenNeedle", regex: false, caseSensitive: true, limit: 20)["results"] as? [[String: Any]])?.isEmpty == true)
        let gitRoot = try Workspace(root.appendingPathComponent("outer").path)
        let rootResults = try gitRoot.search("sharedNeedle", regex: false, caseSensitive: true, limit: 20)
        let rootPaths = (rootResults["results"] as? [[String: Any]] ?? []).compactMap { $0["path"] as? String }
        #expect(rootPaths.first == "file")
        #expect(rootPaths.contains("embedded/file"))
        #expect(rootResults["source"] as? String == "mixed")
        #expect(gitRoot.outsideRootRepository(["embedded/file", "ignored/cache", "file", "sub/file"]) == ["embedded/file", "ignored/cache", "sub/file"])
        #expect(workspace.buildIndex(maxPaths: 1).truncated)
    }

    @Test func fileReadResolvesInsideLinksAndRejectsEscapes() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("folder")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        try Data("hello\n".utf8).write(to: folder.appendingPathComponent("text.ts"))
        try Data("secret".utf8).write(to: root.appendingPathComponent("secret.ts"))
        try FileManager.default.createSymbolicLink(atPath: folder.appendingPathComponent("out.ts").path, withDestinationPath: "../secret.ts")
        try FileManager.default.createSymbolicLink(atPath: folder.appendingPathComponent("in.ts").path, withDestinationPath: "text.ts")
        let workspace = try Workspace(folder.path)
        #expect(try workspace.readFile("in.ts")["text"] as? String == "hello\n")
        #expect(try workspace.readFile("missing")["kind"] as? String == "missing")
        #expect(throws: ExplorerError.self) { try workspace.readFile("out.ts") }
        #expect(throws: ExplorerError.self) { try workspace.readFile("../secret.ts") }
        #expect(throws: ExplorerError.self) { try workspace.readFile(root.appendingPathComponent("secret.ts").path) }
        try Data([65, 0, 66]).write(to: folder.appendingPathComponent("bytes"))
        #expect(try workspace.readFile("bytes")["kind"] as? String == "binary")
        var long = Data(repeating: 65, count: 4 * mib - 1)
        long.append(contentsOf: "é\n".utf8)
        try long.write(to: folder.appendingPathComponent("wide.ts"))
        let text = try workspace.readFile("wide.ts")
        #expect(text["truncated"] as? Bool == true)
        #expect((text["text"] as? String)?.utf8.count == 4 * mib - 1)
    }

    @Test func stoppedGrepKeepsCompleteRecordsAcrossChunks() throws {
        for timedOut in [false, true] {
            let output = try SearchGrepOutput.collect { receive in
                _ = receive(Data("first.txt\01\02\0first match\nsecond".utf8))
                _ = receive(Data(".txt\03\01\0second match\nlast.txt\04\01\0incomplete".utf8))
                if timedOut { throw ExplorerError("timeout", "The operation exceeded its time limit.") }
                return CommandResult(data: Data(), status: 9, truncated: true)
            }
            var paths: [String] = [], lines: [Int] = [], columns: [Int] = [], previews: [String] = []
            output.eachRecord { path, line, column, text in
                paths.append(path); lines.append(line); columns.append(column)
                previews.append(String(decoding: text, as: UTF8.self)); return true
            }
            #expect(output.truncated)
            #expect(paths == ["first.txt", "second.txt"])
            #expect(lines == [1, 3] && columns == [2, 1])
            #expect(previews == ["first match", "second match"])
        }
    }

    @Test func commandOutputStopsAtTheLimit() throws {
        let exact = try command("/usr/bin/printf", ["1234"], limit: 4, seconds: 2)
        #expect(!exact.truncated && exact.string == "1234")
        let over = try command("/usr/bin/printf", ["12345"], limit: 4, seconds: 2)
        #expect(over.truncated && over.string == "1234")
        let pipe = try command("/bin/cat", [], input: Data(repeating: 65, count: 256 * kib), limit: 256 * kib, seconds: 2)
        #expect(pipe.data.count == 256 * kib && pipe.status == 0)
    }

    @Test func liveCapabilityMustBePrivateAndIsConsumedOnlyOnce() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("live.json")
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "endpoint": "http://127.0.0.1:42321", "token": String(repeating: "a", count: 64)])
        try data.write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
        #expect(throws: ExplorerError.self) { try LiveConfiguration.consume(url.path) }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        #expect(try LiveConfiguration.consume(url.path).endpoint.port == 42321)
        #expect(throws: ExplorerError.self) { try LiveConfiguration.consume(url.path) }
    }

    @Test func reviewStateAndMarkersDoNotInvalidateNotes() {
        #expect(affectsNotes("repos/key/notes/note.json"))
        #expect(affectsNotes("repos/key/tours/tour.json"))
        #expect(affectsNotes("repos/key/repo.json"))
        #expect(!affectsNotes("repos/key/reviews/review.json"))
        #expect(!affectsNotes("repos/key/markers.json"))
        #expect(!affectsNotes("repos/key/notes/.note.json.tmp"))
    }

    @Test func indexStopsAtThePathCapBeforeListingQueuedFolders() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data().write(to: root.appendingPathComponent("file"))
        let workspace = try Workspace(root.path)
        let exact = workspace.buildIndex(maxPaths: 1)
        #expect(exact.paths == ["file"] && !exact.truncated && !exact.repositoriesTruncated)

        let metadata = root.appendingPathComponent("child/nested/.git")
        try FileManager.default.createDirectory(at: metadata, withIntermediateDirectories: true)
        try Data("ref: refs/heads/main\n".utf8).write(to: metadata.appendingPathComponent("HEAD"))
        let capped = workspace.buildIndex(maxPaths: 1)
        #expect(capped.paths == ["file"] && capped.truncated && capped.repositoriesTruncated)
        #expect(capped.repositories.isEmpty)

        // The shallower repository has a marker, but the path cap precludes its Git listing.
        let repo = root.appendingPathComponent("repo")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: false)
        let git = try command("/usr/bin/git", ["init", "-q", "--template=", "-b", "main"], cwd: repo,
                              environment: ["PATH": "/usr/bin:/bin", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"],
                              limit: 8192, seconds: 2)
        try #require(git.status == 0)
        try Data().write(to: repo.appendingPathComponent("another-file"))
        try FileManager.default.removeItem(at: root.appendingPathComponent("child"))
        try FileManager.default.createDirectory(at: root.appendingPathComponent("child"), withIntermediateDirectories: false)
        try FileManager.default.moveItem(at: root.appendingPathComponent("file"), to: root.appendingPathComponent("child/file"))
        let queued = workspace.buildIndex(maxPaths: 1)
        #expect(queued.paths == ["child/file"] && queued.truncated && queued.repositoriesTruncated)
        #expect(queued.repositories.map(\.path) == ["repo"])
    }

    @Test func fileEventsReachTheWorkspaceWatcher() throws {
        let scratch = try fixture()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let root = scratch.appendingPathComponent("folder"), store = scratch.appendingPathComponent("store")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        let workspace = try Workspace(root.path)
        #expect(workspace.files().paths.isEmpty)
        let changed = DispatchSemaphore(value: 0)
        let watch = ExplorerWatch(workspace: workspace, store: store) { type, fields in
            if type == "files.changed", (fields["structural"] as? [String])?.contains("updated.txt") == true {
                #expect(fields["outside"] == nil)
                changed.signal()
            }
        }
        try withExtendedLifetime(watch) {
            try Data("new contents".utf8).write(to: root.appendingPathComponent("updated.txt"))
            #expect(changed.wait(timeout: .now() + .seconds(4)) == .success)
            #expect(workspace.files().paths == ["updated.txt"])
        }
    }

    @Test func cardDraftsAreIndependentOfReadingPositionAndOtherRoots() throws {
        let scratch = try fixture()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let a = scratch.appendingPathComponent("a"), b = scratch.appendingPathComponent("b")
        let store = scratch.appendingPathComponent("store")
        let state = ExplorerState(store: store)
        let reopened = ExplorerState(store: store)
        let fields: [String: Any] = ["mode": "ask", "text": "Question?", "range": ["side": "head", "start": 2, "end": 4], "commit": NSNull()]
        try state.save(root: a, fields: ["path": "one.ts", "line": 2, "view": "file"])
        #expect(try !state.save(root: a, fields: ["path": "two.ts", "draft": fields]))
        #expect(reopened.restore(root: a, launch: [:])["path"] as? String == "one.ts")
        try state.save(root: a, fields: ["path": "two.ts", "line": 9])
        let implicit = reopened.restore(root: a, launch: [:])
        #expect(implicit["line"] as? Int == 9)
        #expect((implicit["draft"] as? [String: Any])?["text"] as? String == "Question?")
        #expect(reopened.restore(root: a, launch: ["path": "two.ts"])["draft"] != nil)
        for pin: [String: Any] in [["line": 3], ["end": 4], ["note": "n-a"], ["tour": "tour-a"]] {
            let launch = ["path": "two.ts"].merging(pin) { _, right in right }
            #expect(reopened.restore(root: a, launch: launch)["draft"] == nil)
        }
        #expect(reopened.restore(root: b, launch: ["path": "two.ts"])["draft"] == nil)
        try state.save(root: b, fields: ["path": "two.ts", "draft": fields])
        try state.save(root: a, fields: ["path": "two.ts", "draft": NSNull()])
        #expect(reopened.restore(root: a, launch: [:])["draft"] == nil)
        #expect(reopened.restore(root: b, launch: ["path": "two.ts"])["draft"] != nil)
    }

    @Test func invalidCardDraftDoesNotReplaceValidText() throws {
        let scratch = try fixture()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let state = ExplorerState(store: scratch.appendingPathComponent("store"))
        try state.save(root: scratch, fields: ["path": "code.ts", "draft": ["mode": "note", "text": "Original"]])
        let cases: [[String: Any]] = [
            ["text": String(repeating: "😀", count: 8 * kib + 1)],
            ["quote": String(repeating: "é", count: 16 * kib + 1)],
            ["mode": "other"],
            ["range": ["side": "head", "start": true, "end": 2]],
            ["range": ["side": "base", "start": 3, "end": 2]],
            ["commit": "HEAD"],
            ["noteId": "other"],
        ]
        for values in cases {
            let input = ["mode": "comment", "text": "Replacement"].merging(values) { _, right in right }
            #expect(throws: ExplorerError.self) { try state.save(root: scratch, fields: ["path": "code.ts", "draft": input]) }
        }
        #expect(throws: ExplorerError.self) { try state.save(root: scratch, fields: ["draft": NSNull()]) }
        let restored = state.restore(root: scratch, launch: ["path": "code.ts"])["draft"] as? [String: Any]
        #expect(restored?["text"] as? String == "Original")
    }

    private func fixture() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("explorer-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return directory
    }
}
