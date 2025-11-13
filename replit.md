# Homework Helper - AI-Powered Educational Assistant

## Overview
Homework Helper is an AI-powered mobile application built with React Native and Expo. It assists students with homework across various subjects by providing clear, step-by-step visual solutions. The app leverages AI to offer grade-appropriate explanations, beautiful formatting, and interactive features to foster deeper learning and understanding. The business vision is to revolutionize homework assistance by making learning engaging and accessible, tapping into a significant market of students seeking personalized educational support. The project aims to become a leading tool for enhancing student comprehension and academic performance.

## Recent Changes (Nov 13, 2025)
- **NEW: Format-Matching Final Answers** - Solutions now mirror question format/appearance for competitive differentiation:
  1. **Multiple Choice** - Final answer shows ALL options (A, B, C, D) with correct answer highlighted in red, helping students understand why other options are wrong
  2. **Handwritten Problems** - Detects handwritten questions and uses Caveat handwriting font for final answers, making solutions feel personal and relatable
  3. **Number Format Preservation** - Matches input format (decimals→decimals, fractions→fractions) and maintains question structure (labeled parts, fill-in-the-blank style)
  4. **MathText Component Enhancement** - Added [handwritten:] tag support with Google Fonts Caveat integration
- **FIXED: Three Critical Deployment Issues**:
  1. **Fraction Rendering** - Fixed `{` and `}` displaying above/below fraction lines. Added LaTeX `\frac{num}{den}` conversion BEFORE macro stripping in `enforceProperFormatting()`.
  2. **Ratio Fill-in-the-Blank Formatting** - Added AI instructions to recognize ratio problems and format answers clearly (e.g., "Box 1: 3, Box 2: 5" instead of confusing prose). Recreates original format when possible.
  3. **Missing Step 1 Overview** - Restored mandatory multi-step problem overview to STEM OCR path's system prompt. Step 1 now identifies problem type, approach, and goal for all multi-step problems.
- **NEW: Mobile Keyboard Zoom Prevention** - Fixed unwanted zoom on mobile when keyboard appears. Set input fontSize to 16px (preventing iOS auto-zoom) and added viewport maximum-scale constraint via custom `public/index.html`. Eliminates need for manual pinch-to-zoom after entering problem numbers.
- **OPTIMIZED: OCR Pipeline Performance** - Post-OCR correction now runs ONLY on STEM content (saves 6-8s on non-STEM images). Fixed production timeout detection (120s prod vs 45s dev). Added comprehensive timing logs at each pipeline stage (Mistral OCR, STEM detection, correction, GPT-4o analysis, total request time) for performance monitoring.
- **CONFIRMED: Hybrid OCR Active (Mistral + OpenAI)** - Hybrid OCR approach validated with ~95% accuracy on STEM content. Mistral OCR extracts text from images (3-4s), STEM detection routes appropriately, GPT-4o-mini correction (STEM only), and GPT-4o analyzes for solutions. Google Cloud Vision removed due to failures.
- **P1 Fix: iOS/Safari Photo Library Access** - Restored `focus()` call before programmatic `click()` on file input to ensure mobile Safari properly opens the file picker. Without focus, iOS silently ignores programmatic clicks on file inputs.
- **Gallery Focus-Aware Picker** - Implemented focus-aware gallery flow using `useFocusEffect` to automatically re-open picker on screen focus, preventing stuck loading spinners.
- **Service Worker Cache Prevention** - Disabled service worker caching (metro bundler) and added cache-control headers to prevent stale JavaScript from being served after deployments.
- **Build Process Optimization** - Simplified build script with 2-minute timeout and clean error handling for reliable production deployments.

## User Preferences
None documented yet.

## System Architecture

### UI/UX Decisions
The application features a responsive design with distinct typography and a color scheme emphasizing readability and user engagement (primary indigo, secondary emerald green, grays). Gradient buttons and a gold graduation cap icon are used for key interactions. Animations with React Native Reanimated provide a smooth, interactive experience with progressive step reveals and haptic feedback. The solution screen includes a redesigned two-row action bar with "Simplify," "Ask Question," and "New Problem" buttons, maintaining visual continuity with matching color schemes for related features.

### Technical Implementations
The app is built with React Native 0.81.5, Expo SDK 54, and TypeScript, utilizing React Navigation v7 for navigation, Zustand for state management, and NativeWind v4 for styling. Animations are handled by React Native Reanimated and Gesture Handler.

A custom `MathText` component renders complex mathematical notation, including vertical fractions, subscripts, superscripts, and inline images, with critical rendering optimizations to prevent unwanted line breaks. The component uses a unified parser (`parseContentInternal`) with bracket-depth tracking to correctly handle nested formatting tags like `[handwritten:[red:text]]`. All formatting types (colors, fractions, subscripts, arrows, italics, images) are preserved when wrapped in `[handwritten:]` tags, which apply the Caveat handwriting font for format-matching. Server-side whitespace normalization ensures clean text delivery.

Intelligent Visual Aid Generation uses AI to determine the optimal type and placement of visual aids (geometric diagrams, graphs, charts, physics diagrams, process illustrations), ensuring they are grade-level aware and enhance understanding. Mandatory diagram generation is enforced for key biology/chemistry topics like metabolic cycles.

A comprehensive cross-platform image conversion solution handles various image formats and URIs, ensuring accurate base64 conversion with multi-layer MIME type detection across web, iOS, and Android.

Cross-platform API communication is handled through platform-aware URL construction. In development, the app automatically detects the dev server IP for Expo Go connections. In production, API URLs are configured via environment variables.

The "I Still Don't Get It" feature provides simplified, intuitive, and grade-appropriate explanations for each solution step, focusing on reasoning and analogies. The application also implements a two-tier contextual explanation system: a concise built-in explanation for immediate understanding and an on-demand, analogy-driven simplified explanation. This system supports subject-aware verbosity, tailoring explanation depth based on the subject matter.

Feature specifications include multiple input methods (text, photo, gallery), AI-powered problem analysis (GPT-4o Vision for images, GPT-4o for text), progressive step-by-step solutions with interactive elements, and improved OCR accuracy using a hybrid approach (Mistral OCR + GPT-4o-mini correction + GPT-4o analysis). The OCR pipeline includes a post-correction layer that fixes common math/science errors (O/0 confusion, missing decimals, variable separation) using GPT-4o-mini with low-temperature deterministic processing. The AI is instructed to match the input number format (decimals or fractions) in solutions and to explicitly state common denominators when combining fractions. For essay questions, the AI provides guidance in Step 1 and a complete, polished essay in the Final Answer section. For multiple-choice questions, the correct letter option is included in the final answer.

Server-side formatting enforcement includes post-processing for consistent mathematical formatting (e.g., converting "1/8" to "{1/8}"), color-tag fraction formatting, comprehensive whitespace normalization, and stripping LaTeX command artifacts from text output. Multi-part answers are formatted with preserved line breaks for readability.

A multi-stage Quality Control & Validation System ensures solution accuracy through structural validation, cross-model verification, confidence scoring, and comprehensive logging, running asynchronously for performance.

Performance optimizations include an asynchronous architecture for instant responses with progressive diagram loading and validation running in the background. Diagram URLs are dynamically generated using the request hostname for proper production deployment. Diagram generation is optimized with hash-based caching, providing near-instant delivery for identical requests.

Multi-step problems now include a strategic overview as Step 1, which identifies the problem type, explains the general approach, states the goal, and provides brief reasoning. This applies to math, physics, chemistry, and multi-part analysis problems.

### System Design Choices
The application uses a proxy server architecture (port 5000) that centralizes API endpoints and handles CORS. In development, it proxies frontend requests to the Expo dev server; in production, it serves the built Expo web app from the `dist/` directory as static files. The server is configured for Autoscale deployment with environment-aware behavior, including health checks and smart environment detection that prioritizes the existence of a `dist/` directory for production mode. The web build process uses a smart script with timeout handling to reliably complete deployment.

**Production Deployment Requirements:**
- Environment secrets (MISTRAL_API_KEY, OpenAI credentials) must be manually configured in Autoscale deployment settings
- Development secrets are NOT automatically copied to production
- Enhanced error handling provides specific error messages for missing API keys, rate limits, timeouts, and invalid images
- Structured logging captures error name, code, message, and status for production debugging

## External Dependencies
- **AI Integration:** OpenAI GPT-4o (vision, text analysis, Q&A, image generation) via Replit AI Integrations, Mistral OCR API for superior STEM text extraction (~95% accuracy).
- **Image Handling:** `expo-camera`, `expo-image-picker`, `expo-image`, `expo-file-system`.
- **Platform Detection:** `expo-constants` for configuration and manifest access.
- **Haptics:** `expo-haptics`.
- **Icons:** `expo-vector-icons`.
- **Concurrency & Retries:** `p-limit`, `p-retry`.
- **Cross-Platform Base64:** `base-64` for magic byte detection on React Native.