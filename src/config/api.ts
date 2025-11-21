import { Platform } from 'react-native';
import Constants from 'expo-constants';

/**
 * Get the base API URL for the current platform
 * - Web: Uses relative URLs (works with proxy)
 * - Native (iOS/Android): Uses absolute URLs from environment or current domain
 */
function getApiBaseUrl(): string {
  if (Platform.OS === 'web') {
    // Web can use relative URLs - they work with the proxy
    return '/api';
  }
  
  // Native platforms need absolute URLs
  
  // 1. Check if configured in app.json extra.apiUrl
  const configuredUrl = Constants.expoConfig?.extra?.apiUrl;
  if (configuredUrl) {
    return configuredUrl;
  }
  
  // 2. For Expo Go in development, construct URL from manifest
  // The manifest contains the dev server URL
  if (Constants.expoConfig?.hostUri) {
    // hostUri looks like "192.168.1.100:8081" or "domain.com:8081"
    const host = Constants.expoConfig.hostUri.split(':')[0];
    return `http://${host}:5000/api`;
  }
  
  // 3. Check runtime global in case an Expo public env var was injected manually
  const envApiUrl = typeof globalThis !== 'undefined'
    ? (globalThis as Record<string, unknown>).EXPO_PUBLIC_API_URL
    : undefined;
  if (envApiUrl) {
    return String(envApiUrl);
  }
  
  // 4. Configuration error - throw descriptive error instead of returning placeholder
  const errorMessage = `
❌ API Configuration Error for ${Platform.OS}

The app cannot determine the API URL for native platform (${Platform.OS}).
This happens when the app is built for production without proper configuration.

Required: Set one of the following:
  1. app.json: Add "extra": { "apiUrl": "https://your-api.com/api" }
  2. Environment variable: EXPO_PUBLIC_API_URL=https://your-api.com/api

Current state:
  - Platform: ${Platform.OS}
  - Constants.expoConfig.extra.apiUrl: ${Constants.expoConfig?.extra?.apiUrl || 'NOT SET'}
  - Constants.expoConfig.hostUri: ${Constants.expoConfig?.hostUri || 'NOT SET'}
  - globalThis.EXPO_PUBLIC_API_URL: ${envApiUrl || 'NOT SET'}
  - Production build: ${!!Constants.manifest2?.runtimeVersion}

Please configure the API URL before building for production.
  `.trim();
  
  throw new Error(errorMessage);
}

export const API_BASE_URL = getApiBaseUrl();

console.log('🌐 API Base URL configured:', API_BASE_URL);
console.log('📱 Platform:', Platform.OS);
