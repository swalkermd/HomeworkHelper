// Math content formatting utilities for structured, non-breaking layout

import { ContentBlock, MathNode } from '../types/math';

// Patterns for non-breaking groups
const NON_BREAKING_PATTERNS = [
  // Function notation: f(x), v(t), s(2), etc.
  /\b[a-zA-Z]\([^)]+\)/g,
  
  // Interval notation: (0, 1/2), [1, 3), etc.
  /[\(\[][\s\d\/\.,\{\}+-]+[\)\]]/g,
  
  // Equations with operators: = ± × ÷ → ≤ ≥
  /[=±×÷→≤≥]/g,
  
  // Tagged fractions: t = {1/2}, x = {3/4}
  /\w+\s*=\s*\{[^}]+\}/g,
  
  // Simple fractions with context: t = 1/2
  /\w+\s*=\s*\d+\/\d+/g,
];

/**
 * Normalize solution content into structured blocks
 * Handles multi-part answers (a), b), c)...) and preserves non-breaking groups
 */
export function normalizeSolutionContent(content: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (!content.trim()) {
    return blocks;
  }

  const labelPattern = /(^|\s)([a-z]\)|\([a-z]\)|\d+\)|\(\d+\))\s+/gi;
  const normalizedContent = content.replace(/\r\n/g, '\n').trim();

  const labelMatches = [...normalizedContent.matchAll(labelPattern)];
  const hasMultipleLabels = labelMatches.length >= 2;

  if (hasMultipleLabels) {
    // Insert hard breaks before labels that appear mid-line so each part can be processed individually
    const preparedContent = normalizedContent.replace(
      /(\s+)(?=([a-z]\)|\([a-z]\)|\d+\)|\(\d+\))\s+)/gi,
      '\n',
    );

    const lines = preparedContent
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const match = line.match(/^([a-z]\)|\([a-z]\)|\d+\)|\(\d+\))\s*/i);

      if (match) {
        const label = match[1];
        const remainingContent = line.substring(match[0].length).trim();

        blocks.push({
          type: 'block',
          label,
          content: remainingContent,
        });
      } else if (blocks.length > 0) {
        // Continuation of previous part
        blocks[blocks.length - 1].content = `${blocks[blocks.length - 1].content} ${line}`.trim();
      } else {
        blocks.push({
          type: 'block',
          content: line,
        });
      }
    }
  } else {
    blocks.push({
      type: 'block',
      content: normalizedContent,
    });
  }

  return blocks;
}

/**
 * Check if a text segment should be kept as non-breaking
 * Returns true for equations, intervals, function notation, etc.
 */
export function isNonBreakingSegment(text: string): boolean {
  // Check against all non-breaking patterns
  for (const pattern of NON_BREAKING_PATTERNS) {
    pattern.lastIndex = 0; // Reset regex
    if (pattern.test(text)) {
      return true;
    }
  }
  
  // Check for color tags with math content
  if (/\[(?:red|blue|green|purple|orange|pink|yellow):[^\]]+\]/.test(text)) {
    return true;
  }
  
  // Check for fractions in curly braces
  if (/\{\d+\/\d+\}/.test(text)) {
    return true;
  }
  
  return false;
}

// Token types for math content
export type MathToken = {
  type: 'number' | 'identifier' | 'operator' | 'delimiter' | 'whitespace' | 'special' | 'text';
  value: string;
  sticky?: boolean; // Should stick to adjacent tokens
};

// Cluster of tokens that should not break across lines
export type TokenCluster = {
  tokens: MathToken[];
  canBreakAfter: boolean; // Can we break to new line after this cluster?
};

/**
 * Tokenize text content into math tokens
 * Breaks down text like "v(t) = 12t^2 - 30t" into individual math atoms
 */
export function tokenizeMathText(text: string): MathToken[] {
  const tokens: MathToken[] = [];
  let i = 0;
  
  while (i < text.length) {
    const char = text[i];
    
    // Whitespace
    if (/\s/.test(char)) {
      tokens.push({ type: 'whitespace', value: char });
      i++;
      continue;
    }
    
    // Numbers (including decimals)
    if (/\d/.test(char)) {
      let num = '';
      while (i < text.length && /[\d.]/.test(text[i])) {
        num += text[i];
        i++;
      }
      tokens.push({ type: 'number', value: num });
      continue;
    }
    
    // Operators and sticky symbols
    if ('=+-×÷→≤≥±'.includes(char)) {
      tokens.push({ type: 'operator', value: char, sticky: true });
      i++;
      continue;
    }
    
    // Delimiters
    if ('()[]{},.;:'.includes(char)) {
      tokens.push({ type: 'delimiter', value: char, sticky: char === '(' || char === ',' });
      i++;
      continue;
    }
    
    // Identifiers (variable names, function names)
    if (/[a-zA-Z]/.test(char)) {
      let ident = '';
      while (i < text.length && /[a-zA-Z]/.test(text[i])) {
        ident += text[i];
        i++;
      }
      tokens.push({ type: 'identifier', value: ident });
      continue;
    }
    
    // Everything else is text
    tokens.push({ type: 'text', value: char });
    i++;
  }
  
  return tokens;
}

/**
 * Cluster tokens into non-breaking groups
 * Handles patterns like:
 * - Function calls: f(x), v(t)
 * - Equations: v = 12
 * - Intervals: (0, 1/2)
 * - Lists: a, b, c
 */
export function clusterizeTokens(tokens: MathToken[]): TokenCluster[] {
  const clusters: TokenCluster[] = [];
  let currentCluster: MathToken[] = [];
  
  const flushCluster = (canBreak: boolean = true) => {
    if (currentCluster.length > 0) {
      clusters.push({ tokens: currentCluster, canBreakAfter: canBreak });
      currentCluster = [];
    }
  };
  
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : null;
    const next = i < tokens.length - 1 ? tokens[i + 1] : null;
    
    // Function call pattern: identifier followed by (
    if (token.type === 'identifier' && next?.value === '(') {
      currentCluster.push(token);
      currentCluster.push(next);
      i++; // Skip the (
      
      // Collect until matching )
      let depth = 1;
      i++;
      while (i < tokens.length && depth > 0) {
        const t = tokens[i];
        currentCluster.push(t);
        if (t.value === '(') depth++;
        if (t.value === ')') depth--;
        i++;
      }
      i--; // Back up one since loop will increment
      continue;
    }
    
    // Interval pattern: ( followed by content until )
    if (token.value === '(' && token.type === 'delimiter') {
      currentCluster.push(token);
      i++;
      
      // Collect until matching )
      let depth = 1;
      while (i < tokens.length && depth > 0) {
        const t = tokens[i];
        currentCluster.push(t);
        if (t.value === '(') depth++;
        if (t.value === ')') depth--;
        i++;
      }
      i--; // Back up one
      continue;
    }
    
    // Sticky operators (=, ±, etc.) keep tokens together
    if (token.sticky) {
      currentCluster.push(token);
      continue;
    }
    
    // Comma - could be end of cluster or continuation
    if (token.value === ',') {
      currentCluster.push(token);
      // Check if next is whitespace then text (new list item)
      if (next?.type === 'whitespace') {
        const afterSpace = i + 2 < tokens.length ? tokens[i + 2] : null;
        if (afterSpace && (afterSpace.type === 'identifier' || afterSpace.type === 'number')) {
          // This is a list separator - break here
          flushCluster(true);
          continue;
        }
      }
      continue;
    }
    
    // Whitespace - potential break point
    if (token.type === 'whitespace') {
      // Check if we're in middle of sticky group
      if (prev?.sticky || next?.sticky) {
        currentCluster.push(token);
      } else {
        // Break opportunity
        currentCluster.push(token);
        flushCluster(true);
      }
      continue;
    }
    
    // Regular token - add to current cluster
    currentCluster.push(token);
  }
  
  // Flush remaining
  flushCluster(true);
  
  return clusters;
}

/**
 * Split content into non-breaking clusters (simple string-based version)
 * Each cluster should be rendered without internal line breaks
 */
export function clusterizeContent(content: string): string[] {
  const tokens = tokenizeMathText(content);
  const clusters = clusterizeTokens(tokens);
  
  return clusters.map(cluster => 
    cluster.tokens.map(t => t.value).join('')
  );
}

export interface ParsedPartCluster {
  parts: MathNode[];  // Original parts with all formatting preserved
  canBreakAfter: boolean;
}

/**
 * Cluster ParsedPart[] array into non-breaking groups
 * SIMPLIFIED: Keep highlighted content and fractions as non-breaking units
 */
export function clusterizeParsedParts(parsedContent: MathNode[]): ParsedPartCluster[] {
  const clusters: ParsedPartCluster[] = [];
  let currentCluster: MathNode[] = [];
  
  const flushCluster = () => {
    if (currentCluster.length > 0) {
      clusters.push({ parts: currentCluster, canBreakAfter: true });
      currentCluster = [];
    }
  };
  
  for (let i = 0; i < parsedContent.length; i++) {
    const part = parsedContent[i];
    const next = i < parsedContent.length - 1 ? parsedContent[i + 1] : null;
    
    // Strategy: Keep entire highlighted spans as non-breaking units
    // Keep fractions with adjacent context
    // Allow regular text to break naturally
    
    if (part.type === 'highlighted') {
      // Highlighted content (colored text) should never break
      // Flush current cluster and make highlighted span its own cluster
      flushCluster();
      currentCluster.push(part);
      
      // Check if next part is also highlighted or a fraction - keep together
      if (next && (next.type === 'highlighted' || next.type === 'fraction')) {
        currentCluster.push(next);
        i++; // Skip next
      }
      
      flushCluster();
    } else if (part.type === 'fraction' || part.type === 'image') {
      // Keep fraction with current cluster if there's content before it
      // This handles "= {1/2}" staying together
      if (currentCluster.length > 0) {
        currentCluster.push(part);
        
        // Check for suffix (unit, hyphen, closing delimiter)
        if (next && next.type === 'text' && /^[-\u2013\u2014a-z\s\)\]\},;:]/i.test(next.content) && next.content.length < 10) {
          currentCluster.push(next);
          i++; // Skip next
        }
        
        flushCluster();
      } else {
        // Standalone fraction
        currentCluster.push(part);
        
        // Check for suffix
        if (next && next.type === 'text' && /^[-\u2013\u2014a-z\s\)\]\},;:]/i.test(next.content) && next.content.length < 10) {
          currentCluster.push(next);
          i++; // Skip next
        }
        
        flushCluster();
      }
    } else {
      // Regular text, arrow, subscript, superscript
      // Keep with current cluster
      currentCluster.push(part);
      
      // Check if we should flush based on content
      const content = part.content || '';
      
      // Flush after punctuation or long segments
      if (content.includes(',') || content.includes('.') || content.length > 30) {
        flushCluster();
      }
    }
  }
  
  // Flush any remaining
  flushCluster();
  
  return clusters;
}
