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
