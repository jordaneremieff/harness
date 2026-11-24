// swift-tools-version: 6.2
import PackageDescription

// AppPaneCore  request parsing, application matching, browser scripts and geometry (Foundation only)
// AppPane      the pane program: finds its pane, docks the window, mirrors it while the terminal is in front
let package = Package(
    name: "AppPane",
    platforms: [.macOS(.v26)],
    products: [.executable(name: "AppPane", targets: ["AppPane"])],
    dependencies: [.package(path: "../../../native-pane")],
    targets: [
        .target(name: "AppPaneCore"),
        .executableTarget(name: "AppPane", dependencies: ["AppPaneCore", .product(name: "NativePane", package: "native-pane")]),
        .testTarget(name: "AppPaneCoreTests", dependencies: ["AppPaneCore"]),
    ]
)
