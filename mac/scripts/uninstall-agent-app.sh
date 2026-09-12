#!/usr/bin/env bash
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.rhazen.bifrost-synchro.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "后台计划服务已卸载（Bifrost.app 打开时仍可同步）"
