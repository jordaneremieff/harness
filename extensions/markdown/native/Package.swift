// swift-tools-version: 6.2
import PackageDescription

// Native feature and platform boundaries:
// MarkdownCore   document store reading, identities, asset resolution, rendering (Foundation + cmark)
// ReaderFeature  the WebKit host, bridge, document preparation and reading state (AppKit + WebKit)
// EditorFeature  immutable edit snapshots, private recovery and explicit save boundaries
// MacPlatform    pasteboard, external opening, Finder reveal, terminal return (AppKit)
// NativePane     shared Rex overlay and terminal input/size (local SwiftPM package)
// MarkdownReader the application entry point: windows, menus, open-request intake, check modes
// markdown-core  headless tool of the core (reference inventory); no AppKit or WebKit
let package = Package(
    name: "MarkdownReader",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "MarkdownReader", targets: ["MarkdownReader"]),
        .executable(name: "markdown-core", targets: ["markdown-core"]),
    ],
    dependencies: [
        .package(path: "../../../native-pane"),
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
        .target(name: "EditorFeature", dependencies: ["MarkdownCore"]),
        .target(name: "MacPlatform", dependencies: ["MarkdownCore", "ReaderFeature"]),
        .executableTarget(name: "markdown-core", dependencies: ["MarkdownCore"]),
        .executableTarget(name: "MarkdownReader", dependencies: ["MarkdownCore", "ReaderFeature", "EditorFeature", "MacPlatform", .product(name: "NativePane", package: "native-pane")]),
        .testTarget(name: "EditorFeatureTests", dependencies: ["EditorFeature", "MarkdownCore"]),
        .testTarget(name: "MarkdownCoreTests", dependencies: ["MarkdownCore"]),
        .testTarget(name: "MacPlatformTests", dependencies: ["MacPlatform", "MarkdownCore"]),
        .testTarget(name: "ReaderFeatureTests", dependencies: ["ReaderFeature", "MarkdownCore"]),
        // Runs the built reader binary in pane mode on a pseudo-terminal.
        .testTarget(name: "MarkdownReaderTests", dependencies: ["MarkdownCore", "EditorFeature", "MarkdownReader"]),
    ]
)
