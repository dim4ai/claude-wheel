#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$HOME/builds/claude-wheel-mobile"

echo "==> Синхронизирую исходники в $BUILD_DIR"
mkdir -p "$BUILD_DIR"
rsync -a --delete \
  --exclude=node_modules \
  --exclude=android \
  --exclude=ios \
  --exclude=.expo \
  --exclude=package-lock.json \
  "$SCRIPT_DIR/" "$BUILD_DIR/"

cd "$BUILD_DIR"

echo "==> Устанавливаю зависимости"
npm install --prefer-offline

if [ ! -d android ] || [ app.json -nt android/.prebuild-stamp ]; then
  echo "==> expo prebuild"
  rm -rf android
  npx expo prebuild --platform android --no-install
  # Только arm64 — быстрее, достаточно для реальных устройств
  sed -i 's/abiFilters "arm64-v8a", "armeabi-v7a", "x86", "x86_64"/abiFilters "arm64-v8a"/' \
    android/app/build.gradle
  touch android/.prebuild-stamp
fi

echo "==> Собираю APK"
cd android
./gradlew assembleRelease --console=plain

APK=$(find app/build/outputs/apk/release -name "*.apk" | head -1)
echo ""
echo "==> Готово: $BUILD_DIR/android/$APK"
cp "$APK" "$HOME/builds/claude-wheel.apk"
echo "==> Скопировано в ~/builds/claude-wheel.apk"
