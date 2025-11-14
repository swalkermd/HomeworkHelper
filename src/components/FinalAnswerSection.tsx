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

  // Preserve structured content if provided, otherwise parse from strings
  const derivedStructuredBlocks = React.useMemo(() => {
    if (!isMultiPart) {
      return [] as MathNode[][];
    }
    
    // If we already have structured content, partition it by labels instead of reparsing
    if (structuredContent && structuredContent.length > 0) {
      // Find label positions in the structured content
      const partitionedBlocks: MathNode[][] = [];
      let currentBlock: MathNode[] = [];
      
      for (const node of structuredContent) {
        // Check if this text node contains a label marker (a), b), etc.)
        if (node.type === 'text' && /^([a-z]\)|\([a-z]\)|\d+\)|\(\d+\))\s*/i.test(node.content)) {
          // Start new block if we have accumulated nodes
          if (currentBlock.length > 0) {
            partitionedBlocks.push(currentBlock);
            currentBlock = [];
          }
          
          // Remove the label from this node and add remaining content
          const cleanedContent = node.content.replace(/^([a-z]\)|\([a-z]\)|\d+\)|\(\d+\))\s*/i, '').trim();
          if (cleanedContent) {
            currentBlock.push({ ...node, content: cleanedContent });
          }
        } else {
          currentBlock.push(node);
        }
      }
      
      // Add final block
      if (currentBlock.length > 0) {
        partitionedBlocks.push(currentBlock);
      }
      
      return partitionedBlocks;
    }
    
    // Fallback: parse from strings
    return blocks.map(block => parseMathContent(block.content));
  }, [blocks, isMultiPart, structuredContent]);

  if (isMultiPart) {
    // Render as structured multi-part layout
    return (
      <View style={styles.container}>
        {blocks.map((block, index) => (
          <View key={index} style={styles.partRow}>
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
    gap: 12, // Vertical spacing between parts
  },
  partRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  labelContainer: {
    minWidth: 40,
    paddingTop: 2, // Align with first line of text
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  labelOnGreen: {
    color: colors.textPrimary,
  },
  contentContainer: {
    flex: 1,
    flexShrink: 1,
  },
});
