import Darwin
import Foundation
import WebKit

/// Reads only regular, explicitly typed files beneath the app's web resource directory.
struct AppResources: Sendable {
    static let scheme = "config-app"
    static let contentSecurityPolicy = "default-src 'none'; script-src config-app:; style-src config-app:; img-src data:; font-src config-app:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; require-trusted-types-for 'script'"
    let root: URL

    init(root: URL) { self.root = root }

    func response(for url: URL) throws -> (response: HTTPURLResponse, data: Data) {
        let components = try Self.pathComponents(for: url)
        guard root.isFileURL, let name = components.last, let mime = Self.mimeType(for: name) else {
            throw URLError(.unsupportedURL)
        }
        // Each open is relative to a held directory descriptor, so a replaced path cannot
        // redirect a later read outside the resource tree. O_NOFOLLOW refuses symlinks.
        var directory = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw URLError(.fileDoesNotExist) }
        defer { Darwin.close(directory) }
        for component in components.dropLast() {
            let next = openat(directory, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard next >= 0 else { throw URLError(.noPermissionsToReadFile) }
            Darwin.close(directory)
            directory = next
        }
        let descriptor = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { throw URLError(.fileDoesNotExist) }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? file.close() }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG else {
            throw URLError(.noPermissionsToReadFile)
        }
        let data = try file.readToEnd() ?? Data()
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            "Content-Security-Policy": Self.contentSecurityPolicy,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            throw URLError(.badServerResponse)
        }
        return (response, data)
    }

    static func mimeType(for path: String) -> String? {
        switch (path as NSString).pathExtension.lowercased() {
        case "html": "text/html; charset=utf-8"
        case "css": "text/css; charset=utf-8"
        case "js", "ts": "text/javascript; charset=utf-8"
        case "json": "application/json; charset=utf-8"
        case "woff": "font/woff"
        case "woff2": "font/woff2"
        case "ttf": "font/ttf"
        case "otf": "font/otf"
        default: nil
        }
    }

    private static func pathComponents(for url: URL) throws -> [String] {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == scheme, parts.host == "app", parts.user == nil, parts.password == nil,
              parts.port == nil, parts.fragment == nil,
              parts.query == nil || parts.path == "/index.html" else { throw URLError(.unsupportedURL) }
        let path = parts.percentEncodedPath
        guard path.hasPrefix("/"), path.utf8.count <= 4096 else { throw URLError(.badURL) }

        let raw = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
        guard !raw.isEmpty else { throw URLError(.badURL) }
        return try raw.map { component in
            guard let value = String(component).removingPercentEncoding, !value.isEmpty,
                  value != ".", value != "..", !value.contains("/"), !value.contains("\\"),
                  !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
                throw URLError(.noPermissionsToReadFile)
            }
            return value
        }
    }
}

/// WebKit's custom-scheme adapter. Resource validation remains testable without a web view.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    let resources: AppResources
    init(resources: AppResources) { self.resources = resources; super.init() }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        do {
            guard urlSchemeTask.request.httpMethod == nil || urlSchemeTask.request.httpMethod == "GET",
                  let url = urlSchemeTask.request.url else { throw URLError(.unsupportedURL) }
            let result = try resources.response(for: url)
            urlSchemeTask.didReceive(result.response)
            urlSchemeTask.didReceive(result.data)
            urlSchemeTask.didFinish()
        } catch {
            urlSchemeTask.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        // Reads finish synchronously before WebKit issues another callback.
    }
}
