import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { decode as base64Decode } from 'base-64';

function detectMimeFromMagicBytes(base64Data: string): string | null {
  // Extract first 16 bytes (enough for all magic numbers we check)
  // Each base64 char encodes 6 bits, so 24 chars = 18 bytes
  const prefix = base64Data.substring(0, 24);
  
  try {
    // Decode base64 to get the actual bytes (cross-platform)
    const bytes = base64Decode(prefix);
    const hex = Array.from(bytes).map((b: string) => b.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    
    console.log('Magic bytes (hex):', hex.substring(0, 20) + '...');
    
    // Check magic numbers
    if (hex.startsWith('ffd8ff')) {
      return 'image/jpeg';
    }
    if (hex.startsWith('89504e47')) {
      return 'image/png';
    }
    if (hex.includes('66747970')) { // 'ftyp' marker for HEIC/HEIF
      return 'image/heic';
    }
    if (hex.startsWith('474946')) {
      return 'image/gif';
    }
    if (hex.startsWith('52494646') && hex.includes('57454250')) {
      return 'image/webp';
    }
  } catch (e) {
    console.warn('Failed to detect MIME from magic bytes:', e);
  }
  
  return null;
}

function getMimeTypeFromUri(uri: string, providedMimeType?: string, base64Data?: string): string {
  // Priority 1: Use provided MIME type from picker metadata
  if (providedMimeType) {
    return providedMimeType;
  }

  // Priority 2: Try extension detection
  const pathOnly = uri.split(/[?#]/)[0];
  const parts = pathOnly.split('.');
  const extension = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
  }

  // Priority 3: Try magic byte detection if we have base64 data
  if (base64Data) {
    const detectedType = detectMimeFromMagicBytes(base64Data);
    if (detectedType) {
      console.log('Detected MIME type from magic bytes:', detectedType);
      return detectedType;
    }
  }

  // Last resort: default to JPEG
  console.warn('Could not reliably detect MIME type, defaulting to image/jpeg');
  return 'image/jpeg';
}

async function convertBlobToBase64Web(uri: string): Promise<{ dataUri: string; blobType?: string }> {
  // Web-specific: Use fetch + FileReader for blob:// URIs
  const response = await fetch(uri);
  const blob = await response.blob();
  
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      resolve({
        dataUri: reader.result as string,
        blobType: blob.type || undefined,
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function convertImageToBase64(
  uri: string, 
  base64Data?: string,
  mimeType?: string
): Promise<string> {
  try {
    // If already a data URI, check if it has valid MIME
    if (uri.startsWith('data:')) {
      // Check for broken data URIs missing MIME (e.g., "data:;base64,")
      if (uri.startsWith('data:;base64,')) {
        // Extract base64 for magic byte detection
        const base64Payload = uri.replace('data:;base64,', '');
        const detectedMimeType = getMimeTypeFromUri(uri, mimeType, base64Payload);
        console.log('Fixing data URI with missing MIME type, using:', detectedMimeType);
        return `data:${detectedMimeType};base64,${base64Payload}`;
      }
      // Valid data URI, return as-is
      return uri;
    }

    // If base64 data is provided directly, prepend MIME header
    if (base64Data) {
      const detectedMimeType = getMimeTypeFromUri(uri, mimeType, base64Data);
      return `data:${detectedMimeType};base64,${base64Data}`;
    }

    // Platform-specific conversion
    if (Platform.OS === 'web' || uri.startsWith('blob:')) {
      // Web: Use fetch + FileReader for blob URIs
      console.log('Converting blob URI to base64 (web):', uri.substring(0, 50));
      const { dataUri, blobType } = await convertBlobToBase64Web(uri);
      
      // Fix broken data URI if needed
      if (dataUri.startsWith('data:;base64,')) {
        // Extract base64 for magic byte detection
        const base64Payload = dataUri.replace('data:;base64,', '');
        const finalMimeType = blobType || getMimeTypeFromUri(uri, mimeType, base64Payload);
        console.log('Web FileReader returned data URI with missing MIME, using:', finalMimeType);
        return `data:${finalMimeType};base64,${base64Payload}`;
      }
      
      // If blob.type is missing, try to detect from the data URI content
      if (!blobType && dataUri.startsWith('data:image/')) {
        return dataUri; // FileReader gave us a valid MIME
      }
      
      return dataUri;
    } else {
      // Native: Use Expo FileSystem for file:// URIs
      console.log('Reading file with FileSystem (native):', uri.substring(0, 50));
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      
      const detectedMimeType = getMimeTypeFromUri(uri, mimeType, base64);
      return `data:${detectedMimeType};base64,${base64}`;
    }
  } catch (error) {
    console.error('Error converting image to base64:', error);
    throw new Error(`Failed to convert image: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
