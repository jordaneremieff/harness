import MacPlatform
import MarkdownCore
import ReaderFeature
import SwiftUI

struct DocumentEditorView: View {
    @Bindable var document: WorkingDocument
    var body: some View {
        VStack(spacing: 0) {
            ViewThatFits(in: .horizontal) {
                HStack { modePicker; Spacer(); settings }
                VStack(alignment: .leading) { modePicker; settings }
            }.padding(.horizontal, 10).padding(.vertical, 6)
            if let pending = document.pendingMode {
                Text("\(pending.rawValue) mode will open after text composition finishes.").font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            switch document.mode {
            case .styled, .raw:
                MarkdownEditorTextSurface(controller: document.text)
            case .rendered:
                preview
            case .split:
                HSplitView {
                    MarkdownEditorTextSurface(controller: document.text).frame(minWidth: 180)
                    preview.frame(minWidth: 180)
                }
            }
        }
        .onChange(of: document.presentation) { _, _ in document.updatePresentation() }
        .preferredColorScheme(document.presentation.appearance == .system ? nil : document.presentation.appearance == .dark ? .dark : .light)
    }

    private var modePicker: some View {
        Picker("Mode", selection: Binding(get: { document.mode }, set: { document.setMode($0) })) {
            ForEach(EditorMode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
        }.pickerStyle(.segmented).frame(maxWidth: 360)
    }

    private var settings: some View {
        Menu {
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
        } label: { Label("Appearance", systemImage: "textformat.size") }
        .menuStyle(.borderlessButton).fixedSize()
    }

    private var preview: some View {
        VStack(spacing: 0) {
            if document.preview.draftGeneration != document.session.record.generation {
                HStack {
                    Text("Preview update pending").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }.padding(6)
            }
            ReaderView(model: document.preview, chrome: .preview)
        }
    }
}
