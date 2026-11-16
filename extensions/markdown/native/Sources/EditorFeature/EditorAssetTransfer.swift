import Darwin
import MarkdownCore

/// Private staged images supplement, but never widen, the saved document's resolver.
public struct EditorDraftAssetResolver: AssetResolving {
    private let base: any AssetResolving
    private let root: URL
    private let images: [String: StagedImage]

    public init(base: any AssetResolving, root: URL, images: [StagedImage]) {
        self.base = base; self.root = root
        self.images = Dictionary(images.map { ($0.reference, $0) }, uniquingKeysWith: { first, _ in first })
    }

    public func resolve(_ reference: String) -> AssetResolution {
        guard let image = images[reference] else { return base.resolve(reference) }
        guard image.relativePath.hasPrefix("assets/"),
              case .local(var asset) = DirectoryAssetResolver(directory: root).resolve(image.relativePath) else {
            return .unavailable(reason: "staged-image-unavailable")
        }
        asset.expectedDigest = image.digest; asset.expectedBytes = image.bytes
        return .local(asset)
    }
}

public struct FileAssetTransferResult: Sendable {
    public let copied: Int
    public let unavailable: Int
    public let external: Int
}

/// Copies only images used by this source, under their existing relative references. Open
/// directory descriptors and no-follow exclusive writes prevent a path from escaping the chosen
/// directory or replacing existing user files. Source text is never rewritten.
public enum FileAssetTransfer {
    public static func copy(source: String, resolver: any AssetResolving, beside file: URL) throws -> FileAssetTransferResult {
        guard source.utf8.count <= Limits.sourceBytes else { throw FileSaveError.invalid("The source exceeds the editor limit.") }
        let root = FileAccess.canonicalPath(file.deletingLastPathComponent().path)
        let descriptor = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw FileSaveError.invalid("The chosen image directory is unavailable.") }
        defer { close(descriptor) }
        let rendered = MarkdownRenderer.render(source, resolver: resolver)
        var references = Set<String>(), copied = 0, unavailable = 0, external = 0, bytes = 0
        for image in rendered.images where references.insert(image.reference).inserted {
            switch image.source {
            case .local(let token):
                guard let asset = rendered.assets[token] else { throw FileSaveError.invalid("A local image lost its resolved identity.") }
                guard copied < 64 else { throw FileSaveError.invalid("The source uses more than 64 local image references.") }
                let data = try asset.readData()
                guard bytes + data.count <= 32 * 1024 * 1024 else { throw FileSaveError.invalid("The local images exceed 32 MiB.") }
                let components = try destination(image.reference)
                try retain(data, components: components, under: descriptor)
                copied += 1; bytes += data.count
            case .unavailable: unavailable += 1
            case .external: external += 1
            case .embedded: break
            }
        }
        return FileAssetTransferResult(copied: copied, unavailable: unavailable, external: external)
    }

    private static func destination(_ reference: String) throws -> [String] {
        let path = String(reference.prefix { $0 != "?" && $0 != "#" })
        guard let decoded = path.removingPercentEncoding, !decoded.isEmpty, !decoded.hasPrefix("/"), !decoded.utf8.contains(0) else {
            throw FileSaveError.invalid("An image has no safe relative destination.")
        }
        var components: [String] = []
        for part in decoded.split(separator: "/") {
            if part == "." { continue }
            if part == ".." {
                guard !components.isEmpty else { throw FileSaveError.invalid("An image destination would leave the chosen directory.") }
                components.removeLast()
            } else { components.append(String(part)) }
        }
        guard !components.isEmpty, components.count <= 32 else { throw FileSaveError.invalid("The image destination is too deep.") }
        return components
    }

    static func retain(_ data: Data, components: [String], under root: Int32) throws {
        var directory = dup(root)
        guard directory >= 0 else { throw POSIXError(.EMFILE) }
        defer { close(directory) }
        for component in components.dropLast() {
            if mkdirat(directory, component, 0o700) != 0, errno != EEXIST { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            let next = openat(directory, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard next >= 0 else { throw FileSaveError.invalid("An image destination directory is not a real directory.") }
            close(directory); directory = next
        }
        let name = components.last!
        let output = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        if output < 0 {
            guard errno == EEXIST else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            let input = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard input >= 0 else { throw FileSaveError.invalid("An existing image destination is not a regular file.") }
            defer { close(input) }
            var info = stat()
            guard fstat(input, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size == data.count else {
                throw FileSaveError.invalid("An existing file conflicts with an image destination.")
            }
            var existing = Data(count: data.count)
            let count = existing.withUnsafeMutableBytes { buffer -> Int in
                var offset = 0
                while offset < buffer.count {
                    let readCount = Darwin.read(input, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                    if readCount < 0, errno == EINTR { continue }
                    if readCount <= 0 { break }
                    offset += readCount
                }
                return offset
            }
            guard count == data.count, existing == data else { throw FileSaveError.invalid("An existing file conflicts with an image destination.") }
            return
        }
        var created = stat()
        guard fstat(output, &created) == 0 else { close(output); throw POSIXError(.EIO) }
        var complete = false
        defer {
            close(output)
            if !complete {
                var current = stat()
                if fstatat(directory, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
                   current.st_dev == created.st_dev, current.st_ino == created.st_ino { unlinkat(directory, name, 0) }
            }
        }
        try data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(output, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
                offset += count
            }
        }
        guard fsync(output) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        complete = true
    }
}
