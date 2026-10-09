/* Google Ads tag, shared by every page an ad can land on plus the thank-you
   page. The tag stores the click id (gclid) from the ad URL in a first-party
   cookie on the landing page, and the Lead conversion on contact-thank-you.html
   (or mockup.html, which has no thank-you page) reads it back.

   PUT YOUR IDS BELOW. Google Ads > Goals > Conversions > your "Lead" action >
   Tag setup > Use Google tag. The send_to there looks like
   'AW-123456789/AbC-D_efG-h12_34-567'; the part before the slash is ID, the
   part after is LEAD_LABEL. Until ID is set this file does NOTHING and says so
   in the console, so a placeholder can never look like working tracking. */
(function () {
  var ID = '';          // <-- e.g. 'AW-123456789'
  var LEAD_LABEL = '';  // <-- e.g. 'AbC-D_efG-h12_34-567'

  window.afterGloGoogleLead = function () {};
  if (!ID) {
    console.warn('[AFTERGLO] Google Ads tag not configured. Set ID and LEAD_LABEL in js/google-ads.js.');
    return;
  }

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ID);
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  gtag('js', new Date());
  gtag('config', ID);

  // One conversion per quote request. transaction_id stops a reload of the
  // thank-you page from counting the same lead twice.
  window.afterGloGoogleLead = function (leadId) {
    if (!LEAD_LABEL) {
      console.warn('[AFTERGLO] Google Ads LEAD_LABEL not set; this lead is not counted.');
      return;
    }
    var p = { send_to: ID + '/' + LEAD_LABEL };
    if (leadId) p.transaction_id = leadId;
    gtag('event', 'conversion', p);
  };
})();
