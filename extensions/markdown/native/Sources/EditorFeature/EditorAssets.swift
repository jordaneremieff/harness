import CoreGraphics
import Darwin
import Foundation
import ImageIO
import MarkdownCore

/// Immutable private image bytes. Existing digest paths are reused only after exact comparison;
/// a full root refuses new images without evicting retained work.
public struct EditorAssetStore: Sendable {
    public let root: URL
    public init(root: URL) { self.root = root }

    public func stage(file: URL) throws -> StagedImage {
        guard MediaTypes.images[file.pathExtension.lowercased()] != nil else { throw FileSaveError.invalid("Choose a PNG, JPEG, GIF, WebP or SVG image.") }
        let bytes = try FileAccess.readRegularFile(file, limit: Limits.assetBytes, missing: .notFound(file.lastPathComponent))
        return try stage(data: bytes, extension: file.pathExtension)
    }

    public func stage(data: Data, extension ext: String) throws -> StagedImage {
        guard data.count <= Limits.assetBytes else { throw StoreError.tooLarge(name: "Image", bytes: data.count, limit: Limits.assetBytes) }
        let ext = ext.lowercased() == "jpeg" ? "jpg" : ext.lowercased()
        if ext == "tiff" || ext == "tif" { return try retain(Self.png(fromTIFF: data), extension: "png") }
        guard MediaTypes.images[ext] != nil else { throw FileSaveError.invalid("This image type is unsupported.") }
        return try retain(data, extension: ext)
    }

    public func resolver() -> any AssetResolving { StagedResolver(root: root) }

    private func retain(_ data: Data, extension ext: String) throws -> StagedImage {
        let manager = FileManager.default
        let requestedPath = root.path
        var path = requestedPath
        var info = stat()
        if lstat(path, &info) == 0 {
            guard info.st_mode & S_IFMT == S_IFDIR else { throw StoreError.outsideStore }
        } else {
            guard errno == ENOENT else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            try manager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        guard lstat(requestedPath, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else { throw StoreError.outsideStore }
        path = FileAccess.canonicalPath(requestedPath)
        let directory = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw StoreError.outsideStore }
        defer { close(directory) }
        var opened = stat()
        guard fstat(directory, &opened) == 0, opened.st_dev == info.st_dev, opened.st_ino == info.st_ino,
              fchmod(directory, 0o700) == 0 else { throw StoreError.outsideStore }
        if mkdirat(directory, "assets", 0o700) != 0, errno != EEXIST { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let assets = openat(directory, "assets", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard assets >= 0 else { throw StoreError.outsideStore }
        defer { close(assets) }
        guard fchmod(assets, 0o700) == 0 else { throw StoreError.outsideStore }
        guard flock(assets, LOCK_EX | LOCK_NB) == 0 else { throw FileSaveError.invalid("An image save is in progress. Retry this image after it finishes.") }
        defer { flock(assets, LOCK_UN) }
        let digest = Digest.sha256(data)
        let name = String(digest.dropFirst(7)) + "." + ext
        try Self.checkCapacity(assets, adding: name, bytes: data.count)
        try FileAssetTransfer.retain(data, components: ["assets", name], under: directory)
        return StagedImage(reference: "assets/" + name, relativePath: "assets/" + name, digest: digest, bytes: data.count)
    }

    private static func checkCapacity(_ descriptor: Int32, adding name: String, bytes: Int) throws {
        let copy = dup(descriptor)
        guard copy >= 0 else { throw POSIXError(.EMFILE) }
        guard let directory = fdopendir(copy) else { close(copy); throw POSIXError(.EIO) }
        defer { closedir(directory) }
        var entries = 0, count = 0, total = 0, exists = false
        while let entry = readdir(directory) {
            entries += 1
            guard entries <= 128 else { throw FileSaveError.invalid("The private image directory exceeds its scan bound.") }
            let item = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            if item == "." || item == ".." { continue }
            var info = stat()
            guard fstatat(descriptor, item, &info, AT_SYMLINK_NOFOLLOW) == 0, info.st_mode & S_IFMT == S_IFREG,
                  info.st_size >= 0, info.st_size <= Limits.assetBytes else { throw StoreError.outsideStore }
            count += 1; total += Int(info.st_size)
            exists = exists || item == name
            guard count <= 64, total <= 32 * 1024 * 1024 else { throw FileSaveError.invalid("The private image store is full; no image was removed.") }
        }
        guard exists || (count < 64 && total + bytes <= 32 * 1024 * 1024) else {
            throw FileSaveError.invalid("The private image store is full; no image was removed.")
        }
    }

    static func checkTIFFDimensions(width: UInt64, height: UInt64) throws {
        let (pixels, overflow) = width.multipliedReportingOverflow(by: height)
        guard width > 0, height > 0, !overflow, pixels <= 64_000_000 else {
            throw StoreError.tooLarge(name: "TIFF image pixels", bytes: Int(clamping: pixels), limit: 64_000_000)
        }
    }

    private static func png(fromTIFF data: Data) throws -> Data {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.uint64Value,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.uint64Value else {
            throw FileSaveError.invalid("The TIFF image has no readable dimensions.")
        }
        try checkTIFFDimensions(width: width, height: height)
        guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw FileSaveError.invalid("The TIFF image cannot be decoded.") }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, "public.png" as CFString, 1, nil) else { throw FileSaveError.invalid("The PNG encoder is unavailable.") }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw FileSaveError.invalid("The image could not be converted to PNG.") }
        guard output.length <= Limits.assetBytes else { throw StoreError.tooLarge(name: "Converted image", bytes: output.length, limit: Limits.assetBytes) }
        return output as Data
    }
}

private struct StagedResolver: AssetResolving {
    let root: URL
    func resolve(_ reference: String) -> AssetResolution {
        var info = stat()
        guard lstat(root.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else { return .unavailable(reason: "outside-root") }
        let path = FileAccess.canonicalPath(root.path), assets = path + "/assets"
        guard FileAccess.canonicalPath(assets) == assets else { return .unavailable(reason: "outside-root") }
        let parts = reference.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0] == "assets" else { return .unavailable(reason: "invalid-staged-reference") }
        let name = String(parts[1]) as NSString, hash = name.deletingPathExtension
        guard hash.utf8.count == 64, hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              MediaTypes.images[name.pathExtension] != nil,
              case .local(var asset) = DirectoryAssetResolver(directory: root).resolve(reference) else { return .unavailable(reason: "missing") }
        asset.expectedDigest = "sha256:" + hash; asset.expectedBytes = asset.bytes
        return .local(asset)
    }
}
