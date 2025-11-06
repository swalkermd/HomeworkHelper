# Homework Helper - AI-Powered Educational Assistant

## Overview
A comprehensive AI-powered homework assistant mobile app built with React Native and Expo. The app helps students understand concepts across all subjects (Math, Chemistry, Physics, Bible Studies, Language Arts, Geography) by providing step-by-step visual solutions with world-class teaching principles, beautiful formatting, and grade-appropriate explanations.

## Current State
**Status:** MVP Complete ✅
**Last Updated:** November 6, 2025

### Implemented Features
1. ✅ **Multiple Input Methods**
   - Type/Paste Question: Text input screen for direct question entry
   - Take Photo: Native camera integration with CameraView (Expo Camera)
   - Gallery Upload: Select existing photos from device gallery
   - Permission handling for camera and photo library

2. ✅ **AI-Powered Problem Analysis**
   - GPT-4o vision processing for image analysis
   - GPT-4o text processing for typed questions
   - Automatic subject detection (Math, Chemistry, Physics, Bible, Language Arts, Geography)
   - Automatic difficulty detection (K-5, 6-8, 9-12, College+)
   - Optional problem number specification

3. ✅ **Step-by-Step Solutions**
   - Progressive reveal animation (800ms intervals)
   - Haptic feedback on step reveals
   - Custom MathText component for mathematical notation:
     - Vertical graphical fractions {num/den}
     - Subscripts (H_2_O, v_0_)
     - Superscripts (x^2^, Ca^2+^)
     - Color highlighting [red:text], [blue:text]
     - Arrows (-> or =>)
     - Italic variables (+text+)
     - Inline images (IMAGE: desc](url)
   - Grade-appropriate language adaptation
   - Final answer card with green gradient

4. ✅ **Interactive Features**
   - Follow-up Q&A chat modal with context preservation
   - Ask Question functionality
   - New Problem navigation back to home
   - Keyboard-dismissable inputs with smooth scrolling

5. ✅ **Navigation & UI**
   - React Navigation Native Stack
   - Modal presentation for Q&A screen
   - Gradient buttons matching design mockup
   - Responsive typography (portrait vs landscape)
   - Responsive spacing
   - Safe area handling
   - Animations with React Native Reanimated

## Technical Architecture

### Tech Stack
- **Framework:** React Native 0.81.5 with Expo SDK 54
- **Language:** TypeScript with strict type safety
- **Navigation:** React Navigation v7 (Native Stack Navigator)
- **State Management:** Zustand (non-persisted for privacy)
- **Styling:** NativeWind v4 (TailwindCSS for React Native)
- **Animations:** React Native Reanimated v3
- **Gestures:** React Native Gesture Handler
- **AI Integration:** OpenAI GPT-4o via Replit AI Integrations (no API key required)
- **Image Handling:** Expo Camera, Expo Image Picker, Expo Image
- **Haptics:** Expo Haptics
- **Icons:** Expo Vector Icons

### Project Structure
```
/
├── src/
│   ├── components/
│   │   └── MathText.tsx          # Custom math notation renderer
│   ├── constants/
│   │   └── theme.ts               # Colors, typography, spacing
│   ├── navigation/
│   │   ├── AppNavigator.tsx       # Main navigation setup
│   │   └── types.ts               # Navigation type definitions
│   ├── screens/
│   │   ├── HomeScreen.tsx         # Landing page with 3 input options
│   │   ├── TextInputScreen.tsx    # Type/paste question input
│   │   ├── CameraScreen.tsx       # Full-screen camera capture
│   │   ├── GalleryScreen.tsx      # Photo gallery picker
│   │   ├── ProblemSelectionScreen.tsx  # Image preview & problem selection
│   │   ├── SolutionScreen.tsx     # Step-by-step solution display
│   │   └── QuestionScreen.tsx     # Follow-up Q&A chat modal
│   ├── services/
│   │   └── openai.ts              # AI integration with rate limiting
│   ├── store/
│   │   └── homeworkStore.ts       # Zustand state management
│   ├── types/
│   │   └── index.ts               # TypeScript type definitions
│   └── utils/
│       └── formatters.ts          # Content formatting utilities
├── App.tsx                         # App entry point
├── babel.config.js                 # Babel configuration
├── tailwind.config.js              # TailwindCSS configuration
├── metro.config.js                 # Metro bundler config
└── global.css                      # Global styles
```

### Design System

#### Colors
- **Primary:** #6366f1 (Indigo)
- **Secondary:** #10b981 (Emerald Green)
- **Text Primary:** #111827 (Gray-900)
- **Text Secondary:** #6b7280 (Gray-500)
- **Background:** #f9fafb (Gray-50)
- **Surface:** #ffffff (White)
- **Surface Alt:** #f3f4f6 (Gray-100)
- **Border:** #e5e7eb (Gray-200)

#### Typography (Responsive)
Portrait mode uses smaller sizes for compactness; landscape mode uses larger sizes for readability.

#### Gradient Buttons
- **Type Question:** Indigo-Purple (#6366f1 → #8b5cf6)
- **Take Photo:** Pink-Orange (#ec4899 → #f97316)
- **Choose from Gallery:** Green-Cyan (#10b981 → #06b6d4)

### AI Integration
Uses Replit AI Integrations for OpenAI access:
- **Vision Analysis:** GPT-4o (multimodal) for image analysis
- **Text Analysis:** GPT-4o for typed questions
- **Q&A Chat:** GPT-4o for follow-up questions
- **Image Generation:** gpt-image-1 for educational diagrams (future feature)
- **Rate Limiting:** p-limit and p-retry for concurrent processing with automatic retries
- **No API Key Required:** Charges billed to Replit credits

### Environment Variables
Automatically configured by Replit AI Integrations:
- `AI_INTEGRATIONS_OPENAI_BASE_URL`
- `AI_INTEGRATIONS_OPENAI_API_KEY`

## Development

### Running the App
The app runs on port 5000 for web preview:
```bash
PORT=5000 npx expo start --web --port 5000
```

### Workflow
A workflow named `expo-dev-server` is configured to automatically start the development server.

### Key Dependencies
- `expo` ~54.0.22
- `react-native` 0.81.5
- `react` 19.1.0
- `openai` ^6.8.1
- `zustand` ^5.0.8
- `nativewind` ^4.2.1
- `@react-navigation/native` ^7.1.19
- `react-native-reanimated` ^4.1.3
- `p-limit` ^7.2.0
- `p-retry` ^7.1.0

## User Flow

### Photo Input Flow
1. Home → Tap "Take Photo"
2. Camera → Capture homework page (with haptic feedback)
3. ProblemSelection → Preview image, optionally enter problem #
4. Analyzing → "Analyzing your homework..."
5. Solution → Steps reveal sequentially with animations
6. Optional: "Ask Question" or "New Problem"

### Text Input Flow
1. Home → Tap "Type Question"
2. TextInput → Enter question
3. Analyzing → AI processes
4. Solution → Steps reveal with formatted math
5. Optional: Ask follow-up via chat modal

### Gallery Flow
1. Home → Tap "Choose from Gallery"
2. Gallery picker opens
3. Select image
4. ProblemSelection → Same as photo flow

## Next Phase Features (Not Yet Implemented)
- [ ] "I Still Don't Get It" feature for simplified explanations
- [ ] Solution history to save and review past problems
- [ ] Answer verification system
- [ ] Subject-specific formatting post-processor
- [ ] Automatic diagram generation for geometry/physics
- [ ] Offline mode with cached solutions

## Recent Changes
- November 6, 2025: Initial MVP implementation complete
  - All core screens and navigation
  - AI integration with GPT-4o
  - MathText component for notation rendering
  - Progressive step reveal with animations
  - Follow-up Q&A chat functionality
  - Configured for Expo web on port 5000

## User Preferences
None documented yet.
