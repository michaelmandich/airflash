import Foundation
import Network

/// Browses for Bonjour services with Network.framework and resolves each one to an
/// address by opening a TCP connection to it and reading the path's remote endpoint
/// (Apple's recommended replacement for NetService resolution). The connection is
/// closed right away; the node sees an empty connection and ignores it.
class AirflashBonjour {
    struct Service {
        let name: String
        /// Ready to drop into a URL: a dotted IPv4 address when we got one, otherwise a
        /// hostname, otherwise a bracketed IPv6 address, otherwise "" (unresolved).
        let host: String
        let port: Int
        let addresses: [String]
    }

    var onServiceFound: ((Service) -> Void)?
    var onServiceLost: ((String) -> Void)?
    var onError: ((_ code: String, _ message: String) -> Void)?

    private let queue = DispatchQueue(label: "airflash.bonjour")
    private var browser: NWBrowser?
    private var resolvers: [String: NWConnection] = [:]
    private static let resolveTimeout: TimeInterval = 5

    func start(type: String) {
        queue.async {
            self.stopOnQueue()
            let parameters = NWParameters()
            parameters.includePeerToPeer = true
            let browser = NWBrowser(for: .bonjour(type: type, domain: nil), using: parameters)
            browser.stateUpdateHandler = { [weak self] state in
                switch state {
                case .failed(let error):
                    self?.report(error)
                case .waiting(let error):
                    // Local-network permission denied shows up here, not in .failed.
                    self?.report(error)
                default:
                    break
                }
            }
            browser.browseResultsChangedHandler = { [weak self] _, changes in
                guard let self = self else { return }
                for change in changes {
                    switch change {
                    case .added(let result):
                        self.resolve(result.endpoint)
                    case .changed(old: _, new: let result, flags: _):
                        self.resolve(result.endpoint)
                    case .removed(let result):
                        if let name = self.serviceName(of: result.endpoint) {
                            self.resolvers.removeValue(forKey: name)?.cancel()
                            self.onServiceLost?(name)
                        }
                    default:
                        break
                    }
                }
            }
            self.browser = browser
            browser.start(queue: self.queue)
        }
    }

    func stop() {
        queue.async { self.stopOnQueue() }
    }

    private func stopOnQueue() {
        browser?.cancel()
        browser = nil
        for connection in resolvers.values {
            connection.cancel()
        }
        resolvers.removeAll()
    }

    private func report(_ error: NWError) {
        var code = "BROWSE_FAILED"
        // kDNSServiceErr_PolicyDenied: the user declined (or iOS silently denied) local network access.
        if case .dns(let dnsError) = error, Int(dnsError) == -65570 {
            code = "LOCAL_NETWORK_DENIED"
        }
        onError?(code, error.localizedDescription)
    }

    private func serviceName(of endpoint: NWEndpoint) -> String? {
        if case .service(let name, _, _, _) = endpoint {
            return name
        }
        return nil
    }

    private func resolve(_ endpoint: NWEndpoint) {
        guard let name = serviceName(of: endpoint) else { return }
        // First try IPv4 only (what the web UI wants for http://host:port), then anything.
        let ipv4 = NWParameters.tcp
        if let ip = ipv4.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
            ip.version = .v4
        }
        connect(name: name, endpoint: endpoint, using: ipv4) { [weak self] service in
            guard let self = self else { return }
            if let service = service {
                self.onServiceFound?(service)
                return
            }
            self.connect(name: name, endpoint: endpoint, using: .tcp) { [weak self] service in
                // Unresolved: still tell JS the name exists; it can retry or ask for the address.
                self?.onServiceFound?(service ?? Service(name: name, host: "", port: 0, addresses: []))
            }
        }
    }

    /// Opens a connection to the service and calls `completion` once with the resolved
    /// endpoint, or with nil if it could not connect within the timeout.
    private func connect(name: String, endpoint: NWEndpoint, using parameters: NWParameters,
                         completion: @escaping (Service?) -> Void) {
        resolvers.removeValue(forKey: name)?.cancel()
        let connection = NWConnection(to: endpoint, using: parameters)
        resolvers[name] = connection
        var done = false
        let finish: (Service?) -> Void = { [weak self] service in
            guard !done else { return }
            done = true
            if let self = self, self.resolvers[name] === connection {
                self.resolvers.removeValue(forKey: name)
            }
            // The handler captures this closure, which captures the connection: break the cycle.
            connection.stateUpdateHandler = nil
            connection.cancel()
            completion(service)
        }
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                finish(self?.describe(name: name, connection: connection))
            case .failed, .cancelled:
                finish(nil)
            default:
                break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + AirflashBonjour.resolveTimeout) {
            finish(nil)
        }
    }

    private func describe(name: String, connection: NWConnection) -> Service? {
        guard let remote = connection.currentPath?.remoteEndpoint,
              case .hostPort(host: let host, port: let port) = remote else {
            return nil
        }
        var hostText = ""
        var addresses: [String] = []
        switch host {
        case .ipv4(let address):
            hostText = "\(address)"
            addresses.append(hostText)
        case .ipv6(let address):
            // Drop the "%en0" zone suffix; it is not valid inside a URL.
            let text = "\(address)".components(separatedBy: "%").first ?? ""
            hostText = "[\(text)]"
            addresses.append(text)
        case .name(let hostname, _):
            hostText = hostname
        @unknown default:
            break
        }
        return Service(name: name, host: hostText, port: Int(port.rawValue), addresses: addresses)
    }
}
