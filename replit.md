# Homework Helper - AI-Powered Educational Assistant

## Overview
Homework Helper is an AI-powered mobile application built with React Native and Expo. It assists students with homework across various subjects by providing clear, step-by-step visual solutions. The app leverages AI to offer grade-appropriate explanations, beautiful formatting, and interactive features to foster deeper learning and understanding. The business vision is to revolutionize homework assistance by making learning engaging and accessible, tapping into a significant market of students seeking personalized educational support, and aiming to become a leading tool for enhancing student comprehension and academic performance.

## User Preferences
None documented yet.

## System Architecture

### UI/UX Decisions
The application features a responsive design with distinct typography and a color scheme emphasizing readability and user engagement (primary indigo, secondary emerald green, grays). Gradient buttons and a gold graduation cap icon are used for key interactions. Animations with React Native Reanimated provide a smooth, interactive experience with progressive step reveals and haptic feedback. The solution screen includes a redesigned two-row action bar with "Simplify," "Ask Question," and "New Problem" buttons, maintaining visual continuity with matching color schemes for related features.

### Technical Implementations
The app is built with React Native 0.81.5, Expo SDK 54, and TypeScript, utilizing React Navigation v7 for navigation, Zustand for state management, and NativeWind v4 for styling. Animations are handled by React Native Reanimated and Gesture Handler.

A custom `MathText` component renders complex mathematical notation, including vertical fractions, subscripts, superscripts, and inline images, with critical rendering optimizations and support for nested formatting tags. Intelligent Visual Aid Generation uses AI to determine optimal type and placement of visual aids, ensuring they are grade-level aware and enhance understanding. Mandatory diagram generation is enforced for key biology/chemistry topics.

A comprehensive cross-platform image conversion solution handles various image formats and URIs. Cross-platform API communication is handled through platform-aware URL construction. The "I Still Don't Get It" feature provides simplified, intuitive, and grade-appropriate explanations for each solution step, focusing on reasoning and analogies, with a two-tier contextual explanation system supporting subject-aware verbosity.

Feature specifications include multiple input methods (text, photo, gallery), AI-powered problem analysis (GPT-4o Vision for images, GPT-4o for text), progressive step-by-step solutions, and improved OCR accuracy using a hybrid approach (Mistral OCR + GPT-4o-mini correction + GPT-4o analysis). The AI is instructed to match input number format and explicitly state common denominators. For essay questions, AI provides guidance and a complete essay. For multiple-choice questions, the correct letter option is included. Server-side formatting enforcement includes post-processing for consistent mathematical formatting, color-tag fraction formatting, comprehensive whitespace normalization, and stripping LaTeX command artifacts. Multi-part answers are formatted with preserved line breaks.

A multi-stage Quality Control & Validation System ensures solution accuracy through structural validation, cross-model verification, confidence scoring, and comprehensive logging, running asynchronously. Performance optimizations include an asynchronous architecture for instant responses with progressive diagram loading and validation in the background. Diagram generation is optimized with hash-based caching. Multi-step problems now include a strategic overview as Step 1, identifying problem type, approach, and goal.

**Automatic Invalid Solution Handling:** When GPT-4o produces corrupted output (missing fields, garbage text, logical contradictions, incomplete steps), system immediately retries up to 2 additional times (~6-10 seconds each) before showing anything to user. Only valid, perfectly formatted solutions are returned. If all 3 GPT-4o attempts fail, WolframAlpha fallback generates mathematically verified solution asynchronously using Full Results API with step-by-step solutions, then GPT-4o formats with app styling. Math eligibility classifier uses phrase-based detection to avoid false rejections. Response size guard rejects oversized GPT-4o responses (>5000 chars) and triggers emergency compression with ultra-concise instructions to prevent timeouts. Verification protocols for AI responses are rigorous, employing a 6-step independent assessment. 

**Professional Final Answer Formatting:** Multi-part final answers follow strict professional formatting rules: descriptive labels (not just letters), no periods after equations, parallel grammatical structure, complete descriptions, and each part on its own line with generous spacing. Visual presentation enhanced with brand-colored labels (indigo), bolder typography, refined letter spacing, and micro-tuned alignment. Fractions are vertically centered with text baseline for proper mathematical alignment.

### System Design Choices
The application uses a proxy server architecture (port 5000) that centralizes API endpoints and handles CORS. It proxies frontend requests in development and serves the built Expo web app in production. The server is configured for Autoscale deployment with environment-aware behavior, including health checks and smart environment detection. Production deployment requires manual configuration of environment secrets and includes enhanced error handling and structured logging.

## External Dependencies
- **AI Integration:** OpenAI GPT-4o (vision, text analysis, Q&A, image generation) via Replit AI Integrations, Mistral OCR API, WolframAlpha Short Answers API (math verification), Google Gemini 2.0 Flash (optional legacy backup).
- **Image Handling:** `expo-camera`, `expo-image-picker`, `expo-image`, `expo-file-system`.
- **Platform Detection:** `expo-constants`.
- **Haptics:** `expo-haptics`.
- **Icons:** `expo-vector-icons`.
- **Concurrency & Retries:** `p-limit`, `p-retry`.
- **Cross-Platform Base64:** `base-64`.