/* Putting HaRM on a phone's home screen: trusting HaRM's certificate, and installing the app. */
import { useState } from 'react';
import { S, useApp } from '../lib/state';
import { closeAllModals, modal } from '../ui/overlay';
import { Qr } from './print';

export async function installApp() {
  const p = useApp.getState().installPrompt;
  if (!p) return phoneAppHelp();
  p.prompt();
  await p.userChoice;
  useApp.setState({ installPrompt: null });
}

/* QR codes for setting up a phone from the web app (for servers without the desktop app). */
export function PhoneQrBlock() {
  const urls: string[] = S.caps.phone_urls || [];
  const [base, setBase] = useState(urls[0] || '');
  if (!urls.length || !S.caps.ca_cert) return null;
  return (
    <div className="qr-pair-wrap">
      <p><b>Scan this with your phone’s camera. </b>Both need to be on the same Wi‑Fi. Scan ① first (install and trust the certificate), then ②.</p>
      {urls.length > 1 ? <label className="disc-field"><span>Address your phone uses</span>
        <select aria-label="Address" value={base} onChange={e => setBase(e.target.value)}>{urls.map(u => <option key={u} value={u}>{u.replace('https://', '')}</option>)}</select></label> : null}
      <div className="qr-pair">
        <div className="qr-box"><Qr text={`${base}/harm-ca.crt`} size={168} /><div className="muted small">① Certificate</div></div>
        <div className="qr-box"><Qr text={`${base}/`} size={168} /><div className="muted small">② Open HaRM</div></div>
      </div>
    </div>
  );
}

function PhoneHelp() {
  const installPrompt = useApp(s => s.installPrompt);
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  const secure = window.isSecureContext;
  return (
    <div className="phone-help">
      <div className="notice">Not connecting, or a warning that won’t go away? <a href="#/help?s=trouble" onClick={() => closeAllModals()}>Step-by-step troubleshooting for iPhone, iPad and Android</a></div>
      {standalone ? <p className="ok-text">✓ You’re already using HaRM as an installed app.</p> : null}
      <PhoneQrBlock />
      <p>Chrome only offers “Install app” for sites it fully trusts. HaRM uses its own HTTPS certificate, so your phone needs to trust it once:</p>
      <ol>
        <li>On your phone, open this page and download the certificate: {S.caps.ca_cert ? <a className="button sm" href="/harm-ca.crt" download="harm-ca.crt">⬇ harm-ca.crt</a>
          : <span className="warn-text">not created yet: run scripts/make-cert.sh on the server</span>}</li>
        <li><b>Android: </b>Settings &gt; Security &amp; privacy &gt; More security settings &gt; Encryption &amp; credentials &gt; Install a certificate &gt; <b>CA certificate</b> &gt; Install anyway &gt; pick harm-ca.crt. (Search Settings for “CA certificate” if the menus differ.)</li>
        <li><b>iPhone: </b>open the file &gt; Settings &gt; Profile Downloaded &gt; Install, then Settings &gt; General &gt; About &gt; Certificate Trust Settings &gt; turn on “Zom’s HaRM local CA”.</li>
        <li>Close Chrome completely, reopen <code>{location.origin}</code>. There should be no warning now.</li>
        <li>Chrome menu (⋮) &gt; <b>Install app</b> (or “Add to Home screen”). On iPhone: Safari &gt; Share &gt; Add to Home Screen.</li>
      </ol>
      <p><button type="button" className="primary install-btn" hidden={!installPrompt} onClick={installApp}>⤓ Install now</button></p>
      <p className="muted small">{`This browser: ${secure ? 'secure connection ✓' : 'NOT trusted yet (step 2 not done)'} · ${standalone ? 'installed' : 'in a browser tab'}. Only install it on your own devices, and keep data/tls/harm-ca.key on the server private: whoever has that key could vouch for other sites to your phone. Long-press the app icon for shortcuts (Scan a part, Devices, Tasks).`}</p>
    </div>
  );
}

export function phoneAppHelp() {
  modal('Use HaRM as an app on your phone', <PhoneHelp />);
}
