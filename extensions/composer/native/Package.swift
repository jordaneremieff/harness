// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Composer",
    platforms: [.macOS(.v26)],
    dependencies: [.package(path: "../../../native-pane")],
    targets: [
        .executableTarget(name: "Composer", dependencies: [.product(name: "NativePane", package: "native-pane")]),
        .testTarget(name: "ComposerTests", dependencies: ["Composer"]),
    ]
)
