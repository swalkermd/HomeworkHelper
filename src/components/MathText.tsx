import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { colors } from '../constants/theme';
import { clusterizeParsedParts } from '../utils/mathFormatter';
import { parseMathContent } from '../utils/mathParser';
import { MathNode } from '../types/math';

interface MathTextProps {
  content: string;
  structuredContent?: MathNode[];
  fontSize?: number;
  color?: string;
  isOnGreenBackground?: boolean;
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

export default function MathText({
  content,
  structuredContent,
  fontSize = 14,
  color = colors.textPrimary,
  isOnGreenBackground = false,
}: MathTextProps) {
  const parsedContent = structuredContent && structuredContent.length > 0
    ? structuredContent
    : parseMathContent(content);
  
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
  
  // For content with fractions/images: create non-breaking clusters
  // Cluster ParsedPart[] directly to preserve all formatting (colors, fractions, etc.)
  const partClusters = clusterizeParsedParts(parsedContent);
  
  return (
    <View style={styles.lineContainer}>
      {partClusters.map((cluster, clusterIndex) => (
        <View key={`cluster-${clusterIndex}`} style={styles.cluster}>
          {cluster.parts.map((part, partIndex) => {
            const key = `${clusterIndex}-${partIndex}`;
            
            // Handle fractions and complex parts with views
            if (part.type === 'fraction' || part.type === 'image') {
              return renderPart(part, partIndex, fontSize, color, isOnGreenBackground);
            }

            // Handle text parts inline
            return renderTextPart(part, partIndex, fontSize, color, isOnGreenBackground);
          })}
        </View>
      ))}
    </View>
  );
}

// Render text-only parts as nested Text (for inline flow without breaks)
function renderTextPart(part: MathNode, index: number, baseFontSize: number, baseColor: string, isOnGreenBg: boolean): React.ReactNode {
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
        <Text style={{ fontSize: baseFontSize * 1.5, fontWeight: '900', color: arrowColor, position: 'relative', top: 3 }}>
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
function renderPart(part: MathNode, index: number, baseFontSize: number, baseColor: string, isOnGreenBg: boolean): React.ReactNode {
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
        <Text key={index} style={[{ fontSize: baseFontSize * 1.5, fontWeight: '900', color: arrowColor, position: 'relative', top: 3 }, getHandwritingStyle()]}>
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
  cluster: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'baseline',
  },
  fractionContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 2,
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
