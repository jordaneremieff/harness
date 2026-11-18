import AppKit
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Local file intake and bounded thumbnail rendering for the native composer.
///
/// Paths returned here are the only file references the page receives. Images that the
/// composer owns are copied into private storage; every other file stays a plain absolute
/// path chosen by the user. No network location is opened or resolved.
@MainActor
struct ComposerFiles {
    /// The composer state directory. Its private image directory is `Images` when the
    /// directory is already named `Composer`, and `Composer/Images` for the state root.
    let directory: URL

    init(directory: URL) {
        self.directory = directory.standardizedFileURL
    }

    /// Reads file URLs and image representations from the general pasteboard.
    func paste() throws -> [String] {
        let board = NSPasteboard.general
        let items = board.pasteboardItems ?? []

        var urls: [URL] = []
        for item in items where item.types.contains(.fileURL) {
            guard let value = item.string(forType: .fileURL) else { continue }
            if let url = URL(string: value), url.isFileURL {
                urls.append(url)
            } else if (value as NSString).isAbsolutePath {
                urls.append(URL(fileURLWithPath: value))
            }
        }
        if items.isEmpty,
           let objects = board.readObjects(forClasses: [NSURL.self],
                                           options: [.urlReadingFileURLsOnly: true]) as? [URL] {
            urls = objects.filter(\.isFileURL)
        }

        var result = try ingest(urls)
        var seen = Set(result)
        for item in items where !item.types.contains(.fileURL) {
            guard let path = try pasteImage(from: item), seen.insert(path).inserted else { continue }
            result.append(path)
        }
        return result
    }

    /// Asks for local files or directories. Directories are expanded to their regular files.
    func pick() async throws -> [String] {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.resolvesAliases = true
        panel.canCreateDirectories = false
        let response = await withCheckedContinuation { continuation in
            panel.begin { continuation.resume(returning: $0) }
        }
        guard response == .OK else { return [] }
        return try ingest(panel.urls)
    }

    /// Returns absolute paths for regular local files. Supported images are copied to private
    /// storage first; unsupported formats, oversized images and non-images keep their own path.
    func ingest(_ urls: [URL]) throws -> [String] {
        var result: [String] = []
        for url in urls {
            guard url.isFileURL else { continue }
            let file = url.standardizedFileURL
            guard (file.path as NSString).isAbsolutePath else { continue }
            try append(file, depth: 0, to: &result)
        }
        return result
    }

    /// Stores image bytes whose type is inferred from their format signature.
    func save(_ data: Data) throws -> String {
        guard data.count <= ComposerImages.maximumBytes else {
            throw ComposerFilesError.tooLarge(data.count, ComposerImages.maximumBytes)
        }
        guard let kind = ComposerImages.kind(from: data) else {
            throw ComposerFilesError.unsupportedImage
        }
        return try write(data, kind: kind)
    }

    /// Builds a PNG data URL from a local, non-symbolic-link regular image. Decoding is kept
    /// off the main actor and the thumbnail is limited to 128 pixels.
    func thumbnail(_ path: String) async -> String? {
        await Task.detached(priority: .utility) {
            ComposerImages.thumbnailData(for: path)
        }.value
    }

    private func append(_ url: URL, depth: Int, to result: inout [String]) throws {
        var info = stat()
        guard lstat(url.path, &info) == 0 else {
            if errno == ENOENT { throw CocoaError(.fileReadNoSuchFile) }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        switch info.st_mode & S_IFMT {
        case S_IFDIR:
            try appendDirectory(url, depth: depth, to: &result)
        case S_IFREG:
            if let path = try ingestFile(url) { result.append(path) }
        default:
            // Symbolic links and special files are not text references.
            break
        }
    }

    private func appendDirectory(_ url: URL, depth: Int, to result: inout [String]) throws {
        guard depth <= 8, result.count < 512 else { throw ComposerFilesError.tooManyFiles }
        let entries = try FileManager.default.contentsOfDirectory(
            at: url, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]
        )
        for entry in entries.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            try append(entry, depth: depth + 1, to: &result)
        }
    }

    private func ingestFile(_ url: URL) throws -> String? {
        var info = stat()
        guard lstat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return nil }
        let header = try ComposerImages.header(of: url, limit: 16)
        guard let signature = ComposerImages.kind(fromSignature: header) else {
            return url.path
        }
        guard info.st_size > 0, info.st_size <= Int64(ComposerImages.maximumBytes) else {
            return url.path
        }
        let data = try ComposerFileRead.read(
            url, limit: ComposerImages.maximumBytes
        )
        guard ComposerImages.kind(fromSignature: data) == signature else { return url.path }
        return try write(data, kind: signature)
    }

    private func pasteImage(from item: NSPasteboardItem) throws -> String? {
        let direct = [
            NSPasteboard.PasteboardType("public.png"),
            NSPasteboard.PasteboardType("public.jpeg"),
            NSPasteboard.PasteboardType("com.compuserve.gif"),
            NSPasteboard.PasteboardType("org.webmproject.webp"),
        ]
        for type in direct {
            guard let data = item.data(forType: type) else { continue }
            do { return try save(data) } catch { continue }
        }
        guard let tiff = item.data(forType: .tiff) else { return nil }
        if let png = ComposerImages.png(fromTIFF: tiff) {
            return try save(png)
        }
        // Some pasteboards label a non-TIFF image as TIFF; let the signature decide.
        return try? save(tiff)
    }

    private func write(_ data: Data, kind: ComposerImages.Kind) throws -> String {
        guard data.count <= ComposerImages.maximumBytes else {
            throw ComposerFilesError.tooLarge(data.count, ComposerImages.maximumBytes)
        }
        let images = imagesDirectory
        try ComposerImages.preparePrivateDirectory(images.deletingLastPathComponent())
        try ComposerImages.preparePrivateDirectory(images)
        return try ComposerImages.createFile(in: images, data: data, extension: kind.fileExtension)
    }

    private var imagesDirectory: URL {
        if directory.lastPathComponent.caseInsensitiveCompare("Composer") == .orderedSame {
            return directory.appendingPathComponent("Images", isDirectory: true)
        }
        return directory
            .appendingPathComponent("Composer", isDirectory: true)
            .appendingPathComponent("Images", isDirectory: true)
    }
}

private enum ComposerFilesError: LocalizedError {
    case tooLarge(Int, Int)
    case unsupportedImage
    case tooManyFiles

    var errorDescription: String? {
        switch self {
        case .tooLarge(let bytes, let limit):
            "The image has \(bytes) bytes; the limit is \(limit)."
        case .unsupportedImage:
            "The image format is not supported."
        case .tooManyFiles:
            "Too many files were selected at once."
        }
    }
}

/// Image signatures, private file writes and bounded thumbnails. None of these helpers retain
/// image bytes or expose them through logs or shared state.
private enum ComposerImages {
    static let maximumBytes = 20 * 1024 * 1024
    static let maximumPixels: UInt64 = 64_000_000

    enum Kind: String {
        case png
        case jpeg
        case gif
        case webp

        var fileExtension: String { self == .jpeg ? "jpg" : rawValue }

        init?(imageIOIdentifier: String) {
            switch imageIOIdentifier {
            case "public.png": self = .png
            case "public.jpeg": self = .jpeg
            case "com.compuserve.gif": self = .gif
            case "org.webmproject.webp": self = .webp
            default: return nil
            }
        }

        func matches(extension ext: String) -> Bool {
            switch self {
            case .png: ext == "png"
            case .jpeg: ext == "jpg" || ext == "jpeg"
            case .gif: ext == "gif"
            case .webp: ext == "webp"
            }
        }
    }

    static func kind(fromSignature data: Data) -> Kind? {
        let png: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        if data.count >= png.count, data.prefix(png.count).elementsEqual(png) { return .png }
        let jpeg: [UInt8] = [0xFF, 0xD8, 0xFF]
        if data.count >= jpeg.count, data.prefix(jpeg.count).elementsEqual(jpeg) { return .jpeg }
        if data.count >= 6,
           data.prefix(6).elementsEqual(Array("GIF87a".utf8)) || data.prefix(6).elementsEqual(Array("GIF89a".utf8)) {
            return .gif
        }
        if data.count >= 12,
           data.prefix(4).elementsEqual(Array("RIFF".utf8)),
           data.dropFirst(8).prefix(4).elementsEqual(Array("WEBP".utf8)) {
            return .webp
        }
        return nil
    }

    static func kind(from data: Data) -> Kind? {
        guard data.count > 0, data.count <= maximumBytes,
              let signature = kind(fromSignature: data),
              let source = CGImageSourceCreateWithData(
                data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary
              ),
              CGImageSourceGetCount(source) > 0,
              let identifier = CGImageSourceGetType(source) as String?,
              let detected = Kind(imageIOIdentifier: identifier),
              detected == signature else { return nil }
        return detected
    }

    static func header(of url: URL, limit: Int) throws -> Data {
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }
        var bytes = [UInt8](repeating: 0, count: limit)
        var total = 0
        while total < limit {
            let count = bytes.withUnsafeMutableBytes { buffer -> Int in
                guard let base = buffer.baseAddress else { return 0 }
                return Darwin.read(descriptor, base.advanced(by: total), limit - total)
            }
            if count > 0 {
                total += count
            } else if count == 0 {
                break
            } else if errno == EINTR {
                continue
            } else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        }
        return Data(bytes.prefix(total))
    }

    static func png(fromTIFF data: Data) -> Data? {
        guard data.count > 0, data.count <= maximumBytes,
              let source = CGImageSourceCreateWithData(
                data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary
              ),
              CGImageSourceGetCount(source) > 0,
              let identifier = CGImageSourceGetType(source) as String?,
              UTType(identifier)?.conforms(to: .tiff) == true,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.uint64Value,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.uint64Value,
              dimensionsAreBounded(width: width, height: height),
              let bitmap = NSBitmapImageRep(data: data),
              let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
        return png
    }

    static func thumbnailData(for path: String) -> String? {
        guard (path as NSString).isAbsolutePath else { return nil }
        let ext = (path as NSString).pathExtension.lowercased()
        guard ["png", "jpg", "jpeg", "gif", "webp"].contains(ext) else { return nil }
        let url = URL(fileURLWithPath: path)
        var info = stat()
        guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_size > 0, info.st_size <= Int64(maximumBytes) else { return nil }
        guard let data = try? ComposerFileRead.read(
            url, limit: maximumBytes
        ), let source = CGImageSourceCreateWithData(
            data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary
        ), CGImageSourceGetCount(source) > 0,
           let identifier = CGImageSourceGetType(source) as String?,
           let kind = Kind(imageIOIdentifier: identifier), kind.matches(extension: ext) else { return nil }

        if let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.uint64Value,
           let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.uint64Value,
           !dimensionsAreBounded(width: width, height: height) {
            return nil
        }

        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 128,
            kCGImageSourceShouldCacheImmediately: false,
        ]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output, "public.png" as CFString, 1, nil
        ) else { return nil }
        CGImageDestinationAddImage(destination, thumbnail, nil)
        guard CGImageDestinationFinalize(destination), output.length <= maximumBytes else { return nil }
        return "data:image/png;base64," + (output as Data).base64EncodedString()
    }

    static func dimensionsAreBounded(width: UInt64, height: UInt64) -> Bool {
        guard width > 0, height > 0 else { return false }
        let (pixels, overflow) = width.multipliedReportingOverflow(by: height)
        return !overflow && pixels <= maximumPixels
    }

    static func preparePrivateDirectory(_ url: URL) throws {
        var info = stat()
        if lstat(url.path, &info) != 0 {
            guard errno == ENOENT else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            try FileManager.default.createDirectory(
                at: url, withIntermediateDirectories: true,
                attributes: [.posixPermissions: NSNumber(value: 0o700)]
            )
        }
        guard lstat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
              info.st_uid == geteuid(), chmod(url.path, 0o700) == 0,
              lstat(url.path, &info) == 0, (info.st_mode & 0o077) == 0 else {
            throw CocoaError(.fileWriteNoPermission)
        }
    }

    static func createFile(in directory: URL, data: Data, extension ext: String) throws -> String {
        for _ in 0..<8 {
            let url = directory.appendingPathComponent(fileName(extension: ext))
            let descriptor = open(
                url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600
            )
            if descriptor < 0 {
                if errno == EEXIST { continue }
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            do {
                try handle.write(contentsOf: data)
                guard fchmod(descriptor, 0o600) == 0 else {
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                }
                try handle.close()
                return url.path
            } catch {
                try? handle.close()
                _ = unlink(url.path)
                throw error
            }
        }
        throw CocoaError(.fileWriteFileExists)
    }

    private static func fileName(extension ext: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let date = formatter.string(from: Date())
        let id = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8)).lowercased()
        return "\(date)-\(id).\(ext)"
    }
}
