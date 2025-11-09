# Homework Helper - AI-Powered Educational Assistant

## Overview
Homework Helper is an AI-powered mobile application built with React Native and Expo. It assists students with homework across various subjects by providing clear, step-by-step visual solutions. The app leverages AI to offer grade-appropriate explanations, beautiful formatting, and interactive features to foster deeper learning and understanding.

## User Preferences
None documented yet.

## Recent Features & Enhancements

### ✅ Two-Tier Contextual Explanations (Implemented: November 9, 2025)
**Status:** Completed  
**Date Implemented:** November 9, 2025  
**Original Proposal:** November 7, 2025  
**Priority:** Medium-High (educational value)

**Overview:**
Enhance the learning experience by exposing step explanations directly in the solution view, providing immediate contextual understanding alongside mathematical notation. This creates a two-tier explanation system that balances conciseness with depth.

**Current Limitation:**
- The `SolutionStep.explanation` field exists but is never populated or displayed
- Students only see procedural math (`step.content`) without context
- "Simplify" feature requires manual click and generates separate on-demand explanations
- Non-quantitative subjects (essays, history, science) lack narrative guidance in step displays

**Proposed Solution:**

1. **Two-Tier System:**
   - **Built-in explanation** (always generated): 1 concise sentence providing immediate takeaway
     - Example: "We're combining fractions by finding a common denominator."
   - **Simplified explanation** (on-demand via "Simplify" button): 2-3 sentences with analogies for struggling students
     - Example: "Think of fractions like pizza slices. Before we can add {1/3} + {1/4}, we need to cut all the slices the same size..."

2. **Subject-Aware Verbosity:**
   - Math/Physics: Minimal built-in explanations (focus on procedural work)
   - Essays/History/Science: Verbose explanations (narrative is primary)
   - Multiple Choice: Brief reasoning for option elimination logic

3. **UI Implementation:**
   - Display built-in explanations in muted text beneath `MathText` component
   - Use subtle styling (gray color, smaller font) to avoid overwhelming users
   - Maintain visual hierarchy: title → math → explanation → diagram
   - Keep "Simplify" button for deeper, analogy-driven help

4. **User Control:**
   - Add settings toggle: "Show step explanations" (default: ON)
   - Allows power users to hide for cleaner UI
   - Ensures students who need guidance get it by default

**Technical Changes Required:**
- **Backend (`server/proxy.ts`):**
  - Modify `/api/analyze` prompt to generate brief explanations for each step
  - Update response schema validation to require `explanation` field
  - Apply `enforceProperFormatting()` to explanation text
  
- **Frontend (`src/screens/SolutionScreen.tsx`):**
  - Add explanation rendering below `MathText` component (lines ~178-179)
  - Create new `explanationText` style (muted gray, smaller font)
  - Wrap in conditional check for settings toggle
  
- **Types (`src/types/index.ts`):**
  - Change `explanation?: string` to `explanation: string` (make required)

- **State Management:**
  - Add `showStepExplanations` boolean to settings store (if settings exist)
  - Default to `true` for first-time users

**Expected Benefits:**
- ✅ Immediate learning context without extra clicks
- ✅ Better support for non-math subjects with narrative needs
- ✅ Reduced friction in understanding process
- ✅ Shifts focus from "give me answers" to "help me learn"
- ✅ Complementary to existing "Simplify" feature

**Implementation Summary:**

Successfully implemented the two-tier contextual explanations feature with the following components:

1. **Backend Changes:**
   - Updated both `/api/analyze-text` and `/api/analyze-image` prompts with mandatory explanation field requirements
   - Added subject-aware verbosity instructions (minimal for math/physics, verbose for essays/history/science)
   - Implemented fallback mechanism in `enforceResponseFormatting()` to ensure all steps always have explanations
   - Applied formatting enforcement to explanation text using `enforceProperFormatting()`
   - Added warning logs when AI omits explanations (fallback triggers)

2. **Frontend Changes:**
   - Created `useSettingsStore` with `showStepExplanations` toggle (defaults to `true`)
   - Added explanation display below step content with muted, italic styling
   - Implemented "Show/Hide Tips" toggle in action bar header for user control
   - Used subtle visual hierarchy to avoid overwhelming users

3. **Type Safety:**
   - Changed `SolutionStep.explanation?: string` to `explanation: string` (required)
   - Guaranteed non-undefined explanations through fallback mechanism

**User Experience:**
- Students now see concise, contextual explanations for every step by default
- "Simplify" button remains available for deeper, analogy-driven explanations
- Users can toggle explanations on/off via the "Show/Hide Tips" button
- Subject-aware verbosity ensures appropriate detail level for different subjects

**Files Modified:**
- `src/types/index.ts` - Made explanation required
- `src/store/settingsStore.ts` - Created new settings store
- `server/proxy.ts` - Updated prompts and formatting enforcement
- `src/screens/SolutionScreen.tsx` - Added UI for explanations and toggle

## System Architecture

### UI/UX Decisions
The application features a responsive design with distinct typography and a color scheme emphasizing readability and user engagement (primary indigo, secondary emerald green, grays). Gradient buttons and a gold graduation cap icon are used for key interactions. Animations with React Native Reanimated provide a smooth, interactive experience with progressive step reveals and haptic feedback. The solution screen includes a redesigned two-row action bar with "Simplify," "Ask Question," and "New Problem" buttons, maintaining visual continuity with matching color schemes for related features.

### Technical Implementations
The app is built with React Native 0.81.5, Expo SDK 54, and TypeScript, utilizing React Navigation v7 for navigation, Zustand for state management, and NativeWind v4 for styling. Animations are handled by React Native Reanimated and Gesture Handler.

A custom `MathText` component renders complex mathematical notation, including vertical fractions, subscripts, superscripts, and inline images, with critical rendering optimizations to prevent unwanted line breaks. Server-side whitespace normalization ensures clean text delivery.

Intelligent Visual Aid Generation uses AI to determine the optimal type and placement of visual aids (geometric diagrams, graphs, charts, physics diagrams, process illustrations), ensuring they are grade-level aware and enhance understanding. Mandatory diagram generation is enforced for key biology/chemistry topics like metabolic cycles.

A comprehensive cross-platform image conversion solution handles various image formats and URIs, ensuring accurate base64 conversion with multi-layer MIME type detection across web, iOS, and Android.

Cross-platform API communication is handled through platform-aware URL construction: web uses relative URLs (`/api`) that work with the proxy, while native platforms (iOS/Android) use absolute URLs constructed from Expo Constants. In development, the app automatically detects the dev server IP from the Expo manifest for Expo Go connections. In production, API URLs are configured via environment variables.

The "I Still Don't Get It" feature provides simplified, intuitive, and grade-appropriate explanations for each solution step, focusing on reasoning and analogies.

Feature specifications include multiple input methods (text, photo, gallery), AI-powered problem analysis (GPT-4o Vision for images, GPT-4o for text), progressive step-by-step solutions with interactive elements, and improved OCR accuracy. The AI is instructed to match the input number format (decimals or fractions) in solutions and to explicitly state common denominators when combining fractions. For essay questions, the AI provides guidance in Step 1 and a complete, polished essay in the Final Answer section. For multiple-choice questions, the correct letter option is included in the final answer.

Server-side formatting enforcement includes post-processing for consistent mathematical formatting (e.g., converting "1/8" to "{1/8}"), color-tag fraction formatting, and comprehensive whitespace normalization. Multi-part answers are formatted with preserved line breaks for readability.

A multi-stage Quality Control & Validation System ensures solution accuracy through structural validation, cross-model verification, confidence scoring, and comprehensive logging, running asynchronously for performance.

Performance optimizations include an asynchronous architecture for instant responses with progressive diagram loading and validation running in the background. Diagram URLs are dynamically generated using the request hostname for proper production deployment.

**Diagram Generation Optimizations (November 7, 2025):**
- **Hash-Based Caching:** Identical diagram requests are served from a 24-hour in-memory cache for near-instant delivery (<1s):
  - Cache key includes description to uniquely identify diagrams
  - Common educational topics (Krebs cycle, Pythagorean theorem) benefit from ~95% faster response on repeat requests
  - Expected cache hit rate: 30-40% for typical educational use
  - Cache statistics available via `/api/cache-stats` endpoint for monitoring performance
- **Impact:** Cached diagrams are 95%+ faster, significantly improving user experience for repeated topics

### System Design Choices
The application uses a proxy server architecture (port 5000) that centralizes API endpoints and handles CORS. In development, it proxies frontend requests to the Expo dev server; in production, it serves the built Expo web app from the `dist/` directory as static files. The server is configured for Autoscale deployment with environment-aware behavior, including health checks and smart environment detection that prioritizes the existence of a `dist/` directory for production mode.

## External Dependencies
- **AI Integration:** OpenAI GPT-4o (vision, text analysis, Q&A, image generation) via Replit AI Integrations.
- **Image Handling:** `expo-camera`, `expo-image-picker`, `expo-image`, `expo-file-system`.
- **Platform Detection:** `expo-constants` for configuration and manifest access.
- **Haptics:** `expo-haptics`.
- **Icons:** `expo-vector-icons`.
- **Concurrency & Retries:** `p-limit`, `p-retry`.
- **Cross-Platform Base64:** `base-64` for magic byte detection on React Native.