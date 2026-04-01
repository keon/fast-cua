import Foundation
import ApplicationServices

struct ComputerAction: Decodable {
    let type: String
    let x: Double?
    let y: Double?
    let endX: Double?
    let endY: Double?
    let deltaX: Double?
    let deltaY: Double?
    let text: String?
    let key: String?
    let button: String?
}

struct ExecutorResponse: Encodable {
    let accepted: Bool
    let message: String
    let actionId: String?
}

enum ExecutorError: Error {
    case invalidInput(String)
    case unsupportedKey(String)
    case permissionDenied
    case systemError(String)
}

let letterKeyCodes: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
    "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
    "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37,
    "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "`": 50
]

let namedKeyCodes: [String: CGKeyCode] = [
    "return": 36,
    "enter": 36,
    "tab": 48,
    "space": 49,
    "backspace": 51,
    "delete": 51,
    "escape": 53,
    "esc": 53,
    "command": 55,
    "cmd": 55,
    "shift": 56,
    "option": 58,
    "alt": 58,
    "control": 59,
    "ctrl": 59,
    "right": 124,
    "left": 123,
    "down": 125,
    "up": 126,
    "home": 115,
    "end": 119,
    "pageup": 116,
    "pagedown": 121
]

let modifierFlags: [String: CGEventFlags] = [
    "command": .maskCommand,
    "cmd": .maskCommand,
    "shift": .maskShift,
    "option": .maskAlternate,
    "alt": .maskAlternate,
    "control": .maskControl,
    "ctrl": .maskControl
]

func writeResponse(_ response: ExecutorResponse) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(response), let text = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data(text.utf8))
    }
}

func fail(_ message: String) -> Never {
    writeResponse(ExecutorResponse(accepted: false, message: message, actionId: nil))
    exit(1)
}

func point(x: Double?, y: Double?) throws -> CGPoint {
    guard let x, let y else {
        throw ExecutorError.invalidInput("Pointer action requires x and y.")
    }
    return CGPoint(x: x, y: y)
}

func cgButton(from action: ComputerAction) -> CGMouseButton {
    switch action.button ?? (action.type == "right_click" ? "right" : "left") {
    case "right": return .right
    case "middle": return .center
    default: return .left
    }
}

func mouseTypes(for button: CGMouseButton) -> (down: CGEventType, up: CGEventType, drag: CGEventType) {
    switch button {
    case .right:
        return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case .center:
        return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
    default:
        return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
    }
}

func postMouseMove(to target: CGPoint) throws {
    CGWarpMouseCursorPosition(target)
    guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: target, mouseButton: .left) else {
        throw ExecutorError.systemError("Failed to create mouse move event.")
    }
    event.post(tap: .cghidEventTap)
}

func postClick(at target: CGPoint, button: CGMouseButton, clickState: Int64 = 1) throws {
    try postMouseMove(to: target)
    let types = mouseTypes(for: button)
    guard let down = CGEvent(mouseEventSource: nil, mouseType: types.down, mouseCursorPosition: target, mouseButton: button),
          let up = CGEvent(mouseEventSource: nil, mouseType: types.up, mouseCursorPosition: target, mouseButton: button) else {
        throw ExecutorError.systemError("Failed to create click events.")
    }

    down.setIntegerValueField(.mouseEventClickState, value: clickState)
    up.setIntegerValueField(.mouseEventClickState, value: clickState)
    down.post(tap: .cghidEventTap)
    usleep(12000)
    up.post(tap: .cghidEventTap)
}

func postDoubleClick(at target: CGPoint, button: CGMouseButton) throws {
    try postClick(at: target, button: button, clickState: 1)
    usleep(18000)
    try postClick(at: target, button: button, clickState: 2)
}

func postDrag(from start: CGPoint, to end: CGPoint, button: CGMouseButton) throws {
    try postMouseMove(to: start)
    let types = mouseTypes(for: button)
    guard let down = CGEvent(mouseEventSource: nil, mouseType: types.down, mouseCursorPosition: start, mouseButton: button),
          let drag = CGEvent(mouseEventSource: nil, mouseType: types.drag, mouseCursorPosition: end, mouseButton: button),
          let up = CGEvent(mouseEventSource: nil, mouseType: types.up, mouseCursorPosition: end, mouseButton: button) else {
        throw ExecutorError.systemError("Failed to create drag events.")
    }

    down.post(tap: .cghidEventTap)
    usleep(16000)
    drag.post(tap: .cghidEventTap)
    usleep(16000)
    up.post(tap: .cghidEventTap)
}

func postScroll(deltaX: Double, deltaY: Double) throws {
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(deltaY), wheel2: Int32(deltaX), wheel3: 0) else {
        throw ExecutorError.systemError("Failed to create scroll event.")
    }
    event.post(tap: .cghidEventTap)
}

func postUnicodeCharacter(_ value: UniChar) throws {
    guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
        throw ExecutorError.systemError("Failed to create unicode keyboard events.")
    }

    var char = value
    keyDown.keyboardSetUnicodeString(stringLength: 1, unicodeString: &char)
    keyUp.keyboardSetUnicodeString(stringLength: 1, unicodeString: &char)
    keyDown.post(tap: .cghidEventTap)
    usleep(8000)
    keyUp.post(tap: .cghidEventTap)
}

func postText(_ text: String) throws {
    for value in text.utf16 {
        try postUnicodeCharacter(value)
        usleep(6000)
    }
}

func keyCode(for token: String) -> CGKeyCode? {
    let normalized = token.lowercased()
    if let named = namedKeyCodes[normalized] {
        return named
    }
    if normalized.count == 1, let char = normalized.first {
        return letterKeyCodes[char]
    }
    return nil
}

func keyEvent(keyCode: CGKeyCode, keyDown: Bool, flags: CGEventFlags) throws -> CGEvent {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: keyDown) else {
        throw ExecutorError.systemError("Failed to create key event.")
    }
    event.flags = flags
    return event
}

func postKeypress(_ key: String) throws {
    let tokens = key.split(separator: "+").map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty }
    guard let mainToken = tokens.last, !tokens.isEmpty else {
        throw ExecutorError.invalidInput("Keypress requires a non-empty key string.")
    }

    var flags: CGEventFlags = []
    for token in tokens.dropLast() {
        guard let flag = modifierFlags[token] else {
            throw ExecutorError.unsupportedKey(String(token))
        }
        flags.insert(flag)
    }

    guard let code = keyCode(for: String(mainToken)) else {
        throw ExecutorError.unsupportedKey(String(mainToken))
    }

    let down = try keyEvent(keyCode: code, keyDown: true, flags: flags)
    let up = try keyEvent(keyCode: code, keyDown: false, flags: flags)
    down.post(tap: .cghidEventTap)
    usleep(10000)
    up.post(tap: .cghidEventTap)
}

func perform(_ action: ComputerAction) throws {
    switch action.type {
    case "move":
        try postMouseMove(to: try point(x: action.x, y: action.y))
    case "click":
        try postClick(at: try point(x: action.x, y: action.y), button: cgButton(from: action))
    case "double_click":
        try postDoubleClick(at: try point(x: action.x, y: action.y), button: cgButton(from: action))
    case "right_click":
        try postClick(at: try point(x: action.x, y: action.y), button: .right)
    case "drag":
        let start = try point(x: action.x, y: action.y)
        let end = try point(x: action.endX, y: action.endY)
        try postDrag(from: start, to: end, button: cgButton(from: action))
    case "scroll":
        if action.x != nil && action.y != nil {
            try postMouseMove(to: try point(x: action.x, y: action.y))
        }
        try postScroll(deltaX: action.deltaX ?? 0, deltaY: action.deltaY ?? 0)
    case "type":
        guard let text = action.text else {
            throw ExecutorError.invalidInput("Type action requires text.")
        }
        try postText(text)
    case "keypress":
        guard let key = action.key else {
            throw ExecutorError.invalidInput("Keypress action requires key.")
        }
        try postKeypress(key)
    default:
        throw ExecutorError.invalidInput("Unsupported action type: \(action.type)")
    }
}

let inputData = FileHandle.standardInput.readDataToEndOfFile()

guard !inputData.isEmpty else {
    fail("No action payload received on stdin.")
}

do {
    guard AXIsProcessTrusted() else {
        throw ExecutorError.permissionDenied
    }

    let action = try JSONDecoder().decode(ComputerAction.self, from: inputData)
    try perform(action)
    writeResponse(ExecutorResponse(accepted: true, message: "Action executed on macOS.", actionId: UUID().uuidString))
} catch ExecutorError.invalidInput(let message) {
    fail(message)
} catch ExecutorError.unsupportedKey(let key) {
    fail("Unsupported key token: \(key)")
} catch ExecutorError.permissionDenied {
    fail("Accessibility permission is required. Enable access for your terminal or Node process in System Settings > Privacy & Security > Accessibility.")
} catch ExecutorError.systemError(let message) {
    fail(message)
} catch {
    fail(String(describing: error))
}
