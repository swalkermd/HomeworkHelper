import React, { useCallback } from 'react';
import {
  View,
  Alert,
  StyleSheet,
  ActivityIndicator,
  Text,
  Platform,
  Linking,
  AlertButton,
} from 'react-native';
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

type NormalizedImagePickerResult = ImagePicker.ImagePickerResult | null;

const isImagePickerError = (
  result: unknown
): result is ImagePicker.ImagePickerErrorResult => {
  return !!result && typeof result === 'object' && 'error' in result;
};

const normalizePickerResult = (
  result:
    | ImagePicker.ImagePickerResult
    | ImagePicker.ImagePickerResult[]
    | ImagePicker.ImagePickerErrorResult
    | null
): NormalizedImagePickerResult => {
  if (!result) {
    return null;
  }

  if (Array.isArray(result)) {
    if (result.length === 0) {
      return null;
    }
    const lastResult = result[result.length - 1];
    return lastResult ?? null;
  }

  if (isImagePickerError(result)) {
    const errorMessage = (result as { error?: string }).error ?? 'Unknown image picker error';
    throw new Error(errorMessage);
  }

  if ('canceled' in result) {
    return result;
  }

  return null;
};

const hasMediaLibraryAccess = (permissionResult: ImagePicker.MediaLibraryPermissionResponse) => {
  if (permissionResult.granted) {
    return true;
  }

  if (permissionResult.status === ImagePicker.PermissionStatus.GRANTED) {
    return true;
  }

  return permissionResult.accessPrivileges === 'limited';
};

export default function GalleryScreen({ navigation }: GalleryScreenProps) {
  const setCurrentImage = useHomeworkStore((state) => state.setCurrentImage);
  const pickImage = useCallback(
    async (isActiveRef: MutableBooleanRef) => {
      try {
        console.log('🖼️ Gallery: Starting image picker...');

        const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
        console.log('🖼️ Gallery: Permission result:', permissionResult);

        if (!hasMediaLibraryAccess(permissionResult)) {
          console.log('🖼️ Gallery: Permission denied');

          if (!isActiveRef.current) {
            return;
          }

          const message = permissionResult.canAskAgain
            ? 'Please grant permission to access your photo library so Homework Helper can analyze your homework photos.'
            : 'Homework Helper does not have permission to access your photo library. Please enable access in your device settings.';

          const buttons: AlertButton[] = permissionResult.canAskAgain
            ? [{ text: 'OK', onPress: () => navigation.navigate('Home') }]
            : [
                {
                  text: 'Open Settings',
                  onPress: () => {
                    Linking.openSettings().catch((err) => {
                      console.warn('🖼️ Gallery: Failed to open settings', err);
                    });
                    navigation.navigate('Home');
                  },
                },
                { text: 'Cancel', style: 'cancel', onPress: () => navigation.navigate('Home') },
              ];

          Alert.alert('Permission Required', message, buttons);
          return;
        }

        let pickerResult: ImagePicker.ImagePickerResult | null = null;

        try {
          const pendingResult = await ImagePicker.getPendingResultAsync();
          pickerResult = normalizePickerResult(pendingResult);
        } catch (pendingError) {
          console.warn('🖼️ Gallery: Pending result error:', pendingError);
        }

        if (!pickerResult) {
          console.log('🖼️ Gallery: Launching image library...');
          pickerResult = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: false,
            quality: 1,
            base64: true,
            presentationStyle:
              Platform.OS === 'ios'
                ? ImagePicker.UIImagePickerPresentationStyle.AUTOMATIC
                : undefined,
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

        const asset = pickerResult.assets?.[0];

        if (!pickerResult.canceled && asset && asset.uri) {
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
