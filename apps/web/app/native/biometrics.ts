import { Capacitor } from '@capacitor/core';

export interface BiometricResult {
  available: boolean;
  biometryType: 'face' | 'fingerprint' | 'iris' | 'none';
}

/** Checks if biometric authentication is available on this device. */
export async function checkBiometrics(): Promise<BiometricResult> {
  if (!Capacitor.isNativePlatform()) {
    return { available: false, biometryType: 'none' };
  }

  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
    const result = await BiometricAuth.checkBiometry();
    const available = result.isAvailable;
    let biometryType: BiometricResult['biometryType'] = 'none';
    if (result.biometryType === 1) biometryType = 'fingerprint';
    else if (result.biometryType === 2) biometryType = 'face';
    else if (result.biometryType === 3) biometryType = 'iris';
    return { available, biometryType };
  } catch {
    return { available: false, biometryType: 'none' };
  }
}

/** Prompts for biometric authentication. Returns true if verified. */
export async function authenticateWithBiometrics(reason: string): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;

  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
    await BiometricAuth.authenticate({ reason, cancelTitle: 'Cancel' });
    return true;
  } catch {
    return false;
  }
}
