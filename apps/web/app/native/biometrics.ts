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
    // androidConfirmationRequired: false — after a successful weak
    // biometric match (face on most Android devices), skip the extra
    // "Confirm" tap. Banking / screen-unlock apps do the same. Safe
    // here because this prompt gates UI visibility, not a transaction:
    // the refresh token is already keychain-backed
    // (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` / Keystore +
    // EncryptedSharedPreferences, ADR-006 / audit A-024), so the
    // biometric is friction reduction, not the secret's custodian.
    await BiometricAuth.authenticate({
      reason,
      cancelTitle: 'Cancel',
      androidConfirmationRequired: false,
    });
    return true;
  } catch {
    return false;
  }
}
