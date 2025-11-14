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
      <Text style={{ fontSize, color, lineHeight: fontSize * LINE_HEIGHT_MULTIPLIER }}>
        {renderInlineContent(parsedContent, fontSize, color, isOnGreenBackground)}
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
          {renderCluster(cluster.parts, clusterIndex, fontSize, color, isOnGreenBackground)}
        </View>
      ))}
    </View>
  );
}

function renderCluster(
  parts: MathNode[],
  clusterIndex: number,
  baseFontSize: number,
  baseColor: string,
  isOnGreenBg: boolean,
): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  let currentInline: React.ReactNode[] = [];

  const flushInline = () => {
    if (currentInline.length === 0) {
      return;
    }

    elements.push(
      <Text
        key={`cluster-${clusterIndex}-inline-${elements.length}`}
        style={[
          styles.inlineText,
          {
            fontSize: baseFontSize,
            color: baseColor,
            lineHeight: baseFontSize * LINE_HEIGHT_MULTIPLIER,
          },
        ]}
      >
        {currentInline}
      </Text>,
    );

    currentInline = [];
  };

  parts.forEach((part, partIndex) => {
    if (part.type === 'fraction' || part.type === 'image') {
      flushInline();
      elements.push(
        renderComplexPart(part, `cluster-${clusterIndex}-complex-${partIndex}`, baseFontSize, baseColor, isOnGreenBg),
      );
      return;
    }

    currentInline.push(
      renderInlineSpan(part, `cluster-${clusterIndex}-text-${partIndex}`, baseFontSize, baseColor, isOnGreenBg),
    );
  });

  flushInline();

  return elements;
}

function renderInlineContent(
  parts: MathNode[],
  baseFontSize: number,
  baseColor: string,
  isOnGreenBg: boolean,
): React.ReactNode[] {
  return parts.map((part, index) =>
    renderInlineSpan(part, `inline-${index}`, baseFontSize, baseColor, isOnGreenBg),
  );
}

function renderInlineSpan(
  part: MathNode,
  key: string,
  baseFontSize: number,
  baseColor: string,
  isOnGreenBg: boolean,
): React.ReactNode {
  const handwritingStyle = part.isHandwritten
    ? { fontFamily: 'Caveat', fontSize: baseFontSize * 1.25, fontWeight: '600' as const }
    : null;

  switch (part.type) {
    case 'highlighted': {
      const highlightColor = getHighlightColor(part.color || '');
      return (
        <Text
          key={key}
          style={[
            { color: highlightColor, fontWeight: '600', lineHeight: baseFontSize * LINE_HEIGHT_MULTIPLIER },
            handwritingStyle,
          ]}
        >
          {part.content}
        </Text>
      );
    }

    case 'arrow': {
      const arrowColor = isOnGreenBg ? '#ffffff' : colors.secondary;
      return (
        <Text
          key={key}
          style={[
            {
              color: arrowColor,
              fontSize: baseFontSize * 1.35,
              fontWeight: '700',
              lineHeight: baseFontSize * LINE_HEIGHT_MULTIPLIER,
              paddingHorizontal: baseFontSize * 0.1,
            },
            handwritingStyle,
          ]}
        >
          {' → '}
        </Text>
      );
    }

    case 'italic':
      return (
        <Text
          key={key}
          style={[
            { fontStyle: 'italic', color: baseColor, lineHeight: baseFontSize * LINE_HEIGHT_MULTIPLIER },
            handwritingStyle,
          ]}
        >
          {part.content}
        </Text>
      );

    case 'subscript': {
      const subscriptText = part.content.split('').map(char => SUBSCRIPT_MAP[char] || char).join('');
      return (
        <Text
          key={key}
          style={[
            {
              fontSize: baseFontSize * 0.72,
              color: baseColor,
              lineHeight: baseFontSize,
              position: 'relative',
              top: baseFontSize * 0.18,
            },
            handwritingStyle,
          ]}
        >
          {subscriptText}
        </Text>
      );
    }

    case 'superscript': {
      const superscriptText = part.content.split('').map(char => SUPERSCRIPT_MAP[char] || char).join('');
      return (
        <Text
          key={key}
          style={[
            {
              fontSize: baseFontSize * 0.72,
              color: baseColor,
              lineHeight: baseFontSize,
              position: 'relative',
              top: -baseFontSize * 0.25,
            },
            handwritingStyle,
          ]}
        >
          {superscriptText}
        </Text>
      );
    }

    case 'text':
    default:
      if (part.isHandwritten) {
        return (
          <Text
            key={key}
            style={[
              {
                color: baseColor,
                lineHeight: baseFontSize * LINE_HEIGHT_MULTIPLIER,
              },
              handwritingStyle,
            ]}
          >
            {part.content}
          </Text>
        );
      }

      return <React.Fragment key={key}>{part.content}</React.Fragment>;
  }
}

// Render all parts (including fractions/images) as View children
function renderComplexPart(
  part: MathNode,
  key: string,
  baseFontSize: number,
  baseColor: string,
  isOnGreenBg: boolean,
): React.ReactNode {
  const handwritingStyle = part.isHandwritten
    ? { fontFamily: 'Caveat', fontWeight: '600' as const }
    : null;

  switch (part.type) {
    case 'fraction': {
      const fractionColor = part.color ? getHighlightColor(part.color) : baseColor;
      const fractionWeight = part.color ? '600' : 'normal';
      const fractionFontSize = baseFontSize * 0.82;
      const lineThickness = Math.max(1, Math.round(baseFontSize / 14));

      return (
        <View key={key} style={[styles.fractionContainer, { marginHorizontal: baseFontSize * 0.12 }]}> 
          <Text
            style={[
              styles.fractionText,
              {
                fontSize: fractionFontSize,
                color: fractionColor,
                fontWeight: fractionWeight,
                lineHeight: fractionFontSize * 1.1,
              },
              handwritingStyle,
            ]}
          >
            {part.numerator}
          </Text>
          <View
            style={[
              styles.fractionLine,
              {
                backgroundColor: fractionColor,
                height: lineThickness,
                marginVertical: baseFontSize * 0.08,
              },
            ]}
          />
          <Text
            style={[
              styles.fractionText,
              {
                fontSize: fractionFontSize,
                color: fractionColor,
                fontWeight: fractionWeight,
                lineHeight: fractionFontSize * 1.1,
              },
              handwritingStyle,
            ]}
          >
            {part.denominator}
          </Text>
        </View>
      );
    }

    case 'image':
      if (part.url) {
        return (
          <View key={key} style={styles.imageContainer}>
            <Image
              source={{ uri: part.url }}
              style={styles.image}
              resizeMode="contain"
            />
            {part.content ? (
              <Text style={[styles.imageCaption, { fontSize: baseFontSize * 0.85, lineHeight: baseFontSize }]}>
                {part.content}
              </Text>
            ) : null}
          </View>
        );
      }
      return null;

    default:
      return (
        <Text
          key={key}
          style={[
            { fontSize: baseFontSize, color: baseColor, lineHeight: baseFontSize * LINE_HEIGHT_MULTIPLIER },
            handwritingStyle,
          ]}
        >
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

const LINE_HEIGHT_MULTIPLIER = 1.35;

const styles = StyleSheet.create({
  lineContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    maxWidth: '100%',
  },
  cluster: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'flex-end',
    flexShrink: 1,
    maxWidth: '100%',
    rowGap: 0,
    columnGap: 0,
  },
  inlineText: {
    flexShrink: 1,
  },
  fractionContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  fractionText: {
    textAlign: 'center',
  },
  fractionLine: {
    width: '100%',
  },
  imageContainer: {
    width: '100%',
    marginVertical: 8,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  image: {
    width: '100%',
    maxWidth: '100%',
    aspectRatio: 1,
    borderRadius: 8,
  },
  imageCaption: {
    marginTop: 4,
    color: colors.textSecondary,
    textAlign: 'center',
  },
});
