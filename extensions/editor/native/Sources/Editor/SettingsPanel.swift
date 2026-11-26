import AppKit

extension WorkspaceScreen {
    func showSettingsPanel() {
        let panel = SettingsPanel(store: preferences, appearance: appearance, currentLanguage: currentEditor?.languageID)
        panel.onClose = { [weak self, weak panel] in
            guard let self, let panel else { return }
            chrome.dismissOverlay(panel)
            if chrome.window?.isKeyWindow == true { currentEditor?.focus() }
        }
        chrome.presentOverlay(panel, placement: .top) { pane in
            NSSize(width: min(846, max(0, pane.width - 24)), height: 668)
        }
        panel.takeFocus()
    }
}

@MainActor
final class SettingsPanel: QuickSurface {
    private enum Page { case settings, reset }

    private let store: SettingsStore
    private let paneAppearance: PaneAppearance
    private let palette = CatppuccinPalette.bundled()
    private let currentLanguage: String?
    private var page = Page.settings
    private var language: String?
    private var scopes: [String?] = []
    private var shownProblems: [String] = []
    private var keyMonitor: Any?
    private var rows: [SettingsRow] = []
    private var toneLabels: [(NSTextField, SettingsText)] = []
    private var form: [(view: NSView, height: CGFloat)] = []
    private var appearanceRow: SettingsAppearanceRow?
    private var settingsScrollY: CGFloat = 0
    private var shownNotice = ""

    private let heading = QuickSurface.label("")
    private let subtitle = QuickSurface.label("")
    private let status = QuickSurface.label("")
    private let path = QuickSurface.label("")
    private let scope = NSPopUpButton()
    private let scopeHelp = QuickSurface.label("")
    private let closeButton = NSButton()
    private let copyButton = NSButton(title: "Copy Path", target: nil, action: nil)
    private let revealButton = NSButton(title: "Reveal", target: nil, action: nil)
    private let primaryButton = NSButton()
    private let secondaryButton = NSButton()
    private let topRule = NSView()
    private let bottomRule = NSView()
    private let scroll = NSScrollView()
    private let canvas = SettingsCanvas()
    var onClose: (() -> Void)?

    init(store: SettingsStore, appearance: PaneAppearance, currentLanguage: String? = nil) {
        self.store = store
        paneAppearance = appearance
        self.currentLanguage = currentLanguage
        super.init(frame: .zero)
        setAccessibilityLabel("Editor Settings")
        scope.target = self
        scope.action = #selector(changeScope)
        scope.setAccessibilityLabel("Settings scope")
        closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close Settings")
        closeButton.setAccessibilityLabel("Close Settings")
        closeButton.isBordered = false
        closeButton.target = self
        closeButton.action = #selector(close)
        copyButton.target = self
        copyButton.action = #selector(copyPath)
        revealButton.target = self
        revealButton.action = #selector(revealPath)
        primaryButton.target = self
        primaryButton.action = #selector(primaryAction)
        secondaryButton.target = self
        secondaryButton.action = #selector(secondaryAction)
        topRule.wantsLayer = true
        bottomRule.wantsLayer = true
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = canvas
        [heading, subtitle, closeButton, scope, scopeHelp, topRule, scroll, bottomRule, status, path,
         copyButton, revealButton, primaryButton, secondaryButton].forEach(addSubview)
        path.lineBreakMode = .byTruncatingMiddle
        path.stringValue = store.file?.path ?? "Settings stay in memory"
        path.toolTip = store.file?.path
        copyButton.isEnabled = store.file != nil
        revealButton.isEnabled = store.file != nil
        showPage(.settings)
        onDetach = { [weak self] in self?.stopInput() }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func takeFocus() {
        guard let window, window.isKeyWindow else { return }
        window.recalculateKeyViewLoop()
        window.makeFirstResponder(scope)
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, let window = self.window, event.window === window, event.keyCode == 53,
                  (window.firstResponder as? NSTextView)?.hasMarkedText() != true else { return event }
            escape()
            return nil
        }
    }

    private func stopInput() {
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
    }

    private var isSettings: Bool { if case .settings = page { true } else { false } }
    private var scopeName: String { language.map { SyntaxLanguage.named($0)?.displayName ?? $0 } ?? "All languages" }

    private func updateScopes() {
        var ids = Set(store.languages.keys)
        ids.formUnion(SyntaxLanguage.languages.map(\.id).filter { $0 != "plain" })
        if let currentLanguage { ids.insert(currentLanguage) }
        if let language { ids.insert(language) }
        let labels = ids.map { id -> (id: String, title: String) in
            if let match = SyntaxLanguage.named(id), match.id == id { return (id, match.displayName) }
            return (id, "\(id) (settings file)")
        }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        let scopes: [String?] = [nil] + labels.map { Optional($0.id) }
        if self.scopes != scopes {
            self.scopes = scopes
            scope.removeAllItems()
            scope.addItem(withTitle: "All languages")
            scope.addItems(withTitles: labels.map { $0.title })
        }
        scope.selectItem(at: scopes.firstIndex(of: language) ?? 0)
        scopeHelp.stringValue = language == nil ? "Defaults for every file" : "Overrides for \(scopeName) files only"
    }

    @objc private func changeScope() {
        guard scopes.indices.contains(scope.indexOfSelectedItem) else { return }
        language = scopes[scope.indexOfSelectedItem]
        shownNotice = ""
        updateScopes()
        buildForm(at: 0)
    }

    @objc private func close() { onClose?() }

    @objc private func copyPath() {
        guard let url = store.file else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        notice(pasteboard.setString(url.path, forType: .string) ? "Settings path copied." : "Could not copy the settings path.")
    }

    @objc private func revealPath() {
        guard let url = store.file else { return }
        var candidate = url
        while !FileManager.default.fileExists(atPath: candidate.path), candidate.path != "/" {
            candidate.deleteLastPathComponent()
        }
        NSWorkspace.shared.activateFileViewerSelecting([candidate])
    }

    private func notice(_ text: String) {
        shownNotice = text
        refreshStatus()
    }

    private func refreshStatus() {
        if !shownNotice.isEmpty {
            status.stringValue = shownNotice
        } else if case .settings = page {
            if !store.problems.isEmpty { status.stringValue = "\(store.problems.count) settings file \(store.problems.count == 1 ? "problem" : "problems")." }
            else { status.stringValue = "Changes apply immediately." }
        } else {
            status.stringValue = ""
        }
        status.toolTip = status.stringValue
    }

    @objc private func primaryAction() {
        switch page {
        case .settings: break
        case .reset:
            let settings = if let language { store.languages[language] } else { store.base }
            store.set(settings?.values.keys.map { ($0, Optional<SettingValue>.none, language) } ?? [])
            showPage(.settings)
            notice(store.problems.first ?? "Reset \(scopeName.lowercased()) settings.")
        }
    }

    @objc private func secondaryAction() {
        if isSettings {
            settingsScrollY = scroll.contentView.bounds.minY
            showPage(.reset)
        } else {
            returnToSettings()
        }
    }

    private func escape() {
        if isSettings { close() } else { returnToSettings() }
    }

    private func returnToSettings() {
        showPage(.settings)
    }

    private func showPage(_ page: Page) {
        self.page = page
        shownNotice = ""
        switch page {
        case .settings:
            heading.stringValue = "Editor Settings"
            subtitle.stringValue = "Appearance, type and editing behaviour"
            secondaryButton.title = "Reset…"
            primaryButton.isHidden = true
            updateScopes()
        case .reset:
            heading.stringValue = "Reset Settings"
            subtitle.stringValue = scopeName
            primaryButton.title = "Reset Settings"
            primaryButton.isHidden = false
            primaryButton.isEnabled = true
            secondaryButton.title = "Cancel"
        }
        scope.isHidden = !isSettings
        scopeHelp.isHidden = !isSettings
        buildForm(at: isSettings ? settingsScrollY : 0)
    }

    private func buildForm(at offset: CGFloat) {
        canvas.subviews.forEach { $0.removeFromSuperview() }
        rows = []
        toneLabels = []
        form = []
        appearanceRow = nil
        shownProblems = store.problems
        func append(_ view: NSView, height: CGFloat) {
            form.append((view, height))
            canvas.addSubview(view)
        }
        func text(_ value: String, tone: SettingsText, height: CGFloat) {
            let label = QuickSurface.label(value)
            label.toolTip = value
            tone.paint(label)
            toneLabels.append((label, tone))
            append(label, height: height)
        }
        func messages(_ lines: [String], tone: SettingsText) {
            for line in lines.prefix(80) { text(line, tone: tone, height: 27) }
            if lines.count > 80 { text("\(lines.count - 80) more messages in this group.", tone: .detail, height: 27) }
        }
        switch page {
        case .settings:
            if !store.problems.isEmpty {
                text("Settings file problems", tone: .section, height: 36)
                messages(store.problems, tone: .warning)
            }
            if language == nil {
                text("Appearance", tone: .section, height: 36)
                let row = SettingsAppearanceRow(appearance: paneAppearance, palette: palette)
                append(row, height: 127)
                appearanceRow = row
            }
            var group = ""
            for spec in EditorSettings.specs where language == nil || spec.perLanguage {
                if group != spec.group {
                    group = spec.group
                    text(group, tone: .section, height: 37)
                }
                let selectedLanguage = language
                let row = SettingsRow(spec: spec, scoped: selectedLanguage != nil)
                row.commit = { [weak self] value in self?.change(spec, value, language: selectedLanguage) }
                row.rejected = { [weak self] in self?.notice("\(spec.title): enter \(spec.expectation).") }
                rows.append(row)
                append(row, height: 67)
            }
        case .reset:
            text(language == nil ? "Return the base Editor settings to their factory defaults?" : "Remove all overrides for \(scopeName)?",
                 tone: .section, height: 37)
            text(language == nil ? "Language overrides and shared appearance stay as they are." : "Files of this language will inherit the base Editor settings.",
                 tone: .normal, height: 35)
        }
        syncControls()
        needsLayout = true
        layoutSubtreeIfNeeded()
        let maxY = max(0, canvas.frame.height - scroll.contentView.bounds.height)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: min(offset, maxY)))
        scroll.reflectScrolledClipView(scroll.contentView)
        window?.recalculateKeyViewLoop()
    }

    private func change(_ spec: SettingSpec, _ value: SettingValue?, language: String?) {
        shownNotice = ""
        store.set(spec.key, value, language: language)
        syncControls()
    }

    private func syncControls() {
        let effective = store.settings(language: language)
        let overrides = language.flatMap { store.languages[$0]?.values } ?? [:]
        for row in rows { row.sync(effective.value(row.spec.key), overridden: overrides[row.spec.key] != nil) }
        appearanceRow?.applyStyle()
        refreshStatus()
        if isSettings {
            secondaryButton.isEnabled = language.map { store.languages[$0] != nil } ?? !store.base.values.isEmpty
        } else {
            secondaryButton.isEnabled = true
        }
    }

    override func applyPanelStyle() {
        super.applyPanelStyle()
        let theme = WorkspaceStyle.theme
        SettingsText.section.paint(heading, delta: 7)
        SettingsText.detail.paint(subtitle)
        SettingsText.detail.paint(scopeHelp)
        SettingsText.detail.paint(path)
        SettingsText.detail.paint(status)
        closeButton.contentTintColor = theme.secondaryText
        topRule.layer?.backgroundColor = theme.panelBorder.cgColor
        bottomRule.layer?.backgroundColor = theme.panelBorder.cgColor
        for button in [copyButton, revealButton, primaryButton, secondaryButton] {
            button.font = WorkspaceStyle.interfaceFont(-1, weight: .medium)
        }
        scope.font = WorkspaceStyle.interfaceFont(-1, weight: .medium)
        if isSettings {
            updateScopes()
            if shownProblems != store.problems { buildForm(at: scroll.contentView.bounds.minY) }
        }
        for (label, tone) in toneLabels { tone.paint(label) }
        syncControls()
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let h = bounds.height, w = bounds.width
        let edge: CGFloat = 23
        let width = max(0, w - 2 * edge)
        let top: CGFloat = isSettings ? 112 : 78
        let bottom: CGFloat = max(top, h - 89)
        heading.frame = NSRect(x: edge, y: 12, width: max(0, width - 42), height: 31)
        subtitle.frame = NSRect(x: edge, y: 47, width: width, height: 23)
        closeButton.frame = NSRect(x: w - edge - 28, y: 15, width: 28, height: 28)
        scope.frame = NSRect(x: edge - 3, y: 78, width: 219, height: 27)
        scopeHelp.frame = NSRect(x: edge + 227, y: 78, width: max(0, width - 227), height: 25)
        topRule.frame = NSRect(x: edge, y: top, width: width, height: 1)
        scroll.frame = NSRect(x: edge, y: top + 1, width: max(0, w - edge - 6), height: max(0, bottom - top - 1))
        let formWidth = max(0, min(width, scroll.contentSize.width - 7))
        var y: CGFloat = 4
        for entry in form {
            entry.view.frame = NSRect(x: 0, y: y, width: formWidth, height: entry.height)
            y += entry.height
        }
        canvas.frame.size = NSSize(width: formWidth, height: max(y + 10, scroll.contentSize.height))
        bottomRule.frame = NSRect(x: edge, y: bottom, width: width, height: 1)
        status.frame = NSRect(x: edge, y: bottom + 10, width: max(0, width - 328), height: 27)
        secondaryButton.frame = NSRect(x: w - edge - (primaryButton.isHidden ? 108 : 310), y: bottom + 9, width: 108, height: 29)
        primaryButton.frame = NSRect(x: w - edge - 196, y: bottom + 9, width: 196, height: 29)
        path.frame = NSRect(x: edge, y: bottom + 46, width: max(0, width - 200), height: 27)
        copyButton.frame = NSRect(x: w - edge - 186, y: bottom + 45, width: 102, height: 28)
        revealButton.frame = NSRect(x: w - edge - 77, y: bottom + 45, width: 77, height: 28)
    }
}

@MainActor
private final class SettingsCanvas: NSView {
    override var isFlipped: Bool { true }
}

@MainActor
private enum SettingsText {
    case section, normal, detail, warning

    func paint(_ label: NSTextField, delta: CGFloat? = nil) {
        let theme = WorkspaceStyle.theme
        switch self {
        case .section:
            label.font = WorkspaceStyle.interfaceFont(delta ?? 2, weight: .semibold)
            label.textColor = theme.text
        case .normal:
            label.font = WorkspaceStyle.interfaceFont(delta ?? 0, weight: .medium)
            label.textColor = theme.text
        case .detail:
            label.font = WorkspaceStyle.interfaceFont(delta ?? -1)
            label.textColor = theme.secondaryText
        case .warning:
            label.font = WorkspaceStyle.interfaceFont(delta ?? -1)
            label.textColor = theme.warning
        }
    }
}

@MainActor
private final class SettingsRow: NSView, NSTextFieldDelegate {
    override var isFlipped: Bool { true }
    let spec: SettingSpec
    var commit: ((SettingValue?) -> Void)?
    var rejected: (() -> Void)?
    private let title: NSTextField
    private let detail: NSTextField
    private let control: NSControl
    private let stepper: NSStepper?
    private let unit: NSTextField?
    private let inherit: NSButton?
    private var current: SettingValue
    private var fonts: [String] = []

    init(spec: SettingSpec, scoped: Bool) {
        self.spec = spec
        current = spec.initial
        title = QuickSurface.label(spec.title)
        detail = NSTextField(wrappingLabelWithString: spec.detail)
        detail.maximumNumberOfLines = 2
        detail.toolTip = spec.detail
        if scoped {
            inherit = NSButton(title: "Use base", target: nil, action: nil)
        } else { inherit = nil }
        switch spec.kind {
        case .toggle:
            control = NSButton(checkboxWithTitle: "", target: nil, action: nil)
            stepper = nil
            unit = nil
        case .choice(_, let names):
            let popup = NSPopUpButton()
            popup.addItems(withTitles: names)
            control = popup
            stepper = nil
            unit = nil
        case .font:
            control = NSPopUpButton()
            stepper = nil
            unit = nil
        case .number(let range, let step, let units):
            control = NSTextField()
            let stepper = NSStepper()
            stepper.minValue = range.lowerBound
            stepper.maxValue = range.upperBound
            stepper.increment = step
            stepper.valueWraps = false
            stepper.autorepeat = false
            self.stepper = stepper
            unit = units.isEmpty ? nil : QuickSurface.label(units)
        case .columns:
            control = NSTextField()
            stepper = nil
            unit = nil
        }
        super.init(frame: .zero)
        [title, detail, control].forEach(addSubview)
        control.setAccessibilityLabel(spec.title)
        control.toolTip = spec.detail
        control.target = self
        control.action = #selector(changed)
        if let field = control as? NSTextField {
            field.delegate = self
            field.isBezeled = true
            field.bezelStyle = .roundedBezel
            field.drawsBackground = true
            field.isEditable = true
            if case .columns = spec.kind { field.placeholderString = "e.g. 80, 120" }
            (field.cell as? NSTextFieldCell)?.sendsActionOnEndEditing = true
        }
        if let stepper {
            stepper.target = self
            stepper.action = #selector(step)
            stepper.setAccessibilityLabel("Adjust \(spec.title)")
            addSubview(stepper)
        }
        if let unit { addSubview(unit) }
        if let inherit {
            inherit.target = self
            inherit.action = #selector(removeOverride)
            inherit.setAccessibilityLabel("Use base value for \(spec.title)")
            addSubview(inherit)
        }
        if case .font = spec.kind { setupFonts() }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private static let familyNames = NSFontManager.shared.availableFontFamilies.sorted {
        $0.localizedStandardCompare($1) == .orderedAscending
    }

    private func setupFonts() {
        guard let popup = control as? NSPopUpButton else { return }
        fonts = [""] + Self.familyNames
        popup.removeAllItems()
        popup.addItem(withTitle: "System Monospaced")
        popup.lastItem?.attributedTitle = NSAttributedString(string: "System Monospaced", attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
        ])
        for name in Self.familyNames {
            popup.addItem(withTitle: name)
            if let font = NSFontManager.shared.font(withFamily: name, traits: [], weight: 5, size: 13) {
                popup.lastItem?.attributedTitle = NSAttributedString(string: name, attributes: [.font: font])
            }
        }
    }

    func sync(_ value: SettingValue, overridden: Bool) {
        current = value
        let theme = WorkspaceStyle.theme
        SettingsText.normal.paint(title)
        SettingsText.detail.paint(detail)
        if let unit { SettingsText.detail.paint(unit) }
        control.font = WorkspaceStyle.interfaceFont(-1)
        inherit?.font = WorkspaceStyle.interfaceFont(-2)
        inherit?.isEnabled = overridden
        detail.stringValue = inherit == nil || overridden ? spec.detail : "Inherits the base value. \(spec.detail)"
        switch (spec.kind, value) {
        case (.toggle, .flag(let enabled)):
            (control as? NSButton)?.state = enabled ? .on : .off
            (control as? NSButton)?.contentTintColor = theme.accent
        case (.choice(let values, _), .text(let text)):
            (control as? NSPopUpButton)?.selectItem(at: values.firstIndex(of: text) ?? 0)
        case (.font, .text(let text)):
            guard let popup = control as? NSPopUpButton else { return }
            if fonts.count > Self.familyNames.count + 1 {
                popup.removeItem(at: fonts.count - 1)
                fonts.removeLast()
            }
            if !fonts.contains(text) {
                fonts.append(text)
                popup.addItem(withTitle: "\(text) (not installed)")
            }
            popup.selectItem(at: fonts.firstIndex(of: text) ?? 0)
        case (.columns, .columns), (.number, .number):
            guard let field = control as? NSTextField else { return }
            field.textColor = theme.text
            field.backgroundColor = theme.editor
            if field.currentEditor() == nil { field.stringValue = spec.fieldText(value) }
            if case .number(let number) = value { stepper?.doubleValue = number }
        default: break
        }
    }

    @objc private func changed() {
        let value: SettingValue?
        switch spec.kind {
        case .toggle:
            value = (control as? NSButton).map { .flag($0.state == .on) }
        case .choice(let choices, _):
            let index = (control as? NSPopUpButton)?.indexOfSelectedItem ?? -1
            value = choices.indices.contains(index) ? .text(choices[index]) : nil
        case .font:
            let index = (control as? NSPopUpButton)?.indexOfSelectedItem ?? -1
            value = fonts.indices.contains(index) ? .text(fonts[index]) : nil
        case .number, .columns:
            guard let field = control as? NSTextField else { return }
            value = spec.fieldValue(field.stringValue)
            let canonical = spec.fieldText(value ?? current)
            if let editor = field.currentEditor(), editor.string != canonical { editor.string = canonical }
            field.stringValue = canonical
        }
        guard let value else { rejected?(); return }
        if value != current || inherit?.isEnabled == false { commit?(value) }
    }

    @objc private func step() {
        guard let stepper, let value = spec.accept(stepper.doubleValue) else { return }
        commit?(value)
        if let field = control as? NSTextField, let editor = field.currentEditor() { editor.string = spec.fieldText(value) }
    }

    @objc private func removeOverride() { commit?(nil) }

    func controlTextDidBeginEditing(_ notification: Notification) {
        let editor = (control as? NSTextField)?.currentEditor() as? NSTextView
        let theme = WorkspaceStyle.theme
        editor?.insertionPointColor = theme.caret
        editor?.selectedTextAttributes = [.foregroundColor: theme.text, .backgroundColor: theme.selection]
    }

    override func layout() {
        super.layout()
        let w = bounds.width
        let actionWidth: CGFloat = inherit == nil ? 0 : 91
        let fieldWidth: CGFloat = switch spec.kind {
        case .toggle: 22
        case .number(_, _, let unit): unit.isEmpty ? 99 : 127
        case .columns: 140
        case .choice: 148
        case .font: 224
        }
        let textWidth = max(0, w - actionWidth - fieldWidth - 28)
        title.frame = NSRect(x: 0, y: 6, width: textWidth, height: 24)
        detail.frame = NSRect(x: 0, y: 30, width: textWidth, height: 36)
        let fieldX = max(0, w - fieldWidth - actionWidth - 3)
        switch spec.kind {
        case .number:
            let stepX = fieldX + 70
            control.frame = NSRect(x: fieldX, y: 12, width: 65, height: 27)
            stepper?.frame = NSRect(x: stepX, y: 10, width: 19, height: 29)
            unit?.frame = NSRect(x: stepX + 23, y: 14, width: 33, height: 23)
        case .toggle:
            control.frame = NSRect(x: fieldX, y: 13, width: fieldWidth, height: 25)
        default:
            control.frame = NSRect(x: fieldX, y: 12, width: fieldWidth, height: 27)
        }
        inherit?.frame = NSRect(x: w - actionWidth + 2, y: 12, width: actionWidth - 3, height: 27)
    }
}

extension SettingSpec {
    /// Convert a numeric or column field without accepting incomplete tokens or fractional columns.
    func fieldValue(_ input: String) -> SettingValue? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        switch kind {
        case .columns:
            if text.isEmpty { return .columns([]) }
            let parts = text.split(separator: ",", omittingEmptySubsequences: false)
            let columns = parts.compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
            return columns.count == parts.count ? accept(columns) : nil
        case .number:
            return Double(text).flatMap(accept)
        default: return nil
        }
    }

    fileprivate func fieldText(_ value: SettingValue) -> String {
        switch value {
        case .number(let number): number.formatted(.number.grouping(.never).locale(Locale(identifier: "en_US_POSIX")))
        case .columns(let columns): columns.map(String.init).joined(separator: ", ")
        default: ""
        }
    }

    fileprivate func display(_ value: SettingValue) -> String {
        switch value {
        case .flag(let flag): flag ? "On" : "Off"
        case .text(let text):
            switch kind {
            case .choice(let values, let titles): values.firstIndex(of: text).map { titles[$0] } ?? text
            case .font: text.isEmpty ? "System Monospaced" : text
            default: text
            }
        case .number:
            if case .number(_, _, let unit) = kind, !unit.isEmpty { "\(fieldText(value)) \(unit)" } else { fieldText(value) }
        case .columns(let columns): columns.isEmpty ? "None" : fieldText(value)
        }
    }
}

@MainActor
private final class SettingsAppearanceRow: NSView {
    override var isFlipped: Bool { true }
    private let appearanceChoice: PaneAppearance
    private let mode = NSSegmentedControl(labels: ["System", "Light", "Dark"], trackingMode: .selectOne, target: nil, action: nil)
    private let help = QuickSurface.label("Dark appearance · shared with other panes")
    private let buttons: [NSButton]

    init(appearance: PaneAppearance, palette: CatppuccinPalette?) {
        appearanceChoice = appearance
        buttons = PaneAppearance.Flavour.allCases.map { flavour in
            let name = flavour == .frappe ? "Frappé" : flavour.rawValue.capitalized
            let sample = EditorTheme(palette: palette, flavour: flavour.rawValue)
            let button = NSButton(title: name, image: Self.swatch(sample), target: nil, action: nil)
            button.setButtonType(.pushOnPushOff)
            button.imagePosition = .imageLeft
            button.setAccessibilityLabel("Dark theme: \(name)")
            return button
        }
        super.init(frame: .zero)
        mode.target = self
        mode.action = #selector(chooseMode)
        mode.setAccessibilityLabel("Appearance mode")
        addSubview(mode)
        addSubview(help)
        for (index, button) in buttons.enumerated() {
            button.tag = index
            button.target = self
            button.action = #selector(chooseFlavour(_:))
            addSubview(button)
        }
        applyStyle()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func applyStyle() {
        mode.selectedSegment = PaneAppearance.Mode.allCases.firstIndex(of: appearanceChoice.mode) ?? 0
        mode.font = WorkspaceStyle.interfaceFont(-1, weight: .medium)
        SettingsText.detail.paint(help)
        for (index, button) in buttons.enumerated() {
            button.state = PaneAppearance.Flavour.allCases[index] == appearanceChoice.flavour ? .on : .off
            button.font = WorkspaceStyle.interfaceFont(-1, weight: .medium)
        }
    }

    @objc private func chooseMode() {
        guard PaneAppearance.Mode.allCases.indices.contains(mode.selectedSegment) else { return }
        appearanceChoice.choose(mode: PaneAppearance.Mode.allCases[mode.selectedSegment])
        applyStyle()
    }

    @objc private func chooseFlavour(_ sender: NSButton) {
        let flavour = PaneAppearance.Flavour.allCases[sender.tag]
        // Keep System when it already shows a dark theme; show the chosen preview immediately otherwise.
        appearanceChoice.choose(mode: appearanceChoice.shownFlavour == "latte" ? .dark : nil, flavour: flavour)
        applyStyle()
    }

    override func layout() {
        super.layout()
        mode.frame = NSRect(x: 0, y: 1, width: 235, height: 29)
        help.frame = NSRect(x: 0, y: 36, width: bounds.width, height: 24)
        for (i, button) in buttons.enumerated() { button.frame = NSRect(x: CGFloat(i) * 178, y: 66, width: 168, height: 46) }
    }

    private static func swatch(_ theme: EditorTheme) -> NSImage {
        let size = NSSize(width: 47, height: 26)
        let image = NSImage(size: size)
        image.lockFocus()
        theme.editor.setFill()
        NSBezierPath(roundedRect: NSRect(origin: .zero, size: size), xRadius: 4, yRadius: 4).fill()
        let colours = [theme.accent, theme.syntax("string") ?? theme.text, theme.syntax("keyword") ?? theme.secondaryText]
        for (i, colour) in colours.enumerated() {
            colour.setFill()
            NSBezierPath(roundedRect: NSRect(x: 6, y: 18 - CGFloat(i) * 6, width: 34 - CGFloat(i % 2) * 9, height: 2),
                         xRadius: 1, yRadius: 1).fill()
        }
        image.unlockFocus()
        return image
    }
}
