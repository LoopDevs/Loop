import { Capacitor } from '@capacitor/core';

/** Sets up Android notification channels. Call once on app start. */
export async function setupNotificationChannels(): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    await PushNotifications.createChannel({
      id: 'orders',
      name: 'Order Updates',
      description: 'Payment confirmations and gift card delivery',
      importance: 4, // HIGH
      sound: 'default',
      vibration: true,
    });
    await PushNotifications.createChannel({
      id: 'general',
      name: 'General',
      description: 'App updates and announcements',
      importance: 3, // DEFAULT
    });
  } catch {
    // Push notifications not available or permission not granted
  }
}
