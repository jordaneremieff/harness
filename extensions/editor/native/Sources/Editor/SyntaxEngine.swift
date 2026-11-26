import AppKit

@MainActor
final class SyntaxEngine: NSObject {
    private weak var storage: NSTextStorage?
    private var path: String
    private var pathLanguage: SyntaxLanguage
    private var profile: SyntaxLexicon
    private var checkpoints = SyntaxCheckpoints()
    private var symbolCache: [CodeSymbol]?
    private var tokenCache: (range: NSRange, tokens: [SyntaxToken])?
    private var recentLines: [LineKey: LexedLine] = [:]
    private var languageOverride: SyntaxLanguage?
    private var warmScheduled = false
    private var repaintThrough: Int?
    var onViewportSyntax: (() -> Void)?
    private(set) var revision: UInt64 = 0
    private(set) var visitedLineCount = 0

    var language: SyntaxLanguage { profile.language }

    init(path: String = "", storage: NSTextStorage? = nil) {
        self.path = path
        pathLanguage = .detect(path: path)
        profile = .profile(pathLanguage.id)
        super.init()
        if let storage { attach(to: storage) }
    }

    func setFile(_ path: String) {
        guard self.path != path else { return }
        self.path = path
        pathLanguage = .detect(path: path)
        reset(language: detectedLanguage())
    }

    func chooseLanguage(_ id: String?) {
        if let id {
            guard let explicit = SyntaxLanguage.named(id) else { return }
            languageOverride = explicit
        } else { languageOverride = nil }
        let language = detectedLanguage()
        if language.id != self.language.id { reset(language: language) }
    }

    func attach(to storage: NSTextStorage) {
        guard self.storage !== storage else { return }
        if let previous = self.storage {
            NotificationCenter.default.removeObserver(self, name: NSTextStorage.didProcessEditingNotification, object: previous)
        }
        self.storage = storage
        reset(language: detectedLanguage())
        NotificationCenter.default.addObserver(self, selector: #selector(didEdit(_:)),
                                               name: NSTextStorage.didProcessEditingNotification, object: storage)
    }

    func viewTokens(in range: NSRange) -> [SyntaxToken]? {
        if range.location - checkpoints.end.offset > 4_096 {
            repaintThrough = max(repaintThrough ?? 0, range.location)
            scheduleWarmup()
            return nil
        }
        return tokens(in: range)
    }

    func roleForView(at offset: Int) -> SyntaxRole {
        guard offset - checkpoints.end.offset <= 4_096 else { return .plain }
        return role(at: offset)
    }

    func role(at offset: Int) -> SyntaxRole {
        guard language.id != "plain", let source = storage?.mutableString, offset >= 0, offset < source.length else { return .plain }
        let tokens: [SyntaxToken]
        if let tokenCache, NSLocationInRange(offset, tokenCache.range) {
            tokens = tokenCache.tokens
        } else {
            let line = source.lineRange(for: NSRange(location: offset, length: 0))
            tokens = self.tokens(in: line)
        }
        var low = 0
        var high = tokens.count
        while low < high {
            let mid = (low + high) / 2
            if NSMaxRange(tokens[mid].range) <= offset { low = mid + 1 } else { high = mid }
        }
        return low < tokens.count && NSLocationInRange(offset, tokens[low].range) ? tokens[low].role : .plain
    }

    func symbols() -> [CodeSymbol] {
        if let symbolCache { return symbolCache }
        guard language.id != "plain", let source = storage?.mutableString else { return [] }
        var collector = SyntaxSymbolCollector()
        var state = SyntaxState()
        var offset = 0
        var number = 1
        while offset < source.length {
            let line = Self.line(from: offset, in: source)
            let (next, tokens) = scan(line, at: offset, in: source, initial: state, emit: true)
            collector.consume(line.text, tokens: tokens, offset: offset, number: number, language: language)
            checkpoints.record(line.end, next)
            state = next
            offset = line.end
            number += 1
        }
        symbolCache = collector.symbols
        return collector.symbols
    }

    func tokens(in range: NSRange) -> [SyntaxToken] {
        guard language.id != "plain", let source = storage?.mutableString,
              range.location >= 0, range.location < source.length, range.length > 0 else { return [] }
        let end = range.location + min(range.length, source.length - range.location)
        let query = NSRange(location: range.location, length: end - range.location)
        if let tokenCache, tokenCache.range == query { return tokenCache.tokens }
        extend(to: range.location, in: source)
        let mark = checkpoints.atOrBefore(range.location)
        var offset = mark.offset
        var state = mark.state
        var result: [SyntaxToken] = []
        while offset < end {
            let line = Self.line(from: offset, in: source)
            let (next, tokens) = scan(line, at: offset, in: source, initial: state, emit: true)
            for token in tokens where token.role != .plain && token.range.location < end && NSMaxRange(token.range) > range.location {
                result.append(token)
            }
            checkpoints.record(line.end, next)
            offset = line.end
            state = next
        }
        tokenCache = (query, result)
        return result
    }

    private func scheduleWarmup() {
        guard !warmScheduled, language.id != "plain", let source = storage?.mutableString,
              checkpoints.end.offset < source.length else { return }
        warmScheduled = true
        DispatchQueue.main.async { [weak self] in self?.warmStep() }
    }

    private func warmStep() {
        warmScheduled = false
        guard language.id != "plain", let source = storage?.mutableString else { return }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .milliseconds(2))
        var remaining = 192
        while checkpoints.end.offset < source.length, remaining > 0, clock.now < deadline {
            let mark = checkpoints.end
            let line = Self.line(from: mark.offset, in: source)
            guard line.end > mark.offset else { break }
            checkpoints.record(line.end, scan(line, at: mark.offset, in: source, initial: mark.state, emit: false).0)
            remaining -= 1
        }
        if let repaintThrough, checkpoints.end.offset >= repaintThrough {
            self.repaintThrough = nil
            onViewportSyntax?()
        }
        if remaining < 192 { scheduleWarmup() }
    }

    private func extend(to offset: Int, in source: NSString) {
        while checkpoints.end.offset < offset {
            let mark = checkpoints.end
            let line = Self.line(from: mark.offset, in: source)
            let state = scan(line, at: mark.offset, in: source, initial: mark.state, emit: false).0
            checkpoints.record(line.end, state)
        }
    }

    private func scan(_ line: Line, at offset: Int, in source: NSString, initial: SyntaxState, emit: Bool) -> (SyntaxState, [SyntaxToken]) {
        visitedLineCount += 1
        let markdown = profile.language.id == "markdown"
        let next = emit && markdown && initial.markdown == .text && line.end < source.length ? Self.line(from: line.end, in: source).text : nil
        // Unchanged viewport lines keep their tokens when an edit shifts their offsets.
        let key = emit && line.text.utf16.count <= 2_048 && (next?.utf16.count ?? 0) <= 2_048
            ? LineKey(text: line.text, next: next, first: offset == 0) : nil
        if let key, let cached = recentLines[key], cached.initial == initial {
            let shift = offset - cached.offset
            if shift == 0 { return (cached.end, cached.tokens) }
            let tokens = cached.tokens.map { token in
                SyntaxToken(range: NSRange(location: token.range.location + shift, length: token.range.length), role: token.role)
            }
            return (cached.end, tokens)
        }
        let result: (SyntaxState, [SyntaxToken])
        if markdown {
            result = SyntaxMarkdown.scan(line.text, offset: offset, nextLine: next, state: initial, emit: emit)
        } else if !emit && initial.frames.isEmpty && profile.flags.contains(.swift) && SyntaxLexer.swiftStateUnchanged(line.text) {
            result = (initial, [])
        } else {
            var lexer = SyntaxLexer(line.text, offset: offset, profile: profile, state: initial, emit: emit)
            result = lexer.run()
        }
        if let key {
            if recentLines.count >= 128 { recentLines.removeAll(keepingCapacity: true) }
            recentLines[key] = LexedLine(initial: initial, end: result.0, offset: offset, tokens: result.1)
        }
        return result
    }

    private struct LineKey: Hashable {
        let text: String
        let next: String?
        let first: Bool

        static func == (left: Self, right: Self) -> Bool {
            left.first == right.first && left.text.utf16.elementsEqual(right.text.utf16) &&
                ((left.next == nil && right.next == nil) ||
                 (left.next != nil && right.next != nil && left.next!.utf16.elementsEqual(right.next!.utf16)))
        }
    }

    private struct LexedLine {
        let initial: SyntaxState
        let end: SyntaxState
        let offset: Int
        let tokens: [SyntaxToken]
    }

    private struct Line {
        let text: String
        let end: Int
    }

    private static func line(from offset: Int, in source: NSString) -> Line {
        var end = offset
        var bodyEnd = offset
        source.getLineStart(nil, end: &end, contentsEnd: &bodyEnd, for: NSRange(location: offset, length: 0))
        return Line(text: source.substring(with: NSRange(location: offset, length: bodyEnd - offset)), end: end)
    }

    private func reset(language: SyntaxLanguage) {
        profile = .profile(language.id)
        checkpoints = SyntaxCheckpoints()
        symbolCache = nil
        tokenCache = nil
        recentLines.removeAll()
        revision &+= 1
        repaintThrough = nil
        scheduleWarmup()
    }

    private func detectedLanguage() -> SyntaxLanguage {
        if let languageOverride { return languageOverride }
        guard pathLanguage.id == "plain", let source = storage?.mutableString, source.length >= 2,
              source.character(at: 0) == 35, source.character(at: 1) == 33 else { return pathLanguage }
        // A shebang interpreter must precede any arguments; a long first line
        // need not be copied just to identify the language.
        let head = source.substring(to: min(512, source.length))
        let first = head.prefix { !$0.isNewline }
        return SyntaxLanguage.detect(path: path, shebang: String(first))
    }

    @objc private func didEdit(_ notification: Notification) {
        guard let storage, notification.object as? NSTextStorage === storage,
              storage.editedMask.contains(.editedCharacters) else { return }
        let range = storage.editedRange
        guard range.location != NSNotFound else { return }
        let source = storage.mutableString
        var restart = 0
        if source.length > 0 {
            source.getLineStart(&restart, end: nil, contentsEnd: nil,
                                for: NSRange(location: min(range.location, source.length), length: 0))
        }
        if restart == 0 && pathLanguage.id == "plain" {
            let detected = detectedLanguage()
            if detected.id != language.id { reset(language: detected); return }
        }
        checkpoints.edit(restart: restart, oldEnd: NSMaxRange(range) - storage.changeInLength, delta: storage.changeInLength)
        symbolCache = nil
        tokenCache = nil
        revision &+= 1
        scheduleWarmup()
    }
}
