#!/usr/bin/env bash
# 构建 Bifrost for macOS：.app（内嵌 node 运行时）→ dist/Bifrost-1.0.0.dmg
# 用法：bash mac/build-app.sh [--no-dmg]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAC="$ROOT/mac"
DIST="$ROOT/dist"
APP="$DIST/Bifrost.app"
VERSION="1.0.0"
NODE_SRC="$(command -v node)"

if [[ -z "${NODE_SRC}" ]]; then
  echo "错误：未找到 node（用于打包内置运行时）" >&2
  exit 1
fi

echo "▸ 清理并创建目录"
rm -rf "$DIST"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bin" "$APP/Contents/Resources/app" "$APP/Contents/Resources/scripts"

echo "▸ 复制应用代码"
cp "$ROOT/server.js" "$ROOT/cli.js" "$ROOT/package.json" "$APP/Contents/Resources/app/"
cp -R "$ROOT/lib" "$APP/Contents/Resources/app/lib"
cp -R "$ROOT/public" "$APP/Contents/Resources/app/public"
cp "$MAC/scripts/"*.sh "$APP/Contents/Resources/scripts/"
chmod +x "$APP/Contents/Resources/scripts/"*.sh

echo "▸ 打包内置 Node 运行时（$(file "$NODE_SRC" | grep -o 'arm64\|x86_64' | head -1)）"
cp "$NODE_SRC" "$APP/Contents/Resources/bin/node"
chmod +x "$APP/Contents/Resources/bin/node"

echo "▸ 编译原生外壳（AppKit + WebKit）"
swiftc "$MAC/main.swift" -o "$APP/Contents/MacOS/Bifrost" -O \
  -framework AppKit -framework WebKit -framework UserNotifications

echo "▸ 生成图标"
swift "$MAC/make-icon.swift" "$APP/Contents/Resources"
ICONSET="$DIST/AppIcon.iconset"
mkdir -p "$ICONSET"
SRC_PNG="$APP/Contents/Resources/AppIcon.png"
for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
  size="${spec%% *}"; name="${spec##* }"
  sips -z "$size" "$size" "$SRC_PNG" --out "$ICONSET/$name.png" > /dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"
rm -f "$SRC_PNG"

echo "▸ 写入 Info.plist"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Bifrost</string>
  <key>CFBundleDisplayName</key><string>Bifrost</string>
  <key>CFBundleIdentifier</key><string>com.rhazen.bifrost</string>
  <key>CFBundleExecutable</key><string>Bifrost</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Bifrost 需要通过 AppleScript 控制 Dia / Chrome（退出浏览器、打开商店页），以完成书签与插件同步。</string>
  <key>NSHumanReadableCopyright</key><string>MIT License</string>
</dict>
</plist>
EOF

echo "▸ 代码签名（ad-hoc）"
codesign --force --sign - "$APP"
codesign --verify --strict "$APP" && echo "  签名校验通过"

if [[ "${1:-}" == "--no-dmg" ]]; then
  echo "✅ 完成：$APP"
  exit 0
fi

echo "▸ 制作 DMG 安装镜像"
STAGE="$DIST/stage"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cp "$ROOT/README.md" "$STAGE/使用说明.md"
hdiutil create -volname "Bifrost ${VERSION}" -srcfolder "$STAGE" -ov -format UDZO "$DIST/Bifrost-${VERSION}.dmg" > /dev/null
rm -rf "$STAGE"

echo "✅ 完成："
echo "   $APP"
echo "   $DIST/Bifrost-${VERSION}.dmg"
