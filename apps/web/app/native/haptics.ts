import { Capacitor } from '@capacitor/core';

/** Triggers a light haptic impact on native platforms. No-op on web. */
export async function triggerHaptic(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle.Light });
  }
}

/** Triggers a medium haptic impact on native platforms. No-op on web. */
export async function triggerHapticMedium(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle.Medium });
  }
}

/** Triggers a haptic notification (success/warning/error). No-op on web. */
export async function triggerHapticNotification(
  type: 'success' | 'warning' | 'error',
): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Haptics, NotificationType } = await import('@capacitor/haptics');
    const notificationMap = {
      success: NotificationType.Success,
      warning: NotificationType.Warning,
      error: NotificationType.Error,
    } as const;
    await Haptics.notification({ type: notificationMap[type] });
  }
}
