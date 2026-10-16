import UIKit
import UniformTypeIdentifiers

/// The "Share -> AirFlash" sheet. Copies every shared file into the App Group container
/// (Inbox/), collects URLs and text, writes the result where @capgo/capacitor-share-target
/// reads it (UserDefaults suite = App Group, key "share-target-data"), opens airflash://share
/// and dismisses itself. Files are copied file-to-file; extension memory is tight.
class ShareViewController: UIViewController {
    private let appGroupId = "group.app.airflash.ios"
    private let appURL = URL(string: "airflash://share")!

    private let collect = DispatchQueue(label: "airflash.share.collect")
    private var texts: [String] = []
    private var files: [[String: Any]] = []
    private var finished = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let label = UILabel()
        label.text = "Sending to AirFlash…"
        label.font = .preferredFont(forTextStyle: .headline)
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24)
        ])

        gatherAttachments()
    }

    private func gatherAttachments() {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let title = items.compactMap { $0.attributedTitle?.string }.first ?? ""

        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            finish(title: title)
            return
        }
        let inbox = container.appendingPathComponent("Inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        pruneStale(inbox)

        let group = DispatchGroup()
        for item in items {
            for provider in item.attachments ?? [] {
                group.enter()
                handle(provider, inbox: inbox) { group.leave() }
            }
        }
        group.notify(queue: .main) { [weak self] in
            self?.finish(title: title)
        }
    }

    private func handle(_ provider: NSItemProvider, inbox: URL, done: @escaping () -> Void) {
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            // Files app and friends hand over a file URL; copy it straight across.
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { [weak self] item, _ in
                if let url = self?.asURL(item) {
                    self?.store(fileAt: url, inbox: inbox, suggestedName: provider.suggestedName)
                }
                done()
            }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] item, _ in
                if let url = self?.asURL(item) {
                    self?.add(text: url.absoluteString)
                }
                done()
            }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
            copyFile(provider, typeIdentifier: UTType.movie.identifier, inbox: inbox, done: done)
        } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            copyFile(provider, typeIdentifier: UTType.image.identifier, inbox: inbox, done: done)
        } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { [weak self] item, _ in
                if let text = item as? String {
                    self?.add(text: text)
                } else if let attributed = item as? NSAttributedString {
                    self?.add(text: attributed.string)
                } else if let data = item as? Data, let text = String(data: data, encoding: .utf8) {
                    self?.add(text: text)
                }
                done()
            }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
            copyFile(provider, typeIdentifier: UTType.data.identifier, inbox: inbox, done: done)
        } else {
            done()
        }
    }

    /// Asks the provider for a file on disk (no bytes in memory) and copies it into the inbox.
    /// The temporary file only exists during the completion handler, so the copy is synchronous.
    private func copyFile(_ provider: NSItemProvider, typeIdentifier: String, inbox: URL, done: @escaping () -> Void) {
        provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] url, _ in
            guard let self = self else {
                done()
                return
            }
            if let url = url, self.store(fileAt: url, inbox: inbox, suggestedName: provider.suggestedName) {
                done()
            } else {
                self.loadItemFallback(provider, typeIdentifier: typeIdentifier, inbox: inbox, done: done)
            }
        }
    }

    /// Some providers (screenshots, images copied from the clipboard) only hand over a UIImage.
    /// This is the one place the whole file passes through memory.
    private func loadItemFallback(_ provider: NSItemProvider, typeIdentifier: String, inbox: URL, done: @escaping () -> Void) {
        provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { [weak self] item, _ in
            guard let self = self else {
                done()
                return
            }
            if let url = self.asURL(item) {
                self.store(fileAt: url, inbox: inbox, suggestedName: provider.suggestedName)
            } else if let image = item as? UIImage, let data = image.pngData() {
                let base = (provider.suggestedName as NSString?)?.deletingPathExtension ?? ""
                let name = (base.isEmpty ? "image" : base) + ".png"
                let dest = inbox.appendingPathComponent(UUID().uuidString + "_" + name)
                do {
                    try data.write(to: dest, options: .atomic)
                    self.add(file: dest, name: name)
                } catch {
                    // Nothing to report to the user from here; the app simply receives fewer files.
                }
            }
            done()
        }
    }

    private func asURL(_ item: NSSecureCoding?) -> URL? {
        if let url = item as? URL {
            return url
        }
        if let data = item as? Data, let url = URL(dataRepresentation: data, relativeTo: nil) {
            return url
        }
        return nil
    }

    @discardableResult
    private func store(fileAt source: URL, inbox: URL, suggestedName: String?) -> Bool {
        var name = source.lastPathComponent
        if name.isEmpty || name.hasPrefix(".") {
            if let suggested = suggestedName, !suggested.isEmpty {
                name = suggested
            } else {
                name = "file"
            }
        }
        let dest = inbox.appendingPathComponent(UUID().uuidString + "_" + name)
        let scoped = source.startAccessingSecurityScopedResource()
        defer {
            if scoped {
                source.stopAccessingSecurityScopedResource()
            }
        }
        do {
            try FileManager.default.copyItem(at: source, to: dest)
        } catch {
            return false
        }
        add(file: dest, name: name)
        return true
    }

    /// Copies the app never got to delete (killed with its send sheet open, never relaunched) would
    /// otherwise sit in the shared container forever. Anything younger than an hour may still be
    /// feeding one of the app's background uploads, so it is left alone.
    private func pruneStale(_ inbox: URL) {
        let cutoff = Date().addingTimeInterval(-3600)
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: inbox, includingPropertiesForKeys: [.contentModificationDateKey], options: []) else {
            return
        }
        for entry in entries {
            let modified = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            if modified < cutoff {
                try? fm.removeItem(at: entry)
            }
        }
    }

    private func add(file url: URL, name: String) {
        let mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
        collect.sync {
            // "size" is an extra key; the plugin passes the dictionaries through untouched.
            files.append(["uri": url.absoluteString, "name": name, "mimeType": mimeType, "size": size])
        }
    }

    private func add(text: String) {
        collect.sync {
            texts.append(text)
        }
    }

    private func finish(title: String) {
        guard !finished else { return }
        finished = true

        var payload: [String: Any] = ["title": title]
        collect.sync {
            payload["texts"] = texts
            payload["files"] = files
        }
        if let defaults = UserDefaults(suiteName: appGroupId) {
            defaults.set(payload, forKey: "share-target-data")
            defaults.synchronize()
        }

        openHostApp()
        // Give the open request a moment before the extension goes away.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        }
    }

    /// Extensions cannot call UIApplication.shared.open; walk the responder chain to the host
    /// UIApplication, which still responds to openURL:. If that stops working on a future iOS,
    /// the plugin re-reads the App Group when the user opens AirFlash themselves.
    private func openHostApp() {
        let selector = sel_registerName("openURL:")
        var responder: UIResponder? = self
        while let current = responder {
            if current.responds(to: selector) {
                current.perform(selector, with: appURL)
                return
            }
            responder = current.next
        }
        extensionContext?.open(appURL, completionHandler: nil)
    }
}
