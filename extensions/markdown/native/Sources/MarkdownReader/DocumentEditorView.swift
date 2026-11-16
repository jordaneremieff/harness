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
            HStack {
                EditorCommandMenu(document: document)
                Button("Find") { document.showFind() }
                TextField("Line", text: $document.goToLineText).frame(width: 65).onSubmit { document.goToLine() }
                Button("Go") { document.goToLine() }
                Spacer()
            }.padding(.horizontal, 10).padding(.bottom, 6)
            if document.findVisible { EditorFindBar(document: document) }
            Divider()
            GeometryReader { geometry in
                VStack(spacing: 0) {
                    if document.mode == .split, geometry.size.width < EditorModeSplitView.minimumSplitWidth {
                        Text("Split shows source at this width. Select Rendered for the preview.")
                            .font(.caption).foregroundStyle(.secondary).padding(6)
                    }
                    EditorModeLayout(document: document)
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

}
