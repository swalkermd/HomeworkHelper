import React, { useRef, useState } from 'react';
import { View, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useHomeworkStore } from '../store/homeworkStore';
import { RootStackParamList } from '../navigation/types';

type CameraScreenProps = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Camera'>;
};

export default function CameraScreen({ navigation }: CameraScreenProps) {
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const setCurrentImage = useHomeworkStore((state) => state.setCurrentImage);

  React.useEffect(() => {
    if (!permission) {
      requestPermission();
    } else if (!permission.granted) {
      Alert.alert(
        'Camera Permission',
        'Camera access is required to take photos of homework.',
        [
          { text: 'Cancel', onPress: () => navigation.goBack() },
          { text: 'Grant', onPress: requestPermission }
        ]
      );
    }
  }, [permission]);

  const handleCapture = async () => {
    if (!cameraRef.current) return;

    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 1,
      });
      
      if (photo) {
        setCurrentImage({
          uri: photo.uri,
          width: photo.width,
          height: photo.height,
          base64: photo.base64,
        });
        navigation.navigate('ProblemSelection');
      }
    } catch (error) {
      console.error('Error taking picture:', error);
      Alert.alert('Error', 'Failed to capture photo');
    }
  };

  const toggleFlash = () => {
    setFlash(flash === 'off' ? 'on' : 'off');
  };

  const toggleCameraFacing = () => {
    setFacing(current => (current === 'back' ? 'front' : 'back'));
  };

  if (!permission?.granted) {
    return <View style={styles.container} />;
  }

  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={styles.camera}
        facing={facing}
        flash={flash}
      >
        <View style={styles.overlay}>
          <View style={styles.topControls}>
            <TouchableOpacity style={styles.controlButton} onPress={() => navigation.goBack()}>
              <Ionicons name="close" size={32} color="#ffffff" />
            </TouchableOpacity>
            
            <View style={styles.topRightControls}>
              <TouchableOpacity style={styles.controlButton} onPress={toggleFlash}>
                <Ionicons
                  name={flash === 'on' ? 'flash' : 'flash-off'}
                  size={28}
                  color="#ffffff"
                />
              </TouchableOpacity>
              
              <TouchableOpacity style={styles.controlButton} onPress={toggleCameraFacing}>
                <Ionicons name="camera-reverse" size={28} color="#ffffff" />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.bottomControls}>
            <TouchableOpacity style={styles.captureButton} onPress={handleCapture}>
              <View style={styles.captureButtonInner} />
            </TouchableOpacity>
          </View>
        </View>
      </CameraView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },
  overlay: {
    flex: 1,
  },
  topControls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 20,
    paddingTop: 50,
  },
  topRightControls: {
    flexDirection: 'row',
    gap: 12,
  },
  controlButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomControls: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  captureButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureButtonInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#ffffff',
  },
});
