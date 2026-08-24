// Activity Recorder 的 macOS 采集 sidecar。
//
// sidecar 只负责系统能力：屏幕截图、前台应用、输入活动计数和 Vision OCR。它不写配置、
// SQLite 或模型上下文；所有数据通过 JSONL 交给 Electron 主进程，由主进程统一做权限门禁、
// 脱敏、落盘和生命周期管理。
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
        jpegQuality = try values.decodeIfPresent(Int.self, forKey: .jpegQuality) ?? 55
        ocrEnabled = try values.decodeIfPresent(Bool.self, forKey: .ocrEnabled) ?? true
        inputMonitoringEnabled = try values.decodeIfPresent(Bool.self, forKey: .inputMonitoringEnabled) ?? true
        ocrLanguages = try values.decodeIfPresent([String].self, forKey: .ocrLanguages) ?? ["en-US", "zh-Hans", "zh-Hant", "ja"]
        ocrEveryNFrames = try values.decodeIfPresent(Int.self, forKey: .ocrEveryNFrames) ?? 5
        sensitiveApplications = Set(try values.decodeIfPresent([String].self, forKey: .sensitiveApplications) ?? [])
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, captureDebounceMs, heartbeatMs, idleTimeoutMs, inputPauseMs, visualPollMs
        case jpegQuality, ocrEnabled, inputMonitoringEnabled, ocrLanguages, ocrEveryNFrames
        case sensitiveApplications
    }
}

private struct SidecarCommand: Decodable {
    let type: String
    let settings: ActivitySettings?
}

private struct SidecarStatus: Encodable {
    let type = "status"
    let status: String
    let screenRecordingGranted: Bool
    let accessibilityGranted: Bool
    let currentApplication: String?
    let inputEventCount: Int
    let error: String?
}

private struct SidecarCapture: Encodable {
    let type = "capture"
    let occurredAt: String
    let application: String?
    let bundleId: String?
    let jpegBase64: String
    let ocrText: String?
    let inputEventCount: Int
}

private struct SidecarError: Encodable {
    let type = "error"
    let message: String
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
    private let output: SidecarOutput
    private let captureQueue = DispatchQueue(label: "com.biny.activity-recorder.capture", qos: .utility)
    private let stateLock = NSLock()
    private var settings: ActivitySettings?
    private var timer: DispatchSourceTimer?
    private var globalMonitor: Any?
    private var lastInputAt = Date()
    private var lastCaptureAt: Date?
    private var frameCount = 0
    private var inputEventCount = 0
    private var sessionActive = false
    private var captureInFlight = false
    private var lastPermissionError: String?

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
            emitStatus(status: sessionActive ? "running" : "stopped", error: lastPermissionError)
        default:
            output.write(SidecarError(message: "未知 sidecar 命令：\(command.type)"))
        }
    }

    func stop() {
        timer?.cancel()
        timer = nil
        if let globalMonitor {
            NSEvent.removeMonitor(globalMonitor)
            self.globalMonitor = nil
        }
        sessionActive = false
        emitStatus(status: "stopped", error: nil)
    }

    private func start(_ nextSettings: ActivitySettings) {
        stop()
        settings = nextSettings
        guard nextSettings.enabled else {
            emitStatus(status: "paused", error: nil)
            return
        }

        lastInputAt = Date()
        lastCaptureAt = nil
        frameCount = 0
        inputEventCount = 0
        lastPermissionError = nil
        installInputMonitorIfNeeded(nextSettings)
        sessionActive = true

        let interval = max(250, min(
            nextSettings.visualPollMs > 0 ? nextSettings.visualPollMs : nextSettings.heartbeatMs,
            nextSettings.heartbeatMs
        ))
        let source = DispatchSource.makeTimerSource(queue: captureQueue)
        source.schedule(deadline: .now(), repeating: .milliseconds(interval), leeway: .milliseconds(100))
        source.setEventHandler { [weak self] in self?.captureIfNeeded() }
        source.resume()
        timer = source
        emitStatus(status: "running", error: nil)
    }

    private func installInputMonitorIfNeeded(_ nextSettings: ActivitySettings) {
        guard nextSettings.inputMonitoringEnabled else { return }
        let events: NSEvent.EventTypeMask = [
            .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel
        ]
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: events) { [weak self] _ in
            self?.recordInput()
        }
    }

    private func recordInput() {
        stateLock.lock()
        lastInputAt = Date()
        inputEventCount += 1
        stateLock.unlock()
    }

    private func captureIfNeeded() {
        guard let settings, sessionActive else { return }
        guard CGPreflightScreenCaptureAccess() else {
            let message = "缺少屏幕录制权限，Activity 采集已暂停。"
            if lastPermissionError != message {
                lastPermissionError = message
                emitStatus(status: "permission_required", error: message)
            }
            return
        }

        let now = Date()
        stateLock.lock()
        let lastInput = lastInputAt
        let inputCount = inputEventCount
        stateLock.unlock()
        let elapsedSinceInput = now.timeIntervalSince(lastInput) * 1_000
        let elapsedSinceCapture = lastCaptureAt.map { now.timeIntervalSince($0) * 1_000 } ?? .greatestFiniteMagnitude
        let idle = elapsedSinceInput >= Double(max(0, settings.idleTimeoutMs))
        let minimumInterval = idle ? settings.heartbeatMs : settings.captureDebounceMs
        if elapsedSinceCapture < Double(max(0, minimumInterval)) { return }
        if !idle && elapsedSinceInput < Double(max(0, settings.inputPauseMs)) { return }

        guard markCaptureStarted() else { return }

        let frontmost = NSWorkspace.shared.frontmostApplication
        let bundleId = frontmost?.bundleIdentifier
        if let bundleId, settings.sensitiveApplications.contains(bundleId) {
            markCaptureFinished()
            lastCaptureAt = now
            emitStatus(status: "sensitive_application", error: nil)
            return
        }

        let capturedAt = ISO8601DateFormatter().string(from: now)
        Task { [weak self] in
            guard let self else { return }
            defer { self.markCaptureFinished() }
            do {
                let image = try await captureScreen()
                guard let jpeg = jpegData(image: image, quality: settings.jpegQuality) else {
                    emitStatus(status: "capture_error", error: "无法编码屏幕 JPEG。")
                    return
                }

                let currentFrame = nextFrame()
                let ocrText: String?
                if settings.ocrEnabled && currentFrame % max(1, settings.ocrEveryNFrames) == 0 {
                    ocrText = recognizeText(image: image, languages: settings.ocrLanguages)
                } else {
                    ocrText = nil
                }
                lastCaptureAt = now
                output.write(SidecarCapture(
                    occurredAt: capturedAt,
                    application: frontmost?.localizedName,
                    bundleId: bundleId,
                    jpegBase64: jpeg.base64EncodedString(),
                    ocrText: ocrText,
                    inputEventCount: inputCount
                ))
            } catch {
                emitStatus(status: "capture_error", error: "无法读取当前屏幕画面。")
            }
        }
    }

    private func markCaptureStarted() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        if captureInFlight { return false }
        captureInFlight = true
        return true
    }

    private func markCaptureFinished() {
        stateLock.lock()
        captureInFlight = false
        stateLock.unlock()
    }

    private func nextFrame() -> Int {
        stateLock.lock()
        frameCount += 1
        let result = frameCount
        stateLock.unlock()
        return result
    }

    private func captureScreen() async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw NSError(domain: "BinyActivityRecorder", code: 1) }
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

    private func emitStatus(status: String, error: String?) {
        let appName = NSWorkspace.shared.frontmostApplication?.localizedName
        stateLock.lock()
        let count = inputEventCount
        stateLock.unlock()
        output.write(SidecarStatus(
            status: status,
            screenRecordingGranted: CGPreflightScreenCaptureAccess(),
            accessibilityGranted: AXIsProcessTrusted(),
            currentApplication: appName,
            inputEventCount: count,
            error: error
        ))
    }
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
