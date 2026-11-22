/*
 * The bot's Chrome window stays out of sight (off the screen, at its normal size, so pages are
 * drawn and read as usual) and comes forward only when the user is needed: a captcha, signing in,
 * or «نمایش پنجرهٔ سایت» in the panel. Afterwards it goes back out of sight.
 * (Nothing here is about the sites: they see the same Chrome either way.)
 */
'use strict';

const HIDDEN = { left: -32000, top: -32000 };
const SHOWN = { left: 60, top: 30, width: 1366, height: 900 };
// Only for the Chrome the bot launches itself (started out of sight, with full speed kept while
// out of sight); a browser handed in from outside (tests) is left as it is.
let enabled = false;
const enable = () => { enabled = true; };

async function setBounds(page, bounds) {
  if (!enabled || !page || page.isClosed()) return false;
  let s = null;
  try {
    s = await page.context().newCDPSession(page);
    const { windowId } = await s.send('Browser.getWindowForTarget');
    await s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await s.send('Browser.setWindowBounds', { windowId, bounds });
    return true;
  } catch (_) {
    return false; // not Chrome over CDP (tests): nothing to move
  } finally {
    if (s) s.detach().catch(() => {});
  }
}

/** Brings the window of this page onto the screen, in front. */
async function showWindow(page) {
  const ok = await setBounds(page, SHOWN);
  if (page && !page.isClosed()) await page.bringToFront().catch(() => {});
  return ok;
}

/** Moves the window of this page out of sight (it keeps working). */
async function hideWindow(page) {
  return setBounds(page, HIDDEN);
}

module.exports = { showWindow, hideWindow, enable };
