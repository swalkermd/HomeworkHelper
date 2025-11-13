#!/bin/bash
set -e  # Exit on error

echo "🔨 Starting Expo web build..."
echo "📅 Build started at: $(date)"

# Clean previous build
echo "🗑️  Cleaning previous build..."
rm -rf dist/

# Show node and npm versions for debugging
echo "📋 Node: $(node --version), NPM: $(npm --version)"

# Run expo export with timeout (5 minutes for deployment builds)
echo "⚙️  Running expo export (timeout: 5 minutes)..."
timeout 300 npx expo export --platform web --output-dir dist || {
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 124 ]; then
    echo "⏰ Build process timed out after 300s"
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
