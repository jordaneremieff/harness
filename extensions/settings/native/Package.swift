// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Settings",
    platforms: [.macOS(.v26)],
    dependencies: [.package(path: "../../../native-pane")],
    targets: [
        .executableTarget(name: "Settings", dependencies: [.product(name: "NativePane", package: "native-pane")]),
        .testTarget(name: "SettingsTests", dependencies: ["Settings"]),
    ]
)
