# Homework Helper - AI-Powered Educational Assistant

## Overview
Homework Helper is an AI-powered mobile application built with React Native and Expo, designed to assist students with homework across various subjects (Math, Chemistry, Physics, Bible Studies, Language Arts, Geography). Its core purpose is to provide clear, step-by-step visual solutions, leveraging world-class teaching principles and grade-appropriate explanations. The app aims to enhance understanding through beautiful formatting and interactive features, ultimately fostering deeper learning.

## User Preferences
None documented yet.

## System Architecture

### UI/UX Decisions
The application features a responsive design with distinct typography for portrait and landscape modes. The hero section features a gold graduation cap icon (#fbbf24→#f59e0b gradient). Gradient buttons are used for key actions (Type Question: Indigo-Purple; Take Photo: Pink-Orange; Choose from Gallery: Green-Cyan). Color schemes prioritize readability and user engagement, utilizing primary indigo, secondary emerald green, and a range of grays for text and backgrounds. Animations with React Native Reanimated provide a smooth and interactive user experience, including progressive step reveals and haptic feedback.

**Solution Screen Action Bar (Nov 2025):** Redesigned two-row card layout with grouped actions:
- **Row 1 - "Need More Help?"**: Two equal-width buttons side-by-side
  - "Simplify" button (yellow gradient #fbbf24→#f59e0b, turns green when active)
  - "Ask Question" button (blue gradient #3b82f6→#2563eb with white text/icon)
- **Row 2**: Full-width button (reduced spacing for cleaner layout)
  - "New Problem" button (white background with thick maroon border #991b1b)
- Clean visual hierarchy with gradient and outlined button styles, icons, and consistent spacing for a polished, modern appearance.
- **Visual Continuity:** Simplified explanation dialogue boxes use matching yellow color scheme (#fde68a background with #fbbf24 border) to maintain visual connection with the Simplify button.

### Technical Implementations
- **Framework & Language:** React Native 0.81.5 with Expo SDK 54, TypeScript.
- **Navigation:** React Navigation v7 (Native Stack Navigator).
- **State Management:** Zustand (non-persisted for privacy).
- **Styling:** NativeWind v4 (TailwindCSS for React Native).
- **Animations & Gestures:** React Native Reanimated v3 and React Native Gesture Handler.
- **Custom MathText Component:** Renders mathematical notation including vertical fractions {num/den}, subscripts, superscripts, color highlighting [red:text], arrows, italic variables, and inline images. **Critical rendering optimization (Nov 2025):** Implements intelligent text grouping to prevent unwanted line breaks in React Native's flexbox layout. Groups consecutive text parts (including highlighted terms) into single nested Text components for proper inline flow, while keeping fractions/images as separate layout elements. Server-side whitespace normalization removes all newlines and Unicode whitespace characters, ensuring clean text delivery.
- **Intelligent Visual Aid Generation:** AI uses sophisticated screening logic to determine IF, WHEN, and WHAT TYPE of visual aid would best enhance understanding. Supports 5 visual types (geometric diagrams, graphs/coordinate planes, charts/data viz, physics diagrams, process illustrations) with type-specific prompts and style guides. Visuals are grade-level aware (prioritizing K-8), placement-flexible (can appear in any step), and selectively generated only when they significantly enhance understanding, not as decoration. Generates clean, whiteboard-style PNG images with labels served via absolute URLs.
- **"I Still Don't Get It" Feature:** Provides simplified, intuitive, and grade-appropriate explanations for each solution step, focusing on reasoning rather than just operations, using everyday language and analogies.

### Feature Specifications
- **Multiple Input Methods:** Text input, photo capture (native camera with Expo Camera), and gallery upload. Includes comprehensive permission handling.
- **AI-Powered Problem Analysis:** Utilizes GPT-4o vision for image analysis and GPT-4o for text-based questions, automatically detecting subject, difficulty, and optional problem numbers.
- **Step-by-Step Solutions:** Features progressive reveal animations, haptic feedback, custom math notation rendering, and grade-appropriate language adaptation. Final answers are highlighted.
- **Interactive Features:** Includes a follow-up Q&A chat modal with context preservation and navigation for asking new questions or returning home.
- **OCR Accuracy Improvements:** Specific instructions and examples for AI to improve transcription of mathematical expressions, fractions, and coefficients from images.
- **Number Format Matching (Nov 2025):** AI prompts explicitly instruct the model to MATCH the input format. If the problem uses decimals (0.5, 2.75), the solution uses decimals. If the problem uses fractions (1/2, 3/4), the solution uses vertical fractions {num/den} including mixed numbers when appropriate (e.g., {1{1/2}} for 1½). This ensures the solution format aligns with the student's learning context and problem presentation.
- **Common Denominator Explanations (Nov 2025):** When combining fractions with different denominators, the AI explicitly states what the common denominator is and shows the conversion step (e.g., "Find a common denominator of 5: Convert 2h to fifths: 2h = {10/5}h"). This provides clearer explanations for students learning fraction operations.
- **Essay Question Format (Nov 2025):** For questions requiring essay or written responses (common in Language Arts, Bible Studies, History), the AI uses a specialized format with ONLY ONE explanatory step titled "Key Concepts for Your Essay" that outlines main themes and concepts. The complete, well-structured essay (with introduction, body paragraphs, and conclusion) is provided in the Final Answer section, with key terms highlighted throughout.
- **Server-Side Formatting Enforcement:** A post-processing layer on the server ensures consistent mathematical formatting, converting OCR-detected fractions (like "1/8") to vertical {num/den} format while preserving the number format from the input. **Color-Tag Fraction Formatting (Nov 2025):** Regex processing now converts fractions inside [blue:] and [red:] highlighting tags (e.g., [blue:12/5h - 10/5h] → [blue:{12/5}h - {10/5}h]) before handling standalone fractions, ensuring proper vertical fraction rendering in all colored mathematical expressions. **Whitespace normalization (Nov 2025):** Comprehensive cleanup of all newline characters (\n, \r, \u2028, \u2029), zero-width characters, and non-breaking spaces applied after all transformations (including image placeholder restoration) to ensure continuous text flow without mid-sentence breaks. **Multi-Part Answer Formatting (Nov 2025):** For questions with multiple parts (a, b, c), the AI places each answer on its own line in the final answer section, and the whitespace normalization logic preserves these intentional line breaks while removing mid-sentence breaks. Pattern /\n\s*([a-z]\))/gi protects newlines before single-letter enumerators during text cleanup.
- **Quality Control & Validation System:** Multi-stage validation pipeline that ensures solution accuracy:
  - **Structural Validation**: Verifies JSON schema compliance, required fields, and proper formatting
  - **Cross-Model Verification**: Independent AI verification call reviews solution accuracy, calculations, and final answers
  - **Confidence Scoring**: Solutions must pass 70% confidence threshold
  - **Comprehensive Logging**: Timestamps, validation metrics, errors, and warnings logged for quality monitoring
  - **Async Background Execution**: Validation runs in background after delivering solution to user (non-blocking for speed)
- **Performance Optimizations (Nov 2025):** Asynchronous architecture for instant responses with progressive diagram loading:
  - **Async Diagram Generation**: Solutions return immediately (<8s), diagrams generate in background and load progressively as ready
  - **Async Validation**: Quality control runs in background (non-blocking) for logging/monitoring only
  - **Client Polling**: Frontend polls for diagram updates every 2 seconds, rendering them as they become available
  - **Response Time**: ALL solutions delivered in 3-7s, diagrams appear within 30-50s asynchronously
  - **Timeout Configuration**: Server timeout 300s, client fetch timeout 30s for initial response

### System Design Choices
The application uses a proxy server architecture (running on port 5000) that handles API endpoints and proxies frontend requests to the Expo dev server (port 8081). This setup centralizes OpenAI API integration, CORS handling, and ensures all interactions occur through a single exposed port in the Replit environment.

## External Dependencies
- **AI Integration:** OpenAI GPT-4o via Replit AI Integrations for vision analysis, text analysis, Q&A chat, and image generation (gpt-image-1). No external API key is required, and charges are billed to Replit credits.
- **Image Handling:** `expo-camera`, `expo-image-picker`, `expo-image` for camera, gallery access, and image rendering.
- **Haptics:** `expo-haptics`.
- **Icons:** `expo-vector-icons`.
- **Concurrency & Retries:** `p-limit` and `p-retry` for managing concurrent AI requests and ensuring robustness.