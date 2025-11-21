// Professional structured layout for multi-part final answers

import React from 'react';
import { View, Text, StyleSheet, TextStyle } from 'react-native';
import MathText from './MathText';
import { normalizeSolutionContent } from '../utils/mathFormatter';
import { parseMathContent } from '../utils/mathParser';
import { colors } from '../constants/theme';
import { MathNode } from '../types/math';

interface FinalAnswerSectionProps {
  content: string;
  structuredContent?: MathNode[];
  isOnGreenBackground?: boolean;
  allowHandwriting?: boolean;
}

function stripHandwrittenTags(text: string): string {
  if (!text || !text.toLowerCase().includes('[handwritten:')) {
    return text;
  }

  const target = '[handwritten:';
  const lowerTarget = target.toLowerCase();
  const tagLength = target.length;
  let result = '';

  for (let i = 0; i < text.length;) {
    if (text.slice(i, i + tagLength).toLowerCase() === lowerTarget) {
      let depth = 1;
      let j = i + tagLength;
      const innerStart = j;

      while (j < text.length && depth > 0) {
        if (text[j] === '[') depth++;
        else if (text[j] === ']') depth--;
        j++;
      }

      const innerContent = stripHandwrittenTags(text.slice(innerStart, j - 1));
      result += innerContent;
      i = j;
      continue;
    }

    result += text[i];
    i++;
  }

  return result;
}

function normalizeHandwritingNodes(nodes: MathNode[] | undefined, allowHandwriting: boolean): MathNode[] | undefined {
  if (!nodes) {
    return nodes;
  }
  if (allowHandwriting) {
    return nodes;
  }
  return nodes.map(node => ({ ...node, isHandwritten: false }));
}

export default function FinalAnswerSection({
  content,
  structuredContent,
  isOnGreenBackground = false,
  allowHandwriting = true,
}: FinalAnswerSectionProps) {
  const sanitizedContent = allowHandwriting ? content : stripHandwrittenTags(content);
  const sanitizedStructuredContent = normalizeHandwritingNodes(structuredContent, allowHandwriting);

  // Normalize content into structured blocks
  const blocks = normalizeSolutionContent(sanitizedContent);

  // Check if we have multi-part answer (more than one block with labels)
  const isMultiPart = blocks.length > 1 && blocks.some(block => block.label);
  const heroFontSize = isMultiPart ? 18 : 26;
  const heroFontWeight: TextStyle['fontWeight'] = isMultiPart ? '600' : '700';

  const containerStyles = [
    styles.container,
    styles.heroContainer,
    isOnGreenBackground && styles.heroContainerOnGreen,
  ];

  // Preserve structured content if provided, split by newlines to maintain formatting
  const derivedStructuredBlocks = React.useMemo(() => {
    if (!isMultiPart) {
      return [] as MathNode[][];
    }
    
    // Always parse from block strings to ensure proper alignment with labels
    return blocks.map(block => {
      const parsed = parseMathContent(block.content);
      return normalizeHandwritingNodes(parsed, allowHandwriting) || [];
    });
  }, [allowHandwriting, blocks, isMultiPart]);

  if (isMultiPart) {
    // Render as structured multi-part layout
    return (
      <View style={containerStyles}>
        {blocks.map((block, index) => (
          <View 
            key={index} 
            style={[
              styles.partRow,
              index === blocks.length - 1 && styles.lastPartRow
            ]}
          >
            {block.label && (
              <View style={styles.labelContainer}>
                <Text style={[
                  styles.label,
                  isOnGreenBackground && styles.labelOnGreen
                ]}>
                  {block.label}
                </Text>
              </View>
            )}
            <View style={styles.contentContainer}>
              <MathText
                content={block.content}
                structuredContent={derivedStructuredBlocks[index]}
                fontSize={heroFontSize}
                fontWeight={heroFontWeight}
                color={isOnGreenBackground ? colors.textPrimary : colors.textPrimary}
                isOnGreenBackground={isOnGreenBackground}
              />
            </View>
          </View>
        ))}
      </View>
    );
  }
  
  // Single block - render normally
  return (
    <View style={containerStyles}>
      <MathText
        content={blocks[0]?.content || sanitizedContent}
        structuredContent={sanitizedStructuredContent}
        fontSize={heroFontSize}
        fontWeight={heroFontWeight}
        color={isOnGreenBackground ? colors.textPrimary : colors.textPrimary}
        isOnGreenBackground={isOnGreenBackground}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'column',
    paddingVertical: 4,
  },
  heroContainer: {
    width: '100%',
    paddingVertical: 6,
  },
  heroContainerOnGreen: {
    borderRadius: 12,
    paddingHorizontal: 4,
  },
  partRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 10, // Clean spacing between parts
    paddingVertical: 2,
  },
  lastPartRow: {
    marginBottom: 0, // Remove trailing margin
  },
  labelContainer: {
    minWidth: 42,
    marginRight: 14, // Space between label and content
    paddingTop: 3,
  },
  label: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.primary,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  labelOnGreen: {
    color: colors.textPrimary,
  },
  contentContainer: {
    flex: 1,
    flexShrink: 1,
    paddingTop: 1,
  },
});
