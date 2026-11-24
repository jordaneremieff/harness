import Foundation

struct NotesHelper {
    let workspace: Workspace
    let store: URL
    let resources: URL

    func call(_ op: String, fields: [String: Any] = [:]) throws -> [String: Any] {
        guard let node = buildRecord(resources)["node"] as? String, node.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: node) else {
            throw ExplorerError("store-failure", "The Node runtime for the notes store is unavailable.")
        }
        let helper = resources.appendingPathComponent("notes/notes-helper.js").path
        guard FileManager.default.isReadableFile(atPath: helper) else { throw ExplorerError("store-failure", "The notes helper is unavailable.") }
        let request = fields.merging(["version": 1, "store": store.path, "root": workspace.root.path, "op": op]) { _, trusted in trusted }
        let data = try JSONSerialization.data(withJSONObject: request)
        guard data.count <= mib else { throw ExplorerError("invalid", "The notes request exceeds its size limit.") }
        var environment = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("GIT_") && !$0.key.hasPrefix("NODE_") }
        environment["GIT_OPTIONAL_LOCKS"] = "0"
        environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        let result = try command(node, [helper], cwd: workspace.root, environment: environment, input: data, limit: 16 * mib, seconds: 10)
        guard !result.truncated, var reply = (try? JSONSerialization.jsonObject(with: result.data)) as? [String: Any],
              let ok = reply.removeValue(forKey: "ok") as? Bool else {
            throw ExplorerError("store-failure", "The notes helper did not return a valid response.")
        }
        if !ok {
            let error = reply["error"] as? [String: Any]
            throw ExplorerError(error?["code"] as? String ?? "store-failure", error?["message"] as? String ?? "The notes operation failed.")
        }
        guard result.status == 0 else { throw ExplorerError("store-failure", "The notes helper exited unsuccessfully.") }
        return reply
    }
}

struct ExplorerServices {
    let workspace: Workspace
    let store: URL
    let resources: URL
    let showIgnored: Bool
    var helper: NotesHelper { NotesHelper(workspace: workspace, store: store, resources: resources) }

    private func marker(_ scope: [String: Any]? = nil) -> String? {
        guard scope == nil || scope?["kind"] as? String == "since-review",
              let branch = workspace.gitValue(["symbolic-ref", "--quiet", "--short", "HEAD"]) else { return nil }
        return (try? helper.call("marker", fields: ["branch": branch]))?["head"] as? String
    }

    func handle(_ type: String, _ fields: [String: Any]) throws -> [String: Any] {
        func path(_ key: String = "path") throws -> String {
            guard let path = fields[key] as? String, validPath(path) else { throw ExplorerError("invalid-path", "A path inside the opened folder is required.") }
            return path
        }
        switch type {
        case "files.list":
            let found = workspace.files()
            var result: [String: Any] = ["paths": found.paths, "truncated": found.truncated,
                                         "source": found.source, "repositories": found.repositories.map(\.fields)]
            if found.repositoriesTruncated { result["repositoriesTruncated"] = true }
            return result
        case "files.folder":
            guard let folder = fields["path"] as? String else { throw ExplorerError("invalid-path", "A folder path is required.") }
            let found = try workspace.folder(folder, showIgnored: showIgnored)
            return ["entries": found.entries.map(\.fields), "truncated": found.truncated]
        case "file.read", "markdown.render":
            if let at = fields["at"], !(at is String) { throw ExplorerError("invalid", "The revision is invalid.") }
            let at = fields["at"] as? String
            if type == "markdown.render" { return try workspace.renderMarkdown(path(), at: at) }
            return try workspace.readFile(path(), at: at)
        case "markdown.text":
            // Note text renders without images: card text has no file to resolve them against.
            guard let text = fields["text"] as? String, text.utf8.count <= 128 * kib else {
                throw ExplorerError("invalid", "The Markdown text is missing or too long.")
            }
            guard let html = MarkdownPreview.html(text, image: { _ in nil }) else {
                throw ExplorerError("invalid", "The Markdown text could not be rendered.")
            }
            return ["html": html]
        case "file.write":
            guard fields["root"] as? String == workspace.root.path, let text = fields["text"] as? String,
                  let base = fields["base"] as? String else { throw ExplorerError("invalid", "The open root or edit is invalid.") }
            try workspace.writeFile(path(), text: text, base: base)
            return ["base": contentDigest(Data(text.utf8))]
        case "file.create":
            guard fields["root"] as? String == workspace.root.path else { throw ExplorerError("invalid-root", "The open folder changed.") }
            try workspace.createFile(path())
            workspace.indexCache.invalidate()
            return [:]
        case "review.scopes": return try workspace.reviewScopes(marker: marker())
        case "review.files", "review.diff":
            let scope = try scopeShape(fields["scope"])
            if type == "review.files" { return try workspace.reviewFiles(scope, marker: marker(scope)) }
            return try workspace.reviewDiff(scope, path: path(), marker: marker(scope))
        case "search":
            guard let query = fields["query"] as? String else { throw ExplorerError("invalid", "Search text is required.") }
            return try workspace.search(query, regex: fields["regex"] as? Bool ?? false,
                                        caseSensitive: fields["caseSensitive"] as? Bool ?? false, limit: fields["limit"] as? Int ?? 200)
        case "notes.list":
            return try helper.call("list", fields: fields["path"] == nil ? [:] : ["path": try path()])
        case "notes.write":
            guard let op = fields["op"] as? String, ["create", "update", "reply", "state", "delete"].contains(op) else {
                throw ExplorerError("invalid", "Unknown notes operation.")
            }
            return try helper.call(op, fields: fields)
        case "review.state":
            guard let op = fields["op"] as? String, ["get", "set"].contains(op),
                  let key = fields["key"] as? String, key.utf8.count <= 256,
                  key.range(of: #"^(worktree@(empty|[0-9a-f]{40}([0-9a-f]{24})?)|(empty|[0-9a-f]{40}([0-9a-f]{24})?)\.\.[0-9a-f]{40}([0-9a-f]{24})?)$"#, options: .regularExpression) != nil else {
                throw ExplorerError("invalid", "The review key or operation is invalid.")
            }
            var request: [String: Any] = ["key": key]
            if op == "set", let raw = fields["viewed"] {
                guard let viewed = raw as? [String], viewed.allSatisfy(validPath) else { throw ExplorerError("invalid", "A viewed path is invalid.") }
                request["viewed"] = viewed
            }
            if op == "set", fields["finished"] as? Bool == true {
                let head = key.hasPrefix("worktree@") ? String(key.dropFirst(9)) : String(key.components(separatedBy: "..").last!)
                request["finished"] = true
                if head != "empty" {
                    request["head"] = head
                    let root = workspace.info()
                    if root["head"] as? String == head { request["branch"] = root["branch"] as? String }
                }
            }
            return try helper.call("review-\(op)", fields: request)
        default: throw ExplorerError("unknown-message", "Unknown Explorer message.")
        }
    }
}
