import Foundation
import ApplicationServices
import AppKit
import Carbon

struct ObservedEvent: Encodable {
    let timestamp: String
    let type: String
    let x: Int?
    let y: Int?
    let deltaX: Int?
    let deltaY: Int?
    let key: String?
    let modifiers: [String]?
    let frontmostApp: String?
    let frontmostBundleId: String?
}

enum ObserverError: Error {
    case permissionDenied
    case tapCreateFailed
}

func isoTimestamp() -> String {
    ISO8601DateFormatter().string(from: Date())
}

func writeEvent(_ event: ObservedEvent) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(event), let json = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((json + "\n").utf8))
    }
}

func currentFrontmostApp() -> (name: String?, bundleId: String?) {
    let app = NSWorkspace.shared.frontmostApplication
    return (app?.localizedName, app?.bundleIdentifier)
}

func modifierNames(from flags: CGEventFlags) -> [String] {
    var modifiers: [String] = []
    if flags.contains(.maskCommand) { modifiers.append("cmd") }
    if flags.contains(.maskShift) { modifiers.append("shift") }
    if flags.contains(.maskAlternate) { modifiers.append("option") }
    if flags.contains(.maskControl) { modifiers.append("ctrl") }
    return modifiers
}

let specialKeys: [CGKeyCode: String] = [
    36: "enter",
    48: "tab",
    49: "space",
    51: "backspace",
    53: "escape",
    123: "left",
    124: "right",
    125: "down",
    126: "up"
]

func keyName(from event: CGEvent) -> String? {
    let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
    if let special = specialKeys[keyCode] {
        return special
    }

    guard CGEventSource(stateID: .combinedSessionState) != nil else {
        return String(keyCode)
    }

    let layout = TISCopyCurrentKeyboardLayoutInputSource().takeRetainedValue()
    guard let rawLayoutData = TISGetInputSourceProperty(layout, kTISPropertyUnicodeKeyLayoutData) else {
        return String(keyCode)
    }

    let data = unsafeBitCast(rawLayoutData, to: CFData.self) as Data
    return data.withUnsafeBytes { rawBuffer in
        guard let pointer = rawBuffer.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else {
            return String(keyCode)
        }

        var deadKeyState: UInt32 = 0
        let maxStringLength: Int = 4
        var actualLength: Int = 0
        var chars = [UniChar](repeating: 0, count: maxStringLength)

        let status = UCKeyTranslate(
            pointer,
            keyCode,
            UInt16(kUCKeyActionDisplay),
            0,
            UInt32(LMGetKbdType()),
            UInt32(kUCKeyTranslateNoDeadKeysBit),
            &deadKeyState,
            maxStringLength,
            &actualLength,
            &chars
        )

        guard status == noErr, actualLength > 0 else {
            return String(keyCode)
        }

        return String(utf16CodeUnits: chars, count: actualLength).lowercased()
    }
}

let eventMask = (
    (1 << CGEventType.leftMouseDown.rawValue)
    | (1 << CGEventType.leftMouseUp.rawValue)
    | (1 << CGEventType.rightMouseDown.rawValue)
    | (1 << CGEventType.rightMouseUp.rawValue)
    | (1 << CGEventType.otherMouseDown.rawValue)
    | (1 << CGEventType.otherMouseUp.rawValue)
    | (1 << CGEventType.scrollWheel.rawValue)
    | (1 << CGEventType.keyDown.rawValue)
)

func makeObservedEvent(type: String, event: CGEvent, key: String? = nil, deltaX: Int? = nil, deltaY: Int? = nil) -> ObservedEvent {
    let location = event.location
    let frontmost = currentFrontmostApp()
    let modifiers = modifierNames(from: event.flags)

    return ObservedEvent(
        timestamp: isoTimestamp(),
        type: type,
        x: Int(location.x.rounded()),
        y: Int(location.y.rounded()),
        deltaX: deltaX,
        deltaY: deltaY,
        key: key,
        modifiers: modifiers.isEmpty ? nil : modifiers,
        frontmostApp: frontmost.name,
        frontmostBundleId: frontmost.bundleId
    )
}

func callback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, userInfo: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    switch type {
    case .leftMouseDown:
        writeEvent(makeObservedEvent(type: "left_mouse_down", event: event))
    case .leftMouseUp:
        writeEvent(makeObservedEvent(type: "left_mouse_up", event: event))
    case .rightMouseDown:
        writeEvent(makeObservedEvent(type: "right_mouse_down", event: event))
    case .rightMouseUp:
        writeEvent(makeObservedEvent(type: "right_mouse_up", event: event))
    case .otherMouseDown:
        writeEvent(makeObservedEvent(type: "middle_mouse_down", event: event))
    case .otherMouseUp:
        writeEvent(makeObservedEvent(type: "middle_mouse_up", event: event))
    case .scrollWheel:
        let deltaY = Int(event.getIntegerValueField(.scrollWheelEventDeltaAxis1))
        let deltaX = Int(event.getIntegerValueField(.scrollWheelEventDeltaAxis2))
        writeEvent(makeObservedEvent(type: "scroll", event: event, deltaX: deltaX, deltaY: deltaY))
    case .keyDown:
        writeEvent(makeObservedEvent(type: "key_down", event: event, key: keyName(from: event)))
    default:
        break
    }

    return Unmanaged.passUnretained(event)
}

do {
    guard AXIsProcessTrusted() else {
        throw ObserverError.permissionDenied
    }

    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .defaultTap,
        eventsOfInterest: CGEventMask(eventMask),
        callback: callback,
        userInfo: nil
    ) else {
        throw ObserverError.tapCreateFailed
    }

    let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    CFRunLoopRun()
} catch ObserverError.permissionDenied {
    fputs("Accessibility permission is required to observe keyboard and mouse events. Enable access for your terminal or Node process in System Settings > Privacy & Security > Accessibility.\n", stderr)
    exit(1)
} catch ObserverError.tapCreateFailed {
    fputs("Failed to create macOS event tap.\n", stderr)
    exit(1)
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
