// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Config",
    platforms: [.macOS(.v26)],
    dependencies: [.package(path: "../../../native-pane")],
    targets: [
        .executableTarget(name: "Config", dependencies: [.product(name: "NativePane", package: "native-pane")]),
        .testTarget(name: "ConfigTests", dependencies: ["Config"]),
    ]
)
