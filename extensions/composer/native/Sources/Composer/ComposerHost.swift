import AppKit
import CoreFoundation
import Darwin
import NativePane
import OSLog
import WebKit

@MainActor
final class ComposerHost {
    private static let fitLog = Logger(subsystem: "local.harness.composer", category: "fit")
    private let overlay = PaneOverlay(background: { ComposerHost.paperColour }, logger: Logger(subsystem: "local.harness.composer", category: "pane"), tracksWindowContent: true)
    private static var paperColour: NSColor {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                ? NSColor(srgbRed: 36 / 255, green: 39 / 255, blue: 58 / 255, alpha: 1)
                : NSColor(srgbRed: 239 / 255, green: 241 / 255, blue: 245 / 255, alpha: 1)
        }
    }

    private let terminal: PaneTerminal
    private let page: ComposerPage
    private let store: ComposerDraftStore
    private let files: ComposerFiles
    private var preferences: ComposerPreferences
    private var recovery: ComposerDraftStore.Draft?
    private var recoveryJob: Task<Void, Never>?
    private var reportedVisibility: Bool?
    private var visibilityJob: Task<Void, Never>?
    private let reconnectFile: URL
    private var configuration: ComposerConfiguration
    private var link: ComposerTransport?
    private var text: String
    private var generation = 0
    private var state: [String: Any]?
    private var history: [String] = []
    private var connection = "connecting"
    private var connectionNotice: String?
    private var ready = false
    private var reveal = false
    private var wantsFocus = false
    private var closing = false
    private var terminalGone = false
    private var submitting = false
    private var draftJob: Task<Void, Never>?
    private var connectionJob: Task<Void, Never>?
    private var peerMonitor: Task<Void, Never>?
    private var input = ComposerTerminalInput()
    private var buffered: [(String, [String: Any])] = []
    private var lastMetrics: CGSize?
    private var retentionProblem: String?
    private var fit: ComposerFit
    private var fitStartup: ComposerFit.Startup?
    private var lastOverlayAbove = 0.0
    private var resizeJob: Task<Void, Never>?

    init(configuration: ComposerConfiguration, launchFile: URL, stateDirectory: URL, terminal: PaneTerminal) throws {
        self.configuration = configuration
        fit = ComposerFit(offset: ComposerFit.loadOffset(from: stateDirectory))
        self.terminal = terminal
        reconnectFile = launchFile.deletingLastPathComponent().appendingPathComponent("composer-\(configuration.composer).json")
        store = ComposerDraftStore(directory: stateDirectory, composer: configuration.composer)
        files = ComposerFiles(directory: store.directory)
        preferences = ComposerPreferences.load(from: stateDirectory)
        text = store.retained()
        page = try ComposerPage(frame: overlay.content.bounds)
    }

    func start() {
        fitStartup = ComposerFit.Startup(now: .now)
        overlay.ready = false
        overlay.window.onClose = { [weak self] in self?.close() }
        overlay.window.onCancel = { [weak self] in self?.post("escape") }
        overlay.onChange = { [weak self] in self?.placed() }
        overlay.content.addSubview(page.view)
        page.receive = { [weak self] type, fields in
            guard let self else { throw composerRefusal("The composer is closed.") }
            return try await self.handle(type, fields)
        }
        page.onDroppedFiles = { [weak self] urls in
            guard let self, !closing else { return }
            do { post("paths", ["paths": try files.ingest(urls)]) }
            catch { post("notice", ["text": error.localizedDescription]) }
        }
        page.onFailure = { [weak self] in
            guard let self else { return }
            ready = false
            lastOverlayAbove = 0
            overlay.extendAbove(0)
        }
        terminal.onBytes = { [weak self] bytes in self?.terminalInput(bytes) }
        terminal.onResize = { [weak self] in
            guard let self else { return }
            fitStartup?.terminalResized()
            overlay.anchor.refresh()
            publishMetrics()
            resizeToFit()
        }
        terminal.onHangUp = { [weak self] in self?.close(terminalGone: true) }
        terminal.onTerminate = { [weak self] in self?.close() }
        terminal.enter()
        terminal.start()
        overlay.start()
        placed()
        do { try ComposerDraftStore.prepare(store.directory) }
        catch { recordRetentionFailure(error, notify: false) }
        page.load()
        connectionJob = Task { await connect() }
        peerMonitor = Task {
            while !Task.isCancelled {
                guard ComposerDraftStore.alive(configuration.pid) else { piEnded(); return }
                if fitStartup != nil || fit.awaitsFrame { resizeToFit() }
                try? await Task.sleep(for: .milliseconds(200))
            }
        }
        Task {
            try? await Task.sleep(for: .seconds(2))
            reveal = true
            showWhenReady()
        }
    }

    private func showWhenReady() {
        if ready, reveal, !closing { overlay.ready = true }
    }

    private var terminalMetrics: CGSize? {
        guard case .placed(let pane) = overlay.anchor.status else { return nil }
        let (columns, rows) = terminal.size()
        // The PTY describes the character grid, not its font. Estimate the em
        // from both axes: a terminal cell is roughly 0.6 em wide and 1.25 em tall.
        let cell = pane.frame.width / CGFloat(columns)
        let row = pane.frame.height / CGFloat(rows)
        guard cell >= 4, cell <= 24, row >= 8, row <= 44 else { return nil }
        let base = (cell / 0.60 + row / 1.25) / 2
        return CGSize(width: (cell * 4).rounded() / 4, height: (base * 4).rounded() / 4)
    }

    private func publishMetrics() {
        guard ready, let metrics = terminalMetrics, lastMetrics != metrics else { return }
        lastMetrics = metrics
        post("metrics", ["baseSize": metrics.height, "cellWidth": metrics.width])
    }

    private func placed() {
        publishMetrics()
        terminal.drawMarker(overlay.anchor.marker)
        syncVisibility()
        if lastOverlayAbove != overlay.appliedAbove {
            lastOverlayAbove = overlay.appliedAbove
            post("overlay", ["above": lastOverlayAbove])
        }
        resizeToFit()
        if wantsFocus, ready, overlay.window.isVisible, !closing {
            wantsFocus = false
            overlay.window.makeKeyAndOrderFront(nil)
            overlay.window.makeFirstResponder(page.view)
            post("focus")
        }
    }

    private func focus() {
        wantsFocus = true
        placed()
    }

    private func post(_ type: String, _ fields: [String: Any] = [:]) {
        if ready { Task { await page.send(type, fields) } }
    }

    private func publishStatus() async {
        var fields: [String: Any] = ["connection": connection]
        fields["state"] = state
        fields["notice"] = connectionNotice
        if ready { await page.send("status", fields) }
    }

    private func terminalInput(_ bytes: ArraySlice<UInt8>) {
        let value = input.feed(bytes)
        if !value.text.isEmpty {
            focus()
            Task { await deliver("insert", value.text) }
        } else if !value.close { focus() }
        if value.close { close() }
    }

    private func deliver(_ type: String, _ value: String) async {
        guard type != "insert" || !value.isEmpty else { return }
        let fields = ["text": value]
        if ready, await page.send(type, fields) { return }
        buffered.append((type, fields))
    }

    @MainActor
    private final class Hello {
        let link: ComposerTransport
        let generation: Int
        let sequence: Int
        let state: [String: Any]
        let history: [String]
        let replacement: String?

        init(link: ComposerTransport, generation: Int, reply: [String: Any]) throws {
            guard reply["protocol"] as? Int == 1, let sequence = reply["sequence"] as? Int,
                  let state = reply["state"] as? [String: Any], let history = reply["history"] as? [String],
                  reply["text"] == nil || reply["text"] is String else {
                throw ComposerTransportError.invalidResponse
            }
            self.link = link
            self.generation = generation
            self.sequence = sequence
            self.state = state
            self.history = history
            replacement = reply["text"] as? String
        }
    }

    private enum Reconnection: Sendable {
        case hello(Hello)
        case file(ComposerConfiguration)
    }

    private func hello() async throws -> Hello {
        let transport = ComposerTransport(configuration)
        let sentGeneration = generation
        let reply = try await transport.request("/hello", ["pid": Int(getpid()), "draft": ["text": wireDraft]])
        try Task.checkCancellation()
        return try Hello(link: transport, generation: sentGeneration, reply: reply)
    }

    private func connect() async {
        var first = true
        var next = try? await hello()
        while !closing, !Task.isCancelled {
            var detached = false
            if let next {
                reportedVisibility = nil
                updateState(next.state, refreshRecovery: true)
                history = next.history
                if let replacement = next.replacement {
                    if ready { await deliver("replace", replacement) }
                    else { setDraft(replacement) }
                }
                guard !closing, !Task.isCancelled else { return }
                link = next.link
                connection = "connected"
                connectionNotice = nil
                await publishStatus()
                post("history", ["entries": history])
                reveal = true
                if first { wantsFocus = true }
                showWhenReady()
                placed()
                first = false
                if generation != next.generation { scheduleMirror() }
                detached = (try? await poll(next.link, after: next.sequence)) ?? false
            }
            guard !closing, !Task.isCancelled else { return }
            visibilityJob?.cancel(); visibilityJob = nil
            link = nil
            connection = "reconnecting"
            await publishStatus()
            next = await reconnect(fileOnly: detached)
        }
    }

    private func reconnect(fileOnly: Bool) async -> Hello? {
        let deadline = ContinuousClock.now + .seconds(60)
        let notice = Task {
            do { try await Task.sleep(until: deadline, clock: .continuous) } catch { return }
            let saved = retain()
            connectionNotice = saved ? "Pi does not answer. Your draft is saved." : "Pi does not answer. Draft recovery failed."
            await publishStatus()
        }
        defer { notice.cancel() }
        var needsFile = fileOnly
        while !Task.isCancelled, !closing {
            let retryCurrent = !needsFile
            let result = await withTaskGroup(of: Reconnection?.self) { group in
                group.addTask { await self.waitForReconnectFile() }
                if retryCurrent { group.addTask { await self.retryHello() } }
                let result = await group.next() ?? nil
                group.cancelAll()
                // A one-use file already consumed by the watcher takes precedence.
                for await pending in group {
                    if case .file = pending { return pending }
                }
                return result
            }
            switch result {
            case .hello(let reply): return reply
            case .file(let next):
                configuration = next
                if let reply = try? await hello() { return reply }
                needsFile = false
            case nil: return nil
            }
        }
        return nil
    }

    private func waitForReconnectFile() async -> Reconnection? {
        while !closing, !Task.isCancelled {
            if let next = try? ComposerConfiguration.consume(reconnectFile, expectedComposer: configuration.composer) {
                return .file(next)
            }
            do { try await Task.sleep(for: .milliseconds(150)) } catch { return nil }
        }
        return nil
    }

    private func retryHello() async -> Reconnection? {
        var delay = Duration.milliseconds(500)
        while !closing, !Task.isCancelled {
            do { try await Task.sleep(for: delay) } catch { return nil }
            if let reply = try? await hello() { return .hello(reply) }
            delay = min(delay * 2, .seconds(5))
        }
        return nil
    }

    private func poll(_ transport: ComposerTransport, after: Int) async throws -> Bool {
        var cursor = after
        while !closing, !Task.isCancelled {
            let result = try await transport.request("/events", ["after": cursor])
            guard !closing, !Task.isCancelled else { return false }
            guard let sequence = result["sequence"] as? Int, sequence >= cursor,
                  let next = result["state"] as? [String: Any], let events = result["events"] as? [[String: Any]] else {
                throw ComposerTransportError.invalidResponse
            }
            if state?["version"] as? Int != next["version"] as? Int {
                updateState(next)
                await publishStatus()
            }
            if result["reset"] as? Bool != true {
                for event in events {
                    guard let seq = event["seq"] as? Int, seq > cursor, seq <= sequence else { continue }
                    cursor = seq
                    switch event["type"] as? String {
                    case "setText":
                        if let text = event["text"] as? String { await deliver("replace", text) }
                    case "insert":
                        if let text = event["text"] as? String, !text.isEmpty { focus(); await deliver("insert", text) }
                    case "focus": focus()
                    case "history": history = event["entries"] as? [String] ?? history; post("history", ["entries": history])
                    case "notice": post("notice", ["text": event["text"] as? String ?? ""])
                    case "detach": return true
                    case "close": close(notifyPi: false); return false
                    default: continue
                    }
                }
            }
            cursor = sequence
        }
        return false
    }

    private var wireDraft: String { text.utf8.count <= 1024 * 1024 ? text : "" }

    private var sessionID: String? {
        guard let session = state?["session"] as? [String: Any],
              let id = session["id"] as? String, !id.isEmpty else { return nil }
        return id
    }

    private func updateState(_ next: [String: Any], refreshRecovery: Bool = false) {
        let previous = sessionID
        state = next
        let current = sessionID
        guard refreshRecovery || previous != current else { return }
        recoveryJob?.cancel()
        recovery = nil
        offerRecovery()
        guard let current else { return }
        recoveryJob = Task { [weak self, store] in
            let draft = await Task.detached { store.newestOrphan(in: current) }.value
            guard !Task.isCancelled, let self, !closing, sessionID == current else { return }
            recovery = draft
            offerRecovery()
        }
    }

    private func recordRetentionFailure(_ error: Error, notify: Bool = true) {
        let reason = "Cannot save drafts. \(error.localizedDescription)"
        if notify && retentionProblem != reason { post("notice", ["text": reason, "tone": "failure"]) }
        retentionProblem = reason
    }

    @discardableResult
    private func retain(notify: Bool = true) -> Bool {
        do { try store.save(text, sessionID: sessionID); retentionProblem = nil; return true }
        catch { recordRetentionFailure(error, notify: notify); return false }
    }

    private func setDraft(_ value: String) {
        guard text != value else { return }
        let emptinessChanged = text.isEmpty != value.isEmpty
        text = value
        generation += 1
        retain()
        if emptinessChanged { offerRecovery() }
        scheduleMirror()
    }

    private func scheduleMirror() {
        draftJob?.cancel()
        draftJob = Task {
            do { try await Task.sleep(for: .milliseconds(150)); await mirror() } catch { }
        }
    }

    private func mirror() async {
        guard !closing, !submitting, let link, wireDraft == text else { return }
        _ = try? await link.request("/draft", ["text": text, "generation": generation])
    }

    private func handle(_ type: String, _ fields: [String: Any]) async throws -> [String: Any] {
        guard !closing else { throw composerRefusal("The composer is closing.") }
        switch type {
        case "ready":
            let metrics = terminalMetrics ?? CGSize(width: 9, height: 16)
            lastMetrics = metrics
            ready = await page.send("init", ["text": text, "sendKey": preferences.sendKey,
                                             "textAdjust": preferences.textAdjust,
                                             "baseSize": metrics.height, "cellWidth": metrics.width])
            guard ready else { throw composerRefusal("The composer page did not initialise.") }
            await publishStatus()
            if let retentionProblem { await page.send("notice", ["text": retentionProblem, "tone": "failure"]) }
            await page.send("history", ["entries": history])
            while !buffered.isEmpty {
                let (kind, body) = buffered.removeFirst()
                await page.send(kind, body)
            }
            offerRecovery()
            showWhenReady()
            placed()
        case "overlay":
            guard let above = fields["above"] as? NSNumber, CFGetTypeID(above) != CFBooleanGetTypeID(),
                  above.doubleValue.isFinite, (0...8192).contains(above.doubleValue) else {
                throw composerRefusal("Invalid overlay height.")
            }
            overlay.extendAbove(above.doubleValue)
            lastOverlayAbove = overlay.appliedAbove
            if ready { await page.send("overlay", ["above": lastOverlayAbove]) }
        case "pasteText":
            return ["text": NSPasteboard.general.string(forType: .string) ?? ""]
        case "layout":
            guard let height = fields["height"] as? NSNumber, CFGetTypeID(height) != CFBooleanGetTypeID(), fit.layout(height.doubleValue) else {
                Self.fitLog.debug("decision=invalid-layout")
                throw composerRefusal("Invalid layout height.")
            }
            resizeToFit(reportedLayout: true)
        case "draft":
            guard let value = fields["text"] as? String else { throw composerRefusal("The draft is invalid.") }
            setDraft(value)
        case "flush":
            if !submitting, let value = fields["text"] as? String { setDraft(value) }
            draftJob?.cancel()
            await mirror()
        case "submit": return try await submit(fields)
        case "abort": return try await request("/abort")
        case "close":
            if let value = fields["text"] as? String { setDraft(value) }
            close()
        case "release": overlay.releaseFocus()
        case "sendKey":
            guard let value = fields["value"] as? String, value == "return" || value == "command" else {
                throw composerRefusal("The send key is invalid.")
            }
            preferences.sendKey = value
            try preferences.save(to: store.directory)
        case "textSize":
            guard let value = fields["value"] as? Int, (-4...8).contains(value) else {
                throw composerRefusal("The text size is invalid.")
            }
            preferences.textAdjust = value
            try preferences.save(to: store.directory)
        default: return try await assist(type, fields)
        }
        return [:]
    }

    private func syncVisibility() {
        guard !closing, let link, visibilityJob == nil,
              reportedVisibility != overlay.window.isVisible else { return }
        visibilityJob = Task { [weak self] in
            guard let self else { return }
            defer { if self.link === link { visibilityJob = nil } }
            while !Task.isCancelled, self.link === link, reportedVisibility != overlay.window.isVisible {
                let shown = overlay.window.isVisible
                if !shown { await mirror() }
                do { _ = try await link.request("/visibility", ["visible": shown]) }
                catch { return }
                reportedVisibility = shown
                resizeToFit()
            }
        }
    }

    private func resizeToFit(reportedLayout: Bool = false) {
        let rows = terminal.size().rows
        let awaited = fit.awaitsFrame
        let placement: TerminalAnchor.Placement?
        if case .placed(let pane) = overlay.anchor.status { placement = pane }
        else { placement = nil }
        if fitStartup != nil {
            guard fitStartup?.settled(placement?.frame, now: .now) == true else { return }
            fitStartup = nil
        }
        var frame = 0.0
        if let pane = placement {
            frame = pane.frame.height
            if let offset = fit.observe(.init(height: frame, windowHeight: Double(pane.windowFrame?.height ?? 0),
                                              splitHeight: Double(pane.verticalSplitFrame?.height ?? pane.contentFrame?.height ?? 0))) {
                do { try ComposerFit.saveOffset(offset, to: store.directory) }
                catch { Self.fitLog.debug("Could not save the calibrated offset.") }
            }
        } else {
            fit.expire()
        }
        let pending = fit.pending ?? 0
        let share = fit.share
        let request = ready && !closing && overlay.window.isVisible && reportedVisibility == true && resizeJob == nil && link != nil
            ? fit.request() : nil
        if reportedLayout || request != nil || (awaited && !fit.awaitsFrame) {
            Self.fitLog.debug("needed=\(self.fit.needed ?? 0) frame=\(frame) rows=\(rows) share=\(share) slope=\(self.fit.slope ?? 0) offset=\(self.fit.offset) goal=\(self.fit.goal ?? 0) request=\(request ?? 0) manual=\(self.fit.manual) pending=\(pending) floor=\(self.fit.floor ?? 0) attempts=\(self.fit.attempts)")
        }
        guard let request, let link else { return }
        resizeJob = Task { [weak self] in
            guard let self else { return }
            let reply = try? await link.request("/resize", ["share": request])
            let applied = reply?["applied"] as? Bool == true
            fit.finish(applied: applied)
            Self.fitLog.debug("reply applied=\(applied) share=\(request) received=\(reply != nil)")
            resizeJob = nil
            resizeToFit()
        }
    }

    private func offerRecovery() {
        let draft = text.isEmpty ? recovery : nil
        let label = draft?.updated.formatted(date: .omitted, time: .shortened) ?? ""
        post("recovery", ["label": label])
    }

    private func assist(_ type: String, _ fields: [String: Any]) async throws -> [String: Any] {
        switch type {
        case "complete", "applyCompletion":
            guard let text = fields["text"] as? String, text.utf8.count <= 1024 * 1024,
                  let cursor = fields["cursor"] as? Int, (0...text.utf16.count).contains(cursor) else {
                throw composerRefusal("Invalid completion range.")
            }
            var body: [String: Any] = ["text": text, "cursor": cursor]
            if type == "complete" { body["force"] = fields["force"] as? Bool ?? false }
            else {
                guard let item = fields["item"] as? [String: Any], let prefix = fields["prefix"] as? String else {
                    throw composerRefusal("Invalid completion item.")
                }
                body["item"] = item; body["prefix"] = prefix
            }
            return try await request("/" + type, body)
        case "models", "dequeue": return try await request("/" + type)
        case "setModel":
            guard let provider = fields["provider"] as? String, let id = fields["id"] as? String else {
                throw composerRefusal("Invalid model.")
            }
            return try await request("/setModel", ["provider": provider, "id": id])
        case "setThinking":
            guard let level = fields["level"] as? String else { throw composerRefusal("Invalid thinking level.") }
            return try await request("/setThinking", ["level": level])
        case "restore":
            guard text.isEmpty else { throw composerRefusal("Clear your draft before you restore another one.") }
            guard let draft = recovery, draft.sessionID == sessionID else { throw composerRefusal("No draft is available for this Pi session.") }
            return ["text": draft.text]
        case "pick": return ["paths": try await files.pick()]
        case "pasteFiles": return ["paths": try files.paste()]
        case "image":
            guard let source = fields["data"] as? String, source.utf8.count <= 28 * 1024 * 1024,
                  let data = Data(base64Encoded: source) else { throw composerRefusal("The image exceeds 20 MiB or is not valid.") }
            return ["paths": [try files.save(data)]]
        case "thumbnail":
            guard let path = fields["path"] as? String, path.utf8.count <= 4096, text.contains(path) else { return [:] }
            if let url = await files.thumbnail(path) { return ["url": url] }
            return [:]
        default: throw composerRefusal("Unknown composer message.")
        }
    }

    private func request(_ path: String, _ fields: [String: Any] = [:]) async throws -> [String: Any] {
        guard let link else { throw composerRefusal("Pi is not connected.") }
        do { return try await link.request(path, fields) }
        catch ComposerTransportError.refused(let message) { throw composerRefusal(message) }
        catch { throw composerRefusal("Pi did not confirm the request. Check the terminal before you try again.") }
    }

    private func submit(_ fields: [String: Any]) async throws -> [String: Any] {
        guard !submitting, let value = fields["text"] as? String,
              let behavior = fields["behavior"] as? String, behavior == "send" || behavior == "followUp" else {
            throw composerRefusal("The message is invalid or already has a send in progress.")
        }
        setDraft(value)
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.utf8.count <= 1024 * 1024 else {
            throw composerRefusal("A message must contain text and fit in 1 MiB.")
        }
        guard retain(notify: false) else { throw composerRefusal("Not sent. " + (retentionProblem ?? "The draft could not be saved.")) }
        draftJob?.cancel()
        submitting = true
        defer { submitting = false }
        let result = try await request("/submit", ["id": UUID().uuidString.lowercased(), "text": value, "behavior": behavior])
        switch result["outcome"] as? String {
        case "accepted": if text == value { setDraft("") }
        case "refused": scheduleMirror()
        default: throw composerRefusal("Pi did not confirm the send. Check the terminal before you try again.")
        }
        return result
    }

    private func piEnded() {
        guard !closing else { return }
        retain()
        connection = "ended"
        connectionNotice = nil
        link = nil
        connectionJob?.cancel()
        Task {
            await publishStatus()
            try? await Task.sleep(for: .seconds(2))
            close(notifyPi: false)
        }
    }

    func close(notifyPi: Bool = true, terminalGone gone: Bool = false) {
        terminalGone = terminalGone || gone
        guard !closing else { return }
        let saved = retain()
        guard saved || terminalGone || !notifyPi else { return }
        closing = true
        connectionJob?.cancel(); peerMonitor?.cancel(); draftJob?.cancel(); visibilityJob?.cancel(); resizeJob?.cancel(); recoveryJob?.cancel()
        overlay.stop()
        let link = self.link
        let draft = wireDraft
        Task {
            if notifyPi, let link {
                _ = await CloseDeadline.run(until: .now() + 0.5) {
                    _ = try? await link.request("/close", ["draft": ["text": draft]])
                }
            }
            if !terminalGone { terminal.leave(before: .now() + CloseDeadline.outputAllowance) }
            _exit(saved ? 0 : 1)
        }
    }

    static func menu() -> NSMenu {
        let menu = NSMenu()
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem(); menu.addItem(item)
            let sub = NSMenu(title: title); item.submenu = sub
            return sub
        }
        let app = submenu("Composer")
        app.addItem(withTitle: "Close Composer", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        app.addItem(withTitle: "Quit Composer", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = submenu("Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"),
                                     ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: NSSelectorFromString(action), keyEquivalent: key)
        }
        return menu
    }
}

func composerRefusal(_ message: String) -> NSError {
    NSError(domain: "Composer", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

struct ComposerTerminalInput {
    private var utf8: [UInt8] = []
    private var expected = 0
    private enum Escape { case none, first, sequence, osc, oscEscape }
    private var escape = Escape.none

    mutating func feed(_ bytes: ArraySlice<UInt8>) -> (text: String, close: Bool) {
        var text = ""
        for byte in bytes {
            switch escape {
            case .first:
                escape = byte == 0x5D ? .osc : (byte == 0x5B || byte == 0x4F ? .sequence : .none)
                continue
            case .sequence:
                if (0x40...0x7e).contains(byte) { escape = .none }
                continue
            case .osc, .oscEscape:
                escape = byte == 7 || (escape == .oscEscape && byte == 0x5C) ? .none : (byte == 0x1B ? .oscEscape : .osc)
                continue
            case .none: break
            }
            if expected > 0 {
                if (0x80...0xBF).contains(byte) {
                    utf8.append(byte)
                    expected -= 1
                    if expected == 0, let scalar = String(bytes: utf8, encoding: .utf8) { text += scalar }
                    continue
                }
                expected = 0
            }
            switch byte {
            case 4: return (text, true)
            case 0x1B: escape = .first
            case 0x20...0x7e: text.unicodeScalars.append(UnicodeScalar(byte))
            case 0xC2...0xF4:
                utf8 = [byte]
                expected = byte < 0xE0 ? 1 : byte < 0xF0 ? 2 : 3
            default: break
            }
        }
        return (text, false)
    }
}
