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
    if (!hasPickedRef.current) {
      hasPickedRef.current = true;
      
      if (Platform.OS === 'web') {
        pickImageWeb();
      } else {
        pickImage();
      }
    }
  }, []);

  const pickImageWeb = () => {
    console.log('🖼️ Gallery: Using web file input...');
    
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    
    input.onchange = async (e: any) => {
      const file = e.target.files?.[0];
      if (!file) {
        console.log('🖼️ Gallery: No file selected');
        navigation.navigate('Home');
        return;
      }

      console.log('🖼️ Gallery: File selected:', file.name);
      
      const reader = new FileReader();
      reader.onload = (event) => {
        const uri = event.target?.result as string;
        const img = new Image();
        img.onload = () => {
          console.log('🖼️ Gallery: Image loaded, dimensions:', img.width, 'x', img.height);
          setCurrentImage({
            uri,
            width: img.width,
            height: img.height,
          });
          navigation.navigate('ProblemSelection');
        };
        img.src = uri;
      };
      reader.readAsDataURL(file);
    };
    
    input.oncancel = () => {
      console.log('🖼️ Gallery: File picker canceled');
      navigation.navigate('Home');
    };
    
    input.click();
  };

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
      });
      
      console.log('🖼️ Gallery: Image picker result:', result);

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        console.log('🖼️ Gallery: Image selected:', asset.uri);
        setCurrentImage({
          uri: asset.uri,
          width: asset.width,
          height: asset.height,
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
