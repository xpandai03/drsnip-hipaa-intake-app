// AdsWizz attribution pixel on REGISTRATION success (client request,
// 2026-11-05). The one exception to the vendor-script rule recorded in
// api/_lib/analytics.ts: an image request, not a script, from the form's own
// document, only after the server has confirmed the submission.
//
// What leaves the browser: one GET to the URL below, exactly as the client
// supplied it. The intake app adds no form data, no submission id and no URL
// of its own (referrerpolicy="no-referrer"). The vendor still sees the
// browser's IP address, user agent and its own cookies.
//
// Registration only. Consultation and insurance never import this module.

/** The pixel URL, exactly as the client supplied it (scratchpad/pixel-adswizz.txt). */
export const ADSWIZZ_REGISTRATION_PIXEL_URL =
  "https://us-49476-adswizz.attribution.adswizz.com/fire?pixelId=829488e5-4037-4a3b-87e6-80391f8330c7&type=sitevisit&subtype=FormSubmission1&aw_0_req.gdpr=true&redirectURL=aHR0cHM6Ly9waXhlbC50YXBhZC5jb20vaWRzeW5jL2V4L3JlY2VpdmU_cGFydG5lcl9pZD0yOTk0JjwjaWYgcmVxdWVzdC5saXN0ZW5lcklkP21hdGNoZXMoJ1swLTlhLWZdezh9LVswLTlhLWZdezR9LVswLTlhLWZdezR9LVswLTlhLWZdezR9LVswLTlhLWZdezEyfScpPnBhcnRuZXJfdHlwZWRfZGlkPSU3QiUyMkhBUkRXQVJFX0FORFJPSURfQURfSUQlMjIlM0ElMjIke3JlcXVlc3QubGlzdGVuZXJJZH0lMjIlN0Q8I2Vsc2VpZiByZXF1ZXN0Lmxpc3RlbmVySWQ_bWF0Y2hlcygnWzAtOUEtRl17OH0tWzAtOUEtRl17NH0tWzAtOUEtRl17NH0tWzAtOUEtRl17NH0tWzAtOUEtRl17MTJ9Jyk-cGFydG5lcl90eXBlZF9kaWQ9JTdCJTIySEFSRFdBUkVfSURGQSUyMiUzQSUyMiR7cmVxdWVzdC5saXN0ZW5lcklkfSUyMiU3RDwjZWxzZT5wYXJ0bmVyX2RldmljZV9pZD0ke3JlcXVlc3QubGlzdGVuZXJJZCF9PC8jaWY-";

/** Append the pixel to THIS document (the form's, never the parent's). Never throws. */
export function appendRegistrationPixel(doc: Document = document): void {
  try {
    const img = doc.createElement("img");
    // Policy before src, so the request itself goes out without a referrer.
    img.setAttribute("referrerpolicy", "no-referrer");
    img.setAttribute("alt", "");
    img.setAttribute("width", "0");
    img.setAttribute("height", "0");
    img.style.display = "none";
    img.setAttribute("src", ADSWIZZ_REGISTRATION_PIXEL_URL);
    (doc.body ?? doc.documentElement).appendChild(img);
  } catch {
    /* attribution must never affect the patient's experience */
  }
}

/** Fire the pixel once for a submission the server has confirmed; nothing otherwise. */
export function registrationPixelOnResult(ok: boolean, doc?: Document): void {
  if (ok) appendRegistrationPixel(doc);
}
