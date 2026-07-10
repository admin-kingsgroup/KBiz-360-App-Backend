// Public privacy policy page, served at GET /privacy (linked from the Google Play listing).
// Embedded as a string so it ships inside dist/ without Dockerfile changes.
export const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — KBiz 360 Smart Connect</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1c2330; margin: 0; background: #f6f7f9; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 22px 80px; background: #fff; min-height: 100vh; box-sizing: border-box; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .meta { color: #667085; font-size: 14px; margin-bottom: 28px; }
  h2 { font-size: 19px; margin: 30px 0 8px; }
  p, li { font-size: 15px; line-height: 1.65; color: #344054; }
  strong { color: #1c2330; }
  a { color: #2a5bd7; }
</style>
</head>
<body>
<main>
<h1>Privacy Policy</h1>
<div class="meta">KBiz 360 – Smart Connect · Kings Group Companies (Travkings) · Effective 10 July 2026</div>

<p><strong>KBiz 360 – Smart Connect</strong> ("the app") is an internal workplace app operated by Kings Group Companies / Travkings Tours and Travels ("we", "us") for our employees. It provides team chat and calls, workplace attendance, reminders and access to your company Microsoft 365 email. Only people with a company-issued account can sign in.</p>

<h2>Information we collect</h2>
<ul>
<li><strong>Account &amp; profile:</strong> your name, work email address, role, branch and department, as maintained in our company systems.</li>
<li><strong>Attendance:</strong> daily check-in/check-out times, the method used (Wi-Fi, geofence or face punch), your distance from the office at the time of the punch, and the name of the office Wi-Fi network your device was connected to (only when it matches an office network we configured).</li>
<li><strong>Location:</strong> used to detect when you arrive at or leave your office. This includes <strong>background location</strong>, so automatic check-in/out works while the app is closed. Location is checked against your office's registered coordinates; we store punch events (with the distance and the coordinates of the punch), not a continuous movement history.</li>
<li><strong>Messages &amp; calls:</strong> chats, group messages, voice notes and shared files you send through the app; call history (who called whom, when, duration). Call audio/video is transmitted for the call and not recorded.</li>
<li><strong>Email:</strong> the app connects to your company Microsoft 365 mailbox via Microsoft's APIs. Mail is fetched from Microsoft and displayed in the app; sign-in tokens are stored securely to keep you connected.</li>
<li><strong>Device &amp; notifications:</strong> a push notification token (Firebase Cloud Messaging / Apple push) so we can deliver messages, reminders and alerts.</li>
<li><strong>Biometrics:</strong> the face/fingerprint attendance punch uses your device's built-in screen-lock verification (Android BiometricPrompt / Apple Face ID). Biometric data never leaves your device and is never seen, stored or transmitted by us.</li>
</ul>

<h2>How we use it</h2>
<ul>
<li>Operating workplace chat, calls, email and reminders.</li>
<li>Recording workplace attendance and making it visible to you and to authorised managers.</li>
<li>Feeding attendance summaries into company HR/payroll processes.</li>
<li>Securing the service and enforcing role-based access.</li>
</ul>
<p>We do <strong>not</strong> sell your data, use it for advertising, or share it with third parties for marketing.</p>

<h2>Consent for attendance location</h2>
<p>Before location-based attendance is enabled, the app shows a consent screen explaining what is collected. You can decline or withdraw consent in the app at any time; you can also revoke the location permission in your device settings. Without it, automatic check-in is disabled and manual punch options remain.</p>

<h2>Where your data lives</h2>
<p>Data is stored on company-controlled infrastructure: our API server (hosted on Amazon Web Services, Mumbai region) and our MongoDB Atlas database. Email content remains in Microsoft 365. Push notifications are delivered through Google Firebase and Apple's push service. All traffic between the app and our servers is encrypted (HTTPS/TLS).</p>

<h2>Retention</h2>
<p>Attendance records, messages and account data are retained for the duration of your employment and thereafter as required by company policy and applicable law, then deleted or anonymised.</p>

<h2>Your rights</h2>
<p>You may request access to, correction of, or deletion of your personal data, subject to employment-record obligations. Contact your administrator or write to us at the address below.</p>

<h2>Children</h2>
<p>The app is a workplace tool for employees and is not directed at children under 18.</p>

<h2>Changes</h2>
<p>We will update this page when the policy changes and note the new effective date above.</p>

<h2>Contact</h2>
<p>Kings Group Companies / Travkings Tours and Travels<br>
Email: <a href="mailto:admin@kingsgroupco.com">admin@kingsgroupco.com</a></p>
</main>
</body>
</html>`;
