#!/usr/bin/env bash
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.rhazen.bifrost-synchro.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "✅ LaunchAgent 已卸载，Bifröst 常驻服务已停止"
echo "（应用副本保留在 ~/Library/Application Support/Bifrost，可手动删除）"
