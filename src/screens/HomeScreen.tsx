import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useHomeworkStore } from '../store/homeworkStore';
import { RootStackParamList } from '../navigation/types';
import { colors, typography, spacing } from '../constants/theme';

type HomeScreenProps = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Home'>;
};

export default function HomeScreen({ navigation }: HomeScreenProps) {
  const reset = useHomeworkStore((state) => state.reset);
  const setCurrentImage = useHomeworkStore((state) => state.setCurrentImage);
  const fileInputRef = useRef<any>(null);
  const [isProcessingFile, setIsProcessingFile] = useState(false);

  useEffect(() => {
    reset();

    // CRITICAL DIAGNOSTIC: Log platform info on mount
    console.log('🏠 HomeScreen mounted');
    console.log('🏠 Platform.OS:', Platform.OS);
    console.log('🏠 navigator.userAgent:', typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A');
    console.log('🏠 Window exists:', typeof window !== 'undefined');
    console.log('🏠 Document exists:', typeof document !== 'undefined');
  }, [reset]);

  // Handle file selection from persistent input
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];

    if (!file) {
      console.log('🖼️ No file selected');
      setIsProcessingFile(false);
      return;
    }

    console.log('🖼️ File selected:', file.name, 'size:', file.size);

    const reader = new FileReader();
    reader.onload = (event) => {
      console.log('🖼️ FileReader loaded');
      const uri = event.target?.result as string;
      const img = new Image();
      img.onload = () => {
        console.log('🖼️ Image loaded, dimensions:', img.width, 'x', img.height);
        setCurrentImage({
          uri,
          width: img.width,
          height: img.height,
        });
        setIsProcessingFile(false);
        navigation.navigate('ProblemSelection');
      };
      img.onerror = () => {
        console.error('🖼️ Failed to load image');
        setIsProcessingFile(false);
        alert('Failed to load image. Please try again.');
      };
      img.src = uri;
    };
    reader.onerror = () => {
      console.error('🖼️ FileReader error');
      setIsProcessingFile(false);
      alert('Failed to read file. Please try again.');
    };
    reader.readAsDataURL(file);

    // Reset input so same file can be selected again
    e.target.value = '';
  };

  // Handle gallery button - uses persistent input on web for reliable mobile browser support
  const handleGalleryPress = () => {
    const diagnostics = {
      timestamp: new Date().toISOString(),
      platform: Platform.OS,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A',
      isMobile: typeof navigator !== 'undefined' ? /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) : false,
      touchSupport: typeof window !== 'undefined' && 'ontouchstart' in window,
      refExists: !!fileInputRef.current,
      refType: fileInputRef.current ? typeof fileInputRef.current : 'null',
    };

    console.log('🖼️ Gallery button diagnostics:', JSON.stringify(diagnostics, null, 2));

    // FAILSAFE: Never navigate to Gallery on web platform
    if (Platform.OS === 'web' || typeof window !== 'undefined') {
      console.log('🖼️ Web platform detected - using file input');
      console.log('🖼️ Mobile browser detected:', diagnostics.isMobile);
      console.log('🖼️ Ref current:', fileInputRef.current);

      // Create and click file input dynamically as fallback
      if (!fileInputRef.current) {
        console.warn('⚠️ File input ref is null, creating dynamic input as fallback');

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (e: any) => {
          const file = e.target.files?.[0];
          if (file) {
            handleFileChange({ target: { files: [file], value: '' } } as any);
          }
        };
        input.click();
        return;
      }

      try {
        setIsProcessingFile(true);
        
        // iOS/Safari requires focus before programmatic click
        fileInputRef.current.focus();
        console.log('✅ File input focused');
        
        fileInputRef.current.click();
        console.log('✅ File input click triggered');

        // Safety timeout
        setTimeout(() => {
          setIsProcessingFile(false);
        }, 500);
      } catch (error) {
        console.error('❌ File input click failed:', error);
        alert('Failed to open file picker: ' + (error as Error).message);
        setIsProcessingFile(false);
      }
    } else {
      console.log('🖼️ Native platform, navigating to Gallery screen');
      navigation.navigate('Gallery');
    }
  };

  return (
    <View style={styles.container}>
      {/* Hidden file input - persistent on web for reliable mobile browser support */}
      {Platform.OS === 'web' && (
        <input
          id="gallery-file-input"
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{
            position: 'absolute',
            top: '-9999px',
            left: '-9999px',
            width: '1px',
            height: '1px',
            opacity: 0,
            pointerEvents: 'none',
          }}
          onChange={handleFileChange}
        />
      )}

      <View style={styles.hero}>
        <View style={styles.iconContainer}>
          <LinearGradient
            colors={['#fbbf24', '#f59e0b']}
            style={styles.iconGradient}
          >
            <Ionicons name="school" size={48} color="#ffffff" />
          </LinearGradient>
        </View>

        <Text style={styles.title}>Homework Helper</Text>
      </View>

      <View style={styles.buttonsContainer}>
        <TouchableOpacity
          onPress={() => navigation.navigate('TextInput')}
          activeOpacity={0.8}
        >
          <LinearGradient
            colors={['#6366f1', '#8b5cf6']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.button}
          >
            <View style={styles.buttonIconContainer}>
              <Ionicons name="create-outline" size={24} color="#ffffff" />
            </View>
            <Text style={styles.buttonText}>Type Question</Text>
          </LinearGradient>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => navigation.navigate('Camera')}
          activeOpacity={0.8}
        >
          <LinearGradient
            colors={['#ec4899', '#f97316']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.button}
          >
            <View style={styles.buttonIconContainer}>
              <Ionicons name="camera" size={24} color="#ffffff" />
            </View>
            <Text style={styles.buttonText}>Take Photo</Text>
          </LinearGradient>
        </TouchableOpacity>

        {Platform.OS === 'web' ? (
          <>
            {/* WEB PATH: Using label element */}
            <label
              htmlFor="gallery-file-input"
              style={{
                cursor: isProcessingFile ? 'default' : 'pointer',
                opacity: isProcessingFile ? 0.6 : 1,
                userSelect: 'none',
              }}
              onClick={() => {
                console.log('🖼️ [WEB] Label clicked for file input');
                console.log('🖼️ [WEB] Platform.OS:', Platform.OS);
                console.log('🖼️ [WEB] This should open file picker via htmlFor');
                setIsProcessingFile(true);
                setTimeout(() => setIsProcessingFile(false), 500);
              }}
            >
              <LinearGradient
                colors={['#10b981', '#06b6d4']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.button}
              >
                <View style={styles.buttonIconContainer}>
                  {isProcessingFile ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Ionicons name="images" size={24} color="#ffffff" />
                  )}
                </View>
                <Text style={styles.buttonText}>
                  {isProcessingFile ? 'Loading...' : 'Choose from Gallery'}
                </Text>
              </LinearGradient>
            </label>
          </>
        ) : (
          <TouchableOpacity
            onPress={handleGalleryPress}
            activeOpacity={0.8}
            disabled={isProcessingFile}
          >
            <LinearGradient
              colors={['#10b981', '#06b6d4']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={[styles.button, isProcessingFile && styles.buttonDisabled]}
            >
              <View style={styles.buttonIconContainer}>
                {isProcessingFile ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <Ionicons name="images" size={24} color="#ffffff" />
                )}
              </View>
              <Text style={styles.buttonText}>
                {isProcessingFile ? 'Loading...' : 'Choose from Gallery'}
              </Text>
            </LinearGradient>
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.footer}>Supports Math, Science, English & More</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  hero: {
    alignItems: 'center',
    marginBottom: spacing.xxl * 2,
  },
  iconContainer: {
    marginBottom: spacing.xl,
  },
  iconGradient: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  title: {
    fontSize: 36,
    lineHeight: 44,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.xl,
  },
  subtitle: {
    fontSize: typography.bodyLarge.fontSize,
    lineHeight: typography.bodyLarge.lineHeight,
    color: colors.textSecondary,
  },
  buttonsContainer: {
    gap: spacing.lg,
  },
  button: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  buttonIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  buttonText: {
    fontSize: typography.titleLarge.fontSize,
    lineHeight: typography.titleLarge.lineHeight,
    fontWeight: '600',
    color: '#ffffff',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  footer: {
    fontSize: typography.bodyLarge.fontSize,
    lineHeight: typography.bodyLarge.lineHeight,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.xxl * 2,
  },
});
