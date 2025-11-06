import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useHomeworkStore } from '../store/homeworkStore';
import { RootStackParamList } from '../navigation/types';
import MathText from '../components/MathText';
import { colors, typography, spacing } from '../constants/theme';
import { getSimplifiedExplanations, pollForDiagrams, DiagramStatus } from '../services/openai';
import { SimplifiedExplanation } from '../types';

type SolutionScreenProps = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Solution'>;
};

export default function SolutionScreen({ navigation }: SolutionScreenProps) {
  const currentSolution = useHomeworkStore((state) => state.currentSolution);
  const [revealedSteps, setRevealedSteps] = useState(0);
  const [allRevealed, setAllRevealed] = useState(false);
  const [simplifiedMode, setSimplifiedMode] = useState(false);
  const [simplifiedExplanations, setSimplifiedExplanations] = useState<SimplifiedExplanation[]>([]);
  const [loadingSimplified, setLoadingSimplified] = useState(false);
  const [diagrams, setDiagrams] = useState<DiagramStatus[]>([]);
  const [diagramsComplete, setDiagramsComplete] = useState(false);

  useEffect(() => {
    console.log('🔍 SolutionScreen mounted. Has solution:', !!currentSolution);
    console.log('Solution details:', currentSolution ? {
      hasSteps: !!currentSolution.steps,
      stepsCount: currentSolution.steps?.length,
      subject: currentSolution.subject,
      difficulty: currentSolution.difficulty,
      solutionId: currentSolution.solutionId
    } : 'No solution');
    
    if (!currentSolution) {
      console.log('⚠️ No solution found, navigating back to Home');
      navigation.navigate('Home');
      return;
    }

    const timer = setInterval(() => {
      setRevealedSteps((prev) => {
        if (prev < currentSolution.steps.length) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          return prev + 1;
        }
        setAllRevealed(true);
        clearInterval(timer);
        return prev;
      });
    }, 800);

    return () => clearInterval(timer);
  }, [currentSolution]);

  useEffect(() => {
    if (!currentSolution?.solutionId || diagramsComplete) return;

    console.log('🎨 Starting diagram polling for solution:', currentSolution.solutionId);
    
    const pollInterval = setInterval(async () => {
      try {
        const result = await pollForDiagrams(currentSolution.solutionId!);
        
        console.log('📊 Diagram status:', {
          count: result.diagrams.length,
          complete: result.complete,
          ready: result.diagrams.filter(d => d.status === 'ready').length
        });
        
        setDiagrams(result.diagrams);
        
        if (result.complete) {
          console.log('✅ All diagrams complete!');
          setDiagramsComplete(true);
          clearInterval(pollInterval);
        }
      } catch (error) {
        console.error('Error polling diagrams:', error);
      }
    }, 2000);

    return () => clearInterval(pollInterval);
  }, [currentSolution?.solutionId, diagramsComplete]);

  const handleSimplifyExplanation = async () => {
    if (!currentSolution || loadingSimplified) return;
    
    if (simplifiedMode) {
      setSimplifiedMode(false);
      return;
    }

    setLoadingSimplified(true);
    try {
      const explanations = await getSimplifiedExplanations(currentSolution);
      setSimplifiedExplanations(explanations);
      setSimplifiedMode(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.error('Error getting simplified explanations:', error);
      alert('Failed to generate simplified explanations. Please try again.');
    } finally {
      setLoadingSimplified(false);
    }
  };

  if (!currentSolution) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Solution</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        <Animated.View entering={FadeInUp.duration(500)} style={styles.problemCard}>
          <View style={styles.problemIconContainer}>
            <Ionicons name="document-text" size={24} color={colors.primary} />
          </View>
          <Text style={styles.problemLabel}>Problem</Text>
          <View style={styles.problemTextContainer}>
            <MathText content={currentSolution.problem} fontSize={typography.bodyLarge.fontSize} />
          </View>
        </Animated.View>

        {currentSolution.steps.map((step, index) => {
          const simplified = simplifiedExplanations.find(exp => exp.stepNumber === index + 1);
          const stepDiagram = diagrams.find(d => d.stepId === step.id);
          
          return (
            <Animated.View
              key={step.id}
              entering={FadeInDown.duration(600).delay(200 * index)}
              style={[
                styles.stepCard,
                index >= revealedSteps && styles.stepCardPending,
              ]}
            >
              <View style={[
                styles.stepBadge,
                index < revealedSteps ? styles.stepBadgeRevealed : styles.stepBadgePending,
              ]}>
                <Text style={styles.stepBadgeText}>{index + 1}</Text>
              </View>
              
              <Text style={styles.stepTitle}>{step.title}</Text>
              
              {stepDiagram && stepDiagram.status === 'ready' && stepDiagram.imageUrl && (
                <View style={styles.diagramContainer}>
                  <Text style={styles.diagramLabel}>Visual Aid:</Text>
                  <Image 
                    source={{ uri: stepDiagram.imageUrl }} 
                    style={styles.diagramImage}
                    contentFit="contain"
                  />
                </View>
              )}
              
              {stepDiagram && stepDiagram.status === 'generating' && (
                <View style={styles.diagramContainer}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={styles.diagramLoading}>Generating diagram...</Text>
                </View>
              )}
              
              <View style={styles.stepContent}>
                <MathText content={step.content} fontSize={typography.mathMedium.fontSize} />
              </View>
              
              {simplifiedMode && simplified && (
                <View style={styles.simplifiedBox}>
                  <View style={styles.simplifiedHeader}>
                    <Ionicons name="bulb" size={20} color="#f59e0b" />
                    <Text style={styles.simplifiedLabel}>Simpler Explanation</Text>
                  </View>
                  <MathText 
                    content={simplified.simplifiedExplanation} 
                    fontSize={typography.bodyLarge.fontSize}
                    color="#92400e"
                  />
                </View>
              )}
            </Animated.View>
          );
        })}

        {allRevealed && (
          <Animated.View entering={FadeInUp.duration(600)}>
            <LinearGradient
              colors={['#10b981', '#059669']}
              style={styles.finalAnswerCard}
            >
              <Ionicons name="checkmark-circle" size={32} color="#ffffff" />
              <Text style={styles.finalAnswerLabel}>Final Answer</Text>
              <View style={styles.finalAnswerBox}>
                <MathText
                  content={currentSolution.finalAnswer}
                  fontSize={typography.mathLarge.fontSize}
                  color={colors.textPrimary}
                />
              </View>
            </LinearGradient>
          </Animated.View>
        )}
      </ScrollView>

      <View style={styles.actionBar}>
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => navigation.navigate('Question')}
          >
            <Text style={styles.actionButtonText}>Ask Question</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={styles.actionButtonOutline}
            onPress={() => navigation.navigate('Home')}
          >
            <Text style={styles.actionButtonOutlineText}>New Problem</Text>
          </TouchableOpacity>
        </View>
        
        <TouchableOpacity
          style={[styles.simplifyButton, simplifiedMode && styles.simplifyButtonActive]}
          onPress={handleSimplifyExplanation}
          disabled={loadingSimplified}
        >
          {loadingSimplified ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <>
              <Ionicons 
                name={simplifiedMode ? "checkmark-circle" : "help-circle"} 
                size={20} 
                color="#ffffff" 
              />
              <Text style={styles.simplifyButtonText}>
                {simplifiedMode ? "Hide Simpler Explanations" : "I Still Don't Get It"}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    paddingTop: 50,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    fontSize: typography.titleLarge.fontSize,
    lineHeight: typography.titleLarge.lineHeight,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: spacing.lg,
  },
  problemCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  problemIconContainer: {
    marginBottom: spacing.sm,
  },
  problemLabel: {
    fontSize: typography.bodyLarge.fontSize,
    lineHeight: typography.bodyLarge.lineHeight,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  problemTextContainer: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: spacing.md,
  },
  stepCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  stepCardPending: {
    opacity: 0.3,
  },
  stepBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  stepBadgeRevealed: {
    backgroundColor: colors.secondary,
  },
  stepBadgePending: {
    backgroundColor: colors.border,
  },
  stepBadgeText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#ffffff',
  },
  stepTitle: {
    fontSize: typography.bodyLarge.fontSize,
    lineHeight: typography.bodyLarge.lineHeight,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  stepContent: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: spacing.md,
  },
  explanationBox: {
    backgroundColor: '#fef3c7',
    borderLeftWidth: 4,
    borderLeftColor: '#f59e0b',
    borderRadius: 8,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  explanationText: {
    fontSize: typography.bodyLarge.fontSize,
    lineHeight: typography.bodyLarge.lineHeight,
    color: '#92400e',
  },
  finalAnswerCard: {
    borderRadius: 12,
    padding: spacing.xl,
    alignItems: 'center',
    marginBottom: spacing.lg,
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  finalAnswerLabel: {
    fontSize: typography.titleLarge.fontSize,
    lineHeight: typography.titleLarge.lineHeight,
    fontWeight: '700',
    color: '#ffffff',
    marginVertical: spacing.sm,
  },
  finalAnswerBox: {
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 8,
    padding: spacing.lg,
    width: '100%',
    alignItems: 'center',
  },
  actionBar: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: spacing.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 5,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  actionButton: {
    flex: 1,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 12,
    alignItems: 'center',
  },
  actionButtonText: {
    fontSize: typography.bodyLarge.fontSize,
    lineHeight: typography.bodyLarge.lineHeight,
    fontWeight: '600',
    color: '#ffffff',
  },
  actionButtonOutline: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: colors.secondary,
    paddingVertical: spacing.md,
    borderRadius: 12,
    alignItems: 'center',
  },
  actionButtonOutlineText: {
    fontSize: typography.bodyLarge.fontSize,
    lineHeight: typography.bodyLarge.lineHeight,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  simplifyButton: {
    backgroundColor: '#fbbf24',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: 12,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  simplifyButtonActive: {
    backgroundColor: '#10b981',
  },
  diagramContainer: {
    marginTop: spacing.md,
    marginBottom: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 8,
    padding: spacing.md,
    alignItems: 'center',
  },
  diagramLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  diagramImage: {
    width: '100%',
    height: 300,
    borderRadius: 8,
  },
  diagramLoading: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  simplifyButtonText: {
    fontSize: typography.bodyLarge.fontSize,
    lineHeight: typography.bodyLarge.lineHeight,
    fontWeight: '600',
    color: '#ffffff',
  },
  simplifiedBox: {
    backgroundColor: '#fef3c7',
    borderLeftWidth: 4,
    borderLeftColor: '#f59e0b',
    borderRadius: 8,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  simplifiedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  simplifiedLabel: {
    fontSize: typography.bodyLarge.fontSize,
    lineHeight: typography.bodyLarge.lineHeight,
    fontWeight: '600',
    color: '#f59e0b',
  },
});
