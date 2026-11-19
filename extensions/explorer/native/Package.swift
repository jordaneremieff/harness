// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Explorer",
    platforms: [.macOS(.v26)],
    targets: [
        .target(name: "ExplorerPane"),
        .executableTarget(name: "Explorer", dependencies: ["ExplorerPane"]),
        .testTarget(name: "ExplorerPaneTests", dependencies: ["ExplorerPane"]),
        .testTarget(name: "ExplorerTests", dependencies: ["Explorer"]),
    ],
    swiftLanguageModes: [.v5]
)
