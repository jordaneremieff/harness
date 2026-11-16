import MacPlatform
import MarkdownCore
import ReaderFeature
import SwiftUI

struct DocumentEditorView: View {
    @Bindable var document: WorkingDocument
    var readingChrome: ReaderChrome = .preview
    var editActions: ReaderEditActions?
    var body: some View {
        VStack(spacing: 0) {
            if !document.readingDraft {
                HStack(spacing: 12) {
                    EditorCommandMenu(document: document)
                    viewMenu
                    Spacer(minLength: 0)
                }.padding(.horizontal, 10).padding(.vertical, 6)
                if let pending = document.pendingMode {
                    Text("\(pending.rawValue) mode will open after text composition finishes.").font(.caption).foregroundStyle(.secondary)
                }
                if document.findVisible { EditorFindBar(document: document) }
                Divider()
            }
            GeometryReader { geometry in
                VStack(spacing: 0) {
                    if !document.readingDraft, document.mode == .split, geometry.size.width < EditorModeSplitView.minimumSplitWidth {
                        Text("Split shows source at this width. Select Rendered for the preview.")
                            .font(.caption).foregroundStyle(.secondary).padding(6)
                    }
                    EditorModeLayout(document: document, readingChrome: readingChrome, editActions: editActions)
                        .id(document.id)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }.onChange(of: geometry.size.width, initial: true) { _, width in
                    document.setSplitAvailable(width >= EditorModeSplitView.minimumSplitWidth)
                }
            }
        }
        .disabled(document.replacing)
        .onChange(of: document.presentation) { _, _ in document.updatePresentation() }
        .preferredColorScheme(document.presentation.appearance == .system ? nil : document.presentation.appearance == .dark ? .dark : .light)
    }

    private var viewMenu: some View {
        Menu {
            Picker("Mode", selection: Binding(get: { document.mode }, set: { document.setMode($0) })) {
                ForEach([EditorMode.visual, .raw], id: \.self) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.inline)
            Divider()
            Button("Find…") { document.showFind() }
            Button("Zoom Out") { document.text.setZoom(document.text.zoom - 0.1) }
            Button("Actual Size") { document.text.setZoom(1) }
            Button("Zoom In") { document.text.setZoom(document.text.zoom + 0.1) }
            Divider()
            Picker("Appearance", selection: $document.presentation.appearance) {
                ForEach(MarkdownThemeAppearance.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
            }
            Picker("Source Font", selection: $document.presentation.font) {
                ForEach(MarkdownSourceFont.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
            }
            Picker("Text Size", selection: $document.presentation.fontSize) {
                ForEach(PageSettings.textSizes, id: \.self) { Text("\($0) pt").tag(CGFloat($0)) }
            }
            Toggle("Wrap Lines", isOn: $document.presentation.wrapsLines)
        } label: { Label("View", systemImage: "eye") }
        .menuStyle(.borderlessButton).fixedSize()
        .help("Visual edits headings, prose, emphasis and link labels. Other blocks remain editable source; use Source for selections across hidden markup.")
    }

}
