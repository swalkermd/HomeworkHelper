import React, { useState } from 'react';
import { View, Text, Image, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useHomeworkStore } from '../store/homeworkStore';
import { analyzeImageQuestion } from '../services/openai';
import { RootStackParamList } from '../navigation/types';
import { colors, typography, spacing } from '../constants/theme';
import { convertImageToBase64 } from '../utils/imageConverter';

type ProblemSelectionScreenProps = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ProblemSelection'>;
};

export default function ProblemSelectionScreen({ navigation }: ProblemSelectionScreenProps) {
  const [problemNumber, setProblemNumber] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const currentImage = useHomeworkStore((state) => state.currentImage);
  const setCurrentSolution = useHomeworkStore((state) => state.setCurrentSolution);

  const handleAnalyze = async () => {
    if (!currentImage || isLoading) return;

    setIsLoading(true);
    try {
      console.log('Converting image to base64...');
      const base64Image = await convertImageToBase64(currentImage.uri);
      console.log('Image converted, analyzing...');
      const solution = await analyzeImageQuestion(base64Image, problemNumber);
      setCurrentSolution(solution);
      navigation.navigate('Solution');
    } catch (error) {
      console.error('Error analyzing image:', error);
      alert('Failed to analyze image. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  if (!currentImage) {
    navigation.goBack();
    return null;
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>Review Your Photo</Text>
        
        <Image
          source={{ uri: currentImage.uri }}
          style={[
            styles.image,
            {
              aspectRatio: currentImage.width / currentImage.height,
            }
          ]}
          resizeMode="contain"
        />

        <Text style={styles.label}>Problem Number (optional)</Text>
        <TextInput
          style={styles.input}
          value={problemNumber}
          onChangeText={setProblemNumber}
          placeholder="e.g., 1, 2, 3..."
          placeholderTextColor={colors.textSecondary}
          keyboardType="default"
        />

        <TouchableOpacity
          style={[styles.analyzeButton, isLoading && styles.analyzeButtonDisabled]}
          onPress={handleAnalyze}
          disabled={isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.analyzeButtonText}>Solve!</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.retakeButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.retakeButtonText}>Retake Photo</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    padding: spacing.xl,
  },
  title: {
    fontSize: typography.displayMedium.fontSize,
    lineHeight: typography.displayMedium.lineHeight,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.xl,
  },
  image: {
    width: '100%',
    maxHeight: 400,
    borderRadius: 12,
    backgroundColor: colors.surfaceAlt,
    marginBottom: spacing.xl,
  },
  label: {
    fontSize: typography.bodyLarge.fontSize,
    lineHeight: typography.bodyLarge.lineHeight,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.lg,
    fontSize: typography.bodyLarge.fontSize,
    lineHeight: typography.bodyLarge.lineHeight,
    color: colors.textPrimary,
    marginBottom: spacing.xl,
  },
  analyzeButton: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.lg,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  analyzeButtonDisabled: {
    opacity: 0.5,
  },
  analyzeButtonText: {
    fontSize: typography.titleLarge.fontSize,
    lineHeight: typography.titleLarge.lineHeight,
    fontWeight: '600',
    color: '#ffffff',
  },
  retakeButton: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: colors.border,
    paddingVertical: spacing.lg,
    borderRadius: 12,
    alignItems: 'center',
  },
  retakeButtonText: {
    fontSize: typography.titleLarge.fontSize,
    lineHeight: typography.titleLarge.lineHeight,
    fontWeight: '600',
    color: colors.textSecondary,
  },
});
