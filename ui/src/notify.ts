/**
 * The desktop popup path, and the guard in front of it. A platform with no Notification API,
 * a permission the trader refused, and a browser that throws when a popup is constructed all
 * end the same way: nothing pops, nothing breaks, and the in-app list still records the fire.
 */

import { notificationGrant, shouldNotify, type DesktopProbe, type NotificationGrant } from './alertsModel';

/** The part of `Notification` this uses, so a test can hand over a browser that lacks it. */
export interface NotificationLike {
  permission?: string;
  requestPermission?: () => void;
  new (title: string, options?: NotificationOptions): NotificationHandle;
}

/** A popup once it exists; nothing here reads it back. */
export interface NotificationHandle {
  readonly title: string;
}

/** A browser, as far as this module cares. `ctor` is null where there is no Notification. */
export interface Desktop {
  ctor: NotificationLike | null;
}

/** Why a popup did or did not go up, for the panel line and for tests. */
export interface Delivery {
  shown: boolean;
  reason: NotificationGrant | 'refused';
}

/** Reads the permission without assuming the API is there. */
export function probe(desktop: Desktop): DesktopProbe {
  const permission = typeof desktop.ctor?.permission === 'string' ? desktop.ctor.permission : null;
  return { supported: desktop.ctor !== null, permission };
}

/**
 * The guarded path: check the permission first, construct the popup only when it is granted,
 * and swallow whatever the browser throws. Some browsers refuse to construct a notification
 * outside a service worker, and that is not a reason to lose an alert.
 */
export function deliver(desktop: Desktop, title: string, body: string, tag = 'chartkit-alert'): Delivery {
  const grant = notificationGrant(probe(desktop));
  if (grant !== 'on') return { shown: false, reason: grant };
  const ctor = desktop.ctor;
  if (!ctor) return { shown: false, reason: 'unsupported' };
  try {
    new ctor(title, { body, tag, silent: true });
    return { shown: true, reason: 'on' };
  } catch {
    return { shown: false, reason: 'refused' };
  }
}

/** The real browser. `Notification` is absent on platforms that have no desktop popups. */
export function globalDesktop(): Desktop {
  // SAFETY: the DOM types promise `Notification` always exists; this cast is exactly the
  // case they miss, a platform that has no desktop popups, so the field is read as optional.
  const holder = globalThis as unknown as { Notification?: NotificationLike };
  return { ctor: holder.Notification ?? null };
}

/** One guarded popup per fired alert, plus the one permission ask the trader starts. */
export class DesktopNotifier {
  private readonly desktop: Desktop;

  constructor(desktop: Desktop = globalDesktop()) {
    this.desktop = desktop;
  }

  get grant(): NotificationGrant {
    return notificationGrant(probe(this.desktop));
  }

  /** Asks for permission. Browsers ignore an ask that did not follow a gesture, so the panel
   * starts it from a button rather than on load. */
  ask(): void {
    try {
      void this.desktop.ctor?.requestPermission?.();
    } catch {
      // A browser that refuses the ask still gets every alert in the list.
    }
  }

  /** Whether a popup went up. The caller writes the list entry either way. */
  notify(fire: { muted: boolean; missed: boolean; ts: number }, title: string, body: string, now = Date.now()): boolean {
    if (!shouldNotify(fire, this.grant, now)) return false;
    return deliver(this.desktop, title, body).shown;
  }
}
