// Activity Recorder 的 macOS 采集 sidecar。
//
// 正常路径只输出前台应用、窗口、焦点控件和输入活动的最小摘要。AX 无法提供有效语义时，
// 才按冷却时间请求 ScreenCaptureKit 整屏 JPEG；sidecar 不写配置、SQLite 或模型上下文。
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

private struct ActivitySettings: Decodable {
    let enabled: Bool
    let captureDebounceMs: Int
    let heartbeatMs: Int
    let idleTimeoutMs: Int
    let inputPauseMs: Int
    let visualPollMs: Int
    let browserPollIntervalMs: Int
    let jpegQuality: Int
    let ocrEnabled: Bool
    let inputMonitoringEnabled: Bool
    let ocrLanguages: [String]
    let ocrEveryNFrames: Int
    let sensitiveApplications: Set<String>

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        captureDebounceMs = try values.decodeIfPresent(Int.self, forKey: .captureDebounceMs) ?? 4_000
        heartbeatMs = try values.decodeIfPresent(Int.self, forKey: .heartbeatMs) ?? 120_000
        idleTimeoutMs = try values.decodeIfPresent(Int.self, forKey: .idleTimeoutMs) ?? 30_000
        inputPauseMs = try values.decodeIfPresent(Int.self, forKey: .inputPauseMs) ?? 1_200
        visualPollMs = try values.decodeIfPresent(Int.self, forKey: .visualPollMs) ?? 12_000
        browserPollIntervalMs = try values.decodeIfPresent(Int.self, forKey: .browserPollIntervalMs) ?? 12_000
        jpegQuality = try values.decodeIfPresent(Int.self, forKey: .jpegQuality) ?? 55
        ocrEnabled = try values.decodeIfPresent(Bool.self, forKey: .ocrEnabled) ?? true
        inputMonitoringEnabled = try values.decodeIfPresent(Bool.self, forKey: .inputMonitoringEnabled) ?? true
        ocrLanguages = try values.decodeIfPresent([String].self, forKey: .ocrLanguages) ?? ["en-US", "zh-Hans", "zh-Hant", "ja"]
        ocrEveryNFrames = try values.decodeIfPresent(Int.self, forKey: .ocrEveryNFrames) ?? 5
        sensitiveApplications = Set(try values.decodeIfPresent([String].self, forKey: .sensitiveApplications) ?? [])
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, captureDebounceMs, heartbeatMs, idleTimeoutMs, inputPauseMs, visualPollMs
        case browserPollIntervalMs, jpegQuality, ocrEnabled, inputMonitoringEnabled
        case ocrLanguages, ocrEveryNFrames, sensitiveApplications
    }
}

private struct SidecarCommand: Decodable {
    let type: String
    let settings: ActivitySettings?
    let permission: String?
}

private struct SidecarStatus: Encodable {
    let type = "status"
    let status: String
    let screenRecordingGranted: Bool
    let accessibilityGranted: Bool
    let inputMonitoringGranted: Bool
    let axAvailable: Bool
    let fallbackAvailable: Bool
    let currentApplication: String?
    let inputEventCount: Int
    let error: String?
}

private struct SidecarEvent: Encodable {
    let type = "event"
    let occurredAt: String
    let eventType: String
    let application: String?
    let bundleId: String?
    let windowTitle: String?
    let axRole: String?
    let axTitle: String?
    /// 浏览器标签 URL：结构化字段，主进程直落 activity_events.url 列，不经过文本脱敏。
    let url: String?
    /// 浏览器标签标题：主进程按普通文本处理（走 redactActivityText 后落 window_title）。
    let tabTitle: String?
    let text: String?
    let mouseEventType: String?
    let mouseButton: Int?
    let inputEventCount: Int
    let axAvailable: Bool
    let fallbackReason: String?
}

private struct SidecarCapture: Encodable {
    let type = "capture"
    let occurredAt: String
    let eventType = "fallback_capture"
    let application: String?
    let bundleId: String?
    let windowTitle: String?
    let axRole: String?
    let axTitle: String?
    let text: String?
    let jpegBase64: String
    let ocrText: String?
    let inputEventCount: Int
    let fallbackReason: String
}

private struct SidecarError: Encodable {
    let type = "error"
    let message: String
}

private struct AXContext {
    var windowTitle: String?
    var axRole: String?
    var axTitle: String?
    var text: String?
    var valid: Bool
    var secureTextField: Bool

    static let unavailable = AXContext(
        windowTitle: nil,
        axRole: nil,
        axTitle: nil,
        text: nil,
        valid: false,
        secureTextField: false
    )
}

private final class SidecarOutput {
    private let lock = NSLock()
    private let encoder = JSONEncoder()

    func write<T: Encodable>(_ value: T) {
        guard let data = try? encoder.encode(value) else { return }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

private final class ActivityRecorder {
    private struct PendingPointerBurst {
        let eventType: String
        let mouseEventType: String
        let mouseButton: Int?
        var count: Int
    }

    // 这类应用的主要内容是画布/视频，AX 可以返回控件但通常无法描述画面本身。
    private let visualApplicationBundleIds: Set<String> = [
        "com.apple.Preview",
        "com.apple.QuickTimePlayerX",
        "com.figma.Desktop",
        "com.bohemiancoding.sketch3",
        "com.adobe.Photoshop",
        "com.adobe.Photoshop2024",
        "com.pixelmatorteam.pixelmator.x"
    ]
    // P4：只有这些浏览器会被轮询当前标签。Chrome/Edge 家族共用 Chromium 的
    // 「active tab of front window」脚本，Safari 家族用「front document」。
    private let supportedBrowserBundleIds: Set<String> = [
        "com.apple.Safari",
        "com.apple.SafariTechnologyPreview",
        "com.google.Chrome",
        "com.google.Chrome.canary",
        "com.google.Chrome.beta",
        "com.google.Chrome.dev",
        "com.microsoft.edgemac",
        "com.microsoft.edgemac.Beta",
        "com.microsoft.edgemac.Dev",
        "com.microsoft.edgemac.Canary"
    ]
    private struct BrowserTabState {
        let bundleId: String
        let url: String
        let title: String
    }
    private let output: SidecarOutput
    private var settings: ActivitySettings?
    private var fallbackTimer: DispatchSourceTimer?
    private var browserPollTimer: DispatchSourceTimer?
    private var browserPollWorkItem: DispatchWorkItem?
    private var browserScripts: [String: (url: NSAppleScript, title: NSAppleScript)] = [:]
    private var lastBrowserTab: BrowserTabState?
    /// Apple Events 被拒绝（-1743）后短暂退避，避免每个轮询周期都重复失败开销；
    /// 用户后续在系统设置里授权后，退避结束会自动恢复采集。
    private var browserAutomationBlockedUntil: Date?
    private var eventTap: CFMachPort?
    private var eventTapSource: CFRunLoopSource?
    private var workspaceObserver: NSObjectProtocol?
    private var axObserver: AXObserver?
    private var axApplicationElement: AXUIElement?
    private var axRegistrations: [(element: AXUIElement, notification: CFString)] = []
    private var keyBurstWorkItem: DispatchWorkItem?
    private var pointerBurstWorkItem: DispatchWorkItem?
    private var lastInputAt: Date?
    private var lastActivityAt: Date?
    private var lastCaptureAt: Date?
    private var fallbackPendingReason: String?
    private var frameCount = 0
    private var inputEventCount = 0
    private var keyBurstCount = 0
    private var pendingPointerBurst: PendingPointerBurst?
    private var sessionActive = false
    private var captureInFlight = false
    private var currentContext = AXContext.unavailable
    private var currentApplication: NSRunningApplication?
    private var inputMonitoringGranted = false
    private var lastStatusError: String?

    init(output: SidecarOutput) {
        self.output = output
    }

    func handle(_ command: SidecarCommand) {
        switch command.type {
        case "start":
            guard let settings = command.settings else {
                output.write(SidecarError(message: "start 缺少 Activity 设置。"))
                return
            }
            start(settings)
        case "stop":
            stop()
        case "status":
            emitStatus(status: sessionActive ? "running" : "stopped", error: lastStatusError)
        case "request_permission":
            requestPermission(command.permission)
        default:
            output.write(SidecarError(message: "未知 sidecar 命令：\(command.type)"))
        }
    }

    private func requestPermission(_ permission: String?) {
        guard let permission else {
            output.write(SidecarError(message: "request_permission 缺少权限类型。"))
            return
        }
        switch permission {
        case "screen-recording":
            _ = CGRequestScreenCaptureAccess()
        case "accessibility":
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        case "input-monitoring":
            _ = CGRequestListenEventAccess()
        default:
            output.write(SidecarError(message: "未知权限类型：\(permission)"))
            return
        }
        emitStatus(status: sessionActive ? "running" : "stopped", error: statusError())
    }

    func stop() {
        if sessionActive {
            flushKeyBurst()
            flushPointerBurst()
        }
        fallbackTimer?.cancel()
        fallbackTimer = nil
        browserPollTimer?.cancel()
        browserPollTimer = nil
        browserPollWorkItem?.cancel()
        browserPollWorkItem = nil
        browserScripts.removeAll()
        lastBrowserTab = nil
        browserAutomationBlockedUntil = nil
        keyBurstWorkItem?.cancel()
        keyBurstWorkItem = nil
        pointerBurstWorkItem?.cancel()
        pointerBurstWorkItem = nil
        pendingPointerBurst = nil
        removeEventTap()
        removeWorkspaceObserver()
        removeAXObserver()
        sessionActive = false
        fallbackPendingReason = nil
        lastActivityAt = nil
        lastInputAt = nil
        captureInFlight = false
        emitStatus(status: "stopped", error: nil)
    }

    private func start(_ nextSettings: ActivitySettings) {
        stop()
        settings = nextSettings
        guard nextSettings.enabled else {
            emitStatus(status: "paused", error: nil)
            return
        }

        frameCount = 0
        inputEventCount = 0
        keyBurstCount = 0
        lastCaptureAt = nil
        lastStatusError = nil
        sessionActive = true
        installWorkspaceObserver()
        installInputEventTapIfNeeded(nextSettings)
        installFallbackTimer(nextSettings)
        installBrowserPollTimer(nextSettings)
        frontmostApplicationChanged(NSWorkspace.shared.frontmostApplication)
        emitStatus(status: "running", error: statusError())
    }

    private func installWorkspaceObserver() {
        workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: OperationQueue.main
        ) { [weak self] notification in
            let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            self?.frontmostApplicationChanged(application ?? NSWorkspace.shared.frontmostApplication)
        }
    }

    private func removeWorkspaceObserver() {
        if let workspaceObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(workspaceObserver)
            self.workspaceObserver = nil
        }
    }

    private func installFallbackTimer(_ nextSettings: ActivitySettings) {
        let interval = max(250, nextSettings.visualPollMs > 0 ? nextSettings.visualPollMs : nextSettings.heartbeatMs)
        let source = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
        source.schedule(deadline: .now() + .milliseconds(interval), repeating: .milliseconds(interval), leeway: .milliseconds(100))
        source.setEventHandler { [weak self] in
            guard let self else { return }
            self.refreshPermissionState()
            self.checkFallback()
        }
        source.resume()
        fallbackTimer = source
    }

    // P4：浏览器标签轮询。只有前台应用是受支持浏览器时才真正执行 AppleScript，
    // 因此不额外占用事件流；Apple Events 无权限（-1743）时安静降级，不报错不上报。
    private func installBrowserPollTimer(_ nextSettings: ActivitySettings) {
        guard nextSettings.browserPollIntervalMs > 0 else { return }
        let intervalMs = max(1_000, nextSettings.browserPollIntervalMs)
        let source = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
        source.schedule(
            deadline: .now() + .milliseconds(intervalMs),
            repeating: .milliseconds(intervalMs),
            leeway: .milliseconds(250)
        )
        source.setEventHandler { [weak self] in
            self?.pollFrontmostBrowser()
        }
        source.resume()
        browserPollTimer = source
    }

    private func scheduleImmediateBrowserPoll() {
        guard settings?.browserPollIntervalMs ?? 0 > 0, sessionActive else { return }
        browserPollWorkItem?.cancel()
        // 应用刚切到前台时窗口/标签可能还没就绪，延迟 300ms 再查，失败由周期轮询兜底。
        let workItem = DispatchWorkItem { [weak self] in
            self?.pollFrontmostBrowser()
        }
        browserPollWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(300), execute: workItem)
    }

    private func pollFrontmostBrowser() {
        guard sessionActive, settings?.enabled == true else { return }
        guard let app = NSWorkspace.shared.frontmostApplication,
              let bundleId = app.bundleIdentifier,
              supportedBrowserBundleIds.contains(bundleId) else { return }
        // 敏感应用黑名单（含浏览器内的密码框焦点）一律不采集标签。
        guard !isSensitive(application: app, context: currentContext), let settings, settings.browserPollIntervalMs > 0 else { return }
        if let blockedUntil = browserAutomationBlockedUntil, Date() < blockedUntil { return }
        guard let tab = queryFrontTab(bundleId: bundleId) else { return }
        if let last = lastBrowserTab, last.bundleId == bundleId, last.url == tab.url, last.title == tab.title {
            return
        }
        lastBrowserTab = tab
        emitBrowserTabEvent(application: app, url: tab.url, title: tab.title)
    }

    private func queryFrontTab(bundleId: String) -> BrowserTabState? {
        let scripts: (url: NSAppleScript, title: NSAppleScript)
        if let cached = browserScripts[bundleId] {
            scripts = cached
        } else {
            guard let source = browserScriptSource(for: bundleId),
                  let urlScript = NSAppleScript(source: source.urlScript),
                  let titleScript = NSAppleScript(source: source.titleScript) else { return nil }
            scripts = (url: urlScript, title: titleScript)
            browserScripts[bundleId] = scripts
        }
        var urlError: NSDictionary?
        guard let rawUrl = scripts.url.executeAndReturnError(&urlError).stringValue,
              !rawUrl.isEmpty,
              let url = safeUrl(rawUrl) else {
            if let number = urlError?[NSAppleScript.errorNumber] as? Int, number == -1743 {
                browserAutomationBlockedUntil = Date().addingTimeInterval(60)
            }
            return nil
        }
        // 标题偶尔拿不到（如正在加载中）时仍上报 URL，标题可空。
        let title = scripts.title.executeAndReturnError(nil).stringValue ?? ""
        return BrowserTabState(bundleId: bundleId, url: url, title: shortText(title) ?? "")
    }

    /// 返回该浏览器的 AppleScript 源：Safari 家族走 document，Chromium 家族走窗口标签。
    private func browserScriptSource(for bundleId: String) -> (urlScript: String, titleScript: String)? {
        guard supportedBrowserBundleIds.contains(bundleId) else { return nil }
        if bundleId == "com.apple.Safari" || bundleId == "com.apple.SafariTechnologyPreview" {
            return (
                urlScript: "tell application id \"\(bundleId)\" to get URL of front document",
                titleScript: "tell application id \"\(bundleId)\" to get name of front document"
            )
        }
        return (
            urlScript: "tell application id \"\(bundleId)\" to get URL of active tab of front window",
            titleScript: "tell application id \"\(bundleId)\" to get title of active tab of front window"
        )
    }

    private func emitBrowserTabEvent(application: NSRunningApplication, url: String, title: String) {
        guard sessionActive else { return }
        let now = Date()
        lastActivityAt = now
        output.write(SidecarEvent(
            occurredAt: ISO8601DateFormatter().string(from: now),
            eventType: "browser_tab_changed",
            application: application.localizedName,
            bundleId: application.bundleIdentifier,
            windowTitle: nil,
            axRole: nil,
            axTitle: nil,
            url: safeUrl(url),
            tabTitle: shortText(title),
            text: nil,
            mouseEventType: nil,
            mouseButton: nil,
            inputEventCount: inputEventCount,
            axAvailable: true,
            fallbackReason: nil
        ))
    }

    /// URL 结构化字段的准入：只收 http/https，清理控制字符，限长；不在这里做内容脱敏。
    private func safeUrl(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 2_048,
              let schemeEnd = trimmed.range(of: "://")?.lowerBound else { return nil }
        let scheme = String(trimmed[..<schemeEnd]).lowercased()
        guard scheme == "http" || scheme == "https" else { return nil }
        return String(trimmed.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
    }

    private func refreshPermissionState() {
        guard sessionActive else { return }
        if let settings, settings.inputMonitoringEnabled, eventTap == nil, CGPreflightListenEventAccess() {
            installInputEventTapIfNeeded(settings)
        }
        if let reason = fallbackPendingReason,
           (reason == "accessibility_unavailable" || reason == "ax_connection_failed"),
           AXIsProcessTrusted() {
            rebindAXObserver(for: currentApplication ?? NSWorkspace.shared.frontmostApplication)
        }
        emitStatus(status: "running", error: statusError())
    }

    private func installInputEventTapIfNeeded(_ nextSettings: ActivitySettings) {
        guard nextSettings.inputMonitoringEnabled else {
            inputMonitoringGranted = CGPreflightListenEventAccess()
            return
        }
        guard CGPreflightListenEventAccess() else {
            inputMonitoringGranted = false
            return
        }
        let eventTypes: [CGEventType] = [
            .keyDown,
            .leftMouseDown, .leftMouseUp, .leftMouseDragged,
            .rightMouseDown, .rightMouseUp, .rightMouseDragged,
            .otherMouseDown, .otherMouseUp, .otherMouseDragged,
            .scrollWheel
        ]
        let mask = eventTypes.reduce(CGEventMask(0)) { partialResult, type in
            partialResult | (CGEventMask(1) << CGEventMask(type.rawValue))
        }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: eventTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            inputMonitoringGranted = false
            return
        }
        eventTap = tap
        inputMonitoringGranted = true
        if let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) {
            eventTapSource = source
            CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode)
        } else {
            CGEvent.tapEnable(tap: tap, enable: false)
            eventTap = nil
            inputMonitoringGranted = false
        }
    }

    private func removeEventTap() {
        if let source = eventTapSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .defaultMode)
            eventTapSource = nil
        }
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
            eventTap = nil
        }
        inputMonitoringGranted = false
    }

    fileprivate func handleGlobalEvent(_ type: CGEventType, mouseButton: Int?) {
        guard sessionActive else { return }
        let now = Date()
        lastActivityAt = now
        lastInputAt = now
        inputEventCount += 1
        switch type {
        case .keyDown:
            flushPointerBurst()
            keyBurstCount += 1
            scheduleKeyBurstFlush()
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            flushPointerBurst()
            emitInputEvent(eventType: "mouse_down", mouseEventType: "mouse_down", mouseButton: mouseButton)
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            flushPointerBurst()
            emitInputEvent(eventType: "mouse_up", mouseEventType: "mouse_up", mouseButton: mouseButton)
        case .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
            schedulePointerBurst(eventType: "mouse_drag", mouseEventType: "mouse_drag", mouseButton: mouseButton)
        case .scrollWheel:
            schedulePointerBurst(eventType: "scroll", mouseEventType: "scroll", mouseButton: nil)
        default:
            break
        }
    }

    private func scheduleKeyBurstFlush() {
        keyBurstWorkItem?.cancel()
        let pause = max(250, min(2_000, settings?.inputPauseMs ?? 1_200))
        let workItem = DispatchWorkItem { [weak self] in self?.flushKeyBurst() }
        keyBurstWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(pause), execute: workItem)
    }

    private func flushKeyBurst() {
        guard keyBurstCount > 0 else { return }
        let burstCount = keyBurstCount
        keyBurstCount = 0
        keyBurstWorkItem = nil
        emitSemanticEvent(eventType: "key_burst", inputCountOverride: burstCount)
    }

    private func schedulePointerBurst(eventType: String, mouseEventType: String, mouseButton: Int?) {
        if let pending = pendingPointerBurst,
           pending.eventType == eventType,
           pending.mouseButton == mouseButton {
            pendingPointerBurst?.count += 1
        } else {
            flushPointerBurst()
            pendingPointerBurst = PendingPointerBurst(
                eventType: eventType,
                mouseEventType: mouseEventType,
                mouseButton: mouseButton,
                count: 1
            )
        }
        pointerBurstWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in self?.flushPointerBurst() }
        pointerBurstWorkItem = workItem
        // 拖拽和滚轮会在一次手势中产生大量 CGEvent；短窗口合并后只保留一条语义事件，
        // count 仍记录这条事件覆盖的原始活动数量。
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(120), execute: workItem)
    }

    private func flushPointerBurst() {
        guard let pending = pendingPointerBurst else { return }
        pendingPointerBurst = nil
        pointerBurstWorkItem = nil
        emitSemanticEvent(
            eventType: pending.eventType,
            mouseEventType: pending.mouseEventType,
            mouseButton: pending.mouseButton,
            inputCountOverride: pending.count
        )
    }

    private func emitInputEvent(eventType: String, mouseEventType: String, mouseButton: Int?) {
        emitSemanticEvent(
            eventType: eventType,
            mouseEventType: mouseEventType,
            mouseButton: mouseButton
        )
    }

    private func frontmostApplicationChanged(_ application: NSRunningApplication?) {
        currentApplication = application ?? NSWorkspace.shared.frontmostApplication
        rebindAXObserver(for: currentApplication)
        emitSemanticEvent(eventType: "frontmost_application_changed", application: currentApplication)
        if supportedBrowserBundleIds.contains(currentApplication?.bundleIdentifier ?? "") {
            // 切到浏览器时立即查一次当前标签，不用等下一个轮询周期。
            scheduleImmediateBrowserPoll()
        }
    }

    private func rebindAXObserver(for application: NSRunningApplication?) {
        removeAXObserver()
        currentContext = AXContext.unavailable
        guard AXIsProcessTrusted() else {
            scheduleFallback(reason: "accessibility_unavailable")
            return
        }
        guard let application else {
            scheduleFallback(reason: "ax_connection_failed")
            return
        }
        let applicationElement = AXUIElementCreateApplication(application.processIdentifier)
        var observer: AXObserver?
        guard AXObserverCreate(application.processIdentifier, axObserverCallback, &observer) == .success,
              let observer else {
            axApplicationElement = applicationElement
            currentContext = queryAXContext(for: applicationElement, application: application)
            scheduleFallback(reason: "ax_connection_failed")
            return
        }
        axObserver = observer
        axApplicationElement = applicationElement
        let source = AXObserverGetRunLoopSource(observer)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode)
        refreshAXObservation()
    }

    private func refreshAXObservation() {
        guard let observer = axObserver, let applicationElement = axApplicationElement else {
            currentContext = AXContext.unavailable
            scheduleFallback(reason: "ax_connection_failed")
            return
        }
        removeAXRegistrations(observer)
        currentContext = queryAXContext(for: applicationElement, application: currentApplication)
        registerAXNotification(observer, element: applicationElement, notification: kAXFocusedUIElementChangedNotification as CFString)
        registerAXNotification(observer, element: applicationElement, notification: kAXFocusedWindowChangedNotification as CFString)
        if let window = axElementAttribute(kAXFocusedWindowAttribute as CFString, from: applicationElement) {
            registerAXNotification(observer, element: window, notification: kAXTitleChangedNotification as CFString)
        }
        if let focused = axElementAttribute(kAXFocusedUIElementAttribute as CFString, from: applicationElement) {
            registerAXNotification(observer, element: focused, notification: kAXTitleChangedNotification as CFString)
            registerAXNotification(observer, element: focused, notification: kAXValueChangedNotification as CFString)
            registerAXNotification(observer, element: focused, notification: kAXSelectedTextChangedNotification as CFString)
        }
    }

    private func removeAXObserver() {
        if let observer = axObserver {
            removeAXRegistrations(observer)
            let source = AXObserverGetRunLoopSource(observer)
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .defaultMode)
        }
        axObserver = nil
        axApplicationElement = nil
        currentContext = AXContext.unavailable
    }

    private func removeAXRegistrations(_ observer: AXObserver) {
        for registration in axRegistrations {
            _ = AXObserverRemoveNotification(observer, registration.element, registration.notification)
        }
        axRegistrations.removeAll()
    }

    private func registerAXNotification(_ observer: AXObserver, element: AXUIElement, notification: CFString) {
        guard AXObserverAddNotification(
            observer,
            element,
            notification,
            Unmanaged.passUnretained(self).toOpaque()
        ) == .success else { return }
        axRegistrations.append((element: element, notification: notification))
    }

    fileprivate func handleAXNotification(_ notification: String) {
        guard sessionActive else { return }
        refreshAXObservation()
        let eventType: String
        switch notification {
        case kAXFocusedWindowChangedNotification:
            eventType = "window_changed"
        case kAXFocusedUIElementChangedNotification:
            eventType = "focus_changed"
        case kAXTitleChangedNotification:
            eventType = "title_changed"
        case kAXValueChangedNotification:
            eventType = "value_changed"
        case kAXSelectedTextChangedNotification:
            eventType = "selection_changed"
        default:
            eventType = "focus_changed"
        }
        emitSemanticEvent(eventType: eventType)
    }

    private func queryAXContext(for applicationElement: AXUIElement, application: NSRunningApplication?) -> AXContext {
        _ = application
        guard AXIsProcessTrusted() else { return .unavailable }
        let window = axElementAttribute(kAXFocusedWindowAttribute as CFString, from: applicationElement)
        let focused = axElementAttribute(kAXFocusedUIElementAttribute as CFString, from: applicationElement)
        let windowTitle = window.flatMap { axStringAttribute(kAXTitleAttribute as CFString, from: $0) }
        let role = focused.flatMap { axStringAttribute(kAXRoleAttribute as CFString, from: $0) }
        let subrole = focused.flatMap { axStringAttribute(kAXSubroleAttribute as CFString, from: $0) }
        let secure = isSecureRole(role) || isSecureRole(subrole)
        let title = focused.flatMap { axStringAttribute(kAXTitleAttribute as CFString, from: $0) }
        let value = secure ? nil : focused.flatMap { axStringAttribute(kAXValueAttribute as CFString, from: $0) }
        let selected = secure ? nil : focused.flatMap { axStringAttribute(kAXSelectedTextAttribute as CFString, from: $0) }
        let text = shortText([value, selected].compactMap { $0 }.joined(separator: " "))
        let hasSemantics = windowTitle != nil || role != nil || title != nil || text != nil
        return AXContext(
            windowTitle: shortText(windowTitle),
            axRole: shortText(role),
            axTitle: shortText(title),
            text: text,
            valid: window != nil && focused != nil && hasSemantics,
            secureTextField: secure
        )
    }

    private func axElementAttribute(_ attribute: CFString, from element: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
              let value else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }

    private func axStringAttribute(_ attribute: CFString, from element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
              let value else { return nil }
        return value as? String
    }

    private func emitSemanticEvent(
        eventType: String,
        application: NSRunningApplication? = nil,
        mouseEventType: String? = nil,
        mouseButton: Int? = nil,
        inputCountOverride: Int? = nil
    ) {
        guard sessionActive else { return }
        let app = application ?? currentApplication ?? NSWorkspace.shared.frontmostApplication
        let context = currentContext
        let sensitive = isSensitive(application: app, context: context)
        let visualApplication = isVisualApplication(app)
        let outputContext = sensitive
            ? AXContext(windowTitle: nil, axRole: context.axRole, axTitle: nil, text: nil, valid: context.valid, secureTextField: context.secureTextField)
            : context
        let semanticAvailable = outputContext.valid && !visualApplication
        lastActivityAt = Date()
        if semanticAvailable {
            fallbackPendingReason = nil
        } else if !sensitive {
            scheduleFallback(reason: visualApplication ? "visual_application" : fallbackPendingReason ?? "missing_window_or_focus_semantics")
        } else {
            fallbackPendingReason = nil
        }
        output.write(SidecarEvent(
            occurredAt: ISO8601DateFormatter().string(from: Date()),
            eventType: eventType,
            application: app?.localizedName,
            bundleId: app?.bundleIdentifier,
            windowTitle: outputContext.windowTitle,
            axRole: outputContext.axRole,
            axTitle: outputContext.axTitle,
            url: nil,
            tabTitle: nil,
            text: outputContext.text,
            mouseEventType: mouseEventType,
            mouseButton: mouseButton,
            inputEventCount: inputCountOverride ?? inputEventCount,
            axAvailable: semanticAvailable,
            fallbackReason: semanticAvailable ? nil : fallbackPendingReason
        ))
        emitStatus(status: "running", error: statusError())
    }

    private func scheduleFallback(reason: String) {
        guard let settings, sessionActive else { return }
        let app = currentApplication ?? NSWorkspace.shared.frontmostApplication
        if isSensitive(application: app, context: currentContext) {
            fallbackPendingReason = nil
            emitStatus(status: "running", error: nil)
            return
        }
        fallbackPendingReason = reason
        lastStatusError = CGPreflightScreenCaptureAccess()
            ? nil
            : "无屏幕录制权限，事件记录正常，视觉 fallback 不可用。"
        _ = settings
    }

    private func checkFallback() {
        guard let settings, sessionActive, let reason = fallbackPendingReason, let lastActivityAt else { return }
        let now = Date()
        let usesHeartbeat = reason == "accessibility_unavailable" || reason == "ax_connection_failed"
        let frontmost = NSWorkspace.shared.frontmostApplication
        if let frontmost, let currentApplication,
           frontmost.processIdentifier != currentApplication.processIdentifier {
            // 权限检查和截图都必须基于最新前台应用，避免应用切换通知尚未到达时沿用旧上下文。
            frontmostApplicationChanged(frontmost)
            return
        }
        if usesHeartbeat && AXIsProcessTrusted() {
            let previousReason = fallbackPendingReason
            rebindAXObserver(for: currentApplication ?? frontmost)
            if currentContext.valid && !isVisualApplication(currentApplication ?? frontmost) {
                fallbackPendingReason = nil
                lastStatusError = nil
                emitStatus(status: "running", error: nil)
                return
            }
            if fallbackPendingReason == nil {
                fallbackPendingReason = previousReason
            }
        }
        let recentActivityWindow = Double(usesHeartbeat ? settings.heartbeatMs : settings.idleTimeoutMs) / 1_000
        guard now.timeIntervalSince(lastActivityAt) <= recentActivityWindow else { return }
        if let lastInputAt, now.timeIntervalSince(lastInputAt) * 1_000 < Double(max(0, settings.inputPauseMs)) { return }
        let elapsedSinceCapture = lastCaptureAt.map { now.timeIntervalSince($0) * 1_000 } ?? .greatestFiniteMagnitude
        guard elapsedSinceCapture >= Double(max(0, settings.captureDebounceMs)) else { return }
        let app = currentApplication ?? frontmost
        guard !isSensitive(application: app, context: currentContext) else {
            fallbackPendingReason = nil
            return
        }
        guard CGPreflightScreenCaptureAccess() else {
            lastStatusError = "无屏幕录制权限，事件记录正常，视觉 fallback 不可用。"
            emitStatus(status: "running", error: lastStatusError)
            return
        }
        lastStatusError = nil
        guard !captureInFlight else { return }
        captureInFlight = true
        lastCaptureAt = now
        let capturedAt = ISO8601DateFormatter().string(from: now)
        let context = currentContext
        let bundleId = app?.bundleIdentifier
        let appName = app?.localizedName
        Task { [weak self] in
            guard let self else { return }
            defer {
                DispatchQueue.main.async {
                    self.captureInFlight = false
                }
            }
            do {
                guard DispatchQueue.main.sync(execute: { self.fallbackCaptureAllowed() }) else { return }
                let image = try await self.captureScreen()
                guard let jpeg = self.jpegData(image: image, quality: settings.jpegQuality) else {
                    DispatchQueue.main.async { self.lastStatusError = "无法编码屏幕 JPEG。" }
                    return
                }
                guard DispatchQueue.main.sync(execute: { self.fallbackCaptureAllowed() }) else { return }
                let currentFrame = self.nextFrame()
                let ocrText: String?
                if settings.ocrEnabled && currentFrame % max(1, settings.ocrEveryNFrames) == 0 {
                    ocrText = self.recognizeText(image: image, languages: settings.ocrLanguages)
                } else {
                    ocrText = nil
                }
                self.output.write(SidecarCapture(
                    occurredAt: capturedAt,
                    application: appName,
                    bundleId: bundleId,
                    windowTitle: context.windowTitle,
                    axRole: context.axRole,
                    axTitle: context.axTitle,
                    text: context.text,
                    jpegBase64: jpeg.base64EncodedString(),
                    ocrText: ocrText,
                    inputEventCount: self.inputEventCount,
                    fallbackReason: reason
                ))
            } catch {
                DispatchQueue.main.async {
                    self.lastStatusError = "无法读取当前屏幕画面。"
                }
            }
        }
    }

    private func captureScreen() async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw NSError(domain: "BinyActivityRecorder", code: 1)
        }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, display.width)
        configuration.height = max(1, display.height)
        configuration.showsCursor = false
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    }

    private func jpegData(image: CGImage, quality: Int) -> Data? {
        let bitmap = NSBitmapImageRep(cgImage: image)
        return bitmap.representation(using: .jpeg, properties: [
            .compressionFactor: CGFloat(min(100, max(1, quality))) / 100
        ])
    }

    private func recognizeText(image: CGImage, languages: [String]) -> String? {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        request.recognitionLanguages = languages
        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
        } catch {
            return nil
        }
        let lines = (request.results ?? []).compactMap { observation in
            observation.topCandidates(1).first?.string
        }
        return lines.isEmpty ? nil : lines.joined(separator: " ")
    }

    private func nextFrame() -> Int {
        frameCount += 1
        return frameCount
    }

    private func isSensitive(application: NSRunningApplication?, context: AXContext) -> Bool {
        guard let settings else { return context.secureTextField }
        let bundleId = application?.bundleIdentifier
        return context.secureTextField || (bundleId.map { settings.sensitiveApplications.contains($0) } ?? false)
    }

    private func isVisualApplication(_ application: NSRunningApplication?) -> Bool {
        guard let bundleId = application?.bundleIdentifier else { return false }
        return visualApplicationBundleIds.contains(bundleId)
    }

    private func fallbackCaptureAllowed() -> Bool {
        let application = NSWorkspace.shared.frontmostApplication ?? currentApplication
        guard let application, let currentApplication,
              application.processIdentifier == currentApplication.processIdentifier else {
            return false
        }
        let context = contextForApplication(application)
        return sessionActive && CGPreflightScreenCaptureAccess() && !isSensitive(application: application, context: context)
    }

    private func contextForApplication(_ application: NSRunningApplication?) -> AXContext {
        guard let application, let currentApplication,
              application.processIdentifier == currentApplication.processIdentifier else {
            return .unavailable
        }
        return currentContext
    }

    private func isSecureRole(_ role: String?) -> Bool {
        guard let role else { return false }
        let normalized = role.lowercased()
        return normalized == "axsecuretextfield" || normalized == "axpasswordfield" || normalized.contains("securetext")
    }

    private func statusError() -> String? {
        if !CGPreflightScreenCaptureAccess() {
            return "无屏幕录制权限，事件记录正常，视觉 fallback 不可用。"
        }
        return lastStatusError
    }

    private func emitStatus(status: String, error: String?) {
        let screenRecordingGranted = CGPreflightScreenCaptureAccess()
        let app = NSWorkspace.shared.frontmostApplication ?? currentApplication
        let context = contextForApplication(app)
        let blocked = isSensitive(application: app, context: context)
        output.write(SidecarStatus(
            status: status,
            screenRecordingGranted: screenRecordingGranted,
            accessibilityGranted: AXIsProcessTrusted(),
            inputMonitoringGranted: inputMonitoringGranted,
            axAvailable: context.valid && !isVisualApplication(app),
            fallbackAvailable: screenRecordingGranted && !blocked,
            currentApplication: app?.localizedName,
            inputEventCount: inputEventCount,
            error: error ?? (status == "running" ? statusError() : nil)
        ))
    }

    fileprivate func reenableEventTap() {
        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: true)
        }
    }
}

private func eventTapCallback(
    _ proxy: CGEventTapProxy,
    _ type: CGEventType,
    _ event: CGEvent,
    _ refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    _ = proxy
    guard let refcon else { return Unmanaged.passUnretained(event) }
    let recorder = Unmanaged<ActivityRecorder>.fromOpaque(refcon).takeUnretainedValue()
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        DispatchQueue.main.async {
            recorder.reenableEventTap()
        }
        return Unmanaged.passUnretained(event)
    }
    let button: Int?
    switch type {
    case .leftMouseDown, .leftMouseUp, .leftMouseDragged,
         .rightMouseDown, .rightMouseUp, .rightMouseDragged,
         .otherMouseDown, .otherMouseUp, .otherMouseDragged:
        button = Int(event.getIntegerValueField(.mouseEventButtonNumber))
    default:
        button = nil
    }
    DispatchQueue.main.async {
        recorder.handleGlobalEvent(type, mouseButton: button)
    }
    return Unmanaged.passUnretained(event)
}

private func axObserverCallback(
    _ observer: AXObserver,
    _ element: AXUIElement,
    _ notification: CFString,
    _ refcon: UnsafeMutableRawPointer?
) {
    _ = observer
    _ = element
    guard let refcon else { return }
    let recorder = Unmanaged<ActivityRecorder>.fromOpaque(refcon).takeUnretainedValue()
    DispatchQueue.main.async {
        recorder.handleAXNotification(notification as String)
    }
}

private func shortText(_ value: String?) -> String? {
    guard let value else { return nil }
    let normalized = value
        .replacingOccurrences(of: "\0", with: " ")
        .split(whereSeparator: { $0.isWhitespace })
        .joined(separator: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return normalized.isEmpty ? nil : String(normalized.prefix(256))
}

private let output = SidecarOutput()
private let recorder = ActivityRecorder(output: output)
private let inputQueue = DispatchQueue(label: "com.biny.activity-recorder.stdin")

inputQueue.async {
    while let line = readLine(), !line.isEmpty {
        guard let data = line.data(using: .utf8), let command = try? JSONDecoder().decode(SidecarCommand.self, from: data) else {
            output.write(SidecarError(message: "sidecar 收到无效 JSON 命令。"))
            continue
        }
        DispatchQueue.main.async {
            recorder.handle(command)
        }
    }
    DispatchQueue.main.async {
        recorder.stop()
        exit(0)
    }
}
RunLoop.main.run()
