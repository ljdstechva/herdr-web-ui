import type { AgentStatus } from "../../shared/protocol.ts";
import { ENDED_NOTIFICATION_BODY, paneNotificationTag, statusNotificationBody } from "../../shared/notify-policy.ts";
import { MODAL_CHANGE_EVENT } from "./focus.ts";

/**
 * Tab alerts: Web Notifications for pane status transitions while this page is open
 * but hidden. A device with a push subscription (lib/push.ts) gets the same alerts from
 * the server instead, and App skips these. Notification exists only in secure contexts
 * (https or localhost) - a plain-http LAN deployment reports "unsupported", and the bell
 * there switches only the in-app alerts.
 *
 * The transition policy is shared with the server (shared/notify-policy.ts).
 */

export { alertStatus, alertsAllow, shouldNotifyStatus } from "../../shared/notify-policy.ts";

export type NotificationState = "unsupported" | "default" | "granted" | "denied";

type ReadTarget = { paneId: string; machineId: string } | "vps" | "app";
const fallbackNotifications = new Map<string, Notification>();
const NOTIFICATION_SHOWN = "herdr-notification-shown";

/** Android derives launcher badges from these records, not from the Badging API. */
export async function dismissReadNotifications(target: ReadTarget, canRead: () => boolean): Promise<void> {
  if (!canRead()) return;
  const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  if (!canRead()) return;
  const delivered = await registration?.getNotifications?.() ?? [];
  // A pane switch, backgrounding or a modal can happen during either browser lookup.
  if (!canRead()) return;
  for (const notification of [...delivered, ...fallbackNotifications.values()]) {
    const matches = target === "app" ? notification.tag === "herdr-test"
      : target === "vps" ? notification.tag.startsWith("herdr-vps-")
      : notification.tag === paneNotificationTag(target.paneId, target.machineId);
    if (!matches) continue;
    notification.close();
    if (fallbackNotifications.get(notification.tag) === notification) fallbackNotifications.delete(notification.tag);
  }
}

/** Reconcile only on reading/delivery events. No timers, saved unread counter or subscription. */
export function watchReadNotifications(target: ReadTarget, canRead: () => boolean): () => void {
  let disposed = false;
  let running = false;
  let requested = false;
  const readable = (): boolean => !disposed && document.visibilityState === "visible" && canRead();
  const reconcile = (): void => {
    if (!readable()) return;
    requested = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        do {
          requested = false;
          await dismissReadNotifications(target, readable);
        } while (requested && readable());
      } catch (error) {
        console.warn("Could not dismiss read notifications", error);
      } finally { running = false; }
    })();
  };
  const onMessage = (event: MessageEvent): void => {
    if (event.data?.type === "notification-shown") reconcile();
  };
  // React restores focus during modal cleanup, before removing that modal's DOM.
  const onFocus = (): void => queueMicrotask(reconcile);
  document.addEventListener("visibilitychange", reconcile);
  // Closing a nested modal restores focus without changing App's selected pane.
  document.addEventListener("focusin", onFocus);
  document.addEventListener(NOTIFICATION_SHOWN, reconcile);
  document.addEventListener(MODAL_CHANGE_EVENT, reconcile);
  window.addEventListener("focus", onFocus);
  navigator.serviceWorker?.addEventListener("message", onMessage);
  navigator.serviceWorker?.addEventListener("controllerchange", reconcile);
  reconcile();
  return () => {
    disposed = true;
    document.removeEventListener("visibilitychange", reconcile);
    document.removeEventListener("focusin", onFocus);
    document.removeEventListener(NOTIFICATION_SHOWN, reconcile);
    document.removeEventListener(MODAL_CHANGE_EVENT, reconcile);
    window.removeEventListener("focus", onFocus);
    navigator.serviceWorker?.removeEventListener("message", onMessage);
    navigator.serviceWorker?.removeEventListener("controllerchange", reconcile);
  };
}

export function notificationState(): NotificationState {
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  return globalThis.Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationState> {
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  const permission = await globalThis.Notification.requestPermission();
  return permission === "granted" ? "granted" : permission === "denied" ? "denied" : "default";
}

/**
 * Shown through the service worker when there is one: Android Chrome has no
 * `new Notification()`, and the worker's notificationclick (public/sw.js) selects the
 * pane. The constructor is the fallback for a page without a worker.
 */
async function show(paneId: string, title: string, body: string, onClick?: () => void, machineId = "local"): Promise<void> {
  if (typeof globalThis.Notification === "undefined") return;
  if (globalThis.Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return; // visible tab: the UI already shows it
  const options: NotificationOptions = { body, tag: paneNotificationTag(paneId, machineId), data: { pane_id: paneId, machine_id: machineId }, icon: "/icons/icon-192.png?v=ram1" };
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (typeof document !== "undefined" && !document.hidden) return;
    if (registration?.active) {
      await registration.showNotification(title, options);
      registration.active.postMessage({ type: "notification-shown" });
      document.dispatchEvent(new Event(NOTIFICATION_SHOWN));
      return;
    }
    const notification = new globalThis.Notification(title, options);
    fallbackNotifications.get(options.tag!)?.close();
    fallbackNotifications.set(options.tag!, notification);
    notification.addEventListener("show", () => document.dispatchEvent(new Event(NOTIFICATION_SHOWN)));
    notification.addEventListener("close", () => {
      if (fallbackNotifications.get(options.tag!) === notification) fallbackNotifications.delete(options.tag!);
    });
    notification.addEventListener("click", () => {
      notification.close();
      if (fallbackNotifications.get(options.tag!) === notification) fallbackNotifications.delete(options.tag!);
      window.focus();
      onClick?.();
    });
  } catch {
    /* no way to show it here: the sidebar badge still carries the change */
  }
}

export function showPaneStatusNotification(paneId: string, title: string, status: AgentStatus, onClick?: () => void, machineId = "local"): void {
  void show(paneId, title, statusNotificationBody(status), onClick, machineId);
}

export function showPaneEndedNotification(paneId: string, title: string, onClick?: () => void, machineId = "local"): void {
  void show(paneId, title, ENDED_NOTIFICATION_BODY, onClick, machineId);
}
