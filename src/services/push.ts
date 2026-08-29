import { Expo, type ExpoPushMessage } from 'expo-server-sdk';

const expo = new Expo();

export interface PushNotificationContent {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /**
   * Renders as an inline image — automatically on Android; on iOS the
   * client needs a Notification Service Extension to fetch and attach it
   * (not part of the stock expo-notifications config plugin — see
   * docs/backend-prd.md notes). The field is still sent either way so
   * Android gets rich content today and iOS is ready the day that's added.
   */
  imageUrl?: string;
}

/** True on a successful handoff to Expo's push service — not a delivery guarantee. */
export function isValidExpoPushToken(token: string): boolean {
  return Expo.isExpoPushToken(token);
}

export async function sendPushNotification(
  token: string,
  content: PushNotificationContent,
): Promise<boolean> {
  if (!Expo.isExpoPushToken(token)) return false;

  const message: ExpoPushMessage = {
    to: token,
    title: content.title,
    body: content.body,
    data: content.data,
    sound: 'default',
    ...(content.imageUrl
      ? { richContent: { image: content.imageUrl }, mutableContent: true }
      : {}),
  };

  try {
    const [ticket] = await expo.sendPushNotificationsAsync([message]);
    return ticket?.status === 'ok';
  } catch {
    return false;
  }
}
