import AppKit
import MarkdownCore
import SwiftUI
import WebKit

/// Where the reader's controls sit.
public enum ReaderChrome {
    /// A titled window: the controls sit in the window toolbar.
    case window
    /// The editor owns the surrounding title, source mode and save controls.
    case preview
    /// A borderless window inside another application's layout: the controls sit in a compact
    /// header. `close` ends the reader; `release` gives the keyboard back to that application.
    case embedded(close: () -> Void, release: () -> Void)
}

/// The host supplies the permitted transition without exposing its editor state to the reader.
public struct ReaderEditActions {
    public let edit: (() -> Void)?
    public let editCopy: (() -> Void)?
    public let isEnabled: Bool

    public init(edit: (() -> Void)? = nil, editCopy: (() -> Void)? = nil, isEnabled: Bool = true) {
        self.edit = edit
        self.editCopy = editCopy
        self.isEnabled = isEnabled
    }
}

/// The reader for one document. It holds no global state and can be placed in any window.
public struct ReaderView: View {
    @Bindable var model: ReaderModel
    let chrome: ReaderChrome
    let editActions: ReaderEditActions?
    let selectionChanged: ((String?) -> Void)?
    let commentSelection: ((String) -> Void)?
    @FocusState private var findFocused: Bool
    @State private var width: CGFloat = 900
    @State private var dragStart: CGFloat?

    public init(model: ReaderModel, chrome: ReaderChrome = .window, editActions: ReaderEditActions? = nil,
                selectionChanged: ((String?) -> Void)? = nil, commentSelection: ((String) -> Void)? = nil) {
        self.model = model
        self.chrome = chrome
        self.editActions = editActions
        self.selectionChanged = selectionChanged
        self.commentSelection = commentSelection
    }

    private var outlineShown: Bool {
        model.outlineVisible && !model.outlineLayout.isCompact(in: width) && !(model.rendered?.outline.isEmpty ?? true)
    }

    public var body: some View {
        VStack(spacing: 0) {
            if case .embedded(let close, let release) = chrome {
                EmbeddedHeader(model: model, editActions: editActions, close: close, release: release)
            }
            banners
            if model.findVisible { findBar }
            HStack(spacing: 0) {
                if outlineShown {
                    OutlineList(model: model)
                        .frame(width: model.outlineLayout.outlineWidth(in: width))
                    outlineDivider
                }
                content.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }, action: {
            width = $0
            model.outlineCompact = model.outlineLayout.isCompact(in: $0)
            if !model.outlineCompact { model.outlinePopoverVisible = false }
        })
        .onChange(of: outlineShown) { _, _ in dragStart = nil }
        .overlay(alignment: .bottom) { noticeView }
        .confirmationDialog(
            "Open this address in your browser?",
            isPresented: Binding(get: { model.pendingExternalURL != nil }, set: { if !$0 { model.pendingExternalURL = nil } }),
            presenting: model.pendingExternalURL
        ) { _ in
            Button("Open in Browser") { model.confirmExternal() }
            Button("Cancel", role: .cancel) { model.pendingExternalURL = nil }
        } message: { url in
            Text(url.absoluteString)
        }
        .toolbar { if case .window = chrome { toolbarContent } }
        .onChange(of: model.findVisible) { _, visible in findFocused = visible }
    }

    private var outlineDivider: some View {
        Rectangle()
            .fill(.clear)
            .frame(width: OutlineLayout.dividerWidth)
            .overlay { Rectangle().fill(Color(nsColor: .separatorColor)).frame(width: 1) }
            .contentShape(Rectangle())
            .onHover { inside in (inside ? NSCursor.resizeLeftRight : NSCursor.arrow).set() }
            .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                .onChanged { value in
                    if dragStart == nil { dragStart = model.outlineLayout.outlineWidth(in: width) }
                    model.outlineLayout.resize(to: (dragStart ?? 0) + value.translation.width, in: width)
                }
                .onEnded { _ in dragStart = nil })
            .onTapGesture(count: 2) { model.outlineLayout.reset() }
            .help("Drag to resize contents. Double-click to reset.")
            .accessibilityElement()
            .accessibilityLabel("Contents width")
            .accessibilityValue("\(Int(model.outlineLayout.outlineWidth(in: width))) points")
            .accessibilityAdjustableAction { direction in
                let step: CGFloat = direction == .increment ? 40 : -40
                model.outlineLayout.resize(to: model.outlineLayout.outlineWidth(in: width) + step, in: width)
            }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading where model.snapshot == nil:
            ProgressView("Opening…").frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView {
                Label("The document could not be opened", systemImage: "doc.questionmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.refresh() } }
            }
        default:
            WebView(model.page)
                .webViewLinkPreviews(.disabled)
                .webViewBackForwardNavigationGestures(.disabled)
                .webViewElementFullscreenBehavior(.disabled)
                .webViewTextSelection(.enabled)
                .webViewContextMenu { info in contextMenu(info) }
                .webViewOnScrollGeometryChange(for: CGFloat.self, of: { $0.contentOffset.y }, action: { _, _ in model.scrolled() })
                .accessibilityLabel(model.showingSource ? "Markdown source" : "Document")
                .accessibilityHidden(model.review.shown != nil || model.inspection.isOpen)
                .overlay(alignment: .top) { RevisionReviewLayer(model: model) }
                .overlay { ImageInspectionLayer(model: model) }
                .background {
                    if selectionChanged != nil {
                        ReaderSelectionEvents {
                            Task { @MainActor in selectionChanged?(await model.annotationSelection()) }
                        }
                    }
                }
        }
    }

    @ViewBuilder private func contextMenu(_ info: WebView.ActivatedElementInfo) -> some View {
        if let commentSelection {
            Button("Comment on Selection…") {
                Task { @MainActor in
                    let quote = await model.annotationSelection()
                    selectionChanged?(quote)
                    if let quote, !quote.isEmpty { commentSelection(quote) }
                }
            }
            Divider()
        }
        if let url = info.linkURL, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            Button("Open Link in Browser…") { model.pendingExternalURL = url }
            Button("Copy Link") { model.platform.copyText(url.absoluteString) }
            Divider()
        }
        if let image = model.inspectableImage(info.linkURL) {
            Button("Inspect Image") { Task { await model.inspectImage(image) } }
            Divider()
        }
        Button("Copy") {
            Task {
                let text = await model.selectedText()
                if !text.isEmpty { model.platform.copyText(text) }
            }
        }
        if !model.isDraft { Button("Copy Passage with Source") { Task { await model.copyPassageWithSource() } } }
        Button("Copy Markdown") { model.copyMarkdown() }
        if !model.isDraft {
            Divider()
            Button(model.showingSource ? "Show Document" : "Show Source") { Task { await model.toggleSource() } }
        }
    }

    @ViewBuilder private var banners: some View {
        if let update = model.update {
            Banner(systemImage: "arrow.triangle.2.circlepath", tint: .blue) {
                switch update {
                case .revision(let latest):
                    Text("Revision \(latest) is available. You are reading revision \(model.snapshot?.revision ?? 0).")
                case .fileChanged:
                    Text("The file changed on disk.")
                }
            } action: {
                if update != .fileChanged, model.review.shown == nil {
                    Button("Review Changes") { Task { await model.reviewChanges() } }
                }
                Button(update == .fileChanged ? "Reload" : "Show Latest") { Task { await model.refresh() } }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }
        if let failure = model.failure {
            Banner(systemImage: "exclamationmark.triangle", tint: .orange) {
                Text("The last update failed: \(failure)")
            } action: {
                Button("Try Again") { Task { await model.refresh() } }
            }
        }
        if model.snapshot != nil { UpdateObservationBanner(model: model) }
        if let snapshot = model.snapshot, snapshot.completeness.state == .partial {
            Banner(systemImage: "exclamationmark.circle", tint: .orange) {
                Text(Provenance.completenessText(snapshot.completeness))
            } action: { EmptyView() }
        }
    }

    private var findBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
            TextField("Find in document", text: $model.findQuery)
                .textFieldStyle(.roundedBorder)
                .focused($findFocused)
                .onSubmit { Task { await model.find() } }
                .onKeyPress(.escape) {
                    model.hideFind()
                    return .handled
                }
                .accessibilityLabel("Find in document")
            if model.findStatus == .notFound {
                Text("Not found").font(.callout).foregroundStyle(.secondary)
            }
            Button { Task { await model.find(backwards: true) } } label: { Image(systemName: "chevron.up") }
                .help("Find Previous (⇧⌘G)")
                .accessibilityLabel("Find previous")
                .disabled(model.findQuery.isEmpty)
            Button { Task { await model.find() } } label: { Image(systemName: "chevron.down") }
                .help("Find Next (⌘G)")
                .accessibilityLabel("Find next")
                .disabled(model.findQuery.isEmpty)
            Button("Done") { model.hideFind() }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }

    @ViewBuilder private var noticeView: some View {
        if let notice = model.notice {
            HStack(spacing: 8) {
                Image(systemName: notice.kind == .warning ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(notice.kind == .warning ? .orange : .green)
                Text(notice.text).lineLimit(3)
                Button { model.dismissNotice() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.regularMaterial, in: Capsule())
            .shadow(radius: 4, y: 1)
            .padding(.bottom, 16)
            .padding(.horizontal, 16)
            .transition(.opacity)
            .accessibilityElement(children: .combine)
        }
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            OutlineControl(model: model)
            Button { Task { await model.goBack() } } label: { Label("Go Back", systemImage: "arrow.left") }
                .help("Return after a section jump (⌘[)")
                .disabled(!model.canGoBack)
        }
        ToolbarItemGroup(placement: .primaryAction) {
            ReaderEditControl(actions: editActions, hasDocument: model.snapshot != nil)
            Menu {
                Button("Find…") { model.showFind() }
                ViewOptionsMenu(model: model)
                Divider()
                Button("Copy Markdown") { model.copyMarkdown() }.disabled(model.snapshot == nil)
                ReaderCopyAction(actions: editActions)
                Button("Document Details") { model.detailsVisible.toggle() }
                RevisionMenu(model: model)
                if let label = model.returnLabel {
                    Divider()
                    Button(label) { Task { await model.returnToTerminal() } }
                }
            } label: { Label("More Actions", systemImage: "ellipsis.circle") }
                .popover(isPresented: $model.detailsVisible, arrowEdge: .bottom) { DetailsView(model: model) }
        }
    }

}

struct RevisionMenu: View {
    @Bindable var model: ReaderModel
    var showsReviewActions = true

    var body: some View {
        if let snapshot = model.snapshot, snapshot.revisions.count > 1 {
            Menu {
                ForEach(snapshot.revisions.reversed(), id: \.self) { revision in
                    Button {
                        Task { await model.showRevision(revision) }
                    } label: {
                        if revision == snapshot.revision {
                            Label(label(revision), systemImage: "checkmark")
                        } else {
                            Text(label(revision))
                        }
                    }
                }
                Divider()
                if snapshot.olderRevisionsUnlisted {
                    Text("Older revisions are not listed")
                }
                if showsReviewActions {
                    Button("Go to Revision…") { model.review.entry = .show }
                    Button(model.review.shown == nil ? "Review Changes" : "Close Comparison") { Task { await model.reviewChanges() } }
                }
            } label: {
                Label("Revision \(snapshot.revision ?? 0)", systemImage: "clock.arrow.circlepath")
            }
            .help("Choose a revision")
        }
    }

    private func label(_ revision: Int) -> String {
        revision == model.latestRevision ? "Revision \(revision) (latest)" : "Revision \(revision)"
    }
}

struct ViewOptionsMenu: View {
    @Bindable var model: ReaderModel

    var body: some View {
        Menu {
            Button("Bigger Text") { model.changeTextSize(by: 1) }
            Button("Smaller Text") { model.changeTextSize(by: -1) }
            Button("Actual Size") { model.resetTextSize() }
            Divider()
            Toggle("Wrap Code Lines", isOn: Binding(get: { model.settings.wrapCode }, set: { _ in model.toggleWrap() }))
            Toggle("Show Source", isOn: Binding(get: { model.showingSource }, set: { _ in Task { await model.toggleSource() } }))
        } label: {
            Label("View Options", systemImage: "textformat.size")
        }
        .help("Text size, code wrapping and source")
    }
}

/// The document title and primary actions stay visible; details live in the secondary menu.
struct EmbeddedHeader: View {
    @Bindable var model: ReaderModel
    let editActions: ReaderEditActions?
    let close: () -> Void
    let release: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                OutlineControl(model: model)
                Text(model.snapshot == nil ? "Opening…" : model.displayTitle)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ReaderEditControl(actions: editActions, hasDocument: model.snapshot != nil)
                Menu {
                    Button("Find…") { model.showFind() }
                    Button("Go Back") { Task { await model.goBack() } }.disabled(!model.canGoBack)
                    ViewOptionsMenu(model: model)
                    Divider()
                    RevisionMenu(model: model, showsReviewActions: false)
                    if (model.snapshot?.revisions.count ?? 0) > 1 {
                        Button("Go to Revision…") { model.review.entry = .show }
                        Button(model.review.shown == nil ? "Review Changes" : "Close Comparison") { Task { await model.reviewChanges() } }
                    }
                    Button("Show Latest Revision") { Task { await model.refresh() } }
                    Divider()
                    Button("Copy Markdown") { model.copyMarkdown() }
                        .disabled(model.snapshot == nil)
                    ReaderCopyAction(actions: editActions)
                    Button("Document Details") { model.detailsVisible.toggle() }
                    Divider()
                    Button("Return to Terminal", action: release)
                } label: {
                    Label("More Actions", systemImage: "ellipsis.circle")
                }
                .help("Revision, view and document actions")
                .popover(isPresented: $model.detailsVisible, arrowEdge: .bottom) { DetailsView(model: model) }
                Button { close() } label: { Label("Close", systemImage: "xmark") }
                    .help("Close the reader (⌘W)")
            }
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .controlSize(.regular)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }
}

private struct ReaderEditControl: View {
    let actions: ReaderEditActions?
    let hasDocument: Bool

    var body: some View {
        if let action = actions?.edit ?? actions?.editCopy {
            let label = actions?.edit != nil ? "Edit" : "Edit Copy"
            Button(action: action) { Label(label, systemImage: "square.and.pencil") }
                .disabled(!hasDocument || actions?.isEnabled != true)
                .help(label == "Edit" ? "Edit this document" : "Edit a copy; keep the captured source unchanged")
        }
    }
}

private struct ReaderCopyAction: View {
    let actions: ReaderEditActions?

    var body: some View {
        if actions?.edit != nil, let copy = actions?.editCopy {
            Button("Edit a Copy", action: copy).disabled(actions?.isEnabled != true)
        }
    }
}

struct Banner<Message: View, Action: View>: View {
    let systemImage: String
    let tint: Color
    @ViewBuilder let message: Message
    @ViewBuilder let action: Action

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage).foregroundStyle(tint).accessibilityHidden(true)
            message.font(.callout).frame(maxWidth: .infinity, alignment: .leading)
            action.controlSize(.small)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(tint.opacity(0.09))
        .overlay(alignment: .bottom) { Divider() }
        .accessibilityElement(children: .contain)
    }
}

struct OutlineControl: View {
    @Bindable var model: ReaderModel

    var body: some View {
        Button { model.toggleOutline() } label: { Label("Contents", systemImage: "sidebar.left") }
            .help("Show or hide contents (⌃⌘S)")
            .disabled(model.rendered?.outline.isEmpty ?? true)
            .popover(isPresented: $model.outlinePopoverVisible, arrowEdge: .bottom) {
                OutlineList(model: model)
                    .frame(width: 300, height: 420)
            }
    }
}

struct OutlineList: View {
    @Bindable var model: ReaderModel

    var body: some View {
        let entries = model.filteredOutline
        let minimumLevel = model.rendered?.outline.map(\.level).min() ?? 1
        VStack(spacing: 0) {
            TextField("Filter headings", text: $model.outlineQuery)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Filter outline headings")
                .padding(10)
            if entries.isEmpty {
                ContentUnavailableView.search(text: model.outlineQuery)
            } else {
                List(entries) { entry in
                    Button {
                        Task { await model.scrollTo(anchor: entry.id) }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "smallcircle.filled.circle")
                                .foregroundStyle(.tint)
                                .opacity(model.activeSection == entry.id ? 1 : 0)
                                .accessibilityHidden(true)
                            Text(entry.title)
                                .font(entry.level <= 1 ? .body.weight(.semibold) : entry.level == 2 ? .body : .callout)
                                .foregroundStyle(entry.level <= 2 ? .primary : .secondary)
                                .lineLimit(3)
                        }
                        .padding(.leading, CGFloat(max(0, entry.level - minimumLevel)) * 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(model.activeSection == entry.id ? Color.accentColor.opacity(0.12) : Color.clear)
                    .accessibilityLabel("Heading level \(entry.level): \(entry.title)")
                    .accessibilityValue(model.activeSection == entry.id ? "Current section" : "")
                }
                .listStyle(.sidebar)
                .accessibilityLabel("Outline")
            }
        }
    }
}

struct DetailsView: View {
    @Bindable var model: ReaderModel

    var body: some View {
        let rows = Provenance.details(model.snapshot, rendered: model.rendered, latestRevision: model.latestRevision, origin: model.launchOrigin, imageEvidence: model.imageEvidence)
        VStack(alignment: .leading, spacing: 10) {
            Text("Document Details").font(.headline)
            ScrollView {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 4) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            Text(row.0).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
                            Text(row.1).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                        .font(.callout)
                    }
                }
            }
            .frame(maxHeight: 420)
            HStack {
                Button("Copy Details") {
                    model.platform.copyText(rows.map { "\($0.0): \($0.1)" }.joined(separator: "\n"))
                }
                Button("Show in Finder") { model.revealInFinder() }
                Menu("Export") {
                    Button("Revision Archive…") { Task { await model.exportRevision(.archive) } }.disabled(model.snapshot?.record == nil)
                    Button("Sharing Copy…") { Task { await model.exportRevision(.sharing) } }.disabled(model.snapshot?.record == nil)
                    Button("Current Page PDF…") { Task { await model.exportCurrentPagePDF() } }.disabled(!model.canExportPDF)
                }
                Spacer()
            }
        }
        .padding(16)
        .frame(width: 520)
        .task { model.imageEvidence = await model.inspectImages() }
    }
}

/// Observes completed native selection gestures without consuming input or changing focus.
private struct ReaderSelectionEvents: NSViewRepresentable {
    let changed: () -> Void
    func makeNSView(context: Context) -> SelectionEventView { SelectionEventView() }
    func updateNSView(_ view: SelectionEventView, context: Context) { view.changed = changed }
    static func dismantleNSView(_ view: SelectionEventView, coordinator: ()) { view.stop() }
}

private final class SelectionEventView: NSView {
    var changed: (() -> Void)?
    private var monitor: Any?
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        stop()
        guard window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseUp, .keyUp]) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, let window = self.window, event.window === window,
                      !self.isHiddenOrHasHiddenAncestor else { return }
                let area = self.convert(self.bounds, to: nil)
                if event.type == .leftMouseUp {
                    guard area.contains(event.locationInWindow) else { return }
                } else {
                    guard let responder = window.firstResponder as? NSView,
                          area.intersects(responder.convert(responder.bounds, to: nil)) else { return }
                }
                DispatchQueue.main.async { [weak self, weak window] in
                    guard let self, self.window === window, !self.isHiddenOrHasHiddenAncestor else { return }
                    self.changed?()
                }
            }
            return event
        }
    }
    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }
}
