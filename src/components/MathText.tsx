import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { typography, colors } from '../constants/theme';

interface MathTextProps {
  content: string;
  fontSize?: number;
  color?: string;
  isOnGreenBackground?: boolean;
}

interface ParsedPart {
  type: 'text' | 'fraction' | 'highlighted' | 'arrow' | 'italic' | 'image' | 'subscript' | 'superscript' | 'handwritten';
  content: string;
  color?: string;
  url?: string;
  numerator?: string;
  denominator?: string;
  isHandwritten?: boolean; // Flag for applying handwriting font style
}

const SUPERSCRIPT_MAP: { [key: string]: string } = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
};

const SUBSCRIPT_MAP: { [key: string]: string } = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
};

export default function MathText({ content, fontSize = 14, color = colors.textPrimary, isOnGreenBackground = false }: MathTextProps) {
  // Parse the content directly without splitting on newlines
  // All newlines are already removed server-side
  const parsedContent = parseContent(content);
  
  // Check if content has fractions or images (which require View components)
  const hasComplexElements = parsedContent.some(part => part.type === 'fraction' || part.type === 'image');
  
  // If no fractions/images, use nested Text for proper inline flow (prevents unwanted line breaks)
  if (!hasComplexElements) {
    return (
      <Text style={{ fontSize, color }}>
        {parsedContent.map((part, index) => renderTextPart(part, index, fontSize, color, isOnGreenBackground))}
      </Text>
    );
  }
  
  // For content with fractions/images: group consecutive text parts together
  // CRITICAL FIX: Keep hyphen/unit suffixes attached to preceding fractions to prevent line breaks
  const groupedElements: React.ReactNode[] = [];
  let currentTextGroup: ParsedPart[] = [];
  let skipNext = false;
  
  for (let index = 0; index < parsedContent.length; index++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    
    const part = parsedContent[index];
    
    if (part.type === 'fraction' || part.type === 'image') {
      // Flush accumulated text group first
      if (currentTextGroup.length > 0) {
        groupedElements.push(
          <Text key={`text-group-${groupedElements.length}`} style={{ fontSize, color }}>
            {currentTextGroup.map((textPart, i) => renderTextPart(textPart, i, fontSize, color, isOnGreenBackground))}
          </Text>
        );
        currentTextGroup = [];
      }
      
      // Check if next part is text starting with hyphen or unit suffix
      // If so, wrap fraction + suffix together to prevent line break
      const nextPart = index + 1 < parsedContent.length ? parsedContent[index + 1] : null;
      const startsWithHyphenOrUnit = nextPart && 
                                     nextPart.type === 'text' && 
                                     /^[-\u2013\u2014]/.test(nextPart.content); // Matches hyphen, en-dash, em-dash
      
      if (startsWithHyphenOrUnit && nextPart) {
        // Wrap fraction + suffix in same View to keep them together
        groupedElements.push(
          <View key={`fraction-group-${index}`} style={{ flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'baseline' }}>
            {renderPart(part, index, fontSize, color, isOnGreenBackground)}
            <Text style={{ fontSize, color }}>
              {renderTextPart(nextPart, index + 1, fontSize, color, isOnGreenBackground)}
            </Text>
          </View>
        );
        // Skip the next part since we already rendered it
        skipNext = true;
      } else {
        // Add the fraction/image alone
        groupedElements.push(renderPart(part, index, fontSize, color, isOnGreenBackground));
      }
    } else {
      // Accumulate text parts
      currentTextGroup.push(part);
    }
  }
  
  // Flush any remaining text group
  if (currentTextGroup.length > 0) {
    groupedElements.push(
      <Text key={`text-group-${groupedElements.length}`} style={{ fontSize, color }}>
        {currentTextGroup.map((textPart, i) => renderTextPart(textPart, i, fontSize, color, isOnGreenBackground))}
      </Text>
    );
  }
  
  return (
    <View style={styles.lineContainer}>
      {groupedElements}
    </View>
  );
}

// Helper function to parse highlighted content for nested fractions and formatting
function parseHighlightedContent(content: string, color: string): ParsedPart[] {
  const parts: ParsedPart[] = [];
  let i = 0;
  let currentText = '';

  while (i < content.length) {
    if (content[i] === '{' && content.indexOf('}', i) > i) {
      // Found a potential fraction
      if (currentText) {
        parts.push({ type: 'highlighted', content: currentText, color });
        currentText = '';
      }
      const endIndex = content.indexOf('}', i);
      const fractionContent = content.substring(i + 1, endIndex);
      const [num, den] = fractionContent.split('/');
      if (num && den) {
        // This is a fraction like {1/8} - render as fraction with color applied to numerator/denominator
        parts.push({
          type: 'fraction',
          content: fractionContent,
          numerator: num.trim(),
          denominator: den.trim(),
          color: color, // Store color to apply to fraction text
        });
      } else {
        // Just text in braces, add back to current text
        currentText += fractionContent;
      }
      i = endIndex + 1;
    } else {
      currentText += content[i];
      i++;
    }
  }

  if (currentText) {
    parts.push({ type: 'highlighted', content: currentText, color });
  }

  return parts;
}

// Helper function to parse handwritten content - uses full parseContent logic and marks all parts as handwritten
function parseHandwrittenContent(content: string): ParsedPart[] {
  // Parse using the full content parser to get all formatting types
  const parts = parseContentInternal(content, true);
  return parts;
}

// Helper function to find matching closing bracket with depth tracking
function findMatchingBracket(content: string, startIndex: number, openChar: string, closeChar: string): number {
  let depth = 1;
  let i = startIndex + 1;
  
  while (i < content.length && depth > 0) {
    if (content[i] === openChar) {
      depth++;
    } else if (content[i] === closeChar) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
    i++;
  }
  
  return -1; // No matching bracket found
}

// Internal content parser with optional handwritten flag
function parseContentInternal(content: string, isHandwritten: boolean = false): ParsedPart[] {
  const parts: ParsedPart[] = [];
  let i = 0;
  let currentText = '';

  while (i < content.length) {
    if (content[i] === '{' && content.indexOf('}', i) > i) {
      if (currentText) {
        parts.push({ type: 'text', content: currentText, isHandwritten });
        currentText = '';
      }
      const endIndex = content.indexOf('}', i);
      const fractionContent = content.substring(i + 1, endIndex);
      const [num, den] = fractionContent.split('/');
      if (num && den) {
        parts.push({
          type: 'fraction',
          content: fractionContent,
          numerator: num.trim(),
          denominator: den.trim(),
          isHandwritten,
        });
      } else {
        parts.push({ type: 'text', content: fractionContent, isHandwritten });
      }
      i = endIndex + 1;
    } else if (content[i] === '[' && content.indexOf(':', i) > i) {
      // Use bracket depth tracking to find the matching closing bracket
      const endIndex = findMatchingBracket(content, i, '[', ']');
      if (endIndex > i) {
        if (currentText) {
          parts.push({ type: 'text', content: currentText, isHandwritten });
          currentText = '';
        }
        const highlightContent = content.substring(i + 1, endIndex);
        const colonIndex = highlightContent.indexOf(':');
        if (colonIndex > -1) {
          const tagName = highlightContent.substring(0, colonIndex);
          const taggedText = highlightContent.substring(colonIndex + 1).trim();
      
          if (tagName.trim().toLowerCase() === 'handwritten') {
            // Don't nest handwritten tags - just parse the content as handwritten
            const handwrittenParts = parseContentInternal(taggedText, true);
            parts.push(...handwrittenParts);
          } else {
            // Color highlight - parse and preserve isHandwritten flag
            const highlightedParts = parseHighlightedContent(taggedText, tagName.trim());
            highlightedParts.forEach(part => {
              if (isHandwritten) part.isHandwritten = true;
            });
            parts.push(...highlightedParts);
          }
        } else {
          // No colon found, treat as regular text
          currentText += content[i];
          i++;
          continue;
        }
        
        i = endIndex + 1;
      } else {
        // No matching bracket found, treat as regular text
        currentText += content[i];
        i++;
      }
    } else if ((content.substring(i, i + 2) === '->' || content.substring(i, i + 2) === '=>')) {
      if (currentText) {
        parts.push({ type: 'text', content: currentText, isHandwritten });
        currentText = '';
      }
      parts.push({ type: 'arrow', content: content.substring(i, i + 2), isHandwritten });
      i += 2;
    } else if (content[i] === '(' && content.substring(i, i + 7) === '(IMAGE:') {
      const closingParenIndex = content.indexOf(')', i + 7);
      if (closingParenIndex > i) {
        if (currentText) {
          parts.push({ type: 'text', content: currentText, isHandwritten });
          currentText = '';
        }
        const imageContent = content.substring(i + 7, closingParenIndex);
        const separatorIndex = imageContent.indexOf('](');
        if (separatorIndex > -1) {
          const desc = imageContent.substring(0, separatorIndex).trim();
          const url = imageContent.substring(separatorIndex + 2).trim();
          parts.push({
            type: 'image',
            content: desc,
            url: url,
            isHandwritten,
          });
          i = closingParenIndex + 1;
        } else {
          currentText += content[i];
          i++;
        }
      } else {
        currentText += content[i];
        i++;
      }
    } else if (content[i] === '_' && content.indexOf('_', i + 1) > i) {
      if (currentText) {
        parts.push({ type: 'text', content: currentText, isHandwritten });
        currentText = '';
      }
      const endIndex = content.indexOf('_', i + 1);
      const subscriptContent = content.substring(i + 1, endIndex);
      parts.push({ type: 'subscript', content: subscriptContent, isHandwritten });
      i = endIndex + 1;
    } else if (content[i] === '^' && content.indexOf('^', i + 1) > i) {
      if (currentText) {
        parts.push({ type: 'text', content: currentText, isHandwritten });
        currentText = '';
      }
      const endIndex = content.indexOf('^', i + 1);
      const superscriptContent = content.substring(i + 1, endIndex);
      parts.push({ type: 'superscript', content: superscriptContent, isHandwritten });
      i = endIndex + 1;
    } else if (content[i] === '+' && content[i + 1] === '+' && content.indexOf('++', i + 2) > i) {
      if (currentText) {
        parts.push({ type: 'text', content: currentText, isHandwritten });
        currentText = '';
      }
      const endIndex = content.indexOf('++', i + 2);
      const italicContent = content.substring(i + 2, endIndex);
      parts.push({ type: 'italic', content: italicContent, isHandwritten });
      i = endIndex + 2;
    } else {
      currentText += content[i];
      i++;
    }
  }

  if (currentText) {
    parts.push({ type: 'text', content: currentText, isHandwritten });
  }

  return parts;
}

function parseContent(content: string): ParsedPart[] {
  // Use the internal parser with isHandwritten=false for regular content
  return parseContentInternal(content, false);
}

// Render text-only parts as nested Text (for inline flow without breaks)
function renderTextPart(part: ParsedPart, index: number, baseFontSize: number, baseColor: string, isOnGreenBg: boolean): React.ReactNode {
  // Helper to apply handwriting style wrapper if needed
  const wrapWithHandwriting = (element: React.ReactNode) => {
    if (part.isHandwritten) {
      return <Text key={index} style={{ fontFamily: 'Caveat', fontSize: baseFontSize * 1.3, fontWeight: '600' }}>{element}</Text>;
    }
    return element;
  };
  
  switch (part.type) {
    case 'highlighted':
      const highlightColor = getHighlightColor(part.color || '');
      const highlightElement = (
        <Text style={{ color: highlightColor, fontWeight: '600' }}>
          {part.content}
        </Text>
      );
      return wrapWithHandwriting(highlightElement);
    
    case 'arrow':
      const arrowColor = isOnGreenBg ? '#ffffff' : colors.secondary;
      return wrapWithHandwriting(
        <Text style={{ fontSize: baseFontSize * 1.5, fontWeight: '900', color: arrowColor }}>
          {' → '}
        </Text>
      );
    
    case 'italic':
      return wrapWithHandwriting(
        <Text style={{ fontStyle: 'italic' }}>
          {part.content}
        </Text>
      );
    
    case 'subscript':
      const subscriptText = part.content.split('').map(char => SUBSCRIPT_MAP[char] || char).join('');
      return wrapWithHandwriting(
        <Text style={{ fontSize: baseFontSize * 0.7 }}>
          {subscriptText}
        </Text>
      );
    
    case 'superscript':
      const superscriptText = part.content.split('').map(char => SUPERSCRIPT_MAP[char] || char).join('');
      return wrapWithHandwriting(
        <Text style={{ fontSize: baseFontSize * 0.7 }}>
          {superscriptText}
        </Text>
      );
    
    default: // 'text'
      if (part.isHandwritten) {
        return <Text key={index} style={{ fontFamily: 'Caveat', fontSize: baseFontSize * 1.3, fontWeight: '600' }}>{part.content}</Text>;
      }
      return part.content;
  }
}

// Render all parts (including fractions/images) as View children
function renderPart(part: ParsedPart, index: number, baseFontSize: number, baseColor: string, isOnGreenBg: boolean): React.ReactNode {
  // Helper to get font style for handwritten content
  const getHandwritingStyle = () => part.isHandwritten ? { fontFamily: 'Caveat', fontSize: baseFontSize * 1.3, fontWeight: '600' as const } : {};
  
  switch (part.type) {
    case 'fraction':
      // Use the fraction's color if specified (for highlighted fractions), otherwise use base color
      const fractionColor = part.color ? getHighlightColor(part.color) : baseColor;
      const fractionWeight = part.color ? '600' : 'normal'; // Bold if highlighted
      const fractionFont = part.isHandwritten ? { fontFamily: 'Caveat', fontWeight: '600' as const } : {};
      return (
        <View key={index} style={styles.fractionContainer}>
          <Text style={[styles.fractionText, { fontSize: baseFontSize * 0.7, color: fractionColor, fontWeight: fractionWeight }, fractionFont]}>
            {part.numerator}
          </Text>
          <View style={[styles.fractionLine, { backgroundColor: fractionColor }]} />
          <Text style={[styles.fractionText, { fontSize: baseFontSize * 0.7, color: fractionColor, fontWeight: fractionWeight }, fractionFont]}>
            {part.denominator}
          </Text>
        </View>
      );
    
    case 'highlighted':
      const highlightColor = getHighlightColor(part.color || '');
      return (
        <Text key={index} style={[{ fontSize: baseFontSize, color: highlightColor, fontWeight: '600' }, getHandwritingStyle()]}>
          {part.content}
        </Text>
      );
    
    case 'arrow':
      const arrowColor = isOnGreenBg ? '#ffffff' : colors.secondary;
      return (
        <Text key={index} style={[{ fontSize: baseFontSize * 1.5, fontWeight: '900', color: arrowColor }, getHandwritingStyle()]}>
          {' → '}
        </Text>
      );
    
    case 'italic':
      return (
        <Text key={index} style={[{ fontSize: baseFontSize, color: baseColor, fontStyle: 'italic' }, getHandwritingStyle()]}>
          {part.content}
        </Text>
      );
    
    case 'subscript':
      const subscriptText = part.content.split('').map(char => SUBSCRIPT_MAP[char] || char).join('');
      return (
        <Text key={index} style={[{ fontSize: baseFontSize * 0.7, color: baseColor }, getHandwritingStyle()]}>
          {subscriptText}
        </Text>
      );
    
    case 'superscript':
      const superscriptText = part.content.split('').map(char => SUPERSCRIPT_MAP[char] || char).join('');
      return (
        <Text key={index} style={[{ fontSize: baseFontSize * 0.7, color: baseColor }, getHandwritingStyle()]}>
          {superscriptText}
        </Text>
      );
    
    case 'image':
      if (part.url) {
        return (
          <View key={index} style={styles.imageContainer}>
            <Image
              source={{ uri: part.url }}
              style={styles.image}
              resizeMode="contain"
            />
            <Text style={[styles.imageCaption, { fontSize: baseFontSize * 0.8 }]}>
              {part.content}
            </Text>
          </View>
        );
      }
      return null;
    
    case 'text':
    default:
      return (
        <Text key={index} style={[{ fontSize: baseFontSize, color: baseColor }, getHandwritingStyle()]}>
          {part.content}
        </Text>
      );
  }
}

function getHighlightColor(colorName: string): string {
  const colorMap: { [key: string]: string } = {
    red: '#ef4444',
    blue: '#3b82f6',
    green: '#10b981',
    purple: '#8b5cf6',
    orange: '#f97316',
    pink: '#ec4899',
    yellow: '#eab308',
    teal: '#14b8a6',
    indigo: '#6366f1',
  };
  return colorMap[colorName.toLowerCase()] || colors.textPrimary;
}

const styles = StyleSheet.create({
  lineContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
  },
  fractionContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 2,
    transform: [{ translateY: -8 }],
  },
  fractionText: {
    textAlign: 'center',
    lineHeight: 12,
  },
  fractionLine: {
    height: 1,
    width: '100%',
    marginVertical: 1,
  },
  imageContainer: {
    width: '100%',
    marginVertical: 8,
    alignItems: 'center',
  },
  image: {
    width: '100%',
    maxWidth: 400,
    aspectRatio: 1,
    borderRadius: 8,
  },
  imageCaption: {
    marginTop: 4,
    color: colors.textSecondary,
    textAlign: 'center',
  },
});
