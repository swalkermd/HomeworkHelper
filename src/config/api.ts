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
  
  // 3. Check environment variable (works in Expo builds)
  // Note: Must be prefixed with EXPO_PUBLIC_ to be accessible
  // @ts-ignore - env vars are injected at build time
  const envApiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envApiUrl) {
    return envApiUrl;
  }
  
  // 4. For deployed apps, try to get from manifest URL
  if (Constants.manifest2?.runtimeVersion) {
    // This is a production build, we need the deployment URL
    // In Replit deployments, this should be set in environment
    console.warn('Production build detected but no API URL configured');
    console.warn('Please set EXPO_PUBLIC_API_URL environment variable');
  }
  
  // Last resort fallback - should not happen in production
  console.error('❌ Could not determine API URL for native platform!');
  console.error('Platform:', Platform.OS);
  console.error('Please configure API_URL in app.json or set EXPO_PUBLIC_API_URL');
  
  // Return a placeholder that will fail but with a clear error
  return 'https://CONFIGURE_API_URL_IN_APP_JSON/api';
}

export const API_BASE_URL = getApiBaseUrl();

console.log('🌐 API Base URL configured:', API_BASE_URL);
console.log('📱 Platform:', Platform.OS);
