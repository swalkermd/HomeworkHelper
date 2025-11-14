// Professional structured layout for multi-part final answers

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import MathText from './MathText';
import { normalizeSolutionContent } from '../utils/mathFormatter';
import { parseMathContent } from '../utils/mathParser';
import { colors } from '../constants/theme';
import { MathNode } from '../types/math';

interface FinalAnswerSectionProps {
  content: string;
  structuredContent?: MathNode[];
  isOnGreenBackground?: boolean;
}

export default function FinalAnswerSection({ content, structuredContent, isOnGreenBackground = false }: FinalAnswerSectionProps) {
  // Normalize content into structured blocks
  const blocks = normalizeSolutionContent(content);

  // Check if we have multi-part answer (more than one block with labels)
  const isMultiPart = blocks.length > 1 && blocks.some(block => block.label);

  // Preserve structured content if provided, split by newlines to maintain formatting
  const derivedStructuredBlocks = React.useMemo(() => {
    if (!isMultiPart) {
      return [] as MathNode[][];
    }
    
    // Always parse from block strings to ensure proper alignment with labels
    return blocks.map(block => {
      // If we have structured content, try to use it for this specific block
      // Otherwise fall back to parsing the string
      if (structuredContent && structuredContent.length > 0) {
        // For now, parse from string to ensure consistency
        // Future: implement smarter partitioning of structured content
        return parseMathContent(block.content);
      }
      return parseMathContent(block.content);
    });
  }, [blocks, isMultiPart, structuredContent]);

  if (isMultiPart) {
    // Render as structured multi-part layout
    return (
      <View style={styles.container}>
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
                fontSize={16}
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
    <View style={styles.container}>
      <MathText
        content={blocks[0]?.content || content}
        structuredContent={structuredContent}
        fontSize={16}
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
    fontSize: 17,
    fontWeight: '700',
    color: colors.primary,
    letterSpacing: 0.2,
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
