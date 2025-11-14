# Homework Helper - AI-Powered Educational Assistant

## Overview
Homework Helper is an AI-powered mobile application built with React Native and Expo. It assists students with homework across various subjects by providing clear, step-by-step visual solutions. The app leverages AI to offer grade-appropriate explanations, beautiful formatting, and interactive features to foster deeper learning and understanding. The business vision is to revolutionize homework assistance by making learning engaging and accessible, tapping into a significant market of students seeking personalized educational support, and aiming to become a leading tool for enhancing student comprehension and academic performance.

## Recent Changes (Nov 14, 2025)
- **FIXED: JSON Parse Errors for Complex Problems** - Added automatic JSON repair logic to handle malformed AI responses for complex multi-part problems. System now detects and repairs unclosed arrays/objects, logs detailed error information, and attempts recovery before failing. Prevents "failed to analyze" errors on long, complex solutions.
- **FIXED: Improper Line Breaks in Math Expressions** - Changed MathText container from `flexWrap: 'wrap'` to `flexWrap: 'nowrap'` to prevent mathematical expressions from breaking apart mid-equation. Eliminates orphaned text (like "sin" appearing alone on a new line) and keeps complete expressions together for readability.
- **FIXED: Critical Fraction Overlap Issue** - Removed `translateY: -8` transform from fraction container that was causing fractions to overlap with text above them. Fractions now render inline without vertical displacement, preventing text overlap and orphaned punctuation.
- **FIXED: Arrow Vertical Alignment** - Adjusted green arrow (→) positioning in solution steps to align with the horizontal midline of numbers. Added 3px downward offset using relative positioning for better visual alignment.
- **FIXED: Raw Newline in Fraction Output** - Fixed issue where AI was outputting fractions with raw newlines (e.g., "1\n2") instead of proper LaTeX or slash notation. Added pre-processor to detect and convert these malformed fractions to slash notation ("1/2") before whitespace normalization. Updated AI prompts to mandate LaTeX `\frac{num}{den}` or slash notation, which MathText then renders as beautiful vertical fractions for display.
- **UX: Simplified Final Answer Section** - Removed instructional text ("Double-check the concluding statement..." and "Reviewed for completeness and clarity") from final answer display. Changed "Verified Result" label to just "Answer" for clarity.
- **UX: Hidden Difficulty Level** - Removed difficulty level from solution screen display to reduce visual clutter. Difficulty is still tracked internally and can be revealed if user asks about it.
- **FIXED: Critical Fraction Formatting Bug** - Rewrote fraction conversion logic using brace-aware tokenizer to prevent double-wrapping. Fixed bug where `{240/41}` was corrupted to `{2{40/4}1}`. New tokenizer skips already-wrapped fractions in curly braces while still processing fractions in parentheses. Includes unit allowlist (h, m, s, c, cm, ft, in, kg, etc.) to preserve measurement units outside braces (`12/5h` → `{12/5}h`) while keeping algebraic variables inside (`3x/4y` → `{3x/4y}`).
- **NEW: Automatic Diagram Generation for Geometry Problems** - Added deterministic measurement diagram enforcement using keyword classifier. Geometry/measurement problems (cutting, dividing, measuring) with units and fractions now automatically trigger diagram generation even if AI omits them. Uses ≥2 signal threshold (geometry actions, measurement nouns, units, fractions) to avoid false positives.
- **FIXED: Line Break in Mixed Number Measurements** - Enhanced MathText component to prevent line breaks between fractions and following hyphens/units. Fixed issue where "20{1/2}-inch" would break across lines. Fractions followed by hyphens are now wrapped together in a single non-wrapping View container.

## User Preferences
None documented yet.

## System Architecture

### UI/UX Decisions
The application features a responsive design with distinct typography and a color scheme emphasizing readability and user engagement (primary indigo, secondary emerald green, grays). Gradient buttons and a gold graduation cap icon are used for key interactions. Animations with React Native Reanimated provide a smooth, interactive experience with progressive step reveals and haptic feedback. The solution screen includes a redesigned two-row action bar with "Simplify," "Ask Question," and "New Problem" buttons, maintaining visual continuity with matching color schemes for related features.

### Technical Implementations
The app is built with React Native 0.81.5, Expo SDK 54, and TypeScript, utilizing React Navigation v7 for navigation, Zustand for state management, and NativeWind v4 for styling. Animations are handled by React Native Reanimated and Gesture Handler.

A custom `MathText` component renders complex mathematical notation, including vertical fractions, subscripts, superscripts, and inline images, with critical rendering optimizations and support for nested formatting tags like `[handwritten:[red:text]]`. Intelligent Visual Aid Generation uses AI to determine optimal type and placement of visual aids, ensuring they are grade-level aware and enhance understanding. Mandatory diagram generation is enforced for key biology/chemistry topics.

A comprehensive cross-platform image conversion solution handles various image formats and URIs. Cross-platform API communication is handled through platform-aware URL construction. The "I Still Don't Get It" feature provides simplified, intuitive, and grade-appropriate explanations for each solution step, focusing on reasoning and analogies, with a two-tier contextual explanation system supporting subject-aware verbosity.

Feature specifications include multiple input methods (text, photo, gallery), AI-powered problem analysis (GPT-4o Vision for images, GPT-4o for text), progressive step-by-step solutions, and improved OCR accuracy using a hybrid approach (Mistral OCR + GPT-4o-mini correction + GPT-4o analysis). The OCR pipeline includes a post-correction layer for common math/science errors. The AI is instructed to match input number format and explicitly state common denominators. For essay questions, AI provides guidance and a complete essay. For multiple-choice questions, the correct letter option is included. Server-side formatting enforcement includes post-processing for consistent mathematical formatting, color-tag fraction formatting, comprehensive whitespace normalization, and stripping LaTeX command artifacts. Multi-part answers are formatted with preserved line breaks.

A multi-stage Quality Control & Validation System ensures solution accuracy through structural validation, cross-model verification, confidence scoring, and comprehensive logging, running asynchronously. Performance optimizations include an asynchronous architecture for instant responses with progressive diagram loading and validation in the background. Diagram generation is optimized with hash-based caching. Multi-step problems now include a strategic overview as Step 1, identifying problem type, approach, and goal.

### System Design Choices
The application uses a proxy server architecture (port 5000) that centralizes API endpoints and handles CORS. It proxies frontend requests in development and serves the built Expo web app in production. The server is configured for Autoscale deployment with environment-aware behavior, including health checks and smart environment detection.

Production Deployment Requirements:
- Environment secrets (MISTRAL_API_KEY, OpenAI credentials) must be manually configured in Autoscale deployment settings.
- Enhanced error handling provides specific error messages for missing API keys, rate limits, timeouts, and invalid images.
- Structured logging captures error name, code, message, and status for production debugging.

## External Dependencies
- **AI Integration:** OpenAI GPT-4o (vision, text analysis, Q&A, image generation) via Replit AI Integrations, Mistral OCR API.
- **Image Handling:** `expo-camera`, `expo-image-picker`, `expo-image`, `expo-file-system`.
- **Platform Detection:** `expo-constants`.
- **Haptics:** `expo-haptics`.
- **Icons:** `expo-vector-icons`.
- **Concurrency & Retries:** `p-limit`, `p-retry`.
- **Cross-Platform Base64:** `base-64`.