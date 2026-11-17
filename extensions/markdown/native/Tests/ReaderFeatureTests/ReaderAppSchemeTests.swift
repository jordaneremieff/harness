import Foundation
import Testing
@testable import ReaderFeature

@Suite struct ReaderAppSchemeTests {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("reader-app-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    @Test func servesExplicitRootWithMIMEAndExactCSP() throws {
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let resources = ReaderAppResources(root: root)
        try Data("<!doctype html>".utf8).write(to: root.appendingPathComponent("index.html"))
        try FileManager.default.createDirectory(at: root.appendingPathComponent("styles"), withIntermediateDirectories: true)
        try Data("body {}".utf8).write(to: root.appendingPathComponent("styles/page.css"))
        let page = try resources.response(for: URL(string: "reader-app://app/index.html")!)
        #expect(page.data == Data("<!doctype html>".utf8))
        #expect(page.response.statusCode == 200)
        #expect(page.response.value(forHTTPHeaderField: "Content-Type") == "text/html; charset=utf-8")
        #expect(page.response.value(forHTTPHeaderField: "Content-Length") == String(page.data.count))
        #expect(page.response.value(forHTTPHeaderField: "Content-Security-Policy") == "default-src 'none'; script-src reader-app:; style-src reader-app:; img-src reader-asset: data:; font-src reader-app:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; require-trusted-types-for 'script'; trusted-types cmark")
        #expect(page.response.value(forHTTPHeaderField: "X-Content-Type-Options") == "nosniff")
        #expect(page.response.value(forHTTPHeaderField: "Cache-Control") == "no-store")
        #expect(try resources.response(for: URL(string: "reader-app://app/")!).data == page.data)
        let css = try resources.response(for: URL(string: "reader-app://app/styles/page.css")!)
        #expect(css.response.value(forHTTPHeaderField: "Content-Type") == "text/css; charset=utf-8")
        for (name, mime) in [("app.js", "text/javascript; charset=utf-8"), ("data.json", "application/json; charset=utf-8"),
                             ("font.woff", "font/woff"), ("font.woff2", "font/woff2"), ("font.ttf", "font/ttf"), ("font.otf", "font/otf")] {
            #expect(ReaderAppResources.mimeType(for: name) == mime)
            try Data([1, 2, 3]).write(to: root.appendingPathComponent(name))
            #expect(try resources.response(for: URL(string: "reader-app://app/\(name)")!).response.value(forHTTPHeaderField: "Content-Type") == mime)
        }
        #expect(ReaderAppResources.mimeType(for: "unknown.bin") == nil)
    }

    @Test func refusesTraversalWrongOriginsAndUnrecognisedResources() throws {
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("private".utf8).write(to: root.appendingPathComponent("private.txt"))
        let resources = ReaderAppResources(root: root)
        let addresses = [
            "reader-app://other/index.html", "https://app/index.html", "reader-app://app:80/index.html",
            "reader-app://user@app/index.html", "reader-app://app/index.html?q=1", "reader-app://app/index.html#fragment",
            "reader-app://app/../index.html", "reader-app://app/%2e%2e/index.html", "reader-app://app/styles/../index.html",
            "reader-app://app/%2Findex.html", "reader-app://app/styles%2fpage.css", "reader-app://app/%5cindex.html",
            "reader-app://app/%00index.html", "reader-app://app//index.html", "reader-app://app/private.txt",
            "reader-app://app/missing.js", "reader-app://app/styles/",
        ]
        for address in addresses {
            let url = try #require(URL(string: address))
            #expect(throws: (any Error).self, "Refuse \(address)") { try resources.response(for: url) }
        }
        let notFile = ReaderAppResources(root: URL(string: "https://example.org/")!)
        #expect(throws: (any Error).self) { try notFile.response(for: URL(string: "reader-app://app/index.html")!) }
    }

    @Test func refusesSymlinksAndDirectories() throws {
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let outside = try directory()
        defer { try? FileManager.default.removeItem(at: outside) }
        try Data("outside".utf8).write(to: outside.appendingPathComponent("secret.js"))
        try Data("inside".utf8).write(to: root.appendingPathComponent("real.js"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("outside.js"), withDestinationURL: outside.appendingPathComponent("secret.js"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("inside.js"), withDestinationURL: root.appendingPathComponent("real.js"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("styles"), withDestinationURL: outside)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("directory.js"), withIntermediateDirectories: true)
        let resources = ReaderAppResources(root: root)
        for path in ["outside.js", "inside.js", "styles/secret.js", "directory.js"] {
            #expect(throws: (any Error).self) { try resources.response(for: URL(string: "reader-app://app/\(path)")!) }
        }
        let rootLink = root.appendingPathComponent("root-link")
        try FileManager.default.createSymbolicLink(at: rootLink, withDestinationURL: outside)
        #expect(throws: (any Error).self) {
            try ReaderAppResources(root: rootLink).response(for: URL(string: "reader-app://app/secret.js")!)
        }
    }
}
