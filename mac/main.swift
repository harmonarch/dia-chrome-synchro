// Bifröst for macOS —— 菜单栏应用外壳
// 职责：内嵌 node 运行时启动同步服务（Resources/app），用 WKWebView 承载玻璃控制台。
// 若 8770 端口已有 Bifröst 服务（如 LaunchAgent），直接复用，不重复拉起。
import AppKit
import WebKit
import UserNotifications

let kPort = 8770
let kAppData = NSString(string: "~/Library/Application Support/Bifrost").expandingTildeInPath
// 服务端约定：SYNCHRO_DATA_DIR 即数据目录本身（config/state/backups 直接在其中）
let kDataDir = kAppData + "/data"

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, WKNavigationDelegate, UNUserNotificationCenterDelegate {
    var statusItem: NSStatusItem?
    var window: NSWindow?
    var webView: WKWebView?
    var serverProcess: Process?
    var logHandle: FileHandle?
    var spawnedByUs = false
    var lastSyncSummary = "尚未同步"

    var baseURL: URL { URL(string: "http://127.0.0.1:\(kPort)")! }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installSignalHandlers()
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { _, _ in }
        buildStatusItem()
        ensureServer { [weak self] in
            DispatchQueue.main.async {
                self?.buildWindow()
                self?.showWindow()
            }
        }
    }

    /// NSApplication 不会自动处理 SIGTERM/SIGINT；接住信号走正常退出流程，
    /// 否则 applicationWillTerminate 不会执行、内嵌服务进程会变成孤儿。
    func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { [weak self] in
                NSLog("Bifrost: signal received, terminating")
                NSApp.terminate(nil)
            }
            src.resume()
            Self.signalSources.append(src)
        }
    }
    static var signalSources: [DispatchSourceSignal] = []

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        NSLog("Bifrost: applicationWillTerminate, spawnedByUs=%d", spawnedByUs ? 1 : 0)
        if spawnedByUs, let p = serverProcess, p.isRunning {
            p.terminate()
            NSLog("Bifrost: sent SIGTERM to child server")
        }
    }

    // MARK: - 服务管理

    func serverAlive(completion: @escaping (Bool) -> Void) {
        var req = URLRequest(url: baseURL)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            completion((resp as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    func ensureServer(completion: @escaping () -> Void) {
        serverAlive { [weak self] running in
            guard let self else { return }
            if running { completion(); return }
            self.spawnServer()
            let deadline = Date().addingTimeInterval(15)
            func poll() {
                self.serverAlive { ok in
                    if ok || Date() > deadline { completion() }
                    else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: poll) }
                }
            }
            poll()
        }
    }

    func spawnServer() {
        guard let resPath = Bundle.main.resourcePath else { return }
        let nodeBin = resPath + "/bin/node"
        let appDir = resPath + "/app"
        try? FileManager.default.createDirectory(atPath: kDataDir + "/logs", withIntermediateDirectories: true)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodeBin)
        p.arguments = ["server.js"]
        p.currentDirectoryPath = appDir
        var env = ProcessInfo.processInfo.environment
        env["SYNCHRO_DATA_DIR"] = kDataDir
        p.environment = env
        logHandle = FileHandle(forWritingAtPath: kDataDir + "/logs/app.log") ?? FileHandle.nullDevice
        p.standardOutput = logHandle
        p.standardError = logHandle
        do {
            try p.run()
            spawnedByUs = true
            serverProcess = p
        } catch {
            NSLog("Bifrost server spawn failed: \(error)")
        }
    }

    // MARK: - 菜单栏

    func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let img = Bundle.main.image(forResource: "menu-icon") ?? NSImage(named: "menu-icon") {
            img.size = NSSize(width: 18, height: 18)
            img.isTemplate = true
            item.button?.image = img
        } else {
            item.button?.title = "B"
        }
        let menu = NSMenu()
        menu.delegate = self

        let console = NSMenuItem(title: "打开同步控制台", action: #selector(showWindowAction), keyEquivalent: "o")
        let sync = NSMenuItem(title: "立即同步", action: #selector(syncNowAction), keyEquivalent: "s")
        let browser = NSMenuItem(title: "在默认浏览器中打开", action: #selector(openInBrowserAction), keyEquivalent: "b")
        let statusLine = NSMenuItem(title: "  " + lastSyncSummary, action: nil, keyEquivalent: "")
        statusLine.isEnabled = false
        statusLine.tag = 42
        let bg = NSMenuItem(title: "后台计划服务", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        sub.addItem(NSMenuItem(title: "安装（开机自启 + 计划同步）", action: #selector(installAgentAction), keyEquivalent: ""))
        sub.addItem(NSMenuItem(title: "卸载", action: #selector(uninstallAgentAction), keyEquivalent: ""))
        bg.submenu = sub
        let quit = NSMenuItem(title: "退出 Bifrost", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        for it in [console, sync, browser, NSMenuItem.separator(), statusLine, NSMenuItem.separator(), bg, NSMenuItem.separator(), quit] {
            menu.addItem(it)
            it.target = self
        }
        item.menu = menu
        statusItem = item
    }

    func menuWillOpen(_ menu: NSMenu) {
        serverAlive { [weak self] ok in
            guard let self else { return }
            if ok {
                var req = URLRequest(url: URL(string: "\(self.baseURL)/api/state")!)
                req.timeoutInterval = 2
                URLSession.shared.dataTask(with: req) { data, _, _ in
                    guard let data,
                          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let last = obj["lastSync"] as? String else { return }
                    let title: String
                    if let d = ISO8601DateFormatter().date(from: last) {
                        let f = DateFormatter()
                        f.dateFormat = "M/d HH:mm"
                        title = "服务运行中 · 上次同步 \(f.string(from: d))"
                    } else {
                        title = "服务运行中 · 尚未同步"
                    }
                    DispatchQueue.main.async { [weak self] in
                        self?.lastSyncSummary = title
                        self?.statusItem?.menu?.item(withTag: 42)?.title = "  " + title
                    }
                }.resume()
            }
            DispatchQueue.main.async { [weak self] in
                guard let statusLine = self?.statusItem?.menu?.item(withTag: 42) else { return }
                statusLine.title = ok ? "  服务运行中 · \(self?.lastSyncSummary ?? "")" : "  服务未响应"
            }
        }
    }

    // MARK: - 动作

    @objc func showWindowAction() { showWindow() }

    func showWindow() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func openInBrowserAction() { NSWorkspace.shared.open(baseURL) }

    @objc func syncNowAction() {
        var req = URLRequest(url: URL(string: "\(baseURL)/api/sync")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        req.timeoutInterval = 60
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                self?.webView?.reload()
                var body = "同步完成"
                if let data,
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let bm = obj["bookmarks"] as? [String: Any] {
                    if bm["applied"] as? Bool == true {
                        body = "书签已镜像写入，插件差异见控制台"
                    } else if let skipped = bm["skipped"] as? String {
                        body = skipped
                    } else if (bm["counts"] as? [String: Int]).map({ $0.values.reduce(0, +) }) == 0 {
                        body = "书签两边已一致"
                    }
                }
                self?.notify(title: "Bifröst 已同步", body: body)
            }
        }.resume()
    }

    @objc func installAgentAction() { runAgentScript("install-agent-app.sh") }
    @objc func uninstallAgentAction() { runAgentScript("uninstall-agent-app.sh") }

    func runAgentScript(_ name: String) {
        guard let script = Bundle.main.path(forResource: name, ofType: nil, inDirectory: "scripts") else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [script]
        var env = ProcessInfo.processInfo.environment
        env["SYNCHRO_DATA_DIR"] = kDataDir
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do {
            try p.run()
        } catch {
            alert("无法运行脚本：\(error.localizedDescription)")
            return
        }
        DispatchQueue.global().async { [weak self] in
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let out = String(data: data, encoding: .utf8) ?? ""
            p.waitUntilExit()
            DispatchQueue.main.async {
                let ok = p.terminationStatus == 0
                self?.alert((ok ? "✅ " : "⚠️ ") + out.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }
    }

    func alert(_ text: String) {
        let a = NSAlert()
        a.messageText = "Bifrost"
        a.informativeText = text
        a.runModal()
    }

    func notify(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    // MARK: - 窗口

    func buildWindow() {
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1150, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        win.title = "Bifröst · 双浏览器同步台"
        win.titlebarAppearsTransparent = true
        win.minSize = NSSize(width: 900, height: 640)
        win.backgroundColor = NSColor(red: 0.96, green: 0.93, blue: 0.88, alpha: 1)
        win.tabbingMode = .disallowed

        let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 1150, height: 820))
        wv.navigationDelegate = self
        wv.underPageBackgroundColor = .white
        wv.load(URLRequest(url: baseURL))
        win.contentView = wv
        win.center()
        window = win
        webView = wv
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("document.documentElement.setAttribute('data-native','1')")
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
