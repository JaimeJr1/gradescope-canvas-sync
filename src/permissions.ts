// Firefox 115-126 do not grant MV3 host_permissions at install time; the user
// must allow site access, so the extension checks and can request it.
export const HOST_ORIGINS = ["https://www.gradescope.com/*", "https://gatech.instructure.com/*"];

export const HOST_ACCESS_MESSAGE =
  "Site access not granted. Press Sync now in the popup to allow it, or open about:addons > this extension > Permissions and allow gradescope.com and gatech.instructure.com.";

export function hasHostAccess(): Promise<boolean> {
  return browser.permissions.contains({ origins: HOST_ORIGINS });
}

/** Must be called synchronously from a user-input handler (e.g. a click). */
export function requestHostAccess(): Promise<boolean> {
  return browser.permissions.request({ origins: HOST_ORIGINS });
}
