import AppKit
import Foundation

private let fixtureTitle = "小蛇桌面动作验收"

@MainActor
final class KeyReceiverView: NSView {
    var text = "" {
        didSet {
            setNeedsDisplay(bounds)
            onChange?(text)
        }
    }
    var onChange: ((String) -> Void)?

    override var acceptsFirstResponder: Bool { true }

    override func keyDown(with event: NSEvent) {
        guard let characters = event.characters, !characters.isEmpty else { return }
        text += characters
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlBackgroundColor.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 7, yRadius: 7).fill()
        NSColor.separatorColor.setStroke()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 7, yRadius: 7).stroke()
        let value = text.isEmpty ? "等待小蛇键盘输入" : text
        value.draw(
            at: NSPoint(x: 12, y: 8),
            withAttributes: [
                .font: NSFont.systemFont(ofSize: 14),
                .foregroundColor: text.isEmpty ? NSColor.secondaryLabelColor : NSColor.labelColor,
            ]
        )
    }
}

@MainActor
final class FixtureDelegate: NSObject, NSApplicationDelegate {
    private let stateURL: URL
    private var window: NSWindow!
    private var receiver: KeyReceiverView!
    private var status: NSTextField!
    private var activationTimer: Timer?
    private var clicked = false

    init(stateURL: URL) {
        self.stateURL = stateURL
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 300),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = fixtureTitle
        let primaryScreen = NSScreen.screens.first {
            abs($0.frame.minX) < 0.5 && abs($0.frame.minY) < 0.5
        } ?? NSScreen.screens.first
        if let frame = primaryScreen?.visibleFrame {
            window.setFrameOrigin(NSPoint(
                x: frame.minX + 80,
                y: frame.maxY - window.frame.height - 80
            ))
        } else {
            window.center()
        }

        let heading = NSTextField(labelWithString: "小蛇真实桌面动作验收")
        heading.frame = NSRect(x: 40, y: 225, width: 480, height: 28)
        heading.font = .systemFont(ofSize: 20, weight: .semibold)

        receiver = KeyReceiverView(frame: NSRect(x: 40, y: 155, width: 480, height: 38))
        receiver.setAccessibilityRole(.textField)
        receiver.setAccessibilityLabel("小蛇验收输入框")
        receiver.onChange = { [weak self] _ in self?.writeState(ready: true) }

        let focusButton = NSButton(frame: NSRect(x: 40, y: 88, width: 180, height: 36))
        focusButton.title = "聚焦安全输入区"
        focusButton.bezelStyle = .rounded
        focusButton.target = self
        focusButton.action = #selector(focusInput)
        focusButton.setAccessibilityLabel("聚焦安全输入区")

        let button = NSButton(frame: NSRect(x: 235, y: 88, width: 190, height: 36))
        button.title = "执行安全点击验收"
        button.bezelStyle = .rounded
        button.target = self
        button.action = #selector(acceptClick)
        button.setAccessibilityLabel("执行安全点击验收")

        status = NSTextField(labelWithString: "等待真实桌面动作")
        status.frame = NSRect(x: 40, y: 50, width: 480, height: 22)
        status.setAccessibilityLabel("小蛇验收状态")

        for view: NSView in [heading, receiver, focusButton, button, status] {
            window.contentView?.addSubview(view)
        }

        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(nil)
        NSApp.activate(ignoringOtherApps: true)
        activationTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            guard let self else { return }
            if !NSApp.isActive || !self.window.isKeyWindow {
                NSApp.activate(ignoringOtherApps: true)
                self.window.makeKeyAndOrderFront(nil)
            }
        }
        writeState(ready: true)
    }

    @objc private func focusInput() {
        window.makeFirstResponder(receiver)
        status.stringValue = "安全输入区已聚焦"
        writeState(ready: true)
    }

    @objc private func acceptClick() {
        clicked = true
        status.stringValue = "点击已由真实桌面动作接收"
        writeState(ready: true)
    }

    private func writeState(ready: Bool) {
        let state: [String: Any] = [
            "schemaVersion": 1,
            "ready": ready,
            "windowTitle": fixtureTitle,
            "text": receiver?.text ?? "",
            "clicked": clicked,
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
            try data.write(to: stateURL, options: [.atomic])
        } catch {
            fputs("fixture state write failed: \(error)\n", stderr)
        }
    }
}

guard CommandLine.arguments.count == 2 else {
    fputs("usage: XiaosheDesktopActionFixture <state.json>\n", stderr)
    exit(2)
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let delegate = FixtureDelegate(stateURL: URL(fileURLWithPath: CommandLine.arguments[1]))
    application.delegate = delegate
    application.run()
    withExtendedLifetime(delegate) {}
}
