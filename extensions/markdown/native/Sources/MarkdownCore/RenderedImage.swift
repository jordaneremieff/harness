import Foundation

/// One image of a rendered source: what the Markdown says and how the rendering resolved it.
public struct RenderedImage: Sendable, Equatable {
    public enum Source: Sendable, Equatable {
        /// A local file, served under this token of the rendering.
        case local(token: String)
        /// A `data:` address carried in the source and shown inline.
        case embedded
        /// A web address. The reader never loads it.
        case external(URL)
        case unavailable(reason: String)
    }

    /// The destination exactly as the Markdown source has it.
    public var reference: String
    /// The alternative text; empty when the source gives none.
    public var alt: String
    public var title: String
    public var source: Source
}

extension Stylesheet {
    /// Rules of the image inspection page and of the actions that open it from a document.
    static let inspection = #"""

    a.img-open { cursor: zoom-in; }
    a.img-open:hover { text-decoration: none; }
    a.img-inspect { margin-left: 0.2em; font-size: 0.92em; white-space: nowrap; }
    .review a.img-open { pointer-events: none; cursor: default; }
    .review a.img-inspect { display: none; }
    @media print { a.img-inspect { display: none; } }

    /* At a chosen scale the page grows with the image and scrolls both ways; an image smaller
       than the view sits in its middle. */
    html:has(> body.inspect) { height: 100%; }
    body.inspect { display: flex; width: max-content; min-width: 100%; min-height: 100%; padding: 12px; background: var(--surface); }
    body.inspect img { display: block; flex: none; margin: auto; max-width: none; height: auto; }
    html[data-zoom="measure"] body.inspect img { visibility: hidden; }
    html[data-zoom="fit"] body.inspect { width: 100%; height: 100%; overflow: hidden; }
    html[data-zoom="fit"] body.inspect img { width: 100%; height: 100%; min-width: 0; min-height: 0; object-fit: contain; }
    """#
}
