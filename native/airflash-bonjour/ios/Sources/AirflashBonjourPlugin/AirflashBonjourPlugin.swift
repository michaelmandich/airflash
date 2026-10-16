import Foundation
import Capacitor

@objc(AirflashBonjourPlugin)
public class AirflashBonjourPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AirflashBonjourPlugin"
    public let jsName = "AirflashBonjour"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private let implementation = AirflashBonjour()

    override public func load() {
        super.load()
        implementation.onServiceFound = { [weak self] service in
            self?.notifyListeners("serviceFound", data: [
                "name": service.name,
                "host": service.host,
                "port": service.port,
                "addresses": service.addresses
            ])
        }
        implementation.onServiceLost = { [weak self] name in
            self?.notifyListeners("serviceLost", data: ["name": name])
        }
        implementation.onError = { [weak self] code, message in
            self?.notifyListeners("error", data: ["code": code, "message": message])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        let type = call.getString("type") ?? "_airflash._tcp"
        implementation.start(type: type)
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        implementation.stop()
        call.resolve()
    }
}
