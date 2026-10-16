// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AirflashBonjour",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "AirflashBonjour",
            targets: ["AirflashBonjourPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3")
    ],
    targets: [
        .target(
            name: "AirflashBonjourPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/AirflashBonjourPlugin")
    ]
)
