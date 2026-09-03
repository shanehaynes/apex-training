// swift-tools-version: 6.2
import PackageDescription

// The Apple-only half of the app. One package with four library products rather
// than four sibling packages: every worktree runs `xcodegen generate` and
// resolves the graph from scratch, and one package resolves supabase-swift and
// GRDB once instead of four times with four chances of version skew. The
// boundaries that matter are enforced by target dependency edges below.
//
// ApexCore is the one package that must stay separate, for a hard reason rather
// than a stylistic one: `swift test --package-path ios/Packages/ApexCore` has to
// build the whole package on Linux. See docs/ios/decisions.md D-021.
//
// Versions are pinned exactly because the .xcodeproj is generated (D-005), so
// Package.resolved lives inside a git-ignored directory and cannot be committed.
// This manifest is the only place a version can be held still.
let package = Package(
    name: "ApexKit",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "ApexAuth", targets: ["ApexAuth"]),
        .library(name: "ApexPersistence", targets: ["ApexPersistence"]),
        .library(name: "ApexUI", targets: ["ApexUI"]),
        .library(name: "ApexFeatures", targets: ["ApexFeatures"]),
    ],
    dependencies: [
        .package(path: "../ApexCore"),
        .package(url: "https://github.com/supabase/supabase-swift.git", exact: "2.55.1"),
        .package(url: "https://github.com/groue/GRDB.swift.git", exact: "7.11.1"),
    ],
    targets: [
        // Deliberately not MainActor-isolated: the generated row types are
        // Sendable values decoded off the main actor, and the token provider is
        // called from ApexClient's actor.
        .target(
            name: "ApexAuth",
            dependencies: [
                .product(name: "ApexCore", package: "ApexCore"),
                .product(name: "Supabase", package: "supabase-swift"),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "ApexPersistence",
            dependencies: [
                .product(name: "ApexCore", package: "ApexCore"),
                .product(name: "GRDB", package: "GRDB.swift"),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // Views default to MainActor, matching SWIFT_DEFAULT_ACTOR_ISOLATION on
        // the app target.
        .target(
            name: "ApexUI",
            dependencies: [.product(name: "ApexCore", package: "ApexCore")],
            resources: [.process("Resources")],
            swiftSettings: [.swiftLanguageMode(.v6), .defaultIsolation(MainActor.self)]
        ),
        .target(
            name: "ApexFeatures",
            dependencies: [
                .product(name: "ApexCore", package: "ApexCore"),
                "ApexUI", "ApexAuth", "ApexPersistence",
            ],
            swiftSettings: [.swiftLanguageMode(.v6), .defaultIsolation(MainActor.self)]
        ),
    ]
)
