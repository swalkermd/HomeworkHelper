import React, { useEffect } from 'react';
import { View, Alert, StyleSheet } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useHomeworkStore } from '../store/homeworkStore';
import { RootStackParamList } from '../navigation/types';

type GalleryScreenProps = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Gallery'>;
};

export default function GalleryScreen({ navigation }: GalleryScreenProps) {
  const setCurrentImage = useHomeworkStore((state) => state.setCurrentImage);

  useEffect(() => {
    pickImage();
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
          [{ text: 'OK', onPress: () => navigation.goBack() }]
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
        navigation.goBack();
      }
    } catch (error) {
      console.error('🖼️ Gallery: Error picking image:', error);
      Alert.alert(
        'Error',
        'Failed to open photo library. Please try again.',
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    }
  };

  return <View style={styles.container} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
