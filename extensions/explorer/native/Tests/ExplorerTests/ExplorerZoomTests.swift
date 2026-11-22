import AppKit
import Foundation
import Testing
@testable import Explorer

struct ExplorerZoomTests {
    private func key(_ characters: String, _ flags: NSEvent.ModifierFlags = .command) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: 0, context: nil,
                         characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: 0)!
    }

    @Test func stepsMoveThroughLevelsAndStopAtTheLimits() {
        #expect(ExplorerZoom.next(1, .zoomIn) == 1.1)
        #expect(ExplorerZoom.next(1, .zoomOut) == 0.9)
        #expect(ExplorerZoom.next(1.3, .zoomIn) == 1.5)
        #expect(ExplorerZoom.next(1.3, .zoomOut) == 1.25)
        #expect(ExplorerZoom.next(3, .zoomIn) == 3)
        #expect(ExplorerZoom.next(0.5, .zoomOut) == 0.5)
        #expect(ExplorerZoom.next(2.5, .reset) == 1)
    }

    @Test func commandKeysMapToSteps() {
        #expect(ExplorerZoom.step(for: key("=")) == .zoomIn)
        #expect(ExplorerZoom.step(for: key("+", [.command, .shift])) == .zoomIn)
        #expect(ExplorerZoom.step(for: key("+", [.command, .numericPad])) == .zoomIn)
        #expect(ExplorerZoom.step(for: key("-")) == .zoomOut)
        #expect(ExplorerZoom.step(for: key("0")) == .reset)
        #expect(ExplorerZoom.step(for: key("=", [])) == nil)
        #expect(ExplorerZoom.step(for: key("=", [.command, .option])) == nil)
        #expect(ExplorerZoom.step(for: key("-", [.command, .control])) == nil)
        #expect(ExplorerZoom.step(for: key("p")) == nil)
    }

    @Test func pinchStepsByAccumulatedMagnificationAndResetsPerGesture() {
        var pinch = ExplorerZoom.Pinch()
        #expect(pinch.steps(0.1, phase: .began).isEmpty)
        #expect(pinch.steps(0.1, phase: .changed) == [.zoomIn])
        #expect(pinch.steps(0.4, phase: .changed) == [.zoomIn, .zoomIn])
        #expect(pinch.steps(-0.1, phase: .ended).isEmpty)
        #expect(pinch.steps(-0.1, phase: .began).isEmpty)
        #expect(pinch.steps(-0.1, phase: .changed) == [.zoomOut])
    }

    @Test func settingsKeepTheHostZoomAcrossPageSaves() throws {
        let store = FileManager.default.temporaryDirectory.appendingPathComponent("explorer-zoom-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: store) }
        let state = ExplorerState(store: store)
        #expect(state.zoom == 1)
        try state.saveZoom(1.25)
        var page = state.settings
        page["zoom"] = 1
        page["wrap"] = true
        try state.saveSettings(page)
        #expect(state.zoom == 1.25)
        #expect(state.settings["wrap"] as? Bool == true)
        #expect(throws: ExplorerError.self) { try state.saveZoom(4) }
        page["zoom"] = true
        #expect(throws: ExplorerError.self) { try state.saveSettings(page) }
    }
}
