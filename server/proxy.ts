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
import { GoogleGenerativeAI } from '@google/generative-ai';
import pRetry, { AbortError } from 'p-retry';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parseMathContent } from '../src/utils/mathParser';

function sanitizeEnvValue(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\s+/g, '').trim() || undefined;
}

interface OcrBoundingBox {
  text: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
  pageIndex: number;
  pageWidth?: number | null;
  pageHeight?: number | null;
}

interface ProblemBoundingRegion {
  combinedText: string;
  boundingBox: {
    top: number;
    left: number;
    bottom: number;
    right: number;
    pageWidth?: number | null;
    pageHeight?: number | null;
    pageIndex: number;
  };
}

interface TargetedOcrResult {
  transcription: string | null;
  diagnostics: string[];
  boundingBox?: {
    top: number;
    left: number;
    bottom: number;
    right: number;
  };
  croppedImageUri?: string | null;
}

type SharpModule = any;

let sharpModulePromise: Promise<SharpModule | null> | null = null;

function extractStandaloneVariables(text: string): Set<string> {
  const matches = text?.match(/\b([a-zA-Z])\b/g) ?? [];
  return new Set(matches.map((token) => token.toLowerCase()));
}

function normalizeOcrProblemText(text: string, allowedVariables?: Set<string>): string {
  if (!text) {
    return text;
  }
  // Reuse the main formatter so OCR problems follow the exact same math rules.
  let formatted = enforceProperFormatting(text, 'ocr-problem');
  if (allowedVariables && allowedVariables.size > 0) {
    const sanitized = formatted.replace(/\b([a-zA-Z])\b/g, (match, letter: string) => {
      return allowedVariables.has(letter.toLowerCase()) ? match : '';
    });
    if (sanitized !== formatted) {
      console.log(`🔍 Removed unexpected variables; allowed: ${[...allowedVariables].join(', ')}`);
      formatted = sanitized.replace(/\s{2,}/g, ' ').trim();
    }
  }
  return formatted;
}

function extractTeXTokenForFrac(text: string, startIndex: number): { token: string; nextIndex: number } {
  let i = startIndex;
  const isWhitespace = (ch: string) => /\s/.test(ch);

  while (i < text.length && isWhitespace(text[i])) {
    i++;
  }

  if (i >= text.length) {
    return { token: '', nextIndex: i };
  }

  if (text[i] === '{') {
    let depth = 1;
    let j = i + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    return { token: text.slice(i + 1, j - 1), nextIndex: j };
  }

  if (text[i] === '\\') {
    let j = i + 1;
    while (j < text.length && /[a-zA-Z]/.test(text[j])) {
      j++;
    }
    let token = text.slice(i, j);
    if (j < text.length && (text[j] === '(' || text[j] === '{')) {
      const open = text[j];
      const close = open === '(' ? ')' : '}';
      let depth = 1;
      let k = j + 1;
      while (k < text.length && depth > 0) {
        if (text[k] === open) depth++;
        else if (text[k] === close) depth--;
        k++;
      }
      token += text.slice(j, k);
      j = k;
    }
    return { token, nextIndex: j };
  }

  let j = i;
  while (j < text.length && !isWhitespace(text[j]) && text[j] !== '{' && text[j] !== '}') {
    j++;
  }
  return { token: text.slice(i, j), nextIndex: j };
}

function convertLooseFractions(text: string): string {
  let result = '';
  for (let i = 0; i < text.length;) {
    const fracMatch = text.slice(i).match(/^\\[dt]?frac/);
    if (fracMatch) {
      i += fracMatch[0].length;
      const numerator = extractTeXTokenForFrac(text, i);
      const denominator = extractTeXTokenForFrac(text, numerator.nextIndex);
      if (numerator.token && denominator.token) {
        result += `{${numerator.token}/${denominator.token}}`;
        i = denominator.nextIndex;
        continue;
      }
      result += fracMatch[0];
      i = numerator.nextIndex;
      continue;
    }
    result += text[i];
    i++;
  }
  return result;
}

function extractDelimitedContent(
  text: string,
  startIndex: number,
  openChar: string,
  closeChar: string,
): { content: string; nextIndex: number } {
  if (text[startIndex] !== openChar) {
    return { content: '', nextIndex: startIndex };
  }

  let depth = 1;
  let j = startIndex + 1;
  while (j < text.length && depth > 0) {
    if (text[j] === openChar) depth++;
    else if (text[j] === closeChar) depth--;
    j++;
  }

  return { content: text.slice(startIndex + 1, j - 1), nextIndex: j };
}

function convertSqrtExpressions(text: string): string {
  let result = '';
  for (let i = 0; i < text.length;) {
    const sqrtMatch = text.slice(i).match(/^\\+sqrt/);
    if (sqrtMatch) {
      i += sqrtMatch[0].length;

      // Optional root index inside square brackets - skip but preserve expression
      if (text[i] === '[') {
        const { nextIndex } = extractDelimitedContent(text, i, '[', ']');
        i = nextIndex;
      }

      let radicand = '';
      if (text[i] === '{') {
        const extracted = extractDelimitedContent(text, i, '{', '}');
        radicand = extracted.content;
        i = extracted.nextIndex;
      } else {
        let j = i;
        while (
          j < text.length &&
          !/\s/.test(text[j]) &&
          !/[+\-*/=,)]/.test(text[j])
        ) {
          j++;
        }
        radicand = text.slice(i, j);
        i = j;
      }

      radicand = radicand.trim();
      if (radicand) {
        result += `√(${radicand})`;
      } else {
        result += '√';
      }
      continue;
    }

    result += text[i];
    i++;
  }
  return result;
}

const INLINE_FRACTION_PATTERN = /([\p{L}\p{N}√^_]+(?:\([^()]+\))?)\s*\/\s*([\p{L}\p{N}√^_]+(?:\([^()]+\))?)/gu;

function fixStackedDecimals(text: string): string {
  let updated = text;
  // Cases like "5.\n85" -> "5.85"
  updated = updated.replace(/(\d+)\.\s*\n+\s*(\d+)/g, '$1.$2');
  // Cases like "5\n.85" -> "5.85"
  updated = updated.replace(/(\d+)\s*\n+\s*\.(\d+)/g, '$1.$2');
  // Cases like ".\n85" -> ".85"
  updated = updated.replace(/\.\s*\n+\s*(\d+)/g, '.$1');
  return updated;
}

const UNIT_TOKENS = [
  'g', 'gram', 'grams',
  'mol', 'mole', 'moles',
  'm', 'meter', 'meters',
  's', 'sec', 'second', 'seconds',
  'l', 'liter', 'liters',
  'kg', 'cm', 'mm', 'km',
  'pa', 'atm', 'n', 'j',
  'molarity', 'volume',
];

function convertStackedUnits(text: string): string {
  const unitPattern = new RegExp(`\\b(${UNIT_TOKENS.join('|')})\\s*\\n+\\s*(${UNIT_TOKENS.join('|')})\\b`, 'gi');
  return text.replace(unitPattern, (_, top: string, bottom: string) => {
    const normalizedTop = top.trim();
    const normalizedBottom = bottom.trim();
    return `${normalizedTop}/${normalizedBottom}`;
  });
}

function convertStackedQuantityFractions(text: string): string {
  return text.replace(/(\d+(?:\.\d+)?\s*[A-Za-z%°\/]+)\s*\n+\s*(\d+(?:\.\d+)?\s*[A-Za-z%°\/]+)/g, (_match, numerator, denominator) => {
    return `{${numerator.trim()}/${denominator.trim()}}`;
  });
}

function convertInlineSlashFractions(text: string): string {
  if (!text.includes('/')) {
    return text;
  }

  // First, wrap slash fractions even when wrapped in color tags
  text = text.replace(/\[(red|blue|green|yellow|orange|purple):([^\]]+)\]\s*\/\s*\[(red|blue|green|yellow|orange|purple):([^\]]+)\]/gi, (_m, c1, num, c2, den) => {
    return `{[${c1}:${num}]/[${c2}:${den}]}`;
  });
  text = text.replace(/\[(red|blue|green|yellow|orange|purple):([^\]]+)\]\s*\/\s*([A-Za-z0-9_]+)/gi, (_m, c1, num, den) => {
    return `{[${c1}:${num}]/${den}}`;
  });
  text = text.replace(/([A-Za-z0-9_]+)\s*\/\s*\[(red|blue|green|yellow|orange|purple):([^\]]+)\]/gi, (_m, num, c2, den) => {
    return `{${num}/[${c2}:${den}]}`;
  });
  // Wrap common parenthesized expressions over numbers (e.g., (tower + rod)/120)
  text = text.replace(/(\([^()]+\))\s*\/\s*(\d+(?:\.\d+)?)/g, (_m, num, den) => `{${num.trim()}/${den}}`);
  text = text.replace(/(\d+(?:\.\d+)?)\s*\/\s*(\([^()]+\))/g, (_m, num, den) => `{${num}/${den.trim()}}`);

  return text.replace(INLINE_FRACTION_PATTERN, (match, numerator, denominator, offset, fullText) => {
    const before = offset > 0 ? fullText[offset - 1] : '';
    const after = offset + match.length < fullText.length ? fullText[offset + match.length] : '';

    if (before === '{' && after === '}') {
      return match;
    }

    if (!numerator || !denominator) {
      return match;
    }

    return `{${numerator}/${denominator}}`;
  });
}

async function loadSharpModule(): Promise<SharpModule | null> {
  if (!sharpModulePromise) {
    sharpModulePromise = import('sharp')
      .then((module) => {
        const resolved = (module as any).default ?? module;
        return resolved as SharpModule;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('⚠️ Sharp module unavailable; image cropping will be skipped.', message);
        return null;
      });
  }

  return sharpModulePromise;
}

const app = express();
const PORT = 5000;

// Resolve OpenAI configuration with backwards compatibility for legacy env vars
const openaiApiKey = sanitizeEnvValue(process.env.OPENAI_API_KEY);
const openaiBaseURL = process.env.OPENAI_BASE_URL || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

// Resolve Gemini configuration
const geminiApiKey = sanitizeEnvValue(process.env.GEMINI_API_KEY);

// Resolve WolframAlpha configuration
const wolframAlphaAppId = sanitizeEnvValue(process.env.WOLFRAM_ALPHA_APP_ID);

// WolframAlpha API endpoints
const WOLFRAM_SHORT_ANSWER_API = 'https://api.wolframalpha.com/v1/result';
const WOLFRAM_FULL_RESULTS_API = 'https://api.wolframalpha.com/v2/query';
const WOLFRAM_NUMERIC_TOLERANCE = 0.1; // allow small rounding differences

// OpenAI API timeout - prevent indefinite hanging
const OPENAI_TIMEOUT_MS = 45000; // 45 seconds (well under 120s client timeout)

if (!openaiApiKey) {
  console.warn('⚠️ OpenAI API key not configured. Set OPENAI_API_KEY.');
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

  res.json({
    environment: process.env.REPLIT_DEPLOYMENT === '1' ? 'production' : 'development',
    apis: {
      openai: openaiConfigured
        ? 'configured ✅'
        : 'missing ❌ (set OPENAI_API_KEY)'
    },
    ocrMode: openaiConfigured
      ? 'OpenAI GPT-4o Vision with detailed math equation OCR'
      : 'No OCR configured',
    message: openaiConfigured
      ? 'Using OpenAI GPT-4o Vision exclusively for all image analysis with fine-tuned math equation support'
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
      
      const imageUrl = await generateDiagram(diagramDescription);
      
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

// In-memory solution store for regenerated solutions
interface StoredSolution {
  solution: any;
  timestamp: number;
  regenerated: boolean;  // True if this was regenerated via WolframAlpha
}

const solutionStore = new Map<string, StoredSolution>();

// Math eligibility classifier - determines if a problem is suitable for WolframAlpha
function isMathEligible(question: string, subject: string): boolean {
  const mathSubjects = ['mathematics', 'math', 'algebra', 'geometry', 'calculus', 
                        'trigonometry', 'statistics', 'physics', 'chemistry'];
  
  const mathKeywords = [
    'solve', 'calculate', 'find', 'simplify', 'evaluate', 'compute',
    'equation', 'integral', 'derivative', 'limit', 'matrix',
    'factor', 'expand', 'differentiate', 'integrate'
  ];
  
  // Essay-specific phrases (not just "write" which can be math-related)
  const nonMathPhrases = [
    'write an essay', 'write a paragraph', 'write about', 
    'explain in', 'describe how', 'describe why', 'describe the',
    'discuss the', 'analyze the'
  ];
  
  // Check if subject is math-related
  const isMathSubject = mathSubjects.some(s => subject.toLowerCase().includes(s));
  
  // Check for math keywords in question
  const hasMathKeywords = mathKeywords.some(kw => 
    question.toLowerCase().includes(kw)
  );
  
  // Check for non-math phrases (essay questions, etc.)
  const hasNonMathPhrases = nonMathPhrases.some(phrase => 
    question.toLowerCase().includes(phrase)
  );
  
  return (isMathSubject || hasMathKeywords) && !hasNonMathPhrases;
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
  if (!str) {
    return null;
  }

  // Strip color tags like [red:...]
  let cleaned = str.replace(/\[[^\]:]+:([^\]]+)\]/g, '$1');
  // Remove common formatting
  cleaned = cleaned.replace(/[,_\s]/g, '');
  cleaned = cleaned.replace(/[()]/g, '');
  cleaned = cleaned.replace(/[A-Za-z=]/g, ''); // drop variable names/equals, keep signs/digits/slash
  
  // Find the first numeric token (fraction or decimal/int) anywhere in the string
  const tokenMatch = cleaned.match(/[-+]?\d+(?:\.\d+)?(?:\/[-+]?\d+(?:\.\d+)?)?/);
  if (!tokenMatch) {
    return null;
  }
  const numStr = tokenMatch[0];
  
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

function sanitizeForWolfram(text: string): string {
  if (!text) {
    return '';
  }
  return text
    .replace(/\{([^}]+)\}/g, '$1')   // unwrap vertical fraction braces for simpler parsing
    .replace(/°/g, ' degrees ')
    .replace(/∠/g, ' angle ')
    .replace(/×/g, ' * ')
    .replace(/÷/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim();
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
          const safeQuestion = sanitizeForWolfram(subQuestion);
          const wolframUrl = `${WOLFRAM_SHORT_ANSWER_API}?appid=${encodeURIComponent(wolframAlphaAppId)}&i=${encodeURIComponent(safeQuestion)}`;
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
              .replace(/[,_{}]/g, '')
              .replace(/meters?/g, 'm')
              .replace(/seconds?/g, 's');
            
            const normalizedWolfram = wolframAnswer.toLowerCase()
              .replace(/\s+/g, '')
              .replace(/[,_{}]/g, '')
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
                if (Math.abs(proposedNum - wolframNum) <= WOLFRAM_NUMERIC_TOLERANCE) {
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
            const errorBody = await response.text().catch(() => '');
            console.warn(`  ⚠️ Part (${label}): WolframAlpha returned ${response.status} - inconclusive`, errorBody);
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
      const safeQuestion = sanitizeForWolfram(originalQuestion);
      const wolframUrl = `${WOLFRAM_SHORT_ANSWER_API}?appid=${encodeURIComponent(wolframAlphaAppId)}&i=${encodeURIComponent(safeQuestion)}`;
      const response = await fetch(wolframUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'HomeworkHelper/1.0' }
      });
      
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        console.warn(`⚠️ WolframAlpha API returned ${response.status}`, errorBody);
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
        .replace(/[,_{}]/g, '')
        .replace(/meters?/g, 'm')
        .replace(/seconds?/g, 's');
      
      const normalizedWolfram = wolframAnswer.toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[,_{}]/g, '')
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
        if (Math.abs(proposedNum - wolframNum) <= WOLFRAM_NUMERIC_TOLERANCE) {
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

// WolframAlpha solution generation fallback - use when GPT-4o produces invalid output
async function wolframAlphaSolveAndExplain(originalQuestion: string): Promise<any | null> {
  if (!wolframAlphaAppId) {
    console.warn('⚠️ WolframAlpha App ID not configured - cannot generate fallback solution');
    return null;
  }
  
  try {
    console.log('🔧 Attempting WolframAlpha solution generation fallback...');
    
    // Check rate limit
    const canUse = await incrementWolframUsage();
    if (!canUse) {
      console.warn('⚠️ WolframAlpha monthly limit reached');
      return null;
    }
    
    // Try to get step-by-step solution from WolframAlpha Full Results API
    const wolframUrl = `${WOLFRAM_FULL_RESULTS_API}?appid=${encodeURIComponent(wolframAlphaAppId)}&input=${encodeURIComponent(originalQuestion)}&podstate=Result__Step-by-step+solution&format=plaintext&output=json`;
    
    const response = await fetch(wolframUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'HomeworkHelper/1.0' },
      signal: AbortSignal.timeout(15000) // 15 second timeout
    });
    
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.warn(`⚠️ WolframAlpha API returned ${response.status}`, errorBody);
      // If step-by-step isn't available (premium feature), try simple result
      return await wolframAlphaSimpleSolve(originalQuestion);
    }
    
    const data = await response.json();
    
    // Extract step-by-step solution from pods
    const pods = data?.queryresult?.pods || [];
    let steps: string[] = [];
    let finalAnswer = '';
    
    for (const pod of pods) {
      if (pod.id === 'Result' || pod.title?.includes('Result')) {
        const subpods = pod.subpods || [];
        for (const subpod of subpods) {
          if (subpod.title?.includes('Possible intermediate steps') || subpod.plaintext?.includes('Step')) {
            // This is the step-by-step breakdown
            const stepText = subpod.plaintext || '';
            steps = stepText.split('\n').filter((line: string) => line.trim().length > 0);
          } else if (subpod.plaintext) {
            finalAnswer = subpod.plaintext;
          }
        }
      }
    }
    
    if (!finalAnswer && !steps.length) {
      console.warn('⚠️ WolframAlpha did not return usable solution');
      return null;
    }
    
    console.log(`✓ WolframAlpha provided: ${steps.length} steps, final answer: "${finalAnswer}"`);
    
    // Now use GPT-4o to convert WolframAlpha's solution into our formatted step-by-step structure
    return await convertWolframToFormattedSolution(originalQuestion, steps, finalAnswer);
    
  } catch (error) {
    console.error('❌ WolframAlpha solution generation failed:', error);
    return null;
  }
}

// Fallback: Get simple answer from WolframAlpha and have GPT-4o explain it
async function wolframAlphaSimpleSolve(originalQuestion: string): Promise<any | null> {
  try {
    const wolframUrl = `${WOLFRAM_SHORT_ANSWER_API}?appid=${encodeURIComponent(wolframAlphaAppId!)}&i=${encodeURIComponent(originalQuestion)}`;
    
    const response = await fetch(wolframUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'HomeworkHelper/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.warn('⚠️ WolframAlpha simple answer endpoint returned non-200', errorBody);
      return null;
    }
    
    const answer = await response.text();
    console.log(`✓ WolframAlpha simple answer: "${answer}"`);
    
    // Have GPT-4o explain how to arrive at this answer
    return await convertWolframToFormattedSolution(originalQuestion, [], answer);
    
  } catch (error) {
    console.warn('⚠️ WolframAlpha simple solve failed:', error);
    return null;
  }
}

// Convert WolframAlpha solution to our app's formatted structure
async function convertWolframToFormattedSolution(
  originalQuestion: string,
  wolframSteps: string[],
  wolframAnswer: string
): Promise<any> {
  // Build a prompt asking GPT-4o to explain the solution in our format
  const wolframStepsText = wolframSteps.length > 0 
    ? `WolframAlpha provided these steps:\n${wolframSteps.join('\n')}\n\n`
    : '';
  
  const prompt = `You are an expert educational AI tutor. WolframAlpha has solved this problem and provided the correct answer${wolframSteps.length > 0 ? ' with steps' : ''}.

Problem: ${originalQuestion}

${wolframStepsText}Final Answer from WolframAlpha: ${wolframAnswer}

Your task: Create a complete step-by-step solution that explains HOW to arrive at this answer. Follow our standard formatting requirements:

- Use proper color highlighting with [blue:] and [red:] tags
- Break down the solution into clear, numbered steps
- Include explanations for each step
- Make sure the final answer matches WolframAlpha's answer EXACTLY
- Use proper mathematical notation with fractions {num/den} where appropriate
- For multi-part problems, break down the final answer into parts (a), (b), (c), etc.

Respond in valid JSON format matching our solution structure.`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are an expert math tutor creating step-by-step solutions. Always match the provided correct answer." },
      { role: "user", content: prompt }
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
    max_tokens: 4000
  });
  
  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('No response from GPT-4o');
  }
  
  const solution = JSON.parse(content);
  console.log('✓ Converted WolframAlpha solution to formatted structure');
  
  return solution;
}

// Detect if AI-generated solution is corrupted or mathematically invalid
function isInvalidSolution(solution: any): { isInvalid: boolean; reason: string } {
  // Check 1: Missing required fields
  if (!solution || !solution.finalAnswer || !solution.steps || !Array.isArray(solution.steps)) {
    return { isInvalid: true, reason: 'Missing required solution fields' };
  }
  
  // Check 2: Detect garbage text patterns in solution
  const fullText = JSON.stringify(solution).toLowerCase();
  const garbagePatterns = [
    /invalid\s+excess\s+duplicate\s+rendering/i,
    /truthident/i,
    /corrupt/i,
    /\[object\s+object\]/i,
    /undefined/gi,
    /null\s+reference/i
  ];
  
  for (const pattern of garbagePatterns) {
    if (pattern.test(fullText)) {
      return { isInvalid: true, reason: `Corrupted output detected (matched: ${pattern})` };
    }
  }
  
  // Check 3: Detect mathematical contradictions in steps
  // NOTE: Be very conservative here - only catch ACTUAL contradictions, not valid intermediate steps
  const contradictionPatterns = [
    /false\s*=\s*true/i,
    /true\s*=\s*false/i,
    /impossible\s+to\s+solve/i,
    /cannot\s+be\s+solved/i,
    /no\s+solution\s+exists/i
  ];
  
  for (const step of solution.steps) {
    const stepText = (step.content || '') + (step.title || '');
    for (const pattern of contradictionPatterns) {
      if (pattern.test(stepText)) {
        return { isInvalid: true, reason: `Mathematical contradiction detected: ${pattern}` };
      }
    }
  }
  
  // Check 4: Solution too short (likely incomplete)
  if (solution.steps.length === 0 || (solution.steps.length === 1 && solution.steps[0].content.length < 20)) {
    return { isInvalid: true, reason: 'Solution suspiciously short (likely incomplete)' };
  }
  
  // Check 5: Final answer is empty or just punctuation
  // Handle case where finalAnswer exists but is not a string
  if (typeof solution.finalAnswer !== 'string') {
    return { isInvalid: true, reason: 'Final answer is not a string (got ' + typeof solution.finalAnswer + ')' };
  }

  const trimmedFinal = solution.finalAnswer.trim();
  if (trimmedFinal.length === 0 || /^[\s.,;:!?-]+$/.test(trimmedFinal)) {
    return { isInvalid: true, reason: 'Final answer contains no meaningful content' };
  }

  // Check 6: Measurement answers should not be negative
  const measurementUnits = /\b(cm|mm|m|meter|meters|km|kilometer|kilometers|in|inch|inches|ft|foot|feet|yd|yard|yards|mile|miles|unit|units)\b/i;
  const measurementKeywords = ['length', 'distance', 'perimeter', 'circumference', 'radius', 'diameter', 'side', 'segment', 'line', 'height', 'width'];
  const hasMeasurementContext =
    measurementUnits.test(trimmedFinal) ||
    measurementKeywords.some((keyword) => trimmedFinal.toLowerCase().includes(keyword));
  if (hasMeasurementContext) {
    const negativeNumberPattern = /(^|[^0-9])-\s*\d+(\.\d+)?/;
    if (negativeNumberPattern.test(trimmedFinal)) {
      return { isInvalid: true, reason: 'Negative measurement detected in final answer' };
    }
  }
  
  const cleanAnswer = solution.finalAnswer.replace(/[^\w\d]/g, '');
  if (cleanAnswer.length < 2) {
    return { isInvalid: true, reason: 'Final answer is empty or invalid' };
  }
  
  return { isInvalid: false, reason: '' };
}

// Cleanup old verifications and solutions after 1 hour
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  
  // Clean verification store
  for (const [id, data] of verificationStore.entries()) {
    if (data.timestamp < oneHourAgo) {
      verificationStore.delete(id);
    }
  }
  
  // Clean solution store
  for (const [id, data] of solutionStore.entries()) {
    if (data.timestamp < oneHourAgo) {
      solutionStore.delete(id);
    }
  }
}, 5 * 60 * 1000);

/**
 * STEM CONTENT DETECTION - Analyzes extracted text to determine if it's STEM content
 *
 * Returns true if the text contains strong STEM indicators (math, science, equations).
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesProblemStart(problemNumber: string, text: string): boolean {
  if (!problemNumber || !text) {
    return false;
  }

  const normalizedProblem = problemNumber.trim().toLowerCase();
  if (!normalizedProblem) {
    return false;
  }

  const lowerText = text.trim().toLowerCase();
  if (!lowerText) {
    return false;
  }

  const sanitizedProblem = normalizedProblem.replace(/[^a-z0-9]/g, '');
  if (!sanitizedProblem) {
    return false;
  }

  const escapedFull = escapeRegExp(normalizedProblem);
  const patterns: RegExp[] = [
    new RegExp(`^(?:problem\\s+)?#?${escapedFull}(?=\\b|\\s|[).:-]|$)`),
    new RegExp(`^(?:problem\\s+)?#?${escapedFull}\\s*[).:-]`)
  ];

  const digitMatch = sanitizedProblem.match(/^(\d{1,3})/);
  const numericPrefix = digitMatch ? digitMatch[1] : '';
  const suffix = numericPrefix ? sanitizedProblem.slice(numericPrefix.length) : '';

  if (numericPrefix) {
    const escapedDigits = escapeRegExp(numericPrefix);
    patterns.push(new RegExp(`^(?:problem\\s+)?#?${escapedDigits}(?!\\d)(?=\\b|\\s|[).:-]|$)`));
    patterns.push(new RegExp(`^(?:problem\\s+)?#?${escapedDigits}\\s*[).:-]`));
    patterns.push(new RegExp(`^[\[(\s]*${escapedDigits}[)\]]?(?=\\s|[).:-]|$)`));

    if (suffix) {
      const escapedSuffix = escapeRegExp(suffix);
      patterns.push(new RegExp(`^(?:problem\\s+)?#?${escapedDigits}${escapedSuffix}(?=\\b|\\s|[).:-]|$)`));
      patterns.push(new RegExp(`^(?:problem\\s+)?#?${escapedDigits}\\s*${escapedSuffix}(?=\\b|\\s|[).:-]|$)`));
      patterns.push(new RegExp(`^[\[(\s]*${escapedDigits}${escapedSuffix}[)\]]?(?=\\s|[).:-]|$)`));
    } else {
      patterns.push(new RegExp(`^#?${escapedDigits}(?!\\d)(?=\\b|\\s|[).:-]|$)`));
    }
  }

  const sanitizedText = lowerText.replace(/[^a-z0-9]/g, '');

  const passesSanitizedCheck = (target: string) => {
    if (!target) {
      return false;
    }

    const prefixes = [target, `problem${target}`, `problemno${target}`, `prob${target}`, `#${target}`];

    return prefixes.some((prefix) => {
      if (!prefix || !sanitizedText.startsWith(prefix)) {
        return false;
      }

      const nextChar = sanitizedText.charAt(prefix.length);
      return nextChar ? !/\d/.test(nextChar) : true;
    });
  };

  return (
    patterns.some((pattern) => pattern.test(lowerText)) ||
    passesSanitizedCheck(sanitizedProblem) ||
    passesSanitizedCheck(numericPrefix)
  );
}

function extractLeadingProblemNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^(?:problem\s+)?#?(\d{1,3})(?=(?:\s|$|[).:-]|[a-z]))/i);
  if (match) {
    return Number.parseInt(match[1], 10);
  }

  return null;
}

function isDivider(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }

  if (/^[-=_]{3,}$/u.test(trimmed.replace(/\s+/g, ''))) {
    return true;
  }

  return false;
}

function extractProblemBoundingRegion(problemNumber: string, boxes: OcrBoundingBox[]): ProblemBoundingRegion | null {
  if (!problemNumber || boxes.length === 0) {
    return null;
  }

  const relevantBoxes = boxes
    .filter((box) => box.text && box.text.trim().length > 0)
    .sort((a, b) => {
      if (a.pageIndex !== b.pageIndex) {
        return a.pageIndex - b.pageIndex;
      }
      if (a.top !== b.top) {
        return a.top - b.top;
      }
      return a.left - b.left;
    });

  if (relevantBoxes.length === 0) {
    return null;
  }

  const startIndex = relevantBoxes.findIndex((box) => matchesProblemStart(problemNumber, box.text));
  if (startIndex === -1) {
    return null;
  }

  const collected: OcrBoundingBox[] = [relevantBoxes[startIndex]];
  const referencePage = collected[0].pageIndex;
  const targetNumber = extractLeadingProblemNumber(relevantBoxes[startIndex].text) ?? Number.parseInt(problemNumber, 10);

  for (let i = startIndex + 1; i < relevantBoxes.length; i++) {
    const candidate = relevantBoxes[i];

    if (candidate.pageIndex !== referencePage) {
      break;
    }

    if (isDivider(candidate.text)) {
      break;
    }

    const candidateNumber = extractLeadingProblemNumber(candidate.text);
    if (candidateNumber !== null && !Number.isNaN(targetNumber)) {
      if (candidateNumber > targetNumber) {
        break;
      }

      if (candidateNumber === targetNumber && matchesProblemStart(problemNumber, candidate.text)) {
        collected.push(candidate);
        continue;
      }

      if (candidateNumber !== targetNumber) {
        break;
      }
    }

    collected.push(candidate);
  }

  if (collected.length === 0) {
    return null;
  }

  let top = Number.POSITIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;

  for (const box of collected) {
    top = Math.min(top, box.top);
    left = Math.min(left, box.left);
    bottom = Math.max(bottom, box.bottom);
    right = Math.max(right, box.right);
  }

  if (!Number.isFinite(top) || !Number.isFinite(bottom) || !Number.isFinite(left) || !Number.isFinite(right)) {
    return null;
  }

  const pageHeight = collected[0].pageHeight ?? null;
  const expandedTop = Math.max(0, top - 12);
  const expandedBottom = pageHeight != null ? Math.min(pageHeight, bottom + 12) : bottom + 12;

  const combinedText = collected.map((box) => box.text.trim()).join('\n');

  return {
    combinedText,
    boundingBox: {
      top: expandedTop,
      left,
      bottom: expandedBottom,
      right,
      pageWidth: collected[0].pageWidth ?? null,
      pageHeight: collected[0].pageHeight ?? null,
      pageIndex: referencePage
    }
  };
}

function looksLikeProblemHeader(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (/^(?:problem\s+)?#?\d{1,3}\s*[).:-]/u.test(normalized)) {
    return true;
  }

  if (/^(?:problem\s+)?#?\d{1,3}[a-z]/u.test(normalized)) {
    return true;
  }

  if (/^(?:problem\s+)?#?\d{1,3}\b/u.test(normalized)) {
    const remainder = normalized.replace(/^(?:problem\s+)?#?\d{1,3}\b\s*/u, '');
    return remainder.length > 0;
  }

  const sanitized = normalized.replace(/[^a-z0-9]/g, '');
  const numericPrefix = sanitized.match(/^(\d{1,3})/);
  if (numericPrefix) {
    const nextChar = sanitized.charAt(numericPrefix[1].length);
    if (!nextChar || !/\d/.test(nextChar)) {
      return true;
    }
  }

  return false;
}

function extractProblemTextFallback(problemNumber: string, rawText: string): string | null {
  const normalizedProblem = problemNumber?.trim();
  if (!normalizedProblem || !rawText) {
    return null;
  }

  const targetNumber = Number.parseInt(normalizedProblem, 10);
  const lines = rawText.replace(/\r/g, '').split('\n');
  if (lines.length === 0) {
    return null;
  }

  const trimmedLines = lines.map((line) => line.trim());
  let startIndex = trimmedLines.findIndex((line) => matchesProblemStart(normalizedProblem, line));

  if (startIndex === -1 && !Number.isNaN(targetNumber)) {
    const altPattern = new RegExp(`(^|\\s)(?:problem\\s*)?#?${targetNumber}(?=\\s|[).:-]|[a-z])`, 'i');
    startIndex = trimmedLines.findIndex((line) => altPattern.test(line));
  }

  if (startIndex === -1) {
    return null;
  }

  const collected: string[] = [];
  let blankRun = 0;
  const MAX_LINES = 25;

  for (let i = startIndex; i < trimmedLines.length && collected.length < MAX_LINES; i++) {
    const trimmed = trimmedLines[i];

    if (!trimmed) {
      blankRun++;
      if (collected.length === 0) {
        continue;
      }
      if (blankRun >= 2) {
        break;
      }
      collected.push('');
      continue;
    }

    blankRun = 0;

    if (i > startIndex) {
      const candidateNumber = extractLeadingProblemNumber(trimmed);
      if (
        candidateNumber !== null &&
        candidateNumber !== Number.parseInt(normalizedProblem, 10) &&
        looksLikeProblemHeader(trimmed)
      ) {
        break;
      }
    }

    collected.push(trimmedLines[i]);

    if (collected.join('\n').length >= 2000) {
      break;
    }
  }

  const combined = collected.join('\n').trim();
  return combined.length > 0 ? combined : null;
}

/**
 * Uses GPT-4o Vision to locate a specific problem number and return normalized bounding box coordinates
 * Returns coordinates as percentages (0-1) for easier cropping
 */
async function locateProblemWithVision(imageUri: string, problemNumber: string): Promise<{
  top: number;
  left: number;
  bottom: number;
  right: number;
} | null> {
  if (!openai) {
    console.warn('⚠️ OpenAI client not available for vision-based problem location');
    return null;
  }

  try {
    console.log(`📍 Using GPT-4o Vision to locate problem #${problemNumber}...`);
    
    const locatorPrompt = `You are a precise problem locator for homework images. Your task is to identify the EXACT location of a specific problem number on the page.

CRITICAL TASK:
Find problem #${problemNumber} in this image and return its bounding box coordinates.

INSTRUCTIONS:
1. Locate problem #${problemNumber} (look for markers like "#${problemNumber}", "Problem ${problemNumber}", "${problemNumber}.", "${problemNumber})")
2. Identify the FULL extent of this problem including:
   - The problem number/label
   - All parts of the question (a, b, c, etc.)
   - Any equations, diagrams, or figures that are part of THIS problem
   - Stop at the next problem number or clear divider
3. Return NORMALIZED coordinates (0.0 to 1.0 range) where:
   - 0.0 = top/left edge of image
   - 1.0 = bottom/right edge of image
   - Example: top: 0.25 means 25% down from top

RESPONSE FORMAT (JSON only):
{
  "found": true,
  "problemNumber": "${problemNumber}",
  "boundingBox": {
    "top": 0.15,
    "left": 0.10,
    "bottom": 0.35,
    "right": 0.90
  }
}

If problem #${problemNumber} is NOT found:
{
  "found": false,
  "problemNumber": "${problemNumber}",
  "error": "Problem #${problemNumber} not visible in image"
}

CRITICAL: Respond with ONLY valid JSON. No markdown, no explanations.`;

    const response = await openai.chat.completions.create(
      {
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: locatorPrompt },
              {
                type: "image_url",
                image_url: {
                  url: imageUri,
                  detail: "high" // High detail for accurate location
                }
              }
            ]
          }
        ],
        temperature: 0.1, // Low temperature for consistent location
        max_tokens: 300
      },
      { timeout: OPENAI_TIMEOUT_MS }
    );

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      console.warn('⚠️ GPT-4o Vision returned empty response for problem location');
      return null;
    }

    // Parse JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : content;
    const result = JSON.parse(jsonStr);

    if (!result.found || !result.boundingBox) {
      console.log(`⚠️ Problem #${problemNumber} not found by GPT-4o Vision:`, result.error);
      return null;
    }

    const { top, left, bottom, right } = result.boundingBox;
    
    // Validate coordinates are in valid range
    if (top < 0 || top > 1 || left < 0 || left > 1 || bottom < 0 || bottom > 1 || right < 0 || right > 1) {
      console.warn('⚠️ Invalid coordinates returned by GPT-4o Vision:', result.boundingBox);
      return null;
    }

    if (top >= bottom || left >= right) {
      console.warn('⚠️ Invalid bounding box dimensions:', result.boundingBox);
      return null;
    }

    console.log(`✅ Problem #${problemNumber} located at: top=${(top*100).toFixed(1)}%, left=${(left*100).toFixed(1)}%, bottom=${(bottom*100).toFixed(1)}%, right=${(right*100).toFixed(1)}%`);
    
    return { top, left, bottom, right };
  } catch (error) {
    console.error('❌ Error locating problem with GPT-4o Vision:', error);
    return null;
  }
}

/**
 * Crops image using normalized coordinates (0-1 range)
 */
async function cropImageWithNormalizedCoords(imageDataUri: string, coords: {
  top: number;
  left: number;
  bottom: number;
  right: number;
}): Promise<string | null> {
  if (!imageDataUri || !imageDataUri.startsWith('data:')) {
    console.warn('⚠️ Cannot crop image: image URI is not a data URI');
    return null;
  }

  const match = imageDataUri.match(/^data:(.+);base64,(.*)$/);
  if (!match) {
    console.warn('⚠️ Cannot crop image: data URI is malformed');
    return null;
  }

  const [, mimeType, base64Data] = match;

  try {
    const sharpModule = await loadSharpModule();
    if (!sharpModule) {
      return null;
    }

    const imageBuffer = Buffer.from(base64Data, 'base64');
    const metadata = await sharpModule(imageBuffer).metadata();

    const imageWidth = metadata.width;
    const imageHeight = metadata.height;

    if (!imageWidth || !imageHeight) {
      console.warn('⚠️ Unable to read image dimensions for cropping');
      return null;
    }

    // Convert normalized coordinates to pixels
    const left = Math.max(0, Math.floor(coords.left * imageWidth));
    const top = Math.max(0, Math.floor(coords.top * imageHeight));
    const right = Math.min(imageWidth, Math.ceil(coords.right * imageWidth));
    const bottom = Math.min(imageHeight, Math.ceil(coords.bottom * imageHeight));

    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);

    console.log(`✂️ Cropping image: ${imageWidth}x${imageHeight} → region at (${left},${top}) size ${width}x${height}`);

    const croppedBuffer = await sharpModule(imageBuffer)
      .extract({ left, top, width, height })
      .toBuffer();

    return `data:${mimeType};base64,${croppedBuffer.toString('base64')}`;
  } catch (error) {
    console.warn('⚠️ Failed to crop image:', error);
    return null;
  }
}

async function cropImageToBoundingBox(imageDataUri: string, region: ProblemBoundingRegion['boundingBox']): Promise<string | null> {
  if (!imageDataUri || !imageDataUri.startsWith('data:')) {
    console.warn('⚠️ Cannot crop image: image URI is not a data URI');
    return null;
  }

  const match = imageDataUri.match(/^data:(.+);base64,(.*)$/);
  if (!match) {
    console.warn('⚠️ Cannot crop image: data URI is malformed');
    return null;
  }

  const [, mimeType, base64Data] = match;

  try {
    const sharpModule = await loadSharpModule();
    if (!sharpModule) {
      return null;
    }

    const imageBuffer = Buffer.from(base64Data, 'base64');
    const metadata = await sharpModule(imageBuffer).metadata();

    const imageWidth = metadata.width;
    const imageHeight = metadata.height;

    if (!imageWidth || !imageHeight) {
      console.warn('⚠️ Unable to read image dimensions for cropping');
      return null;
    }

    const scaleX = region.pageWidth ? imageWidth / region.pageWidth : 1;
    const scaleY = region.pageHeight ? imageHeight / region.pageHeight : 1;

    const left = Math.max(0, Math.floor(region.left * scaleX));
    const top = Math.max(0, Math.floor(region.top * scaleY));
    const right = Math.min(imageWidth, Math.ceil(region.right * scaleX));
    const bottom = Math.min(imageHeight, Math.ceil(region.bottom * scaleY));

    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);

    const croppedBuffer = await sharpModule(imageBuffer)
      .extract({ left, top, width, height })
      .toBuffer();

    return `data:${mimeType};base64,${croppedBuffer.toString('base64')}`;
  } catch (error) {
    console.warn('⚠️ Failed to crop image to problem bounding box:', error);
    return null;
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
- Preserve equations, symbols, layout, and the author's original notation style.
- Fix common OCR errors:
  - Replace ".5" with "0.5", "5 ." with "5.0"
  - Convert "O"<->"0", "l"<->"1", "S"<->"5" using context
  - Detect and separate variables from numbers (e.g., "3x" not "3 x")
  - Add missing negative signs or decimals if context implies them
- Use the same notation as the source (fractions with '/', decimals with '.', etc.).
- NEVER introduce LaTeX commands (like \\frac, \\sqrt, superscript braces, etc.) unless they already appear in the source.
- Maintain balanced parentheses, operators, and exponents.
- No commentary or explanations—return only corrected text.

If any token looks uncertain or inconsistent, pick the version that best preserves mathematical sense while remaining faithful to the printed notation.`

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

async function performTargetedProblemOcr(imageUri: string, problemNumber: string): Promise<TargetedOcrResult | null> {
  if (!problemNumber || !openai) {
    return null;
  }

  const diagnostics: string[] = [];
  let normalizedBox: TargetedOcrResult['boundingBox'] | undefined;
  let workingImage = imageUri;
  let croppedImageUri: string | null = null;

  try {
    const located = await locateProblemWithVision(imageUri, problemNumber);
    if (located) {
      normalizedBox = located;
      diagnostics.push(
        `Locator bounding box: top ${(located.top * 100).toFixed(1)}%, left ${(located.left * 100).toFixed(1)}%, bottom ${(located.bottom * 100).toFixed(1)}%, right ${(located.right * 100).toFixed(1)}%`
      );
      const cropped = await cropImageWithNormalizedCoords(imageUri, located);
      if (cropped) {
        workingImage = cropped;
        croppedImageUri = cropped;
        diagnostics.push('Image cropped to located problem region for OCR');
      } else {
        diagnostics.push('Cropping failed, falling back to full image for OCR');
      }
    } else {
      diagnostics.push('Problem locator could not find the requested number; using full image for OCR');
    }
  } catch (error) {
    diagnostics.push(`Problem locator error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    console.warn('⚠️ Vision locator failed before OCR:', error);
  }

  try {
    console.log(`[OCR] Running targeted transcription for problem #${problemNumber}...`);
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a meticulous OCR transcription engine for math textbooks. 
Transcribe the requested problem EXACTLY as printed, preserving punctuation, variables, fractions, and line breaks. 
Do not solve or summarize. Respond using strict JSON as instructed.`
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Transcribe ONLY problem #${problemNumber}. 
Start at its number/label and include all lines (parts a/b/c, diagrams descriptions, conditions) until the next numbered problem starts.
You must return the text EXACTLY as printed (same symbols, same fraction style, no LaTeX conversion, no reformatting).
If #${problemNumber} is missing, respond with {"found":false,"problemNumber":"${problemNumber}","error":"reason","problemsVisible":["list","of","numbers"]}.
When it is found, respond with {"found":true,"problemNumber":"${problemNumber}","transcription":"full text","problemsVisible":["numbers you can see"]}.`
            },
            {
              type: "image_url",
              image_url: {
                url: workingImage,
                detail: "high"
              }
            }
          ]
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 1024,
    });

    const rawContent = response.choices[0]?.message?.content ?? '{}';
    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch (parseError) {
      diagnostics.push('OCR returned invalid JSON payload');
      console.error('❌ Targeted OCR returned invalid JSON:', rawContent);
      return {
        transcription: null,
        diagnostics,
        boundingBox: normalizedBox,
        croppedImageUri
      };
    }

    if (!parsed || typeof parsed !== 'object') {
      diagnostics.push('OCR response missing structured fields');
      return {
        transcription: null,
        diagnostics,
        boundingBox: normalizedBox,
        croppedImageUri
      };
    }

    if (parsed.problemsVisible?.length) {
      diagnostics.push(`Visible problems: ${parsed.problemsVisible.join(', ')}`);
    }

    if (!parsed.found) {
      diagnostics.push(parsed.error ? `OCR: ${parsed.error}` : 'OCR could not locate requested problem');
      return {
        transcription: null,
        diagnostics,
        boundingBox: normalizedBox,
        croppedImageUri
      };
    }

    let transcription = typeof parsed.transcription === 'string' ? parsed.transcription.trim() : '';
    if (!transcription) {
      diagnostics.push('OCR returned empty transcription');
      return {
        transcription: null,
        diagnostics,
        boundingBox: normalizedBox,
        croppedImageUri
      };
    }

    const corrected = await correctOcrText(transcription);
    if (corrected && corrected.trim()) {
      if (corrected.trim() !== transcription) {
        diagnostics.push('OCR transcription corrected for math/notation consistency');
      }
      transcription = corrected.trim();
    }

    diagnostics.push(`OCR transcription captured (${transcription.length} chars)`);
    return {
      transcription,
      diagnostics,
      boundingBox: normalizedBox,
      croppedImageUri
    };
  } catch (error) {
    diagnostics.push(`OCR error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    console.warn('⚠️ Targeted OCR failed:', error);
    return {
      transcription: null,
      diagnostics,
      boundingBox: normalizedBox,
      croppedImageUri
    };
  }
}

// Diagram cache for avoiding regeneration of identical diagrams
interface DiagramCacheEntry {
  url: string;
  timestamp: number;
  size: string;
  visualType: string;
}

const GEMINI_IMAGE_MODEL = 'gemini-1.5-flash-latest';
type DiagramSize = '1024x1024';

const diagramCache = new Map<string, DiagramCacheEntry>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Cache statistics for monitoring performance
let cacheStats = {
  hits: 0,
  misses: 0,
  totalRequests: 0
};

async function generateDiagram(description: string): Promise<string> {
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
    
    const diagramPrompt = `MANDATORY NUMBER FORMAT: USE PERIODS FOR DECIMALS - WRITE 14.14 NOT 14,14 - WRITE 3.92 NOT 3,92 - WRITE 10.2 NOT 10,2. Educational ${visualType}: ${cleanDescription}. ${styleGuide} White background, black lines, labeled clearly. ABSOLUTE REQUIREMENT: ALL DECIMAL NUMBERS USE PERIOD SEPARATORS (.) - AMERICAN/ENGLISH FORMAT ONLY - NEVER USE COMMAS (,) IN NUMBERS. Examples: 14.14, 3.92, 10.2, 19.6. IMPORTANT: Leave generous margins (at least 10% padding) on all sides - do not place any content or labels near the edges. Center the main content with plenty of space around it. REMINDER: Decimals use PERIODS not commas.`;
    
    try {
      const response = await openai.images.generate({
        model: "gpt-image-1",
        prompt: diagramPrompt,
        size: size,
        n: 1
      });
      
      const b64Data = response.data?.[0]?.b64_json;
      if (b64Data) {
        return saveDiagramImage(b64Data, visualType, size, cacheKey);
      }
      
      console.log('✗ No image data returned from OpenAI');
    } catch (openaiError) {
      console.warn('⚠️ OpenAI image generation failed:', openaiError?.message || openaiError);
      if (shouldFallbackToGemini(openaiError)) {
        const fallbackUrl = await generateDiagramWithGemini({
          cleanDescription,
          visualType,
          size,
          cacheKey,
          styleGuide,
          prompt: diagramPrompt
        });
        if (fallbackUrl) {
          return fallbackUrl;
        }
      } else {
        throw openaiError;
      }
    }
    
    if (geminiApiKey) {
      const fallbackUrl = await generateDiagramWithGemini({
        cleanDescription,
        visualType,
        size,
        cacheKey,
        styleGuide,
        prompt: diagramPrompt
      });
      if (fallbackUrl) {
        return fallbackUrl;
      }
    }
    
    // Local SVG fallback so users always get a diagram (even without image-model access)
    const localDiagram = generateLocalPlaceholderDiagram(visualType, cleanDescription, size);
    if (localDiagram) {
      return saveDiagramImage(localDiagram, visualType, size, cacheKey, 'svg');
    }
    
    return '';
  } catch (error) {
    console.error('Error generating diagram:', error);
    return '';
  }
}

function shouldFallbackToGemini(error: any): boolean {
  if (!error) {
    return false;
  }
  const status = error?.status ?? error?.code;
  const message = (error?.message || '').toString().toLowerCase();
  if (status === 403) {
    return true;
  }
  return (
    message.includes('permission denied') ||
    message.includes('verify organization') ||
    message.includes('gpt-image-1')
  );
}

async function generateDiagramWithGemini(options: {
  cleanDescription: string;
  visualType: string;
  size: DiagramSize;
  cacheKey: string;
  styleGuide: string;
  prompt: string;
}): Promise<string> {
  if (!geminiAI) {
    console.warn('?? Gemini API key not configured; cannot generate diagram fallback.');
    return '';
  }

  try {
    const model = geminiAI.getGenerativeModel({
      model: GEMINI_IMAGE_MODEL
    });

    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `${options.prompt}

Diagram requirements: ${options.styleGuide}. Focus on: ${options.cleanDescription}`
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: 'image/png',
        temperature: 0.2
      }
    });

    const inlineData =
      result.response?.candidates?.[0]?.content?.parts?.find(
        (part: any) => part?.inlineData?.data
      )?.inlineData?.data;

    if (!inlineData) {
      console.warn('?? Gemini response did not contain inline image data.');
      return '';
    }

    console.log('?? Gemini fallback succeeded.');
    return saveDiagramImage(inlineData, options.visualType, options.size, options.cacheKey);
  } catch (error) {
    console.error('?? Gemini fallback failed:', error);
    return '';
  }
}

function generateLocalPlaceholderDiagram(visualType: string, cleanDescription: string, size: DiagramSize): string {
  const [width, height] = size.split('x').map((n) => parseInt(n, 10) || 1024);

  // Only build placeholders for common subjects; fallback is physics trajectory sketch or right-triangle trig
  const lowerDesc = cleanDescription.toLowerCase();
  const isProjectile = visualType === 'physics' || lowerDesc.includes('projectile');
  const isTrigTriangle = visualType === 'geometry' || lowerDesc.includes('trigonometry') || lowerDesc.includes('triangle') || lowerDesc.includes('right triangle');
  if (!isProjectile && !isTrigTriangle) {
    return '';
  }

  if (isTrigTriangle) {
    const angleMatch = cleanDescription.match(/(\d+(?:\.\d+)?)\s*°/);
    const angle = angleMatch ? angleMatch[1] : 'θ';
    const baseMatch = cleanDescription.match(/(\d+(?:\.\d+)?)\s*m\b/i);
    const baseValue = baseMatch ? `${baseMatch[1]} m` : 'base';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,4 L0,8 z" fill="#111" />
    </marker>
  </defs>
  <rect width="${width}" height="${height}" fill="white"/>
  <polygon points="${width * 0.15},${height * 0.75} ${width * 0.8},${height * 0.75} ${width * 0.15},${height * 0.2}" fill="none" stroke="#111" stroke-width="4"/>
  <rect x="${width * 0.15 - 8}" y="${height * 0.75 - 8}" width="16" height="16" fill="#111"/>
  <line x1="${width * 0.15}" y1="${height * 0.75}" x2="${width * 0.8}" y2="${height * 0.75}" stroke="#111" stroke-width="4" marker-end="url(#arrow)"/>
  <line x1="${width * 0.15}" y1="${height * 0.75}" x2="${width * 0.15}" y2="${height * 0.2}" stroke="#111" stroke-width="4" marker-end="url(#arrow)"/>
  <text x="${width * 0.4}" y="${height * 0.82}" font-size="36" fill="#111">${baseValue}</text>
  <text x="${width * 0.07}" y="${height * 0.45}" font-size="36" fill="#111" transform="rotate(-90 ${width * 0.07} ${height * 0.45})">height</text>
  <text x="${width * 0.45}" y="${height * 0.42}" font-size="36" fill="#111">hypotenuse</text>
  <path d="M ${width * 0.17} ${height * 0.72} A 60 60 0 0 1 ${width * 0.28} ${height * 0.75}" fill="none" stroke="#ef4444" stroke-width="3"/>
  <text x="${width * 0.19}" y="${height * 0.65}" font-size="34" fill="#ef4444">θ = ${angle}°</text>
</svg>`;
    return svg;
  }

  const angleMatch = cleanDescription.match(/(\d+(?:\.\d+)?)\s*°/);
  const speedMatch = cleanDescription.match(/(\d+(?:\.\d+)?)\s*(?:m\/s|meters\/s|mps|meters per second)/i);
  const angle = angleMatch ? angleMatch[1] : '45';
  const speed = speedMatch ? speedMatch[1] : 'v₀';

  // Arc geometry
  const sx = width * 0.1;
  const sy = height * 0.85;
  const ex = width * 0.9;
  const ey = height * 0.85;
  const cx = width * 0.45;
  const cy = height * 0.25;

  // Apex along quadratic Bezier (min y)
  const tyNum = sy - cy;
  const tyDen = sy - 2 * cy + ey;
  let ty = tyDen !== 0 ? tyNum / tyDen : 0.5;
  if (ty < 0 || ty > 1 || Number.isNaN(ty)) {
    ty = 0.5;
  }
  const apexX = (1 - ty) ** 2 * sx + 2 * (1 - ty) * ty * cx + ty ** 2 * ex;
  const apexY = (1 - ty) ** 2 * sy + 2 * (1 - ty) * ty * cy + ty ** 2 * ey;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,4 L0,8 z" fill="#111" />
    </marker>
  </defs>
  <rect width="${width}" height="${height}" fill="white"/>
  <line x1="${width * 0.08}" y1="${height * 0.85}" x2="${width * 0.92}" y2="${height * 0.85}" stroke="#111" stroke-width="3" marker-end="url(#arrow)"/>
  <line x1="${width * 0.1}" y1="${height * 0.9}" x2="${width * 0.1}" y2="${height * 0.08}" stroke="#111" stroke-width="3" marker-end="url(#arrow)"/>
  <path d="M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}" fill="none" stroke="#3b82f6" stroke-width="4"/>
  <line x1="${apexX}" y1="${apexY}" x2="${apexX}" y2="${sy}" stroke="#ef4444" stroke-width="2" stroke-dasharray="10,8"/>
  <line x1="${sx}" y1="${sy + 10}" x2="${ex}" y2="${ey + 10}" stroke="#111" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="${width * 0.12}" y="${height * 0.81}" font-size="32" fill="#111">launch</text>
  <text x="${width * 0.12}" y="${height * 0.97}" font-size="32" fill="#111">x</text>
  <text x="${width * 0.015}" y="${height * 0.12}" font-size="32" fill="#111">y</text>
  <text x="${width * 0.32}" y="${height * 0.35}" font-size="38" fill="#ef4444">θ = ${angle}°</text>
  <text x="${width * 0.32}" y="${height * 0.42}" font-size="38" fill="#ef4444">v₀ = ${speed} m/s</text>
  <circle cx="${sx}" cy="${sy}" r="10" fill="#111"/>
  <circle cx="${apexX}" cy="${apexY}" r="10" fill="#ef4444"/>
  <text x="${apexX + 14}" y="${apexY - 12}" font-size="32" fill="#ef4444">max height</text>
  <circle cx="${ex}" cy="${ey}" r="10" fill="#111"/>
  <text x="${(sx + ex) / 2 - 40}" y="${sy + 45}" font-size="32" fill="#111">range</text>
</svg>`;

  return svg;
}

function saveDiagramImage(
  data: string,
  visualType: string,
  size: DiagramSize,
  cacheKey: string,
  format: 'png' | 'svg' = 'png'
): string {
  const diagramsDir = path.join(process.cwd(), 'public', 'diagrams');
  if (!fs.existsSync(diagramsDir)) {
    fs.mkdirSync(diagramsDir, { recursive: true });
  }

  const hash = cacheKey.substring(0, 8);
  const filename = `${visualType}-${size.replace('x', '-')}-${hash}.${format}`;
  const filepath = path.join(diagramsDir, filename);
  const buffer = format === 'svg' ? Buffer.from(data, 'utf-8') : Buffer.from(data, 'base64');
  fs.writeFileSync(filepath, buffer);

  const apiPath = `/api/diagram-file/${filename}`;

  diagramCache.set(cacheKey, {
    url: apiPath,
    timestamp: Date.now(),
    size,
    visualType
  });

  console.log(`🎨 ${visualType} (${size}) saved and cached:`, apiPath);
  return apiPath;
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
  
  // Remove inline math delimiters while preserving contents
  formatted = formatted.replace(/\\\(/g, '').replace(/\\\)/g, '');
  formatted = formatted.replace(/\\\[/g, '').replace(/\\\]/g, '');
  formatted = formatted.replace(/\$\$/g, '').replace(/\$/g, '');
  
  // 0A. CRITICAL: Convert LaTeX fractions BEFORE stripping other macros
  // This must happen first to preserve numerator and denominator
  // Handle \frac{num}{den}, \dfrac{num}{den}, and \tfrac{num}{den}
  const latexFractionPatterns: Array<[RegExp, string]> = [
    [/\\[dt]?frac\{([^{}]+)\}\{([^{}]+)\}/g, '{$1/$2}'],
    [/\\[dt]?frac\s*\(\s*([^\s{}()]+)\s*\)\s*\(\s*([^\s{}()]+)\s*\)/g, '{$1/$2}'],
    [/\\[dt]?frac\s*([^\s{}]+)\s*([^\s{}]+)/g, '{$1/$2}'],
  ];
  latexFractionPatterns.forEach(([pattern, replacement]) => {
    formatted = formatted.replace(pattern, replacement);
  });
  formatted = convertLooseFractions(formatted);
  formatted = convertSqrtExpressions(formatted);
  formatted = fixStackedDecimals(formatted);
  formatted = convertStackedUnits(formatted);
  formatted = convertStackedQuantityFractions(formatted);
  formatted = convertInlineSlashFractions(formatted);
  // Remove any leftover \frac tokens
  formatted = formatted.replace(/\\[dt]?frac/g, '');
  
  // 0B. Remove LaTeX commands that shouldn't be displayed as text
  // Iteratively strip \command{text} patterns to handle nested commands
  let prevFormatted;
  do {
    prevFormatted = formatted;
    // Strip \text{...}, \textbf{...}, \textit{...}, etc. -> keep content only
    formatted = formatted.replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, '$1');
  } while (formatted !== prevFormatted); // Keep going until no more changes
  formatted = formatted.replace(/\,/g, ''); // spacing
  formatted = formatted.replace(/\;/g, ''); // spacing
  formatted = formatted.replace(/\ /g, ' '); // spacing
    const latexSymbolReplacements: Array<[RegExp, string]> = [
    [/\times/g, '×'],
    [/\cdot/g, '·'],
    [/\angle/g, '∠'],
    [/\triangle/g, '△'],
    [/\Delta/g, 'Δ'],
    [/\alpha/g, 'α'],
    [/\beta/g, 'β'],
    [/\theta/g, 'θ'],
    [/\gamma/g, 'γ'],
    [/\pi/g, 'π'],
    [/\sin/g, 'sin'],
    [/\cos/g, 'cos'],
    [/\tan/g, 'tan'],
    [/\csc/g, 'csc'],
    [/\sec/g, 'sec'],
    [/\cot/g, 'cot'],
  ];
  latexSymbolReplacements.forEach(([pattern, replacement]) => {
    formatted = formatted.replace(pattern, replacement);
  });
  const superscriptMap: Record<string, string> = {
    '⁰': '0',
    '¹': '1',
    '²': '2',
    '³': '3',
    '⁴': '4',
    '⁵': '5',
    '⁶': '6',
    '⁷': '7',
    '⁸': '8',
    '⁹': '9',
  };
  formatted = formatted.replace(/([A-Za-z0-9\}])([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (_match, base: string, superscripts: string) => {
    const normalized = superscripts
      .split('')
      .map((char) => superscriptMap[char] ?? '')
      .join('');
    return normalized ? `${base}^${normalized}` : base;
  });
  formatted = formatted.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (char: string) => {
    const normalized = superscriptMap[char];
    return normalized ? `^${normalized}` : '';
  });
  const symbolNormalization: Array<[RegExp, string]> = [
    [/−/g, '-'],
    [/–/g, '-'],
    [/—/g, '-'],
    [/﹣/g, '-'],
    [/＋/g, '+'],
    [/﹢/g, '+'],
    [/＝/g, '='],
    [/（/g, '('],
    [/）/g, ')'],
  ];
  symbolNormalization.forEach(([pattern, replacement]) => {
    formatted = formatted.replace(pattern, replacement);
  });
  const subscriptMap: Record<string, string> = {
    '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
    '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
    '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')',
  };
  formatted = formatted.replace(/[\u2080-\u2089\u208A-\u208E]+/g, (match) =>
    match.split('').map(char => subscriptMap[char] ?? '').join('')
  );
  // Fix accidental Greek pi inside words (e.g., "πeces" -> "pieces") while leaving math tokens alone
  formatted = formatted.replace(/(^|[^A-Za-z0-9])π([a-z]{2,})/g, '$1pi$2');
  // Normalize stray angle symbols inside words/phrases
  formatted = formatted.replace(/\btri∠s?\b/gi, (m) => m.toLowerCase().endsWith('s') ? 'triangles' : 'triangle');
  formatted = formatted.replace(/\b∠s\b/gi, 'angles');
  formatted = formatted.replace(/\b∠\b/gi, 'angle');
  formatted = formatted.replace(/∠(?=[A-Za-z\s])/g, 'angle ');
  formatted = formatted.replace(/∠/g, 'angle');
  formatted = formatted.replace(/\bangle\s+s\b/gi, 'angles');
  formatted = formatted.replace(/\btriangle\s+s\b/gi, 'triangles');
  formatted = formatted.replace(/(\^\d+)\^/g, '$1'); // Remove trailing caret after superscript numbers
  
  // 0C. CRITICAL: Detect and convert vertical fractions BEFORE whitespace normalization
  // AI sometimes outputs fractions in vertical format:
  //   y = 
  //   1
  //   2
  // This must be converted to "1/2" before newlines are collapsed to spaces
  // Pattern: math context (=, +, -, ×, etc.) followed by newlines and a fraction-like stack
  formatted = formatted.replace(
    /([=+\-x×÷*\(]\s*)\n+\s*(\d+)\s*\n+\s*(\d+)(?=\s|$)/g,
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
  // Repair decimals split by whitespace after cleanup
  formatted = formatted.replace(/(\d+)\.\s+(\d+)/g, '$1.$2');
  formatted = formatted.replace(/(\d+)\s+\.\s+(\d+)/g, '$1.$2');
  formatted = formatted.replace(/(\d+)\s*\n\s*(\d+)/g, '$1$2'); // rejoin numbers split by newline
  formatted = formatted.replace(/(\d+)\s+\/\s+(s)/gi, '$1/$2'); // fix m / s
  formatted = formatted.replace(/(m)\s+\/\s*(s\^?2?)/gi, '$1/$2');
  formatted = formatted.replace(/(\d+)\s*\/\s*(\d+)/g, '{$1/$2}'); // force simple numeric fractions to vertical
  // Trim leading/trailing whitespace
  formatted = formatted.trim();
  // Repair occasional glued tokens from aggressive whitespace scrubbing
  formatted = formatted.replace(/([A-Za-z])sinto\b/gi, '$1 into');
  formatted = formatted.replace(/([A-Za-z])sindependent\b/gi, '$1 independent');
  formatted = formatted.replace(/([A-Za-z])susing\b/gi, '$1 using');
  formatted = formatted.replace(/([A-Za-z])swith\b/gi, '$1 with');
  formatted = formatted.replace(/\btimesin\b/gi, 'time in');
  formatted = formatted.replace(/\bheightand\b/gi, 'height and');
  formatted = formatted.replace(/\brangeand\b/gi, 'range and');
  formatted = formatted.replace(/\bsolution(s?)in\b/gi, 'solution$1 in');
  formatted = formatted.replace(/\bproblems?involves\b/gi, 'problem involves');
  
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
  
  // Two-pass fraction wrapper:
  // Pass 1: Wrap numeric fractions followed by variables (fixes {2/9x}² bug)
  // Pass 2: Wrap algebraic fractions (preserves {3x/4y})
  function wrapFractions(text: string): string {
    // PASS 1: Numeric fractions before variables (e.g., 2/9x² → {2/9}x²)
    // Match: digits/digits followed by letter or parenthesis
    text = text.replace(/(\d+)\/(\d+)(?=[a-zA-Z(])/g, '{$1/$2}');
    
    // PASS 2: General algebraic fractions (brace-aware)
    let result = '';
    let i = 0;
    
    while (i < text.length) {
      // Check if we're at the start of a CURLY brace-wrapped section
      // This ensures we skip already-wrapped fractions like {240/41} or {2/9} from Pass 1
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
        result += text.substring(i, j);
        i = j;
        continue;
      }
      
      // Check if we're at an algebraic fraction pattern
      // Match: alphanumeric/alphanumeric (e.g., 3x/4y, x/4, 12/5)
    const fractionMatch = text
      .substring(i)
      .match(/^([\p{L}0-9_]+(?:\([^)]+\))?)\/([\p{L}0-9_]+(?:\([^)]+\))?)/u);
      if (fractionMatch) {
        const num = fractionMatch[1];
        const den = fractionMatch[2];
        
        // Only wrap if at least one side has a digit (excludes pure letter ratios like m/s)
        const hasDigit = /\d/.test(num) || /\d/.test(den);
        
        // Not preceded/followed by decimal point (to avoid 19.6/5.0)
        const notDecimal = (i === 0 || text[i - 1] !== '.') && 
                          (i + fractionMatch[0].length >= text.length || text[i + fractionMatch[0].length] !== '.');
        
        if (hasDigit && notDecimal) {
          // Wrap fraction
          result += `{${num}/${den}}`;
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

function ensureColorHighlights(text: string | null | undefined, debugLabel: string = ''): string {
  if (!text) {
    return '';
  }

  let updated = text;
  const hasBlue = /\[blue:/i.test(updated);
  const hasRed = /\[red:/i.test(updated);

  // Match fractions, radicals, and numeric tokens for auto-highlighting
  const candidateRegex = /(\{[^}]+\/[^}]+\}|√\([^\[]+\)|-?\d+(?:\.\d+)?)/gu;
  const colorTags = ['blue', 'red', 'green', 'yellow', 'orange', 'purple'];
  const subSuperscriptRegex = /[\u2070-\u209F]/;

  const isInsideColorTag = (content: string, index: number): boolean => {
    const openIndex = content.lastIndexOf('[', index);
    if (openIndex === -1) {
      return false;
    }
    const closeIndex = content.indexOf(']', openIndex);
    if (closeIndex === -1 || closeIndex < index) {
      return false;
    }
    const colonIndex = content.indexOf(':', openIndex);
    if (colonIndex === -1 || colonIndex > closeIndex) {
      return false;
    }
    const tag = content.slice(openIndex + 1, colonIndex).toLowerCase();
    return colorTags.includes(tag) && index >= openIndex && index <= closeIndex;
  };

  const extendSegmentEnd = (content: string, initialEnd: number, baseSegment: string): number => {
    let end = initialEnd;
    const suffix = content.slice(end);
    const unitMatch = suffix.match(/^(\s*(?:°|%|[a-zA-Z]+(?:\s*\/\s*[a-zA-Z]+)*))/);
    if (unitMatch && /\d/.test(baseSegment)) {
      const addition = unitMatch[0];
      if (/[a-zA-Z°%]/.test(addition)) {
        end += addition.length;
      }
    }
    return end;
  };

  const applyHighlight = (content: string, match: RegExpExecArray, color: 'blue' | 'red'): string => {
    const start = match.index ?? 0;
    let end = start + match[0].length;
    end = extendSegmentEnd(content, end, match[0]);
    const segment = content.slice(start, end);
    return `${content.slice(0, start)}[${color}:${segment}]${content.slice(end)}`;
  };

  const isSymbolicContext = (content: string, startIndex: number, value: string): boolean => {
    const prevChar = startIndex > 0 ? content[startIndex - 1] : '';
    if (prevChar === '^' || prevChar === '_') {
      return true;
    }
    return subSuperscriptRegex.test(value);
  };

  const findFirstMatch = (content: string): RegExpExecArray | null => {
    candidateRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = candidateRegex.exec(content)) !== null) {
      if (!isInsideColorTag(content, match.index ?? 0) && !isSymbolicContext(content, match.index ?? 0, match[0])) {
        return match;
      }
    }
    return null;
  };

  const findLastMatch = (content: string): RegExpExecArray | null => {
    candidateRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    let lastMatch: RegExpExecArray | null = null;
    while ((match = candidateRegex.exec(content)) !== null) {
      if (!isInsideColorTag(content, match.index ?? 0) && !isSymbolicContext(content, match.index ?? 0, match[0])) {
        lastMatch = match;
      }
    }
    return lastMatch;
  };

  if (!hasBlue) {
    const firstMatch = findFirstMatch(updated);
    if (firstMatch) {
      updated = applyHighlight(updated, firstMatch, 'blue');
    }
  }

  if (!hasRed) {
    const lastMatch = findLastMatch(updated);
    if (lastMatch) {
      updated = applyHighlight(updated, lastMatch, 'red');
    }
  }

  if (debugLabel && (updated !== text)) {
    console.log(`🎯 Color highlights enforced for [${debugLabel}]`);
  }

  return updated;
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
      const defaultExplanation = "This step is part of solving the problem.";
      const explanation = step.explanation ? enforceProperFormatting(step.explanation, `step${index+1}-explanation`) : defaultExplanation;

      if (!step.explanation) {
        console.warn(`??  Step ${index+1} missing explanation - using fallback`);
      }

      const formattedTitle = step.title ? enforceProperFormatting(step.title, `step${index+1}-title`) : step.title;
      const formattedContent = step.content ? enforceProperFormatting(step.content, `step${index+1}-content`) : '';
      const highlightedContent = ensureColorHighlights(formattedContent, `step${index+1}-content`);

      return {
        ...step,
        title: formattedTitle,
        content: highlightedContent,
        explanation
      };
    });
  }
  
  // Fix final answer if present
  if (formatted.finalAnswer) {
    const normalizedAnswer = enforceProperFormatting(formatted.finalAnswer, 'finalAnswer');
    formatted.finalAnswer = ensureColorHighlights(normalizedAnswer, 'finalAnswer');
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
    
    const verificationPrompt = `You are an educational quality reviewer verifying the accuracy of a homework solution.

Task: Compare the provided solution against your own independent work to check for accuracy.

Step 1 - Solve Independently:
Problem: ${originalQuestion}

First, solve this problem completely on your own. Calculate your answer for each part (if multi-part). Show your work.

Step 2 - List Your Results:
Write your answers:
- Part (a): [your value]
- Part (b): [your value]  
- Part (c): [your value]
(etc. for all parts in the problem)

Step 3 - Review Provided Solution:
Here is the student's work:

Steps:
${stepsText}

Final Answer:
${proposedSolution.finalAnswer}

Step 4 - Extract Their Results:
List what the student provided for each part:
- Part (a): [their value]
- Part (b): [their value]
- Part (c): [their value]
(etc.)

Step 5 - Compare Answers:
For each part, check if your answer matches theirs:
- Part (a): Match? (Yes/No) - If different, note the discrepancy
- Part (b): Match? (Yes/No) - If different, note the discrepancy
- Part (c): Match? (Yes/No) - If different, note the discrepancy

Verify:
• Numerical values match exactly
• Signs are correct (positive/negative)
• Intervals have correct direction and endpoints
• Critical points are identified accurately
• Arithmetic is calculated correctly

Step 6 - Determine Result:
- If all parts match exactly: isCorrect = true
- If any part differs: isCorrect = false  
- If uncertain about any part: isCorrect = false

Example Comparison:

Your solution:
(a) v(t) = 3t² - 12t + 9
(b) a(t) = 6t - 12
(c) Rest at: t = 1, 3
(d) Speeding up: (1,2), (3,5); Slowing down: (0,1), (2,3)

Their solution:
(a) v(t) = 3t² - 12t + 9
(b) a(t) = 6t - 12  
(c) Rest at: t = 1, 3
(d) Speeding up: (0,1), (1,3), (3,5); Slowing down: none

Analysis:
✓ Part (a) matches
✓ Part (b) matches
✓ Part (c) matches
✗ Part (d) differs - your intervals (1,2),(3,5) vs their intervals (0,1),(1,3)

Result: isCorrect = false (one discrepancy found)

Respond in JSON format:
{
  "isCorrect": true/false,
  "confidence": 0-100,
  "errors": ["Part (d): intervals differ - expected (1,2),(3,5) but got (0,1),(1,3)", ...],
  "warnings": [],
  "reasoning": "Independent calculation yielded: ... | Provided solution shows: ... | Differences noted in: ..."
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are an educational accuracy validator. Verify homework solutions by comparing them to your own independent calculations."
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
    
    const verificationPrompt = `You are an educational quality reviewer verifying the accuracy of a homework solution.

Task: Compare the provided solution against your own independent work to check for accuracy.

Step 1 - Solve Independently:
Problem: ${originalQuestion}

First, solve this problem completely on your own. Calculate your answer for each part (if multi-part). Show your work.

Step 2 - List Your Results:
Write your answers:
- Part (a): [your value]
- Part (b): [your value]  
- Part (c): [your value]
(etc. for all parts in the problem)

Step 3 - Review Provided Solution:
Here is the student's work:

Steps:
${stepsText}

Final Answer:
${proposedSolution.finalAnswer}

Step 4 - Extract Their Results:
List what the student provided for each part:
- Part (a): [their value]
- Part (b): [their value]
- Part (c): [their value]
(etc.)

Step 5 - Compare Answers:
For each part, check if your answer matches theirs:
- Part (a): Match? (Yes/No) - If different, note the discrepancy
- Part (b): Match? (Yes/No) - If different, note the discrepancy
- Part (c): Match? (Yes/No) - If different, note the discrepancy

Verify:
• Numerical values match exactly
• Signs are correct (positive/negative)
• Intervals have correct direction and endpoints
• Critical points are identified accurately
• Arithmetic is calculated correctly

Step 6 - Determine Result:
- If all parts match exactly: isCorrect = true
- If any part differs: isCorrect = false  
- If uncertain about any part: isCorrect = false

Example Comparison:

Your solution:
(a) v(t) = 3t² - 12t + 9
(b) a(t) = 6t - 12
(c) Rest at: t = 1, 3
(d) Speeding up: (1,2), (3,5); Slowing down: (0,1), (2,3)

Their solution:
(a) v(t) = 3t² - 12t + 9
(b) a(t) = 6t - 12  
(c) Rest at: t = 1, 3
(d) Speeding up: (0,1), (1,3), (3,5); Slowing down: none

Analysis:
✓ Part (a) matches
✓ Part (b) matches
✓ Part (c) matches
✗ Part (d) differs - your intervals (1,2),(3,5) vs their intervals (0,1),(1,3)

Result: isCorrect = false (one discrepancy found)

Respond in JSON format:
{
  "isCorrect": true/false,
  "confidence": 0-100,
  "errors": ["Part (d): intervals differ - expected (1,2),(3,5) but got (0,1),(1,3)", ...],
  "warnings": [],
  "reasoning": "Independent calculation yielded: ... | Provided solution shows: ... | Differences noted in: ..."
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

  // Safety timeout - ensure verification completes within 3 minutes
  const VERIFICATION_TIMEOUT = 3 * 60 * 1000; // 3 minutes
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      const currentStatus = verificationStore.get(solutionId);
      if (currentStatus && (currentStatus.status === 'pending' || currentStatus.status === 'invalid_pending')) {
        console.warn(`⏱️ Verification timeout for ${solutionId} - marking as unverified`);
        verificationStore.set(solutionId, {
          status: 'unverified',
          confidence: 0,
          warnings: ['Verification timed out after 3 minutes'],
          timestamp: Date.now()
        });
      }
      resolve();
    }, VERIFICATION_TIMEOUT);
  });

  // Initialize as pending (this may be redundant if already set before pipeline starts, but ensures state)
  const existingStatus = verificationStore.get(solutionId);
  if (!existingStatus || existingStatus.status === 'pending' || existingStatus.status === 'invalid_pending') {
    verificationStore.set(solutionId, {
      status: 'pending',
      confidence: 0,
      warnings: [],
      timestamp: Date.now()
    });
  }
  
  try {
    // 🚨 CHECK FOR INVALID SOLUTION FLAG - Regenerate with WolframAlpha if needed
    let currentSolution = solution;
    
    if ((solution as any).__invalid) {
      const invalidReason = (solution as any).__invalidReason || 'Unknown issue';
      console.warn(`🚨 Invalid solution detected (${invalidReason}) - attempting WolframAlpha fallback...`);
      
      // Check if this is a math-eligible problem
      const isMath = isMathEligible(originalQuestion, solution.subject || '');
      
      if (isMath && wolframAlphaAppId) {
        console.log(`🔧 Triggering WolframAlpha solution regeneration for math problem...`);
        
        try {
          const wolframSolution = await wolframAlphaSolveAndExplain(originalQuestion);
          
          if (wolframSolution) {
            console.log(`✅ WolframAlpha successfully generated replacement solution`);
            
            // Format the WolframAlpha solution
            const formattedWolframSolution = enforceResponseFormatting(wolframSolution);
            const structuredWolframSolution = attachStructuredMathContent(formattedWolframSolution);
            
            // PERSIST the regenerated solution to the store
            solutionStore.set(solutionId, {
              solution: structuredWolframSolution,
              timestamp: Date.now(),
              regenerated: true
            });
            
            // Replace current solution for verification
            currentSolution = structuredWolframSolution;
            
            console.log(`✅ Invalid solution successfully regenerated and persisted via WolframAlpha`);
          } else {
            console.warn(`⚠️ WolframAlpha fallback returned null - will verify original solution`);
          }
        } catch (wolframError) {
          console.error(`❌ WolframAlpha fallback error:`, wolframError);
          // Continue with original solution verification
        }
      } else {
        console.warn(`⚠️ Invalid solution detected but not math-eligible or WolframAlpha unavailable`);
      }
    }
    
    // Check if this is a math-eligible problem (use currentSolution which may be regenerated)
    const isMath = isMathEligible(originalQuestion, currentSolution.subject || '');
    let wolframResult: ValidationResult | null = null;
    
    if (isMath && wolframAlphaAppId) {
      console.log(`🧮 Math problem detected - using WolframAlpha for ground truth verification`);
      
      // Attempt 1: WolframAlpha verification (computational ground truth)
      wolframResult = await wolframAlphaVerification(originalQuestion, currentSolution);
      
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
    let verification = await crossModelVerification(originalQuestion, currentSolution);
    
    if (verification.isValid && verification.confidence >= 70) {
      // If Wolfram was inconclusive/missing, do not mark as verified; treat as unverified with warning
      if (isMath && (!wolframResult || wolframResult.confidence < 50 || (wolframResult.warnings && wolframResult.warnings.length > 0))) {
        console.warn(`⚠️ WolframAlpha was unavailable/inconclusive; not marking verified despite AI agreement`);
        verificationStore.set(solutionId, {
          status: 'unverified',
          confidence: verification.confidence,
          warnings: ['WolframAlpha unavailable or inconclusive', ...(verification.warnings || [])],
          timestamp: Date.now()
        });
        return;
      }
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
    const retryVerification = await crossModelVerification(originalQuestion, currentSolution);
    
    if (retryVerification.isValid && retryVerification.confidence >= 70) {
      if (isMath && (!wolframResult || wolframResult.confidence < 50 || (wolframResult.warnings && wolframResult.warnings.length > 0))) {
        console.warn(`⚠️ WolframAlpha was unavailable/inconclusive; not marking verified despite AI agreement (retry)`);
        verificationStore.set(solutionId, {
          status: 'unverified',
          confidence: retryVerification.confidence,
          warnings: ['WolframAlpha unavailable or inconclusive', ...(retryVerification.warnings || [])],
          timestamp: Date.now()
        });
        return;
      }
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

function ensurePhysicsVisualAids(question: string, result: any): any {
  if (!question || typeof question !== 'string') {
    return result;
  }

  if (result.visualAids && result.visualAids.length > 0) {
    return result;
  }

  const lowerQuestion = question.toLowerCase();
  const physicsKeywords = [
    'projectile',
    'catapult',
    'launch',
    'trajectory',
    'range',
    'flight time',
    'initial velocity',
    'v0',
    'parabolic path',
    'angle of elevation',
    'free body',
    'force diagram',
    'incline plane',
    'frictionless track',
  ];

  const hasKeyword = physicsKeywords.some((keyword) => lowerQuestion.includes(keyword));
  if (!hasKeyword) {
    return result;
  }

  console.log('🎯 Auto-injecting physics visual aid');
  const description = 'Projectile motion diagram showing launch angle, horizontal/vertical velocity components (v0x, v0y), parabolic path, maximum height, and landing range. Label initial speed and angle.';
  const stepId = result.steps && result.steps.length > 0 ? result.steps[0].id : '1';

  return {
    ...result,
    visualAids: [
      {
        type: 'physics',
        stepId,
        description,
      },
    ],
  };
}

function ensureConceptualVisualAids(question: string, result: any): any {
  if (!question || typeof question !== 'string') {
    return result;
  }

  if (result.visualAids && result.visualAids.length > 0) {
    return result;
  }

  const subject = (result.subject || '').toLowerCase();
  const questionLower = question.toLowerCase();
  const heuristics: Array<{ match: boolean; type: string; description: string }> = [
    {
      match:
        subject.includes('geometry') ||
        subject.includes('trigonometry') ||
        /triangle|quadrilateral|angle|polygon|circle|arc|perimeter|area|radius|diameter/.test(questionLower),
      type: 'geometry',
      description: 'Geometry diagram showing labeled vertices, sides, and angles referenced in the problem with given measurements and unknowns highlighted.',
    },
    {
      match:
        subject.includes('physics') ||
        /projectile|trajectory|force|velocity|acceleration|catapult|launch|free body|kinematics/.test(questionLower),
      type: 'physics',
      description: 'Physics diagram illustrating the setup with labeled forces, velocity components, and key distances (range, height, time).',
    },
    {
      match:
        subject.includes('chemistry') ||
        subject.includes('biology') ||
        /reaction|cycle|pathway|cell|dna|enzyme|respiration/.test(questionLower),
      type: 'illustration',
      description: 'Process illustration showing each stage with arrows indicating flow, labeled reactants/products, and key molecules called out.',
    },
    {
      match:
        subject.includes('statistics') ||
        subject.includes('data') ||
        /survey|distribution|probability|percent|table|chart|mean|median/.test(questionLower),
      type: 'chart',
      description: 'Data visualization summarizing the referenced values (bar or line chart) with labeled axes and highlighted comparisons.',
    },
    {
      match:
        subject.includes('accounting') ||
        /balance sheet|income statement|ledger|debit|credit|cash flow/.test(questionLower),
      type: 'illustration',
      description: 'Accounting visual showing debits and credits (T-accounts or balance sheet layout) with labeled amounts.',
    },
    {
      match: /graph|plot|function|slope|parabola|coordinate|linear/.test(questionLower),
      type: 'graph',
      description: 'Coordinate plane graphing the function or relation with labeled axes, intercepts, and notable points.',
    },
  ];

  const matched = heuristics.find((rule) => rule.match);
  const stepId = result.steps && result.steps.length > 0 ? result.steps[0].id : '1';

  if (matched) {
    return {
      ...result,
      visualAids: [
        {
          type: matched.type,
          stepId,
          description: matched.description,
        },
      ],
    };
  }

  if (!result.steps || result.steps.length < 2) {
    return result;
  }

  return {
    ...result,
    visualAids: [
      {
        type: 'illustration',
        stepId,
        description: 'Conceptual illustration summarizing each major step with annotations showing how the solution progresses.',
      },
    ],
  };
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

⚡ **RESPONSE SIZE LIMIT - CRITICAL:**
- Keep your ENTIRE JSON response under 2,000 characters total
- Each step content should be 2-3 sentences maximum (50-100 chars each)
- Be concise and focused - students need clarity, not verbosity
- For multi-part problems (a, b, c, d), keep each part's explanation brief

🔢 **NUMBER FORMAT RULE - MATCH THE INPUT:**
- If the problem uses DECIMALS (0.5, 2.75), use decimals in your solution
- If the problem uses FRACTIONS (1/2, 3/4), write them as {numerator/denominator} so they render vertically
- For fractions: Use mixed numbers when appropriate (e.g., {1{1/2}} for 1½, {2{3/4}} for 2¾)
- CRITICAL: Match the user's preferred format - don't convert between decimals and fractions
- **NEVER output LaTeX commands like \\frac — always wrap fractions as {numerator/denominator}**
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
- **MULTI-PART ANSWERS - PROFESSIONAL FORMATTING:**
  If the question has multiple parts OR your answer has multiple numbered/lettered items:
  
  **🚨 CRITICAL: finalAnswer MUST BE A STRING, NOT AN OBJECT!**
  - DO NOT create a JSON object like {"a": "...", "b": "...", "c": "..."}
  - DO use a single string with \n newline separators between parts
  - Correct format: "a) Part one \n b) Part two \n c) Part three"
  
  **CRITICAL RULES for Multi-Part Final Answers:**
  1. **Each part on its own line** - Use literal \n characters to separate parts
  2. **Descriptive labels** - Include what each part represents, not just the letter
  3. **NO periods after equations** - Equations are not sentences
  4. **Parallel structure** - All parts should follow the same grammatical pattern
  5. **Complete descriptions** - Each part should be clear and self-contained
  
  **PROFESSIONAL FORMAT EXAMPLES:**
  
  ✅ EXCELLENT (Physics - descriptive, parallel, no periods):
  "a) Initial velocity: [red:v₀ = 15 m/s] \n b) Maximum height: [red:h = 11.5 m] \n c) Time of flight: [red:t = 3.1 s]"
  
  ✅ EXCELLENT (Math - equation type labeled, consistent structure):
  "a) Vertex form: [red:y = −2(x − 1)² + 25] \n b) Standard form: [red:y = −2x² + 4x + 23] \n c) Vertex coordinates: [red:(1, 25)] \n d) Direction: The parabola opens [red:downward]"
  
  ✅ GOOD (Chemistry - complete descriptions):
  "a) Balanced equation: [red:2H₂ + O₂ → 2H₂O] \n b) Reaction type: [red:Synthesis reaction] \n c) Moles of product: [red:0.5 mol]"
  
  ❌ WRONG (inconsistent - some have context, some don't):
  "a) [red:y = −2(x − 1)² + 25] \n b) Standard form: [red:y = −2x² + 4x + 23] \n c) Vertex: [red:(1, 25)] \n d) Opens [red:downward]"
  
  ❌ WRONG (periods after equations look awkward):
  "a) Vertex form: [red:y = −2(x − 1)² + 25]. \n b) Standard: [red:y = −2x² + 4x + 23]."
  
  ❌ WRONG (all on one line):
  "a) v = 15 m/s, b) h = 11.5 m, c) t = 3.1 s"
  
  ❌ WRONG (too terse, lacks context):
  "a) [red:−2(x − 1)² + 25] \n b) [red:−2x² + 4x + 23] \n c) [red:(1, 25)] \n d) [red:Downward]"

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
          }, { timeout: OPENAI_TIMEOUT_MS });
          
          const content = response.choices[0]?.message?.content || "{}";
          
          // 🚨 POST-CALL GUARD: Reject oversized responses immediately
          const MAX_RESPONSE_SIZE = 5000; // chars (≈1250 tokens)
          if (content.length > MAX_RESPONSE_SIZE) {
            console.error(`🚨 Response too large: ${content.length} chars (limit: ${MAX_RESPONSE_SIZE})`);
            console.log('🔄 Re-requesting with emergency compression instruction...');
            
            // Re-issue with emergency compression request
            const compressResponse = await openai.chat.completions.create({
              model: "gpt-4o",
              messages: [
                {
                  role: "system",
                  content: `You are an expert educational AI tutor. Provide ULTRA-CONCISE step-by-step solutions.
                  
CRITICAL SIZE LIMIT: Your ENTIRE JSON response must be under 2,000 characters. This is non-negotiable.

- Each step: 1-2 SHORT sentences only (40-60 chars max)
- Total steps: Keep to 4-6 steps maximum
- finalAnswer: Just the answer, no explanation
- Use color tags [blue:] [red:] but keep text minimal`
                },
                {
                  role: "user",
                  content: `${question}\n\n⚠️ EMERGENCY: Previous response was too long. Give me the SHORTEST possible solution that still has proper steps and formatting. Maximum 2000 characters total.`
                }
              ],
              response_format: { type: "json_object" },
              max_tokens: 1500, // Hard limit to prevent oversized responses
            }, { timeout: OPENAI_TIMEOUT_MS });
            
            const compressedContent = compressResponse.choices[0]?.message?.content || "{}";
            console.log(`✅ Compressed response: ${compressedContent.length} chars (was ${content.length})`);
            
            try {
              const parsed = JSON.parse(compressedContent);
              return parsed;
            } catch (compressError: any) {
              console.error('❌ Compressed response also failed to parse');
              throw new Error(`Compression failed: ${compressError.message}`);
            }
          }
          
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
    
    // 🔍 INVALID SOLUTION DETECTION: Check for corrupted/mathematically invalid output
    const invalidCheck = isInvalidSolution(result);
    let invalidSolutionDetected = false;
    let invalidReason = '';
    
    if (invalidCheck.isInvalid) {
      console.warn(`⚠️ Invalid solution detected on first attempt: ${invalidCheck.reason}`);
      console.warn(`📄 Solution preview:`, JSON.stringify(result).substring(0, 300));
      
      // 🔄 IMMEDIATE RETRY: Give GPT-4o 2 more chances before showing invalid output
      let retryCount = 0;
      const maxRetries = 2;
      
      while (retryCount < maxRetries && invalidCheck.isInvalid) {
        retryCount++;
        console.log(`🔄 Retrying GPT-4o (attempt ${retryCount + 1}/${maxRetries + 1})...`);
        
        try {
          // Retry GPT-4o with fresh API call (reuses same prompt)
          const retryResponse = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content: `You are an expert educational AI tutor. Analyze the homework question and provide a step-by-step solution with proper formatting. CRITICAL: Provide complete, fully-formed solutions with all required fields (problem, subject, difficulty, steps array with id/title/content/explanation, finalAnswer, visualAids). Do NOT return incomplete or malformed JSON.`
              },
              {
                role: "user",
                content: question
              }
            ],
            response_format: { type: "json_object" },
            max_tokens: 8192,
          });
          
          const retryContent = retryResponse.choices[0]?.message?.content || "{}";
          result = JSON.parse(retryContent);
          
          // Check if retry produced valid solution
          const retryCheck = isInvalidSolution(result);
          if (!retryCheck.isInvalid) {
            console.log(`✅ Retry ${retryCount} succeeded - valid solution generated`);
            invalidSolutionDetected = false;
            invalidReason = '';
            break;
          } else {
            console.warn(`⚠️ Retry ${retryCount} still invalid: ${retryCheck.reason}`);
            invalidCheck.isInvalid = retryCheck.isInvalid;
            invalidCheck.reason = retryCheck.reason;
          }
        } catch (retryError) {
          console.error(`❌ Retry ${retryCount} failed:`, retryError);
          // Continue to next retry or fall through
        }
      }
      
      // If all retries failed, mark as invalid for WolframAlpha fallback
      if (invalidCheck.isInvalid) {
        console.warn(`⚠️ All ${maxRetries + 1} attempts produced invalid solutions - will trigger WolframAlpha fallback`);
        invalidSolutionDetected = true;
        invalidReason = invalidCheck.reason;
      }
    }
    
    // 🧬 BIOLOGY/CHEMISTRY KEYWORD DETECTION: Ensure visual aids for metabolic cycles
    result = ensureBiologyVisualAids(question, result);
    // 🎯 PHYSICS KEYWORD DETECTION: Ensure diagrams for projectile/force problems
    result = ensurePhysicsVisualAids(question, result);
    
    // 📐 MEASUREMENT DIAGRAM ENFORCEMENT: Auto-inject diagrams for geometry/measurement problems
    result = applyMeasurementDiagramEnforcement(question, result);
    // 🌐 GLOBAL CONCEPTUAL VISUALS: Ensure at least one helpful diagram for complex prompts
    result = ensureConceptualVisualAids(question, result);
    
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
    
    // Add metadata for verification pipeline
    if (invalidSolutionDetected) {
      (structuredResult as any).__invalid = true;
      (structuredResult as any).__invalidReason = invalidReason;
    }

    // ⚡ RETURN IMMEDIATELY with verification status (or invalid_pending if corrupted)
    const responseWithId = {
      ...structuredResult,
      solutionId,
      verificationStatus: invalidSolutionDetected ? ('invalid_pending' as const) : ('pending' as const),
      verificationConfidence: 0,
      verificationWarnings: invalidSolutionDetected ? [invalidReason] : [],
      invalidReason: invalidSolutionDetected ? invalidReason : undefined
    };
    
    const totalTime = Date.now() - requestStartTime;
    if (invalidSolutionDetected) {
      console.log(`⚠️ Analysis complete - returning INVALID solution ${solutionId} (WolframAlpha fallback will run)`);
    } else {
      console.log(`✅ Analysis complete - returning solution ${solutionId} immediately (verification pending)`);
    }
    console.log(`⏱️ [TIMING] === TOTAL REQUEST TIME: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s) ===`);
    res.json(responseWithId);

    // Initialize verification store immediately so frontend can poll
    verificationStore.set(solutionId, {
      status: invalidSolutionDetected ? 'invalid_pending' : 'pending',
      confidence: 0,
      warnings: [],
      timestamp: Date.now()
    });

    // 🔄 START ASYNC VERIFICATION PIPELINE (non-blocking)
    void runVerificationPipeline(solutionId, question, structuredResult)
      .catch(err => {
        console.error(`⚠️ Verification pipeline error for ${solutionId}:`, err);
        // Ensure verification is marked as unverified on error
        verificationStore.set(solutionId, {
          status: 'unverified',
          confidence: 0,
          warnings: ['Verification system encountered an error'],
          timestamp: Date.now()
        });
      });

    // Generate diagrams in background if any exist
    if (diagrams.length > 0) {
      void generateDiagramsInBackground(solutionId, diagrams, structuredResult.steps);
    }
  } catch (error) {
    console.error('Error analyzing text:', error);
    res.status(500).json({ error: 'Failed to analyze question' });
  }
});

app.post('/api/analyze-image', async (req, res) => {
  const requestStartTime = Date.now();
  try {
    const { imageUri } = req.body;
    let problemNumber: string | undefined = typeof req.body?.problemNumber === 'string'
      ? req.body.problemNumber
      : undefined;
    console.log('🎯 Starting GPT-4o Vision analysis (single-call approach)...');
    console.log('⏱️ [TIMING] Request received at:', new Date().toISOString());
    let normalizedProblemNumber: string | null = null;
    if (problemNumber) {
      const trimmed = problemNumber.trim();
      if (trimmed.length > 0) {
        const problemPattern = /^\d{1,3}[a-z]?$/i;
        if (!problemPattern.test(trimmed)) {
          console.warn(`⚠️ Invalid problem number provided: "${problemNumber}"`);
          return res.status(400).json({
            error: 'Invalid problem number',
            message: 'Use numeric problems like "22" or "22a" (digits with optional letter).',
          });
        }
        normalizedProblemNumber = trimmed;
      }
    }
    if (normalizedProblemNumber) {
      problemNumber = normalizedProblemNumber;
      console.log(`📍 Target problem: #${problemNumber}`);
    }
    
    let targetedOcrResult: TargetedOcrResult | null = null;
    let ocrTranscription: string | null = null;
    let ocrDiagnostics: string[] = [];
    let ocrCroppedImage: string | null = null;

    if (problemNumber) {
      try {
        targetedOcrResult = await performTargetedProblemOcr(imageUri, problemNumber);
        if (targetedOcrResult) {
          ocrTranscription = targetedOcrResult.transcription;
          ocrDiagnostics = targetedOcrResult.diagnostics;
          ocrCroppedImage = targetedOcrResult.croppedImageUri ?? null;
        }

        if (ocrTranscription) {
          console.log(`[OCR] Captured transcription for problem #${problemNumber} (${ocrTranscription.length} chars)`);
        } else {
          console.warn(`[OCR] No transcription captured for problem #${problemNumber}`);
        }
      } catch (ocrError) {
        console.warn(`[OCR] Targeted OCR pipeline error for problem #${problemNumber}:`, ocrError);
      }
    }

    let result = await pRetry(
      async () => {
        try {
          // SIMPLIFIED STRATEGY: Direct Vision analysis with strong prompting
          // Skip locate/crop entirely - bounding box detection is unreliable
          
          console.log(`⏱️ [TIMING] Starting GPT-4o Vision analysis on full image...`);
          const visionStart = Date.now();

          // Build system message with ULTRA-STRONG problem targeting
          const targetedProblemBlock = problemNumber ? `🚨🚨🚨 CRITICAL REQUIREMENT - PROBLEM #${problemNumber} ONLY 🚨🚨🚨

**YOU MUST SOLVE PROBLEM #${problemNumber} AND ONLY PROBLEM #${problemNumber}**

STEP 1: LOCATE problem #${problemNumber}
- Scan the ENTIRE image for problem number markers: "#${problemNumber}", "Problem ${problemNumber}", "${problemNumber}.", "${problemNumber})"
- DO NOT stop searching until you find "#${problemNumber}" or "Problem ${problemNumber}"
- There may be many problems on the page - you MUST find the one labeled ${problemNumber}

STEP 2: READ THE COMPLETE PROBLEM
- Read EVERY line that is part of problem #${problemNumber}
- Include all parts (a, b, c, etc.) and conditions
- DO NOT stop at the first line
- DO NOT mix in text from other problems

STEP 3: TRANSCRIBE ACCURATELY
- In your "problem" field, write the COMPLETE text of problem #${problemNumber}
- Start with "${problemNumber}." or "Problem ${problemNumber}:" to confirm you found the right one
- Include ALL mathematical notation, equations, and conditions

**IF YOU CANNOT FIND PROBLEM #${problemNumber}:**
Return JSON with: {"error": "Problem #${problemNumber} not found in image", "problemsVisible": ["list", "of", "problem", "numbers", "you", "can", "see"]}

🚨🚨🚨 SOLVING THE WRONG PROBLEM IS A CRITICAL FAILURE 🚨🚨🚨` : 'If multiple problems exist, solve the most prominent one.';

          const ocrReferenceBlock = problemNumber && ocrTranscription
            ? `

OCR REFERENCE FOR PROBLEM #${problemNumber}:
"""
${ocrTranscription}
"""
- Copy this EXACT text into the "problem" field with no reformatting
- If the image appears different, trust this transcription as the ground truth`
            : '';

          let systemMessage = `You are an expert educational AI tutor. Analyze the homework image and provide a step-by-step solution.

${targetedProblemBlock}${ocrReferenceBlock}

📋 **REQUIRED JSON STRUCTURE:**
You MUST return a JSON object with these EXACT fields:
{
  "problem": "string - the complete problem text",
  "subject": "string - subject area (e.g., 'Math', 'Chemistry', 'Physics')",
  "difficulty": "string - grade level (e.g., '9-12', 'College+')",
  "steps": [
    {
      "id": "string - unique step identifier (e.g., '1', '2', '3')",
      "title": "string - concise action heading for this step",
      "content": "string - the solution step with formatted math",
      "explanation": "string - single sentence explaining the reasoning"
    }
  ],
  "finalAnswer": "string - the final answer with highlighting",
  "visualAids": []
}

**CRITICAL:** Never use different field names like "stepByStepSolution" - you MUST use the exact field names shown above.

?? **NUMBER FORMAT RULE - MATCH THE INPUT:**
- If the problem uses DECIMALS (0.5, 2.75), use decimals in your solution
- If the problem uses FRACTIONS (1/2, 3/4), write them as {numerator/denominator} so they render vertically
- For fractions: Use mixed numbers when appropriate (e.g., {1{1/2}} for 1½, {2{3/4}} for 2¾)
- CRITICAL: Match the user's preferred format - don't convert between decimals and fractions
- **NEVER output LaTeX commands like \frac — always wrap fractions as {numerator/denominator}**
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
- **Examine the image to detect if it's handwritten** (look for irregular letters, pen/pencil marks, notebook paper, handwritten numbers/symbols)
- If handwritten: Wrap the ENTIRE finalAnswer text in [handwritten:...] tags with colored highlights inside
- **Example:**
  - Handwritten math problem: finalAnswer = "[handwritten:[red:x = 7]]" (handwriting font with red highlight)
  - Typed textbook problem: finalAnswer = "[red:x = 7]" (normal font, just red highlight)
- **CRITICAL**: You can nest color tags inside handwritten tags: [handwritten:[red:answer]] works perfectly
- The handwriting font makes the answer feel personal and relatable to the student's own work`;
              
              console.log('⏱️ [TIMING] Calling GPT-4o Vision API...');
              const gptStart = Date.now();
              const userPromptLines: string[] = [];

              if (problemNumber) {
                userPromptLines.push(`Analyze the homework worksheet in this image. Find and solve ONLY problem #${problemNumber}. Return complete step-by-step solution in JSON format.`);
                if (ocrTranscription) {
                  userPromptLines.push(`Use this OCR transcription as the exact problem statement. Copy it verbatim into the "problem" field:
"""
${ocrTranscription}
"""`);
                } else {
                  userPromptLines.push(`If problem #${problemNumber} is not visible, return the error JSON described earlier (include the problem numbers you can see).`);
                }
              } else {
                userPromptLines.push('Analyze the homework problem in this image and provide a complete step-by-step solution in JSON format.');
              }

              const userContentBlocks: any[] = [
                {
                  type: "text",
                  text: userPromptLines.join('\n\n')
                }
              ];

              if (ocrCroppedImage) {
                userContentBlocks.push({
                  type: "image_url",
                  image_url: {
                    url: ocrCroppedImage,
                    detail: "high"
                  }
                });
              }

              userContentBlocks.push({
                type: "image_url",
                image_url: {
                  url: imageUri
                }
              });

              const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                  {
                    role: "system",
                    content: systemMessage
                  },
                  {
                    role: "user",
                    content: userContentBlocks
                  }
                ],
                response_format: { type: "json_object" },
                max_tokens: 8192,
              });
              console.log(`⏱️ [TIMING] GPT-4o Vision analysis completed in ${Date.now() - gptStart}ms`);
              
              let content = response.choices[0]?.message?.content || "{}";
              console.log('📝 [DEBUG] Raw GPT-4o response (first 500 chars):', content.substring(0, 500));
              
              const parsed = JSON.parse(content);
              console.log('📝 [DEBUG] Parsed JSON keys:', Object.keys(parsed));
              
              // Check for error responses first
              if (parsed.error) {
                console.error(`❌ GPT-4o returned error: ${parsed.error}`);
                if (parsed.problemsVisible) {
                  console.error(`   Visible problems: ${parsed.problemsVisible.join(', ')}`);
                }
                throw new Error(parsed.error);
              }
              
              // Validate parsed result
              if (!parsed || typeof parsed !== 'object') {
                throw new Error('OpenAI returned invalid JSON: parsed is not an object');
              }
              
              if (!parsed.problem || !parsed.subject || !parsed.difficulty || !parsed.steps || !Array.isArray(parsed.steps)) {
                console.error('❌ [DEBUG] Missing fields in response. Has problem:', !!parsed.problem, 'Has subject:', !!parsed.subject, 'Has difficulty:', !!parsed.difficulty, 'Has steps:', !!parsed.steps, 'Steps is array:', Array.isArray(parsed.steps));
                console.error('❌ [DEBUG] Full response:', content);
                throw new Error('OpenAI response missing required fields (problem, subject, difficulty, or steps array)');
              }

              // STRICT validation: Verify the problem number is in the transcribed text
              if (problemNumber) {
                const problemText = parsed.problem.toLowerCase();
                const hasTargetNumber =
                  problemText.includes(`#${problemNumber}`) ||
                  problemText.includes(`problem ${problemNumber}`) ||
                  problemText.startsWith(`${problemNumber}.`) ||
                  problemText.startsWith(`${problemNumber})`);

                if (!hasTargetNumber) {
                  console.error(`❌ WRONG PROBLEM SELECTED`);
                  console.error(`   Requested: #${problemNumber}`);
                  console.error(`   Got: ${parsed.problem.substring(0, 100)}...`);
                  throw new Error(`GPT-4o solved wrong problem (expected #${problemNumber})`);
                }
                console.log(`✅ Confirmed problem #${problemNumber} was solved`);
              }

              console.log('✅ OpenAI Vision analysis complete');
              return parsed;
        } catch (error: any) {
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
      if (ocrTranscription) {
        console.log(`[OCR] Overriding problem statement with transcription (${ocrTranscription.length} chars)`);
        const allowedVariables = extractStandaloneVariables(result.problem ?? '');
        const normalizedProblem = normalizeOcrProblemText(ocrTranscription, allowedVariables);
        result.problem = normalizedProblem;
        (result as any).ocrTranscription = normalizedProblem;
      }
    if (ocrDiagnostics.length > 0) {
      (result as any).ocrDiagnostics = ocrDiagnostics;
    }

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
    result = ensurePhysicsVisualAids(result.problem || '', result);
    result = ensureConceptualVisualAids(result.problem || '', result);

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

    // Return immediately with solution ID for client polling
    const totalTime = Date.now() - requestStartTime;
    console.log(`⏱️ [TIMING] Total request time: ${totalTime}ms`);

    res.json({
      ...result,
      solutionId,
      processingTime: totalTime
    });

    // Initialize verification store
    verificationStore.set(solutionId, {
      status: 'pending',
      confidence: 0,
      warnings: [],
      timestamp: Date.now()
    });

    // Start async verification in background
    void runVerificationPipeline(solutionId, result.problem || '', result)
      .catch(err => {
        console.error(`⚠️ Verification pipeline error for ${solutionId}:`, err);
        verificationStore.set(solutionId, {
          status: 'unverified',
          confidence: 0,
          warnings: ['Verification system encountered an error'],
          timestamp: Date.now()
        });
      });

    // Start async diagram generation in background
      if (diagrams.length > 0) {
        console.log(`🎨 Starting async generation of ${diagrams.length} diagram(s)...`);
        void generateDiagramsInBackground(solutionId, diagrams, result.steps);
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

app.get('/api/diagram-file/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    if (!/^[\w.-]+$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const filePath = path.join(process.cwd(), 'public', 'diagrams', filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Diagram not found' });
    }

    res.sendFile(filePath);
  } catch (error) {
    console.error('Error serving diagram file:', error);
    res.status(500).json({ error: 'Failed to serve diagram file' });
  }
});

// Endpoint to poll for regenerated solutions (WolframAlpha fallback)
app.get('/api/solution/:solutionId', async (req, res) => {
  try {
    const { solutionId } = req.params;
    
    const storedSolution = solutionStore.get(solutionId);
    if (!storedSolution) {
      return res.status(404).json({ error: 'No regenerated solution available' });
    }
    
    res.json({
      solution: storedSolution.solution,
      regenerated: storedSolution.regenerated,
      timestamp: storedSolution.timestamp
    });
  } catch (error) {
    console.error('Error fetching solution:', error);
    res.status(500).json({ error: 'Failed to fetch solution' });
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
