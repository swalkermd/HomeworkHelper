import React, { useEffect, useRef } from 'react';
import { View, Alert, StyleSheet, ActivityIndicator, Text, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useHomeworkStore } from '../store/homeworkStore';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../constants/theme';

type GalleryScreenProps = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Gallery'>;
};

export default function GalleryScreen({ navigation }: GalleryScreenProps) {
  const setCurrentImage = useHomeworkStore((state) => state.setCurrentImage);
  const hasPickedRef = useRef(false);

  useEffect(() => {
    console.log('🖼️ Gallery: useEffect triggered, Platform.OS:', Platform.OS);

    // SAFEGUARD: Web should never reach this screen
    if (Platform.OS === 'web') {
      console.error('❌ GalleryScreen accessed on web platform - this is a navigation bug');
      console.error('Stack trace:', new Error().stack);
      Alert.alert(
        'Navigation Error',
        'This screen should not be accessible on web. Returning to home screen.',
        [{ text: 'OK', onPress: () => navigation.navigate('Home') }]
      );
      navigation.navigate('Home');
      return;
    }

    if (!hasPickedRef.current) {
      hasPickedRef.current = true;
      console.log('🖼️ Gallery: First run, calling pickImage()');
      pickImage();
    } else {
      console.log('🖼️ Gallery: hasPickedRef already true, skipping');
    }
  }, []);

  const pickImage = async () => {
    try {
      console.log('🖼️ Gallery: Starting image picker...');
      
      const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      console.log('🖼️ Gallery: Permission result:', permissionResult);
      
      if (!permissionResult.granted) {
        console.log('🖼️ Gallery: Permission denied');
        Alert.alert(
          'Permission Required',
          'Please grant permission to access your photo library.',
          [{ text: 'OK', onPress: () => navigation.navigate('Home') }]
        );
        return;
      }

      console.log('🖼️ Gallery: Launching image library...');
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 1,
        base64: true,
      });
      
      console.log('🖼️ Gallery: Image picker result:', result);

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        console.log('🖼️ Gallery: Image selected:', asset.uri);
        console.log('🖼️ Gallery: MIME type:', asset.mimeType);
        setCurrentImage({
          uri: asset.uri,
          width: asset.width,
          height: asset.height,
          base64: asset.base64 || undefined,
          mimeType: asset.mimeType || undefined,
        });
        navigation.navigate('ProblemSelection');
      } else {
        console.log('🖼️ Gallery: Selection canceled or no asset');
        navigation.navigate('Home');
      }
    } catch (error) {
      console.error('🖼️ Gallery: Error picking image:', error);
      Alert.alert(
        'Error',
        'Failed to open photo library. Please try again.',
        [{ text: 'OK', onPress: () => navigation.navigate('Home') }]
      );
    }
  };

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={styles.loadingText}>Opening photo library...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: colors.textSecondary,
  },
});
