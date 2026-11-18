// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "NativePane",
    platforms: [.macOS(.v26)],
    products: [.library(name: "NativePane", targets: ["NativePane"])],
    targets: [
        .target(name: "NativePane"),
        .testTarget(name: "NativePaneTests", dependencies: ["NativePane"]),
    ]
)
