import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useHomeworkStore } from '../store/homeworkStore';
import { useSettingsStore } from '../store/settingsStore';
import { RootStackParamList } from '../navigation/types';
import MathText from '../components/MathText';
import FinalAnswerSection from '../components/FinalAnswerSection';
import { colors, useResponsiveTheme } from '../constants/theme';
import { getSimplifiedExplanations, pollForDiagrams, pollForVerification, DiagramStatus } from '../services/openai';
import { SimplifiedExplanation } from '../types';
import { getUserFriendlyErrorMessage } from '../utils/errorHandler';
import { validateSolutionIntegrity } from '../utils/solutionValidation';

type SectionHeaderProps = {
  title: string;
  subtitle?: string;
  typography: any;
  spacing: any;
};

function SectionHeader({ title, subtitle, typography, spacing }: SectionHeaderProps) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={{ 
        fontSize: typography.titleMedium.fontSize, 
        lineHeight: typography.titleMedium.lineHeight, 
        fontWeight: '700' as const, 
        color: colors.textPrimary 
      }}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={{ 
          marginTop: 4, 
          fontSize: typography.bodyMedium.fontSize, 
          lineHeight: typography.bodyMedium.lineHeight, 
          color: colors.textSecondary 
        }}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

type SolutionScreenProps = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Solution'>;
};

export default function SolutionScreen({ navigation }: SolutionScreenProps) {
  const currentSolution = useHomeworkStore((state) => state.currentSolution);
  const reset = useHomeworkStore((state) => state.reset);
  const showStepExplanations = useSettingsStore((state) => state.showStepExplanations);
  const { typography, spacing } = useResponsiveTheme();
  const [revealedSteps, setRevealedSteps] = useState(0);
  const [allRevealed, setAllRevealed] = useState(false);
  const [simplifiedMode, setSimplifiedMode] = useState(false);
  const [simplifiedExplanations, setSimplifiedExplanations] = useState<SimplifiedExplanation[]>([]);
  const [loadingSimplified, setLoadingSimplified] = useState(false);
  const [diagrams, setDiagrams] = useState<DiagramStatus[]>([]);
  const [diagramsComplete, setDiagramsComplete] = useState(false);
  const [verificationStatus, setVerificationStatus] = useState<'pending' | 'verified' | 'unverified' | 'invalid_pending' | null>(null);
  const validation = useMemo(() => validateSolutionIntegrity(currentSolution), [currentSolution]);

  useEffect(() => {
    if (currentSolution?.solutionId) {
      console.log('🔄 Syncing verification status from solution:', currentSolution.verificationStatus);
      const status = currentSolution.verificationStatus;
      const normalizedStatus = status === 'invalid_pending' ? 'pending' : status || 'pending';
      setVerificationStatus(normalizedStatus);
    }
  }, [currentSolution?.solutionId, currentSolution?.verificationStatus]);

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
      console.log('⚠️ No solution found, resetting store and navigating to Home');
      reset(); // Clear stale data from store
      navigation.navigate('Home');
      return;
    }

    // Reset step reveal state when new solution loads
    setRevealedSteps(0);
    setAllRevealed(false);

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
    
    const MAX_POLL_DURATION = 5 * 60 * 1000; // 5 minutes
    const MAX_RETRIES = 150; // 150 retries * 2 seconds = 5 minutes
    const POLL_INTERVAL = 2000; // 2 seconds
    
    let retryCount = 0;
    const startTime = Date.now();
    
    const pollInterval = setInterval(async () => {
      try {
        // Check if we've exceeded time limit
        const elapsedTime = Date.now() - startTime;
        if (elapsedTime > MAX_POLL_DURATION) {
          console.warn('⏱️ Diagram polling timeout: exceeded 5 minute limit');
          clearInterval(pollInterval);
          setDiagramsComplete(true); // Stop trying
          return;
        }
        
        // Check if we've exceeded retry limit
        retryCount++;
        if (retryCount > MAX_RETRIES) {
          console.warn(`⚠️ Diagram polling stopped: exceeded ${MAX_RETRIES} retries`);
          clearInterval(pollInterval);
          setDiagramsComplete(true); // Stop trying
          return;
        }
        
        const result = await pollForDiagrams(currentSolution.solutionId!);
        
        console.log('📊 Diagram status:', {
          count: result.diagrams.length,
          complete: result.complete,
          ready: result.diagrams.filter(d => d.status === 'ready').length,
          retry: retryCount,
          elapsed: `${Math.round(elapsedTime / 1000)}s`
        });
        
        setDiagrams(result.diagrams);
        
        if (result.complete) {
          console.log('✅ All diagrams complete!');
          setDiagramsComplete(true);
          clearInterval(pollInterval);
        }
      } catch (error) {
        console.error('Error polling diagrams:', error);
        // Don't stop on individual errors, let retry limits handle it
      }
    }, POLL_INTERVAL);

    return () => clearInterval(pollInterval);
  }, [currentSolution?.solutionId, diagramsComplete]);

  useEffect(() => {
    if (!currentSolution?.solutionId || (verificationStatus !== 'pending' && verificationStatus !== 'invalid_pending')) return;

    console.log('🔍 Starting verification polling for solution:', currentSolution.solutionId);
    
    const MAX_POLL_DURATION = 2 * 60 * 1000;
    const POLL_INTERVAL = 3000;
    const startTime = Date.now();
    
    const pollInterval = setInterval(async () => {
      try {
        const elapsedTime = Date.now() - startTime;
        if (elapsedTime > MAX_POLL_DURATION) {
          console.warn('⏱️ Verification polling timeout');
          clearInterval(pollInterval);
          setVerificationStatus('unverified');
          return;
        }
        
        const result = await pollForVerification(currentSolution.solutionId!);
        
        if (result && result.status && result.status !== 'pending' && result.status !== 'invalid_pending') {
          console.log('✅ Verification complete:', result.status);
          setVerificationStatus(result.status);
          clearInterval(pollInterval);
        } else if (result?.status === 'invalid_pending') {
          setVerificationStatus('pending');
        }
      } catch (error) {
        console.error('Error polling verification:', error);
      }
    }, POLL_INTERVAL);

    return () => clearInterval(pollInterval);
  }, [currentSolution?.solutionId, verificationStatus]);

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
      const userMessage = getUserFriendlyErrorMessage(error);
      alert(userMessage);
    } finally {
      setLoadingSimplified(false);
    }
  };

  useEffect(() => {
    if (!validation.isValid) {
      console.warn('Solution validation issues detected', validation.issues);
    }
  }, [validation]);

  if (!currentSolution) return null;

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
      paddingVertical: spacing.md,
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
    headerSubtitle: {
      marginTop: 2,
      fontSize: typography.caption.fontSize,
      lineHeight: typography.caption.lineHeight,
      color: colors.textSecondary,
    },
    scrollView: {
      flex: 1,
    },
    content: {
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.xl,
      paddingBottom: spacing.xxl,
    },
    section: {
      marginBottom: spacing.xxl,
    },
    sectionHeader: {
      marginBottom: spacing.md,
    },
    sectionTitle: {
      fontSize: typography.titleMedium.fontSize,
      lineHeight: typography.titleMedium.lineHeight,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    sectionSubtitle: {
      marginTop: 4,
      fontSize: typography.bodyMedium.fontSize,
      lineHeight: typography.bodyMedium.lineHeight,
      color: colors.textSecondary,
    },
    problemCard: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: spacing.xl,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: '#111827',
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.08,
      shadowRadius: 16,
      elevation: 6,
    },
    problemIconContainer: {
      marginBottom: spacing.sm,
    },
    problemLabel: {
      fontSize: typography.bodyMedium.fontSize,
      lineHeight: typography.bodyMedium.lineHeight,
      fontWeight: '600',
      color: colors.textSecondary,
      marginBottom: spacing.sm,
    },
    problemTextContainer: {
      backgroundColor: colors.surfaceAlt,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      padding: spacing.lg,
    },
    stepCard: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: spacing.xl,
      marginBottom: spacing.lg,
      borderWidth: 1,
      borderColor: 'rgba(99, 102, 241, 0.12)',
      shadowColor: '#111827',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.06,
      shadowRadius: 12,
      elevation: 4,
    },
    stepCardPending: {
      opacity: 0.3,
    },
    stepHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: spacing.md,
    },
    stepBadge: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepBadgeRevealed: {
      backgroundColor: colors.secondary,
    },
    stepBadgePending: {
      backgroundColor: colors.border,
    },
    stepBadgeText: {
      fontSize: typography.bodyMedium.fontSize,
      fontWeight: '700',
      color: '#ffffff',
    },
    stepHeaderTextGroup: {
      marginLeft: spacing.md,
      flex: 1,
    },
    stepTitle: {
      fontSize: typography.titleMedium.fontSize,
      lineHeight: typography.titleMedium.lineHeight,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    stepMeta: {
      marginTop: 2,
      fontSize: typography.caption.fontSize,
      lineHeight: typography.caption.lineHeight,
      color: colors.textSecondary,
    },
    stepContent: {
      backgroundColor: colors.surfaceAlt,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      padding: spacing.lg,
    },
    explanationBox: {
      backgroundColor: '#fef3c7',
      borderLeftWidth: 4,
      borderLeftColor: '#f59e0b',
      borderRadius: 8,
      padding: spacing.md,
      marginTop: spacing.md,
    },
    finalAnswerCard: {
      borderRadius: 12,
      padding: spacing.xxl,
      alignItems: 'center',
      marginBottom: spacing.lg,
      shadowColor: '#10b981',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 8,
      elevation: 8,
    },
    finalAnswerLabel: {
      fontSize: typography.titleMedium.fontSize,
      lineHeight: typography.titleMedium.lineHeight,
      fontWeight: '700',
      color: '#ffffff',
      marginTop: spacing.sm,
      marginBottom: spacing.md,
    },
    finalAnswerBox: {
      backgroundColor: '#ffffff',
      borderRadius: 8,
      padding: spacing.lg,
      width: '100%',
    },
    finalAnswerMeta: {
      marginTop: spacing.md,
      fontSize: typography.bodyMedium.fontSize,
      color: '#d1fae5',
      fontStyle: 'italic',
    },
    explanationContainer: {
      backgroundColor: colors.surfaceAlt,
      borderLeftWidth: 4,
      borderLeftColor: colors.primary,
      borderRadius: 8,
      padding: spacing.md,
      marginTop: spacing.md,
    },
    explanationText: {
      fontSize: typography.bodyMedium.fontSize,
      lineHeight: typography.bodyMedium.lineHeight,
      color: colors.textSecondary,
    },
    finalSection: {
      marginTop: spacing.lg,
    },
    actionBar: {
      backgroundColor: colors.surface,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      padding: spacing.lg,
      paddingBottom: 30,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: -2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 5,
    },
    sectionLabel: {
      fontSize: typography.bodyMedium.fontSize,
      lineHeight: typography.bodyMedium.lineHeight,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    actionBarHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.sm,
    },
    settingsToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.sm,
    },
    settingsToggleText: {
      fontSize: typography.caption.fontSize,
      color: colors.textSecondary,
    },
    actionRow: {
      flexDirection: 'row',
      gap: spacing.md,
      marginBottom: spacing.md,
    },
    helpButton: {
      flex: 1,
    },
    gradientButton: {
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      borderRadius: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
    },
    helpButtonText: {
      fontSize: typography.bodyMedium.fontSize,
      lineHeight: typography.bodyMedium.lineHeight,
      fontWeight: '600',
      color: '#ffffff',
    },
    newProblemOutlineButton: {
      backgroundColor: '#991b1b',
      paddingVertical: spacing.md,
      borderRadius: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
    },
    newProblemOutlineButtonText: {
      fontSize: typography.bodyMedium.fontSize,
      lineHeight: typography.bodyMedium.lineHeight,
      fontWeight: '600',
      color: '#ffffff',
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
      fontSize: typography.bodyMedium.fontSize,
      fontWeight: '600',
      color: colors.textSecondary,
      marginBottom: spacing.sm,
    },
    diagramImage: {
      width: '100%',
      aspectRatio: 1,
      maxHeight: 400,
      borderRadius: 8,
    },
    diagramLoading: {
      fontSize: typography.caption.fontSize,
      color: colors.textSecondary,
      marginTop: spacing.xs,
    },
    simplifiedBox: {
      backgroundColor: '#fef3c7',
      borderRadius: 8,
      padding: spacing.md,
      marginTop: spacing.md,
      borderLeftWidth: 4,
      borderLeftColor: '#f59e0b',
    },
    simplifiedHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginBottom: spacing.sm,
    },
    simplifiedLabel: {
      fontSize: typography.bodyMedium.fontSize,
      fontWeight: '600',
      color: '#92400e',
    },
    validationCallout: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor: '#fef3c7',
      borderLeftWidth: 4,
      borderLeftColor: '#f59e0b',
      borderRadius: 8,
      padding: spacing.md,
      marginBottom: spacing.md,
      gap: spacing.sm,
    },
    validationIcon: {
      marginTop: 2,
    },
    validationTitle: {
      fontSize: typography.bodyMedium.fontSize,
      fontWeight: '600',
      color: '#92400e',
      marginBottom: spacing.xs,
    },
    validationText: {
      fontSize: typography.bodyMedium.fontSize,
      color: '#78350f',
      lineHeight: typography.bodyMedium.lineHeight,
    },
  });

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <View>
          <Text style={styles.headerTitle}>Solution</Text>
          <Text style={styles.headerSubtitle}>Fully worked steps with educator-friendly pacing</Text>
        </View>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <SectionHeader
            title="Problem Statement"
            subtitle="Carefully review the original question before diving into the reasoning."
            typography={typography}
            spacing={spacing}
          />
          {!validation.isValid && validation.issues.length > 0 && (
            <View style={styles.validationCallout}>
              <Ionicons name="alert-circle" size={20} color="#92400e" style={styles.validationIcon} />
              <View style={{ flex: 1 }}>
                <Text style={styles.validationTitle}>We noticed something unusual</Text>
                {validation.issues.map((issue) => (
                  <Text key={issue.code} style={styles.validationText}>
                    • {issue.message}
                  </Text>
                ))}
              </View>
            </View>
          )}

          <Animated.View entering={FadeInUp.duration(500)} style={styles.problemCard}>
            <View style={styles.problemIconContainer}>
              <Ionicons name="document-text" size={24} color={colors.primary} />
            </View>
            <Text style={styles.problemLabel}>Problem</Text>
            <View style={styles.problemTextContainer}>
              <MathText
                content={currentSolution.problem}
                structuredContent={currentSolution.problemStructured}
                fontSize={typography.bodyLarge.fontSize}
              />
            </View>
          </Animated.View>
        </View>

        <View style={styles.section}>
          <SectionHeader
            title="Step-by-step reasoning"
            subtitle="Each stage builds toward the final answer. Reveal animations pace comprehension."
            typography={typography}
            spacing={spacing}
          />
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
              <View style={styles.stepHeader}>
                <View style={[
                  styles.stepBadge,
                  index < revealedSteps ? styles.stepBadgeRevealed : styles.stepBadgePending,
                ]}>
                  <Text style={styles.stepBadgeText}>{index + 1}</Text>
                </View>
                <View style={styles.stepHeaderTextGroup}>
                  <Text style={styles.stepTitle}>{step.title}</Text>
                  <Text style={styles.stepMeta}>
                    {currentSolution.subject}
                  </Text>
                </View>
              </View>

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
                <MathText
                  content={step.content}
                  structuredContent={step.structuredContent}
                  fontSize={typography.mathSmall.fontSize}
                />
              </View>

              {showStepExplanations && step.explanation && (
                <View style={styles.explanationContainer}>
                  <Text style={styles.explanationText}>{step.explanation}</Text>
                </View>
              )}
              
              {simplifiedMode && simplified && (
                <View style={styles.simplifiedBox}>
                  <View style={styles.simplifiedHeader}>
                    <Ionicons name="bulb" size={20} color="#92400e" />
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
        </View>

        {allRevealed && (
          <View style={[styles.section, styles.finalSection]}>
            <SectionHeader
              title="Final answer"
              subtitle=""
              typography={typography}
              spacing={spacing}
            />
            <Animated.View entering={FadeInUp.duration(600)}>
              <LinearGradient
                colors={['#10b981', '#059669']}
                style={styles.finalAnswerCard}
              >
                {(verificationStatus === 'pending' || verificationStatus === 'invalid_pending' || verificationStatus === null) && (
                  <ActivityIndicator size="small" color="#ffffff" />
                )}
                {verificationStatus === 'verified' && (
                  <Ionicons name="checkmark-circle" size={32} color="#ffffff" />
                )}
                {verificationStatus === 'unverified' && (
                  <Ionicons name="alert-circle-outline" size={32} color="#ffffff" />
                )}
                <Text style={styles.finalAnswerLabel}>Answer</Text>
                <View style={styles.finalAnswerBox}>
                  <FinalAnswerSection
                    content={currentSolution.finalAnswer}
                    structuredContent={currentSolution.finalAnswerStructured}
                    isOnGreenBackground={false}
                  />
                </View>
              </LinearGradient>
            </Animated.View>
          </View>
        )}
      </ScrollView>

      <View style={styles.actionBar}>
        <View style={styles.actionBarHeader}>
          <Text style={styles.sectionLabel}>Need More Help?</Text>
          <TouchableOpacity
            onPress={() => useSettingsStore.getState().setShowStepExplanations(!showStepExplanations)}
            style={styles.settingsToggle}
          >
            <Ionicons 
              name={showStepExplanations ? "eye" : "eye-off"} 
              size={20} 
              color={colors.textSecondary} 
            />
            <Text style={styles.settingsToggleText}>
              {showStepExplanations ? "Hide" : "Show"} Tips
            </Text>
          </TouchableOpacity>
        </View>
        <View style={styles.actionRow}>
          <TouchableOpacity
            onPress={handleSimplifyExplanation}
            disabled={loadingSimplified}
            style={styles.helpButton}
          >
            <LinearGradient
              colors={simplifiedMode ? ['#10b981', '#059669'] : ['#fbbf24', '#f59e0b']}
              style={styles.gradientButton}
            >
              {loadingSimplified ? (
                <ActivityIndicator color={simplifiedMode ? "#ffffff" : "#1f2937"} />
              ) : (
                <>
                  <Ionicons 
                    name={simplifiedMode ? "checkmark-circle" : "bulb"} 
                    size={20} 
                    color={simplifiedMode ? "#ffffff" : "#1f2937"} 
                  />
                  <Text style={[styles.helpButtonText, !simplifiedMode && { color: '#1f2937' }]}>
                    {simplifiedMode ? "Hide" : "Simplify"}
                  </Text>
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={styles.helpButton}
            onPress={() => navigation.navigate('Question')}
          >
            <LinearGradient
              colors={['#3b82f6', '#2563eb']}
              style={styles.gradientButton}
            >
              <Ionicons name="chatbubble-ellipses" size={20} color="#ffffff" />
              <Text style={styles.helpButtonText}>Ask Question</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
        
        <TouchableOpacity onPress={() => navigation.navigate('Home')} style={{ marginTop: spacing.sm }}>
          <View style={styles.newProblemOutlineButton}>
            <Ionicons name="add-circle" size={22} color="#ffffff" />
            <Text style={styles.newProblemOutlineButtonText}>New Problem</Text>
          </View>
        </TouchableOpacity>
      </View>
    </View>
  );
}
