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
    static let waitForImages = """
    const states = globalThis.readerImageDecodeStates ||= new Map();
    const pending = [...document.querySelectorAll('img[data-asset]')].filter(i => i.dataset.imageRendering === rendering).map(i => {
      const key = rendering + ':' + i.dataset.asset;
      if (!states.has(key)) {
        const state = { result: 'pending' };
        state.promise = i.decode().then(() => { state.result = 'decoded'; }, () => { state.result = 'failed'; });
        states.set(key, state);
      }
      return states.get(key).promise;
    });
    let timer;
    const settled = await Promise.race([
      Promise.all(pending).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })
    ]);
    clearTimeout(timer);
    return settled;
    """

    static let inspectImages = """
    const images = [...document.querySelectorAll('img[data-asset]')].filter(i => i.dataset.imageRendering === rendering);
    return images.map(i => {
      const token = i.dataset.asset;
      const decoded = globalThis.readerImageDecodeStates?.get(rendering + ':' + token)?.result;
      const reason = failures[token] || (decoded === 'failed' ? 'Image decode failed.' : null);
      return { token, reference: i.dataset.reference, displayed: !reason && decoded === 'decoded' && i.complete && i.naturalWidth > 0, failure: reason };
    });
    """
}

extension ReaderModel {
    /// Check-only browser decode evidence. This observation never changes the document DOM.
    package func inspectImages() async -> [ImageEvidence] {
        guard let rendered, !rendered.assets.isEmpty, !showingSource else { return [] }
        let rendering = rendered.nonce
        _ = try? await page.callJavaScript(PageScript.waitForImages, arguments: ["rendering": rendering], contentWorld: PageScript.world)
        guard self.rendered?.nonce == rendering, !Task.isCancelled else { return [] }
        var failures: [String: String] = [:]
        for token in rendered.assets.keys {
            if let reason = assets.evidence(token).failure { failures[token] = reason }
        }
        guard let rows = try? await page.callJavaScript(PageScript.inspectImages, arguments: ["failures": failures, "rendering": rendering], contentWorld: PageScript.world) as? [[String: Any]] else { return [] }
        return rows.compactMap { row in
            guard let token = row["token"] as? String, let reference = row["reference"] as? String else { return nil }
            let evidence = assets.evidence(token)
            return ImageEvidence(reference: reference, resolved: true, served: evidence.served,
                                 displayed: row["displayed"] as? Bool ?? false,
                                 failure: evidence.failure ?? row["failure"] as? String)
        }
    }
}
