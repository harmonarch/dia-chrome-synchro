// 生成应用图标：暖米色圆角方 + 珊瑚→海沫青「桥拱」，另生成菜单栏模板图标。
// 用法: swift make-icon.swift <输出目录>
import AppKit

func lerp(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat { a + (b - a) * t }

func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> NSColor { NSColor(calibratedRed: r/255, green: g/255, blue: b/255, alpha: 1) }

let coral = color(196, 85, 46)
let amber = color(227, 154, 76)
let teal = color(46, 125, 138)

func bridgeColor(t: CGFloat) -> NSColor {
    // coral → amber → teal 三段插值
    if t < 0.5 {
        let k = t / 0.5
        return NSColor(calibratedRed: lerp(196/255, 227/255, k), green: lerp(85/255, 154/255, k), blue: lerp(46/255, 76/255, k), alpha: 1)
    }
    let k = (t - 0.5) / 0.5
    return NSColor(calibratedRed: lerp(227/255, 46/255, k), green: lerp(154/255, 125/255, k), blue: lerp(76/255, 138/255, k), alpha: 1)
}

let args = CommandLine.arguments
let outDir = args.count > 1 ? args[1] : "."
let S: CGFloat = 1024

func drawBridge(in rect: CGRect, lineWidth w: CGFloat, dotRadius dr: CGFloat, tint: NSColor?) {
    // 桥拱：M 5 30 C 12 12, 28 12, 35 30 的缩放版
    let startX = rect.minX + rect.width * 0.125
    let endX = rect.minX + rect.width * 0.875
    let baseY = rect.minY + rect.height * 0.75
    let topY = rect.minY + rect.height * 0.30
    let c1 = CGPoint(x: rect.minX + rect.width * 0.30, y: topY)
    let c2 = CGPoint(x: rect.minX + rect.width * 0.70, y: topY)
    let p = NSBezierPath()
    p.move(to: CGPoint(x: startX, y: baseY))
    p.curve(to: CGPoint(x: endX, y: baseY), controlPoint1: c1, controlPoint2: c2)
    p.lineWidth = w
    p.lineCapStyle = .round

    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.20)
    shadow.shadowBlurRadius = rect.width * 0.05
    shadow.shadowOffset = NSSize(width: 0, height: -rect.height * 0.03)

    if let tint {
        shadow.set()
        tint.setStroke()
        p.stroke()
        NSShadow().set()
    } else {
        // 24 条竖直切片模拟 coral→teal 渐变描边
        let slices = 24
        for i in 0..<slices {
            let t0 = CGFloat(i) / CGFloat(slices)
            let x0 = startX + (endX - startX) * t0 - (endX - startX) * 0.02
            let x1 = startX + (endX - startX) * (CGFloat(i + 1) / CGFloat(slices)) + (endX - startX) * 0.02
            NSGraphicsContext.current?.saveGraphicsState()
            let clip = NSBezierPath(rect: CGRect(x: x0, y: 0, width: x1 - x0, height: rect.maxY + 100))
            clip.addClip()
            shadow.set()
            bridgeColor(t: (t0 + 1.0 / CGFloat(slices) / 2)).setStroke()
            p.stroke()
            NSGraphicsContext.current?.restoreGraphicsState()
        }
    }

    // 两端圆点
    for (x, c) in [(startX, tint ?? coral), (endX, tint ?? teal)] {
        let dot = NSBezierPath(ovalIn: CGRect(x: x - dr, y: baseY - dr, width: dr * 2, height: dr * 2))
        shadow.set()
        c.setFill()
        dot.fill()
        NSShadow().set()
    }
}

// ---------- AppIcon 1024 ----------
let icon = NSImage(size: NSSize(width: S, height: S))
icon.lockFocus()

let bg = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: S, height: S), xRadius: 232, yRadius: 232)
bg.addClip()
let grad = NSGradient(starting: color(251, 243, 228), ending: color(241, 219, 190))!
grad.draw(in: NSRect(x: 0, y: 0, width: S, height: S), angle: -70)

// 内侧高光描边
let border = NSBezierPath(roundedRect: NSRect(x: 5, y: 5, width: S - 10, height: S - 10), xRadius: 228, yRadius: 228)
color(255, 255, 255).withAlphaComponent(0.65).setStroke()
border.lineWidth = 8
border.stroke()

drawBridge(in: NSRect(x: 0, y: 0, width: S, height: S), lineWidth: 46, dotRadius: 60, tint: nil)

icon.unlockFocus()

func writePNG(_ image: NSImage, _ path: String) {
    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { fatalError("png fail") }
    try! png.write(to: URL(fileURLWithPath: path))
}

writePNG(icon, outDir + "/AppIcon.png")

// ---------- 菜单栏模板图标 88px（@2x） ----------
let M: CGFloat = 88
let menu = NSImage(size: NSSize(width: M, height: M))
menu.lockFocus()
drawBridge(in: NSRect(x: 0, y: 0, width: M, height: M), lineWidth: 9, dotRadius: 11, tint: .black)
menu.unlockFocus()
writePNG(menu, outDir + "/menu-icon.png")

print("icons written to \(outDir)")
