# Homework Helper - AI-Powered Educational Assistant

## Overview
Homework Helper is an AI-powered mobile application built with React Native and Expo. It assists students with homework across various subjects by providing clear, step-by-step visual solutions. The app leverages AI to offer grade-appropriate explanations, beautiful formatting, and interactive features to foster deeper learning and understanding. The business vision is to revolutionize homework assistance by making learning engaging and accessible, tapping into a significant market of students seeking personalized educational support. The project aims to become a leading tool for enhancing student comprehension and academic performance.

## User Preferences
None documented yet.

## Recent Fixes & Improvements (November 11, 2025)

### ✅ Enhanced OCR Quality for Image Capture
**Problem:** Photo capture used default ~50% JPEG quality, causing blurry text. GPT-4o processed images at automatic resolution, leading to poor OCR on dense homework scans. Users reported missing decimals and crucial characters (e.g., "rt" interpreted as "11").
**Fix:** 
- Camera capture now uses `quality: 1` (maximum quality) for full-resolution photos
- GPT-4o vision API now requests `detail: "high"` for maximum fidelity OCR processing
- **Enhanced OCR prompt instructions:**
  - ALL CAPS emphasis on decimal point detection as absolute priority
  - Comprehensive character-by-character accuracy checklist (decimals, operators, signs, parentheses, exponents, variables)
  - Specific examples of decimal OCR errors to avoid (3.14 vs 314, 0.5 vs 5, 19.6 vs 196)
  - **Letter/number confusion prevention** with explicit examples (r vs 1, t vs 1, l vs 1, O vs 0, S vs 5)
  - Context-based verification rules (variable names vs coefficients)
  - Common physics variables reference (r=radius, t=time, v=velocity)
  - Explicit instruction: "rt means r × t, NOT 11"
  - Mandatory verification checklist before solving any problem
  - Final character-by-character mental read-through requirement
- **Known Limitation:** GPT-4o vision achieves ~80% OCR accuracy (industry research). For production-grade accuracy (96-99%), hybrid OCR approach recommended (specialized OCR + GPT-4o reasoning)
- Result: Improved text recognition, especially for decimals and letter/number disambiguation. Hybrid OCR may be needed for mission-critical accuracy.

### ✅ Fixed: Variable Fraction Rendering (x/10c)
**Problem:** Fractions containing variables (like x/10c, a/b, 3x/4) were not being converted to vertical format, displaying as inline text instead.
**Fix:** 
- Updated server-side fraction formatting to handle both numeric (1/8) and variable fractions (x/10c)
- Smart detection: only converts expressions with at least one digit (excludes units like m/s, km/h)
- Prevents false positives while ensuring all algebraic fractions display vertically

## Recent Fixes & Improvements (November 9, 2025)

### ✅ Fixed: Vertical Fraction Rendering in Highlighted Text
**Problem:** Fractions inside color-highlighted sections (`[blue:...]`, `[red:...]`) displayed as inline text instead of vertical fractions.
**Fix:** Added recursive parsing for fractions within highlighted content. Fractions now render vertically with proper color highlighting.

### ✅ Fixed: LaTeX Command Artifacts  
**Problem:** LaTeX commands (`\text{kg}`, `\\,`, `m/s^2^`) appeared as literal text.
**Fix:** Added comprehensive LaTeX stripping with iterative replacement, Greek symbol conversion, and double-caret cleanup.

### ✅ Fixed: Decimal Division Bug
**Problem:** Fraction regex incorrectly converted `{19.6/5.0}` to `{19.{6/5}.0}`.
**Fix:** Updated regex to exclude decimal points: `(?<![{/.\d])(\d+)\/(\d+)(?![}./\d])`. Decimal divisions now remain intact.

### ✅ Fixed: Diagram Decimal Formatting
**Problem:** Generated diagrams used European decimal format (14,14 instead of 14.14).
**Fix:** Made decimal formatting instruction absolutely emphatic:
- ALL CAPS directives at beginning, middle, and end of prompt
- Explicit "DO NOT" examples: "WRITE 14.14 NOT 14,14"
- Multiple reminders throughout prompt
- Cache cleared on restart to prevent old diagrams from reappearing

### ✅ Two-Tier Contextual Explanations Feature  
**Added:** Concise step explanations displayed by default with subject-aware verbosity. Toggle control added in action bar.

## System Architecture

### UI/UX Decisions
The application features a responsive design with distinct typography and a color scheme emphasizing readability and user engagement (primary indigo, secondary emerald green, grays). Gradient buttons and a gold graduation cap icon are used for key interactions. Animations with React Native Reanimated provide a smooth, interactive experience with progressive step reveals and haptic feedback. The solution screen includes a redesigned two-row action bar with "Simplify," "Ask Question," and "New Problem" buttons, maintaining visual continuity with matching color schemes for related features.

### Technical Implementations
The app is built with React Native 0.81.5, Expo SDK 54, and TypeScript, utilizing React Navigation v7 for navigation, Zustand for state management, and NativeWind v4 for styling. Animations are handled by React Native Reanimated and Gesture Handler.

A custom `MathText` component renders complex mathematical notation, including vertical fractions, subscripts, superscripts, and inline images, with critical rendering optimizations to prevent unwanted line breaks. Server-side whitespace normalization ensures clean text delivery.

Intelligent Visual Aid Generation uses AI to determine the optimal type and placement of visual aids (geometric diagrams, graphs, charts, physics diagrams, process illustrations), ensuring they are grade-level aware and enhance understanding. Mandatory diagram generation is enforced for key biology/chemistry topics like metabolic cycles.

A comprehensive cross-platform image conversion solution handles various image formats and URIs, ensuring accurate base64 conversion with multi-layer MIME type detection across web, iOS, and Android.

Cross-platform API communication is handled through platform-aware URL construction: web uses relative URLs (`/api`) that work with the proxy, while native platforms (iOS/Android) use absolute URLs constructed from Expo Constants. In development, the app automatically detects the dev server IP from the Expo manifest for Expo Go connections. In production, API URLs are configured via environment variables.

The "I Still Don't Get It" feature provides simplified, intuitive, and grade-appropriate explanations for each solution step, focusing on reasoning and analogies. The application also implements a two-tier contextual explanation system: a concise built-in explanation for immediate understanding and an on-demand, analogy-driven simplified explanation. This system supports subject-aware verbosity, tailoring explanation depth based on the subject matter.

Feature specifications include multiple input methods (text, photo, gallery), AI-powered problem analysis (GPT-4o Vision for images, GPT-4o for text), progressive step-by-step solutions with interactive elements, and improved OCR accuracy. The AI is instructed to match the input number format (decimals or fractions) in solutions and to explicitly state common denominators when combining fractions. For essay questions, the AI provides guidance in Step 1 and a complete, polished essay in the Final Answer section. For multiple-choice questions, the correct letter option is included in the final answer.

Server-side formatting enforcement includes post-processing for consistent mathematical formatting (e.g., converting "1/8" to "{1/8}"), color-tag fraction formatting, comprehensive whitespace normalization, and stripping LaTeX command artifacts from text output. Multi-part answers are formatted with preserved line breaks for readability.

A multi-stage Quality Control & Validation System ensures solution accuracy through structural validation, cross-model verification, confidence scoring, and comprehensive logging, running asynchronously for performance.

Performance optimizations include an asynchronous architecture for instant responses with progressive diagram loading and validation running in the background. Diagram URLs are dynamically generated using the request hostname for proper production deployment. Diagram generation is optimized with hash-based caching, providing near-instant delivery for identical requests.

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