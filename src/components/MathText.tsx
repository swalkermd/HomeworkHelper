import React from 'react';
import { Text, View, Image, StyleSheet } from 'react-native';
import { typography, colors } from '../constants/theme';

interface MathTextProps {
  content: string;
  fontSize?: number;
  color?: string;
  isOnGreenBackground?: boolean;
}

interface ParsedPart {
  type: 'text' | 'fraction' | 'highlighted' | 'arrow' | 'italic' | 'image' | 'subscript' | 'superscript';
  content: string;
  color?: string;
  url?: string;
  numerator?: string;
  denominator?: string;
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
  const parsedContent = parseContent(content);

  return (
    <View style={styles.container}>
      <Text style={[styles.text, { fontSize, color }]}>
        {parsedContent.map((part, index) => renderPart(part, index, fontSize, color, isOnGreenBackground))}
      </Text>
    </View>
  );
}

function parseContent(content: string): ParsedPart[] {
  const parts: ParsedPart[] = [];
  let i = 0;
  let currentText = '';

  while (i < content.length) {
    if (content[i] === '{' && content.indexOf('}', i) > i) {
      if (currentText) {
        parts.push({ type: 'text', content: currentText });
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
        });
      }
      i = endIndex + 1;
    } else if (content[i] === '[' && content.indexOf(':', i) > i && content.indexOf(']', i) > i) {
      if (currentText) {
        parts.push({ type: 'text', content: currentText });
        currentText = '';
      }
      const endIndex = content.indexOf(']', i);
      const highlightContent = content.substring(i + 1, endIndex);
      const [colorName, ...textParts] = highlightContent.split(':');
      parts.push({
        type: 'highlighted',
        content: textParts.join(':').trim(),
        color: colorName.trim(),
      });
      i = endIndex + 1;
    } else if ((content.substring(i, i + 2) === '->' || content.substring(i, i + 2) === '=>')) {
      if (currentText) {
        parts.push({ type: 'text', content: currentText });
        currentText = '';
      }
      parts.push({ type: 'arrow', content: content.substring(i, i + 2) });
      i += 2;
    } else if (content[i] === '(' && content.substring(i, i + 7) === '(IMAGE:' && content.indexOf(']', i) > i) {
      if (currentText) {
        parts.push({ type: 'text', content: currentText });
        currentText = '';
      }
      const endIndex = content.indexOf(']', i);
      const imageContent = content.substring(i + 7, endIndex);
      const [desc, url] = imageContent.split('](');
      parts.push({
        type: 'image',
        content: desc.trim(),
        url: url?.trim(),
      });
      i = endIndex + 1;
    } else if (content[i] === '_' && content.indexOf('_', i + 1) > i) {
      if (currentText) {
        parts.push({ type: 'text', content: currentText });
        currentText = '';
      }
      const endIndex = content.indexOf('_', i + 1);
      const subscriptContent = content.substring(i + 1, endIndex);
      parts.push({ type: 'subscript', content: subscriptContent });
      i = endIndex + 1;
    } else if (content[i] === '^' && content.indexOf('^', i + 1) > i) {
      if (currentText) {
        parts.push({ type: 'text', content: currentText });
        currentText = '';
      }
      const endIndex = content.indexOf('^', i + 1);
      const superscriptContent = content.substring(i + 1, endIndex);
      parts.push({ type: 'superscript', content: superscriptContent });
      i = endIndex + 1;
    } else if (content[i] === '+' && content.indexOf('+', i + 1) > i) {
      if (currentText) {
        parts.push({ type: 'text', content: currentText });
        currentText = '';
      }
      const endIndex = content.indexOf('+', i + 1);
      const italicContent = content.substring(i + 1, endIndex);
      parts.push({ type: 'italic', content: italicContent });
      i = endIndex + 1;
    } else {
      currentText += content[i];
      i++;
    }
  }

  if (currentText) {
    parts.push({ type: 'text', content: currentText });
  }

  return parts;
}

function renderPart(part: ParsedPart, index: number, baseFontSize: number, baseColor: string, isOnGreenBg: boolean): React.ReactNode {
  switch (part.type) {
    case 'fraction':
      return (
        <View key={index} style={styles.fractionContainer}>
          <Text style={[styles.fractionText, { fontSize: baseFontSize * 0.7, color: baseColor }]}>
            {part.numerator}
          </Text>
          <View style={[styles.fractionLine, { backgroundColor: baseColor }]} />
          <Text style={[styles.fractionText, { fontSize: baseFontSize * 0.7, color: baseColor }]}>
            {part.denominator}
          </Text>
        </View>
      );
    
    case 'highlighted':
      const highlightColor = getHighlightColor(part.color || '');
      return (
        <Text key={index} style={{ color: highlightColor, fontWeight: '600' }}>
          {part.content}
        </Text>
      );
    
    case 'arrow':
      const arrowColor = isOnGreenBg ? '#ffffff' : colors.secondary;
      return (
        <Text key={index} style={{ fontSize: baseFontSize * 1.5, fontWeight: '900', color: arrowColor }}>
          {' → '}
        </Text>
      );
    
    case 'italic':
      return (
        <Text key={index} style={{ fontStyle: 'italic' }}>
          {part.content}
        </Text>
      );
    
    case 'subscript':
      const subscriptText = part.content.split('').map(char => SUBSCRIPT_MAP[char] || char).join('');
      return (
        <Text key={index} style={{ fontSize: baseFontSize * 0.7 }}>
          {subscriptText}
        </Text>
      );
    
    case 'superscript':
      const superscriptText = part.content.split('').map(char => SUPERSCRIPT_MAP[char] || char).join('');
      return (
        <Text key={index} style={{ fontSize: baseFontSize * 0.7 }}>
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
      return <Text key={index}>{part.content}</Text>;
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
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  text: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  fractionContainer: {
    alignItems: 'center',
    marginHorizontal: 2,
  },
  fractionText: {
    textAlign: 'center',
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
    width: 300,
    height: 300,
    borderRadius: 8,
  },
  imageCaption: {
    marginTop: 4,
    color: colors.textSecondary,
    textAlign: 'center',
  },
});
