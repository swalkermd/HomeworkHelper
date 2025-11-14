import { useWindowDimensions } from 'react-native';

export const colors = {
  primary: "#6366f1",
  secondary: "#10b981",
  textPrimary: "#111827",
  textSecondary: "#6b7280",
  background: "#f9fafb",
  surface: "#ffffff",
  surfaceAlt: "#f3f4f6",
  border: "#e5e7eb",
  error: "#ef4444",
  warning: "#f59e0b",
  success: "#10b981",
};

function getTypography(isLandscape: boolean) {
  return {
    displayLarge: {
      fontSize: isLandscape ? 40 : 28,
      lineHeight: isLandscape ? 48 : 36,
    },
    displayMedium: {
      fontSize: isLandscape ? 32 : 24,
      lineHeight: isLandscape ? 40 : 32,
    },
    titleLarge: {
      fontSize: isLandscape ? 26 : 20,
      lineHeight: isLandscape ? 34 : 28,
    },
    titleMedium: {
      fontSize: isLandscape ? 22 : 18,
      lineHeight: isLandscape ? 30 : 26,
    },
    bodyLarge: {
      fontSize: isLandscape ? 20 : 16,
      lineHeight: isLandscape ? 30 : 24,
    },
    bodyMedium: {
      fontSize: isLandscape ? 18 : 15,
      lineHeight: isLandscape ? 28 : 22,
    },
    caption: {
      fontSize: isLandscape ? 14 : 13,
      lineHeight: isLandscape ? 22 : 20,
    },
    mathLarge: {
      fontSize: isLandscape ? 28 : 22,
      lineHeight: isLandscape ? 38 : 32,
    },
    mathMedium: {
      fontSize: isLandscape ? 22 : 18,
      lineHeight: isLandscape ? 32 : 28,
    },
    mathSmall: {
      fontSize: isLandscape ? 18 : 16,
      lineHeight: isLandscape ? 28 : 24,
    },
  };
}

function getSpacing(isLandscape: boolean) {
  return {
    xs: isLandscape ? 6 : 4,
    sm: isLandscape ? 10 : 8,
    md: isLandscape ? 16 : 12,
    lg: isLandscape ? 24 : 18,
    xl: isLandscape ? 32 : 24,
    xxl: isLandscape ? 40 : 32,
  };
}

export function useResponsiveTheme() {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  
  return {
    typography: getTypography(isLandscape),
    spacing: getSpacing(isLandscape),
    isLandscape,
  };
}

// Backward compatibility: Export static versions for non-component usage
// These use actual device dimensions at module load time
import { Dimensions } from 'react-native';
const { width: staticWidth, height: staticHeight } = Dimensions.get('window');
const staticIsLandscape = staticWidth > staticHeight;
export const typography = getTypography(staticIsLandscape);
export const spacing = getSpacing(staticIsLandscape);
