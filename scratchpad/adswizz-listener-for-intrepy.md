# AdsWizz pixel on registration: listener for drsnip.com/registration

**For:** Intrepy · **From:** Xpand (DrSnip intake) · 5 Nov 2026

The registration form on drsnip.com/registration is an iframe served from `https://intake.drsnip.com`. When the intake server confirms a submission, the form posts one message to the parent page:

```js
{ event: 'intake_conversion', form_type: 'registration' }
```

That is the whole payload: no name, email or any other form data. It is never sent for a failed or rejected submit. This is the same message the integration guide's listener already forwards as `drsnip_intake_conversion`. The snippet below fires the AdsWizz image from the parent page when that message arrives for a registration. Nothing changes inside the intake form.

## The snippet

Replace `ADSWIZZ_PIXEL_URL` with the URL the client sends you. Use it exactly as given and add no parameters.

```html
<script>
(function () {
  var ADSWIZZ_PIXEL_URL = 'ADSWIZZ_PIXEL_URL';   // <- the client's AdsWizz pixel URL
  var INTAKE_ORIGIN = 'https://intake.drsnip.com';
  var lastFired = 0;

  window.addEventListener('message', function (e) {
    // Only trust the DrSnip intake origin. Not optional: without this,
    // anything else on the page could forge a conversion.
    if (e.origin !== INTAKE_ORIGIN) return;
    var d = e.data || {};
    if (d.event !== 'intake_conversion' || d.form_type !== 'registration') return;

    // Once per conversion event: ignore a repeat delivery within 3 seconds.
    var now = Date.now();
    if (now - lastFired < 3000) return;
    lastFired = now;

    var img = new Image(1, 1);
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.style.cssText = 'position:absolute;width:0;height:0;border:0;display:none';
    img.src = ADSWIZZ_PIXEL_URL;
    (document.body || document.documentElement).appendChild(img);
  });
})();
</script>
```

## Where it goes, and how to check it

**Where.** Put it on the drsnip.com/registration page, either in the page HTML (anywhere, before or after the form embed) or as a Custom HTML tag in your Matomo container that fires on that page only. If you already run the guide's listener, you can instead skip this script: add a Custom Image tag in Matomo, triggered by the `drsnip_intake_conversion` event when `drsnip_form_type` equals `registration`. Don't use both, or the pixel fires twice.

**How to check it.**
1. Open the page with DevTools → Network.
2. Filter on the pixel's host and tick "Preserve log".
3. Complete a registration. Exactly one image request to the AdsWizz host should appear at the moment the form shows its success step. Its status is normally 200 or 204.
4. Confirm nothing fires on page load, on a submit the form rejects, or on the consultation and insurance forms.

**Testing safely.** A test registration with an invented name creates a real patient chart in the clinic's records. Ask Raunek at Xpand for the agreed test identity before you submit one, and tell him when you do so he can remove it.
