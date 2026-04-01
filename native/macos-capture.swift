import Foundation
import CoreGraphics

struct DisplayInfo: Encodable {
    let id: UInt32
    let width: Int
    let height: Int
    let originX: Int
    let originY: Int
    let isMain: Bool
}

struct CaptureResponse: Encodable {
    let path: String
    let base64Png: String
    let display: DisplayInfo
}

enum CaptureError: Error {
    case permissionDenied
    case invalidDisplay(String)
    case imageUnavailable(String)
}

func listActiveDisplays() throws -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    let maxDisplays: UInt32 = 16
    var active = [CGDirectDisplayID](repeating: 0, count: Int(maxDisplays))
    let result = CGGetActiveDisplayList(maxDisplays, &active, &count)
    guard result == .success else {
        throw CaptureError.imageUnavailable("Failed to enumerate displays.")
    }
    return Array(active.prefix(Int(count)))
}

func encodedDisplayInfo(displays: [CGDirectDisplayID]) -> [DisplayInfo] {
    let main = CGMainDisplayID()
    return displays.map { display in
        let bounds = CGDisplayBounds(display)
        return DisplayInfo(
            id: display,
            width: Int(bounds.width),
            height: Int(bounds.height),
            originX: Int(bounds.origin.x),
            originY: Int(bounds.origin.y),
            isMain: display == main
        )
    }
}

func chooseDisplay(displays: [CGDirectDisplayID], displayId: Int?) throws -> (display: CGDirectDisplayID, ordinal: Int) {
    guard let displayId else {
        let main = CGMainDisplayID()
        let ordinal = (displays.firstIndex(of: main) ?? 0) + 1
        return (main, ordinal)
    }

    if let exactIndex = displays.firstIndex(where: { Int($0) == displayId }) {
        return (displays[exactIndex], exactIndex + 1)
    }

    if displayId >= 1 && displayId <= displays.count {
        return (displays[displayId - 1], displayId)
    }

    throw CaptureError.invalidDisplay("Display id \(displayId) was not found.")
}

func ensureCapturePermission() throws {
    if CGPreflightScreenCaptureAccess() {
        return
    }

    _ = CGRequestScreenCaptureAccess()
    if !CGPreflightScreenCaptureAccess() {
        throw CaptureError.permissionDenied
    }
}

func capturePngData(displayOrdinal: Int) throws -> (path: String, data: Data) {
    let filePath = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("fast-cua-\(UUID().uuidString).png")
        .path

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-tpng", "-D\(displayOrdinal)", filePath]

    let errorPipe = Pipe()
    process.standardError = errorPipe
    try process.run()
    process.waitUntilExit()

    guard process.terminationStatus == 0 else {
        let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
        let errorText = String(data: errorData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        throw CaptureError.imageUnavailable(errorText?.isEmpty == false ? errorText! : "Could not create image from display.")
    }

    let data = try Data(contentsOf: URL(fileURLWithPath: filePath))
    return (filePath, data)
}

func writeJson<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(value)
    FileHandle.standardOutput.write(data)
}

let args = CommandLine.arguments

do {
    let displays = try listActiveDisplays()

    if args.contains("--list-displays") {
        try writeJson(encodedDisplayInfo(displays: displays))
        exit(0)
    }

    let displayIndex = args.firstIndex(of: "--display-id")
    let requestedDisplayId = displayIndex.flatMap { index -> Int? in
        guard args.indices.contains(index + 1) else { return nil }
        return Int(args[index + 1])
    }

    try ensureCapturePermission()
    let selected = try chooseDisplay(displays: displays, displayId: requestedDisplayId)
    let capture = try capturePngData(displayOrdinal: selected.ordinal)

    let selectedInfo = encodedDisplayInfo(displays: [selected.display])[0]
    try writeJson(CaptureResponse(path: capture.path, base64Png: capture.data.base64EncodedString(), display: selectedInfo))
} catch CaptureError.permissionDenied {
    fputs("Screen Recording permission is required. Enable access for your terminal or Node host in System Settings > Privacy & Security > Screen Recording.\n", stderr)
    exit(1)
} catch CaptureError.invalidDisplay(let message) {
    fputs("\(message)\n", stderr)
    exit(1)
} catch CaptureError.imageUnavailable(let message) {
    fputs("\(message)\n", stderr)
    exit(1)
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
