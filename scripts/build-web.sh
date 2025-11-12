#!/bin/bash
set -e  # Exit on error

echo "🔨 Starting Expo web build..."

# Clean previous build
rm -rf dist/

# Run expo export with timeout (2 minutes should be enough)
timeout 120 npx expo export --platform web || {
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 124 ]; then
    echo "⏰ Build process timed out after 120s"
    # Check if build actually completed despite timeout
    if [ -f "dist/index.html" ]; then
      echo "✅ Build artifacts found - build succeeded"
    else
      echo "❌ Build incomplete"
      exit 1
    fi
  else
    echo "❌ Build failed with exit code $EXIT_CODE"
    exit $EXIT_CODE
  fi
}

# Verify build
if [ ! -f "dist/index.html" ]; then
  echo "❌ dist/index.html not found"
  exit 1
fi

echo "✅ Build completed successfully!"
echo "📦 Output: dist/"

# Add cache-busting timestamp
BUILD_TIME=$(date +%s)
if [ -f "dist/index.html" ]; then
  sed -i "s/<head>/<head><meta name=\"build-time\" content=\"${BUILD_TIME}\">/" dist/index.html || true
  echo "✅ Cache-busting header added: ${BUILD_TIME}"
fi

exit 0
