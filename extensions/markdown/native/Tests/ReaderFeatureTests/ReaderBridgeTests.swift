import Foundation
import Testing
@testable import MarkdownCore
@testable import ReaderFeature

@Suite struct ReaderBridgeTests {
    private func envelope(_ type: String, _ fields: [String: Any] = [:]) -> [String: Any] {
        fields.merging(["v": 1, "type": type]) { _, envelope in envelope }
    }

    @Test func incomingShapesAndStrictPrimitives() throws {
        let ready = try ReaderBridgeCodec.decode(body: envelope("ready", ["version": "test", "capabilities": ["editing": true]]))
        #expect(ready.type == .ready)
        let render = try ReaderBridgeCodec.decode(body: envelope("render", ["generation": 0, "id": "request"]))
        #expect(render.id == "request")
        #expect(render.fields["v"] == nil)
        for bad: [String: Any] in [
            ["v": true, "type": "render", "generation": 0],
            ["v": 2, "type": "render", "generation": 0],
            ["v": 1, "type": "unknown"],
            ["v": 1, "type": "format"],
            ["v": 1, "type": "render", "generation": false],
            ["v": 1, "type": "render", "generation": 0.5],
            ["v": 1, "type": "render", "generation": -1],
            ["v": 1, "type": "render", "generation": ReaderBridgeCodec.maxInteger + 1],
            ["v": 1, "type": "render", "generation": 0, "unexpected": true],
            ["v": 1, "type": "render", "generation": 0, "id": 4],
        ] {
            #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: bad) }
        }
        #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: [1, 2, 3]) }
        #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(data: Data("[]".utf8)) }
        #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(data: Data("not JSON".utf8)) }
    }

    @Test func privateReviewDraftHasAnIndependentBoundOnlyForTheMatchingGroup() throws {
        let args: [String: Any] = ["documentKey": "doc", "expectedVersion": 0]
        func set(_ body: [String: Any]) -> [String: Any] {
            envelope("command", ["name": "setReviewDraft", "args": args.merging(["draft": body]) { _, v in v }])
        }
        let comment = ["text": String(repeating: "x", count: 65536)]
        var comments = Array(repeating: comment, count: 64)
        var draft: [String: Any] = ["comments": comments, "overall": "", "parked": [["index": -1, "text": "notes", "authoredRevision": 3]]]
        let excess = try JSONSerialization.data(withJSONObject: draft).count - ReaderBridgeCodec.reviewDraftLimit
        comments[0] = ["text": String(repeating: "x", count: 65536 - excess)]
        draft["comments"] = comments
        let encoded = try JSONSerialization.data(withJSONObject: set(draft))
        #expect(try ReaderBridgeCodec.decode(data: encoded).type == .command)
        let req = try ReaderBridgeCodec.decode(body: envelope("query", ["kind": "reviewDraft", "documentKey": "doc", "id": "q"]))
        var reply = envelope("reply", ["ok": true, "id": "q", "available": true, "version": 1, "draft": draft])
        try ReaderBridgeCodec.validateReply(reply, request: req)
        let other = try ReaderBridgeCodec.decode(body: envelope("query", ["kind": "details", "id": "q"]))
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.validateReply(reply, request: other) }
        var padded = set(draft)
        padded["padding"] = String(repeating: "p", count: ReaderBridgeCodec.messageLimit)
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.decode(body: padded) }
        comments[0]["text"]?.append("x")
        draft["comments"] = comments
        reply["draft"] = draft
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.decode(body: set(draft)) }
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.validateReply(reply, request: req) }
        let clear = try ReaderBridgeCodec.decode(body: envelope("command", ["name": "setReviewDraft", "args": args]))
        try ReaderBridgeCodec.validateReply(envelope("reply", ["ok": true, "status": "stored", "version": 1]), request: clear)
        #expect(throws: ReaderBridgeError.invalid("version")) {
            try ReaderBridgeCodec.validateReply(envelope("reply", ["ok": true, "status": "stored", "version": 3]), request: clear)
        }
    }

    @Test func recoveryOnlyAcceptsPrivateBatchFieldsAndBoundedPassageEvidence() throws {
        let proof: [String: Any] = ["text": "**hi**", "contexts": [["before": "In ", "after": ""]], "headings": ["A"],
                                    "rendered": ["before": "", "text": "hi", "after": "."]]
        let item: [String: Any] = ["text": "explain", "quote": "hi", "sourceAnchor": proof,
                                   "range": ["start": 0, "end": 6], "authoredRevision": 1]
        let draft: [String: Any] = ["comments": [item], "overall": "reader notes", "parked": [["comment": item, "text": "explain", "index": 0]]]
        try ReaderBridgeCodec.validateReviewDraft(draft)
        for patch: [String: Any] in [
            ["threadId": "private"], ["comments": [item.merging(["requestId": "private"]) { _, v in v }]],
            ["comments": [item.merging(["sourceAnchor": proof.merging(["token": "private"]) { _, v in v }]) { _, v in v }]],
            ["comments": [item.merging(["range": NSNull()]) { _, v in v }]],
            ["parked": [["comment": item, "text": "different", "index": 0]]], ["parked": [["index": -1, "text": "a", "authoredRevision": false]]],
            ["comments": Array(repeating: ["text": "x"], count: 513)],
        ] {
            let bad = draft.merging(patch) { _, v in v }
            #expect(throws: ReaderBridgeError.self) { try ReaderBridgeCodec.validateReviewDraft(bad) }
        }
    }

    @Test func encodedMessageAndFieldBounds() throws {
        let base = try JSONSerialization.data(withJSONObject: envelope("render", ["generation": 0]))
        var atLimit = base
        atLimit.append(Data(repeating: 32, count: ReaderBridgeCodec.messageLimit - base.count))
        #expect(try ReaderBridgeCodec.decode(data: atLimit).type == .render)
        atLimit.append(32)
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.decode(data: atLimit) }
        let tooLarge = Data(repeating: 32, count: ReaderBridgeCodec.editListLimit + ReaderBridgeCodec.messageLimit + 17)
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.decode(data: tooLarge) }
        #expect(throws: (any Error).self) {
            try ReaderBridgeCodec.decode(body: envelope("log", ["level": "info", "message": String(repeating: "a", count: 8193)]))
        }
        #expect(throws: (any Error).self) {
            try ReaderBridgeCodec.decode(body: envelope("render", ["generation": 0, "id": String(repeating: "é", count: 129)]))
        }
        let source = String(repeating: "a", count: ReaderBridgeCodec.sourceLimit)
        let edit: [String: Any] = ["start": 0, "end": 0, "text": source, "expected": ""]
        let decoded = try ReaderBridgeCodec.decode(body: envelope("edits", ["presentation": UUID().uuidString, "baseGeneration": 0, "generation": 1, "origin": "person", "edits": [edit]]))
        #expect(decoded.change?.edits.first?.text.utf8.count == ReaderBridgeCodec.sourceLimit)
        var largerEdit = edit
        largerEdit["text"] = source + "a"
        #expect(throws: (any Error).self) {
            try ReaderBridgeCodec.decode(body: envelope("edits", ["presentation": UUID().uuidString, "baseGeneration": 0, "generation": 1, "origin": "person", "edits": [largerEdit]]))
        }
    }

    @Test func nativeDocumentBudgetsAreIndependentAtTheirExactLimits() throws {
        let emptyBlock: [String: Any] = ["key": "b", "start": 0, "end": 0, "type": "paragraph", "html": "", "map": [[0, 0, 0, 0]]]
        let overhead = try JSONSerialization.data(withJSONObject: [emptyBlock], options: [.withoutEscapingSlashes]).count
        var block = emptyBlock
        block["html"] = String(repeating: "a", count: ReaderBridgeCodec.renderedLimit - overhead)
        var metadata: [String: Any] = ["v": 1, "type": "document", "generation": 0, "meta": ["title": ""]]
        let metadataOverhead = try JSONSerialization.data(withJSONObject: metadata, options: [.withoutEscapingSlashes]).count
        metadata["meta"] = ["title": String(repeating: "t", count: ReaderBridgeCodec.messageLimit - metadataOverhead)]
        var document = metadata
        // JSON escapes each null, but the exact source has only two MiB of UTF-8 bytes.
        document["source"] = String(repeating: "\u{0}", count: ReaderBridgeCodec.sourceLimit)
        document["blocks"] = [block]
        try ReaderBridgeCodec.validateNativeEnvelope(document)

        var invalid = document
        invalid["source"] = String(repeating: "a", count: ReaderBridgeCodec.sourceLimit + 1)
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.validateNativeEnvelope(invalid) }
        invalid = document
        invalid["meta"] = ["title": String(repeating: "t", count: ReaderBridgeCodec.messageLimit - metadataOverhead + 1)]
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.validateNativeEnvelope(invalid) }
        var oversizedBlock = block
        oversizedBlock["html"] = (block["html"] as? String ?? "") + "a"
        invalid = document
        invalid["blocks"] = [oversizedBlock]
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.validateNativeEnvelope(invalid) }
        invalid = document
        invalid["source"] = 0
        #expect(throws: (any Error).self) { try ReaderBridgeCodec.validateNativeEnvelope(invalid) }
        invalid = document
        invalid["blocks"] = "not blocks"
        #expect(throws: (any Error).self) { try ReaderBridgeCodec.validateNativeEnvelope(invalid) }
    }

    @Test func replyBudgetsDependOnTheRequestAndSuccess() throws {
        let render = try ReaderBridgeCodec.decode(body: envelope("render", ["generation": 0, "id": "request"]))
        let review = try ReaderBridgeCodec.decode(body: envelope("query", ["kind": "review", "against": "previous", "id": "request"]))
        let details = try ReaderBridgeCodec.decode(body: envelope("query", ["kind": "details", "id": "request"]))
        let large = String(repeating: "a", count: ReaderBridgeCodec.messageLimit + 1)
        var rendered: [String: Any] = ["v": 1, "type": "reply", "id": "request", "ok": true,
            "generation": 0, "blocks": [["key": "b", "html": large, "map": [[0, 1, 0, 1]]]]]
        try ReaderBridgeCodec.validateReply(rendered, request: render)
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.validateReply(rendered, request: details) }
        rendered["detail"] = large
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.validateReply(rendered, request: render) }
        rendered.removeValue(forKey: "detail")
        rendered["blocks"] = [["html": String(repeating: "a", count: ReaderBridgeCodec.renderedLimit)]]
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.validateReply(rendered, request: render) }

        var reviewed: [String: Any] = ["v": 1, "type": "reply", "id": "request", "ok": true,
            "summary": [:], "html": String(repeating: "\"", count: ReaderBridgeCodec.renderedLimit)]
        try ReaderBridgeCodec.validateReply(reviewed, request: review)
        reviewed["html"] = String(repeating: "a", count: ReaderBridgeCodec.renderedLimit + 1)
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.validateReply(reviewed, request: review) }
        reviewed["html"] = large
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.validateReply(reviewed, request: details) }
        reviewed["ok"] = false
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.validateReply(reviewed, request: review) }
        reviewed["ok"] = true
        reviewed["summary"] = ["detail": large]
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.validateReply(reviewed, request: review) }

        let markdown = try ReaderBridgeCodec.decode(body: envelope("query", ["kind": "markdown", "text": "# T", "id": "request"]))
        var detached: [String: Any] = ["v": 1, "type": "reply", "id": "request", "ok": true, "html": large]
        try ReaderBridgeCodec.validateReply(detached, request: markdown)
        detached["html"] = String(repeating: "a", count: ReaderBridgeCodec.renderedLimit + 1)
        #expect(throws: ReaderBridgeError.oversized) { try ReaderBridgeCodec.validateReply(detached, request: markdown) }
        reviewed["summary"] = [:]
        reviewed["html"] = ""
        reviewed["id"] = "different"
        #expect(throws: (any Error).self) { try ReaderBridgeCodec.validateReply(reviewed, request: review) }
        reviewed["id"] = "request"
        reviewed["ok"] = 1
        #expect(throws: (any Error).self) { try ReaderBridgeCodec.validateReply(reviewed, request: review) }
    }

    @Test func largePasteReplacementAndUndoUseTheEditsBudget() throws {
        let count = 19 * 1024 * 1024 / 10
        let first = String(repeating: "a", count: count)
        let second = String(repeating: "b", count: count)
        var mirror = try ReaderSourceMirror(source: "")
        let changes: [(String, String, String)] = [
            ("", first, "person"), (first, second, "agent"), (second, first, "history"), (first, "", "history"),
        ]
        for (index, entry) in changes.enumerated() {
            let (expected, text, origin) = entry
            let edits: [[String: Any]] = [["start": 0, "end": expected.utf16.count, "expected": expected, "text": text]]
            let fields: [String: Any] = ["presentation": UUID().uuidString, "baseGeneration": index, "generation": index + 1, "origin": origin, "edits": edits]
            let data = try JSONSerialization.data(withJSONObject: envelope("edits", fields), options: [.withoutEscapingSlashes])
            let decoded = try ReaderBridgeCodec.decode(data: data)
            let change = try #require(decoded.change)
            try mirror.apply(change)
            #expect(mirror.source.utf8.elementsEqual(text.utf8))
            try ReaderBridgeCodec.validateNativeEnvelope(["v": 1, "type": "agentApply", "operationId": "op",
                "baseGeneration": index, "edits": edits])
        }
        #expect(mirror.source.isEmpty)
        #expect(mirror.generation == 4)
        let oversized: [[String: Any]] = [["start": 0, "end": count, "expected": first, "text": second],
                                          ["start": count, "end": count, "expected": "", "text": first]]
        #expect(throws: ReaderBridgeError.oversized) {
            try ReaderBridgeCodec.decode(body: envelope("edits", ["presentation": UUID().uuidString, "baseGeneration": 0, "generation": 1, "origin": "person", "edits": oversized]))
        }
        #expect(throws: ReaderBridgeError.oversized) {
            try ReaderBridgeCodec.validateNativeEnvelope(["v": 1, "type": "agentApply", "operationId": "op", "baseGeneration": 0, "edits": oversized])
        }
        #expect(throws: ReaderBridgeError.oversized) {
            try ReaderBridgeCodec.decode(body: envelope("edits", ["presentation": UUID().uuidString, "baseGeneration": 0, "generation": 1, "origin": "person",
                "operationId": String(repeating: "x", count: ReaderBridgeCodec.messageLimit),
                "edits": [["start": 0, "end": 0, "expected": "", "text": first]]]))
        }
    }

    @Test func ordinaryNativeEnvelopesAndRepliesKeepTheirTotalLimit() throws {
        try ReaderBridgeCodec.validateNativeEnvelope(["v": 1, "type": "command", "name": "undo", "args": [:]])
        #expect(throws: ReaderBridgeError.oversized) {
            try ReaderBridgeCodec.validateNativeEnvelope(["v": 1, "type": "notice", "text": String(repeating: "a", count: ReaderBridgeCodec.messageLimit)])
        }
        for fields: [String: Any] in [["v": 2, "type": "command"], ["v": true, "type": "command"], ["v": 1, "type": "unknown"], ["v": 1, "type": "command", "args": ["value": Double.nan]]] {
            #expect(throws: (any Error).self) { try ReaderBridgeCodec.validateNativeEnvelope(fields) }
        }
        let request = try ReaderBridgeCodec.decode(body: envelope("ready", ["version": "test", "capabilities": [:]]))
        try ReaderBridgeCodec.validateReply(["v": 1, "type": "reply", "ok": true], request: request)
        #expect(throws: ReaderBridgeError.oversized) {
            try ReaderBridgeCodec.validateReply(["v": 1, "type": "reply", "ok": true, "data": String(repeating: "a", count: ReaderBridgeCodec.messageLimit)], request: request)
        }
        #expect(throws: ReaderBridgeError.oversized) {
            try ReaderBridgeCodec.decode(body: envelope("command", ["name": "copy", "args": ["text": String(repeating: "a", count: ReaderBridgeCodec.messageLimit)]]))
        }
    }

    @Test func copyCommandAcceptsOnlyText() throws {
        let copy = try ReaderBridgeCodec.decode(body: envelope("command", ["name": "copy", "args": ["text": ""]]))
        #expect(copy.type == .command)
        #expect(throws: ReaderBridgeError.self) {
            try ReaderBridgeCodec.decode(body: envelope("command", ["name": "copy", "args": ["text": "exact", "markdown": "unused"]]))
        }
    }

    @Test func jumpHistoryStateRequiresBooleansAndNativeCommandsRemainValid() throws {
        let state: [String: Any] = ["lock": "reading", "canUndo": false, "canRedo": false,
            "canBack": false, "canForward": false, "hasSelection": false, "findOpen": false,
            "scroll": ["blockStart": 0, "offsetY": 0]]
        for back in [false, true] {
            for forward in [false, true] {
                var fields = state
                fields["canBack"] = back
                fields["canForward"] = forward
                let decoded = try ReaderBridgeCodec.decode(body: envelope("state", fields))
                #expect(decoded.pageState?.canBack == back)
                #expect(decoded.pageState?.canForward == forward)
            }
        }
        for key in ["canBack", "canForward"] {
            for value: Any in [0, 1, "true", NSNull()] {
                var invalid = state
                invalid[key] = value
                #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("state", invalid)) }
            }
            var missing = state
            missing.removeValue(forKey: key)
            #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("state", missing)) }
        }
        for name in ["back", "forward"] {
            try ReaderBridgeCodec.validateNativeEnvelope(["v": 1, "type": "command", "name": name])
        }
    }

    @Test func scrollAndRestorePositionShareOneExactShape() throws {
        var state: [String: Any] = ["lock": "reading", "canUndo": false, "canRedo": false,
            "canBack": false, "canForward": false, "hasSelection": false, "findOpen": false]
        var document: [String: Any] = ["v": 1, "type": "document", "source": "", "blocks": [[String: Any]]()]
        try ReaderBridgeCodec.validateNativeEnvelope(document)
        let positions: [(Int, Double)] = [(0, 0), (27, -12.5), (ReaderBridgeCodec.sourceLimit + 1, 1e10),
            (ReaderBridgeCodec.maxInteger, Double.greatestFiniteMagnitude), (0, -Double.greatestFiniteMagnitude)]
        for (start, offset) in positions {
            let position: [String: Any] = ["blockStart": start, "offsetY": offset]
            state["scroll"] = position
            let decoded = try ReaderBridgeCodec.decode(body: envelope("state", state))
            #expect(decoded.pageState?.scroll == .init(blockStart: start, offsetY: offset))
            document["position"] = position
            try ReaderBridgeCodec.validateNativeEnvelope(document)
        }
        let invalidPositions: [Any] = [
            ["blockStart": -1, "offsetY": 0], ["blockStart": 0.5, "offsetY": 0],
            ["blockStart": ReaderBridgeCodec.maxInteger + 1, "offsetY": 0],
            ["blockStart": true, "offsetY": 0], ["blockStart": "0", "offsetY": 0],
            ["blockStart": 0, "offsetY": true], ["blockStart": 0, "offsetY": "0"],
            ["blockStart": 0, "offsetY": Double.nan], ["blockStart": 0, "offsetY": Double.infinity],
            ["blockStart": 0, "offsetY": -Double.infinity], ["blockStart": 0], ["offsetY": 0],
            ["blockStart": 0, "offsetY": 0, "extra": 1], NSNull(), [0, 0],
        ]
        for position in invalidPositions {
            state["scroll"] = position
            #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("state", state)) }
            document["position"] = position
            #expect(throws: (any Error).self) { try ReaderBridgeCodec.validateNativeEnvelope(document) }
        }
        state.removeValue(forKey: "scroll")
        #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("state", state)) }
    }

    @Test func stateQueriesAndCommandArguments() throws {
        let state: [String: Any] = ["lock": "writing", "canUndo": true, "canRedo": false,
            "canBack": false, "canForward": false, "hasSelection": true, "findOpen": false, "held": ["start": 2, "end": 4],
            "activeBlock": ["start": 0, "end": 8], "scroll": ["blockStart": 0, "offsetY": -12.5]]
        let decoded = try ReaderBridgeCodec.decode(body: envelope("state", state))
        #expect(decoded.pageState?.held == .init(start: 2, end: 4))
        #expect(decoded.pageState?.scroll.offsetY == -12.5)
        var detailedState = state
        detailedState["find"] = ["query": "needle", "count": 0, "index": -1]
        detailedState["overlay"] = "review"
        detailedState["selection"] = ["text": "😀", "start": 2, "end": 4]
        let detailed = try ReaderBridgeCodec.decode(body: envelope("state", detailedState))
        #expect(detailed.pageState?.find == .init(query: "needle", count: 0, index: -1))
        #expect(detailed.pageState?.selection == .init(text: "😀", start: 2, end: 4))
        #expect(detailed.pageState?.overlay == "review")
        detailedState["overlay"] = NSNull()
        #expect(try ReaderBridgeCodec.decode(body: envelope("state", detailedState)).pageState?.overlay == nil)
        detailedState["overlay"] = "unknown"
        #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("state", detailedState)) }
        var invalidState = state
        invalidState["canUndo"] = 1
        #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("state", invalidState)) }
        invalidState = state
        invalidState["held"] = ["start": 4, "end": 2]
        #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("state", invalidState)) }
        let queries: [[String: Any]] = [
            ["kind": "details"], ["kind": "review", "against": "previous"], ["kind": "review", "against": "base"], ["kind": "review", "against": 2],
            ["kind": "image", "index": 0], ["kind": "library", "collection": "drafts", "query": "", "cursor": "next"],
            ["kind": "markdown", "text": "# Title\n\n- item\n"], ["kind": "markdown", "text": ""],
        ]
        for query in queries { #expect(try ReaderBridgeCodec.decode(body: envelope("query", query)).type == .query) }
        for query: [String: Any] in [["kind": "unknown"], ["kind": "review", "against": "next"], ["kind": "image", "index": true], ["kind": "library", "collection": "all"],
                                     ["kind": "markdown"], ["kind": "markdown", "text": 1], ["kind": "markdown", "text": "x", "generation": 1]] {
            #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("query", query)) }
        }
        #expect(try ReaderBridgeCodec.decode(body: envelope("command", ["name": "openLink", "args": ["href": "https://example.org/"]])).type == .command)
        for format in ["archive", "sharing", "pdf"] {
            #expect(try ReaderBridgeCodec.decode(body: envelope("command", ["name": "export", "args": ["format": format]])).type == .command)
        }
        #expect(try ReaderBridgeCodec.decode(body: envelope("command", ["name": "open"])).type == .command)
        #expect(try ReaderBridgeCodec.decode(body: envelope("command", ["name": "open", "args": ["ref": "native-reference"]])).type == .command)
        for command: [String: Any] in [["name": "unknown"], ["name": "close", "args": ["extra": true]], ["name": "inspectImage", "args": ["index": -1]],
                                      ["name": "export", "args": ["format": "html"]], ["name": "export", "args": ["format": "markdown"]],
                                      ["name": "open", "args": ["ref": ["kind": "file", "path": "/notes/file.md"]]]] {
            #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("command", command)) }
        }
    }

    @Test func savedTextSizeIsAFinitePositiveMultiplier() throws {
        for size in [0.8125, 1, 1.0625, 1.6875, 0.000001, 21, Double.greatestFiniteMagnitude] {
            let command: [String: Any] = ["name": "saveSettings", "args": ["patch": ["textSize": size]]]
            let decoded = try ReaderBridgeCodec.decode(body: envelope("command", command))
            let args = try #require(decoded.fields["args"] as? [String: Any])
            let patch = try #require(args["patch"] as? [String: Any])
            #expect((patch["textSize"] as? NSNumber)?.doubleValue == size)
        }
        for size: Any in [true, false, 0, -0.0, -1, Double.nan, Double.infinity, -Double.infinity, "1", NSNull()] {
            let command: [String: Any] = ["name": "saveSettings", "args": ["patch": ["textSize": size]]]
            #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("command", command)) }
        }
    }

    @Test func savedDarkThemeIsACatppuccinDarkFlavour() throws {
        for theme in ["frappe", "macchiato", "mocha"] {
            let command: [String: Any] = ["name": "saveSettings", "args": ["patch": ["darkTheme": theme]]]
            #expect(try ReaderBridgeCodec.decode(body: envelope("command", command)).type == .command)
        }
        for theme: Any in ["latte", "Mocha", "", 1, NSNull()] {
            let command: [String: Any] = ["name": "saveSettings", "args": ["patch": ["darkTheme": theme]]]
            #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("command", command)) }
        }
    }

    @Test func libraryMatchAndStoreChooserValidateTheirArguments() throws {
        for collection in ["drafts", "recent", "published"] {
            let fields: [String: Any] = ["kind": "library", "collection": collection, "query": "needle"]
            #expect(try ReaderBridgeCodec.decode(body: envelope("query", fields)).type == .query)
            for match in ["title", "source"] {
                var query = fields
                query["match"] = match
                #expect(try ReaderBridgeCodec.decode(body: envelope("query", query)).fields["match"] as? String == match)
            }
            for match: Any in ["", "all", "SOURCE", true, 1, NSNull()] {
                var query = fields
                query["match"] = match
                #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("query", query)) }
            }
        }
        #expect(try ReaderBridgeCodec.decode(body: envelope("command", ["name": "chooseStore"])).type == .command)
        #expect(try ReaderBridgeCodec.decode(body: envelope("command", ["name": "chooseStore", "args": [String: Any]()])).type == .command)
        #expect(throws: (any Error).self) {
            try ReaderBridgeCodec.decode(body: envelope("command", ["name": "chooseStore", "args": ["path": "/untrusted/store"]]))
        }
        #expect(throws: (any Error).self) {
            try ReaderBridgeCodec.decode(body: envelope("query", ["kind": "details", "match": "source"]))
        }
    }

    @Test func promptsRequireABoundedOpaqueThreadIdentity() throws {
        let first: [String: Any] = ["presentation": UUID().uuidString, "documentKey": UUID().uuidString, "requestId": "first-request", "threadId": "first-request", "text": "Ask about this document", "generation": 0]
        let opened = try ReaderBridgeCodec.decode(body: envelope("prompt", first))
        #expect(opened.type == .prompt)
        #expect(opened.fields["threadId"] as? String == "first-request")
        var followUp = first
        followUp["requestId"] = "second-request"
        let continued = try ReaderBridgeCodec.decode(body: envelope("prompt", followUp))
        #expect(continued.fields["requestId"] as? String == "second-request")
        #expect(continued.fields["threadId"] as? String == "first-request")
        var atLimit = first
        atLimit["threadId"] = String(repeating: "é", count: 128)
        #expect(try ReaderBridgeCodec.decode(body: envelope("prompt", atLimit)).type == .prompt)
        var missing = first
        missing.removeValue(forKey: "threadId")
        #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("prompt", missing)) }
        for value: Any in ["", 1, true, NSNull(), String(repeating: "a", count: 257), String(repeating: "é", count: 129)] {
            var invalid = first
            invalid["threadId"] = value
            #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("prompt", invalid)) }
        }
    }

    @Test func promptAndEditMessagesRequireTheirPageIdentities() throws {
        let prompt: [String: Any] = ["presentation": UUID().uuidString, "documentKey": UUID().uuidString,
            "text": "Which revision?", "requestId": "r", "threadId": "t", "generation": 0, "authoredRevision": 2]
        #expect(try ReaderBridgeCodec.decode(body: envelope("prompt", prompt)).fields["authoredRevision"] as? Int == 2)
        for field in ["presentation", "documentKey"] {
            var invalid = prompt; invalid[field] = nil
            #expect(throws: ReaderBridgeError.self) { try ReaderBridgeCodec.decode(body: envelope("prompt", invalid)) }
            invalid[field] = "other"
            #expect(throws: ReaderBridgeError.self) { try ReaderBridgeCodec.decode(body: envelope("prompt", invalid)) }
        }
        var invalid = prompt; invalid["authoredRevision"] = true
        #expect(throws: ReaderBridgeError.self) { try ReaderBridgeCodec.decode(body: envelope("prompt", invalid)) }
        let edits: [String: Any] = ["baseGeneration": 0, "generation": 1, "origin": "person",
            "edits": [["start": 0, "end": 0, "text": "x", "expected": ""]]]
        #expect(throws: ReaderBridgeError.self) { try ReaderBridgeCodec.decode(body: envelope("edits", edits)) }
    }

    @Test func batchPromptRequiresBoundedAnnotationsAndNoSingleFields() throws {
        let header: [String: Any] = ["presentation": UUID().uuidString, "documentKey": UUID().uuidString, "requestId": "first-request", "threadId": "first-request", "generation": 1]
        let quote = "😀\n"
        let annotation: [String: Any] = ["text": "Rewrite this.", "quote": quote, "quoteRange": ["start": 0, "end": 3]]
        func decode(_ fields: [String: Any]) throws -> ReaderBridgeMessage {
            try ReaderBridgeCodec.decode(body: envelope("prompt", header.merging(fields) { _, field in field }))
        }
        let batch = try decode(["annotations": [annotation, ["text": "Explain the title."]]])
        #expect(batch.type == .prompt)
        #expect((batch.fields["annotations"] as? [[String: Any]])?.first?["quote"] as? String == quote)
        #expect(try decode(["annotations": Array(repeating: annotation, count: 50)]).type == .prompt)
        let overall = "Keep the tone direct.\n" + String(repeating: "é", count: 32757)
        #expect(overall.utf8.count == 64 * 1024)
        #expect(try decode(["annotations": [annotation], "overall": overall]).fields["overall"] as? String == overall)
        for fields: [String: Any] in [
            ["annotations": [annotation], "overall": " \n"], ["annotations": [annotation], "overall": "\u{85}"],
            ["annotations": [annotation], "overall": true],
            ["annotations": [annotation], "authoredRevision": 1],
            ["annotations": [["text": "Which revision?", "authoredRevision": 0]]],
            ["annotations": [annotation], "overall": String(repeating: "é", count: 32769)],
            ["text": "A single comment.", "overall": "Only batches carry one."],
            ["annotations": []], ["annotations": Array(repeating: annotation, count: 51)],
            ["annotations": [annotation], "text": "Both"], ["annotations": [annotation], "quote": quote],
            ["annotations": [["text": " \n"]]], ["annotations": [["text": true]]],
            ["annotations": [["text": String(repeating: "é", count: 32769)]]],
            ["annotations": [["text": "Invalid", "quoteRange": ["start": 3, "end": 2]]]],
            ["annotations": [["text": "Unknown", "range": ["start": 0, "end": 3]]]],
            ["annotations": Array(repeating: ["text": String(repeating: "é", count: 32768)], count: 4)],
        ] {
            #expect(throws: ReaderBridgeError.self) { try decode(fields) }
        }
    }

    @Test func imagePickerRequiresAnExactGenerationAndSourceRange() throws {
        for generation in [0, ReaderBridgeCodec.maxInteger] {
            let message = try ReaderBridgeCodec.decode(body: envelope("command", ["name": "pickImage",
                "args": ["generation": generation, "range": ["start": 2, "end": 4]]]))
            #expect(message.type == .command)
            let args = try #require(message.fields["args"] as? [String: Any])
            #expect(args["generation"] as? Int == generation)
        }
        #expect(try ReaderBridgeCodec.decode(body: envelope("command", ["name": "pickImage",
            "args": ["generation": 0, "range": ["start": 0, "end": 0]]])).type == .command)
        let invalid: [[String: Any]] = [
            [:], ["generation": 0], ["range": ["start": 0, "end": 0]],
            ["generation": true, "range": ["start": 0, "end": 0]],
            ["generation": -1, "range": ["start": 0, "end": 0]],
            ["generation": 0.5, "range": ["start": 0, "end": 0]],
            ["generation": ReaderBridgeCodec.maxInteger + 1, "range": ["start": 0, "end": 0]],
            ["generation": 0, "range": NSNull()],
            ["generation": 0, "range": ["start": 4, "end": 2]],
            ["generation": 0, "range": ["start": true, "end": 2]],
            ["generation": 0, "range": ["start": 0.5, "end": 2]],
            ["generation": 0, "range": ["start": 0, "end": ReaderBridgeCodec.sourceLimit + 1]],
            ["generation": 0, "range": ["start": 0, "end": 2, "extra": true]],
            ["generation": 0, "range": ["start": 0, "end": 0], "extra": true],
        ]
        for args in invalid {
            #expect(throws: (any Error).self) {
                try ReaderBridgeCodec.decode(body: envelope("command", ["name": "pickImage", "args": args]))
            }
        }
    }

    @Test func editDecoderRejectsBadOrderTypesAndGenerations() throws {
        let valid: [String: Any] = ["presentation": UUID().uuidString, "baseGeneration": 1, "generation": 2, "origin": "history",
            "edits": [["start": 0, "end": 1, "text": "x", "expected": "a"]]]
        #expect(try ReaderBridgeCodec.decode(body: envelope("edits", valid)).change?.origin == .history)
        for (key, value): (String, Any) in [
            ("generation", 3), ("baseGeneration", true), ("origin", "unknown"), ("edits", []),
            ("edits", [["start": 0, "end": 2, "text": "x", "expected": "a"]]),
            ("edits", [["start": 1, "end": 2, "text": "x", "expected": "a"], ["start": 0, "end": 1, "text": "y", "expected": "b"]]),
        ] {
            var invalid = valid
            invalid[key] = value
            #expect(throws: (any Error).self) { try ReaderBridgeCodec.decode(body: envelope("edits", invalid)) }
        }
    }

    @Test func mirrorPreservesExactBytesAndUnicodeScalarBoundaries() throws {
        let source = "A😀e\u{301}\r\nB\rC\n"
        var mirror = try ReaderSourceMirror(source: source)
        try mirror.apply(.init(baseGeneration: 0, generation: 1, origin: .person, edits: [
            .init(start: 1, end: 3, text: "🧑🏽‍💻", expected: "😀"),
            .init(start: 4, end: 5, text: "\u{308}", expected: "\u{301}"),
        ]))
        let expected = "A🧑🏽‍💻e\u{308}\r\nB\rC\n"
        #expect(Array(mirror.source.utf8) == Array(expected.utf8))
        #expect(mirror.generation == 1)
        #expect(mirror.digest == Digest.sha256(Data(expected.utf8)))
        // Combining marks are valid scalar boundaries, not necessarily Character boundaries.
        var combining = try ReaderSourceMirror(source: "e\u{301}")
        try combining.apply(.init(baseGeneration: 0, generation: 1, origin: .history,
                                 edits: [.init(start: 1, end: 2, text: "", expected: "\u{301}")]))
        #expect(combining.source == "e")
    }

    @Test func mirrorRefusalsAreAtomic() throws {
        let source = "A😀éZ"
        let changes: [ReaderBridgeChange] = [
            .init(baseGeneration: 1, generation: 2, origin: .person, edits: [.init(start: 0, end: 1, text: "B", expected: "A")]),
            .init(baseGeneration: 0, generation: 2, origin: .person, edits: [.init(start: 0, end: 1, text: "B", expected: "A")]),
            .init(baseGeneration: 0, generation: 1, origin: .person, edits: [.init(start: 2, end: 3, text: "B", expected: "")]),
            .init(baseGeneration: 0, generation: 1, origin: .person, edits: [.init(start: 1, end: 2, text: "B", expected: "")]),
            .init(baseGeneration: 0, generation: 1, origin: .person, edits: [.init(start: 2, end: 2, text: "B", expected: "")]),
            .init(baseGeneration: 0, generation: 1, origin: .agent, edits: [.init(start: 0, end: 1, text: "B", expected: "A"), .init(start: 3, end: 4, text: "E", expected: "e\u{301}")]),
            .init(baseGeneration: 0, generation: 1, origin: .person, edits: [.init(start: 0, end: 3, text: "B", expected: "A😀"), .init(start: 1, end: 3, text: "C", expected: "😀")]),
            .init(baseGeneration: 0, generation: 1, origin: .person, edits: [.init(start: 0, end: 999, text: "B", expected: "A")]),
            .init(baseGeneration: 0, generation: 1, origin: .person, edits: []),
        ]
        for change in changes {
            var mirror = try ReaderSourceMirror(source: source)
            let digest = mirror.digest
            #expect(throws: (any Error).self) { try mirror.apply(change) }
            #expect(Array(mirror.source.utf8) == Array(source.utf8))
            #expect(mirror.generation == 0)
            #expect(mirror.digest == digest)
        }
    }

    @Test func sourceBoundsAndHistoryRoundTrip() throws {
        let source = String(repeating: "x", count: ReaderBridgeCodec.sourceLimit)
        var mirror = try ReaderSourceMirror(source: source)
        #expect(throws: ReaderBridgeError.oversized) {
            try mirror.apply(.init(baseGeneration: 0, generation: 1, origin: .person, edits: [.init(start: 0, end: 0, text: "y", expected: "")]))
        }
        #expect(mirror.source.utf8.count == ReaderBridgeCodec.sourceLimit)
        #expect(mirror.generation == 0)
        #expect(throws: ReaderBridgeError.oversized) { try ReaderSourceMirror(source: source + "y") }
        var history = try ReaderSourceMirror(source: "A\r\nB\rC\n")
        try history.apply(.init(baseGeneration: 0, generation: 1, origin: .agent, operationId: "op", edits: [.init(start: 3, end: 4, text: "β", expected: "B")]))
        try history.apply(.init(baseGeneration: 1, generation: 2, origin: .history, edits: [.init(start: 3, end: 4, text: "B", expected: "β")]))
        #expect(Array(history.source.utf8) == Array("A\r\nB\rC\n".utf8))
    }

    @Test func menuEnablementUsesPageState() {
        let reading = ReaderBridgePageState()
        for command in ReaderPageCommand.allCases where command != .open {
            #expect(!command.isEnabled(state: nil, documentLoaded: true))
            #expect(!command.isEnabled(state: reading, documentLoaded: false))
        }
        #expect(ReaderPageCommand.open.isEnabled(state: nil, documentLoaded: false))
        #expect(!ReaderPageCommand.undo.isEnabled(state: reading, documentLoaded: true))
        #expect(!ReaderPageCommand.redo.isEnabled(state: reading, documentLoaded: true))
        #expect(!ReaderPageCommand.back.isEnabled(state: reading, documentLoaded: true))
        #expect(!ReaderPageCommand.forward.isEnabled(state: reading, documentLoaded: true))
        #expect(!ReaderPageCommand.replace.isEnabled(state: reading, documentLoaded: true))
        #expect(!ReaderPageCommand.askSelection.isEnabled(state: reading, documentLoaded: true))
        #expect(ReaderPageCommand.find.isEnabled(state: reading, documentLoaded: true))
        var history = ReaderBridgePageState(canBack: true)
        #expect(ReaderPageCommand.back.isEnabled(state: history, documentLoaded: true))
        #expect(!ReaderPageCommand.forward.isEnabled(state: history, documentLoaded: true))
        history.canBack = false
        history.canForward = true
        #expect(!ReaderPageCommand.back.isEnabled(state: history, documentLoaded: true))
        #expect(ReaderPageCommand.forward.isEnabled(state: history, documentLoaded: true))
        #expect(!ReaderPageCommand.back.isEnabled(state: history, documentLoaded: false))
        #expect(!ReaderPageCommand.forward.isEnabled(state: history, documentLoaded: false))
        var writing = ReaderBridgePageState(lock: .writing, canUndo: true, canRedo: true, hasSelection: true)
        #expect(ReaderPageCommand.undo.isEnabled(state: writing, documentLoaded: true))
        #expect(ReaderPageCommand.redo.isEnabled(state: writing, documentLoaded: true))
        #expect(ReaderPageCommand.copyPassage.isEnabled(state: writing, documentLoaded: true))
        #expect(ReaderPageCommand.replace.isEnabled(state: writing, documentLoaded: true))
        #expect(!ReaderPageCommand.format.isEnabled(state: writing, documentLoaded: true))
        writing.activeBlock = .init(start: 0, end: 1)
        #expect(ReaderPageCommand.format.isEnabled(state: writing, documentLoaded: true))
    }
}
