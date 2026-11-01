/* "Can't connect" steps for each kind of device. Kept out of the Help page's download: it's shown
   on the start screen too, when HaRM can't reach its server. */
import { deviceKind } from '../lib/util';
import type { Kid } from '../ui/bits';

const B = ({ children }: { children: Kid }) => <b>{children}</b>;
const C = ({ children }: { children: Kid }) => <code>{children}</code>;
const L = ({ items, ordered = false }: { items: Kid[]; ordered?: boolean }) => {
  const kids = items.map((i, n) => <li key={n}>{i}</li>);
  return ordered ? <ol>{kids}</ol> : <ul>{kids}</ul>;
};

export function TroubleshootingContent() {
  const here = location.origin;
  const mine = deviceKind();
  const sec = (key: string, title: string, body: Kid) => <details key={key} className="trouble" open={key === mine}>
    <summary>{title}{key === mine ? <span className="badge info">this device</span> : null}</summary>{body}</details>;
  return <>
    <p>Most connection problems are about trust: phones and tablets only talk to HaRM once they trust its certificate. If HaRM opens on one device but not another, the server is fine; fix the device that fails.</p>
    {sec('ios', 'iPhone / iPad', <>
      <p>Symptoms: <B>“Cannot reach the HaRM server”</B>, a warning that the connection isn’t private, it works in Safari but not from the home screen, or the home-screen icon is just a letter.</p>
      <L ordered items={[
        <><B>Clear old HaRM data: </B>Settings &gt; Apps &gt; Safari &gt; Advanced &gt; Website Data (older versions: Settings &gt; Safari &gt; Advanced &gt; Website Data). Search <C>{location.hostname || '192.168'}</C> and swipe to delete. Remove any HaRM icon from the home screen.</>,
        <><B>Download the certificate: </B>on the computer running HaRM, open <B>📱 Phone setup</B> in the desktop app and scan the first QR code with the Camera app, or open <C>{`${here}/harm-ca.crt`}</C> in Safari. If Safari warns, tap <B>Show Details &gt; visit this website</B>. Tap <B>Allow</B>, then Close.</>,
        <><B>Install it: </B>Settings &gt; <B>Profile Downloaded</B> (or General &gt; VPN &amp; Device Management) &gt; Zom’s HaRM local CA &gt; <B>Install</B>.</>,
        <><B>Trust it (the step most people miss): </B>Settings &gt; General &gt; About &gt; <B>Certificate Trust Settings</B> &gt; turn on <B>Zom’s HaRM local CA</B>.</>,
        <><B>Close Safari completely </B>(swipe it away in the app switcher), then open <C>{here}</C>. There should be no warning.</>,
        <><B>Add to Home Screen: </B>Share &gt; Add to Home Screen &gt; Add.</>,
      ]} />
      <L items={[
        'Still a warning at step 5? The trust switch in step 4 isn’t on. Not listed there? Step 3 didn’t finish.',
        'Worked before and stopped after HaRM was updated or its certificate re-issued? Update HaRM on the computer (older versions made certificates iPhones reject), restart it, then repeat from step 5.',
      ]} />
    </>)}
    {sec('android', 'Android', <L ordered items={[
      <>Open <B>📱 Phone setup</B> in the desktop app and scan the first QR code (or open <C>{`${here}/harm-ca.crt`}</C>). Chrome warns once: Advanced &gt; Proceed. The file downloads.</>,
      <>Settings &gt; Security &amp; privacy &gt; More security &amp; privacy &gt; Encryption &amp; credentials &gt; <B>Install a certificate &gt; CA certificate</B> &gt; Install anyway &gt; pick harm-ca.crt. (Samsung: Settings &gt; Security and privacy &gt; More security settings &gt; Install from device storage &gt; CA certificate.)</>,
      <>Close Chrome completely (swipe it away), reopen <C>{here}</C>. There should be a padlock and no warning.</>,
      <>Chrome ⋮ &gt; <B>Add to Home screen &gt; Install</B>.</>,
    ]} />)}
    {sec('computer', 'Any device', <L items={[
      <><B>Same network? </B>The device must be on the same Wi-Fi/network as the computer running HaRM (not guest Wi-Fi, mobile data or a VPN).</>,
      <><B>Right address? </B>The desktop app shows the addresses under “Where to open it”. If the computer’s IP changed, use the new one and press <B>Fix certificate</B> there.</>,
      <><B>Is HaRM running? </B>The desktop app shows ● Running. If it says Stopped, press Start; if it won’t start, open Server log at the bottom.</>,
      <><B>Firewall: </B>Windows asks the first time HaRM starts: allow it on Private networks. On Linux, the Phone setup checklist checks the firewall and offers to open the port.</>,
      <><B>Shared on your network? </B>In the desktop app, “Let phones and other devices connect” must be ticked (then Restart).</>,
      <><B>Still stuck? </B>The Phone setup checklist in the desktop app watches what the device does and shows which step is missing.</>,
    ]} />)}
  </>;
}
