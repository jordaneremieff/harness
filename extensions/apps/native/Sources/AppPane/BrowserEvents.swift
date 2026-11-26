import AppKit
import ApplicationServices
import AppPaneCore

/// Sends events only to the process that owns the window. The window ID has the type its
/// scripting dictionary uses; it is never an index into the browser's current window order.
enum BrowserEvents {
    static func send(pid: pid_t, event id: AEEventID, parameters: [AEKeyword: NSAppleEventDescriptor],
                     timeout: TimeInterval) throws -> NSAppleEventDescriptor? {
        let event = NSAppleEventDescriptor(eventClass: kAECoreSuite, eventID: id,
                                           targetDescriptor: .init(processIdentifier: pid),
                                           returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
        for (key, value) in parameters { event.setParam(value, forKeyword: key) }
        let reply = try event.sendEvent(options: [.waitForReply, .neverInteract], timeout: timeout)
        if let error = reply.paramDescriptor(forKeyword: keyErrorNumber), error.int32Value != 0 {
            let detail = reply.paramDescriptor(forKeyword: keyErrorString)?.stringValue
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(error.int32Value),
                          userInfo: detail.map { [NSLocalizedDescriptionKey: $0] })
        }
        return reply.paramDescriptor(forKeyword: keyDirectObject)
    }

    static func window(id: String, scripting: BrowserScripting) -> NSAppleEventDescriptor? {
        switch scripting.windowID(id) {
        case .text(let text): return specifier(cWindow, formUniqueID, .init(string: text))
        case .integer(let number): return specifier(cWindow, formUniqueID, .init(int32: number))
        case nil: return nil
        }
    }

    static func createWindow(pid: pid_t, scripting: BrowserScripting, before: Set<String>) throws -> String {
        switch scripting {
        case .chromium:
            let reference = try send(pid: pid, event: kAECreateElement,
                                     parameters: [keyAEObjectClass: .init(typeCode: cWindow)], timeout: 30)
            if let id = windowID(from: reference, scripting: scripting) { return id }
        case .safari:
            return try createSafariWindow(pid: pid, before: before)
        }
        throw Opening.Failure(text: "The browser did not identify the window it opened.")
    }

    private static func createSafariWindow(pid: pid_t, before: Set<String>) throws -> String {
        // Safari makes a document. A private, non-network address identifies its new window
        // even when the make reply is missing or exposes a document rather than a window.
        let marker = "about:blank#app-pane-\(UUID().uuidString.lowercased())"
        let properties = NSAppleEventDescriptor.record()
        properties.setDescriptor(.init(string: marker), forKeyword: 0x7055524C) // pURL
        let created = Result {
            try send(pid: pid, event: kAECreateElement, parameters: [keyAEObjectClass: .init(typeCode: cDocument),
                                                                       keyAEPropData: properties], timeout: 30)
        }
        if case .failure(let error) = created, (error as NSError).code != errAETimeout { throw error }
        let deadline = ContinuousClock.now + .seconds(4)
        repeat {
            if let current = try? windowIDs(pid: pid) {
                let fresh = current.subtracting(before)
                let matches = fresh.filter { id in
                    guard ContinuousClock.now < deadline, let window = window(id: id, scripting: .safari) else { return false }
                    return (try? get(pid: pid, address(of: window, scripting: .safari)))?.stringValue == marker
                }
                if matches.count == 1, let id = matches.first { return id }
                if matches.count > 1 { break }
            }
            if ContinuousClock.now < deadline { Thread.sleep(forTimeInterval: 0.1) }
        } while ContinuousClock.now < deadline
        _ = try created.get()
        throw Opening.Failure(text: "Safari did not expose the address of the new window.")
    }

    /// The browser's own rectangle descriptor, retained without translating screen coordinates.
    struct WindowBounds: Sendable {
        fileprivate let data: Data
        let frame: CGRect
    }

    static func frontWindowID(pid: pid_t) -> String? {
        let first = specifier(cWindow, formAbsolutePosition, .init(int32: 1))
        return (try? send(pid: pid, event: kAEGetData, parameters: [keyDirectObject: property(pID, of: first)], timeout: 1))?.stringValue
    }

    /// Chromium raises the window that receives a tab. Undo that change only if that window
    /// is still in front. The front window is never the address for a tab creation.
    static func restoreFrontWindow(_ previous: String?, ifRaised id: String, pid: pid_t, scripting: BrowserScripting) {
        guard let previous, previous != id, let window = window(id: previous, scripting: scripting),
              frontWindowID(pid: pid) == id else { return }
        _ = try? send(pid: pid, event: kAESetData,
                      parameters: [keyDirectObject: property(pIndex, of: window), keyAEData: .init(int32: 1)], timeout: 1)
    }

    static func originalBounds(pid: pid_t, id: String, scripting: BrowserScripting) throws -> WindowBounds {
        guard let window = window(id: id, scripting: scripting),
              let rectangle = try get(pid: pid, property(pBounds, of: window))?.coerce(toDescriptorType: typeQDRectangle),
              let frame = Geometry.quickDrawFrame(rectangle.data) else {
            throw Opening.Failure(text: "The browser did not report the new window’s original bounds.")
        }
        return WindowBounds(data: rectangle.data, frame: frame)
    }

    static func restoreBounds(pid: pid_t, window: NSAppleEventDescriptor, bounds: WindowBounds) throws {
        guard let rectangle = NSAppleEventDescriptor(descriptorType: typeQDRectangle, data: bounds.data) else {
            throw CocoaError(.coderInvalidValue)
        }
        _ = try send(pid: pid, event: kAESetData,
                     parameters: [keyDirectObject: property(pBounds, of: window), keyAEData: rectangle], timeout: 1)
    }

    static func navigate(pid: pid_t, scripting: BrowserScripting, id: String, url: URL) throws {
        guard let window = window(id: id, scripting: scripting) else { return }
        _ = try send(pid: pid, event: kAESetData,
                     parameters: [keyDirectObject: address(of: window, scripting: scripting),
                                  keyAEData: .init(string: url.absoluteString)], timeout: 5)
    }

    private static func address(of window: NSAppleEventDescriptor, scripting: BrowserScripting) -> NSAppleEventDescriptor {
        switch scripting {
        case .chromium: return property(0x55524C20, of: property(0x61635461, of: window)) // URL , acTa
        case .safari: return property(0x7055524C, of: property(0x63546162, of: window)) // pURL, cTab
        }
    }

    private static func windowID(from reference: NSAppleEventDescriptor?, scripting: BrowserScripting) -> String? {
        guard let reference, reference.descriptorType == typeObjectSpecifier,
              reference.forKeyword(UInt32(keyAEDesiredClass))?.typeCodeValue == cWindow,
              reference.forKeyword(UInt32(keyAEKeyForm))?.enumCodeValue == UInt32(formUniqueID),
              let id = reference.forKeyword(UInt32(keyAEKeyData))?.stringValue,
              scripting.windowID(id) != nil else { return nil }
        return id
    }

    static func windowIDs(pid: pid_t) throws -> Set<String> {
        let allWindows = NSAppleEventDescriptor(enumCode: UInt32(kAEAll))
        let ordinal = NSAppleEventDescriptor(descriptorType: DescType(typeAbsoluteOrdinal), data: allWindows.data)!
        let all = specifier(cWindow, formAbsolutePosition, ordinal)
        guard let ids = try get(pid: pid, property(pID, of: all)), ids.descriptorType == typeAEList else {
            throw Opening.Failure(text: "The browser did not report its window IDs.")
        }
        guard ids.numberOfItems > 0 else { return [] }
        let values = Set((1...ids.numberOfItems).compactMap { ids.atIndex($0)?.stringValue })
        guard values.count == ids.numberOfItems else {
            throw Opening.Failure(text: "The browser did not report distinct window IDs.")
        }
        return values
    }

    private static func get(pid: pid_t, _ object: NSAppleEventDescriptor) throws -> NSAppleEventDescriptor? {
        try send(pid: pid, event: kAEGetData, parameters: [keyDirectObject: object], timeout: 3)
    }

    private static func property(_ code: OSType, of container: NSAppleEventDescriptor) -> NSAppleEventDescriptor {
        specifier(cProperty, formPropertyID, .init(typeCode: code), container: container)
    }

    private static func specifier(_ type: OSType, _ form: Int, _ key: NSAppleEventDescriptor,
                                  container: NSAppleEventDescriptor = .null()) -> NSAppleEventDescriptor {
        let record = NSAppleEventDescriptor.record()
        record.setDescriptor(.init(typeCode: type), forKeyword: UInt32(keyAEDesiredClass))
        record.setDescriptor(.init(enumCode: UInt32(form)), forKeyword: UInt32(keyAEKeyForm))
        record.setDescriptor(key, forKeyword: UInt32(keyAEKeyData))
        record.setDescriptor(container, forKeyword: UInt32(keyAEContainer))
        return record.coerce(toDescriptorType: typeObjectSpecifier)!
    }

    static func run<Value: Sendable>(_ operation: @escaping @Sendable () throws -> Value) async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(with: Result(catching: operation))
            }
        }
    }
}
