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
import { Mistral } from '@mistralai/mistralai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import pRetry, { AbortError } from 'p-retry';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parseMathContent } from '../src/utils/mathParser';

const app = express();
const PORT = 5000;

// Resolve OpenAI configuration with backwards compatibility for legacy env vars
const openaiApiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
const openaiBaseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL;

// Resolve Mistral configuration
const mistralApiKey = process.env.MISTRAL_API_KEY;

// Resolve Gemini configuration
const geminiApiKey = process.env.GEMINI_API_KEY;

// Resolve WolframAlpha configuration
const wolframAlphaAppId = process.env.WOLFRAM_ALPHA_APP_ID;

if (!openaiApiKey) {
  console.warn('⚠️ OpenAI API key not configured. Set AI_INTEGRATIONS_OPENAI_API_KEY or OPENAI_API_KEY.');
}

if (!mistralApiKey) {
  console.warn('⚠️ Mistral API key not configured. Hybrid OCR will fall back to OpenAI only.');
}

if (!geminiApiKey) {
  console.warn('⚠️ Gemini API key not configured. Backup verification will be unavailable.');
}

if (!wolframAlphaAppId) {
  console.warn('⚠️ WolframAlpha App ID not configured. Math verification will be unavailable.');
}

// CRITICAL: Health check endpoint FIRST - must respond immediately for deployment health checks
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// API configuration diagnostic endpoint - shows what's available without exposing keys
app.get('/api/config-check', (req, res) => {
  const openaiConfigured = !!openaiApiKey;
  const mistralConfigured = !!mistralApiKey;

  res.json({
    environment: process.env.REPLIT_DEPLOYMENT === '1' ? 'production' : 'development',
    apis: {
      openai: openaiConfigured
        ? 'configured ✅'
        : 'missing ❌ (set AI_INTEGRATIONS_OPENAI_API_KEY or OPENAI_API_KEY)',
      mistral: mistralConfigured
        ? 'configured ✅'
        : 'missing ❌ (set MISTRAL_API_KEY)'
    },
    ocrMode: mistralConfigured && openaiConfigured
      ? 'Hybrid OCR (Mistral for STEM + OpenAI for general)'
      : openaiConfigured
      ? 'OpenAI GPT-4o Vision only'
      : 'No OCR configured',
    message: mistralConfigured && openaiConfigured
      ? 'STEM questions use Mistral OCR (94% math accuracy), general questions use OpenAI'
      : openaiConfigured
      ? 'Using OpenAI GPT-4o Vision for all image analysis'
      : 'Please configure API keys'
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
  apiKey: openaiApiKey,
  baseURL: openaiBaseURL || undefined,
});

// Initialize Mistral client for superior STEM OCR
const mistral = mistralApiKey ? new Mistral({ apiKey: mistralApiKey }) : null;

// Initialize Gemini client for backup verification
const geminiAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;

// Gemini usage tracking (200 calls/month limit)
const GEMINI_USAGE_FILE = path.join(process.cwd(), 'data', 'gemini-usage.json');
const GEMINI_MONTHLY_LIMIT = 200;

// WolframAlpha usage tracking (2000 calls/month limit)
const WOLFRAM_USAGE_FILE = path.join(process.cwd(), 'data', 'wolfram-usage.json');
const WOLFRAM_MONTHLY_LIMIT = 2000;

interface UsageTracking {
  monthKey: string;
  count: number;
}

const geminiLock = { locked: false, queue: [] as Array<() => void> };
const wolframLock = { locked: false, queue: [] as Array<() => void> };

async function withLock<T>(lock: { locked: boolean, queue: Array<() => void> }, fn: () => Promise<T>): Promise<T> {
  while (lock.locked) {
    await new Promise<void>(resolve => lock.queue.push(resolve));
  }
  
  lock.locked = true;
  try {
    return await fn();
  } finally {
    lock.locked = false;
    const next = lock.queue.shift();
    if (next) next();
  }
}

async function getUsage(file: string): Promise<UsageTracking> {
  try {
    const data = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return { monthKey: '', count: 0 };
  }
}

async function incrementGeminiUsage(): Promise<boolean> {
  return withLock(geminiLock, async () => {
    const currentMonthKey = new Date().toISOString().substring(0, 7);
    const usage = await getUsage(GEMINI_USAGE_FILE);
    
    if (usage.monthKey !== currentMonthKey) {
      usage.monthKey = currentMonthKey;
      usage.count = 0;
    }
    
    if (usage.count >= GEMINI_MONTHLY_LIMIT) {
      console.warn(`⚠️ Gemini monthly limit reached (${usage.count}/${GEMINI_MONTHLY_LIMIT})`);
      return false;
    }
    
    usage.count++;
    await fs.promises.writeFile(GEMINI_USAGE_FILE, JSON.stringify(usage, null, 2));
    console.log(`📊 Gemini usage: ${usage.count}/${GEMINI_MONTHLY_LIMIT} this month`);
    return true;
  });
}

async function incrementWolframUsage(): Promise<boolean> {
  return withLock(wolframLock, async () => {
    const currentMonthKey = new Date().toISOString().substring(0, 7);
    const usage = await getUsage(WOLFRAM_USAGE_FILE);
    
    if (usage.monthKey !== currentMonthKey) {
      usage.monthKey = currentMonthKey;
      usage.count = 0;
    }
    
    if (usage.count >= WOLFRAM_MONTHLY_LIMIT) {
      console.warn(`⚠️ WolframAlpha monthly limit reached (${usage.count}/${WOLFRAM_MONTHLY_LIMIT})`);
      return false;
    }
    
    usage.count++;
    await fs.promises.writeFile(WOLFRAM_USAGE_FILE, JSON.stringify(usage, null, 2));
    console.log(`📊 WolframAlpha usage: ${usage.count}/${WOLFRAM_MONTHLY_LIMIT} this month`);
    return true;
  });
}

// In-memory verification store
interface VerificationResult {
  status: 'pending' | 'verified' | 'unverified';
  confidence: number;
  warnings: string[];
  timestamp: number;
}

const verificationStore = new Map<string, VerificationResult>();

// Math eligibility classifier - determines if a problem is suitable for WolframAlpha
function isMathEligible(question: string, subject: string): boolean {
  const mathSubjects = ['mathematics', 'math', 'algebra', 'geometry', 'calculus', 
                        'trigonometry', 'statistics', 'physics', 'chemistry'];
  
  const mathKeywords = [
    'solve', 'calculate', 'find', 'simplify', 'evaluate', 'compute',
    'equation', 'integral', 'derivative', 'limit', 'matrix',
    'factor', 'expand', 'differentiate', 'integrate'
  ];
  
  const nonMathKeywords = ['explain', 'describe', 'essay', 'write', 'discuss', 'analyze'];
  
  // Check if subject is math-related
  const isMathSubject = mathSubjects.some(s => subject.toLowerCase().includes(s));
  
  // Check for math keywords in question
  const hasMathKeywords = mathKeywords.some(kw => 
    question.toLowerCase().includes(kw)
  );
  
  // Check for non-math keywords (essay questions, etc.)
  const hasNonMathKeywords = nonMathKeywords.some(kw => 
    question.toLowerCase().includes(kw)
  );
  
  return (isMathSubject || hasMathKeywords) && !hasNonMathKeywords;
}

// Extract answer parts from multi-part solution
function extractAnswerParts(finalAnswer: string, steps: any[]): Map<string, string> {
  const parts = new Map<string, string>();
  
  // Try to extract labeled parts: (a), (b), (c), etc.
  // More robust regex that handles nested parentheses
  const lines = finalAnswer.split('\n');
  let currentPart: string | null = null;
  let currentValue: string[] = [];
  
  for (const line of lines) {
    const partMatch = line.match(/^\s*\(([a-z])\)[:\s]*/i);
    if (partMatch) {
      // Save previous part if exists
      if (currentPart && currentValue.length > 0) {
        parts.set(currentPart, currentValue.join(' ').trim());
      }
      // Start new part
      currentPart = partMatch[1].toLowerCase();
      currentValue = [line.replace(/^\s*\([a-z]\)[:\s]*/i, '')];
    } else if (currentPart && line.trim()) {
      // Continue current part
      currentValue.push(line.trim());
    }
  }
  
  // Save last part
  if (currentPart && currentValue.length > 0) {
    parts.set(currentPart, currentValue.join(' ').trim());
  }
  
  // If no parts found in finalAnswer, check steps
  if (parts.size === 0) {
    steps.forEach(step => {
      const stepMatch = step.title.match(/\(([a-z])\)/i);
      if (stepMatch) {
        const label = stepMatch[1].toLowerCase();
        // Extract answer from step content - look for equals sign
        const content = step.content;
        const answerMatch = content.match(/=\s*(.+?)(?:\n|$)/);
        if (answerMatch) {
          parts.set(label, answerMatch[1].trim());
        } else {
          // If no equals, use last sentence
          const lastSentence = content.split(/[.!?]/).filter((s: string) => s.trim()).pop();
          if (lastSentence) {
            parts.set(label, lastSentence.trim());
          }
        }
      }
    });
  }
  
  return parts;
}

// Helper function to parse fractions and numbers
function parseNumericValue(str: string): number | null {
  // Remove common formatting
  const cleaned = str.replace(/[,_\s]/g, '');
  
  // Remove any units (letters, compound units like m/s, m^2, etc.)
  // Match the numeric part at the beginning, before any letters or unit symbols
  const numericPart = cleaned.match(/^([-+]?\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)/);
  if (!numericPart) {
    return null;
  }
  
  const numStr = numericPart[1];
  
  // Try fraction first (e.g., "1/2", "3/4")
  const fractionMatch = numStr.match(/^([-+]?\d+(?:\.\d+)?)\/([-+]?\d+(?:\.\d+)?)$/);
  if (fractionMatch) {
    const numerator = parseFloat(fractionMatch[1]);
    const denominator = parseFloat(fractionMatch[2]);
    if (denominator !== 0) {
      return numerator / denominator;
    }
  }
  
  // Try regular number
  const num = parseFloat(numStr);
  return isNaN(num) ? null : num;
}

// WolframAlpha verification - uses computational engine for ground truth
async function wolframAlphaVerification(
  originalQuestion: string,
  proposedSolution: any
): Promise<ValidationResult> {
  if (!wolframAlphaAppId) {
    console.warn('⚠️ WolframAlpha App ID not configured');
    return {
      isValid: true,
      errors: [],
      warnings: ['WolframAlpha not configured'],
      confidence: 50
    };
  }
  
  try {
    console.log('🧮 Running WolframAlpha verification...');
    
    // Check rate limit
    const canUse = await incrementWolframUsage();
    if (!canUse) {
      return {
        isValid: true,
        errors: [],
        warnings: ['WolframAlpha monthly limit reached'],
        confidence: 50
      };
    }
    
    // Extract parts from the solution
    const answerParts = extractAnswerParts(proposedSolution.finalAnswer, proposedSolution.steps);
    
    // If multi-part, verify each part separately
    if (answerParts.size > 0) {
      console.log(`📝 Multi-part problem detected (${answerParts.size} parts)`);
      const errors: string[] = [];
      let verifiedParts = 0;
      let inconclusiveParts = 0;
      
      for (const [label, proposedAnswer] of answerParts.entries()) {
        // Extract the sub-question for this part - use more robust extraction
        const questionLines = originalQuestion.split('\n');
        let subQuestion = '';
        
        for (let i = 0; i < questionLines.length; i++) {
          if (questionLines[i].match(new RegExp(`\\(${label}\\)`, 'i'))) {
            // Found the part, take this line and potentially the next line if continuation
            subQuestion = questionLines[i].replace(/^\s*\([a-z]\)[:\s]*/i, '').trim();
            if (i + 1 < questionLines.length && !questionLines[i + 1].match(/^\s*\([a-z]\)/)) {
              subQuestion += ' ' + questionLines[i + 1].trim();
            }
            break;
          }
        }
        
        if (!subQuestion) {
          console.warn(`  ⚠️ Part (${label}): Could not extract sub-question`);
          inconclusiveParts++;
          continue;
        }
        
        try {
          const wolframUrl = `http://api.wolframalpha.com/v1/result?appid=${encodeURIComponent(wolframAlphaAppId)}&i=${encodeURIComponent(subQuestion)}`;
          const response = await fetch(wolframUrl, { 
            method: 'GET',
            headers: { 'User-Agent': 'HomeworkHelper/1.0' },
            signal: AbortSignal.timeout(10000) // 10 second timeout
          });
          
          if (response.ok) {
            const wolframAnswer = await response.text();
            console.log(`  Part (${label}): Proposed="${proposedAnswer}" | Wolfram="${wolframAnswer}"`);
            
            // Normalize and compare answers - be conservative to avoid false positives/negatives
            const normalizedProposed = proposedAnswer.toLowerCase()
              .replace(/\s+/g, '')
              .replace(/[,_]/g, '')
              .replace(/meters?/g, 'm')
              .replace(/seconds?/g, 's');
            
            const normalizedWolfram = wolframAnswer.toLowerCase()
              .replace(/\s+/g, '')
              .replace(/[,_]/g, '')
              .replace(/meters?/g, 'm')
              .replace(/seconds?/g, 's');
            
            // Check for exact match first (most reliable)
            if (normalizedProposed === normalizedWolfram) {
              verifiedParts++;
              console.log(`  ✓ Part (${label}) exact match`);
            }
            // Check if Wolfram answer is fully contained in student answer (student might have extra explanation)
            else if (normalizedProposed.includes(normalizedWolfram) && normalizedWolfram.length >= 2) {
              // Only accept containment if Wolfram answer is substantial (not just "2")
              const isSubstantial = normalizedWolfram.length >= 3 || normalizedWolfram.match(/[=<>≤≥]/);
              if (isSubstantial) {
                verifiedParts++;
                console.log(`  ✓ Part (${label}) contains Wolfram answer`);
              } else {
                // Too short, could be false positive - mark inconclusive
                console.warn(`  ? Part (${label}) match uncertain (Wolfram answer too short: "${wolframAnswer}")`);
                inconclusiveParts++;
              }
            }
            // Check numeric equivalence for decimal/fraction conversions
            else {
              const proposedNum = parseNumericValue(normalizedProposed);
              const wolframNum = parseNumericValue(normalizedWolfram);
              
              if (proposedNum !== null && wolframNum !== null) {
                if (Math.abs(proposedNum - wolframNum) < 0.0001) {
                  verifiedParts++;
                  console.log(`  ✓ Part (${label}) numerically equivalent (${proposedNum} ≈ ${wolframNum})`);
                } else {
                  // Definite numeric mismatch
                  errors.push(`Part (${label}): WolframAlpha got ${wolframNum} but solution shows ${proposedNum}`);
                  console.log(`  ✗ Part (${label}) WRONG - numeric mismatch (${wolframNum} vs ${proposedNum})`);
                }
              } else {
                // Can't parse as numbers - could be symbolic or formatting difference
                console.warn(`  ? Part (${label}) uncertain - not numeric or format differs`);
                inconclusiveParts++;
              }
            }
          } else {
            console.warn(`  ⚠️ Part (${label}): WolframAlpha returned ${response.status} - inconclusive`);
            inconclusiveParts++;
          }
        } catch (partError) {
          console.warn(`  ⚠️ Part (${label}) verification failed:`, partError);
          inconclusiveParts++;
        }
      }
      
      const totalProcessed = verifiedParts + errors.length;
      const allVerified = verifiedParts === answerParts.size && errors.length === 0;
      
      // If ANY errors were found, return unverified regardless of processable percentage
      if (errors.length > 0) {
        const confidence = answerParts.size > 0 ? Math.round((errors.length / answerParts.size) * 20) : 20;
        console.log(`📊 WolframAlpha found ${errors.length} error(s) - marking as UNVERIFIED`);
        return {
          isValid: false,
          errors,
          warnings: inconclusiveParts > 0 ? [`${inconclusiveParts} additional parts could not be verified`] : [],
          confidence
        };
      }
      
      // If inconclusive parts exist, cannot confidently verify - return as inconclusive to trigger AI fallback
      if (inconclusiveParts > 0 || verifiedParts < answerParts.size) {
        console.log(`📊 WolframAlpha inconclusive: ${verifiedParts}/${answerParts.size} verified, ${inconclusiveParts} inconclusive - triggering AI fallback`);
        return {
          isValid: true, // Mark as true so it doesn't fail, but low confidence triggers AI verification
          errors: [],
          warnings: [`WolframAlpha verified ${verifiedParts}/${answerParts.size} parts, ${inconclusiveParts} inconclusive - needs AI verification`],
          confidence: 30 // Low confidence forces fallback to AI verification
        };
      }
      
      // All parts verified!
      const confidence = 95;
      console.log(`📊 WolframAlpha verification: ALL ${verifiedParts}/${answerParts.size} parts verified!`);
      
      return {
        isValid: true,
        errors: [],
        warnings: [],
        confidence
      };
    }
    
    // Single-answer problem - verify the whole answer
    try {
      const wolframUrl = `http://api.wolframalpha.com/v1/result?appid=${encodeURIComponent(wolframAlphaAppId)}&i=${encodeURIComponent(originalQuestion)}`;
      const response = await fetch(wolframUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'HomeworkHelper/1.0' }
      });
      
      if (!response.ok) {
        console.warn(`⚠️ WolframAlpha API returned ${response.status}`);
        return {
          isValid: true,
          errors: [],
          warnings: ['WolframAlpha could not solve this problem'],
          confidence: 50
        };
      }
      
      const wolframAnswer = await response.text();
      console.log(`🧮 Wolfram answer: "${wolframAnswer}"`);
      console.log(`📝 Proposed answer: "${proposedSolution.finalAnswer}"`);
      
      // Normalize both answers for comparison - be conservative
      const normalizedProposed = proposedSolution.finalAnswer.toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[,_]/g, '')
        .replace(/meters?/g, 'm')
        .replace(/seconds?/g, 's');
      
      const normalizedWolfram = wolframAnswer.toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[,_]/g, '')
        .replace(/meters?/g, 'm')
        .replace(/seconds?/g, 's');
      
      // Check for exact match first
      if (normalizedProposed === normalizedWolfram) {
        console.log(`✅ WolframAlpha verification: EXACT MATCH`);
        return {
          isValid: true,
          errors: [],
          warnings: [],
          confidence: 95
        };
      }
      
      // Check if Wolfram answer is contained (student might have extra text)
      if (normalizedProposed.includes(normalizedWolfram) && normalizedWolfram.length >= 3) {
        console.log(`✅ WolframAlpha verification: CONTAINS (${normalizedWolfram})`);
        return {
          isValid: true,
          errors: [],
          warnings: [],
          confidence: 85
        };
      }
      
      // Check numeric equivalence
      const proposedNum = parseNumericValue(normalizedProposed);
      const wolframNum = parseNumericValue(normalizedWolfram);
      
      if (proposedNum !== null && wolframNum !== null) {
        if (Math.abs(proposedNum - wolframNum) < 0.0001) {
          console.log(`✅ WolframAlpha verification: NUMERICALLY EQUIVALENT (${proposedNum} ≈ ${wolframNum})`);
          return {
            isValid: true,
            errors: [],
            warnings: [],
            confidence: 90
          };
        } else {
          // Definite numeric mismatch
          console.log(`❌ WolframAlpha verification: WRONG - ${wolframNum} vs ${proposedNum}`);
          return {
            isValid: false,
            errors: [`WolframAlpha computed ${wolframNum} but solution shows ${proposedNum}`],
            warnings: [],
            confidence: 20
          };
        }
      }
      
      // Uncertain - could be format difference - mark as inconclusive
      console.log(`⚠️ WolframAlpha verification: INCONCLUSIVE (not numeric or format differs)`);
      return {
        isValid: true,
        errors: [],
        warnings: ['WolframAlpha could not confidently verify - format might differ'],
        confidence: 50
      };
    } catch (error) {
      console.error('❌ WolframAlpha API error:', error);
      return {
        isValid: true,
        errors: [],
        warnings: ['WolframAlpha verification failed'],
        confidence: 50
      };
    }
    
  } catch (error) {
    console.error('❌ WolframAlpha verification error:', error);
    return {
      isValid: true,
      errors: [],
      warnings: ['WolframAlpha verification encountered an error'],
      confidence: 50
    };
  }
}

// Cleanup old verifications after 1 hour
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, data] of verificationStore.entries()) {
    if (data.timestamp < oneHourAgo) {
      verificationStore.delete(id);
    }
  }
}, 5 * 60 * 1000);

/**
 * STEM CONTENT DETECTION - Analyzes extracted text to determine if it's STEM content
 * 
 * Returns true if the text contains strong STEM indicators (math, science, equations).
 * Mistral OCR achieves 94.29% accuracy on complex mathematical equations.
 */
function detectStemFromText(text: string): boolean {
  if (!text || text.trim().length === 0) {
    return false;
  }
  
  const lowerText = text.toLowerCase();
  
  // STEM indicators: mathematical symbols, equations, scientific terms
  const stemIndicators = [
    // Math symbols and patterns
    /[+\-×÷=<>≤≥≠±∞∑∏√∫]/,  // Mathematical operators and symbols
    /\d+[\s]*[+\-×÷]\s*\d+/,  // Arithmetic operations (e.g., "3 + 5", "10 × 2")
    /\d+\.?\d*\s*[=]/,  // Equations (e.g., "x = 5", "2.5 =")
    /[a-z]\s*[=]\s*\d/,  // Variable assignments (e.g., "x = 10")
    /\^\d+/,  // Exponents (e.g., "x^2", "2^3")
    /\d+\/\d+/,  // Fractions (e.g., "1/2", "3/4")
    /\(\s*\d+/,  // Parenthetical expressions (e.g., "(3 + 5)")
    
    // Science & math keywords
    /\b(solve|equation|formula|calculate|evaluate|simplify|factor|derivative|integral)\b/i,
    /\b(theorem|proof|lemma|corollary|axiom|hypothesis)\b/i,
    /\b(angle|triangle|circle|square|rectangle|polygon|perimeter|area|volume)\b/i,
    /\b(force|mass|velocity|acceleration|energy|momentum|friction)\b/i,
    /\b(atom|molecule|electron|proton|neutron|ion|chemical|reaction)\b/i,
    /\b(cell|dna|protein|enzyme|mitosis|meiosis|chromosome)\b/i,
    /\b(sin|cos|tan|log|ln|exp|sqrt)\b/i,  // Math functions
  ];
  
  // Count how many STEM indicators are present
  let stemScore = 0;
  for (const pattern of stemIndicators) {
    if (pattern.test(text)) {
      stemScore++;
    }
  }
  
  // If we find 2+ strong STEM indicators, classify as STEM
  const isStem = stemScore >= 2;
  
  console.log(`🎯 STEM detection: ${isStem} (score: ${stemScore}/20 indicators)`);
  return isStem;
}

/**
 * MISTRAL OCR HANDLER - Extracts text from images using Mistral's superior math recognition
 * 
 * Returns extracted markdown text and confidence score.
 */
async function extractTextWithMistral(imageUri: string): Promise<{ text: string; confidence: number }> {
  if (!mistral) {
    throw new Error('Mistral client not initialized');
  }
  
  try {
    console.log('🔍 Using Mistral OCR for superior STEM text extraction...');
    
    // Mistral OCR expects either imageUrl or documentBase64
    const response = await mistral.ocr.process({
      model: 'mistral-ocr-latest',
      document: {
        type: 'image_url',
        imageUrl: imageUri
      },
      includeImageBase64: false
    });
    
    if (!response.pages || response.pages.length === 0) {
      throw new Error('Mistral OCR returned no pages');
    }
    
    // Extract markdown from first page
    const extractedText = response.pages[0].markdown || '';
    
    // Mistral OCR has ~94% accuracy, but we can estimate confidence
    // based on text quality (non-empty, reasonable length)
    const confidence = extractedText.trim().length > 0 ? 0.94 : 0.0;
    
    console.log(`✅ Mistral OCR extracted ${extractedText.length} characters (confidence: ${(confidence * 100).toFixed(1)}%)`);
    console.log('📝 Extracted text preview:', extractedText.substring(0, 200));
    
    return {
      text: extractedText,
      confidence
    };
  } catch (error) {
    console.error('❌ Mistral OCR error:', error);
    throw error;
  }
}

/**
 * POST-OCR CORRECTION - Cleans and corrects OCR text for math/science accuracy
 * 
 * Uses OpenAI to fix common OCR errors in mathematical notation, equations, and symbols.
 * Significantly improves accuracy of downstream analysis.
 */
async function correctOcrText(rawText: string): Promise<string> {
  if (!rawText || rawText.trim().length === 0) {
    return rawText;
  }
  
  try {
    console.log('🧹 Applying post-OCR correction for math/science accuracy...');
    
    const correctionPrompt = `You are a post-OCR correction engine for math and science textbooks.
Input will be raw OCR text. Clean and correct it using logic and heuristics while keeping meaning exact.

Rules:
- Preserve equations, symbols, and layout.
- Fix common OCR errors:
  • Replace ".5" → "0.5", "5 ." → "5.0"
  • Convert "O"↔"0", "l"↔"1", "S"↔"5" using context
  • Detect and separate variables from numbers (e.g., "3x" not "3×")
  • Add missing negative signs or decimals if context implies them
- Use normal math syntax or LaTeX (e.g., x², √, ½) when clear.
- Maintain balanced parentheses, operators, and exponents.
- No commentary or explanations—return only corrected text.

If any token looks uncertain or inconsistent, pick the version that best preserves mathematical sense.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Use mini for cost efficiency on correction task
      messages: [
        {
          role: "system",
          content: correctionPrompt
        },
        {
          role: "user",
          content: `Correct this OCR text:\n\n${rawText}`
        }
      ],
      temperature: 0.1, // Low temperature for deterministic corrections
      max_tokens: 4096,
    });
    
    const correctedText = response.choices[0]?.message?.content?.trim() || rawText;
    
    console.log(`✅ OCR correction complete (${rawText.length} → ${correctedText.length} chars)`);
    console.log('📝 Corrected text preview:', correctedText.substring(0, 200));
    
    return correctedText;
  } catch (error) {
    console.warn('⚠️ OCR correction failed, using raw text:', error);
    return rawText; // Fallback to raw text if correction fails
  }
}

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
  
  // 0A. CRITICAL: Convert LaTeX fractions BEFORE stripping other macros
  // This must happen first to preserve numerator and denominator
  // Handle \frac{num}{den}, \dfrac{num}{den}, and \tfrac{num}{den}
  formatted = formatted.replace(/\\[dt]?frac\{([^{}]+)\}\{([^{}]+)\}/g, '{$1/$2}');
  
  // 0B. Remove LaTeX commands that shouldn't be displayed as text
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
  
  // 0C. CRITICAL: Detect and convert vertical fractions BEFORE whitespace normalization
  // AI sometimes outputs fractions in vertical format:
  //   y = 
  //   1
  //   2
  // This must be converted to "1/2" before newlines are collapsed to spaces
  // Pattern: math context (=, +, -, ×, etc.) followed by newlines and a fraction-like stack
  formatted = formatted.replace(
    /([=+\-×÷*\(]\s*)\n+\s*(\d+)\s*\n+\s*(\d+)(?=\s|$)/g,
    '$1$2/$3'
  );
  // Also catch fractions at start of text (no preceding operator)
  formatted = formatted.replace(
    /^\s*(\d+)\s*\n+\s*(\d+)(?=\s+[a-zA-Z])/gm,
    '$1/$2'
  );
  
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
  // FIXED: Use brace-aware tokenizer to prevent double-wrapping fractions like {240/41}
  const beforeFractionConversion = formatted;
  
  // Brace-aware fraction wrapper - only wraps raw a/b tokens, not {a/b}
  // CRITICAL: Only skips CURLY braces {...}, not parentheses () or brackets []
  function wrapFractions(text: string): string {
    let result = '';
    let i = 0;
    
    while (i < text.length) {
      // Check if we're at the start of a CURLY brace-wrapped section
      // This ensures we skip already-wrapped fractions like {240/41}
      // But we still process fractions in parentheses like (3/4) or √(9/16)
      if (text[i] === '{') {
        // Find the matching closing curly brace (handle unmatched braces gracefully)
        let depth = 1;
        let j = i + 1;
        while (j < text.length && depth > 0) {
          if (text[j] === '{') depth++;
          else if (text[j] === '}') depth--;
          j++;
        }
        // Copy the entire brace section unchanged (already wrapped)
        // If unmatched, copy what we found and continue
        result += text.substring(i, j);
        i = j;
        continue;
      }
      
      // Check if we're at a fraction pattern
      // Match: any alphanumeric/any alphanumeric (e.g., 12/5, 3x/4, x/10, 240/41)
      // CRITICAL: Preserve trailing unit suffixes when denom is purely numeric (e.g., 12/5h → {12/5}h)
      // But keep algebraic variables inside (e.g., 3x/4y → {3x/4y})
      const fractionMatch = text.substring(i).match(/^([a-zA-Z0-9]+)\/([a-zA-Z0-9]+)/);
      if (fractionMatch) {
        const num = fractionMatch[1];
        const den = fractionMatch[2];
        
        // Only wrap if at least one side has a digit (excludes pure letter ratios like m/s)
        const hasDigit = /\d/.test(num) || /\d/.test(den);
        
        // Not preceded/followed by decimal point (to avoid 19.6/5.0)
        const notDecimal = (i === 0 || text[i - 1] !== '.') && (i + fractionMatch[0].length >= text.length || text[i + fractionMatch[0].length] !== '.');
        
        if (hasDigit && notDecimal) {
          // Check if denominator is purely numeric with trailing letters (unit suffix case)
          // E.g., "5h" → {12/5}h, but "4y" → {3x/4y} (algebraic variable)
          const pureNumericDenMatch = den.match(/^(\d+)([a-zA-Z]+)$/);
          
          if (pureNumericDenMatch) {
            // Denominator is pure number + letters
            // Use unit allowlist to distinguish units from algebraic variables
            const denNum = pureNumericDenMatch[1];
            const suffix = pureNumericDenMatch[2].toLowerCase();
            
            // Common measurement units (includes common abbreviations, excludes algebraic variables x, y, z, a, b)
            const commonUnits = ['h', 'hr', 'hrs', 'hour', 'hours', 'm', 'min', 'mins', 'minute', 'minutes', 's', 'sec', 'secs', 'second', 'seconds',
                                 'c', 'f', 'k', // c=cups/celsius, f=fahrenheit, k=kilo/kelvin 
                                 'cm', 'mm', 'km', 'meter', 'meters', 'ft', 'feet', 'in', 'inch', 'inches', 'yd', 'yard', 'yards', 'mi', 'mile', 'miles', 'mph',
                                 'kg', 'g', 'mg', 'lb', 'lbs', 'oz', 'l', 'ml', 'gal', 'qt', 'pt', 'cup', 'cups', 'tbsp', 'tsp'];
            
            if (commonUnits.includes(suffix)) {
              // Recognized unit → separate it
              result += `{${num}/${denNum}}${pureNumericDenMatch[2]}`;
            } else {
              // Not a recognized unit → likely algebraic variable → keep together
              result += `{${num}/${den}}`;
            }
          } else {
            // Keep entire fraction together (includes algebraic cases like 3x/4y)
            result += `{${num}/${den}}`;
          }
          i += fractionMatch[0].length;
          continue;
        }
      }
      
      // Copy regular character
      result += text[i];
      i++;
    }
    
    return result;
  }
  
  // Apply fraction wrapping to entire text
  formatted = wrapFractions(formatted);
  
  // Also apply inside color tags (process tag contents separately)
  formatted = formatted.replace(/\[(blue|red):([^\]]+)\]/g, (match, color, content) => {
    const wrappedContent = wrapFractions(content);
    return `[${color}:${wrappedContent}]`;
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

// Deterministic measurement diagram classifier
function requiresMeasurementDiagram(question: string): { required: boolean; reason?: string } {
  // Guard against undefined/null
  if (!question || typeof question !== 'string') {
    return { required: false };
  }
  
  const lowerQuestion = question.toLowerCase();
  
  // Keyword groups for detection
  const geometryActions = ['cut', 'divide', 'split', 'measure', 'draw', 'construct', 'build', 'fit', 'arrange'];
  const measurementNouns = ['length', 'width', 'height', 'area', 'perimeter', 'volume', 'distance', 'piece', 'board', 'rope', 'wire', 'fabric'];
  const units = /\b(inch|inches|foot|feet|yard|yards|meter|meters|centimeter|cm|millimeter|mm|kilometer|km|mile|miles|ft|yd)\b/i;
  const fractions = /\d+\s*\{?\d+\/\d+\}?|\d+\/\d+/; // Matches "20 1/2" or "20{1/2}" or "1/2"
  
  let signalCount = 0;
  const signals: string[] = [];
  
  // Check for geometry action keywords
  if (geometryActions.some(action => lowerQuestion.includes(action))) {
    signalCount++;
    signals.push('geometry-action');
  }
  
  // Check for measurement nouns
  if (measurementNouns.some(noun => lowerQuestion.includes(noun))) {
    signalCount++;
    signals.push('measurement-noun');
  }
  
  // Check for units
  if (units.test(question)) {
    signalCount++;
    signals.push('units');
  }
  
  // Check for fractions (common in measurement problems)
  if (fractions.test(question)) {
    signalCount++;
    signals.push('fractions');
  }
  
  // Require ≥2 signals to avoid false positives
  if (signalCount >= 2) {
    return {
      required: true,
      reason: `Detected ${signalCount} measurement signals: ${signals.join(', ')}`
    };
  }
  
  return { required: false };
}

// Auto-inject default diagram for measurement problems
function applyMeasurementDiagramEnforcement(question: string, solution: any): any {
  // Only apply if visualAids is empty or missing
  if (solution.visualAids && solution.visualAids.length > 0) {
    return solution; // Already has diagrams
  }
  
  const check = requiresMeasurementDiagram(question);
  if (!check.required) {
    return solution; // Doesn't require diagram
  }
  
  console.log(`📐 Auto-injecting measurement diagram: ${check.reason}`);
  
  // Extract key information for diagram description
  const units = question.match(/(\d+(?:\s*\{?\d+\/\d+\}?)?)\s*(?:-?\s*)?(inch|inches|foot|feet|meter|meters|cm|ft|yd|yard|yards)/gi);
  const unitsText = units ? units.slice(0, 3).join(', ') : 'the given measurements';
  
  // Create default visual aid
  const defaultDiagram = {
    type: 'geometry',
    stepId: '1', // Attach to first step
    description: `Diagram showing the measurement problem setup with ${unitsText}. Display the total length/size and how it's divided into pieces or sections. Label all measurements clearly with their units and show the relationships between parts.`
  };
  
  // Inject diagram
  return {
    ...solution,
    visualAids: [defaultDiagram]
  };
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

function attachStructuredMathContent(solution: any): any {
  if (!solution || typeof solution !== 'object') {
    return solution;
  }

  const safeParse = (text?: string): ReturnType<typeof parseMathContent> => {
    if (!text || typeof text !== 'string') {
      return [];
    }

    try {
      return parseMathContent(text);
    } catch (error) {
      console.error('⚠️ Failed to parse math content for structured output:', error);
      return [];
    }
  };

  const structured = {
    ...solution,
    problemStructured: safeParse(solution.problem),
    finalAnswerStructured: safeParse(solution.finalAnswer),
  };

  if (Array.isArray(solution.steps)) {
    structured.steps = solution.steps.map((step: any) => ({
      ...step,
      structuredContent: safeParse(step.content),
      structuredExplanation: safeParse(step.explanation),
    }));
  }

  return structured;
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
    
    const verificationPrompt = `You are a RIGOROUS quality control expert. Your ONLY job is to catch ERRORS that would mislead students. Be EXTREMELY strict.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MANDATORY PROTOCOL - FOLLOW EVERY STEP EXACTLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1: SOLVE THE PROBLEM INDEPENDENTLY FIRST
Problem: ${originalQuestion}

- Solve this problem completely from scratch
- Write YOUR answer for each part (a), (b), (c), (d), (e), etc.
- Show all work and calculations
- DO NOT look below at the proposed solution yet!

STEP 2: LIST YOUR ANSWERS
Write explicitly:
My answer (a): [YOUR_VALUE]
My answer (b): [YOUR_VALUE]
My answer (c): [YOUR_VALUE]
My answer (d): [YOUR_VALUE]
My answer (e): [YOUR_VALUE]
... etc for all parts

STEP 3: NOW EXAMINE THEIR SOLUTION
Here is what they provided:

THEIR STEP-BY-STEP WORK:
${stepsText}

THEIR FINAL ANSWER:
${proposedSolution.finalAnswer}

STEP 4: EXTRACT THEIR ANSWERS  
Write explicitly what THEY said for each part:
Their answer (a): [THEIR_VALUE from their work above]
Their answer (b): [THEIR_VALUE from their work above]
Their answer (c): [THEIR_VALUE from their work above]
Their answer (d): [THEIR_VALUE from their work above]
Their answer (e): [THEIR_VALUE from their work above]
... etc

STEP 5: COMPARE ONE-BY-ONE
For EACH part:
- Part (a): Match? Yes/No - If no, what exactly is wrong?
- Part (b): Match? Yes/No - If no, what exactly is wrong?
- Part (c): Match? Yes/No - If no, what exactly is wrong?
- Part (d): Match? Yes/No - If no, what exactly is wrong?
- Part (e): Match? Yes/No - If no, what exactly is wrong?
... etc

Check EVERYTHING meticulously:
✓ Numerical values (must match EXACTLY)
✓ Signs (+ vs -)  
✓ Intervals (correct direction, endpoints, open/closed)
✓ Critical points identified correctly
✓ Arithmetic calculations

STEP 6: FINAL VERDICT
- ALL parts 100% correct → isCorrect: true
- ANY part wrong (even ONE) → isCorrect: false
- Unsure about any part → isCorrect: false

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXAMPLE - HOW TO CATCH ERRORS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MY INDEPENDENT SOLUTION:
(a) v(t) = 3t² - 12t + 9
(b) a(t) = 6t - 12  
(c) At rest: t = 1, 3
(d) Speeding up: (1,2), (3,5); Slowing down: (0,1), (2,3)
(e) Min s = 4 at t = 0, 3

THEIR WORK SHOWS:
(a) v(t) = 3t² - 12t + 9
(b) a(t) = 6t - 12
(c) At rest: t = 1, 3  
(d) Speeding up: (0,1), (1,3), (3,5); Slowing down: none
(e) Min s = -26 at t = 5

COMPARISON:
✓ (a) MATCH - Both have v(t) = 3t² - 12t + 9
✓ (b) MATCH - Both have a(t) = 6t - 12
✓ (c) MATCH - Both have t = 1, 3
✗ (d) NO MATCH - I got (1,2) & (3,5), they got (0,1) & (1,3). Intervals are backwards!
✗ (e) NO MATCH - I got min=4 at t=0,3; they got min=-26 at t=5. Wrong value AND wrong location!

VERDICT: isCorrect = FALSE (2 errors found)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Respond in JSON:
{
  "isCorrect": true/false,
  "confidence": 0-100,
  "errors": ["Part (d): My intervals (1,2),(3,5) vs their intervals (0,1),(1,3) - backwards!", ...],
  "warnings": [],
  "reasoning": "I solved independently and got: ... | They provided: ... | Mismatches in parts: ..."
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

// Gemini verification - backup verification using Google's Gemini
async function geminiVerification(
  originalQuestion: string,
  proposedSolution: any
): Promise<ValidationResult> {
  if (!geminiAI) {
    console.warn('⚠️ Gemini client not initialized');
    return {
      isValid: true,
      errors: [],
      warnings: ['Gemini not available'],
      confidence: 50
    };
  }
  
  try {
    console.log('🔮 Running Gemini verification (backup)...');
    
    // Check rate limit
    const canUse = await incrementGeminiUsage();
    if (!canUse) {
      return {
        isValid: true,
        errors: [],
        warnings: ['Gemini monthly limit reached'],
        confidence: 50
      };
    }
    
    const stepsText = proposedSolution.steps
      .map((s: any) => `${s.title}: ${s.content}`)
      .join('\n');
    
    const verificationPrompt = `You are a RIGOROUS quality control expert. Your ONLY job is to catch ERRORS that would mislead students. Be EXTREMELY strict.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MANDATORY PROTOCOL - FOLLOW EVERY STEP EXACTLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1: SOLVE THE PROBLEM INDEPENDENTLY FIRST
Problem: ${originalQuestion}

- Solve this problem completely from scratch
- Write YOUR answer for each part (a), (b), (c), (d), (e), etc.
- Show all work and calculations
- DO NOT look below at the proposed solution yet!

STEP 2: LIST YOUR ANSWERS
Write explicitly:
My answer (a): [YOUR_VALUE]
My answer (b): [YOUR_VALUE]
My answer (c): [YOUR_VALUE]
My answer (d): [YOUR_VALUE]
My answer (e): [YOUR_VALUE]
... etc for all parts

STEP 3: NOW EXAMINE THEIR SOLUTION
Here is what they provided:

THEIR STEP-BY-STEP WORK:
${stepsText}

THEIR FINAL ANSWER:
${proposedSolution.finalAnswer}

STEP 4: EXTRACT THEIR ANSWERS  
Write explicitly what THEY said for each part:
Their answer (a): [THEIR_VALUE from their work above]
Their answer (b): [THEIR_VALUE from their work above]
Their answer (c): [THEIR_VALUE from their work above]
Their answer (d): [THEIR_VALUE from their work above]
Their answer (e): [THEIR_VALUE from their work above]
... etc

STEP 5: COMPARE ONE-BY-ONE
For EACH part:
- Part (a): Match? Yes/No - If no, what exactly is wrong?
- Part (b): Match? Yes/No - If no, what exactly is wrong?
- Part (c): Match? Yes/No - If no, what exactly is wrong?
- Part (d): Match? Yes/No - If no, what exactly is wrong?
- Part (e): Match? Yes/No - If no, what exactly is wrong?
... etc

Check EVERYTHING meticulously:
✓ Numerical values (must match EXACTLY)
✓ Signs (+ vs -)  
✓ Intervals (correct direction, endpoints, open/closed)
✓ Critical points identified correctly
✓ Arithmetic calculations

STEP 6: FINAL VERDICT
- ALL parts 100% correct → isCorrect: true
- ANY part wrong (even ONE) → isCorrect: false
- Unsure about any part → isCorrect: false

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXAMPLE - HOW TO CATCH ERRORS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MY INDEPENDENT SOLUTION:
(a) v(t) = 3t² - 12t + 9
(b) a(t) = 6t - 12  
(c) At rest: t = 1, 3
(d) Speeding up: (1,2), (3,5); Slowing down: (0,1), (2,3)
(e) Min s = 4 at t = 0, 3

THEIR WORK SHOWS:
(a) v(t) = 3t² - 12t + 9
(b) a(t) = 6t - 12
(c) At rest: t = 1, 3  
(d) Speeding up: (0,1), (1,3), (3,5); Slowing down: none
(e) Min s = -26 at t = 5

COMPARISON:
✓ (a) MATCH - Both have v(t) = 3t² - 12t + 9
✓ (b) MATCH - Both have a(t) = 6t - 12
✓ (c) MATCH - Both have t = 1, 3
✗ (d) NO MATCH - I got (1,2) & (3,5), they got (0,1) & (1,3). Intervals are backwards!
✗ (e) NO MATCH - I got min=4 at t=0,3; they got min=-26 at t=5. Wrong value AND wrong location!

VERDICT: isCorrect = FALSE (2 errors found)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Respond in JSON:
{
  "isCorrect": true/false,
  "confidence": 0-100,
  "errors": ["Part (d): My intervals (1,2),(3,5) vs their intervals (0,1),(1,3) - backwards!", ...],
  "warnings": [],
  "reasoning": "I solved independently and got: ... | They provided: ... | Mismatches in parts: ..."
}`;

    const model = geminiAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: verificationPrompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
      },
    });
    
    const response = result.response;
    const text = response.text();
    const verification = JSON.parse(text);
    
    console.log(`✓ Gemini verification complete - Correct: ${verification.isCorrect}, Confidence: ${verification.confidence}%`);
    if (verification.errors && verification.errors.length > 0) {
      console.log(`⚠️  Gemini found errors:`, verification.errors);
    }
    
    return {
      isValid: verification.isCorrect === true,
      errors: verification.errors || [],
      warnings: verification.warnings || [],
      confidence: verification.confidence || 0
    };
    
  } catch (error) {
    console.error('❌ Gemini verification error:', error);
    return {
      isValid: true,
      errors: [],
      warnings: ['Gemini verification encountered an error'],
      confidence: 50
    };
  }
}

// Async verification pipeline - runs in background
async function runVerificationPipeline(
  solutionId: string,
  originalQuestion: string,
  solution: any
): Promise<void> {
  console.log(`🔄 Starting async verification pipeline for solution ${solutionId}...`);
  
  // Initialize as pending
  verificationStore.set(solutionId, {
    status: 'pending',
    confidence: 0,
    warnings: [],
    timestamp: Date.now()
  });
  
  try {
    // Check if this is a math-eligible problem
    const isMath = isMathEligible(originalQuestion, solution.subject || '');
    
    if (isMath && wolframAlphaAppId) {
      console.log(`🧮 Math problem detected - using WolframAlpha for ground truth verification`);
      
      // Attempt 1: WolframAlpha verification (computational ground truth)
      const wolframResult = await wolframAlphaVerification(originalQuestion, solution);
      
      if (wolframResult.isValid && wolframResult.confidence >= 70) {
        console.log(`✅ WolframAlpha verification PASSED (confidence: ${wolframResult.confidence}%)`);
        verificationStore.set(solutionId, {
          status: 'verified',
          confidence: wolframResult.confidence,
          warnings: wolframResult.warnings,
          timestamp: Date.now()
        });
        return;
      }
      
      if (!wolframResult.isValid && wolframResult.confidence < 50) {
        // WolframAlpha found a definite error
        console.warn(`❌ WolframAlpha found errors - marking as unverified`);
        verificationStore.set(solutionId, {
          status: 'unverified',
          confidence: wolframResult.confidence,
          warnings: [...wolframResult.warnings, ...wolframResult.errors],
          timestamp: Date.now()
        });
        return;
      }
      
      console.log(`⚠️ WolframAlpha inconclusive, falling back to AI verification...`);
    }
    
    // Attempt 2 (or 1 if not math): GPT-4o verification
    let verification = await crossModelVerification(originalQuestion, solution);
    
    if (verification.isValid && verification.confidence >= 70) {
      console.log(`✅ GPT-4o verification passed (confidence: ${verification.confidence}%)`);
      verificationStore.set(solutionId, {
        status: 'verified',
        confidence: verification.confidence,
        warnings: verification.warnings,
        timestamp: Date.now()
      });
      return;
    }
    
    // Attempt 3: Retry GPT-4o
    console.log(`🔄 First GPT-4o attempt inconclusive, retrying...`);
    const retryVerification = await crossModelVerification(originalQuestion, solution);
    
    if (retryVerification.isValid && retryVerification.confidence >= 70) {
      console.log(`✅ GPT-4o retry passed (confidence: ${retryVerification.confidence}%)`);
      verificationStore.set(solutionId, {
        status: 'verified',
        confidence: retryVerification.confidence,
        warnings: retryVerification.warnings,
        timestamp: Date.now()
      });
      return;
    }
    
    // All verification attempts inconclusive - mark as unverified
    console.warn(`⚠️ All verification attempts inconclusive - marking as unverified`);
    verificationStore.set(solutionId, {
      status: 'unverified',
      confidence: Math.max(verification.confidence, retryVerification.confidence, 0),
      warnings: ['Unable to verify solution accuracy', ...verification.warnings],
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error(`❌ Verification pipeline error for ${solutionId}:`, error);
    verificationStore.set(solutionId, {
      status: 'unverified',
      confidence: 0,
      warnings: ['Verification system error'],
      timestamp: Date.now()
    });
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
  const requestStartTime = Date.now();
  try {
    const { question } = req.body;
    console.log('Analyzing text question:', question);
    console.log('⏱️ [TIMING] Request received at:', new Date().toISOString());
    
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
- **ALWAYS use LaTeX \\frac{num}{den} or slash notation num/den for fractions**
- **DO NOT use raw text newlines between numerator and denominator** (the system renders fractions vertically automatically)

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

🎨 **MATCH QUESTION FORMAT IN FINAL ANSWER - CRITICAL DIFFERENTIATION:**

**This is what makes us stand out from other homework apps - final answers should MIRROR the question's format and appearance!**

**1. MULTIPLE CHOICE QUESTIONS - Show ALL Options:**
- **ALWAYS include ALL answer choices (A, B, C, D, etc.) in the finalAnswer, not just the correct one**
- Format them EXACTLY as they appear in the question
- Highlight ONLY the correct answer with [red:]
- **Example:**
  - Question has: "A) Mitochondrion, B) Nucleus, C) Ribosome, D) Chloroplast"
  - finalAnswer MUST BE: "A) Mitochondrion \n B) Nucleus \n C) [red:Ribosome] \n D) Chloroplast"
  - WRONG: "[red:C) Ribosome]" (missing the other options!)
- This helps students see WHY other options are wrong by showing the full context

**2. HANDWRITTEN PROBLEMS - Use Handwriting Font:**
- **Detect if the question image appears to be handwritten** (look for irregular letters, pen/pencil marks, notebook paper, handwritten numbers/symbols)
- If handwritten: Wrap the ENTIRE finalAnswer text in [handwritten:...] tags with colored highlights inside
- **Example:**
  - Handwritten math problem: finalAnswer = "[handwritten:[red:x = 7]]" (handwriting font with red highlight)
  - Typed textbook problem: finalAnswer = "[red:x = 7]" (normal font, just red highlight)
- **CRITICAL**: You can nest color tags inside handwritten tags: [handwritten:[red:answer]] works perfectly
- The handwriting font makes the answer feel personal and relatable to the student's own work

**3. MATCH NUMBER FORMAT:**
- If question uses decimals (0.5, 3.14), use decimals in answer: [red:0.5]
- If question uses fractions ({1/2}, {3/4}), use fractions in answer: [red:{1/2}]
- If question uses mixed numbers ({1{1/2}}), use mixed numbers in answer

**4. PRESERVE QUESTION STRUCTURE:**
- If question has parts labeled (a, b, c) or (1, 2, 3), use the SAME labels in finalAnswer
- If question is a fill-in-the-blank, format answer to match the blank style
- If question is a table, consider using a simple text table format

**FINAL ANSWER HIGHLIGHTING - GENERAL RULES:**
- ALWAYS highlight key technical terms, concepts, or vocabulary in the final answer using [red:term]
- Examples: [red:phototropism], [red:auxin], [red:mitochondria], [red:Pythagorean theorem], [red:oxidation]
- For math: highlight the final numerical answer: [red:x = 5] or [red:{3/4}]
- For science: highlight phenomena, hormones, processes, chemical names
- For any subject: highlight the most important 2-3 terms that answer the core question
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
          
          try {
            const parsed = JSON.parse(content);
            return parsed;
          } catch (jsonError: any) {
            console.error('❌ JSON Parse Error:', jsonError.message);
            console.error('📄 Response length:', content.length, 'chars');
            console.error('📄 Response preview (first 500 chars):', content.substring(0, 500));
            console.error('📄 Response end (last 500 chars):', content.substring(Math.max(0, content.length - 500)));
            
            // Attempt to repair common JSON issues
            let repairedContent = content;
            
            // Fix: Unclosed arrays - add missing closing bracket
            const openBrackets = (repairedContent.match(/\[/g) || []).length;
            const closeBrackets = (repairedContent.match(/\]/g) || []).length;
            if (openBrackets > closeBrackets) {
              console.log(`🔧 Attempting JSON repair: Adding ${openBrackets - closeBrackets} missing ']'`);
              repairedContent += ']'.repeat(openBrackets - closeBrackets);
            }
            
            // Fix: Unclosed objects - add missing closing brace
            const openBraces = (repairedContent.match(/\{/g) || []).length;
            const closeBraces = (repairedContent.match(/\}/g) || []).length;
            if (openBraces > closeBraces) {
              console.log(`🔧 Attempting JSON repair: Adding ${openBraces - closeBraces} missing '}'`);
              repairedContent += '}'.repeat(openBraces - closeBraces);
            }
            
            // Try parsing repaired JSON
            try {
              const parsed = JSON.parse(repairedContent);
              console.log('✅ JSON successfully repaired and parsed!');
              return parsed;
            } catch (repairError: any) {
              console.error('❌ JSON repair failed:', repairError.message);
              throw new Error(`Failed to parse AI response as JSON: ${jsonError.message}`);
            }
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
    
    // 🧬 BIOLOGY/CHEMISTRY KEYWORD DETECTION: Ensure visual aids for metabolic cycles
    result = ensureBiologyVisualAids(question, result);
    
    // 📐 MEASUREMENT DIAGRAM ENFORCEMENT: Auto-inject diagrams for geometry/measurement problems
    result = applyMeasurementDiagramEnforcement(question, result);
    
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
    if (result.steps && Array.isArray(result.steps)) {
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
    if (result.steps && Array.isArray(result.steps)) {
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
    }
    
    // ENFORCE PROPER FORMATTING - Convert all fractions to {num/den} format
    const formattedResult = enforceResponseFormatting(result);
    const structuredResult = attachStructuredMathContent(formattedResult);

    // ⚡ RETURN IMMEDIATELY with pending verification status
    const responseWithId = {
      ...structuredResult,
      solutionId,
      verificationStatus: 'pending' as const,
      verificationConfidence: 0,
      verificationWarnings: []
    };
    
    const totalTime = Date.now() - requestStartTime;
    console.log(`✅ Analysis complete - returning solution ${solutionId} immediately (verification pending)`);
    console.log(`⏱️ [TIMING] === TOTAL REQUEST TIME: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s) ===`);
    res.json(responseWithId);
    
    // 🔄 START ASYNC VERIFICATION PIPELINE (non-blocking)
    void runVerificationPipeline(solutionId, question, structuredResult)
      .catch(err => {
        console.error(`⚠️ Verification pipeline error for ${solutionId}:`, err);
      });

    // Generate diagrams in background if any exist
    if (diagrams.length > 0) {
      const hostname = req.get('host');
      void generateDiagramsInBackground(solutionId, diagrams, structuredResult.steps, hostname);
    }
  } catch (error) {
    console.error('Error analyzing text:', error);
    res.status(500).json({ error: 'Failed to analyze question' });
  }
});

app.post('/api/analyze-image', async (req, res) => {
  const requestStartTime = Date.now();
  try {
    const { imageUri, problemNumber } = req.body;
    console.log('🎯 Starting hybrid OCR analysis...');
    console.log('⏱️ [TIMING] Request received at:', new Date().toISOString());
    
    let result = await pRetry(
      async () => {
        try {
          // STRATEGY: Always try Mistral OCR first (superior accuracy)
          // Then decide based on content whether to use text analysis or vision
          
          if (mistral) {
            try {
              const startTime = Date.now();
              
              // Step 1: Extract text using Mistral's superior OCR
              console.log('⏱️ [TIMING] Starting Mistral OCR...');
              const { text: rawOcrText, confidence: ocrConfidence } = await extractTextWithMistral(imageUri);
              console.log(`⏱️ [TIMING] Mistral OCR completed in ${Date.now() - startTime}ms`);
              
              if (rawOcrText && rawOcrText.trim().length > 0) {
                // Step 2: Analyze the extracted text to determine if it's STEM content (BEFORE correction)
                const stemCheckStart = Date.now();
                const isStemContent = detectStemFromText(rawOcrText);
                console.log(`⏱️ [TIMING] STEM detection completed in ${Date.now() - stemCheckStart}ms`);
                
                // Step 3: Apply post-OCR correction ONLY for STEM content (optimization: saves 6-8s on non-STEM)
                let ocrText = rawOcrText;
                if (isStemContent) {
                  console.log('⏱️ [TIMING] Starting OCR correction (STEM content)...');
                  const correctionStart = Date.now();
                  ocrText = await correctOcrText(rawOcrText);
                  console.log(`⏱️ [TIMING] OCR correction completed in ${Date.now() - correctionStart}ms`);
                } else {
                  console.log('⏱️ [OPTIMIZATION] Skipping OCR correction for non-STEM content');
                }
                
                if (isStemContent) {
                  console.log('🔬 STEM content detected → Using Mistral OCR + OpenAI text analysis');
                  // HYBRID PATH 1: Mistral OCR + OpenAI Text Analysis (for STEM)
              // Step 2: Use OpenAI GPT-4o (text mode) to analyze the extracted text
              console.log(`📝 Using Mistral OCR text (${(ocrConfidence * 100).toFixed(1)}% confidence) with OpenAI analysis`);
              
              const systemMessage = `You are an expert educational AI tutor. You have been provided with HIGH-ACCURACY text extracted by Mistral OCR (${(ocrConfidence * 100).toFixed(1)}% confidence).

⚠️ CRITICAL: You MUST respond with valid JSON only.

🎯 **USE THE OCR TEXT BELOW AS YOUR PRIMARY SOURCE**
The OCR text has been extracted by Mistral's specialized OCR engine (94.29% accuracy on complex math equations).
Trust this text for all numbers, decimals, variables, operators, and equation structure.

${problemNumber ? `Focus on problem #${problemNumber} in the text below.` : 'If multiple problems exist, solve the most prominent one.'}

**OCR-EXTRACTED TEXT:**
\`\`\`
${ocrText}
\`\`\`

🔢 **NUMBER FORMAT RULE - MATCH THE INPUT:**
- If the problem uses DECIMALS (0.5, 2.75), use decimals in your solution
- If the problem uses FRACTIONS (1/2, 3/4), use fractions {num/den} in your solution
- For fractions: Use mixed numbers when appropriate (e.g., {1{1/2}} for 1½, {2{3/4}} for 2¾)
- CRITICAL: Match the user's preferred format - don't convert between decimals and fractions
- **ALWAYS use LaTeX \\frac{num}{den} or slash notation num/den for fractions**
- **DO NOT use raw text newlines between numerator and denominator** (the system renders fractions vertically automatically)

🎨 **MANDATORY COLOR HIGHLIGHTING IN EVERY STEP:**
- Use [blue:value] for the number/operation being applied (e.g., "Multiply by [blue:8]")
- Use [red:result] for the outcome (e.g., "= [red:24]")
- **CRITICAL:** Include operators WITH the number when showing multiplication/division operations
  - CORRECT: "[blue:8 ×] {1/8}(3d - 2) = [blue:8 ×] {1/4}(d + 5)"
  - WRONG: "[blue:8] × {1/8}" (operator outside the tag causes line breaks)
- Example: "Multiply both sides by [blue:8 ×] to eliminate fractions: [blue:8 ×] {1/8}(3d - 2) = [blue:8 ×] {1/4}(d + 5) simplifies to [red:(3d - 2) = 2(d + 5)]"
- NEVER skip color highlighting - it's essential for student understanding!
- **CRITICAL:** Keep all text (including punctuation) on the SAME LINE as color tags. NEVER write: "[red:phototropism]\\n." Instead write: "[red:phototropism]."

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

**When NOT to use overview step:**
- Simple one-step problems (e.g., "What is 5 + 3?")
- Essay questions (already have special format)
- Multiple choice questions that only need elimination logic

📊 **RATIO FILL-IN-THE-BLANK PROBLEMS:**
**If the problem contains empty boxes/blanks to be filled with ratio numbers:**
- **Recognize ratio patterns:** Look for "ratio of A to B", "_ : _ : _", "Fill in: ___ to ___"
- **Format the answer clearly:**
  - PREFERRED: Recreate the original format with filled boxes, e.g., "Box 1: [red:3], Box 2: [red:5], Box 3: [red:7]" or "Ratio: [red:3]:[red:5]:[red:7]"
  - MINIMUM: List each ratio component with clear labels, e.g., "First number = [red:3], Second number = [red:5], Third number = [red:7]"
- **Avoid confusing prose:** Do NOT say "the ratio can be expressed as..." Instead, directly state "The answer is [red:3]:[red:5]:[red:7]"
- **Highlight ratio numbers:** Always use [red:number] for the actual ratio values to make them stand out

**Example:**
- Question: "Complete the ratio: ___ : ___ : ___ (The angles of a triangle are in ratio 2:3:4)"
- GOOD Answer: "The completed ratio is [red:2]:[red:3]:[red:4]" or "Box 1 = [red:2], Box 2 = [red:3], Box 3 = [red:4]"
- BAD Answer: "The ratio can be expressed as two to three to four based on the proportion given..."

🖊️ **HANDWRITTEN PROBLEMS - Use Handwriting Font in Final Answer:**
- **You have access to BOTH the OCR text AND the original image** - examine the image to detect handwriting
- **Detect if the question image appears to be handwritten** (look for irregular letters, pen/pencil marks, notebook paper, handwritten numbers/symbols)
- If handwritten: Wrap the ENTIRE finalAnswer text in [handwritten:...] tags with colored highlights inside
- **Example:**
  - Handwritten math problem: finalAnswer = "[handwritten:[red:x = 7]]" (handwriting font with red highlight)
  - Typed textbook problem: finalAnswer = "[red:x = 7]" (normal font, just red highlight)
- **CRITICAL**: You can nest color tags inside handwritten tags: [handwritten:[red:answer]] works perfectly
- The handwriting font makes the answer feel personal and relatable to the student's own work`;
              
              console.log('⏱️ [TIMING] Starting GPT-4o analysis (with image for handwriting detection)...');
              const gptStart = Date.now();
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
                        type: "text",
                        text: `Please analyze the OCR-extracted problem text above and provide a complete step-by-step solution in JSON format. I'm also providing the original image so you can detect if it's handwritten and format the final answer accordingly.`
                      },
                      {
                        type: "image_url",
                        image_url: {
                          url: imageUri
                        }
                      }
                    ]
                  }
                ],
                response_format: { type: "json_object" },
                max_tokens: 8192,
              });
              console.log(`⏱️ [TIMING] GPT-4o analysis completed in ${Date.now() - gptStart}ms`);
              
              let content = response.choices[0]?.message?.content || "{}";
              const parsed = JSON.parse(content);
              
              // Validate parsed result
              if (!parsed || typeof parsed !== 'object') {
                throw new Error('OpenAI returned invalid JSON: parsed is not an object');
              }
              
              if (!parsed.problem || !parsed.subject || !parsed.difficulty || !parsed.steps || !Array.isArray(parsed.steps)) {
                throw new Error('OpenAI response missing required fields (problem, subject, difficulty, or steps array)');
              }
              
              console.log('✅ Hybrid OCR complete: Mistral OCR + OpenAI analysis');
              return parsed;
            }
          }
        } catch (mistralError) {
          console.warn('⚠️  Mistral OCR pipeline issue - falling back to OpenAI Vision:', mistralError);
        }
      }

      // HYBRID PATH 2: OpenAI GPT-4o Vision (for non-STEM or fallback)
          // Build system message for GPT-4o Vision analysis
          let systemMessage = `You are an expert educational AI tutor. Analyze the homework image and provide a step-by-step solution.

⚠️ CRITICAL: You MUST respond with valid JSON only.

${problemNumber ? `Focus on problem #${problemNumber} in the image.` : 'If multiple problems exist, solve the most prominent one.'}

🔢 **NUMBER FORMAT RULE - MATCH THE INPUT:**
- If the problem uses DECIMALS (0.5, 2.75), use decimals in your solution
- If the problem uses FRACTIONS (1/2, 3/4), use fractions {num/den} in your solution
- For fractions: Use mixed numbers when appropriate (e.g., {1{1/2}} for 1½, {2{3/4}} for 2¾)
- CRITICAL: Match the user's preferred format - don't convert between decimals and fractions
- **ALWAYS use LaTeX \\frac{num}{den} or slash notation num/den for fractions**
- **DO NOT use raw text newlines between numerator and denominator** (the system renders fractions vertically automatically)

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

📊 **RATIO FILL-IN-THE-BLANK PROBLEMS:**
**If the problem contains empty boxes/blanks to be filled with ratio numbers:**
- **Recognize ratio patterns:** Look for "ratio of A to B", "_ : _ : _", "Fill in: ___ to ___"
- **Format the answer clearly:**
  - PREFERRED: Recreate the original format with filled boxes, e.g., "Box 1: [red:3], Box 2: [red:5], Box 3: [red:7]" or "Ratio: [red:3]:[red:5]:[red:7]"
  - MINIMUM: List each ratio component with clear labels, e.g., "First number = [red:3], Second number = [red:5], Third number = [red:7]"
- **Avoid confusing prose:** Do NOT say "the ratio can be expressed as..." Instead, directly state "The answer is [red:3]:[red:5]:[red:7]"
- **Highlight ratio numbers:** Always use [red:number] for the actual ratio values to make them stand out

**Example:**
- Question: "Complete the ratio: ___ : ___ : ___ (The angles of a triangle are in ratio 2:3:4)"
- GOOD Answer: "The completed ratio is [red:2]:[red:3]:[red:4]" or "Box 1 = [red:2], Box 2 = [red:3], Box 3 = [red:4]"
- BAD Answer: "The ratio can be expressed as two to three to four based on the proportion given..."

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

🎨 **MATCH QUESTION FORMAT IN FINAL ANSWER - CRITICAL DIFFERENTIATION:**

**This is what makes us stand out from other homework apps - final answers should MIRROR the question's format and appearance!**

**1. MULTIPLE CHOICE QUESTIONS - Show ALL Options:**
- **ALWAYS include ALL answer choices (A, B, C, D, etc.) in the finalAnswer, not just the correct one**
- Format them EXACTLY as they appear in the question
- Highlight ONLY the correct answer with [red:]
- **Example:**
  - Question has: "A) Mitochondrion, B) Nucleus, C) Ribosome, D) Chloroplast"
  - finalAnswer MUST BE: "A) Mitochondrion \n B) Nucleus \n C) [red:Ribosome] \n D) Chloroplast"
  - WRONG: "[red:C) Ribosome]" (missing the other options!)
- This helps students see WHY other options are wrong by showing the full context

**2. HANDWRITTEN PROBLEMS - Use Handwriting Font:**
- **Detect if the question image appears to be handwritten** (look for irregular letters, pen/pencil marks, notebook paper, handwritten numbers/symbols)
- If handwritten: Wrap the ENTIRE finalAnswer text in [handwritten:...] tags with colored highlights inside
- **Example:**
  - Handwritten math problem: finalAnswer = "[handwritten:[red:x = 7]]" (handwriting font with red highlight)
  - Typed textbook problem: finalAnswer = "[red:x = 7]" (normal font, just red highlight)
- **CRITICAL**: You can nest color tags inside handwritten tags: [handwritten:[red:answer]] works perfectly
- The handwriting font makes the answer feel personal and relatable to the student's own work

**3. MATCH NUMBER FORMAT:**
- If question uses decimals (0.5, 3.14), use decimals in answer: [red:0.5]
- If question uses fractions ({1/2}, {3/4}), use fractions in answer: [red:{1/2}]
- If question uses mixed numbers ({1{1/2}}), use mixed numbers in answer

**4. PRESERVE QUESTION STRUCTURE:**
- If question has parts labeled (a, b, c) or (1, 2, 3), use the SAME labels in finalAnswer
- If question is a fill-in-the-blank, format answer to match the blank style
- If question is a table, consider using a simple text table format

**FINAL ANSWER HIGHLIGHTING - GENERAL RULES:**
- ALWAYS highlight key technical terms, concepts, or vocabulary in the final answer using [red:term]
- Examples: [red:phototropism], [red:auxin], [red:mitochondria], [red:Pythagorean theorem], [red:oxidation]
- For math: highlight the final numerical answer: [red:x = 5] or [red:{3/4}]
- For science: highlight phenomena, hormones, processes, chemical names
- For any subject: highlight the most important 2-3 terms that answer the core question
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
          
          // Make OpenAI API call with constructed system message and image
          // NOTE: Do NOT use response_format: json_object with images - OpenAI returns {} silently
          console.log('⏱️ [TIMING] Starting GPT-4o Vision analysis...');
          const visionStart = Date.now();
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
            // response_format removed - incompatible with image_url content
            max_tokens: 8192,
          });
          console.log(`⏱️ [TIMING] GPT-4o Vision completed in ${Date.now() - visionStart}ms`);
          
          let content = response.choices[0]?.message?.content || "{}";
          
          // 🐛 DEBUG: Log raw GPT-4o response
          console.log('\n🔍 === GPT-4o RAW RESPONSE DEBUG (IMAGE) ===');
          console.log('Response exists:', !!response);
          console.log('Choices exists:', !!response.choices);
          console.log('Choices length:', response.choices?.length);
          console.log('Message content length:', content?.length);
          console.log('Raw content (first 500 chars):', content.substring(0, 500));
          console.log('Raw content (last 200 chars):', content.substring(Math.max(0, content.length - 200)));
          console.log('=== END RAW RESPONSE ===\n');
          
          // Extract JSON from markdown code blocks if present (since we can't force json_object with images)
          const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
          if (jsonMatch) {
            content = jsonMatch[1];
            console.log('📝 Extracted JSON from markdown code block');
          }
          
          const parsed = JSON.parse(content);
          
          // Validate parsed result has required fields
          if (!parsed || typeof parsed !== 'object') {
            console.error('❌ GPT-4o returned invalid JSON: parsed is not an object');
            throw new Error('GPT-4o returned invalid response structure');
          }
          
          if (!parsed.problem || !parsed.subject || !parsed.difficulty || !parsed.steps || !Array.isArray(parsed.steps)) {
            console.error('❌ GPT-4o response missing required fields:', {
              hasProblem: !!parsed.problem,
              hasSubject: !!parsed.subject,
              hasDifficulty: !!parsed.difficulty,
              hasSteps: !!parsed.steps,
              stepsIsArray: Array.isArray(parsed.steps),
              actualKeys: Object.keys(parsed)
            });
            throw new Error('GPT-4o response missing required fields (problem, subject, difficulty, or steps array)');
          }
          
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
    
    // 📐 MEASUREMENT DIAGRAM ENFORCEMENT: Auto-inject diagrams for geometry/measurement problems
    result = applyMeasurementDiagramEnforcement(result.problem ?? '', result);
    
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
    if (result.steps && Array.isArray(result.steps)) {
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
    if (result.steps && Array.isArray(result.steps)) {
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
    }
    
    // ENFORCE PROPER FORMATTING - Convert all fractions to {num/den} format
    const formattedResult = enforceResponseFormatting(result);
    const structuredResult = attachStructuredMathContent(formattedResult);

    // 🔒 SYNCHRONOUS VALIDATION - Verify accuracy BEFORE sending to user
    console.log('🔍 Running synchronous validation...');
    const validationStart = Date.now();
    let validationResult;
    try {
      validationResult = await validateSolution(result.problem || 'Image-based question', structuredResult);
    } catch (validationError) {
      console.error('⚠️ Validation system error (non-blocking):', validationError);
      // If validator fails, allow solution through with warning
      validationResult = {
        validationPassed: true,
        validationDetails: {
          verification: {
            confidence: 50,
            warnings: ['Validation system unavailable - answer not verified']
          }
        }
      };
    }
    
    const { validationPassed, validationDetails } = validationResult;
    console.log(`⏱️ [TIMING] Validation completed in ${Date.now() - validationStart}ms`);
    
    // Map confidence to verification status
    const confidence = validationDetails?.verification?.confidence || 0;
    let verificationStatus: 'verified' | 'unverified' | 'failed' = 'failed';
    
    // CRITICAL: Check BOTH validationPassed and confidence
    if (!validationPassed) {
      // Validator explicitly marked as incorrect - always fail
      verificationStatus = 'failed';
    } else if (confidence >= 70) {
      // High confidence and passed validation
      verificationStatus = 'verified';
    } else if (confidence >= 40) {
      // Medium confidence but passed validation
      verificationStatus = 'unverified';
    } else {
      // Low confidence - treat as failed
      verificationStatus = 'failed';
    }
    
    // 🚫 BLOCK FAILED VERIFICATIONS - Don't send incorrect answers to students
    if (verificationStatus === 'failed') {
      console.error(`❌ VERIFICATION FAILED - Blocking response (confidence: ${confidence}%)`);
      if (validationDetails?.verification?.errors) {
        console.error('   Errors detected:', validationDetails.verification.errors);
      }
      
      const totalTime = Date.now() - requestStartTime;
      console.log(`⏱️ [TIMING] === REQUEST BLOCKED AFTER: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s) ===`);
      
      return res.status(422).json({
        error: 'Unable to verify answer accuracy',
        message: 'Our AI detected potential errors in the solution. Please try rephrasing your question or breaking it into smaller parts.',
        confidence,
        details: validationDetails?.verification?.errors || []
      });
    }
    
    // Add solutionId and verification metadata to response
    const responseWithId = {
      ...structuredResult,
      solutionId: diagrams.length > 0 ? solutionId : undefined,
      verificationStatus,
      verificationConfidence: confidence,
      verificationWarnings: validationDetails?.verification?.warnings || []
    };
    
    if (verificationStatus === 'unverified') {
      console.warn(`⚠️  Solution verification: unverified (confidence: ${confidence}%)`);
      if (validationDetails?.verification?.warnings) {
        console.warn('   Warnings:', validationDetails.verification.warnings);
      }
    }
    
    // ⚡ RETURN WITH VERIFICATION STATUS (only if verified or unverified, never failed)
    const totalTime = Date.now() - requestStartTime;
    console.log(`✅ Analysis complete - returning solution ${solutionId} (${verificationStatus})`);
    console.log(`⏱️ [TIMING] === TOTAL REQUEST TIME: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s) ===`);
    res.json(responseWithId);
    
    // Generate diagrams in background if any exist
    if (diagrams.length > 0) {
      const hostname = req.get('host');
      void generateDiagramsInBackground(solutionId, diagrams, structuredResult.steps, hostname);
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
      console.error('🔑 API key issue detected - check OpenAI credentials');
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
// Verification status endpoint - check verification progress
app.get('/api/verification/:solutionId', async (req, res) => {
  try {
    const { solutionId } = req.params;
    const verification = verificationStore.get(solutionId);
    
    if (!verification) {
      return res.status(404).json({ error: 'Verification not found' });
    }
    
    res.json(verification);
  } catch (error) {
    console.error('Error fetching verification:', error);
    res.status(500).json({ error: 'Failed to fetch verification status' });
  }
});

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
  
  // Enhanced cache control for reliable updates and bug fixes
  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        // Never cache HTML - always fetch latest
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      } else if (filePath.match(/\.(js|css|json)$/)) {
        // Don't cache JS/CSS to ensure bug fixes are immediately available
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      } else if (filePath.match(/\.(jpg|jpeg|png|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
        // Cache images and fonts for 1 year (these rarely change)
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  }));
  
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
