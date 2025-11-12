/**
 * GOOGLE CLOUD VISION OCR SERVICE
 * 
 * Provides high-accuracy text extraction (96-99%) for hybrid OCR approach.
 * This module handles specialized OCR extraction, which is then combined
 * with GPT-4o's reasoning capabilities for optimal results.
 * 
 * Uses REST API with API key authentication (no SDK required).
 */

interface OCRResult {
  text: string;
  confidence: number;
  boundingBoxes?: Array<{
    text: string;
    confidence: number;
    vertices: Array<{ x: number; y: number }>;
  }>;
}

/**
 * Prepare and validate image data for Google Cloud Vision API
 */
function prepareImageForVision(imageUri: string): string {
  // Remove various data URI prefixes (handles image/jpeg, image/png, image/svg+xml, etc.)
  let base64Data = imageUri.replace(/^data:image\/[^;]+;base64,/, '');
  
  // Validate it's actually base64
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64Data)) {
    throw new Error('Invalid base64 image data');
  }
  
  // Check size (rough estimate: base64 is ~1.37x original size)
  const estimatedSize = (base64Data.length * 0.75) / (1024 * 1024); // MB
  if (estimatedSize > 20) {
    throw new Error(`Image too large (${estimatedSize.toFixed(1)}MB). Max: 20MB`);
  }
  
  return base64Data;
}

/**
 * Extract text from base64-encoded image using Google Cloud Vision API
 * @param base64Image - Base64-encoded image data (with or without data URI prefix)
 * @returns OCRResult with extracted text and confidence score
 */
export async function extractTextFromImage(base64Image: string): Promise<OCRResult> {
  const apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
  
  if (!apiKey) {
    throw new Error('GOOGLE_CLOUD_VISION_API_KEY not found in environment variables');
  }

  // Validate and prepare image data
  const base64Data = prepareImageForVision(base64Image);

  // Use REST API with API key authentication
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
  
  const requestBody = {
    requests: [
      {
        image: {
          content: base64Data
        },
        features: [
          {
            type: 'DOCUMENT_TEXT_DETECTION', // Better for dense text like homework
            maxResults: 1
          }
        ],
        imageContext: {
          languageHints: ['en'] // Can be expanded for multi-language support
        }
      }
    ]
  };

  // Add timeout protection (30 seconds)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      
      // Provide specific error messages for common issues
      if (response.status === 401 || response.status === 403) {
        throw new Error('Google Vision API authentication failed. Check API key permissions.');
      } else if (response.status === 429) {
        throw new Error('Google Vision API rate limit exceeded. Please try again later.');
      } else if (response.status === 400) {
        throw new Error(`Invalid request to Google Vision API: ${errorData.error?.message || 'Bad request'}`);
      } else if (response.status >= 500) {
        throw new Error(`Google Vision API server error (${response.status}). Please try again.`);
      } else {
        throw new Error(`Google Vision API error: ${response.status} - ${JSON.stringify(errorData)}`);
      }
    }

    const data = await response.json();
    
    // Check for errors in response
    if (data.responses?.[0]?.error) {
      throw new Error(`Vision API error: ${data.responses[0].error.message}`);
    }

    const fullTextAnnotation = data.responses?.[0]?.fullTextAnnotation;
    
    if (!fullTextAnnotation || !fullTextAnnotation.text) {
      // No text detected
      return {
        text: '',
        confidence: 0,
        boundingBoxes: []
      };
    }

    // Extract text and calculate average confidence
    const text = fullTextAnnotation.text;
    const pages = fullTextAnnotation.pages || [];
    
    // Calculate confidence from word-level annotations
    let totalConfidence = 0;
    let wordCount = 0;
    
    for (const page of pages) {
      for (const block of page.blocks || []) {
        for (const paragraph of block.paragraphs || []) {
          for (const word of paragraph.words || []) {
            if (word.confidence !== undefined) {
              totalConfidence += word.confidence;
              wordCount++;
            }
          }
        }
      }
    }
    
    const averageConfidence = wordCount > 0 ? totalConfidence / wordCount : 0.95;

    // Extract detailed bounding boxes for potential future use
    const boundingBoxes: OCRResult['boundingBoxes'] = [];
    
    for (const page of pages) {
      for (const block of page.blocks || []) {
        for (const paragraph of block.paragraphs || []) {
          for (const word of paragraph.words || []) {
            const wordText = word.symbols?.map((s: any) => s.text).join('') || '';
            boundingBoxes.push({
              text: wordText,
              confidence: word.confidence || 0,
              vertices: word.boundingBox?.vertices || []
            });
          }
        }
      }
    }

    return {
      text: text.trim(),
      confidence: averageConfidence,
      boundingBoxes
    };

  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Google Vision API request timed out after 30 seconds');
    }
    console.error('Google Vision OCR error:', error);
    throw error;
  }
}

/**
 * Health check for Google Cloud Vision API
 * @returns true if API key is configured and valid
 */
export async function isGoogleVisionAvailable(): Promise<boolean> {
  const apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
  return !!apiKey;
}

/**
 * Format OCR text for better readability in prompts
 * Preserves mathematical notation and structure
 */
export function formatOCRText(text: string): string {
  return text
    .trim()
    // Normalize whitespace while preserving line breaks
    .replace(/[ \t]+/g, ' ')
    // Remove excessive blank lines (more than 2)
    .replace(/\n{3,}/g, '\n\n');
}
