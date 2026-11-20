import Foundation
import Testing
@testable import Explorer

struct MarkdownPreviewTests {
    @Test func safeGFMKeepsSourceCoordinates() throws {
        let source = """
        # Heading

        > A [link](javascript:alert%281%29) and ~~removed~~ content.

        <script>alert(1)</script>

        | Column | Value |
        | --- | ---: |
        | cell | 3 |

        - [x] Done

        ```ts
        const x = 1;
        ```
        """
        let html = try #require(MarkdownPreview.html(source) { _ in nil })
        #expect(html.contains(#"<h1 data-sourcepos="1:1-1:9">Heading</h1>"#))
        #expect(html.contains(#"<blockquote data-sourcepos="3:"#))
        #expect(html.contains("<del>removed</del>"))
        #expect(html.contains(#"<table data-sourcepos="7:"#))
        #expect(html.contains(#"<li data-sourcepos="11:"#))
        #expect(html.contains(#"<pre data-sourcepos="13:"#))
        #expect(html.contains("language-ts"))
        #expect(html.contains("disabled"))
        #expect(!html.contains("<script"))
        #expect(!html.contains("alert(1)"))
        #expect(!html.contains("javascript:"))
    }

    @Test func imagesUseContainedPathsAndTheSelectedRevision() throws {
        let sandbox = FileManager.default.temporaryDirectory.appendingPathComponent("explorer-tests-\(UUID().uuidString)")
        let root = sandbox.appendingPathComponent("repo"), docs = root.appendingPathComponent("docs")
        try FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let image = root.appendingPathComponent("green leaf.png")
        let old = Data([1, 2, 3]), new = Data([4, 5, 6])
        try old.write(to: image)
        try Data([7, 8]).write(to: sandbox.appendingPathComponent("outside.png"))
        try FileManager.default.createSymbolicLink(atPath: docs.appendingPathComponent("escape.png").path, withDestinationPath: "../../outside.png")
        let source = """
        ![local](../green%20leaf.png)
        ![remote](https://example.invalid/x.png)
        ![outside](../../outside.png)
        ![symlink](escape.png)
        ![metadata](../%2eGiT/x.png)
        ![unsupported](../readme.pdf)
        """
        try Data(source.utf8).write(to: docs.appendingPathComponent("guide.md"))
        let git = { (args: [String]) throws in
            let result = try command("/usr/bin/git", ["-c", "user.name=Explorer", "-c", "user.email=explorer@example.invalid",
                                                      "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null"] + args,
                                     cwd: root, environment: ["PATH": "/usr/bin:/bin", "GIT_CONFIG_GLOBAL": "/dev/null",
                                                              "GIT_CONFIG_NOSYSTEM": "1"], limit: 8192, seconds: 3)
            try #require(result.status == 0)
        }
        try git(["init", "--quiet"])
        try git(["add", "docs/guide.md", "green leaf.png"])
        try git(["commit", "--quiet", "-m", "Images"])
        try new.write(to: image)
        let workspace = try Workspace(root.path)
        for (revision, data) in [(nil as String?, new), ("HEAD", old)] {
            let reply = try workspace.renderMarkdown("docs/guide.md", at: revision)
            let html = try #require(reply["html"] as? String)
            #expect(html.components(separatedBy: "explorer-asset://image/").count == 2 || revision != nil)
            #expect(!html.contains("https://example.invalid"))
            for alt in ["remote", "outside", "metadata", "unsupported"] {
                #expect(html.contains("src=\"\" alt=\"\(alt)\""))
            }
            if revision == nil { #expect(html.contains(#"src="" alt="symlink""#)) }
            let url = try #require(html.range(of: #"explorer-asset://image/([0-9a-f-]+)"#, options: .regularExpression))
            let id = try #require(html[url].split(separator: "/").last.map(String.init))
            let (bytes, type) = try workspace.asset(id)
            #expect(bytes == data)
            #expect(type == "image/png")
        }
    }
}
