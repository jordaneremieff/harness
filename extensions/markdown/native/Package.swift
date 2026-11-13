// swift-tools-version: 6.2
import PackageDescription

// Four responsibilities, one target each:
// MarkdownCore   document store reading, identities, asset resolution, rendering (Foundation + cmark)
// ReaderFeature  the SwiftUI reader view and its per-window reading state (SwiftUI + WebKit)
// MacPlatform    pasteboard, external opening, Finder reveal, terminal return (AppKit)
// MarkdownReader the application entry point: windows, menus, open-request intake, check modes
// markdown-core  headless tool of the core (reference inventory); no AppKit, SwiftUI or WebKit
let package = Package(
    name: "MarkdownReader",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "MarkdownReader", targets: ["MarkdownReader"]),
        .executable(name: "markdown-core", targets: ["markdown-core"]),
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-cmark.git", exact: "0.9.0"),
    ],
    targets: [
        .target(
            name: "MarkdownCore",
            dependencies: [
                .product(name: "cmark-gfm", package: "swift-cmark"),
                .product(name: "cmark-gfm-extensions", package: "swift-cmark"),
            ]
        ),
        .target(name: "ReaderFeature", dependencies: ["MarkdownCore"]),
        .target(name: "MacPlatform", dependencies: ["MarkdownCore", "ReaderFeature"]),
        .executableTarget(name: "markdown-core", dependencies: ["MarkdownCore"]),
        .executableTarget(name: "MarkdownReader", dependencies: ["MarkdownCore", "ReaderFeature", "MacPlatform"]),
        .testTarget(name: "MarkdownCoreTests", dependencies: ["MarkdownCore"]),
        .testTarget(name: "MacPlatformTests", dependencies: ["MacPlatform", "MarkdownCore"]),
        .testTarget(name: "ReaderFeatureTests", dependencies: ["ReaderFeature", "MarkdownCore"]),
    ]
)
