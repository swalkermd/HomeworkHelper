#!/bin/bash

# Expo Web Build Script with Timeout Workaround
# Addresses known issue: expo export --platform web hangs after successful completion
# GitHub issues: #27938, #26448

echo "🔨 Starting Expo web build..."

# Start expo export in background
npx expo export --platform web &
EXPORT_PID=$!

# Wait for build completion (max 5 minutes)
MAX_WAIT=300
ELAPSED=0
INTERVAL=5

while [ $ELAPSED -lt $MAX_WAIT ]; do
  # Check if dist/index.html exists (build complete)
  if [ -f "dist/index.html" ]; then
    echo "✅ Build completed successfully! (${ELAPSED}s)"
    echo "📦 Output: dist/"

    # Kill the hanging process
    kill $EXPORT_PID 2>/dev/null || true

    # Verify build artifacts
    if [ -d "dist/_expo" ]; then
      echo "✅ Expo assets bundled"
    fi

    # ADD CACHE BUSTING
    echo "🔄 Adding cache-busting headers..."
    BUILD_TIME=$(date +%s)

    # Add build timestamp to index.html
    if [ -f "dist/index.html" ]; then
      sed -i "s/<head>/<head><meta name=\"build-time\" content=\"${BUILD_TIME}\">/" dist/index.html
      echo "✅ Cache-busting header added: ${BUILD_TIME}"
    fi

    exit 0
  fi
  
  # Still building...
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
  
  # Show progress every 15 seconds
  if [ $((ELAPSED % 15)) -eq 0 ]; then
    echo "⏳ Building... (${ELAPSED}s elapsed)"
  fi
done

# Timeout reached
echo "⚠️  Build timeout after ${MAX_WAIT}s"
echo "Checking if build completed anyway..."

if [ -f "dist/index.html" ]; then
  echo "✅ Build artifacts found despite timeout - proceeding"
  kill $EXPORT_PID 2>/dev/null || true

  # ADD CACHE BUSTING (same as above)
  echo "🔄 Adding cache-busting headers..."
  BUILD_TIME=$(date +%s)
  if [ -f "dist/index.html" ]; then
    sed -i "s/<head>/<head><meta name=\"build-time\" content=\"${BUILD_TIME}\">/" dist/index.html
    echo "✅ Cache-busting header added: ${BUILD_TIME}"
  fi

  exit 0
else
  echo "❌ Build failed or incomplete"
  kill $EXPORT_PID 2>/dev/null || true
  exit 1
fi
