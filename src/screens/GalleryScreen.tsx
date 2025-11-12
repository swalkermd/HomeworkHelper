import React, { useCallback } from 'react';
import { View, Alert, StyleSheet, ActivityIndicator, Text, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { useHomeworkStore } from '../store/homeworkStore';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../constants/theme';

type GalleryScreenProps = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Gallery'>;
};

type MutableBooleanRef = { current: boolean };

const isImagePickerResult = (
  result: ImagePicker.ImagePickerResult | ImagePicker.ImagePickerErrorResult | null
): result is ImagePicker.ImagePickerResult => {
  return !!result && 'canceled' in result;
};

export default function GalleryScreen({ navigation }: GalleryScreenProps) {
  const setCurrentImage = useHomeworkStore((state) => state.setCurrentImage);
  const pickImage = useCallback(
    async (isActiveRef: MutableBooleanRef) => {
      try {
        console.log('🖼️ Gallery: Starting image picker...');

        const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
        console.log('🖼️ Gallery: Permission result:', permissionResult);

        const hasLibraryAccess =
          permissionResult.status === ImagePicker.PermissionStatus.GRANTED ||
          permissionResult.accessPrivileges === 'limited';

        if (!hasLibraryAccess) {
          console.log('🖼️ Gallery: Permission denied');
          if (!isActiveRef.current) {
            return;
          }
          Alert.alert(
            'Permission Required',
            'Please grant permission to access your photo library.',
            [{ text: 'OK', onPress: () => navigation.navigate('Home') }]
          );
          return;
        }

        let pickerResult: ImagePicker.ImagePickerResult | null = null;
        const pendingResult = await ImagePicker.getPendingResultAsync();

        if (pendingResult && 'error' in pendingResult) {
          console.warn('🖼️ Gallery: Pending result error:', pendingResult.error);
        } else if (isImagePickerResult(pendingResult)) {
          pickerResult = pendingResult;
        }

        if (!pickerResult) {
          console.log('🖼️ Gallery: Launching image library...');
          pickerResult = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: false,
            quality: 1,
            base64: true,
          });
        }

        if (!pickerResult) {
          console.warn('🖼️ Gallery: Image picker did not return a result');
          if (!isActiveRef.current) {
            return;
          }
          navigation.navigate('Home');
          return;
        }

        console.log('🖼️ Gallery: Image picker result:', pickerResult);

        if (!isActiveRef.current) {
          console.log('🖼️ Gallery: Screen no longer active, skipping result handling');
          return;
        }

        if (!pickerResult.canceled && pickerResult.assets && pickerResult.assets[0]) {
          const asset = pickerResult.assets[0];
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
        if (!isActiveRef.current) {
          return;
        }
        Alert.alert(
          'Error',
          'Failed to open photo library. Please try again.',
          [{ text: 'OK', onPress: () => navigation.navigate('Home') }]
        );
      }
    },
    [navigation, setCurrentImage]
  );

  useFocusEffect(
    useCallback(() => {
      console.log('🖼️ Gallery: Screen focused, Platform.OS:', Platform.OS);

      // SAFEGUARD: Web should never reach this screen
      if (Platform.OS === 'web') {
        console.error('❌ GalleryScreen accessed on web platform - this is a navigation bug');
        console.error('Stack trace:', new Error().stack);

        if (typeof window !== 'undefined' && window.alert) {
          window.alert('Navigation error detected. Returning to home screen.');
        }

        setTimeout(() => {
          navigation.navigate('Home');
        }, 100);
        return () => {};
      }

      const isActiveRef: MutableBooleanRef = { current: true };

      const openPicker = async () => {
        await pickImage(isActiveRef);
      };

      openPicker();

      return () => {
        console.log('🖼️ Gallery: Screen unfocused, cleaning up');
        isActiveRef.current = false;
      };
    }, [navigation, pickImage])
  );

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
