import Foundation
import MarkdownCore
import WebKit

/// Resolution, serving and decoding are separate observations of the current page.
public struct ImageEvidence: Equatable, Sendable {
    public var reference: String
    public var resolved: Bool
    public var served: Bool
    public var displayed: Bool
    public var failure: String?
}

extension PageScript {
    static let waitForImages = "await Promise.all([...document.querySelectorAll('img[data-asset]')].map(i => i.decode().catch(() => {}))); return true;"

    static let inspectImages = """
    const images = [...document.querySelectorAll('img[data-asset]')];
    return images.map(i => {
      const token = i.dataset.asset;
      const reason = failures[token] || (i.complete && i.naturalWidth === 0 ? 'Image decode failed.' : null);
      if (reason) {
        let placeholder = i.nextElementSibling;
        if (!placeholder || placeholder.dataset.failedAsset !== token) {
          placeholder = document.createElement('span');
          placeholder.className = 'img-ph unavailable';
          placeholder.dataset.failedAsset = token;
          placeholder.setAttribute('role', 'img');
          i.after(placeholder);
        }
        placeholder.textContent = 'Image unavailable: ' + reason + ' (' + i.dataset.reference + ')';
        i.hidden = true;
      }
      return { token, reference: i.dataset.reference, displayed: !reason && i.complete && i.naturalWidth > 0, failure: reason };
    });
    """
}

extension ReaderModel {
    /// Reads decode evidence through the app's content world. Failed serving gets a visible
    /// qualified placeholder; no project-file fallback or document script is involved.
    public func inspectImages() async -> [ImageEvidence] {
        guard let rendered, !showingSource else { return [] }
        _ = try? await page.callJavaScript(PageScript.waitForImages, contentWorld: PageScript.world)
        var failures: [String: String] = [:]
        for token in rendered.assets.keys {
            if let reason = assets.evidence(token).failure { failures[token] = reason }
        }
        guard let rows = try? await page.callJavaScript(PageScript.inspectImages, arguments: ["failures": failures], contentWorld: PageScript.world) as? [[String: Any]] else { return [] }
        return rows.compactMap { row in
            guard let token = row["token"] as? String, let reference = row["reference"] as? String else { return nil }
            let evidence = assets.evidence(token)
            return ImageEvidence(reference: reference, resolved: true, served: evidence.served,
                                 displayed: row["displayed"] as? Bool ?? false,
                                 failure: evidence.failure ?? row["failure"] as? String)
        }
    }
}
