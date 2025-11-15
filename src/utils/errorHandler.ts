/**
 * Converts technical errors into user-friendly messages
 * Helps users understand whether the issue is:
 * - Their internet connection
 * - Server overload
 * - Timeout (problem too complex)
 * - Other issues
 */
export function getUserFriendlyErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'An unexpected error occurred. Please try again.';
  }

  const errorMessage = error.message.toLowerCase();
  const errorName = error.name;

  // Timeout errors (AbortError from fetch timeout)
  if (errorName === 'AbortError' || errorMessage.includes('timeout')) {
    return 'Request timed out. The problem might be too complex, or your connection is slow. Please try again with a simpler problem or check your internet connection.';
  }

  // Network connectivity errors
  if (
    errorMessage.includes('network') ||
    errorMessage.includes('failed to fetch') ||
    errorMessage.includes('networkerror') ||
    errorMessage.includes('no internet') ||
    errorMessage.includes('connection')
  ) {
    return 'No internet connection. Please check your network and try again.';
  }

  // Server errors (5xx status codes)
  if (
    errorMessage.includes('500') ||
    errorMessage.includes('502') ||
    errorMessage.includes('503') ||
    errorMessage.includes('504') ||
    errorMessage.includes('server error')
  ) {
    return 'Our servers are experiencing issues. Please try again in a few moments.';
  }

  // Client errors (4xx status codes)
  if (errorMessage.includes('400')) {
    return 'Invalid request. Please check your input and try again.';
  }

  if (errorMessage.includes('401') || errorMessage.includes('unauthorized')) {
    return 'Authentication failed. Please restart the app.';
  }

  if (errorMessage.includes('403') || errorMessage.includes('forbidden')) {
    return 'Access denied. This feature may not be available.';
  }

  if (errorMessage.includes('404')) {
    return 'Resource not found. Please try again.';
  }

  if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
    return 'Too many requests. Please wait a moment and try again.';
  }

  if (errorMessage.includes('unable to verify answer accuracy')) {
    return 'We could not verify that answer. Try retaking the photo with a clearer view or typing the problem manually.';
  }

  if (errorMessage.includes('422')) {
    return 'The problem could not be verified. Please check the steps and try again with a clearer photo.';
  }

  // API-specific errors
  if (errorMessage.includes('api configuration error')) {
    return 'App configuration error. Please contact support.';
  }

  // Image conversion errors
  if (errorMessage.includes('failed to convert image')) {
    return 'Failed to process image. Please try a different photo format (JPEG, PNG, or HEIC).';
  }

  // Default: return the original error message if it's user-friendly
  // (starts with a capital letter and doesn't look like a technical error)
  if (error.message && error.message[0] === error.message[0].toUpperCase() && 
      !error.message.includes('Error:') && 
      !error.message.includes('TypeError') &&
      !error.message.includes('ReferenceError')) {
    return error.message;
  }

  // Last resort
  return 'An unexpected error occurred. Please try again or contact support if the issue persists.';
}
