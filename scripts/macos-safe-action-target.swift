import AppKit
import Foundation

final class AcceptanceDelegate: NSObject, NSApplicationDelegate {
    private let resultPath: String
    private let screenIndex: Int
    private var window: NSWindow?
    private var status: NSTextField?

    init(resultPath: String, screenIndex: Int) {
        self.resultPath = resultPath
        self.screenIndex = screenIndex
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 0, y: 0, width: 520, height: 240)
        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "小蛇 Phase 7 安全验收"
        if NSScreen.screens.indices.contains(screenIndex) {
            let primary = NSScreen.screens[screenIndex]
            window.setFrameOrigin(NSPoint(
                x: primary.visibleFrame.minX + 180,
                y: primary.visibleFrame.maxY - frame.height - 180
            ))
        }

        let title = NSTextField(labelWithString: "受控测试窗口")
        title.font = NSFont.boldSystemFont(ofSize: 24)
        title.alignment = .center
        title.frame = NSRect(x: 60, y: 165, width: 400, height: 34)

        let status = NSTextField(labelWithString: "XIAOSHE_SAFE_STATUS: waiting")
        status.font = NSFont.systemFont(ofSize: 15)
        status.alignment = .center
        status.frame = NSRect(x: 60, y: 120, width: 400, height: 28)

        let button = NSButton(title: "XIAOSHE_SAFE_BUTTON", target: self, action: #selector(accept))
        button.bezelStyle = .rounded
        button.frame = NSRect(x: 150, y: 54, width: 220, height: 44)
        button.setAccessibilityIdentifier("XIAOSHE_SAFE_BUTTON")

        window.contentView?.addSubview(title)
        window.contentView?.addSubview(status)
        window.contentView?.addSubview(button)
        self.window = window
        self.status = status
        window.makeKeyAndOrderFront(nil)
        NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func accept() {
        do {
            try Data("XS_PHASE7_MACOS_ACTION_OK\n".utf8).write(
                to: URL(fileURLWithPath: resultPath),
                options: .atomic
            )
            status?.stringValue = "XIAOSHE_SAFE_STATUS: clicked"
        } catch {
            status?.stringValue = "XIAOSHE_SAFE_STATUS: failed"
        }
    }
}

guard CommandLine.arguments.count == 2 || CommandLine.arguments.count == 3,
      let screenIndex = Int(CommandLine.arguments.count == 3 ? CommandLine.arguments[2] : "0") else {
    FileHandle.standardError.write(Data("usage: macos-safe-action-target <result-path> [screen-index]\n".utf8))
    exit(64)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AcceptanceDelegate(resultPath: CommandLine.arguments[1], screenIndex: screenIndex)
app.delegate = delegate
app.run()
