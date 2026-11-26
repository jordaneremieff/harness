// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Editor",
    platforms: [.macOS(.v26)],
    dependencies: [.package(path: "../../../native-pane")],
    targets: [
        .executableTarget(name: "Editor", dependencies: [.product(name: "NativePane", package: "native-pane")]),
        .testTarget(name: "EditorTests", dependencies: ["Editor"]),
    ]
)
