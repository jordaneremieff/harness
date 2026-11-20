// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Explorer",
    platforms: [.macOS(.v26)],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-cmark.git", exact: "0.9.0"),
    ],
    targets: [
        .target(name: "ExplorerPane"),
        .executableTarget(name: "Explorer", dependencies: [
            "ExplorerPane",
            .product(name: "cmark-gfm", package: "swift-cmark"),
            .product(name: "cmark-gfm-extensions", package: "swift-cmark"),
        ]),
        .testTarget(name: "ExplorerPaneTests", dependencies: ["ExplorerPane"]),
        .testTarget(name: "ExplorerTests", dependencies: ["Explorer"]),
    ],
    swiftLanguageModes: [.v5]
)
