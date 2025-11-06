import { Dimensions } from 'react-native';

const { width, height } = Dimensions.get('window');
const isLandscape = width > height;

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

export const typography = {
  displayLarge: {
    fontSize: isLandscape ? 32 : 20,
    lineHeight: isLandscape ? 40 : 28,
  },
  displayMedium: {
    fontSize: isLandscape ? 24 : 18,
    lineHeight: isLandscape ? 32 : 22,
  },
  titleLarge: {
    fontSize: isLandscape ? 18 : 14,
    lineHeight: isLandscape ? 24 : 20,
  },
  bodyLarge: {
    fontSize: isLandscape ? 16 : 13,
    lineHeight: isLandscape ? 24 : 20,
  },
  mathLarge: {
    fontSize: isLandscape ? 20 : 14,
    lineHeight: isLandscape ? 30 : 21,
  },
  mathMedium: {
    fontSize: isLandscape ? 17 : 13,
    lineHeight: isLandscape ? 26 : 20,
  },
};

export const spacing = {
  xs: isLandscape ? 4 : 2,
  sm: isLandscape ? 8 : 4,
  md: isLandscape ? 12 : 6,
  lg: isLandscape ? 16 : 8,
  xl: isLandscape ? 20 : 10,
  xxl: isLandscape ? 24 : 12,
};
