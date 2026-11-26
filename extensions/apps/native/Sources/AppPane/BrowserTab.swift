import AppPaneCore
import ApplicationServices
import Foundation

extension BrowserEvents {
    /// A single create event with an explicit insertion point. A stale process or window is an
    /// error, never an instruction to create a tab in the browser's current window.
    static func newTab(pid: pid_t, windowID: String, scripting: BrowserScripting, url: URL?) throws -> String? {
        let location = NSAppleEventDescriptor.record()
        guard let target = window(id: windowID, scripting: scripting) else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(errAENoSuchObject)) }
        location.setDescriptor(target, forKeyword: AEKeyword(keyAEObject))
        location.setDescriptor(.init(enumCode: OSType(kAEEnd)), forKeyword: AEKeyword(keyAEPosition))
        guard let end = location.coerce(toDescriptorType: DescType(typeInsertionLoc)) else { throw CocoaError(.coderInvalidValue) }
        let tab: OSType = scripting == .chromium ? 0x43725462 : 0x62546162 // CrTb / bTab
        var arguments = [keyAEObjectClass: NSAppleEventDescriptor(typeCode: tab), keyAEInsertHere: end]
        if let url {
            let properties = NSAppleEventDescriptor.record()
            let address: AEKeyword = scripting == .chromium ? 0x55524c20 : 0x7055524c // URL  / pURL
            properties.setDescriptor(.init(string: url.absoluteString), forKeyword: address)
            arguments[keyAEPropData] = properties
        }
        let previous = frontWindowID(pid: pid)
        defer { restoreFrontWindow(previous, ifRaised: windowID, pid: pid, scripting: scripting) }
        let reply = try send(pid: pid, event: kAECreateElement, parameters: arguments, timeout: 4)
        guard reply?.forKeyword(AEKeyword(keyAEKeyForm))?.enumCodeValue == OSType(formUniqueID) else { return nil }
        return reply?.forKeyword(AEKeyword(keyAEKeyData))?.stringValue
    }
}
