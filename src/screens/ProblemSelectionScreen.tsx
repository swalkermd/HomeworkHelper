import React, { useState } from 'react';
import { View, Text, Image, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useHomeworkStore } from '../store/homeworkStore';
import { analyzeImageQuestion } from '../services/openai';
import { RootStackParamList } from '../navigation/types';
import { colors, typography, spacing } from '../constants/theme';
import { convertImageToBase64 } from '../utils/imageConverter';
import { getUserFriendlyErrorMessage } from '../utils/errorHandler';

type ProblemSelectionScreenProps = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ProblemSelection'>;
};

export default function ProblemSelectionScreen({ navigation }: ProblemSelectionScreenProps) {
  const [problemNumber, setProblemNumber] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const currentImage = useHomeworkStore((state) => state.currentImage);
  const setCurrentSolution = useHomeworkStore((state) => state.setCurrentSolution);

  const handleAnalyze = async () => {
    console.log('🔘 handleAnalyze called, currentImage:', !!currentImage, 'isLoading:', isLoading);
    
    if (!currentImage) {
      console.error('❌ No current image!');
      alert('No image selected. Please try again.');
      return;
    }
    
    if (isLoading) {
      console.log('⚠️ Already loading, ignoring click');
      return;
    }

    console.log('✅ Starting analysis...');
    setIsLoading(true);
    
    try {
      console.log('Converting image to base64...');
      console.log('Image URI:', currentImage.uri.substring(0, 50) + '...');
      console.log('Has base64 data:', !!currentImage.base64);
      console.log('MIME type:', currentImage.mimeType);
      
      const base64Image = await convertImageToBase64(
        currentImage.uri, 
        currentImage.base64,
        currentImage.mimeType
      );
      console.log('Image converted, size:', base64Image.length, 'chars');
      console.log('Analyzing with problem number:', problemNumber || 'none');
      
      const solution = await analyzeImageQuestion(base64Image, problemNumber);
      console.log('✅ Solution received:', solution ? 'yes' : 'no');
      
      setCurrentSolution(solution);
      console.log('Navigating to Solution screen...');
      navigation.navigate('Solution');
    } catch (error) {
      console.error('❌ Error analyzing image:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      const userMessage = getUserFriendlyErrorMessage(error);
      alert(userMessage);
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
    borderWidth: 3,
    borderColor: colors.secondary,
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
    fontSize: 16,
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
