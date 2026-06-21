import { NativeModules } from 'react-native';

const { BluetoothSco } = NativeModules;

export function startBluetoothSco(): void {
  BluetoothSco?.start();
}

export function stopBluetoothSco(): void {
  BluetoothSco?.stop();
}
