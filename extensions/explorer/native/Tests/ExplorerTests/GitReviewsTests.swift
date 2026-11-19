import Foundation
import Testing
@testable import Explorer

struct GitReviewsTests {
    @Test func unbornAndRootUseTheEmptyTree() throws {
        try withRepository { repo in
            let workspace = try Workspace(repo.path)
            let scope = ["kind": "uncommitted"]
            let options = try workspace.reviewScopes(marker: nil)
            #expect(options["defaultId"] as? String == "uncommitted")
            let empty = try workspace.reviewFiles(scope, marker: nil)
            let resolved = try #require(empty["resolved"] as? [String: Any])
            #expect(resolved["base"] is NSNull)
            #expect(resolved["key"] as? String == "worktree@empty")
            #expect(resolved["label"] as? String == "Uncommitted changes")
            #expect((empty["files"] as? [[String: Any]])?.isEmpty == true)

            try write("one\ntwo", "staged.txt", in: repo)
            try git(repo, "add", "staged.txt")
            try write("three\n", "literal[1].txt", in: repo)
            try write("ignored.txt\n", ".gitignore", in: repo)
            try write("ignored\n", "ignored.txt", in: repo)
            let files = try listed(workspace, scope)
            #expect(Set(files.keys) == ["staged.txt", "literal[1].txt", ".gitignore"])
            #expect(files["staged.txt"]?["additions"] as? Int == 2)
            let diff = try workspace.reviewDiff(scope, path: "literal[1].txt", marker: nil)
            #expect(diff["base"] is NSNull)
            #expect(diff["head"] as? String == "three\n")
            #expect(diff["hunks"] as? [[String: Int]] == [["baseStart": 0, "baseCount": 0, "headStart": 1, "headCount": 1]])
            #expect(throws: ExplorerError.self) { try workspace.reviewDiff(scope, path: "../staged.txt", marker: nil) }

            try git(repo, "commit", "-qm", "Root commit")
            let commit = try git(repo, "rev-parse", "HEAD")
            let rootScope = ["kind": "commit", "commit": commit]
            let result = try workspace.reviewFiles(rootScope, marker: nil)
            #expect((result["resolved"] as? [String: Any])?["key"] as? String == "empty..\(commit)")
            #expect((result["resolved"] as? [String: Any])?["label"] as? String == "\(commit.prefix(7)) Root commit")
            #expect((result["commits"] as? [[String: String]])?.first?["subject"] == "Root commit")
            #expect(try listed(workspace, rootScope)["staged.txt"]?["additions"] as? Int == 2)
            #expect(try workspace.reviewDiff(rootScope, path: "staged.txt", marker: nil)["head"] as? String == "one\ntwo")
        }
    }

    @Test func committedRenameRetainsBothPathsAndRangeStartsAtMergeBase() throws {
        try withRepository { repo in
            let old = "before\tname.txt", new = "after\nname.txt"
            try write("one\ntwo\nthree\nfour\nfive\n", old, in: repo)
            try git(repo, "add", "--", old)
            try git(repo, "commit", "-qm", "Base")
            let base = try git(repo, "rev-parse", "HEAD")
            try git(repo, "branch", "topic")
            try write("main only\n", "main.txt", in: repo)
            try git(repo, "add", "main.txt")
            try git(repo, "commit", "-qm", "Advance main")
            try git(repo, "switch", "-q", "topic")
            try git(repo, "mv", "--", old, new)
            try write("one\nnew\nthree\nfour\nfive\n", new, in: repo)
            try git(repo, "add", "--", new)
            try git(repo, "commit", "-qm", "Move and edit")
            let head = try git(repo, "rev-parse", "HEAD")
            let workspace = try Workspace(repo.path)
            let scope = ["kind": "branch"]
            #expect(try workspace.reviewScopes(marker: nil)["defaultId"] as? String == "branch")
            let branch = try workspace.reviewFiles(scope, marker: nil)
            #expect((branch["resolved"] as? [String: Any])?["base"] as? String == base)
            #expect((branch["resolved"] as? [String: Any])?["label"] as? String == "Branch topic against main: 1 commit")
            #expect((branch["commits"] as? [[String: String]])?.map { $0["subject"] } == ["Move and edit"])
            let rangeScope = ["kind": "range", "base": String(base.prefix(9)), "head": "HEAD"]
            let range = try workspace.reviewFiles(rangeScope, marker: nil)
            #expect((range["resolved"] as? [String: Any])?["label"] as? String == "1 commit, \(base.prefix(7)) to \(head.prefix(7))")
            let files = try listed(workspace, rangeScope)
            #expect(Set(files.keys) == [new])
            #expect(files[new]?["status"] as? String == "renamed")
            #expect(files[new]?["oldPath"] as? String == old)
            #expect(files[new]?["additions"] as? Int == 1)
            #expect(files[new]?["deletions"] as? Int == 1)
            let diff = try workspace.reviewDiff(scope, path: new, marker: nil)
            #expect(diff["base"] as? String == "one\ntwo\nthree\nfour\nfive\n")
            #expect(diff["head"] as? String == "one\nnew\nthree\nfour\nfive\n")
            #expect(diff["hunks"] as? [[String: Int]] == [["baseStart": 2, "baseCount": 1, "headStart": 2, "headCount": 1]])
        }
    }

    @Test func sinceReviewUsesAnExistingMarkerAndFallsBackToFirstParent() throws {
        try withRepository { repo in
            for index in 1...3 {
                try write("\(index)\n", "count.txt", in: repo)
                try git(repo, "add", "count.txt")
                try git(repo, "commit", "-qm", "Count \(index)")
            }
            let workspace = try Workspace(repo.path)
            let scope = ["kind": "since-review"]
            let head = try git(repo, "rev-parse", "HEAD")
            let marker = try git(repo, "rev-parse", "HEAD~2")
            let previous = try git(repo, "rev-parse", "HEAD^1")
            #expect(try workspace.reviewScopes(marker: marker)["defaultId"] as? String == "since-review")
            let retained = try workspace.reviewFiles(scope, marker: marker)
            #expect((retained["resolved"] as? [String: Any])?["base"] as? String == marker)
            #expect((retained["resolved"] as? [String: Any])?["label"] as? String == "Since your last review: 2 commits, \(marker.prefix(7)) to \(head.prefix(7))")
            #expect((retained["commits"] as? [[String: String]])?.map { $0["subject"] } == ["Count 3", "Count 2"])
            let fallback = try workspace.reviewFiles(scope, marker: String(repeating: "f", count: 40))
            #expect((fallback["resolved"] as? [String: Any])?["base"] as? String == previous)
        }
    }

    @Test func worktreeUsesRawBytesWithoutGitDriversOrSymlinkTargets() throws {
        try withRepository { repo in
            try write("one\ntwo\nthree\n", "change.txt", in: repo)
            try write("exact move\n", "old.txt", in: repo)
            try write("prior\n", "removed.txt", in: repo)
            try git(repo, "add", "--", "change.txt", "old.txt", "removed.txt")
            try git(repo, "commit", "-qm", "Base")
            try git(repo, "config", "filter.fixture.clean", "touch .git/driver-ran")
            try git(repo, "config", "filter.fixture.smudge", "touch .git/driver-ran")
            try git(repo, "config", "diff.fixture.command", "touch .git/driver-ran")
            try git(repo, "config", "diff.fixture.textconv", "touch .git/driver-ran")
            try write("*.txt filter=fixture diff=fixture\n", ".gitattributes", in: repo)
            try write("one\nlonger second line\nthree\nfour\n", "change.txt", in: repo)
            try FileManager.default.moveItem(at: repo.appendingPathComponent("old.txt"), to: repo.appendingPathComponent("moved.txt"))
            try FileManager.default.removeItem(at: repo.appendingPathComponent("removed.txt"))
            try Data([0, 255]).write(to: repo.appendingPathComponent("bytes.bin"))
            try FileManager.default.createSymbolicLink(atPath: repo.appendingPathComponent("link").path, withDestinationPath: "/dev/zero")
            let index = repo.appendingPathComponent(".git/index")
            let before = try Data(contentsOf: index)
            let workspace = try Workspace(repo.path)
            let scope = ["kind": "uncommitted"]
            let files = try listed(workspace, scope)
            #expect(files["change.txt"]?["additions"] as? Int == 2)
            #expect(files["change.txt"]?["deletions"] as? Int == 1)
            #expect(files["moved.txt"]?["oldPath"] as? String == "old.txt")
            #expect(files["moved.txt"]?["status"] as? String == "renamed")
            #expect(files["removed.txt"]?["status"] as? String == "deleted")
            #expect(files["bytes.bin"]?["binary"] as? Bool == true)
            let diff = try workspace.reviewDiff(scope, path: "change.txt", marker: nil)
            #expect((diff["hunks"] as? [[String: Int]])?.count == 2)
            #expect(try workspace.reviewDiff(scope, path: "link", marker: nil)["head"] as? String == "/dev/zero")
            #expect(try workspace.reviewDiff(scope, path: "removed.txt", marker: nil)["head"] is NSNull)
            #expect(!FileManager.default.fileExists(atPath: repo.appendingPathComponent(".git/driver-ran").path))
            #expect(try Data(contentsOf: index) == before)
        }
    }

    private func listed(_ workspace: Workspace, _ scope: [String: Any]) throws -> [String: [String: Any]] {
        let result = try workspace.reviewFiles(scope, marker: nil)
        let entries = try #require(result["files"] as? [[String: Any]])
        return try Dictionary(uniqueKeysWithValues: entries.map { (try #require($0["path"] as? String), $0) })
    }

    private func withRepository(_ test: (URL) throws -> Void) throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("explorer-review-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: folder) }
        try git(folder, "init", "-q", "-b", "main")
        try git(folder, "config", "user.name", "Review Fixture")
        try git(folder, "config", "user.email", "review-fixture@example.test")
        try test(folder)
    }

    @discardableResult private func git(_ repo: URL, _ args: String...) throws -> String {
        let output = try command("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false"] + args,
                                 cwd: repo, environment: ["PATH": "/usr/bin:/bin", "GIT_CONFIG_GLOBAL": "/dev/null",
                                                          "GIT_CONFIG_NOSYSTEM": "1"], limit: 16 * kib, seconds: 5)
        try #require(output.status == 0, "Git fixture command failed: \(args)")
        return output.string.trimmingCharacters(in: .newlines)
    }

    private func write(_ body: String, _ path: String, in repo: URL) throws {
        try Data(body.utf8).write(to: repo.appendingPathComponent(path))
    }
}
