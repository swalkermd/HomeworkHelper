import React, { useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
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

  useEffect(() => {
    reset();
  }, [reset]);

  // Handle gallery button - direct file picker on web to maintain user gesture
  const handleGalleryPress = () => {
    if (Platform.OS === 'web') {
      // Open file picker directly on web (must be triggered by user gesture)
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      
      input.onchange = async (e: any) => {
        const file = e.target.files?.[0];
        document.body.removeChild(input);
        
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
          const uri = event.target?.result as string;
          const img = new Image();
          img.onload = () => {
            setCurrentImage({
              uri,
              width: img.width,
              height: img.height,
            });
            navigation.navigate('ProblemSelection');
          };
          img.onerror = () => {
            alert('Failed to load image. Please try again.');
          };
          img.src = uri;
        };
        reader.onerror = () => {
          alert('Failed to read file. Please try again.');
        };
        reader.readAsDataURL(file);
      };
      
      document.body.appendChild(input);
      input.click();
    } else {
      // Native platform - navigate to Gallery screen (which handles permissions)
      navigation.navigate('Gallery');
    }
  };

  return (
    <View style={styles.container}>
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

        <TouchableOpacity
          onPress={handleGalleryPress}
          activeOpacity={0.8}
        >
          <LinearGradient
            colors={['#10b981', '#06b6d4']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.button}
          >
            <View style={styles.buttonIconContainer}>
              <Ionicons name="images" size={24} color="#ffffff" />
            </View>
            <Text style={styles.buttonText}>Choose from Gallery</Text>
          </LinearGradient>
        </TouchableOpacity>
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
  footer: {
    fontSize: typography.bodyLarge.fontSize,
    lineHeight: typography.bodyLarge.lineHeight,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.xxl * 2,
  },
});
