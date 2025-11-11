/**
 * HOMEWORK HELPER API SERVER
 * 
 * Performance Optimizations:
 * - Diagram generation runs in parallel using Promise.all
 * - Validation runs async in background (non-blocking)
 * - Target processing time: <15 seconds for complex problems
 * 
 * Timeout Configuration:
 * - Server timeout: 300s (5 min) - generous buffer for AI operations
 * - Client fetch timeout: 120s (2 min) - reasonable UX limit
 * - Mismatch is intentional: server timeout > client timeout provides safety margin
 *   while client timeout ensures user doesn't wait indefinitely
 */

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import cors from 'cors';
import OpenAI from 'openai';
import pRetry, { AbortError } from 'p-retry';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { extractTextFromImage, isGoogleVisionAvailable, formatOCRText } from './googleVision';

const app = express();
const PORT = 5000;

// CRITICAL: Health check endpoint FIRST - must respond immediately for deployment health checks
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// API configuration diagnostic endpoint - shows what's available without exposing keys
app.get('/api/config-check', (req, res) => {
  const googleVisionConfigured = !!process.env.GOOGLE_CLOUD_VISION_API_KEY;
  const openaiConfigured = !!process.env.OPENAI_API_KEY;
  
  res.json({
    environment: process.env.REPLIT_DEPLOYMENT === '1' ? 'production' : 'development',
    apis: {
      googleCloudVision: googleVisionConfigured ? 'configured ✅' : 'missing ❌',
      openai: openaiConfigured ? 'configured ✅' : 'missing ❌'
    },
    ocrMode: googleVisionConfigured ? 'Hybrid (Google Vision + GPT-4o)' : 'Standard (GPT-4o only)',
    message: googleVisionConfigured 
      ? 'Gold-standard OCR is active (96-99% accuracy)' 
      : 'Add GOOGLE_CLOUD_VISION_API_KEY for enhanced OCR accuracy'
  });
});

// Cache statistics endpoint for monitoring performance
app.get('/api/cache-stats', (req, res) => {
  const hitRate = cacheStats.totalRequests > 0 
    ? ((cacheStats.hits / cacheStats.totalRequests) * 100).toFixed(1)
    : '0.0';
  
  res.json({
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    totalRequests: cacheStats.totalRequests,
    hitRate: `${hitRate}%`,
    cacheSize: diagramCache.size,
    cacheTTL: '24 hours'
  });
});

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));

// In-memory store for async diagram generation
interface DiagramStatus {
  stepId: string;
  type: string;
  description: string;
  status: 'pending' | 'generating' | 'ready' | 'failed';
  imageUrl?: string;
  error?: string;
}

interface SolutionDiagrams {
  diagrams: DiagramStatus[];
  timestamp: number;
  complete: boolean;
}

const solutionDiagramStore = new Map<string, SolutionDiagrams>();

// Cleanup old solutions after 1 hour
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, data] of solutionDiagramStore.entries()) {
    if (data.timestamp < oneHourAgo) {
      solutionDiagramStore.delete(id);
    }
  }
}, 5 * 60 * 1000); // Run every 5 minutes

// Background diagram generation function
async function generateDiagramsInBackground(
  solutionId: string,
  diagrams: DiagramStatus[],
  steps: any[],
  hostname?: string
): Promise<void> {
  console.log(`🎨 Starting background generation of ${diagrams.length} diagrams for solution ${solutionId}`);
  
  const solutionData = solutionDiagramStore.get(solutionId);
  if (!solutionData) {
    console.error(`Solution ${solutionId} not found in store`);
    return;
  }
  
  // Generate all diagrams in parallel
  const promises = diagrams.map(async (diagram, index) => {
    try {
      // Update status to generating
      solutionData.diagrams[index].status = 'generating';
      
      const diagramDescription = diagram.type === 'legacy' 
        ? diagram.description
        : `type=${diagram.type} - ${diagram.description}`;
      
      console.log(`🎨 Generating diagram ${index + 1}/${diagrams.length}: ${diagramDescription}`);
      
      const imageUrl = await generateDiagram(diagramDescription, hostname);
      
      if (imageUrl) {
        solutionData.diagrams[index].status = 'ready';
        solutionData.diagrams[index].imageUrl = imageUrl;
        console.log(`✅ Diagram ${index + 1}/${diagrams.length} ready: ${imageUrl}`);
      } else {
        solutionData.diagrams[index].status = 'failed';
        solutionData.diagrams[index].error = 'Failed to generate image';
        console.error(`❌ Diagram ${index + 1}/${diagrams.length} failed`);
      }
    } catch (error) {
      solutionData.diagrams[index].status = 'failed';
      solutionData.diagrams[index].error = error instanceof Error ? error.message : 'Unknown error';
      console.error(`❌ Error generating diagram ${index + 1}/${diagrams.length}:`, error);
    }
  });
  
  await Promise.all(promises);
  
  solutionData.complete = true;
  console.log(`✅ All diagrams complete for solution ${solutionId}`);
}

// Serve diagram images from public/diagrams
app.use('/diagrams', express.static(path.join(process.cwd(), 'public', 'diagrams')));

const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY
});

// Diagram cache for avoiding regeneration of identical diagrams
interface DiagramCacheEntry {
  url: string;
  timestamp: number;
  size: string;
  visualType: string;
}

const diagramCache = new Map<string, DiagramCacheEntry>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Cache statistics for monitoring performance
let cacheStats = {
  hits: 0,
  misses: 0,
  totalRequests: 0
};

async function generateDiagram(description: string, hostname?: string): Promise<string> {
  try {
    // Extract visual type from description if provided
    const typeMatch = description.match(/type=(\w+)/);
    const visualType = typeMatch ? typeMatch[1] : 'diagram';
    
    // Remove type tag from description for cleaner prompt
    const cleanDescription = description.replace(/type=\w+\s*-\s*/, '');
    
    // Use standard 1024x1024 size (API doesn't support 512x512)
    const size = "1024x1024" as const;
    
    // Check cache before generating (hash includes description + size to avoid collisions)
    const cacheKey = crypto.createHash('md5').update(description + size).digest('hex');
    cacheStats.totalRequests++;
    
    const cached = diagramCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      cacheStats.hits++;
      const hitRate = ((cacheStats.hits / cacheStats.totalRequests) * 100).toFixed(1);
      console.log(`♻️  Cache HIT (${hitRate}% hit rate): ${visualType} ${size} - ${cacheKey.substring(0, 8)}`);
      return cached.url;
    }
    
    cacheStats.misses++;
    console.log(`🎨 Cache MISS: Generating ${visualType} at ${size} for:`, cleanDescription.substring(0, 100) + '...');
    
    // Customize prompt based on visual type
    const styleGuides: { [key: string]: string } = {
      geometry: 'Clean geometric diagram with clear angles, labeled vertices, precise measurements, and dimension annotations. Use a ruler-and-compass style with clean black lines on white background.',
      graph: 'Coordinate plane with clearly marked axes, grid lines, labeled points, and plotted function/equation. Include axis labels (x, y) and key coordinates. Mathematical graph style.',
      chart: 'Clean data visualization chart with clear labels, legend if needed, and easy-to-read values. Professional infographic style with simple colors.',
      physics: 'Physics diagram with labeled components, force arrows with magnitude indicators, clear directional vectors, and relevant measurements. Technical diagram style.',
      illustration: 'Step-by-step visual illustration showing process or transformation clearly with arrows indicating sequence and labeled stages. Educational illustration style.',
    };
    
    const styleGuide = styleGuides[visualType] || 'Clean educational diagram with clear labels and simple presentation';
    
    const response = await openai.images.generate({
      model: "gpt-image-1",
      prompt: `MANDATORY NUMBER FORMAT: USE PERIODS FOR DECIMALS - WRITE 14.14 NOT 14,14 - WRITE 3.92 NOT 3,92 - WRITE 10.2 NOT 10,2. Educational ${visualType}: ${cleanDescription}. ${styleGuide} White background, black lines, labeled clearly. ABSOLUTE REQUIREMENT: ALL DECIMAL NUMBERS USE PERIOD SEPARATORS (.) - AMERICAN/ENGLISH FORMAT ONLY - NEVER USE COMMAS (,) IN NUMBERS. Examples: 14.14, 3.92, 10.2, 19.6. IMPORTANT: Leave generous margins (at least 10% padding) on all sides - do not place any content or labels near the edges. Center the main content with plenty of space around it. REMINDER: Decimals use PERIODS not commas.`,
      size: size,
      n: 1
    });
    
    // Replit AI Integrations returns base64 data by default
    const b64Data = response.data?.[0]?.b64_json;
    if (b64Data) {
      // Save to file instead of returning data URL (data URLs crash React Native Web)
      const diagramsDir = path.join(process.cwd(), 'public', 'diagrams');
      if (!fs.existsSync(diagramsDir)) {
        fs.mkdirSync(diagramsDir, { recursive: true });
      }
      
      // Generate unique filename with type prefix (use cacheKey for consistency)
      const hash = cacheKey.substring(0, 8);
      const filename = `${visualType}-${size.replace('x', '-')}-${hash}.png`;
      const filepath = path.join(diagramsDir, filename);
      
      // Convert base64 to buffer and save
      const buffer = Buffer.from(b64Data, 'base64');
      fs.writeFileSync(filepath, buffer);
      
      // Use request hostname if provided (for production), otherwise fall back to env vars (for dev)
      const domain = hostname || process.env.REPLIT_DEV_DOMAIN || `${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
      const url = `https://${domain}/diagrams/${filename}`;
      
      // Store in cache for future requests
      diagramCache.set(cacheKey, {
        url,
        timestamp: Date.now(),
        size,
        visualType
      });
      
      console.log(`✓ ${visualType} (${size}) saved and cached:`, url);
      return url;
    }
    
    console.log('✗ No image data returned');
    return '';
  } catch (error) {
    console.error('Error generating diagram:', error);
    return '';
  }
}

function isRateLimitError(error: any): boolean {
  const errorMsg = error?.message || String(error);
  return (
    errorMsg.includes("429") ||
    errorMsg.includes("RATELIMIT_EXCEEDED") ||
    errorMsg.toLowerCase().includes("quota") ||
    errorMsg.toLowerCase().includes("rate limit")
  );
}

// Convert decimal to fraction with simplification
// Helper function: Convert decimal to fraction using continued fractions algorithm
// Currently unused - format matching respects input (decimals stay decimals, fractions stay fractions)
// Preserved for potential future features
function decimalToFraction(decimal: number): { numerator: number; denominator: number } {
  const tolerance = 1.0E-6;
  let h1 = 1, h2 = 0, k1 = 0, k2 = 1;
  let b = decimal;
  
  do {
    const a = Math.floor(b);
    let aux = h1;
    h1 = a * h1 + h2;
    h2 = aux;
    aux = k1;
    k1 = a * k1 + k2;
    k2 = aux;
    b = 1 / (b - a);
  } while (Math.abs(decimal - h1 / k1) > decimal * tolerance);
  
  return { numerator: h1, denominator: k1 };
}

// Enforce proper math formatting - convert ALL fractions to {num/den} format
function enforceProperFormatting(text: string | null | undefined, debugLabel: string = ''): string {
  // Return empty string if text is null or undefined
  if (!text || typeof text !== 'string') {
    return '';
  }
  
  const originalText = text;
  
  // Extract and preserve IMAGE tags to avoid processing their data URLs
  const imageTags: string[] = [];
  let formatted = text.replace(/\(IMAGE:[^\)]+\]\([^\)]+\)/g, (match) => {
    imageTags.push(match);
    return `__IMAGE_PLACEHOLDER_${imageTags.length - 1}__`;
  });
  
  // 0. Remove LaTeX commands that shouldn't be displayed as text
  // Iteratively strip \command{text} patterns to handle nested commands
  let prevFormatted;
  do {
    prevFormatted = formatted;
    // Strip \text{...}, \textbf{...}, \textit{...}, etc. -> keep content only
    formatted = formatted.replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, '$1');
  } while (formatted !== prevFormatted); // Keep going until no more changes
  
  // Strip LaTeX spacing and symbols
  formatted = formatted.replace(/\\,/g, ''); // spacing
  formatted = formatted.replace(/\\;/g, ''); // spacing
  formatted = formatted.replace(/\\ /g, ' '); // spacing
  formatted = formatted.replace(/\\times/g, '×');
  formatted = formatted.replace(/\\cdot/g, '·');
  formatted = formatted.replace(/\\Delta/g, 'Δ');
  formatted = formatted.replace(/\\alpha/g, 'α');
  formatted = formatted.replace(/\\beta/g, 'β');
  formatted = formatted.replace(/\\theta/g, 'θ');
  formatted = formatted.replace(/\\pi/g, 'π');
  // Remove any remaining standalone backslash commands
  formatted = formatted.replace(/\\[a-zA-Z]+\b/g, '');
  
  // Fix double caret issues (e.g., "m/s^2^" -> "m/s^2")
  // This happens when LaTeX \text{m/s}^2 is stripped, leaving the ^2 from LaTeX superscript
  formatted = formatted.replace(/\^\^/g, '^'); // Replace double carets with single
  formatted = formatted.replace(/(\^\d+)\^/g, '$1'); // Remove trailing caret after superscript numbers
  
  // 1. Normalize whitespace: replace ALL newlines with spaces for continuous text flow
  // EXCEPT for multi-part answers (a), b), c) which should stay on separate lines
  // First, normalize all line endings to \n
  formatted = formatted.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Remove zero-width characters and other invisible Unicode whitespace that AI might generate
  formatted = formatted.replace(/[\u200B-\u200D\uFEFF]/g, '');
  
  // Preserve newlines before multi-part answer markers by using a temporary placeholder
  // Match patterns like "\n a)" or "\n b)" or "\n c)" or "\n 1." or "\n 2." or "\n 1)" etc.
  formatted = formatted.replace(/\n\s*([a-z]\)|\d+\.|\d+\))/gi, '__LINEBREAK__$1');
  
  // Convert ALL other newlines (single or multiple) to single space
  formatted = formatted.replace(/\n+/g, ' ');
  
  // Restore preserved line breaks for multi-part answers
  formatted = formatted.replace(/__LINEBREAK__/g, '\n');
  
  // Clean up multiple spaces (including NBSP) but NOT newlines
  formatted = formatted.replace(/[ \t\u00A0\u202F]+/g, ' ');
  // CRITICAL: Remove ALL whitespace (including Unicode) before punctuation (but not newlines)
  formatted = formatted.replace(/[ \t\u00A0\u202F]+([.,!?;:])/g, '$1');
  // Trim leading/trailing whitespace
  formatted = formatted.trim();
  
  // Debug logging - show sample before/after for content with punctuation issues
  if (debugLabel && originalText.includes(',')) {
    const sample = originalText.substring(0, 100);
    const formattedSample = formatted.substring(0, 100);
    console.log(`\n🔍 DEBUG [${debugLabel}]:`);
    console.log(`  BEFORE: ${JSON.stringify(sample)}`);
    console.log(`  AFTER:  ${JSON.stringify(formattedSample)}`);
  }
  
  // 1. Convert standalone fractions like "1/8" to "{1/8}" (for OCR-detected fractions)
  // NOTE: We no longer force decimal→fraction conversion. Format should match input.
  // CRITICAL: Don't match fractions that are part of decimal divisions like "19.6/5.0"
  const beforeFractionConversion = formatted;
  
  // First, convert ALL fractions INSIDE color tags: [blue:12/5h - 10/5h] -> [blue:{12/5}h - {10/5}h]
  // This regex handles multiple fractions within a single color tag by processing each tag's content
  // Use negative lookbehind/lookahead for decimal points to avoid matching "19.6/5.0"
  // Updated to handle variable fractions like x/10c, not just numeric fractions
  // CRITICAL: Exclude unit expressions (m/s, km/h) by requiring at least one digit
  formatted = formatted.replace(/\[(blue|red):([^\]]+)\]/g, (match, color, content) => {
    // Convert all fractions inside this color tag's content, but NOT decimal divisions or units
    // Pattern matches: numbers (12/5), mixed (3x/4, x/10c) - but NOT pure letters (m/s, km/h)
    const convertedContent = content.replace(/(?<![{/.])([a-zA-Z0-9]+)\/([a-zA-Z0-9]+)(?![}./])/g, (m: string, num: string, den: string) => {
      // Only wrap if numerator or denominator contains at least one digit
      // This excludes unit expressions like m/s, kg/m which are letter-only
      if (/\d/.test(num) || /\d/.test(den)) {
        return `{${num}/${den}}`;
      }
      return m; // Leave units unchanged
    });
    return `[${color}:${convertedContent}]`;
  });
  
  // Then, convert any remaining standalone fractions outside color tags
  // Handles both numeric fractions (1/8) and variable fractions (x/10c)
  // Excludes unit expressions (m/s, km/h) by requiring at least one digit
  formatted = formatted.replace(/(?<![{/.])([a-zA-Z0-9]+)\/([a-zA-Z0-9]+)(?![}./])/g, (match: string, num: string, den: string) => {
    // Only wrap if numerator or denominator contains at least one digit
    if (/\d/.test(num) || /\d/.test(den)) {
      return `{${num}/${den}}`;
    }
    return match; // Leave units unchanged
  });
  
  if (debugLabel && beforeFractionConversion !== formatted) {
    console.log(`🔢 FRACTION CONVERSION in [${debugLabel}]:`);
    console.log(`   BEFORE: ${JSON.stringify(beforeFractionConversion)}`);
    console.log(`   AFTER:  ${JSON.stringify(formatted)}`);
  }
  
  // Restore IMAGE tags
  formatted = formatted.replace(/__IMAGE_PLACEHOLDER_(\d+)__/g, (match, index) => {
    return imageTags[parseInt(index)];
  });
  
  // CRITICAL: Final whitespace scrub AFTER all transformations (including image restoration)
  // This catches any newlines that may have been reintroduced by image tags or other operations
  // BUT preserve multi-part answer line breaks (a), b), c), 1., 2., 1), 2))
  
  // First, preserve multi-part answer line breaks again
  formatted = formatted.replace(/\n\s*([a-z]\)|\d+\.|\d+\))/gi, '__LINEBREAK__$1');
  
  // Remove other line separator characters
  formatted = formatted.replace(/[\r\n\u2028\u2029]+/g, ' ');  // All line separator characters
  
  // Restore multi-part answer line breaks
  formatted = formatted.replace(/__LINEBREAK__/g, '\n');
  
  // Normalize all whitespace (but not newlines we just restored)
  formatted = formatted.replace(/[ \t\u00A0\u202F]+/g, ' ');     // Normalize spaces/tabs but not newlines
  formatted = formatted.replace(/[ \t\u00A0\u202F]+([.,!?;:])/g, '$1');  // Remove spaces before punctuation
  formatted = formatted.trim();
  
  // Enhanced debug logging - show full text for blue highlighting issues
  if (debugLabel && formatted.includes('[blue:')) {
    console.log(`\n🔵 BLUE HIGHLIGHTING in [${debugLabel}]:`);
    console.log(`   Full text: ${JSON.stringify(formatted)}`);
  }
  
  // Check for newlines
  if (debugLabel) {
    const hasNewlines = /[\r\n\u2028\u2029]/.test(formatted);
    if (hasNewlines) {
      console.log(`\n⚠️  NEWLINES DETECTED in [${debugLabel}]:`);
      console.log(`   Full text: ${JSON.stringify(formatted)}`);
    }
  }
  
  return formatted;
}

// Apply formatting enforcement to entire AI response
function enforceResponseFormatting(response: any): any {
  const formatted = { ...response };
  
  // Fix problem field
  if (formatted.problem) {
    console.log(`📝 BEFORE formatting problem: "${formatted.problem}"`);
    formatted.problem = enforceProperFormatting(formatted.problem, 'problem');
    console.log(`✅ AFTER formatting problem: "${formatted.problem}"`);
  }
  
  // Fix all step content, titles, and explanations (with fallback)
  if (formatted.steps && Array.isArray(formatted.steps)) {
    formatted.steps = formatted.steps.map((step: any, index: number) => {
      // Provide a default explanation if missing (should never happen, but ensures type safety)
      const defaultExplanation = "This step is part of solving the problem.";
      const explanation = step.explanation ? enforceProperFormatting(step.explanation, `step${index+1}-explanation`) : defaultExplanation;
      
      if (!step.explanation) {
        console.warn(`⚠️  Step ${index+1} missing explanation - using fallback`);
      }
      
      return {
        ...step,
        title: step.title ? enforceProperFormatting(step.title, `step${index+1}-title`) : step.title,
        content: step.content ? enforceProperFormatting(step.content, `step${index+1}-content`) : step.content,
        explanation: explanation
      };
    });
  }
  
  // Fix final answer if present
  if (formatted.finalAnswer) {
    formatted.finalAnswer = enforceProperFormatting(formatted.finalAnswer, 'finalAnswer');
  }
  
  return formatted;
}

// ============================================================================
// QUALITY CONTROL & VALIDATION SYSTEM
// ============================================================================

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  confidence: number;
}

// Structural validation - check required fields and format
function validateStructure(solution: any): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Check required fields
  if (!solution.problem || typeof solution.problem !== 'string') {
    errors.push('Missing or invalid problem statement');
  }
  
  if (!solution.subject || typeof solution.subject !== 'string') {
    errors.push('Missing or invalid subject');
  }
  
  if (!solution.difficulty || typeof solution.difficulty !== 'string') {
    errors.push('Missing or invalid difficulty level');
  }
  
  if (!Array.isArray(solution.steps) || solution.steps.length === 0) {
    errors.push('Missing or empty steps array');
  } else {
    solution.steps.forEach((step: any, index: number) => {
      if (!step.id || !step.title || !step.content) {
        errors.push(`Step ${index + 1} missing required fields (id, title, or content)`);
      }
    });
  }
  
  // Final answer is optional for multi-part questions where answers are in steps
  // Only flag as error if there are no steps either
  if (!solution.finalAnswer && (!solution.steps || solution.steps.length === 0)) {
    errors.push('Missing final answer and no solution steps provided');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

// Cross-model verification - use a second AI to verify the solution
async function crossModelVerification(
  originalQuestion: string, 
  proposedSolution: any
): Promise<ValidationResult> {
  try {
    console.log('🔍 Running cross-model verification...');
    
    // Extract key information from the solution
    const stepsText = proposedSolution.steps
      .map((s: any) => `${s.title}: ${s.content}`)
      .join('\n');
    
    const verificationPrompt = `You are a quality control expert verifying educational content for accuracy.

ORIGINAL PROBLEM:
${originalQuestion}

PROPOSED SOLUTION:
Subject: ${proposedSolution.subject}
Grade Level: ${proposedSolution.difficulty}

Steps:
${stepsText}

Final Answer: ${proposedSolution.finalAnswer}

YOUR TASK:
1. Verify the mathematical/scientific accuracy of this solution
2. Check that calculations are correct at each step
3. Verify the final answer is accurate
4. Identify any errors in logic, arithmetic, or problem-solving approach
5. Confirm the solution actually addresses the question asked

Respond in JSON format:
{
  "isCorrect": true/false,
  "confidence": 0-100 (how confident you are in this assessment),
  "errors": ["list of specific errors found, if any"],
  "warnings": ["list of minor issues or improvements, if any"],
  "reasoning": "brief explanation of your assessment"
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are an expert quality control validator for educational content. Your job is to verify accuracy and identify errors."
        },
        {
          role: "user",
          content: verificationPrompt
        }
      ],
      response_format: { type: "json_object" },
      max_tokens: 2048,
      temperature: 0.3, // Lower temperature for more consistent verification
    });
    
    const verification = JSON.parse(response.choices[0]?.message?.content || "{}");
    
    console.log(`✓ Verification complete - Correct: ${verification.isCorrect}, Confidence: ${verification.confidence}%`);
    if (verification.errors && verification.errors.length > 0) {
      console.log(`⚠️  Errors found:`, verification.errors);
    }
    if (verification.warnings && verification.warnings.length > 0) {
      console.log(`⚠️  Warnings:`, verification.warnings);
    }
    
    return {
      isValid: verification.isCorrect === true,
      errors: verification.errors || [],
      warnings: verification.warnings || [],
      confidence: verification.confidence || 0
    };
    
  } catch (error) {
    console.error('❌ Verification error:', error);
    // If verification fails, we'll log it but not block the solution
    return {
      isValid: true, // Assume valid if verification system fails
      errors: [],
      warnings: ['Verification system encountered an error'],
      confidence: 50
    };
  }
}

// Main validation orchestrator with retry capability
async function validateSolution(
  originalQuestion: string,
  solution: any,
  attemptNumber: number = 1,
  maxRetries: number = 2
): Promise<{ solution: any; validationPassed: boolean; validationDetails?: any }> {
  const timestamp = new Date().toISOString();
  console.log(`🎯 [${timestamp}] Starting solution validation (Attempt ${attemptNumber}/${maxRetries})...`);
  
  // Step 1: Structural validation
  const structureCheck = validateStructure(solution);
  if (!structureCheck.isValid) {
    console.error('❌ Structure validation failed:', structureCheck.errors);
    // Return a failed validation rather than throwing (more graceful)
    return {
      solution,
      validationPassed: false,
      validationDetails: {
        timestamp,
        attempt: attemptNumber,
        passed: false,
        confidence: 0,
        errors: ['Solution format is invalid: ' + structureCheck.errors.join(', ')],
        warnings: [],
        subject: solution.subject || 'Unknown',
        difficulty: solution.difficulty || 'Unknown'
      }
    };
  }
  console.log('✓ Structure validation passed');
  
  // Step 2: Cross-model verification
  const verification = await crossModelVerification(originalQuestion, solution);
  
  // Step 3: Determine if solution passes quality control
  const MIN_CONFIDENCE_THRESHOLD = 70;
  const passesQC = verification.isValid && verification.confidence >= MIN_CONFIDENCE_THRESHOLD;
  
  // Log validation metrics
  const validationLog = {
    timestamp,
    attempt: attemptNumber,
    passed: passesQC,
    confidence: verification.confidence,
    errors: verification.errors,
    warnings: verification.warnings,
    subject: solution.subject,
    difficulty: solution.difficulty
  };
  console.log('📊 Validation metrics:', JSON.stringify(validationLog, null, 2));
  
  if (passesQC) {
    console.log(`✅ Solution passed all validation checks (Confidence: ${verification.confidence}%)`);
    return { 
      solution, 
      validationPassed: true,
      validationDetails: validationLog
    };
  } else {
    // If validation failed and we have retries left, log warning but don't retry yet
    // (Retry logic would need to regenerate solution, which is expensive and complex)
    const errorSummary = verification.errors.length > 0 
      ? `Errors: ${verification.errors.join('; ')}` 
      : 'Low confidence score';
    
    console.log(`⚠️  Solution validation concerns (Confidence: ${verification.confidence}%)`);
    console.log(`    ${errorSummary}`);
    
    if (verification.warnings.length > 0) {
      console.log(`    Warnings: ${verification.warnings.join('; ')}`);
    }
    
    // Note: We return the solution even if validation has concerns
    // This prevents blocking users while still logging issues for improvement
    return { 
      solution, 
      validationPassed: false,
      validationDetails: validationLog
    };
  }
}

// Ensure biology/chemistry topics have visual aids based on keyword detection
function ensureBiologyVisualAids(question: string, result: any): any {
  // Biology/Chemistry keywords that should trigger visual aids
  const biologyKeywords = {
    'krebs cycle': 'Krebs (citric acid) cycle showing circular pathway starting with Acetyl-CoA + Oxaloacetate forming Citrate, then proceeding through Isocitrate, α-Ketoglutarate, Succinyl-CoA, Succinate, Fumarate, Malate, and back to Oxaloacetate. Mark inputs (Acetyl-CoA), outputs (2 CO₂), and energy molecules produced (3 NADH, 1 FADH₂, 1 ATP/GTP) at appropriate steps. Use arrows to show cycle direction.',
    'citric acid cycle': 'Citric acid cycle (Krebs cycle) showing circular pathway with all intermediate compounds (Citrate, Isocitrate, α-Ketoglutarate, Succinyl-CoA, Succinate, Fumarate, Malate, Oxaloacetate), inputs (Acetyl-CoA), outputs (CO₂), and energy molecules (NADH, FADH₂, ATP/GTP) labeled at each step. Use arrows to show direction of cycle.',
    'electron transport chain': 'Electron transport chain showing the sequential transfer of electrons through protein complexes (Complex I, II, III, IV) in the inner mitochondrial membrane. Mark electron flow with arrows, H⁺ pumping across membrane, and ATP synthase generating ATP. Label inputs (NADH, FADH₂, O₂) and outputs (NAD⁺, FAD, H₂O, ATP).',
    'calvin cycle': 'Calvin cycle showing the three phases: Carbon Fixation (CO₂ + RuBP → 3-PGA), Reduction (3-PGA → G3P using ATP and NADPH), and Regeneration (G3P → RuBP). Mark inputs (CO₂, ATP, NADPH), outputs (glucose/G3P), and the role of RuBisCO enzyme. Use arrows to show cycle direction.',
    'photosynthesis': 'Photosynthesis process showing two main stages: Light-dependent reactions in thylakoid membranes (light energy → ATP + NADPH + O₂) and Light-independent reactions/Calvin cycle in stroma (CO₂ + ATP + NADPH → glucose). Label chloroplast structures, inputs (light, H₂O, CO₂), and outputs (O₂, glucose).',
    'cellular respiration': 'Cellular respiration showing all stages: Glycolysis (glucose → pyruvate in cytoplasm), Krebs cycle (in mitochondrial matrix), and Electron Transport Chain (in inner mitochondrial membrane). Mark inputs (glucose, O₂), outputs (CO₂, H₂O, ATP), and energy yield at each stage.',
    'protein synthesis': 'Protein synthesis showing two stages: Transcription (DNA → mRNA in nucleus) and Translation (mRNA → protein at ribosome in cytoplasm). Label DNA, mRNA, tRNA, amino acids, and ribosome. Show direction of synthesis with arrows.',
    'dna replication': 'DNA replication showing the double helix unwinding, leading strand synthesis (continuous), and lagging strand synthesis (Okazaki fragments). Label DNA polymerase, helicase, primase, template strands, and direction of synthesis (5\' to 3\'). Mark leading and lagging strands clearly.',
    'glycolysis': 'Glycolysis pathway showing 10-step conversion of glucose to 2 pyruvate molecules. Mark energy investment phase (steps 1-5 using 2 ATP) and energy payoff phase (steps 6-10 producing 4 ATP and 2 NADH). Label key intermediates and net ATP yield (+2 ATP).',
    'cell cycle': 'Cell cycle diagram showing Interphase (G₁, S, G₂ phases) and M phase (Mitosis + Cytokinesis). Mark key events in each phase, checkpoints (G₁, G₂, M), and relative time spent in each phase. Use circular diagram with labeled sections.'
  };
  
  const questionLower = question.toLowerCase();
  let matchedKeyword: string | null = null;
  let description: string | null = null;
  
  // Check if question contains any biology keywords
  for (const [keyword, defaultDescription] of Object.entries(biologyKeywords)) {
    if (questionLower.includes(keyword)) {
      matchedKeyword = keyword;
      description = defaultDescription;
      break;
    }
  }
  
  // If keyword matched and no visual aids exist, add one
  if (matchedKeyword && description) {
    if (!result.visualAids || result.visualAids.length === 0) {
      console.log(`🧬 Biology keyword detected: "${matchedKeyword}" - Adding required visual aid`);
      
      // Add visual aid to first step (or create one if none exist)
      const stepId = result.steps && result.steps.length > 0 ? result.steps[0].id : "1";
      
      result.visualAids = [{
        type: "illustration",
        stepId: stepId,
        description: description
      }];
      
      console.log(`✅ Auto-added biology visual aid for "${matchedKeyword}"`);
    } else {
      console.log(`ℹ️  Biology keyword "${matchedKeyword}" detected, but visual aid already exists`);
    }
  }
  
  return result;
}

app.post('/api/analyze-text', async (req, res) => {
  try {
    const { question } = req.body;
    console.log('Analyzing text question:', question);
    
    let result = await pRetry(
      async () => {
        try {
          const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content: `You are an expert educational AI tutor. Analyze the homework question and provide a step-by-step solution with proper formatting.

🔢 **NUMBER FORMAT RULE - MATCH THE INPUT:**
- If the problem uses DECIMALS (0.5, 2.75), use decimals in your solution
- If the problem uses FRACTIONS (1/2, 3/4), use fractions {num/den} in your solution
- For fractions: Use mixed numbers when appropriate (e.g., {1{1/2}} for 1½, {2{3/4}} for 2¾)
- CRITICAL: Match the user's preferred format - don't convert between decimals and fractions

🎨 **MANDATORY COLOR HIGHLIGHTING IN EVERY STEP:**
- Use [blue:value] for the number/operation being applied (e.g., "Multiply by [blue:8]")
- Use [red:result] for the outcome (e.g., "= [red:24]")
- **CRITICAL:** Include operators WITH the number when showing multiplication/division operations
  - CORRECT: "[blue:8 ×] {1/8}(3d - 2) = [blue:8 ×] {1/4}(d + 5)"
  - WRONG: "[blue:8] × {1/8}" (operator outside the tag causes line breaks)
- Example: "Multiply both sides by [blue:8 ×] to eliminate fractions: [blue:8 ×] {1/8}(3d - 2) = [blue:8 ×] {1/4}(d + 5) simplifies to [red:(3d - 2) = 2(d + 5)]"
- NEVER skip color highlighting - it's essential for student understanding!
- **CRITICAL:** Keep all text (including punctuation) on the SAME LINE as color tags. NEVER write: "[red:phototropism]\n." Instead write: "[red:phototropism]."

📝 **ESSAY QUESTIONS - SPECIAL FORMAT:**
**If the question requires an essay/written response** (common in Language Arts, Bible Studies, History, or opinion questions):
- Use ONLY ONE step with id "1" titled "Key Concepts for Your Essay"
- In this single step, provide GUIDANCE and RECOMMENDATIONS for the student on what themes to address and how to structure their essay
- Put the COMPLETE, POLISHED, FINAL ESSAY in the finalAnswer field - NOT advice or recommendations
- **CRITICAL:** The finalAnswer must be the ACTUAL ESSAY ITSELF written as a finished piece, not instructions on how to write it
- The essay should be well-structured with introduction, body paragraphs, and conclusion
- Highlight key concepts and vocabulary with [red:term] throughout the essay
- **Example:**
  - Step 1 content (GUIDANCE): "Your essay should address [blue:three main themes]: the protagonist's journey, the [red:symbolism] of the setting, and the [red:moral lesson]. Begin with an engaging introduction that states your thesis. Each body paragraph should focus on one theme with [blue:specific examples] from the text. Conclude by summarizing how these elements work together."
  - finalAnswer (ACTUAL ESSAY): "In Harper Lee's novel To Kill a Mockingbird, the protagonist Scout Finch embarks on a transformative journey from innocence to moral awareness. The story explores how childhood experiences shape our understanding of justice and [red:prejudice] in society. Throughout the narrative, Scout's father Atticus serves as a moral compass, teaching her that true courage means standing up for what is right even when facing overwhelming opposition. The [red:symbolism] of the mockingbird represents innocence and the harm caused by destroying it without reason..."
  - WRONG finalAnswer: "To write this essay, you should discuss the protagonist's journey. Include examples from the text. Make sure to address symbolism..." (This is advice, not an essay!)

🎯 **MULTI-STEP PROBLEMS - MANDATORY OVERVIEW IN STEP 1:**
**For any problem requiring multiple steps (math, physics, chemistry, multi-part analysis), Step 1 MUST be a simple overview that helps orient the student.**

**Purpose:** Help students understand the "big picture" before diving into detailed calculations. This centers their approach and shows the general strategy.

**Step 1 Requirements for Multi-Step Problems:**
- **Title:** Should identify the problem type (e.g., "Identify Problem Type: Linear Equation", "Approach: Projectile Motion Analysis", "Strategy: Finding Area of Composite Shape")
- **Content:** Write 2-3 SHORT sentences that explain:
  1. What type of problem this is (e.g., "This is a [red:linear equation] with fractions on both sides")
  2. The general approach we'll use (e.g., "We'll [blue:eliminate fractions first], then [blue:collect like terms], and finally [blue:isolate the variable]")
  3. Optional: What our goal is (e.g., "Our goal is to find the value of [red:d]")
- **Explanation:** Brief note about why this approach makes sense (e.g., "Starting with a clear plan helps us stay organized through multiple steps")

**Examples:**

**Math Problem (Linear Equation):**
- Step 1 Title: "Identify Problem Type and Approach"
- Step 1 Content: "This is a [red:linear equation] with fractional coefficients on both sides. We'll [blue:multiply both sides by a common multiple] to eliminate fractions, then [blue:distribute and combine like terms] to solve for [red:d]. This systematic approach keeps the algebra organized."
- Step 1 Explanation: "Understanding our strategy upfront prevents confusion when working with multiple fractions"

**Physics Problem (Projectile Motion):**
- Step 1 Title: "Problem Type: Projectile Motion"
- Step 1 Content: "This is a [red:2D projectile motion] problem where we need to find maximum height and range. We'll [blue:break velocity into components], use [blue:kinematic equations for vertical motion] to find peak height, and [blue:calculate horizontal distance] using time of flight. The parabolic trajectory means vertical and horizontal motions are independent."
- Step 1 Explanation: "Separating the motion into vertical and horizontal components simplifies what looks like a complex 2D problem"

**Geometry Problem:**
- Step 1 Title: "Approach: Composite Shape Area"
- Step 1 Content: "This shape is a [red:composite figure] made of a rectangle and semicircle. We'll [blue:find the area of each shape separately] using their respective formulas, then [blue:add them together]. Breaking complex shapes into simpler parts is the key strategy here."
- Step 1 Explanation: "Dividing the composite shape into familiar pieces (rectangle + semicircle) makes the calculation straightforward"

**Chemistry Problem:**
- Step 1 Title: "Strategy: Stoichiometry Calculation"
- Step 1 Content: "This is a [red:limiting reactant problem] requiring stoichiometry. We'll [blue:convert grams to moles], [blue:use mole ratios] from the balanced equation to identify which reactant runs out first, then [blue:calculate product yield] based on the limiting reactant."
- Step 1 Explanation: "Following the moles pathway (grams → moles → mole ratio → moles → grams) is the systematic approach for all stoichiometry problems"

**CRITICAL:** This overview step does NOT replace detailed work - it simply provides a roadmap. Steps 2, 3, 4, etc. will contain the actual calculations and detailed solution work.

**When NOT to use overview step:**
- Simple one-step problems (e.g., "What is 5 + 3?")
- Essay questions (already have special format)
- Multiple choice questions that only need elimination logic

💡 **STEP EXPLANATIONS - CONTEXTUAL LEARNING:**
**MANDATORY: Every step must include a concise "explanation" field that provides immediate learning context.**

**Purpose:** Help students understand WHY we're doing each step, not just WHAT we're doing.

**Guidelines:**
- **Length:** ONE concise sentence that captures the key insight or reasoning for this step
- **Tone:** Conversational and encouraging, like a tutor sitting beside the student
- **Focus:** Explain the PURPOSE or STRATEGY behind the step, not just repeat what's in the content

**Subject-Aware Verbosity:**
- **Math/Physics:** Keep explanations MINIMAL and focused on the mathematical operation
  - Example: "We're finding a common denominator so we can add these fractions together."
  - Example: "Isolating the variable on one side will help us find its value."
- **Essays/History/Science (non-quantitative):** Use MORE VERBOSE explanations that provide narrative context
  - Example: "This paragraph establishes your thesis by connecting the historical context to your main argument about social change."
  - Example: "Understanding the hormone's role helps explain how the plant responds to environmental stimuli."
- **Multiple Choice:** Brief reasoning about the elimination logic or why the correct answer fits
  - Example: "We can eliminate options A and B because they don't account for the energy lost to friction."

**What to Include:**
✓ The strategic reason for this step ("We need to eliminate the fraction to solve for x")
✓ The mathematical principle being applied ("Common denominators allow us to combine fractions")
✓ The connection to the problem goal ("This brings us closer to finding the vertex coordinates")

**What NOT to Include:**
✗ Repeating what's already in the title or content
✗ Generic statements like "This is an important step"
✗ Procedural instructions that are already shown in the content

**Examples:**

For Math Step:
- title: "Find a common denominator"
- content: "{2/3} + {1/4} = {8/12} + {3/12} = {11/12}"
- explanation: "Finding a common denominator of 12 allows us to add fractions by making the pieces the same size."

For Physics Step:
- title: "Apply Newton's Second Law"
- content: "F = ma, so [blue:15 N] = [blue:3 kg] × a → a = [red:5 m/s²]"
- explanation: "We're using the relationship between force, mass, and acceleration to find how quickly the object speeds up."

For Essay Step:
- title: "Develop Your Argument"
- content: "Build three body paragraphs exploring [blue:character development], [blue:thematic symbolism], and [blue:narrative structure]..."
- explanation: "Organizing your analysis into these three focused areas creates a clear, logical progression that strengthens your overall argument about the author's intent."

RESPONSE FORMAT (JSON):
{
  "problem": "Restate the problem clearly",
  "subject": "Math|Chemistry|Physics|Bible Studies|Language Arts|Geography|General",
  "difficulty": "K-5|6-8|9-12|College+",
  "steps": [
    {
      "id": "1",
      "title": "Clear action heading",
      "content": "Solution step with proper formatting (use {num/den} for fractions, _subscript_, ^superscript^, [red:text] for colors, -> for arrows)",
      "explanation": "One concise sentence explaining WHY this step matters or WHAT strategy it employs"
    }
  ],
  "finalAnswer": "Final answer with KEY TERMS highlighted using [red:term] syntax for important concepts, formulas, or vocabulary (e.g., [red:phototropism], [red:auxin], [red:quadratic formula])",
  "visualAids": [
    {
      "type": "physics|geometry|graph|chart|illustration",
      "stepId": "1",
      "description": "Detailed description of what to visualize with all measurements and labels"
    }
  ]
}

**FINAL ANSWER HIGHLIGHTING - CRITICAL:**
- ALWAYS highlight key technical terms, concepts, or vocabulary in the final answer using [red:term]
- Examples: [red:phototropism], [red:auxin], [red:mitochondria], [red:Pythagorean theorem], [red:oxidation]
- For math: highlight the final numerical answer: [red:x = 5] or [red:{3/4}]
- For science: highlight phenomena, hormones, processes, chemical names
- For any subject: highlight the most important 2-3 terms that answer the core question
- **MULTIPLE CHOICE QUESTIONS:** If the question provides answer choices (A, B, C, D), ALWAYS include the correct letter in the final answer:
  - CORRECT: "[red:C) Mitochondrion]" or "[red:C)] [red:Mitochondrion]"
  - WRONG: "[red:Mitochondrion]" (missing the letter C)
  - The letter must be clearly visible so students know which option is correct
- **MULTI-PART ANSWERS:** If the question has multiple parts OR your answer has multiple numbered/lettered items, put each part on its own line:
  - CORRECT (letters): "a) [red:v = 15 m/s] \n b) [red:h = 11.5 m] \n c) [red:t = 3.1 s]"
  - CORRECT (numbers): "1. [blue:Patient Preparation]: ... \n 2. [blue:Ultrasound Guidance]: ... \n 3. [blue:Sterile Field]: ..."
  - WRONG: "a) v = 15 m/s, b) h = 11.5 m, c) t = 3.1 s" (all on one line)
  - WRONG: "1. Step one 2. Step two 3. Step three" (all on one line)

**CRITICAL: visualAids array is REQUIRED for:**
- Physics: projectile motion, force diagrams, circuits, kinematics
- Geometry: shapes, angles, spatial relationships
- Data: surveys, percentages, comparing quantities, proportions
- Biology/Chemistry: metabolic cycles (Krebs, Calvin, electron transport), cellular processes, multi-step reactions
- Leave empty [] ONLY if truly no visual would help

📊 INTELLIGENT VISUAL AIDS - WHEN AND WHAT TYPE TO CREATE 📊

**🚨 ESSENTIAL VISUALS - ALWAYS CREATE for these classic scenarios:**

**PHYSICS - NEARLY MANDATORY:**
✓ **PROJECTILE MOTION** - Any problem with objects launched at angles (catapults, projectiles, balls thrown)
   → Show parabolic trajectory, launch angle, velocity components, max height, range
   → Tag: [DIAGRAM NEEDED: type=physics - Projectile motion showing parabolic arc from launch point at [angle]° with initial velocity [v₀], marking maximum height at apex, horizontal range, and ground level. Label velocity components, trajectory path, and key measurements.]

✓ **FORCE DIAGRAMS** - Any problem analyzing forces on an object (friction, tension, normal force)
   → Show object with all force vectors (magnitude + direction), coordinate system
   → Tag: [DIAGRAM NEEDED: type=physics - Free body diagram of [object] with force vectors: [list all forces with magnitudes and directions]. Include coordinate axes.]

✓ **KINEMATICS** - Motion problems with acceleration, velocity, position over time
   → Show motion diagram with position/velocity/acceleration vectors at key moments
   → Tag: [DIAGRAM NEEDED: type=physics - Motion diagram showing [object] at key time points with velocity and acceleration vectors. Mark initial and final positions.]

✓ **CIRCUITS** - Any electrical circuit problem
   → Show circuit schematic with components, current flow, voltage labels
   → Tag: [DIAGRAM NEEDED: type=physics - Circuit diagram with [components] connected in [series/parallel], showing current direction and voltage labels.]

**GEOMETRY - NEARLY MANDATORY:**
✓ Any problem with shapes, angles, areas, perimeters
✓ Spatial relationships between multiple geometric objects
✓ 3D geometry or perspective views

**DATA VISUALIZATION - NEARLY MANDATORY:**
✓ **SURVEYS & PERCENTAGES** - Any problem asking about percentages, surveys, or preferences
   → **MUST CREATE** a pie chart or bar chart comparing categories
   → Examples triggering this: "survey of students", "percentage of...", "what fraction preferred", "poll results"
   → Tag: [DIAGRAM NEEDED: type=chart - Pie chart showing [category names] with percentages: [list each category with its percentage]. Use distinct colors for each segment and label with both category name and percentage.]
   → EXAMPLE: For "survey of 200 students: Math 60, Science 50, English 40, History 30, Art 20" → ADD: [DIAGRAM NEEDED: type=chart - Pie chart showing subject preferences: Math 30%, Science 25%, English 20%, History 15%, Art 10%. Use distinct colors for each segment with labels.]

✓ **COMPARING QUANTITIES** - Problems comparing multiple values, populations, or measurements
   → Show bar chart or comparison chart
   → Tag: [DIAGRAM NEEDED: type=chart - Bar chart comparing [categories] with values: [list values]. Include labeled axes and value labels on each bar.]

✓ **PROPORTIONS & RATIOS** - Problems involving parts of a whole
   → Show pie chart or stacked bar chart
   → Tag: [DIAGRAM NEEDED: type=chart - Visual representation showing proportions of [total] divided into [parts with values/percentages].]

**BIOLOGY & CHEMISTRY - NEARLY MANDATORY:**
✓ **METABOLIC CYCLES & PATHWAYS** - The Krebs cycle, citric acid cycle, Calvin cycle, electron transport chain
   → **MUST CREATE** a process illustration showing the cycle with inputs, outputs, and intermediate steps
   → Tag: [DIAGRAM NEEDED: type=illustration - [Cycle name] showing circular pathway with all intermediate compounds, enzymes (if mentioned), inputs (substrates entering), outputs (products leaving), and energy molecules (ATP, NADH, FADH₂, etc.). Label each step in sequence with arrows showing direction of flow.]
   → EXAMPLE: "Krebs cycle" → ADD: [DIAGRAM NEEDED: type=illustration - Krebs (citric acid) cycle showing circular pathway starting with Acetyl-CoA + Oxaloacetate forming Citrate, then proceeding through Isocitrate, α-Ketoglutarate, Succinyl-CoA, Succinate, Fumarate, Malate, and back to Oxaloacetate. Mark inputs (Acetyl-CoA), outputs (2 CO₂), and energy molecules produced (3 NADH, 1 FADH₂, 1 ATP/GTP) at appropriate steps. Use arrows to show cycle direction.]

✓ **CELLULAR PROCESSES** - Photosynthesis, cellular respiration, protein synthesis, DNA replication
   → Show multi-stage process with labeled inputs, outputs, and intermediate steps
   → Tag: [DIAGRAM NEEDED: type=illustration - [Process name] showing all stages, key molecules/structures involved, inputs, outputs, and energy flow. Label each major step.]

✓ **CHEMICAL REACTIONS & MECHANISMS** - Multi-step organic reactions, redox reactions, equilibrium systems
   → Show reaction pathway with structures, electron flow, intermediates
   → Tag: [DIAGRAM NEEDED: type=illustration - Reaction mechanism showing reactants, intermediates, and products with electron flow arrows and key conditions.]

**SCREENING CRITERIA - For other cases, create visuals when they SIGNIFICANTLY enhance understanding:**

Consider creating a visual aid when:
✓ The problem involves spatial relationships that are hard to describe in words alone
✓ Lower grade levels (K-5, 6-8) - visuals help younger students grasp concepts better
✓ Complex multi-step processes benefit from a visual roadmap
✓ The visual would clarify confusion, not just repeat what words already convey

**TYPES OF VISUALS:**

1. **GEOMETRIC DIAGRAMS** - For shapes, angles, spatial relationships
   - Tag: [DIAGRAM NEEDED: type=geometry - detailed description with ALL dimensions, labels, spatial relationships]

2. **GRAPHS & COORDINATE PLANES** - For plotting, functions, data visualization
   - Tag: [DIAGRAM NEEDED: type=graph - equation/function with axes, labels, key points]

3. **CHARTS & DATA VISUALIZATION** - For comparing quantities, showing proportions
   - Tag: [DIAGRAM NEEDED: type=chart - data values, labels, chart type (bar/pie/line)]

4. **PHYSICS DIAGRAMS** - For forces, motion, circuits, energy
   - Tag: [DIAGRAM NEEDED: type=physics - physical setup, forces/components, labels]

5. **PROCESS ILLUSTRATIONS** - For sequential steps or transformations
   - Tag: [DIAGRAM NEEDED: type=illustration - what's shown, key elements, relationships]

**WHEN NOT TO CREATE VISUALS:**
✗ Pure algebraic manipulation where symbols are clear enough
✗ Simple word problems without spatial/physical elements
✗ When the description in words is already perfectly clear

**PLACEMENT:** Visual aids can appear in ANY step where they'd be most helpful, not just Step 1. Place them where understanding would benefit most.

**FORMAT EXAMPLE:**
"[DIAGRAM NEEDED: type=geometry - Rectangle PQRS with horizontal base PQ = 6 units at bottom, vertical height PS on left side. Isosceles triangle OPQ with base PQ (6 units) on bottom edge of rectangle, vertex O above PQ, equal sides OP and OQ forming triangle inside rectangle. Label all corners P, Q, R, S clockwise, and point O at triangle apex.]"

**DECISION FRAMEWORK:**
Ask yourself: "Would a student understand this BETTER with a visual, or is it already clear?"
- If visual is essential for understanding → CREATE IT
- If visual would be nice but not necessary → SKIP IT
- If visual would just repeat what's already clear → SKIP IT

CRITICAL MATHEMATICAL FORMATTING RULES:

**FRACTIONS - ABSOLUTELY MANDATORY VERTICAL FORMAT:**
- ALWAYS use {num/den} for ALL fractions at ALL stages - NEVER use inline format like "a/b", (a/b), or decimals
- Simple fractions: {5/6}, {3/4}, {12/7}
- Complex fractions: {12/{3d - 1}}, {{-b ± √{b^2^ - 4ac}}/{2a}}, {{x + 5}/{x - 2}}
- ALWAYS simplify fractions before presenting: {12/8} -> {3/2}
- For improper fractions in FINAL ANSWER ONLY, show both reduced fraction AND mixed number: {7/3} = 2{1/3} or {17/5} = 3{2/5}
- NEVER convert to decimals at ANY step unless user explicitly requests decimal form
- Arithmetic with fractions stays as fractions: {2/3} + {1/4} = {8/12} + {3/12} = {11/12}
- **CRITICAL: When finding common denominators, EXPLICITLY STATE what the common denominator is and SHOW the conversion:**
  - GOOD: "Find a common denominator of [blue:5]: {12/5}h - 2h. Convert 2h to fifths: [blue:2h = {10/5}h]. This gives us: [blue:{12/5}h - {10/5}h] = [red:{2/5}h]"
  - BAD: "Simplify by finding a common denominator: {12/5}h - {10/5}h = {2/5}h" (doesn't explain what the denominator is or show conversion)

**COLOR HIGHLIGHTING - CLARITY FOR EVERY OPERATION:**
- [blue:term] = the specific value/variable/operation being applied in THIS step
- [red:result] = the outcome or simplified result
- Use highlighting to show EXACTLY what changes: "Multiply by [blue:5]: 3x = 15 -> [blue:5] × 3x = [blue:5] × 15 -> 15x = [red:75]"
- When substituting: "Substitute [blue:d = 1]: {12/{3([blue:1]) - 1}} = {12/[red:2]} = [red:6]"
- Multiple operations: use blue for operation, red for result, keep unhighlighted text as context

**ALGEBRAIC EQUATIONS - SHOW EVERY TRANSFORMATION:**
- Always use vertical fractions: {12/{3d - 1}} = d + 5
- Show progression with arrows: equation_before -> equation_after
- Quadratic formula MUST be: x = {{-b ± √{b^2^ - 4ac}}/{2a}} with full braces on numerator
- Example substitution: a=[blue:3], b=[blue:14], c=[blue:-17]
  x = {{-[blue:14] ± √{[blue:14]^2^ - 4([blue:3])([blue:-17])}}/{2([blue:3])}}
  x = {{-14 ± √{196 + 204}}/{6}}
  x = {{-14 ± √400}/{6}}
  x = {{-14 ± 20}/{6}}
  Two solutions: x = {{-14 + 20}/{6}} = {6/6} = [red:1] OR x = {{-14 - 20}/{6}} = {-34/6} = {-17/3} = [red:-5{2/3}]

**SQUARE ROOTS, EXPONENTS, AND SPECIAL SYMBOLS:**
- Square roots: √16 = 4, √{25} = 5, √{b^2^ - 4ac}
- Exponents: x^2^, 3^4^ = 81, (2x)^3^ = 8x^3^
- Plus-minus: ±
- Nested: √{x^2^ + y^2^}

**STEP CLARITY - EACH STEP TELLS A STORY:**
- Title: Concise action verb phrase ("Multiply both sides by (3d - 1)", "Apply quadratic formula", "Simplify the fraction")
- Content: Show WHAT you're doing, WHY, and the RESULT
- Before and after: Show equation before operation, highlight what changes, show result
- Example full step:
  Title: "Clear the fraction by multiplying both sides"
  Content: "Multiply both sides by [blue:(3d - 1)] to eliminate the fraction:
  [blue:(3d - 1)] × {12/{3d - 1}} = [blue:(3d - 1)] × (d + 5)
  -> 12 = [red:(3d - 1)(d + 5)]"

**COMPLETE WORKED EXAMPLE - SOLVING {12/{3d - 1}} = d + 5:**

Step 1 Title: "Rewrite as a fraction equation"
Content: "{12/{3d - 1}} = d + 5"

Step 2 Title: "Clear the fraction by multiplying both sides"
Content: "Multiply both sides by [blue:(3d - 1)]:
[blue:(3d - 1)] × {12/{3d - 1}} = [blue:(3d - 1)] × (d + 5)
-> 12 = [red:(d + 5)(3d - 1)]"

Step 3 Title: "Expand the right side"
Content: "Expand [blue:(d + 5)(3d - 1)]:
12 = d([blue:3d]) + d([blue:-1]) + 5([blue:3d]) + 5([blue:-1])
12 = 3d^2^ - d + 15d - 5
-> 12 = [red:3d^2^ + 14d - 5]"

Step 4 Title: "Set to standard quadratic form"
Content: "Subtract [blue:12] from both sides:
12 [blue:- 12] = 3d^2^ + 14d - 5 [blue:- 12]
-> 0 = [red:3d^2^ + 14d - 17]"

Step 5 Title: "Apply the quadratic formula"
Content: "For 3d^2^ + 14d - 17 = 0, use d = {{-b ± √{b^2^ - 4ac}}/{2a}}
where a=[blue:3], b=[blue:14], c=[blue:-17]

Discriminant: Δ = [blue:14]^2^ - 4([blue:3])([blue:-17]) = 196 + 204 = [red:400]

d = {{-14 ± √400}/{6}} = {{-14 ± 20}/{6}}

Two solutions:
d = {{-14 + 20}/{6}} = {6/6} = [red:1]
d = {{-14 - 20}/{6}} = {-34/6} = {-17/3} = [red:-5{2/3}]"

**CHEMISTRY/PHYSICS:**
- Subscripts: H_2_O, v_0_, x_n_
- Superscripts: Ca^2+^, x^3^
- Units: 5 m/s^2^, 3.2 × 10^-5^ mol

Grade-appropriate language based on difficulty level.`
              },
              {
                role: "user",
                content: question
              }
            ],
            response_format: { type: "json_object" },
            max_tokens: 8192,
          });
          
          const content = response.choices[0]?.message?.content || "{}";
          const parsed = JSON.parse(content);
          return parsed;
        } catch (error: any) {
          console.error('OpenAI API error:', error);
          if (isRateLimitError(error)) {
            throw error;
          }
          throw new AbortError(error);
        }
      },
      {
        retries: 7,
        minTimeout: 2000,
        maxTimeout: 128000,
        factor: 2,
      }
    );
    
    // 🧬 BIOLOGY/CHEMISTRY KEYWORD DETECTION: Ensure visual aids for metabolic cycles
    result = ensureBiologyVisualAids(question, result);
    
    // ⚡ ASYNC DIAGRAM GENERATION: Generate unique solution ID
    const solutionId = crypto.randomBytes(16).toString('hex');
    const diagrams: DiagramStatus[] = [];
    
    // Collect all diagram requirements from visualAids array
    if (result.visualAids && Array.isArray(result.visualAids)) {
      for (const visualAid of result.visualAids) {
        const { type, stepId, description } = visualAid;
        diagrams.push({
          stepId,
          type,
          description,
          status: 'pending'
        });
      }
    }
    
    // Legacy support: Check for old-style [DIAGRAM NEEDED: ...] tags
    for (const step of result.steps) {
      if (step.content) {
        const diagramMatch = step.content.match(/\[DIAGRAM NEEDED:\s*([^\]]+)\]/);
        if (diagramMatch) {
          diagrams.push({
            stepId: step.id,
            type: 'legacy',
            description: diagramMatch[1],
            status: 'pending'
          });
        }
      }
    }
    
    // Initialize diagram store for this solution
    if (diagrams.length > 0) {
      solutionDiagramStore.set(solutionId, {
        diagrams,
        timestamp: Date.now(),
        complete: false
      });
      console.log(`📊 Initialized ${diagrams.length} pending diagrams for solution ${solutionId}`);
    }
    
    // CLEANUP: Remove all [DIAGRAM NEEDED] tags - diagrams will load asynchronously
    for (const step of result.steps) {
      if (step.content) {
        let content = step.content;
        
        while (true) {
          const startIndex = content.indexOf('[DIAGRAM NEEDED:');
          if (startIndex === -1) break;
          
          let depth = 1;
          let endIndex = startIndex + '[DIAGRAM NEEDED:'.length;
          
          while (depth > 0 && endIndex < content.length) {
            if (content[endIndex] === '[') depth++;
            else if (content[endIndex] === ']') depth--;
            endIndex++;
          }
          
          content = content.substring(0, startIndex) + content.substring(endIndex);
        }
        
        step.content = content;
      }
    }
    
    // ENFORCE PROPER FORMATTING - Convert all fractions to {num/den} format
    const formattedResult = enforceResponseFormatting(result);
    
    // Add solutionId to response for diagram polling
    const responseWithId = {
      ...formattedResult,
      solutionId: diagrams.length > 0 ? solutionId : undefined
    };
    
    // ⚡ RETURN IMMEDIATELY - No waiting for diagrams!
    console.log(`✅ Analysis complete - returning solution ${solutionId} immediately (<8s target)`);
    res.json(responseWithId);
    
    // ⚡ BACKGROUND TASKS: Validation and diagram generation (non-blocking)
    void validateSolution(question, formattedResult)
      .then(({ validationPassed, validationDetails }) => {
        if (!validationPassed) {
          console.warn('⚠️ Background validation failed:', validationDetails);
        } else {
          console.log('✅ Background validation passed');
        }
      })
      .catch(err => {
        console.error('⚠️ Background validation error (non-blocking):', err);
      });
    
    // Generate diagrams in background if any exist
    if (diagrams.length > 0) {
      const hostname = req.get('host');
      void generateDiagramsInBackground(solutionId, diagrams, result.steps, hostname);
    }
  } catch (error) {
    console.error('Error analyzing text:', error);
    res.status(500).json({ error: 'Failed to analyze question' });
  }
});

app.post('/api/analyze-image', async (req, res) => {
  try {
    const { imageUri, problemNumber } = req.body;
    console.log('Analyzing image, problem number:', problemNumber);
    
    // 🚀 HYBRID OCR APPROACH: Google Vision + GPT-4o
    let ocrText = '';
    let ocrConfidence = 0;
    let useHybridOCR = false;
    
    try {
      const visionAvailable = await isGoogleVisionAvailable();
      if (visionAvailable) {
        console.log('🔍 Step 1: Extracting text with Google Cloud Vision (high-accuracy OCR)...');
        const ocrResult = await extractTextFromImage(imageUri);
        ocrText = formatOCRText(ocrResult.text);
        ocrConfidence = ocrResult.confidence;
        useHybridOCR = true;
        console.log(`✅ OCR extraction complete. Confidence: ${(ocrConfidence * 100).toFixed(1)}%, Text length: ${ocrText.length} chars`);
        console.log(`📝 OCR Preview: ${ocrText.substring(0, 200)}...`);
      } else {
        console.log('⚠️ Google Vision API key not configured - falling back to GPT-4o vision only');
      }
    } catch (ocrError) {
      console.error('⚠️ Google Vision OCR failed, falling back to GPT-4o vision only:', ocrError);
      useHybridOCR = false;
    }
    
    let result = await pRetry(
      async () => {
        try {
          // Build system message based on whether we have OCR text
          let systemMessage = `You are an expert educational AI tutor. Analyze the homework ${useHybridOCR ? 'problem' : 'image'} and provide a step-by-step solution.

⚠️ CRITICAL: You MUST respond with valid JSON only.

${problemNumber ? `Focus on problem #${problemNumber} in the ${useHybridOCR ? 'text below' : 'image'}.` : useHybridOCR ? 'Solve the problem shown in the text below.' : 'If multiple problems exist, solve the most prominent one.'}`;

          if (useHybridOCR) {
            systemMessage += `

🎯 **HYBRID OCR MODE - IMPORTANT INSTRUCTIONS:**

**You have been provided with HIGH-ACCURACY OCR text extracted by Google Cloud Vision (${(ocrConfidence * 100).toFixed(1)}% confidence).**

**YOUR PRIMARY TASK:**
1. Use the OCR text below as your PRIMARY SOURCE for the exact problem statement
2. The OCR text is HIGHLY ACCURATE (96-99% precision) - trust it for numbers, variables, and mathematical notation
3. Cross-reference with the image ONLY for:
   - Visual context (diagrams, graphs already present in the problem)
   - Layout understanding (how equations or problems are arranged)
   - Handwriting style or formatting nuances

**CRITICAL OCR USAGE RULES:**
✅ DO: Trust OCR text for all numbers, decimals, variables, operators, and equation structure
✅ DO: Use OCR text character-for-character for mathematical expressions
✅ DO: Preserve exact decimal places and fractions as shown in OCR
❌ DON'T: Re-read numbers or text from the image when OCR text is available
❌ DON'T: Second-guess the OCR text unless image clearly contradicts it
❌ DON'T: Ignore OCR text and only use image analysis

**WHY THIS MATTERS:**
- Specialized OCR engines excel at pixel-perfect character recognition (especially decimals like 3.14, 19.6, 0.5)
- GPT-4o vision is better at reasoning and layout understanding than raw OCR
- Combining both gives you the best of both worlds: accuracy + intelligence

**OCR-EXTRACTED TEXT:**
\`\`\`
${ocrText}
\`\`\`

**Now solve the problem using the OCR text above as your primary reference.**`;
          }
          
          systemMessage += `

🔢 **NUMBER FORMAT RULE - MATCH THE INPUT:**
- If the problem uses DECIMALS (0.5, 2.75), use decimals in your solution
- If the problem uses FRACTIONS (1/2, 3/4), use fractions {num/den} in your solution
- For fractions: Use mixed numbers when appropriate (e.g., {1{1/2}} for 1½, {2{3/4}} for 2¾)
- CRITICAL: Match the user's preferred format - don't convert between decimals and fractions`;

          // For hybrid OCR, we already have the character-level accuracy instructions
          // For GPT-4o vision only, add the OCR accuracy instructions
          if (!useHybridOCR) {
            systemMessage += `

🎨 **MANDATORY COLOR HIGHLIGHTING IN EVERY STEP:**
- Use [blue:value] for the number/operation being applied (e.g., "Multiply by [blue:8]")
- Use [red:result] for the outcome (e.g., "= [red:24]")
- **CRITICAL:** Include operators WITH the number when showing multiplication/division operations
  - CORRECT: "[blue:8 ×] {1/8}(3d - 2) = [blue:8 ×] {1/4}(d + 5)"
  - WRONG: "[blue:8] × {1/8}" (operator outside the tag causes line breaks)
- Example: "Multiply both sides by [blue:8 ×] to eliminate fractions: [blue:8 ×] {1/8}(3d - 2) = [blue:8 ×] {1/4}(d + 5) simplifies to [red:(3d - 2) = 2(d + 5)]"
- NEVER skip color highlighting - it's essential for student understanding!
- **CRITICAL:** Keep all text (including punctuation) on the SAME LINE as color tags. NEVER write: "[red:phototropism]\n." Instead write: "[red:phototropism]."

📝 **ESSAY QUESTIONS - SPECIAL FORMAT:**
**If the question requires an essay/written response** (common in Language Arts, Bible Studies, History, or opinion questions):
- Use ONLY ONE step with id "1" titled "Key Concepts for Your Essay"
- In this single step, provide GUIDANCE and RECOMMENDATIONS for the student on what themes to address and how to structure their essay
- Put the COMPLETE, POLISHED, FINAL ESSAY in the finalAnswer field - NOT advice or recommendations
- **CRITICAL:** The finalAnswer must be the ACTUAL ESSAY ITSELF written as a finished piece, not instructions on how to write it
- The essay should be well-structured with introduction, body paragraphs, and conclusion
- Highlight key concepts and vocabulary with [red:term] throughout the essay
- **Example:**
  - Step 1 content (GUIDANCE): "Your essay should address [blue:three main themes]: the protagonist's journey, the [red:symbolism] of the setting, and the [red:moral lesson]. Begin with an engaging introduction that states your thesis. Each body paragraph should focus on one theme with [blue:specific examples] from the text. Conclude by summarizing how these elements work together."
  - finalAnswer (ACTUAL ESSAY): "In Harper Lee's novel To Kill a Mockingbird, the protagonist Scout Finch embarks on a transformative journey from innocence to moral awareness. The story explores how childhood experiences shape our understanding of justice and [red:prejudice] in society. Throughout the narrative, Scout's father Atticus serves as a moral compass, teaching her that true courage means standing up for what is right even when facing overwhelming opposition. The [red:symbolism] of the mockingbird represents innocence and the harm caused by destroying it without reason..."
  - WRONG finalAnswer: "To write this essay, you should discuss the protagonist's journey. Include examples from the text. Make sure to address symbolism..." (This is advice, not an essay!)

🎯 **MULTI-STEP PROBLEMS - MANDATORY OVERVIEW IN STEP 1:**
**For any problem requiring multiple steps (math, physics, chemistry, multi-part analysis), Step 1 MUST be a simple overview that helps orient the student.**

**Purpose:** Help students understand the "big picture" before diving into detailed calculations. This centers their approach and shows the general strategy.

**Step 1 Requirements for Multi-Step Problems:**
- **Title:** Should identify the problem type (e.g., "Identify Problem Type and Approach", "Problem Type: Projectile Motion", "Strategy: Composite Shape Area")
- **Content:** Write 2-3 SHORT sentences that explain:
  1. What type of problem this is (e.g., "This is a [red:linear equation] with fractions on both sides")
  2. The general approach we'll use (e.g., "We'll [blue:eliminate fractions first], then [blue:collect like terms], and finally [blue:isolate the variable]")
  3. Optional: What our goal is (e.g., "Our goal is to find the value of [red:d]")
- **Explanation:** Brief note about why this approach makes sense (e.g., "Starting with a clear plan helps us stay organized through multiple steps")

**Examples:**

**Math Problem (Linear Equation):**
- Step 1 Title: "Identify Problem Type and Approach"
- Step 1 Content: "This is a [red:linear equation] with fractional coefficients on both sides. We'll [blue:multiply both sides by a common multiple] to eliminate fractions, then [blue:distribute and combine like terms] to solve for [red:d]. This systematic approach keeps the algebra organized."
- Step 1 Explanation: "Understanding our strategy upfront prevents confusion when working with multiple fractions"

**Physics Problem (Projectile Motion):**
- Step 1 Title: "Problem Type: Projectile Motion"
- Step 1 Content: "This is a [red:2D projectile motion] problem where we need to find maximum height and range. We'll [blue:break velocity into components], use [blue:kinematic equations for vertical motion] to find peak height, and [blue:calculate horizontal distance] using time of flight. The parabolic trajectory means vertical and horizontal motions are independent."
- Step 1 Explanation: "Separating the motion into vertical and horizontal components simplifies what looks like a complex 2D problem"

**Geometry Problem:**
- Step 1 Title: "Approach: Composite Shape Area"
- Step 1 Content: "This shape is a [red:composite figure] made of a rectangle and semicircle. We'll [blue:find the area of each shape separately] using their respective formulas, then [blue:add them together]. Breaking complex shapes into simpler parts is the key strategy here."
- Step 1 Explanation: "Dividing the composite shape into familiar pieces (rectangle + semicircle) makes the calculation straightforward"

**Chemistry Problem:**
- Step 1 Title: "Strategy: Stoichiometry Calculation"
- Step 1 Content: "This is a [red:limiting reactant problem] requiring stoichiometry. We'll [blue:convert grams to moles], [blue:use mole ratios] from the balanced equation to identify which reactant runs out first, then [blue:calculate product yield] based on the limiting reactant."
- Step 1 Explanation: "Following the moles pathway (grams → moles → mole ratio → moles → grams) is the systematic approach for all stoichiometry problems"

**CRITICAL:** This overview step does NOT replace detailed work - it simply provides a roadmap. Steps 2, 3, 4, etc. will contain the actual calculations and detailed solution work.

**When NOT to use overview step:**
- Simple one-step problems (e.g., "What is 5 + 3?")
- Essay questions (already have special format)
- Multiple choice questions that only need elimination logic

**🚨 CRITICAL OCR ACCURACY INSTRUCTIONS - READ EVERY CHARACTER CAREFULLY 🚨**

⚠️⚠️⚠️ ABSOLUTE PRIORITY: READ EVERY SINGLE CHARACTER WITH EXTREME CARE ⚠️⚠️⚠️

**MOST CRITICAL - DECIMAL POINTS AND NUMBERS:**
- **DECIMAL POINTS ARE TINY BUT ESSENTIAL** - Look for EVERY decimal point (.) with maximum attention
- WRONG: Reading "3.14" as "314" - NEVER miss decimal points!
- WRONG: Reading "0.5" as "5" or "05" - Leading zeros matter!
- WRONG: Reading "2.75" as "275" or "2.7" - Count digits after decimal carefully!
- **VERIFY EVERY NUMBER:** Is it 3.14 or 314? Is it 0.5 or 5? Is it 19.6 or 196?
- Common decimal numbers in homework: 3.14, 0.5, 2.75, 9.8, 19.6, 14.7
- **Before solving ANY problem, scan for decimal points and verify you captured EVERY digit correctly**

**🚨 CRITICAL - LETTERS vs NUMBERS CONFUSION (MOST COMMON OCR ERROR):**
DO NOT confuse these commonly misread pairs - VERIFY CONTEXT:
- **"r" is a LETTER, "1" is a NUMBER** - WRONG: Reading "rt" as "11" (should be r and t!)
- **"t" is a LETTER, "1" is a NUMBER** - WRONG: Reading "rate" as "1a1e"
- **"l" (lowercase L) is a LETTER, "1" is a NUMBER** - Context matters: "al" not "a1"
- **"I" (capital i) is a LETTER, "1" is a NUMBER** - In words, it's probably "I"
- **"O" (letter) vs "0" (zero)** - In variables (vO, aO) it's usually letter O
- **"S" (letter) vs "5" (number)** - In words like "distance" it's letter S
- **"Z" (letter) vs "2" (number)** - Check context carefully
- **"B" (letter) vs "8" (number)** - In formulas, B is usually a coefficient variable

**VERIFICATION RULE FOR LETTERS VS NUMBERS:**
1. If it appears in a WORD or VARIABLE NAME → It's a LETTER (rate, time, velocity, rt, vt)
2. If it appears ALONE as a COEFFICIENT or VALUE → Check carefully (is "1t" really "1×t" or is it "lt"?)
3. **COMMON PHYSICS VARIABLES:** r (radius), t (time), v (velocity), a (acceleration), d (distance), h (height)
4. **If you see "rt" it means r × t (radius times time), NOT "11"!**
5. **If you see "vt" it means v × t (velocity times time), NOT two numbers!**

**CHARACTER-BY-CHARACTER ACCURACY CHECKLIST:**
✓ DECIMAL POINTS (.) - Tiny dots that change entire meaning! Look twice!
✓ NEGATIVE SIGNS (-) - Don't confuse with subtraction operators
✓ PLUS/MINUS SIGNS (+, -) - Are they there or missing?
✓ PARENTHESES ( ) - Opening and closing must match
✓ EQUALS SIGNS (=) - Where is the equation split?
✓ VARIABLES (x, d, a, b, c, t, h, etc.) - Correct letter?
✓ COEFFICIENTS (numbers before variables) - All digits present?
✓ EXPONENTS (², ³, ^2, ^3) - Is there a power?
✓ DIVISION SLASHES (/) - Fraction or division?
✓ COMMAS in large numbers (1,000) - Present or not?

1. **TRANSCRIBE EXACTLY character-by-character** from the image:
   - Look for fraction coefficients BEFORE parentheses: "1/8(3d - 2)" means multiply (3d-2) by the fraction 1/8
   - "1/4(d + 5)" means multiply (d+5) by the fraction 1/4
   - These are LINEAR equations, NOT fractions equal to expressions
   - The equation should have TWO sides separated by "=" - do NOT add extra terms!
   
2. **⚠️ COMMON OCR MISTAKES TO AVOID - CRITICALLY IMPORTANT:**
   - **MISSING DECIMAL POINTS** - The #1 OCR error! Always check: is it "3.14" or "314"?
   - **FRACTION COEFFICIENTS:** Look VERY carefully at fractions before parentheses
     * If you see "1/8(3d-2)", it's ONE-EIGHTH times (3d-2), NOT "12(3d-2)" or "12/8(3d-2)"
     * The numerator is the digit "1" (one), NOT "12" (twelve)
     * Common error: misreading the "1/" as "12" - VERIFY the numerator is a SINGLE digit
   - DO NOT misread "1/8" as "12/8", "18", "12", or add "12(d) +" - the numerator is ALWAYS "1" (one)
   - DO NOT misread "1/4" as "14", "12/4", or "1/14" - look for the slash carefully
   - DO NOT misread "+" as missing - "(d + 5)" must keep the plus sign
   - DO NOT add extra terms like "12(d) +" that don't exist in the image!
   - Fractions like 1/8, 1/4, 1/2, 1/3 are VERY common in homework - don't overcomplicate them!
   - **SPECIFIC EXAMPLE:** Image shows "1/8(3d-2)=1/4(d+5)" → Transcribe as EXACTLY that, NOT "12(3d-2)=1/4(d+5)"
   
3. **Common patterns you might see:**
   - "1/8(3d - 2) = 1/4(d + 5)" → This is LINEAR (no d² term), solve with basic algebra
   - "2/5h - 7 = 12/5h - 2h + 3" → This is LINEAR, collect like terms
   - "2(4r + 6) = 2/3(12r + 18)" → This is LINEAR, distribute and solve
   
4. **MANDATORY OCR VERIFICATION - Before solving, ALWAYS verify:**
   ✓ **DECIMAL POINTS:** Did I capture EVERY decimal point? (3.14 not 314, 0.5 not 5, 19.6 not 196)
   ✓ **ALL DIGITS:** Is it "3.14159" with 5 decimal places, or "3.14" with 2? Count carefully!
   ✓ **NEGATIVE SIGNS:** Is the number negative? (-5 not 5, -0.5 not 0.5)
   ✓ **FRACTION COEFFICIENTS:** Is "1/8" actually 1/8 or did you misread as 12/8?
   ✓ **PARENTHESES:** Are they in the right place and matched correctly?
   ✓ **OPERATORS:** Did you capture all +, -, ×, ÷ signs correctly?
   ✓ **EXPONENTS:** Is there a superscript? (x² not x, m/s² not m/s)
   ✓ **VARIABLES:** Correct letters? (d not b, h not n, x not y)
   
   **FINAL CHECK:** Read the entire problem aloud mentally, character by character, to catch any errors.
   
4. **SOLUTION METHOD SELECTION:**
   - If NO squared terms (d², x², etc.) → LINEAR equation → Use: multiply, distribute, collect terms, divide
   - If you see ax² + bx + c = 0 → QUADRATIC equation → Use: quadratic formula
   - NEVER use quadratic formula for linear equations!
   
5. **Write the EXACT transcription in "problem" field** for verification

💡 **STEP EXPLANATIONS - CONTEXTUAL LEARNING:**
**MANDATORY: Every step must include a concise "explanation" field that provides immediate learning context.**

**Purpose:** Help students understand WHY we're doing each step, not just WHAT we're doing.

**Guidelines:**
- **Length:** ONE concise sentence that captures the key insight or reasoning for this step
- **Tone:** Conversational and encouraging, like a tutor sitting beside the student
- **Focus:** Explain the PURPOSE or STRATEGY behind the step, not just repeat what's in the content

**Subject-Aware Verbosity:**
- **Math/Physics:** Keep explanations MINIMAL and focused on the mathematical operation
  - Example: "We're finding a common denominator so we can add these fractions together."
  - Example: "Isolating the variable on one side will help us find its value."
- **Essays/History/Science (non-quantitative):** Use MORE VERBOSE explanations that provide narrative context
  - Example: "This paragraph establishes your thesis by connecting the historical context to your main argument about social change."
  - Example: "Understanding the hormone's role helps explain how the plant responds to environmental stimuli."
- **Multiple Choice:** Brief reasoning about the elimination logic or why the correct answer fits
  - Example: "We can eliminate options A and B because they don't account for the energy lost to friction."

**What to Include:**
✓ The strategic reason for this step ("We need to eliminate the fraction to solve for x")
✓ The mathematical principle being applied ("Common denominators allow us to combine fractions")
✓ The connection to the problem goal ("This brings us closer to finding the vertex coordinates")

**What NOT to Include:**
✗ Repeating what's already in the title or content
✗ Generic statements like "This is an important step"
✗ Procedural instructions that are already shown in the content

**Examples:**

For Math Step:
- title: "Find a common denominator"
- content: "{2/3} + {1/4} = {8/12} + {3/12} = {11/12}"
- explanation: "Finding a common denominator of 12 allows us to add fractions by making the pieces the same size."

For Physics Step:
- title: "Apply Newton's Second Law"
- content: "F = ma, so [blue:15 N] = [blue:3 kg] × a → a = [red:5 m/s²]"
- explanation: "We're using the relationship between force, mass, and acceleration to find how quickly the object speeds up."

For Essay Step:
- title: "Develop Your Argument"
- content: "Build three body paragraphs exploring [blue:character development], [blue:thematic symbolism], and [blue:narrative structure]..."
- explanation: "Organizing your analysis into these three focused areas creates a clear, logical progression that strengthens your overall argument about the author's intent."

RESPONSE FORMAT (JSON):
{
  "problem": "Extracted problem text",
  "subject": "Math|Chemistry|Physics|Bible Studies|Language Arts|Geography|General",
  "difficulty": "K-5|6-8|9-12|College+",
  "steps": [
    {
      "id": "1",
      "title": "Clear action heading",
      "content": "Solution step with proper formatting",
      "explanation": "One concise sentence explaining WHY this step matters or WHAT strategy it employs"
    }
  ],
  "finalAnswer": "Final answer with KEY TERMS highlighted using [red:term] syntax for important concepts, formulas, or vocabulary (e.g., [red:phototropism], [red:auxin], [red:quadratic formula])",
  "visualAids": [
    {
      "type": "physics|geometry|graph|chart|illustration",
      "stepId": "1",
      "description": "Detailed description of what to visualize with all measurements and labels"
    }
  ]
}

**FINAL ANSWER HIGHLIGHTING - CRITICAL:**
- ALWAYS highlight key technical terms, concepts, or vocabulary in the final answer using [red:term]
- Examples: [red:phototropism], [red:auxin], [red:mitochondria], [red:Pythagorean theorem], [red:oxidation]
- For math: highlight the final numerical answer: [red:x = 5] or [red:{3/4}]
- For science: highlight phenomena, hormones, processes, chemical names
- For any subject: highlight the most important 2-3 terms that answer the core question
- **MULTIPLE CHOICE QUESTIONS:** If the question provides answer choices (A, B, C, D), ALWAYS include the correct letter in the final answer:
  - CORRECT: "[red:C) Mitochondrion]" or "[red:C)] [red:Mitochondrion]"
  - WRONG: "[red:Mitochondrion]" (missing the letter C)
  - The letter must be clearly visible so students know which option is correct
- **MULTI-PART ANSWERS:** If the question has multiple parts OR your answer has multiple numbered/lettered items, put each part on its own line:
  - CORRECT (letters): "a) [red:v = 15 m/s] \n b) [red:h = 11.5 m] \n c) [red:t = 3.1 s]"
  - CORRECT (numbers): "1. [blue:Patient Preparation]: ... \n 2. [blue:Ultrasound Guidance]: ... \n 3. [blue:Sterile Field]: ..."
  - WRONG: "a) v = 15 m/s, b) h = 11.5 m, c) t = 3.1 s" (all on one line)
  - WRONG: "1. Step one 2. Step two 3. Step three" (all on one line)

**CRITICAL: visualAids array is REQUIRED for:**
- Physics: projectile motion, force diagrams, circuits, kinematics
- Geometry: shapes, angles, spatial relationships
- Data: surveys, percentages, comparing quantities, proportions
- Biology/Chemistry: metabolic cycles (Krebs, Calvin, electron transport), cellular processes, multi-step reactions
- Leave empty [] ONLY if truly no visual would help

📊 INTELLIGENT VISUAL AIDS - WHEN AND WHAT TYPE TO CREATE 📊

**🚨 ESSENTIAL VISUALS - ALWAYS CREATE for these classic scenarios:**

**PHYSICS - NEARLY MANDATORY:**
✓ **PROJECTILE MOTION** - Any problem with objects launched at angles (catapults, projectiles, balls thrown)
   → Show parabolic trajectory, launch angle, velocity components, max height, range
   → Tag: [DIAGRAM NEEDED: type=physics - Projectile motion showing parabolic arc from launch point at [angle]° with initial velocity [v₀], marking maximum height at apex, horizontal range, and ground level. Label velocity components, trajectory path, and key measurements.]

✓ **FORCE DIAGRAMS** - Any problem analyzing forces on an object (friction, tension, normal force)
   → Show object with all force vectors (magnitude + direction), coordinate system
   → Tag: [DIAGRAM NEEDED: type=physics - Free body diagram of [object] with force vectors: [list all forces with magnitudes and directions]. Include coordinate axes.]

✓ **KINEMATICS** - Motion problems with acceleration, velocity, position over time
   → Show motion diagram with position/velocity/acceleration vectors at key moments
   → Tag: [DIAGRAM NEEDED: type=physics - Motion diagram showing [object] at key time points with velocity and acceleration vectors. Mark initial and final positions.]

✓ **CIRCUITS** - Any electrical circuit problem
   → Show circuit schematic with components, current flow, voltage labels
   → Tag: [DIAGRAM NEEDED: type=physics - Circuit diagram with [components] connected in [series/parallel], showing current direction and voltage labels.]

**GEOMETRY - NEARLY MANDATORY:**
✓ Any problem with shapes, angles, areas, perimeters
✓ Spatial relationships between multiple geometric objects
✓ 3D geometry or perspective views

**DATA VISUALIZATION - NEARLY MANDATORY:**
✓ **SURVEYS & PERCENTAGES** - Any problem asking about percentages, surveys, or preferences
   → **MUST CREATE** a pie chart or bar chart comparing categories
   → Examples triggering this: "survey of students", "percentage of...", "what fraction preferred", "poll results"
   → Tag: [DIAGRAM NEEDED: type=chart - Pie chart showing [category names] with percentages: [list each category with its percentage]. Use distinct colors for each segment and label with both category name and percentage.]
   → EXAMPLE: For "survey of 200 students: Math 60, Science 50, English 40, History 30, Art 20" → ADD: [DIAGRAM NEEDED: type=chart - Pie chart showing subject preferences: Math 30%, Science 25%, English 20%, History 15%, Art 10%. Use distinct colors for each segment with labels.]

✓ **COMPARING QUANTITIES** - Problems comparing multiple values, populations, or measurements
   → Show bar chart or comparison chart
   → Tag: [DIAGRAM NEEDED: type=chart - Bar chart comparing [categories] with values: [list values]. Include labeled axes and value labels on each bar.]

✓ **PROPORTIONS & RATIOS** - Problems involving parts of a whole
   → Show pie chart or stacked bar chart
   → Tag: [DIAGRAM NEEDED: type=chart - Visual representation showing proportions of [total] divided into [parts with values/percentages].]

**BIOLOGY & CHEMISTRY - NEARLY MANDATORY:**
✓ **METABOLIC CYCLES & PATHWAYS** - The Krebs cycle, citric acid cycle, Calvin cycle, electron transport chain
   → **MUST CREATE** a process illustration showing the cycle with inputs, outputs, and intermediate steps
   → Tag: [DIAGRAM NEEDED: type=illustration - [Cycle name] showing circular pathway with all intermediate compounds, enzymes (if mentioned), inputs (substrates entering), outputs (products leaving), and energy molecules (ATP, NADH, FADH₂, etc.). Label each step in sequence with arrows showing direction of flow.]
   → EXAMPLE: "Krebs cycle" → ADD: [DIAGRAM NEEDED: type=illustration - Krebs (citric acid) cycle showing circular pathway starting with Acetyl-CoA + Oxaloacetate forming Citrate, then proceeding through Isocitrate, α-Ketoglutarate, Succinyl-CoA, Succinate, Fumarate, Malate, and back to Oxaloacetate. Mark inputs (Acetyl-CoA), outputs (2 CO₂), and energy molecules produced (3 NADH, 1 FADH₂, 1 ATP/GTP) at appropriate steps. Use arrows to show cycle direction.]

✓ **CELLULAR PROCESSES** - Photosynthesis, cellular respiration, protein synthesis, DNA replication
   → Show multi-stage process with labeled inputs, outputs, and intermediate steps
   → Tag: [DIAGRAM NEEDED: type=illustration - [Process name] showing all stages, key molecules/structures involved, inputs, outputs, and energy flow. Label each major step.]

✓ **CHEMICAL REACTIONS & MECHANISMS** - Multi-step organic reactions, redox reactions, equilibrium systems
   → Show reaction pathway with structures, electron flow, intermediates
   → Tag: [DIAGRAM NEEDED: type=illustration - Reaction mechanism showing reactants, intermediates, and products with electron flow arrows and key conditions.]

**SCREENING CRITERIA - For other cases, create visuals when they SIGNIFICANTLY enhance understanding:**

Consider creating a visual aid when:
✓ The problem involves spatial relationships that are hard to describe in words alone
✓ Lower grade levels (K-5, 6-8) - visuals help younger students grasp concepts better
✓ Complex multi-step processes benefit from a visual roadmap
✓ The visual would clarify confusion, not just repeat what words already convey

**TYPES OF VISUALS:**

1. **GEOMETRIC DIAGRAMS** - For shapes, angles, spatial relationships
   - Tag: [DIAGRAM NEEDED: type=geometry - detailed description with ALL dimensions, labels, spatial relationships]

2. **GRAPHS & COORDINATE PLANES** - For plotting, functions, data visualization
   - Tag: [DIAGRAM NEEDED: type=graph - equation/function with axes, labels, key points]

3. **CHARTS & DATA VISUALIZATION** - For comparing quantities, showing proportions
   - Tag: [DIAGRAM NEEDED: type=chart - data values, labels, chart type (bar/pie/line)]

4. **PHYSICS DIAGRAMS** - For forces, motion, circuits, energy
   - Tag: [DIAGRAM NEEDED: type=physics - physical setup, forces/components, labels]

5. **PROCESS ILLUSTRATIONS** - For sequential steps or transformations
   - Tag: [DIAGRAM NEEDED: type=illustration - what's shown, key elements, relationships]

**WHEN NOT TO CREATE VISUALS:**
✗ Pure algebraic manipulation where symbols are clear enough
✗ Simple word problems without spatial/physical elements
✗ When the description in words is already perfectly clear

**PLACEMENT:** Visual aids can appear in ANY step where they'd be most helpful, not just Step 1. Place them where understanding would benefit most.

**FORMAT EXAMPLE:**
"[DIAGRAM NEEDED: type=geometry - Rectangle PQRS with horizontal base PQ = 6 units at bottom, vertical height PS on left side. Isosceles triangle OPQ with base PQ (6 units) on bottom edge of rectangle, vertex O above PQ, equal sides OP and OQ forming triangle inside rectangle. Label all corners P, Q, R, S clockwise, and point O at triangle apex.]"

**DECISION FRAMEWORK:**
Ask yourself: "Would a student understand this BETTER with a visual, or is it already clear?"
- If visual is essential for understanding → CREATE IT
- If visual would be nice but not necessary → SKIP IT
- If visual would just repeat what's already clear → SKIP IT

CRITICAL MATHEMATICAL FORMATTING RULES:

**FRACTIONS - ABSOLUTELY MANDATORY VERTICAL FORMAT:**
- ALWAYS use {num/den} for ALL fractions at ALL stages - NEVER use inline format like "a/b", (a/b), or decimals
- Simple fractions: {5/6}, {3/4}, {12/7}
- Complex fractions: {12/{3d - 1}}, {{-b ± √{b^2^ - 4ac}}/{2a}}, {{x + 5}/{x - 2}}
- ALWAYS simplify fractions before presenting: {12/8} -> {3/2}
- For improper fractions in FINAL ANSWER ONLY, show both reduced fraction AND mixed number: {7/3} = 2{1/3} or {17/5} = 3{2/5}
- NEVER convert to decimals at ANY step unless user explicitly requests decimal form
- Arithmetic with fractions stays as fractions: {2/3} + {1/4} = {8/12} + {3/12} = {11/12}
- **CRITICAL: When finding common denominators, EXPLICITLY STATE what the common denominator is and SHOW the conversion:**
  - GOOD: "Find a common denominator of [blue:5]: {12/5}h - 2h. Convert 2h to fifths: [blue:2h = {10/5}h]. This gives us: [blue:{12/5}h - {10/5}h] = [red:{2/5}h]"
  - BAD: "Simplify by finding a common denominator: {12/5}h - {10/5}h = {2/5}h" (doesn't explain what the denominator is or show conversion)

**COLOR HIGHLIGHTING - CLARITY FOR EVERY OPERATION:**
- [blue:term] = the specific value/variable/operation being applied in THIS step
- [red:result] = the outcome or simplified result
- Use highlighting to show EXACTLY what changes: "Multiply by [blue:5]: 3x = 15 -> [blue:5] × 3x = [blue:5] × 15 -> 15x = [red:75]"
- When substituting: "Substitute [blue:d = 1]: {12/{3([blue:1]) - 1}} = {12/[red:2]} = [red:6]"
- Multiple operations: use blue for operation, red for result, keep unhighlighted text as context

**ALGEBRAIC EQUATIONS - SHOW EVERY TRANSFORMATION:**
- Always use vertical fractions: {12/{3d - 1}} = d + 5
- Show progression with arrows: equation_before -> equation_after
- Quadratic formula MUST be: x = {{-b ± √{b^2^ - 4ac}}/{2a}} with full braces on numerator
- Example substitution: a=[blue:3], b=[blue:14], c=[blue:-17]
  x = {{-[blue:14] ± √{[blue:14]^2^ - 4([blue:3])([blue:-17])}}/{2([blue:3])}}
  x = {{-14 ± √{196 + 204}}/{6}}
  x = {{-14 ± √400}/{6}}
  x = {{-14 ± 20}/{6}}
  Two solutions: x = {{-14 + 20}/{6}} = {6/6} = [red:1] OR x = {{-14 - 20}/{6}} = {-34/6} = {-17/3} = [red:-5{2/3}]

**SQUARE ROOTS, EXPONENTS, AND SPECIAL SYMBOLS:**
- Square roots: √16 = 4, √{25} = 5, √{b^2^ - 4ac}
- Exponents: x^2^, 3^4^ = 81, (2x)^3^ = 8x^3^
- Plus-minus: ±
- Nested: √{x^2^ + y^2^}

**STEP CLARITY - EACH STEP TELLS A STORY:**
- Title: Concise action verb phrase ("Multiply both sides by (3d - 1)", "Apply quadratic formula", "Simplify the fraction")
- Content: Show WHAT you're doing, WHY, and the RESULT
- Before and after: Show equation before operation, highlight what changes, show result
- Example full step:
  Title: "Clear the fraction by multiplying both sides"
  Content: "Multiply both sides by [blue:(3d - 1)] to eliminate the fraction:
  [blue:(3d - 1)] × {12/{3d - 1}} = [blue:(3d - 1)] × (d + 5)
  -> 12 = [red:(d + 5)(3d - 1)]"

**COMPLETE WORKED EXAMPLE - SOLVING {12/{3d - 1}} = d + 5:**

Step 1 Title: "Rewrite as a fraction equation"
Content: "{12/{3d - 1}} = d + 5"

Step 2 Title: "Clear the fraction by multiplying both sides"
Content: "Multiply both sides by [blue:(3d - 1)]:
[blue:(3d - 1)] × {12/{3d - 1}} = [blue:(3d - 1)] × (d + 5)
-> 12 = [red:(d + 5)(3d - 1)]"

Step 3 Title: "Expand the right side"
Content: "Expand [blue:(d + 5)(3d - 1)]:
12 = d([blue:3d]) + d([blue:-1]) + 5([blue:3d]) + 5([blue:-1])
12 = 3d^2^ - d + 15d - 5
-> 12 = [red:3d^2^ + 14d - 5]"

Step 4 Title: "Set to standard quadratic form"
Content: "Subtract [blue:12] from both sides:
12 [blue:- 12] = 3d^2^ + 14d - 5 [blue:- 12]
-> 0 = [red:3d^2^ + 14d - 17]"

Step 5 Title: "Apply the quadratic formula"
Content: "For 3d^2^ + 14d - 17 = 0, use d = {{-b ± √{b^2^ - 4ac}}/{2a}}
where a=[blue:3], b=[blue:14], c=[blue:-17]

Discriminant: Δ = [blue:14]^2^ - 4([blue:3])([blue:-17]) = 196 + 204 = [red:400]

d = {{-14 ± √400}/{6}} = {{-14 ± 20}/{6}}

Two solutions:
d = {{-14 + 20}/{6}} = {6/6} = [red:1]
d = {{-14 - 20}/{6}} = {-34/6} = {-17/3} = [red:-5{2/3}]"

**CHEMISTRY/PHYSICS:**
- Subscripts: H_2_O, v_0_, x_n_
- Superscripts: Ca^2+^, x^3^
- Units: 5 m/s^2^, 3.2 × 10^-5^ mol

Grade-appropriate language based on difficulty level.`;
          }
          
          // Make OpenAI API call with constructed system message and image
          const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content: systemMessage
              },
              {
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: {
                      url: imageUri,
                      detail: "high"
                    }
                  }
                ]
              }
            ],
            response_format: { type: "json_object" },
            max_tokens: 8192,
          });
          
          const content = response.choices[0]?.message?.content || "{}";
          const parsed = JSON.parse(content);
          return parsed;
        } catch (error: any) {
          console.error('OpenAI API error:', error);
          if (isRateLimitError(error)) {
            throw error;
          }
          throw new AbortError(error);
        }
      },
      {
        retries: 7,
        minTimeout: 2000,
        maxTimeout: 128000,
        factor: 2,
      }
    );
    
    // Log AI response for debugging
    console.log('=== AI RESPONSE DEBUG ===');
    console.log('Problem:', result.problem);
    console.log('Subject:', result.subject);
    console.log('Difficulty:', result.difficulty);
    console.log('Steps count:', result.steps?.length);
    if (result.steps && result.steps.length > 0) {
      result.steps.forEach((step: any, i: number) => {
        console.log(`\n========== STEP ${i + 1} ==========`);
        console.log(`Title: ${step.title}`);
        console.log(`Full Content:`);
        console.log(step.content);
        console.log(`==================================`);
      });
    }
    console.log('========================\n');
    
    // 🧬 BIOLOGY/CHEMISTRY KEYWORD DETECTION: Ensure visual aids for metabolic cycles
    result = ensureBiologyVisualAids(result.problem || '', result);
    
    // ⚡ ASYNC DIAGRAM GENERATION: Generate unique solution ID
    const solutionId = crypto.randomBytes(16).toString('hex');
    const diagrams: DiagramStatus[] = [];
    
    // Collect all diagram requirements from visualAids array
    if (result.visualAids && Array.isArray(result.visualAids)) {
      for (const visualAid of result.visualAids) {
        const { type, stepId, description } = visualAid;
        diagrams.push({
          stepId,
          type,
          description,
          status: 'pending'
        });
      }
    }
    
    // Legacy support: Check for old-style [DIAGRAM NEEDED: ...] tags
    for (const step of result.steps) {
      if (step.content) {
        const diagramMatch = step.content.match(/\[DIAGRAM NEEDED:\s*([^\]]+)\]/);
        if (diagramMatch) {
          diagrams.push({
            stepId: step.id,
            type: 'legacy',
            description: diagramMatch[1],
            status: 'pending'
          });
        }
      }
    }
    
    // Initialize diagram store for this solution
    if (diagrams.length > 0) {
      solutionDiagramStore.set(solutionId, {
        diagrams,
        timestamp: Date.now(),
        complete: false
      });
      console.log(`📊 Initialized ${diagrams.length} pending diagrams for solution ${solutionId}`);
    }
    
    // CLEANUP: Remove all [DIAGRAM NEEDED] tags - diagrams will load asynchronously
    for (const step of result.steps) {
      if (step.content) {
        let content = step.content;
        
        while (true) {
          const startIndex = content.indexOf('[DIAGRAM NEEDED:');
          if (startIndex === -1) break;
          
          let depth = 1;
          let endIndex = startIndex + '[DIAGRAM NEEDED:'.length;
          
          while (depth > 0 && endIndex < content.length) {
            if (content[endIndex] === '[') depth++;
            else if (content[endIndex] === ']') depth--;
            endIndex++;
          }
          
          content = content.substring(0, startIndex) + content.substring(endIndex);
        }
        
        step.content = content;
      }
    }
    
    // ENFORCE PROPER FORMATTING - Convert all fractions to {num/den} format
    const formattedResult = enforceResponseFormatting(result);
    
    // Add solutionId to response for diagram polling
    const responseWithId = {
      ...formattedResult,
      solutionId: diagrams.length > 0 ? solutionId : undefined
    };
    
    // ⚡ RETURN IMMEDIATELY - No waiting for diagrams!
    console.log(`✅ Analysis complete - returning solution ${solutionId} immediately (<8s target)`);
    res.json(responseWithId);
    
    // ⚡ BACKGROUND TASKS: Validation and diagram generation (non-blocking)
    void validateSolution(result.problem || 'Image-based question', formattedResult)
      .then(({ validationPassed, validationDetails }) => {
        if (!validationPassed) {
          console.warn('⚠️ Background validation failed:', validationDetails);
        } else {
          console.log('✅ Background validation passed');
        }
      })
      .catch(err => {
        console.error('⚠️ Background validation error (non-blocking):', err);
      });
    
    // Generate diagrams in background if any exist
    if (diagrams.length > 0) {
      const hostname = req.get('host');
      void generateDiagramsInBackground(solutionId, diagrams, result.steps, hostname);
    }
  } catch (error: any) {
    console.error('❌ Error analyzing image:', error);
    console.error('Error details:', {
      name: error?.name,
      message: error?.message,
      code: error?.code,
      status: error?.status
    });
    
    // Provide specific error messages for common issues
    let userMessage = 'Failed to analyze image';
    let statusCode = 500;
    
    // Check for missing API keys
    if (error?.message?.includes('API key') || error?.code === 'invalid_api_key') {
      userMessage = 'API configuration error. Please check deployment settings.';
      statusCode = 503;
      console.error('🔑 API key issue detected - check GOOGLE_CLOUD_VISION_API_KEY and OpenAI credentials');
    }
    // Check for rate limiting
    else if (error?.status === 429 || error?.message?.includes('rate limit')) {
      userMessage = 'Service temporarily unavailable due to rate limits. Please try again in a moment.';
      statusCode = 429;
    }
    // Check for timeout
    else if (error?.message?.includes('timeout') || error?.code === 'ETIMEDOUT') {
      userMessage = 'Request timed out. Please try again.';
      statusCode = 504;
    }
    // Check for invalid image
    else if (error?.message?.includes('image') && error?.message?.includes('invalid')) {
      userMessage = 'Invalid image format. Please try a different image.';
      statusCode = 400;
    }
    
    res.status(statusCode).json({ 
      error: userMessage,
      details: process.env.NODE_ENV === 'development' ? error?.message : undefined
    });
  }
});

// Polling endpoint for diagram status
app.get('/api/diagrams/:solutionId', async (req, res) => {
  try {
    const { solutionId } = req.params;
    
    const solutionData = solutionDiagramStore.get(solutionId);
    
    if (!solutionData) {
      return res.status(404).json({ error: 'Solution not found' });
    }
    
    res.json({
      diagrams: solutionData.diagrams,
      complete: solutionData.complete
    });
  } catch (error) {
    console.error('Error fetching diagrams:', error);
    res.status(500).json({ error: 'Failed to fetch diagrams' });
  }
});

app.post('/api/simplify-explanation', async (req, res) => {
  try {
    const { problem, subject, difficulty, steps } = req.body;
    console.log('Generating simplified explanations for', steps.length, 'steps');
    
    const result = await pRetry(
      async () => {
        try {
          const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content: `You are an exceptional teacher helping a struggling student understand a problem. The student has seen the solution steps but still doesn't get it. Your job is to provide a MUCH SIMPLER, more intuitive explanation for each step.

Guidelines:
- Use everyday language and analogies
- Break down WHY we're doing each operation, not just WHAT we're doing
- Use relatable examples when possible
- Keep each explanation to 2-3 short sentences maximum
- Preserve math formatting: {num/den} for fractions, _subscript_, ^superscript^, [color:text] for highlighting
- Focus on the INTUITION and REASONING behind each step

Problem: ${problem}
Subject: ${subject}
Difficulty Level: ${difficulty}

For each step provided, return a simplified explanation that helps the student understand the underlying logic and reasoning.

IMPORTANT: Return ONLY a valid JSON array with this exact structure:
[
  {
    "stepNumber": 1,
    "simplifiedExplanation": "Plain language explanation here"
  },
  {
    "stepNumber": 2,
    "simplifiedExplanation": "Plain language explanation here"
  }
]

Do NOT include any text before or after the JSON array.`
              },
              {
                role: "user",
                content: `Here are the solution steps that need simplified explanations:

${steps.map((step: any, index: number) => `Step ${index + 1}: ${step.title}
${step.content}`).join('\n\n')}

Please provide a simplified, intuitive explanation for each step.`
              }
            ],
            max_tokens: 2000,
          });
          
          const content = response.choices[0]?.message?.content || '[]';
          
          // Parse JSON response
          try {
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
              throw new Error('No JSON array found in response');
            }
            const parsed = JSON.parse(jsonMatch[0]);
            return parsed;
          } catch (parseError: any) {
            console.error('Failed to parse simplified explanations:', content);
            throw new AbortError(parseError);
          }
        } catch (error: any) {
          console.error('OpenAI API error:', error);
          if (isRateLimitError(error)) {
            throw error;
          }
          throw new AbortError(error);
        }
      },
      {
        retries: 7,
        minTimeout: 2000,
        maxTimeout: 128000,
        factor: 2,
      }
    );
    
    // ENFORCE PROPER FORMATTING on each explanation
    const formattedExplanations = result.map((item: any) => ({
      ...item,
      simplifiedExplanation: enforceProperFormatting(item.simplifiedExplanation)
    }));
    
    console.log('Simplified explanations generated');
    res.json({ simplifiedExplanations: formattedExplanations });
  } catch (error) {
    console.error('Error generating simplified explanations:', error);
    res.status(500).json({ error: 'Failed to generate simplified explanations' });
  }
});

app.post('/api/ask-question', async (req, res) => {
  try {
    const { question, context } = req.body;
    console.log('Answering follow-up question');
    
    const result = await pRetry(
      async () => {
        try {
          const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content: `You are a helpful tutor answering follow-up questions. Be concise (2-4 sentences), use plain language, but preserve mathematical notation using the same formatting: {num/den} for fractions, _subscript_, ^superscript^, [color:text] for highlighting.

Context:
Problem: ${context.problem}
Solution: ${context.solution}`
              },
              {
                role: "user",
                content: question
              }
            ],
            max_tokens: 500,
          });
          
          return response.choices[0]?.message?.content || "I'm sorry, I couldn't answer that question.";
        } catch (error: any) {
          console.error('OpenAI API error:', error);
          if (isRateLimitError(error)) {
            throw error;
          }
          throw new AbortError(error);
        }
      },
      {
        retries: 7,
        minTimeout: 2000,
        maxTimeout: 128000,
        factor: 2,
      }
    );
    
    // ENFORCE PROPER FORMATTING on the answer text
    const formattedAnswer = enforceProperFormatting(result);
    
    console.log('Follow-up question answered');
    res.json({ answer: formattedAnswer });
  } catch (error) {
    console.error('Error answering question:', error);
    res.status(500).json({ error: 'Failed to answer question' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'API server is running' });
});

// Smart environment detection: serve static files if dist/ exists, otherwise proxy to dev server
const distPath = path.join(process.cwd(), 'dist');
const hasDistBuild = fs.existsSync(distPath) && fs.existsSync(path.join(distPath, 'index.html'));
const isProduction = process.env.NODE_ENV === 'production' || hasDistBuild;

if (isProduction && hasDistBuild) {
  // Serve the built Expo web app from dist/
  console.log(`📦 Production mode: Serving static files from ${distPath}`);
  app.use(express.static(distPath));
  
  // Serve index.html for all non-API, non-static routes (SPA routing)
  app.use((req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else if (isProduction && !hasDistBuild) {
  // Production mode but no build files - return helpful error
  console.error(`❌ Production mode but dist/ directory not found at ${distPath}`);
  app.use((req, res) => {
    res.status(500).json({ 
      error: 'Frontend build not found',
      message: 'The dist/ directory is missing. Run: npx expo export --platform web',
      mode: 'production',
      NODE_ENV: process.env.NODE_ENV
    });
  });
} else {
  // Development mode: proxy to Expo dev server
  console.log(`🔧 Development mode: Proxying to Expo dev server on port 8081`);
  app.use('/', createProxyMiddleware({
    target: 'http://localhost:8081',
    changeOrigin: false,
    ws: true,
    on: {
      proxyReq: (proxyReq: any, req: any) => {
        if (req.headers.origin) {
          proxyReq.setHeader('origin', req.headers.origin);
        }
      }
    }
  }));
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Proxy server with API running on port ${PORT}`);
  console.log(`   API endpoints available at /api/*`);
  console.log(`   Frontend proxied from port 8081`);
});

// Increase server timeout to 5 minutes for long-running AI requests (diagram generation, validation, etc.)
server.timeout = 300000; // 5 minutes in milliseconds
server.keepAliveTimeout = 310000; // Slightly higher than timeout
server.headersTimeout = 320000; // Slightly higher than keepAliveTimeout
console.log(`⏱️  Server timeout set to ${server.timeout/1000} seconds`);
