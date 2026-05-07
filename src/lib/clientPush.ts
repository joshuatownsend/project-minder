"use client";

async function getVapidPublicKey(): Promise<string> {
  const res = await fetch("/api/notifications/push/vapid-public-key");
  if (!res.ok) throw new Error("Failed to fetch VAPID key");
  const { publicKey } = await res.json();
  return publicKey;
}

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const buf = new ArrayBuffer(rawData.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < rawData.length; i++) view[i] = rawData.charCodeAt(i);
  return buf;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

export async function requestPushPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) return "denied";
  return Notification.requestPermission();
}

export async function subscribeToPush(): Promise<PushSubscription | null> {
  const reg = await registerServiceWorker();
  if (!reg) return null;
  const publicKey = await getVapidPublicKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToArrayBuffer(publicKey),
  });
  await fetch("/api/notifications/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  return sub;
}

export async function unsubscribeFromPush(): Promise<void> {
  const reg = await navigator.serviceWorker?.getRegistration("/");
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await fetch("/api/notifications/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker?.getRegistration("/");
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}
