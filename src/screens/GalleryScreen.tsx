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
    const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
    
    if (!permissionResult.granted) {
      Alert.alert(
        'Permission Required',
        'Please grant permission to access your photo library.',
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 1,
    });

    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setCurrentImage({
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
      });
      navigation.navigate('ProblemSelection');
    } else {
      navigation.goBack();
    }
  };

  return <View style={styles.container} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
