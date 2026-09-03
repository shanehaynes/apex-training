// swift-tools-version: 6.0
import PackageDescription

// ApexCore has no dependencies, on purpose.
//
// `swift test --package-path ios/Packages/ApexCore` is the gate a Linux session
// runs to prove Swift-side decisions (docs/ios/architecture.md rule 2). It has to
// build the *whole* package, so one Apple-only import or one SDK dependency ends
// that gate for everyone. scripts/ci-guards.sh enforces the import rule
// mechanically; this manifest enforces the dependency half by having none.
//
// Anything needing UIKit/SwiftUI, supabase-swift or GRDB belongs in ../ApexKit.
let package = Package(
    name: "ApexCore",
    // Declared for the Apple side of the build. Platform clauses do not
    // constrain the Linux build, which is what CI's apexcore-linux job runs.
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "ApexCore", targets: ["ApexCore"]),
    ],
    targets: [
        // No .defaultIsolation(MainActor) here: ApexCore's actors and Sendable
        // models are used off the main actor by design.
        .target(name: "ApexCore", swiftSettings: [.swiftLanguageMode(.v6)]),
        .testTarget(
            name: "ApexCoreTests",
            dependencies: ["ApexCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
